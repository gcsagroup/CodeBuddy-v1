# Repeated `<br>` in a colleague's installed CodeBuddy

Investigation only: no product logic, original export, installer or model configuration changed; no commit or push. The export came from a colleague's installer. Source inspection used `D:\CodeBuddy-v1`, main, 797b2b0 plus existing uncommitted changes. The colleague's exact build remains unidentified.

## Established evidence

- Session `f439531e-647e-41e3-bf2e-30b5f8ff644b`: 13 messages, 13 unique IDs.
- One image submission and two 30-second status calls; the first 1088×1920 PNG completed.
- Final text: 16,896 UTF-16 units, with 3,315 repetitions of `<br>\n` occupying 98.1%. No tool call follows: wave was never submitted and create_desktop_pet was never called.
- `htmlSecurity.ts` fences each HTML-containing line separately, including br; `MarkdownContent.tsx` applies it before rendering. The real export produces exactly 3,315 pre elements, explaining the screenshot. This amplifies display; it does not create the original repeated strings.
- Visible text also contains model-channel markers. The exporter explicitly writes null provider/model fields and omits raw SSE, individual delta timing and finish reason.

## Remaining uncertainty

Generation degeneration or service format configuration is the leading hypothesis, not a confirmed model-specific root cause. Without the original response, adapter/replay duplication remains possible. Existing empty-response validation accepts visible text and does not detect repetition; the actual request's output cap is unknown. This happened after image completion, outside ComfyUI's 240-second waiting phase.

## Validation and proposed work

Using existing Node 24, `.local/br-loop-diagnosis/analyze.mjs` runs the actual transformation and ReactMarkdown server renderer over the supplied text: 3,315 pre elements after transformation, zero when rendering the raw text directly. From `ui/desktop`, `node ../node_modules/vitest/vitest.mjs run src/utils/htmlSecurity.test.ts src/components/MarkdownContent.test.tsx --maxWorkers=1` passed 77/77. Both commands exited 0. No model/GPU calls or colleague-installer E2E were performed. Evidence: `.local/br-loop-diagnosis/evidence.json`.

Proposed, not implemented: avoid per-line HTML fences while preserving safe escaping and original data; evaluate general repetition protection and output budgets at the existing Harness stream boundary, using structured termination/cancellation rather than a br keyword rule or automatic image resubmission; verify provider model, template, tool/reasoning parser, EOS and sampling configuration. New termination semantics require separate design approval under repository rules.

References: [ReactMarkdown's default HTML escaping](https://github.com/remarkjs/react-markdown), [vLLM SamplingParams](https://docs.vllm.ai/en/stable/api/vllm/sampling_params/). The latter is a mechanism to compare, not evidence that the colleague uses vLLM.

Required next evidence: installer name/version, selected model, application logs for the incident and the matching `backend/harness/sessions/.../session.v4.jsonl`. Compare the original request's raw SSE with native/transcript data to locate the first duplication. API keys or entire credential configurations are unnecessary. A short successful probe would not establish a fix for the original context.

[简体完整报告](2026-10-27-br-loop-diagnosis.zh-CN.md) · [繁體](2026-10-27-br-loop-diagnosis.zh-TW.md)
