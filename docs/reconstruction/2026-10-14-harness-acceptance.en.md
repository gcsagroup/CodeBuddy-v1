# Harness-owned execution: acceptance record for this batch

> The user's daily profile exposed a large-history stall at 20:16 that this earlier batch did not cover. The evidence below is historical, not daily-profile acceptance. See the [follow-up](2026-10-14-history-latency.en.md) for the cause, fix and daily-window verification.

Date: 2026-10-14, China Standard Time. Scope: current source in `D:\CodeBuddy-v1`. Original revision `964bbeb1587f1c5551ee17907e0b26632c4163ce` and copied uncommitted files are recorded in [source-baseline.json](source-baseline.json). This directory has no Git repository; no branch, commit or push was created. Official npm Harness remains pinned to `0.2.1-alpha.2`, an MIT developer preview. See [PROVENANCE.json](../../runtime/harness/PROVENANCE.json) for npm/source correspondence limits.

[简体中文](2026-10-14-harness-acceptance.zh-CN.md) · [繁體中文](2026-10-14-harness-acceptance.zh-TW.md) · [Functionality matrix](v1-functionality.en.md)

**This batch passed real-model ACP chat, six-module stop/backend-restart/resume, final real Electron two-turn display recheck, controlled Electron recovery and current-source preview launch. Complete regression passed 327/327, the subset after a display revision 30/30, and component regression 42/42.** This is not acceptance of every first-version feature or a release installer; the earlier preview's 286 tests are not this batch's full suite. The 20:05 [final source identity](../../.preview-evidence/harness-final-source.json) records Node `v24.21.0` and SHA256 for 19 files. The [final frontend comparison](../../.preview-evidence/harness-frontend-final-comparison.json) checks 1069 files: 1067 unchanged, two approved changes and zero unexpected differences.

The only frontend changes are `ui/desktop/src/components/ProgressiveMessageList.tsx` and its `.test.tsx`: omit empty activity sections when ordinary chat has no actual operations, retaining reasoning and real tool display. This is the user-approved display adaptation, not an entirely unchanged frontend. The historical 19:53 finding of 1069 unchanged files remains in the [pre-change snapshot](../../.preview-evidence/harness-source-before-empty-activity.json).

The 19:55 [source UI recheck](../../.preview-evidence/harness-source-ui-current.json) records the original project's current HEAD as `dfdc47fb1a8d483fc02293b85d977e87a8969f10`, with 1074 original UI files matching the copied baseline. This current HEAD is distinct from the initial baseline revision above.

## Findings and limits

| Symptom | Verified fact | Change and boundary |
|---|---|---|
| Slow conversation creation | Previous `session/new` awaited Harness, configuration decryption and extension initialization. Isolated timings: protected global configuration 7916ms, explicit configuration 13320ms, slow MCP 15849ms | Persist the conversation first, initialize at first execution and reduce repeated decryption. Corresponding timings: 4ms, 279ms, 274ms. Initialization still has a cost; independent MCP connections start concurrently with individual errors retained |
| Long wait followed by a burst | Original native first-delta waits were 26.768s / 19.298s, then native text deltas were already concentrated within 14ms / 19ms, before ACP. Controlled spaced SSE remained spaced through Harness, ACP and the original renderer adapter | Current real SDK and raw SSE requests both stream. The historical service, network or request-specific cause remains undetermined. Added redacted timing/status/network-cause observation does not establish a fix for an unproven service issue |
| Completed answer marked interrupted | Native `completed` was misclassified because the former CodeBuddy completion protocol required `codebuddy_task(answer)`: an adapter defect | Ordinary turns follow native completion; long tasks consume native goals without requiring the old registration protocol |
| Separate Connection error | The 19:13 native event was an actual `TRANSPORT / Connection error.`; the old configuration forced zero retries | Official bounded retries are restored and real errors remain visible. Recovery is improved without claiming the historical disconnect source is known |

[Before](../../.preview-evidence/session-new-timing-diagnostic.json) and [after](../../.preview-evidence/session-new-timing-diagnostic-after.json) creation timings are isolated backend scenarios, not a latency promise for every machine. The default container remains `D:\CodeBuddy-Workspace`, with one directory per task and explicit project selection preserved.

Original session `c4117cd6-e198-4d7a-8ada-6ffdbd15ea85` termination details are in the [authority migration record](2026-10-14-harness-authority.en.md). The [controlled streaming receipt](../../.preview-evidence/stream-timing-bgBLI9/receipt.json) has three chunks approximately 350ms apart and Harness-to-ACP latency of 15.45 / 2.46 / 2.26ms. This validates the adapter path, not a real Electron screen workflow.

## Fact ownership and implementation scope

| Area | Official owner | CodeBuddy adaptation |
|---|---|---|
| Execution and child scheduling | Session Controller, AgentLoop, subagent | Host integration, permissions and role model selection in `runtime/harness/index.mjs`; concurrency 1–32 maps to the official total child limit, without a second coder scheduler |
| Goals and automatic rounds | goal / goal-round-driver / tool-goal | `profile.mjs` enables official plugins; prompt transport stays attached while active+armed. Stop disarms; restart does not replay. Structured resume attaches events/permissions before official CAS resume |
| Todos and completion display | todo/write, turn/start, goal/change | `codepro.mjs` only projects structured facts. Todos belong to the current turn, without invented DAG dependencies. harness_turn/harness_goal do not establish independent test success |
| Creation and communication | Product conversations, existing ACP and Electron bridge | `compat.mjs` separates creation from runtime initialization; frontend wiring yields to native backend authority |
| Network recovery | Official llm-retry | `transport-observation.mjs` observes allowlisted codes, timing and counts only; no content, credentials, headers or URLs, and no fetch/stream modification |
| MCP/settings/memory | Official MCP, tools, storage-domain/storage-json | Product settings, permissions and presentation remain. External memory may use MCP; no separate built-in upstream memory provider is claimed |

See the [runtime README](../../runtime/harness/README.en.md). Independent MCP connections run concurrently with visible individual failures. The official default 60-second timeout is per request; version negotiation may involve several requests, so it is not an overall extension startup deadline.

## Real model and streaming measurements

The saved `kimi-k3` configuration was used with isolated data roots. These samples were collected at different times; full prompts and runtime parameters are not guaranteed byte-identical, so they are not a controlled equivalent performance A/B.

| Path | First delta / first answer text | Duration and chunks | Receipt |
|---|---|---|---|
| Raw SSE, 48 tool schemas, high effort | First network body 2.217s | 4.131s; 37 network chunks, 70 SSE frames; no tools executed | [HTTP 200](../../.preview-evidence/diagnosis-20261014/direct-sse.json) |
| Official Harness driver, 48 tool schemas, high effort | First reasoning 2.885s; first answer text 3.516s | 4.282s; 143 deltas: 58 reasoning + 85 answer text; network chunks span 1.392s; zero attempted tools | [passed](../../.preview-evidence/official-real-stream-4WEjgH/receipt.json) |
| First greeting in a new ACP conversation | First answer text 6.639s, including first runtime initialization | 7.917s; 117 answer chunks span 1.252s | [passed](../../.preview-evidence/native-chat-xvSway/receipt.json) |
| Second turn in the same ACP conversation | First answer text 3.003s | 3.816s; 89 answer chunks span 0.608s | Same receipt; both end_turn / harness_turn, no tool receipts |

ACP `session/new` took 4ms, excluding directory selection, window rendering and other user interactions. The ACP samples were taken around 19:35 China Standard Time.

At 19:52–19:53, a separate two-turn chat used the original renderer, real Electron, saved model and isolated profile: [real UI receipt](../../.preview-evidence/real-chat-ui-xXzIZR/receipt.json). A new conversation became visible in **478ms**, without a directory picker. First turn: first answer text 9.973s, full answer visible 12.624s, 81 chunks / 4 UI commits. Second turn: first answer text 2.802s, full answer visible 6.812s, 152 chunks / 5 UI commits. Complete ACP/DOM text matched in both turns; both were completed/harness_turn with no pageErrors or consoleErrors. Acceptance processes were reaped. This accepts ordinary chat, not every page or tool. The first answer still took roughly ten seconds to begin, distinct from fast conversation creation.

At 20:03–20:04, the [final real two-turn display recheck](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json) after those frontend changes passed. The new conversation became visible in **361ms**, without a directory picker. First turn: first answer text **11.807s**, complete answer visible **15.207s**, 109 chunks / four UI commits. Second turn: first answer text **3.084s**, complete answer visible **6.759s**, 135 chunks / five UI commits. Full text matched and both turns completed as harness_turn. Reasoning remained visible; there were no empty operation counters or ordinary-chat verification cards, and no pageErrors/consoleErrors. Acceptance processes were reaped. The first answer still took 11.807s to begin; fast conversation creation does not establish low model response latency.

## Six-module development, stop and restart

The [project receipt](../../.preview-evidence/native-project-SI0dN5/receipt.json) reports `passed`, from 19:35:31 to 19:37:00 China Standard Time, approximately 89.8 seconds. The real model used ACP, official Harness and actual tools to implement money/catalog/cart/discount/inventory/order. Only `packages/*/index.mjs` could be modified; the test contract was read-only, and networking, installation and Git writes were prohibited.

1. Following native create_goal/todo and the first persisted file write, the client sent `session/cancel`; the first prompt was cancelled and the run paused.
2. The backend server was closed and recreated, a fresh workspace lease acquired, the original conversation loaded and a continuation sent. This restarts the backend instance, not an OS process kill or Electron restart.
3. Session `b793f5e7-e334-44b2-a9b2-cd22a9c8b81a`, run `b39c0b2b-aa60-41ab-b0a3-2eeeff66a0fe` and the historical event prefix were preserved.
4. The native test command exited 0. An independent contract rerun passed **33/33**, without failures, cancellation or skips: [log](../../.preview-evidence/native-project-SI0dN5/independent-tests.log). The test-file hash was unchanged. An independent disk check confirmed the initial money file retained its exact SHA256 and mtime, with one final write receipt for that path.
5. Native goal `goal-7b1c87ab-9a6f-44a0-a6ca-f3df736e3a0b` was complete, projected as harness_goal. Initial phase 48.142s; resumed phase 41.108s; first resumed answer text 2.936s.

Native `roundsStarted: 0` means this real sample did not trigger automatic goal continuation; that behavior is separately established by controlled official-plugin regression. **This proves minute-scale six-module work and backend restart recovery, not hours-long unattended work, large production repositories, real concurrent cloud agents or the complete toolbox.**

## Controlled Electron recovery

The [current Electron recovery receipt](../../.preview-evidence/controlled-ui-resume-ox7zjR/receipt.json) reports passed. Real UI controls with a controlled HTTP model stopped work, closed/restarted the desktop, loaded and resumed run `b6108765-a665-4f80-88da-27dda281a3c2`. There were 14 native tool calls and five todo writes; the goal finished complete. The initial file hash/mtime and history were preserved, independent [3/3 tests exited 0](../../.preview-evidence/controlled-ui-resume-ox7zjR/independent-tests.log), and pageErrors/consoleErrors were empty. This validates the desktop control path separately from the real cloud-model six-module ACP sample. The UI task report still lacks an independent verification label; actual command receipts remain the evidence, without inventing a label from display text.

## Automation and final results

Targeted Harness command, using installed Node 24:

```powershell
node --test --test-concurrency=1 runtime/harness/test/driver.test.mjs runtime/harness/test/capabilities.test.mjs runtime/harness/test/recovery.test.mjs runtime/harness/test/goals.test.mjs
```

[One combined run passed 39/39, exit 0](../../.preview-evidence/harness-final-39.log). After extending concurrency to 1–32 and the maxTurns+goal boundary, the affected subset passed [27/27, exit 0](../../.preview-evidence/harness-goal-capacity-boundaries.log). They overlap and are not summed. Covered boundaries include automatic continuation, CAS, stop/restart without replay, automatic compaction retaining goal/todo, partial-stream retry with one tool side effect, AUTH without retry, cancellation during backoff, concurrent MCP startup and explicit timeouts. At maxTurns the official goal becomes disarmed, without false completion.

| Gate | Status | Actual receipt |
|---|---|---|
| Backend/scripts suite for this batch | **PASS 327/327, exit 0** | [Complete-suite log](../../.preview-evidence/harness-authority-final-tests.log), 228.410s, zero failures/cancellations/skips. The subsequent ordinary-chat display revision passed its [30/30 affected subset](../../.preview-evidence/harness-terminal-display-tests.log), exit 0, 5.859s. Counts are not summed |
| Final real Electron ordinary-chat display | **PASS: UqLIqK, 20:03–20:04** | [Final receipt](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json): both complete answers matched, no empty operation counter/verification card, reasoning retained and no UI errors. The earlier empty-counter assertion failure in [HKem83](../../.preview-evidence/real-chat-ui-HKem83/receipt.json) remains preserved |
| Current candidate controlled Electron stop/restart/continue | **PASS, controlled model** | Receipt above: same run, complete native goal, actual tools, independent 3/3, no UI errors |
| Display adaptation component regression | **PASS 42/42, exit 0** | Three component test files, 33.21s; [log](../../.preview-evidence/real-chat-ui-UqLIqK/component-tests.log), exact command below |
| Current-source user preview launch | **PASS, process running** | [20:06:38 launch receipt](../../.preview-evidence/harness-final-preview.json), 19 matching source hashes and a visible new-task page; not a release installer |

Exact commands for the complete run and the affected regression after the display revision follow. The second run follows the first; their counts are not added:

```powershell
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' --test --test-concurrency=1 runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/*.test.cjs scripts/*.test.mjs *> .preview-evidence/harness-authority-final-tests.log
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' --test --test-concurrency=1 runtime/tests/harness-authority-acp.test.mjs runtime/tests/codepro-harness-projection.test.mjs runtime/tests/codepro-integration.test.mjs runtime/tests/codepro-harness-integration.test.mjs *> .preview-evidence/harness-terminal-display-tests.log
```

Component test working directory: `D:\CodeBuddy-v1\ui\desktop`. The receipt's [componentValidation](../../.preview-evidence/real-chat-ui-UqLIqK/receipt.json) preserves the original run; it was not repeated for logging:

```powershell
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/ProgressiveMessageList.test.tsx src/components/ToolCallExpandable.test.tsx src/components/GooseMessage.stream.test.tsx
```

## Current preview launch and retained data

The existing `start-preview.ps1` entry point was launched through hidden PowerShell process 36220: launcher 25292, backend 36136, Forge 38156 and Electron main process 39740. At 20:06:38 the CodeBuddy new-task window was visible, handle 33295174, with all 19 current source hashes matching. SDK/i18n preparation gates exited 0. The application remains running; its lifecycle is not reported as exit 0. The read-only launch inspector exited 0.

All 621 prior conversations in the user `.preview-data` directory remain; the current count is 621. The default `kimi-k3` and provider configuration fingerprint are unchanged, one imported schedule remains paused, and `D:\CodeBuddy-Workspace` exists. See the [launch/data receipt](../../.preview-evidence/harness-final-preview.json). No model request was submitted by this check; actual execution evidence is recorded in the isolated acceptance above. Runtime logs are `.preview-data/logs/preview/runtime.log` and `electron.log`.

The [environment comparison](../../.preview-evidence/harness-final-environment-comparison.json) reports unchanged with no differences: User/Machine/Process PATH and protocol registration fingerprints were retained. This delivery is a Windows development preview from current source, not an installer or macOS delivery.

## Remaining first-version gaps

The [functionality matrix](v1-functionality.en.md) retains pending remote/restore/conflict Git operations, GitHub accounts/PR/CI, Nostr, local ASR, advanced recipes, OAuth and real desktop workflows for every setting/tool. Windows evidence does not replace macOS, installers, hours-long work or large real repository acceptance. Implementation, controlled automation, real-model ACP, real Electron and release acceptance remain separate statuses.
