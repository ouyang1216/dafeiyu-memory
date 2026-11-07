# 大肥鱼记忆

面向 DeepSeek Harness 大肥鱼人格的本地优先长期记忆服务。

## 目录

- `dafeiyu-memory/`：SQLite 记忆内核和 stdio MCP server。
- `dafeiyu-memory-dsh/`：可安装的 DSH bundle。
- `releases/`：核心包、DSH bundle 和完整源码归档。

## 安装到 DSH

```powershell
dsh plugin --profile desktop add ./releases/dafeiyu-memory-dsh-0.2.1.tgz
```

安装后重启 DSH。模型侧提供七个工具：

```text
mcp__dafeiyu_memory__remember
mcp__dafeiyu_memory__recall
mcp__dafeiyu_memory__get
mcp__dafeiyu_memory__correct
mcp__dafeiyu_memory__forget
mcp__dafeiyu_memory__delete
mcp__dafeiyu_memory__stats
```

## 数据

- 默认数据库：`%USERPROFILE%\.dafeiyu-memory\memory.sqlite3`
- 快照：`%USERPROFILE%\.dafeiyu-memory\memory.sqlite3.snapshots`
- 维护报告：`%USERPROFILE%\.dafeiyu-memory\memory.sqlite3.maintenance`
- 使用策略：`%USERPROFILE%\.dsh\AGENTS.md` 的托管块

数据库和快照不进入 Git。SQLite 使用单写进程锁；桌面与 Web 不应同时共享一个写库。

## 验证

```powershell
Set-Location dafeiyu-memory
npm test
npm run build
npm run smoke:stdio
npm run smoke:dsh

Set-Location ..\dafeiyu-memory-dsh
npm run bundle:pack
npm run smoke:install
```
