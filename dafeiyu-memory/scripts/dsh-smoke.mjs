#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDirectory, "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const dshBin = join(repoRoot, "apps", "cli", "lib", "bin.js");
const overlayPath = join(pluginRoot, "dafeiyu-memory.cordis.yml");
const memoryEntrypoint = join(pluginRoot, "dist", "index.js");
const tempRoot = mkdtempSync(join(tmpdir(), "dafeiyu-dsh-smoke-"));
const dbPath = join(tempRoot, "memory.sqlite3");
const shutdownTrigger = join(tempRoot, "shutdown.trigger");
const controlPluginPath = join(tempRoot, "shutdown-control.mjs");
const controlOverlayPath = join(tempRoot, "shutdown-control.cordis.yml");

const HOST = "127.0.0.1";
const DUMP_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;
const MAX_LOG_CHARS = 256 * 1024;

let dsh;
let stdout = "";
let stderr = "";
let exitResult;
let exitPromise;
let cleanupStarted = false;
let cleanupComplete = false;
let failureError;
let shutdownRequested = false;
const recordedProcesses = new Map();

function appendBounded(current, chunk) {
  const next = current + chunk;
  return next.length <= MAX_LOG_CHARS
    ? next
    : next.slice(next.length - MAX_LOG_CHARS);
}

function normalized(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function combinedLogs() {
  return [
    stdout.length > 0 ? `[stdout]\n${stdout}` : "",
    stderr.length > 0 ? `[stderr]\n${stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function logDiagnostics() {
  const lines = combinedLogs().split(/\r?\n/u);
  const relevant = lines.filter((line) =>
    /dsh web|dafeiyu|mcp-client|error|fail|warn|listen|sqlite/i.test(line),
  );
  const excerpt = (relevant.length > 0 ? relevant : lines)
    .slice(-80)
    .join("\n")
    .trim();
  if (excerpt.length > 0) {
    process.stderr.write(`\n[dsh-smoke] DSH log excerpt:\n${excerpt}\n`);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function probeFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: HOST, port: 0, exclusive: true }, resolvePromise);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  return port;
}

function powershellExecutable() {
  const candidates = [
    process.env.ProgramFiles
      ? join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")
      : undefined,
    process.env.SystemRoot
      ? join(
          process.env.SystemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : undefined,
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(
    found,
    "PowerShell is required to inspect and clean Windows process trees",
  );
  return found;
}

async function runPowerShell(script, timeoutMs = 20_000) {
  const command = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    script,
  ].join("; ");
  const { stdout: output, stderr: errors } = await execFileAsync(
    powershellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  return { stdout: output, stderr: errors };
}

async function listProcesses() {
  const script = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate",
    "ConvertTo-Json -Compress -Depth 3",
  ].join(" | ");
  const { stdout: output } = await runPowerShell(script);
  const text = output.replace(/^\uFEFF/u, "").trim();
  if (text.length === 0 || text === "null") {
    return [];
  }
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter(
      (row) =>
        row &&
        Number.isInteger(Number(row.ProcessId)) &&
        Number.isInteger(Number(row.ParentProcessId)),
    )
    .map((row) => ({
      ProcessId: Number(row.ProcessId),
      ParentProcessId: Number(row.ParentProcessId),
      Name: typeof row.Name === "string" ? row.Name : "",
      CommandLine:
        typeof row.CommandLine === "string" ? row.CommandLine : "",
      CreationDate:
        row.CreationDate === null || row.CreationDate === undefined
          ? ""
          : String(row.CreationDate),
    }));
}

function descendantsOf(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ParentProcessId) ?? [];
    list.push(row);
    children.set(row.ParentProcessId, list);
  }
  const result = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.ProcessId)) continue;
      seen.add(child.ProcessId);
      result.push(child);
      queue.push(child.ProcessId);
    }
  }
  return result;
}

function rememberProcess(row) {
  if (!row || row.ProcessId <= 0) return;
  const existing = recordedProcesses.get(row.ProcessId);
  if (
    existing === undefined ||
    existing.CreationDate === row.CreationDate
  ) {
    recordedProcesses.set(row.ProcessId, { ...row });
  }
}

async function refreshProcessEvidence() {
  if (!Number.isInteger(dsh?.pid) || dsh.pid <= 0) return [];
  const rows = await listProcesses();
  const root = rows.find((row) => row.ProcessId === dsh.pid);
  if (root !== undefined) {
    rememberProcess(root);
  }
  const descendants = descendantsOf(rows, dsh.pid);
  for (const row of descendants) rememberProcess(row);
  return descendants;
}

function processStillMatches(record, current) {
  return (
    current !== undefined &&
    current.ProcessId === record.ProcessId &&
    current.CommandLine === record.CommandLine &&
    (record.CreationDate === "" ||
      current.CreationDate === record.CreationDate)
  );
}

async function findRecordedProcess(record) {
  const rows = await listProcesses();
  const current = rows.find((row) => row.ProcessId === record.ProcessId);
  return processStillMatches(record, current) ? current : undefined;
}

async function waitFor(description, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (dsh?.exitCode !== null && dsh?.exitCode !== undefined) {
      throw new Error(
        `${description}: DSH exited early with code ${dsh.exitCode}`,
      );
    }
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `${description}: timed out after ${timeoutMs}ms${
      lastError instanceof Error ? ` (${lastError.message})` : ""
    }`,
  );
}

async function assertHttp200(url) {
  return await waitFor("waiting for DSH HTTP 200", STARTUP_TIMEOUT_MS, async () => {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(String(error));
    }
  });
}

async function waitForStartupLog(expectedUrl) {
  return await waitFor("waiting for the DSH web startup log", 10_000, () => {
    const urls = [
      ...combinedLogs().matchAll(/dsh web:\s+(http:\/\/[^\s]+)/gu),
    ].map((match) => match[1].replace(/[)\].,;]+$/u, ""));
    return urls.some((url) => {
      try {
        const parsed = new URL(url);
        return (
          parsed.hostname === HOST &&
          Number(parsed.port) === Number(new URL(expectedUrl).port)
        );
      } catch {
        return false;
      }
    });
  });
}

async function waitForMemoryMcpChild() {
  return await waitFor(
    "waiting for the dafeiyu memory MCP child process",
    15_000,
    async () => {
      const descendants = await refreshProcessEvidence();
      const expected = normalized(memoryEntrypoint);
      return descendants.find(
        (row) =>
          /^node(?:\.exe)?$/iu.test(row.Name) &&
          normalized(row.CommandLine).includes(expected),
      );
    },
  );
}

async function assertTemporaryDatabaseUsed() {
  await waitFor(
    "waiting for the memory server to report the temporary database",
    10_000,
    () => {
      const logs = normalized(combinedLogs());
      return (
        logs.includes(normalized(dbPath)) &&
        logs.includes("[dafeiyu-memory] mcp server ready over stdio")
      );
    },
  );
  assert.equal(
    existsSync(dbPath),
    true,
    `temporary SQLite database was not created: ${dbPath}`,
  );
  assert.ok(
    statSync(dbPath).size > 0,
    `temporary SQLite database is empty: ${dbPath}`,
  );
  assert.equal(
    existsSync(`${dbPath}.snapshots`),
    true,
    `temporary SQLite snapshot directory is missing: ${dbPath}.snapshots`,
  );
}

async function runDumpConfig() {
  const { stdout: output, stderr: errors } = await execFileAsync(
    process.execPath,
    [
      dshBin,
      "--profile",
      "web",
      "--patch",
      overlayPath,
      "--dump-config",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DAFEIYU_MEMORY_SERVER_ENTRY: memoryEntrypoint,
        DSH_TELEMETRY_DISABLED: "1",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: DUMP_TIMEOUT_MS,
      windowsHide: true,
    },
  );

  assert.match(
    output,
    /^- id: memory-dafeiyu$/mu,
    "dump-config did not include the memory-dafeiyu overlay row",
  );
  const memoryBlockStart = output.search(/^- id: memory-dafeiyu$/mu);
  assert.ok(memoryBlockStart >= 0);
  const nextBlock = output.slice(memoryBlockStart + 1).search(/^- id: /mu);
  const memoryBlock =
    nextBlock >= 0
      ? output.slice(memoryBlockStart, memoryBlockStart + 1 + nextBlock)
      : output.slice(memoryBlockStart);
  assert.match(
    memoryBlock,
    /name: '@deepseek-ai\/dsh-mcp-client'/u,
    "dump-config memory row did not load dsh-mcp-client",
  );
  assert.match(
    memoryBlock,
    /serverName: dafeiyu_memory/u,
    "dump-config memory row did not configure serverName dafeiyu_memory",
  );
  return { stdout: output, stderr: errors };
}

function writeShutdownControl() {
  writeFileSync(
    controlPluginPath,
    `import { existsSync } from "node:fs";

export const name = "dafeiyu-smoke-shutdown";

export function apply(ctx) {
  const trigger = process.env.DAFEIYU_SMOKE_SHUTDOWN_FILE;
  if (!trigger) {
    throw new Error("DAFEIYU_SMOKE_SHUTDOWN_FILE is required");
  }
  let announced = false;
  const timer = setInterval(() => {
    if (!existsSync(trigger) || announced) return;
    announced = true;
    clearInterval(timer);
    process.stdout.write("[dafeiyu-smoke] graceful shutdown trigger observed\\n");
    const exit = ctx.get("appExit");
    if (typeof exit !== "function") {
      throw new Error("ctx.appExit is unavailable");
    }
    exit(0);
  }, 100);
  timer.unref();
  ctx.effect(() => () => clearInterval(timer), "dafeiyu-smoke-shutdown.timer");
}
`,
    "utf8",
  );
  writeFileSync(
    controlOverlayPath,
    [
      "- insert:",
      "    - id: dafeiyu-smoke-shutdown",
      `      name: ${JSON.stringify(pathToFileURL(controlPluginPath).href)}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function startDsh(port) {
  const args = [
    dshBin,
    "--profile",
    "web",
    "--patch",
    overlayPath,
    "--patch",
    controlOverlayPath,
    "--host",
    HOST,
    "--port",
    String(port),
    "--no-open",
  ];
  dsh = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      DAFEIYU_MEMORY_DB: dbPath,
      DAFEIYU_MEMORY_SERVER_ENTRY: memoryEntrypoint,
      DAFEIYU_SMOKE_SHUTDOWN_FILE: shutdownTrigger,
      DSH_TELEMETRY_DISABLED: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  assert.ok(
    Number.isInteger(dsh.pid) && dsh.pid > 0,
    "failed to obtain the DSH child PID",
  );
  dsh.stdout.setEncoding("utf8");
  dsh.stderr.setEncoding("utf8");
  dsh.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  dsh.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  exitPromise = new Promise((resolvePromise, rejectPromise) => {
    dsh.once("error", rejectPromise);
    dsh.once("exit", (code, signal) => {
      exitResult = { code, signal };
      resolvePromise(exitResult);
    });
  });
}

async function waitForDshExit() {
  if (exitResult !== undefined) return exitResult;
  return await Promise.race([
    exitPromise,
    delay(SHUTDOWN_TIMEOUT_MS).then(() => {
      throw new Error(
        `DSH did not exit within ${SHUTDOWN_TIMEOUT_MS}ms after graceful shutdown`,
      );
    }),
  ]);
}

async function waitForRecordedProcessExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await findRecordedProcess(record)) === undefined) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

async function forceKillRecorded(record) {
  const current = await findRecordedProcess(record);
  if (current === undefined) return false;
  try {
    process.kill(current.ProcessId, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return true;
}

async function cleanup() {
  if (cleanupStarted) {
    if (!cleanupComplete) {
      while (!cleanupComplete) await delay(50);
    }
    return;
  }
  cleanupStarted = true;
  const cleanupErrors = [];

  try {
    if (dsh?.exitCode === null || dsh?.exitCode === undefined) {
      try {
        await refreshProcessEvidence();
      } catch (error) {
        cleanupErrors.push(
          `process evidence refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (
      dsh !== undefined &&
      (dsh.exitCode === null || dsh.exitCode === undefined)
    ) {
      try {
        process.kill(dsh.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") {
          cleanupErrors.push(
            `DSH PID ${dsh.pid} kill failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      try {
        if (exitPromise !== undefined) {
          await Promise.race([exitPromise, delay(5_000)]);
        }
      } catch (error) {
        cleanupErrors.push(
          `DSH exit wait failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const records = [...recordedProcesses.values()].sort(
      (left, right) => right.ParentProcessId - left.ParentProcessId,
    );
    for (const record of records) {
      try {
        await forceKillRecorded(record);
      } catch (error) {
        cleanupErrors.push(
          `PID ${record.ProcessId} targeted cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await delay(300);
    for (const record of records) {
      try {
        const current = await findRecordedProcess(record);
        if (current !== undefined) {
          cleanupErrors.push(
            `PID ${record.ProcessId} (${record.Name}) still matches its recorded command line`,
          );
        }
      } catch (error) {
        cleanupErrors.push(
          `PID ${record.ProcessId} cleanup verification failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } finally {
    try {
      rmSync(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
      if (existsSync(tempRoot)) {
        cleanupErrors.push(`temporary directory still exists: ${tempRoot}`);
      }
    } catch (error) {
      cleanupErrors.push(
        `temporary directory cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    cleanupComplete = true;
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`cleanup failed:\n- ${cleanupErrors.join("\n- ")}`);
  }
}

async function askDshToShutdown() {
  shutdownRequested = true;
  writeFileSync(shutdownTrigger, "shutdown\n", "utf8");
}

async function main() {
  process.stdout.write(
    `[dsh-smoke] plugin=${pluginRoot}\n[dsh-smoke] temp=${tempRoot}\n`,
  );
  accessSync(dshBin);
  accessSync(overlayPath);
  accessSync(memoryEntrypoint);

  const port = await probeFreePort();
  assert.equal(HOST, "127.0.0.1");
  process.stdout.write(
    `[dsh-smoke] checking overlay with DSH --dump-config...\n`,
  );
  const dump = await runDumpConfig();
  if (dump.stderr.trim().length > 0) {
    process.stdout.write(
      `[dsh-smoke] dump-config stderr (non-blocking): ${dump.stderr.trim()}\n`,
    );
  }
  process.stdout.write(
    `[dsh-smoke] dump-config OK: memory-dafeiyu -> @deepseek-ai/dsh-mcp-client\n`,
  );

  writeShutdownControl();
  process.stdout.write(
    `[dsh-smoke] starting DSH on http://${HOST}:${port} ...\n`,
  );
  startDsh(port);
  await waitFor("waiting for the DSH process evidence", 10_000, async () => {
    const descendants = await refreshProcessEvidence();
    return recordsContainRoot() && descendants.length > 0;
  });

  const url = `http://${HOST}:${port}/`;
  await assertHttp200(url);
  process.stdout.write(`[dsh-smoke] HTTP 200: ${url}\n`);
  await waitForStartupLog(url);
  process.stdout.write(
    `[dsh-smoke] startup log OK: dsh web: http://${HOST}:${port}\n`,
  );
  const mcpChild = await waitForMemoryMcpChild();
  process.stdout.write(
    `[dsh-smoke] MCP child OK: PID ${mcpChild.ProcessId} ${mcpChild.CommandLine}\n`,
  );
  await assertTemporaryDatabaseUsed();
  process.stdout.write(
    `[dsh-smoke] temporary SQLite DB OK: ${dbPath}\n`,
  );

  await askDshToShutdown();
  const dshExit = await waitForDshExit();
  assert.equal(
    dshExit.code,
    0,
    `DSH graceful shutdown returned code ${dshExit.code}`,
  );
  process.stdout.write(`[dsh-smoke] DSH exited cleanly (code 0)\n`);
  assert.equal(
    await waitForRecordedProcessExit(mcpChild, 10_000),
    true,
    `MCP child PID ${mcpChild.ProcessId} remained alive after DSH shutdown`,
  );
  process.stdout.write(
    `[dsh-smoke] MCP child PID ${mcpChild.ProcessId} exited\n`,
  );

  await assertPortReleased(port);
  process.stdout.write(`[dsh-smoke] port ${port} released\n`);
  assert.match(stdout + stderr, /\[dafeiyu-smoke\] graceful shutdown trigger observed/u);

  await cleanup();
  process.stdout.write(
    `[dsh-smoke] cleanup OK: no tracked process remains; temp directory removed\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      result: "pass",
      host: HOST,
      port,
      dumpConfig: "memory-dafeiyu -> @deepseek-ai/dsh-mcp-client",
      httpStatus: 200,
      dshPid: dsh.pid,
      mcpPid: mcpChild.ProcessId,
      dshExitCode: dshExit.code,
      mcpExited: true,
      tempDatabase: "random temporary SQLite database",
    })}\n`,
  );
}

function recordsContainRoot() {
  const root = recordedProcesses.get(dsh.pid);
  return (
    root !== undefined &&
    normalized(root.CommandLine).includes(normalized(dshBin))
  );
}

async function assertPortReleased(port) {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: HOST, port, exclusive: true }, resolvePromise);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.stderr.write(`[dsh-smoke] ${signal} received; cleaning up\n`);
    void cleanup()
      .catch((error) => {
        process.stderr.write(
          `[dsh-smoke] emergency cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      })
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await main();
} catch (error) {
  failureError = error;
  process.stderr.write(
    `\n[dsh-smoke] FAIL: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  if (
    dsh !== undefined ||
    shutdownRequested ||
    combinedLogs().trim().length > 0
  ) {
    logDiagnostics();
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    process.stderr.write(
      `\n[dsh-smoke] cleanup failure: ${
        cleanupError instanceof Error
          ? (cleanupError.stack ?? cleanupError.message)
          : String(cleanupError)
      }\n`,
    );
  }
  process.exitCode = 1;
}

if (failureError === undefined) {
  process.exitCode = 0;
}
