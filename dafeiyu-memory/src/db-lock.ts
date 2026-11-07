import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

interface LockRecord {
  token: string;
  pid: number;
  database: string;
  acquired_at: string;
}

export interface DatabaseLock {
  path: string;
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockRecord).token === "string" &&
      Number.isInteger((parsed as LockRecord).pid)
    ) {
      return parsed as LockRecord;
    }
  } catch {
    // A malformed lock is treated as stale; the next writer replaces it.
  }
  return undefined;
}

function removeIfTokenMatches(path: string, token: string): void {
  const current = readLock(path);
  if (current?.token === token) {
    unlinkSync(path);
  }
}

/**
 * Acquires the process-exclusive writer lock beside a SQLite database.
 *
 * The SQLite file may be shared by desktop and web only if they also share
 * this lock. A lock left by a terminated process is reclaimed once its PID is
 * no longer alive.
 */
export function acquireDatabaseLock(databasePath: string): DatabaseLock {
  const path = `${databasePath}.lock`;
  mkdirSync(dirname(databasePath), { recursive: true });
  const lock: LockRecord = {
    token: randomUUID(),
    pid: process.pid,
    database: databasePath,
    acquired_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return {
        path,
        release(): void {
          try {
            removeIfTokenMatches(path, lock.token);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const current = readLock(path);
      if (current !== undefined && isProcessAlive(current.pid)) {
        throw new Error(
          `dafeiyu-memory: database ${databasePath} is already in use by PID ${current.pid}; ` +
            "one SQLite writer is allowed. Stop the other DSH profile or set DAFEIYU_MEMORY_DB to a separate database.",
        );
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }
  throw new Error(
    `dafeiyu-memory: could not acquire the writer lock for ${databasePath}`,
  );
}
