# 2026-10-15-event-type-namespace - 自有事件类型采用插件作用域命名并显式声明可忽略性

- 日期：2026-10-15
- 状态：已采纳
- 参与者：DSH agent 会话

## 背景

第三方插件可以向会话日志追加自有事件类型。读取路径对「不认识的类型」有两种态度：

- `known-event-types.d.ts` 头注释宣称：`KNOWN_SESSION_EVENT_TYPES` 之外的类型
  默认**拒绝重建会话**，除非事件信封带 `ignorable: true`；
- 实测（`docs/explore/phase0-results.md` 第 4 节）：该闸门在当前版本**不生效**，
  未知类型无论是否带 `ignorable` 都会被放行。

同时，`Session.append`（`dsh-session/lib/index.js:1441-1459`）只从 opts 取
`sourceEventSeqs` 与 `surfaceOp`，**没有 `ignorable` 参数** —— 第三方目前
无法在新事件上设置该信封标记。

## 决策

1. 事件类型命名为 **`dsh-tui-rewrite/message`**：插件作用域前缀 + 单斜杠，
   不会与核心类型或他插件冲突。
2. 该类型**必须**声明 `@messageProjection` 语义（`src/projection.d.ts` 的
   `declare module` 块），使「这个事件需要解释器」成为类型层契约而非注释约定。
3. 事件**禁止**携带 `surfaceOp` / `sourceEventSeqs`：它不是 surface 事件类型，
   携带会被直接拒绝（实测：`session event "..." is not surface-eligible and cannot carry surfaceOp`）。
4. 插件侧承担变化风险：投影注册失败时**必须**显式告警，不得静默失效。

## 理由

- 依赖一个「碰巧没生效」的闸门是不安全的：上游修正后，缺失 `ignorable` 的存量日志
  会集体不可读。因此把风险显式化 —— 自检 + 告警 + 文档记录，而不是赌闸门不变。
- 命名空间化让「谁能解释这个事件」在类型层可判定，与官方 `image/offload` 的形态一致。

## 替代方案

- **复用核心事件类型**：不可能，核心类型语义固定且会被其他组件解释。
- **不追加事件，直接改日志**：破坏 append-only 契约。
- **注册自定义类型到 `KNOWN_SESSION_EVENT_TYPES`**：官方明确否决过
  （`known-event-types.d.ts`：「event-name registration was rejected because it does not
  classify omission safety and would make reads composition-dependent」）。

## 影响

- 收益：类型层语义明确；插件卸载后事件失效而非损坏日志；升级风险有记录可查。
- 成本：需要维护自检代码与投影声明文件。
- 风险：上游修正闸门后增量写入会失败（失败是显式的，不是静默的）。
  缓解：升级 dsh 时优先跑 `test-harness/run.sh` 与真机挂载检查。
- 后续工作：向上游确认 `ignorable` 对第三方事件类型的预期用法。

## 订正（2026-10-15 真机轮次，REVIEW.md R-019）

「闸门不生效」只对 **seed 路径**成立。**恢复路径**（从磁盘打开会话）一直在执行这条闸门：
`dsh-session-persistence/lib/index.js:184` 对「不在 `KNOWN_SESSION_EVENT_TYPES` 且未带
`ignorable: true`」的事件**整份拒绝**，真机报
`session "…" contains event type "dsh-tui-rewrite/message" (seq N) unknown to this harness and
not marked ignorable; refusing to interpret the log`，随后 TUI 退回启动页。

即：决策 1（命名空间化）与 2、3 仍然成立，但「依赖一个碰巧没生效的闸门」这件事**已经发生**——
后果不是"上游修正后存量日志不可读"，而是**当下就写不出可再打开的会话**（`Session.append`
没有写 `ignorable` 的途径，见「背景」第 2 条）。复现链与修法候选见
`docs/explore/phase1b-1c-results.md` 第 6 节；本文「影响」一节中
"风险：上游修正闸门后增量写入会失败"应改读为"风险已成事实，且表现为**读取**失败"。

## 关联

- 替代：无
- 相关任务：`docs/tasks/20261015-142000-rewrite-exploration.md`
- 相关决策：[2026-10-15-message-rewrite-seam](./2026-10-15-message-rewrite-seam.md)
- 相关发现：REVIEW.md R-019（P1，未关闭）
