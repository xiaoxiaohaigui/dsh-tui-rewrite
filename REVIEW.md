# REVIEW.md - dsh-tui-rewrite-working-tree

- 范围：工作树（`master` 尚无任何提交，全部文件为未跟踪状态）。审查对象：`packages/dsh-tui-rewrite/`、`test-harness/`、`package.json`、`docs/`、`HANDOFF.md`
- 审查者：AI 助手（DSH agent 会话）
- 时间：2026-10-15 17:37
- 状态：已完成

## 审查基准

对照物：`docs/PLAN.md` 第 0 节不变式 C1–C8 与各阶段验收项、`docs/decisions/` 五份 ADR、
`HANDOFF.md` 的七条硬约束，以及 `@deepseek-ai/dsh-session` 0.2.0-rc.2 与
`@deepseek-harness-tui/dsh-tui` 0.15.0 的实际实现（读取本机安装副本源码，非注释推断）。

已执行的验证命令（均在本工作树内，结果如实记录）：

| 命令 | 结果 |
|---|---|
| `bash test-harness/run.sh` | 60 项 全绿（`tests 60 / pass 60 / fail 0`） |
| `npm test`（Windows 默认 shell） | 同上，60 项全绿 |
| `npm run report` | 5 项 RESULT 全 true（改写生效 / 日志留原文 / 邻居不变 / 无 surfaceOp / 投影可解绑） |
| 临时探针（跑完即删，未入库） | 见各条目「验证」列的复现要点 |

未覆盖：真机（无终端，未执行 `dst`）。阶段 1a 的 A1–A8 由用户于 2026-10-15 实测通过；
1b/1c 的真机验收（B1–B5、C1–C7）尚无记录，见 R-004。

## Active

| ID | 级别 | 位置 | 问题/证据/影响 | 状态 | 验证 |
|---|---|---|---|---|---|
| R-001 | P1 | `packages/dsh-tui-rewrite/src/scene.js:204-208,264,268`（`RewriteScene` 输入分发） | 编辑模式下 `mirrors.mode`/`mirrors.draft` 只在**渲染期**赋值（204、206），而 handler 改草稿只走 `setDraft`，从不回写镜像；同一 stdin chunk 内的后续按键因此读到过期快照。实测两个后果：(a) 一个 chunk 内连打 `X`、`Y` → 编辑区渲染为 `HELLOY`，`X` **静默丢失**；(b) 同一 chunk 内 `Esc` 后接 `Ctrl+S` → 已取消的草稿**仍被 append**（日志出现 `dsh-tui-rewrite/message`，状态行显示 "rewrote seq 1"）。对照：`caret`/`selected` 无此问题（`move`/`step`/`onClick` 同步写镜像），列表模式同 chunk 连按两次 `j` 实测正确移动两行 —— 缺陷局限在 draft/mode 两个镜像。这正是 `scene-design.md` 第 7 节与 `scene.js` 头注释反复强调的批处理陷阱，也是项目自己列为「最难查的一类 bug」的形态。**影响**：用户改写正文时丢字，且丢失发生在提交给模型的那份文本里。 | Open | 已复现。复现要点：复用 `test-harness/test/scene-render.test.mjs:50` 的 `makeRenderer`，在**不插入 `render()`** 的情况下连续调用 `inputs[0]` 两次。现有 60 项测试对 `useInput` handler **零覆盖**：`makeRenderer` 收集了 `inputs` 但没有任何用例调用它。 |
| R-002 | P2 | `packages/dsh-tui-rewrite/src/projection.js:62-73`（`rewriteProjection.project`） | 三处 `throw` 落在重放/种子校验路径上且无人兜底：日志里只要有一条 `targetSeq` 越界或非数字的改写事件，**会话根本无法建立**。实测 `sessions.create` 直接抛 `invalid seed event at index 1: dsh-tui-rewrite/message: no event at seq 99`；`surface.nodes`/`deriveMessages` 同样不可用。且 `dsh-session` 的修复通道（`lib/types/repair.d.ts`）只补工具结果与开放轮次，**没有丢弃坏投影事件的能力**，即一条坏事件会让该会话永久打不开。与插件其余部分「只降级、不打断」的姿态相反（`apply` 逐步 guard、`sessionFor` 吞异常、`debugLog` 全吞）。触发条件（非插件自身写入路径）：fork/窗口化重放使 `target - baseSeq` 越界 —— 正是 PLAN F2 要验证的场景；或旧版本、其他工具、手改日志写入的事件。 | Open | 已复现。复现要点：注册插件后以 `seed` 注入 `{type:'dsh-tui-rewrite/message', data:{targetSeq:99,…}}`，会话创建即抛错。同一日志在**不注册投影**时可正常打开（见 R-013），故本条只在插件在场时成立。 |
| R-003 | P2 | `packages/dsh-tui-rewrite/package.json:8,11,16,18` | `types` 与 `exports[].types` 指向 `src/main.d.ts`、`src/projection.d.ts`，但 `src/` 下只有 5 个 `.js`（`ls src` 与全仓 `.d.ts` 检索均无命中）。这不只是打包瑕疵：ADR `docs/decisions/2026-10-15-event-type-namespace.md` 的决策第 2 条明确要求「该类型**必须**声明 `@messageProjection` 语义（`src/projection.d.ts` 的 `declare module` 块），使『这个事件需要解释器』成为类型层契约而非注释约定」——该文件不存在，即一条已采纳决策未落地。**影响**：TS 消费方解析 `types` 失败；事件语义退回注释约定。 | Open | `ls -la packages/dsh-tui-rewrite/src/` 只有 debug/main/projection/scene/seam.js；`.d.ts` 检索仅命中 node_modules。 |
| R-004 | P2 | `docs/PLAN.md:36-37,79,104-139`；`docs/explore/phase1a-results.md:166-172`；`docs/tasks/20261015-142000-rewrite-exploration.md:49-51` | 记录与代码不一致，且是**双向**的。**(a) 代码多于记录**：`PLAN.md:79` 把 1a 的「明确不做」写成含「编辑与提交（1c）」，但 `src/scene.js` 实际交付了编辑模式与提交路径（`beginEdit` 254、编辑分发 262-311、编辑视图 350-381、`submit` 233-252），实测可真正完成一次改写（日志落下 `dsh-tui-rewrite/message`）。任务文件只承认了列表模式（「1b 列表模式完整化：↑↓/jk 已有基础实现」，49-51），**从未记录编辑模式已存在**。**(b) 代码少于 PLAN 的定义**：1c 范围内明确列的 **Home/End 完全没有**（`key.home`/`key.end` 零命中），1b 要求的 **hover 也完全没有**（`onMouseEnter`/`onMouseLeave` 零命中）—— 所以按 PLAN 自己的定义，1b/1c **均未完成**，PLAN 的「待开始」与任务文件的「待阶段 1b」在这一点上并不算错。**影响**：真正的问题是「编辑 + 提交」这段代码既不属于任何阶段的交付记录、也没有对应验收项，无法判断它是否经过真机确认；而 R-001 这条 P1 恰好落在这段无人认领的代码上。 | Open | 逐行比对 PLAN 第 2 节与 `scene.js`；`grep -c` 核 `key.home`/`key.end`/`onMouseEnter`/`onMouseLeave` 均零命中；编辑提交路径由模拟 hook 运行时驱动实测跑通。 |
| R-005 | P3 | `packages/dsh-tui-rewrite/test/fixture/` | 陈旧夹具树，属被取代的旧布局（时间戳 14:56），全仓无任何脚本或文档引用（`grep -rn "test/fixture"` 零命中）。`du -sh` 为 **95 MB**；内部 `test/fixture/node_modules/dsh-tui-rewrite` 是包目录的副本，形成自嵌套的重复树。**影响**：占空间、与现行 `test-harness/node_modules` 夹具重复；打包/扫描/备份等递归工具会在其上放大工作量。判定为遗留物而非有意保留：`.gitignore` 的 `node_modules/` 使其永远不会被提交。 | Open | `du -sh packages/dsh-tui-rewrite/test` = 95M；引用检索零命中。属删除类操作，本次审查未执行。 |
| R-006 | P3 | `test-harness/build-fixture.mjs:22-25`；`test-harness/mount.mjs:20-23`；`test-harness/unmount.mjs:8-10` | 本机绝对路径硬编码且**无环境变量兜底**。`test-harness/tools.mjs:31` 的样本路径有 `DSH_REWRITE_SAMPLE`，但夹具与挂载所需的 `CORE`/`PROF` 没有；`HANDOFF.md` 换机说明只提到改用 `DSH_REWRITE_SAMPLE`，未覆盖这一半。**影响**：换机后 `npm test`、`npm run mount`/`unmount` 必须改源码才能运行，与「一条命令验证」的基建目标不符。 | Open | 读三个脚本的常量声明并与 `tools.mjs` 的 `samplePath()` 对比。 |
| R-007 | P3 | `packages/dsh-tui-rewrite/src/scene.js:122-127,459`（`messageText`） | `(message?.content ?? []).filter(…)` 在 `content` 不是数组时抛 `TypeError: …filter is not a function`（实测）；`collectTargets` 只对 `deriveEventMessage` 包了 try，故异常会从渲染期的 `useState(() => collectTargets(session))`（195）与重枚举 effect（224）穿出，由宿主错误边界兜住并关掉场景。同一插件的 `applyRewrite`（projection.js:37）对同一问题用了 `Array.isArray` 防护，姿态不一致。**影响面有限**：合法 `Message.content` 恒为块数组（`dsh-llm/lib/types/types.d.ts:470`），只在跨内核/异构会话形状下可达，而 `collectTargets` 的注释（434-441）与用例「degrades on a session shape from another kernel」恰恰宣称对该形态降级。 | Open | 已复现：`messageText({role:'assistant',content:'plain string'})` 与伪造 session 的 `collectTargets` 均抛 TypeError。 |
| R-008 | P3 | `packages/dsh-tui-rewrite/src/main.js:56,59-61` | 模块级单例 `state` 被所有 `createPlugin()` 实例共享；对外导出的 `projectionStatus()` 报告的是「最后一个 apply 的实例」，任一根 dispose 都会把它清成 `registered:false`。`test-harness/test/plugin.test.mjs:78-94` 正是依赖这个全局来断言「重复拥有者被拒」。**影响**：同进程多上下文（测试、并发挂载）下状态互相污染，诊断读数不可信；生产单实例下无实际影响。 | Open | 读 main.js 与现有测试对该全局的依赖点。 |
| R-009 | P3 | `packages/dsh-tui-rewrite/src/scene.js:233-252`；`packages/dsh-tui-rewrite/src/projection.js:50` | 编辑区允许把文本删空后 `Ctrl+S`：`text !== target.original` 成立，于是 append `content: ''`。实测该事件不改变消息数（`deriveMessages` 3→3、`surface.nodes` 不变），目标消息文本变为空串 —— 即投影能产出 `deriveEventMessage` 在自然状态下会判为「空内容 → 不产生消息」的形态（该 empty-content 规则只作用于原始事件，不作用于投影结果）。**影响**：下发给模型的助手消息含空文本块，是否被上游接受未验证；插件既不阻止也不提示。 | Open | 已实测：纯文本回复改写为 `''` 后文本序列为 `["FIRST","","THIRD"]`。下游接受度未验证，故未升级级别。 |
| R-010 | P3 | `packages/dsh-tui-rewrite/src/scene.js:162-171`（`useMirrorRefs`） | 用 `React.useMemo(factory, [])` 承载「稳定 ref 对象」，而 React 文档明确 `useMemo` 只是性能优化、不保证缓存不被丢弃（宿主 React 为 19.2，`dsh-tui@0.15.0` 依赖 `react: ^19.2.0`）。一旦缓存被丢，镜像对象换新，`useInput` 闭包读到的镜像与 state 脱钩，整个输入纪律失效。当前各版本均不丢弃，属**潜在**风险而非现网缺陷；`useRef` 才是语义正确的 API。 | Open | 静态审查 + 宿主 React 版本核实。未构造出触发路径。 |
| R-011 | P3 | `packages/dsh-tui-rewrite/src/scene.js:339`；`packages/dsh-tui-rewrite/src/main.js:228-251` | 诊断/自检代码的副作用位置问题：(a) `debugLog('no session for channel', …)` 在**渲染期**调用，未命中会话时每次渲染都做一次同步 `mkdirSync`+`appendFileSync`，把同步文件 I/O 放进了渲染路径（同一函数在 `sessionFor` 的 catch 里也被调用）；(b) `reportLateMountState` 的 `setInterval`/`setTimeout` 未通过 `ctx.effect` 绑定激活，卸载后仍会跑到 60 s 才写 `entry points incomplete`（已 `unref`，不会吊住进程）。二者都不影响正确性，但与同一仓库在别处坚持的「观察性代码必须有属主、不承载副作用」不一致。 | Open | 读 `scene.js:339` 与 `main.js:228-251`；`debugLog` 的实现见 `src/debug.js:35-43`。 |

## Closed

- R-012 | Invalid | `packages/dsh-tui-rewrite/src/projection.js:35-53` | 假设「改写为空文本会让该消息从模型可见面消失、破坏不变式 C2」**不成立**：实测改写为 `''` 后 `deriveMessages()` 仍为 3 条、`surface.nodes` 不变，仅文本变空串。empty-content 规则只作用于原始事件派生，不作用于投影结果。相关边界另记为 R-009。 | 2026-10-15
- R-013 | Verified | `packages/dsh-tui-rewrite/src/projection.js:59-74` | 不变式 C6「插件缺失时日志可读」**成立**：把含 `dsh-tui-rewrite/message` 事件的日志在**未注册投影**的情况下重开，`deriveMessages()` 返回原文、`eventAt(seq).data.message` 原文完好、后续 append 正常。原因是自有事件类型不在上游硬编码的 `MESSAGE_PROJECTION_EVENT_TYPES`（`dsh-session/lib/index.js:141`，只含 `image/offload`）中，`surfaceOpOf` 视其为无副作用记录（同文件 297-301）。 | 2026-10-15
- R-014 | Invalid | `package.json:6-13`、`test-harness/run.sh` | 假设「`npm test` 在 Windows 默认 shell 下因 glob 引号问题跑不起来」**不成立**：`npm test` 60 项全绿，`pretest` 夹具构建正常，`npm run report` 5 项 RESULT 全 true。HANDOFF 记载的两条入口（`bash test-harness/run.sh` 与 `npm test`）确认等价可用。 | 2026-10-15
- R-015 | Accepted-risk | `packages/dsh-tui-rewrite/src/main.js:96-102`；`test-harness/test/plugin.test.mjs:163-170` | 插件卸载会让**已用过该投影的 live 会话**拒绝继续派生（实测 dispose 后 `deriveMessages()` 与 `surface.nodes` 均抛 `session message projection "dsh-tui-rewrite/message" was removed or replaced`）。判定为**已接受风险**而非缺陷：这是上游文档化的投影生命周期语义（`dsh-session/lib/index.js:577-582` 与 `registerMessageProjection` 的注释「Disposing the contribution makes sessions that used it refuse further derivation」），且 dsh-tui 的 `/reload` 只重读偏好文件、不重载插件（`lib/types/reload.d.ts`），进程内卸载在正常使用下不可达。留意：现有测试把「卸载即解绑」断言为期望行为，却未记录该后果，建议在该用例补一行注释指向本条风险。 | 2026-10-15
- R-016 | Duplicate | `packages/dsh-tui-rewrite/src/projection.js:21` | 「未知事件类型缺少 `ignorable`，上游修正该闸门后存量日志会集体不可读」已由 ADR `docs/decisions/2026-10-15-event-type-namespace.md` 与 PLAN 风险表 R1 记录并接受（并已确认：`Session.append` 不提供 `ignorable` 参数，闸门目前是死代码，本插件依赖它「碰巧没生效」）。本次不重复开条目，仅确认该判断与上游源码一致。 | 2026-10-15
