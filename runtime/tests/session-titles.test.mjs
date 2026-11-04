import test from 'node:test';
import assert from 'node:assert/strict';
import { nameFirstTurn } from '../session-titles.mjs';

test('first completed reply names the chat; manual rename and later turns are preserved', async () => {
  const original = { id: 'chat', title: '新对话', messageCount: 0 };
  const saved = { ...original, updates: [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '怎么做备份' } }] };
  const reply = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '按目录备份并验证恢复。' } }];
  const calls = [];
  const host = { session: () => structuredClone(saved), store: { update: async fn => fn({ sessions: [saved] }) }, driver: { generateTitle: async (_id, input) => { calls.push(input); return '备份与恢复方案'; } } };
  const signal = new AbortController().signal;
  await nameFirstTurn(host, original, [], signal);
  assert.equal(calls.length, 0);
  await nameFirstTurn(host, original, reply, signal);
  assert.equal(saved.title, '备份与恢复方案');
  assert.deepEqual(calls[0], { user: '怎么做备份', assistant: '按目录备份并验证恢复。' });
  await nameFirstTurn(host, { ...original, messageCount: 2 }, reply, signal);
  assert.equal(calls.length, 1);
  saved.title = '新对话';
  host.driver.generateTitle = async () => { saved.title = '手工名称'; saved.userSetName = true; return '不应覆盖'; };
  await nameFirstTurn(host, original, reply, signal);
  assert.equal(saved.title, '手工名称');
  saved.userSetName = false; saved.title = '新对话';
  host.driver.generateTitle = async () => { throw new Error('offline'); };
  await nameFirstTurn(host, original, reply, signal);
  assert.equal(saved.title, '新对话');
});
