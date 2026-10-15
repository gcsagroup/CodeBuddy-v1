# CodeBuddy Task-Oriented Navigation, Toolbox, and Automation Redesign

Date: 2026-09-04
Status: Approved by the user
Language: English

## 1. Background

The product currently exposes Recipes, Skills, Apps, Scheduling, and Extensions as top-level concepts. These labels mirror implementation details but do not directly answer the questions most users have: what can I do, how do I start, and did the feature actually take effect? General settings also mix a raw configuration editor with tool-display, input, and security controls, raising the learning curve and the risk of accidental misconfiguration.

This design extends the goal-oriented direction in `2026-08-31-settings-center-redesign-en.md`. Where the documents conflict, this specification takes precedence for the approved terminology, removal of the raw configuration editor, and capability aggregation model.

## 2. Goals and non-goals

### Goals

- Make the primary product structure understandable as New Task, Common Tasks, Automatic Tasks, Toolbox, History, and Settings.
- Preserve existing Skills, Apps, MCP/Extensions, Scheduler, and task-template capabilities without breaking stored data, deep links, or execution behavior.
- Present CodeBuddy-managed built-in capabilities, working methods, mini tools, and MCP connections in one Toolbox with explicit source, health, usage, and dependency information.
- Base every “actually used” claim on local runtime events, never on enablement, page views, or configuration tests.
- Complete acceptance with a real MCP connection and a real local file, producing auditable evidence.

### Non-goals

- Do not collapse Skills, Apps, MCP, and the scheduler into one backend object type.
- Do not rename project directories, historical session paths, or existing identifiers.
- Do not scan or import `C:\Users\jiangrui\.codex\skills`; the Toolbox shows only capabilities managed by CodeBuddy.
- Do not add cloud telemetry, a capability marketplace, or a new account system in this redesign.

## 3. Approved information architecture

| New label | Existing feature | User meaning |
| --- | --- | --- |
| New Task | New conversation | Describe what needs to be done now |
| Common Tasks | Recipes | Save and repeat a proven workflow |
| Automatic Tasks | Scheduling | Run a Common Task at a chosen time |
| Toolbox | Skills, Apps, and Extensions | View, configure, and connect capabilities |
| History | Session history | Recover previous tasks and outcomes |
| Settings | Settings | Configure models, input, security, and advanced behavior |

Legacy routes, deep links, and configuration remain compatible through redirects. Duplicate entry points may be removed only after migration tests and real desktop acceptance pass.

## 4. Toolbox design

The Toolbox is an aggregation view, not a new shared persistence layer. Adapters read existing Skills, Apps, and MCP/Extensions sources into a common presentation model. Actions are dispatched back to the owning source API.

### 4.1 Sections and actions

- **Available capabilities**: built-in capabilities that are ready to use.
- **Working methods**: CodeBuddy-managed Skills; “Skill” is a secondary technical label only.
- **My tools**: existing Apps, described by the job they help complete.
- **External tools**: connected or unconfigured MCP services; the primary action is “Connect external tool.”

Each card shows at least its name, purpose, source, state, last-used time, successful-use count, and the Common or Automatic Tasks that reference it. Common states are Ready, Off, Setup required, and Connection failed. Available actions are source-specific variants of Open, Enable, Disable, Configure, Test connection, and Remove.

Before disabling or removing an in-use capability, the UI lists affected tasks and requests confirmation. A source load failure must never appear as an empty collection. The UI distinguishes genuinely empty, load failed, setup required, and permission denied states and provides a recovery action.

### 4.2 External-tool connection flow

The simple flow asks only for a display name, a connection method (URL or launch command), and the required address or command fields. Environment variables, custom headers, timeouts, and similar controls live under Advanced settings.

Test connection proves reachability and capability discovery but does not count as real usage. After saving, the UI shows discovered tools/resources, permission scope, and the most recent error. “MCP” remains available as supporting technical text without becoming a prerequisite for ordinary users.

## 5. Common and Automatic Tasks

A Common Task card shows its purpose, required files/tools/permissions/model, last run, and latest result. Its primary actions are Run, Edit, and Make automatic. Users may create one through natural language or a small form. A pre-run summary is always available, and external writes, deletion, sending, or other high-risk actions still require confirmation.

Automatic Tasks use natural-language scheduling rather than exposing raw cron syntax to ordinary users. Creation selects a Common Task, time, and failure-notification behavior, then requires a test run before enablement. The list shows the next run, previous result, enabled state, and required capabilities.

The product explicitly states that automatic execution requires the CodeBuddy backend to remain running. Missed runs are not replayed by default; catch-up is an explicit advanced option.

## 6. Settings cleanup

- Remove the raw configuration editor from General. The underlying configuration system remains available to product features, but ordinary users no longer edit internal keys one by one.
- Split Behavior and Responses by actual effect: keep the operating mode selector; move maximum turns to Advanced; rename Project Hints to Project Rules; move dictation and spellcheck to Input; rename Reply Style to the accurate Tool Process Display; move prompt-injection detection to Security and Permissions.
- Do not claim Tool Process Display changes the model's writing style. It only expands or collapses tool-call detail.

## 7. Actual-use records

Records remain local and do not create telemetry.

| Kind | Counts as use | Does not count |
| --- | --- | --- |
| Working method | Loaded or invoked during execution | Viewed or enabled |
| External tool | Successful MCP tool call | Connection test or settings view |
| Mini tool | Opened and initialized successfully | Card was visible |
| Common Task | Task execution started | Edited or previewed |
| Automatic Task | Scheduler actually triggered | Schedule merely enabled |

The presentation model includes a stable identifier, source kind, state, last-used timestamp, successful-use count, latest result, and task references. Each source continues to own its configuration to prevent dual writes and drift.

## 8. Compatibility, migration, and failures

- The first launch builds a presentation index only; it does not move or rewrite existing Skills, Apps, MCP, Recipe, or Scheduler data.
- Legacy terms may remain temporarily as search aliases and explanatory text, but not as primary navigation labels.
- Legacy routes redirect while preserving the selected item. Unparseable legacy settings remain intact and produce a recoverable error.
- If one aggregated source fails, the remaining sources continue to render while the failed section explains the cause. A silent empty page is forbidden.
- Dependencies and permissions are checked again at execution time; an earlier Ready state never bypasses the security boundary.

## 9. Real MCP acceptance design

The user-provided acceptance target is:

`D:\xwechat_files\wxid_5mloegbbcbl222_d3a5\msg\file\2026-09\obsidian README.md`

Preflight inspection confirms that this is one Markdown file, not a complete Obsidian vault. It is therefore treated as a single-file knowledge source. Testing a whole vault later requires the actual vault directory.

The filesystem MCP server receives `D:\xwechat_files\wxid_5mloegbbcbl222_d3a5\msg\file\2026-09` as its only allowed directory and reads only the named file. The official filesystem server scopes directories rather than individual files and exposes write as well as read tools. An allowed directory must therefore not be misrepresented as read-only enforcement; CodeBuddy permits and invokes read operations only during acceptance.

Acceptance uses an isolated test profile and records the following evidence:

1. Before connecting, record file existence, size, last-modified time, and SHA-256.
2. Create a STDIO connection through Toolbox → Connect external tool. Follow the official Windows `cmd /c npx` launch guidance. During implementation, resolve, pin, and record an exact package version before the test; do not allow version drift during a run.
3. Invoke `list_allowed_directories` and assert that only the parent directory is present, comparing normalized Windows drive-letter casing.
4. Verify that the Toolbox reports a successful connection and the capabilities actually discovered. A connection test alone leaves formal usage at zero.
5. Ask about a stable heading or fact from the file and verify that the answer audit contains an MCP read call, ruling out an answer guessed from model knowledge.
6. Attempt a read of a non-sensitive test path outside the parent directory and require denial. Do not create or modify an external file for this check.
7. Disable the external tool and repeat the question. The UI must report unavailability and emit no MCP call. Re-enable it and restart the app to verify persisted connection configuration and state.
8. Recompute SHA-256, size, and last-modified time. They must match step 1, and the audit must contain no write, move, or delete tool invocation.

File content is data, not instruction. Commands, prompts, or requested actions found inside it must never be executed as user instructions. The test reads the minimum content required for the answer and does not scan unrelated private files in the directory.

Official references: [MCP Filesystem Server](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md) and [Connect to local MCP servers](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/develop/connect-local-servers.mdx).

## 10. Test and completion criteria

1. **Characterization baseline:** lock down legacy routes, settings reads, Skills/Apps/MCP/Scheduler loading, and the current real effects of Behavior and Responses.
2. **Component tests:** cover navigation labels, search aliases, Toolbox sections, empty/error/setup/permission states, dependency warnings, and usage counters.
3. **Integration tests:** cover aggregation adapters, source-action dispatch, legacy-data compatibility, scheduler triggers, and usage-event persistence.
4. **Full automated gates:** desktop tests, typecheck, lint, format, build, and relevant Rust tests all pass.
5. **Real Electron acceptance:** rebuild and launch from the changed source, then use real mouse and keyboard interaction for navigation, connection, restart, disablement, recovery, and the MCP single-file question flow.
6. **Evidence:** record command, working directory, exit code, pass/fail/ignored counts, screenshots, tool calls, relevant logs, and pre/post file hashes. Environment and download failures are reported separately and are not mislabeled as product defects.

## 11. Delivery phases

1. Add baseline regression tests.
2. Change navigation and labels with legacy-route compatibility.
3. Add the read-only Toolbox aggregation layer and explicit failure states.
4. Connect source actions, dependency warnings, and local usage events.
5. Redesign Common Tasks and Automatic Tasks.
6. Reorganize Settings and remove duplicate entry points.
7. Run all automated gates and the real MCP/Electron acceptance flow.
8. Remove old entry points only after compatibility evidence is complete; retain the underlying capabilities.

## 12. External comparison and decisions

Public OpenAI/Codex product material continues to treat Skills, MCP, and optional interfaces as separate capabilities while presenting user-facing scenarios such as automation and connecting external systems. CodeBuddy adopts a unified entry point, plain-language labels, and independent internals. It adopts clear capability boundaries without inferring private Codex implementation details, and rejects collapsing everything into one backend type because that would damage lifecycle, permission, and failure semantics.

## 13. Review gate

This specification confirms product structure, behavior boundaries, and acceptance. After user approval, a file-by-file implementation plan with exact test commands will be written. No feature code for this redesign starts before that review.
