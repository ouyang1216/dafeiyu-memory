# 大肥鱼记忆 MCP 服务

面向 DSH（DeepSeek Harness）大肥鱼人格的本地优先、类人长期记忆服务。

当前版本通过 stdio MCP 提供 `remember`、`recall`、`get`、`correct`、`forget`、`delete`、`stats` 七个工具。DSH 只负责调用 MCP，不需要修改 `D:/deepseek/packages` 或 DSH 核心源码。

```text
大肥鱼 DSH 会话
  -> @deepseek-ai/dsh-mcp-client
  -> stdio MCP
  -> dafeiyu-memory-mcp-server
  -> 本地 SQLite
```

模型侧工具名是：

```text
mcp__dafeiyu_memory__remember
mcp__dafeiyu_memory__recall
mcp__dafeiyu_memory__get
mcp__dafeiyu_memory__correct
mcp__dafeiyu_memory__forget
mcp__dafeiyu_memory__delete
mcp__dafeiyu_memory__stats
```

## 已验证状态

截至 2026-11-07，以下路径已经真实验证：

- `npm test`：6 个测试文件、28 项测试通过。
- `npm run build`：通过。
- `npm run smoke:stdio`：通过；真实 stdio 验证七个工具和 `remember`、`recall`、`delete`、`get`。
- `npm run smoke:dsh`：通过；随机临时数据库、随机 loopback 端口、HTTP `200`、MCP 子进程和清理均已验证。
- DSH `--dump-config`：正式 overlay 能被解析。
- `dafeiyu-memory-dsh@0.2.1`：tarball 能通过 `dsh plugin --profile desktop add ...` 安装，并已接入官方桌面 DSH。
- 桌面真实闭环：七个 `mcp__dafeiyu_memory__*` 工具完成 `remember -> 新会话 recall -> correct -> forget -> delete`；使用临时 SQLite，不共享个人记忆库。
- 大肥鱼专用启动器：真实启动 DSH Web 并返回 HTTP `200`，DSH 父进程和记忆 MCP 子进程存在；`Ctrl+C` 后正常退出且无残留。

## 当前范围

服务负责：

- 在本地保存用户明确要求记住的信息。
- 按范围、类型、时间、来源、置信度和冲突关系召回记忆。
- 保存不可变版本，支持纠正、抑制、归档、隔离和可验证删除。
- 通过 SQLite 持久化事件、来源账本、版本、召回轨迹和墓碑。
- 启动、删除前和闲时整理前创建带 SHA-256 清单的 SQLite 一致性快照。
- 空闲时自动抑制规范化正文完全相同的重复 active 记忆，并生成语义整理候选报告。
- 通过 stdio MCP 暴露七个工具，不自行监听 HTTP 端口。

当前 MVP 不负责：

- 自动从全部对话中抽取记忆。是否写入由用户要求、模型指令或调用方决定。
- 替代 DSH 的会话日志、上下文压缩、人格提示词或系统权限策略。
- 多用户鉴权、云端同步、Web 管理界面或公网 API。
- 训练模型。记忆数据不会被本服务用于训练。
- 完整的“情绪、性格、记忆”认知模型。MVP 只保留 `salience`、`identity_relevance`、标签和 `attributes` 等扩展字段。

## 正式安装

核心包仍是可直接运行的 stdio MCP server。可安装的 DSH 入口在独立组合包 `D:\deepseek\plugins\dafeiyu-memory-dsh`：

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory-dsh'
npm run bundle:pack
dsh plugin --profile desktop add ./releases/dafeiyu-memory-dsh-0.2.1.tgz
```

生成的 tarball 自带核心包及生产依赖。bundle patch 从自身安装目录解析 `dafeiyu-memory-mcp-server`，不依赖 `D:/deepseek` 写死路径。官方桌面 profile 由应用独占，必须在 DSH 完全退出后执行上述命令；安装后重新启动。

## 大肥鱼专用启动

首次使用先构建记忆服务：

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory'
npm install
npm run build
```

之后可以选择以下任一方式启动：

1. 双击：

   ```text
   D:\deepseek\start-dafeiyu-memory.bat
   ```

2. 直接在 PowerShell 前台运行：

   ```powershell
   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\deepseek\plugins\dafeiyu-memory\scripts\start-dafeiyu-memory.ps1"
   ```

   插件内脚本路径是 `scripts/start-dafeiyu-memory.ps1`。

默认访问地址：

```text
http://127.0.0.1:31789/
```

### 启动器实际行为

启动器会在拉起 DSH 前检查：

- `D:/deepseek/apps/cli/lib/bin.js` 存在。
- `D:/deepseek/plugins/dafeiyu-memory/dafeiyu-memory.cordis.yml` 存在。
- `D:/deepseek/plugins/dafeiyu-memory/dist/index.js` 存在、非空，并通过 `node --check`。
- Node.js 版本至少为 `22.19`。项目 `package.json` 声明的支持范围是 `^22.19.0 || >=24.0.0`。
- 默认安装并校验 `$DSH_HOME/AGENTS.md` 中的记忆使用指令块。
- 使用正式 overlay 执行一次 DSH `--dump-config`，配置错误时立即退出。
- 数据库父目录可以创建。
- DSH Web 端口在 `127.0.0.1` 上可用。

任何预检失败都会打印 `[ERROR]` 并以非零状态退出。正式 overlay 使用 `failOnStartupError: true`；记忆 MCP 无法启动、路径错误、数据库不可写或工具同步失败时，不会静默运行一个没有记忆工具的 DSH。

### 数据库配置

默认数据库：

```text
%USERPROFILE%\.dafeiyu-memory\memory.sqlite3
```

当前用户的默认路径是：

```text
%USERPROFILE%\.dafeiyu-memory\memory.sqlite3
```

默认位置在 DSH 和插件源码树之外。可以使用 `DAFEIYU_MEMORY_DB` 覆盖：

```powershell
$env:DAFEIYU_MEMORY_DB = 'D:\dafeiyu-data\memory.sqlite3'
```

专用启动器要求该路径最终是绝对路径。相对路径会直接报错；父目录不存在时会自动创建。不要把数据库放在 Git、OneDrive 或编辑器会频繁原子替换的目录中。

服务在数据库旁创建 `memory.sqlite3.lock`，用 PID 和随机 token 保证同一个 SQLite 文件只有一个活跃写进程。桌面和 Web 同时运行时必须使用不同数据库，或先停掉其中一个；死进程遗留的锁会在下一次启动时自动回收。

### 快照与闲时整理

默认快照目录是 `<database>.snapshots`：

```text
C:\Users\<user>\.dafeiyu-memory\memory.sqlite3.snapshots
```

可用环境变量调整：

- `DAFEIYU_MEMORY_SNAPSHOT_DIR`：快照目录。
- `DAFEIYU_MEMORY_SNAPSHOT_RETAIN`：保留快照数量，默认 `10`。
- `DAFEIYU_MEMORY_MAINTENANCE_IDLE_MS`：无工具活动多久后整理，默认 `1800000`。
- `DAFEIYU_MEMORY_MAINTENANCE_CHECK_MS`：空闲检查周期，默认 `60000`。
- `DAFEIYU_MEMORY_MAINTENANCE_DISABLED=1`：关闭自动闲时整理。

快照使用 `VACUUM INTO`，不会用普通文件复制假装一致备份；每个快照带 manifest、SQLite 版本、schema 版本、大小和 SHA-256。启动时、硬删除前、闲时自动去重前都会创建快照，超过保留数的旧快照会被清理。

闲时整理只自动执行确定性安全动作：正文经过 NFKC、大小写和空白规范化后完全相同、同 kind 且仍为 active 的重复记忆，会保留最早一条并对其余执行 `forget(suppress)`。执行前重新读取并复核；跨 kind、内容变化或语义相近但不同的记录只写入 `latest-maintenance-plan.json` 供 DSH 推理，不会自动合并。

维护报告默认位置：

```text
C:\Users\<user>\.dafeiyu-memory\memory.sqlite3.maintenance\latest-maintenance-plan.json
```

### 端口与监听地址

DSH Web 端口通过 `DAFEIYU_DSH_PORT` 配置，默认 `31789`：

```powershell
$env:DAFEIYU_DSH_PORT = '31790'
```

有效范围是 `1..65535`。端口已被占用时启动器会明确报错。

监听地址固定为 `127.0.0.1`：

- 启动器始终向 DSH 传 `--host 127.0.0.1`。
- 没有设置 `0.0.0.0` 或其他外部监听地址的入口。
- 记忆 MCP 本身使用 stdio，不监听 TCP 端口；`DAFEIYU_DSH_PORT` 只控制 DSH Web。

### AGENTS 应急跳过

正常启动会自动安装并校验记忆使用说明。仅在临时排障时可以使用：

```powershell
$env:DAFEIYU_MEMORY_SKIP_AGENTS_INSTALL = '1'
```

此时安装和 `-Check` 都会被跳过，启动器会打印明确警告。跳过不会改变 MCP 工具是否加载，但模型可能不知道何时应该调用记忆工具，因此不应作为日常启动方式。

### 退出方式

启动器在前台运行 DSH，不是后台服务，也没有隐藏的守护进程。

- PowerShell 中按 `Ctrl+C`。
- 通过 `.bat` 启动时，`cmd.exe` 可能询问 `Terminate batch job (Y/N)?`，输入 `Y`。

正常中断后，DSH 和记忆 MCP 子进程应一起退出。可以通过端口和进程命令复查，不应留下监听 `127.0.0.1:<port>` 的 DSH 或 `dist/index.js` 记忆进程。

## 开发、构建与基础验证

在插件目录执行：

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory'
npm install
npm run build
npm test
npm run smoke:stdio
```

常用命令：

```powershell
npm run dev       # 直接从 TypeScript 启动
npm start         # 运行已构建的 dist/index.js
npm run build     # TypeScript 编译到 dist/
npm test          # 隔离测试，当前为 6 个测试文件、28 项测试
npm run smoke:stdio
npm run smoke:dsh
```

`npm test` 使用项目内的 `vitest.config.ts`，只加载本目录的 `tests/**/*.test.ts`。测试使用系统临时目录中的一次性 SQLite 数据库，不写入个人记忆库。

`npm run smoke:stdio` 会启动真实的 stdio MCP，验证七个工具，并执行 `remember`、`recall`、`delete`、`get`。它不会监听 HTTP 端口。

直接在终端运行 `node dist/index.js` 时，服务会等待 MCP 协议消息；人工调试应使用 MCP Inspector 或 smoke 脚本。

## DSH overlay

正式 overlay：

```text
D:\deepseek\plugins\dafeiyu-memory\dafeiyu-memory.cordis.yml
```

当前关键配置等价于：

```yaml
- insert:
    - id: memory-dafeiyu
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dafeiyu_memory
        transport: stdio
        command: !!js process.execPath
        args:
          - !!js process.env.DAFEIYU_MEMORY_SERVER_ENTRY?.trim() || (() => { throw ... })()
        env:
          ELECTRON_RUN_AS_NODE: '1'
          DAFEIYU_MEMORY_DB: !!js >-
            process.env.DAFEIYU_MEMORY_DB?.trim() ||
            process.getBuiltinModule('node:path').join(
              process.getBuiltinModule('node:os').homedir(),
              '.dafeiyu-memory',
              'memory.sqlite3'
            )
        toolCallTimeoutMs: 60000
        failOnStartupError: true
```

`serverName: dafeiyu_memory` 决定模型侧工具前缀。`failOnStartupError: true` 让启动错误直接暴露。

正式安装优先使用 `dafeiyu-memory-dsh` bundle。这个源码 overlay 只用于仓库内 Web smoke，并由启动器或 `smoke:dsh` 设置 `DAFEIYU_MEMORY_SERVER_ENTRY`。

### 真实 dump-config 检查

从 DSH 仓库根目录执行：

```powershell
Set-Location 'D:/deepseek'
node apps/cli/lib/bin.js --profile web --patch D:/deepseek/plugins/dafeiyu-memory/dafeiyu-memory.cordis.yml --dump-config
```

当前展开配置已包含以下证据：

- `id: memory-dafeiyu`
- `name: '@deepseek-ai/dsh-mcp-client'`
- `serverName: dafeiyu_memory`
- `DAFEIYU_MEMORY_DB` 的 JavaScript 默认表达式
- `failOnStartupError: true`

需要只看关键行时可以执行：

```powershell
node apps/cli/lib/bin.js --profile web --patch D:/deepseek/plugins/dafeiyu-memory/dafeiyu-memory.cordis.yml --dump-config |
  Select-String -Pattern 'memory-dafeiyu|dsh-mcp-client|serverName|DAFEIYU_MEMORY_DB|failOnStartupError' -Context 0,2
```

Overlay 保持只配置 MCP 客户端和工具。模型使用记忆的时机不由 overlay 注入。

## DSH integration smoke

在插件目录运行：

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory'
npm run smoke:dsh
```

这个 smoke 当前是 Windows 专用，依赖已构建的：

- `D:/deepseek/apps/cli/lib/bin.js`
- `D:/deepseek/apps/web/dist`
- `D:/deepseek/plugins/dafeiyu-memory/dist/index.js`

每次执行会：

1. 创建随机临时目录和随机临时 SQLite 数据库。
2. 使用正式 overlay 运行 DSH `--dump-config`，校验 `memory-dafeiyu` 加载了 `@deepseek-ai/dsh-mcp-client`。
3. 探测一个空闲的 `127.0.0.1` 随机端口。
4. 写入临时 shutdown-control overlay 和对应控制插件，通过公开的 `ctx.appExit` 请求优雅退出。
5. 以随机临时数据库启动 DSH Web。
6. 验证 HTTP `200`、`dsh web: http://127.0.0.1:<port>` 启动日志和真实记忆 MCP 子进程。
7. 校验 MCP 日志和数据库文件都指向本次临时路径。
8. 触发优雅关闭，验证 DSH 退出码 `0`、MCP 子进程退出、端口释放。
9. 成功或失败都按已记录的 PID、命令行和创建时间清理自己的进程树，并删除本次随机临时目录。

脚本记录进程身份后才做定向清理，不会执行全机范围的 `kill node`。它继承当前 `DSH_HOME` 和 web profile；记忆数据库和控制文件是本轮临时资源，DSH 自身仍可能更新自己的 profile/session 元数据。

最新一次真实样例（端口、PID 和临时目录每次都会变化）：

```text
[dsh-smoke] plugin=D:\deepseek\plugins\dafeiyu-memory
[dsh-smoke] temp=C:\Users\<user>\AppData\Local\Temp\dafeiyu-dsh-smoke-FuMPoG
[dsh-smoke] checking overlay with DSH --dump-config...
[dsh-smoke] dump-config OK: memory-dafeiyu -> @deepseek-ai/dsh-mcp-client
[dsh-smoke] starting DSH on http://127.0.0.1:56889 ...
[dsh-smoke] HTTP 200: http://127.0.0.1:56889/
[dsh-smoke] startup log OK: dsh web: http://127.0.0.1:56889
[dsh-smoke] MCP child OK: PID 10668 node D:/deepseek/plugins/dafeiyu-memory/dist/index.js
[dsh-smoke] temporary SQLite DB OK: C:\Users\<user>\AppData\Local\Temp\dafeiyu-dsh-smoke-FuMPoG\memory.sqlite3
[dsh-smoke] DSH exited cleanly (code 0)
[dsh-smoke] MCP child PID 10668 exited
[dsh-smoke] port 56889 released
[dsh-smoke] cleanup OK: no tracked process remains; temp directory removed
```

## 模型何时使用记忆

### MCP server instructions 与 AGENTS.md

仓库 checkout 中的 DSH `0.1.1-rc.2` 不会把 MCP initialize instructions 注入模型；官方桌面运行时 `0.2.2-rc.1` 已提供 server instruction prompt section。为了让两种运行时和无 prompt-section 的 profile 都遵守记忆策略，本交付继续保留用户级 `AGENTS.md` 托管块。

源码 checkout 的实际链路是：

- `D:/deepseek/packages/mcp/mcp-client/src/connection.ts:272` 调用 `generation.connect(...)` 后没有使用其 initialize 返回值。
- 连接成功后只执行工具同步和 `tools/list`。
- `D:/deepseek/packages/mcp/mcp-client/src/tools.ts:149` 一带读取每个工具的名称、`tool.description` 和输入 schema。
- 工具描述会注册给 DSH 并被模型看到，因此可以作为补充提示。
- MCP server instructions 不会被转发，不能依赖它决定“何时先 recall”。

### 当前实际注入位置

本阶段使用用户级 DSH 指令文件：

```text
$DSH_HOME/AGENTS.md
```

未设置 `DSH_HOME` 时默认是：

```text
%USERPROFILE%\.dsh\AGENTS.md
```

当前机器对应：

```text
%USERPROFILE%\.dsh\AGENTS.md
```

指令模板：

```text
D:\deepseek\plugins\dafeiyu-memory\dafeiyu-memory.AGENTS.md
```

安装器：

```text
D:\deepseek\plugins\dafeiyu-memory\scripts\install-agents-instructions.ps1
```

安装器只在以下 marker 之间幂等写入或更新内容，不会丢弃 `AGENTS.md` 的其他内容：

```text
<!-- BEGIN DAFEIYU-MEMORY MANAGED BLOCK -->
<!-- END DAFEIYU-MEMORY MANAGED BLOCK -->
```

手动安装、检查和移除：

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory'
npm run instructions:install
npm run instructions:check
```

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\deepseek\plugins\dafeiyu-memory\scripts\install-agents-instructions.ps1" -Remove
```

使用自定义 DSH 主目录时先设置：

```powershell
$env:DSH_HOME = 'D:\dsh-profile'
```

大肥鱼专用启动器会先无参数运行安装器，再以 `-Check` 校验；任一步失败都会阻止 DSH 启动。`DAFEIYU_MEMORY_SKIP_AGENTS_INSTALL=1` 只用于应急跳过。

### 指令片段

当前模板要求模型：

- 历史问题、长期偏好、此前决定或当前上下文缺少已确认事实时，先调用 `mcp__dafeiyu_memory__recall`。
- 只有用户明确要求记住时，才调用 `mcp__dafeiyu_memory__remember`。
- 纠错时先 `recall` 或 `get` 找到 `memory_id`，再调用 `mcp__dafeiyu_memory__correct`。
- 用户说“别再提”、要求隐藏或降权时调用 `mcp__dafeiyu_memory__forget`。
- 只有明确要求彻底、不可恢复地删除时才调用 `mcp__dafeiyu_memory__delete`。
- 召回结果包含冲突或多视角时，必须说明冲突内容、来源、时间和置信度，不能静默选择。
- 召回为空或证据不足时，明确说明没有可靠记忆，不能编造。
- 工具不可用时，明确说明无法访问长期记忆，不能假装已经检索或保存。

### 生效范围与限制

`AGENTS.md` 的加载和注入机制如下：

- DSH 的 `standard`、`code`、`cordis` preset 挂载了 `@deepseek-ai/dsh-agent-instructions`，用户级 `AGENTS.md` 在这些 preset 中生效。
- `minimal` preset 没有挂载 `agent-instructions`，因此不会加载该用户级记忆指令。
- `AGENTS.md` 不是 system prompt，也不是强制策略。DSH 会把它渲染为 `<system-reminder>` 用户消息。
- 它受到 `65536` 字节上下文预算限制。
- 更具体的工作区指令可以覆盖或优先于用户级指令；预算不足时也可能被挤占。
- 工具 description 对模型可见，但不能单独替代全局的“何时调用记忆”策略。

如果必须把规则提升到 system prompt 强度，下一步可以复制 `standard` 为独立 ID 的 `dafeiyu` 用户 preset，并把规则并入该 preset 的 `persona.text`。本阶段没有创建或启用这个 preset，当前交付仍使用 `$DSH_HOME/AGENTS.md`。

## 工具语义

| 工具 | 类型 | 主要语义 |
|---|---|---|
| `remember` | 写入 | 新建一条 active 记忆。输入包含范围、记忆类型、正文、认知类型、来源、来源置信度、事实置信度、有效时间和可选属性。返回 `memory_id`、首个 `version_id` 和记录内容。 |
| `recall` | 读取 | 按查询、当前目标、记忆类型和上下文召回候选。返回 `decision`、证据、冲突 ID 和解释。默认不包含 suppressed 记忆。访问统计和召回轨迹会写入本地数据库。 |
| `get` | 读取 | 按 `memory_id` 和范围读取单条记录的当前版本。找不到时返回空结果。用于在召回后核对完整元数据。 |
| `correct` | 写入 | 对已有记忆建立新版本，必须给出 reason、新来源和两组置信度。旧版本保留为历史，不直接覆盖。 |
| `forget` | 写入 | 通过 `suppress`、`archive` 或 `quarantine` 改变可见性或使用策略，保留审计与版本数据。它不等同于彻底删除。 |
| `delete` | 破坏性写入 | 删除指定记忆及其版本和关联，并清理或脱敏事件载荷。返回删除计数与 `verified`。仅用于明确、不可恢复的删除请求。 |
| `stats` | 读取 | 返回指定范围内的记忆、状态、版本和关联数量，不返回正文。 |

范围由以下字段共同确定：

```text
tenant_id
user_id
agent_id
persona_id
space_id
```

调用方必须保持这些字段稳定，否则同一句话会落到不同逻辑空间。

记忆类型：

- `episodic`：发生过的事件或经历。
- `semantic`：稳定事实、偏好和知识。
- `procedural`：步骤、命令和做事方式。
- `prospective`：未来要做的事、提醒和承诺。
- `autobiographical`：关于用户或人格自身的重要经历。
- `social`：人物、角色、关系和互动。

认知类型用于区分 `observed`、`reported`、`inferred`、`imagined`、`generated`、`injected` 和 `unknown`。一段文字被写入数据库，并不自动代表它是事实。

## 数据与隐私

- 数据库是本地 SQLite 文件。需要同时保护主文件以及运行期间可能出现的 `-wal`、`-shm` 多文件。
- `recall` 会把查询、当前目标、传入上下文和结果轨迹写入本地 `recall_episodes`，同时更新访问次数、最后访问时间、激活强度和审计记录；它不是零写入操作。
- 不记录密码、密钥、Token、Cookie 或其他敏感凭据。
- 本服务不训练模型，但召回结果会进入 DSH 发给模型提供方的上下文；模型提供方是否保留日志取决于其自身策略。
- `source_confidence` 表示来源本身有多可靠；`factual_confidence` 表示当前认为内容为真的程度。发生冲突时两者都要展示。
- `occurred_at`、`valid_from`、`valid_to` 会规范化为 UTC ISO-8601 再入库。`valid_from` 晚于 `valid_to` 会被拒绝。
- `forget` 是可恢复的可见性控制，不是安全擦除。
- `delete` 会清理正文和版本、删除关联并脱敏事件载荷，但保留不含正文的删除请求、墓碑和审计元数据。`verified: true` 只证明服务在其可访问范围内完成检查，不能清除文件系统快照、备份、外部日志或其他数据库副本。
- SQLite 删除页可能在一段时间内仍存在于文件或 WAL 中。高敏感数据应配合全盘加密、受控备份和专门的数据库擦除流程。

## 边界与 MVP 限制

- Node.js 当前使用 `node:sqlite`。Node 22 上的 `ExperimentalWarning: SQLite is an experimental feature` 是预期输出，不是测试失败；启动失败应看错误和退出码。
- SQLite 适合单机、单用户和单写进程。不要同时启动多个 DSH 或 MCP 进程写同一个数据库文件。
- 逻辑 `scope` 用于隔离查询范围，不是身份认证或租户鉴权。
- stdio 没有内置传输鉴权，只适合本机可信进程。不要把它改成公网 HTTP 服务。
- 服务自身不监听 TCP；DSH Web 启动器只允许 `127.0.0.1`，没有 `0.0.0.0` 入口。
- 召回以本地词法匹配、时间和上下文重排为主；同义改写、跨语言查询和长文档语义检索仍有限。
- `recall` 使用服务进程当前时间过滤 `valid_from` 和 `valid_to`，没有 `as_of` 参数。已经过期的记录默认不能通过召回重新发现。
- 没有 embedding、向量索引或后台自动摘要。
- 冲突检测是服务启发式结果，不等同于事实核查。
- 情绪与性格没有独立推理引擎，只能通过 `salience`、`identity_relevance`、标签和 `attributes` 表达。
- 自动记忆抽取、遗忘曲线、记忆巩固、睡眠式重排和跨会话主动提醒不在本 MVP 内。
- `npm run smoke:dsh` 当前依赖 Windows PowerShell/CIM 和 Windows 进程语义。
- PostgreSQL + pgvector 是后续服务器或多用户阶段，不作为当前 SQLite MVP 的替代。

后续阶段可以考虑：

1. 增加 embedding 与 lexical/vector 混合召回，并保留可解释分数。
2. 增加 PostgreSQL + pgvector 后端，支持多实例、备份和更强并发。
3. 为 agent、用户和子智能体增加能力令牌、读写权限与审计。
4. 增加情绪关联、人格特质与身份相关记忆的独立策略层。
5. 增加数据库加密、密钥轮换、保留期和可验证安全删除。
6. 用固定种子数据持续运行 `eval/`，把召回质量、冲突处理和删除行为纳入回归。
7. 复制 `standard` 为 `dafeiyu` 用户 preset，将记忆策略提升到 persona/system prompt 强度。

## 最终验收命令

以下命令应全部实际执行并通过：

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory'
npm test
npm run build
npm run smoke:stdio
npm run smoke:dsh
```

检查正式 overlay：

```powershell
Set-Location 'D:/deepseek'
node apps/cli/lib/bin.js --profile web --patch D:/deepseek/plugins/dafeiyu-memory/dafeiyu-memory.cordis.yml --dump-config
```

执行一次真实 DSH Web 启动：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "D:\deepseek\plugins\dafeiyu-memory\scripts\start-dafeiyu-memory.ps1"
```

在另一个 PowerShell 中检查 HTTP：

```powershell
(Invoke-WebRequest -Uri 'http://127.0.0.1:31789/' -UseBasicParsing).StatusCode
```

预期输出：

```text
200
```

回到启动窗口按 `Ctrl+C`。通过 `.bat` 启动时如果出现：

```text
Terminate batch job (Y/N)?
```

输入 `Y`。随后检查端口和进程：

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 31789 -State Listen -ErrorAction SilentlyContinue
```

没有输出表示端口已释放。再检查本轮启动的 Node/DSH/记忆进程已经退出：

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and (
      $_.CommandLine -like '*plugins\dafeiyu-memory\dist\index.js*' -or
      $_.CommandLine -like '*apps\cli\lib\bin.js*--profile*web*'
    )
  } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

如果机器上原本还有其他 DSH 会话，应按启动时记录的 PID 区分，只关闭本轮启动的进程，不要误杀其他会话。

## 手工验收清单

使用一次性数据库，并在每一步确认工具返回值和数据库路径一致。

1. **写入**：让大肥鱼记住“我的验证饮品是 `lapsang-eval-01`”，确认调用了 `remember` 并返回 `memory_id`。
2. **新会话召回**：不复制上一段对话，询问“我的验证饮品是什么”，确认模型先调用 `recall` 并返回 `lapsang-eval-01`。
3. **纠正**：对刚才的 `memory_id` 执行 `correct`，把值改为 `lapsang-eval-02`。用 `get` 确认当前版本是新值，旧版本仍可追溯。
4. **抑制**：执行 `forget` 的 `suppress` 模式。默认 `recall` 不应再返回该记忆，`stats` 中 suppressed 计数应增加。
5. **删除**：在一次性测试库中对指定 `memory_id` 执行 `delete`。确认返回 `verified`，再用 `get` 和默认 `recall` 验证不可见。
6. **统计**：调用 `stats`，核对 active、suppressed、deleted、versions 的变化与操作数量一致。
7. **重启持久性**：停止并重新启动 DSH，使用同一 `DAFEIYU_MEMORY_DB`，确认未删除数据仍可 `get` 或 `recall`。
8. **故障可见性**：把 `DAFEIYU_MEMORY_DB` 指向不可写目录，确认启动非零退出并报告 MCP 启动或工具同步失败，而不是静默进入无工具会话。
9. **干净退出**：按 `Ctrl+C` 后确认 HTTP 端口关闭，本轮 DSH 和记忆 MCP 进程都没有残留。

固定种子评估材料位于：

- `D:/deepseek/plugins/dafeiyu-memory/eval/README.md`
- `D:/deepseek/plugins/dafeiyu-memory/eval/seed-plan.md`
- `D:/deepseek/plugins/dafeiyu-memory/eval/evaluation.xml`
