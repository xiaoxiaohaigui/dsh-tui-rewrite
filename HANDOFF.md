# dsh-tui-rewrite — 项目入口

> 稳定背景、环境约束与操作入口。阶段进度与验收标准在 `docs/PLAN.md`，
> 不在本文件里重复。

## 这是什么

一个 dsh-tui 插件：允许**用户手动**改写会话历史中助手回复的文本。
改写后下一轮对话模型看到的是改写后的内容，而**持久化日志原文不变**。

范围边界与"明确不做"的事项见 `docs/PLAN.md` 第 0 节。

## 环境事实（2026-10-15 实测）

| 项 | 值 |
|---|---|
| dsh | `@deepseek-ai/dsh` **0.2.0-rc.2** |
| dsh-tui | `@deepseek-harness-tui/dsh-tui` **0.15.0**（profile 内安装副本） |
| Node | **v24.18.0**（原生 `zlib.zstdDecompressSync` 可用） |
| 平台 | Windows，git bash |

### 关键路径

```
dsh 核心包
  C:/Users/86198/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
TUI profile
  C:/Users/86198/.dsh/profiles/dsh-tui/
会话日志
  C:/Users/86198/.dsh/sessions/<项目 slug>/<session-id>/session.v4.jsonl.zstd
TUI 状态与日志
  C:/Users/86198/.dsh-tui/   （effect-ledger.jsonl、last-run.json、compile-cache）
```

绝对路径是本机专有的，但 test-harness/ **不再把它们写死在源码里**：
全部经 `test-harness/tools.mjs` 解析，换机只需设环境变量。

| 环境变量 | 作用 | 默认（本机） |
|---|---|---|
| `DSH_REWRITE_CORE` | dsh 自身解析得到的 `@deepseek-ai/*` 所在目录 | `%APPDATA%/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` |
| `DSH_REWRITE_PROFILE` | TUI 用的 profile 目录 | `$DSH_HOME/profiles/dsh-tui`（`DSH_HOME` 未设时为 `~/.dsh`） |
| `DSH_REWRITE_SAMPLE` | 用于测试的会话日志 | 本机一个中等规模样本 |

`build-fixture.mjs`、`mount.mjs`、`unmount.mjs` 在使用前都会校验路径存在；
`mount`/`unmount` 会**在写入任何东西之前**就失败，不会写坏一个猜错的 profile。

## 操作入口

```bash
# 全部 headless 验证（73 项）
bash test-harness/run.sh          # 等价：npm test

# 可读的端到端契约报告
npm run report

# 挂进真实 profile / 一键回滚（幂等，均自动备份）
npm run mount
npm run unmount

# 真机启动（见下方"启动路径"）
dst
```

## 启动路径（重要）

| 路径 | 入口 | 本机状态 |
|---|---|---|
| `dst` | dsh-tui 的 bin → 直接运行 `host-entry.js` | ✅ 正常 |
| `dsh --profile dsh-tui` | DSH CLI → `dsh-app-boot.boot()` | ⚠️ 静默挂起（与本项目无因果） |

**真机验证一律用 `dst`**。原因与已排除项见
`docs/decisions/2026-10-15-dst-for-ondevice-verification.md`。

## 硬约束（改代码前先读）

1. 插件 `apply` **必须同步**，且**每一步独立 try/catch**。
   cordis 在 effect 体抛错时会中止 apply 的其余部分，一个会抛的 effect
   会静默吃掉它后面的所有注册。详见 `docs/explore/phase0-results.md` 第 3 节。
2. 改写事件**绝不能**携带 `surfaceOp` / `sourceEventSeqs`（非 surface 事件类型，会被拒）。
3. 投影用 `deriveEventMessage(ctx.events[t - ctx.baseSeq], ctx.messages)` 取旧值 ——
   `ctx.messages` **只含已被投影改动过的消息**，首次投影时是空 Map。
4. 场景组件必须用宿主注入的 React（`TuiSceneProps.React`）与
   `@deepseek-harness-tui/dsh-tui/jsx-runtime`；插件自带 React 副本会在首帧崩溃。
   宿主只注入 `{ React, ui, channel, close }` 四个 prop，**没有 session** —— 场景经
   `setSessionResolver` 注册的查询能力、用 `channel.sessionId` 自解析会话
   （见决策 `2026-10-15-scene-session-discovery`）。
5. 场景组件里**不能让条件 return 出现在 hook 之前**：React 按调用顺序对位 hook，
   首帧提前 return 会让后一帧的 `useState` 落错槽位 —— 已踩过，
   自动化测试 `scene-render.test.mjs` 会抓住这类回归。
6. TUI 缝合点（`tuiScenes` / `tuiShortcuts`）**不要用裸软探测**：插件行可能早于
   运行时服务激活，探测不到就永久静默失效。走 `src/seam.js` 的
   `whenSeamMounted` / `registerSeamWithRetry`；也**不要**改用 `ctx.inject`
   （在 inject 回调里注册会被算成别的激活的注册）。
7. 真机挂载后**不要以"已挂上"的状态结束工作**：要么验证通过并记录，
   要么 `npm run unmount` 回滚。
8. 场景的输入分发**只读 `useMirrorRefs` 的镜像**，且每个镜像必须与它的 state
   **在同一条语句里**写入；渲染路径**不得**再用 state 回写镜像。React 的状态提交是
   异步的，一个 stdin chunk 内的渲染带的是**上一轮** state，回写会把它整个抹掉
   （R-001：一批按键全丢、`Esc` 后同 chunk 的 `Ctrl+S` 仍提交已取消的草稿）。
   新增键位必须沿用同一纪律，并在 `scene-render.test.mjs` 补「同 chunk 连按」用例。

## 调试通道

全屏界面里 stderr 不可见，现场证据只有两个：

```bash
# 插件的 JSONL 诊断（场景挂载、目标枚举、提交与失败）
DSH_TUI_REWRITE_DEBUG=1            # 写 ~/.dsh-tui/dsh-tui-rewrite.log
DSH_TUI_REWRITE_DEBUG=D:/path.log  # 或指定文件

# TUI 自身的启动时间线
DSH_TUI_BOOT_TRACE=D:/bt.jsonl
```

## 目录结构

```
packages/dsh-tui-rewrite/   插件包（package.json、cordis.patch.yml、dsh-plugin.json、src/）
test-harness/               解析夹具、测试、挂载脚本、可读报告
docs/PLAN.md                分期规划与各阶段验收标准
packages/dsh-tui-rewrite/src/seam.js
                            缝合点晚挂载轮询（场景/快捷键注册不在 apply 里赌运气）
packages/dsh-tui-rewrite/src/scene.js
                            全屏场景（数据源、键盘、降级路径）
docs/decisions/             架构决策记录（改投影语义或事件形态时同步更新）
docs/explore/               探索与验证记录（phase0-results、phase1a-results、scene-design）
docs/tasks/                 任务文件
```

## 参考实现

`dsh-tui-find`（本机已装）是第三方插件的最佳范本：命令注册双路径、
seam 晚挂载轮询、鼠标行交互、键盘分发纪律。路径：
`C:/Users/86198/.dsh/profiles/dsh-tui/node_modules/dsh-tui-find/dist/`

官方文档：`@deepseek-harness-tui/dsh-tui/guide/dsh-tui-guide/`
（`plugins.md`、`interaction.md`）。注意本机安装包**没有**
`tui-profile/docs/plugin-admission-and-development.md`。