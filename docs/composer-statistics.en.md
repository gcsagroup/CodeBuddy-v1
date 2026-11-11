# Composer statistics

During generation the composer shows the current request’s output tokens per second over the latest sampling interval of at least half a second. Discovered vLLM chat endpoints receive continuous usage requests. Other chat endpoints can also supply stream counters. When only content is available, the Harness token estimate is marked `≈`. Sampling starts with output and resets for each request. After generation the composer returns to the completed session average.

Keep permissions, model selection and send controls on the action row. A separate wrapping statistics row shows speed, cache hits and context occupancy, with keyboard-accessible explanatory tooltips.

Average generation speed reuses the pinned Harness 0.2.1-alpha.2 `@deepseek-ai/dsh-session-stats` plugin: `decodeTokens / (decodeMs / 1000)`. This is the session average across completed model requests, excluding first-token wait and tool execution. It updates on completion; reloads do not add idle time. Mixed-model sessions still show a session average, not a benchmark of the selected model.

Cache hits use the latest non-compaction request's existing receipt. Divide cache reads by total input: prefer `totalTokens - outputTokens`, otherwise sum Harness's uncached input, cache reads and cache writes. Writes are not hits. Missing/invalid data shows `Not reported`; explicitly reported zero shows `0%`; partial hits never round to `100%`. Context occupancy retains the existing meter and alerts, with `≈` for estimates.

Optional `sessionStats` travels through the existing `status_message.data.context_meter` payload because the SDK strips undefined metadata from usage_update. No additional inference calls, timer, statistics database or execution loop is introduced. Older services and histories remain usable without these figures.

The pinned upstream plugin and its MIT-licensed reference UI define the metrics. The full upstream Web UI depends on its own application context, so the Electron frontend reuses its existing React components instead. [LM Studio](https://lmstudio.ai/docs/developer/rest/chat) separates generation speed and first-token latency; [Cline](https://docs.cline.bot/core-workflows/task-management) tracks available caching information and updates costs per request. Only the information hierarchy is referenced, without copying their code or adding dependencies. Accuracy depends on provider receipts and Harness normalization; unreported server KV-cache hits are not inferred.

Cache receipt correction: the existing pinned adapter seam preserves explicit zero cache reads from OpenAI-compatible raw usage. Missing data remains unknown and positive counts retain native mapping. Values remain request-scoped and persist in native sessions; old histories are not backfilled. Enabling vLLM prefix caching and returning prompt_tokens_details.cached_tokens are separate settings.
