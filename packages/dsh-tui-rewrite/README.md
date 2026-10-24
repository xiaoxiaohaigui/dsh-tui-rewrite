# dsh-tui-rewrite

⛔ **Alpha — 发布版 0.0.1 不可用。** 0.0.1 有一个已知 P1（R-019）：提交过一次改写后，
该会话会**无法再被恢复**。开发树已修复（0.2.1+ 官方 `appendPluginRecord`、0.2.0 受控写入守卫，
并补了真实磁盘往返测试），真机 T1–T6 已全部完成；修复版尚未发布。
**在修复版发布前，请不要把 0.0.1 挂到日常 profile 上使用。**

dsh-tui 插件：允许用户**手动**改写会话历史中助手回复的文本。改写后下一轮对话
模型看到的是改写后的内容，而 append-only 的持久化日志原文不变。

完整 README、安装步骤与已知限制见仓库：

<https://github.com/xiaoxiaohaigui/dsh-tui-rewrite#readme>

## License

MIT
