// Locked DSH compatibility seam. The loader applies these checked replacements
// to the original module URL; native service and error identities stay intact.
const replacements = [
  [
    'function routedTarget(session) {',
    `// Several independently committed regions may be needed after a window shrink.
// Stay inside native maintenance/recovery; never dispatch the main request here.
async function compactForRequestFit(engine, agent, compact, measure, before, signal) {
\tlet result = null;
\tlet fit = before;
\tfor (let attempt = 0; attempt < 8; attempt += 1) {
\t\tsignal?.throwIfAborted();
\t\tconst generation = agent.session.surface.replaceGeneration;
\t\tif (attempt > 0) engine.fitContinuations.add(agent);
\t\tlet current;
\t\ttry { current = await compact(); }
\t\tfinally { engine.fitContinuations.delete(agent); }
\t\tsignal?.throwIfAborted();
\t\tif (current !== null) result = current;
\t\tif (agent.session.surface.replaceGeneration <= generation || measure === void 0) break;
\t\tconst after = await measure();
\t\tsignal?.throwIfAborted();
\t\tconst minimum = fit.minimumMaxTokens ?? 1;
\t\tconst samePolicy = fit.provider === after.provider && fit.model === after.model
\t\t\t&& fit.contextWindow === after.contextWindow && fit.safetyTokens === after.safetyTokens
\t\t\t&& fit.desiredMaxTokens === after.desiredMaxTokens && minimum === (after.minimumMaxTokens ?? 1);
\t\tconst progress = Number.isFinite(after.estimate.tokens) && after.estimate.tokens < fit.estimate.tokens
\t\t\t&& Number.isFinite(after.available) && after.available > fit.available;
\t\tif (!samePolicy) throw new LlmError("compaction request budget policy changed during recovery", "INVALID_PREPARED_CALL");
\t\tfit = after;
\t\tif (!progress || after.available >= minimum) break;
\t}
\treturn { result, fit };
}
function routedTarget(session) {`,
  ],
  [
    '\tconst latest = agent.session.requestHeader()?.config;',
    '\tconst latest = input.compactionTarget ?? agent.session.requestHeader()?.config;',
  ],
  [
    '\t\tconst target = conversationTarget(agent);',
    `\t\tconst first = input.messages[0]?.role === "system" ? 1 : 0;
\t\tif (this.fitContinuations.has(agent) && input.messages.length === first + 1 && input.messages[first]?.source?.kind === "compact-checkpoint")
\t\t\tthrow new LlmError("remaining history cannot fit without repeatedly summarizing the same checkpoint", "COMPACTION_NO_PROGRESS");
\t\tconst target = input.compactionTarget ?? conversationTarget(agent);`,
  ],
  [
    '\tfor await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);',
    '\tfor await (const chunk of input.requestFitStream === void 0 ? ctx.llm.stream(options) : input.requestFitStream(options)) assembler.push(chunk);',
  ],
  [
    '\tlet summaryResult;\n\tfor (;;) {',
    '\tlet summaryResult;\n\tlet requestFitStream;\n\tfor (;;) {',
  ],
  [
    '\t\t\tsummaryResult = await dependencies.summarize(prepared.input, agent, signal);',
    '\t\t\tsummaryResult = await dependencies.summarize(requestFitStream === void 0 ? prepared.input : { ...prepared.input, requestFitStream }, agent, signal);',
  ],
  [
    '\t\t\tassertStable(dependencies, agent.session, prepared);\n\t\t\tif (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error;',
    `\t\t\tassertStable(dependencies, agent.session, prepared);
\t\t\tconst fitRecovery = dependencies.fitRecovery?.(error, agent);
\t\t\tif (fitRecovery !== void 0) {
\t\t\t\tconst nodes = agent.session.surface.nodes;
\t\t\t\tconst current = validateSurfaceRegion(agent.session, prepared.start, prepared.end);
\t\t\t\tconst ends = [];
\t\t\t\tfor (let index = current.startIdx; index < current.endIdx; index += 1)
\t\t\t\t\tif (toolPairingBalancedAfter(agent.session, nodes[index])) ends.push(nodes[index]);
\t\t\t\tif (ends.length === 0) throw error;
\t\t\t\t// Both estimated and provider-confirmed overflow shrink the selected
\t\t\t\t// span geometrically, bounded by its original balanced ends.
\t\t\t\t// It favors a useful fitting prefix over finding the longest one.
\t\t\t\tconst end = ends[Math.floor((ends.length - 1) / 2)];
\t\t\t\tsignal?.throwIfAborted();
\t\t\t\tprepared = prepareCompaction(dependencies, agent.session, validateSurfaceRegion(agent.session, prepared.start, end));
\t\t\t\trequestFitStream = fitRecovery.stream;
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error;`,
  ],
  [
    '\t\t\tmeter: this.ctx.tokenMeter,\n\t\t\tsummarize:',
    `\t\t\tmeter: this.ctx.tokenMeter,
\t\t\tfitRecovery: (error, agent) => error instanceof LlmError && (error.code === "COMPACTION_OUTPUT_BUDGET_EXHAUSTED" || error.code === CONTEXT_WINDOW_EXCEEDED_CODE)
\t\t\t\t? this.ctx.llm.requestFitRecovery?.(error.failure, { purpose: "compaction", sessionId: agent.session.id }) : void 0,
\t\t\tsummarize:`,
  ],
  [
    '* Resolve the next range starting at the first non-system surface node while\n* retaining a priced recent tail and never splitting an assistant\n* tool-call/result pair. A `system/message` at surface node 0 is never inside\n* the range; without one the range starts at node 0.',
    '* Resolve a useful priced range while retaining the recent tail and latest\n* canonical user input verbatim. Never split a tool-call/result pair or include\n* the leading system message; the selected range may follow the protected user.',
  ],
  [
    '\tif (keepFromIdx <= firstIdx) return null;\n\treturn {\n\t\tstart: surfaceNodes[firstIdx],\n\t\tend: surfaceNodes[keepFromIdx - 1]\n\t};',
    `\tif (keepFromIdx <= firstIdx) return null;
\t// Generated runtime/catalog messages can follow the human input. Retaining
\t// only the final surface unit must not turn that input into a lossy summary.
\tlet latestUserIdx = -1;
\tfor (let index = surfaceNodes.length - 1; index >= firstIdx; index -= 1) {
\t\tconst event = session.eventAt(surfaceNodes[index]);
\t\tif (event.type === "user/message" && event.data.source?.kind === "user") {
\t\t\tlatestUserIdx = index;
\t\t\tbreak;
\t\t}
\t}
\tconst candidates = latestUserIdx >= firstIdx && latestUserIdx < keepFromIdx
\t\t? [[firstIdx, latestUserIdx - 1], [latestUserIdx + 1, keepFromIdx - 1]]
\t\t: [[firstIdx, keepFromIdx - 1]];
\tlet selected = null;
\tlet checkpointFallback = null;
\tfor (let [startIdx, endIdx] of candidates) {
\t\t// Trim inward: a tool unit crossing the user or retained tail stays whole.
\t\twhile (startIdx <= endIdx && !toolPairingBalancedBefore(session, surfaceNodes[startIdx])) startIdx += 1;
\t\twhile (startIdx <= endIdx && !toolPairingBalancedAfter(session, surfaceNodes[endIdx])) endIdx -= 1;
\t\tif (startIdx > endIdx) continue;
\t\tconst event = startIdx === endIdx ? session.eventAt(surfaceNodes[startIdx]) : void 0;
\t\tconst tokens = pricedNodes.slice(startIdx, endIdx + 1).reduce((total, node) => total + node.tokens, 0);
\t\tif (tokens <= 0) continue;
\t\tif (event?.type === "user/message" && event.data.source?.kind === "compact-checkpoint") {
\t\t\t// Prefer new history, but retain native forced/manual re-compaction when
\t\t\t// an old checkpoint is the only safe candidate. Pressure keeps its guard.
\t\t\tif (checkpointFallback === null || tokens > checkpointFallback.tokens) checkpointFallback = {
\t\t\t\tstart: surfaceNodes[startIdx], end: surfaceNodes[endIdx], tokens
\t\t\t};
\t\t\tcontinue;
\t\t}
\t\t// Price ranks useful segments; the adapter still owns actual request fit.
\t\t// Prefer the earlier segment on a tie for deterministic replay.
\t\tif (selected === null || tokens > selected.tokens) selected = {
\t\t\tstart: surfaceNodes[startIdx],
\t\t\tend: surfaceNodes[endIdx],
\t\t\ttokens
\t\t};
\t}
\tselected ??= checkpointFallback;
\treturn selected === null ? null : { start: selected.start, end: selected.end };`,
  ],
  [
    '\toverflowAgents = /* @__PURE__ */ new WeakMap();',
    '\toverflowAgents = /* @__PURE__ */ new WeakMap();\n\trequestFitRetries = /* @__PURE__ */ new WeakMap();\n\tfitContinuations = /* @__PURE__ */ new WeakSet();',
  ],
  [
    '\t\t\tif (status === "idle") this.overflowRetries.delete(agent);',
    '\t\t\tif (status === "idle") {\n\t\t\t\tthis.overflowRetries.delete(agent);\n\t\t\t\tthis.requestFitRetries.delete(agent);\n\t\t\t}',
  ],
  [
    '\t\tctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {',
    `\t\t// Local request fitting is distinct from a provider-confirmed overflow.
\t\t// The LLM service owns the ephemeral original-envelope/fit association.
\t\tctx.on("agent/request-error", async ({ agent, turn, step, failure, signal }, next) => {
\t\t\tif (signal.aborted || failure.code !== "LOCAL_OUTPUT_BUDGET_EXHAUSTED" && failure.code !== "OUTPUT_TRUNCATED") return next();
\t\t\tconst recovery = ctx.llm.requestFitRecovery?.(failure);
\t\t\tif (recovery === void 0) return next();
\t\t\tconst allowance = ctx.bail("codebuddy/output-recovery-available", { agent, turn, step, fit: recovery.fit });
\t\t\tconst previous = this.requestFitRetries.get(agent);
\t\t\tif (allowance?.allowed === false || previous?.turn === turn && previous.step === step) return next();
\t\t\t// Deduplicate failed/no-op summaries within a native step. The host
\t\t\t// recovery projection owns the shared generation allowance.
\t\t\tthis.requestFitRetries.set(agent, { turn, step });
\t\t\tconst before = recovery.fit;
\t\t\tconst generation = agent.session.surface.replaceGeneration;
\t\t\tconst trigger = failure.code === "LOCAL_OUTPUT_BUDGET_EXHAUSTED" ? "local-budget" : "output-truncation";
\t\t\ttry {
\t\t\t\tconst { result, fit: after } = await compactForRequestFit(this, agent,
\t\t\t\t\t() => this.compactIfNeeded(agent, trigger, signal),
\t\t\t\t\t() => recovery.measure({ messages: agent.session.deriveMessages(), toolHistory: agent.session.toolHistory(), signal }),
\t\t\t\t\tbefore, signal);
\t\t\t\tif (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
\t\t\t\tif (signal.aborted) return next();
\t\t\t\t// Compare the same routed envelope and budget policy; a replacement marker
\t\t\t\t// alone is not proof that the actual adapter projection became smaller.
\t\t\t\tconst minimumMaxTokens = before.minimumMaxTokens ?? 1;
\t\t\t\tconst improved = before.provider === after.provider && before.model === after.model
\t\t\t\t\t&& before.contextWindow === after.contextWindow && before.safetyTokens === after.safetyTokens
\t\t\t\t\t&& before.desiredMaxTokens === after.desiredMaxTokens
\t\t\t\t\t&& minimumMaxTokens === (after.minimumMaxTokens ?? 1)
\t\t\t\t\t&& Number.isFinite(before.estimate.tokens) && Number.isFinite(after.estimate.tokens)
\t\t\t\t\t&& after.estimate.tokens < before.estimate.tokens
\t\t\t\t\t&& Number.isFinite(before.available) && Number.isFinite(after.available)
\t\t\t\t\t&& after.available > before.available && after.available >= minimumMaxTokens && after.effectiveMaxTokens >= minimumMaxTokens;
\t\t\t\tif (!improved) {
\t\t\t\t\tctx.logger.warn(trigger + " compaction did not improve the prepared request fit; preserving the original request error");
\t\t\t\t\treturn next();
\t\t\t\t}
\t\t\t\tif (result !== null) logResult(result, trigger + " recovery");
\t\t\t\tconst admission = ctx.bail("codebuddy/output-recovery-started", { agent, turn, step, fit: before, strategy: "compact" });
\t\t\t\tif (admission?.allowed === false || signal.aborted) return next();
\t\t\t\treturn { kind: "retry" };
\t\t\t} catch (recoveryError) {
\t\t\t\tconst message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
\t\t\t\tctx.logger.warn(trigger + " compaction failed: " + message + "; " + (signal.aborted ? "cancellation prevents retry" : "preserving the original request error"));
\t\t\t\treturn next();
\t\t\t}
\t\t});
\t\tctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {`,
  ],
  [
    '\t\t\tcase "context-overflow": break;\n\t\t\tcase "pressure": break;',
    '\t\t\tcase "context-overflow": break;\n\t\t\tcase "local-budget": break;\n\t\t\tcase "output-truncation": break;\n\t\t\tcase "pressure": break;',
  ],
  [
    '\t\tif (trigger === "context-overflow") {',
    '\t\tif (trigger === "context-overflow" || trigger === "local-budget" || trigger === "output-truncation") {',
  ],
  [
    '\t\t\t\t\tconst range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);\n\t\t\t\t\tif (range === null) return null;\n\t\t\t\t\treturn await compactSurfaceRegion(this.regionDependencies(), agent.session, range.start, range.end, agent, {',
    `\t\t\t\t\tif (selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0) === null) return null;
\t\t\t\t\tconst pending = this.ctx.sessionProjections?.stateOf(agent.session, "modelSelection")?.pending;
\t\t\t\t\tconst target = Object.freeze({ ...(pending ?? agent.session.requestHeader()?.config ?? agent.options) });
\t\t\t\t\tconst call = await this.ctx.llm.prepareCall?.(target, operationSignal);
\t\t\t\t\tconst measure = call?.measure === void 0 ? void 0 : () => call.measure({
\t\t\t\t\t\t...call.config, sessionId: agent.session.id, messages: agent.session.deriveMessages(),
\t\t\t\t\t\ttools: agent.session.requestHeader()?.tools, toolHistory: agent.session.toolHistory(), signal: operationSignal,
\t\t\t\t\t});
\t\t\t\t\tconst before = await measure?.();
\t\t\t\t\tconst dependencies = { ...this.regionDependencies(),
\t\t\t\t\t\tsummarize: (input, owner, abort) => this.summarize({ ...input, compactionTarget: target }, owner, abort),
\t\t\t\t\t};
\t\t\t\t\tconst { result, fit } = await compactForRequestFit(this, agent, async () => {
\t\t\t\t\tconst range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);
\t\t\t\t\tif (range === null) return null;
\t\t\t\t\treturn await compactSurfaceRegion(dependencies, agent.session, range.start, range.end, agent, {`,
  ],
  [
    '\t\t\t\t\t}, operationSignal);\n\t\t\t\t} catch (error) {',
    `\t\t\t\t\t}, operationSignal);
\t\t\t\t\t}, measure, before, operationSignal);
\t\t\t\t\tif (fit !== void 0 && (fit.available < (fit.minimumMaxTokens ?? 1) || fit.effectiveMaxTokens < (fit.minimumMaxTokens ?? 1)))
\t\t\t\t\t\tthrow new ManualCompactionError("summary", "manual compaction could not fit the selected model's context window within safe bounded recovery; uncompressed history was retained");
\t\t\t\t\treturn result;
\t\t\t\t} catch (error) {`,
  ],
  [
    '"manual compaction could not produce a smaller summary", { cause: failure.error }',
    '`manual compaction failed: ${errorChain(failure.error)}`, { cause: failure.error }',
  ],
];

export const compactionPatch = {
  name: '@deepseek-ai/dsh-compaction-basic',
  hash: 'b7ac52f20a36430cf01a66b3a36f23a48ffdb22708d714dbe1fff541b5df4ec5',
  transform(source) {
    for (const [previous, replacement] of replacements) {
      if (source.split(previous).length !== 2)
        throw new Error('Review the native compaction request-fit compatibility patch.');
      source = source.replace(previous, replacement);
    }
    return source;
  },
};

export default compactionPatch;
