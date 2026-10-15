# Electron 既有停止与重启续作验收

日期：2026-10-14；源码为当前 `D:\CodeBuddy-v1`，见 [source-baseline.json](source-baseline.json)。使用已有 `start-harness-preview.cjs` 入口、Node 24、原 Electron renderer、官方 Harness 0.2.1-alpha.2 与本机受控 HTTP 模型。未修改 renderer、用户 Kimi profile、依赖、分支或提交。

`node scripts/accept-controlled-codepro-resume-ui.cjs` 最终退出 0，实际 10:40:14–10:41:45 UTC。独立 profile 为 `.preview-evidence/controlled-ui-resume-RnxtKT`；[回执](../../.preview-evidence/controlled-ui-resume-RnxtKT/receipt.json)和[独立测试日志](../../.preview-evidence/controlled-ui-resume-RnxtKT/independent-tests.log)保留。

## 原界面的实际路径

1. 点击“新任务”，在原输入框发送独立开发目标。
2. 受控模型通过官方工具创建三步计划，实际写入 math 模块并提交成功回执，然后等待下一次模型响应。
3. 点击输入框旁的“停止”。owner 结束 attempt，保存 paused；无执行中 attempt、待执行副作用或不确定副作用。
4. 关闭实际 Electron 窗口，原 launcher 回收后端及 Electron 子进程。
5. 同一 profile 再次通过原 launcher 启动，点击“历史记录”打开同一个任务，点击“确认并开始”确认已有工作区。
6. 原输入框发送“继续现有任务……”，保留同一 runId。模型读取既有结构化事实，写 invoice 与 tests，运行真实 PowerShell/Node 测试，提交验证与完成提案。
7. 原页面实际显示“已完成”“测试通过”“3/3”；独立重跑 3/3 通过、退出 0。最后关闭验收窗口并检查进程回收。

最新 AppLayout 使用 WorkspacePanel，旧 CodeProControlPlanePanel 的“暂停/恢复”按钮没有挂载。因此本次验证的是可见“停止”与后续消息继续，不声称点击过不可见按钮。脚本没有调用隐藏 ACP 控制请求替代 UI 操作；Playwright/CDP 使用原生 locator 操作，页面 JavaScript 仅只读观察。

## 身份、状态与回收

| 对象 | 证据 |
|---|---|
| Session | `cb7d8ea7-7e64-47c5-b3b5-825783de2aa3` |
| Run | `3620b8c7-2a82-4342-b8dc-11d57d8de84e`，重启前后相同 |
| 路由 | `http://localhost:5173/#/codepro/pair?resumeSessionId=cb7d8ea7-7e64-47c5-b3b5-825783de2aa3` |
| 状态序列 | run_created 1 → attempt_started 2 → 首模块回执 6、任务成功 7 → 停止后 attempt_finished 8 → 继续 attempt_started 9 → 验证回执 18 / exitCode 0 → run_completed 20 → attempt_finished 21 |
| 第一轮进程 | runtime 34068、Forge 36152、Electron 主进程 34128；含子进程全部退出 |
| 第二轮进程 | runtime 36404、Forge 33268、Electron 主进程 9676；含子进程全部退出 |
| 测试编排进程 | PID 23968，最终退出码 0；9389 无监听 |
| 连续性 | 原事件前缀逐项相等；首文件 hash、mtime 不变；首 write 回执唯一；最终 pendingEffects/uncertainEffects 为 0 |
| 页面错误 | pageErrors=[]，consoleErrors=[] |

截图：[执行中](../../.preview-evidence/controlled-ui-resume-RnxtKT/01-running-before-pause.png)、[停止后](../../.preview-evidence/controlled-ui-resume-RnxtKT/02-paused.png)、[重开确认](../../.preview-evidence/controlled-ui-resume-RnxtKT/03-reopened-workspace-confirmation.png)、[已回放](../../.preview-evidence/controlled-ui-resume-RnxtKT/04-replayed-paused-run.png)、[完成](../../.preview-evidence/controlled-ui-resume-RnxtKT/05-completed.png)。停止和完成截图已实际查看。

## 保留的不完整尝试与边界

- `controlled-ui-resume-QOEUSE`：原本查找旧暂停按钮，确认当前页面没有该入口，退出 1；窗口与子进程回收。
- `controlled-ui-resume-mosbb9`：实际停止/重启/继续已到真实 run_completed，但固定模型序列没有回应官方自动压缩之后的额外请求，退出 1。原生 JSONL 明确为 compact-checkpoint；属于验收夹具缺口，原记录保留。
- 最终夹具为 owner 已完成后的少量纯文本请求补齐有限回复，重新完整运行通过。最终也出现 1 次官方自动压缩；这不证明云端压缩摘要质量。

本次为真实 Electron 用户路径、受控模型、真实文件和原生测试的 Windows 验收。与 [真实 Kimi ACP 恢复 15 项测试](2026-10-14-real-codepro-resume.zh-CN.md)分开记录，不把两份证据合成为“真实 Kimi Electron 重启已验”。没有小时级负载、复杂仓库、强杀进程或 macOS 验收结论。
