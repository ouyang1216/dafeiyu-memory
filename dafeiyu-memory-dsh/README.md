# 大肥鱼记忆 DSH 组合包

`dafeiyu-memory-dsh` 把现有 `dafeiyu-memory-mcp-server` 包装成可安装的 DSH bundle。它只贡献一条 `@deepseek-ai/dsh-mcp-client` 配置，不复制 SQLite、召回或七个 MCP 工具的实现。

`0.2.1` 的核心包增加了数据库一致性快照、删除前快照、空闲精确去重与维护报告。bundle 仍只负责安装和标准输入输出接线，不直接访问 SQLite。

```text
DSH bundle
  -> @deepseek-ai/dsh-mcp-client
  -> dafeiyu-memory-mcp-server (same node_modules resolution)
  -> local SQLite
```

## 安装

从本目录安装到普通 profile：

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory-dsh'
npm run bundle:pack
dsh plugin --profile <profile> add ./releases/dafeiyu-memory-dsh-0.2.1.tgz
```

官方桌面版的 `desktop` profile 由 Electron 插件管理器独占。完全退出 DSH 后，可在「设置 -> 插件 -> 添加插件」中填入生成的 `.tgz` 绝对路径，安装后重启 DSH。

`bundle:pack` 会先构建核心包，再把 `dafeiyu-memory-mcp-server` 及其生产依赖放进 tarball 的 `node_modules/`。普通源码目录是 `link:` 安装，pnpm 不会为它安装依赖，所以日常安装使用 `.tgz`，不要把源码目录当作已打包插件。

包内 patch 从自身安装位置解析 `dafeiyu-memory-mcp-server`，不包含 `D:/deepseek` 或用户目录写死路径。

## 配置

`DAFEIYU_MEMORY_DB` 控制数据库路径。未设置时使用 `%USERPROFILE%\.dafeiyu-memory\memory.sqlite3`。数据库必须位于源码树和 Git 工作区之外。

服务在数据库旁创建 `<database>.lock`，同一 SQLite 数据库只允许一个写入进程。桌面和 Web 必须使用同一个锁文件，或配置成两个不同的数据库。进程异常退出后，下一次启动会回收失去所有者的锁。

## 验证

```powershell
Set-Location 'D:/deepseek/plugins/dafeiyu-memory'
npm test
npm run build
npm run smoke:stdio
npm run smoke:dsh
```

安装后模型工具为：

```text
mcp__dafeiyu_memory__remember
mcp__dafeiyu_memory__recall
mcp__dafeiyu_memory__get
mcp__dafeiyu_memory__correct
mcp__dafeiyu_memory__forget
mcp__dafeiyu_memory__delete
mcp__dafeiyu_memory__stats
```

用户级 `$DSH_HOME/AGENTS.md` 的记忆使用指令继续由核心包的 `instructions:install` 和 `instructions:check` 管理。
