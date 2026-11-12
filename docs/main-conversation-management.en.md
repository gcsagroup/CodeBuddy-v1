# Managing projects and chats from the main conversation

A user can ask “Create a website project and start one chat for design and another for development,” then open the returned folder and chats. Asking what is blocking development should return the relevant task, latest tool result, timestamp and outstanding decision. The proposed scope is the projects and chats in the current CodeBuddy data profile.

## Choosing where work runs

The main chat answers questions and creates small standalone files directly. A change belonging to an existing project goes to its project chat. For a new multi-stage product, the main chat can create the project and development chat and start a verifiable first milestone. With full access, explicit requests to create, change, delete or dispatch run directly. Ask when the action or target is ambiguous. Changing chat permissions still requires confirmation. The main chat receives the outcome when the assigned turn ends. The target chat owns permissions, cancellation and execution. Native input acceptance proves delivery. Check receipts and artifacts for completion. Clarify ambiguous targets before changing them.

A single progress lookup reads recent user requests, the latest reported reply, live run state and tool receipts. Clearing history resets the current main conversation and model context. Other chats, project files and saved memories remain. The native fork may retain the old journal.

For launch-only requests the approval can explicitly select immediate return on native acceptance. The user receives the target directory and can follow the project chat. Mixed requests continue for other deliverables, such as a local unit conversion alongside a project assignment. Check that delegated files exist only in the project directory.

Acceptance cases cover unit conversion, a standalone file, architecture advice only, Git progress in two identically named projects, an ambiguous permission change, starting a cloud-drive milestone, checking its written artifact, continuing in the same project chat and retrieving a one-time marker after clearing main history.

## Available in the desktop app

Ask the main chat about a project by name or directory to check active work and the latest run. In chat, ask to create a project folder or conversation, rename, archive, restore or delete a conversation, remove a project registration, or change permissions for one chat. New projects use the configured workspace root. Removing a registration preserves disk files. The foreground approval shows the resolved target and change before submission.

Permission options are read-only, workspace-write, full access and inheritance. Idle chats apply changes immediately. An active turn keeps its starting override and the next turn uses the saved choice. The optional session field `permissionOverride` records the selection. Harness applies the effective preset. Older clients retain the global-setting API. Check restrictive overrides before downgrading.

History lookup reads original user messages from the current native conversation and returns bounded newest-first pages with event sequences and message IDs. Detailed progress can include native tool receipts. The current implementation reads the native journal on demand. A separate full-text index remains optional.

## Interface and storage

Move the general introduction, logo and three capability labels to New Task, above its workspace picker and composer. The main conversation resumes its own history. Its empty view introduces project progress, chat management and per-chat permissions.

Each profile obtains its main chat through `runtime/main-conversation.mjs`. Its dedicated `workspace_memory` tool recalls eligible memories from registered workspaces. The working directory is `backend/main-conversation`. Resolve the product record marked `globalConversation` in `backend/state.json`, then locate its native journal under `backend/harness/sessions` using `nativeSessionId ?? id`. An “Open chat history folder” action should resolve the current profile and native ID each time, including after a data move or history reset.

## Accuracy over a long history

The introduction remains visible while drafting, gives way to the first message, and stays hidden during replay.

Harness persists native events in JSONL and compacts selected spans under context pressure or on `/compact`. A checkpoint can carry file paths from paired, successful tool receipts in its selected span. Each model request has a finite context budget. Summaries can omit a negation, version or correction. On 2026-11-11, a real Gemma 4 26B A4B processed about 36,000 input characters in an isolated profile. After two `/compact` operations and a backend restart, the final prompt omitted the target and new title. The model retrieved the correction and the project directories. It renamed only the `west-site` chat from “开发” to “核验-351a2f”. The identically named `east-site` chat retained its title. This is one measured case. A separate Electron run created a project and chat and set that chat to read-only. The position of evidence in a long input affects retrieval on some models. [Original study](https://arxiv.org/abs/2307.03172)

1. For questions about past decisions, scope retrieval by profile, project, conversation and time. Use the summary to find candidates, then fetch the user’s words, nearby messages and subsequent corrections. Link to the source. Ask for clarification if conflicting instructions have ambiguous scope. For current state, read the live configuration or run.
2. Before acting, the host verifies the project ID, chat ID, working directory, effective permissions, target state and prior receipts. Historical approvals describe past decisions.
3. Harness retains ownership of journal writes. Measure scan latency first. If needed, build a rebuildable incremental local index of necessary retrieval fields and event positions, with bounded pages and verified resume positions. Constrain lookups to the effective lineage after a clear, fork or deletion. Keep a single journal outside the working folder. Measure open and retrieval latency and journal/index size before choosing an archive policy. Context compaction does not cap journal size.
4. Evaluate two identically named projects with an early decision, a mid-history correction, a late revocation and substantial irrelevant tool output. Cross two real model compactions and restart. Check the original quote, current decision, target IDs, receipts and duplicate execution count. After clearing history, verify that old content cannot resurface. Report correct/total, wrong actions and latency by model and actual context usage. A wrong target or a breached critical constraint blocks delivery.

## Management operations

| Request | Behavior |
| --- | --- |
| Inspect projects, progress or chat history | Load a snapshot, subscribe to changes by ID and refresh on reconnect. Fetch bounded excerpts, working-tree diffs or test receipts on demand. Link observations to their source and timestamp. Distinguish run completion, code changes, tests and user acceptance. Background updates consume events. Model analysis runs when requested. |
| Create projects and chats | Reuse workspace allocation, project registration, chat creation and failure compensation. Deduplicate retries by operation ID, return created objects and allow resuming partially completed requests. |
| Update or delegate | Rename projects and chats, append a goal, or start a task in a specific project. The destination chat runs under its own permissions and working directory. Return an acknowledgement and a link. Busy targets use their established queue or follow-up behavior. |
| Archive or delete | Distinguish archiving/restoring a chat, deleting its history, removing a project registration and deleting its physical folder. Show the resolved path and impact before physical deletion. Use existing active-run checks and durable logical deletion receipts. |
| Change permissions | Show the target, current and requested modes, and effective time. The host validates main-chat identity and user authorization. Retrieved conversations supply data only. |

Register management tools only for the main chat. The host validates target IDs, canonical paths and scope. Offer candidate paths for ambiguous names. Harness owns execution, cancellation, tool outcomes and history. Store and project registration retain their respective writes. The overview reads their facts.

Today `session/set_mode` writes the global `preferences.gooseMode` and synchronizes several sessions. Preserve that contract and add an explicit per-session override within host policy. Apply changes from the next turn. For an immediate restriction, stop the active turn and await its acknowledgement. Pending approvals retain their original scope. Show previous and applied values, with a way to resume inheriting the global default. Existing records inherit by default. Check for active overrides, particularly stricter ones, before downgrading.

## Delivery and acceptance

1. Deliver the welcome move separately from the read-only overview. Verify live runs, disconnected and interrupted sessions, empty records and source links across two projects.
2. Add project and chat management. Verify ambiguous names, retries, partial failures, preservation of existing files and deletion of a busy chat. Create, delegate and inspect results through the main chat.
3. Add per-chat permissions. Changing A must preserve B and the global default. Verify active-turn boundaries and restart persistence. Follow integration tests with a real desktop flow, isolated data and a real model.

OpenCode exposes project and session APIs and a global event stream. Deep Agents delegates tasks with isolated context. Both have publicly maintained MIT repositories. Borrow these patterns while keeping execution and persistence in the current DeepSeek Harness. [OpenCode server](https://opencode.ai/v1/docs/server/) · [OpenCode repository](https://github.com/anomalyco/opencode) · [Deep Agents documentation](https://docs.langchain.com/oss/javascript/deepagents/overview) · [Deep Agents repository](https://github.com/langchain-ai/deepagentsjs)
