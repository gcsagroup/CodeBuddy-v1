# 日常历史配置中的首轮卡顿

本记录补充并修正同日早先的 Harness 验收结论。早先真实 Electron 两轮测试使用少量历史及部分扩展，日常 profile 启动后没有再次发消息，因此漏掉了大历史列表阻塞。此前测试通过不代表用户日常配置已验收。

对象是 `D:\CodeBuddy-v1` 当前未提交源码（目录没有 Git 仓库）；没有分支、提交、推送、依赖安装或升级。执行、调度和完成判定仍由 Harness 主导。本文只涉及产品历史读取和侧栏刷新。

## 根因证据

- 用户 20:16 的“你好”在原生模型请求前已经等待约 183 秒；随后一次请求记录 `UND_ERR_SOCKET`，并由官方重试恢复。这两段延迟应分开，网络错误不解释此前的本地阻塞。
- 在日常 Electron、原模型、原扩展和 600 多条历史下复现：一次 `session/list` 约 11 秒，后续列表请求连续出现。见 [窗口通信记录](../../.preview-evidence/daily-ui-elx9cg/receipt.json)。此诊断在约 122 秒时被开发热重载打断，后续不作为完整对话验收。
- `Compat.info` 对每条历史调用 `CodeProRuns.latest`，后者重复 `store.read()`，同步复制所有历史。侧栏新会话轮询按次数估算 10 秒，没有计算请求耗时，使刷新拖长到分钟级，并阻塞同一 Node 进程中的模型初始化和流式事件。
- 同一份 623 条历史数据（返回 617 条未归档记录）对照：旧读取路径 618 次快照、9764.7ms；修复后 1 次快照、20.7ms。见 [同数据测量](../../.preview-evidence/history-list-before-after.json)。这是当前机器的测量，不是延迟承诺。
- 独立 MCP 连接测试约 0.66/2.47 秒；完整配置独立 ACP 重放首正文约 8.9 秒、结束约 10.5 秒。这些结果排除了“只要启用这些工具就必然卡一分钟”的推断，没有证明外网始终稳定。

## 修改与回归

`runtime/compat.mjs` 一次列表读取共享同一快照；`runtime/codepro.mjs` 允许从该快照取得最新运行投影，保留原有事实 owner。`ui/desktop/src/hooks/useNavigationSessions.ts` 按实际时间限制轮询，并在卸载后停止后续刷新。界面布局和功能不变。

新增后端回归覆盖 650 条带正文历史、最新运行身份、历史保护及后续修改可见性；新增 hook 回归覆盖 11 秒慢请求和卸载期间请求返回。相关后端合同 26/26，历史及运行回归 23/23（含一个重叠用例）；侧栏组件和 hook 13/13，命令均退出 0。首次 hook 测试缺少模块 mock，修正后通过。日志：[合同](../../.preview-evidence/history-latency-contract-tests.log)、[历史](../../.preview-evidence/history-latency-tests.log)、[侧栏](../../.preview-evidence/sidebar-latency-tests.log)。

## 日常窗口复验

20:32 使用已有 `node scripts/start-harness-preview.cjs` 入口重启当前源码；后端 PID 18652、Electron 主进程 6808，窗口已保留。旧进程关闭回执为退出 0。没有换模型或减少历史/扩展，配置逐字段比较一致。最终 625 条历史含本次新增验收会话。[最终回执](../../.preview-evidence/history-latency-final.json)包含源码 SHA256、启动身份、配置比较及可见正文与持久化匹配。

直接操作真实 Electron 新任务、默认工作区、发送“你好”，两次结果（从点击发送计时）：

| 新会话 | 创建完成 | 首正文增量 | 后台正常完成 | 正文增量数 |
|---|---:|---:|---:|---:|
| 冷启动后首个 | 1.223s | 10.035s | 10.393s | 8 |
| 第二个 | 0.878s | 8.732s | 10.232s | 96 |

两次 Harness 均为 completed，窗口可见真实回答，未出现提交错误或误报中断；第二次完整显示内容与持久化正文匹配。[首轮截图](../../.preview-evidence/daily-ui-yk1I35/result.png)、[第二轮截图](../../.preview-evidence/daily-ui-VRyp68/result.png)。后台完成时间和 UI 动画全部结束时间不同。8–10 秒首正文仍包含初始化、工具配置、网络及模型思考；不是秒回承诺。原网络断连原因尚未完全确定。

命令使用既有 Node 24：`node --test runtime/tests/history-list-latency.test.mjs runtime/tests/acp-contract.test.mjs runtime/tests/codepro-harness-projection.test.mjs`；`node --test runtime/tests/history.test.mjs runtime/tests/history-list-latency.test.mjs runtime/tests/codepro.test.mjs`；在 `ui/desktop` 执行 `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/hooks/useNavigationSessions.test.tsx src/components/Layout/NavigationPanel.test.tsx`。退出码均为 0。

macOS、数小时目标及全部首版功能不在本次缺陷修复验收结论内。
