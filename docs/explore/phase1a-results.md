# 阶段 1a 验证记录 —— 场景骨架、数据源与入口

- 状态：**已完成**。自动化 60 项全绿；真机 A1–A8 由用户于 2026-10-15 执行通过
- 日期：2026-10-15
- 前置：`node test-harness/mount.mjs`（验证期间 profile 保持挂载；回滚 `node test-harness/unmount.mjs`）
- 结论：用户 2026-10-15 实测通过（`dst`，147×42 终端）
- 计划与验收标准：[docs/PLAN.md](../PLAN.md) 第 2 节「阶段 1a」

## 1. 实现过程中发现并修掉的四个真实缺陷

代码原本"看起来完成"，但与宿主契约逐条对照后，**场景根本打不开有内容的一屏**。
四条都不是风格问题，任何一条留下都会让 1a 的验收项直接失败。

### 1.1 宿主不把 session 交给场景（致命）

`createChannelSceneOutlet`（`lib/types/dsh-adapter/channel-scene-outlet.js:9`）只注入
`{ React, ui, channel, close }`，与 `TuiSceneProps` 类型完全一致 —— **没有第五个 prop**。
原实现读 `props.session`，永远是 `undefined`，于是每次都渲染
"no live session is bound to this UI"。A2「标题显示目标条数」不可能通过。

修法（沿用决策 `2026-10-15-scene-session-discovery` 的结论，补上"谁执行查询"）：

- 插件在 `apply` 的同步段注册查询能力：`setSessionResolver(id => ctx.sessions.get(id))`；
- 场景**每次渲染**用当前 `channel.sessionId` 调 `sessionFor(id)`。

已注册的是**能力**而非某个会话对象，所以快捷键入口、会话切换、场景重挂载都指向正确会话。

### 1.2 条件 return 插在 hook 之前，会错位 React 的 hook 槽

场景在「无会话」分支提前 return，而 `useState(() => collectTargets(session))` 在**它之后**。
React 按调用顺序对位 hook：首帧少调用几个 hook，会话出现后的那一帧每个 state 都会落到
**上一个**槽位 —— 症状是"界面正常但列表永远空"。这正是本项目最怕的静默失效形态。

修法：`sessionFor` 与全部 hook（含两个 effect）移到条件 return 之前。
回归测试：`scene-render.test.mjs` 的「a first paint without a session does not shift the hook slots」。

### 1.3 ref 镜像改在渲染期绑定

原实现在 handler 里就地写 `selectedRef.current`，state 与镜像两套账。
改为 `useMirrorRefs(React)`（一个 `useMemo` 造的稳定 ref 对象）+ 每次渲染统一绑定，
handler 只读镜像。"一个 stdin chunk 多个按键"的批处理风险不变，但状态只有一处写入路径。

### 1.4 缝合点可能比插件行更晚上线

参考实现 `dsh-tui-find` 的注释记载了它自己踩过的坑（0.10.1 + engine rc.2）：
**插件行的 apply 可能跑在 TUI 运行时服务存在之前**，此时 `ctx.get('tuiScenes', false)`
返回 `undefined`，注册被静默跳过 —— 此后整场会话的 `/find` 都打不开，而启动看起来完全正常。
原实现只做一次裸软探测，命中同一形态：场景与快捷键都不注册，用户只看到"命令没反应"。

修法（`src/seam.js`，与参考实现同机制）：

- `whenSeamMounted` —— 先同步探测一次（正常启动零成本），未命中则按
  25 ms × 200 → 5 s × 5 s 的两段预算轮询到 ~10 分钟；超时才放弃并记一条 warn。
- `registerSeamWithRetry` —— 缝合点在、但宿主 liveness 闸门在冷启动窗口拒绝注册时，
  在定时器上重试而不是在 `apply` 里抛错（`apply` 抛错会让整个激活失败）。
- 两层都用 `ctx.effect` 绑定 disposer，且 disposer **先注册后定时**：
  否则一个在激活卸载后才排上的定时器没有任何属主（实测会把测试进程挂住）。
- 刻意**不用** `ctx.inject`：cordis 把服务代理的调用者绑定到 `.get()` 所在的 context，
  在 inject 回调里注册会被算成"另一个激活的注册"，之后每次 `open()` 都会被拒。

## 2. 自动化证据

```
npm test        # 60 项，全绿
npm run report  # 端到端契约报告，5 项 RESULT 全 true
```

新增测试（阶段 1a 相关）：

| 测试 | 位置 | 锁住的契约 |
|---|---|---|
| 场景渲染 13 项 | `test-harness/test/scene-render.test.mjs` | 标题条数与 session 短 id、一行一条回复、空态、无会话态、resolver 抛错降级、hook 槽位不漂移、projected 文本回读 |
| resolver 接真实 store | `plugin.test.mjs` | `sessionFor(channel.sessionId)` 真的拿到 live Session（不是形状替身） |
| 无 TUI 缝合点（A7） | `plugin.test.mjs` | 组合无 `tuiScenes`/`commands`/`tuiShortcuts` 时仍 apply，`projectionStatus().registered === true`，UI 三个标志均 false |
| 入口常量契约 | `plugin.test.mjs` | `rewrite` / `alt+r` / scene id 形态、`inject = ['sessions']` |
| 场景注册 | `plugin.test.mjs` | `scenes.register` 收到 `{ id, title, component }`，component 是函数 |
| 命令双路径 | `plugin.test.mjs` | 先试中介（`COMPONENT_NOT_ADMITTED`），回落直接注册；`recordInput: false` |
| 开场景失败可见 | `plugin.test.mjs` | `open()` 返回 false 时 handler 返回 `kind: 'error'`，不静默 |
| collectTargets 边界 | `scene.test.mjs` | 空会话、全 tool-call、已改写内容、跨内核形状 |
| 缝合点轮询 10 项 | `seam.test.mjs` | 同步命中不留定时器、晚挂载命中、两段节奏、预算耗尽只报一次、卸载停轮询、探测抛错被兜住、setup 抛错交给调用方、重试成功与失败路径、抛出 tick 被兜住 |
| 缝合点晚挂载（端到端） | `plugin.test.mjs` | apply 之后才 provide tuiScenes，轮询仍能注册成功 |
| 现场证据通道 3 项 | `debug.test.mjs` | 三个入口各自的落地行都被写下；`applied` 行**不带**入口布尔；无缝合点时只有 `applied` 一行 |

测试桩说明：`test-harness/test/scene-render.test.mjs` 用一个**模拟 hook 运行时**直接调用组件
（无 reconciler、无终端），并按 React 的规则跑 effect、按调用顺序对位 effect 槽位。
会话一律是**真实 dsh-session 会话**（`tools.mjs` 的 `openSession`/`sessionWithReplies`），
不用形状替身。渲染层本身（真实终端、鼠标、键盘投递）仍只能真机验证。

## 3. 真机验证清单（A1–A8，已通过）

前置：`node test-harness/mount.mjs`（已挂载时可跳过）；启动用 `dst`。
建议同时开诊断日志：

```powershell
$env:DSH_TUI_REWRITE_DEBUG = '1'; dst   # pwsh；日志路径 ~/.dsh-tui/dsh-tui-rewrite.log
# 观察 scene opened / scene registered / targets enumerated / rewrite appended
```

| 编号 | 步骤 | 期望 | 结果 |
|---|---|---|---|
| A1 | `dst` 启动，界面与对话正常 | 无异常；`~/.dsh-tui/dsh-tui-rewrite.log` 有 `applied` 且 `registered:true` | ✅ |
| A2 | 输入 `/rewrite` 回车 | 进入全屏场景；标题形如 `rewrite · N assistant replies · session <8位>`，N = 当前会话助手回复条数 | ✅（日志 3 次 `scene opened` + `targets enumerated` 0→1→2） |
| A3 | 回聊天态按 `alt+r` | 打开同一场景（若被占用，记录实际组合） | ✅（`alt+r` 未被占用，三次打开同一 session） |
| A4 | 场景内按 `Esc` | 回到原界面，无残影、无重复边框、输入框可正常输入 | ✅ |
| A5 | 清单逐条核对 | 每行 `seq <n>  摘要`；seq 与模型可见助手消息一一对应、同序；摘要是该消息文本压掉空白后按显示宽度截断（CJK 记 2 格，超长带 `…`） | ✅（条数随会话推进 0→1→2，与真实会话一致） |
| A6 | 打开一个**无助手文本**的会话再 `/rewrite` | 标题条数为 0，正文显示 `(no assistant replies with text in this session yet)`，不崩 | ✅（首开即 `targets: 0`） |
| A8 | 场景内快速连按方向键、连续 `Esc` | 不出现跳两格/无响应/卡死；渲染期异常由宿主边界兜住并关闭场景 | ✅（无异常日志） |

A7 已由自动化覆盖（见第 2 节表格）。

**诊断日志要看的四行**（`DSH_TUI_REWRITE_DEBUG=1`）：`applied`（带 scene/command/shortcut 三个布尔）、
`scene opened`、`targets enumerated`（带条数）、异常时的 `no session for channel` /
`deriveEventMessage threw`。全屏界面看不到 stderr，这里是唯一现场证据。

### 3.1 现场证据（用户 2026-10-15 实测，`DSH_TUI_REWRITE_DEBUG=1`）

日志原文（`~/.dsh-tui/dsh-tui-rewrite.log`，UTC）：

```jsonl
{"at":"2026-10-15T09:10:42.864Z","message":"applied","registered":true,"scene":false,"command":true,"shortcut":false}
{"at":"2026-10-15T09:10:43.303Z","message":"scene registered","scene":"dsh-tui-rewrite-scene"}
{"at":"2026-10-15T09:11:42.870Z","message":"scene mounted","sessionId":"946ce6b2-…","hasSession":true,"targets":0,"columns":147,"rows":42}
{"at":"2026-10-15T09:12:39.735Z","message":"scene mounted","sessionId":"946ce6b2-…","hasSession":true,"targets":1,"columns":147,"rows":42}
{"at":"2026-10-15T09:13:15.248Z","message":"scene mounted","sessionId":"946ce6b2-…","hasSession":true,"targets":2,"columns":147,"rows":42}
```

这四条日志各自锁定一件事：

1. **`scene:false` 之后 439 ms 才 `scene registered`** —— 第 1.4 节那个缺陷在真机上真的会发生：
   `apply` 那一刻 `tuiScenes` 还不存在，裸软探测会永久静默失效。
   晚挂载轮询不是防御性编程，是这台机器上的实际启动路径。
2. **`hasSession:true`** —— 第 1.1 节的 session 通路真的接通了（若没接通，这里会是 false 且场景显示"no live session"）。
3. **`targets` 0 → 1 → 2 且 `sessionId` 全程不变** —— 清单随会话推进，A5 的"条数与真实会话一致"成立。
4. **首次打开 `targets: 0` 却没有任何 error/warn 行** —— A6 的空态是设计路径，不是异常路径。

三点由日志佐证的边界：

- `columns:147, rows:42` 说明 `useTerminalSize` 在这个终端上给的是真实尺寸，视口与截断按 147 列算。
- 三次打开之间没有 `scene closed` 之类的错误行，A4/A8 无异常穿透。
- 日志里**没有** `rewrite appended` —— 1a 范围内不含提交（提交属 1c），所以这次没有实际写入改写事件。
  也就是说：**投影端到端（模型看到新文本、日志留原文）靠 `npm run report` 与集成测试证明，不靠这次真机**。

### 3.2 真机验证后补的两处观测改进

真机日志暴露了一个**观测陷阱**：`applied` 行原本带 `scene`/`command`/`shortcut` 三个布尔，
而它们都是 **apply 那一刻的快照** —— 上面那份日志里 `scene:false`，439 ms 后场景才注册成功。
照着这行读会得出"场景没注册"的错误结论。已改为：

- `applied` 行只保留 `registered`（投影是否注册，这是 apply 期内就确定的）；
- 每个入口在**真正落地**时各写一行：`scene registered` / `command registered` / `shortcut bound`；
- `DSH_TUI_REWRITE_DEBUG` 打开时，插件每 250 ms 自检一次，三处都落地后写一行
  `entry points verified`（60 s 未齐则写 `entry points incomplete` 并 warn）。
  定时器 `unref`，不拖住进程；不开调试开关时完全不启动。

这样下一轮（1c 真机）看日志就能直接回答"三个入口到底有没有都装上"。
`debug.test.mjs` 锁住了这三类行与"`applied` 不带入口布尔"这条形状。

**未在真机覆盖的**：这次没有真正提交过改写，所以日志里没有 `rewrite appended`。
1a 范围不含提交，不阻塞；**1c 收尾时必须**在真机上提交一次，核对 `rewrite appended` 与回读新文本。

**异常路径也要看**：启动阶段（会话尚未就绪）打开场景应显示
"no live session is bound to this UI"，而不是空清单。

## 4. 本阶段已解决的开放问题

- **`channel` 是否带 seq** —— 不需要 seq：`channel.sessionId` 足够，
  seq 由 `session.surface.nodes` 提供（原第 5 节问题 2 关闭）。
- **场景内输入是否被接管** —— `useInput` 在场景挂载期生效；
  真机 A8 补最后的手感确认。

## 5. 仍未验证 / 留给后续阶段

| 项 | 阶段 | 说明 |
|---|---|---|
| R6 compaction 与改写消息的交互 | 4 | 被改写消息可能被整体遮蔽 |
| fork 子会话继承改写事件 | 4 | 投影注册是否随子会话生效 |
| 中介命令注册（`registerCommand`）真实可用性 | — | 当前宿主不签发 admission，回落是正常路径；manifest **故意不声明** contribution，见决策 `2026-10-15-defer-command-mediated-registration` |
| 场景滚轮手感、hover 高亮漂移 | 1b | 阶段 1b 的 B4/B5 |
| 编辑模式（自研多行编辑器） | 1c | 最大 UI 工作量 |