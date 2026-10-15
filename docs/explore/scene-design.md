# dsh-tui-rewrite 全屏场景设计勘察（2026-10-15）

- 状态：阶段 1 的接口事实已查清（含鼠标能力，已由代码与参考实现双证）
- 上源：用户 2026-10-15 决策「交互性强的改写方式：/rewrite 或快捷键进入全屏场景，
  场景内列出各段回复，键盘或鼠标选择后进入该段的编辑模式；目前只做文本修改」

## 1. 已确认的需求边界（本次收窄）

- 入口：`/rewrite` 命令 **和/或** 全局快捷键，打开全屏场景。
- 场景内：列出会话中各段助手回复，用户选择其中一段。
- 选择后：进入该段的**编辑模式**，改完提交。
- **只改文本**（`type:'text'` 的 part）。工具调用参数、`tool/result` 明确不做。
- 不做自动改写（沿用 HANDOFF 第 1 节边界）。

## 2. 场景接缝契约（已查实）

来源：`@deepseek-harness-tui/dsh-tui/scenes`（公开导出子路径）、
`lib/types/dsh-adapter/scenes.d.ts`。

```ts
ctx.tuiScenes.register(descriptor, identity?)  // 返回 disposer，调用方用 ctx.effect 绑定
ctx.tuiScenes.open(id): boolean                // 打开失败返回 false 并 warn
ctx.tuiScenes.close(): void
ctx.tuiScenes.active: TuiSceneDescriptor | undefined
ctx.tuiScenes.subscribe(listener): () => void  // UI 侧变更订阅

interface TuiSceneDescriptor {
  id: string;                 // kebab-case
  title?: string;             // 仅用于日志/调试，场景自绘标题
  component: React.ComponentType<TuiSceneProps>;
}

interface TuiSceneProps {
  React: typeof React;            // 必须用宿主的 React
  ui: typeof import('../ui.js');  // 宿主 ui 套件
  channel: Channel;               // 活会话通道：rows / status / trace / notifications
  close(): void;                  // 回到场景打开前的界面
}
```

要点：

- **不需要自己包 `AlternateScreen`**：宿主在 `screens/Chat.js:5538` 处，当
  `channel.pluginScene` 有值时**替换**会话视图渲染插件场景，外面包了
  `PluginSceneBoundary` 错误边界。场景就是整屏。
- **必须用宿主的 React**：插件的第二份 React 副本会让 hooks 在首次渲染就
  `invalid-hook-call` 崩掉；元素要用注入的 `React.createElement`，或把 tsconfig 的
  `"jsxImportSource"` 指向 `@deepseek-harness-tui/dsh-tui`（其 `./jsx-runtime`
  子路径再导出宿主自己的 react/jsx-runtime）。参考实现就是这么编的：
  `dsh-tui-find/dist/*.js` 全部 `import { jsx } from '@deepseek-harness-tui/dsh-tui/jsx-runtime'`。
  → **本项目 tsconfig 的硬性要求**。
- **错误边界只兜渲染/生命周期错误**：异步 handler 与 effect 抛的错会打穿到 app 级边界。
  → 所有会话写入与 IO 必须自己 try/catch。
- **`open()` 失败要显式处理**：宿主只写日志，用户看不见 → 自己 toast（`ctx.tuiToast`）。

## 3. 场景内可用的 UI 能力

### 3.1 公开面（`TuiSceneProps.ui`）

`Box`、`Text`、`ScrollBox`（含 `ScrollBoxHandle`）、`Spacer`、`Newline`、`NoSelect`、
`Image`、`Ansi`、`AlternateScreen`、`InputCaret`、`ThemeProvider`/`useTheme`、
`useInput`、`useStdin`、`useApp`、`useTerminalSize`、`useDeclaredCursor`、`useNativeCursor`、
`useCopyOnSelect`、`useAnimationFrame`、`useBlink`、`useTerminalImages*`、`render`/`createRoot`。

**不在公开面**（需要自己写或绕开）：`Button`、`ListItem`、`HintLine`、`Divider`、`Pane`、
`StatusIcon` 等 `components/design-system/*`；以及宿主的 `PromptEditor`（多行编辑器）。
参考实现在 `find-chrome.js`、`find-list.js` 里自建了一套 chrome，可照抄风格。

### 3.2 键盘

`ui.useInput(handler, { isActive?, prepend? })`，handler 收 `(input, key, event)`。
`key` 含方向键、`return`、`escape`、`tab`、`shift`/`ctrl`/`meta`/`super` 等。

全局入口另可用 `ctx.tuiShortcuts.register(combo, { description, handler }, identity?)`。
约束（已查实）：combo **必须带 ctrl 或 alt**；内置保留组合会拒并 warn；
**overlay（含场景）打开时快捷键不匹配**，只在普通聊天态生效
→ 快捷键只能用于「从聊天态打开场景」，场景内操作走 `useInput`。

参考实现的组合：`/find` 用 `alt+f` 作全局入口（避开终端自绑的 `Ctrl+Shift+F`）。

### 3.3 鼠标：**可用**（已证实）

- `ui.Box`（`ThemedBox`）原生透传 ink 鼠标事件，**无需包装**——
  参考实现只是给 Box 起了别名：`find-list.js:55-56` 的 `const WheelBox = Box; const ContextBox = Box;`。
- 可用事件：`onClick`、`onWheel`、`onMouseEnter`、`onMouseLeave`、
  `onDragStart`/`onDragMove`/`onDragEnd`、`onContextMenu`、`onKeyDown`、
  `tabIndex`、`autoFocus`，以及 `opaque`（弹层遮挡用）。
- 事件类：`ClickEvent`（`cellIsBlank` 可用于忽略空白列误点）、`DragEvent`、
  `ContextMenuEvent`、`PointerEvent`（`localCol`/`localRow` 按容器重算）。
  沿父链冒泡，`event.stopImmediatePropagation()` 阻止祖先 handler。
- **开启原因（已定论）**：`AlternateScreen.js` 的签名是
  `function AlternateScreen({ children, mouseTracking = true })`——
  **默认就是 true**；宿主 fullscreen 包装处 `React.createElement(AlternateScreen, null, …)`
  没传该 prop，走的就是默认开启。它写入 `ENABLE_MOUSE_TRACKING` 并调
  `setAltScreenActive(true, true)`，于是 `isAltScreenMouseTracking` 为真
  （注意 `ink.js:1346` 的 `mouseTracking = false` 只是被调用方的形参默认，
  不是实际生效值——别被它误导）。
- **实测旁证**：参考实现在列表行上用了 `onClick`/`onMouseEnter`/`onMouseLeave`、
  在滚动区用了 `onWheel`、在行上用了 `onContextMenu`（右键菜单）、
  在弹层上用 `onClick + stopImmediatePropagation` 做点击拦截——这些都在正式发布版里，
  说明在该宿主版本上确实投递。
- **两个已知陷阱**（参考实现踩过，直接抄结论）：
  1. **宿主不会给「被重渲染卸载掉的节点」发 `onMouseLeave`**（其 hover 派发跳过脱离节点）
     → hover 状态必须是**组件局部 state**，不能由父层按行号/行 id 持有，
     否则会出现「指针不在控件上却亮着」的错位高亮（其 REVIEW R-068）。
     同时行必须用**稳定 id 做 React key**，否则组件被复用，局部 hover 会跟着漂。
  2. **wheel 的 `deltaY` 是「格」自己的大小（宿主自己的界面每格 ±3）**，
     不能塌缩成 ±1；且 `deltaY === 0`（横向滚动）必须**不滚动**。
     它的 `wheelRows(deltaY, deltaX)` helper（`find-types.js:137`）可直接复用：
     非有限值或 deltaY 0 → 0，否则 `Math.max(1, Math.round(Math.abs(deltaY)))` 带符号返回。

### 3.4 编辑模式

- `ctx.tuiDialogs` 的 input 是**单行**、且有 500 单元格上限（`INPUT_CELLS = 500`）
  → 不适合改写整段回复。
- 宿主**没有**公开可复用的多行编辑器 → **编辑模式要自己在场景内实现**。
  参考实现的 `find-input.js`（302 行）是**单行查询输入**的完整键盘分发器，
  不是多行编辑器；但它把「一个 stdin chunk 里多个 key、React 批处理、
  ref 镜像先行写入」这套纪律写透了，直接照抄这套结构最稳。

## 4. 组件与数据流（建议）

```
ctx.commands.register('/rewrite')  ─┐
ctx.tuiShortcuts.register('alt+r') ─┤→ ctx.tuiScenes.open('dsh-tui-rewrite')
                                    │      （失败则 toast）
                          TuiSceneProps.channel ─→ 取当前会话的模型可见消息
                                    │
                    ┌───────────────┴───────────────┐
                    │ 列表模式：ScrollBox + useInput │
                    │  · 每段助手回复一行摘要         │
                    │  · ↑↓/jk 移动，Enter 进入       │
                    │  · 鼠标：onClick 选中、onWheel 滚动、右键菜单 │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │ 编辑模式：多行编辑器（自研）     │
                    │  · Esc 取消，提交后回列表        │
                    └───────────────┬───────────────┘
                                    │
              session.append('rewrite/message', { targetSeq, content })
```

**关键待答问题**：场景拿 `seq` 的路径。
- 命令 handler 里有 `invocation.agent.session`，但**场景由 `open()` 启动，拿不到 invocation**。
- 参考实现用**模块级变量**跨这两个点传值（`dsh-tui-find/main.js` 的 `pendingQuery`：
  命令 handler 存、场景挂载时消费一次）。同一手法可直接用于传 `session`。
  → 已证明可行，风险低。仍应顺手确认 `channel` 上是否直接带 seq（若有则更干净）。

## 5. 仍需实测的事项（阶段 1 前置，已缩短）

1. ~~鼠标是否投递~~ —— **已定论：可用**（第 3.3 节）。仍需在真机上确认一次手感
   （选中高亮、滚轮步长），以及**右键菜单是否与终端 / 宿主冲突**。
2. **`channel` 是否带 seq**：在场景里 dump `Object.keys(channel)` 与 rows 结构。
   若无 → 用模块级暂存 `invocation.agent.session`（参考实现同款手法）。
3. **场景内输入是否被正确接管**：场景内 `useInput` 与宿主 composer 的优先级
   （文档称 overlay 拥有键盘；需确认无双重处理）。

## 6. 修订后的分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **0** | 真实加载（不变）：最小插件经 profile 装载、投影注册、顺序竞态 | 与既有任务文件一致 |
| **1a** | 场景骨架 + 数据源：注册场景、`/rewrite` 与 `alt+r` 打开；实测第 5 节第 2、3 问 | 能打开空场景；两问有定论并落盘 |
| **1b** | 列表模式：列出助手回复（摘要 + 序号），键盘 **与鼠标** 选择 | 选中任一段能进入编辑模式 |
| **1c** | 编辑模式 + 提交：自研多行编辑器，提交后 `append` | `deriveMessages()` 回读为新文本；日志原文不变 |
| **2** | 双视图标记：`ctx.tuiRenderers` 渲染「已改写」记录行 | 屏幕上能看到改写标记 |
| **3** | 撤销 | 追加反向事件，模型可见文本回原文 |
| **4** | 健壮性：自检告警、轻量内核安静 pending、fork | 投影未注册时明确报错 |

## 7. 已识别的实现风险

- **自研多行编辑器是本项目最大的一块 UI 工作量**（宿主不提供公开组件）。
  建议第一版只做「整段替换式编辑」：全宽文本区，支持输入/退格/换行/方向键/Home/End，
  不做语法高亮与软换行折行；用 `ScrollBox` + 行级窗口化承载超长回复。
- **粘贴**：ink 的 `useInput` 在粘贴多字符时只回调一次、整串作为 `input` 传入 →
  编辑器必须处理「一次性多字符插入」，否则粘贴丢字符。
- **提交键**：`Ctrl+S` 在部分终端是 XOFF（暂停输出），`Ctrl+Enter` 在部分终端不可靠。
  参考实现的规矩是「**只有无修饰的 Enter 才能提交模态**」（`isPlainReturn`：
  `key.return && !ctrl && !meta && !shift && !super`），因为 Option/Shift/Ctrl+Enter
  会以 `return + modifier` 到达。→ 建议 **Enter 提交、Alt+Enter 换行**，并在界面上明写。
- **超长回复**：单段可能上千行，列表摘要必须按显示宽度截断
  （参考实现有 `truncateWidth`/`displayWidth` 工具，注意 CJK 宽度），
  编辑区必须窗口化，否则终端会卡。
- **键盘分发的批处理陷阱**（参考实现反复标注）：React 会把**一个 stdin chunk 里的
  多个解析后的 key 批量处理**，handler 可能在一次重渲染前跑多次 →
  分支判断必须读**同步镜像 ref**（handler 里立刻写），位置编辑走函数式 setState。
  不守这条会出现「按键跳两格」「按了没反应」这类难查的 bug。
