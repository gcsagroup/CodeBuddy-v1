// The native LLM boundary owns projection and adapter registration. Keep the
// prepared fit beside the failed call, without changing persisted failures.
export const llmPatch = {
  name: '@deepseek-ai/dsh-llm',
  hash: 'aa958631d989ea6ef9b6d0399261e7c52361c8137da33d13cfad6ebd36af41d9',
  transform(source) {
    source = source.replaceAll('\r\n', '\n');
    const replace = (previous, replacement) => {
      if (source.split(previous).length !== 2)
        throw new Error('Review the locked LLM request-fit compatibility patch.');
      source = source.replace(previous, replacement);
    };
    replace('import { createRequire } from "node:module";', 'import { createRequire } from "node:module";\nimport { isDeepStrictEqual as requestFitToolsEqual } from "node:util";');
    replace('\t\tdirectory = /* @__PURE__ */ new Map();', '\t\tdirectory = /* @__PURE__ */ new Map();\n\t\trequestFitFailures = /* @__PURE__ */ new Map();');
    replace('\t\t\t\t\t\tdispatch: (options) => adapterCall.stream(options)', '\t\t\t\t\t\tdispatch: (options) => adapterCall.stream(options),\n\t\t\t\t\t\tprepareRequest: adapterCall.prepareRequest === void 0 ? void 0 : (options) => adapterCall.prepareRequest(options)');

    // Reuse the existing file, modality, tool-history and replay projections for
    // both dispatch and recovery measurement; there is no second estimator.
    const projectionStart = '\t\t\t\tlet projectedMessages = resolvedOptions.messages;';
    const projectionEnd = '\t\t\t\titerator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();';
    if (source.split(projectionStart).length !== 2 || source.split(projectionEnd).length !== 2)
      throw new Error('The native LLM projection boundary changed.');
    const projection = source.slice(source.indexOf(projectionStart), source.indexOf(projectionEnd));
    replace(projection + projectionEnd, `\t\t\t\tconst projectedOptions = this.projectRequestOptions(resolvedOptions, modelInfo, adapter);
\t\t\t\tif (prepareRequest === void 0) iterator = dispatch(projectedOptions)[Symbol.asyncIterator]();
\t\t\t\telse {
\t\t\t\t\tconst request = await prepareRequest(projectedOptions);
\t\t\t\t\tthis.ctx.emit("codebuddy/request-fit", { sessionId: options.sessionId, fit: request.fit });
\t\t\t\t\tlet fitRecoveryDispatched = false;
\t\t\t\t\tconst summaryConfig = options.purpose === "compaction" ? Object.freeze({ ...resolvedConfig, ...resolvedConfig.stop === void 0 ? {} : { stop: Object.freeze([...resolvedConfig.stop]) } }) : void 0;
\t\t\t\t\tconst summaryTools = options.purpose === "compaction" ? deepFreeze(structuredClone(resolvedOptions.tools)) : void 0;
\t\t\t\t\tconst summaryScope = { sessionId: resolvedOptions.sessionId, purpose: resolvedOptions.purpose };
\t\t\t\t\tfitRecovery = Object.freeze({
\t\t\t\t\t\tsessionId: options.sessionId,
\t\t\t\t\t\tpurpose: options.purpose,
\t\t\t\t\t\tfit: request.fit,
\t\t\t\t\t\tmeasure: async ({ messages, toolHistory, signal }) => {
\t\t\t\t\t\t\tsignal?.throwIfAborted();
\t\t\t\t\t\t\tconst next = { ...resolvedOptions, messages, toolHistory, signal };
\t\t\t\t\t\t\tconst projected = this.projectRequestOptions(Object.isFrozen(resolvedOptions) ? deepFreeze(next) : next, modelInfo, adapter);
\t\t\t\t\t\t\tconst measured = await prepareRequest(projected);
\t\t\t\t\t\t\tsignal?.throwIfAborted();
\t\t\t\t\t\t\treturn measured.fit;
\t\t\t\t\t\t},
\t\t\t\t\t\t...options.purpose !== "compaction" ? {} : {
\t\t\t\t\t\t\tstream: (nextOptions) => {
\t\t\t\t\t\t\t\tnextOptions.signal?.throwIfAborted();
\t\t\t\t\t\t\t\tif (fitRecoveryDispatched) throw new LlmError("a summary fit continuation can only be dispatched once", "INVALID_PREPARED_CALL");
\t\t\t\t\t\t\t\tconst next = { ...nextOptions, reasoningEffort: nextOptions.reasoningEffort === void 0 ? summaryConfig.reasoningEffort : nextOptions.reasoningEffort };
\t\t\t\t\t\t\t\tif (!callConfigEquals(next, summaryConfig) || next.sessionId !== summaryScope.sessionId || next.purpose !== summaryScope.purpose || !requestFitToolsEqual(next.tools, summaryTools))
\t\t\t\t\t\t\t\t\tthrow new LlmError("summary fit continuation envelope changed before dispatch", "INVALID_PREPARED_CALL");
\t\t\t\t\t\t\t\tfitRecoveryDispatched = true;
\t\t\t\t\t\t\t\treturn this.streamWithRegistration(deepFreeze(next), { registration, config: summaryConfig, modelInfo, dispatch, prepareRequest });
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t});
\t\t\t\t\t// A checkpoint must have its complete requested output reservation.
\t\t\t\t\t// The native region owner can shrink before any provider I/O occurs.
\t\t\t\t\tif (options.purpose === "compaction" && request.fit.effectiveMaxTokens < request.fit.desiredMaxTokens)
\t\t\t\t\t\tthrow new LlmError("compaction request cannot reserve its complete output budget", "COMPACTION_OUTPUT_BUDGET_EXHAUSTED", { requestId: request.fit.requestId });
\t\t\t\t\titerator = request.stream()[Symbol.asyncIterator]();
\t\t\t\t}`);
    replace('\t\t/** Remove replay state whose historical route is owned by another adapter. */', `\t\t/** Consume only the failed request's transient fit, never restored history. */
\t\trequestFitRecovery(failure, scope) {
\t\t\tconst recovery = this.requestFitFailures.get(failure.requestId);
\t\t\tif (recovery === void 0 || (scope === void 0 ? recovery.purpose !== void 0
\t\t\t\t: recovery.purpose !== scope.purpose || recovery.sessionId !== scope.sessionId)) return;
\t\t\tthis.requestFitFailures.delete(failure.requestId);
\t\t\treturn recovery;
\t\t}
\t\tclearRequestFitFailures(options) {
\t\t\tif (options.purpose !== void 0 || options.sessionId === void 0) return;
\t\t\tfor (const [id, recovery] of this.requestFitFailures) {
\t\t\t\tif (recovery.sessionId === options.sessionId) this.requestFitFailures.delete(id);
\t\t\t}
\t\t}
\t\trememberRequestFitFailure(chunk, recovery, options) {
\t\t\tconst failure = chunk.type === "finish" && chunk.reason.kind === "error" ? chunk.reason.failure : void 0;
\t\t\tconst mainFailure = options.purpose === void 0 && (failure?.code === "LOCAL_OUTPUT_BUDGET_EXHAUSTED" || failure?.code === "OUTPUT_TRUNCATED" || failure?.code === "OUTPUT_LIMIT_REACHED");
\t\t\tconst summaryPreflight = options.purpose === "compaction" && (failure?.code === "COMPACTION_OUTPUT_BUDGET_EXHAUSTED" || failure?.code === "CONTEXT_WINDOW_EXCEEDED");
\t\t\tif ((!mainFailure && !summaryPreflight) || recovery === void 0 || failure.requestId !== recovery.fit.requestId) return;
\t\t\t// Failures are consumed synchronously by native request-error recovery.
\t\t\t// Bound diagnostics from callers that do not install that consumer.
\t\t\tif (this.requestFitFailures.size >= 256) this.requestFitFailures.delete(this.requestFitFailures.keys().next().value);
\t\t\tthis.requestFitFailures.set(failure.requestId, recovery);
\t\t}
\t\tprojectRequestOptions(resolvedOptions, modelInfo, adapter) {
${projection.replaceAll('\t\t\t\t', '\t\t\t')}\t\t\treturn this.forAdapter(projectedOptions, adapter);
\t\t}
\t\t/** Remove replay state whose historical route is owned by another adapter. */`);
    replace('\t\t\tlet iterator;\n\t\t\ttry {\n\t\t\t\tconst registration = prepared?.registration', '\t\t\tlet iterator;\n\t\t\tlet fitRecovery;\n\t\t\tthis.clearRequestFitFailures(options);\n\t\t\ttry {\n\t\t\t\tconst registration = prepared?.registration');
    replace('\t\t\t\tlet dispatch;\n\t\t\t\tif (prepared === void 0)', '\t\t\t\tlet dispatch;\n\t\t\t\tlet prepareRequest;\n\t\t\t\tif (prepared === void 0)');
    replace('\t\t\t\t\tdispatch = (options) => adapterCall.stream(options);', '\t\t\t\t\tdispatch = (options) => adapterCall.stream(options);\n\t\t\t\t\tprepareRequest = adapterCall.prepareRequest === void 0 ? void 0 : (options) => adapterCall.prepareRequest(options);');
    replace('\t\t\t\t\tdispatch = prepared.dispatch;', '\t\t\t\t\tdispatch = prepared.dispatch;\n\t\t\t\t\tprepareRequest = prepared.prepareRequest;');
    replace('\t\t\t} catch (error) {\n\t\t\t\tyield adapterFailureChunk(error, options.signal);\n\t\t\t\treturn;\n\t\t\t}', '\t\t\t} catch (error) {\n\t\t\t\tconst failure = adapterFailureChunk(error, options.signal);\n\t\t\t\tthis.rememberRequestFitFailure(failure, fitRecovery, options);\n\t\t\t\tyield failure;\n\t\t\t\treturn;\n\t\t\t}');
    replace('\t\t\t\t\t\tcompleted = true;\n\t\t\t\t\t\tyield adapterFailureChunk(error, options.signal);', '\t\t\t\t\t\tcompleted = true;\n\t\t\t\t\t\tconst failure = adapterFailureChunk(error, options.signal);\n\t\t\t\t\t\tthis.rememberRequestFitFailure(failure, fitRecovery, options);\n\t\t\t\t\t\tyield failure;');
    replace('\t\t\t\t\tyield item.value;', '\t\t\t\t\tthis.rememberRequestFitFailure(item.value, fitRecovery, options);\n\t\t\t\t\tyield item.value;');
    return source;
  },
};
