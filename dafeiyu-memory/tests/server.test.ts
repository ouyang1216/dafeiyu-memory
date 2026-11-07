import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryMcpServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";
import type { MemoryScope, MemoryStore } from "../src/types.js";

const scope: MemoryScope = {
  tenant_id: "tenant-mcp",
  user_id: "user-mcp",
  agent_id: "agent-mcp",
  persona_id: "dafeiyu",
  space_id: "space-mcp",
};

let directory: string;
let store: MemoryStore;
let server: McpServer;
let client: Client;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "dafeiyu-memory-mcp-"));
  store = createMemoryStore(join(directory, "memory.sqlite3"));
  server = createMemoryMcpServer(store);
  client = new Client(
    { name: "dafeiyu-memory-test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  await server.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("dafeiyu memory MCP server", () => {
  it("lists all required snake_case tools with structured output schemas", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "correct",
      "delete",
      "forget",
      "get",
      "recall",
      "remember",
      "stats",
    ]);
    for (const tool of result.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description?.length).toBeGreaterThan(80);
      expect(tool.annotations).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
    }
    expect(result.tools.find((tool) => tool.name === "recall")?.annotations)
      .toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    expect(result.tools.find((tool) => tool.name === "delete")?.annotations)
      .toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
  });

  it("remembers and recalls through the MCP client transport", async () => {
    const remembered = await client.callTool({
      name: "remember",
      arguments: {
        scope,
        kind: "semantic",
        content: {
          text: "大肥鱼的记忆系统优先使用 SQLite 做本地持久化。",
          tags: ["memory", "sqlite"],
          entities: ["大肥鱼", "SQLite"],
        },
        summary: "本地持久化优先 SQLite",
        epistemic_type: "observed",
        source_type: "conversation",
        source_label: "mcp-test",
        source_confidence: 0.92,
        factual_confidence: 0.88,
        salience: 0.8,
        identity_relevance: 0.6,
        response_format: "json",
      },
    });

    expect(remembered.isError).not.toBe(true);
    expect(remembered.structuredContent).toBeDefined();
    const memory = remembered.structuredContent?.memory as
      | { memory_id: string; version: number }
      | undefined;
    expect(memory?.version).toBe(1);
    expect(memory?.memory_id).toMatch(/^mem_/);

    const recalled = await client.callTool({
      name: "recall",
      arguments: {
        scope,
        query: "SQLite 本地持久化",
        current_goal: "实现大肥鱼记忆系统",
        max_evidence: 5,
        response_format: "json",
      },
    });

    expect(recalled.isError).not.toBe(true);
    expect(recalled.structuredContent?.decision).not.toBe("abstain");
    const evidence = recalled.structuredContent?.evidence as
      | Array<{ memory_id: string; source_confidence: number }>
      | undefined;
    expect(evidence?.[0]?.memory_id).toBe(memory?.memory_id);
    expect(evidence?.[0]?.source_confidence).toBe(0.92);

    const textBlock = recalled.content[0];
    expect(textBlock?.type).toBe("text");
    if (textBlock?.type === "text") {
      expect(textBlock.text).toContain('"decision"');
    }
  });

  it("rejects extra input fields through the strict Zod schema", async () => {
    const result = await client.callTool({
      name: "stats",
      arguments: {
        scope,
        unexpected_field: true,
      },
    });

    expect(result.isError).toBe(true);
    const textBlock = result.content[0];
    expect(textBlock?.type).toBe("text");
    if (textBlock?.type === "text") {
      expect(textBlock.text).toMatch(/Input validation error|Unrecognized key/i);
    }
  });

  it("does not expose unexpected storage errors to the MCP caller", async () => {
    vi.spyOn(store, "get").mockImplementation(() => {
      throw new Error("SQLITE_IOERR: C:\\private\\memory.sqlite3");
    });
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const result = await client.callTool({
      name: "get",
      arguments: {
        scope,
        memory_id: "mem_unknown",
        response_format: "json",
      },
    });

    expect(result.isError).toBe(true);
    const textBlock = result.content[0];
    expect(textBlock?.type).toBe("text");
    if (textBlock?.type === "text") {
      expect(textBlock.text).toContain("Unexpected internal storage error.");
      expect(textBlock.text).not.toContain("SQLITE_IOERR");
      expect(textBlock.text).not.toContain("private");
    }
    expect(stderr).toHaveBeenCalled();
  });
});
