<!-- BEGIN DAFEIYU-MEMORY MANAGED BLOCK -->
仅当当前会话中 `mcp__dafeiyu_memory__remember`、`mcp__dafeiyu_memory__recall` 等记忆工具可用时，执行以下规则；工具不可用时应直接说明无法访问长期记忆，不得假装已读取或已保存。

1. 当用户询问历史、长期偏好、此前决定、项目历史，或当前上下文缺少已确认事实时，先调用 `mcp__dafeiyu_memory__recall`，再基于返回的证据回答。
2. 仅当用户明确要求“记住”、保存长期偏好、事实或决定时，调用 `mcp__dafeiyu_memory__remember`。不要持久化临时状态、猜测、密钥、口令、Token、Cookie 或其他敏感凭据。
3. 当用户纠正已存记忆，或新证据明确推翻旧内容时，先用 `mcp__dafeiyu_memory__recall` 或 `mcp__dafeiyu_memory__get` 找到准确的 memory id，再调用 `mcp__dafeiyu_memory__correct` 形成新版本；不要用 remember 静默复制成一条无关记录。
4. 当用户表示“别再提”、要求隐藏、降低权重或不再主动使用某条记忆时，调用 `mcp__dafeiyu_memory__forget`，按语义选择 suppress、archive 或 quarantine；不要误用 delete。
5. 只有当用户明确要求彻底删除、清除或不可恢复地抹除某条记忆时，才调用 `mcp__dafeiyu_memory__delete`。用户只是不想被提及、忘记偏好或撤回使用时，使用 forget。
6. recall 返回冲突或多视角证据时，要同时说明冲突内容、各自来源与置信度；不得静默选择一个版本。证据不足、召回为空或范围不匹配时，明确说“证据不足”，再给出基于当前上下文的有限判断。
7. 发送类记忆必须遵守“先确认、后记忆”：只有通道或适配器返回明确的成功投递确认（ack）后，才可调用 `remember` 或 `correct` 记录“我说过”“已发送”等已发生事件；发送失败、被拦截、超时或结果不确定时，不得写成既成事实。
8. DSH 工具结果只能证明对应工具实际执行及其返回值。计划、意图、草稿、预期回复或尚未执行的工具调用不是既成事实，不得记录为已发送、已完成或已写入。
9. 当前 DSH 无法观察外部投递 ack 时，只能记录用户输入、已返回工具结果等直接观察事实；不得声称回复已发出，也不得把模型输出写成对外发送成功。
10. 闲时维护报告中的语义候选只是待审提案，不是已执行整理。需要合并、改摘要或归档时，先 recall/get 核对目标，再通过 correct、forget 或其他显式写操作执行；不得把报告当成事实来源。
<!-- END DAFEIYU-MEMORY MANAGED BLOCK -->
