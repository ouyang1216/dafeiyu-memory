import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "../src/store.js";
import type {
  MemoryScope,
  MemoryStore,
  RememberInput,
} from "../src/types.js";

const scope: MemoryScope = {
  tenant_id: "tenant-test",
  user_id: "user-test",
  agent_id: "agent-test",
  persona_id: "dafeiyu",
  space_id: "space-test",
};

let directory: string;
let dbPath: string;
let store: MemoryStore;

function rememberText(
  text: string,
  overrides: Partial<RememberInput> = {},
): ReturnType<MemoryStore["remember"]> {
  return store.remember({
    scope,
    kind: "semantic",
    content: { text, tags: ["architecture"], entities: ["Dafeiyu"] },
    epistemic_type: "observed",
    source_type: "conversation",
    source_label: "test-session",
    source_confidence: 0.9,
    factual_confidence: 0.8,
    salience: 0.7,
    identity_relevance: 0.5,
    ...overrides,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dafeiyu-memory-store-"));
  dbPath = join(directory, "memory.sqlite3");
  store = createMemoryStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("SQLite memory store", () => {
  it("remembers and gets a scoped memory with structured content", () => {
    const memory = rememberText("大肥鱼偏好先看设计图，再讨论实现。", {
      content: {
        text: "大肥鱼偏好先看设计图，再讨论实现。",
        tags: ["preference", "design"],
        entities: ["大肥鱼"],
        metadata: { confidence_note: "stated directly" },
      },
      summary: "偏好先设计后实现",
      privacy_level: "personal",
    });

    expect(memory.version).toBe(1);
    expect(memory.status).toBe("active");
    expect(memory.summary).toBe("偏好先设计后实现");
    expect(memory.content.metadata).toEqual({
      confidence_note: "stated directly",
    });
    expect(store.get(scope, memory.memory_id)).toEqual(memory);
    expect(
      store.get({ ...scope, space_id: "another-space" }, memory.memory_id),
    ).toBeNull();
  });

  it("normalizes time fields to UTC and rejects inverted validity windows", () => {
    const memory = rememberText("time normalization probe", {
      occurred_at: "2025-10-01T09:30:00+08:00",
      valid_from: "2025-10-01T00:00:00+08:00",
      valid_to: "2025-10-02T00:00:00+08:00",
    });

    expect(memory.valid_from).toBe("2025-09-30T16:00:00.000Z");
    expect(memory.valid_to).toBe("2025-10-01T16:00:00.000Z");
    expect(() =>
      rememberText("invalid time window", {
        valid_from: "2025-10-02T00:00:00Z",
        valid_to: "2025-10-01T00:00:00Z",
      }),
    ).toThrow(/valid_from must not be later than valid_to/i);
    expect(() =>
      rememberText("invalid timestamp", {
        occurred_at: "not-a-timestamp",
      }),
    ).toThrow(/valid ISO-8601/i);
  });

  it("recalls Chinese and English memories with evidence and status filtering", () => {
    const chinese = rememberText("我喜欢用中文讨论系统架构和代码设计。", {
      salience: 0.9,
      source_confidence: 0.86,
      factual_confidence: 0.74,
    });
    const english = rememberText(
      "The project uses PostgreSQL for durable task metadata.",
      {
        content: {
          text: "The project uses PostgreSQL for durable task metadata.",
          tags: ["postgresql", "storage"],
          entities: ["PostgreSQL"],
        },
      },
    );
    const suppressed = rememberText("中文架构旧方案已经废弃。");
    store.forget({
      scope,
      memory_id: suppressed.memory_id,
      mode: "suppress",
      reason: "superseded",
    });
    rememberText("中文架构隔离测试", { kind: "semantic" });
    const quarantined = rememberText("中文架构不可信来源");
    store.forget({
      scope,
      memory_id: quarantined.memory_id,
      mode: "quarantine",
      reason: "untrusted",
    });

    const zh = store.recall({
      scope,
      query: "系统 架构 设计",
      current_goal: "设计记忆系统架构",
      max_evidence: 5,
    });
    expect(zh.evidence[0]?.memory_id).toBe(chinese.memory_id);
    expect(zh.evidence[0]?.source_confidence).toBe(0.86);
    expect(zh.evidence[0]?.factual_confidence).toBe(0.74);
    expect(zh.evidence.some((item) => item.memory_id === suppressed.memory_id)).toBe(
      false,
    );
    expect(
      zh.evidence.some((item) => item.memory_id === quarantined.memory_id),
    ).toBe(false);

    const en = store.recall({
      scope,
      query: "postgresql metadata",
      max_evidence: 3,
    });
    expect(en.evidence[0]?.memory_id).toBe(english.memory_id);
    expect(["direct", "qualified"]).toContain(en.decision);

    const audit = store.recall({
      scope,
      query: "中文 架构",
      include_suppressed: true,
      max_evidence: 20,
    });
    expect(
      audit.evidence.some((item) => item.memory_id === suppressed.memory_id),
    ).toBe(true);
    expect(
      audit.evidence.some((item) => item.memory_id === quarantined.memory_id),
    ).toBe(false);

    const unrelated = store.recall({
      scope,
      query: "quantum rocket telemetry",
      max_evidence: 5,
    });
    expect(unrelated.decision).toBe("abstain");
    expect(unrelated.evidence).toEqual([]);
  });

  it("keeps an immutable old version when correcting a memory", () => {
    const original = rememberText("记忆系统的数据库使用 SQLite。");
    const corrected = store.correct({
      scope,
      memory_id: original.memory_id,
      content: {
        text: "记忆系统的数据库使用 SQLite，并为未来 PostgreSQL 适配保留边界。",
        tags: ["architecture", "storage"],
      },
      summary: "存储选型已修正",
      reason: "user clarified the durable storage boundary",
      source_type: "conversation",
      source_label: "correction-session",
      source_confidence: 0.95,
      factual_confidence: 0.9,
    });

    expect(corrected.version).toBe(2);
    expect(corrected.memory_id).toBe(original.memory_id);
    expect(corrected.content.text).toContain("PostgreSQL");
    const recalled = store.recall({
      scope,
      query: "SQLite PostgreSQL 存储",
      max_evidence: 5,
    });
    const currentEvidence = recalled.evidence.find(
      (item) => item.memory_id === original.memory_id,
    );
    expect(currentEvidence?.version_id).toBe(corrected.version_id);
    expect(currentEvidence?.text).toBe(corrected.content.text);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const versions = db
        .prepare(
          `SELECT version, content_json
           FROM memory_versions
           WHERE memory_id = ?
           ORDER BY version`,
        )
        .all(original.memory_id);
      expect(versions).toHaveLength(2);
      expect(versions[0]?.version).toBe(1);
      expect(String(versions[0]?.content_json)).toContain("SQLite");
      expect(versions[1]?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it("forgets in all reversible modes and excludes hidden records from recall", () => {
    const suppressed = rememberText("suppressed memory about 秘密设计");
    const archived = rememberText("archived memory about old design");
    const quarantined = rememberText("quarantined memory about 秘密设计");

    expect(
      store.forget({
        scope,
        memory_id: suppressed.memory_id,
        mode: "suppress",
        reason: "temporary",
      }).status,
    ).toBe("suppressed");
    expect(
      store.forget({
        scope,
        memory_id: archived.memory_id,
        mode: "archive",
        reason: "old",
      }).status,
    ).toBe("archived");
    expect(
      store.forget({
        scope,
        memory_id: quarantined.memory_id,
        mode: "quarantine",
        reason: "unsafe",
      }).status,
    ).toBe("quarantined");

    const result = store.recall({
      scope,
      query: "旧设计 memory",
      max_evidence: 10,
    });
    expect(result.evidence.some((item) => item.memory_id === archived.memory_id)).toBe(
      true,
    );
    expect(
      result.evidence.some((item) => item.memory_id === suppressed.memory_id),
    ).toBe(false);
    expect(
      result.evidence.some((item) => item.memory_id === quarantined.memory_id),
    ).toBe(false);

    const stats = store.stats(scope);
    expect(stats.suppressed_memories).toBe(1);
    expect(stats.quarantined_memories).toBe(1);
    expect(stats.total_memories).toBe(3);
  });

  it("never recalls suppressed or quarantined records by default", () => {
    const active = rememberText("默认可见的架构偏好");
    const suppressed = rememberText("默认隐藏的架构偏好");
    const quarantined = rememberText("隔离中的架构偏好");
    store.forget({
      scope,
      memory_id: suppressed.memory_id,
      mode: "suppress",
      reason: "user hid this memory",
    });
    store.forget({
      scope,
      memory_id: quarantined.memory_id,
      mode: "quarantine",
      reason: "untrusted source",
    });

    const result = store.recall({
      scope,
      query: "架构偏好",
      max_evidence: 10,
    });
    expect(result.evidence.map((item) => item.memory_id)).toContain(
      active.memory_id,
    );
    expect(result.evidence.map((item) => item.memory_id)).not.toContain(
      suppressed.memory_id,
    );
    expect(result.evidence.map((item) => item.memory_id)).not.toContain(
      quarantined.memory_id,
    );

    const auditSuppressed = store.recall({
      scope,
      query: "架构偏好",
      include_suppressed: true,
      max_evidence: 10,
    });
    expect(auditSuppressed.evidence.map((item) => item.memory_id)).toContain(
      suppressed.memory_id,
    );
    expect(auditSuppressed.evidence.map((item) => item.memory_id)).not.toContain(
      quarantined.memory_id,
    );
  });

  it("does not use source or factual confidence as activation", () => {
    const lowConfidence = rememberText("activation-probe-low", {
      source_confidence: 0,
      factual_confidence: 0,
      salience: 0.33,
      identity_relevance: 0,
    });
    const highConfidence = rememberText("activation-probe-high", {
      source_confidence: 1,
      factual_confidence: 1,
      salience: 0.33,
      identity_relevance: 0,
    });

    expect(lowConfidence.activation_strength).toBe(0.33);
    expect(highConfidence.activation_strength).toBe(0.33);

    const lowRecall = store.recall({
      scope,
      query: "activation-probe-low",
      max_evidence: 1,
    });
    const highRecall = store.recall({
      scope,
      query: "activation-probe-high",
      max_evidence: 1,
    });

    expect(lowRecall.evidence[0]?.activation).toBe(0.33);
    expect(highRecall.evidence[0]?.activation).toBe(0.33);
    expect(lowRecall.evidence[0]?.source_confidence).toBe(0);
    expect(lowRecall.evidence[0]?.factual_confidence).toBe(0);
    expect(highRecall.evidence[0]?.source_confidence).toBe(1);
    expect(highRecall.evidence[0]?.factual_confidence).toBe(1);
  });

  it("enforces exact scope for get, recall, correction, forget, and delete", () => {
    const memory = rememberText("scope-isolation-probe");
    const outsider: MemoryScope = { ...scope, user_id: "another-user" };

    expect(store.get(outsider, memory.memory_id)).toBeNull();
    expect(
      store.recall({
        scope: outsider,
        query: "scope-isolation-probe",
        max_evidence: 5,
      }).evidence,
    ).toEqual([]);
    expect(() =>
      store.correct({
        scope: outsider,
        memory_id: memory.memory_id,
        content: { text: "cross-scope correction" },
        reason: "should fail",
        source_type: "test",
        source_label: "test",
        source_confidence: 1,
        factual_confidence: 1,
      }),
    ).toThrow(/not found in this scope/i);
    expect(() =>
      store.forget({
        scope: outsider,
        memory_id: memory.memory_id,
        mode: "suppress",
        reason: "should fail",
      }),
    ).toThrow(/not found in this scope/i);
    expect(() =>
      store.delete({
        scope: outsider,
        memory_id: memory.memory_id,
        reason: "should fail",
        requested_by: "outsider",
      }),
    ).toThrow(/not found in this scope/i);
    expect(store.get(scope, memory.memory_id)?.status).toBe("active");
  });

  it("hard-deletes every version, link, event payload, and provenance row while retaining a safe tombstone", () => {
    const first = rememberText("敏感内容：大肥鱼的真实密钥是 abc123", {
      content: {
        text: "敏感内容：大肥鱼的真实密钥是 abc123",
        tags: ["secret"],
        entities: ["abc123"],
        metadata: { raw: "sensitive payload" },
      },
    });
    const corrected = store.correct({
      scope,
      memory_id: first.memory_id,
      content: {
        text: "敏感内容更新：大肥鱼的真实密钥是 def456",
        tags: ["secret", "corrected"],
        entities: ["def456"],
        metadata: { raw: "new sensitive payload" },
      },
      summary: "corrected sensitive payload",
      reason: "the first secret was replaced",
      source_type: "conversation",
      source_label: "delete-test-correction",
      source_confidence: 0.98,
      factual_confidence: 0.97,
    });
    expect(corrected.version).toBe(2);
    const second = rememberText("这条记忆与第一条冲突。", {
      attributes: { conflicts_with: [first.memory_id] },
    });

    const conflict = store.recall({
      scope,
      query: "记忆 冲突",
      max_evidence: 10,
    });
    expect(conflict.decision).toBe("multi_perspective");
    expect(conflict.conflicts).toHaveLength(1);

    const deleted = store.delete({
      scope,
      memory_id: first.memory_id,
      reason: "explicit erasure request",
      requested_by: "owner",
    });
    expect(deleted.state).toBe("completed");
    expect(deleted.verified).toBe(true);
    expect(deleted.deleted_versions).toBe(2);
    expect(deleted.deleted_links).toBe(1);
    expect(deleted.redacted_events).toBe(2);
    expect(store.get(scope, first.memory_id)).toBeNull();
    expect(store.get(scope, second.memory_id)?.status).toBe("active");
    expect(
      store.delete({
        scope,
        memory_id: first.memory_id,
        reason: "retry after completion",
        requested_by: "owner",
      }),
    ).toMatchObject({
      memory_id: first.memory_id,
      state: "completed",
      redacted_events: 0,
      deleted_versions: 0,
      deleted_links: 0,
      verified: true,
    });

    const stats = store.stats(scope);
    expect(stats.deleted_memories).toBe(1);
    expect(stats.total_links).toBe(0);
    expect(
      store.recall({
        scope,
        query: "abc123 def456 敏感内容",
        max_evidence: 10,
      }).evidence.some((item) => item.memory_id === first.memory_id),
    ).toBe(false);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const versions = db
        .prepare("SELECT COUNT(*) AS count FROM memory_versions WHERE memory_id = ?")
        .get(first.memory_id);
      const links = db
        .prepare(
          `SELECT COUNT(*) AS count FROM memory_links
           WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
             AND persona_id = ? AND space_id = ?
             AND (from_memory_id = ? OR to_memory_id = ?)`,
        )
        .get(
          scope.tenant_id,
          scope.user_id,
          scope.agent_id,
          scope.persona_id,
          scope.space_id,
          first.memory_id,
          first.memory_id,
        );
      const events = db
        .prepare(
          `SELECT payload_json, source_type, source_label, redacted_at FROM events
           WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
             AND persona_id = ? AND space_id = ?`,
        )
        .all(
          scope.tenant_id,
          scope.user_id,
          scope.agent_id,
          scope.persona_id,
          scope.space_id,
        );
      const provenance = db
        .prepare(
          `SELECT COUNT(*) AS count FROM provenance_records
           WHERE tenant_id = ? AND user_id = ? AND agent_id = ?
             AND persona_id = ? AND space_id = ?
             AND details_json LIKE '%correct%'`,
        )
        .get(
          scope.tenant_id,
          scope.user_id,
          scope.agent_id,
          scope.persona_id,
          scope.space_id,
        );
      const tombstone = db
        .prepare("SELECT verified, redaction_summary_json FROM tombstones WHERE memory_id = ?")
        .get(first.memory_id);
      const deletionRequest = db
        .prepare(
          `SELECT requested_by_hash, reason_hash FROM deletion_requests
           WHERE memory_id = ?`,
        )
        .get(first.memory_id);

      expect(Number(versions?.count)).toBe(0);
      expect(Number(links?.count)).toBe(0);
      expect(events).toHaveLength(3);
      const redactedEvents = events.filter(
        (row) =>
          row.source_type === "[redacted]" &&
          row.source_label === "[redacted]" &&
          typeof row.redacted_at === "string",
      );
      expect(redactedEvents).toHaveLength(2);
      expect(
        events.some((row) =>
          ["abc123", "def456", "sensitive payload"].some((secret) =>
            String(row.payload_json).includes(secret),
          ),
        ),
      ).toBe(false);
      expect(Number(provenance?.count)).toBe(0);
      expect(Number(tombstone?.verified)).toBe(1);
      expect(String(tombstone?.redaction_summary_json)).not.toMatch(
        /abc123|def456|sensitive payload/,
      );
      expect(String(deletionRequest?.requested_by_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(deletionRequest?.reason_hash)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
  });

  it("reports aggregate stats for the exact scope", () => {
    rememberText("active memory");
    const hidden = rememberText("suppressed memory");
    store.forget({
      scope,
      memory_id: hidden.memory_id,
      mode: "suppress",
      reason: "test",
    });

    expect(store.stats(scope)).toEqual({
      total_memories: 2,
      active_memories: 1,
      suppressed_memories: 1,
      quarantined_memories: 0,
      deleted_memories: 0,
      total_versions: 2,
      total_links: 0,
    });
    expect(
      store.stats({ ...scope, tenant_id: "different-tenant" }),
    ).toEqual({
      total_memories: 0,
      active_memories: 0,
      suppressed_memories: 0,
      quarantined_memories: 0,
      deleted_memories: 0,
      total_versions: 0,
      total_links: 0,
    });
  });
});
