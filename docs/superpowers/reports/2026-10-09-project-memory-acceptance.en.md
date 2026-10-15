# Project memory and response-wait acceptance

[繁體中文](2026-10-09-project-memory-acceptance.md) · [简体中文](2026-10-09-project-memory-acceptance.zh-CN.md)

## Result and source

The scoped memory fixes and silent-wait limit passed acceptance. Saved project memory is shared between conversations using the same device, profile and project. This does not merge transcripts or synchronize devices. Real Windows development Electron and the installed Mac application used the configured Ollama `deepseek-v4-pro:0813`.

Source: existing `main`, base `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`, plus these fixes. The working tree also contains other existing changes. Five Rust source hashes and the rebuilt backend were checked; the installer is a dirty-working-tree build, not a clean build of only these commits. See the [merge handoff](2026-10-09-memory-fixes-merge-handoff.en.md) for commit IDs.

## Automated gates

- Each platform: 56 memory unit tests, 14 integration tests, 5 conversation-only tests and 52 task-contract tests passed. One external Hindsight test remained ignored as previously marked.
- Latest provider suite: 138 passed per platform, including five silent-wait regressions covering Chat/Responses stalled headers, heartbeats, active text/thinking/tool arguments, partial-output stalls and non-streaming compatibility.
- Audit suite: 29 passed per platform, one manual benchmark ignored by default. The benchmark was explicitly run on Windows and passed. Corrupt-history rejection, child-session orphans and cross-run isolation remain enforced.
- Applicable Windows Clippy with `-D warnings`, formatting and backend builds exited 0. Mac DMG verification, read-only mounting, installation and deep strict signature verification exited 0.

## Real application gates

Bundle41 verified save, recall in a new conversation, project isolation, update visible to an existing conversation, delete, recall after deletion, clear and recall after clear on both platforms. Evidence includes storage, tool receipts and host state. Conversation-only recall produced no execution tasks or tool calls.

Bundle42 retest timings in seconds, including model and application overhead:

| Path | Windows | Mac |
| --- | ---: | ---: |
| Save memory | 92.371 | 24.542 |
| Recall in a new conversation | 21.807 | 17.988 |
| Clear memory | 45.406 | 21.688 |
| End wait against a silent local server | 61.093 | 60.680 |
| Switch back to Ollama; reply connection restored | 10.163 | 9.737 |

The silent fixture listened only on each device's `127.0.0.1` and used no credentials. Exactly one streaming POST was observed per platform, with no automatic replay. The UI reported semantic-decision service unavailability while preserving the task for retry; this error is not necessarily persisted as an assistant message. Fixture providers and servers were removed/stopped and the test conversations restored to Ollama.

## Latency and unsuccessful attempts

Old Windows audit timings were 224.293 seconds on the first observed run and 7.785 seconds on retest. The new test executable scanned all existing history in 2.016 seconds. Cache conditions differ; this is not a controlled cold-start speedup claim. The new first save took 92.371 seconds including finalization, so the old 224-second finalization did not recur. All historical records remain validated.

A previous Mac external-model wait took approximately 286 seconds. The new default bounds silent streaming waits to 60 seconds; active SSE data refreshes the deadline. This does not accelerate external inference. Explicit provider timeout settings remain respected, and non-streaming behavior is unchanged.

Preserved failures include bundle41's 240-second UI timeout followed by late host completion and a Windows provider failure followed by a passing targeted recall retry. Initial bundle42 harness attempts selected hidden panes, did not wait for model UI updates, mismatched a provider display name, or used a session mixed with manual input; these are excluded from passing evidence. Corrected independent-session runs passed. The Windows timeout record's `turn not_started` is expected before semantic routing succeeds, not an execution failure; its subsequent recovery record has no failures.

## Boundaries

Intel hardware, Developer ID notarization, Gatekeeper interaction, Finder drag-and-drop and all unrelated product features were not accepted in this batch. The Mac artifact is an ad-hoc signed internal test installer. Cross-device memory synchronization and transcript merging are outside this change.

## Commands / 命令

Windows working directory: `D:\Users\jiangrui\Desktop\CodeBuddy`. Mac: `/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001`. Use the existing README build environment; Mac tests use `--release`.

```text
cargo test --locked --offline -p goose --lib --test codepro_project_memory_tools --jobs 1 project_memory -- --test-threads=1
cargo test --locked --offline -p goose --test codepro_project_memory_tools --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib explicit_no_tools --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib agents::tool_task::tests --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib agents::tool_audit::tests --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose-providers --lib --jobs 1 -- --test-threads=1
cargo clippy --locked --offline -p goose -p goose-providers --lib --tests --jobs 1 -- -D warnings
cargo fmt --all -- --check
```

Windows audit benchmark used the newly built test executable with `CODEPRO_AUDIT_BENCH_ROOT=C:/Users/jiangrui/.CodeBuddy/profiles/local/audit` and `agents::tool_audit::tests::completion_scan_existing_history_benchmark --ignored --nocapture --test-threads=1`: exit 0, 2,016 ms.

## Evidence / 證據 / 证据

Local, ignored evidence (not committed; contains session content):

- `target/memory-cross-chat-20261009/`: memory tests and original/retry logs.
- `target/memory-cross-chat-20261009/retest/windows-e2e.json`, `windows-refresh-retry.json`, `mac-e2e.json`, `mac-late-clear.json`: bundle41 functional acceptance and late completion.
- `target/memory-cross-chat-20261009/retest/windows-latency42.json`, `windows-timeout42.json`.
- `target/delay-fixes-20261009/`: provider/audit/Clippy/build logs, exit files, source manifest, benchmark, timeout requests and recovery log.
- `target/delay-fixes-20261009/mac-evidence/target/macos-acceptance42/`: installer validation, timeout evidence and recovery log/exit 0.
- `target/delay-fixes-20261009/mac-evidence/target/memory-cross-chat-20261009/retest/mac-latency42.json`.

## Installer / 安裝包 / 安装包

Apple Silicon bundle42: `target/macos-release-20261009-bundle42/CodeBuddy-arm64.dmg`.

SHA-256: `823a477eeca3d924c034ec20efb0d54a8f85aa00bdfd272b5aa8866e278eefa4`.

Mac desktop copy: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261009-bundle42/CodeBuddy-arm64.dmg`.

Installed acceptance app: `/Users/erjinyi/Applications/CodeBuddy-Test-20261009-bundle42/CodeBuddy.app`.

Windows backend SHA-256: `2c9271093b2c05585db42f95ed9fba8b4ef9ebb5b64cc16d5d11348c25cbc0fc`.
Mac packaged backend SHA-256: `9c92481bc2e16ddd53a2de1a6fe239e1475eb26b35f82da48e4ecae2c355cedf`.
