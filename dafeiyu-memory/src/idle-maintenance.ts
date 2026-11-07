import type { MemoryStore } from "./types.js";
import {
  runMaintenance,
  type RunMaintenanceOptions,
  type RunMaintenanceResult,
} from "./maintenance.js";

export interface IdleMaintenanceSchedulerOptions {
  store: MemoryStore;
  dbPath: string;
  idleAfterMs: number;
  checkIntervalMs: number;
  maintenance?: RunMaintenanceOptions;
  onResult?: (result: RunMaintenanceResult) => void;
  onError?: (error: unknown) => void;
}

export interface IdleMaintenanceScheduler {
  markActivity(): void;
  start(): void;
  stop(): void;
  runNow(): RunMaintenanceResult | null;
}

function positiveInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

/**
 * Runs deterministic memory maintenance only after a period without tool
 * activity. The timer is unref'd so it cannot keep the stdio server alive.
 */
export function createIdleMaintenanceScheduler(
  options: IdleMaintenanceSchedulerOptions,
): IdleMaintenanceScheduler {
  const idleAfterMs = positiveInteger("idleAfterMs", options.idleAfterMs);
  const checkIntervalMs = positiveInteger(
    "checkIntervalMs",
    options.checkIntervalMs,
  );
  let lastActivityAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const runNow = (): RunMaintenanceResult | null => {
    if (stopped || running) {
      return null;
    }
    running = true;
    try {
      const result = runMaintenance(options.store, options.dbPath, {
        ...options.maintenance,
        applyExactDuplicates: options.maintenance?.applyExactDuplicates ?? true,
      });
      lastActivityAt = Date.now();
      options.onResult?.(result);
      return result;
    } catch (error) {
      options.onError?.(error);
      return null;
    } finally {
      running = false;
    }
  };

  return {
    markActivity(): void {
      lastActivityAt = Date.now();
    },
    start(): void {
      if (timer !== undefined || stopped) {
        return;
      }
      timer = setInterval(() => {
        if (Date.now() - lastActivityAt < idleAfterMs) {
          return;
        }
        runNow();
      }, checkIntervalMs);
      timer.unref();
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    runNow,
  };
}
