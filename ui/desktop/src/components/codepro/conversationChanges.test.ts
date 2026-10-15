import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/message';
import { collectConversationChanges } from './conversationChanges';

const metadata = { userVisible: true, agentVisible: true };
const audit = {
  schemaVersion: 1,
  auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
  actor: 'primary',
  effectiveModel: 'unknown',
  extensionSource: 'platform',
  toolName: 'developer::text_editor',
  permissionClass: 'workspace_write',
  authorization: 'user_confirmed',
  outcome: 'success',
  taskScoped: true,
  startedAt: '2026-08-04T09:20:30.100Z',
  completedAt: '2026-08-04T09:20:30.142Z',
  durationMs: 42,
};
const user = (id?: string, text = id ?? 'Attachment request'): Message => ({
  id,
  role: 'user',
  created: 10,
  metadata,
  content: [{ type: 'text', text }],
});
function request(id: string, path = '/fixture/app.py', name = 'write', owner = 'harness'): Message {
  return {
    id: `request:${id}`,
    role: 'assistant',
    created: 11,
    metadata,
    content: [
      {
        type: 'toolRequest',
        id,
        metadata: { extensionName: owner },
        toolCall: { status: 'success', value: { name, arguments: { file_path: path } } },
      },
    ],
  };
}
function response(
  id: string,
  raw: Record<string, unknown> = {
    path: '/fixture/app.py',
    operation: 'update',
    before: 'old\n',
    after: 'new\n',
  }
): Message {
  return {
    id: `response:${id}`,
    role: 'user',
    created: 12,
    metadata,
    content: [
      {
        type: 'toolResponse',
        id,
        toolResult: { status: 'success', value: { isError: false, structuredContent: raw } },
      },
    ],
  };
}
const operation = (id: string, path = '/fixture/app.py') => [
  request(id, path),
  response(id, { path, before: 'old\n', after: 'new\n' }),
];

describe('conversation change evidence ledger', () => {
  it('counts every visible user turn, keeps earlier file records, and binds a late response to its request owner', () => {
    const messages = [
      user('no-files'),
      user('first-edit', 'First request\nwith context'),
      request('first'),
      { ...user('hidden'), metadata: { ...metadata, userVisible: false } },
      user('second-edit'),
      ...operation('second', '/fixture/second.py'),
      response('first'),
    ];
    const turns = collectConversationChanges(messages, '/fixture');
    expect(turns.map(({ id, number, title }) => ({ id, number, title }))).toEqual([
      { id: 'first-edit', number: 2, title: 'First request with context' },
      { id: 'second-edit', number: 3, title: 'second-edit' },
    ]);
    expect(turns[0].files.map((file) => file.path)).toEqual(['/fixture/app.py']);
    expect(turns[1].files.map((file) => file.path)).toEqual(['/fixture/second.py']);
  });

  it('deduplicates replay without combining repeated edits into a net workspace diff or erasing later turns', () => {
    const first = request('a', 'C:\\Fixture\\App.py');
    const firstResult = response('a', {
      path: 'C:\\Fixture\\App.py',
      before: 'old\n',
      after: 'new\n',
    });
    const messages = [
      user('first'),
      first,
      firstResult,
      request('b', './app.py'),
      response('b', { path: './app.py', before: 'new\n', after: 'old\n' }),
      first,
      firstResult,
      user('next'),
      ...operation('c', 'C:/Fixture/App.py'),
    ];
    const turns = collectConversationChanges(messages, 'C:\\Fixture');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ id: 'first', added: 2, removed: 2 });
    expect(turns[0].files).toHaveLength(1);
    expect(turns[0].files[0]).toMatchObject({
      key: 'c:/fixture/app.py',
      added: 2,
      removed: 2,
      hasUnavailableDiff: false,
    });
    expect(turns[0].files[0].changes).toHaveLength(2);
    expect(turns[1]).toMatchObject({ id: 'next', number: 2, added: 1, removed: 1 });
  });

  it('uses request ownership even when a receipt is replayed before its matching call', () => {
    const turns = collectConversationChanges([
      user('old'),
      response('late'),
      user('owner'),
      request('late'),
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(['owner']);
  });

  it('distinguishes a confirmed create from an update with a missing original, retaining mixed evidence gaps', () => {
    const messages = [
      user('create'),
      request('a'),
      response('a', {
        path: '/fixture/app.py',
        operation: 'create',
        before: null,
        after: 'first\nsecond\n',
      }),
      request('b'),
      response('b', {
        path: '/fixture/app.py',
        operation: 'update',
        before: null,
        after: 'changed\n',
      }),
    ];
    const [turn] = collectConversationChanges(messages);
    expect(turn).toMatchObject({ added: 2, removed: 0 });
    expect(turn.files[0]).toMatchObject({ added: 2, removed: 0, hasUnavailableDiff: true });
    expect(turn.files[0].changes).toHaveLength(1);
  });

  it('does not count failed, unconfirmed, external lookalike, read or shell calls as successful file changes', () => {
    const failed = response('failed');
    failed.content = [
      { type: 'toolResponse', id: 'failed', toolResult: { status: 'error', error: 'denied' } },
    ];
    const isError = response('is-error');
    isError.content = [
      {
        type: 'toolResponse',
        id: 'is-error',
        toolResult: { status: 'success', value: { isError: true } },
      },
    ];
    expect(
      collectConversationChanges([
        user('first'),
        request('pending'),
        request('failed'),
        failed,
        request('is-error'),
        isError,
        request('external', '/fixture/app.py', 'write', 'external'),
        response('external'),
        request('namespaced', '/fixture/app.py', 'mcp__server__write'),
        response('namespaced'),
        request('read', '/fixture/app.py', 'read'),
        response('read'),
        request('shell', '/fixture/app.py', 'pwsh'),
        response('shell'),
      ])
    ).toEqual([]);
  });

  it('retains committed changes from an interrupted turn while omitting unfinished writes', () => {
    const terminal: Message = {
      role: 'assistant',
      created: 14,
      metadata,
      content: [
        {
          type: 'systemNotification',
          notificationType: 'turnTerminal',
          msg: 'Interrupted',
          data: { status: 'interrupted', source_user_message_id: 'stopped' },
        },
      ],
    };
    const [turn] = collectConversationChanges([
      user('stopped'),
      ...operation('done'),
      request('not-done', '/fixture/pending.py'),
      terminal,
    ]);
    expect(turn.files.map((file) => file.path)).toEqual(['/fixture/app.py']);
    expect(turn.files[0].changes).toHaveLength(1);
  });

  it('retains a saved truncated legacy patch even when its original request is absent', () => {
    const saved = response('legacy', {
      file_change: {
        schema_version: 1,
        path: '/fixture/deleted.py',
        added: 0,
        removed: 3,
        diff: '@@ -1,3 +0,0 @@\n-old',
        diff_truncated: true,
      },
    });
    saved.content[0] = {
      ...saved.content[0],
      metadata: {
        toolAudit: audit,
      },
    } as Message['content'][number];
    const [turn] = collectConversationChanges([user('legacy-turn'), saved, saved]);
    expect(turn).toMatchObject({ added: 0, removed: 3 });
    expect(turn.files[0]).toMatchObject({
      hasUnavailableDiff: false,
      changes: [{ diff_truncated: true }],
    });
  });

  it('keeps audited platform write gaps even when the compatibility transport labels the extension harness', () => {
    const saved = response('platform', {});
    saved.content[0] = {
      ...saved.content[0],
      metadata: { toolAudit: { ...audit, toolName: 'developer::write' } },
    } as Message['content'][number];
    const call = request('platform', '/fixture/legacy.py', 'developer::write');
    const [turn] = collectConversationChanges([user('legacy'), call, saved]);
    expect(turn.files[0]).toMatchObject({
      path: '/fixture/legacy.py',
      changes: [],
      hasUnavailableDiff: true,
    });
    saved.content[0] = {
      ...saved.content[0],
      metadata: { toolAudit: { ...audit, extensionSource: 'external_stdio' } },
    } as Message['content'][number];
    expect(collectConversationChanges([user('legacy'), call, saved])).toEqual([]);
  });

  it('keeps original-less native updates as known paths rather than empty-file diffs', () => {
    const [turn] = collectConversationChanges([
      user('old-record'),
      request('old'),
      response('old', {}),
    ]);
    expect(turn.files[0]).toMatchObject({
      path: '/fixture/app.py',
      changes: [],
      hasUnavailableDiff: true,
    });
    expect(collectConversationChanges([user('no-owner'), response('orphan')])).toEqual([]);
  });

  it('keeps missing-source fragments separate and gives id-less real user turns a deterministic local identity', () => {
    const [unassigned, identified] = collectConversationChanges([
      ...operation('prefix'),
      user(),
      ...operation('real'),
    ]);
    expect(unassigned).toMatchObject({ id: 'unassigned', number: 0, title: '' });
    expect(identified).toMatchObject({ id: 'turn:1', number: 1, title: 'Attachment request' });
  });

  it('collects full history rather than only the last visible message window', () => {
    const messages = [
      user('first'),
      ...operation('first-write'),
      ...Array.from({ length: 80 }, (_, index) => user(`later:${index}`)),
      ...operation('last-write'),
    ];
    const turns = collectConversationChanges(messages);
    expect(turns.map(({ id, number }) => ({ id, number }))).toEqual([
      { id: 'first', number: 1 },
      { id: 'later:79', number: 81 },
    ]);
  });

  it('uses the committed receipt path over the submitted path', () => {
    const [turn] = collectConversationChanges([
      user('path'),
      request('a', 'submitted.py'),
      response('a', { path: '/fixture/applied.py', operation: 'update' }),
    ]);
    expect(turn.files[0]).toMatchObject({
      path: '/fixture/applied.py',
      changes: [],
      hasUnavailableDiff: true,
    });
  });
});
