# 大肥鱼记忆内核与推理边界

## 定位

本文是大肥鱼记忆插件当前实现的职责边界参考，用于判断一项能力应进入持久化内核、MCP 适配层，还是 DSH 侧推理策略。

“MemoryKernel”在本文中是职责名称，不是现有类名或待创建接口。当前代码用 [MemoryStore](../src/types.ts)、[createMemoryStore](../src/store.ts) 和进程入口承担这组职责。

## 结论

- **内核保存确定事实**：事务、版本、所有权、状态、快照、锁、唯一性约束、关联、审计和删除验证必须由内核执行，并且在相同存储状态和评估时间下得到可复现的结果。
- **推理适配器作出语义判断**：是否值得记、记成什么、摘要写什么、冲突意味着什么、何时整理以及如何向用户解释，属于 DSH 侧模型与策略。
- **MCP 是协议适配层**：它把内核操作暴露成稳定工具，不拥有记忆语义，也不应在进程内调用模型。
- **`dafeiyu-memory-dsh` 是安装适配层**：它只把现有 MCP server 接入 DSH，不是推理适配器。
- **当前不新增 MemoryKernel 类**：现有 `MemoryStore` 已足够表达内核操作。只有出现第二个真实消费者或职责确实独立变化时，才值得拆接口。

## 当前分层

| 层 | 当前位置 | 拥有的职责 | 不负责 |
|---|---|---|---|
| 持久化内核 | [store.ts](../src/store.ts)、[schema.ts](../src/schema.ts)、[retrieval.ts](../src/retrieval.ts) | SQLite 状态、事务、版本、范围过滤、确定性召回、状态迁移、证据轨迹、删除与墓碑 | 判断一段话是否值得记、生成语义摘要、解释冲突、决定何时整理 |
| 进程生命周期 | [db-lock.ts](../src/db-lock.ts)、[index.ts](../src/index.ts) | 单写进程锁、数据库启动、服务关闭、异常退出清理 | MCP 工具语义、模型策略、DSH 安装 |
| MCP 协议适配 | [server.ts](../src/server.ts) | 七个工具的名称、输入输出 schema、参数转换、错误包装、Markdown/JSON 呈现 | 重新定义存储规则、直接修改数据库、调用模型做判断 |
| 安装适配 | [dafeiyu-memory-dsh](../../dafeiyu-memory-dsh/README.md) | DSH bundle patch、包相对路径解析、以 stdio 启动 MCP server | 记忆抽取、摘要、冲突解释、后台整理 |
| 推理策略 | 当前由模型与 [dafeiyu-memory.AGENTS.md](../dafeiyu-memory.AGENTS.md) 承担 | 选择工具、选择记忆内容与类型、组织摘要、解释证据、决定是否提案整理 | 绕过内核直接写 SQLite，或依赖不存在的隐式自动写入 |

## MemoryKernel 的职责

### 所有权与范围

每条记录由 `tenant_id`、`user_id`、`agent_id`、`persona_id`、`space_id` 五个字段共同归属。`get`、`recall`、`correct`、`forget`、`delete`、`stats` 都要求精确匹配这五个字段；跨范围的 id 不得被读取或修改。

范围是数据分区，不是身份认证。鉴权、令牌和用户身份验证属于外层服务，不应由当前 SQLite 查询冒充安全边界。

### 事务与账本

一次写入及其事件、来源、版本、关联和审计必须同成同败。[store.ts](../src/store.ts) 中的 `BEGIN IMMEDIATE`、提交、回滚和删除后验证是实现约束，不是可下沉到推理层的建议。

内核负责维护：

- `events`：发生了什么；
- `provenance_records`：内容来自哪里；
- `memory_versions`：每个不可变内容版本；
- `memory_links`：记录之间的显式关系；
- `recall_episodes`：召回查询和结果轨迹；
- `audit_log`：操作审计；
- `tombstones` 与 `deletion_requests`：不保留正文的删除证明。

### 版本与记录级快照

`remember` 创建版本 1；`correct` 创建版本 N+1，通过 `supersedes_version_id` 指向旧版本，并移动 `current_version_id`。旧内容在硬删除前保持不变，因此可以追溯“何时改了什么”。

记录版本与数据库快照是两种不同机制。`memory_versions` 保存单条记忆的不可变版本，不能替代灾难恢复；[snapshots.ts](../src/snapshots.ts) 则通过 `VACUUM INTO` 创建完整 SQLite 一致性快照，写入 manifest、SHA-256 和 schema 版本，并由 `MemoryStore.snapshot()` 集成到进程生命周期。启动时、硬删除前和闲时自动去重前都会创建数据库快照。

### 状态与可见性

内核拥有状态机：

- `active`：默认参与召回；
- `archived`：仍可召回，但激活强度降低；
- `suppressed`：默认召回排除，显式审计召回可包含；
- `quarantined`：默认召回排除，只允许按 id 显式检查；
- `deleted`：内容、版本、关联与来源已删除或脱敏，只保留墓碑。

`forget` 是可逆可见性控制；`delete` 是显式硬脱敏流程。推理适配器可以选择调用哪个操作，但不能自定义跳过状态约束或直接改写状态列。

### 单写进程与锁

[db-lock.ts](../src/db-lock.ts) 在数据库旁创建 `<database>.lock`，记录 PID、随机 token、数据库路径和获取时间。所有者仍存活时，第二个进程必须启动失败；所有者已退出时，下一次启动可以回收陈旧锁。锁的获取、持有和释放在 [index.ts](../src/index.ts) 的整个数据库生命周期内完成。

桌面和 Web 若共享同一个 SQLite 文件，仍必须共享这个锁文件；实际部署应使用同一个启动路径，或为两个 profile 配置不同数据库。推理层不得自行打开数据库绕过锁。

### 确定性召回

[retrieval.ts](../src/retrieval.ts) 是无 I/O 的评分模块。内核负责：

- 按五字段范围、有效期和状态过滤候选；
- 组合词法、时效、显著度、激活、身份相关性和当前目标分数；
- 纳入显式的冲突邻居；
- 返回来源置信度、事实置信度、评分分量和冲突 id；
- 记录本次召回对访问次数、激活强度和 `recall_episodes` 的影响。

`recall` 不是纯读操作，它会更新访问状态并写入召回轨迹。调用方必须把这一点视为内核语义。

### 硬删除

`delete` 在一个事务内清理版本、关联和来源记录，脱敏事件载荷，写入删除请求与墓碑，并在提交前验证正文、版本和关联确实不可读。返回 `verified: true` 只表示内核可访问范围内验证通过，不代表文件系统快照、备份或外部日志已被清除。

## DSH reasoning adapter 的职责

### 选择记什么

适配器决定一条信息是否持久、属于哪种 `kind`、是否只是临时上下文、是否含敏感凭据，以及是否需要用户明确确认。调用边界只校验必填字段、长度、时间格式和 `0..1` 范围，不判断一句话是否“值得记住”。

### 语义总结

适配器可以生成 `summary`、`tags`、`entities`、`epistemic_type`、两组置信度、显著度、身份相关性和有效期。内核原样保存这些调用方判断，不调用模型补全。

当 `summary` 缺失时，召回使用文本截断作为展示回退。这是确定性文本处理，不是语义摘要；真正的摘要仍属于适配器。

### 冲突解释与来源判断

内核返回冲突 id、冲突对、来源类型、来源标签、时间和两组置信度；适配器解释这些证据对当前问题意味着什么，是否可以静默采用，是否需要询问用户，以及如何呈现多个视角。

不要把“哪个来源更可信”“这句话是否真的互相矛盾”“用户希望听哪种解释”等判断写进 SQLite 查询或固定状态迁移。

### 闲时整理

整理包括合并重复、归档陈旧记忆、纠正摘要、提出新关联或发现待确认冲突。内核只负责确定性的重复识别、状态迁移、快照和审计；语义摘要、优先级和合并建议属于适配器。

[maintenance.ts](../src/maintenance.ts) 在完整 scope 内按规范化正文找出完全相同的 active 记忆，保留最早 canonical，并默认只自动 `suppress` 其余 exact duplicate。跨 kind、正文已变化或只是语义相近的记录只进入 `semantic_review_groups`，由 DSH 阅读维护报告后决定是否生成 `remember`、`correct`、`forget` 提案。整理执行仍通过现有写操作，携带来源和 reason，并留下审计。

[idle-maintenance.ts](../src/idle-maintenance.ts) 只在工具活动静默达到阈值后运行；定时器被 `unref`，不会单独维持进程存活。自动动作只限 exact duplicate，语义候选永远不会被自动应用。

### 模型可见策略与 DSH 接线

当前 DSH 不桥接 MCP initialize instructions，因此“何时 recall、何时 remember、何时 forget”由模型与用户级 `AGENTS.md` 托管块约束；工具描述补充局部用法。未来若增加 DSH 原生 prompt section，它属于 DSH 推理适配层，不属于 SQLite 内核。

## 当前代码已经满足

- 记忆写入、来源账本、版本、记录指针和审计在一个事务内完成。
- `correct` 保留旧版本并通过 `supersedes_version_id` 形成版本链。
- 五字段范围在全部读写操作中精确匹配，已有跨范围隔离测试。
- `active`、`archived`、`suppressed`、`quarantined`、`deleted` 的可见性规则已经实现。
- `delete` 在事务内清理并验证版本、关联、来源和事件脱敏，留下无正文墓碑。
- 进程入口持有数据库级单写锁，重复进程会明确失败，陈旧锁可回收。
- 词法召回评分独立在 [retrieval.ts](../src/retrieval.ts)，没有模型、网络或向量服务依赖。
- 数据库级一致性快照使用 `VACUUM INTO`，带 SHA-256 manifest，并接入启动、删除前和维护前三个恢复点。
- 闲时维护只自动抑制复核过的 exact duplicate；语义候选只写报告，不自动合并。
- MCP 层只做 schema、参数转换、结果呈现与错误包装，七个工具覆盖完整操作面。
- DSH 安装包从自身安装位置解析 MCP server，不要求推理层持有源码树路径。
- 当前写入内容、摘要、类型、置信度和冲突目标都由调用方显式提供，内核没有自动抽取或自动总结。

## 仍需改造

1. **移动召回解释的归属。** [store.ts](../src/store.ts) 目前在 `recall` 内生成 `decision` 和固定英文 `explanation`。证据、评分和冲突 id 应留在内核；`decision` 的语义解释与面向模型或用户的冲突说明应由推理适配器生成。若需要保持 MCP 响应兼容，可由 MCP 适配层传递适配器产生的文本，而不是继续把语义解释固化在内核。

2. **把语义整理候选接入 DSH。** 当前报告写入 `<database>.maintenance/latest-maintenance-plan.json`，但还没有 MCP 工具或 DSH prompt surface 自动消费它。后续应让适配器读取报告、生成可追溯提案，再调用既有写操作。

3. **明确摘要策略。** 当前 `summary` 可由调用方提供，缺失时仅截断原文。需要推理适配器决定哪些记忆值得摘要、何时重新摘要，以及摘要更新是否通过 `correct` 形成新版本。

4. **补齐恢复入口。** 快照创建、校验和清理已经存在，但还没有在线恢复命令；恢复必须在进程锁下关闭数据库，验证 manifest/SHA-256 后替换文件，并用独立验收证明失败可回滚。

5. **将 DSH prompt 能力声明为适配层。** 若未来 DSH 提供原生 prompt section，接线仍在 DSH 插件或 MCP 适配层；当前 `AGENTS.md` 策略可以继续保留，避免依赖未桥接的 MCP instructions。

## 后续接口边界

```text
DSH conversation
  -> reasoning policy: model + AGENTS.md, later optionally a native DSH prompt plugin
  -> MCP tools: seven stable operations
  -> MemoryStore: deterministic kernel operations
  -> SQLite + process lock
```

边界约束如下：

- 推理适配器只提交已经作出的记忆判断，不向内核传“帮我决定是否值得记”之类的能力请求。
- 内核只返回记录、状态、版本、证据、评分、冲突、计数和错误，不调用模型、网络、向量服务或后台任务调度器。
- DSH bundle 和 MCP 适配器不直接打开 SQLite；它们通过 core 入口或稳定的 MCP 工具交互。
- 数据库锁由进程入口拥有，覆盖 store 创建到关闭的整个生命周期；适配器不得获取裸数据库句柄绕过锁。
- 整理提案至少包含目标 memory id、建议操作、证据、建议来源和建议 reason。提案不是内核状态；只有执行现有写操作后才产生版本、状态或审计变化。
- 现有 `MemoryStore` 的操作集合就是最小接口。不要为“推理器”“策略引擎”“记忆管道”再建一层通用抽象，除非有第二个真实实现需要替换它。

## 不应下沉到内核

- 判断用户是否明确要求记住，以及是否应拒绝保存敏感信息。
- 选择 `kind`、`epistemic_type`、标签、实体、显著度或身份相关性。
- 生成自然语言摘要和面向用户的冲突解释。
- 决定哪个来源正确，或把多视角冲突静默压成单一事实。
- 闲时扫描、整理优先级、合并建议和触发频率。
- 人格措辞、情绪表达、prompt section 或 DSH 工具使用策略。
- MCP 工具名称与 schema、DSH bundle 安装细节、包路径解析。
- 自动向量化、训练、跨设备同步或网络重试。

## 验收标准

### 内核

1. 任意事务中途失败时，记录、版本、来源、关联和审计都不出现部分提交。
2. 五字段范围任一不同，读取、纠正、遗忘和删除都不能访问原记录。
3. `correct` 后旧版本内容仍可审计，当前指针只指向新版本；`delete` 后版本和关联不可读且墓碑验证通过。
4. 每种状态的默认召回可见性符合本文定义，`include_suppressed` 只影响 `suppressed`。
5. 同一数据库的第二个进程在锁所有者存活时启动失败，原进程退出后锁可回收。
6. 内核模块没有模型、网络或隐式向量调用；排序和状态迁移只由存储状态、输入和评估时间决定。
7. `recall` 的访问更新、召回轨迹和审计与返回结果一致；空结果也有可解释的 `abstain` 事实。

### 推理适配器

1. 每次 `remember` 的语义字段都由适配器显式提供，内核不补写未提供的摘要、类型或冲突关系。
2. 冲突场景下，适配器能从证据、来源和置信度解释不同视角；内核只提供事实和冲突 id。
3. 闲时整理先生成提案，执行时可追溯到目标 id、来源和 reason；取消提案不改变数据库。
4. DSH 没有桥接 MCP instructions 时，模型仍由用户级 `AGENTS.md` 获得 recall、remember、correct、forget、delete 的使用规则。
5. 工具不可用时，适配器明确报告长期记忆不可用，不伪造召回或保存结果。

### 端到端

1. 使用临时 `DAFEIYU_MEMORY_DB` 完成 `remember -> 新会话 recall -> correct -> forget -> delete`，并能通过 `get`、`recall`、`stats` 验证状态。
2. 七个 `mcp__dafeiyu_memory__*` 工具在桌面 DSH 和测试库中都可见，关闭 DSH 后无 MCP 子进程或锁残留。
3. 删除验证后，测试库不保留可读正文；测试结束不污染默认个人记忆库。
4. 原有 `npm test`、`npm run build`、`npm run smoke:stdio`、`npm run smoke:dsh` 继续通过，且不要求修改 `packages/` 或增加未使用的适配抽象。
