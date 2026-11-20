import test from 'node:test';
import assert from 'node:assert/strict';
import { nameFirstTurn, proposeFirstTurnTitle, restoreMissingTitles } from '../session-titles.mjs';

const original = { id: 'chat', title: '新对话', messageCount: 0 };
const users = [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '帮我生成一张关于小猫的图片' } }];
const reply = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结果已保存' } }];
const signal = new AbortController().signal;
function fixture() {
  const saved = { ...original, updates: [...users, { ...users[0], content: { type: 'text', text: '接着做成视频' } }] };
  const calls = [];
  const host = { store: { updateSession: async (_id, edit) => edit(saved) },
    driver: { generateTitle: async (_id, input) => { calls.push(input); return '小猫图片'; } } };
  return { saved, calls, host };
}

test('a tool-only first turn projects a title using the original prompt, even with later steering', async () => {
  const { saved, calls, host } = fixture();
  await nameFirstTurn(host, original, users, [], signal);
  assert.deepEqual(calls, [{ user: users[0].content.text, assistant: '' }]);
  assert.equal(saved.title, '小猫图片');
  await nameFirstTurn(host, { ...original, messageCount: 2 }, users, reply, signal);
  assert.equal(calls.length, 1);
});

test('manual rename, cancellation and native fork during naming win the race', async () => {
  for (const change of ['rename', 'cancel', 'fork']) {
    const { saved, host } = fixture();
    const controller = new AbortController();
    host.driver.generateTitle = async () => {
      if (change === 'rename') { saved.title = '我的小猫'; saved.userSetName = true; }
      if (change === 'cancel') controller.abort();
      if (change === 'fork') saved.nativeSessionId = 'other';
      return '覆盖';
    };
    await nameFirstTurn(host, original, users, reply, controller.signal);
    assert.equal(saved.title, change === 'rename' ? '我的小猫' : '新对话');
  }
});

test('overlap naming with tool activity once and publish only at settlement', async () => {
  const { saved, host, calls } = fixture();
  const proposed = proposeFirstTurnTitle(host, original, users, [], signal, true);
  await proposed;
  assert.equal(saved.title, '新对话');
  await nameFirstTurn(host, original, users, reply, signal, proposed);
  assert.equal(saved.title, '小猫图片');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { user: users[0].content.text, assistant: '', topicOnly: true });
});

test('restart repairs only unclaimed placeholders and keeps order, including a missing native cache entry', async () => {
  const rows = [
    { id: 'cached' }, { id: 'cold' }, { id: 'manual', userSetName: true },
    { id: 'named', title: '已命名' }, { id: 'main', globalConversation: true },
    { id: 'empty', messageCount: 0 }, { id: 'imported', readonlyHistory: true },
  ].map(row => ({ title: '新对话', messageCount: 2, updatedAt: 'old-time', ...row }));
  const lookups = [];
  const host = {
    store: { read: () => ({ sessions: structuredClone(rows) }), updateSession: async (id, edit) => edit(rows.find(s => s.id === id)) },
    driver: { listSessions: async () => rows.map(s => ({ sessionId: s.id, projections: { values: { title: s.id === 'cold' ? null : '小猫图片' } } })),
      history: async id => { lookups.push(id); return { events: [{ type: 'session/title', data: { title: '原始标题' } }] }; } },
  };
  await restoreMissingTitles(host);
  await restoreMissingTitles(host);
  assert.deepEqual(lookups, ['cold']);
  assert.deepEqual(rows.map(row => row.title), ['小猫图片', '原始标题', '新对话', '已命名', '新对话', '新对话', '新对话']);
  assert.ok(rows.every(row => row.updatedAt === 'old-time'));
});
