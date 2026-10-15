# CodeBuddy: DeepSeek Harness Refactoring Plan
Date: 2026-10-14 (Asia/Shanghai) · Version: 0.1 · Status: Design draft, pending implementation approval

Languages: [简体](2026-10-14-harness-refactor.zh-CN.md) | [繁體](2026-10-14-harness-refactor.zh-TW.md) | [English](2026-10-14-harness-refactor.en.md)

## 1. Confirmed Objectives

| Item | Confirmed requirement |
|---|---|
| Source project | D:\Users\jiangrui\Desktop\CodeBuddy; use the current files, including uncommitted changes, when establishing the implementation baseline |
| New version directory | D:\CodeBuddy-v1; retain the original project |
| Interface | Preserve components, styles, text, interactions, and all existing functionality |
| Permitted changes | Electron backend startup, communication bridges, and packaging configuration; limit changes to integration needs |
| Execution core | Fully replace the old agent execution and scheduling core; deepseek-harness takes the lead, with capabilities connected through adapters or plugins |
| Legacy data | Keep history viewable and allow configuration and memory migration; restart unfinished tasks in the new version |
| Scheduled tasks | Import them in a paused state, verify each through the existing “Run now” action, and then enable them |
| Platforms | Include both Windows and macOS; complete Windows acceptance first, followed by macOS acceptance |

“Preserving functionality” includes every existing entry point and its actual results, error feedback, pause/cancel behavior, persistence, and behavior after restarting. Compare model-generated content, quality, speed, and token usage separately; changing the framework alone does not establish improvements in these metrics. This plan does not expand into an interface redesign, and adding a DeepSeek model provider does not count as replacing the agent.

## 2. Verified Basis and Evidence Boundaries

- Static source baseline: main, HEAD 964bbeb1587f1c5551ee17907e0b26632c4163ce, with uncommitted frontend and backend changes. Record the file inventory and hashes again during implementation; HEAD does not represent the working tree state.
- The frontend calls the backend through ACP and goose extensions, including a separate control connection and CodePro task snapshots. Sources: ui/desktop/src/acp/acpConnection.ts, codepro/runCommands.ts, acp/sessions.ts.
- The original scheduled execution entry point creates the old Agent; legacy sessions, run logs, memory, and the Electron queue use separate stores. Migrating only the chat interface is insufficient to replace the entire execution chain.
- Upstream research is pinned to d743267388641bc76f17c45ce8b4c231aed1d32c, committed on 2026-10-09 at 17:31:32 (Beijing time). This is a candidate integration baseline; it has not yet been validated by running it in this project.
- The official project is labeled developer preview and uses the MIT license. Pin the commit and dependency lockfiles during implementation, and retain license, copyright, and third-party notices in the deliverables. [Project overview](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/README.md), [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE)
- The official ACP is intended for automation; the existing SDK also lacks a complete per-session cancellation interface. Neither directly covers the existing interface contract. [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/acp/acp/README.md), [SDK](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/sdk/server/README.md)
- The Host Session Controller provides history, forking, cancellation, and a live follow stream, making it the preferred integration surface for this plan. [Controller](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/api/session-controller/README.md), [History stream source](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/api/session-controller/src/history.ts)

This round covers only source code and official documentation research and preparation of this plan. No dependencies were installed, project source code copied, real credentials accessed, model tests run, builds performed, or desktop acceptance conducted.

## 3. Options and Recommendation

| Option | Benefits | Costs and assessment |
|---|---|---|
| Custom Harness profile + Host compatibility plugin + independent capability services | Preserve the existing interface contract and reuse the upstream core and existing mature capabilities | Requires protocol/state adapters; recommended |
| Directly replace the backend with a dsh ACP or existing SDK process | Fastest route to basic chat connectivity | Gaps remain in full control, live presentation, and product extensions; does not meet the current scope |
| Rewrite all surrounding services on Harness | Unify implementation technology | Repeats the migration of Git, computer control, memory, and other capabilities, with a broad regression surface; not adopted in this round |

Use a version-constrained plugin composition to avoid long-term modifications to the upstream core. Retaining Rust/Go/Swift capability services is implementation reuse; the old Agent loop, Planner, TaskScheduler, old control plane, and resume-execution entry points must leave the execution chain for new tasks.

## 4. Target Structure and Responsibilities

```text
Frozen CodeBuddy interface
    ↓ Existing ACP / goose extension contract
Electron startup and communication bridge
    ↓ Authenticated local connection
CodeBuddy Host compatibility plugin
    ├─ Session Controller: history, live streams, forking, cancellation
    ├─ Harness agent-loop / subagent / jobs: sole execution and scheduling core
    ├─ CodeBuddy product policy plugins: role configuration, task control, permissions, and result projections
    └─ Independent capability services: MCP, computer control, Git, memory, models/configuration, etc.
```

| Unit | Sole responsibility and boundary |
|---|---|
| Electron host | Startup/shutdown, readiness, crash reporting, connection authentication, and packaging; does not interpret user tasks or schedule agents |
| Host compatibility plugin | Validate existing requests and translate events, identifiers, and errors; does not run a second model loop of its own |
| Harness and product policy plugins | Harness execution/subtask mechanisms handle execution; product policies implement existing roles, plans, task lifecycles, and completion conditions through its extension points |
| Product state | One writer per state item; new run events enter the Harness session log, and legacy UI snapshots become rebuildable projections; do not equate turn/end with task completion |
| Capability services | Perform specific tool, storage, or system operations and return real receipts; do not independently create the old Agent |
| History adapter | Read migrated history in its legacy format and support existing queries/export/management; do not restore legacy checkpoints or execution permissions |

Assemble plugins through the upstream startup mechanism using a custom codebuddy profile; prioritize ctx.sessionController and exposed services, and reuse follow-stream/reconnection logic. Avoid duplicating a separate Harness launcher or a complete Web UI.

The compatibility layer preserves existing request fields, capability negotiation, error shapes, message/tool identifiers, task sequence numbers, and permission options. Keep long prompts and control operations on separate channels so stop/snapshot queries are not blocked. Handle streaming deltas, durable events, and final commits separately, and deduplicate on reconnection; forward visible reasoning only when the provider actually supplies it.

## 5. Interface Freeze Method

- The freeze covers App/routes, components, styles, localization resources, interaction hooks/store, message/task presentation transformations, and their public types.
- Communication exceptions are limited to main/preload/gooseServe, connection transport implementations, and necessary build/packaging/dependency wiring; window, menu, shortcut, and other behavior in the same files remains unchanged.
- Preserve the external type contracts of ACP business adapters and the SDK. State the reason for every exception file in the change inventory; do not make an entire directory editable by extension.
- Before implementation, save the current source file inventory, hashes, and dirty state; copy the source, documentation, and uncommitted new files included in the baseline. Exclude .git, dependencies, build artifacts, caches, and private data; separately list and include ignored but necessary source/assets.
- The freeze applies to the complete working tree at the time of copying; subsequent changes in the original project enter through explicit incremental merges and do not automatically overwrite the new version.
- Acceptance checks both zero differences in frozen files and real functionality. Zero differences establish only compliance with the source constraint, not functional acceptance.

## 6. Functionality Migration and Acceptance Matrix

This table is a module-level inventory. P0 must expand it to every reachable frontend entry point/RPC/notification, recording the old contract, new owner, data source, automated scenarios, and product scenarios; only a complete pass qualifies as “preserving all functionality.”

| Functionality | Migration approach | Required acceptance scenarios |
|---|---|---|
| General chat and CodePro development | Route both through Harness while preserving existing modes and tool scopes | Input/attachments, real response text and reasoning streams, tool cards, errors, retries |
| Planning and multiple agents | Map role configuration to Harness subtasks/model routing; product state plugins supply legacy task projections | Plans, dependencies, concurrency, subtask activity, role models, result aggregation |
| Control and recovery | Manage new runs through Harness and a single product state owner | Pause/resume, distinction between stop and cancel, interjections, process crashes, reconnection, recovery after restart |
| Permissions and workspaces | Reuse existing product rules and enforce them through tool execution extension points | Deny/allow, scope isolation, file writes, workspace confirmation, questions/clarifications |
| Session management | Use Harness for new sessions and a migrated archive adapter for legacy history | Listing, searching, loading, continuing conversations, forking, renaming, archiving, importing/exporting/deleting |
| Models and local inference | Preserve all existing configuration contracts; implement provider adapters as needed | Custom endpoints, model discovery, role/vision routing, tool calling, images, reasoning parameters, local models |
| MCP, toolbox, and Apps | Preserve existing management services; connect model tools to Harness and use a dedicated bridge for product resources/UI | stdio/HTTP, authentication references, startup/shutdown, resources/prompts, MCP Apps, structured and multimodal results |
| Skills, recipes, and project sources | Reuse management and reading, switching execution entry points to Harness | Discovery, installation/management, loading, parameter confirmation, project binding |
| Computer control | Prefer retaining qwen_computer MCP and platform adapters | Real observation/action/results, desktop mutual exclusion, user takeover, cancellation, Windows/macOS permissions |
| Memory and history retrieval | Independent memory service and Harness context plugin | View/edit/disable/delete/export, project isolation, recall, index failures |
| Scheduled tasks | The scheduling service only triggers new Harness runs | Run now, enable/disable, editing, restart, history, prevention of duplicate triggers |
| Git/GitHub, review, and cleanup | Reuse independent services through existing interfaces | Status/diffs, authentication, Issues/PR/CI, review, authorization, and file recovery |
| Voice, common queries, settings, and diagnostics | Preserve configuration and service contracts | Voice input, time/weather, theme/language/shortcuts, diagnostics, release startup |

Upstream MCP is not automatically equivalent to this project's Apps, prompt, and rich-result capabilities; retain each difference as a bridging task. [Upstream MCP scope](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/mcp/mcp-client/README.md)
Preserving existing multi-vendor and local-model support is a requirement; connecting to a compatible endpoint does not establish that tool/vision/reasoning behavior has passed acceptance. [Upstream model adapter](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-pi-ai/README.md)

## 7. Data Migration Design

1. Use an independent application data root, Electron userData, and credential namespace for the new version. P0 also fixes the installation directory, installer identity, Bundle ID, single-instance identity, protocol/file-association ownership, and update channel. Candidate versions do not take over legacy registrations; list precise handover operations separately for the final switch, while preserving visible interface copy. Retain the old directories throughout, and write only to the new version during migration.
2. Use consistent snapshots or database backup APIs for legacy SQLite databases, handling WAL/SHM; record inventories, sources, and verification hashes for logs/attachments. Make repeated imports idempotent and partial failures retryable.
3. Preserve the original states of legacy chats, tool receipts, and task history. Continuing a conversation from a history window retains the original interaction; the backend creates a new Harness run linked to read-only historical context. Do not inherit legacy checkpoints, live process handles, authorizations, or pending tools.
4. Preserve existing new-session/fork entry points. Deleting, renaming, and otherwise managing legacy history affects only the new version's archive copy, without modifying the source application.
5. Migrate model/MCP configuration, skills, recipes, and preferences; map credential references separately. Handle system keyring, OAuth, and GitHub login individually, without writing secrets into reports or logs; if migration fails, use the existing interface to sign in again.
6. Preserve enabled state, provenance, review information, TTL, and project identity for project memory; explicitly map path changes. Rebuild derived indexes such as Hindsight from authoritative local records, without reviving disabled or deleted content.
7. Confirmed: import schedules in a paused state pending validation through the existing “Run now” flow. “Run now” performs real execution, so use controlled tasks for acceptance. Before enabling a schedule, verify that its legacy counterpart is disabled and record the original schedule ID and handover state, ensuring a single trigger owner; merely exiting the old application does not prove permanent disablement. The importer does not modify legacy schedules without authorization. If the source schedule remains enabled or its state is unknown, keep the new schedule paused and report the handover gap through existing error feedback. Do not migrate old run instances into active tasks.
8. Preserve the existing behavior of pausing the queue after recovery; handle pending sends, uncertain send results, and drafts separately to avoid replay. Validate external backend connection configuration to prevent the new version from accidentally reconnecting to the old core.

The old and new versions coexist to allow application-version rollback; running tasks do not switch live between the two cores. New events are not written back in the legacy format, and the old version is not required to continue executing tasks from the new version.

## 8. Implementation Phases and Gates

| Phase | Deliverables | Gate before entering the next phase |
|---|---|---|
| P0 Baseline and contracts | Source/freeze hashes, complete functionality and RPC inventory, existing defect register, data mappings, precise change inventory, pinned upstream version | Current and target states are traceable; existing failures are distinguished from new regressions; read-only validation does not modify the environment |
| P1 Minimal real integration | Original interface → Host plugin → Harness; connect real models, tools, permissions, cancellation, history/reconnection | Protocol and component tests pass; key paths pass in a real browser/desktop; confirm zero calls to the old core |
| P2 Execution and scheduling migration | Roles, multiple agents, plans, task state, interjections, pause/resume, and scheduled entry points | State/cancellation/concurrency/idempotency/crash tests pass; real multi-task flows pass |
| P3 All capability adapters | Complete each contract in Section 6 and fill gaps for MCP Apps, models, memory, and native capabilities | Automation passes for each item before acceptance of the relevant real interactions; items that have not passed are not marked complete |
| P4 Data migration | Read-only import from legacy sources, history bridge, credential/memory mappings, paused schedules, and rollback records | Sanitized samples in real formats include attachments/tool errors/incomplete logs; failure retry and isolation between old and new versions pass |
| P5 Windows delivery | New runtime and installation artifacts paired with the frozen interface | Full functional regression, a complete development task and computer-control flow, and installation startup/upgrade/exit checks |
| P6 macOS delivery | Platform runtime, native capabilities, and installation artifacts | Build/signing status on a real Mac, permissions, complete user flows, and platform-difference acceptance |

Advance each feature through “automation → real key paths,” without deferring all real validation until the end. Tests address only changes and contract risks; document changes do not trigger product tests. Computer-control tool acceptance applies to computer-operation capabilities; other interface interactions use browser/Electron test entry points.

## 9. Acceptance, Risks, and Delivery Boundaries

- Backend coverage must include state machines, protocol validation, event deduplication, concurrency control, cancellation, persistence, and migration boundaries; use sanitized samples in the original project's real formats as inputs.
- Retain frontend component tests and validate existing interactions in a real browser/Electron environment. Cross-module flows cover requirement input, planning, actual file changes, testing, result presentation, stop/resume, and history.
- Model acceptance covers cloud models, custom compatible endpoints, local models, and vision paths used by the existing product; when using real configuration, separately record credential availability and invocation costs. User credentials are not accessed at this stage.
- Collect time to the first visible delta, tool duration, cancellation completion, reconnection recovery, tokens, and costs, and compare against the original version under the same conditions; do not promise fixed performance gains without a baseline.
- List existing defects separately rather than making them correct behavior that must be preserved; explicitly assign responsibility for defects affecting migration acceptance, without hiding functionality or returning false success to bypass them.
- Handle upstream interface changes through explicit upgrades; pin versions, notifications, plugin boundaries, and compatibility contracts rather than automatically following master.
- Mac acceptance requires a real Mac environment; Windows evidence does not substitute for it. Report development builds, automated tests, real product acceptance, and installer acceptance separately.
- Completion criteria: no unauthorized changes to the frozen interface; all contract mappings are complete; new tasks run only through Harness; all migrated schedules start paused and activation has evidence of a single trigger-owner handover; data is traceable and rollback to the original version remains possible; installing, updating, or uninstalling the new version does not damage the old version; each platform has its own acceptance evidence.

This design round does not create branches, commit, push, install dependencies, or modify the system environment. First list the exact operations required for implementation dependencies, the build environment, and real data migration; approval of the plan does not authorize arbitrary environment changes.

## 10. Next Decision

The confirmed user requirements are sufficient to support this overall design. After approval, begin with P0 and P1, using real integration with the frozen interface to validate the full approach. If P1 reveals structural protocol or platform differences, report the evidence and revise the specific integration plan, without silently reducing functionality or restoring the old execution core.

Code search entry points: the original project's AGENTS.md; ui/desktop/src/acp/; ui/desktop/src/codepro/; crates/goose/src/acp/; crates/goose/src/session/session_manager.rs; crates/goose/src/config/storage_migration.rs; crates/goose/src/scheduler.rs; tools/qwen-computer-use/.
