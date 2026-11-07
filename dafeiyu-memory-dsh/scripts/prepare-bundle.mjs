#!/usr/bin/env node

import { accessSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(bundleRoot, "..", "dafeiyu-memory");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const bundledCore = join(bundleRoot, "node_modules", "dafeiyu-memory-mcp-server");

execFileSync(npm, ["--prefix", coreRoot, "run", "build"], {
  cwd: coreRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
accessSync(join(coreRoot, "dist", "index.js"));

rmSync(bundledCore, { recursive: true, force: true });
execFileSync(
  npm,
  ["install", "--ignore-scripts", "--install-links=true", "--no-audit", "--no-fund"],
  {
    cwd: bundleRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

accessSync(join(bundledCore, "dist", "index.js"));
process.stdout.write("[dafeiyu-memory-dsh] bundled core is ready\n");
