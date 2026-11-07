import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyExactDuplicatePlan,
  planMaintenance,
  runMaintenance,
  serializeMaintenancePlan,
} from "../src/maintenance.js";
import { createMemoryStore } from "../src/store.js";
import type {
  MemoryKind,
  MemoryScope,
  MemoryStore,
  RememberInput,
} from "../src/types.js";

const scope: MemoryScope = {
  tenant_id: "tenant-maintenance",
  user_id: "user-maintenance",
  agent_id: "agent-maintenance",
  persona_id: "dafeiyu",
  space_id: "space-maintenance",
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
    content: { text },
    epistemic_type: "observed",
    source_type: "conversation",
    source_label: "maintenance-test",
    source_confidence: 0.9,
    factual_confidence: 0.8,
    ...overrides,
  });
}

function rememberWithKind(
  text: string,
  kind: MemoryKind,
  tags: string[] = [],
): ReturnType<MemoryStore["remember"]> {
  return rememberText(text, {
    kind,
    content: { text, tags },
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dafeiyu-maintenance-"));
  dbPath = join(directory, "memory.sqlite3");
  store = createMemoryStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("memory maintenance planning", () => {
  it("finds normalized exact duplicates, keeps the oldest canonical, and is deterministic", async () => {
    const canonical = rememberWithKind("ＤＡＦＥＩＹＵ   记忆系统", "semantic");
    await delay(5);
    const duplicate = rememberWithKind("dafeiyu 记忆系统", "semantic");
    const hidden = rememberWithKind("dafeiyu 记忆系统", "semantic");
    store.forget({
      scope,
      memory_id: hidden.memory_id,
      mode: "suppress",
      reason: "already hidden",
    });
    rememberText("dafeiyu 记忆系统", {
      scope: { ...scope, space_id: "another-space" },
    });

    const firstPlan = planMaintenance(dbPath, scope);
    const secondPlan = planMaintenance(dbPath, scope);

    expect(serializeMaintenancePlan(firstPlan)).toBe(
      serializeMaintenancePlan(secondPlan),
    );
    expect(firstPlan.scope).toEqual(scope);
    expect(firstPlan.summary).toEqual({
      active_memories_scanned: 2,
      exact_duplicate_groups: 1,
      exact_duplicate_records: 1,
      semantic_review_groups: 0,
      semantic_review_records: 0,
    });
    expect(firstPlan.exact_duplicate_groups).toHaveLength(1);
    expect(firstPlan.exact_duplicate_groups[0]?.canonical.memory_id).toBe(
      canonical.memory_id,
    );
    expect(
      firstPlan.exact_duplicate_groups[0]?.duplicates.map(
        (memory) => memory.memory_id,
      ),
    ).toEqual([duplicate.memory_id]);
    expect(JSON.parse(serializeMaintenancePlan(firstPlan))).toEqual(firstPlan);
  });

  it("groups semantic-review candidates without generating summaries or duplicating exact copies", async () => {
    const first = rememberText("大肥鱼偏好使用 SQLite 保存长期记忆。", {
      content: {
        text: "大肥鱼偏好使用 SQLite 保存长期记忆。",
        tags: ["memory", "storage"],
      },
    });
    await delay(5);
    const duplicate = rememberText("大肥鱼偏好使用 SQLite 保存长期记忆。", {
      content: {
        text: "大肥鱼偏好使用 SQLite 保存长期记忆。",
        tags: ["memory", "storage"],
      },
    });
    const related = rememberText("SQLite 记忆库需要启用 WAL。", {
      content: {
        text: "SQLite 记忆库需要启用 WAL。",
        tags: ["memory", "sqlite"],
      },
    });
    const unrelated = rememberText("今天天气晴朗。", {
      content: { text: "今天天气晴朗。", tags: ["weather"] },
    });

    const plan = planMaintenance(dbPath, scope);
    expect(plan.summary.exact_duplicate_records).toBe(1);
    expect(plan.semantic_review_groups).toHaveLength(1);
    const group = plan.semantic_review_groups[0];
    expect(group?.kind).toBe("semantic");
    expect(group?.memory_ids).toEqual([first.memory_id, related.memory_id]);
    expect(group?.memory_ids).not.toContain(duplicate.memory_id);
    expect(group?.memory_ids).not.toContain(unrelated.memory_id);
    expect(group?.signals).toContain("shared_tag");
    expect(group?.shared_tags).toContain("memory");
    expect(
      group?.candidates.find((memory) => memory.memory_id === first.memory_id)
        ?.summary,
    ).toBeNull();
  });

  it("defaults to dry-run and suppresses only revalidated exact duplicates when applied", async () => {
    const canonical = rememberWithKind("保留这条 canonical 记忆", "semantic");
    await delay(5);
    const duplicate = rememberWithKind(" 保留这条   canonical 记忆 ", "semantic");
    const unrelated = rememberWithKind("另一条独立记忆", "semantic");
    const plan = planMaintenance(dbPath, scope);

    const dryRun = applyExactDuplicatePlan(store, plan);
    expect(dryRun).toMatchObject({
      dry_run: true,
      actions: [
        {
          memory_id: duplicate.memory_id,
          canonical_memory_id: canonical.memory_id,
          outcome: "would_suppress",
        },
      ],
      skipped: [],
    });
    expect(store.get(scope, duplicate.memory_id)?.status).toBe("active");

    const applied = applyExactDuplicatePlan(store, plan, { dryRun: false });
    expect(applied.dry_run).toBe(false);
    expect(applied.actions).toEqual([
      {
        memory_id: duplicate.memory_id,
        canonical_memory_id: canonical.memory_id,
        outcome: "suppressed",
      },
    ]);
    expect(store.get(scope, canonical.memory_id)?.status).toBe("active");
    expect(store.get(scope, duplicate.memory_id)?.status).toBe("suppressed");
    expect(store.get(scope, unrelated.memory_id)?.status).toBe("active");

    const repeated = applyExactDuplicatePlan(store, plan, { dryRun: false });
    expect(repeated.actions).toEqual([]);
    expect(repeated.skipped[0]?.reason).toMatch(/no longer active/i);
  });

  it("skips stale and cross-kind candidates instead of mutating unconfirmed records", async () => {
    const canonical = rememberWithKind("同文记忆", "semantic");
    await delay(5);
    const stale = rememberWithKind("同文记忆", "semantic");
    const crossKind = rememberWithKind("同文记忆", "procedural");
    const plan = planMaintenance(dbPath, scope);

    store.correct({
      scope,
      memory_id: stale.memory_id,
      content: { text: "已经修正的不同内容" },
      reason: "stale-plan test",
      source_type: "conversation",
      source_label: "maintenance-correction",
      source_confidence: 0.95,
      factual_confidence: 0.95,
    });

    const applied = applyExactDuplicatePlan(store, plan, { dryRun: false });
    expect(applied.actions).toEqual([]);
    expect(applied.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memory_id: stale.memory_id,
          reason: expect.stringMatching(/normalized text changed/i),
        }),
        expect.objectContaining({
          memory_id: crossKind.memory_id,
          reason: expect.stringMatching(/cross-kind/i),
        }),
      ]),
    );
    expect(store.get(scope, canonical.memory_id)?.status).toBe("active");
    expect(store.get(scope, stale.memory_id)?.status).toBe("active");
    expect(store.get(scope, crossKind.memory_id)?.status).toBe("active");
  });

  it("runs idle maintenance once with a snapshot and only suppresses exact duplicates", async () => {
    const canonical = rememberWithKind("idle maintenance canonical", "semantic");
    await delay(5);
    const duplicate = rememberWithKind("idle maintenance canonical", "semantic");
    const related = rememberText(
      "idle maintenance canonical needs a semantic review",
      {
        content: {
          text: "idle maintenance canonical needs a semantic review",
          tags: ["idle-maintenance"],
        },
      },
    );
    rememberText("idle maintenance canonical", {
      content: {
        text: "idle maintenance canonical",
        tags: ["idle-maintenance"],
      },
    });

    const result = runMaintenance(store, dbPath, {
      reason: "test idle maintenance",
      snapshotPrefix: "test-maintenance",
      reportDirectory: join(directory, "maintenance-report"),
    });

    expect(result.scopes_scanned).toBe(1);
    expect(result.exact_duplicate_groups).toBe(1);
    expect(result.exact_duplicates_suppressed).toBe(2);
    expect(result.semantic_review_groups).toBeGreaterThanOrEqual(1);
    expect(result.snapshot).not.toBeNull();
    expect(result.report_path).not.toBeNull();
    expect(existsSync(result.report_path as string)).toBe(true);
    const report = JSON.parse(
      readFileSync(result.report_path as string, "utf8"),
    ) as { semantic_review_groups: number; scopes: unknown[] };
    expect(report.semantic_review_groups).toBe(result.semantic_review_groups);
    expect(report.scopes).toHaveLength(1);
    expect(store.get(scope, canonical.memory_id)?.status).toBe("active");
    expect(store.get(scope, duplicate.memory_id)?.status).toBe("suppressed");
    expect(store.get(scope, related.memory_id)?.status).toBe("active");
  });
});
