# 2026-10-15-message-rewrite-seam - 用 SessionMessageProjection 改写消息，不用 SurfaceOp replace

- 日期：2026-10-15
- 状态：已采纳
- 参与者：DSH agent 会话

## 背景

需求是「用户手动改写会话历史里 AI 回复的文本；下一轮模型看到改写后的内容，
append-only 日志原文不变」。dsh-session 提供两条都能改「模型可见面」的机制：

1. `SurfaceOp: { op: 'replace', startSeq, endSeq }` —— 位置替换，遮蔽一段 surface 节点；
2. `SessionMessageProjection` —— 为插件自有事件类型注册纯解释器，逐事件改写派生出的消息。

约束是硬性的：改写**必须不改变**消息数量、消息身份（seq）与邻居内容，
否则会话历史的重放与审计都会失真。

## 决策

采用 **SessionMessageProjection**：插件拥有事件类型 `dsh-tui-rewrite/message`，
在其上注册纯投影，把目标 seq 的消息文本替换为新内容。

## 理由

- 类型系统本身就排除了 replace：`SurfaceIntent`（`dsh-session/lib/types/types.d.ts:467`）
  规定 `assistant/message` 事件**禁止**携带 `sourceEventSeqs`（"Assistant messages embed
  their provider stream instead of citing source events"），而 replace 又要求
  `sourceEventSeqs` 完整覆盖被遮蔽节点 —— 两条约束不可同时满足。
- 投影按定义只换内容：实测消息数 120→120、目标 seq 不变、119 条邻居逐字节相同。
- 投影**可叠加**：fold 把累积的 `projectedMessages` 交给下一个投影
  （`dsh-session/lib/index.js:434`），所以同一 seq 的后一次改写天然胜出 ——
  「撤销」于是只是再追加一条改写事件，不需要新机制。
- 插件卸载后行为可接受：投影不注册时改写事件失效、原文浮现（见下方风险）。

## 替代方案

- **SurfaceOp replace**：被类型系统排除，见理由第一条。
- **重写整个会话文件**：破坏 append-only 契约与审计价值，且并发写入不安全。
- **让模型自己重读改写后的文本**（把改写内容塞进下一轮 prompt）：
  污染请求头、无法持久、与 compaction 交互复杂。

## 影响

- 收益：满足全部硬约束；撤销与叠加零成本；日志与人类记录面不受影响。
- 成本：插件必须注册投影，否则改写静默失效 —— 需要自检告警（已实现）。
- 风险：`MESSAGE_PROJECTION_EVENT_TYPES`（`lib/index.js:141`）是编译期硬编码集合，
  只含 `image/offload`。第三方事件类型不在其中，于是「未知类型必须带 `ignorable`
  否则拒绝读取」的闸门（`known-event-types.d.ts` 头注释所称）**实际未生效**
  （`surfaceOpOf` 的 `return` 之后函数本就结束，是死代码）。
  上游若修正该闸门，存量日志会变成不可读。缓解：事件类型命名空间化 +
  投影自检 + 上报上游（见 `docs/tasks/20261015-142000-rewrite-exploration.md` 第 4.1 节）。
- 后续工作：跟踪 `dsh-session` 的 `MESSAGE_PROJECTION_EVENT_TYPES` 与 `ignorable` 语义变化。

## 关联

- 相关任务：`docs/tasks/20261015-142000-rewrite-exploration.md`
- 证据：`docs/explore/phase0-results.md`、`test-harness/test/plugin.test.mjs`
