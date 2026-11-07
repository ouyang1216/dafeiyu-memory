import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleMaintenanceScheduler } from "../src/idle-maintenance.js";
import { createMemoryStore } from "../src/store.js";
import type { MemoryStore } from "../src/types.js";

let directory: string;
let dbPath: string;
let store: MemoryStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T05:00:00.000Z"));
  directory = mkdtempSync(join(tmpdir(), "dafeiyu-idle-maintenance-"));
  dbPath = join(directory, "memory.sqlite3");
  store = createMemoryStore(dbPath);
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("idle maintenance scheduler", () => {
  it("runs only after the configured inactivity window and resets after activity", () => {
    const results: number[] = [];
    const scheduler = createIdleMaintenanceScheduler({
      store,
      dbPath,
      idleAfterMs: 1_000,
      checkIntervalMs: 100,
      onResult(result) {
        results.push(result.scopes_scanned);
      },
    });

    scheduler.start();
    vi.advanceTimersByTime(999);
    expect(results).toEqual([]);

    vi.advanceTimersByTime(200);
    expect(results).toEqual([0]);

    vi.advanceTimersByTime(500);
    scheduler.markActivity();
    vi.advanceTimersByTime(900);
    expect(results).toEqual([0]);

    vi.advanceTimersByTime(200);
    expect(results).toEqual([0, 0]);
    scheduler.stop();

    vi.advanceTimersByTime(5_000);
    expect(results).toEqual([0, 0]);
  });
});
