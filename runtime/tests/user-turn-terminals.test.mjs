import test from 'node:test';
import assert from 'node:assert/strict';
import { userTurnTerminals } from '../harness/user-turn-terminals.mjs';

// Native event vocabulary, including admission targets; content text is immaterial.
const start = turn => ({ type: 'turn/start', data: { turn } });
const end = (turn, reason = { kind: 'completed' }) => ({ type: 'turn/end', time: turn, data: { turn, reason } });
const failure = { kind: 'error', error: { code: 'AUTH' } };
const user = id => ({ id, source: { kind: 'user', rpcId: id } });
const notice = id => ({ id, source: { kind: 'subagent-settled', senderSessionId: 'child' } });
const admit = (message, target = 'next-turn') => [
  { type: 'agent/inbox/spliced', data: { target, start: 0, inserted: [message] } },
  { type: 'user/message', data: message },
];
const initial = [start(1), ...admit(user('first')), end(1)];

test('native continuations inherit the preceding request without crossing independent inputs', () => {
  const cases = [
    { events: [...initial, start(2), ...admit(notice('a')), end(2), start(3), ...admit(notice('b')), end(3, failure)], owners: [['first']] },
    { events: [...initial, start(2), ...admit(user('second')), ...admit(notice('a')), end(2, failure)], owners: [['second']] },
    { events: [...initial, start(2), ...admit(user('steer'), 'next-step'), end(2), start(3), ...admit(notice('a')), end(3, failure)], owners: [['first', 'steer']] },
    { events: [...initial, start(2), ...admit(notice('a')), ...admit({ id: 'relay', source: { kind: 'agent-message', form: 'relay' } }, 'next-step'), end(2, failure)], owners: [['first']] },
    { events: [...initial, start(2), ...admit({ id: 'relay', source: { kind: 'agent-message', form: 'relay' } }, 'next-step'), end(2, failure)], owners: [['first']] },
    { events: [...initial, start(2), ...admit(notice('a')), ...admit({ id: 'context', source: { kind: 'tool-context' } }, 'next-step'), end(2, failure)], owners: [['first']] },
    { events: [start(1), ...admit(user('first')), end(1, failure), start(2), ...admit(notice('a')), end(2, failure)], owners: [['first']] },
    { events: [start(1), ...admit(user('first')), end(1, { kind: 'aborted', reason: { kind: 'user' } }), start(2), ...admit(notice('a')), end(2, failure)], owners: [['first']] },
    { events: [...initial, start(2), ...admit(notice('a')), end(2, { kind: 'error', error: { code: 'OUTPUT_LIMIT_REACHED' } })], owners: [] },
  ];
  for (const { events, owners } of cases) {
    const original = structuredClone(events);
    assert.deepEqual(userTurnTerminals(events).map(t => t.sourceIds), owners);
    assert.deepEqual(events, original, 'Projection must never mutate native history');
  }
});

for (const kind of ['schedule', 'agent-message', 'goal', 'future-native-input']) test(`${kind} breaks child-continuation ownership`, () => {
  const independent = { id: 'independent', source: { kind } };
  const events = [...initial, start(2), ...admit(independent), ...admit(notice('a')), end(2), start(3), ...admit(notice('b')), end(3, failure)];
  assert.deepEqual(userTurnTerminals(events), []);
  for (const inputs of [
    [...admit(independent), ...admit(user('new-steer'), 'next-step')],
    [...admit(user('new-steer'), 'next-step'), ...admit(independent)],
  ]) assert.deepEqual(userTurnTerminals([...initial, start(2), ...inputs, end(2, failure)]).map(t => t.sourceIds), [['new-steer']]);
});
