import { createHash, randomUUID } from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { code: -32602 });
const metaId = update => update.messageId ?? update._meta?.goose?.messageId;
const digest = session => createHash('sha256').update(JSON.stringify([session.nativeSessionId ?? session.id, session.updates ?? [], session.usageUpdates ?? []])).digest('hex');
const countMessages = updates => new Set(updates.filter(u => ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(u.sessionUpdate)).map(metaId).filter(Boolean)).size;

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
  handles(method) { return ['session/fork', 'session/conversation/truncate'].includes(method.replace(/^_goose\/unstable\//, '')); }
  async request(method, params = {}) {
    const name = method.replace(/^_goose\/unstable\//, '');
    if (!this.handles(method)) throw Object.assign(new Error(`Unsupported conversation operation: ${method}`), { code: -32601 });
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('Session id is required');
    return this.driver.withConversationLock(params.sessionId, async () => {
      const source = this.store.read().sessions.find(s => s.id === params.sessionId);
      if (!source) throw invalid('Session not found');
      if (source.readonlyHistory) throw invalid('Imported history is read-only; start a new task');
      if (source.archivedAt) throw invalid('Unarchive this session before editing or copying it');
      if (this.isActive(source.id)) throw invalid('Stop the active prompt before editing or copying this session');
      const isTruncate = name === 'session/conversation/truncate';
      if (!isTruncate && source.type === 'code_pro') throw invalid('CodePro sessions use new tasks instead of conversation forks');
      if (isTruncate && source.type === 'code_pro' && !this.beforeTruncate) throw invalid('CodePro run cancellation must be connected before editing');
      if (params.cwd !== undefined && params.cwd !== source.cwd) throw invalid('A conversation fork must keep its source workspace');
      const cutoff = isTruncate ? params.truncateFrom : params._meta?.conversationBefore;
      const prefix = cutoff === undefined && !isTruncate ? { updates: source.updates ?? [], usageUpdates: source.usageUpdates ?? [] } : prefixAt(source, cutoff);
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
      const forked = await this.driver.fork(source.id, beforeRequestId ? { beforeRequestId } : {});
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
      await this.store.update(state => {
        const live = state.sessions.find(s => s.id === source.id);
        if (!live || digest(live) !== snapshot || this.isActive(source.id)) throw invalid('Conversation changed while the fork was being prepared; retry');
        if (isTruncate) {
          live.nativeSessionId = forked.sessionId;
          live.updates = prefix.updates; live.usageUpdates = prefix.usageUpdates;
          live.messageCount = countMessages(prefix.updates); live.updatedAt = now;
          live.conversationEdits ??= [];
          live.conversationEdits.push({ id: randomUUID(), createdAt: now, previousNativeSessionId: nativeSourceId, nativeSessionId: forked.sessionId, truncateFrom: cutoff, beforeRequestId: prefix.requestId, workspaceEffectsRetained: true });
          result = {};
        } else {
          const id = randomUUID();
          const copy = { id, nativeSessionId: forked.sessionId, type: 'user', title: `${source.title} (fork)`, createdAt: now, updatedAt: now, updates: prefix.updates, usageUpdates: prefix.usageUpdates, messageCount: countMessages(prefix.updates), forkedFrom: { sessionId: source.id, nativeSessionId: nativeSourceId, ...(cutoff === undefined ? {} : { conversationBefore: cutoff }) } };
          for (const key of ['cwd', 'providerId', 'modelId', 'mode', 'workspaceBinding', 'workspaceOrigin', 'projectId', 'extensions', 'extensionDefinitions', 'protectedMcpServers', 'mcpServers', 'recipe', 'userRecipeValues', 'temperature']) if (source[key] !== undefined) copy[key] = source[key];
          state.sessions.push(copy);
          result = { sessionId: id };
        }
      });
      await this.onChanged(isTruncate ? source.id : result.sessionId);
      if (isTruncate) {
        try { await this.driver.releaseNativeSessionCapabilities?.(nativeSourceId); }
        catch { console.error('[conversation] edit saved; retired capabilities will be closed at shutdown'); }
      }
      return result;
    });
  }
}
