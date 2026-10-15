# Project memory and response waits: merge handoff

[繁體中文（預設）](2026-10-09-memory-fixes-merge-handoff.md) · [简体中文](2026-10-09-memory-fixes-merge-handoff.zh-CN.md)

## Source and commits

Existing `main` checkout, base `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`. Acceptance of the rebuilt applications is complete. The following code commits are delivered together with this handoff.

### Code commits

- `7b34092cf4c90587ee592ee47263b49474ebea5e` — memory
- `803f9431b5dfd1eaaffdc4226cf79322d7d6fa40` — audit
- `bc4ff081d1bdd3f43e5d5dd55c296ca592885588` — providers

## Changes

| File | Cause and correction |
| --- | --- |
| `crates/goose/src/agents/tool_task.rs` | Successful memory deletion/clearing was rejected by completion validation. Accept typed receipts from the trusted built-in owner, bound to the original UUID/current project, including idempotent absence/empty results. Failed, forged, malformed or mismatched receipts remain rejected. |
| `crates/goose/src/agents/agent.rs` | Conversation-only turns retained an execution contract and repeated completion checks. Clear the binding where the existing conversation restriction is applied; retain evidence checks for executable tasks. |
| `crates/goose/src/agents/tool_audit.rs` | Per-record asynchronous I/O and sequential history scans delayed completion. Batch blocking I/O, reuse parsed receipts and use a shared four-thread pool. Continue locking and validating every historical session; log maximum lock/read durations. |
| `crates/goose-providers/src/openai.rs`, `openai_compatible.rs` | Custom Ollama uses the OpenAI-compatible path, which previously relied on a 600-second total HTTP timeout. Default to a 60-second silent-wait deadline covering retries and headers. Headers do not reset the initial deadline. Subsequent SSE data refreshes it; comment heartbeats do not. Stop the timed-out request without automatically replaying it. |

An explicit existing `timeout_seconds` value controls the OpenAI provider wait; otherwise the default is 60 seconds. Non-streaming responses retain their existing HTTP timeout. This bounds application waiting; it does not speed up external model inference. No new dependency, public protocol or memory migration is introduced. Audit corruption checks and completion evidence gates remain enabled.

## Colleague integration steps

1. Run `git status --short` and preserve local work using team procedures.
2. Run `git fetch origin` and verify the final commit IDs recorded here.
3. If `main` can fast-forward, run `git merge --ff-only origin/main`. Review divergence before integrating.
4. Review overlapping changes in the five files, especially conversation binding, memory receipts, audit locking, provider retries and SSE parsing.
5. Follow the existing platform README, run the [acceptance commands](2026-10-09-project-memory-acceptance.en.md), and rebuild the backend. Explicit timeout settings remain available for custom models requiring longer silent waits.

## Delivery boundaries

Different conversations in the same project can share saved memory. Full transcript sharing and cross-device synchronization are outside this scope. Other staged and unstaged work remains in the checkout and is excluded from these commits. Product acceptance uses binaries from that working tree; not all binary contents are represented by this commit batch. Profiles, credentials, raw conversations, fixtures and installers remain in ignored directories.

The Mac artifact is an Apple Silicon internal test package with ad-hoc signing. Intel hardware, Developer ID notarization and Gatekeeper interaction are not accepted here.

## Design references

Reuse the existing Rayon dependency to bound parallel I/O, following [Tokio blocking-task guidance](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html). Total HTTP timeout differs from read waiting; see [reqwest ClientBuilder](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html). SSE wait handling stays in the provider transport layer without adding another business-state decision maker.
