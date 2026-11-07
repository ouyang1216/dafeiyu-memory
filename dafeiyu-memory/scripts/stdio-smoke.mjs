#!/usr/bin/env node

import assert from "node:assert/strict";
import { accessSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const entrypoint = join(projectRoot, "dist", "index.js");
const directory = mkdtempSync(join(tmpdir(), "dafeiyu-memory-stdio-"));
const dbPath = join(directory, "memory.sqlite3");
const scope = {
  tenant_id: "smoke-tenant",
  user_id: "smoke-user",
  agent_id: "smoke-agent",
  persona_id: "dafeiyu",
  space_id: "stdio-smoke",
};

let client;
let stderr = "";

try {
  accessSync(entrypoint);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env: {
      ...getDefaultEnvironment(),
      DAFEIYU_MEMORY_DB: dbPath,
      DAFEIYU_MEMORY_MAINTENANCE_IDLE_MS: "300",
      DAFEIYU_MEMORY_MAINTENANCE_CHECK_MS: "50",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  client = new Client(
    { name: "dafeiyu-memory-stdio-smoke", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["correct", "delete", "forget", "get", "recall", "remember", "stats"],
  );

  const remembered = await client.callTool({
    name: "remember",
    arguments: {
      scope,
      kind: "semantic",
      content: {
        text: "stdio smoke memory token is QUARTZ-27",
        tags: ["stdio-smoke"],
        entities: ["QUARTZ-27"],
      },
      summary: "stdio smoke marker",
      epistemic_type: "observed",
      source_type: "test",
      source_label: "stdio-smoke",
      source_confidence: 0.99,
      factual_confidence: 0.99,
      salience: 0.8,
      response_format: "json",
    },
  });
  assert.notEqual(remembered.isError, true);
  const memory = remembered.structuredContent?.memory;
  assert.equal(typeof memory?.memory_id, "string");
  assert.equal(memory?.version, 1);

  const recalled = await client.callTool({
    name: "recall",
    arguments: {
      scope,
      query: "QUARTZ-27",
      max_evidence: 3,
      response_format: "json",
    },
  });
  assert.notEqual(recalled.isError, true);
  assert.ok(
    Array.isArray(recalled.structuredContent?.evidence) &&
      recalled.structuredContent.evidence.some(
        (item) => item.memory_id === memory.memory_id,
      ),
  );

  const deleted = await client.callTool({
    name: "delete",
    arguments: {
      scope,
      memory_id: memory.memory_id,
      reason: "stdio smoke cleanup",
      requested_by: "stdio-smoke",
      response_format: "json",
    },
  });
  assert.notEqual(deleted.isError, true);
  assert.equal(deleted.structuredContent?.verified, true);
  assert.equal(deleted.structuredContent?.state, "completed");

  const afterDelete = await client.callTool({
    name: "get",
    arguments: {
      scope,
      memory_id: memory.memory_id,
      response_format: "json",
    },
  });
  assert.equal(afterDelete.structuredContent?.memory, null);

  for (const label of ["maintenance-a", "maintenance-b"]) {
    const rememberedDuplicate = await client.callTool({
      name: "remember",
      arguments: {
        scope,
        kind: "semantic",
        content: { text: "idle maintenance duplicate marker" },
        epistemic_type: "observed",
        source_type: "test",
        source_label: label,
        source_confidence: 0.98,
        factual_confidence: 0.98,
        response_format: "json",
      },
    });
    assert.notEqual(rememberedDuplicate.isError, true);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_200));
  const maintainedStats = await client.callTool({
    name: "stats",
    arguments: { scope, response_format: "json" },
  });
  assert.equal(maintainedStats.structuredContent?.active_memories, 1);
  assert.equal(maintainedStats.structuredContent?.suppressed_memories, 1);
  assert.equal(
    existsSync(
      join(directory, "memory.sqlite3.maintenance", "latest-maintenance-plan.json"),
    ),
    true,
  );
  assert.equal(existsSync(`${dbPath}.snapshots`), true);
  assert.match(stderr, /MCP server ready over stdio/);

  process.stdout.write(
    `${JSON.stringify({
      tools: tools.tools.length,
      memory_id: memory.memory_id,
      recall_decision: recalled.structuredContent?.decision,
      delete_verified: deleted.structuredContent?.verified,
      database: dbPath,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `stdio smoke failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
} finally {
  if (client !== undefined) {
    try {
      await client.close();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      if (existsSync(`${dbPath}.lock`)) {
        throw new Error("database writer lock remained after MCP shutdown");
      }
    } catch (error) {
      process.stderr.write(
        `stdio smoke client close failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(
      `stdio smoke temp cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
