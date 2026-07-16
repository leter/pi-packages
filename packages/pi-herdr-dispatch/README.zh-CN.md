# pi-herdr-dispatch

[English](./README.md) | 简体中文

一个处于分阶段开发中的 Pi 扩展，通过带 Registry 的类型化路径，把工作自动派发给本地 Herdr 工作区中**已经存在**的 coding Agent。

> **状态：** 实验阶段，Phase 6 验收已恢复。投递、结果和 Widget 修复已通过全新的真实 Pi、Claude Code、Codex、OpenCode、Droid、Amp、Grok 矩阵，默认自动派发也已通过 schema v3 迁移后的免确认真机探针。本包仍保持 `private`、版本 `0.0.0-development`，没有发布任何包。

## 环境要求

- Node.js 24 或更高（需要 `node:sqlite`）
- Pi `0.80.6` 或更高版本（修复后矩阵已在 `0.80.7` 验证）
- Herdr `0.7.3`，socket 协议版本 `16`
- Pi 必须运行在 Herdr 的 pane 里，且具备 `HERDR_SOCKET_PATH`、`HERDR_WORKSPACE_ID`、`HERDR_PANE_ID` 环境变量

本扩展在正常运行中**从不**创建 Agent、pane、工作区、worktree 或协调者，只向捕获到的当前工作区中已存在的 Agent 派发任务。

## 开发安装

```bash
git clone https://github.com/leter/pi-packages.git
cd pi-packages
npm ci
npm run check
npm test
pi install "$PWD/packages/pi-herdr-dispatch"
```

重启 Pi 或执行 `/reload`，然后用 `/hd-agents` 和 `/hd-manager` 验证。卸载开发安装：

```bash
pi remove /absolute/path/to/pi-packages/packages/pi-herdr-dispatch
```

在验收完成之前，本包刻意保持 private/development 状态。以上步骤安装的是本地 checkout 的引用，不会发布任何东西。

### 开发迭代循环

`pi install ./本地路径` 只是把路径引用写进 `~/.pi/agent/settings.json`——不拷贝任何文件，Pi 直接加载 `src/index.ts` 源码，没有构建步骤。装一次之后：

1. 改代码；
2. 在 Pi 会话里（它所在的 Herdr pane 中）执行 `/reload`。reload 对本扩展是安全的：Registry 会重新打开、监控带有界 catch-up 读取重启、widget 重新挂载，dispatch 状态不会丢；
3. 如果改的是纯渲染或纯逻辑，`npx vitest run test/unit/dispatch-view.test.ts` 比真机 reload 快得多——`/reload` 留给交互手感和键位测试。

只有三种情况需要再碰 install：checkout 换了路径、要在别的机器上装、或者要卸载。

## Dispatch 工作流

推荐日常使用清晰易读的 `hd-*` 别名；原来的长命令会继续保留以保证兼容性。

- `/hd-agents`（`/herdr-agents`）—— 列出当前工作区中符合条件的 Agent。
- `/hd-new`（`/herdr-dispatch`）—— 完成手动派发向导后立即发送，不再出现最终确认。
- `/hd-manager`（`/herdr-dispatches`，或 `alt+h`）—— 打开当前工作区的 Dispatch Manager，浏览人类可读的任务，并执行显式的有界输出读取（`r` 读 50 行，`R` 读 200 行）。
- `/hd-reply [id或前缀]`（`/herdr-dispatch-reply`）—— 当一个 Active Dispatch 有 attention 时，选择、预览并确认一条回复。
- `/hd-cancel [id或前缀]`（`/herdr-dispatch-cancel`）—— 选择并确认一个常规取消请求；**从不**向目标发送 `Ctrl+C`。
- `/hd-resolve [id或前缀]`（`/herdr-dispatch-resolve`）—— 在查看证据并确认后，将 dispatch 手动（或紧急）结算为 `blocked`、`failed` 或 `cancelled`；手动结算不会声称任务 `done`。
- `/hd-output <目标> [行数]`（`/herdr-agent-output`）—— 执行一次显式请求的有界输出读取。
- `/hd-setup`（`/herdr-dispatch-setup`）—— 显式安装一个选定的 Herdr 状态集成。

模型工具只暴露范围受限的列表、提案、状态和一次性检查能力。回复、取消、结算、创建 Agent、等待、强制打断**永远不是**模型工具。

TUI 模式下默认自动派发。`herdr_dispatch_propose` 和完成后的 `/hd-new` 向导会构建一条不可变出站消息并直接发送，不再需要提案确认、Grant 设置、次数、有效期或续期。类型化路径仍会在持久化 intent 和投递前重新校验当前工作区目标身份、状态证据、cwd/规范 worktree、占用、租约和并发限制。非 TUI 模式不能预留、发送、回复、取消、结算或监控。

## Dispatch Manager 使用指南

`/hd-manager`（或 `alt+h`；长命令为 `/herdr-dispatches`）打开 Dispatch Manager。行按行动优先级分组——先 `NEEDS ATTENTION`（需要关注），再 `RUNNING`（运行中），最后 `DELIVERING`（投递中）——每行显示目标 Agent、任务摘要、最主要的 attention 原因和相对截止时间。默认行**从不**显示 dispatch ID；需要完整标识符时在详情页按 `D`。

状态 glyph 由「符号 + 主题色 + 文字标签」三者组成，任何状态都不单靠颜色传达：`●` 运行中、`◌` 投递中、`▲` 需要关注、`✓` 完成、`◼` 受阻、`✗` 失败、`○` 已取消。

### 列表页

| 按键 | 作用 |
|---|---|
| `↑`/`↓`（或 `ctrl+p`/`ctrl+n`） | 移动选中行 |
| `PageUp`/`PageDown` | 翻页（10 行窗口） |
| `Home`/`End` | 跳到第一条 / 最后一条 |
| `Enter` 或 `→` | 打开选中的 dispatch |
| `s` | 显示 / 隐藏最近已结算的记录 |
| `Esc`、`←` 或 `Ctrl+C` | 关闭面板，不改变任何状态 |

### 详情页

| 按键 | 作用 |
|---|---|
| `r` / `R` | 一次有界输出读取（50 / 200 行）——带时间戳、标注为不可信、永不流式 |
| `y` | 回复（仅当该记录是本 Origin Session 的 Active Dispatch 且有 attention 时才显示） |
| `c` | 请求取消（从不向目标发送 `Ctrl+C`） |
| `v` | 手动结算；外来 Origin 的记录会显示紧急结算标注 |
| `D` | 展开 / 收起技术细节（完整 dispatch ID、终端、Origin、工作区） |
| `Esc` 或 `←` | 返回列表 |

动作键只在记录的生命周期、attention 状态和 Origin 关系允许时才出现；每个动作在发送前都会重新读取并校验记录，并经过既有的预览 + 确认闸门。用 `Esc` 或 `Ctrl+C` 关闭面板**永远不可能**改变 dispatch 状态。

典型流程：用 `/hd-new` 派发任务 → 留意编辑器下方 widget 的计数 → 有需要关注的事项时按 `alt+h` → 打开记录 → 按 `r` 读取它最近的输出 → 在详情页选择回复、取消或结算。

## 配置

可选文件：`~/.config/pi-herdr-dispatch/config.json`

```json
{
  "defaultDeadlineMinutes": 30,
  "minDeadlineMinutes": 1,
  "maxDeadlineMinutes": 1440,
  "startupWindowMs": 30000,
  "minStartupWindowMs": 5000,
  "maxStartupWindowMs": 300000,
  "maxActivePerTargetWorkspace": 4,
  "maxActiveGlobal": 8,
  "retentionDays": 30,
  "inspectionLines": 50,
  "maxInspectionLines": 200,
  "catchUpLines": 200,
  "cwdPollMs": 5000,
  "cwdDriftSamples": 2
}
```

未知字段、非法类型、不安全的边界值、或最小/默认/最大值不一致，都会禁用改状态的行为。依赖健康的安全读取能力仍然可用。

Registry 默认位于 `~/.local/state/pi-herdr-dispatch/registry.sqlite`，目录权限 `0700`、数据库权限 `0600`，启用 WAL、外键、备份、事务化迁移和完整性检查。

## 安全边界

安全性是**尽力而为的建议性约束**，不是 shell 沙箱，也不是目标侧的安全边界。

本扩展提供：

- 全局唯一的目标占用（Target Occupancy）和 Worktree 写锁（Write Lease）；
- Pi 侧对可识别的内置 `edit`、`write`、`bash`、`!`、`!!` 变更的守卫；
- 原始 Herdr CLI 闸门，阻止常规任务下发、等待、创建、控制、外部读取和跨工作区快照；
- 默认自动的类型化派发、不可变的 payload 哈希、当前工作区范围、终端身份、关闭/移动观测、投递回显校验；
- 对 Agent 元数据、输出和结果的有界、显式不可信框定；
- 投递结果不明确时从不自动重发。

它无法可靠控制：

- Pi 之外的手动 shell 或进程；
- 无视建议性约束的目标 Agent；
- 未知的第三方变更工具；
- 生成的脚本、别名、替代二进制、直连 socket 的代码、或足够混淆的 shell 命令；
- 不经 Registry 就修改 worktree 的外部进程。

本包不授权提交、推送、部署、发布、破坏性清理、远程变更或全局/系统级安装。项目依赖安装需要一个显式确认的写提案。

## 恢复手册

### `delivery-unverified`（投递未验证）

**不要**自动重发。即使响应或有界回显丢失，目标也可能已经收到了输入。先检查目标，在确定最终结局之后再用 `/hd-resolve`。

### Origin Session 关闭或 Pi 重载

预留是持久的。恢复到**同一个** Origin Session，它会执行一次有界 catch-up 读取，且永不把监控转移给其他会话。排队的净化结果通过 `nextTurn` 送达，不会触发模型回合。

### Herdr 重启

Herdr 0.7.3 会重新生成终端 ID。存储的终端一旦丢失就变成 `target-lost`，即使 pane ID、cwd、Agent 标签或保留的历史看起来相似。V1 从不做启发式重定向；请检查后手动结算。

### `result-missing`、`target-moved` 或 `target-lost`

预留仍然被持有。查看展示的有界证据，然后使用手动结算。没有独立的锁释放命令。

### Origin Session 不可用

其他本地 TUI 会话只有在亲自证明 Origin 不可用、并对预留释放做第二次确认之后，才能使用紧急结算。任何进程存活检查都不被当作证据。紧急结算不转移监控，也不向结算者注入上下文。

### Registry 不可用或损坏

改状态的行为会失败关闭（fail closed），从不回退到空的或内存中的 Registry。保留数据库及其带时间戳的迁移备份，恢复访问或经过审阅的备份后再重试。瞬时的 SQLite busy/locked 超时耗尽只影响当前操作；结构性 SQL 错误会禁用该进程内后续的变更。

## UI 与通知

本扩展只在编辑器下方添加一个紧凑 widget，从不替换 Pi 的 footer。`/hd-manager`（长命令 `/herdr-dispatches`；快捷键 `alt+h`，仅 TUI）打开 Dispatch Manager：一个当前工作区、attention 优先的列表，本 Origin 最近已结算的记录默认折叠。Dispatch ID 是内部关联细节，只出现在显式的技术细节里。Widget 和 Manager 每次渲染都重读 Registry，不缓存状态。`running` 不包含已归入 attention 的 dispatch，attention 数量表示受影响的 dispatch 数，而不是并发 condition 数。Manager 还会刷新相对时间，输出读取只以显式的一次性有界 tail 进行（`r` 50 行、`R` 200 行，带时间戳并标注为不可信）。回复、取消和结算的选择仍然经过既有的预览、资格重验和确认闸门。

命令的可选参数支持精确 ID 和无歧义前缀（面向高级用户），并提供完整 ID 的参数补全。有歧义的前缀会打开人类可读的选择器，从不猜测。外来 Origin 的记录只能在当前工作区范围内被发现，且只暴露紧急结算，不提供回复或取消。Herdr 通知声音仅限于：

- `done` —— 成功的 `done` 结局；
- `request` —— attention、受阻或失败结局；
- `none` —— 取消。

本扩展从不调用 `pane.report_metadata`。

## 相关文档

- [设计文档](./docs/DESIGN.md)
- [领域语言](./docs/CONTEXT.md)
- [实现计划](./docs/IMPLEMENTATION-PLAN.md)
- [交互计划](./docs/DISPATCH-INTERACTION-PLAN.md)
- [兼容性验证](./docs/SPIKE-RESULTS.md)
- [真机验收结果](./docs/ACCEPTANCE-RESULTS.md)
- [评审发现](./docs/REVIEW-FINDINGS.md)
- [架构决策](./docs/adr)
