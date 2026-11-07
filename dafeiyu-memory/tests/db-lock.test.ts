import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDatabaseLock } from "../src/db-lock.js";

const directories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "dafeiyu-db-lock-"));
  directories.push(directory);
  return join(directory, "nested", "memory.sqlite3");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("database writer lock", () => {
  it("creates parent directories and releases its own lock", () => {
    const databasePath = temporaryDatabase();
    const lock = acquireDatabaseLock(databasePath);
    expect(existsSync(lock.path)).toBe(true);
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(process.pid);

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it("rejects a second live writer", () => {
    const databasePath = temporaryDatabase();
    const lock = acquireDatabaseLock(databasePath);
    expect(() => acquireDatabaseLock(databasePath)).toThrow(
      `database ${databasePath} is already in use by PID ${process.pid}`,
    );
    lock.release();
  });

  it("reclaims a malformed or dead-owner lock", () => {
    const databasePath = temporaryDatabase();
    const lockPath = `${databasePath}.lock`;
    acquireDatabaseLock(databasePath).release();
    writeFileSync(
      lockPath,
      JSON.stringify({ token: "stale", pid: 2_147_483_647 }),
      "utf8",
    );

    const lock = acquireDatabaseLock(databasePath);
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(process.pid);
    lock.release();
  });
});
