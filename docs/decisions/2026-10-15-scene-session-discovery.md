# 2026-10-15-scene-session-discovery - 场景自己解析会话，不从命令处理器传递

- 日期：2026-10-15
- 状态：已采纳（2026-10-15 阶段 1a 的实现补充见文末）
- 参与者：DSH agent 会话

## 背景

改写场景需要拿到「当前会话」才能枚举模型可见消息（`session.surface.nodes` +
`deriveMessages()`）。命令处理器里能拿到 `CommandInvocation.agent.session`，
但**场景是由 `ctx.tuiScenes.open(id)` 打开的，拿不到 invocation**。

两条候选通路：

1. **模块级暂存**：命令处理器把 session 存进模块变量，场景挂载时消费一次。
   参考实现 `dsh-tui-find` 用同样手法传 `pendingQuery`（进程内单窗口，安全）。
2. **场景自解析**：场景从 `TuiSceneProps.channel` 取 `sessionId`，用
   `ctx.sessions.get(id)` 取回 live Session。

## 决策

采用**场景自解析**，模块级暂存不作为主通路。

## 理由

- `ChannelUi` 明确暴露 `sessionId`（`adapter/ports/channel-ui.d.ts:97`），
  且 `SessionStore.get(id)` 是公开 API（`dsh-session/lib/types/index.d.ts:447`，
  "Look up a live session"）。两者相接即可，无需跨调用的可变状态。
- 模块级暂存有真实性缺陷：场景可能在**另一个**会话里被快捷键打开
  （快捷键是纯聊天态入口，命令处理器未参与），暂存的 session 会是错的；
  自解析天然对「当前 UI 绑定的会话」正确。
- 消除进程内可变状态，测试与并发推理都更简单。

## 替代方案

- **模块级暂存（参考实现用法）**：在「快捷键打开」路径上会指向错误会话，故不采用为主通路。
- **让命令把 seq 通过 scene 参数传入**：`tuiScenes.open(id)` 不接受参数。

## 实现补充（2026-10-15，阶段 1a）

写代码时发现一个本文未覆盖的事实：**宿主不把 `ctx` 交给场景**。
`createChannelSceneOutlet`（`lib/types/dsh-adapter/channel-scene-outlet.js:9`）
只注入 `{ React, ui, channel, close }` —— 与 `TuiSceneProps` 的类型一致，
没有第五个 prop。场景是纯 React 组件，拿不到任何 cordis 上下文，
因此**它自己无法调用 `ctx.sessions.get`**。

保持本决策的结论不变（仍以 `channel.sessionId` 为准，不用模块级暂存 session），
但把「谁执行查询」落成一条显式接缝：

- 插件在 `apply` 的同步段把 `id => ctx.sessions.get(id)` 注册进场景模块
  （`setSessionResolver`，见 `src/scene.js`）；
- 场景**每次渲染**都用当前 `channel.sessionId` 调 `sessionFor(id)`。

这与「模块级暂存」的关键差别：暂存的是**查询能力**（与会话无关），
不是**某个会话对象**。所以快捷键路径、会话切换、场景重挂载都指向
正确的会话，而模块级暂存 session 会在这些情形下指向错的会话。

## 影响

- 收益：快捷键与命令两条入口行为一致；无跨调用状态。
- 成本：场景挂载时多做一次 store 查询（O(1)）。
- 风险：若 UI 绑定的不是 DSH 会话（其他内核），`ctx.sessions.get` 返回 `undefined`；
  场景必须优雅降级 —— 已实现（显示 "no live session bound to this UI"）。
- 后续工作：无。相关自动化测试：`test-harness/test/scene-render.test.mjs`
  （场景解析与降级）与 `test-harness/test/plugin.test.mjs`（resolver 接真实 store）。

## 关联

- 相关任务：`docs/tasks/20261015-142000-rewrite-exploration.md`
- 相关决策：[2026-10-15-defer-command-mediated-registration](./2026-10-15-defer-command-mediated-registration.md)