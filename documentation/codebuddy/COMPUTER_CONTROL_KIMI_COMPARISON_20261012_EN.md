# Kimi K3 desktop-control comparison

Date: 2026-10-12, Asia/Shanghai.

## Recommendation

Keep **Kimi K3 as the primary Agent with the existing qwen_computer controller**, using Kimi K3 auxiliary vision on demand. Retain Windows-MCP v0.8.8 as an isolated candidate until host integration and control-state problems are addressed. The existing controller already uses MCP; this is a comparison of implementations and integration quality, not MCP versus a return to the removed custom/hybrid controller.

## Scope and configuration

Repository: <CodeBuddy checkout>, main at 50dfeb1be31350a54a97de40318c8d0890361eaf plus existing uncommitted common-query/weather changes. Tasks ran in the real CodeBuddy Electron/ACP application. No product source edits, rebuild, commit or push were performed in this comparison.

Only the isolated target/common-query-acceptance/home profile was changed: default, main/planner/coder/tester/reviewer and auxiliary vision all use custom_1/kimi-k3. Main and auxiliary calls were actually exercised; other roles were configured but not separately tested on development tasks. The normal user profile was unchanged.

The isolated Kimi image capability was explicitly enabled, then validated against real provider requests containing image_url. Final configuration is main-first vision mode auto, qwen enabled, candidate disabled. Original settings are in kimi-original-config-state.json. Each completed test's session controller was removed through the normal API. Final candidate serve.py process count was zero.

## Real acceptance results

| Scenario | Existing qwen + Kimi | Windows-MCP + Kimi |
|---|---|---|
| Calculator (63+19)×4 | Pass: 93 s, 12 calls, result 328 | Pass after correction: 156 s, 26 calls, result 328 |
| Restore tray-hidden WeChat and send | Pass: 89 s, 13 calls, 2 recovered tool errors | Incomplete: observed 256 s, 12 calls, 3 errors; stopped after prolonged lack of progress |
| Send with WeChat already open | No additional duplicate test | Pass: 103 s, 8 calls, 1 recovered tool error |
| Doubao draft protection, new chat, send, read reply, return to draft | Pass: 231 s, 15 calls, 0 tool errors | Incomplete: observed 111 s, 14 calls, 9 errors; persistent CONTROL_UNAVAILABLE |
| Read-only Kimi auxiliary vision | Pass: 21 s, 2 tool calls; actual separate image request and JSON response verified | Candidate auxiliary integration not separately retested |

Times are the span between first and last exported session messages, including model/tool round trips. Stopped cases are observation durations, not completion times. These are exploratory single runs, not reliability percentages or statistical benchmarks. WeChat success cases had different initial conditions and should not be directly speed-ranked. Both calculator cases cleared and recomputed despite different starting values. Images and accessibility trees were available: these are integrated product tests, not isolated vision/OCR/UIA accuracy measurements.

### Visible evidence

- WeChat header matched 小号. New outgoing bubbles K3现有验收1012-A and K3候选验收1012-B2 appeared; composer empty, no failure marker. This is sender-side visible evidence, not recipient-side delivery confirmation. Original candidate message K3候选验收1012-B has no confirmed send evidence.
- Doubao actually replied K3 现有豆包 1012-A, with completion controls and a stable repeated observation. Returning to the original composer showed 保留草稿1012：周五确认出发时间。 including the final punctuation.
- The separate auxiliary request used kimi-k3 and one image. Its JSON correctly identified the home/new-chat page and transcribed the draft. See kimi-aux-actual-proof.json. Main requests were also checked for actual images, rather than relying on model capability settings alone.

## Findings

1. **Confirmed host scheduling gap.** agent.rs classifies only qwen_computer__ calls as ordered desktop streams; desktop_tool_stream.rs concurrently merges other calls. Seven candidate Click calls began within about 104 ms and completed in different order. The screen showed 6+39; Kimi detected it, cleared it and recomputed. Evidence: kimi-windows-click-order.json. This is a host/candidate integration defect, not entirely an upstream Windows-MCP issue. A prompt asking the model to avoid concurrency is insufficient as the long-term fix.
2. **Control-state failures with an unresolved full cause.** Session 20261012_14 changed unavailable→user→ready at 23:10–23:11. The user explicitly confirmed no input and no other controller. Previously retained session instances were a possible confound; a subsequent clean single-candidate Doubao run still became unavailable. Earlier direct testing captured an indicator state-acknowledgement exception, but the same stack was not captured for every new failure. Do not attribute all failures to that cause or to user activity. The model's claim of another party owning control exceeded the raw evidence.
3. **Fast individual actions did not produce faster completed tasks.** Earlier direct warm candidate click-plus-crop samples were about 0.76–0.78 s; existing actions with observation were 1.86–1.93 s, with different returned work. Full candidate Snapshot samples took 27–29 s. Installed source also sets windows empty and active window None when UI-tree collection is skipped, potentially confusing not collected with no windows present.
4. **The current implementation also has overhead.** WeChat required recovery from two targeting errors. Doubao's first new-chat click had no effect and required refocusing. Large accessibility trees, repeated observations and model round trips add cost. Doubao cumulative input/output tokens were 845545/9606 across requests, including repeated context; this is neither a single context length nor a billing amount.

## Proposed next steps

Keep the existing controller for current use. For a candidate integration, reuse the host's ordered desktop machinery through explicit desktop-capability/shared-input classification, without spoofing trusted tool names. Enforce one desktop owner and proper session teardown while preserving user takeover. Diagnose indicator/control-state failures, distinguish uncollected data from absence, and reduce unnecessary full-tree calls and retries without progress.

After adaptation, run repeated alternating-order trials with matched starting states: calculator, Chinese input, hidden-window recovery, unique WeChat sending, Doubao draft protection, occlusion and recovery. Choose on complete task results and elapsed time. These product changes are proposed, not implemented in this report.

## Evidence and validation boundary

Local ignored directory target/windows-mcp-comparison contains kimi-results.json, kimi-*-session.json, kimi-*-ui.png, kimi-*-image-audit.json, kimi-windows-click-order.json, kimi-input-confirmation.json and kimi-aux-actual-proof.json. Raw sessions contain private desktop content and remain local.

Source references: crates/goose/src/agents/agent.rs, desktop_tool_stream.rs, extension_manager.rs. git status --short exited 0; existing changes were preserved. No full Cargo/frontend test suite or installer build was run; this phase was real desktop acceptance comparison.

[Official Windows-MCP repository](https://github.com/CursorTouch/Windows-MCP): MIT, screenshot/accessibility/input tooling. Advertised per-action latency is not end-to-end CodeBuddy task time. The recommendation above rests primarily on local evidence.
