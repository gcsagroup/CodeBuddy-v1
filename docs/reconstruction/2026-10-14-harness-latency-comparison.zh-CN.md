# Harness 直连对比与首轮延迟

截至 2026-10-14 21:07，本地重复工作已修复，功能回归与真实对话正常；**新会话延迟目标仍未达成**。最终真实窗口两轮首正文为 13.743s、15.030s；同一会话追加消息为 3.780s。这些结果不支持“已稳定秒回”的结论。

## 对比方法

使用当前固定版本的官方 Harness `SessionController` 直接创建会话、选择模型和发送“你好”，绕过 CodeBuddy Compat、ACP 和 Electron。不是另外安装的上游 CLI。两侧使用相同 kimi-k3、high 思考档位、50 个工具、提示词、角色及 Exa/autovisualiser 扩展；配置凭据只在本机解密，不写入报告。官方源码和许可证来源见 [上游](https://github.com/deepseek-ai/deepseek-harness) 及本地 `runtime/harness/PROVENANCE.json`。

采用 Compat → 原生 → 原生 → Compat 顺序，每个样本使用独立会话。原生侧凭据在计时前注入，Compat 包含配置准备；两者均计入运行时启动、会话建立、工具发现和响应。Compat 隔离 profile 复制当前历史与配置，不执行用户日程。不是严格控制远端负载的实验，样本数也不足以估计服务 SLA。

最终四个真实请求的正文均为 48,493 字节、50 个工具，SHA256 全部相同：`3cd5669b83df33cb7647cc03a88a6b8469cea8061dc3bc8d95260b1731556385`。没有通过关闭工具或降低思考档位获得快结果。

| 最终比较 | 请求模型前 | 首正文 | 完成 |
|---|---:|---:|---:|
| Compat 1 | 8.581s | 12.401s | 13.183s |
| 官方原生 1 | 3.416s | 6.553s | 8.298s |
| 官方原生 2 | 3.441s | 7.273s | 8.628s |
| Compat 2 | 4.184s | 6.716s | 7.117s |

[最终比较回执](../../.preview-evidence/harness-compare-73Injt/receipt.json)。Compat 1 的 Exa 建连耗时 5.981s，适配准备 0.876s；第二轮本地适配与远端耗时均有变化，不能将两轮差值全部归因于代码优化。

其他批次也保留：修复前完整配置首正文 Compat 7.537/7.295s、原生 6.028/4.694s（[回执](../../.preview-evidence/harness-compare-boBe7R/receipt.json)）；之后空闲批次 Compat 8.910/6.541s、原生 5.405/4.092s（[回执](../../.preview-evidence/harness-compare-qiNbuv/receipt.json)）；另一批原生也达 12.178/13.756s（[回执](../../.preview-evidence/harness-compare-eW0vbo/receipt.json)，当时本机另有用户对话）。不能挑单次最快值作为验收。早先 20 工具原生样本仅作探索，不与 50 工具路径作等价比较。

## 已修复与剩余原因

- `runtime/secrets.mjs` 合并同一密文正在进行的 DPAPI 解密；完成和失败都清理，不缓存已解密明文。`runtime/providers.mjs` 并行读取 key 与 headers。
- `runtime/compat.mjs` 并行准备角色配置、扩展快照及原生工具清单，复用这一份快照；原有设置版本、会话身份与权限校验保留。
- `runtime/store.mjs` 支持只复制指定字段的脱离式快照；`runtime/settings.mjs` 及 Compat 配置热路径不再复制全部历史。写入、原子替换、持久化格式保持原状。同一份日常数据读取偏好 50 次：全量快照 2028ms，字段快照小于 1ms（[本地测量](../../.preview-evidence/settings-projection-timing.json)）。此数字只覆盖读取成本。
- `runtime/compat.mjs`、`runtime/harness/index.mjs` 记录适配准备、MCP 初始化、模型首增量和结束的脱敏耗时，不记录 URL、密钥、请求或响应正文，不改变官方重试与完成判定。

远程 MCP 在官方插件激活时建立连接并发现工具。目前每个会话使用独立配置作用域，新会话仍需重新连接；本次 Exa 在实际窗口分别为 2.625s、8.126s，自动可视化工具为 0.124s、0.100s。模型请求至首增量分别为 5.198s、2.703s（含思考增量），不是纯首正文时间。该路径仍有宿主建立会话、持久化投影及界面切换的额外耗时。

没有关闭 Exa、改为工具未就绪即请求模型，也没有自行建立跨会话 MCP 连接池。这些做法涉及工具可用性、会话配置快照和连接状态隔离，不能用它们掩盖本次速度验收未达标。外部服务波动没有因本地优化消失。

## 验证和当前窗口

最终源码来自 `D:\CodeBuddy-v1`，目录没有 `.git`；保留原有未提交文件，未建分支、提交、推送、安装或升级依赖。当前批没有修改前端。源码 SHA256、完整设置保持一致、631 条历史、真实 UI/持久化正文一致及启动身份见 [验收回执](../../.preview-evidence/startup-latency-final.json)，状态明确为 `functional_pass_latency_not_met`。

后端回归 58/58：`node --test --test-concurrency=1 runtime/tests/store-atomicity.test.mjs runtime/tests/settings-runtime.test.mjs runtime/tests/extension-resolution.test.mjs runtime/tests/providers.test.mjs runtime/tests/roles.test.mjs runtime/tests/acp-contract.test.mjs runtime/tests/session-extensions.test.mjs runtime/tests/model-settings.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/tests/history-list-latency.test.mjs`，退出 0，[日志](../../.preview-evidence/startup-projection-tests.log)。新增覆盖并发解密、失败后重试、并行准备顺序、650 条历史下配置快照隔离和提交可见性。

加入耗时日志后，重跑受影响目标与传输恢复测试 17/17，退出 0：`node --test --test-concurrency=1 runtime/tests/settings-runtime.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/harness/test/recovery.test.mjs`，[日志](../../.preview-evidence/startup-observation-tests.log)。包含模拟断线恢复；不是公网连接稳定性证明。

21:03 通过现有 `node scripts/start-harness-preview.cjs` 启动开发预览，后端 PID 15132、Electron 主进程 38376，使用原 `.preview-data` 和默认工作区 `D:\CodeBuddy-Workspace`。真实 Electron 点击“新任务”发送“你好”，新会话分别在 1.070s、0.884s 创建，8/68 个正文增量，两次 Harness completed，无提交错误或误报中断。对话、设置与历史均保留，窗口保持打开。

最终截图：[第一轮](../../.preview-evidence/daily-ui-fZBC2U/result.png)、[第二轮](../../.preview-evidence/daily-ui-3v1bXF/result.png)。同一会话追加的 [回执](../../.preview-evidence/daily-ui-WyQEJz/receipt.json) 为首正文 3.780s、完成 4.799s；其中 `first_visible_assistant` 会读到上一条回答，应以本轮 `agent_message_chunk` 计时，不能采用其 0.576s 值。追加消息未重做 MCP 初始化，模型首增量 2.105s。

中间未补足诊断的两批真实窗口结果也保留：13 秒附近及 10–13 秒，不能作稳定加速证明。本次只验收此缺陷链路；长任务、多模块项目、macOS、全部首版功能及之前公网断连的彻底根治不在通过结论内。后续优化重点是官方 MCP 生命周期与会话作用域，需保留所有工具能力和配置隔离。
