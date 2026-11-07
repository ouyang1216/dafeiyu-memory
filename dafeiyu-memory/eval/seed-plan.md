# 固定种子计划

本计划定义评估数据库的精确初始状态。所有记录使用同一范围：

```json
{
  "tenant_id": "eval-tenant",
  "user_id": "eval-user",
  "agent_id": "dafeiyu",
  "persona_id": "dafeiyu-eval",
  "space_id": "memory-eval"
}
```

## 固定规则

- 按 `M01` 到 `M20` 的顺序执行 `remember`。
- `occurred_at`、`valid_from`、`valid_to` 使用表中固定值；不要改成评估当天。
- 表中置信度是小数，不是百分数。
- `M09` 执行一次 `correct`，保留原版本。
- `M10` 执行 `forget`，模式为 `suppress`。
- `M19` 执行一次 `delete`。
- 不要额外写入其他记录。不要调用 `archive` 或 `quarantine`。
- 记住每次 `remember` 返回的 `memory_id`，下文的 `<Mxx_ID>` 必须替换为对应真实值。

各记录共用的显式字段如下；没有列出的可选字段保持省略：

```json
{
  "privacy_level": "private",
  "retention_class": "evaluation"
}
```

## 种子记录

| ID | kind | 正文 | epistemic_type | source_type / source_label | source_confidence | factual_confidence | occurred_at | valid_from / valid_to | tags / entities | salience / identity_relevance |
|---|---|---|---|---|---|---|---:|---:|---|---|---:|
| M01 | semantic | 用户当前的紧急联系人是林舟。 | observed | conversation / `eval://conversation/2025-03-10/emergency` | 0.95 | 0.98 | 2025-03-10T09:15:00+08:00 | 2025-03-10T09:15:00+08:00 / null | `["emergency-contact","current"]` / `["林舟"]` | 0.90 / 0.60 |
| M02 | semantic | 用户过去的紧急联系人是赵谦。 | observed | conversation / `eval://conversation/2024-12-02/old-emergency` | 0.90 | 0.92 | 2024-12-02T18:00:00+08:00 | 2024-12-02T18:00:00+08:00 / 2025-03-09T23:59:59+08:00 | `["emergency-contact","expired"]` / `["赵谦"]` | 0.55 / 0.35 |
| M03 | episodic | 2025 年第二季度规划会在杭州举办，开始日期是 2025-04-18。 | observed | calendar / `eval://calendar/2025-04-18/q2-offsite` | 0.91 | 0.97 | 2025-04-18T10:00:00+08:00 | 2025-04-18T10:00:00+08:00 / null | `["offsite","Q2-2025","planning"]` / `["杭州","Q2 规划会"]` | 0.76 / 0.32 |
| M04 | episodic | 2025-05-12 的预算评审批准了 Project Atlas。 | observed | calendar / `eval://calendar/2025-05-12/atlas-budget` | 0.97 | 0.95 | 2025-05-12T14:30:00+08:00 | 2025-05-12T14:30:00+08:00 / null | `["budget","approval","Atlas"]` / `["Project Atlas","陈颖"]` | 0.72 / 0.28 |
| M05 | social | 陈颖是财务审批负责人。 | reported | conversation / `eval://conversation/2025-01-20/finance-role` | 0.93 | 0.91 | 2025-01-20T11:40:00+08:00 | 2025-01-20T11:40:00+08:00 / null | `["person","role","finance"]` / `["陈颖","财务审批负责人"]` | 0.62 / 0.45 |
| M06 | semantic | 截至 2025-09-30，主用浓缩咖啡豆供应商是北岸烘焙。 | observed | document / `eval://document/2025-01-01/coffee-supplier-a` | 0.94 | 0.92 | 2025-01-01T09:00:00+08:00 | 2025-01-01T09:00:00+08:00 / 2025-09-30T23:59:59+08:00 | `["supplier","coffee","espresso"]` / `["北岸烘焙"]` | 0.48 / 0.18 |
| M07 | semantic | 自 2025-10-01 起，主用浓缩咖啡豆供应商是云岭咖啡。 | reported | email / `eval://email/2025-09-25/coffee-supplier-b` | 0.72 | 0.63 | 2025-09-25T16:20:00+08:00 | 2025-10-01T00:00:00+08:00 / null | `["supplier","coffee","espresso"]` / `["云岭咖啡"]` | 0.51 / 0.18 |
| M08 | prospective | 域名续费必须在 2025-11-20 之前完成。 | observed | document / `eval://document/2025-10-01/domain-renewal` | 0.95 | 0.96 | 2025-10-01T13:10:00+08:00 | 2025-10-01T13:10:00+08:00 / 2025-11-20T23:59:59+08:00 | `["deadline","domain","renewal"]` / `["域名续费"]` | 0.70 / 0.22 |
| M09 | semantic | 当前发布代号是 ORCHID-17。 | observed | conversation / `eval://conversation/2025-06-01/release-codename` | 0.80 | 0.65 | 2025-06-01T15:00:00+08:00 | 2025-06-01T15:00:00+08:00 / null | `["release","codename"]` / `["ORCHID-17"]` | 0.67 / 0.25 |
| M10 | semantic | 用户不吃香菜。 | observed | conversation / `eval://conversation/2025-02-01/food-note` | 0.90 | 0.88 | 2025-02-01T12:05:00+08:00 | 2025-02-01T12:05:00+08:00 / null | `["food","dislike","suppressed"]` / `["香菜"]` | 0.74 / 0.40 |
| M11 | semantic | 用户确认不吃牡蛎。 | observed | conversation / `eval://conversation/2025-02-03/food-confirmation` | 0.96 | 0.94 | 2025-02-03T19:30:00+08:00 | 2025-02-03T19:30:00+08:00 / null | `["food","dislike","confirmed"]` / `["牡蛎"]` | 0.82 / 0.48 |
| M12 | procedural | 构建这个记忆服务使用 `npm run build`。 | observed | document / `eval://document/2024-12-20/build-step` | 0.95 | 0.90 | 2024-12-20T10:10:00+08:00 | 2024-12-20T10:10:00+08:00 / null | `["build","workflow"]` / `["dafeiyu-memory"]` | 0.40 / 0.15 |
| M13 | episodic | 2025 年夏季青岛差旅从 2025-07-03 开始，到 2025-07-06 结束。 | observed | calendar / `eval://calendar/2025-06-15/qingdao-trip` | 0.99 | 0.98 | 2025-06-15T08:00:00+08:00 | 2025-07-03T00:00:00+08:00 / omit | `["travel","Qingdao","summer-travel"]` / `["青岛"]` | 0.78 / 0.30 |
| M14 | semantic | 2025 年青岛差旅对应的会议名称是 Blue Current Forum。 | reported | email / `eval://email/2025-06-20/qingdao-conference-name` | 0.85 | 0.80 | 2025-06-20T17:45:00+08:00 | 2025-06-20T17:45:00+08:00 / null | `["travel","Qingdao","conference"]` / `["青岛","Blue Current Forum"]` | 0.58 / 0.20 |
| M15 | social | 周宁是用户的长期导师。 | reported | conversation / `eval://conversation/2024-11-11/mentor-relation` | 0.92 | 0.90 | 2024-11-11T20:00:00+08:00 | 2024-11-11T20:00:00+08:00 / null | `["person","mentor","relationship"]` / `["周宁"]` | 0.72 / 0.66 |
| M16 | episodic | 周宁在 2025-08-08 推荐了《The Uninhabitable Earth》。 | reported | conversation / `eval://conversation/2025-08-08/book-recommendation` | 0.88 | 0.84 | 2025-08-08T21:10:00+08:00 | 2025-08-08T21:10:00+08:00 / null | `["mentor","book","recommendation"]` / `["周宁","The Uninhabitable Earth"]` | 0.61 / 0.52 |
| M17 | semantic | Orion 看板的主要负责人是沈禾。 | observed | document / `eval://document/2025-01-01/orion-owner-a` | 0.93 | 0.90 | 2025-01-01T10:00:00+08:00 | 2025-01-01T10:00:00+08:00 / null | `["Orion","owner","conflict"]` / `["Orion","沈禾"]` | 0.68 / 0.25 |
| M18 | semantic | Orion 看板的主要负责人是韩石。 | reported | chat / `eval://chat/2025-03-01/orion-owner-b` | 0.89 | 0.70 | 2025-03-01T09:30:00+08:00 | 2025-03-01T09:30:00+08:00 / null | `["Orion","owner","conflict"]` / `["Orion","韩石"]` | 0.60 / 0.25 |
| M19 | episodic | 临时储物柜密码是 7742。 | observed | conversation / `eval://conversation/2025-05-01/temp-locker` | 0.99 | 0.99 | 2025-05-01T08:20:00+08:00 | 2025-05-01T08:20:00+08:00 / 2025-05-02T23:59:59+08:00 | `["temporary","locker-code","deleted"]` / `["储物柜"]` | 0.88 / 0.10 |
| M20 | episodic | 用户参加了 2025-09-09 的 MCP Systems Workshop。 | observed | calendar / `eval://calendar/2025-09-09/mcp-workshop` | 0.97 | 0.95 | 2025-09-09T09:00:00+08:00 | 2025-09-09T09:00:00+08:00 / omit | `["workshop","MCP"]` / `["MCP Systems Workshop"]` | 0.55 / 0.25 |

## 写入模板

每条 `remember` 至少使用以下字段，并填入上表对应值：

```json
{
  "scope": {
    "tenant_id": "eval-tenant",
    "user_id": "eval-user",
    "agent_id": "dafeiyu",
    "persona_id": "dafeiyu-eval",
    "space_id": "memory-eval"
  },
  "kind": "semantic",
  "content": {
    "text": "用户当前的紧急联系人是林舟。",
    "tags": ["emergency-contact", "current"],
    "entities": ["林舟"],
    "metadata": {
      "seed_id": "M01"
    }
  },
  "summary": "当前紧急联系人：林舟",
  "epistemic_type": "observed",
  "source_type": "conversation",
  "source_label": "eval://conversation/2025-03-10/emergency",
  "source_confidence": 0.95,
  "factual_confidence": 0.98,
  "salience": 0.9,
  "identity_relevance": 0.6,
  "valid_from": "2025-03-10T09:15:00+08:00",
  "privacy_level": "private",
  "retention_class": "evaluation",
  "occurred_at": "2025-03-10T09:15:00+08:00",
  "attributes": {
    "seed_id": "M01"
  }
}
```

每条记录的 `summary` 可以不同，但 `content.text`、`attributes.seed_id` 和上表字段必须一致。评估答案只依赖正文与元数据，不依赖自动生成的摘要。上表标为“开放有效期”的记录必须省略 `valid_to`；不要传 `null`，因为当前输入契约使用可选字符串而不是可空字符串。

`M18` 的 `attributes` 还必须包含 `"conflicts_with": "<M17_ID>"`，用来建立与 `M17` 的真实冲突关联。其余记录不添加 `conflicts_with`。

## 纠正、抑制与删除

全部 20 条 `remember` 完成后，依次执行：

1. 纠正 `M09`：

   ```json
   {
     "scope": {
       "tenant_id": "eval-tenant",
       "user_id": "eval-user",
       "agent_id": "dafeiyu",
       "persona_id": "dafeiyu-eval",
       "space_id": "memory-eval"
     },
     "memory_id": "<M09_ID>",
     "content": {
       "text": "当前发布代号是 ORCHID-41。",
       "tags": ["release", "codename", "corrected"],
       "entities": ["ORCHID-41"],
       "metadata": {
         "seed_id": "M09"
       }
     },
     "summary": "当前发布代号：ORCHID-41",
     "reason": "用户指出原记录把 41 听成了 17",
     "source_type": "conversation",
     "source_label": "eval://conversation/2025-06-02/release-codename-correction",
     "source_confidence": 0.99,
     "factual_confidence": 0.99
   }
   ```

2. 抑制 `M10`：

   ```json
   {
     "scope": {
       "tenant_id": "eval-tenant",
       "user_id": "eval-user",
       "agent_id": "dafeiyu",
       "persona_id": "dafeiyu-eval",
       "space_id": "memory-eval"
     },
     "memory_id": "<M10_ID>",
     "mode": "suppress",
     "reason": "用户澄清香菜是误记，确认不吃的是牡蛎"
   }
   ```

3. 删除 `M19`：

   ```json
   {
     "scope": {
       "tenant_id": "eval-tenant",
       "user_id": "eval-user",
       "agent_id": "dafeiyu",
       "persona_id": "dafeiyu-eval",
       "space_id": "memory-eval"
     },
     "memory_id": "<M19_ID>",
     "reason": "临时储物柜已失效，执行明确删除",
     "requested_by": "evaluation-runner"
   }
   ```

删除调用必须返回 `state: "completed"` 和 `verified: true`。如果 `verified` 为 false，停止评估并修复删除路径，不要继续。

## 预期状态

在单一评估范围内，种子阶段完成后应满足：

- `total_memories` 为 20。
- `active_memories` 为 18。
- `suppressed_memories` 为 1。
- `quarantined_memories` 为 0。
- `deleted_memories` 为 1。
- `total_versions` 为 20：20 条初始版本，加上 `M09` 纠正产生的一个新版本，再减去 `M19` 删除时清掉的初始版本。
- `total_links` 为 1：`M18` 指向 `M17` 的 contradicts 关联。`M09` 的纠正通过版本行的 `supersedes_version_id` 表达，不额外创建 `memory_links` 行。

评估题只使用状态字段，不使用版本或关联总数；这两个计数用于种子完成后的健全性检查。

## 稳定性说明

- 评估器不得读取本文件。它只应看到 `evaluation.xml` 和 MCP 工具。
- 所有答案都来自种子正文、固定有效期或状态字段。
- `M02` 是过期记录，`M06` 与 `M07` 是按时间接续的供应商记录，`M17` 与 `M18` 才是同时间段的真实冲突。
- `recall` 按评估运行时的当前时间过滤有效期；因此供应商题使用 2026-12-31 检查当前有效的 `M07`，不要求召回已经过期的 `M06`。
- `M10` 必须保持 suppressed，`M19` 必须不可召回。
- 评估期间不得修改系统时间。即使修改系统时间，题目答案也只依赖种子中的固定历史字段。
