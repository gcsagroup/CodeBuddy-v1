# Run advice and model selection

This is per-run observational advice, not model ranking, a failure verdict, or another agent core. The screenshot informed the layout only; no private Codex trigger logic is assumed.

The card distinguishes a request waiting 90 seconds, generation lasting 180 seconds, three consecutive failed tool receipts, and three response-recovery attempts without a successful tool receipt. HTTP/network failures retain connection diagnostics. Tool failures explicitly suggest checking arguments, permissions and environment. Successful tool receipts clear counters; tool dispatch/request completion clears the generation clock. Read-only success is not classified as lack of progress.

Suppress advice during approval, tools, compaction, child work and cancellation. “Keep waiting” dismisses the card for this attempt without sending anything. New attempts can show it again; dismissal is not persisted across reloads. “Stop and choose a model” uses existing cancellation, waits for idle, then opens the existing picker. It never selects a model, resubmits a task or removes files. Switching chats cancels the pending UI picker action.

The driver consumes existing command-failure facts. `work-status` sends ephemeral observations through `execution_activity`; the desktop store validates optional fields and run identity. The hook/card only presents them. No additional inference, permissions, terminal states or persistence migration. Older senders simply omit the advice fields; older clients may ignore them.

References: [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/running-agents/) separates run limits and error classes; [LangChain](https://reference.langchain.com/javascript/langchain/index/toolCallLimitMiddleware) offers run/thread counts and configurable limit behavior; [Anthropic](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) discusses durable progress and verification. The first two public repositories use MIT licenses; their public documentation and main branches were accessible during this review. No code was copied, dependency added or second agent loop introduced. Hitting a hard limit is not treated as a model-quality judgment.

Advice does not verify deliverables or resolve the previously observed functional defects, reviewer misses and Gemma recovery failures. Completion review and independent verification were removed at the user’s request on 2026-11-10.
