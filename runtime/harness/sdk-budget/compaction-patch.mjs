// Locked DSH compatibility seam. The loader applies these checked replacements
// to the original module URL; native service and error identities stay intact.
const replacements = [
  [
    'async compactIfNeeded(agent, trigger, signal) {\n\t\tconst target = routedTarget(agent.session);',
    'async compactIfNeeded(agent, trigger, signal) {\n\t\tconst pressureTarget = trigger === "pressure" ? this.pressureTarget?.(agent) : undefined;\n\t\tconst target = pressureTarget ?? routedTarget(agent.session);',
  ],
  [
    'const spec = resolveCompactSpec(policy, info.context.contextWindow, reservedCompletionTokens(agent, info.defaultMaxTokens));',
    'const reserve = pressureTarget ? pressureTarget.maxTokens ?? agent.options.maxTokens ?? info.defaultMaxTokens ?? 0 : reservedCompletionTokens(agent, info.defaultMaxTokens);\n\t\tconst spec = resolveCompactSpec(policy, info.context.contextWindow, reserve);\n\t\tthis.recordPressureSpec?.(agent, spec);',
  ],
  [
    '\t\t\ttry {\n\t\t\t\tsession.append("compaction/end", {',
    '\t\t\ttry {\n\t\t\t\ttry { dependencies.onFailure?.(error, session, compactionId); } catch { /* Optional diagnostics cannot change the transaction outcome. */ }\n\t\t\t\tsession.append("compaction/end", {',
  ],
  [
    '\t\t\t\t\tconst range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);\n\t\t\t\t\tif (range === null) return null;\n\t\t\t\t\treturn await compactSurfaceRegion',
    '\t\t\t\t\tconst compact = async () => {\n\t\t\t\t\tconst range = selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0);\n\t\t\t\t\tif (range === null) return null;\n\t\t\t\t\treturn await compactSurfaceRegion',
  ],
  [
    '\t\t\t\t\t}, operationSignal);\n\t\t\t\t} catch (error)',
    '\t\t\t\t\t}, operationSignal);\n\t\t\t\t\t};\n\t\t\t\t\treturn this.finishManualCompaction === void 0 ? await compact() : await this.finishManualCompaction(agent, compact, operationSignal);\n\t\t\t\t} catch (error)',
  ],
  [
    'throw new Error(`summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`)',
    'throw Object.assign(new Error(`summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`), { code: "COMPACTION_NOT_SMALLER" })',
  ],
  [
    'new ManualCompactionError("summary", "manual compaction could not produce a smaller summary", { cause: failure.error })',
    'new ManualCompactionError("summary", "manual compaction failed: " + (failure.error instanceof Error ? failure.error.message : String(failure.error)), { cause: failure.error })',
  ],
  [
    'throw new Error("summarization produced no text summary content")',
    'throw Object.assign(new Error("summarization produced no text summary content"), { code: "COMPACTION_EMPTY_SUMMARY" })',
  ],
  [
    '\tconst checkpointMessage = createUserMessage({\n\t\tcontent: frameSummary(summaryResult.summary),',
    '\tconst baseCheckpoint = createUserMessage({\n\t\tcontent: frameSummary(summaryResult.summary),',
  ],
  [
    '\tconst framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage);',
    '\tconst checkpointMessage = dependencies.includeFileReferences?.(baseCheckpoint, agent.session, prepared.shadowedSeqs, prepared.shadowedRouteTokenCount, dependencies.meter) ?? baseCheckpoint;\n\tconst framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage);',
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
\t\t\t\t// Geometric local preparation is bounded by the original balanced ends.
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
\t\t\tfitRecovery: (error, agent) => error instanceof LlmError && (error.code === "COMPACTION_OUTPUT_BUDGET_EXHAUSTED" || error.code === "CONTEXT_WINDOW_EXCEEDED")
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
    '\toverflowAgents = /* @__PURE__ */ new WeakMap();\n\trequestFitRetries = /* @__PURE__ */ new WeakMap();',
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
\t\t\tlet before = recovery.fit;
\t\t\tconst trigger = failure.code === "LOCAL_OUTPUT_BUDGET_EXHAUSTED" ? "local-budget" : "output-truncation";
\t\t\t// One admitted recovery can need several balanced
\t\t\t// summaries before even one target-model reply fits.
\t\t\tconst rounds = trigger === "local-budget" ? 8 : 1;
\t\t\ttry {
\t\t\t\tfor (let round = 0; round < rounds; round++) {
\t\t\t\t\tconst generation = agent.session.surface.replaceGeneration;
\t\t\t\t\tconst result = await this.compactIfNeeded(agent, trigger, signal);
\t\t\t\t\tif (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next();
\t\t\t\t\tconst after = await recovery.measure({ messages: agent.session.deriveMessages(), toolHistory: agent.session.toolHistory(), signal });
\t\t\t\t\tconst minimum = before.minimumMaxTokens ?? 1;
\t\t\t\t\tif (signal.aborted || before.provider !== after.provider || before.model !== after.model ||
\t\t\t\t\t    before.source !== after.source || before.contextWindow !== after.contextWindow ||
\t\t\t\t\t    before.safetyTokens !== after.safetyTokens || before.desiredMaxTokens !== after.desiredMaxTokens ||
\t\t\t\t\t    minimum !== (after.minimumMaxTokens ?? 1) || !Number.isFinite(after.estimate.tokens) ||
\t\t\t\t\t    !Number.isFinite(after.available) || !(after.estimate.tokens < before.estimate.tokens && after.available > before.available)) return next();
\t\t\t\t\tif (result !== null) logResult(result, trigger + " recovery");
\t\t\t\t\tif (after.available >= minimum && after.effectiveMaxTokens >= minimum) {
\t\t\t\t\t\tconst admission = ctx.bail("codebuddy/output-recovery-started", { agent, turn, step, fit: before, strategy: "compact" });
\t\t\t\t\t\tif (admission?.allowed === false || signal.aborted) return next();
\t\t\t\t\t\treturn { kind: "retry" };
\t\t\t\t\t}
\t\t\t\t\tbefore = after;
\t\t\t\t}
\t\t\t\treturn next();
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
