#!/usr/bin/env node

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { acquireDatabaseLock } from "./db-lock.js";
import { createIdleMaintenanceScheduler } from "./idle-maintenance.js";
import { createMemoryMcpServer } from "./server.js";
import { createMemoryStore } from "./store.js";
import type { MemoryStore } from "./types.js";

const DEFAULT_DB_PATH = join(homedir(), ".dafeiyu-memory", "memory.sqlite3");
const DEFAULT_SNAPSHOT_RETENTION = 10;
const DEFAULT_MAINTENANCE_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MAINTENANCE_CHECK_MS = 60 * 1000;

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function databasePath(): string {
  const configured = process.env.DAFEIYU_MEMORY_DB?.trim();
  return configured ? expandHome(configured) : DEFAULT_DB_PATH;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const configured = process.env[name]?.trim();
  if (!configured) {
    return fallback;
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function snapshotDirectory(dbPath: string): string {
  const configured = process.env.DAFEIYU_MEMORY_SNAPSHOT_DIR?.trim();
  return configured
    ? expandHome(configured)
    : `${dbPath}.snapshots`;
}

function activityTrackedStore(
  store: MemoryStore,
  markActivity: () => void,
): MemoryStore {
  return {
    remember(input) {
      markActivity();
      return store.remember(input);
    },
    recall(input) {
      markActivity();
      return store.recall(input);
    },
    get(scope, memoryId) {
      markActivity();
      return store.get(scope, memoryId);
    },
    correct(input) {
      markActivity();
      return store.correct(input);
    },
    forget(input) {
      markActivity();
      return store.forget(input);
    },
    delete(input) {
      markActivity();
      return store.delete(input);
    },
    stats(scope) {
      markActivity();
      return store.stats(scope);
    },
    snapshot(options) {
      markActivity();
      return store.snapshot(options);
    },
    close() {
      markActivity();
      store.close();
    },
  };
}

async function main(): Promise<void> {
  const dbPath = databasePath();
  const snapshotDir = snapshotDirectory(dbPath);
  const snapshotRetention = positiveIntegerEnv(
    "DAFEIYU_MEMORY_SNAPSHOT_RETAIN",
    DEFAULT_SNAPSHOT_RETENTION,
  );
  const maintenanceIdleMs = positiveIntegerEnv(
    "DAFEIYU_MEMORY_MAINTENANCE_IDLE_MS",
    DEFAULT_MAINTENANCE_IDLE_MS,
  );
  const maintenanceCheckMs = positiveIntegerEnv(
    "DAFEIYU_MEMORY_MAINTENANCE_CHECK_MS",
    Math.min(DEFAULT_MAINTENANCE_CHECK_MS, maintenanceIdleMs),
  );
  const maintenanceDisabled =
    dbPath === ":memory:" ||
    process.env.DAFEIYU_MEMORY_MAINTENANCE_DISABLED === "1";
  const databaseLock = acquireDatabaseLock(dbPath);
  let store: MemoryStore;
  try {
    store = createMemoryStore(dbPath, {
      snapshotDirectory: snapshotDir,
      snapshotRetention,
      snapshotPrefix: "memory",
      snapshotBeforeDelete: true,
    });
    if (dbPath !== ":memory:") {
      store.snapshot({ prefix: "startup" });
    }
  } catch (error) {
    databaseLock.release();
    throw error;
  }
  const maintenance = createIdleMaintenanceScheduler({
    store,
    dbPath,
    idleAfterMs: maintenanceIdleMs,
    checkIntervalMs: maintenanceCheckMs,
    maintenance: {
      applyExactDuplicates: true,
      snapshotPrefix: "maintenance",
      reason: "idle maintenance: suppress exact duplicate memory",
      reportDirectory: `${dbPath}.maintenance`,
    },
    onResult(result) {
      const removed = result.exact_duplicates_suppressed;
      const review = result.semantic_review_groups;
      if (removed > 0 || review > 0) {
        process.stderr.write(
          `[dafeiyu-memory] idle maintenance: scopes=${result.scopes_scanned} ` +
            `suppressed_duplicates=${removed} semantic_review_groups=${review}\n`,
        );
      }
    },
    onError(error) {
      process.stderr.write(
        `[dafeiyu-memory] idle maintenance failed: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      );
    },
  });
  const server = createMemoryMcpServer(
    activityTrackedStore(store, () => maintenance.markActivity()),
  );
  if (!maintenanceDisabled) {
    maintenance.start();
  }
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`[dafeiyu-memory] shutting down: ${reason}\n`);
    maintenance.stop();
    try {
      await server.close();
    } catch (error) {
      process.stderr.write(
        `[dafeiyu-memory] server close error: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    try {
      store.close();
    } catch (error) {
      process.stderr.write(
        `[dafeiyu-memory] store close error: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    try {
      databaseLock.release();
    } catch (error) {
      process.stderr.write(
        `[dafeiyu-memory] lock release error: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("uncaughtException", (error) => {
    process.stderr.write(
      `[dafeiyu-memory] uncaught exception: ${error.stack ?? error.message}\n`,
    );
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (reason) => {
    process.stderr.write(
      `[dafeiyu-memory] unhandled rejection: ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }\n`,
    );
    void shutdown("unhandledRejection", 1);
  });
  process.once("exit", () => {
    maintenance.stop();
    try {
      store.close();
    } catch {
      // The process is already exiting; there is no safe recovery path.
    }
    try {
      databaseLock.release();
    } catch {
      // A stale lock is reclaimed by the next process through its PID check.
    }
  });

  try {
    await server.connect(transport);
    process.stderr.write(
      `[dafeiyu-memory] MCP server ready over stdio; database=${dbPath}; ` +
        `snapshots=${snapshotDir}; maintenance=${maintenanceDisabled ? "disabled" : `${maintenanceIdleMs}ms idle`}\n`,
    );
  } catch (error) {
    maintenance.stop();
    try {
      await server.close();
    } catch {
      // Preserve the startup failure below.
    }
    store.close();
    databaseLock.release();
    throw error;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[dafeiyu-memory] startup failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
