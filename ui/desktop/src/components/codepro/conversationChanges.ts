import {
  getToolRequests,
  getToolResponses,
  type Message,
  type ToolRequestMessageContent,
  type ToolResponseMessageContent,
} from '../../types/message';
import { isRecord } from '../../acp/adapter/shared';
import { parseToolAuditReceipt } from '../../acp/adapter/toolAudit';
import { fileChangeReceipt, type FileChangeReceipt } from './CodeProFileChange';
import { presentedToolCall } from './CodeProToolContent';
import { toolFilePath } from '../toolActionPresentation';

export interface ConversationChangeFile {
  key: string;
  path: string;
  changes: FileChangeReceipt[];
  added: number;
  removed: number;
  hasUnavailableDiff: boolean;
}

export interface ConversationChangeTurn {
  id: string;
  number: number;
  created: number;
  title: string;
  files: ConversationChangeFile[];
  added: number;
  removed: number;
}

function isUserTurn(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.metadata.userVisible &&
    getToolResponses(message).length === 0
  );
}

export function fileIdentity(path: string, workspaceRoot?: string): string {
  let normalized = path.replace(/\\/g, '/');
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized) && workspaceRoot)
    normalized = `${workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')}/${normalized.replace(/^\.\//, '')}`;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function displayChangePath(path: string, workspaceRoot?: string): string {
  const normalized = path.replace(/\\/g, '/');
  const root = workspaceRoot?.replace(/\\/g, '/').replace(/\/$/, '');
  if (!root) return normalized;
  const windows = /^[A-Za-z]:\//.test(root);
  const candidate = windows ? normalized.toLowerCase() : normalized;
  const prefix = windows ? root.toLowerCase() : root;
  return candidate.startsWith(`${prefix}/`) ? normalized.slice(root.length + 1) : normalized;
}

/** Resolve an operation by its committed call identity, not the current file or latest edit. */
export function conversationFileOperation(messages: Message[], toolCallId: string) {
  let request: ToolRequestMessageContent | undefined;
  let response: ToolResponseMessageContent | undefined;
  for (const message of messages) {
    for (const entry of getToolRequests(message)) if (entry.id === toolCallId) request = entry;
    for (const entry of getToolResponses(message))
      if (entry.id === toolCallId && !response) response = entry;
  }
  const call = request && presentedToolCall(request);
  if (!call) return;
  const change = fileChangeReceipt(response, request);
  const path = change?.path ?? toolFilePath(call.name, call.arguments);
  if (!path) return;
  const name = call.name.split(/__|::/).pop();
  const kind =
    name === 'read' ||
    name === 'read_document' ||
    (name === 'text_editor' && call.arguments.command === 'view')
      ? 'read'
      : 'change';
  return { kind, path: change?.path ?? path, change } as const;
}

function successfulWritePath(
  request: ToolRequestMessageContent,
  response: ToolResponseMessageContent
): string | undefined {
  const result = response.toolResult;
  if (result.status !== 'success' || !isRecord(result.value) || result.value.isError === true)
    return;
  const call = presentedToolCall(request);
  if (!call) return;
  const audit = parseToolAuditReceipt(response.metadata?.toolAudit);
  const native =
    request.metadata?.extensionName === 'harness' &&
    (call.name === 'write' || call.name === 'edit');
  if (
    !native &&
    (!audit ||
      audit.outcome !== 'success' ||
      !['platform', 'builtin'].includes(audit.extensionSource))
  )
    return;
  const name = native ? call.name : call.name.split(/__|::/).pop();
  const write =
    name === 'write' ||
    name === 'edit' ||
    (!native &&
      name === 'text_editor' &&
      ['write', 'str_replace', 'insert'].includes(String(call.arguments.command)));
  if (!write) return;
  const raw = result.value.structuredContent ?? response.metadata?.rawOutput;
  const path =
    (isRecord(raw) && typeof raw.path === 'string' ? raw.path : undefined) ??
    call.arguments.file_path ??
    call.arguments.path;
  return typeof path === 'string' && path.trim() ? path : undefined;
}

/** Derive a read-only ledger from committed receipts, without reading today's files.
 * Counts accumulate operations, including repeated edits, rather than a net diff.
 */
export function collectConversationChanges(
  messages: Message[],
  workspaceRoot?: string
): ConversationChangeTurn[] {
  const turns: ConversationChangeTurn[] = [];
  const byUserId = new Map<string, ConversationChangeTurn>();
  const requests = new Map<
    string,
    { request: ToolRequestMessageContent; turn: ConversationChangeTurn }
  >();
  const responses = new Map<
    string,
    { response: ToolResponseMessageContent; turn: ConversationChangeTurn }
  >();
  let current: ConversationChangeTurn = {
    id: 'unassigned',
    number: 0,
    created: messages[0]?.created ?? 0,
    title: '',
    files: [],
    added: 0,
    removed: 0,
  };
  turns.push(current);
  let number = 0;
  for (const message of messages) {
    if (isUserTurn(message)) {
      const existing = message.id ? byUserId.get(message.id) : undefined;
      if (existing) current = existing;
      else {
        number += 1;
        current = {
          id: message.id || `turn:${number}`,
          number,
          created: message.created,
          title: message.content
            .flatMap((content) => (content.type === 'text' ? [content.text] : []))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160),
          files: [],
          added: 0,
          removed: 0,
        };
        turns.push(current);
        if (message.id) byUserId.set(message.id, current);
      }
    }
    for (const request of getToolRequests(message)) {
      // A replay may replace a partial argument snapshot, never its original turn.
      requests.set(request.id, { request, turn: requests.get(request.id)?.turn ?? current });
    }
    for (const response of getToolResponses(message)) {
      // ACP responses are terminal: replaying the same receipt must not count twice.
      if (!responses.has(response.id)) responses.set(response.id, { response, turn: current });
    }
  }

  const add = (turn: ConversationChangeTurn, path: string, change?: FileChangeReceipt) => {
    const key = fileIdentity(path, workspaceRoot);
    let file = turn.files.find((entry) => entry.key === key);
    if (!file) {
      file = { key, path, changes: [], added: 0, removed: 0, hasUnavailableDiff: false };
      turn.files.push(file);
    }
    if (change) {
      file.changes.push(change);
      file.added += change.added;
      file.removed += change.removed;
      turn.added += change.added;
      turn.removed += change.removed;
    } else file.hasUnavailableDiff = true;
  };
  for (const [id, { request, turn }] of requests) {
    const response = responses.get(id)?.response;
    if (!response) continue;
    const change = fileChangeReceipt(response, request);
    const path = change?.path ?? successfulWritePath(request, response);
    if (path) add(turn, path, change);
  }
  // Older platform receipts can retain a validated patch without a request.
  for (const [id, { response, turn }] of responses) {
    if (requests.has(id)) continue;
    const change = fileChangeReceipt(response);
    if (change) add(turn, change.path, change);
  }
  return turns.filter((turn) => turn.files.length > 0);
}
