# Direct Harness comparison and first-turn latency

As of 2026-10-14 21:07, redundant local work is fixed and functional checks pass. **New-session latency is not accepted.** The final two real Electron greetings produced their first text after 13.743s and 15.030s; a follow-up in the same session took 3.780s. This does not establish consistently fast startup.

## Method and results

The native arm invokes the pinned official Harness `SessionController` directly, bypassing Compat, ACP and Electron. It is not a separate upstream CLI installation. Both arms use kimi-k3, high reasoning, identical instructions, roles, 50 tools and Exa/autovisualiser. Credentials stay local. Provenance and license are recorded in `runtime/harness/PROVENANCE.json`; [upstream source](https://github.com/deepseek-ai/deepseek-harness).

The order is Compat, native, native, Compat, each with a fresh session. Native credentials are injected before timing; Compat includes credential/configuration preparation. Both include runtime startup, session setup, tool discovery and generation. The isolated Compat profile copies current history/configuration without running user schedules. Remote load is uncontrolled and this sample is not an SLA estimate.

All four final model request bodies are exactly 48,493 bytes, contain 50 tools, and have the same SHA256: `3cd5669b83df33cb7647cc03a88a6b8469cea8061dc3bc8d95260b1731556385`. No tools were disabled and reasoning was not reduced.

| Final sample | Model request starts | First text | Completed |
|---|---:|---:|---:|
| Compat 1 | 8.581s | 12.401s | 13.183s |
| Native 1 | 3.416s | 6.553s | 8.298s |
| Native 2 | 3.441s | 7.273s | 8.628s |
| Compat 2 | 4.184s | 6.716s | 7.117s |

[Final comparison receipt](../../.preview-evidence/harness-compare-73Injt/receipt.json). Compat 1 spent 5.981s connecting Exa and 0.876s preparing adapter configuration. Do not attribute the difference between samples entirely to code changes.

Other retained batches: before these fixes, Compat first text was 7.537/7.295s and native 6.028/4.694s ([receipt](../../.preview-evidence/harness-compare-boBe7R/receipt.json)); a subsequent idle batch was 8.910/6.541s versus 5.405/4.092s ([receipt](../../.preview-evidence/harness-compare-qiNbuv/receipt.json)); native also took 12.178/13.756s in a batch with another local user conversation ([receipt](../../.preview-evidence/harness-compare-eW0vbo/receipt.json)). Earlier native samples with 20 tools are exploratory, not equivalent comparisons with the 50-tool setup.

## Changes and remaining causes

- `runtime/secrets.mjs` coalesces concurrent DPAPI reads of the same ciphertext, evicting both success and failure. It does not retain resolved plaintext. `runtime/providers.mjs` reads the key and headers concurrently.
- `runtime/compat.mjs` overlaps role configuration, extension snapshot resolution and native tool activation, then reuses the resolved snapshot. Configuration revision, session identity and permission checks remain.
- `runtime/store.mjs` supports detached snapshots of selected fields. Hot settings reads in `runtime/settings.mjs` and Compat no longer clone all conversation history. Atomic writes and persisted state format are unchanged. Fifty preference reads against the same daily data took 2028ms using full snapshots and less than 1ms using selected fields ([measurement](../../.preview-evidence/settings-projection-timing.json)); this is only the read cost.
- `runtime/compat.mjs` and `runtime/harness/index.mjs` log sanitized adapter/MCP preparation and model first-chunk/end timings. No URL, credential or request/response body is logged. Official retries, execution and completion ownership are unchanged.

The official MCP plugin connects and discovers tools before activation. Independent per-session configuration scopes still reconnect on new sessions. In the final desktop samples, Exa took 2.625s and 8.126s; autovisualiser took 0.124s and 0.100s. Model stream first-chunk waits were 5.198s and 2.703s, including reasoning chunks. Session creation, persistence and navigation add further host overhead.

Exa was not disabled, requests were not sent before tools were ready, and no custom cross-session MCP pool was added. Those changes affect tool availability, configuration snapshots and connection isolation. External service variance remains despite local optimization.

## Verification and running build

Source: `D:\CodeBuddy-v1`, which has no `.git` directory. Existing changes were retained; no branch, commit, push, dependency installation or upgrade occurred. No frontend changes in this batch. [Final receipt](../../.preview-evidence/startup-latency-final.json) records source SHA256 hashes, unchanged configuration, 631 histories, rendered/persisted text agreement and launch identity, with status `functional_pass_latency_not_met`.

The following completed with exit code 0, **58/58** tests ([log](../../.preview-evidence/startup-projection-tests.log)):

```text
node --test --test-concurrency=1 runtime/tests/store-atomicity.test.mjs runtime/tests/settings-runtime.test.mjs runtime/tests/extension-resolution.test.mjs runtime/tests/providers.test.mjs runtime/tests/roles.test.mjs runtime/tests/acp-contract.test.mjs runtime/tests/session-extensions.test.mjs runtime/tests/model-settings.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/tests/history-list-latency.test.mjs
```

New coverage includes concurrent credential reads, failure retry, parallel preparation ordering, and detached/committed configuration snapshots with 650 histories. After timing instrumentation, affected tests plus controlled transport recovery were rerun: **17/17**, exit 0 ([log](../../.preview-evidence/startup-observation-tests.log)):

```text
node --test --test-concurrency=1 runtime/tests/settings-runtime.test.mjs runtime/tests/codepro-harness-integration.test.mjs runtime/harness/test/recovery.test.mjs
```

Controlled recovery tests do not prove public-network stability.

At 21:03, `node scripts/start-harness-preview.cjs` launched the current development preview: runtime PID 15132, Electron browser PID 38376, existing `.preview-data`, default workspace root `D:\CodeBuddy-Workspace`. In actual Electron interaction, two new greetings created sessions in 1.070s/0.884s and delivered 8/68 text increments. Both Harness runs completed, with no submission error or false interruption. The window remains open and existing settings/history are preserved.

Screenshots: [first](../../.preview-evidence/daily-ui-fZBC2U/result.png), [second](../../.preview-evidence/daily-ui-3v1bXF/result.png). The [same-session follow-up](../../.preview-evidence/daily-ui-WyQEJz/receipt.json) delivered first text in 3.780s and completed in 4.799s, without repeating MCP startup; model first chunk took 2.105s. Its `first_visible_assistant` measurement sees the preceding reply and must not be used as this turn's latency. Use the new `agent_message_chunk` timestamp instead.

Intermediate real UI samples around 13 seconds and 10–13 seconds are retained, not counted as stable acceleration. This batch does not accept hours-long tasks, multi-module development, macOS, all first-release features, or complete resolution of the earlier public-network disconnect. Further latency work should address official MCP lifecycle and session scoping while retaining tool capability and configuration isolation.
