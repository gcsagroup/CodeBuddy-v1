import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoalRequest } from '../goal-request.mjs';

test('goal controls require explicit structured intent and valid revision/budget', () => {
  assert.equal(parseGoalRequest(undefined), undefined);
  for (const value of ['pause', {}, null, { action: 'resume', goalId: 'g', revision: 0 }, { action: 'create', objective: ' ' }, { action: 'create', objective: 'x', maxGoalRounds: 0 }, { action: 'create', objective: 'x', maxGoalRounds: 1.5 }, { action: 'create', objective: 'x', maxGoalRounds: 1001 }]) assert.throws(() => parseGoalRequest(value));
  assert.deepEqual(parseGoalRequest({ action: 'create', objective: ' pause after verification ', maxGoalRounds: 5 }), { action: 'create', objective: 'pause after verification', maxGoalRounds: 5 });
  assert.deepEqual(parseGoalRequest({ action: 'resume', goalId: 'g', revision: 2 }), { action: 'resume', goalId: 'g', revision: 2 });
  assert.deepEqual(parseGoalRequest({ action: 'edit', goalId: 'g', revision: 2, objective: ' Revised ' }), { action: 'edit', goalId: 'g', revision: 2, objective: 'Revised' });
  assert.throws(() => parseGoalRequest({ action: 'edit', goalId: 'g', revision: 2, objective: '' }));
  assert.deepEqual(parseGoalRequest({ action: 'clear', goalId: 'g', revision: 2 }), { action: 'clear', goalId: 'g', revision: 2 });
});
