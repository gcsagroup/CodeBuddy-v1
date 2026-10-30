# 同事安装版连续 `<br>` 诊断

## 范围与结论

用户提供 `aaaa.json` 和截图，确认来自同事使用的安装包。本轮在 `D:\CodeBuddy-v1`、`main`、`797b2b0` 加现有未提交改动上只做调查、真实数据复现和文档记录；没有修改产品逻辑、原始导出、安装包或模型配置，没有提交或推送。当前源码可解释截图，但不代表同事安装包的精确源码身份已经核实。

结论是两个问题叠加：会话正文存在长重复尾部；HTML 显示处理把每行重复扩张为独立代码块。不是截图错觉，也没有证据表明 ComfyUI 在反复执行生成。上游首次产生重复的位置仍待原始日志确认。

## 可验证事实

- 导出 SHA-256：`d5ea1903adba1c265cf33d74218cbcbe0ab4d39e7c1f0c1ac051fd48a92356b3`。
- 会话：`f439531e-647e-41e3-bf2e-30b5f8ff644b`，13 条消息，13 个唯一消息 ID。
- 只有一次 `generate_image(operation=generate)`，之后两次 `status(wait_seconds=30)`。第一张图片有 completed 回执，为 1088×1920 PNG。
- 最后一条 assistant 消息正文为 16,896 个 UTF-16 单元，其中连续尾部是 3,315 次 `<br>\n`，长 16,575，占正文 98.1%。该条消息没有工具调用；没有实际提交 wave，也没有调用 create_desktop_pet。
- 第 6、8 条消息（从 0 计数）的正文包含 `<|channel>thought`／`<channel|>` 协议外观标记。这是可疑格式信号，不足以单独确认模型或解析器故障。
- 导出 provider_name、model_config 均为空。当前 `runtime/history.mjs:25` 明确导出 null，而非证明用户没有配置模型。导出也不保留原始 SSE、逐 chunk 时序或终止原因；不能据此确认停止、截断或当时仍在输出。

## 调用链分析

1. `runtime/harness/index.mjs:528` 将 Harness text-delta 发为 text_delta；`runtime/compat.mjs:2728` 转为 agent_message_chunk。
2. `runtime/history.mjs:112` 的导出投影按消息 ID 累加文字。`ui/desktop/src/acp/adapter/messages.ts:52` 同样按增量追加。输入必须是真增量；重复派发或上游累计快照会被忠实累加。此次导出缺少 chunk 身份，尚不能完全排除这个来源。
3. `ui/desktop/src/components/MarkdownContent.tsx:330` 在渲染前调用 wrapHTMLInCodeBlock。
4. `ui/desktop/src/utils/htmlSecurity.ts:20` 把 br 纳入 HTML 检测；`:39` 起逐行转换，每个命中行各包一对 html 代码围栏。因此 3,315 行产生 3,315 个 `<pre>`。这一步解释黑色长条，但不产生原始的 3,315 次重复，也不会结束模型请求。
5. `runtime/harness/model-response-validation.mjs` 检查的是只有推理、没有文字／工具的空响应。只要有可见 text 就会被视为 productive；这个检查不识别重复输出。输出上限由模型调用配置／上游负责，导出未记录当时的实际值，不能称其为无限预算。

## 假设及证据边界

优先排查模型生成退化或服务端格式配置：在正常文字后只有短片段持续重复，并同时存在通道标记泄漏。但目前没有同事机器的原始响应，所以这是推测，不能写成已证实的 Gemma、vLLM 或安装包根因。

这与 240 秒 ComfyUI 等待是不同阶段：这里图片已经完成，接下来是语言模型输出异常。缩短 ComfyUI 轮询间隔、加强 ComfyUI 技能或隐藏 `<br>` 都不能单独终止异常模型流。安装包回执使用 30 秒等待和旧工作流标识，只能证明与本次 240 秒开发链路的行为不同，不能确定安装包版本号。

## 复现与验证

使用已有 Node 24 和本地依赖，不安装软件、不调用模型、不产生 GPU 任务。

```text
node .local/br-loop-diagnosis/analyze.mjs
node ../node_modules/vitest/vitest.mjs run src/utils/htmlSecurity.test.ts src/components/MarkdownContent.test.tsx --maxWorkers=1
```

第二条在 `ui/desktop` 执行。两条退出码均为 0。真实导出经实际 htmlSecurity 函数和 ReactMarkdown 服务端渲染产生 3,315 个 pre；同一原文直接交给 ReactMarkdown 时为 0 个 pre。77/77 现有测试通过，说明它们并未覆盖本例的重复输出体验。证据在 `.local/br-loop-diagnosis/evidence.json`；原始文件未改。没有执行同事安装包 E2E，也没有把服务端渲染当作完整桌面验收。

## 建议的修复顺序（未实施）

1. 展示层：停止逐行把普通 HTML 包成代码块；优先沿用 Markdown 库默认的 HTML 转义方式，或对必要安全换行做 AST 转换。长重复段可折叠展示，保留复制／导出原文。不要启用任意 raw HTML。覆盖正常代码示例、HTML 示例、长文、恶意 HTML 和本次真实样本。
2. 执行层：在 Harness 已有模型流边界评估通用短周期重复保护与实际输出预算，使用结构化异常终止和现有取消链路；不要根据 `<br>` 关键词判断任务完成，也不要把无变化的持续输出当作进展。保护需要考虑合法重复代码／数据，不能盲目自动重试或重新提交已有图片。此项改变终止语义，按仓库规则需要单独确认设计后实施。
3. 供应商层：核对同事的模型名、推理服务版本、chat template、tool/reasoning parser、EOS/stop 与实际采样参数。原始 SSE 若已重复，修正客户端渲染不会修正生成；原始 SSE 正常而 native/transcript 重复，才修适配或重放。

参考：ReactMarkdown 官方说明默认转义 HTML，而非必须逐行建代码块：[react-markdown](https://github.com/remarkjs/react-markdown)。vLLM 的参数和重复检测是可对照的上游机制，是否适用取决于同事实际服务与版本：[SamplingParams](https://docs.vllm.ai/en/stable/api/vllm/sampling_params/)。不据此默认同事使用 vLLM，也不直接修改其参数。

## 还需同事侧的最小证据

安装包文件名／版本、所选模型名、故障时间段的应用运行日志，以及 `backend/harness/sessions/` 下属于上述会话的 `session.v4.jsonl`。如需确定首次重复来源，再采集该请求的原始 SSE，对照 native 消息和 transcript；不需要发送 API key 或整个凭据配置。现有导出不足以重建同一模型请求，短提示词重新测试成功也不能证明本例修复。

[繁體](2026-10-27-br-loop-diagnosis.zh-TW.md) · [English](2026-10-27-br-loop-diagnosis.en.md)
