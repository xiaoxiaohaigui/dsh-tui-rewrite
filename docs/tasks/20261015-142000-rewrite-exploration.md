# 20261015-142000-rewrite-exploration - 初期探索：需求边界与开发路径

- 状态：进行中（阶段 0、1a 已完成；1b **真机验收通过**；1c 真机通过 6/7，
  **只剩 C2 的方向键/Home/End/退格待人工复核**；审查记录见 REVIEW.md）
- 负责人：DSH agent 会话（2026-10-15）
- 更新时间：2026-10-15 22:40 +0800
- 来源：用户请求「阅读 HANDOFF.md，进行初期探索，明确需求和发展路径」；上源 `C:/Users/86198/dsh-rewrite-poc/HANDOFF.md`
- 工作位置：`D:/dsh-tui-rewrite`（`git init` 已完成；基线提交 `6f706e4` 已于 2026-10-15 落地，此前「无提交不可回退」的风险已消除）

## 目标与完成条件

- 目标：把 HANDOFF 的可行性结论转成**可执行的需求边界 + 分阶段开发路径**，并打掉最高风险的未知项。
- 完成条件：
  1. 环境事实与接缝结论在本工作区重新实测核对（不依赖交接文档的口头结论）。
  2. 明确「用户如何选中一条消息并拿到 `seq`」的可行路径（HANDOFF 自认的最大未知）。
  3. 给出可执行的分阶段计划，每阶段有可判定的验收标准。
  4. 列出必须由用户拍板的需求问题。

## 范围与所有权

- 负责文件或模块：本文件；`docs/explore/*.md`（侦察产出）。
- 不在范围内：插件实现代码、profile 安装、任何远程仓库操作。
- 协作约束：两个后台侦察子代理各写一个 `docs/explore/` 文件，与本文件互不重叠。

## 当前状态

- 已完成：环境核对、接缝复核、核心工程路径打通、两处 POC 未覆盖的风险点实测（见下）。
  第 3 节（命令到 seq 通路）、第 8 节（打包与接入形式）均已查清，HANDOFF 的两个最大未知不再是未知。
- 已完成（续）：**阶段 0 全部通过**。headless 断言 28 项（插件包落地、投影注册与叠加语义、
  顺序竞态排除、静默失效有可见告警、真实组合树确认）；
  **真机启动验证通过**（2026-10-15，用户确认界面与功能正常，启动用 dst）。
  记录见 [docs/explore/phase0-results.md](../explore/phase0-results.md)。
- 已完成（续）：**阶段 1a 全部通过**（自动化 60 项 + 真机 A1–A8，用户 2026-10-15 实测）。
  现场日志锁定了一个关键事实：apply 时 `tuiScenes` 尚不存在（`scene:false`），439 ms 后才
  `scene registered` —— 晚挂载轮询不是防御性编程，是本机的实际启动路径。
  完整记录见 [docs/explore/phase1a-results.md](../explore/phase1a-results.md)。
- 已完成：用户安排的一轮代码审查（2026-10-15 17:37–17:43）。产出 [REVIEW.md](../../REVIEW.md)：
  **11 条未关闭**（1×P1、3×P2、7×P3），5 条已关闭（含 C6「插件缺失时日志可读」实测成立）。
  审查基线复跑：60 项测试全绿、`npm run report` 5 项 RESULT 全 true。
  遗留的观测改进已落地：`applied` 行不再带入口布尔，改为各入口落地行 +
  `entry points verified` 自检汇总（见 phase1a-results 第 3.2 节）。
- 审查的关键发现（决定后续范围）：
  1. **R-001（P1）**：`src/scene.js` 编辑模式读的是**渲染期**镜像 `mirrors.draft`/`mode`，
     而 handler 只走 `setDraft`、从不回写镜像 —— 一个 stdin chunk 内多键会丢字
     （实测 `X`+`Y` 得 `HELLOY`），`Esc` 后同 chunk `Ctrl+S` 还会提交已取消的草稿。
  2. 代码**超出记录**：`scene.js` 已含 1b 的列表选择/鼠标/滚轮/视口跟随与 1c 的多行编辑+提交
     （此前记录只承认 1b 的 `↑↓`/`jk` 基础实现）。
  3. 但按 PLAN 自己的定义，1b/1c **均未完成**：缺 **hover**（1b B5）与 **Home/End**（1c 范围）。
  4. `scene-render.test.mjs` 的 13 项虽记为 1a 证据，却依赖 1b 行为（按 `onClick` 数行、断言 `❯` 选中标记）。
- 已定口径（用户 2026-10-15 决定）：**不回退、不删**这段 1b/1c 代码，改为修完审查问题后继续推进；
  修复由**新会话**执行；修复前建议先落基线提交（仓库尚无提交）。
- **已执行（2026-10-15 新会话）**：基线提交 `6f706e4`（40 文件，修复前快照），随后按
  P1 → P2 → P3 顺序修审查条目，每条一个提交。R-004 的记录修正已落到 `PLAN.md`
  与 `docs/explore/phase1a-results.md`：1a 一节不再声称「不做编辑与提交」，
  1b 记为「仅剩 hover」，1c 记为「仅剩 Home/End 且无真机记录」。
- 自动化侧基线：**81 项测试全绿**（修复轮次时为 60 项）—— 1a 阶段新增
  `scene-render.test.mjs`（模拟 hook 运行时直接驱动场景组件）、
  `seam.test.mjs`（10 项，晚挂载轮询）、`debug.test.mjs`（3 项，现场证据通道的行形状）；
  `plugin.test.mjs` 增补 resolver / 场景注册 / 命令双路径 / 开场景失败可见 / 晚挂载端到端。
  实现中发现并修掉四处会让验收项直接失败的缺陷（宿主不给场景 session、
  条件 return 错位 hook 槽、ref 镜像两套账、缝合点晚挂载静默失效），记录见
  [docs/explore/phase1a-results.md](../explore/phase1a-results.md)。
  修复轮次新增 21 项：输入 handler 直接用例 6 项（此前零覆盖）、畸形改写事件 1 项、
  实例状态隔离与自检归属 2 项、空草稿拒绝 2 项、镜像稳定性 2 项、
  非数组 content 降级 1 项、渲染期无副作用 1 项、声明文件一致性 6 项。
- 阻塞项：无。`dsh --profile dsh-tui` 在本机静默挂起，与本项目无因果（profile 完好、
  组合正常、当时无本项目任何行），已改用 `dst` 并记入决策文件；该问题独立跟踪。
- **审查问题修复已完成（2026-10-15 新会话）**：REVIEW.md 的 11 条未关闭问题全部修复并
  移入 Closed（`Open` → `Verified`），Active 区现为空。R-001 已按预期列为第一项。
  每条一个提交，逐条验证结果与提交号见 [REVIEW.md](../../REVIEW.md) 的「修复轮次」一节，
  条目细节不在此复制。自动化基线 **81 项全绿**（审查基线 60 项；修复过程新增 21 项），
  `npm run report` 5 项 RESULT 全 true。
  修复轮次顺带修正了记录与代码的双向不一致（R-004）：1a 不再声称「不做编辑与提交」，
  1b 记为「仅剩 hover」，1c 记为「仅剩 Home/End 且无真机记录」，见 PLAN 对应阶段。
- **1b/1c 实现已补齐（2026-10-15 新会话，提交 `37b47bc`）**：hover 局部 state（稳定 `seq` 为键）、
  `lineEndOf` + Home/End 分发。自动化 **91 项全绿**，`npm run report` 5 项 RESULT 全 true
  （修复轮次 81 项 → 本次 +10）。细节与实现取舍见
  [docs/explore/phase1a-results.md](../explore/phase1a-results.md) 第 6 节，不在本文件复制。
  两条值得单记的事实：
  1. **滚轮与「视口跟随选中项」争同一个 `scroll`**：朝选中项所在边缘滚的那一步会被立刻
     回置（新开列表选中第 0 行时向下滚正是这一类；定点复算见 phase1a-results 6.2，数字已按
     REVIEW.md R-018 订正）。已改为滚轮移动选中项。
  2. **测试运行时自身失真**：模拟 hook 运行时的 `useInput` 累加 handler、
     `useState` 每次新建 setter，都会让「实现正确、测出来错误」。已按 React 语义修正。
- **1b/1c 真机验收（2026-10-15，第二轮会话）**：用自建 ConPTY 宿主在真实 dsh-tui 进程内
  跑完 B1–B5 与 C1、C3–C7，并真的提交了一次改写（`rewrite appended targetSeq 16 eventSeq 349`），
  工件回放 C1–C6 硬不变式 8/8。完整现场证据、复现方法、方法与坑见
  [docs/explore/phase1b-1c-results.md](../explore/phase1b-1c-results.md)，不在本文件复制。
  两条必须记住的操作规则（同文第 5 节）：**夹具会话一律放独立 DSH_HOME**（把身份不自洽的
  会话塞进真实库会让 dsh-workspace 启动即抛错、TUI 起不来）；**helper 进程按 PID 杀**
  （`taskkill /IM node.exe` 会连宿主一起杀）。
- 下一步：**只剩 C2 的按键分支人工复核**（方向键 / Home / End / 退格：ConPTY 注入无法忠实
  投递 ESC 前缀按键，需在真实终端里走一遍）。其余阶段收尾项见
  [docs/PLAN.md](../docs/PLAN.md) 第 4 节。
- 真机挂载：**当前为已挂载状态**（2026-10-15 第二轮，`node test-harness/mount.mjs`）——
  junction + patch 行均在位，`dsh --profile dsh-tui --dump-config` 含本插件行，
  真实 `~/.dsh` 未被夹具写入（前后 slug 数一致）。回滚命令 `node test-harness/unmount.mjs`；
  挂载前备份 `cordis.patch.yml.bak-rewrite-mount-2026-10-15T12-54-46-488Z` 保留。
- 阶段划分、验收标准、测试策略与风险登记已独立成 [docs/PLAN.md](../PLAN.md)；
  架构决策见 [docs/decisions/](../decisions/)。本文件保留为本次探索的任务记录。

---

## 1. 环境核对结果（本工作区实测）

| 项 | HANDOFF 声称 | 本次实测 | 判定 |
|---|---|---|---|
| dsh | 0.2.0-rc.2 | package.json version 0.2.0-rc.2 | 一致 |
| dsh-tui | ^0.15.0 | 安装版本 **0.15.0** | 一致 |
| Node | v24.18.0 | v24.18.0；zstdDecompressSync = function | 可用 |
| MESSAGE_PROJECTION_EVENT_TYPES | Set(["image/offload"]) | dsh-session/lib/index.js:141 仍为 new Set(["image/offload"]) | 未变 |
| registerMessageProjection(projection) | 返回 fiber-owned disposer | dsh-session/lib/types/index.d.ts:347 签名未变，@throws 重复类型 | 未变 |

**新增观察**（HANDOFF 未记录）：dsh-session 的 exports 已开放 `./surface` 子路径，
投影类型可从 `@deepseek-ai/dsh-session/surface` 正常导入，不必依赖内部路径。
`./types`、`./fork`、`./invariant` 同样开放。

## 2. 接缝复核：投影链是可叠加的（官方语义，代码确认）

dsh-session/lib/index.js 的 fold 状态携带 `projectedMessages: Map`，
`planSurfaceEvent`（:434）把**累积的** `state.projectedMessages` 交给下一个投影：

```js
const projection = projections.find((item) => item.type === event.type);
if (projection !== void 0) return { kind: "project", projection,
  messages: projection.project(event, { nodes: state.nodes, events, baseSeq,
    messages: state.projectedMessages }) };   // 累积态，非空 Map
```

`applySurfacePlan`（:467）随后 `state.projectedMessages.set(seq, message)` 覆盖。

**直接含义**（比 HANDOFF 第 4 节断言 8 更进一步）：

- 同一 targetSeq 被多次改写时，**后写的投影看到的是前一次改写后的内容**，天然「后者胜出」，无需特殊处理。
- **撤销可以零成本实现**：追加一条新改写事件即可覆盖前一条，不需要删除历史事件。
- 投影返回空 Map 即等于「这条不改」，可用于实现「恢复原文」。

## 3. 打通的核心路径：命令到 seq

HANDOFF 第 9 节把「用户选中消息并拿到 seq」列为最大未知。本次已找到通路：

```
/rewrite 命令 handler
  -> CommandInvocation.agent        （dsh-commands/lib/types/index.d.ts:23）
  -> agent.session                  （dsh-agent/lib/types/runtime-types.d.ts:143
                                     "The live session this agent drives"）
  -> session.surface.nodes          （seq 数组，模型可见顺序）
  -> deriveEventMessage / deriveMessages   枚举文本，展示给用户选
  -> session.append('rewrite/message', { targetSeq, content })
```

参考实现 **dsh-tui-find** 已经把「命令注册到打开 UI」这条链路跑通，可直接照抄其形态：

- `inject = ['agents']`（必需；缺失则插件保持 pending，而不是半死状态）；
- 经 `ctx.get('tuiPluginHost', false)` **软探测**宿主；
- 优先 `tuiPluginHost.registerCommand(ctx, contributionId, definition)`；
- 该宿主路径**当前必然失败**（见 4.2），回落到 `ctx.get('commands', false).register(definition)`；
- 每个注册都用 `ctx.effect` 绑定生命周期。

**结论**：seq 通路成立，不是阻塞项。真正要设计的是「用户怎么选」的交互形态。

## 4. 两处 POC 未覆盖的风险（本次实测）

### 4.1 第三方事件类型会被日志读取路径放行，但语义上不安全

实测（样本会话，seq 296 起追加，foldSurface 与 Session.create 各跑一遍）：

| 追加的事件 | 结果 |
|---|---|
| `{type:'probe/a', data:{x:1}}`（裸未知类型） | 通过 |
| 裸未知类型 + `surfaceOp:'append'` | 失败：session event "probe/a" is not surface-eligible and cannot carry surfaceOp |
| 裸未知类型 + `ignorable:true` | 通过 |
| 裸未知类型 + `ignorable:true` + `surfaceOp:'append'` | 通过（surfaceOp 被静默忽略） |

- **必须遵守**：`rewrite/message` 事件**绝不能携带 `surfaceOp`**（它非 surface 事件类型）。HANDOFF 第 7 节骨架这一点是对的。
- **`ignorable` 闸门在本版本是死代码**：`surfaceOpOf`（lib/index.js:296-299）写的是
  `if (!KNOWN.has(type) && event.ignorable === true) return;`，该 `return` 之后函数本就结束，
  所以未知类型无论有没有 `ignorable` 都被放行。`known-event-types.d.ts` 头注释宣称的
  「未知类型默认拒绝，除非带 `ignorable`」**对第三方事件类型并不成立**。
- **而且第三方设不了 `ignorable`**：`Session.append`（:1441-1459）只从 opts 取
  `sourceEventSeqs` 与 `surfaceOp`，**没有 `ignorable` 参数**；塞进 `data` 只会变成数据字段而非信封字段。
- **净效果**：插件卸载后日志仍可读（HANDOFF 第 5 节「不毁档」方向成立），
  但机制不是 `ignorable`，而是**闸门根本没生效**。风险是：一旦上游修正该闸门，
  存量日志会集体变成「不可读」。
- 附带收益：追加裸未知类型**不会**改变 surface.nodes（实测 120 到 120），不污染人类可见记录。

### 4.2 宿主的中介注册当前必然失败

dsh-tui-find 源码注释（dist/main.js:210-218）明确记载：
`tuiPluginHost.registerCommand` 要求 verified admission identity，而当前宿主运行时**不签发**
（cordis-plugin-loader 从不调用 admit），实践中抛 `COMPONENT_NOT_ADMITTED`。

因此本项目必须实现同样的「中介优先 + 直接注册回落」双路径，并把回落当正常路径而非异常。
这会削弱 `commands.invoke` 的按属主授权（C-070 边界），属已知取舍。

## 5. 需求边界（承接 HANDOFF 第 1 节，未变）

**做**：用户**手动**改写会话历史中 AI 回复的文本；下一轮模型看到改写版；持久化日志原文不变。

**不做**：任何自动改写、拒绝检测、模式匹配、自动替换策略。

本次探索未发现需要推翻该边界的证据。补充一条推论：
由于第 2 节的「投影链可叠加」，**撤销不需要新机制**，它只是再追加一条改写事件。
这把 HANDOFF 第 9 节里「可选的撤销」从设计问题降级为交互问题。

## 6. 开发路径（建议，按风险排序）

| 阶段 | 内容 | 验收标准 | 风险 |
|---|---|---|---|
| **0** | 真实加载：最小插件经 profile 装载 | **headless 已完成**：`ctx.sessions` 可用、投影恰好注册一次、会话先于注册也能改写（竞态排除）、静默失效有告警、组合树已确认。真机启动待用户 | 已消解 |
| **1a** | 场景骨架与数据源：注册全屏场景，`/rewrite` 与快捷键（如 `alt+r`）打开；定「场景如何拿到 seq」 | 能打开空场景；`channel` 是否带 seq 有定论（否则用模块级暂存 `invocation.agent.session`） | 中 |
| **1b** | 列表模式：列出各段助手回复（摘要 + 序号），键盘与鼠标选择 | 选中任一段能进入编辑模式；鼠标点击/滚轮/右键可用 | 中 |
| **1c** | 编辑模式与提交：自研多行编辑器，提交后 `append` 改写事件 | `deriveMessages()` 回读为新文本；日志原文不变 | **中高**（多行编辑器是最大 UI 工作量） |
| **2** | 双视图标记：让用户看到「这条已被改写」 | 追加一条 log-only 事件 + `ctx.tuiRenderers.register` 渲染为记录行；屏幕仍显示原文但带改写标记 | 低（渲染器契约已确认：text-only，不能遮蔽内置类型投影） |
| **3** | 撤销与恢复原文 | `/rewrite --undo <seq>` 追加反向改写事件，模型可见文本回到原文 | 低（机制已在第 2 节确认） |
| **4** | 健壮性：自检告警、Claude 与 Codex 内核下安静 pending、fork 行为 | 投影未注册时明确报错而非静默失效；轻量内核对 ctx.sessions 保持 pending 不崩 | 中 |
| — | **不建议先做**：flatten（HANDOFF 第 5 节已降级为非必需）；拒绝检测等自动化（明确出界） | | |

## 7. 待定问题

### 需要用户拍板（影响外部行为与 UX 形态）

- **U1 选择器形态 —— 已定（用户 2026-10-15）**：走**强交互**路线。
  `/rewrite` 命令或全局快捷键打开**全屏场景**，场景内**列出各段助手回复**，
  用户用**键盘或鼠标**选中一段后进入该段的**编辑模式**改完提交。
  不做「按序号/倒序定位」的命令行式选择。
  契约与可用能力详见 [docs/explore/scene-design.md](../explore/scene-design.md)。
- **U2 改写的作用域 —— 已定（用户 2026-10-15）**：**只做文本修改**，
  即只改 `type:'text'` 的 part；工具调用参数与 `tool/result` 明确不做。
- **U3 历史幂等与上游兼容**：是否接受「依赖当前未生效的未知事件闸门」这一事实？
  可选的保守做法是给事件类型加命名空间前缀，并在插件内做版本自检，同时把该问题上报上游。

### 工程上待验证（阶段 0 一并打掉）

- 插件经 profile 真实加载后，**投影注册顺序**是否晚于会话恢复（HANDOFF 第 6.7 节推断）。
- `ctx.sessions` 在 Claude 与 Codex 轻量内核下 pending 的实际表现。
- fork 子会话 seed 父会话（含改写事件）时投影是否同样注册。
- TUI 屏幕是否**真的**不会自动变（HANDOFF 未验证面 4），以及需不需要主动刷新。
- 场景内 `channel` 是否直接带 `seq`（否则用模块级暂存 `invocation.agent.session`）。
- 场景打开的 overlay 状态下，宿主 composer 是否彻底让出键盘（无双重处理）。

已定论（原疑似项）：~~鼠标是否可用~~ —— **可用**。`AlternateScreen` 的
`mouseTracking` 形参默认即为 `true`，宿主 fullscreen 包装未传该 prop 因而走默认开启；
参考实现 `dsh-tui-find` 在正式发布版里就用了 `onClick`/`onMouseEnter`/`onMouseLeave`/
`onWheel`/`onContextMenu`。详见 [docs/explore/scene-design.md](../explore/scene-design.md) 第 3.3 节。

## 8. 打包与接入形式（补齐侦察缺口）

### 8.1 一个第三方插件的最小文件集

参照已在本机跑通的 dsh-tui-find 与 dsh-ops：

| 文件 | 必需 | 作用 |
|---|---|---|
| package.json | 是 | main 与 exports 指向入口；type: module；engines 声明 Node；dsh.bundle.patch: ./cordis.patch.yml |
| cordis.patch.yml | 是 | 挂载行：- insert: 一个到多个行（id / name / config / disabled） |
| dsh-plugin.json | 建议 | 社区清单：id / version / manifestVersion "0.15"、facets.host.{entry, apiVersion "v1alpha1"}、requires.contracts、permissions、contributes.commands |
| peerDependencies | 是 | 声明 @deepseek-ai/cordis、@deepseek-harness-tui/dsh-tui，按需 @deepseek-ai/dsh-session 等 |

dsh-ops 的 patch 展示了多行与 disabled 用法；dsh-tui-find 展示了单行最简形态。

### 8.2 安装与挂载

官方路径（cordis.patch.yml 注释里写明）：

    dsh plugin --profile dsh-tui add dsh-tui-rewrite
      -> pnpm 安装到 profile
      -> 把包名追加进 profile package.json 的 dsh.profile.bundles
      -> 应用本包自带的 ./cordis.patch.yml 挂载行

手动路径（开发期更实用）：把行插进 $DSH_HOME/profiles/dsh-tui/cordis.patch.yml：

    - insert:
        - id: dsh-tui-rewrite
          name: 'dsh-tui-rewrite'

**约束**（configuration.md:183-184）：不要对同一 profile 重复 insert 同名行，
也不要同时用 dsh plugin add 挂同一个包。

### 8.3 插件行的装载顺序（关键）

plugins.md 原文：**「界面先挂、profile 后组合，插件行在首帧之后激活」**，
且「在首个 TUI 行之后激活的行，apply 里不能用 ctx.root 的能力」。
同时：**apply 里等待会拖住组合**，耗时工作必须脱离 apply 启动、不要 await。

**对本项目的直接约束**：投影注册必须发生在 apply 的**同步段**，且要接受
「会话可能先于插件恢复」这一事实。这正是 HANDOFF 第 6.7 节的顺序风险，
也是阶段 0 的核心验收项。

### 8.4 可用的 TUI 扩展点（本机 0.15.0 实测枚举）

ctx.tui* 服务共 12 个：tuiPanels / tuiPluginHost / tuiDialogs / tuiScenes /
tuiPluginStorage / tuiShortcuts / tuiMessageObserver / tuiEffectLedger /
tuiToast / tuiThemes / tuiStatus / tuiRenderers。

与本项目相关度排序：

1. **ctx.commands（非 tui 前缀）** —— 命令入口，见 4.2 的双路径。
2. **ctx.tuiRenderers.register(type, renderer, identity?)** —— 把 log-only 事件投影成
   记录行，**正是「这次改写了哪条」的人类可见标记**。契约要点：仅文本
   （{title?, lines}）、会剥控制字符、不能遮蔽内置事件类型、抛错只跳过该事件。
3. **ctx.tuiDialogs** —— 交互式选择与输入（U1 的候选实现）。
4. **ctx.tuiScenes** —— 全屏场景（重交互备选）。
5. **ctx.tuiMessageObserver** —— messages.observe 契约：assistant/message 映射为
   message.sent，信封 sequence 就是该会话事件的 seq，eventId 形如 <sessionId>:<seq>。
   需要 messages.observe.read 授权（默认拒绝）与 scope = session:<id> 精确匹配，
   且**至多一次、无重放**。属可选旁路，不作为主选择器（它不解决「用户选了哪条」）。

## 验证

- `node -e "console.log(typeof require('node:zlib').zstdDecompressSync)"`：通过，function。
- `node probe2.mjs <样本会话>`：通过。确认追加事件真实形态为
  `{"type":"rewrite/message","seq":297,"time":...,"data":{"targetSeq":16,"content":"NEW-TEXT"}}`，
  无 `ignorable` 字段；无投影重开与 `foldSurface` 均不抛错。
- `node probe4.mjs <样本会话>`：通过。第 4.1 节四组对照结论如上表。
- HANDOFF 第 12 节的 `poc.mjs` 与 `final.mjs`：**未运行**（本次改用 `probe*.mjs` 覆盖了同一断言面；
  若阶段 0 需要基线对照再补跑）。

- 两个后台侦察子代理（会话与 seq 映射、插件打包准入）：**未产出文件即被中断**。
  第 3 节与第 8 节的结论由主会话自行查证，不依赖其产出；
  剩余空白是 plugin-template 仓库的官方骨架原文（本机未安装该仓库），
  以及 `docs/explore/` 里更细的会话事件数据表，可在阶段 0 按需补做。

- 场景接缝与 UI 能力核对（2026-10-15 第二轮）：**通过**。已查实
  `ctx.tuiScenes` 的 register/open/close 契约、`TuiSceneProps` 四个字段、
  宿主在 `screens/Chat.js:5538` 替换会话视图渲染场景（外包 `PluginSceneBoundary`）、
  `ui` 公开面清单，以及鼠标事件的实际可用性（见 `docs/explore/scene-design.md`）。
- 参考实现交叉验证：`dsh-tui-find` 的 `main.js`（命令注册双路径）、
  `seam.js`（seam 晚挂载轮询）、`find-list.js`（`WheelBox = Box` 与鼠标行交互）、
  `find-input.js`（键盘分发与 ref 镜像纪律）、`find-types.js:137`（`wheelRows`）。

## 相关内容

- 决策：暂无（docs/decisions 尚未建立；阶段 0 的接缝与装载方式确定后应补一条）。
- 变更或评审：无 git 仓库，无 commit。
- 风险与遗留：第 4.1 节的未知事件闸门是**新发现的上游风险**（HANDOFF 未记录）。
  建议在阶段 0 前先向上游确认 MESSAGE_PROJECTION_EVENT_TYPES 与 ignorable 的预期语义，
  否则未来 dsh 小版本升级可能让存量日志不可读。