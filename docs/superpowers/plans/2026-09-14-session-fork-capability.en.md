# Session copy capability consistency

Date: 2026-09-14. Capability guards, concurrency repair, and this isolated native acceptance passed.

The backend `ensure_fork_allowed` rejects `code_pro` while retaining existing support for other known session types. History cards, sidebar context menus, message editing and Ctrl+Enter previously exposed unsupported fork requests.

All entries share `canForkSession`. Copying is disabled for CodePro and unresolved session types with guidance to start an independent task. An unsupported keyboard fork retains the draft and does not silently become an in-place edit. In-place editing remains an explicit action. The ACP wrapper rereads the session type before dispatch. Backend lease and permission rules remain intact; copying CodePro content is outside this change.

## Public product comparison

The current Codex `fork_thread` tool contract creates an independent child task from completed history, excluding an unfinished active turn. This change adopts explicit capabilities and source isolation. It does not present unsupported CodePro forks as available. The public [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) was inspected; the current page did not provide the full fork contract, so this comparison relies on the tool description available in this session. No private implementation is inferred, and no third-party code or dependency was copied.

## Validation

Final frontend focused coverage: 29 passed across five files, exit 0 (`fork-focused-final.log`). The full frontend run preceded the additional test-only coverage: 2022 passed across 227 files, four skipped, zero failures. The final focused run covers those later tests. Type checking, lint, formatting, translation checks and compilation, and renderer build exited 0 (`fork-gates.json`).

Native acceptance exposed a loading problem that led to a deterministic regression: the outer request holds an access permit, loading obtains the lifecycle lock and drains active requests, and the inner handler waits to acquire access again. Before the fix, notification barriers reached the two-second circular-wait assertion: zero passed, one failed, exit 101 (`fork-deadlock-before-fixture-fixed.log`). An earlier missing isolated cleanup journal root was a test fixture failure, not deadlock evidence.

The repair uses request types' `JsonRpcMessage::matches_method` to identify 11 handlers that already own access guards and skips their duplicate outer permit. Inner guards remain intact: nine still require writable workspaces, while two retain their existing narrower requirements. See `fork-reentry-access-map.json`.

All backend gates passed (`fork-reentry-gates.json`): seven concurrency/permission tests; full core 3304 passed, zero failed, two ignored; ACP integration 59+55=114 passed; formatting, Clippy and backend build exited 0. Focused coverage requires entering the original concurrency barrier and checks missing/closing sessions for all 11 entries, writable requirements for nine, and the existing in-flight permit lifetime.

Real Electron checks confirmed disabled CodePro history, sidebar and message-edit entries; Ctrl+Enter draft retention; a new ordinary copy ID and persisted body; and an enabled ordinary message-fork action. With the rebuilt backend, 16 source/copy scenarios passed: 14 actual loads and two cached navigations, including eight refreshes and one process restart. Backend load times were 2162–2229 ms. Both visible body and matching load-completion logs were required for actual loads. Persisted content was checked again. No model task was sent.

Backend SHA-256: `41709ABD6B42B800EEA57B7102CFFE7288912914FA6938ECC68E66E07F4D7051`. Details: `fork-reentry-native-summary.json`, `fork-reentry-native-runs.json`, both backend JSONL captures, and `fork-persistence.json`. The first observer incorrectly expected a new RPC for cached navigation; its original mismatch and source-based correction remain in `fork-reentry-native-observer-mismatch.json`. This was not a product failure or an actual load.

All evidence is under `.cargo/evidence/audit-fixes-20260914/`. Acceptance is limited to these isolated-profile scenarios, not every possible race. Real model execution remains separately unverified while the service is stopped; that service was not contacted.
