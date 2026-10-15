# 2026-10-15-defer-command-mediated-registration - 命令注册先走宿主中介，失败即回落直接注册

- 日期：2026-10-15
- 状态：已采纳
- 参与者：DSH agent 会话

## 背景

dsh-tui 提供两条命令注册通路：

1. `ctx.tuiPluginHost.registerCommand(ctx, contributionId, definition)` —— 中介路径，
   为命令盖上**已校验的组件身份**，使宿主能在调用点执行按属主的 `commands.invoke` 授权；
2. `ctx.get('commands', false).register(definition)` —— 直接路径，
   官方文档称之为 C-070 边界：注册是未署名的，授权无从按属主执行。

参考实现 `dsh-tui-find` 的源码注释记载：中介路径要求 verified admission identity，
而当前宿主运行时**不签发**（`cordis-plugin-loader` 从不调用 `admit`），
实践中抛 `COMPONENT_NOT_ADMITTED`。

## 决策

实现**双路径**：优先中介注册，捕获到拒绝后回落到直接注册。
把回落当**正常路径**（info 级日志），不当异常（不 warn）。

## 理由

- 中介路径的收益（按属主授权）在宿主不签发身份时不存在，硬等它等于功能不可用。
- 回落是官方文档承认的边界，不是绕过安全机制：直接注册就是宿主自身命令所用的同一接口。
- 把回落记为 info 而非 warn：每次启动都 warn 会训练用户忽略警告。

## 替代方案

- **只用中介注册**：命令不可用，直到宿主修复签发。
- **只用直接注册**：放弃未来宿主开始签发身份后自动获得的授权收益；
  且与参考实现的既有实践不一致。

## 影响

- 收益：当下可用；宿主一旦开始签发身份，无需改代码即自动获得中介路径。
- 成本：两段注册代码与一次 try/catch。
- 风险：直接注册路径下 `commands.invoke` 无法按属主拒绝 —— 已知且被官方文档记录。
- 后续工作：关注宿主 admission 链路的进展，条件成熟后可移除回落。

## 关联

- 相关任务：`docs/tasks/20261015-142000-rewrite-exploration.md`
- 证据：`dsh-tui-find/dist/main.js:210-218`（参考实现注释）
