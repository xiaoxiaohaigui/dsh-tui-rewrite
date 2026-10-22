# dsh-tui-rewrite

⛔ **Alpha — 发布版 0.0.1 不可用。** 0.0.1 有一个已知 P1（R-019）：提交过一次改写后，
该会话会**无法再被恢复**。开发树已修复（0.2.1+ 官方 `appendPluginRecord`、0.2.0 受控写入守卫，
并补了真实磁盘往返测试）；真机复核 T2/T3/T4/T5 已完成（2026-10-20），
T1 的方向键/Home/End 仍待人工；项目仍处于开发阶段，暂不发布。
**在修复版发布前，请不要把 0.0.1 挂到日常 profile 上使用。**

dsh-tui 插件：允许用户**手动**改写会话历史中助手回复的文本。改写后下一轮对话
模型看到的是改写后的内容，而 append-only 的持久化日志原文不变。

> 本文件是占位版本，完整 README（安装、配置、截图）稍后补齐。

## 使用

- 入口：`/rewrite` 或 **`Alt+W`**（`Alt+R` 被宿主 Continue 动作占用）。
  profile row 的 `config.shortcut` 可以改入口，`off` 关闭全局快捷键。
- 界面语言跟随 dsh-tui：宿主 `lang` 配置 → `DSH_TUI_LANG` → `~/.dsh-tui/lang.json` → 系统 locale；
  插件 row 的 `config.lang` 可显式固定为 `zh` / `en`。

## License

MIT
