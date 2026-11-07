import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { extractTokens, normalizeText } from "./retrieval.js";
import { SCHEMA_VERSION } from "./schema.js";
import type {
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStore,
} from "./types.js";

export const MAINTENANCE_PLAN_VERSION = 1;

const DEFAULT_SEMANTIC_TOKEN_THRESHOLD = 0.35;
const DEFAULT_PREVIEW_CHARACTERS = 600;
const SCOPE_COLUMNS = [
  "tenant_id",
  "user_id",
  "agent_id",
  "persona_id",
  "space_id",
] as const;
const SIGNAL_ORDER = [
  "shared_tag",
  "shared_entity",
  "text_similarity",
] as const;

type DatabaseValue = string | number | bigint | null | Uint8Array;
type DatabaseRow = Record<string, DatabaseValue>;
type SemanticSignal = (typeof SIGNAL_ORDER)[number];

export interface MaintenanceMemoryView {
  memory_id: string;
  version_id: string;
  kind: MemoryKind;
  created_at: string;
  updated_at: string;
  summary: string | null;
  text_preview: string;
  tags: string[];
  entities: string[];
  source_confidence: number;
  factual_confidence: number;
  salience: number;
  identity_relevance: number;
}

export interface ExactDuplicateGroup {
  group_id: string;
  canonical: MaintenanceMemoryView;
  duplicates: MaintenanceMemoryView[];
}

export interface SemanticReviewGroup {
  group_id: string;
  kind: MemoryKind;
  memory_ids: string[];
  candidates: MaintenanceMemoryView[];
  signals: SemanticSignal[];
  shared_tags: string[];
  shared_entities: string[];
  token_similarity: {
    min: number;
    max: number;
  };
}

export interface MaintenancePlan {
  schema_version: typeof MAINTENANCE_PLAN_VERSION;
  scope: MemoryScope;
  exact_duplicate_groups: ExactDuplicateGroup[];
  semantic_review_groups: SemanticReviewGroup[];
  summary: {
    active_memories_scanned: number;
    exact_duplicate_groups: number;
    exact_duplicate_records: number;
    semantic_review_groups: number;
    semantic_review_records: number;
  };
}

export interface MaintenancePlanOptions {
  semanticTokenThreshold?: number;
  previewCharacters?: number;
}

export interface ApplyExactDuplicatePlanOptions {
  dryRun?: boolean;
  allowCrossKind?: boolean;
  reason?: string;
}

export interface ApplyExactDuplicateAction {
  memory_id: string;
  canonical_memory_id: string;
  outcome: "would_suppress" | "suppressed";
}

export interface ApplyExactDuplicateSkip {
  memory_id: string;
  canonical_memory_id: string;
  reason: string;
}

export interface ApplyExactDuplicatePlanResult {
  dry_run: boolean;
  actions: ApplyExactDuplicateAction[];
  skipped: ApplyExactDuplicateSkip[];
}

export interface ScopeMaintenanceResult {
  scope: MemoryScope;
  plan: MaintenancePlan;
  applied: ApplyExactDuplicatePlanResult | null;
}

export interface RunMaintenanceOptions extends MaintenancePlanOptions {
  applyExactDuplicates?: boolean;
  reason?: string;
  snapshotPrefix?: string;
  reportDirectory?: string;
}

export interface RunMaintenanceResult {
  scopes_scanned: number;
  exact_duplicate_groups: number;
  exact_duplicates_suppressed: number;
  semantic_review_groups: number;
  snapshot: import("./snapshots.js").SnapshotInfo | null;
  report_path: string | null;
  scopes: ScopeMaintenanceResult[];
}

/** Stable filename for the latest deterministic maintenance report. */
export const MAINTENANCE_REPORT_FILENAME = "latest-maintenance-plan.json";

interface ScannedMemory {
  view: MaintenanceMemoryView;
  normalizedText: string;
  tokens: Set<string>;
  normalizedTags: Set<string>;
  normalizedEntities: Set<string>;
}

interface PairSignal {
  left: number;
  right: number;
  tokenSimilarity: number;
  sharedTags: string[];
  sharedEntities: string[];
}

interface PendingSuppression {
  canonicalMemoryId: string;
  duplicateMemoryId: string;
}

function asString(value: DatabaseValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: DatabaseValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: DatabaseValue | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return fallback;
}

function parseJson(value: DatabaseValue | undefined, fallback: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function parseContent(value: DatabaseValue | undefined): {
  text: string;
  tags: string[];
  entities: string[];
} {
  const parsed = parseJson(value, {});
  if (typeof parsed !== "object" || parsed === null) {
    return { text: "", tags: [], entities: [] };
  }
  const record = parsed as Record<string, unknown>;
  return {
    text: typeof record.text === "string" ? record.text : "",
    tags: stringArray(record.tags),
    entities: stringArray(record.entities),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeValues(scope: MemoryScope): string[] {
  return SCOPE_COLUMNS.map((column) => scope[column]);
}

function assertScope(scope: MemoryScope): void {
  for (const column of SCOPE_COLUMNS) {
    if (typeof scope[column] !== "string" || scope[column].trim().length === 0) {
      throw new Error(`Maintenance scope.${column} must be a non-empty string.`);
    }
  }
}

function assertPositiveInteger(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function assertUnitInterval(label: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1.`);
  }
  return value;
}

function previewText(text: string, limit: number): string {
  const characters = [...text];
  if (characters.length <= limit) {
    return text;
  }
  return `${characters.slice(0, Math.max(0, limit - 3)).join("")}...`;
}

function normalizedLabels(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map(normalizeText)
        .filter((value) => [...value].length >= 2),
    ),
  ].sort();
}

function compareCanonical(
  left: MaintenanceMemoryView,
  right: MaintenanceMemoryView,
): number {
  return (
    left.created_at.localeCompare(right.created_at) ||
    left.memory_id.localeCompare(right.memory_id)
  );
}

function intersection(left: Set<string>, right: Set<string>): string[] {
  const values: string[] = [];
  for (const value of left) {
    if (right.has(value)) {
      values.push(value);
    }
  }
  return values.sort();
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const value of left) {
    if (right.has(value)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function scanActiveMemories(
  dbPath: string,
  scope: MemoryScope,
  previewCharacters: number,
): ScannedMemory[] {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    const schemaRow = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get("schema_version");
    const schemaVersion = Number(schemaRow?.value);
    if (!Number.isInteger(schemaVersion) || schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported memory schema version ${String(schemaRow?.value)}; ` +
          `maintenance supports up to version ${SCHEMA_VERSION}.`,
      );
    }

    const rows = db
      .prepare(
        `SELECT
           mr.memory_id,
           mr.kind,
           mr.created_at AS memory_created_at,
           mr.updated_at AS memory_updated_at,
           mv.version_id,
           mv.content_json,
           mv.summary,
           mv.source_confidence,
           mv.factual_confidence,
           mv.salience,
           mv.identity_relevance
         FROM memory_records mr
         JOIN memory_versions mv ON mv.version_id = mr.current_version_id
         WHERE mr.tenant_id = ? AND mr.user_id = ? AND mr.agent_id = ?
           AND mr.persona_id = ? AND mr.space_id = ?
           AND mr.status = 'active'
         ORDER BY mr.created_at, mr.memory_id`,
      )
      .all(...scopeValues(scope)) as DatabaseRow[];

    return rows.map((row) => {
      const content = parseContent(row.content_json);
      const tags = [...new Set(content.tags)].sort();
      const entities = [...new Set(content.entities)].sort();
      return {
        view: {
          memory_id: asString(row.memory_id),
          version_id: asString(row.version_id),
          kind: asString(row.kind) as MemoryKind,
          created_at: asString(row.memory_created_at),
          updated_at: asString(row.memory_updated_at),
          summary: asNullableString(row.summary),
          text_preview: previewText(content.text, previewCharacters),
          tags,
          entities,
          source_confidence: asNumber(row.source_confidence),
          factual_confidence: asNumber(row.factual_confidence),
          salience: asNumber(row.salience),
          identity_relevance: asNumber(row.identity_relevance),
        },
        normalizedText: normalizeText(content.text),
        tokens: extractTokens(content.text),
        normalizedTags: new Set(normalizedLabels(tags)),
        normalizedEntities: new Set(normalizedLabels(entities)),
      };
    });
  } finally {
    db.close();
  }
}

function buildExactDuplicateGroups(
  memories: ScannedMemory[],
): {
  groups: ExactDuplicateGroup[];
  duplicateMemoryIds: Set<string>;
} {
  const byText = new Map<string, ScannedMemory[]>();
  for (const memory of memories) {
    const bucket = byText.get(memory.normalizedText) ?? [];
    bucket.push(memory);
    byText.set(memory.normalizedText, bucket);
  }

  const groups: ExactDuplicateGroup[] = [];
  const duplicateMemoryIds = new Set<string>();
  for (const bucket of byText.values()) {
    if (bucket.length < 2) {
      continue;
    }
    bucket.sort((left, right) => compareCanonical(left.view, right.view));
    const canonical = bucket[0] as ScannedMemory;
    const duplicates = bucket.slice(1);
    for (const duplicate of duplicates) {
      duplicateMemoryIds.add(duplicate.view.memory_id);
    }
    groups.push({
      group_id: hash(`exact\0${canonical.normalizedText}`),
      canonical: canonical.view,
      duplicates: duplicates.map((duplicate) => duplicate.view),
    });
  }

  groups.sort((left, right) =>
    left.canonical.created_at.localeCompare(right.canonical.created_at) ||
    left.canonical.memory_id.localeCompare(right.canonical.memory_id),
  );
  return { groups, duplicateMemoryIds };
}

function buildSemanticReviewGroups(
  memories: ScannedMemory[],
  duplicateMemoryIds: Set<string>,
  threshold: number,
): SemanticReviewGroup[] {
  const byKind = new Map<MemoryKind, ScannedMemory[]>();
  for (const memory of memories) {
    if (duplicateMemoryIds.has(memory.view.memory_id)) {
      continue;
    }
    const bucket = byKind.get(memory.view.kind) ?? [];
    bucket.push(memory);
    byKind.set(memory.view.kind, bucket);
  }

  const groups: SemanticReviewGroup[] = [];
  for (const [kind, candidates] of byKind) {
    if (candidates.length < 2) {
      continue;
    }

    const parent = candidates.map((_, index) => index);
    const find = (index: number): number => {
      let current = index;
      while (parent[current] !== current) {
        current = parent[current] as number;
      }
      let compress = index;
      while (parent[compress] !== compress) {
        const next = parent[compress] as number;
        parent[compress] = current;
        compress = next;
      }
      return current;
    };
    const union = (left: number, right: number): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) {
        return;
      }
      if (leftRoot < rightRoot) {
        parent[rightRoot] = leftRoot;
      } else {
        parent[leftRoot] = rightRoot;
      }
    };

    const pairSignals: PairSignal[] = [];
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      const left = candidates[leftIndex] as ScannedMemory;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < candidates.length;
        rightIndex += 1
      ) {
        const right = candidates[rightIndex] as ScannedMemory;
        const sharedTags = intersection(
          left.normalizedTags,
          right.normalizedTags,
        );
        const sharedEntities = intersection(
          left.normalizedEntities,
          right.normalizedEntities,
        );
        const tokenSimilarity = jaccard(left.tokens, right.tokens);
        if (
          sharedTags.length === 0 &&
          sharedEntities.length === 0 &&
          tokenSimilarity < threshold
        ) {
          continue;
        }
        union(leftIndex, rightIndex);
        pairSignals.push({
          left: leftIndex,
          right: rightIndex,
          tokenSimilarity,
          sharedTags,
          sharedEntities,
        });
      }
    }

    const byRoot = new Map<number, number[]>();
    for (let index = 0; index < candidates.length; index += 1) {
      const root = find(index);
      const bucket = byRoot.get(root) ?? [];
      bucket.push(index);
      byRoot.set(root, bucket);
    }

    for (const indices of byRoot.values()) {
      if (indices.length < 2) {
        continue;
      }
      const indexSet = new Set(indices);
      const groupSignals = pairSignals.filter(
        (pair) => indexSet.has(pair.left) && indexSet.has(pair.right),
      );
      const signalSet = new Set<SemanticSignal>();
      const sharedTags = new Set<string>();
      const sharedEntities = new Set<string>();
      for (const signal of groupSignals) {
        if (signal.sharedTags.length > 0) {
          signalSet.add("shared_tag");
          for (const tag of signal.sharedTags) {
            sharedTags.add(tag);
          }
        }
        if (signal.sharedEntities.length > 0) {
          signalSet.add("shared_entity");
          for (const entity of signal.sharedEntities) {
            sharedEntities.add(entity);
          }
        }
        if (signal.tokenSimilarity >= threshold) {
          signalSet.add("text_similarity");
        }
      }

      const groupCandidates = indices
        .map((index) => candidates[index] as ScannedMemory)
        .sort((left, right) => compareCanonical(left.view, right.view));
      const memoryIds = groupCandidates.map(
        (candidate) => candidate.view.memory_id,
      );
      const similarities = groupSignals.map((signal) => signal.tokenSimilarity);
      const minSimilarity =
        similarities.length === 0
          ? 0
          : Math.min(...similarities);
      const maxSimilarity =
        similarities.length === 0
          ? 0
          : Math.max(...similarities);

      groups.push({
        group_id: hash(`semantic\0${kind}\0${memoryIds.join("\0")}`),
        kind,
        memory_ids: memoryIds,
        candidates: groupCandidates.map((candidate) => candidate.view),
        signals: SIGNAL_ORDER.filter((signal) => signalSet.has(signal)),
        shared_tags: [...sharedTags].sort(),
        shared_entities: [...sharedEntities].sort(),
        token_similarity: {
          min: roundScore(minSimilarity),
          max: roundScore(maxSimilarity),
        },
      });
    }
  }

  groups.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      (left.memory_ids[0] ?? "").localeCompare(right.memory_ids[0] ?? ""),
  );
  return groups;
}

/**
 * Builds a deterministic maintenance plan from active memories in one exact
 * scope. Reading is isolated from the store's write connection and all text
 * grouping is local; semantic summaries are deliberately not generated.
 *
 * @param dbPath SQLite database opened read-only.
 * @param scope Exact five-part memory scope to inspect.
 * @param options Threshold and preview controls for deterministic grouping.
 * @returns Exact-duplicate and semantic-review candidates without mutations.
 */
export function planMaintenance(
  dbPath: string,
  scope: MemoryScope,
  options: MaintenancePlanOptions = {},
): MaintenancePlan {
  assertScope(scope);
  const threshold = assertUnitInterval(
    "semanticTokenThreshold",
    options.semanticTokenThreshold ?? DEFAULT_SEMANTIC_TOKEN_THRESHOLD,
  );
  const previewCharacters = assertPositiveInteger(
    "previewCharacters",
    options.previewCharacters ?? DEFAULT_PREVIEW_CHARACTERS,
  );
  const memories = scanActiveMemories(dbPath, scope, previewCharacters);
  const exact = buildExactDuplicateGroups(memories);
  const semanticReviewGroups = buildSemanticReviewGroups(
    memories,
    exact.duplicateMemoryIds,
    threshold,
  );
  const exactDuplicateRecords = exact.groups.reduce(
    (total, group) => total + group.duplicates.length,
    0,
  );
  const semanticReviewRecords = semanticReviewGroups.reduce(
    (total, group) => total + group.memory_ids.length,
    0,
  );

  return {
    schema_version: MAINTENANCE_PLAN_VERSION,
    scope: { ...scope },
    exact_duplicate_groups: exact.groups,
    semantic_review_groups: semanticReviewGroups,
    summary: {
      active_memories_scanned: memories.length,
      exact_duplicate_groups: exact.groups.length,
      exact_duplicate_records: exactDuplicateRecords,
      semantic_review_groups: semanticReviewGroups.length,
      semantic_review_records: semanticReviewRecords,
    },
  };
}

/**
 * Serializes a maintenance plan with stable two-space formatting.
 *
 * @param plan Plan returned by {@link planMaintenance}.
 * @returns Pretty-printed JSON suitable for storage or DSH inspection.
 */
export function serializeMaintenancePlan(plan: MaintenancePlan): string {
  return JSON.stringify(plan, null, 2);
}

/**
 * Lists the exact scopes present in a memory database.
 *
 * The read-only connection deliberately does not apply the process write
 * lock; the owner of the database must already hold it while this planner
 * opens the same file for reads.
 *
 * @param dbPath SQLite database path.
 * @returns Distinct five-part scopes sorted by their stable ids.
 */
export function listMaintenanceScopes(dbPath: string): MemoryScope[] {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT tenant_id, user_id, agent_id, persona_id, space_id
         FROM memory_records
         ORDER BY tenant_id, user_id, agent_id, persona_id, space_id`,
      )
      .all() as DatabaseRow[];
    return rows.map((row) => {
      const scope = {
        tenant_id: asString(row.tenant_id),
        user_id: asString(row.user_id),
        agent_id: asString(row.agent_id),
        persona_id: asString(row.persona_id),
        space_id: asString(row.space_id),
      };
      assertScope(scope);
      return scope;
    });
  } finally {
    db.close();
  }
}

/**
 * Runs deterministic maintenance for every scope in one database.
 *
 * Exact normalized duplicates are suppressed only after one database
 * snapshot. Semantic-review groups are reported for an adapter to reason
 * about; they are never applied here.
 *
 * @param store Store that owns the database write connection.
 * @param dbPath SQLite database path.
 * @param options Planner, mutation, snapshot, and reason controls.
 * @returns Per-scope plans and the aggregate mutation summary.
 */
export function runMaintenance(
  store: MemoryStore,
  dbPath: string,
  options: RunMaintenanceOptions = {},
): RunMaintenanceResult {
  const applyExactDuplicates = options.applyExactDuplicates ?? true;
  const scopes = listMaintenanceScopes(dbPath);
  const results: ScopeMaintenanceResult[] = [];
  let snapshot: import("./snapshots.js").SnapshotInfo | null = null;
  let exactDuplicateGroups = 0;
  let exactDuplicatesSuppressed = 0;
  let semanticReviewGroups = 0;

  for (const scope of scopes) {
    const plan = planMaintenance(dbPath, scope, {
      ...(options.semanticTokenThreshold === undefined
        ? {}
        : { semanticTokenThreshold: options.semanticTokenThreshold }),
      ...(options.previewCharacters === undefined
        ? {}
        : { previewCharacters: options.previewCharacters }),
    });
    exactDuplicateGroups += plan.summary.exact_duplicate_groups;
    semanticReviewGroups += plan.summary.semantic_review_groups;
    let applied: ApplyExactDuplicatePlanResult | null = null;
    if (applyExactDuplicates && plan.summary.exact_duplicate_groups > 0) {
      snapshot ??= store.snapshot({
        prefix: options.snapshotPrefix ?? "maintenance",
      });
      applied = applyExactDuplicatePlan(store, plan, {
        dryRun: false,
        reason:
          options.reason?.trim() ||
          "idle maintenance: suppress exact duplicate memory",
      });
      exactDuplicatesSuppressed += applied.actions.length;
    }
    results.push({ scope, plan, applied });
  }

  const result: RunMaintenanceResult = {
    scopes_scanned: scopes.length,
    exact_duplicate_groups: exactDuplicateGroups,
    exact_duplicates_suppressed: exactDuplicatesSuppressed,
    semantic_review_groups: semanticReviewGroups,
    snapshot,
    report_path: null,
    scopes: results,
  };
  if (options.reportDirectory !== undefined) {
    mkdirSync(options.reportDirectory, { recursive: true });
    const reportPath = join(options.reportDirectory, MAINTENANCE_REPORT_FILENAME);
    const temporaryPath = `${reportPath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          scopes_scanned: result.scopes_scanned,
          exact_duplicate_groups: result.exact_duplicate_groups,
          exact_duplicates_suppressed: result.exact_duplicates_suppressed,
          semantic_review_groups: result.semantic_review_groups,
          scopes: result.scopes,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    renameSync(temporaryPath, reportPath);
    result.report_path = reportPath;
  }
  return result;
}

function assertMaintenancePlan(plan: MaintenancePlan): void {
  if (plan.schema_version !== MAINTENANCE_PLAN_VERSION) {
    throw new Error(
      `Unsupported maintenance plan version ${String(plan.schema_version)}.`,
    );
  }
  assertScope(plan.scope);
  if (!Array.isArray(plan.exact_duplicate_groups)) {
    throw new Error("Maintenance plan exact_duplicate_groups must be an array.");
  }

  const canonicalIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const group of plan.exact_duplicate_groups) {
    if (
      typeof group.canonical?.memory_id !== "string" ||
      group.canonical.memory_id.length === 0 ||
      !Array.isArray(group.duplicates)
    ) {
      throw new Error("Maintenance exact-duplicate group is malformed.");
    }
    if (canonicalIds.has(group.canonical.memory_id)) {
      throw new Error(
        `Maintenance plan repeats canonical memory '${group.canonical.memory_id}'.`,
      );
    }
    canonicalIds.add(group.canonical.memory_id);
    for (const duplicate of group.duplicates) {
      if (typeof duplicate?.memory_id !== "string" || duplicate.memory_id === "") {
        throw new Error("Maintenance duplicate memory id is malformed.");
      }
      if (duplicate.memory_id === group.canonical.memory_id) {
        throw new Error("Maintenance duplicate cannot equal its canonical.");
      }
      if (duplicateIds.has(duplicate.memory_id)) {
        throw new Error(
          `Maintenance plan repeats duplicate memory '${duplicate.memory_id}'.`,
        );
      }
      duplicateIds.add(duplicate.memory_id);
    }
  }
  for (const canonicalId of canonicalIds) {
    if (duplicateIds.has(canonicalId)) {
      throw new Error(
        `Maintenance memory '${canonicalId}' is both canonical and duplicate.`,
      );
    }
  }
}

function normalizedCurrentText(memory: MemoryRecord | null): string | null {
  return memory === null ? null : normalizeText(memory.content.text);
}

/**
 * Applies only exact-duplicate suppressions from a plan. Every action is
 * revalidated against the store immediately before mutation: both records must
 * still be active, their normalized text must match, and cross-kind groups are
 * skipped unless explicitly allowed. Semantic-review groups are never applied.
 *
 * The default is a dry run. Passing `{ dryRun: false }` explicitly suppresses
 * duplicate records through the public MemoryStore.forget API while retaining
 * each canonical record.
 *
 * @param store Store that owns the same scope used to build the plan.
 * @param plan Maintenance plan, possibly loaded back from JSON.
 * @param options Mutation opt-in and cross-kind policy.
 * @returns Planned or completed suppressions plus skipped records and reasons.
 */
export function applyExactDuplicatePlan(
  store: MemoryStore,
  plan: MaintenancePlan,
  options: ApplyExactDuplicatePlanOptions = {},
): ApplyExactDuplicatePlanResult {
  assertMaintenancePlan(plan);
  const dryRun = options.dryRun ?? true;
  const allowCrossKind = options.allowCrossKind ?? false;
  const requestedReason = options.reason?.trim();
  const pending: PendingSuppression[] = [];
  const skipped: ApplyExactDuplicateSkip[] = [];

  for (const group of plan.exact_duplicate_groups) {
    const canonical = store.get(plan.scope, group.canonical.memory_id);
    if (canonical === null || canonical.status !== "active") {
      for (const duplicate of group.duplicates) {
        skipped.push({
          memory_id: duplicate.memory_id,
          canonical_memory_id: group.canonical.memory_id,
          reason: "canonical is missing or no longer active",
        });
      }
      continue;
    }
    const canonicalText = normalizedCurrentText(canonical);

    for (const duplicateView of group.duplicates) {
      const duplicate = store.get(plan.scope, duplicateView.memory_id);
      if (duplicate === null || duplicate.status !== "active") {
        skipped.push({
          memory_id: duplicateView.memory_id,
          canonical_memory_id: canonical.memory_id,
          reason: "duplicate is missing or no longer active",
        });
        continue;
      }
      if (!allowCrossKind && duplicate.kind !== canonical.kind) {
        skipped.push({
          memory_id: duplicate.memory_id,
          canonical_memory_id: canonical.memory_id,
          reason: "cross-kind duplicate requires explicit review",
        });
        continue;
      }
      if (normalizedCurrentText(duplicate) !== canonicalText) {
        skipped.push({
          memory_id: duplicate.memory_id,
          canonical_memory_id: canonical.memory_id,
          reason: "normalized text changed since the plan was created",
        });
        continue;
      }
      pending.push({
        canonicalMemoryId: canonical.memory_id,
        duplicateMemoryId: duplicate.memory_id,
      });
    }
  }

  if (dryRun) {
    return {
      dry_run: true,
      actions: pending.map((action) => ({
        memory_id: action.duplicateMemoryId,
        canonical_memory_id: action.canonicalMemoryId,
        outcome: "would_suppress",
      })),
      skipped,
    };
  }

  const actions: ApplyExactDuplicateAction[] = [];
  for (const action of pending) {
    try {
      const result = store.forget({
        scope: plan.scope,
        memory_id: action.duplicateMemoryId,
        mode: "suppress",
        reason:
          requestedReason && requestedReason.length > 0
            ? requestedReason
            : `maintenance: exact duplicate of ${action.canonicalMemoryId}`,
      });
      if (result.status !== "suppressed") {
        skipped.push({
          memory_id: action.duplicateMemoryId,
          canonical_memory_id: action.canonicalMemoryId,
          reason: `unexpected status after suppression: ${result.status}`,
        });
        continue;
      }
      actions.push({
        memory_id: action.duplicateMemoryId,
        canonical_memory_id: action.canonicalMemoryId,
        outcome: "suppressed",
      });
    } catch (error) {
      skipped.push({
        memory_id: action.duplicateMemoryId,
        canonical_memory_id: action.canonicalMemoryId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    dry_run: false,
    actions,
    skipped,
  };
}
