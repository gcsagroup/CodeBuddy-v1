# Tester Agent（独立验证）

## 职责

Tester 独立验证 Coder 的实现，并在必要时补充测试。核心职责是实际运行与改动相关的
测试命令，保存结构化、可核验的测试证据，而不是在文字报告中声称“测试通过”。

用户明确指定一个工作区内测试文件或一条安全白名单测试命令时，由宿主直接完成确定性
验证，不创建 Tester 模型会话。宿主复用统一 Shell 工具，只执行一次已编译命令，并保存
Shell 类型、工作目录、原始命令、真实退出码和有界 stdout/stderr。项目级测试、模糊测试
目标和需要发现范围的任务仍由受控 Tester Agent 执行。

## 输入与输出

输入：

- 上游 Coder 任务和验收标准；
- 当前项目中的实际修改；
- 返工轮次中的 Reviewer 问题。

输出：

- 最多 12 行的简明验证报告，只包含“结论、修改、验证、限制”；
- 实际测试命令；
- 工具退出码和有界 stdout/stderr 摘要；
- Tester 自己新增测试产生的 Patch 和文件列表。

验证报告不重复任务描述、不粘贴完整日志、不使用表格。测试失败、质量检查未通过、
环境限制和未运行场景必须分开说明；没有当前复现证据的历史问题只能标为“未确认”。

只有系统捕获到真实测试命令、工具调用成功且退出码为 `0`，才算成功证据。以下内容
不会被误认成测试：

- `echo cargo test`、`Write-Output pytest` 等只打印文字的命令；
- `cargo test --no-run`；
- `pytest --collect-only`；
- 只在模型报告中写“测试已通过”。

当前识别 Cargo、npm/pnpm/yarn、Vitest/Jest、pytest/unittest、Go、.NET、Maven、
Gradle 和 CTest 等常用测试命令。每个任务只提交本任务增量证据，最终运行报告仍保留
整轮累计证据。

Python 验证所用 `.venv`、`venv`、PATH Python 或 `uv run` 由宿主在 Tester 启动前探测，
Tester 不得自行搜索替代运行时或混用 PowerShell、cmd 和 POSIX 语法。明确入口无法安全
编译时不得猜测命令；一般 Tester 若连续两次提交完全相同且失败的 Shell 参数，宿主停止
当前 Worker 并保存可继续检查点。切换命令或成功执行会重置该局部计数，非 Tester 不受此
规则影响。

## 模型和失败处理

- 提供商：`ollama_cloud`
- 主模型：`glm-5.2`
- 备用模型：`kimi-k2.7-code`
- 配置键：`GOOSE_TESTER_PROVIDER`、`GOOSE_TESTER_MODEL`、
  `GOOSE_TESTER_FALLBACK_MODEL`

未运行测试、证据不可核验或 Tester 自身执行失败时，宿主标记 Agent 未完成并阻止虚假
批准。测试命令真实执行但退出码非零时，记录为项目测试失败，不伪装成 Tester 调度失败；
Reviewer 可以核对该失败证据是否支持最终结论。Test/Change 工作流的模型失败最多使用
一次备用重试，不进行第三次尝试。

## 闭环位置

`Coder → Tester → Reviewer`

宿主会为遗漏测试节点的 Coder 自动补充 Tester；Reviewer 返工后也会自动创建复验
Tester，保证每次实现都有验证。
