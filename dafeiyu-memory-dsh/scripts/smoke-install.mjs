#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(bundleRoot, "..", "..");
const dshBin = join(repoRoot, "apps", "cli", "lib", "bin.js");
const tarball = join(bundleRoot, "dafeiyu-memory-dsh-0.2.1.tgz");
const profile = "web";
const bundledCore = join(
  bundleRoot,
  "node_modules",
  "dafeiyu-memory-mcp-server",
  "dist",
  "index.js",
);
const desktopPnpm =
  "D:\\harness\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.cjs";
const tempRoot = mkdtempSync(join(tmpdir(), "dafeiyu-bundle-install-"));
const shimDirectory = join(tempRoot, "bin");
const dbPath = join(tempRoot, "memory.sqlite3");
const triggerPath = join(tempRoot, "shutdown.trigger");
let dshProcess;
let dshOutput = "";

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function profileManifest(home) {
  return JSON.parse(
    readFileSync(join(home, "profiles", profile, "package.json"), "utf8"),
  );
}

function assertInstalled(home) {
  const manifest = profileManifest(home);
  assert.equal(typeof manifest.dependencies?.["dafeiyu-memory-dsh"], "string");
  assert.ok(manifest.dsh?.profile?.bundles?.includes("dafeiyu-memory-dsh"));
}

async function probeFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolvePromise);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  return port;
}

function writeShutdownControl() {
  const plugin = join(tempRoot, "shutdown-control.mjs");
  const overlay = join(tempRoot, "shutdown-control.yml");
  writeFileSync(
    plugin,
    `import { existsSync } from "node:fs";

export function apply(ctx) {
  const timer = setInterval(() => {
    if (!existsSync(process.env.DAFEIYU_SMOKE_SHUTDOWN_FILE)) return;
    clearInterval(timer);
    const exit = ctx.get("appExit");
    if (typeof exit !== "function") throw new Error("appExit unavailable");
    exit(0);
  }, 100);
  timer.unref();
  ctx.effect(() => () => clearInterval(timer), "dafeiyu-smoke-shutdown.timer");
}
`,
    "utf8",
  );
  writeFileSync(
    overlay,
    [
      "- insert:",
      "    - id: dafeiyu-smoke-shutdown",
      `      name: '${pathToFileURL(plugin).href}'`,
      "",
    ].join("\n"),
    "utf8",
  );
  return overlay;
}

async function waitForHttp(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (dshProcess?.exitCode !== null && dshProcess?.exitCode !== undefined) {
      throw new Error(`DSH exited early with code ${dshProcess.exitCode}`);
    }
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // The web server has not bound yet.
    }
    await delay(250);
  }
  throw new Error(`DSH did not return HTTP 200 at ${url}`);
}

async function stopTrackedProcess() {
  if (
    dshProcess === undefined ||
    dshProcess.exitCode !== null ||
    dshProcess.exitCode !== undefined
  ) {
    return;
  }
  if (process.platform === "win32") {
    await run("taskkill.exe", ["/PID", String(dshProcess.pid), "/T", "/F"], {
      timeout: 15_000,
    }).catch(() => {});
  } else {
    dshProcess.kill("SIGKILL");
  }
}

async function main() {
  accessSync(dshBin);
  accessSync(tarball);
  accessSync(bundledCore);
  accessSync(desktopPnpm);

  mkdirSync(shimDirectory, { recursive: true });
  writeFileSync(
    join(shimDirectory, "pnpm.cmd"),
    `@echo off\r\nnode "${desktopPnpm}" %*\r\n`,
    "ascii",
  );

  const env = {
    ...process.env,
    DSH_HOME: tempRoot,
    PATH: `${shimDirectory};${process.env.PATH ?? ""}`,
    DSH_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  };

  process.stdout.write(`[bundle-smoke] temp=${tempRoot}\n`);
  process.stdout.write("[bundle-smoke] installing tarball...\n");
  await run(process.execPath, [
    dshBin,
    "plugin",
    "--profile",
    profile,
    "add",
    tarball,
  ], { env });
  assertInstalled(tempRoot);

  const dump = await run(process.execPath, [
    dshBin,
    "--profile",
    profile,
    "--dump-config",
  ], { env });
  assert.match(dump.stdout, /id: memory-dafeiyu/u);
  assert.match(dump.stdout, /name: '@deepseek-ai\/dsh-mcp-client'/u);
  assert.match(dump.stdout, /serverName: dafeiyu_memory/u);
  assert.doesNotMatch(dump.stdout, /D:\/deepseek\/plugins\/dafeiyu-memory/u);
  process.stdout.write("[bundle-smoke] dump-config OK\n");

  process.stdout.write("[bundle-smoke] removing and reinstalling...\n");
  await run(process.execPath, [
    dshBin,
    "plugin",
    "--profile",
    profile,
    "remove",
    "dafeiyu-memory-dsh",
  ], { env });
  assert.equal(profileManifest(tempRoot).dependencies?.["dafeiyu-memory-dsh"], undefined);
  assert.ok(!profileManifest(tempRoot).dsh?.profile?.bundles?.includes("dafeiyu-memory-dsh"));
  await run(process.execPath, [
    dshBin,
    "plugin",
    "--profile",
    profile,
    "add",
    tarball,
  ], { env });
  assertInstalled(tempRoot);

  const port = await probeFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const controlOverlay = writeShutdownControl();
  process.stdout.write(`[bundle-smoke] starting DSH at ${url}\n`);
  dshProcess = spawn(
    process.execPath,
    [
      dshBin,
      "--profile",
      profile,
      "--patch",
      controlOverlay,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ],
    {
      cwd: repoRoot,
      env: {
        ...env,
        DAFEIYU_MEMORY_DB: dbPath,
        DAFEIYU_SMOKE_SHUTDOWN_FILE: triggerPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  dshProcess.stdout.setEncoding("utf8");
  dshProcess.stderr.setEncoding("utf8");
  dshProcess.stdout.on("data", (chunk) => {
    dshOutput += chunk;
  });
  dshProcess.stderr.on("data", (chunk) => {
    dshOutput += chunk;
  });

  await waitForHttp(url);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      dshOutput.includes("[dafeiyu-memory] MCP server ready over stdio") &&
      dshOutput.includes(dbPath)
    ) {
      break;
    }
    await delay(100);
  }
  assert.match(dshOutput, /\[dafeiyu-memory\] MCP server ready over stdio/u);
  assert.ok(dshOutput.includes(dbPath));
  assert.equal(existsSync(dbPath), true);
  process.stdout.write("[bundle-smoke] HTTP 200 and temporary SQLite ready\n");
  await delay(2_000);

  writeFileSync(triggerPath, "stop\n", "utf8");
  const exit = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(undefined), 30_000);
    dshProcess.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(existsSync(`${dbPath}.lock`), false);
  process.stdout.write("[bundle-smoke] graceful shutdown and lock release OK\n");
}

try {
  await main();
  process.stdout.write(
    `${JSON.stringify({ result: "pass", install: "add/remove/add", httpStatus: 200 })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `[bundle-smoke] FAIL: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.stderr.write(`[bundle-smoke] output:\n${dshOutput}\n`);
  await stopTrackedProcess();
  process.exitCode = 1;
} finally {
  await stopTrackedProcess();
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
