# REVIEW.md - dsh-tui-rewrite-working-tree

- 范围：第二轮 —— `5e0fa5e..0ecbd33` 的插件增量（1b/1c：hover、滚轮、Home/End）及其记录；
  工作树与 HEAD 一致。第一轮的审查对象是当时的整个工作树
  （`packages/dsh-tui-rewrite/`、`test-harness/`、`package.json`、`docs/`、`HANDOFF.md`）
- 审查者：AI 助手（DSH agent 会话）
- 时间：2026-10-15 22:40（第一轮 17:37 及其修复轮次；第二轮 1b/1c 增量；第二轮附真机验收）
- 状态：已完成（R-001–R-018 全部关闭；真机 B1–B5 通过、1c 通过 6/7）
- **R-019（P1）未关闭**：真机轮次发现「提交过改写的会话无法再被恢复」，见「真机验收轮次」第 3 条

## 审查基准

对照物：`docs/PLAN.md` 第 0 节不变式 C1–C8 与各阶段验收项、`docs/decisions/` 五份 ADR、
`HANDOFF.md` 的七条硬约束，以及 `@deepseek-ai/dsh-session` 0.2.0-rc.2 与
`@deepseek-harness-tui/dsh-tui` 0.15.0 的实际实现（读取本机安装副本源码，非注释推断）。

第二轮（1b/1c 增量）额外核对的本机宿主源码：
`lib/types/ink/events/input-event.js`、`ink/parse-keypress.js`、`ink/hit-test.js`、
`ink/components/App.js`、`ink/ink.js`、`screens/Chat.js`、`dsh-adapter/channel-scene-outlet.js`。

## 修复轮次（2026-10-15）

审查基线先落为提交 `6f706e4`（40 文件，修复前快照），随后按 P1 → P2 → P3 逐条修复：

| 提交 | 条目 |
|---|---|
| `889753a` | R-001 |
| `b16f086` | R-002 |
| `a82a5b6` | R-003 |
| `ce1feb3` | R-004 |
| `cf73288` | R-005、R-006 |
| `1b5c11e` | R-007、R-008、R-009、R-010 |
| `a9abfff` | R-011 |

修复后的验证命令与结果：

| 命令 | 结果 |
|---|---|
| `npm test` | **81 项全绿**（审查基线 60 项；修复过程新增 21 项） |
| `npm run report` | 5 项 RESULT 全 true |
| `node test-harness/build-fixture.mjs` | 通过；`DSH_REWRITE_PROFILE=C:/nope/nowhere` 时在写入前即报错退出 |
| 临时探针（跑完即删，未入库） | 复现 R-001 两种后果；空文本提交与 R-011 定时器行为 |

未覆盖：真机（无终端，未执行 `dst`）。阶段 1a 的 A1–A8 由用户于 2026-10-15 实测通过；
1b/1c 的真机验收仍无记录，见 R-004 与 `docs/PLAN.md` 对应阶段。

## 审查轮次（2026-10-15，1b/1c 增量）

对象：`37b47bc`（hover、Home/End、滚轮改由选中项驱动）与 `0ecbd33`（记录指向该提交），
以及同批的 `docs/PLAN.md` 1b/1c 一节、`docs/explore/phase1a-results.md` 第 6 节、
`docs/tasks/20261015-142000-rewrite-exploration.md` 的状态更新。

方法：逐行读增量差异；把每条新依赖的**宿主行为**回到本机安装副本的源码里核实（不靠注释推断）；
再跑全量自动化。

| 核对项 | 结论 | 证据 |
|---|---|---|
| `key.home` / `key.end` 在本机宿主确实存在 | 成立 | `lib/types/ink/events/input-event.js:15-16`（`home: keypress.name === 'home'`）；Windows VK 映射 `ink/parse-keypress.js:140-141`（VK_END/VK_HOME）；宿主自家组件同款用法 `screens/Launchpad.js:747`、`screens/Chat.js:4407` |
| `userMessageBackgroundHover` 是合法主题色 | 成立 | 宿主多处用它做行 hover 底色：`components/design-system/ListItem.js:67`、`components/approvals/ApprovalPanel.js:199`；`guide/dsh-tui-guide/themes.md:118` 列在消息类色板里 |
| 场景内的鼠标事件能到达插件节点 | 成立 | 场景渲染在 Chat 自己的树里（`screens/Chat.js:5537-5543`，非独立 root），hover 走 `hitTestWithOverlays`；滚轮由 `dispatchWheel` 从最深命中节点**向上冒泡**，容器上的 `onWheel` 收得到（`ink/hit-test.js:324-339`） |
| "宿主不给被卸载节点发 leave" | 成立 | `ink/hit-test.js:507-523`：离开集合里先 `if (old.parentNode)` 才调 `onMouseLeave` |
| `onMouseLeave` 的 `current === seq` 守卫是必要的 | 成立 | 宿主同一次指针移动先发 leave 再发 enter（同文件 507-535）；守卫写法与宿主自家一致（`components/questions/PlanReviewPanel.js:353`） |
| "滚轮与视口跟随抢同一个 state" | 成立（数字口径见 R-018） | 用旧公式定点复算：选中第 0 行时 d=+3/+1/+20 全部被跟随 effect 回置到 0；选中第 10 行时 d=+3 保留为 3 |
| hook 槽位纪律 | 成立 | `scene.js:243-290` 的全部 hook 在 `scene.js:448`、`scene.js:464` 的条件 return 之前；新增的 `hoverSeq` 追加在固定顺序中，未改变既有槽位含义 |
| 镜像纪律（handler 只读镜像） | 成立 | 新增 Home/End 走 `move`(=`writeCaret`) 与两个纯函数，没有引入"渲染路径回写镜像"；hover 不进镜像的理由（无键位读指针）已写在模块注释 `scene.js:33-40` |
| 声明文件与运行导出一致 | 成立 | `lineEndOf` 在 `scene.d.ts:42-46` 声明，`types.test.mjs` 的子路径集合比对通过 |
| 自动化 | 91/91 通过；`npm run report` 5 项 RESULT 全 true | `npm test`、`npm run report` |

观察（不判为问题）：`scene.js:517` 的 `onWheel` 用渲染态 `targets.length` 做夹取上界，
是这条 handler 里唯一没走镜像的读。两者由同一条语句写入（`writeTargets`），且任何 state 变更都会先重渲染，
取不到不同值；仅与文件自述的镜像纪律不同源，后续改动该段时建议换成 `mirrors.targets.current.length`。

## 真机验收轮次（2026-10-15）

本轮把 1b/1c 的验收项放进**真实 dsh-tui 进程**里跑（真实 profile + 已挂载的本插件 + 真实会话）。
方法、原始证据与复现步骤见 [docs/explore/phase1b-1c-results.md](docs/explore/phase1b-1c-results.md)，
这里只留结论与它对本审查的影响：

| 项 | 结果 | 关键证据 |
|---|---|---|
| B1 键盘移动 + 高亮 | 通过 | 每次移动的字节差分：旧行重画为普通文本，新行带 \`38;2;213;81;127\` + \`48;2;243;215;224\` + \`1m\` |
| B2 视口跟随 | 通过 | 14 行终端（可见 9 行）连按 10 次 \`j\`：窗口从 \`seq 16\` 滚到 \`seq 69\`，选中行始终可见 |
| B3 点击选中 | 通过 | 宿主 \`dispatchClick {col:9,row:9,handled:true}\`，选中标记与底色落到该行 |
| B4 滚轮步长 | 通过（纵向） | 一格 = 宿主 \`deltaY 3\` → 选中项 ±3 行；横向事件宿主报 \`deltaY 0\`，由 \`wheelRows\` 归零（单元测试锁定） |
| B5 hover | 通过 | 指针移入/移出/换行时，\`48;2;240;220;230\`（主题 hover 色）落在**同一行**且随之撤销 |
| C1/C3–C7 | 通过 | 真机提交了一次改写（\`rewrite appended targetSeq 16 eventSeq 349 chars 112\`），工件回放 C1–C6 硬不变式 **8/8** |
| C2 | 部分 | 插入、\`Enter\` 换行、整段粘贴已确认；方向键/Home/End/退格**无法经 ConPTY 忠实投递**（conhost 把 VT 键序列拆成逐字符事件，宿主只看到孤立 ESC），待人工复核 |

两条与本审查直接相关的结论：

1. **R-017 的判断被真机证实**：hover 只在指针移动时更新，静止指针下不会重算（真机差分里
   hover 底色由指针事件驱动，没有"提交后重算"的痕迹）。因此 B5 的判据必须写成
   "移动指针后高亮指向指针所在行"。
2. **R-018 涉及的滚轮行为在真机上确认**：一格 = 3 行，改为"移动选中项"后视口跟随生效；
   记录里的旧数字按 R-018 订正。
3. **发现 P1（R-019）**：**提交过改写的会话无法再被打开**。恢复路径
   （`dsh-session-persistence/lib/index.js:184`）要求「未知事件类型必须带 `ignorable: true`」，
   而 `Session.append`（`dsh-session/lib/index.js:1441-1459`）只接受 `surfaceOp`/`sourceEventSeqs`，
   插件**没有**任何公开途径写下这个标记 —— 于是含 `dsh-tui-rewrite/message` 的日志被整份拒绝。
   真机现象：`DSH 会话没能打开：dsh-tui: cannot resume session "<id>": session "<id>" contains
   event type "dsh-tui-rewrite/message" (seq N) unknown to this harness and not marked ignorable;
   refusing to interpret the log`，随后退回启动页。这与 ADR/PLAN 里「闸门是死代码」的记录相反
   （旧结论来自 seed 路径；**恢复路径是活的**）。

## Active

| ID | 级别 | 位置 | 问题/证据/影响 | 状态 | 验证 |
|---|---|---|---|---|---|
| R-019 | P1 | `packages/dsh-tui-rewrite/src/main.js`、`src/projection.js`（改写事件的信封）；上游 `dsh-session-persistence/lib/index.js:184` 与 `dsh-session/lib/index.js:1441-1459` | **提交过改写的会话无法再被恢复**：日志读取器拒绝「未知类型且未标 `ignorable`」的事件，而 `Session.append` 不提供写该标记的途径，插件因此必然写出"不可再打开"的会话。真机证据（同一夹具、只差一条事件）：<br>① 原样拷贝 → 正常进会话（`scene opened`，12 目标）；<br>② 只追加**一条** `dsh-tui-rewrite/message` → 启动页 + `cannot resume session "…": session "…" contains event type "dsh-tui-rewrite/message" (seq 296) unknown to this harness and not marked ignorable; refusing to interpret the log`；<br>③ 同一文件改用逐行重编码（无该事件）→ 恢复正常；<br>④ 该事件加 `ignorable: true` → 恢复正常（12 目标）。<br>影响：插件当前形态下，用户**一旦真的提交一次改写，该会话就再也打不开**（TUI 退回启动页；其余会话与插件加载不受影响）。这也推翻了 ADR `2026-10-15-event-type-namespace` 与 PLAN R1 里「闸门是死代码」的前提 | Open | 真机复现链见上；离线 `SessionStore.create({seed})` 路径**不**暴露此问题（seed 校验接受 `ignorable`、且不查已知类型），这解释了为什么 91 项自动化与阶段 0 的探针都没抓到。修法候选：(a) 上游给 `Session.append` 增加 `ignorable` 选项（或对 `KNOWN_SESSION_EVENT_TYPES` 之外的类型默认置位）；(b) 插件侧不经 `append` 写这条事件（需要私有 API 或改日志，代价与风险都高）；(c) 放弃自定义事件类型（会推翻既有 ADR 的命名空间决策）。**在定案前不要把插件挂到生产 profile 上使用** |

## Closed

- R-001 | Verified | `packages/dsh-tui-rewrite/src/scene.js`（`RewriteScene` 输入分发、`useMirrorRefs`、`makeMirrors`） | 修：镜像改为**唯一事实来源** —— 每个镜像与它的 state 在同一条语句里写入（`choose`/`writeDraft`/`writeCaret`/`writeTargets`/`leaveEdit`），渲染路径**不再**用 state 回写镜像（React 的提交是异步的，chunk 中途渲染带的是上一轮 state，回写会把整批按键抹掉）。失效的 `mode` 镜像删除，改以 `draft === undefined` 作模式开关。`useMirrorRefs` 由 `useMemo` 改为 `useRef`。验证：新增 6 项用例直接驱动 `useInput` handler（此前该 handler **零覆盖**），复现并锁定两种后果——同一 chunk 内 `X`+`Y` 曾整批丢失、`Esc` 后同 chunk 的 `Ctrl+S` 曾提交已取消的草稿；修复后 81 项全绿。修复过程中另修正测试运行时的两处失真（`useCallback` 未记忆化导致依赖它的 effect 无限触发；`useMemo`/`useCallback` 与 state 共用槽位数组导致 `useRef` 与 `useCallback` 串槽） | 2026-10-15
- R-002 | Verified | `packages/dsh-tui-rewrite/src/projection.js`（`rewriteProjection.project`、`reportSkip`、`rewriteSkips`） | 修：三处 `throw` 全部改为返回空 Map（投影契约里「这条不改」的表达），原文保留、会话照常打开。理由：投影运行在 surface fold 内，而会话**校验种子时也走同一条 fold**，且 `dsh-session` 的修复通道（`repair.d.ts`）只补工具结果与开放轮次、**没有**丢弃坏投影事件的能力 —— 一条坏事件会让该会话永久打不开。跳过是唯一用户看不见的失败，故按原因计数并在**首次**出现时经 `setProjectionDiagnostics` 告警（main.js 接到 warn 与 debugLog），自检行加 `rewritesSkipped`。验证：新增用例注入三条畸形事件（越界、非数字 targetSeq、非字符串 content），断言会话仍能建立、原文保留、后续正常改写仍生效、跳过被计数；`npm test` 81/81 | 2026-10-15
- R-003 | Verified | `packages/dsh-tui-rewrite/src/{main,projection,scene,debug,seam}.d.ts`；`package.json` exports | 修：补齐五个子路径的声明文件，每个 exports 的 `types` 都指向真实存在的文件。ADR `2026-10-15-event-type-namespace` 决策 2 要求的 `@messageProjection` 语义落在 `projection.d.ts` 的 `declare module '@deepseek-ai/dsh-session'` 块中。验证：新增 `types.test.mjs`——(a) 逐子路径比对**运行导出**与声明值的集合一致（写这条时抓到两处遗漏）；(b) 用 Node 的 `stripTypeScriptTypes` 擦除类型后解析，作为无编译器环境下的语法检查；(c) 断言 `package.json` 的每个 types 目标存在。`npm test` 81/81 | 2026-10-15
- R-004 | Verified | `docs/PLAN.md`（1a 范围与 1b/1c 状态）、`docs/explore/phase1a-results.md`、`docs/tasks/20261015-142000-rewrite-exploration.md` | 修：记录改为与代码一致，并保留可追溯的「记录修正」说明。1a 一节不再声称「不做编辑与提交」，改为如实记录这段代码随 1a 落地；1b 记为「键盘/点击/滚轮/视口已完成，**仅剩 hover**（B5）」；1c 记为「多行编辑与提交已实现，**仅剩 Home/End**，且 C1–C7 全部无真机记录」。`phase1a-results.md` 澄清「1a 不含提交」只对真机清单成立，并区分「还没写」与「写了但没在真机上走过」。验证：逐行比对 PLAN 第 2 节与 `scene.js` 实际交付；`key.home`/`key.end`、`onMouseEnter`/`onMouseLeave` 仍为零命中（与修订后的记录一致） | 2026-10-15
- R-005 | Verified | `packages/dsh-tui-rewrite/test/` | 修：整树删除（95 MB → 包目录 98 KB）。删除前核实：`git ls-files` 在该树下**零条**记录（含自嵌套副本），全仓无任何脚本或文档引用；现行夹具由 `test-harness/build-fixture.mjs` 生成。验证：`npm test` 81/81、`npm run report` 5/5 通过 | 2026-10-15
- R-006 | Verified | `test-harness/tools.mjs`、`build-fixture.mjs`、`mount.mjs`、`unmount.mjs`、`HANDOFF.md` | 修：机器相关路径统一由 `tools.mjs` 解析并支持覆盖——`DSH_REWRITE_CORE`、`DSH_REWRITE_PROFILE`（默认走 `DSH_HOME` 或 `~/.dsh`）、`DSH_REWRITE_SAMPLE`；包目录改为从脚本自身位置推导，任意 cwd 与任意检出均可用。会写入真实 profile 的脚本经 `requirePath()` **在写入任何东西之前**校验路径。`HANDOFF.md` 补上变量表与 R-001 的镜像纪律，测试数改为 73（当时）。验证：`DSH_REWRITE_PROFILE=C:/nope/nowhere` 时 `build-fixture`/`mount`/`unmount` 均以变量名报错退出，真实 profile 的 patch 未出现本插件行 | 2026-10-15
- R-007 | Verified | `packages/dsh-tui-rewrite/src/scene.js`（`messageText`） | 修：`content` 非数组时降级为空串，`text` 非字符串不再是字面 `"undefined"`。理由：该函数在**渲染路径**上被调用（`collectTargets` 只给 `deriveEventMessage` 包了 try），抛错会穿透到宿主错误边界并关掉整个场景；`applyRewrite` 对同一字段早有 `Array.isArray` 防护，两者必须对「可用的消息」持同一判据。验证：新增用例覆盖字符串/对象/null/缺失 content 与无 `text` 的 part，并断言伪造 session 的 `collectTargets` 返回空列表而不抛；`npm test` 81/81 | 2026-10-15
- R-008 | Verified | `packages/dsh-tui-rewrite/src/main.js`（`makeState`、`createPlugin`、`projectionStatus`） | 修：状态改为**按实例**创建并挂在返回的行上（`row.state`），`projectionStatus(plugin)` 描述该实例；无参形式仍描述最新实例，单实例的生产路径不变。验证：新增用例断言被拒实例不影响健康实例、dispose 一个不清空另一个、自己的 dispose 确实清空自己；另把测试中原本走无参全局的断言改为各自的实例——审查时这套测试本就并发运行，读的正是别的用例的实例。`npm test` 81/81 | 2026-10-15
- R-009 | Verified | `packages/dsh-tui-rewrite/src/scene.js`（`submit`） | 修：草稿为空或仅空白时**拒绝**提交并显示 `empty text — nothing appended`，不再 append `content: ''`。理由：投影会忠实产出「空文本块的助手消息」，而 `deriveEventMessage` 对原始事件从不产出该形态 —— 等于把插件凭空造出的消息交给模型。验证：新增两项用例——删空后 `Ctrl+S` 不产生任何本插件事件、仅空白同样被拒、真实文本仍能提交（对照）；`npm test` 81/81 | 2026-10-15
- R-010 | Verified | `packages/dsh-tui-rewrite/src/scene.js`（`useMirrorRefs`） | 修：改用 `useRef` 承载稳定镜像对象，`useMemo` 仅作为宿主无 `useRef` 时的**单槽**回退。理由：React 明确 `useMemo` 只是性能提示、不保证缓存不被丢弃，缓存被丢会让镜像换新、handler 与 state 脱钩。验证：新增用例分别用带/不带 `useRef` 的 React stub 驱动两条分支，断言各自只占**一个 hook 槽**、镜像对象跨渲染保持同一、且渲染不会重置镜像；`npm test` 81/81 | 2026-10-15
- R-011 | Verified | `packages/dsh-tui-rewrite/src/scene.js:339`（原位置）、`src/main.js`（`reportLateMountState`） | 修：(a) `no session for channel` 的 `debugLog` 从**渲染期**移入监听 session 的 effect（`debugLog` 是同步 `mkdirSync`+`appendFileSync`，而一次渲染每按键可跑多次）；(b) 自检的 `setInterval`/`setTimeout` 经 `ctx.effect` 绑定激活，卸载即停；effect 作用域不可用时明确告警且**不启动**，不再无主运行。验证：新增用例以显式 context 驱动 apply，断言自检确实注册了 disposer（修复前一个都没有）且每个 disposer 可调用不抛；场景侧新增用例断言同一 session 的重复渲染**不产生任何待执行 effect**。`npm test` 81/81 | 2026-10-15
- R-012 | Invalid | `packages/dsh-tui-rewrite/src/projection.js:35-53` | 假设「改写为空文本会让该消息从模型可见面消失、破坏不变式 C2」**不成立**：实测改写为 `''` 后 `deriveMessages()` 仍为 3 条、`surface.nodes` 不变，仅文本变空串。empty-content 规则只作用于原始事件派生，不作用于投影结果。相关边界另记为 R-009（现已修复为拒绝空文本提交）。 | 2026-10-15
- R-013 | Verified | `packages/dsh-tui-rewrite/src/projection.js:59-74` | 不变式 C6「插件缺失时日志可读」**成立**：把含 `dsh-tui-rewrite/message` 事件的日志在**未注册投影**的情况下重开，`deriveMessages()` 返回原文、`eventAt(seq).data.message` 原文完好、后续 append 正常。原因是自有事件类型不在上游硬编码的 `MESSAGE_PROJECTION_EVENT_TYPES`（`dsh-session/lib/index.js:141`，只含 `image/offload`）中，`surfaceOpOf` 视其为无副作用记录（同文件 297-301）。 | 2026-10-15
- R-014 | Invalid | `package.json:6-13`、`test-harness/run.sh` | 假设「`npm test` 在 Windows 默认 shell 下因 glob 引号问题跑不起来」**不成立**：`npm test` 全绿，`pretest` 夹具构建正常，`npm run report` RESULT 全 true。HANDOFF 记载的两条入口（`bash test-harness/run.sh` 与 `npm test`）确认等价可用。 | 2026-10-15
- R-015 | Accepted-risk | `packages/dsh-tui-rewrite/src/main.js:96-102`；`test-harness/test/plugin.test.mjs:163-170` | 插件卸载会让**已用过该投影的 live 会话**拒绝继续派生（实测 dispose 后 `deriveMessages()` 与 `surface.nodes` 均抛 `session message projection "dsh-tui-rewrite/message" was removed or replaced`）。判定为**已接受风险**而非缺陷：这是上游文档化的投影生命周期语义（`dsh-session/lib/index.js:577-582` 与 `registerMessageProjection` 的注释「Disposing the contribution makes sessions that used it refuse further derivation」），且 dsh-tui 的 `/reload` 只重读偏好文件、不重载插件（`lib/types/reload.d.ts`），进程内卸载在正常使用下不可达。留意：现有测试把「卸载即解绑」断言为期望行为，却未记录该后果，建议在该用例补一行注释指向本条风险。 | 2026-10-15
- R-016 | Duplicate | `packages/dsh-tui-rewrite/src/projection.js:21` | 「未知事件类型缺少 `ignorable`，上游修正该闸门后存量日志会集体不可读」已由 ADR `docs/decisions/2026-10-15-event-type-namespace.md` 与 PLAN 风险表 R1 记录并接受（并已确认：`Session.append` 不提供 `ignorable` 参数，闸门目前是死代码，本插件依赖它「碰巧没生效」）。本次不重复开条目，仅确认该判断与上游源码一致。 | 2026-10-15
- R-017 | Verified | `docs/PLAN.md`（1b 的 B5 措辞）、`test-harness/test/scene-render.test.mjs:748`（"hover follows the row, not the screen slot" 用例注释） | 修：两处文字改为与宿主实现一致——hover 只在**指针移动事件**里重算（`ink/components/App.js:876` → `ink/ink.js:2397 dispatchHover`；其余调用点只有 resize / 交替屏切换时的 `clearHovered`），静止指针下任何实现都拿不到指针位置，所以 B5 的判据写成"移动指针后高亮指向指针所在行"，用例注释也明确那次 `onMouseEnter()` 是手工模拟"下一次指针移动"。验证：真机差分显示 hover 底色完全由指针事件驱动（`c0→c1` 只有该行的 `48;2;240;220;230`），无"提交后重算"；`npm test` 91/91 | 2026-10-15
- R-018 | Verified | `docs/explore/phase1a-results.md` §6.2 第 1 项、`docs/tasks/20261015-142000-rewrite-exploration.md`（同段转述） | 修：旧记录里的"滚一格 → `scroll` 先变 20"改成按真实一格（±3 行，`App.js:747`）与定点复算表述；"只要选中项不在视口内，滚轮一格都滚不动"改成"朝选中项所在边缘滚的那一步会被立刻回置、背离该边缘才留得住"，并附复算数据（选中 0 行时 `d=+3/+1/+20` 全回置 0；选中 10 行时 `d=+3` 保留 3；选中 25 行时 `d=-3` 回置 7）与订正说明；任务文件转述同步。验证：真机一格 = `deltaY 3` → 选中项 ±3 行、视口跟随生效 | 2026-10-15
