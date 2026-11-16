import { randomUUID } from 'node:crypto';

/** Keep product identities stable while official immutable forks own model history. */
export function createConversationDriver(driver, store) {
  const busy = new Map();
  const waitingPrompts = new Set();
  const nativeId = id => (store.readSession ? store.readSession(id, { fields: ['nativeSessionId'] }) : store.read(['sessions']).sessions.find(s => s.id === id))?.nativeSessionId ?? id;
  const project = (value, actual, product) => {
    if (!value || typeof value !== 'object') return value;
    const mapped = { ...value };
    for (const key of ['sessionId', 'parentSessionId']) if (mapped[key] === actual) mapped[key] = product;
    return mapped;
  };
  const callbacks = (options = {}, actual, product) => ({
    ...options,
    ...(options.onEvent ? { onEvent: event => options.onEvent(project(event, actual, product)) } : {}),
    ...(options.onPermission ? { onPermission: call => options.onPermission(project(call, actual, product)) } : {}),
    ...(options.onToolPolicy ? { onToolPolicy: call => options.onToolPolicy(project(call, actual, product)) } : {}),
    ...(options.onToolStart ? { onToolStart: call => options.onToolStart(project(call, actual, product)) } : {}),
  });
  const capabilities = (options, actual, product) => options ? {
    ...options,
    // Project the invocation, not the definition: trusted tool identity must
    // survive the conversation/native-session boundary for scoped approvals.
    projectToolContext: context => project(context, actual, product),
  } : options;
  async function lock(id, operation, kind = 'exclusive') {
    if (busy.has(id) || waitingPrompts.has(id)) throw new Error('Wait for the active conversation operation to finish');
    const completion = Promise.withResolvers();
    busy.set(id, { kind, done: completion.promise });
    try { return await operation(); } finally { busy.delete(id); completion.resolve(); }
  }
  async function prompt(id, content, options = {}) {
    const previous = busy.get(id);
    if (waitingPrompts.has(id) || (previous && previous.kind !== 'tool'))
      throw new Error('Wait for the active conversation operation to finish');
    if (previous) {
      // A sidebar tool may already be in native maintenance when Send arrives.
      // Reserve the next admission, so polling cannot starve the user's turn.
      waitingPrompts.add(id);
      let abort;
      try {
        options.signal?.throwIfAborted();
        await Promise.race([previous.done, new Promise((_, reject) => {
          abort = () => reject(options.signal.reason);
          options.signal?.addEventListener('abort', abort, { once: true });
        })]);
      } finally {
        options.signal?.removeEventListener('abort', abort);
        waitingPrompts.delete(id);
      }
    }
    options.signal?.throwIfAborted();
    const actual = nativeId(id);
    return lock(id, () => driver.prompt(actual, content, callbacks(options, actual, id)));
  }
  // Native task catalogs need identity metadata, never transcript payloads.
  // Take one committed mapping per catalog, not one full history clone per task.
  const productIds = () => new Map(store.read(['sessions'], {
    sessionFields: ['id', 'nativeSessionId'],
  }).sessions.map(session => [session.nativeSessionId ?? session.id, session.id]));
  const productId = actual => productIds().get(actual) ?? actual;
  const methods = {
    startNativeSchedules(options) {
      return driver.startNativeSchedules({
        ...options,
        prepareSession: id => options.prepareSession(productId(id)),
        observe: input => options.observe({ ...input, sessionId: productId(input.sessionId) }),
      });
    },
    async nativeScheduleRequest(action, input = {}) {
      const result = await driver.nativeScheduleRequest(action, {
        ...input, ...(input.sessionId ? { sessionId: nativeId(input.sessionId) } : {}),
      });
      if (action !== 'catalog') return result;
      const ids = productIds();
      return { ...result, records: result.records.map(record => ({ ...record, sessionId: ids.get(record.sessionId) ?? record.sessionId })) };
    },
    nativeSessionId: nativeId,
    generateTitle(id, input) { return driver.generateTitle(nativeId(id), input); },
    withConversationLock: lock,
    isConversationBusy: id => busy.has(id) || waitingPrompts.has(id),
    async createSession(input) {
      const id = input.sessionId ?? randomUUID(), actual = nativeId(id);
      return lock(id, async () => ({ ...await driver.createSession({ ...input, sessionId: actual, options: capabilities(input.options, actual, id) }), sessionId: id }));
    },
    configureSession(id, options) { const actual = nativeId(id); return lock(id, () => driver.configureSession(actual, capabilities(options, actual, id))); },
    permissions(id, options) { return driver.permissions(nativeId(id), options); },
    prompt,
    callTool(id, name, args, options) { const actual = nativeId(id); return lock(id, () => driver.callTool(actual, name, args, callbacks(options, actual, id)), 'tool'); },
    compact(id, options) { const actual = nativeId(id); return lock(id, () => driver.compact(actual, callbacks(options, actual, id))); },
    contextUsage(id) { const actual = nativeId(id); return driver.contextUsage(actual).then(value => project(value, actual, id)); },
    steer(id, content, options) { return driver.steer(nativeId(id), content, options); },
    mainAgentProfile(id) { return driver.mainAgentProfile?.(nativeId(id)) ?? null; },
    mainAgentUnavailable(id, profile) { return driver.mainAgentUnavailable?.(nativeId(id), profile) ?? []; },
    agentInputIds(id, options) { return driver.agentInputIds?.(nativeId(id), options) ?? []; },
    questions(id) { return driver.questions?.(nativeId(id)) ?? { active: [], settled: [] }; },
    answerQuestion(id, callId, answer) { return driver.answerQuestion(nativeId(id), callId, answer); },
    getGoal(id) { return driver.getGoal?.(nativeId(id)); },
    controlGoal(id, options) { return driver.controlGoal(nativeId(id), options); },
    getPlanMode(id) { return driver.getPlanMode(nativeId(id)); },
    setPlanMode(id, options) { return driver.setPlanMode(nativeId(id), options); },
    cancel(id) { return driver.cancel(nativeId(id)); },
    upload(id, file, signal) { return driver.upload(nativeId(id), file, signal); },
    listTools(id, extensionName) { return driver.listTools?.(id === undefined ? id : nativeId(id), extensionName) ?? []; },
    listSkills(id) { return driver.listSkills(nativeId(id)); },
    listBuiltinSkills(cwd) { return driver.listBuiltinSkills?.(cwd) ?? []; },
    extensionStatus(id) { return driver.extensionStatus?.(nativeId(id)) ?? []; },
    readResource(id, server, uri, options) { const actual = nativeId(id); return driver.readResource(actual, server, uri, callbacks(options, actual, id)); },
    listResources(id, server, cursor, options) { const actual = nativeId(id); return driver.listResources(actual, server, cursor, callbacks(options, actual, id)); },
    rename(id, title) { return driver.rename(nativeId(id), title); },
    history(id) { return driver.history(nativeId(id)); },
    lastUserStop(id, sourceId, options) { return driver.lastUserStop?.(nativeId(id), sourceId, options); },
    userTurnTerminals(id, options) { return driver.userTurnTerminals?.(nativeId(id), options); },
    exportSessionLog(id) { return driver.exportSessionLog(nativeId(id)); },
    // Subagent browsing resolves the product root once; child addresses are native.
    nativeHistory(id) { return driver.history(id); },
    listSubagentChildren(id, signal) { return driver.listSubagentChildren(id, signal); },
    // A native fork is not a published product session until Editing commits it.
    fork(id, options) { return driver.fork(nativeId(id), options); },
    forkWorkingDirectory(id, workingDir, options) { return driver.forkWorkingDirectory(nativeId(id), workingDir, options); },
    assertNativeSessionIdle(id) { return driver.assertNativeSessionIdle?.(id); },
    releaseNativeSessionCapabilities(id) { return driver.releaseNativeSessionCapabilities?.(id); },
    async *follow(id, signal) {
      const actual = nativeId(id);
      for await (const value of driver.follow(actual, signal)) yield project(value, actual, id);
    },
    async listSessions() {
      const sessions = store.read(['sessions'], { sessionFields: ['id', 'nativeSessionId', 'conversationEdits', 'directoryChanges'] }).sessions;
      const current = new Map(sessions.map(s => [s.nativeSessionId ?? s.id, s.id]));
      const retired = new Set(sessions.flatMap(s => [...(s.conversationEdits ?? []), ...(s.directoryChanges ?? [])].map(edit => edit.previousNativeSessionId)));
      return (await driver.listSessions()).filter(s => !retired.has(s.id ?? s.sessionId) || current.has(s.id ?? s.sessionId)).map(s => {
        const actual = s.id ?? s.sessionId, id = current.get(actual);
        return id ? { ...project(s, actual, id), ...(s.id !== undefined ? { id } : {}) } : s;
      });
    },
  };
  // Optional native scheduling must remain absent on ACP-only and legacy
  // drivers; the conversation projection cannot manufacture a capability.
  for (const key of ['startNativeSchedules', 'nativeScheduleRequest'])
    if (typeof driver[key] !== 'function') delete methods[key];
  return new Proxy(driver, { get(target, key) { return Object.hasOwn(methods, key) ? methods[key] : typeof target[key] === 'function' ? target[key].bind(target) : target[key]; } });
}
