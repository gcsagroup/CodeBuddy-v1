# CodeBuddy Memory Module Optimization Design

Date: 2026-09-11. Reviewed: 2026-09-12. Status: approved implementation baseline for the basic release and later evolution.

[繁體中文 (default)](2026-09-11-memory-module-optimization-design.md) · [简体中文](2026-09-11-memory-module-optimization-design.zh-CN.md)

## 1. Decision

CodeBuddy should separate durable rules, project memory, user habits, and conversation history into four logical layers instead of treating them as one kind of memory.

- `AGENTS.md` contains only durable rules explicitly confirmed by the user or team.
- AI-inferred habits stay in user memory and cannot modify `AGENTS.md` by default.
- Project facts and working knowledge stay in project-scoped memory with provenance and isolation.
- Complete conversations remain in the session database and are not copied wholesale into long-term memory.
- Remove product-level limits that reject writes after a fixed total entry count or file size. Replace them with lossless archival, on-demand retrieval, and observable disk safeguards.
- Keep per-record, search-response, prompt-injection, and security limits. These are execution safety boundaries, not total memory capacity limits.

Direct answer to “should AI-learned user habits also be written to `AGENTS.md`?”: **No.** AI-learned habits first enter separate, reviewable user memory. They reach the global rules file only after the user explicitly selects “Promote to rule” and approves the diff.

## 2. Current State and Problems

The current implementation already provides project identity isolation, cross-session persistence, TTL, CRUD, search, pagination, export, backup recovery, active/archive tiers, and memory kinds such as `project_rule`, `preference`, and `verified_fact`. The settings page exposes Project Memory and personalized-memory controls.

The remaining problems are:

1. Rules, facts, and preferences share a channel without a sufficiently clear authority boundary.
2. The UI and data semantics do not clearly separate inferred preferences from explicit user rules.
3. The 500-active-entry and 1 MiB soft/2 MiB hard limits look like total-memory limits and can reject otherwise valid writes.
4. Automatic injection favors recent entries; relevance, provenance, and match explanations need improvement.
5. The JSON active/archive layout works at the current scale, but full-text search, updates, and consistency become more expensive as data grows.

## 3. Reference Designs and Decisions

### Codex

Codex separates durable instructions from generated memory. Layered `AGENTS.md` files provide global and project instructions, while context extracted from prior chats lives in a separate local memory store. Rules that must always apply belong in `AGENTS.md` or versioned documentation; memory is supporting context. Project instruction loading is itself bounded, so `AGENTS.md` is not a memory database.

Adopt: separate rules from memory, distinguish global and project scopes, and control memory generation separately from memory use.
Reject: silently generating or overwriting project rules.

References: [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md); [Codex memory](https://learn.chatgpt.com/docs/customization/memories)

### Claude Code, Hermes, Pi, and other agents

Observable mature designs commonly combine user-maintained instruction files, on-demand history or memory retrieval, and a bounded current context. Hermes-style systems emphasize session search and full-text indexing; Pi-style systems preserve full sessions, branches, and compaction; Claude Code separates manually maintained memory files from automatic memory. Their shared principle is not unlimited prompt injection, but growing durable storage with bounded per-turn recall.

Adopt: separate durable storage from prompt budgets, provide traceable retrieval, and keep full sessions separate from summaries.
Defer: vector databases, cloud synchronization, and knowledge graphs. They increase delivery time without first solving rule pollution or cross-project leakage.

| Project      | Verifiable public design                                                                                                                                             | CodeBuddy decision                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Codex        | Layered `AGENTS.md`; a separate local memory store; separate `use_memories` and `generate_memories` controls                                                         | Adopt rule/memory separation, two controls, and local storage; never let AI silently change rules                                        |
| Claude Code  | Users maintain `CLAUDE.md`; Claude maintains per-project auto memory; startup loads only the first 200 lines or 25KB of `MEMORY.md`, with topic files read on demand | Adopt a short index plus on-demand reads and separate authored rules from automatic memory; do not grant automatic memory rule authority |
| Hermes Agent | Full sessions live in SQLite with FTS5 search; pluggable memory backends can expose trust and feedback                                                               | Prefer SQLite + FTS5 after data growth justifies it; do not add plugin or vector dependencies to the basic release                       |
| Pi           | `AGENTS.md`/`CLAUDE.md` are context files; sessions use a JSONL tree; compaction summarizes older context                                                            | Preserve the boundary between complete sessions and long-term memory; summaries are not durable rules                                    |
| TRAE         | Separate `user_rules.md` and `project_rules.md` managed in Settings; long sessions retain recent text and summarize older content                                    | Adopt user/project rule editors and explicit priority; do not infer undisclosed cross-session behavior from public material              |
| OpenHands    | Opt-in user-tier and project-tier `MEMORY.md`; repository skills/instructions stay separate                                                                          | Adopt user/project scopes while keeping CodeBuddy's structured records instead of reverting to a Markdown database                    |

Public sources: [Codex memory](https://learn.chatgpt.com/docs/customization/memories), [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Claude Code memory](https://code.claude.com/docs/en/memory), [Hermes sessions](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md), [Hermes memory provider](https://github.com/NousResearch/hermes-agent/blob/main/plugins/memory/holographic/README.md), [Pi usage](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/usage.md), [TRAE Rules](https://www.trae.ai/blog/trae_tutorial_0825), [TRAE Agent 2.0](https://www.trae.ai/blog/product_thought_0617), and [OpenHands persistent memory example](https://github.com/OpenHands/software-agent-sdk/blob/main/examples/01_standalone_sdk/55_persistent_memory.py).

## 4. Goals and Non-goals

### Goals

- Let users manage global rules from Settings while project rules are discovered automatically from the working directory.
- Let the AI learn stable, low-risk habits that users can inspect, delete, disable, or promote to durable rules.
- Allow stored memory to grow beyond fixed entry-count and aggregate-file-size limits.
- Inject only a small, relevant, explainable set of memories per model call.
- Prevent leakage across projects, users, and workspaces.
- Make every write and recall explain who created it, why, when, and from which source.

### Non-goals

- Do not convert every chat into long-term memory.
- Do not let the AI automatically modify committed team rules.
- Do not add cloud synchronization, a vector database, or a knowledge graph in the first release.
- Do not use deletion of old memory as routine capacity management.

## 5. Layered Architecture

### 5.1 Conversation history

- Storage: existing `sessions/sessions.db`.
- Content: complete messages, tool calls, and session state.
- Purpose: resume a conversation, audit activity, and produce candidate memories.
- It is not loaded wholesale into every new conversation.

### 5.2 Project rules

- Storage: `AGENTS.md` or `AGENTS.override.md` at the project root or nearest applicable directory.
- Content: build commands, test requirements, code conventions, safety constraints, and team workflows.
- Writes: direct user edits. AI may only produce a draft or proposed diff that requires user confirmation.
- Properties: authoritative, version-controlled, and directory-scoped.

### 5.3 Global user rules and habits

- Explicit rules: store in `.CodeBuddy/AGENTS.md` on the user's computer and manage them through the multiline editor under Behavior and Responses. The first save creates the file.
- Compatibility: the legacy `profiles/<profile>/AGENTS.md` is a read fallback only when the root file is absent; it is no longer a write target.
- AI habits: store structured records under `profiles/<profile>/memory/user/`, not in global `AGENTS.md`.
- A user may select “Promote to durable rule,” review the change, and then add a habit to the global rules.
- Load order: load global rules first, then load the nearest applicable rules from the project root down to the current working directory. Within one directory, `AGENTS.override.md` wins over `AGENTS.md`. Closer project rules override only conflicting content, and changes apply to new conversations.

### 5.4 Project memory

- Storage: `profiles/<profile>/memory/projects/<project-id>/`.
- Content: working knowledge, verified facts, architecture decisions, and recent work summaries.
- Project identity uses a normalized path and stable ID. The UI always shows the owning project to prevent accidental deletion.
- Project moves or renames use an explicit rebind or copy flow and never merge silently.

## 6. Settings Design

The Memory settings page has three sections:

1. **CodeBuddy instructions**: under Behavior and Responses, provide a multiline editor, an explicit Save action, external-change conflict protection, and the actual file location. It writes `.CodeBuddy/AGENTS.md` and applies to every new conversation.
2. **Automatic project-rule discovery**: Settings does not expose a manual folder picker. When a project opens, load rules from the project root down to the current working directory; when tools read or write a deeper directory, load the nearest rules along that directory chain. The system reads and injects these rules without copying them into the memory database or creating or modifying project files automatically.
3. **Habits learned by AI**: cards show content, source, confidence, creation time, and last-use time. Actions include keep, edit, delete, disable, and promote to a durable rule.

Keep two independent controls:

- **Use memory**: retrieve and inject existing memories in later conversations.
- **Allow new memory generation**: allow the current conversation to contribute project memories or inferred habits.

Turning either control off never deletes data. Delete and clear remain separate confirmed actions.

## 7. Data Model

Each structured memory contains at least:

```text
id, scope, kind, subject, content,
source, source_ref, reason, confidence,
created_at, updated_at, last_used_at,
expires_at, status, schema_version
```

- `scope`: `user` or `project`.
- `kind`: `preference`, `verified_fact`, `decision`, or `work_summary`.
- `source`: `user_explicit`, `user_approved`, `ai_inferred`, or `project_verified`.
- `status`: `candidate`, `active`, `disabled`, or `expired`.
- `confidence` applies only to AI inference and cannot override explicit user rules.
- `source_ref` is required for verified project facts and must be a safe path relative to the current project.

Stop creating `project_rule` as a general memory kind. During migration, existing `project_rule` records become candidate rules; the user decides whether to move them to `AGENTS.md` or downgrade them to ordinary project memory.

## 8. Write Policy

1. A rule entered in Settings is written to the matching rules file after the user clicks Save.
2. When a user explicitly says “remember this,” write a `user_explicit` or `user_approved` memory.
3. Automatic learning accepts only stable, low-risk interaction habits such as language, response length, and commonly used tools. Initially store them as `candidate`; user approval changes them to `active`.
4. Passwords, API keys, tokens, government identifiers, payment data, private communications, and one-off task details cannot become long-term memory.
5. Reuse or version an existing scope + kind + subject record instead of creating unlimited duplicates.
6. AI inference cannot write to `AGENTS.md`; it may only create an auditable promotion proposal.

## 9. Retrieval and Context Budget

Within the user-configurable layer, apply this order:

```text
Explicit request in the current conversation
→ nearest project AGENTS.override.md / AGENTS.md
→ global user rules
→ approved, task-relevant user habits
→ project memory
→ historical work summaries
```

System and developer policies always remain above these layers.

Bound proactive injection to a first-release total of 6,000 characters. Rules take priority; remaining space is shared by user habits and project memory. Candidate, disabled, expired, or invalid-source records are not proactively injected.

Relevance combines scope match, keyword/FTS match, memory kind, user approval, source reliability, recent use, and duplicate penalties. Results include a short match reason. If nothing is relevant, the system does not fill the budget with unrelated memories.

## 10. Exact Meaning of Removing Capacity Limits

Remove:

- The product meaning of 500 active entries as total capacity.
- Aggregate 1 MiB soft/2 MiB hard file limits that reject normal memory writes.
- Any silent deletion because data is old or over a quota.

Keep:

- Per-record content, subject, reason, and source-path limits.
- Per-turn prompt injection, search response, page size, and tool output limits.
- Corruption, path traversal, symlink, secret, and prompt-injection defenses.

When disk space is insufficient or storage is not writable, reject only the current write with an actionable error. Never delete existing data. Settings shows disk usage but does not impose a fixed quota on normal growth.

## 11. Storage Evolution

### Phase 1: fast delivery

Reuse the current file format and ACP contract. Separate rules and memory, add the Settings UI, candidate habits, independent use/generate controls, and remove aggregate-capacity rejection. Active/archive becomes a recall tier rather than user-visible capacity.

### Phase 2: after data growth

Move structured memory to SQLite + FTS5 while keeping full sessions separate. Use schema versions, backup, validation, and atomic cutover for a copy-first migration; preserve the source files until confirmation. Add vector retrieval only if fixed evaluations show that FTS5 cannot meet Chinese and semantic-recall requirements.

## 12. API and Error Handling

Keep the existing search, remember, forget, clear, stats, and export capabilities, and add or adjust:

- Read/write global rules and automatically discover read-only project rules from the active working-directory chain.
- List, approve, reject, disable, and promote candidate habits.
- Configure `use_memory` and `generate_memory` independently.
- Return scope, source, confidence, source_ref, and match_reason in search results.

Every mutation uses a stable request ID and atomic persistence. A failed write preserves previous data. The UI reflects authoritative backend state instead of hiding failures with optimistic state. If a rule file changed externally, Save detects the version conflict and asks the user to reload or compare rather than overwriting someone else's work.

## 13. Tests and Acceptance

### Backend

- Rules, user habits, project memory, and sessions never write into one another.
- AI inference cannot directly modify `AGENTS.md`.
- Use/generate controls are independent, and disabling them does not delete data.
- Writes, search, and restart recovery work beyond the old 500-entry and 2 MiB thresholds.
- Prompt and tool responses remain within their own budgets.
- Project isolation, rename, expiry, concurrent writes, corruption recovery, and low-disk behavior are reproducible.

### Desktop UI

- Component tests cover global instructions, failed-save rollback, external-edit conflicts, and removal of the manual project-folder picker.
- The global `AGENTS.md` is created only by an explicit Save; project `AGENTS.md` files are discovered without being modified.
- Candidate habits support approve, reject, delete, and promote flows.
- All four combinations of the two controls persist across restart.

### Real user flow

Launch Electron from the changed backend and use a real window, mouse, and keyboard to set a global rule, verify automatic discovery of a pre-existing project rule in a new conversation, generate a candidate habit, approve and recall it across projects, reject a candidate and prove it is no longer recalled, and restart to verify persistence. Use two projects to verify isolation, and inspect actual files, database state, and logs.

## 14. Success Criteria

- 100% of durable rules have an explicit user write or approval event.
- AI-inferred habits write directly to `AGENTS.md` zero times.
- No data loss or write stoppage after crossing the old capacity thresholds.
- Zero cross-project false recall and zero persisted secrets.
- Relevant-memory recall improves on a fixed evaluation suite while unrelated proactive injection decreases.
- Every recalled item exposes provenance and a match reason.

## 15. Delivery Order and Estimate

The basic release implements only the minimum closed loop:

1. Global-rule editor, automatic project `AGENTS.md` discovery, and external-modification conflict protection: 0.5–1 working day.
2. Reuse existing structured project memory, remove aggregate entry/file-size rejection, and retain per-record and prompt safety budgets: 0.5–1 working day.
3. Two memory controls, backend regressions, UI tests, and real Electron critical-path acceptance: 1 working day.

The single-developer basic release is estimated at **2–3 working days**. Automatic habit inference, candidate approval, and SQLite + FTS5 are separate later milestones and do not block the basic release; explicit “remember this” requests can still use the existing structured memory. Implementation must respect file ownership in the current dirty worktree and pass acceptance stage by stage.

## 16. Executable Real-Backend Acceptance Cases

These cases must use a CLI/desktop backend built from the current source and an isolated `CODEBUDDY_HOME`. Direct JSON edits, mocked ACP calls, and component-only tests cannot substitute for backend acceptance. Record the working directory, full command, exit code, test counts, backend binary SHA-256, storage path, and log path for every case. Mark cases that were not executed as `NOT_RUN`.

The basic release must pass BE-01, BE-02, BE-03, BE-04, BE-05, BE-07, and BE-08. BE-06 belongs to the later automatic-habit-candidate milestone and does not block the basic release.

| ID    | Preconditions and operation                                                                                                                                                 | Required observation                                                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BE-01 | Write data beyond the old 500-record and 2 MiB thresholds through real `project_memory_remember` calls, restart, and continue writing.                                      | Every write succeeds. Active hot data may rotate to the archive, but the total record count does not decrease and no capacity-full rejection occurs.                                    |
| BE-02 | Search for unique content that BE-01 rotated into the archive, restart, and repeat the `project_memory_search`.                                                             | Both searches return the same memory, scope, source, and evidence; restart does not lose archive data.                                                                                  |
| BE-03 | Use ACP list/stats against a dataset containing active, archive, project-scope, and user-scope records.                                                                     | `usageBytes` covers all persistent memory. Compatibility capacity fields report zero/unlimited, and the UI does not interpret them as full.                                             |
| BE-04 | Write a unique project-scope memory in project A, then search and start a new conversation in project B.                                                                    | B cannot search or automatically recall A's project memory. User scope crosses projects only when explicitly enabled.                                                                   |
| BE-05 | Disable memory use while generation remains enabled, complete a turn, then swap the two controls.                                                                           | Disabling use prevents injection; disabling generation prevents new AI memory; none of the four combinations deletes stored data.                                                       |
| BE-06 | Let the model infer a work habit, leave it unapproved, then approve it, disable it, and restart.                                                                            | An unapproved candidate is not recalled; approval makes it recallable; disabling stops recall; content and status survive restart, and the AI never modifies `AGENTS.md` automatically. |
| BE-07 | Save global `AGENTS.md`; prepare project `AGENTS.md`, then project `AGENTS.override.md`; start a new conversation after each change. Also modify the global file externally before saving an older editor revision. | New conversations follow global/project precedence; existing conversations are not silently rewritten; the project files remain unchanged, and a global-editor conflict preserves the draft and refuses to overwrite the external edit. |
| BE-08 | Simulate one corrupt record, an interrupted atomic write, and a reproducible low-disk condition.                                                                            | Existing data remains recoverable or isolated. The error identifies storage failure instead of misreporting a capacity limit, and other projects remain intact.                         |

Run real Electron acceptance after the cases for the corresponding milestone pass. For the basic release, use the real window, mouse, and keyboard to edit rules, toggle memory controls, verify project isolation, and verify restart persistence. Add candidate approval and rejection in the later milestone. Corroborate both visible workflows with actual files and logs.
