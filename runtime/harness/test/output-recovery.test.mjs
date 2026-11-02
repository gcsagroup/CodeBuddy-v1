import test from 'node:test';
import assert from 'node:assert/strict';
import { outputRecoveryProjection } from '../output-recovery.mjs';

const budget = { requestedTokens: 128, effectiveTokens: 128, capacityTokens: 32768,
  contextLimit: 65536, source: 'configured' };
const fold = (events, header = {}, inherited = 0) => events.reduce((state, event) => outputRecoveryProjection.apply(state, event), outputRecoveryProjection.init(header, inherited));
const record = data => ({ type: 'plugin:codebuddy/output-recovery', ignorable: true, data });
const begun = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'step/start', data: { turn: 1, step: 1 } }];

test('replaying a legacy recovery retains its spent one-attempt turn allowance', () => {
  const events = [...begun, record({ turn: 1, attempt: 1, strategy: 'smaller-steps', budget }),
    { type: 'assistant/message', data: { turn: 1, step: 1 } },
    { type: 'step/start', data: { turn: 1, step: 2 } }];
  const restored = fold(events);
  assert.equal(restored.attempts, 1);
  assert.equal(restored.maxAttempts, 1, 'reloading an old turn must not increase its allowance');
  assert.equal(restored.retryPending, false);
  const blocked = outputRecoveryProjection.apply(restored, record({ version: 2, turn: 1, step: 2,
    attempt: 2, strategy: 'compact', budget }));
  assert.deepEqual(blocked, restored);
  const nextTurn = outputRecoveryProjection.apply(restored, { type: 'turn/start', data: { turn: 2 } });
  assert.equal(nextTurn.attempts, 1, 'an automatic native turn must not refresh an old allowance');
  const human = fold([...events, { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 1 } }, { type: 'user/message', data: { source: { kind: 'user' } } }]);
  assert.equal(human.attempts, 0);
  assert.equal(human.maxAttempts, 2, 'newly admitted user input receives the new policy');
});

test('duplicate step events and assistant prose do not replenish the generation allowance', () => {
  const spent = fold([...begun, record({ version: 2, turn: 1, step: 1, attempt: 1, strategy: 'smaller-steps', budget })]);
  const replayed = [{ type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1 } }]
    .reduce((state, event) => outputRecoveryProjection.apply(state, event), spent);
  assert.equal(replayed.stepAttempts, 1);
  assert.equal(replayed.attempts, 1);
  const invalidRecord = record({ version: 2, turn: 1, step: 1, attempt: 2, strategy: 'compact', budget });
  assert.deepEqual(outputRecoveryProjection.apply(replayed, invalidRecord), replayed);
});

test('only new first-step human, schedule or direct-parent inputs renew the allowance', () => {
  const spent = [...begun, record({ version: 2, turn: 1, step: 1, attempt: 1, strategy: 'smaller-steps', budget })];
  for (const source of [{ kind: 'subagent-settled' }, { kind: 'agent-message', senderSessionId: 'child' },
    { kind: 'runtime-context' }]) {
    const automatic = fold([...spent, { type: 'turn/start', data: { turn: 2 } },
      { type: 'step/start', data: { turn: 2, step: 1 } }, { type: 'user/message', data: { source } }], { parentSession: 'parent' });
    assert.equal(automatic.attempts, 1);
  }
  for (const source of [{ kind: 'user' }, { kind: 'schedule' }, { kind: 'agent-message', senderSessionId: 'parent' }]) {
    assert.equal(fold([...spent, { type: 'turn/start', data: { turn: 2 } },
      { type: 'step/start', data: { turn: 2, step: 1 } }, { type: 'user/message', data: { source } }], { parentSession: 'parent' }).attempts, 0);
  }
  assert.equal(fold([...spent, { type: 'step/start', data: { turn: 1, step: 2 } },
    { type: 'user/message', data: { source: { kind: 'user' } } }]).attempts, 1, 'an immediate steer stays in the same execution');
});

test('a forked child does not inherit its parent recovery records', () => {
  const events = [...begun, record({ turn: 1, attempt: 1, strategy: 'compact', budget })]
    .map((event, seq) => ({ ...event, seq }));
  const child = fold(events, { parentSession: 'parent' }, events.length);
  assert.equal(child.attempts, 0);
  assert.equal(child.maxAttempts, 2);
});
