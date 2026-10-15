# Unified task continuation source

2026-09-15 · [繁體中文](2026-09-15-unified-continuation.md) · [简体中文](2026-09-15-unified-continuation.zh-CN.md) · [English](2026-09-15-unified-continuation.en.md)

Confirmed counterexample: `继续。` starts a new goal boundary and drops the previous unknown action from tracking. Focused RED: 0 passed, 1 failed; evidence: continuation-red.json.

The existing unified-turn source_message_id remains the goal identity. Optional message metadata task_continuation_of references that identity; turn_id still identifies an execution turn and steer only identifies delivery mode. The trusted entry checks saved state, working directory, intent, and local history before binding. Missing metadata remains compatible with old records, and user text cannot establish a relation. Goal extraction and unknown-action tracking share the resolved relationship.

Coverage is deliberately limited to existing plain continuation phrases with terminal punctuation and explicit continuation plus mouse-only constraint phrases. Cancellation, stop, explicit replacement, mixed extra content, and unmatched sources are not automatically amendments. Existing clarification semantics remain unchanged. This does not implement arbitrary language classification or enforce a mouse-only tool policy.

OpenAI public guidance describes steering as incorporating updated requirements into a continuation while preserving completed work. This change adopts task continuity and retention of the original update text. It does not infer private Codex classification or introduce external code or dependencies.

Passed: 10 public reply_codepro entry/continuation tests; 429 message-type tests; 30 tracker tests; 10 unified-turn tests; 1 existing provider regression; 114 ACP tests. Filters overlap and are not an aggregate total. Formatting, Clippy, and backend build exited 0. See continuation-focused.json and continuation-gates.json.

The public-entry test submits a mouse-only amendment, then reloads and submits a punctuated continuation. Each provider call receives the original goal, original constraint text, and unknown receipt; the original source persists and the third failure pauses execution. Legacy defaults, local source/workspace mismatches, forged text, and late old links are documented in continuation-boundary-evidence.json. The initial executor test failure omitted the public entry persistence step; its record is preserved. The final test calls the public entry directly; see continuation-test-fixture-classification.json.

The rebuilt isolated Electron app passed old-session load and Ctrl+R reload compatibility: the original message and manual mode remained visible. See continuation-native-summary.json. This proves load/reload compatibility only. Real-model understanding and autonomous desktop continuation remain NOT_RUN; neither 120 nor 107 is probed. Mouse-only tool enforcement is not implemented and remains the next slice.

[OpenAI: Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

Evidence: `.cargo/evidence/audit-fixes-20260914/`.
