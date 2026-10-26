# 模型只返回思考内容：诊断与展示修正

日期：2026-10-26。源码基线：`189096734438abafbb3580851cdce150f4ffd520`，`main`，叠加既有未提交改动及本批修改。

## 已确认的现象

本次用户提供的绘图会话有两轮请求，每轮首次请求加五次原生重试。12 次原生 `assistant/attempt` 都只有 reasoning 块，replay 字段签名为 `reasoning`，原始结束原因均为 `stop`，最终均被校验为 `EMPTY_RESPONSE`。没有原生 `tool/call` 或 `tool/result`。响应中的协议标记和工具名只是文本，不构成工具调用。服务报告的输出 token 合计为 46,118；这不是费用计算。

当时连接为 Ollama Cloud 的 OpenAI 兼容接口，模型 ID 为 `kimi-k3`。用户批准的三次后续短请求均 HTTP 200 且正常结束：普通回答有正文；默认思考的工具请求有结构化调用；`reasoning_effort: none` 的工具请求也有结构化调用。没有执行这些工具，也没有发送原会话或保存密钥。

因此，已确认的是历史请求产生了无正文、无工具调用的思考输出；尚未确认是上游服务瞬态故障、特定上下文触发的生成/解析异常，还是特定流形态在客户端丢失。短请求成功不证明原任务恢复，原生日志也不是服务端原始 SSE。后续若复现，应对照同一请求的原始字段与适配后块，而不是增加相同请求的尝试次数。

## 本批修正及边界

- `runtime/work-status.mjs` 消费已有 `model_diagnostic` 的正文、思考、工具块计数，仅在原生失败代码为 `EMPTY_RESPONSE` 且计数完整时显示“模型只返回了思考内容”。未知或相反计数保留通用提示。重试提示保留真实次数；只有原生终态才说明本轮已停止并给出重试、切换模型和检查输出格式的建议。
- `GooseMessage.tsx` 将无失败验证证据的执行失败显示为“需要处理 / 未完成”。只有结构化 `verification_summary` 中存在 failed 才显示“测试失败”。复用既有简体、繁体、英文文案。`INCOMPLETE` 仅为显示层类型，不写入持久化或公共协议。
- 回归验证涵盖 `reasoning`、`reasoning_content`、`reasoning_text`，真实 Harness 流解析、失败诊断、重试/取消、跨会话隔离以及前端渲染。

Harness 继续持有完成、失败和重试事实；观察计数只帮助解释失败。思考文本不提升为正文、工具调用或授权。原始记录不删除，其他工作区改动不覆盖。

## 方案比较

1. 采用已有字段边界、原生校验与重试：兼容当前锁定的 MIT 许可 DSH `0.2.1-alpha.2`，不新增依赖或执行循环。
2. 不采用从思考文本抓取工具标记并执行：会把普通文本变成操作，也会绕开服务端协议边界。
3. 不自动关闭思考或切换模型：一次短请求成功不足以证明该方案能修复原任务，且会改变用户选项。
4. 本批保留原生五次重试。降低所有错误的重试次数会同时影响网络、限流和服务故障恢复；单独限制某类错误需要评估现有原生策略接口，单独确定策略边界，不在展示修复中新增重试状态机。

## 参考与复核

- [Ollama OpenAI 兼容接口](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)：接口仅兼容 OpenAI API 的子集。
- [Ollama 工具调用](https://github.com/ollama/ollama/blob/main/docs/capabilities/tool-calling.mdx)：分别消费 thinking、content 和 tool_calls。
- 锁定上游说明：`runtime/harness/node_modules/@deepseek-ai/dsh-llm-retry/README.zh.md`。公开仓库最新源码可能与已安装版本不同，以锁定包及实际回执为准。

## 本批验证结果

以下最终检查使用已有 Node 24.18.0。桌面依赖实际位于 `ui/node_modules`；首次显式定位到 `ui/desktop/node_modules` 的命令因路径缺失退出 1，修正路径后执行成功，没有安装或重建依赖。初次前端测试在默认 Node 22 下 64 项通过并有 engine 警告，随后用 Node 24 复核同一组，仍为 64 项通过。

| 检查 | 命令或入口 | 结果 |
| --- | --- | --- |
| 后端 | 仓库根：`node --test runtime/tests/work-status.test.mjs runtime/harness/test/response-channels.test.mjs runtime/harness/test/model-response-validation.test.mjs runtime/harness/test/empty-response-recovery.test.mjs runtime/harness/test/recovery.test.mjs` | 45 项通过，退出 0 |
| 前端 | `ui/desktop`：`node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/GooseMessage.test.ts src/components/GooseMessage.handoff.test.tsx src/components/GooseMessage.stream.test.tsx src/components/codepro/codeProPresentation.test.ts` | 64 项通过，退出 0 |
| 类型检查 | `ui/desktop`：`node ../node_modules/typescript/bin/tsc --noEmit` | 退出 0 |
| ESLint | 对上述五个受影响 TS/TSX 源文件和测试执行既有 ESLint，`--max-warnings 0 --no-warn-ignored` | 退出 0 |
| 差异检查 | `git diff --check`，限定本批文件 | 退出 0 |
| 真实桌面 | 标准 `scripts/start-harness-preview.cjs` 的 `startPreview`，隔离 dataDirectory；实际输入框发送、失败后再次发送、重新加载 | 三次交互验证均退出 0 |

桌面构建来自本目录当前源码，包含既有 dirty 改动。模型为本地 HTTP 夹具，不访问云端、不执行工具；原生日志有 6 条失败 attempt、5 次重试、0 次工具调用、先 error 后 completed 的两轮终态，HTTP 夹具共收到 7 次流式请求。页面实际显示“需要处理 / 未完成”及思考独占提示；下一轮正文恢复并清除错误条；重新加载保留正确记录。已检查真实截图。开发启动有依赖 sourcemap 缺失警告，未发现本批相关 renderer 异常；没有修改依赖处理这些警告。

本地探测脚本、隔离 profile、日志和截图在 `.preview-evidence/response-diagnosis-20261026/`，不纳入提交。未创建分支、提交、推送、制作或安装发布包。上游根因仍待原请求级复现；本批修复的是诊断和显示准确性，不宣称彻底修复模型生成异常。

验收预览已关闭：桌面与标准启动器均退出 0，启动回执为 stopped。CDP 关闭命令因目标先关闭而返回连接结束错误（该辅助命令退出 1），以桌面退出码与启动回执核实收尾成功。
