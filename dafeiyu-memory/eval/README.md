# 大肥鱼记忆 MCP 评估

本目录使用固定合成数据评估模型能否正确调用记忆 MCP 工具。题目只读、相互独立、不修改状态，并针对固定历史时间点设计，不依赖“今天”或运行顺序。

## 文件

- `seed-plan.md`：精确的种子记录、固定时间戳、来源、置信度、冲突、纠正、抑制和删除步骤。
- `evaluation.xml`：10 道只读问答题，答案均可直接字符串比较。

## 准备隔离环境

评估必须使用一次性数据库，不要指向个人长期记忆库。

```powershell
New-Item -ItemType Directory -Force 'D:/deepseek/data/dafeiyu-memory' | Out-Null
$env:DAFEIYU_MEMORY_DB = 'D:/deepseek/data/dafeiyu-memory/eval.sqlite3'
Set-Location 'D:/deepseek/plugins/dafeiyu-memory'
npm run build
```

如果同名评估库已存在，应在开始新一轮前换一个新文件名，例如 `eval-2025-11-06.sqlite3`，避免重复种子、版本数和统计值。评估题目本身不包含删除或重置操作。

## 通过 MCP Inspector 评估

1. 用同一环境变量启动 Inspector：

   ```powershell
   npx -y @modelcontextprotocol/inspector node ./dist/index.js
   ```

2. 严格按 `seed-plan.md` 执行全部 `remember`、`correct`、`forget` 和一次 `delete`。记录每次写入返回的 `memory_id`，用于后续纠正、抑制和删除。
3. 确认 `stats` 与种子计划末尾的预期状态一致。
4. 逐题把 `evaluation.xml` 的 `question` 交给一个只能使用本 MCP 服务的模型或评估器。不要附加 `seed-plan.md` 的内容。
5. 将模型回答与 `<answer>` 做精确比较。题目要求单个字符串时，不接受解释、列表或多答案。

建议用 MCP Inspector 先人工跑前两题，确认题目的词汇能触发至少两次 `recall` 或 `recall` + `get`，再批量运行全部题目。

## 通过 DSH 评估

1. 用 `dafeiyu-memory.cordis.yml` 启动 DSH，并把 `DAFEIYU_MEMORY_DB` 指向同一个隔离评估库。
2. 在 DSH 中通过 `mcp__dafeiyu_memory__*` 工具完成种子步骤。每完成阶段都可以用 `stats` 检查状态。
3. 种子完成后新开一个 DSH 会话，不粘贴种子对话，也不把种子表加入上下文。
4. 在会话指令中只允许使用记忆工具回答题目，禁止读取本目录中的答案文件。
5. 可逐题新开会话，或在一个会话中按题号隔离上下文；不要把上一题的答案传递给下一题。

DSH 通用 MCP 接入方式见 [MCP 客户端配置](<D:/deepseek/packages/mcp/mcp-client/README.zh.md>) 和 [第三方记忆 MCP 示例](<D:/deepseek/examples/mcp-memory/README.zh.md>)。

## 评估约束

- 每题独立，不依赖其他题的调用或答案。
- 评估题目不含 `remember`、`correct`、`forget`、`delete`。
- `recall` 会写入 `recall_episodes` 和审计记录，并更新访问计数与激活强度，但不得修改正文、版本、状态、有效期或来源；所有题目答案只能依赖这些稳定事实。
- 因此这里的“只读”是指不修改记忆事实，不是对 SQLite 文件零写入。严格的字节级幂等评估不适用于当前 `recall` 实现；`get` 和 `stats` 是严格只读工具。
- `delete` 只发生在正式评估前的种子阶段。
- 不按 `created_at`、访问次数或“当前日期”推导答案。所有可判定时间均来自固定 `occurred_at`、`valid_from` 和 `valid_to`。
- 允许调用 `recall`、`get`、`stats` 多次；最终只输出题目要求的单值。

## 手工判定建议

若输出格式不完全符合要求，可先规范化空白，再按大小写精确比较英文值；中文名称不做同义映射。出现额外解释时视为不通过，因为这会掩盖模型对自己得到的值是否有把握。
