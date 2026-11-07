import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MemoryInputError, MemoryNotFoundError } from "./errors.js";
import type {
  CorrectInput,
  DeleteInput,
  ForgetInput,
  MemoryContent,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  RecallInput,
  RecallResult,
  RememberInput,
  ResponseFormat,
} from "./types.js";

const memoryKindSchema = z.enum([
  "episodic",
  "semantic",
  "procedural",
  "prospective",
  "autobiographical",
  "social",
]);

const epistemicTypeSchema = z.enum([
  "observed",
  "reported",
  "inferred",
  "imagined",
  "generated",
  "injected",
  "unknown",
]);

const memoryStatusSchema = z.enum([
  "active",
  "suppressed",
  "archived",
  "quarantined",
  "deleted",
]);

const responseFormatSchema = z
  .enum(["json", "markdown"])
  .default("json")
  .describe(
    "json is the primary machine-readable format; markdown is for direct human inspection.",
  );

const scopeSchema = z
  .object({
    tenant_id: z.string().min(1).max(512).describe("Tenant partition id."),
    user_id: z.string().min(1).max(512).describe("User/owner partition id."),
    agent_id: z.string().min(1).max(512).describe("Agent partition id."),
    persona_id: z
      .string()
      .min(1)
      .max(512)
      .describe("Persona id, for example dafeiyu."),
    space_id: z
      .string()
      .min(1)
      .max(512)
      .describe("Conversation, project, or workspace partition id."),
  })
  .strict();

const contentSchema = z
  .object({
    text: z.string().min(1).max(100_000).describe("Canonical memory text."),
    tags: z.array(z.string().min(1).max(256)).max(200).optional(),
    entities: z.array(z.string().min(1).max(256)).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const rememberSchema = z
  .object({
    scope: scopeSchema,
    kind: memoryKindSchema.describe(
      "episodic=event, semantic=fact, procedural=how-to, prospective=future intention, autobiographical=self history, social=relationship knowledge.",
    ),
    content: contentSchema,
    summary: z.string().min(1).max(4_000).optional(),
    epistemic_type: epistemicTypeSchema,
    source_type: z
      .string()
      .min(1)
      .max(512)
      .describe("Source category, for example conversation, document, or tool_result."),
    source_label: z
      .string()
      .min(1)
      .max(2_000)
      .describe("Human-readable source identifier or short label."),
    source_confidence: z.number().min(0).max(1),
    factual_confidence: z.number().min(0).max(1),
    salience: z.number().min(0).max(1).optional(),
    identity_relevance: z.number().min(0).max(1).optional(),
    valid_from: z.string().min(1).max(128).optional(),
    valid_to: z.string().min(1).max(128).optional(),
    privacy_level: z.string().min(1).max(128).optional(),
    retention_class: z.string().min(1).max(128).optional(),
    occurred_at: z.string().min(1).max(128).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    response_format: responseFormatSchema,
  })
  .strict();

const recallSchema = z
  .object({
    scope: scopeSchema,
    query: z
      .string()
      .min(1)
      .max(10_000)
      .describe("Natural-language retrieval query in Chinese or English."),
    current_goal: z.string().min(1).max(10_000).optional(),
    current_context: z.record(z.string(), z.unknown()).optional(),
    kinds: z.array(memoryKindSchema).min(1).max(6).optional(),
    max_candidates: z.number().int().min(1).max(1_000).optional(),
    max_evidence: z.number().int().min(1).max(50).optional(),
    include_suppressed: z.boolean().optional(),
    response_format: responseFormatSchema,
  })
  .strict();

const getSchema = z
  .object({
    scope: scopeSchema,
    memory_id: z.string().min(1).max(512),
    response_format: responseFormatSchema,
  })
  .strict();

const correctSchema = z
  .object({
    scope: scopeSchema,
    memory_id: z.string().min(1).max(512),
    content: contentSchema,
    summary: z.string().min(1).max(4_000).optional(),
    reason: z.string().min(1).max(10_000),
    source_type: z.string().min(1).max(512),
    source_label: z.string().min(1).max(2_000),
    source_confidence: z.number().min(0).max(1),
    factual_confidence: z.number().min(0).max(1),
    response_format: responseFormatSchema,
  })
  .strict();

const forgetSchema = z
  .object({
    scope: scopeSchema,
    memory_id: z.string().min(1).max(512),
    mode: z
      .enum(["suppress", "archive", "quarantine"])
      .describe(
        "suppress hides a memory from default recall, archive demotes but keeps it, quarantine isolates untrusted data.",
      ),
    reason: z.string().min(1).max(10_000),
    response_format: responseFormatSchema,
  })
  .strict();

const deleteSchema = z
  .object({
    scope: scopeSchema,
    memory_id: z.string().min(1).max(512),
    reason: z.string().min(1).max(10_000),
    requested_by: z.string().min(1).max(2_000),
    response_format: responseFormatSchema,
  })
  .strict();

const statsSchema = z
  .object({
    scope: scopeSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const memoryContentOutputSchema = z
  .object({
    text: z.string(),
    tags: z.array(z.string()).optional(),
    entities: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const memoryRecordOutputSchema = z
  .object({
    memory_id: z.string(),
    version_id: z.string(),
    version: z.number().int(),
    kind: memoryKindSchema,
    status: memoryStatusSchema,
    content: memoryContentOutputSchema,
    summary: z.string().nullable(),
    epistemic_type: epistemicTypeSchema,
    source_type: z.string(),
    source_label: z.string(),
    source_confidence: z.number(),
    factual_confidence: z.number(),
    salience: z.number(),
    activation_strength: z.number(),
    identity_relevance: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
    last_accessed_at: z.string().nullable(),
    access_count: z.number().int(),
    valid_from: z.string().nullable(),
    valid_to: z.string().nullable(),
    privacy_level: z.string(),
    retention_class: z.string(),
  })
  .strict();

const rememberOutputSchema = z
  .object({ memory: memoryRecordOutputSchema })
  .strict();

const recallEvidenceOutputSchema = z
  .object({
    memory_id: z.string(),
    version_id: z.string(),
    kind: memoryKindSchema,
    summary: z.string(),
    text: z.string(),
    epistemic_type: epistemicTypeSchema,
    source_type: z.string(),
    source_label: z.string(),
    source_confidence: z.number(),
    factual_confidence: z.number(),
    activation: z.number(),
    lexical_score: z.number(),
    recency_score: z.number(),
    goal_score: z.number(),
    conflict_ids: z.array(z.string()),
    created_at: z.string(),
  })
  .strict();

const recallOutputSchema = z
  .object({
    decision: z.enum([
      "direct",
      "qualified",
      "uncertain",
      "multi_perspective",
      "abstain",
    ]),
    query: z.string(),
    evidence: z.array(recallEvidenceOutputSchema),
    conflicts: z.array(z.string()),
    explanation: z.string(),
    total_candidates: z.number().int(),
  })
  .strict();

const getOutputSchema = z
  .object({ memory: memoryRecordOutputSchema.nullable() })
  .strict();

const forgetOutputSchema = rememberOutputSchema;
const correctOutputSchema = rememberOutputSchema;

const deleteOutputSchema = z
  .object({
    memory_id: z.string(),
    state: z.literal("completed"),
    redacted_events: z.number().int(),
    deleted_versions: z.number().int(),
    deleted_links: z.number().int(),
    verified: z.boolean(),
    completed_at: z.string(),
  })
  .strict();

const statsOutputSchema = z
  .object({
    total_memories: z.number().int(),
    active_memories: z.number().int(),
    suppressed_memories: z.number().int(),
    quarantined_memories: z.number().int(),
    deleted_memories: z.number().int(),
    total_versions: z.number().int(),
    total_links: z.number().int(),
  })
  .strict();

type RememberParams = z.infer<typeof rememberSchema>;
type RecallParams = z.infer<typeof recallSchema>;
type GetParams = z.infer<typeof getSchema>;
type CorrectParams = z.infer<typeof correctSchema>;
type ForgetParams = z.infer<typeof forgetSchema>;
type DeleteParams = z.infer<typeof deleteSchema>;
type StatsParams = z.infer<typeof statsSchema>;

function toolOutput(
  payload: Record<string, unknown>,
  responseFormat: ResponseFormat,
  markdown: string,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          responseFormat === "markdown"
            ? markdown
            : JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function toolError(toolName: string, hint: string, error: unknown): CallToolResult {
  const safe =
    error instanceof MemoryInputError || error instanceof MemoryNotFoundError;
  if (!safe) {
    process.stderr.write(
      `[dafeiyu-memory] ${toolName} internal error: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
  }
  const message = safe
    ? (error as Error).message
    : "Unexpected internal storage error.";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${toolName} failed: ${message}\nNext step: ${hint}`,
      },
    ],
  };
}

function markdownMemory(memory: MemoryRecord): string {
  return [
    `# Memory ${memory.memory_id}`,
    "",
    `- Version: ${memory.version} (${memory.version_id})`,
    `- Kind: ${memory.kind}`,
    `- Status: ${memory.status}`,
    `- Epistemic type: ${memory.epistemic_type}`,
    `- Source: ${memory.source_label} (${memory.source_type})`,
    `- Source confidence: ${memory.source_confidence.toFixed(2)}`,
    `- Factual confidence: ${memory.factual_confidence.toFixed(2)}`,
    `- Salience: ${memory.salience.toFixed(2)}`,
    `- Activation: ${memory.activation_strength.toFixed(2)}`,
    "",
    memory.summary ? `## Summary\n${memory.summary}` : "## Summary\n(none)",
    "",
    `## Content\n${memory.content.text}`,
  ].join("\n");
}

function markdownRecall(result: RecallResult): string {
  const lines = [
    `# Recall: ${result.decision}`,
    "",
    result.explanation,
    "",
    `Eligible candidates: ${result.total_candidates}`,
    `Evidence returned: ${result.evidence.length}`,
  ];
  if (result.conflicts.length > 0) {
    lines.push(`Conflict pairs: ${result.conflicts.length}`);
  }
  for (const item of result.evidence) {
    lines.push(
      "",
      `## ${item.memory_id} (${item.kind})`,
      `- Summary: ${item.summary}`,
      `- Text: ${item.text}`,
      `- Source confidence: ${item.source_confidence.toFixed(2)}`,
      `- Factual confidence: ${item.factual_confidence.toFixed(2)}`,
      `- Lexical score: ${item.lexical_score.toFixed(3)}`,
      `- Recency score: ${item.recency_score.toFixed(3)}`,
      `- Goal score: ${item.goal_score.toFixed(3)}`,
      `- Conflicts: ${item.conflict_ids.length > 0 ? item.conflict_ids.join(", ") : "none"}`,
    );
  }
  return lines.join("\n");
}

function withOptional<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V | undefined,
): T & Partial<Record<K, V>> {
  if (value === undefined) {
    return target;
  }
  return { ...target, [key]: value } as T & Partial<Record<K, V>>;
}

function toContent(
  content: z.infer<typeof contentSchema>,
): MemoryContent {
  let result: MemoryContent = { text: content.text };
  result = withOptional(result, "tags", content.tags);
  result = withOptional(result, "entities", content.entities);
  result = withOptional(result, "metadata", content.metadata);
  return result;
}

function toRememberInput(params: RememberParams): RememberInput {
  let input: RememberInput = {
    scope: params.scope,
    kind: params.kind,
    content: toContent(params.content),
    epistemic_type: params.epistemic_type,
    source_type: params.source_type,
    source_label: params.source_label,
    source_confidence: params.source_confidence,
    factual_confidence: params.factual_confidence,
  };
  input = withOptional(input, "summary", params.summary);
  input = withOptional(input, "salience", params.salience);
  input = withOptional(input, "identity_relevance", params.identity_relevance);
  input = withOptional(input, "valid_from", params.valid_from);
  input = withOptional(input, "valid_to", params.valid_to);
  input = withOptional(input, "privacy_level", params.privacy_level);
  input = withOptional(input, "retention_class", params.retention_class);
  input = withOptional(input, "occurred_at", params.occurred_at);
  input = withOptional(input, "attributes", params.attributes);
  return input;
}

function toRecallInput(params: RecallParams): RecallInput {
  let input: RecallInput = {
    scope: params.scope,
    query: params.query,
  };
  input = withOptional(input, "current_goal", params.current_goal);
  input = withOptional(input, "current_context", params.current_context);
  input = withOptional(input, "kinds", params.kinds);
  input = withOptional(input, "max_candidates", params.max_candidates);
  input = withOptional(input, "max_evidence", params.max_evidence);
  input = withOptional(input, "include_suppressed", params.include_suppressed);
  return input;
}

function toCorrectInput(params: CorrectParams): CorrectInput {
  let input: CorrectInput = {
    scope: params.scope,
    memory_id: params.memory_id,
    content: toContent(params.content),
    reason: params.reason,
    source_type: params.source_type,
    source_label: params.source_label,
    source_confidence: params.source_confidence,
    factual_confidence: params.factual_confidence,
  };
  input = withOptional(input, "summary", params.summary);
  return input;
}

/**
 * Creates an MCP server around a MemoryStore. Keeping this as a factory lets
 * tests use the exact same tool registration as the stdio entry point.
 */
export function createMemoryMcpServer(store: MemoryStore): McpServer {
  const server = new McpServer(
    {
      name: "dafeiyu-memory-mcp-server",
      version: "0.2.1",
      description:
        "Local-first associative memory for the Dafeiyu agent persona.",
    },
    {
      instructions:
        "Use recall before asserting remembered facts. Preserve source and factual confidence separately. Use forget for reversible suppression and delete only for an explicit hard-redaction request. Never record an outbound message as sent unless a channel or adapter confirmed delivery for that message. The storage kernel creates database snapshots and performs exact-duplicate maintenance while idle; do not invent snapshot or maintenance tools.",
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: `Store a new durable memory with provenance and immutable initial version.

Use when the user explicitly asks you to remember something, or explicitly asks to persist a durable preference, fact, or decision. Do not use it for transient context, guesses, or secrets. Never record an assistant-generated or outbound message as sent, delivered, or observed unless a channel or adapter returned a successful delivery ack for that exact message. To correct an existing memory, use correct instead.
Required: full scope, kind, content, epistemic type, source details, source confidence, and factual confidence.
Optional: summary, salience, identity relevance, validity window, privacy/retention class, occurrence time, and attributes.
To mark a contradiction to an existing memory, put its id in attributes.conflicts_with.

Returns: { memory: MemoryRecord }.
Examples:
  - A user preference from conversation.
  - A verified project fact from a document.
  - An inferred relationship with lower factual confidence.

Errors explain whether scope, confidence, content, or storage is invalid. Do not use this tool for secrets that should not be persisted.`,
      inputSchema: rememberSchema,
      outputSchema: rememberOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: RememberParams) => {
      try {
        const memory = store.remember(toRememberInput(params));
        const payload = { memory };
        return toolOutput(payload, params.response_format, markdownMemory(memory));
      } catch (error) {
        return toolError(
          "remember",
          "Check scope ids, confidence ranges (0..1), and non-empty content; then retry.",
          error,
        );
      }
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description: `Retrieve memories using hybrid lexical relevance, recency, salience, activation, identity relevance, and optional current-goal/context overlap.

Use before answering questions about prior conversations, long-term preferences, earlier decisions, or project history, and whenever relevant remembered context is not already present. If evidence conflicts, explain the competing memories and their sources rather than silently choosing one; if evidence is weak or absent, say so.
Chinese CJK bigrams and English words are supported. Scope filtering is mandatory. Suppressed, quarantined, and deleted memories are excluded by default. Source and factual confidence are returned as evidence and influence the decision, but are not treated as activation.

Returns a RecallResult with decision direct | qualified | uncertain | multi_perspective | abstain, ranked evidence, conflict ids, and an explanation.
Use include_suppressed only when explicitly auditing suppressed memories; quarantined records remain excluded from recall and require an explicit get by id. Treat multi_perspective output as competing perspectives rather than choosing silently.

Errors suggest checking scope, query, cursor limits, or available data.`,
      inputSchema: recallSchema,
      outputSchema: recallOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: RecallParams) => {
      try {
        const result = store.recall(toRecallInput(params));
        const payload = { ...result };
        return toolOutput(payload, params.response_format, markdownRecall(result));
      } catch (error) {
        return toolError(
          "recall",
          "Verify the five scope ids and query length, then retry; use stats if the scope may be empty.",
          error,
        );
      }
    },
  );

  server.registerTool(
    "get",
    {
      title: "Get Memory",
      description: `Read the current immutable version of one memory by id within an exact scope.

Returns { memory: MemoryRecord | null }. Null means the id is absent or was hard-deleted; use stats for aggregate state.
This tool never promotes a hidden memory into recall context, but an explicit id lookup may return suppressed, quarantined, or archived records for inspection.`,
      inputSchema: getSchema,
      outputSchema: getOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GetParams) => {
      try {
        const memory = store.get(params.scope, params.memory_id);
        const payload = { memory };
        const markdown =
          memory === null
            ? `# Memory not found\n${params.memory_id}`
            : markdownMemory(memory);
        return toolOutput(payload, params.response_format, markdown);
      } catch (error) {
        return toolError(
          "get",
          "Verify the exact memory id and all scope ids; use recall for discovery.",
          error,
        );
      }
    },
  );

  server.registerTool(
    "correct",
    {
      title: "Correct Memory",
      description: `Create a new immutable version of an existing memory and move the current pointer.

Use when the user corrects a previously stored fact or when new evidence clearly supersedes an existing memory. Recall or get the exact memory id first; do not create an unrelated duplicate with remember.
The old version is retained for audit and history. The correction records a hashed reason, new content, new source evidence, and new confidence values. Existing validity window, privacy, retention, salience, activation, identity relevance, and attributes are inherited.

Returns the updated { memory: MemoryRecord }. Use this rather than overwriting content in place. For contradictory testimony that should remain multi-perspective, create a separate memory with attributes.conflicts_with instead.`,
      inputSchema: correctSchema,
      outputSchema: correctOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: CorrectParams) => {
      try {
        const memory = store.correct(toCorrectInput(params));
        const payload = { memory };
        return toolOutput(payload, params.response_format, markdownMemory(memory));
      } catch (error) {
        return toolError(
          "correct",
          "Confirm the memory exists in this scope and is not deleted; recall can provide the current id.",
          error,
        );
      }
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget Memory",
      description: `Hide or demote a memory without hard-deleting its data.

Use when the user asks you to stop mentioning, hide, deprioritize, quarantine, or stop actively using a memory, but does not explicitly require permanent erasure. Do not substitute remember for this action and do not use delete unless hard redaction was explicitly requested.
Modes:
  - suppress: exclude from default recall, retain for explicit inspection.
  - archive: keep recallable with reduced activation, useful for old context.
  - quarantine: isolate untrusted or unsafe memory and exclude it from default recall.

Returns the updated record. Use delete only when hard redaction is explicitly required.`,
      inputSchema: forgetSchema,
      outputSchema: forgetOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: ForgetParams) => {
      try {
        const input: ForgetInput = {
          scope: params.scope,
          memory_id: params.memory_id,
          mode: params.mode,
          reason: params.reason,
        };
        const memory = store.forget(input);
        const payload = { memory };
        return toolOutput(payload, params.response_format, markdownMemory(memory));
      } catch (error) {
        return toolError(
          "forget",
          "Verify the exact scope and memory id, then choose suppress, archive, or quarantine.",
          error,
        );
      }
    },
  );

  server.registerTool(
    "delete",
    {
      title: "Delete Memory",
      description: `Permanently redact one memory after an explicit deletion request.

Use only when the user explicitly asks to permanently delete, erase, clear, or irreversibly redact a specific memory. Do not use it when the user only says "forget", "do not mention", or asks to stop using the memory; use forget for those reversible cases.
This is a hard redaction workflow: current and historical versions, memory links, and source-event payloads are removed or redacted inside one transaction. A tombstone with no memory content remains for integrity, and the result is verified before commit.

Returns counts and verified=true only after the cascade check passes. This operation cannot be undone. Prefer forget when reversible suppression is sufficient.`,
      inputSchema: deleteSchema,
      outputSchema: deleteOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: DeleteParams) => {
      try {
        const input: DeleteInput = {
          scope: params.scope,
          memory_id: params.memory_id,
          reason: params.reason,
          requested_by: params.requested_by,
        };
        const result = store.delete(input);
        const payload = { ...result };
        const markdown = [
          `# Memory deleted: ${result.memory_id}`,
          "",
          `- Verified: ${result.verified}`,
          `- Redacted events: ${result.redacted_events}`,
          `- Deleted versions: ${result.deleted_versions}`,
          `- Deleted links: ${result.deleted_links}`,
          `- Completed at: ${result.completed_at}`,
        ].join("\n");
        return toolOutput(payload, params.response_format, markdown);
      } catch (error) {
        return toolError(
          "delete",
          "Verify this is an explicit deletion request and that the id belongs to the exact scope.",
          error,
        );
      }
    },
  );

  server.registerTool(
    "stats",
    {
      title: "Memory Statistics",
      description: `Return aggregate memory counts for one exact scope.

Includes total, active, suppressed, quarantined, deleted records, retained versions, and links. Useful for health checks and confirming deletion outcomes. It does not expose memory text.`,
      inputSchema: statsSchema,
      outputSchema: statsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: StatsParams) => {
      try {
        const stats = store.stats(params.scope);
        const payload = { ...stats };
        const markdown = [
          "# Memory statistics",
          "",
          `- Total memories: ${stats.total_memories}`,
          `- Active: ${stats.active_memories}`,
          `- Suppressed: ${stats.suppressed_memories}`,
          `- Quarantined: ${stats.quarantined_memories}`,
          `- Deleted: ${stats.deleted_memories}`,
          `- Versions: ${stats.total_versions}`,
          `- Links: ${stats.total_links}`,
        ].join("\n");
        return toolOutput(payload, params.response_format, markdown);
      } catch (error) {
        return toolError(
          "stats",
          "Verify all five scope ids; use an empty result as evidence that the scope has no records.",
          error,
        );
      }
    },
  );

  return server;
}
