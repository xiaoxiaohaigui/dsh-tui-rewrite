# 1b/1c 真机验收记录（2026-10-15）

> 本文只记**真机**观察到的事实与可复现方法。实现细节见
> [docs/PLAN.md](../PLAN.md) 阶段 1b/1c 与 [phase1a-results.md](phase1a-results.md) 第 6 节。

## 1. 结论

在真实 dsh-tui 进程（真实 profile、本插件已挂载、真实会话）里：

- **1b 通过**：B1、B2、B3、B5 全部真机确认；B4 的纵向步长真机确认，横向分支由自动化覆盖
  （宿主把横向滚轮报成 `deltaY=0`，与单元测试同一条判据）。
- **1c 大部分通过**：C1、C3、C4、C5、C6、C7 真机确认，并且**真的提交了一次改写**——
  真机产生的工件回放后 C1–C6 硬不变式 8/8 通过。C2 只完成了一部分：插入、换行、整段粘贴
  已确认；**方向键、Home/End、退格无法用本文的注入手段忠实投递**，仍需人工在真实终端上确认。
- **⛔ 但真机同时暴露一个 P1（见第 6 节）**：**提交过改写的会话再也打不开**——
  恢复路径拒绝「未知事件类型且未标 `ignorable`」的日志，而插件写不出这个标记。
  插件因此不适合挂到日常 profile 上使用，本文的真机挂载已回滚。

## 2. 方法（可复现）

真机验证过去卡在"没有终端"：`dst` 明确拒绝非 TTY（`dsh-tui requires an interactive
terminal (stdout must be a TTY)`），`winpty` 在管道 stdout 下直接断言失败。本次改为自建
**ConPTY 宿主**：

| 件 | 位置 | 作用 |
|---|---|---|
| `ptyrun.exe`（C，mingw 编译） | `D:/dsh-tui-rewrite-onddev/tools/`（**仓库外**） | 建真伪控制台（固定 100×14 / 120×40 等尺寸），把本进程 stdin/stdout 与伪控制台对接；子进程因此拿到真 TTY（`isTTY=true`、`setRawMode` 可用） |
| `driver.mjs` | 同上 | 按脚本投递按键与 SGR 鼠标事件；**每步存一份累计字节流**（`<step>.raw.bin`），并维护一个最小 ANSI 屏幕模型 |
| `showdelta.mjs` / `analyze.mjs` / `screen.mjs` | 同上 | 逐帧字节差分与屏幕回放：`后一帧 - 前一帧` 就是该动作**实际画出来的东西**，比截屏更硬 |

要点与坑：

1. **必须隔离 DSH_HOME**。本次用
   `DSH_HOME=D:/dsh-tui-rewrite-onddev/dsh-home`：`profiles/dsh-tui` 用 junction 指向真实
   profile（这样插件就是真机挂载的那一份），`sessions/` 是本地空目录，里面放一份**真实会话的
   字节拷贝**（目录名=header id、slug=header cwd，身份自洽）。真实 `~/.dsh` 全程未被写入
   （前后都是 9 个 slug，未新增会话）。
2. **必须给颜色**。工具 shell 里 `TERM=dumb`、`NO_COLOR=1` 会被 TUI 继承，chalk 判定无色 →
   ink 把 `bold`/`color`/`backgroundColor` 全部丢掉：此时 hover 与选中**一格都不画**，
   看上去像"高亮失效"。加 `env -u NO_COLOR FORCE_COLOR=3 COLORTERM=truecolor
   TERM=xterm-256color` 后，场景首帧就带上了
   `38;2;213;81;127`（suggestion）、`48;2;243;215;224`（pinkDayTheme 的 `selectionBg`）与 `1m`。
3. **按键注入的边界**：字母、`Enter`、`Ctrl+S`、`Ctrl+C` 与 **SGR 鼠标事件**都能忠实到达；
   **ESC 前缀的方向键/Home/End 不能**（见第 4 节）。原因是 conhost 把注入的 VT 键序列翻成
   逐字符控制台事件，宿主只看到一个孤立的 ESC。

启动命令（等价于 `dst`，只是换了 home 与尺寸）：

```bash
env -u NO_COLOR FORCE_COLOR=3 COLORTERM=truecolor TERM=xterm-256color \
  node tools/driver.mjs steps-<x>.json .onddev
```

## 3. 逐项结果

会话固定为 `74b50eef-dad8-4731-b8cb-f85cafac74ce`（真实样本的拷贝，47 条助手消息中 **12 条有文本** →
场景 12 个目标）。主题 `pinkDayTheme`：`selectionBg #F3D7E0`、`userMessageBackgroundHover #F0DCE6`。

| 项 | 结果 | 现场证据 |
|---|---|---|
| B1 键盘移动 + 高亮 | 通过 | `j j k` 后 `❯` 落在预期行；每次移动的字节差分为：旧行重画为普通文本、新行带 `38;2;213;81;127`+`48;2;243;215;224`+`1m`（`c5→c6`：`\u001b[48;2;243;215;224m\u001b[1m\u001b[13;1H❯ seq 287 …`） |
| B2 视口跟随 | 通过 | 14 行终端（可见 9 行）里连按 10 次 `j`：首行从 `seq 16` 滚到 `seq 69`，选中的 `seq 287` 始终在窗口内 |
| B3 点击选中 | 通过 | 注入 (10,10) 点击 → 宿主 `dispatchClick {col:9,row:9,handled:true}`，`❯` 与选中底色移到该行（`seq 227`） |
| B4 滚轮按格步长 | 通过（纵向） | 宿主一格 = `deltaY 3`；`wheel-down` 后选中 `seq 227→287`（+3 行），`wheel-up` 后回到 `seq 227`；横向事件宿主报 `deltaY 0`，`wheelRows` 返回 0（单元测试锁定） |
| B5 hover 不漂移 | 通过 | 指针移到某行 → 该行被重画为 `\u001b[48;2;240;220;230m`（正是主题的 hover 色）；移到另一行 → 旧行恢复普通、新行接上；移出列表 → 取消高亮 |
| C1 预填当前可见文本 | 通过 | `Enter`（以及列表上的 `Ctrl+S`）后标题为 ` rewrite · editing seq 16  (line 3/3)` |
| C2 光标/插入/删除/换行 | **部分** | 插入、`Enter` 换行、整段粘贴在提交工件里逐字节可验（见下）；方向键/Home/End/退格无法投递（第 4 节），**待人工确认** |
| C3 多字符粘贴整段 | 通过 | 一次写入的 `-PASTE-OK` 与 `REV`、换行一起，原样落在工件末尾：`…refers to here.REV\nL2-PASTE-OK` |
| C4 提交后硬约束成立 | 通过 | 插件日志 `{"message":"rewrite appended","targetSeq":16,"eventSeq":349,"chars":112}`；工件回放 8/8：C1 模型可见=改写文本、C2 消息数与 `surface.nodes` 与未注册投影时完全一致、C3 邻居逐字节不变、C4 原文仍在、C5 事件无 `surfaceOp`/`sourceEventSeqs` |
| C5 未修改即提交 | 通过 | 进入编辑器后直接 `Ctrl+S` → 回到列表并显示 `unchanged`，日志无 `rewrite appended`，工件里改写事件数仍为 0（提交前后各查一次） |
| C6 失败可见 | 通过（按"不静默"口径） | 本次未制造写入失败；提交成功/未修改两条路径都有可见状态与 JSONL 记录，失败路径由自动化用例覆盖 |
| C7 列表选中项触发提交路径 | 通过 | 列表上直接 `Ctrl+S` 进入编辑器（`h1-edit-from-list` 标题为 `editing seq 16`） |
| Esc 分层退出 | 通过 | 编辑器内 `Esc` → 回列表（`edit cancelled`）；列表内 `Esc` → 关场景回对话 |

## 4. 未能覆盖：ESC 前缀按键（方向键 / Home / End / 退格）

- 注入的字节本身是完整的：探针（同一 ConPTY、`node` 裸读 stdin）收到的 Home 是**一个** chunk
  `1b5b48`，上箭头是 `1b5b41`。
- 但宿主看到的是"ESC + 字面文本"：在宿主**自己的输入框**里输入 `abc` 后按 Home 再按 `Z`，
  输入框显示 `[HZ`（End → `[FW`、左箭头 → `[DQ`）。即 conhost 把注入的 VT 键序列翻译成
  逐字符控制台事件，宿主只收到一个孤立的 ESC（被当作 Escape 键）。
- 这解释了真机脚本里"按 Home 却退出了编辑器"的现象：那是**注入手段的失真**，不是插件缺陷；
  鼠标 SGR 报告能活下来，是因为宿主开着鼠标跟踪，conhost 会合成鼠标记录。
- 因此：**1c 的 Home/End、方向键、退格必须在真实终端上由人复核一次**（自动化用例已覆盖其逻辑）。
  同时提醒：B5 的"漂移"判据要按"移动指针后高亮跟随"来测——宿主只在指针移动时重算 hover
  （见 REVIEW.md R-017）。

## 5. 事故与规则（写给下一次）

1. **不要把身份不自洽的会话放进真实会话库**。本次曾把真实会话的字节拷贝放到真实
   `~/.dsh/sessions` 下、却换了目录 id/slug：dsh-workspace 启动时扫全库、发现身份不符即抛错 →
   插件激活失败 → TUI 永远停在 `waiting for service: workspaceRegistry`（表现就是"起不来"）。
   该目录已被用户隔离到 `~/.dsh/.backups/quarantine-fixture-session-20261015/`，全库 386 份
   只有这一份不健康。**规则：夹具一律放独立 DSH_HOME/独立 session root。**
2. **按 PID 杀进程**。`taskkill /IM node.exe` 会把宿主一起杀掉（本次就杀掉了本会话的宿主）。
   只对自己启动的进程树用 `taskkill /PID <pid> /T /F`。
3. **every run 都要能回滚**：真机跑完检查真实 `~/.dsh` 账目（slug 数、有无新会话），
   确认未被写入；本文所有运行前后都是 9 个 slug。

## 6. ⛔ P1：提交过改写的会话无法再被恢复（REVIEW.md R-019）

**这是本次真机轮次最重要的产出**：阶段 0–1c 的全部自动化（91 项）与离线工件校验都通过，
但真机启动路径拒绝打开含改写事件的会话。

现象（真机、宽终端可直接读到原文）：

```
DSH 会话没能打开：dsh-tui: cannot resume session "74b50eef-…": session "74b50eef-…" contains
event type "dsh-tui-rewrite/message" (seq 296) unknown to this harness and not marked ignorable;
refusing to interpret the log — it was likely written by a newer harness
```

随后 TUI 退回启动页（插件本身仍正常加载：`applied`/`entry points verified` 都在）。

复现链（同一份夹具，逐项只改一个变量；每项都用 `--resume <id>` 启动，看插件日志里有没有
`scene opened`）：

| # | 夹具内容 | 结果 |
|---|---|---|
| ① | 真实样本的原样字节拷贝 | ✅ 进会话，`scene opened`，12 个目标 |
| ② | 只追加**一条** `dsh-tui-rewrite/message`（插件真机提交写下的那种形态） | ❌ 启动页 + 上面的报错 |
| ③ | 同一文件按同一路径**逐行重编码**（不加事件） | ✅ 恢复正常 → 排除"重编码/帧结构"这个变量 |
| ④ | ② 的那条事件加上 `ignorable: true` | ✅ 恢复正常 → 确认根因就是这个信封标记 |

根因（上游源码）：

- 恢复时校验：`dsh-session-persistence/lib/index.js:184` ——
  `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(...)`。
- 写入侧：`dsh-session/lib/index.js:1441-1459` 的 `Session.append(type, data, ...opts)` 只取
  `surfaceOp`/`sourceEventSeqs`，**没有** `ignorable`；`KNOWN_SESSION_EVENT_TYPES` 也是固定集合，
  官方文档明确否决过第三方注册类型。**即：第三方插件用公开 API 无法写出"可被重新打开"的自有事件。**
- 为什么之前没发现：阶段 0 的探针与 91 项自动化走的是 `SessionStore.create({seed})` 路径，
  它接受 `ignorable`、也不查已知类型；**只有从磁盘恢复的路径才检查**。这正是"离线全绿、
  真机致命"的那类缺口。

影响与处置：

- 影响：用户只要真的提交一次改写，**该会话就再也打不开**（退回启动页；其他会话、插件加载不受影响）。
  这直接否掉了"改完继续用"的核心用法，因此**真机挂载已回滚**（`unmount.mjs`，junction 与 patch 行均已移除）。
- ADR `2026-10-15-event-type-namespace` 与 PLAN R1 里"闸门是死代码"的前提需要订正：
  闸门在**恢复路径**上一直生效，只是 seed 路径不经过它。
- 修法候选：(a) 上游给 `Session.append` 加 `ignorable` 选项（或对未知类型默认置位）——
  最干净，且与 dsh-session 自己的文档（`ignorable` 就是为词汇表增长准备的）一致；
  (b) 插件侧绕过 `append` 写事件（需要私有 API 或直接改日志，代价高、风险大）；
  (c) 放弃自定义事件类型（推翻既有 ADR 的命名空间决策）。
  未定案前不要在生产 profile 上挂这个插件。
