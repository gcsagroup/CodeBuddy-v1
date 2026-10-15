# Harness first preview: usage and acceptance

> Historical record: this describes the early ordinary-chat stage. The [current foundation delivery](2026-10-14-foundations-status.en.md) and [functionality matrix](v1-functionality.en.md) supersede it. Pending features, process IDs, and test counts below are historical.

Date: 2026-10-14. Workspace: `D:\CodeBuddy-v1`. This is a Windows development preview. Full capability migration continues under the [approved design](2026-10-14-harness-refactor.en.md).

## Versions and source identity

- Original project: `D:\Users\jiangrui\Desktop\CodeBuddy`; baseline HEAD: `964bbeb1587f1c5551ee17907e0b26632c4163ce`, including uncommitted files present at copy time. Per-file hashes are in [source-baseline.json](source-baseline.json).
- Harness packages are pinned to `@deepseek-ai/dsh@0.2.1-alpha.2` and `@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2`; upstream source identity: `d743267388641bc76f17c45ce8b4c231aed1d32c`.
- Original renderer components, styles, copy, interactions, and SDK source are frozen. Electron `main.ts` changes startup and isolation; a dedicated launcher connects the existing ACP client to the new service. Connected ordinary-chat tasks run through the actual Harness execution loop.
- Runtime: Node.js 24 and Electron 41.1.0. Delivery is a development launch; no standalone installer has been produced. No branch, commit, or push was created.

## Preview scope

| Capability | Current scope and acceptance boundary |
| --- | --- |
| Model configuration | Existing settings UI for OpenAI-compatible and Ollama connections and default model selection. First launch opens the existing configuration page. |
| Ordinary text conversations | The existing ordinary-chat ACP path connects to Harness; text, actual upstream reasoning deltas, and tool results map to the existing message UI. Default CodePro workbench tasks are not connected yet. |
| File and PowerShell tools | Harness file and Windows PowerShell tools are wired through the ordinary-session approval UI. Rejected requests do not execute. The CodePro tool chain remains separate migration work. |
| Cancellation | Stop requests are handled while generation is in progress rather than waiting for a completed turn. |
| History | Preview sessions and settings persist independently. New history can be listed and replayed after restart. Importing old history remains pending. |

This describes the first implementation slice. Existing menus and the default CodePro entry remain intact; visible menus or successful model configuration do not establish that CodePro task execution has been migrated. An optional ordinary-chat entry sets `CODEPRO_UNIFIED_MODE=false` to open the existing ordinary mode, while the default entry retains its original behavior. The user personally configured `kimi-k3` at `https://ollama.com` and explicitly approved preserving that configuration and continuing verification. Three real turns without tools passed, including history replay after restart and the ordering of six user/assistant messages. Complete tasks, live-model tool execution and cancellation, and other capabilities still need targeted acceptance.

## Launch and configure

Project-local dependencies have been prepared. Both entries share the preview data and select an available Node.js 24 runtime:

| Entry | Purpose |
| --- | --- |
| `D:\CodeBuddy-v1\start-preview.cmd` | Retains the original default CodePro workbench route for viewing configuration and existing pages. New CodePro task execution remains pending. |
| `D:\CodeBuddy-v1\start-chat-preview.cmd` | Optional existing ordinary-chat mode for the currently connected Harness text conversation path. |

Double-click the desired entry. Alternatively, explicitly use the verified runtime in PowerShell to open the default entry:

```powershell
Set-Location 'D:\CodeBuddy-v1'
& 'C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\a9ba6825a525118c\bin\node.exe' 'D:\CodeBuddy-v1\scripts\start-harness-preview.cjs'
```

The launcher compiles the existing SDK and locale resources, starts the authenticated local compatibility service, then starts the original Electron UI. It does not invoke the old Rust Agent build or launch path.

1. On first launch, add a custom provider in the existing model settings page. Choose OpenAI-compatible or Ollama, then enter your endpoint, key, and model.
2. Saving reads the model list and sends a short validation request to the configured service. The service may charge for that request under its own terms.
3. Select a real default model and check that it was saved. The user has configured `kimi-k3` and authorized retaining it; subsequent ordinary conversations can use `start-chat-preview.cmd`. The preview does not automatically connect to the source project's default LAN endpoint. Default CodePro task execution remains pending.
4. Targeted ordinary-mode acceptance proceeds through text, file reads/writes and PowerShell in a dedicated test workspace, then cancellation. Check approval prompts, tool results, and actual files.
5. Exit and relaunch to check model configuration and the preview history created during targeted tests. Ordinary-mode results do not establish CodePro acceptance.

On Windows, closing all windows exits this desktop instance; the launcher then reaps its backend. `Ctrl+C` in the launcher terminal also stops it. macOS lifecycle and release acceptance are separate work.

## Data, logs, and isolation

- Default preview data: `D:\CodeBuddy-v1\.preview-data`; backend state: `.preview-data\backend\state.json`.
- Electron profile: `.preview-data\state\electron-app`; Harness persistence: `.preview-data\backend\harness`.
- Launch receipt: `.preview-data\logs\preview\launch.json`, containing PIDs, port, paths, and exit status without authentication secrets.
- Logs: `prepare.log`, `runtime.log`, and `electron.log` in that directory. Electron main-process logs are at `.preview-data\state\electron-app\logs\main.log`.
- Original source and old data stay separate. This iteration does not automatically migrate history, configuration, memory, credentials, or schedules. New saved keys use Windows DPAPI protection for the current user.
- The candidate disables the old update channel, protocol registration, shim replacement, and default LAN injection. Debugging is off by default; controlled acceptance may use `CODEBUDDY_PREVIEW_DEVTOOLS_PORT`, bound to `127.0.0.1` only.
- Automated acceptance uses a separate absolute `dataDirectory` passed to the launcher. The user then personally configured a real service in that window and explicitly approved retaining it. Preview backend configuration and Harness sessions have been saved to the default `.preview-data` directory, with the original acceptance profile also retained. Configuration loading, history replay, and continued conversation after restart passed. This preserves data created during this preview; importing old-version data remains pending.

## Verification record

The integrated command `node --test runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/start-harness-preview.test.cjs` passed 40/40; see `.preview-evidence\automated-tests.log`. Grouped backend/launcher counts below are included in those 40 tests; the 40 existing UI tests were run separately. The frozen-source check matched 1069 files.

| Verification layer | Current record |
| --- | --- |
| SDK, locale compilation, desktop typecheck | Passed, exit code 0. |
| ESLint for the changed file | `ui/desktop/src/main.ts` passed, exit code 0. Existing Prettier warnings were left without unrelated whole-file formatting. |
| Existing UI/connection/routing tests | 40 passed: 24 model configuration/Onboarding tests and 16 connection/routing tests. |
| New launcher | 4 passed, covering real child processes, isolated profiles, first-launch navigation, startup failure, and process cleanup. |
| ACP/provider compatibility service | Integrated receipt: 20 passed, comprising 14 ACP and 6 provider tests. |
| Actual Harness driver | Lead agent's integrated receipt: 9 passed with controlled model protocol fixtures, including actual key/header transmission and checks for plaintext credential persistence. |
| ACP → Harness integration | Lead agent's integrated receipt: 7 passed, comprising 1 parent test and 6 subtests. Live provider behavior is a separate gate. |
| Real Windows Electron UI | The original configuration and ordinary-chat paths passed: model setup, three live turns, history replay after restart, and live ordering of six user/assistant messages. The renderer remains frozen. |
| User's live model service | `https://ollama.com` / `kimi-k3` returned `CODEBUDDY_HARNESS_REAL_OK`, `CODEBUDDY_HARNESS_RESTART_OK`, and `CODEBUDDY_HARNESS_ORDER_OK`, with token usage. None of the three turns called tools. Complete tasks and live-model tool execution and cancellation remain unaccepted. |
| macOS and installer | Not yet accepted. |

The live UI receipt is `.preview-evidence\real-model-ui.json`; the screenshot is `.preview-evidence\real-model-restarted.png`. The final delivery receipt, `.preview-evidence\final-validation.json`, was recorded at 2026-10-14 16:11:52 (Asia/Shanghai): Windows PowerShell 5.1 launched `powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\CodeBuddy-v1\start-preview.ps1 -OrdinaryChat`, with window title `CodeBuddy`; Electron main PID 2196, launcher PID 28420, backend PID 30200, and Forge PID 10456. This instance uses the default `.preview-data` directory with debugging disabled. User/machine environment variables, process PATH, and old protocol-registration fingerprints match the pre-launch snapshot. These PIDs describe that acceptance snapshot; consult `launch.json` for subsequent launches, where `desktopPid` identifies the Forge launch process.

## Remaining migration

- Readable import of old chat history, configuration and memory migration. Incomplete old tasks are started again in the new version.
- Imported schedules start paused; validate them individually and disable the matching old schedule before enabling the new one.
- Full MCP/plugin execution, CodePro execution and scheduling, vision/computer control, memory, skills, recipes, and other original capabilities.
- macOS credential storage, tools, real desktop flows, and release builds, following Windows acceptance.
- Production packaging, upgrade, and rollback verification.

Unconnected capabilities must report explicit protocol errors. Empty results, visible menus, and passing automated tests do not establish complete product acceptance.

Status update: this preview instance exited normally at 2026-10-14 16:14:00 (Asia/Shanghai), with desktop exit code 0. Its launcher and backend have stopped; configuration and history remain saved. Double-click `start-chat-preview.cmd` to open it again. Shutdown evidence: `.preview-evidence\shutdown-validation.json`.
