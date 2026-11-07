import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SNAPSHOT_FORMAT = "dafeiyu-memory-snapshot";
const SNAPSHOT_FORMAT_VERSION = 1;
const MANIFEST_SUFFIX = ".manifest.json";
const DATABASE_SUFFIX = ".sqlite3";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const HASH_BUFFER_BYTES = 1024 * 1024;

/**
 * A self-contained snapshot database and its integrity manifest.
 */
export interface SnapshotManifest {
  format: typeof SNAPSHOT_FORMAT;
  format_version: typeof SNAPSHOT_FORMAT_VERSION;
  snapshot_id: string;
  created_at: string;
  sqlite_version: string;
  source_schema_version: string | null;
  database: {
    file: string;
    bytes: number;
    sha256: string;
  };
}

/**
 * Resolved paths and parsed metadata for one complete snapshot.
 */
export interface SnapshotInfo {
  manifest: SnapshotManifest;
  database_path: string;
  manifest_path: string;
}

export interface SnapshotDirectoryOptions {
  directory: string;
  prefix?: string;
}

export interface PruneSnapshotsOptions extends SnapshotDirectoryOptions {
  retain: number;
}

export interface PruneSnapshotsResult {
  kept: SnapshotInfo[];
  removed: SnapshotInfo[];
}

/**
 * Failure to create, read, verify, or remove a local SQLite snapshot.
 */
export class SnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotError";
  }
}

function validatePrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new SnapshotError(
      `快照文件名前缀无效：${JSON.stringify(prefix)}。只允许字母、数字、点、下划线和连字符，且必须以字母或数字开头。`,
    );
  }
}

function normalizeDirectory(directory: string): string {
  if (directory.trim().length === 0) {
    throw new SnapshotError("快照目录不能为空。");
  }
  return resolve(directory);
}

function snapshotId(prefix: string): string {
  const timestamp = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${prefix}-${timestamp}-${randomUUID().slice(0, 12)}`;
}

function databaseFileName(id: string): string {
  return `${id}${DATABASE_SUFFIX}`;
}

function manifestFileName(id: string): string {
  return `${id}${MANIFEST_SUFFIX}`;
}

function durableWrite(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function sqliteVersion(db: DatabaseSync): string {
  const row = db.prepare("SELECT sqlite_version() AS version").get();
  return typeof row?.version === "string" ? row.version : "unknown";
}

function sourceSchemaVersion(db: DatabaseSync): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get("schema_version");
    return typeof row?.value === "string" ? row.value : null;
  } catch (error) {
    if (/no such table:\s*schema_meta/i.test(errorMessage(error))) {
      return null;
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a transactionally consistent SQLite snapshot with `VACUUM INTO`.
 *
 * The database and manifest are written with temporary names, flushed, hashed,
 * and atomically renamed into place. No file-copy fallback is used because it
 * could omit committed WAL pages or capture a torn database.
 *
 * @param db Open source database connection.
 * @param options Snapshot directory and optional filename prefix.
 * @returns The complete snapshot and resolved file paths.
 */
export function createSnapshot(
  db: DatabaseSync,
  options: SnapshotDirectoryOptions,
): SnapshotInfo {
  const directory = normalizeDirectory(options.directory);
  const prefix = options.prefix ?? "memory";
  validatePrefix(prefix);

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new SnapshotError(
      `无法创建快照目录 ${directory}：${errorMessage(error)}`,
      { cause: error },
    );
  }

  const id = snapshotId(prefix);
  const temporaryToken = randomUUID();
  const temporaryDatabase = join(
    directory,
    `.${id}.${temporaryToken}${DATABASE_SUFFIX}.tmp`,
  );
  const temporaryManifest = join(
    directory,
    `.${id}.${temporaryToken}${MANIFEST_SUFFIX}.tmp`,
  );
  const databasePath = join(directory, databaseFileName(id));
  const manifestPath = join(directory, manifestFileName(id));
  let databasePublished = false;
  let manifestPublished = false;

  try {
    db.prepare("VACUUM INTO ?").run(temporaryDatabase);
    durableFile(temporaryDatabase);

    const stats = statSync(temporaryDatabase);
    if (!stats.isFile() || stats.size === 0) {
      throw new SnapshotError("VACUUM INTO 没有生成有效的 SQLite 快照文件。");
    }

    const manifest: SnapshotManifest = {
      format: SNAPSHOT_FORMAT,
      format_version: SNAPSHOT_FORMAT_VERSION,
      snapshot_id: id,
      created_at: new Date().toISOString(),
      sqlite_version: sqliteVersion(db),
      source_schema_version: sourceSchemaVersion(db),
      database: {
        file: databaseFileName(id),
        bytes: stats.size,
        sha256: sha256File(temporaryDatabase),
      },
    };
    durableWrite(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);

    renameSync(temporaryDatabase, databasePath);
    databasePublished = true;
    renameSync(temporaryManifest, manifestPath);
    manifestPublished = true;

    return {
      manifest,
      database_path: databasePath,
      manifest_path: manifestPath,
    };
  } catch (error) {
    if (manifestPublished) {
      removeIfPresent(manifestPath);
    }
    if (databasePublished) {
      removeIfPresent(databasePath);
    }
    throw new SnapshotError(
      `创建一致性快照失败。VACUUM INTO 必须成功，未使用不安全的文件复制回退：${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    try {
      removeIfPresent(temporaryDatabase);
      removeIfPresent(temporaryManifest);
    } catch (cleanupError) {
      throw new SnapshotError(
        `快照临时文件清理失败：${errorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestError(path: string, reason: string): SnapshotError {
  return new SnapshotError(`快照清单无效 ${path}：${reason}`);
}

function parseManifest(path: string, expectedId: string): SnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new SnapshotError(
      `无法读取快照清单 ${path}：${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw manifestError(path, "根节点必须是对象。");
  }
  if (parsed.format !== SNAPSHOT_FORMAT) {
    throw manifestError(path, `format 必须是 ${SNAPSHOT_FORMAT}。`);
  }
  if (parsed.format_version !== SNAPSHOT_FORMAT_VERSION) {
    throw manifestError(
      path,
      `不支持的 format_version：${String(parsed.format_version)}。`,
    );
  }
  if (parsed.snapshot_id !== expectedId) {
    throw manifestError(path, "snapshot_id 与清单文件名不一致。");
  }
  if (!SNAPSHOT_ID_PATTERN.test(expectedId)) {
    throw manifestError(path, "snapshot_id 包含非法字符。");
  }
  if (
    typeof parsed.created_at !== "string" ||
    !Number.isFinite(Date.parse(parsed.created_at))
  ) {
    throw manifestError(path, "created_at 必须是有效的 ISO 时间。");
  }
  if (typeof parsed.sqlite_version !== "string") {
    throw manifestError(path, "sqlite_version 必须是字符串。");
  }
  if (
    parsed.source_schema_version !== null &&
    typeof parsed.source_schema_version !== "string"
  ) {
    throw manifestError(path, "source_schema_version 必须是字符串或 null。");
  }
  if (!isRecord(parsed.database)) {
    throw manifestError(path, "database 必须是对象。");
  }
  const database = parsed.database;
  const expectedDatabaseFile = databaseFileName(expectedId);
  if (
    database.file !== expectedDatabaseFile ||
    basename(expectedDatabaseFile) !== expectedDatabaseFile
  ) {
    throw manifestError(
      path,
      `database.file 必须是 ${expectedDatabaseFile} 且不能包含路径。`,
    );
  }
  if (
    typeof database.bytes !== "number" ||
    !Number.isSafeInteger(database.bytes) ||
    database.bytes <= 0
  ) {
    throw manifestError(path, "database.bytes 必须是正整数。");
  }
  if (
    typeof database.sha256 !== "string" ||
    !HASH_PATTERN.test(database.sha256)
  ) {
    throw manifestError(path, "database.sha256 必须是 64 位小写十六进制。");
  }
  return {
    format: SNAPSHOT_FORMAT,
    format_version: SNAPSHOT_FORMAT_VERSION,
    snapshot_id: expectedId,
    created_at: parsed.created_at,
    sqlite_version: parsed.sqlite_version,
    source_schema_version: parsed.source_schema_version,
    database: {
      file: expectedDatabaseFile,
      bytes: database.bytes,
      sha256: database.sha256,
    },
  };
}

function snapshotInfo(directory: string, id: string): SnapshotInfo {
  const manifestPath = join(directory, manifestFileName(id));
  const manifest = parseManifest(manifestPath, id);
  const databasePath = join(directory, manifest.database.file);
  let stats: Stats;
  try {
    stats = statSync(databasePath);
  } catch (error) {
    throw new SnapshotError(
      `快照数据库缺失或不可读 ${databasePath}：${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!stats.isFile()) {
    throw new SnapshotError(`快照数据库不是普通文件：${databasePath}`);
  }
  if (stats.size !== manifest.database.bytes) {
    throw new SnapshotError(
      `快照大小与清单不一致：清单 ${manifest.database.bytes} 字节，文件 ${stats.size} 字节。`,
    );
  }
  return {
    manifest,
    database_path: databasePath,
    manifest_path: manifestPath,
  };
}

/**
 * Lists complete snapshots in newest-first order.
 *
 * Broken manifests and missing or truncated databases fail loudly so retention
 * never silently treats an incomplete recovery point as a usable snapshot.
 *
 * @param options Snapshot directory and optional prefix filter.
 * @returns Complete snapshots sorted by creation time descending.
 */
export function listSnapshots(
  options: SnapshotDirectoryOptions,
): SnapshotInfo[] {
  const directory = normalizeDirectory(options.directory);
  if (options.prefix !== undefined) {
    validatePrefix(options.prefix);
  }
  if (!existsSync(directory)) {
    return [];
  }
  if (!statSync(directory).isDirectory()) {
    throw new SnapshotError(`快照路径不是目录：${directory}`);
  }

  const snapshots: SnapshotInfo[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.name.startsWith(".") ||
      !entry.name.endsWith(MANIFEST_SUFFIX)
    ) {
      continue;
    }
    const id = entry.name.slice(0, -MANIFEST_SUFFIX.length);
    if (
      options.prefix !== undefined &&
      !id.startsWith(`${options.prefix}-`)
    ) {
      continue;
    }
    snapshots.push(snapshotInfo(directory, id));
  }

  return snapshots.sort(
    (left, right) =>
      right.manifest.created_at.localeCompare(left.manifest.created_at) ||
      right.manifest.snapshot_id.localeCompare(left.manifest.snapshot_id),
  );
}

/**
 * Verifies that a snapshot database still matches its manifest SHA-256.
 *
 * @param snapshot Snapshot returned by create or list.
 */
export function verifySnapshot(snapshot: SnapshotInfo): void {
  const stats = statSync(snapshot.database_path);
  if (stats.size !== snapshot.manifest.database.bytes) {
    throw new SnapshotError(
      `快照大小校验失败 ${snapshot.database_path}：清单 ${snapshot.manifest.database.bytes} 字节，文件 ${stats.size} 字节。`,
    );
  }
  const actual = sha256File(snapshot.database_path);
  if (actual !== snapshot.manifest.database.sha256) {
    throw new SnapshotError(
      `快照 SHA-256 校验失败 ${snapshot.database_path}：清单 ${snapshot.manifest.database.sha256}，实际 ${actual}。`,
    );
  }
}

/**
 * Removes the oldest snapshots while retaining the requested newest count.
 *
 * @param options Snapshot directory, optional prefix, and positive retention count.
 * @returns Snapshot lists kept and removed.
 */
export function pruneSnapshots(
  options: PruneSnapshotsOptions,
): PruneSnapshotsResult {
  if (!Number.isSafeInteger(options.retain) || options.retain < 0) {
    throw new SnapshotError("快照保留数量必须是非负整数。");
  }
  const snapshots = listSnapshots(options);
  const kept = snapshots.slice(0, options.retain);
  const removed = snapshots.slice(options.retain);

  for (const snapshot of removed) {
    try {
      removeIfPresent(snapshot.manifest_path);
      removeIfPresent(snapshot.database_path);
    } catch (error) {
      throw new SnapshotError(
        `清理旧快照失败 ${snapshot.manifest.snapshot_id}：${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  return { kept, removed };
}
