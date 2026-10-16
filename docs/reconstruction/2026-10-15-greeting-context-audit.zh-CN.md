# “你好”占用 8k 的会话取证

日期：2026-10-15。对象：16:29 的 kimi-k3 会话 `411ca1a4-5bb7-4048-bc5a-49b25f36e62d`。当前运行安装版为 1.43.3-harness8，PID 25012。源码目录 D:\CodeBuddy-v1，main / 01610d03764570282eee439cd2bfb49fcd373e98，包含前批未提交改动。安装目录的 index、profile、tool-discovery、compat 与当前源码 SHA256 一致。本轮只调查，未修改产品、重启应用或发送新的模型请求。

## 已确认事实

本轮仅一次原生模型请求、零工具调用；用户消息只有两个字“你好”，没有旧聊天混入。服务端报告输入 6,638、输出 101、合计 6,739。底部收到的却是 `used=7927, source=local_estimate`，容量 32,768。

按当前 Harness 计量算法重放日志，可精确复原 7,927：

| 项目 | 原始内容 | 本地估算 token |
| --- | --- | ---: |
| 43 个常驻工具的声明 | 24,840 字符 | 6,214 |
| 系统提示 | 6,026 字符 | 1,511 |
| 工作目录及沙箱运行上下文 | 458 字符 | 123 |
| 用户“你好” | 2 字符，加消息结构 | 9 |
| 助手回复及思考 | 正文 151、思考 78 字符，加消息结构 | 70 |
| 合计 | | 7,927 |

表内为 Harness 的每四字符约一个 token 加结构开销的估算，不是 Kimi 对每项的实际分词。服务端只给总量，不能把估算分项直接称为实际计费分项。7,927 比服务端合计 6,739 多 1,188，约 17.6%。这不是本轮多发了 1,188 token。

## 大头从哪里来

工具声明占本地总估算约 78%。43 个工具包括：

| 来源 | 数量 | 声明字符数 | 字符估算约数，未分摊数组框架 |
| --- | ---: | ---: | ---: |
| 当前 profile 启用的 Harness 原生工具 | 23 | 14,702 | 3,676 |
| CodeBuddy Git 适配工具 | 14 | 4,243 | 1,061 |
| CodeBuddy 注册的 coder/planner/reviewer/tester 角色入口 | 4 | 4,674 | 1,169 |
| CodeBuddy 项目记忆入口 | 1 | 439 | 110 |
| MCP 工具发现入口 | 1 | 738 | 185 |

23 个原生工具是本产品 profile 的启用选择，不是所有 Harness 应用的最低固定成本。角色入口复用原生 subagent 插件执行，但每个入口都有单独的完整 schema，此外仍有通用 subagent。

此会话可发现 163 个 MCP 工具，首请求实际含 **0 个 MCP 完整 schema**。harness8 的 MCP 按需加载已生效。不过 `tool-discovery.mjs` 只过滤 `assembly.tools`；原生 MCP 插件单独把服务器说明加入 `systemPrompt.section`，所以 autovisualiser 的说明和八种工具摘要仍常驻，约 1,204 字符。这是按需加载未覆盖的提示层开销。

系统提示还包含两段相近的 CodeBuddy 身份提示（202 与 258 字符）、空项目记忆仍携带的 1,111 字符说明、808 字符 CodePro 工作原则，以及原生文件、后台任务、目标等使用规则。本次没有载入完整技能正文、项目源码或旧会话历史；记忆 records 为空。

## 为什么页脚 6.6k，底部 8k

安装的原生 `dsh-token-meter/lib/index.js` 在 `measure()` 中，仅在 provider usage 不低于估算 anchor 时采用 usage；否则保留估算。本会话 6,739 小于 7,927，因此保留估算。`runtime/harness/index.mjs` 使用这个 meter 作为 used，并正确标记 local_estimate；`runtime/context-updates.mjs` 透传来源。前端 `gooseSessionNotifications.ts` 只投影 used 等数字，未投影来源，因此界面没有提醒它是估算值。

旧项目 `crates/goose/src/acp/server.rs::build_usage_updates` 读取 session.usage.total_tokens；`agents/reply_parts.rs::update_session_metrics` 在普通响应中记录 provider usage。新旧普通响应的底部统计语义因此有差异。没有同模型、同插件、同配置的旧版对照会话证据，不能进一步声称旧版实际请求一定更小。

33k 来自本次请求记录的 32,768；适配层在缺少模型容量时使用该默认值，并非 Harness 对所有模型的固定上限，也不是 Kimi 的理论容量证明。

## 结论与后续修复边界

共同原因是本产品选用的原生工具常驻、CodeBuddy 适配工具和提示继续叠加，以及保守估算没有在界面区分。不是“你好”很长，不是 MCP 163 个 schema 再次全量注入，也没有本次执行旧 CodeBuddy 调度核心的证据。此前把 MCP schema 隐藏解决了较大的部分，但未完成全部提示开销优化。

建议在保留 Harness 注册、权限和执行所有权的前提下：

1. 扩大按需投影到 Git、角色入口等工具组，保留发现入口与必要基础工具，不做“你好”关键词特判。
2. 让功能专属提示随能力加载，合并重复身份说明，压缩空记忆说明；保留权限和项目记忆边界。
3. 分开表达服务端实测用量与 Harness 保守预算估算，不为降低显示数字而降低压缩安全预算。
4. 验证问候、Git、记忆、角色协作、电脑控制及长任务；逐项确认按需加载不使功能消失。本报告不承诺未实测的目标 token 数或延迟。

## 验证与证据

原生 session.v4.jsonl、实际 state.json 选定会话用量、当前源码和安装目录只读取证。执行 `.preview-evidence/hello-context-audit.mjs`，退出码 0，算术复原 7,927，与界面事件完全一致；输出 `.preview-evidence/hello-context-audit.json`，不含凭据。没有运行新模型对话或产品 E2E，不将历史验收当成本轮复测。本轮新增三语诊断文档与忽略的本地取证脚本；没有提交或推送。
