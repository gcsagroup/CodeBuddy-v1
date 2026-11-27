// Keep request preemption inside the pinned native loop. The turn signal,
// tool scheduler, Session history and final result writer remain upstream-owned.
const replace = (source, before, after) => {
  if (source.split(before).length !== 2)
    throw new Error('Review the pinned Harness steering contract.');
  return source.replace(before, after);
};

// The job owns the producer. This controller only releases a caller's wait.
export async function waitForSteeringInput(ctx, exec, wait) {
  const wake = new AbortController();
  const unsubscribe = ctx.on('codebuddy/steer-requested', ({ agent }) => {
    if (agent === exec.agent) wake.abort();
  });
  try {
    if (exec.agent?.codebuddyHasPendingSteering?.()) wake.abort();
    let value;
    try { value = await wait(AbortSignal.any([exec.signal, wake.signal])); }
    catch (error) { if (!wake.signal.aborted || exec.signal.aborted) throw error; }
    exec.signal.throwIfAborted();
    return { value, released: wake.signal.aborted };
  } finally { unsubscribe(); }
}

const waiterImport = `import { waitForSteeringInput } from ${JSON.stringify(import.meta.url)};\n`;

export function patchSteeringLoop(source) {
  source = replace(source, '\tsteer(input) {', `
\tcodebuddySteeringInputs = new Set();
\tcodebuddySampling;
\tcodebuddyHasPendingSteering() {
\t\tfor (const id of this.codebuddySteeringInputs) {
\t\t\tif (this.inbox.nextStep.some(message => message.source?.kind === "user" && message.source.rpcId === id)) return true;
\t\t\tthis.codebuddySteeringInputs.delete(id);
\t\t}
\t\treturn false;
\t}
\tcodebuddyPreemptForInput(requestId) {
\t\tif (this.phase.kind !== "running" || this.phase.abort.signal.aborted ||
\t\t\t!this.inbox.nextStep.some(message => message.source?.kind === "user" && message.source.rpcId === requestId)) return false;
\t\tthis.codebuddySteeringInputs.add(requestId);
\t\tthis.codebuddySampling?.codebuddyCapture?.();
\t\tthis.codebuddySampling?.abort(new Error("Model request preempted by admitted user input"));
\t\tthis.dispatch.emit("codebuddy/steer-requested", { requestId });
\t\treturn true;
\t}
\tsteer(input) {`);
  source = replace(source, '\t\t\tconst request = this.buildRequest(config, preparedCall, assembly.tools, {',
    '\t\t\tif (this.codebuddyHasPendingSteering()) return null;\n\t\t\tconst sampling = new AbortController();\n\t\t\tconst request = this.buildRequest(config, preparedCall, assembly.tools, {');
  source = replace(source, '\t\t\t}, startsRequestSeries, signal);',
    '\t\t\t}, startsRequestSeries, AbortSignal.any([signal, sampling.signal]));\n\t\t\tthis.codebuddySampling = sampling;');
  source = replace(source, '\t\t\tlet started = false;', `\t\t\tlet started = false;
\t\t\tlet outputCompleted = false;
\t\t\tconst closedBlocks = () => live.assembler.order.flatMap(index => {
\t\t\t\tconst block = live.assembler.partials.get(index)?.block;
\t\t\t\treturn block === undefined ? [] : [block];
\t\t\t});
\t\t\tsampling.codebuddyCapture = () => { sampling.codebuddyConfirmed ??= closedBlocks(); };
\t\t\tconst settlePreempted = () => {
\t\t\t\tif (!started) return null;
\t\t\t\t// Some adapters close open blocks during abort cleanup. Only pre-abort
\t\t\t\t// closure or a genuine successful terminal event establishes completion.
\t\t\t\tconst content = outputCompleted ? live.blocks() : sampling.codebuddyConfirmed ?? [];
\t\t\t\tif (content.length === 0) live.settle("assistant/attempt", () => this.session.append("assistant/attempt", { turn, step, stream: live.stream }).seq);
\t\t\t\telse {
\t\t\t\t\tconst message = createAssistantMessage({ content, source: { provider: request.provider, model: request.model,
\t\t\t\t\t\t...outputCompleted && live.replayState !== undefined ? { replayState: live.replayState } : {} } });
\t\t\t\t\tlive.settle("assistant/message", () => this.session.append("assistant/message", {
\t\t\t\t\t\tturn, step, message, interrupted: true, stream: live.stream,
\t\t\t\t\t\t...live.usage === undefined ? {} : { usage: live.usage }
\t\t\t\t\t}, { surfaceOp: "append" }).seq);
\t\t\t\t\tfor (const block of content) if (block.type === "tool-call") appendSkippedToolCall(this.session, turn, step, block);
\t\t\t\t}
\t\t\t\treturn null;
\t\t\t};`);
  source = replace(source, '\t\t\t\t\tlive.push(chunk);',
    '\t\t\t\t\tlive.push(chunk);\n\t\t\t\t\tif (chunk.type === "finish" && chunk.reason.kind !== "error" && chunk.reason.kind !== "aborted") outputCompleted = true;');
  source = replace(source, '\t\t\t} catch (error) {\n\t\t\t\tif (!started) throw error;', `\t\t\t} catch (error) {
\t\t\t\tif (!signal.aborted && sampling.signal.aborted) {
\t\t\t\t\treturn settlePreempted();
\t\t\t\t} else {
\t\t\t\tif (!started) throw error;`);
  source = replace(source, '\t\t\t\tthrow error;\n\t\t\t}\n\t\t\ttry {\n\t\t\t\tconst finish = live.finish;', `\t\t\t\tthrow error;
\t\t\t\t}
\t\t\t} finally {
\t\t\t\tif (this.codebuddySampling === sampling) this.codebuddySampling = undefined;
\t\t\t}
\t\t\tif (!signal.aborted && sampling.signal.aborted) return settlePreempted();
\t\t\ttry {
\t\t\t\tconst finish = live.finish;`);
  source = replace(source, '\t\t\t\tif (toolCalls.length === 0) return { kind: "completed" };', `\t\t\t\tif (toolCalls.length === 0) return { kind: "completed" };
\t\t\t\tif (this.codebuddyHasPendingSteering()) {
\t\t\t\t\tfor (const call of toolCalls) appendSkippedToolCall(this.session, turn, step, call);
\t\t\t\t\treturn null;
\t\t\t\t}`);
  source = replace(source, '\twhile (next < planned.length) {', `\twhile (next < planned.length) {
\t\tif (agent.codebuddyHasPendingSteering()) {
\t\t\tfor (const call of planned.slice(next)) appendSkippedToolCall(session, turn, step, call.block);
\t\t\treturn { concluded };
\t\t}`);
  source = replace(source, '\tconst { session } = ctx.agents.requireInitiator();',
    '\tconst agent = ctx.agents.requireInitiator();\n\tconst { session } = agent;');
  source = replace(source, '\tlet aborted = signal.aborted;', '\tlet aborted = signal.aborted || agent.codebuddyHasPendingSteering();');
  source = replace(source, '\t\t\tcase "dispatch": {\n\t\t\t\tconst promise =', `\t\t\tcase "dispatch": {
\t\t\t\tif (agent.codebuddyHasPendingSteering()) {
\t\t\t\t\tslots[index] = { exec: prepared.exec, result: ctx.tools.cancellationResult(prepared.exec), needsPost: true };
\t\t\t\t\taborted = true;
\t\t\t\t\tbreak;
\t\t\t\t}
\t\t\t\tconst promise =`);
  const abortCheck = '\t\t\tif (signal.aborted) aborted = true;';
  if (source.split(abortCheck).length !== 3) throw new Error('Review the native tool scheduler steering boundaries.');
  source = source.replaceAll(abortCheck, '\t\t\tif (signal.aborted || agent.codebuddyHasPendingSteering()) aborted = true;');
  return source;
}

export const steeringJobsPatch = {
  name: '@deepseek-ai/dsh-tool-jobs',
  hash: '660066155801b20c67e6e288820961a365fe65738ffee1a16e50a2394ac9c7c6',
  transform(source) {
    return waiterImport + replace(source,
      '\t\t\tif (args.wait === true) await jobs.wait(id, Math.min(args.timeout_ms ?? waitDefault, waitCap), exec.agent?.id, exec.signal);',
      '\t\t\tif (args.wait === true) await waitForSteeringInput(ctx, exec, signal => jobs.wait(id, Math.min(args.timeout_ms ?? waitDefault, waitCap), exec.agent?.id, signal));');
  },
};

// Composed after the existing preparation transform under its single loader.
export function patchSteeringPwsh(source) {
  source = replace(source, '\t\t\tlet view;\n\t\t\ttry {\n\t\t\t\tview = await registry.wait(attached.id, timeoutMs, owner, exec.signal);', `\t\t\tlet view;
\t\t\tlet released = false;
\t\t\ttry {
\t\t\t\tconst waited = await waitForSteeringInput(ctx, exec, signal => registry.wait(attached.id, timeoutMs, owner, signal));
\t\t\t\treleased = waited.released;
\t\t\t\tview = waited.value ?? registry.get(attached.id, owner);`);
  source = replace(source,
    '\t\t\tif ((view.status === "running" || view.status === "stopping") && attached.process() === void 0) {',
    '\t\t\tif (!released && (view.status === "running" || view.status === "stopping") && attached.process() === void 0) {');
  source = replace(source, '\t\t\t\t\toutput: renderPwshJobRead(',
    '\t\t\t\t\t...released ? { releaseReason: "steer", preparing: attached.process() === void 0 } : {},\n\t\t\t\t\toutput: renderPwshJobRead(');
  source = replace(source, 'function renderPwshPromoted(promoted) {', `function renderPwshPromoted(promoted) {
\tif (promoted.releaseReason === "steer") return \`\${promoted.output}\${promoted.output.length > 0 && !promoted.output.endsWith("\\n") ? "\\n" : ""}[foreground wait released by user input; background job \${promoted.jobId}\${promoted.preparing ? "; preparing, command start not yet confirmed" : ""}]\\nThe same job continues. Read its result with job_output; do not start the command again.\`;`);
  source = replace(source, '\t\t\t\t\t\t\toutput: {\n\t\t\t\t\t\t\t\ttype: "string",', `\t\t\t\t\t\t\treleaseReason: { type: "string", enum: ["steer"] },
\t\t\t\t\t\t\tpreparing: { type: "boolean" },
\t\t\t\t\t\t\toutput: {
\t\t\t\t\t\t\t\ttype: "string",`);
  return waiterImport + source;
}
