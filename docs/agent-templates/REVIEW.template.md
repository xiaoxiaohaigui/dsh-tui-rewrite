<!-- 模板说明，实例化时删除：一个 REVIEW.md 对应一个 branch/worktree 和一个审查范围。只保留当前问题与简短关闭摘要。 -->

# REVIEW.md - <review-id>

- 范围：<base...head、PR、commit 或工作树>
- 审查者：<Agent 或人员>
- 时间：YYYY-MM-DD HH:mm
- 状态：进行中 / 已完成

## Active

| ID | 级别 | 位置 | 问题/证据/影响 | 状态 | 验证 |
|---|---|---|---|---|---|
| R-001 | P1 | `path/to/file:line` (`symbol`) | <简述> | Open | - |

## Closed

- R-000 | Verified | `path/to/file:line` | <原因和验证结果> | YYYY-MM-DD
