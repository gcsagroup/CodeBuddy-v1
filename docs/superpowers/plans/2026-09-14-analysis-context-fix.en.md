# Project analysis context-limit repair

2026-09-14

Source repair, automated verification and backend build passed. Live model and complete desktop acceptance are blocked by gateway connection refusal and remain incomplete.

The gateway answers greetings but rejects larger analysis requests with HTTP 413 / context_exceeded. A configured 128k window does not establish the actual gateway allowance. Analysis previously injected too many extension instructions and tool definitions, then retained long tool results in subsequent requests. Compaction also had an indexing defect when removing single or odd numbers of tool results.

Read-only analysis initially offers file reading, directory listing, search and constrained shell tools. Other already-enabled read-only tools load on demand, one to three definitions at a time, replacing the selection. Loading definitions executes no tool and is not project evidence. Existing permissions, workspace checks, user instructions and project rules remain in force.

Long tool text becomes an explicit excerpt containing its first and last 512 characters in model requests. The model can read omitted ranges with focused queries. The full result remains in user-visible history. This budget applies per textual tool result; it is not a total-request, image or structured-content capacity guarantee.

Fix single/odd-result removal and verify that compaction actually reduces model-visible context. Ineffective recovery preserves history and reports the task incomplete. Ordinary chat and other execution paths retain their existing behavior.

Adopt public on-demand tool-loading principles. Do not wire Responses-only defer_loading or /compact into this Chat Completions gateway. No claims are made about private Codex internals. [OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/)

Analysis: 42 passed. Compaction: 13 passed. Full core: 3297 passed, 0 failed, 2 ignored. ACP/control: 129 passed, 0 failed, 0 ignored (1+59+55+3+11). Format and strict Clippy passed. Focused tests overlap the full suite; these counts are not additive coverage totals. Every command below ran from D:\CodeBuddy and exited 0.

```text
cargo test -p goose --lib analysis --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --lib context_mgmt::tests --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --lib --features code-mode --jobs 1 -- --test-threads=1
cargo fmt --all --check
cargo clippy --all-targets --features code-mode --jobs 1 -- -D warnings
cargo test -p goose --test acp_custom_provider_methods_test --test acp_custom_requests_test --test acp_server_test --test codepro_control_command --test codepro_control_reducer --features code-mode --jobs 1 -- --test-threads=1
```

V2 passed its first two live analysis turns but failed the third turn reading a roughly 60 KB file. The failed evidence is retained. ACP end_turn and harness exit 0 alone are not acceptance. V3 must verify file-based findings, the end marker, recovery of the previously failed conversation, and persistence after reload.

The existing installer and the user’s already-running old backend are not updated yet. Source validation is not installer delivery. Test credentials are excluded from this report.

Evidence: `.cargo/evidence/analysis-context-20260914/` (`source-v3.json`, `v3/gates.json`, `v3/*.log`, `real-analysis-acp-v2-failed.json`, `real-request-sizes-v2-failed.json`).

The V3 backend build exited 0. Real ACP session 20260914_4 returned a provider-unavailable message on its first turn, produced no project analysis, and the acceptance harness exited 1. Both models and chat endpoints then failed to connect. A 2026-09-14 16:53 Asia/Shanghai recheck still returned ECONNREFUSED at 192.168.9.107:8080. This is an external availability blocker, not evidence that live context-repair acceptance passed.

An isolated Electron instance launched with the rebuilt backend and displayed the historical conversation list. Continuing the old failed conversation, checking the end marker, analyzing the actual repository, and validating persistence after reload remain pending. The user’s existing backend was not replaced. Once the gateway recovers, run accept-analysis.mjs and accept-repository.mjs, then perform native old-conversation recovery and reload verification.

```text
cargo build -p goose-cli --features code-mode --jobs 1
node .cargo/evidence/analysis-context-20260914/accept-analysis.mjs
```

Backend SHA256: `B17C4F9FF00F63FE8D8483E85015BF345ED70472122671BC372B6A120D43BAF2`

Latest evidence: `v3/fixed-binary.json`, `v3/gateway-availability.json`, `real-analysis-acp.json`, `native-launch.json`.
