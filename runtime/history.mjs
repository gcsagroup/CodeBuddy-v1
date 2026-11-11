import { randomUUID } from 'node:crypto';
import { loadLegacyConversation } from './legacy-migration.mjs';

const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), { code: -32602 });
const text = value => typeof value === 'string' ? value : JSON.stringify(value) ?? '';
const timestamp = (value, fallback) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;

// These are display projections only. Import never creates a Harness session,
// a CodePro run, a permission receipt, or a resumable execution context.
export class HistoryService {
  constructor(store) { this.store = store; }

  async request(method, params = {}) {
    if (method === 'session/export') {
      const session = this.store.read().sessions.find(item => item.id === params.sessionId);
      if (!session) throw invalid('Session not found');
      const conversation = session.legacyHistory ? await loadLegacyConversation(this.store.directory, session.legacyHistory) : session.historyConversation ?? conversationFromUpdates(session.updates ?? [], session.createdAt);
      const usageByMessage = new Map(), accumulated = {};
      for (const update of session.usageUpdates ?? []) {
        if (update.sessionUpdate !== 'message_usage' || !record(update.usage)) continue;
        const usage = usageByMessage.get(update.messageId) ?? {};
        for (const [key, field] of Object.entries({ inputTokens: 'input_tokens', outputTokens: 'output_tokens', totalTokens: 'total_tokens', cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens' })) {
          const value = update.usage[key];
          if (!Number.isFinite(value) || value < 0) continue;
          usage[field] = (usage[field] ?? 0) + value;
          accumulated[field] = (accumulated[field] ?? 0) + value;
        }
        usageByMessage.set(update.messageId, usage);
      }
      const exportedConversation = conversation.map(message => usageByMessage.has(message.id)
        ? { ...message, metadata: { ...message.metadata, usage: usageByMessage.get(message.id) } } : message);
      const lastUsage = [...usageByMessage.values()].at(-1) ?? {};
      return { data: JSON.stringify({
        id: session.id, name: session.title, user_set_name: true,
        working_dir: session.cwd, session_type: session.type,
        created_at: session.createdAt, updated_at: session.updatedAt,
        extension_data: {}, usage: lastUsage, accumulated_usage: accumulated, accumulated_cost: null,
        schedule_id: null, recipe: null, user_recipe_values: null,
        provider_name: session.providerId ?? null,
        model_config: session.modelId ? { model_name: session.modelId, toolshim: false,
          ...(session.thinkingEffort ? { reasoning_effort: session.thinkingEffort } : {}) } : null,
        goose_mode: 'approve',
        conversation: exportedConversation, message_count: conversation.length,
      }, null, 2) };
    }
    if (method !== 'session/import') throw Object.assign(new Error(`Unsupported history method: ${method}`), { code: -32601 });
    const source = params.source ?? 'auto';
    if (source === 'nostr') throw Object.assign(new Error('Nostr history import is not connected in this preview; import an exported JSON file'), { code: -32601 });
    if (!['auto', 'json'].includes(source)) throw invalid('History source must be auto, json, or nostr');
    if (typeof params.input !== 'string' || !params.input.trim()) throw invalid('History input must be a JSON string');
    if (Buffer.byteLength(params.input, 'utf8') > MAX_IMPORT_BYTES) throw invalid('History JSON exceeds the 32 MiB import limit');
    let sourceSession;
    try { sourceSession = JSON.parse(params.input); } catch { throw invalid('History input is not valid JSON'); }
    if (!record(sourceSession) || !Array.isArray(sourceSession.conversation)) throw invalid('Expected a Goose session JSON with a conversation array');
    if (sourceSession.conversation.length > 100_000) throw invalid('History contains too many messages');
    validateConversation(sourceSession.conversation);
    const now = new Date().toISOString();
    const id = randomUUID();
    const createdAt = timestamp(sourceSession.created_at, now);
    const updatedAt = timestamp(sourceSession.updated_at, createdAt);
    const rawTitle = sourceSession.name ?? sourceSession.description;
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle : 'Imported history';
    const session = {
      id, title, createdAt, updatedAt,
      cwd: typeof sourceSession.working_dir === 'string' ? sourceSession.working_dir : '',
      type: sourceSession.session_type === 'code_pro' ? 'code_pro' : 'user',
      readonlyHistory: true, importedAt: now,
      historyConversation: sourceSession.conversation,
      updates: updatesFromConversation(sourceSession.conversation, createdAt), usageUpdates: [],
      messageCount: sourceSession.conversation.length,
    };
    await this.store.update(state => { state.sessions.push(session); });
    return { sessionId: id, title, updatedAt, messageCount: session.messageCount };
  }
}

export function validateConversation(messages) {
  for (const [index, message] of messages.entries()) {
    if (!record(message) || !['user', 'assistant'].includes(message.role) || !Array.isArray(message.content)) throw invalid(`Invalid history message at index ${index}`);
    if (message.id != null && typeof message.id !== 'string') throw invalid(`Invalid history message ID at index ${index}`);
    if (message.created != null && (!Number.isSafeInteger(message.created) || message.created < 0)) throw invalid(`Invalid history timestamp at index ${index}`);
    for (const block of message.content) {
      if (!record(block) || typeof block.type !== 'string') throw invalid(`Invalid history content at index ${index}`);
      if (block.type === 'text' && typeof block.text !== 'string') throw invalid(`Invalid history text at index ${index}`);
      if (block.type === 'image' && (typeof block.data !== 'string' || typeof block.mimeType !== 'string')) throw invalid(`Invalid history image at index ${index}`);
      if (block.type === 'thinking' && typeof block.thinking !== 'string') throw invalid(`Invalid history thought at index ${index}`);
    }
  }
}

function displayBlock(block) {
  if (block?.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') return { type: 'image', data: block.data, mimeType: block.mimeType };
  // Rich resources, old approval requests, and old client actions are inert
  // historical text, not active MCP app/resource/permission notifications.
  return { type: 'text', text: `[${block?.type ?? 'history'}] ${text(block)}` };
}

export function updatesFromConversation(messages, createdAt) {
  const updates = [];
  const usedIds = new Set();
  for (const [index, message] of messages.entries()) {
    if (message.metadata?.userVisible === false) continue;
    let messageId = message.id || `history-${index}`;
    if (usedIds.has(`${message.role}:${messageId}`)) messageId = `${messageId}-history-${index}`;
    usedIds.add(`${message.role}:${messageId}`);
    const created = message.created ?? Math.floor(Date.parse(createdAt) / 1000);
    const meta = { goose: { messageId, created } };
    for (const block of message.content) {
      if (block.type === 'thinking') {
        updates.push({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: block.thinking }, _meta: meta });
      } else if (block.type === 'toolRequest' && typeof block.id === 'string' && block.toolCall?.status === 'success' && typeof block.toolCall.value?.name === 'string') {
        const name = block.toolCall.value.name;
        updates.push({ sessionUpdate: 'tool_call', toolCallId: block.id, title: name, kind: 'other', status: 'pending', rawInput: block.toolCall.value.arguments ?? {}, _meta: { goose: { ...meta.goose, toolCall: { toolName: name } } } });
      } else if (block.type === 'toolResponse' && typeof block.id === 'string' && ['success', 'error'].includes(block.toolResult?.status)) {
        const failed = block.toolResult.status === 'error';
        const value = block.toolResult.value;
        const blocks = failed ? [{ type: 'text', text: text(block.toolResult.error) }] : Array.isArray(value?.content) ? value.content.map(displayBlock) : [];
        updates.push({ sessionUpdate: 'tool_call_update', toolCallId: block.id, status: failed ? 'failed' : 'completed', content: blocks.map(content => ({ type: 'content', content })), rawOutput: failed ? text(block.toolResult.error) : value?.structuredContent, _meta: meta });
      } else {
        updates.push({ sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', messageId, content: displayBlock(block), _meta: meta });
      }
    }
  }
  return updates;
}

function conversationFromUpdates(updates, createdAt) {
  const messages = [], byId = new Map(), requests = new Map(), responses = new Set();
  const getMessage = (update, role) => {
    const meta = update._meta?.goose;
    const id = update.messageId ?? meta?.messageId;
    const key = id ? `${role}:${id}` : null;
    if (key && byId.has(key)) return byId.get(key);
    const message = { id: id ?? `export-${messages.length}`, role, created: meta?.created ?? Math.floor(Date.parse(createdAt) / 1000), content: [], metadata: { userVisible: true, agentVisible: true } };
    messages.push(message);
    if (key) byId.set(key, message);
    return message;
  };
  for (const update of updates) {
    if (['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate)) {
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
      const message = getMessage(update, role);
      const block = update.sessionUpdate === 'agent_thought_chunk' ? { type: 'thinking', thinking: update.content?.text ?? '', signature: '' } : displayBlock(update.content);
      const last = message.content.at(-1);
      if (last?.type === block.type && ['text', 'thinking'].includes(block.type)) {
        const field = block.type === 'text' ? 'text' : 'thinking';
        last[field] += block[field];
      } else message.content.push(block);
    } else if (update.sessionUpdate === 'tool_call') {
      const block = { type: 'toolRequest', id: update.toolCallId, toolCall: { status: 'success', value: { name: update._meta?.goose?.toolCall?.toolName ?? update.title, arguments: update.rawInput ?? {} } } };
      const previous = requests.get(update.toolCallId);
      if (previous) previous.toolCall = block.toolCall;
      else { getMessage(update, 'assistant').content.push(block); requests.set(update.toolCallId, block); }
    } else if (update.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status) && !responses.has(update.toolCallId)) {
      const content = (update.content ?? []).filter(item => item.type === 'content').map(item => displayBlock(item.content));
      const failed = update.status === 'failed';
      getMessage(update, 'user').content.push({ type: 'toolResponse', id: update.toolCallId, toolResult: failed ? { status: 'error', error: typeof update.rawOutput === 'string' ? update.rawOutput : content.map(item => item.text ?? '').join('\n') } : { status: 'success', value: { content, isError: false, ...(update.rawOutput !== undefined ? { structuredContent: update.rawOutput } : {}) } } });
      responses.add(update.toolCallId);
    }
  }
  return messages;
}
