# Gemma thinking and contract revision fixes — 2026-10-13

[简体中文](GEMMA_CONTRACT_20261013_ZH_CN.md) · [繁體中文](GEMMA_CONTRACT_20261013_ZH_TW.md)

## Findings and changes

- The OpenAI-compatible request builder did not translate Gemma 4 thinking selection. `formats/openai.rs` now maps off to false and low/medium/high/max to true in `chat_template_kwargs.enable_thinking`. These levels do not imply different Gemma reasoning budgets. Unset preferences preserve server defaults; explicit custom template values take precedence. Existing Qwen behavior is retained.
- `main_agent_contract.rs` replaces misleading top-level field guidance with the correct `requirements[i].semantics.revision_relation` nesting. Existing `serde_path_to_error` and wire types identify structural error paths without changing accepted protocol shapes.
- `reporting/projection.rs` retains ownership of revision validation. Missing/stale relations report an array index and current revision; missing relations include an illustrative JSON shape. No relation is fabricated or silently moved. The model must select retained/replaced/withdrawn based on the user request.
- `tests/codepro_runtime.rs` extends the existing recovery regression: rejected changes preserve state, corrected changes succeed, and stale/retained checks remain. Better feedback does not guarantee every model will comply with the schema.

## Validation

Run from the repository root; all commands exited 0:

| Command | Result |
| --- | --- |
| `cargo test -p goose-provider-types --lib formats::openai::tests --jobs 1` | 96 passed: Gemma settings, explicit overrides, Qwen/OpenAI regressions |
| `cargo test -p goose --lib main_agent_contract --jobs 1` | 3 passed: misplaced fields and corrected structures |
| `cargo test -p goose --test codepro_runtime requirement_revision_recovers_after_rejected_unknown_effect_changes --jobs 1` | 1 passed: rejection preserves state and corrected revisions recover |
| `cargo test -p goose --lib run_relation_tests --jobs 1` | 7 passed: JSON fences, strict schemas, cancellation and timeout boundaries |
| `cargo fmt --all --check`, `git diff --check` | Passed |

From `ui/desktop`, `pnpm run ensure-dev-backend` exited 0 after 14m18s. Final backend: `target/debug/goose.exe`; SHA-256: `8186e7eb25a45e93d4ba29a4b56a1230985a30d5a9b8a7843f571a683f1d8b13`. The existing desktop process holds its older binary, which was not overwritten.

Logs in `target/mcp-discovery-20261013/`: `provider-tests.log`, `contract-tests.log`, `contract-runtime-tests.log`, `relation-tests.log`, `final-backend-build.log`. Source hashes: `source-manifest.json`.

### Live service validation

Using the final binary, `node target/mcp-discovery-20261013/probe.cjs target/debug/goose.exe --expect-fixed --model --thinking --both-thinking` exited 0. An isolated profile connected through desktop ACP to the actual Gemma service at `http://192.168.9.101:8001`, model `gemma-4-26B-A4B-it-uncensored-FP8-W8A16`.

| Scenario | Setting | ACP thought chunks | Result |
| --- | --- | --- | --- |
| Follow-up in the same conversation after MCP discovery | high | 325 | Correct answer 15, normal completion, no recovery decoding error |
| Another follow-up in that conversation | off | 0 | Correct answer 15, normal completion |
| New conversation | high | 153 | Correct answer 15, normal completion |
| New conversation | off | 0 | Correct answer 15, normal completion |

Wire logs confirm `enable_thinking:true` for high and false for off. Evidence: `target/mcp-discovery-acp-DuSQFu/result.json`, `responses.jsonl`, `profile/logs/llm_request.*.jsonl`. Source hashes still match the build manifest.

A preceding run of the same binary, `target/mcp-discovery-acp-BdMMVj/`, successfully classified the follow-up and answered, but failed the assertion that high must always emit visible thoughts. The wire enabled thinking and the internal classifier produced 622 thought chunks, while the final arithmetic response contained only text. Internal classification thoughts should not appear as answer thoughts. Final acceptance separately checks wire settings, successful recovery and observed answer chunks. The earlier result is retained; chunk counts are not stable performance metrics, and enabling thinking does not guarantee a reasoning response on every request.

### Acceptance boundaries

Automated tests validate rejected inputs and successful corrected revisions. The original airplane-game development task was not replayed end to end. Full Electron desktop, Mac hardware and installer acceptance were not run. Clippy was not run in this batch and remains a pre-merge gate. Building and live ACP tests do not establish desktop acceptance.

## Handoff

- Source: `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce` plus uncommitted changes; also see [MCP fixes](MCP_DISCOVERY_20261013_EN.md).
- User model settings, credentials and historical conversations are unchanged. No commit or push. The Rust layer is shared by Windows/macOS; Windows validation is not Mac hardware acceptance. Existing installers do not contain these changes.
- The model/context metadata discrepancy is separate and has not been established as the failure cause.
- Reference: [vLLM Gemma 4 reasoning mode](https://docs.vllm.ai/projects/recipes/en/stable/Google/Gemma4.html#thinking-reasoning-mode).

## Related failure found during live validation

With thinking enabled, Gemma returned a complete Markdown JSON fence containing valid `{"kind":"question"}` to the input-relation classifier. Direct JSON decoding rejected the wrapper before the actual answer. Evidence: `target/mcp-discovery-acp-TjnShw/`.

Both recovery-classification entry points in `agents/agent_clarification.rs` now use a local format decoder accepting raw JSON or one complete plain/JSON fence, followed by the original typed schema validation. Unknown relations, extra fields, incomplete fences, multiple JSON values and surrounding prose remain rejected. Classification ownership, lifecycle, permissions and task binding are unchanged.
