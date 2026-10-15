# 阶段 0 验证结果：真实加载与投影注册

- 日期：2026-10-15
- 状态：**headless 部分全部通过**（16 项检查）；「真机启动一次」待用户在终端完成
- 上源：`docs/tasks/20261015-142000-rewrite-exploration.md` 第 6 节阶段 0
- 复现：`bash test-harness/run.sh <某个 session.v4.jsonl.zstd>`

## 1. 做了什么

1. 建立插件包 `packages/dsh-tui-rewrite/`：`package.json`（含 `dsh.bundle.patch`）、
   `cordis.patch.yml`、`dsh-plugin.json`、`src/projection.js`、`src/main.js`。
2. 建立**与真实安装等价的解析链**（`test-harness/build-fixture.mjs`）：
   用 Windows **junction** 而不是 symlink，让 Node 解析真实路径，
   于是每个包自己的兄弟依赖仍可达（cordis 找得到 `@deepseek-ai/cosmokit`）。
   两层：`test-harness/node_modules`（模拟 profile 提供的）+ 
   `packages/dsh-tui-rewrite/node_modules`（插件自己的 peer，等价于 `npm install` 的结果）。
   **不需要 `--preserve-symlinks`**，夹具因此对真实安装保持诚实。
3. 用真实 `Context` + 真实 `SessionStore` + 真实样本会话跑断言（无 TUI、无 TTY）。
4. 挂进真实 profile 并验证组合树。

## 2. 断言结果（16 项全过）

### 2.1 加载与生命周期（`test-harness/phase0-loading.mjs`，12 项）

| 断言 | 结果 | 证据 |
|---|---|---|
| `ctx.sessions` 在挂载 store 行后可解析 | PASS | `typeof = object` |
| 插件应用并**恰好注册一次**投影 | PASS | `projections=[dsh-tui-rewrite/message]` |
| 同一事件类型不会被第二行重复注册 | PASS | 拥有者始终为 1 |
| **会话先于投影注册**建立也能被投影改写（顺序竞态） | PASS | 120 消息，目标 index 5 |
| 仅注册投影**不会**追溯改动已派生的缓存 | PASS | 无 append 时逐字节不变 |
| append 后模型看到改写文本 | PASS | `"<< phase0 rewrite v1 >>"` |
| 消息数量与 surface 位置不变 | PASS | 120 → 120 |
| 邻居消息逐字节相同 | PASS | 比较 119 条 |
| append-only 日志仍保留原文 | PASS | seq 16 |
| 改写事件不带 `surfaceOp`/`sourceEventSeqs` | PASS | keys = type,seq,time,data |
| 同一 seq 的后一次改写胜出（投影可叠加） | PASS | v2 生效 |
| 释放插件 fiber 后投影被移除 | PASS | remaining=0 |

**第 4 条是阶段 0 的核心结论**：HANDOFF 第 6.7 节担心的注册顺序竞态**不成立**。
投影是在事件在 fold 时被查表的，不是创建会话时快照绑定的；会话先建立、
插件后注册，第一次改写照样生效。

### 2.2 冲突与可见性（`test-harness/phase0-selfcheck.mjs`，4 项）

| 断言 | 结果 |
|---|---|
| 已有外部投影占用事件类型时，不被顶掉 | PASS |
| `projectionStatus()` 报告被拒原因 | PASS |
| 被拒在挂载时写入日志 | PASS |
| **「插件已加载但改写无效」会在会话创建时告警** | PASS |

## 3. 过程中发现并修掉的真 bug

**effect 体抛错会中止 `apply` 的其余部分。** 第一版 `apply` 写成：

```js
export function apply(ctx) {
  ctx.effect(() => ctx.sessions.registerMessageProjection(rewriteProjection)); // ← 可能抛
  watchForInertSessions(ctx);   // ← 上行抛了就永远不执行
}
```

当事件类型已被占用时，`registerMessageProjection` 抛
`session message projection "dsh-tui-rewrite/message" is already registered`，
cordis 捕获后中止 `apply`，**自检监听器从未装上** ——
于是「插件装了但静默失效」这个 HANDOFF 明确警告过的模式，
正好由本插件自己复现了一次。现在注册包在 try/catch 里，
拒绝被记录到 `projectionStatus()` 并在每个会话创建时告警。

**教训（值得写进实现规范）**：插件 `apply` 里的每一段都必须是「不可抛」的，
或各自独立 try/catch；一个会抛的 effect 会静默吃掉它后面所有的注册。

## 4. 真实 profile 装载

- 挂载方式：`$DSH_HOME/profiles/dsh-tui/cordis.patch.yml` 追加
  `- insert:\n    - id: dsh-tui-rewrite\n      name: dsh-tui-rewrite`。
  备份：`cordis.patch.yml.bak-before-rewrite-20261015-150118`。
- 包解析：`profiles/dsh-tui/node_modules/dsh-tui-rewrite` → 本仓库包目录（junction）。
- **验证结果**：`dsh --profile dsh-tui --dump-config` 的组合树第 706-707 行确认存在该行：
  ```yaml
  - id: dsh-tui-rewrite
    name: dsh-tui-rewrite
  ```

### 4.1 补丁写法

用户层是 overlay，新增行必须用 `- insert:`；判据与踩坑细节见 [6.1](#61-profile-用户层的补丁语义)。

### 4.2 真机启动这一步

本会话无 TTY，真机启动改由用户在终端完成。原先用 `dsh --profile dsh-tui`
作为启动命令，实测该路径在本机静默挂起，已改用 `dst`——原因分析见第 6.3 节。

## 5. 顺带确认的事实

- **鼠标默认开启**：存在 `DSH_TUI_DISABLE_MOUSE` 开关（`utils/fullscreen.js`
  `isMouseClicksDisabled()`），即默认是开的、显式才关。与 `AlternateScreen` 的
  `mouseTracking = true` 形参默认一致。参考实现 `dsh-tui-find` 的鼠标用法印证之。
- 轻量内核下的 pending 行为未在阶段 0 覆盖（hostless 夹具只装了 `SessionStore`）；
  留待阶段 4。

## 6. 与真实 profile 交互时踩到的坑（2026-10-15 补记）

### 6.1 profile 用户层的补丁语义

用户层是 overlay：`- id:/name:` 只改已存在的行，新增必须 `- insert:`。
判据是 `dsh --dump-config` 的 stderr 出现 `patch: entry "X" not found` —— 该警告是
**静默跳过**，不影响启动，容易漏看。

### 6.2 两条启动路径不是同一回事

| 路径 | 入口 | 是否接管已装的 dsh | 启动追踪标记 |
|---|---|---|---|
| `dst` | dsh-tui 的 bin → 默认直接跑 `host-entry.js` | 是（prepareHostRoot 接管） | 有 entry-* |
| `dsh --profile dsh-tui` | DSH CLI → `dsh-app-boot.boot()` | 否 | 无 entry-* |

实测差别：本机 `dst` 可进界面；`dsh --profile dsh-tui` 静默无输出。
同一份 profile 在两条路径下的判定可能不同——profile 补丁第 6-11 行记录过同类坑：
bundle 层的让位守卫早于用户层求值，导致两行都启用，报
`1 required plugin did not activate`（webServer 重复注册）。

### 6.3 dsh --profile 静默挂起：已排除与未查明

**已排除：**

- profile 补丁完好（md5 与挂载前逐字节一致），junction 已删，无插件残留
- 装载与组合阶段正常：loadProfile 与 composeEntries 在 17ms 内产出 **122 行、0 个跳过**
- `--dump-config` 正常返回 705 行
- 无 TTY 也**不阻塞**，所以"没有终端"不是原因

**未查明：**

- 进程活着、stdout 与 stderr **各零字节**、boot trace 无任何标记 → 卡在挂载阶段、
  且在 TUI 渲染之前。TUI 自身的错误输出受 `process.stderr.isTTY` 门控，
  非 TTY 下看不见，所以本机复现拿不到报错文本
- 用户报告过"有报错但界面闪烁没截到"，说明真机上有过一条被清屏吞掉的 DSH 错误

**结论**：阶段 0 的真机验证改用 `dst` 进行（见第 7 节）；`dsh --profile` 这条独立问题另行跟踪。

## 7. 复现命令

```bash
# 全部 headless 断言（16 项）
bash test-harness/run.sh "<session.v4.jsonl.zstd>"

# 挂载到真实 profile 与回滚（幂等，可重复执行）
node test-harness/mount.mjs
node test-harness/unmount.mjs

# 真机启动走可用的那条路
dst
```
