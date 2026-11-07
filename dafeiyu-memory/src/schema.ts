import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_label TEXT NOT NULL,
  epistemic_type TEXT NOT NULL,
  occurred_at TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redacted_at TEXT,
  redaction_reason TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (current_version_id) REFERENCES memory_versions(version_id)
    ON DELETE SET NULL
) STRICT;

CREATE TABLE IF NOT EXISTS provenance_records (
  provenance_id TEXT PRIMARY KEY,
  event_id TEXT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_confidence REAL NOT NULL,
  captured_at TEXT NOT NULL,
  details_json TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE SET NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_versions (
  version_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  summary TEXT,
  epistemic_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_confidence REAL NOT NULL,
  factual_confidence REAL NOT NULL,
  salience REAL NOT NULL,
  activation_strength REAL NOT NULL,
  identity_relevance REAL NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  privacy_level TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  provenance_id TEXT,
  supersedes_version_id TEXT,
  reason_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (memory_id, version),
  FOREIGN KEY (memory_id) REFERENCES memory_records(memory_id) ON DELETE CASCADE,
  FOREIGN KEY (provenance_id) REFERENCES provenance_records(provenance_id) ON DELETE SET NULL,
  FOREIGN KEY (supersedes_version_id) REFERENCES memory_versions(version_id) ON DELETE SET NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memory_links (
  link_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  from_memory_id TEXT NOT NULL,
  to_memory_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_memory_id, to_memory_id, relation_type),
  FOREIGN KEY (from_memory_id) REFERENCES memory_records(memory_id) ON DELETE CASCADE,
  FOREIGN KEY (to_memory_id) REFERENCES memory_records(memory_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS recall_episodes (
  episode_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  current_goal TEXT,
  context_json TEXT NOT NULL,
  result_trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS deletion_requests (
  request_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  requested_by_hash TEXT NOT NULL,
  reason_hash TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  redacted_events INTEGER NOT NULL DEFAULT 0,
  deleted_versions INTEGER NOT NULL DEFAULT 0,
  deleted_links INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (memory_id) REFERENCES memory_records(memory_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS tombstones (
  tombstone_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL UNIQUE,
  deletion_request_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  verified INTEGER NOT NULL,
  redaction_summary_json TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_records(memory_id) ON DELETE CASCADE,
  FOREIGN KEY (deletion_request_id) REFERENCES deletion_requests(request_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  action TEXT NOT NULL,
  memory_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memory_scope_status
  ON memory_records (tenant_id, user_id, agent_id, persona_id, space_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_kind
  ON memory_records (kind);
CREATE INDEX IF NOT EXISTS idx_version_memory
  ON memory_versions (memory_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_links_from
  ON memory_links (from_memory_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_links_to
  ON memory_links (to_memory_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_recall_scope_created
  ON recall_episodes (tenant_id, user_id, agent_id, persona_id, space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_memory
  ON audit_log (memory_id, created_at);
`;

/**
 * Creates the complete schema when absent and verifies the schema version.
 * Initialization is idempotent so the stdio server can restart safely.
 */
export function initializeSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA_SQL);

  const existing = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get("schema_version");

  if (existing === undefined) {
    db.prepare(
      "INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)",
    ).run("schema_version", String(SCHEMA_VERSION), new Date().toISOString());
    return;
  }

  const version = Number(existing.value);
  if (!Number.isInteger(version) || version > SCHEMA_VERSION) {
    throw new Error(
      `Unsupported memory schema version ${String(existing.value)}; ` +
        `this server supports up to version ${SCHEMA_VERSION}.`,
    );
  }
}
