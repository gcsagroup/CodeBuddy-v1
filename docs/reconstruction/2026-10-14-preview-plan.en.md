# First Harness preview implementation plan

Execution: split and implement tasks in parallel inside the approved `D:\CodeBuddy-v1` workspace, with targeted tests and review. Do not create branches or commits.

**Objective:** connect the original CodeBuddy UI to actual Harness and deliver a launchable Windows development preview with explicit capability boundaries.

**Architecture:** preserve the existing UI and SDK contracts; connect a Node ACP compatibility service to a pinned Harness driver; isolate new storage and exclude the old core from new task execution.

**Stack:** Electron/React/TypeScript, Node, WebSocket JSON-RPC, deepseek-harness.

**Progress on 2026-10-14:** the first preview is implemented and delivered: 40/40 integrated tests, 40/40 existing UI/connection/routing tests, and 1069 matching frozen files. The original Electron configuration and ordinary-chat paths passed live-model acceptance. A user instance is running without a debugging port (Electron PID 2196). Default CodePro tasks, MCP, old-data migration, macOS, and complete product acceptance remain pending. See [preview usage, evidence, and boundaries](2026-10-14-preview-status.en.md).

**Live model and delivery:** the user personally configured `kimi-k3` at `https://ollama.com` and explicitly approved preserving the configuration and continuing verification. Three ordinary-chat turns returned the requested text and token usage. History replay after restart and live ordering of six user/assistant messages passed; none of the turns called tools. Preview configuration and Harness sessions are saved in the default `.preview-data` directory. `start-chat-preview.cmd` optionally opens the existing ordinary mode; the default `start-preview.cmd` retains its CodePro route. Complete tasks, live-model tool execution and cancellation, CodePro, and other capabilities remain separate acceptance work.

## Global constraints

- Freeze UI components, interactions, copy, and styles. Change only host startup, connection, and packaging.
- Include existing uncommitted source files in the baseline; treat the original project as read-only.
- Upstream research SHA: `d743267388641bc76f17c45ce8b4c231aed1d32c`. Record the actual installed package version and source identity.
- Isolate data, processes, and application identity. Do not take over old protocol registrations, change system PATH, or automatically migrate credentials.
- Deliver a verified preview slice while keeping remaining capabilities in the migration backlog. Placeholder success does not establish integration.

## Task 1: source baseline

Files: `scripts/create-source-baseline.mjs`, `docs/reconstruction/source-baseline.json`.

- [x] Obtain source files with `git ls-files -z --cached --others --exclude-standard` and copy them, excluding build artifacts, dependencies, and private files.
- [x] Record SHA256 per file, preserve copied frontend hashes, and reject overwrites of existing differing files.
- [x] Record source HEAD, dirty status, and the copied file inventory.

Verification: `node scripts/create-source-baseline.mjs --verify`; all frozen files must match.

## Task 2: actual Harness driver

Files: `runtime/harness/index.mjs`, `runtime/harness/package.json`, `runtime/harness/test/`.

```js
const driver = await createHarnessDriver({ dataDir });
await driver.createSession({ sessionId, cwd, provider, model });
await driver.prompt(sessionId, content, { onEvent, signal });
await driver.cancel(sessionId);
await driver.close();
```

- [x] Pin and load upstream dependencies, using the upstream execution loop.
- [x] Integrate sessions, streaming text/reasoning, tool receipts, and cancellation.
- [x] Verify the actual Harness path with controlled model protocol fixtures; record live provider acceptance separately.

Verification: `node --test runtime/harness/test/*.test.mjs`; record the absolute Node executable path.

## Task 3: ACP compatibility and persistence

Files: `runtime/server.mjs`, `runtime/compat.mjs`, `runtime/store.mjs`, `runtime/tests/`.

- [x] Implement local authentication, initialize, session creation/load/list, prompt, cancel, and configuration/provider methods required by the existing UI.
- [x] Map actual driver events and allow an independent control connection to stop an active prompt.
- [x] Persist new history and settings; return explicit protocol errors for unconnected methods.
- [x] Test rejected credentials, unknown methods, tool/reasoning order, cancellation, restart history, and state isolation.

Verification: `node --test runtime/tests/*.test.mjs`.

## Task 4: Electron wiring

Files: `ui/desktop/src/main.ts`, `scripts/start-harness-preview.cjs`, `start-preview.ps1`, `start-preview.cmd`, `start-chat-preview.cmd`. No changes are needed in `gooseServe.ts`, `preload.ts`, or the renderer.

- [x] Start the new Node service and reuse the existing ACP client.
- [x] Isolate userData, protocol registration, and automatic updates while preserving the UI.
- [x] Run component/type checks before launching the actual Electron entry point.

Verification: existing typecheck, targeted component tests, and the dedicated preview launch command documented in the usage guide.

## Task 5: delivery

- [x] Verify frozen files and the allowed change inventory; review that the compatibility service does not call the old core.
- [x] Exercise the preview's actual UI paths: configuration, three ordinary text turns, restart history, and message ordering; record model, PIDs, logs, baseline, and launch command.
- [x] Update Simplified Chinese, Traditional Chinese, and English usage guides and completed/pending capability lists.
- [x] Launch the preview for the user and report automated, controlled-model, live-model, and product acceptance separately. Keep the complete migration backlog in the usage guide and overall design.
