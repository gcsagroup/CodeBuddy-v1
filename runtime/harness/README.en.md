# CodeBuddy Harness runtime

Remote MCP connections are reused across sessions through the official `agent-preset-registry` standing scopes and leases. Matching configurations connect once; changed configurations use isolated revisions while existing sessions retain their connections. Up to eight reusable definitions are retained; Harness preserves retired revisions while leased. Stdio remains workspace/session scoped. Tool-list changes refresh inherited tool masks, and execution still requires per-session authorization. See [design and real desktop acceptance](../../docs/reconstruction/2026-10-14-mcp-reuse.en.md).

Official `goal`, `goal-round-driver`, and `tool-goal` own durable objectives, CAS updates, automatic rounds, round limits, and pausing. `prompt` stays open while a native goal is active and armed, waiting for official continuation; an ordinary conversation without a goal ends normally. Its `goal` result is the official GoalView. Stop cancels execution and disarms continuation; restart remains disarmed and never replays work automatically. Explicitly paused goals resume through structured `prompt(...,{resumeGoal:{goalId,revision}})`, which attaches permissions and events before invoking the official resume operation. `getGoal` is read-only. `controlGoal` supports pause, and resume within an attached run; standalone idle resume is rejected.

Model requests use the official bounded retry defaults: five retries, exponential backoff starting at 500ms, and a maximum interval of 10 seconds. `llm/retry`, `goal/change`, `turn/start`, and `todo/write` retain native identities through `harness_event`; todos belong only to the current turn. `model_diagnostic` records first-chunk/end latency, HTTP status, chunk counts, and allowlisted network error codes. It never records content, credentials, headers, or URLs, and does not modify fetch, streams, or retry decisions.

The Host fixes the official settings at `maxActiveSubagents: 3` and `maxDepth: 1`: each root conversation's native tree can run three children concurrently, and children cannot delegate another level. Obsolete `roleModels`, `maxParallelSubagents`, and `maxParallelCoders` do not affect execution; saved role routes cannot replace the model currently selected for the root conversation.

The MIT-licensed official npm distribution and plugins are pinned to 0.2.1-alpha.2, a developer preview. The profile composes official boot, Session Controller, AgentLoop, JSONL persistence, MCP, skills, subagents, jobs and compaction. There is no second model loop. See PROVENANCE.json; npm/source byte equivalence is unverified. [Upstream repository](https://github.com/deepseek-ai/deepseek-harness).

Use Node 24+. The approved dependency entrypoint is `npm ci --ignore-scripts --no-audit --no-fund`. This batch installed, downloaded and upgraded no dependencies and changed no system PATH.

## Adapter interface

`createHarnessDriver({dataDir,cwd,instructionsHome})` requires an isolated data root. Call `createSession({sessionId,cwd,provider,model,options})`, `prompt(sessionId,content,{onEvent,onPermission,signal})`, then `close()`. Provider fields include baseUrl (API root), apiKey, protocol, headers, compat, contextWindow, maxTokens, inputModalities and reasoningEfforts. Model/MCP credentials remain in driver memory. The on-disk Host providers map stays empty; legacy and ambient credentials are not discovered.

`configureSession(sessionId,options)` applies while idle; the application persists settings and reapplies them after restart:

- systemPrompt, maxTokens, temperature and thinkingEffort affect actual requests. Efforts must be declared by the provider.
- maxTurns bounds official steps across the prompt's root and children. max_turns preserves history and never means business completion.
- autoCompactThreshold (between 0 and 1), autoCompact and `compact(sessionId,{signal})` use official token-meter/compaction-basic; original evidence events remain intact.
- tools: `[{name,description,inputSchema,execute}]`. Execute receives `(args,{sessionId,signal,callId})` and returns a JSON object through the official registry, validation and approval pipeline.
- mcpServers uses official stdio/streamable-http configuration. Tools are mcp__server__tool. Independent servers connect concurrently, retaining each ready/error result in configuration order. Failed connections are disposed; other capabilities stay usable. Reconfiguration retries. `extensionStatus(sessionId)` reports status. `testExtension(server)` temporarily connects, discovers and disposes; failures reject. Official connection and tool-discovery requests each default to a 60-second timeout. Version negotiation may involve multiple requests, so this is not an overall startup deadline.
- toolFilter:{allow?,deny?} filters inherited tools. Same-scope MCP/host registrations require the application's shared permission gate to enforce exact allowlists.
- The generic native `subagent` accepts `{description,prompt,cwd?}` and inherits the provider, model, and reasoning effort of the parent's actual request. No `subagent_<role>` tools or child model selection are registered. Harness owns creation, concurrency, depth, and result delivery; child file and command operations still use the existing permission gate.

onEvent may return a Promise. Events are serialized and awaited before subsequent approval or host execution. Events carry sessionId; render children separately. tool_result.structuredContent/error are original official outcomes. Foreground shell results contain exitCode, aborted and timedOut; background handles are not verification results. Streaming attemptId and durable messageId differ.

Every tool requires onPermission to return true. Children inherit the callback through verified live ownership. Files additionally use workspace policy; native shells are not claimed to have kernel sandbox isolation. Cancellation interrupts children and owned jobs and returns actual states; running/stopping remains unconfirmed. Jobs are process-local; restart recovery rechecks and continues durable conversations, not old OS processes.

Other methods: listTools, callTool (idle maintenance window), steer (active official inbox), history, listSessions, rename, fork, follow and upload.

Images enter prompt parts as `{type:'image',mediaType,data:<base64>,name?}` with image declared in the model inputModalities. Official admission validates, normalizes and persists references. Generic files use `upload(sessionId,{data:<base64>,name})`, followed by `{type:'file',receiptId}` in the same session prompt. A receipt is consumed once; the model receives a handle for reading the file on demand.

`../transcripts.mjs` persists the ACP display projection while Harness owns execution history. `openTranscriptJournal(store)` recovers unfinished NDJSON at startup; `begin({sessionId,turnId,users,title?})` returns append, appendUsage and finalize. Each append awaits fsync. Finalize atomically projects chunks and replay high water marks in the runtime store, then removes the journal. Await appends before UI notifications. Recovery does not invent completion evidence.

ACP `session/cancel` requests cancellation. The adapter reserves occupancy before its first asynchronous validation. It sends the real terminal to the original caller and same-session observers; when finalization exits, it deletes occupancy before synchronously sending the existing `session_info_update` with `activeRunId: null`. The terminal, Host release, and original prompt RPC result are distinct observations; writing the cancel notification does not replace them.

## Skills and memory

AGENTS.md loading uses the official agent-instructions plugin. `instructionsHome` selects this application's global root, defaults to the isolated data root, and receives CODEBUDDY_HOME in the product. Official discovery handles project and nested instructions. This pinned version captures environment paths synchronously during apply; the wrapper changes Process variables only during that synchronous initialization and restores them immediately. It never changes User/Machine environment variables.

Official spawn creates a flat child scope. After verifying parent ownership, the driver explicitly composes host tools, MCP, system instructions and compaction during child agent/created. Execution and approval retain the actual child sessionId; native delegation inherits model and effort without a role override.

Official skill roots are project .dsh/skills and .agents/skills, plus data-root skills and agents/skills. listSkills, refreshSkills and explicit /skill-name invocation use official implementations.

This pinned version has no standalone built-in memory provider. Third-party memory uses official MCP. Local CodeBuddy records reuse storage-domain/storage-json under codebuddy_memory: synchronous memory.get(scope,key)/list(scope), asynchronous set(scope,key,JSONvalue)/delete(scope,key). The application owns schemas, project scopes, candidate activation and retrieval semantics; no second memory model or database is added.

## Validation boundary

`node --test test/driver.test.mjs test/capabilities.test.mjs`: Windows 28/28, exit 0. Tests use real official Harness, native PowerShell, isolated temporary directories and controlled loopback model/MCP services. Coverage includes request settings, awaited receipts, MCP isolation/offline behavior, skills, child routing/approval/cancellation, background jobs, step limits, compaction, image reuse after restart, file receipt isolation, memory restart and credential isolation. `node --test tests/transcripts.test.mjs` from runtime: 4/4, including a killed separate process, torn trailing records and cleanup failure after state commit. These do not establish real-model large-project quality, all UI features, desktop E2E, macOS or legacy migration acceptance.
