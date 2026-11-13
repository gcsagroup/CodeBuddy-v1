// Pinned alpha2 compatibility: a runtime-context snapshot supersedes earlier
// snapshots in the canonical Session fold. Positional nodes and raw events stay
// intact, including old compaction ranges; ordinary user/tool messages do not move.
const checkedReplace = (source, previous, replacement) => {
  if (source.split(previous).length !== 2)
    throw new Error('Review the pinned runtime-context projection compatibility patch.');
  return source.replace(previous, replacement);
};

export const runtimeContextSessionPatch = {
  name: '@deepseek-ai/dsh-session',
  hash: '74d80a6c843483458018596cb52b26d12ae014d3cfafe1531ae5626f46403bf0',
  transform(source) {
    source = checkedReplace(source, 'function planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections) {',
      `function planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections) {
\tconst runtimeContext = event.type === "user/message" && event.data.role === "user" &&
\t\tevent.data.source?.kind === "runtime-context" &&
\t\t(event.data.source.form === undefined || event.data.source.form === "snapshot");`);
    source = checkedReplace(source, 'kind: "append",\n\t\tseq: event.seq', 'kind: "append",\n\t\truntimeContext,\n\t\tseq: event.seq');
    source = checkedReplace(source, 'kind: "replace",\n\t\tseq: event.seq', 'kind: "replace",\n\t\truntimeContext,\n\t\tseq: event.seq');
    source = checkedReplace(source, '\tif (plan?.kind !== "replace") return;', `\tif (plan?.runtimeContext) {
\t\tif (state.runtimeContextSeq !== undefined) {
\t\t\tstate.projectedMessages.set(state.runtimeContextSeq, null);
\t\t\tstate.contentGeneration += 1;
\t\t}
\t\tstate.runtimeContextSeq = plan.seq;
\t} else if (plan?.kind === "replace" && plan.shadowedSeqs.includes(state.runtimeContextSeq)) {
\t\t// Removing the current snapshot must not revive an older permission state.
\t\tstate.runtimeContextSeq = undefined;
\t}
\tif (plan?.kind !== "replace") return;`);
    // Reuse the existing native interpreter for the meter's prefix replay.
    return checkedReplace(source, 'export { KNOWN_SESSION_EVENT_TYPES,', 'export { SurfaceManager, KNOWN_SESSION_EVENT_TYPES,');
  },
};

export const runtimeContextLoopPatch = {
  name: '@deepseek-ai/dsh-agent-loop',
  hash: 'cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033',
  transform(source) {
    return checkedReplace(source, 'if (surface.has(event.seq)) {',
      'if (surface.has(event.seq) && session.deriveEventMessage(event) !== null) {');
  },
};

export const runtimeContextImageOffloadPatch = {
  name: '@deepseek-ai/dsh-compaction-image-offload',
  hash: 'fb69943ae54f1113efd42eb2487244247c63fb811f42e780c3a783c80c3b47b7',
  transform(source) {
    source = checkedReplace(source, 'const message = session.deriveEventMessage(event);\n\t\tconst imageIndexes = [];',
      'const message = session.deriveEventMessage(event);\n\t\tif (message === null) continue;\n\t\tconst imageIndexes = [];');
    // Replaying an older omission must validate its original occurrence without
    // turning a superseded runtime snapshot back into a visible message.
    return checkedReplace(source, 'messages.set(seq, offloadMessageImages(message, target["imageIndexes"]));',
      'const offloaded = offloadMessageImages(message, target["imageIndexes"]);\n\t\t\tmessages.set(seq, context.messages.get(seq) === null ? null : offloaded);');
  },
};

export const runtimeContextMeterPatch = {
  name: '@deepseek-ai/dsh-token-meter',
  hash: '39ed60a470b240f8bbc82befdb0bbbad1f409732e8ba8d12d41a1059de0dde05',
  transform(source) {
    source = checkedReplace(source, 'SessionLogOffset, SessionSeq, canonicalHeader,', 'SurfaceManager, SessionLogOffset, SessionSeq, canonicalHeader,');
    source = checkedReplace(source, 'function planSurfaceTokens(nodes, event) {\n\tconst node = analyzeNode(event.seq, deriveEventMessage(event));',
      'function planSurfaceTokens(nodes, event, projection) {\n\tconst node = analyzeNode(event.seq, projection ? projection.deriveEventMessage(event) : deriveEventMessage(event));');
    source = checkedReplace(source, '\t\tif (state === void 0) {\n\t\t\tstate = {', '\t\tif (state === void 0) {\n\t\t\tconst events = [];\n\t\t\tstate = {\n\t\t\t\tevents,\n\t\t\t\tprojection: new SurfaceManager(events, SessionLogOffset(0), session.surfaceManager.projections),');
    source = checkedReplace(source, '\t\t\tthis._foldEvent(state, event);', `\t\t\tconst generation = state.projection.contentGeneration;
\t\t\tconst surface = state.surface;
\t\t\tstate.projection.validateNext(event);
\t\t\tstate.events.push(event);
\t\t\ttry {
\t\t\t\tif (state.projection.contentGeneration !== generation)
\t\t\t\t\tstate.surface = state.surface.map(node => analyzeNode(node.seq,
\t\t\t\t\t\tstate.projection.deriveEventMessage(state.events[node.seq])));
\t\t\t\tthis._foldEvent(state, event, session.firstLiveSeq);
\t\t\t} catch (error) {
\t\t\t\tstate.surface = surface;
\t\t\t\tstate.events.pop();
\t\t\t\tstate.projection = new SurfaceManager(state.events, SessionLogOffset(0), session.surfaceManager.projections);
\t\t\t\tthrow error;
\t\t\t}`);
    source = checkedReplace(source, 'planSurfaceTokens(state.surface, event) : void 0;', 'planSurfaceTokens(state.surface, event, state.projection) : void 0;');
    source = checkedReplace(source, '_foldEvent(state, event) {', '_foldEvent(state, event, replayBoundary) {');
    // A restored provider sample may describe the old uncoalesced payload.
    // Its billing facts remain durable, but cannot calibrate a different input.
    // Only newly observed calls or unchanged historical views reuse that sample.
    return checkedReplace(source, 'if (event.data.usage !== void 0 && nextHeader !== void 0) nextAnchor = {',
      `const sameHistoricalView = event.seq >= replayBoundary || !state.surface.some(node =>
\t\t\t\tderiveEventMessage(state.events[node.seq]) !== null &&
\t\t\t\tstate.projection.deriveEventMessage(state.events[node.seq]) === null);
\t\t\tif (event.data.usage !== void 0 && nextHeader !== void 0 && sameHistoricalView) nextAnchor = {`);
  },
};
