# Retry accounting for invalid normalized coordinates

Date: 2026-09-14. [Traditional Chinese](2026-09-14-computer-invalid-coordinate-retry.md) is the default; [Simplified Chinese](2026-09-14-computer-invalid-coordinate-retry.zh-CN.md) is also available.

## Confirmed counterexample

Three actual ACP calls against the isolated window used `screenshot_normalized_1000`, `x:1001`, and `y:500`, each with a different fresh screenshot. All were rejected before input with “归一化截图坐标必须位于 0..1000”. Refreshing the screenshot cannot repair these coordinates, but the existing retry fingerprint counts each screenshot separately. Evidence: `.cargo/evidence/audit-fixes-20260914/computer-normalized-range-native.json`. Direct ACP bypasses the main Agent retry tracker, so these rejections alone do not verify main-loop stopping.

## Minimal design

Exclude the screenshot identifier from the failure fingerprint only for computer coordinate tools in normalized mode, an explicit error result, and the exact single known error text above. Preserve coordinates, coordinate space, target, and all other arguments. Corrected input gets another attempt. Reuse the existing second-failure review and third-failure pause; permission decisions, tool inputs, and completion criteria stay unchanged.

The current interface supplies no structured category for this rejection. Exact text classification is deliberately limited: no fuzzy matching and no extension to stale observations, changed windows, ordinary unknown receipts, or all computer errors.

## Public comparison

OpenAI's public computer-use guide requires runtimes to preserve state, apply permission rules and execution limits, and assess actions, screenshots, and final state. This design preserves reassessment with new state while bounding a known input rejection that screenshot refresh cannot repair. It makes no claim about private Codex retry algorithms and does not classify reaching a turn limit as a product defect. [OpenAI: Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)

## Validation status

Passed: 26 focused tracker tests; 3307 full goose library tests with 2 ignored; 114 ACP tests. The new executor test and related unified-turn tests passed 9/9; the existing analysis-provider regression passed 1/1. Formatting, Clippy, and the rebuilt backend exited 0.

Executor evidence confirms a persisted repair prompt after failure two, pause after failure three, exactly three provider calls, and preservation of the original goal. The first test failed because MOIM appends content to the provider message. Checking for the entire prompt constant within that message fixed the assertion while preserving exact persisted-message and stop assertions. This was an assertion mismatch with existing message wrapping, not a product regression.

Real ACP acceptance in the rebuilt isolated Electron app rejected out-of-range coordinates before input without navigation. A new screenshot and corrected coordinates then opened History; the expected button changed from absent to visible and the receipt reported `worked`. See `retry-gates.json`, `retry-execution-focused.json`, `retry-final-gates.json`, and `retry-native-summary.json` in the evidence directory above. Direct ACP, actual receipt replay, and executor tests are separate evidence. Real-model autonomous acceptance remains `NOT_RUN` because the user stopped the service. Neither 120 nor 107 is probed.
