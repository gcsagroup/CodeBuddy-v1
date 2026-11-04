import { createHash } from 'node:crypto';

// Compatibility seam for the locked adapter. The loader keeps its native URL,
// so all existing consumers still receive the same PiAiAdapter class.
export const adapterPatch = {
  name: '@deepseek-ai/dsh-llm-pi-ai',
  hash: 'acc61ec5df9878094e078c25bed6b49eabd26467378fe6476141bfda024600fa',
  transform(source) {
    if (createHash('sha256').update(source).digest('hex') !== adapterPatch.hash)
      throw new Error('Review the locked PiAiAdapter request-fit patch.');
    source = source.replaceAll('\r\n', '\n');
    const replace = (previous, replacement) => {
      if (source.split(previous).length !== 2)
        throw new Error('PiAiAdapter request-fit patch no longer has one exact match.');
      source = source.replace(previous, replacement);
    };
    const between = (start, end) => {
      if (source.split(start).length !== 2 || source.split(end).length !== 2)
        throw new Error('PiAiAdapter request-fit projection boundary changed.');
      return source.slice(source.indexOf(start), source.indexOf(end));
    };
    replace('import { homedir } from "node:os";', `import { homedir } from "node:os";
import { randomUUID as requestFitId } from "node:crypto";
import { normalizeContext as normalizeRequestFitContext } from "@earendil-works/pi-ai/utils/transcript";
import { estimateContextTokens as estimateRequestFitTokens } from "@earendil-works/pi-ai/utils/estimate";
import { clampMaxTokensToContext as clampRequestFitTokens, adjustMaxTokensForThinking as adjustRequestFitThinking } from "@earendil-works/pi-ai/api/simple-options";`);
    replace('import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";', 'import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai/utils/overflow";');
    // A request default must not replace model capacity. Native prepareCall
    // marks this default in request/header, so clearing it survives replay.
    replace('\tmaxTokens: z.number().step(1).min(1),\n\tinput: z.array(z.union(MODALITIES)),',
      '\tmaxTokens: z.number().step(1).min(1),\n\trequestMaxTokens: z.number().step(1).min(1),\n\tinput: z.array(z.union(MODALITIES)),');
    replace('\t\tif (entry.maxTokens !== void 0) configuredMaxTokens.set(entry.id, entry.maxTokens);',
      '\t\tconst requestMaxTokens = entry.requestMaxTokens ?? entry.maxTokens;\n\t\tif (requestMaxTokens !== void 0) configuredMaxTokens.set(entry.id, requestMaxTokens);');
    // Schemas otherwise alias the caller's mutable declarations after fitting.
    replace('\t\tparameters: tool.parameters\n', '\t\tparameters: structuredClone(tool.parameters)\n');

    // Move the existing projection, including tool-history handling and image
    // version resolution, rather than maintaining another conversion path.
    const setup = between('\t\t\tconst updates = conversationUpdates(model);', '\t\t\tconst apiKey = await this.config.resolveApiKey');
    const projection = between('\t\t\t\tconst containsImage = options.messages.some', '\t\t\t\tconst iterator = toStreamChunks');
    const prepare = `
\tasync prepareRequestWithSnapshot(options, snapshot) {
\t\toptions = { ...options };
\t\ttry {
\t\tif (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED");
\t\tif (options.stop !== void 0) throw new LlmError("llm-pi-ai does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
\t\tconst profile = this.profileOf(snapshot, options.provider);
\t\tconst model = this.modelOf(snapshot, options.provider, options.model);
${setup.replaceAll('\t\t\t', '\t\t')}${projection.replaceAll('\t\t\t\t', '\t\t').replace('const context = attachments', 'const projected = attachments').replace('signal: watchdog.signal', 'signal: options.signal')}
\t\tif (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED");
\t\tconst context = normalizeRequestFitContext(projected);
\t\tconst estimate = Object.freeze(estimateRequestFitTokens(context));
\t\t// The pinned Responses provider enforces OpenAI's minimum max_output_tokens of 16.
\t\tconst minimumMaxTokens = model.api === "openai-responses" && model.compat?.supportsMaxOutputTokens !== false ? 16 : 1;
\t\tlet desiredMaxTokens = options.maxTokens ?? model.maxTokens;
\t\tlet effectiveMaxTokens = clampRequestFitTokens(model, context, desiredMaxTokens);
\t\tif (model.api === "anthropic-messages" && reasoning !== "off" && reasoning !== void 0 && model.compat?.forceAdaptiveThinking !== true) {
\t\t\tdesiredMaxTokens = adjustRequestFitThinking(desiredMaxTokens, model.maxTokens, reasoning, profile.thinkingBudgets).maxTokens;
\t\t\teffectiveMaxTokens = clampRequestFitTokens(model, context, adjustRequestFitThinking(effectiveMaxTokens, model.maxTokens, reasoning, profile.thinkingBudgets).maxTokens);
\t\t}
\t\tconst fit = Object.freeze({
\t\t\tversion: 1, requestId: requestFitId(), provider: options.provider, model: options.model,
\t\t\tsource: "pi-ai-estimate-context-tokens", estimate,
\t\t\tcontextWindow: model.contextWindow, safetyTokens: 4096,
\t\t\tmodelMaxTokens: model.maxTokens, explicitMaxTokens: options.maxTokens !== void 0,
\t\t\toutputCapApplied: model.api !== "openai-responses" || model.compat?.supportsMaxOutputTokens !== false,
\t\t\t...options.purpose === void 0 ? {} : { purpose: options.purpose },
\t\t\tdesiredMaxTokens, effectiveMaxTokens, minimumMaxTokens,
\t\t\tavailable: model.contextWindow - estimate.tokens - 4096
\t\t});
\t\tlet started = false;
\t\treturn Object.freeze({ fit, stream: () => {
\t\t\tif (started) throw new LlmError("pi-ai prepared request already consumed", "REQUEST_ALREADY_CONSUMED");
\t\t\tstarted = true;
\t\t\treturn this.streamWithSnapshot(options, snapshot, { context, fit });
\t\t} });
\t\t} catch (error) {
\t\t\tif (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED", { cause: error });
\t\t\tthrow error;
\t\t}
\t}
`;
    replace(setup, '');
    replace(projection, '\t\t\t\tconst { context, fit } = prepared;\n');
    replace('\t\t\tstream: (options) => this.streamWithSnapshot(options, snapshot)', '\t\t\tprepareRequest: (options) => this.prepareRequestWithSnapshot(options, snapshot),\n\t\t\tstream: (options) => this.streamWithSnapshot(options, snapshot)');
    replace('\tasync *streamWithSnapshot(options, snapshot) {', `${prepare}\tasync *streamWithSnapshot(options, snapshot, prepared) {
\t\tif (prepared === void 0) {
\t\t\tconst request = await this.prepareRequestWithSnapshot(options, snapshot);
\t\t\tyield* request.stream();
\t\t\treturn;
\t\t}
\t\tif (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED");
\t\tif (prepared.fit.desiredMaxTokens < prepared.fit.minimumMaxTokens) throw new LlmError(\`pi-ai request maxTokens must be at least \${prepared.fit.minimumMaxTokens} for this protocol\`, "INVALID_OUTPUT_BUDGET", { requestId: prepared.fit.requestId });
\t\tif (prepared.fit.available < prepared.fit.minimumMaxTokens) throw new LlmError("pi-ai request cannot reserve the protocol's minimum output budget after context safety reservation", "LOCAL_OUTPUT_BUDGET_EXHAUSTED", { requestId: prepared.fit.requestId });`);
    // Reasoning still resolves against the captured model/profile when streaming.
    replace('\t\t\tconst model = this.modelOf(snapshot, options.provider, options.model);\n\t\t\tconst apiKey', '\t\t\tconst model = this.modelOf(snapshot, options.provider, options.model);\n\t\t\tconst reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning);\n\t\t\tconst apiKey');
    replace('\t\t\t\tconst iterator = toStreamChunks', '\t\t\t\tconst reportedOutput = { tokens: void 0 };\n\t\t\t\tconst iterator = toStreamChunks');
    replace('\t\t\t\t\theaders: requestHeaders(profile.headers)\n', `\t\t\t\t\theaders: requestHeaders(profile.headers),
\t\t\t\t\tonProviderStreamEvent: async (event, requestModel) => {
\t\t\t\t\t\tobserveReportedOutput(requestModel.api, event, reportedOutput);
\t\t\t\t\t\tawait options.onProviderStreamEvent?.(event, requestModel);
\t\t\t\t\t}
`);
    replace('}), model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]();', '}), model.contextWindow, options.signal, model.id, fit, reportedOutput)[Symbol.asyncIterator]();');
    // Pi normalizes absent output usage to zero. Preserve presence only at its
    // public raw-event observer; final normalized usage cannot distinguish them.
    replace('function mapStopReason(message, contextWindow) {', `function observeReportedOutput(api, event, reported) {
\tlet value;
\tif (api === "openai-completions") {
\t\tconst usage = event?.usage || event?.choices?.[0]?.usage;
\t\tif (!usage) return;
\t\tvalue = usage.completion_tokens;
\t} else if (api === "openai-responses") {
\t\tif (event?.type !== "response.completed" && event?.type !== "response.incomplete") return;
\t\tvalue = event.response?.usage?.output_tokens;
\t} else if (api === "anthropic-messages") {
\t\t// message_start reports initial usage, not the completed response count.
\t\tif (event?.type !== "message_delta") return;
\t\tvalue = event.usage?.output_tokens;
\t} else return;
\treported.tokens = Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function mapStopReason(message, contextWindow, requestFit, reportedOutputTokens) {`);
    replace('\tconst piAiOverflow = isContextOverflow(message, contextWindow);', `\tconst hasReportedOutput = reportedOutputTokens !== void 0 && message.usage.output === reportedOutputTokens;
\tconst piAiOverflow = (message.stopReason !== "length" || hasReportedOutput) && isContextOverflow(message, contextWindow);`);
    replace('\t\tcase "length": return { kind: "max-tokens" };', `\t\tcase "length":
\t\t\tif (requestFit !== void 0 && requestFit.outputCapApplied !== false && hasReportedOutput && isRecoverableLength(message, requestFit.desiredMaxTokens)) return {
\t\t\t\tkind: "error",
\t\t\t\tfailure: {
\t\t\t\t\tmessage: "pi-ai response ended before the requested output budget",
\t\t\t\t\tcode: "OUTPUT_TRUNCATED",
\t\t\t\t\trequestId: requestFit.requestId
\t\t\t\t}
\t\t\t};
\t\t\tif (requestFit !== void 0 && requestFit.outputCapApplied !== false && requestFit.purpose === void 0 && hasReportedOutput) return {
\t\t\t\tkind: "error",
\t\t\t\tfailure: { message: "Model generation reached its output limit before completing the step.", code: "OUTPUT_LIMIT_REACHED", requestId: requestFit.requestId }
\t\t\t};
\t\t\tif (requestFit !== void 0 && requestFit.purpose === void 0) return {
\t\t\t\tkind: "error",
\t\t\t\tfailure: { message: "The service reported a response length stop; the applied output cap or output usage is unconfirmed.", code: "OUTPUT_LENGTH_STOP", requestId: requestFit.requestId }
\t\t\t};
\t\t\treturn { kind: "max-tokens" };`);
    replace('async function* toStreamChunks(events, contextWindow, callerSignal, requestedModel) {', 'async function* toStreamChunks(events, contextWindow, callerSignal, requestedModel, requestFit, reportedOutput) {');
    replace('reason: mapStopReason(event.message, contextWindow),', 'reason: mapStopReason(callerSignal?.aborted ? { ...event.message, stopReason: "aborted" } : event.message, contextWindow, requestFit, reportedOutput?.tokens),');
    replace('} : event.error, contextWindow)', '} : event.error, contextWindow, requestFit, reportedOutput?.tokens)');
    return source;
  },
};
