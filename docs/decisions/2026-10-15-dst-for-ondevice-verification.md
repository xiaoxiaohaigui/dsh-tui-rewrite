# 2026-10-15-dst-for-ondevice-verification - 真机验证用 dst，dsh --profile 另行跟踪

- 日期：2026-10-15
- 状态：已采纳
- 参与者：DSH agent 会话

## 背景

同一个 profile 有两条启动路径：

| 路径 | 入口 | 是否接管已装的 dsh |
|---|---|---|
| `dst` | dsh-tui 的 bin → 默认直接运行 `host-entry.js` | 是（`prepareHostRoot`） |
| `dsh --profile dsh-tui` | DSH CLI → `dsh-app-boot.boot()` | 否 |

实测（本机）：`dst` 可正常进入界面；`dsh --profile dsh-tui` **静默挂起** ——
进程存活、stdout 与 stderr 各零字节、boot trace 无任何标记。

已排除的原因：profile 补丁完好（md5 与挂载前逐字节一致）、装载与组合正常
（`loadProfile` + `composeEntries` 17ms 内产出 122 行、0 个跳过）、
`--dump-config` 正常、无 TTY 也**不阻塞**（与「缺少终端」无关）。

## 决策

1. 项目的真机验证与日常开发启动统一使用 **`dst`**。
2. `dsh --profile dsh-tui` 的静默挂起**不作为本项目阻塞项**，单独跟踪。
3. 所有插件改动必须保持**可一键回滚**（`test-harness/unmount.mjs`），
   使真机验证的风险可控。

## 理由

- 两条路径共用同一份 profile 组合，`dst` 能启动即证明 profile、插件树与 TUI 本体健康。
- 静默挂起发生在**挂载阶段、渲染之前**，且当时 profile 中并无本项目任何行
  （已还原），因此与本插件无因果关系。
- 拿不到报错文本的原因已定位：TUI 自身的错误输出受 `process.stderr.isTTY` 门控，
  非 TTY 环境下不可见，故无法在无终端环境复现出可读错误。

## 替代方案

- **先修 `dsh --profile` 再继续**：会把项目阻塞在一个与本需求无关的环境问题上；
  且该问题的排查需要真机交互，不适合作为前置条件。
- **改用其他 profile**：会失去用户既有配置，代价远高于收益。

## 影响

- 收益：项目推进不被环境问题阻塞；真机验证路径明确且可回滚。
- 成本：真机验证无法覆盖 `dsh --profile` 那条路径下的行为差异
  （例如 bundle 层与用户层补丁的求值时机差异）。
- 风险：若未来用户改用 `dsh --profile` 启动，可能遇到同类问题。
  缓解：本决策与排查记录留在文档中，含已排除项与下一步线索。
- 后续工作：排查线索已记录 —— profile 补丁第 6-11 行记载过同类坑
  （bundle 层的让位守卫早于用户层求值，导致 `dsh-tui-webserver` 与 insert 的
  `webserver` 两行都启用，报 `1 required plugin did not activate`）。

## 关联

- 相关任务：`docs/tasks/20261015-142000-rewrite-exploration.md`
- 证据：`docs/explore/phase0-results.md` 第 6 节
