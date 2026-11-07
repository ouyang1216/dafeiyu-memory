/**
 * Canonical domain types shared by the storage, retrieval, and MCP layers.
 */

import type { SnapshotInfo } from "./snapshots.js";

export type MemoryKind =
  | "episodic"
  | "semantic"
  | "procedural"
  | "prospective"
  | "autobiographical"
  | "social";

export type EpistemicType =
  | "observed"
  | "reported"
  | "inferred"
  | "imagined"
  | "generated"
  | "injected"
  | "unknown";

export type MemoryStatus =
  | "active"
  | "suppressed"
  | "archived"
  | "quarantined"
  | "deleted";

export type ResponseFormat = "json" | "markdown";

export interface MemoryScope {
  tenant_id: string;
  user_id: string;
  agent_id: string;
  persona_id: string;
  space_id: string;
}

export interface MemoryContent {
  text: string;
  tags?: string[];
  entities?: string[];
  metadata?: Record<string, unknown>;
}

export interface RememberInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: MemoryContent;
  summary?: string;
  epistemic_type: EpistemicType;
  source_type: string;
  source_label: string;
  source_confidence: number;
  factual_confidence: number;
  salience?: number;
  identity_relevance?: number;
  valid_from?: string;
  valid_to?: string;
  privacy_level?: string;
  retention_class?: string;
  occurred_at?: string;
  attributes?: Record<string, unknown>;
}

export interface MemoryRecord {
  memory_id: string;
  version_id: string;
  version: number;
  kind: MemoryKind;
  status: MemoryStatus;
  content: MemoryContent;
  summary: string | null;
  epistemic_type: EpistemicType;
  source_type: string;
  source_label: string;
  source_confidence: number;
  factual_confidence: number;
  salience: number;
  activation_strength: number;
  identity_relevance: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  valid_from: string | null;
  valid_to: string | null;
  privacy_level: string;
  retention_class: string;
}

export interface RecallInput {
  scope: MemoryScope;
  query: string;
  current_goal?: string;
  current_context?: Record<string, unknown>;
  kinds?: MemoryKind[];
  max_candidates?: number;
  max_evidence?: number;
  include_suppressed?: boolean;
}

export interface RecallEvidence {
  memory_id: string;
  version_id: string;
  kind: MemoryKind;
  summary: string;
  text: string;
  epistemic_type: EpistemicType;
  source_type: string;
  source_label: string;
  source_confidence: number;
  factual_confidence: number;
  activation: number;
  lexical_score: number;
  recency_score: number;
  goal_score: number;
  conflict_ids: string[];
  created_at: string;
}

export interface RecallResult {
  decision: "direct" | "qualified" | "uncertain" | "multi_perspective" | "abstain";
  query: string;
  evidence: RecallEvidence[];
  conflicts: string[];
  explanation: string;
  total_candidates: number;
}

export interface CorrectInput {
  scope: MemoryScope;
  memory_id: string;
  content: MemoryContent;
  summary?: string;
  reason: string;
  source_type: string;
  source_label: string;
  source_confidence: number;
  factual_confidence: number;
}

export interface ForgetInput {
  scope: MemoryScope;
  memory_id: string;
  mode: "suppress" | "archive" | "quarantine";
  reason: string;
}

export interface DeleteInput {
  scope: MemoryScope;
  memory_id: string;
  reason: string;
  requested_by: string;
}

export interface DeleteResult {
  memory_id: string;
  state: "completed";
  redacted_events: number;
  deleted_versions: number;
  deleted_links: number;
  verified: boolean;
  completed_at: string;
}

export interface StatsResult {
  total_memories: number;
  active_memories: number;
  suppressed_memories: number;
  quarantined_memories: number;
  deleted_memories: number;
  total_versions: number;
  total_links: number;
}

export interface MemorySnapshotOptions {
  directory?: string;
  prefix?: string;
  retain?: number;
}

export interface MemoryStoreOptions {
  snapshotDirectory?: string;
  snapshotRetention?: number;
  snapshotPrefix?: string;
  snapshotBeforeDelete?: boolean;
}

export interface MemoryStore {
  remember(input: RememberInput): MemoryRecord;
  recall(input: RecallInput): RecallResult;
  get(scope: MemoryScope, memoryId: string): MemoryRecord | null;
  correct(input: CorrectInput): MemoryRecord;
  forget(input: ForgetInput): MemoryRecord;
  delete(input: DeleteInput): DeleteResult;
  stats(scope: MemoryScope): StatsResult;
  snapshot(options?: MemorySnapshotOptions): SnapshotInfo;
  close(): void;
}
