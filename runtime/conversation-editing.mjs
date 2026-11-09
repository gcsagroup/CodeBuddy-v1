import { createHash, randomUUID } from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { code: -32602 });
const metaId = update => update.messageId ?? update._meta?.goose?.messageId;
const digest = session => createHash('sha256').update(JSON.stringify([session.nativeSessionId ?? session.id, session.updates ?? [], session.usageUpdates ?? [], session.agentSelection, session.agentInputs, session.agentProfile])).digest('hex');
const countMessages = updates => new Set(updates.filter(u => ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(u.sessionUpdate)).map(metaId).filter(Boolean)).size;

function forkTitle(source, sessions) {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const root = session => {
    const seen = new Set();
    while (!session.userSetName && session.forkedFrom && !seen.has(session.id)) {
      seen.add(session.id);
      const parent = byId.get(session.forkedFrom.sessionId);
      if (!parent) break;
      session = parent;
    }
    return session;
  };
  const original = root(byId.get(source.id));
  const titles = new Set(sessions.map(session => session.title));
  let number = Math.max(1, sessions.filter(session => root(session).id === original.id).length);
  while (titles.has(`${original.title} (${number})`)) number++;
  return `${original.title} (${number})`;
}

function prefixBeforeMessage(session, id) {
  if (typeof id !== 'string' || !id) throw invalid('Conversation boundary must be a user message id');
  const updates = session.updates ?? [];
  const cut = updates.findIndex(u => u.sessionUpdate === 'user_message_chunk' && metaId(u) === id);
  if (cut < 0) throw invalid('Conversation boundary message was not found');
  const kept = updates.slice(0, cut), ids = new Set(kept.map(metaId).filter(Boolean));
  return { updates: kept, usageUpdates: (session.usageUpdates ?? []).filter(u => ids.has(metaId(u))), requestId: id };
}

function prefixAt(session, cutoff) {
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw invalid('Conversation boundary must be an integer Unix timestamp');
  const updates = session.updates ?? [];
  const cut = updates.findIndex(u => Number.isFinite(u._meta?.goose?.created) && u._meta.goose.created >= cutoff);
  if (cut < 0 || updates[cut].sessionUpdate !== 'user_message_chunk' || !metaId(updates[cut])) throw invalid('Conversation boundary must select an existing user request');
  if (updates.slice(cut).some(u => Number.isFinite(u._meta?.goose?.created) && u._meta.goose.created < cutoff)) throw invalid('This timestamp does not identify a chronological conversation prefix');
  const kept = updates.slice(0, cut);
  const ids = new Set(kept.map(metaId).filter(Boolean));
  return { updates: kept, usageUpdates: (session.usageUpdates ?? []).filter(u => ids.has(metaId(u))), requestId: metaId(updates[cut]) };
}

/** UI projection changes surround an official fork; no native log is edited. */
export class ConversationEditing {
  constructor(store, driver, { isActive = () => false, beforeTruncate, onChanged = () => {} } = {}) {
    this.store = store; this.driver = driver;
    this.isActive = isActive; this.beforeTruncate = beforeTruncate; this.onChanged = onChanged;
  }
  handles(method) { return ['session/fork', 'session/conversation/truncate', '_codebuddy/main-conversation/clear'].includes(method.replace(/^_goose\/unstable\//, '')); }
  async request(method, params = {}) {
    const name = method.replace(/^_goose\/unstable\//, '');
    if (!this.handles(method)) throw Object.assign(new Error(`Unsupported conversation operation: ${method}`), { code: -32601 });
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('Session id is required');
    return this.driver.withConversationLock(params.sessionId, async () => {
      const source = this.store.readSession(params.sessionId);
      if (!source) throw invalid('Session not found');
      if (source.readonlyHistory) throw invalid('Imported history is read-only; start a new task');
      if (source.archivedAt) throw invalid('Unarchive this session before editing or copying it');
      if (this.isActive(source.id)) throw invalid('Stop the active prompt before editing or copying this session');
      const isClear = name === '_codebuddy/main-conversation/clear';
      if (isClear && !source.globalConversation) throw invalid('Only the main conversation can be cleared here');
      const isTruncate = isClear || name === 'session/conversation/truncate';
      if (isTruncate && source.type === 'code_pro' && !this.beforeTruncate) throw invalid('CodePro run cancellation must be connected before editing');
      if (params.cwd !== undefined && params.cwd !== source.cwd) throw invalid('A conversation fork must keep its source workspace');
      const cutoff = isTruncate ? params.truncateFrom : params._meta?.conversationBefore;
      const boundaryId = !isTruncate ? params._meta?.conversationBeforeMessageId : undefined;
      if (boundaryId !== undefined && cutoff !== undefined) throw invalid('Choose one conversation boundary');
      const prefix = boundaryId !== undefined ? prefixBeforeMessage(source, boundaryId) : isClear ? { updates: [], usageUpdates: [] } : cutoff === undefined && !isTruncate ? { updates: source.updates ?? [], usageUpdates: source.usageUpdates ?? [] } : prefixAt(source, cutoff);
      const nativeSourceId = this.driver.nativeSessionId(source.id);
      const snapshot = digest(source);
      const sourceHistory = await this.driver.history(source.id);
      const sourceRequests = new Set(sourceHistory.events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted ?? []).filter(item => item.source?.kind === 'user').map(item => item.source.rpcId));
      // A visible request can fail before native admission (for example while
      // preparing MCP services). It belongs to UI history, not model context.
      // Cut before the next admitted request, retaining the exact native prefix.
      const requestedIndex = prefix.requestId ? (source.updates ?? []).findIndex(update => metaId(update) === prefix.requestId) : -1;
      const nativeBoundary = requestedIndex < 0 ? undefined : (source.updates ?? []).slice(requestedIndex).find(update => update.sessionUpdate === 'user_message_chunk' && sourceRequests.has(metaId(update)));
      const beforeRequestId = nativeBoundary ? metaId(nativeBoundary) : undefined;
      const forked = await this.driver.fork(source.id, isClear ? { atSeq: 0 } : beforeRequestId ? { beforeRequestId } : {});
      const history = await this.driver.history(forked.sessionId);
      const nativeRequests = [...new Set(history.events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted ?? []).filter(item => item.source?.kind === 'user').map(item => item.source.rpcId))];
      const displayedRequests = [...new Set(prefix.updates.filter(u => u.sessionUpdate === 'user_message_chunk').map(metaId).filter(id => sourceRequests.has(id)))];
      if (JSON.stringify(nativeRequests) !== JSON.stringify(displayedRequests)) throw invalid('This history has no exact UI-to-Harness request mapping; start a new task');
      // Cancel the old control-plane run before publishing the new model context.
      // A failed state commit may leave an unused native fork and cancelled run;
      // it never exposes a new context under a still-authoritative old run.
      if (isTruncate) await this.beforeTruncate?.(source);
      const now = new Date().toISOString();
      let result;
      const validate = live => {
        if (!live || digest(live) !== snapshot || this.isActive(source.id)) throw invalid('Conversation changed while the fork was being prepared; retry');
      };
      if (isTruncate) {
        await this.store.updateSession(source.id, live => {
          validate(live);
          live.nativeSessionId = forked.sessionId;
          live.updates = prefix.updates; live.usageUpdates = prefix.usageUpdates;
          live.messageCount = countMessages(prefix.updates); live.updatedAt = now;
          live.conversationEdits ??= [];
          live.conversationEdits.push({ id: randomUUID(), createdAt: now, previousNativeSessionId: nativeSourceId, nativeSessionId: forked.sessionId, ...(isClear ? { cleared: true } : { truncateFrom: cutoff, beforeRequestId: prefix.requestId }), workspaceEffectsRetained: true });
          result = {};
        });
      } else {
        await this.store.insertSession(() => {
          validate(this.store.readSession(source.id));
          const sessions = this.store.read(['sessions'], { sessionFields: ['id', 'title', 'forkedFrom', 'userSetName'] }).sessions;
          const id = randomUUID();
          const copy = { id, nativeSessionId: forked.sessionId, type: 'user', title: forkTitle(source, sessions), createdAt: now, updatedAt: now, updates: prefix.updates, usageUpdates: prefix.usageUpdates, messageCount: countMessages(prefix.updates), forkedFrom: { sessionId: source.id, nativeSessionId: nativeSourceId, ...(cutoff === undefined ? {} : { conversationBefore: cutoff }), ...(boundaryId === undefined ? {} : { conversationBeforeMessageId: boundaryId }) } };
          for (const key of ['cwd', 'providerId', 'modelId', 'mode', 'workspaceBinding', 'workspaceOrigin', 'projectId', 'extensions', 'extensionDefinitions', 'protectedMcpServers', 'mcpServers', 'recipe', 'userRecipeValues', 'temperature']) if (source[key] !== undefined) copy[key] = source[key];
          // The native prefix still refers to its original input identities.
          // Copy configuration snapshots, never resolve old turns from today's template.
          for (const key of ['agentProfile', 'agentSelection', 'agentInputs']) if (source[key] !== undefined) copy[key] = structuredClone(source[key]);
          result = { sessionId: id };
          return copy;
        });
      }
      await this.onChanged(isTruncate ? source.id : result.sessionId);
      if (isTruncate) {
        try { await this.driver.releaseNativeSessionCapabilities?.(nativeSourceId); }
        catch { console.error('[conversation] edit saved; retired capabilities will be closed at shutdown'); }
      }
      return result;
    });
  }
}
