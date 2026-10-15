# Natural tool action presentation

Bounded acceptance completed.

Existing tool cards retain technical details. Titles use finite localized actions and file basenames, with explicit running, pending, failure, cancellation, unknown, and tool-completed states. Tool completion does not imply turn completion. Full tool names, arguments, output, and errors remain expandable.

New toolCallIds received during the current prompt attempt pass through the session store, hook, and message list. Inserted notifications no longer lose running status. Replay, existing IDs, and late result updates do not enroll. New attempts, finish, failure, and clearing empty the set. Approval requires exact IDs; explicit receipts determine terminal states. The ACP SDK defines IDs as unique within a session.

87 related tests passed. Final frontend suite: 230 files, 2053 passed, 4 skipped. Typecheck, lint, formatting, 2600-message locale validation, locale compilation, and renderer build exited 0. Session-store and message-list changes justified a full frontend rerun. Backend sources and binary hash were unchanged; no redundant Rust build.

The isolated native window used a scripted loopback provider through real chat, approval, and tool execution. Running changed to tool completed; the read-only command returned original with exit_code 0. Details and errors remained accessible; reload preserved success, tool cancellation, and unknown missing receipts. Historical failure/cancellation/missing-receipt examples were labelled fixtures, not real model results. The first shell syntax error was a fixture error and remains documented. The window, process, and provider were closed.

[OpenAI App Server](https://openai.com/index/unlocking-the-codex-harness/): public item/turn lifecycle separation informed the design; no private UI assumptions or external code.

Evidence: `.cargo/evidence/audit-fixes-20260914/natural-native-summary.json`, `natural-gates.json`, `natural-source-frozen.json`, `natural-tool-identity-audit.json`. Real model: **NOT_RUN**; 120/107 were not probed.
