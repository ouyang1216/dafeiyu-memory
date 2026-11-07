import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/store.js";
import {
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  verifySnapshot,
} from "../src/snapshots.js";
import type { SnapshotInfo } from "../src/snapshots.js";

let directory: string;
let sourcePath: string;
let snapshotDirectory: string;
let db: DatabaseSync;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dafeiyu-snapshots-"));
  sourcePath = join(directory, "source.sqlite3");
  snapshotDirectory = join(directory, "snap'shots");
  db = new DatabaseSync(sourcePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  db.exec(`
    CREATE TABLE schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL
    ) STRICT;
  `);
  db.prepare(
    "INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)",
  ).run("schema_version", "1", new Date().toISOString());
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // A test may already have closed the connection.
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("SQLite snapshots", () => {
  it("creates a WAL-consistent snapshot and writes a verifiable manifest", () => {
    const insert = db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)");
    for (let index = 1; index <= 100; index += 1) {
      insert.run(index, `note-${index}`);
    }
    expect(existsSync(`${sourcePath}-wal`)).toBe(true);

    const snapshot = createSnapshot(db, {
      directory: snapshotDirectory,
      prefix: "memory",
    });

    db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run(
      101,
      "after-snapshot",
    );

    expect(snapshot.manifest.format).toBe("dafeiyu-memory-snapshot");
    expect(snapshot.manifest.format_version).toBe(1);
    expect(snapshot.manifest.source_schema_version).toBe("1");
    expect(snapshot.manifest.database.bytes).toBeGreaterThan(0);
    expect(snapshot.manifest.database.sha256).toBe(sha256(snapshot.database_path));
    expect(verifySnapshot(snapshot)).toBeUndefined();
    expect(listSnapshots({ directory: snapshotDirectory })).toEqual([snapshot]);

    const manifestOnDisk = JSON.parse(
      readFileSync(snapshot.manifest_path, "utf8"),
    ) as unknown;
    expect(manifestOnDisk).toEqual(snapshot.manifest);
    expect(
      readdirSync(snapshotDirectory).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);

    const restored = new DatabaseSync(snapshot.database_path, {
      readOnly: true,
    });
    try {
      expect(
        restored.prepare("SELECT COUNT(*) AS count FROM notes").get()?.count,
      ).toBe(100);
      expect(
        restored.prepare("PRAGMA integrity_check").get()?.integrity_check,
      ).toBe("ok");
    } finally {
      restored.close();
    }
  });

  it("fails clearly without artifacts when VACUUM INTO cannot run", () => {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run(1, "pending");

    expect(() =>
      createSnapshot(db, { directory: snapshotDirectory }),
    ).toThrow(/VACUUM INTO.*未使用不安全的文件复制回退/);

    db.exec("ROLLBACK");
    expect(listSnapshots({ directory: snapshotDirectory })).toEqual([]);
    expect(
      readdirSync(snapshotDirectory).filter(
        (name) => name.startsWith(".") || name.endsWith(".tmp"),
      ),
    ).toEqual([]);
  });

  it("keeps newest snapshots and removes old database and manifest files", async () => {
    const snapshots: SnapshotInfo[] = [];
    for (let index = 0; index < 4; index += 1) {
      db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run(
        index + 1,
        `retention-${index}`,
      );
      snapshots.push(
        createSnapshot(db, {
          directory: snapshotDirectory,
          prefix: "memory",
        }),
      );
      await wait(5);
    }
    writeFileSync(join(snapshotDirectory, "keep.txt"), "unrelated\n", "utf8");

    const result = pruneSnapshots({
      directory: snapshotDirectory,
      prefix: "memory",
      retain: 2,
    });

    expect(result.kept.map((item) => item.manifest.snapshot_id)).toEqual(
      snapshots.slice(2).reverse().map((item) => item.manifest.snapshot_id),
    );
    expect(result.removed.map((item) => item.manifest.snapshot_id)).toEqual(
      snapshots.slice(0, 2).reverse().map((item) => item.manifest.snapshot_id),
    );
    expect(listSnapshots({ directory: snapshotDirectory })).toEqual(
      result.kept,
    );
    for (const removed of result.removed) {
      expect(existsSync(removed.database_path)).toBe(false);
      expect(existsSync(removed.manifest_path)).toBe(false);
    }
    expect(existsSync(join(snapshotDirectory, "keep.txt"))).toBe(true);
  });

  it("rejects invalid retention values and tampered snapshot databases", () => {
    const snapshot = createSnapshot(db, { directory: snapshotDirectory });
    expect(() =>
      pruneSnapshots({ directory: snapshotDirectory, retain: -1 }),
    ).toThrow("快照保留数量必须是非负整数");

    const tampered = readFileSync(snapshot.database_path);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    writeFileSync(snapshot.database_path, tampered);
    expect(() => verifySnapshot(snapshot)).toThrow(/快照 SHA-256 校验失败/);
  });

  it("integrates startup, manual, and pre-delete snapshots through MemoryStore", () => {
    const storePath = join(directory, "store.sqlite3");
    const storeSnapshotDirectory = join(directory, "store-snapshots");
    const store = createMemoryStore(storePath, {
      snapshotDirectory: storeSnapshotDirectory,
      snapshotRetention: 3,
      snapshotBeforeDelete: true,
    });
    try {
      const memory = store.remember({
        scope: {
          tenant_id: "tenant-snapshot",
          user_id: "user-snapshot",
          agent_id: "agent-snapshot",
          persona_id: "dafeiyu",
          space_id: "space-snapshot",
        },
        kind: "semantic",
        content: { text: "snapshot integration marker" },
        epistemic_type: "observed",
        source_type: "test",
        source_label: "snapshot-integration",
        source_confidence: 1,
        factual_confidence: 1,
      });

      const manual = store.snapshot({ prefix: "manual" });
      expect(verifySnapshot(manual)).toBeUndefined();
      const startup = store.snapshot({ prefix: "startup" });
      expect(verifySnapshot(startup)).toBeUndefined();

      const deleted = store.delete({
        scope: {
          tenant_id: "tenant-snapshot",
          user_id: "user-snapshot",
          agent_id: "agent-snapshot",
          persona_id: "dafeiyu",
          space_id: "space-snapshot",
        },
        memory_id: memory.memory_id,
        reason: "snapshot before delete",
        requested_by: "snapshot-test",
      });
      expect(deleted.verified).toBe(true);

      const snapshots = listSnapshots({ directory: storeSnapshotDirectory });
      expect(snapshots).toHaveLength(3);
      expect(snapshots.map((item) => item.manifest.snapshot_id)).toEqual(
        expect.arrayContaining([
          startup.manifest.snapshot_id,
          manual.manifest.snapshot_id,
          expect.stringContaining("before-delete-"),
        ]),
      );
    } finally {
      store.close();
    }
  });
});
