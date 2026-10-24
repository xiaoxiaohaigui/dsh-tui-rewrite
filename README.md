# dsh-tui-rewrite

⛔ **Alpha — 发布版 0.0.1 不可用。** 0.0.1 有一个已知 P1（R-019）：提交过一次改写后，
该会话会**无法再被恢复**。开发树已修复（0.2.1+ 官方 `appendPluginRecord`、0.2.0 受控写入守卫，
并补了真实磁盘往返测试）；真机 T1–T6 已全部完成（T1 的方向键/Home/End 于 2026-10-24
由用户确认）；项目仍处于开发阶段，暂不发布。
**在修复版发布前，请不要把 0.0.1 挂到日常 profile 上使用。**

dsh-tui 插件：允许用户**手动**改写会话历史中助手回复的文本。改写后下一轮对话
模型看到的是改写后的内容，而 append-only 的持久化日志原文不变。

> 本文件是占位版本，完整 README（安装、配置、截图）稍后补齐。

## 使用

- 入口：`/rewrite` 或 **`Alt+W`**（`Alt+R` 被宿主 Continue 动作占用）。
  profile row 的 `config.shortcut` 可以改入口，`off` 关闭全局快捷键。
- 列表：`↑↓` 选择，`Enter` 或**点击某行**进入编辑，`Esc` 关闭；滚轮移动选中项。
- 编辑：**点击文本**定位光标，`Ctrl+Z` 按词撤销，滚轮上下滚动（不移动光标）；长行自动软换行，`↑/↓` 一次移动一个显示行并尽量保持列，编辑框铺满终端。
- 界面语言与宿主同序：`DSH_TUI_LANG` → 插件 row 的 `config.lang` → `~/.dsh-tui/lang.json`
  → 系统 locale（`zh*` 中文；其它显式 locale 或 `C` 英文；无 locale 时中文）→ 中文。
  `/lang` 写入 lang.json，插件约一秒内跟随；插件不再读宿主 `channel.configuredLang`
  （它是静态 cordis 配置，不随 `/lang` 变化，且会压过 `DSH_TUI_LANG`，与宿主启动顺序相反）。

## License

MIT
