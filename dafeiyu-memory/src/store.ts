import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryInputError, MemoryNotFoundError } from "./errors.js";
import { initializeSchema } from "./schema.js";
import { clamp01, scoreCandidate } from "./retrieval.js";
import {
  createSnapshot,
  pruneSnapshots,
  SnapshotError,
  type SnapshotInfo,
} from "./snapshots.js";
import type {
  CorrectInput,
  DeleteInput,
  DeleteResult,
  ForgetInput,
  MemoryContent,
  MemoryKind,
  MemoryRecord,
  MemorySnapshotOptions,
  MemoryScope,
  MemoryStatus,
  MemoryStore,
  MemoryStoreOptions,
  RecallEvidence,
  RecallInput,
  RecallResult,
  RememberInput,
  StatsResult,
} from "./types.js";

type SqlValue = string | number | null;
type SqlRow = Record<string, string | number | bigint | null | Uint8Array>;
type ScoredMemory = {
  record: MemoryRecord;
  summary: string;
  score: ReturnType<typeof scoreCandidate>;
};

const MEMORY_SELECT = `
  SELECT
    mr.memory_id,
    mr.kind,
    mr.status,
    mr.created_at AS memory_created_at,
    mr.updated_at AS memory_updated_at,
    mr.last_accessed_at,
    mr.access_count,
    mv.version_id,
    mv.version,
    mv.content_json,
    mv.summary,
    mv.epistemic_type,
    mv.source_type,
    mv.source_label,
    mv.source_confidence,
    mv.factual_confidence,
    mv.salience,
    mv.activation_strength,
    mv.identity_relevance,
    mv.valid_from,
    mv.valid_to,
    mv.privacy_level,
    mv.retention_class,
    mv.occurred_at,
    mv.attributes_json
  FROM memory_records mr
  JOIN memory_versions mv ON mv.version_id = mr.current_version_id
`;

const SCOPE_COLUMNS = [
  "tenant_id",
  "user_id",
  "agent_id",
  "persona_id",
  "space_id",
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTimestamp(label: string, value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new MemoryInputError(
      `${label} must be a valid ISO-8601/RFC-3339 timestamp.`,
    );
  }
  return new Date(parsed).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseContent(value: unknown): MemoryContent {
  const parsed = parseJson<unknown>(value, { text: "" });
  if (typeof parsed !== "object" || parsed === null) {
    return { text: "" };
  }
  return parsed as MemoryContent;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assertText(label: string, value: string, maxLength = 100_000): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryInputError(`${label} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new MemoryInputError(
      `${label} exceeds the maximum length of ${maxLength}.`,
    );
  }
}

function assertUnitInterval(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryInputError(
      `${label} must be a finite number between 0 and 1.`,
    );
  }
}

function assertScope(scope: MemoryScope): void {
  for (const key of SCOPE_COLUMNS) {
    assertText(`scope.${key}`, scope[key], 512);
  }
}

function scopeValues(scope: MemoryScope): SqlValue[] {
  return [
    scope.tenant_id,
    scope.user_id,
    scope.agent_id,
    scope.persona_id,
    scope.space_id,
  ];
}

function rowToMemory(row: SqlRow | undefined): MemoryRecord | null {
  if (row === undefined) {
    return null;
  }
  return {
    memory_id: asString(row.memory_id),
    version_id: asString(row.version_id),
    version: asNumber(row.version),
    kind: asString(row.kind) as MemoryKind,
    status: asString(row.status) as MemoryStatus,
    content: parseContent(row.content_json),
    summary: asNullableString(row.summary),
    epistemic_type: asString(row.epistemic_type) as MemoryRecord["epistemic_type"],
    source_type: asString(row.source_type),
    source_label: asString(row.source_label),
    source_confidence: asNumber(row.source_confidence),
    factual_confidence: asNumber(row.factual_confidence),
    salience: asNumber(row.salience),
    activation_strength: asNumber(row.activation_strength),
    identity_relevance: asNumber(row.identity_relevance),
    created_at: asString(row.memory_created_at),
    updated_at: asString(row.memory_updated_at),
    last_accessed_at: asNullableString(row.last_accessed_at),
    access_count: asNumber(row.access_count),
    valid_from: asNullableString(row.valid_from),
    valid_to: asNullableString(row.valid_to),
    privacy_level: asString(row.privacy_level),
    retention_class: asString(row.retention_class),
  };
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

function conflictTargets(input: RememberInput): string[] {
  const values = [
    input.attributes?.conflicts_with,
    input.attributes?.contradicts_memory_id,
    input.content.metadata?.conflicts_with,
    input.content.metadata?.contradicts_memory_id,
  ];
  return [...new Set(values.flatMap(stringArrayFromUnknown))];
}

function summarizeText(text: string): string {
  return text.length <= 280 ? text : `${text.slice(0, 277)}...`;
}

function traceContext(context: Record<string, unknown> | undefined): string {
  if (context === undefined) {
    return "{}";
  }
  try {
    return JSON.stringify(context);
  } catch {
    return JSON.stringify({ unserializable_context: true });
  }
}

class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly snapshotDirectory: string | undefined;
  private readonly snapshotRetention: number;
  private readonly snapshotPrefix: string;
  private readonly snapshotBeforeDelete: boolean;
  private closed = false;

  constructor(dbPath: string, options: MemoryStoreOptions = {}) {
    this.dbPath = dbPath;
    this.snapshotDirectory =
      dbPath === ":memory:"
        ? undefined
        : options.snapshotDirectory ?? `${dbPath}.snapshots`;
    this.snapshotRetention = options.snapshotRetention ?? 10;
    this.snapshotPrefix = options.snapshotPrefix ?? "memory";
    this.snapshotBeforeDelete = options.snapshotBeforeDelete ?? false;
    if (
      !Number.isSafeInteger(this.snapshotRetention) ||
      this.snapshotRetention < 0
    ) {
      throw new MemoryInputError(
        "snapshotRetention must be a non-negative integer.",
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(this.snapshotPrefix)) {
      throw new MemoryInputError("snapshotPrefix is invalid.");
    }
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    initializeSchema(this.db);
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
  }

  snapshot(options: MemorySnapshotOptions = {}): SnapshotInfo {
    if (this.closed) {
      throw new SnapshotError("Cannot snapshot a closed memory store.");
    }
    const directory =
      options.directory ?? this.snapshotDirectory;
    if (directory === undefined) {
      throw new SnapshotError(
        "In-memory databases do not support database snapshots.",
      );
    }
    const prefix = options.prefix ?? this.snapshotPrefix;
    const retain = options.retain ?? this.snapshotRetention;
    if (!Number.isSafeInteger(retain) || retain < 0) {
      throw new MemoryInputError(
        "snapshot retain must be a non-negative integer.",
      );
    }
    const snapshot = createSnapshot(this.db, { directory, prefix });
    pruneSnapshots({ directory, prefix, retain });
    return snapshot;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if SQLite already rolled back.
      }
      throw error;
    }
  }

  private audit(
    scope: MemoryScope,
    action: string,
    memoryId: string | null,
    details: Record<string, unknown>,
    createdAt = nowIso(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (
          audit_id, tenant_id, user_id, agent_id, persona_id, space_id,
          action, memory_id, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        makeId("audit"),
        ...scopeValues(scope),
        action,
        memoryId,
        JSON.stringify(details),
        createdAt,
      );
  }

  private currentRow(
    scope: MemoryScope,
    memoryId: string,
    includeDeleted = false,
  ): SqlRow | undefined {
    return this.db
      .prepare(
        `${MEMORY_SELECT}
         WHERE mr.memory_id = ?
           AND mr.tenant_id = ? AND mr.user_id = ? AND mr.agent_id = ?
           AND mr.persona_id = ? AND mr.space_id = ?
           ${includeDeleted ? "" : "AND mr.status <> 'deleted'"}
         LIMIT 1`,
      )
      .get(memoryId, ...scopeValues(scope));
  }

  private readMemory(scope: MemoryScope, memoryId: string): MemoryRecord | null {
    return rowToMemory(this.currentRow(scope, memoryId));
  }

  remember(input: RememberInput): MemoryRecord {
    assertScope(input.scope);
    assertText("content.text", input.content.text);
    assertText("source_type", input.source_type, 512);
    assertText("source_label", input.source_label, 2_000);
    assertUnitInterval("source_confidence", input.source_confidence);
    assertUnitInterval("factual_confidence", input.factual_confidence);

    const salience = clamp01(input.salience ?? 0.5);
    const identityRelevance = clamp01(input.identity_relevance ?? 0);
    const activation = salience;
    const now = nowIso();
    const memoryId = makeId("mem");
    const versionId = makeId("ver");
    const eventId = makeId("evt");
    const provenanceId = makeId("prov");
    const occurredAt = normalizeTimestamp(
      "occurred_at",
      input.occurred_at ?? now,
    );
    const validFrom =
      input.valid_from === undefined
        ? null
        : normalizeTimestamp("valid_from", input.valid_from);
    const validTo =
      input.valid_to === undefined
        ? null
        : normalizeTimestamp("valid_to", input.valid_to);
    if (validFrom !== null && validTo !== null && validFrom > validTo) {
      throw new MemoryInputError("valid_from must not be later than valid_to.");
    }
    const privacyLevel = input.privacy_level ?? "private";
    const retentionClass = input.retention_class ?? "standard";
    const attributes = input.attributes ?? {};
    const payload = {
      content: input.content,
      summary: input.summary ?? null,
      epistemic_type: input.epistemic_type,
      attributes,
    };

    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO events (
            event_id, tenant_id, user_id, agent_id, persona_id, space_id,
            event_type, source_type, source_label, epistemic_type, occurred_at,
            payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          ...scopeValues(input.scope),
          "memory.remembered",
          input.source_type,
          input.source_label,
          input.epistemic_type,
          occurredAt,
          JSON.stringify(payload),
          now,
        );

      this.db
        .prepare(
          `INSERT INTO provenance_records (
            provenance_id, event_id, tenant_id, user_id, agent_id, persona_id,
            space_id, source_type, source_label, source_confidence, captured_at,
            details_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          provenanceId,
          eventId,
          ...scopeValues(input.scope),
          input.source_type,
          input.source_label,
          input.source_confidence,
          now,
          JSON.stringify({ epistemic_type: input.epistemic_type }),
        );

      this.db
        .prepare(
          `INSERT INTO memory_records (
            memory_id, tenant_id, user_id, agent_id, persona_id, space_id,
            kind, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          memoryId,
          ...scopeValues(input.scope),
          input.kind,
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO memory_versions (
            version_id, memory_id, version, content_json, summary,
            epistemic_type, source_type, source_label, source_confidence,
            factual_confidence, salience, activation_strength,
            identity_relevance, valid_from, valid_to, privacy_level,
            retention_class, occurred_at, attributes_json, provenance_id,
            created_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          memoryId,
          JSON.stringify(input.content),
          input.summary ?? null,
          input.epistemic_type,
          input.source_type,
          input.source_label,
          input.source_confidence,
          input.factual_confidence,
          salience,
          // Confidence affects answer qualification later, never activation.
          activation,
          identityRelevance,
          validFrom,
          validTo,
          privacyLevel,
          retentionClass,
          occurredAt,
          JSON.stringify(attributes),
          provenanceId,
          now,
        );

      this.db
        .prepare(
          "UPDATE memory_records SET current_version_id = ? WHERE memory_id = ?",
        )
        .run(versionId, memoryId);

      for (const targetId of conflictTargets(input)) {
        if (targetId === memoryId) {
          continue;
        }
        const target = this.db
          .prepare(
            `SELECT memory_id FROM memory_records
             WHERE memory_id = ? AND tenant_id = ? AND user_id = ?
               AND agent_id = ? AND persona_id = ? AND space_id = ?
               AND status <> 'deleted'`,
          )
          .get(targetId, ...scopeValues(input.scope));
        if (target === undefined) {
          continue;
        }
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_links (
              link_id, tenant_id, user_id, agent_id, persona_id, space_id,
              from_memory_id, to_memory_id, relation_type, confidence, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'contradicts', ?, ?)`,
          )
          .run(
            makeId("link"),
            ...scopeValues(input.scope),
            memoryId,
            targetId,
            Math.min(input.source_confidence, input.factual_confidence),
            now,
          );
      }

      this.audit(
        input.scope,
        "remember",
        memoryId,
        { kind: input.kind, version: 1 },
        now,
      );
    });

    const created = this.readMemory(input.scope, memoryId);
    if (created === null) {
      throw new Error("Memory was written but could not be read back.");
    }
    return created;
  }

  recall(input: RecallInput): RecallResult {
    assertScope(input.scope);
    assertText("query", input.query, 10_000);
    if (input.current_goal !== undefined) {
      assertText("current_goal", input.current_goal, 10_000);
    }
    const now = new Date();
    const nowText = now.toISOString();
    const maxCandidates = Math.max(
      1,
      Math.min(1_000, Math.trunc(input.max_candidates ?? 256)),
    );
    const maxEvidence = Math.max(
      1,
      Math.min(50, Math.trunc(input.max_evidence ?? 8)),
    );

    const statuses = input.include_suppressed
      ? ["active", "archived", "suppressed"]
      : ["active", "archived"];
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const params: SqlValue[] = [
      ...scopeValues(input.scope),
      nowText,
      nowText,
      ...statuses,
    ];
    let kindClause = "";
    if (input.kinds && input.kinds.length > 0) {
      kindClause = `AND mr.kind IN (${input.kinds.map(() => "?").join(", ")})`;
      params.push(...input.kinds);
    }
    params.push(maxCandidates);

    const rows = this.db
      .prepare(
        `${MEMORY_SELECT}
         WHERE mr.tenant_id = ? AND mr.user_id = ? AND mr.agent_id = ?
           AND mr.persona_id = ? AND mr.space_id = ?
           AND (mv.valid_from IS NULL OR mv.valid_from <= ?)
           AND (mv.valid_to IS NULL OR mv.valid_to >= ?)
           AND mr.status IN (${statusPlaceholders})
           ${kindClause}
         ORDER BY mr.updated_at DESC
         LIMIT ?`,
      )
      .all(...params);

    const scoreContext = {
      now,
      ...(input.current_goal !== undefined
        ? { currentGoal: input.current_goal }
        : {}),
      ...(input.current_context !== undefined
        ? { currentContext: input.current_context }
        : {}),
    };
    const scoreRow = (row: SqlRow): ScoredMemory | null => {
      const record = rowToMemory(row);
      if (record === null) {
        return null;
      }
      const summary = record.summary ?? summarizeText(record.content.text);
      const candidate = {
        summary,
        text: record.content.text,
        tags: record.content.tags ?? [],
        entities: record.content.entities ?? [],
        createdAt: record.created_at,
        salience: record.salience,
        activation:
          record.status === "archived"
            ? record.activation_strength * 0.25
            : record.activation_strength,
        identityRelevance: record.identity_relevance,
      };
      const score = scoreCandidate(input.query, candidate, scoreContext);
      return { record, summary, score };
    };

    const relevantScored = rows
      .map(scoreRow)
      .filter(
        (item): item is ScoredMemory =>
          item !== null &&
          (item.score.lexicalScore > 0 || item.score.goalScore > 0),
      );

    const relevantIds = relevantScored.map((item) => item.record.memory_id);
    const relevantIdSet = new Set(relevantIds);
    const neighborIds = new Set<string>();
    if (relevantIds.length > 0) {
      const idPlaceholders = relevantIds.map(() => "?").join(", ");
      const seedLinks = this.db
        .prepare(
          `SELECT from_memory_id, to_memory_id
           FROM memory_links
           WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
             AND persona_id = ? AND space_id = ?
             AND relation_type = 'contradicts'
             AND (
               from_memory_id IN (${idPlaceholders})
               OR to_memory_id IN (${idPlaceholders})
             )`,
        )
        .all(...scopeValues(input.scope), ...relevantIds, ...relevantIds);
      for (const link of seedLinks) {
        for (const candidateId of [
          asString(link.from_memory_id),
          asString(link.to_memory_id),
        ]) {
          if (
            candidateId.length > 0 &&
            !relevantIdSet.has(candidateId) &&
            neighborIds.size < maxCandidates
          ) {
            neighborIds.add(candidateId);
          }
        }
      }
    }

    let conflictNeighbors: ScoredMemory[] = [];
    if (neighborIds.size > 0) {
      const neighborIdValues = [...neighborIds];
      const neighborPlaceholders = neighborIdValues.map(() => "?").join(", ");
      const neighborParams: SqlValue[] = [
        ...scopeValues(input.scope),
        nowText,
        nowText,
        ...statuses,
        ...(input.kinds ?? []),
        ...neighborIdValues,
      ];
      const neighborRows = this.db
        .prepare(
          `${MEMORY_SELECT}
           WHERE mr.tenant_id = ? AND mr.user_id = ? AND mr.agent_id = ?
             AND mr.persona_id = ? AND mr.space_id = ?
             AND (mv.valid_from IS NULL OR mv.valid_from <= ?)
             AND (mv.valid_to IS NULL OR mv.valid_to >= ?)
             AND mr.status IN (${statusPlaceholders})
             ${kindClause}
             AND mr.memory_id IN (${neighborPlaceholders})`,
        )
        .all(...neighborParams);
      conflictNeighbors = neighborRows
        .map(scoreRow)
        .filter((item): item is ScoredMemory => item !== null);
    }

    const scored = [...relevantScored, ...conflictNeighbors].sort(
      (left, right) =>
        right.score.totalScore - left.score.totalScore ||
        right.score.lexicalScore - left.score.lexicalScore ||
        right.score.recencyScore - left.score.recencyScore ||
        right.record.created_at.localeCompare(left.record.created_at),
    );
    const selected = scored.slice(0, maxEvidence);
    const allIds = scored.map((item) => item.record.memory_id);
    const conflictMap = new Map<string, Set<string>>();
    const conflictPairs = new Set<string>();

    if (allIds.length > 1) {
      const idPlaceholders = allIds.map(() => "?").join(", ");
      const links = this.db
        .prepare(
          `SELECT from_memory_id, to_memory_id
           FROM memory_links
           WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
             AND persona_id = ? AND space_id = ?
             AND relation_type = 'contradicts'
             AND from_memory_id IN (${idPlaceholders})
             AND to_memory_id IN (${idPlaceholders})`,
        )
        .all(...scopeValues(input.scope), ...allIds, ...allIds);

      for (const link of links) {
        const from = asString(link.from_memory_id);
        const to = asString(link.to_memory_id);
        if (!from || !to) {
          continue;
        }
        const fromSet = conflictMap.get(from) ?? new Set<string>();
        const toSet = conflictMap.get(to) ?? new Set<string>();
        fromSet.add(to);
        toSet.add(from);
        conflictMap.set(from, fromSet);
        conflictMap.set(to, toSet);
        conflictPairs.add([from, to].sort().join(":"));
      }
    }

    const evidence: RecallEvidence[] = selected.map(({ record, summary, score }) => ({
      memory_id: record.memory_id,
      version_id: record.version_id,
      kind: record.kind,
      summary,
      text: record.content.text,
      epistemic_type: record.epistemic_type,
      source_type: record.source_type,
      source_label: record.source_label,
      source_confidence: record.source_confidence,
      factual_confidence: record.factual_confidence,
      activation: record.activation_strength,
      lexical_score: score.lexicalScore,
      recency_score: score.recencyScore,
      goal_score: score.goalScore,
      conflict_ids: [...(conflictMap.get(record.memory_id) ?? [])].sort(),
      created_at: record.created_at,
    }));

    const conflicts = [...conflictPairs].sort();
    let decision: RecallResult["decision"];
    if (evidence.length === 0) {
      decision = "abstain";
    } else if (conflicts.length > 0) {
      decision = "multi_perspective";
    } else {
      const top = evidence[0] as RecallEvidence;
      const confidence = Math.min(top.source_confidence, top.factual_confidence);
      if (top.lexical_score >= 0.7 && confidence >= 0.7) {
        decision = "direct";
      } else if (top.lexical_score >= 0.3 && confidence >= 0.4) {
        decision = "qualified";
      } else {
        decision = "uncertain";
      }
    }

    const explanation =
      decision === "abstain"
        ? "No eligible memory matched this scope and query."
        : decision === "multi_perspective"
          ? `Found ${evidence.length} evidence item(s) with ${conflicts.length} contradiction link(s); preserve competing perspectives.`
          : decision === "direct"
            ? "Top evidence is strongly matched and independently supported by source and factual confidence."
            : decision === "qualified"
              ? "Relevant evidence exists, but confidence or match strength requires qualification."
              : "Candidate evidence is weak, stale, or structurally similar; do not treat it as certain.";

    const result: RecallResult = {
      decision,
      query: input.query,
      evidence,
      conflicts,
      explanation,
      total_candidates: scored.length,
    };

    this.transaction(() => {
      for (const item of selected) {
        this.db
          .prepare(
            `UPDATE memory_records
             SET access_count = access_count + 1, last_accessed_at = ?
             WHERE memory_id = ?`,
          )
          .run(nowText, item.record.memory_id);
        this.db
          .prepare(
            `UPDATE memory_versions
             SET activation_strength = MIN(1.0, activation_strength + 0.05)
             WHERE version_id = ?`,
          )
          .run(item.record.version_id);
      }

      this.db
        .prepare(
          `INSERT INTO recall_episodes (
            episode_id, tenant_id, user_id, agent_id, persona_id, space_id,
            query_text, query_hash, current_goal, context_json,
            result_trace_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          makeId("recall"),
          ...scopeValues(input.scope),
          input.query,
          hashText(input.query),
          input.current_goal ?? null,
          traceContext(input.current_context),
          JSON.stringify({
            decision,
            evidence: evidence.map((item) => ({
              memory_id: item.memory_id,
              version_id: item.version_id,
              lexical_score: item.lexical_score,
              recency_score: item.recency_score,
              goal_score: item.goal_score,
              conflict_ids: item.conflict_ids,
            })),
            conflicts,
            total_candidates: scored.length,
          }),
          nowText,
        );
      this.audit(
        input.scope,
        "recall",
        null,
        {
          decision,
          evidence_count: evidence.length,
          total_candidates: scored.length,
        },
        nowText,
      );
    });

    return result;
  }

  get(scope: MemoryScope, memoryId: string): MemoryRecord | null {
    assertScope(scope);
    assertText("memory_id", memoryId, 512);
    return this.readMemory(scope, memoryId);
  }

  correct(input: CorrectInput): MemoryRecord {
    assertScope(input.scope);
    assertText("memory_id", input.memory_id, 512);
    assertText("content.text", input.content.text);
    assertText("source_type", input.source_type, 512);
    assertText("source_label", input.source_label, 2_000);
    assertText("reason", input.reason, 10_000);
    assertUnitInterval("source_confidence", input.source_confidence);
    assertUnitInterval("factual_confidence", input.factual_confidence);

    this.transaction(() => {
      const current = this.currentRow(input.scope, input.memory_id);
      if (current === undefined) {
        throw new MemoryNotFoundError(
          `Memory '${input.memory_id}' was not found in this scope. Use recall to locate an active memory id.`,
        );
      }
      const currentVersion = asNumber(current.version);
      const oldVersionId = asString(current.version_id);
      const versionId = makeId("ver");
      const eventId = makeId("evt");
      const provenanceId = makeId("prov");
      const now = nowIso();
      const attributesJson = asString(current.attributes_json, "{}");
      const reasonHash = hashText(input.reason);

      this.db
        .prepare(
          `INSERT INTO events (
            event_id, tenant_id, user_id, agent_id, persona_id, space_id,
            event_type, source_type, source_label, epistemic_type, occurred_at,
            payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          ...scopeValues(input.scope),
          "memory.corrected",
          input.source_type,
          input.source_label,
          asString(current.epistemic_type),
          now,
          JSON.stringify({
            content: input.content,
            summary: input.summary ?? null,
            reason_hash: reasonHash,
            from_version: currentVersion,
            to_version: currentVersion + 1,
          }),
          now,
        );

      this.db
        .prepare(
          `INSERT INTO provenance_records (
            provenance_id, event_id, tenant_id, user_id, agent_id, persona_id,
            space_id, source_type, source_label, source_confidence, captured_at,
            details_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          provenanceId,
          eventId,
          ...scopeValues(input.scope),
          input.source_type,
          input.source_label,
          input.source_confidence,
          now,
          JSON.stringify({
            operation: "correct",
            from_version: currentVersion,
            to_version: currentVersion + 1,
          }),
        );

      this.db
        .prepare(
          `INSERT INTO memory_versions (
            version_id, memory_id, version, content_json, summary,
            epistemic_type, source_type, source_label, source_confidence,
            factual_confidence, salience, activation_strength,
            identity_relevance, valid_from, valid_to, privacy_level,
            retention_class, occurred_at, attributes_json, provenance_id,
            supersedes_version_id, reason_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          input.memory_id,
          currentVersion + 1,
          JSON.stringify(input.content),
          input.summary ?? null,
          asString(current.epistemic_type),
          input.source_type,
          input.source_label,
          input.source_confidence,
          input.factual_confidence,
          asNumber(current.salience),
          asNumber(current.activation_strength),
          asNumber(current.identity_relevance),
          asNullableString(current.valid_from),
          asNullableString(current.valid_to),
          asString(current.privacy_level, "private"),
          asString(current.retention_class, "standard"),
          asString(current.occurred_at, now),
          attributesJson,
          provenanceId,
          oldVersionId,
          reasonHash,
          now,
        );

      this.db
        .prepare(
          "UPDATE memory_records SET current_version_id = ?, updated_at = ? WHERE memory_id = ?",
        )
        .run(versionId, now, input.memory_id);

      this.audit(
        input.scope,
        "correct",
        input.memory_id,
        {
          from_version: currentVersion,
          to_version: currentVersion + 1,
          reason_hash: reasonHash,
        },
        now,
      );
    });

    const corrected = this.readMemory(input.scope, input.memory_id);
    if (corrected === null) {
      throw new Error("Correction was written but could not be read back.");
    }
    return corrected;
  }

  forget(input: ForgetInput): MemoryRecord {
    assertScope(input.scope);
    assertText("memory_id", input.memory_id, 512);
    assertText("reason", input.reason, 10_000);

    this.transaction(() => {
      const current = this.currentRow(input.scope, input.memory_id);
      if (current === undefined) {
        throw new MemoryNotFoundError(
          `Memory '${input.memory_id}' was not found in this scope. Use recall to locate an active memory id.`,
        );
      }
      const now = nowIso();
      if (input.mode === "archive") {
        this.db
          .prepare(
            `UPDATE memory_versions
             SET activation_strength = activation_strength * 0.25
             WHERE version_id = ?`,
          )
          .run(asString(current.version_id));
      }
      this.db
        .prepare(
          "UPDATE memory_records SET status = ?, updated_at = ? WHERE memory_id = ?",
        )
        .run(input.mode === "suppress" ? "suppressed" : input.mode === "archive" ? "archived" : "quarantined", now, input.memory_id);
      this.audit(
        input.scope,
        "forget",
        input.memory_id,
        { mode: input.mode, reason_hash: hashText(input.reason) },
        now,
      );
    });

    const forgotten = this.readMemory(input.scope, input.memory_id);
    if (forgotten === null) {
      throw new Error("Forget operation completed but the memory is unavailable.");
    }
    return forgotten;
  }

  delete(input: DeleteInput): DeleteResult {
    assertScope(input.scope);
    assertText("memory_id", input.memory_id, 512);
    assertText("reason", input.reason, 10_000);
    assertText("requested_by", input.requested_by, 2_000);

    if (this.snapshotBeforeDelete) {
      this.snapshot({ prefix: "before-delete" });
    }

    const existingRecord = this.db
      .prepare(
        `SELECT status, current_version_id
         FROM memory_records
         WHERE memory_id = ? AND tenant_id = ? AND user_id = ? AND agent_id = ?
           AND persona_id = ? AND space_id = ?`,
      )
      .get(input.memory_id, ...scopeValues(input.scope));
    if (existingRecord === undefined) {
      throw new MemoryNotFoundError(
        `Memory '${input.memory_id}' was not found in this scope. Verify the scope and memory id.`,
      );
    }

    if (asString(existingRecord.status) === "deleted") {
      const tombstone = this.db
        .prepare("SELECT deleted_at, verified FROM tombstones WHERE memory_id = ?")
        .get(input.memory_id);
      return {
        memory_id: input.memory_id,
        state: "completed",
        redacted_events: 0,
        deleted_versions: 0,
        deleted_links: 0,
        verified: tombstone !== undefined && asNumber(tombstone.verified) === 1,
        completed_at:
          asNullableString(tombstone?.deleted_at) ?? nowIso(),
      };
    }

    const liveRow = this.currentRow(input.scope, input.memory_id);
    if (liveRow === undefined) {
      throw new MemoryNotFoundError(
        `Memory '${input.memory_id}' has no readable current version; inspect storage before retrying deletion.`,
      );
    }

    const completedAt = nowIso();
    const requestId = makeId("delreq");
    let result: DeleteResult | null = null;

    this.transaction(() => {
      const provenanceRows = this.db
        .prepare(
          `SELECT DISTINCT pr.provenance_id, pr.event_id
           FROM memory_versions mv
           JOIN provenance_records pr ON pr.provenance_id = mv.provenance_id
           JOIN memory_records mr ON mr.memory_id = mv.memory_id
           WHERE mv.memory_id = ?
             AND mr.tenant_id = ? AND mr.user_id = ? AND mr.agent_id = ?
             AND mr.persona_id = ? AND mr.space_id = ?`,
        )
        .all(input.memory_id, ...scopeValues(input.scope));
      const provenanceIds = [
        ...new Set(
          provenanceRows
            .map((row) => asString(row.provenance_id))
            .filter((value) => value.length > 0),
        ),
      ];
      const eventIds = provenanceRows
        .map((row) => asString(row.event_id))
        .filter((value) => value.length > 0)
        .filter((value, index, values) => values.indexOf(value) === index);

      const versionCount = Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM memory_versions WHERE memory_id = ?")
          .get(input.memory_id)?.count ?? 0,
      );
      const linkCount = Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM memory_links
             WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
               AND persona_id = ? AND space_id = ?
               AND (from_memory_id = ? OR to_memory_id = ?)`,
          )
          .get(
            ...scopeValues(input.scope),
            input.memory_id,
            input.memory_id,
          )?.count ?? 0,
      );

      for (const eventId of eventIds) {
        this.db
          .prepare(
            `UPDATE events
             SET payload_json = ?, source_type = '[redacted]',
                 source_label = '[redacted]',
                 redacted_at = ?, redaction_reason = 'memory_deleted'
             WHERE event_id = ?`,
          )
          .run(
            JSON.stringify({ redacted: true, reason: "memory_deleted" }),
            completedAt,
            eventId,
          );
      }

      this.db
        .prepare(
          `DELETE FROM memory_links
           WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
             AND persona_id = ? AND space_id = ?
             AND (from_memory_id = ? OR to_memory_id = ?)`,
        )
        .run(...scopeValues(input.scope), input.memory_id, input.memory_id);

      this.db
        .prepare("DELETE FROM memory_versions WHERE memory_id = ?")
        .run(input.memory_id);

      for (const provenanceId of provenanceIds) {
        this.db
          .prepare(
            `DELETE FROM provenance_records
             WHERE provenance_id = ?
               AND tenant_id = ? AND user_id = ? AND agent_id = ?
               AND persona_id = ? AND space_id = ?`,
          )
          .run(provenanceId, ...scopeValues(input.scope));
      }

      this.db
        .prepare(
          `UPDATE memory_records
           SET status = 'deleted', current_version_id = NULL,
               updated_at = ?, last_accessed_at = NULL, access_count = 0
           WHERE memory_id = ?`,
        )
        .run(completedAt, input.memory_id);

      this.db
        .prepare(
          `INSERT INTO deletion_requests (
            request_id, memory_id, requested_by_hash, reason_hash, requested_at,
            completed_at, redacted_events, deleted_versions, deleted_links, verified
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          requestId,
          input.memory_id,
          hashText(input.requested_by),
          hashText(input.reason),
          completedAt,
          completedAt,
          eventIds.length,
          versionCount,
          linkCount,
        );

      const redactionSummary = {
        redacted_events: eventIds.length,
        deleted_versions: versionCount,
        deleted_links: linkCount,
        content_redacted: true,
      };

      this.db
        .prepare(
          `INSERT INTO tombstones (
            tombstone_id, memory_id, deletion_request_id, deleted_at, verified,
            redaction_summary_json
          ) VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(
          makeId("tomb"),
          input.memory_id,
          requestId,
          completedAt,
          JSON.stringify(redactionSummary),
        );

      this.audit(
        input.scope,
        "delete",
        input.memory_id,
        redactionSummary,
        completedAt,
      );

      const remainingVersions = Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM memory_versions WHERE memory_id = ?")
          .get(input.memory_id)?.count ?? 0,
      );
      const remainingLinks = Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM memory_links
             WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
               AND persona_id = ? AND space_id = ?
               AND (from_memory_id = ? OR to_memory_id = ?)`,
          )
          .get(
            ...scopeValues(input.scope),
            input.memory_id,
            input.memory_id,
          )?.count ?? 0,
      );
      const status = this.db
        .prepare(
          `SELECT status, current_version_id FROM memory_records
           WHERE memory_id = ? AND tenant_id = ? AND user_id = ? AND agent_id = ?
             AND persona_id = ? AND space_id = ?`,
        )
        .get(input.memory_id, ...scopeValues(input.scope));
      const tombstone = this.db
        .prepare("SELECT verified FROM tombstones WHERE memory_id = ?")
        .get(input.memory_id);
      const remainingProvenance = provenanceIds.filter(
        (provenanceId) =>
          this.db
            .prepare(
              `SELECT 1 FROM provenance_records
               WHERE provenance_id = ?
                 AND tenant_id = ? AND user_id = ? AND agent_id = ?
                 AND persona_id = ? AND space_id = ?`,
            )
            .get(provenanceId, ...scopeValues(input.scope)) !== undefined,
      ).length;
      const eventPayloads = eventIds.map((eventId) =>
        this.db
          .prepare(
            `SELECT payload_json, source_type, source_label, redacted_at
             FROM events WHERE event_id = ?`,
          )
          .get(eventId),
      );
      const eventsRedacted = eventPayloads.every((row) => {
        const payload = parseJson<{ redacted?: unknown }>(row?.payload_json, {});
        return (
          payload.redacted === true &&
          asString(row?.source_type) === "[redacted]" &&
          asString(row?.source_label) === "[redacted]" &&
          asNullableString(row?.redacted_at) !== null
        );
      });
      const verified =
        remainingVersions === 0 &&
        remainingLinks === 0 &&
        remainingProvenance === 0 &&
        asString(status?.status) === "deleted" &&
        status?.current_version_id === null &&
        asNumber(tombstone?.verified) === 1 &&
        eventsRedacted;

      if (!verified) {
        throw new Error(
          "Deletion verification failed inside the transaction; no partial deletion was committed.",
        );
      }

      result = {
        memory_id: input.memory_id,
        state: "completed",
        redacted_events: eventIds.length,
        deleted_versions: versionCount,
        deleted_links: linkCount,
        verified: true,
        completed_at: completedAt,
      };
    });

    if (result === null) {
      throw new Error("Delete transaction completed without a result.");
    }
    return result;
  }

  stats(scope: MemoryScope): StatsResult {
    assertScope(scope);
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_memories,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_memories,
           SUM(CASE WHEN status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed_memories,
           SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined_memories,
           SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END) AS deleted_memories
         FROM memory_records
         WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
           AND persona_id = ? AND space_id = ?`,
      )
      .get(...scopeValues(scope));

    const versionCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM memory_versions mv
         JOIN memory_records mr ON mr.memory_id = mv.memory_id
         WHERE mr.tenant_id = ? AND mr.user_id = ? AND mr.agent_id = ?
           AND mr.persona_id = ? AND mr.space_id = ?`,
      )
      .get(...scopeValues(scope));

    const linkCount = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_links
         WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
           AND persona_id = ? AND space_id = ?`,
      )
      .get(...scopeValues(scope));

    return {
      total_memories: asNumber(counts?.total_memories),
      active_memories: asNumber(counts?.active_memories),
      suppressed_memories: asNumber(counts?.suppressed_memories),
      quarantined_memories: asNumber(counts?.quarantined_memories),
      deleted_memories: asNumber(counts?.deleted_memories),
      total_versions: asNumber(versionCount?.count),
      total_links: asNumber(linkCount?.count),
    };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }
}

export function createMemoryStore(
  dbPath: string,
  options: MemoryStoreOptions = {},
): MemoryStore {
  return new SqliteMemoryStore(dbPath, options);
}
