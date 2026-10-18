import test from 'node:test';
import assert from 'node:assert/strict';
import { workStatusUpdates } from '../work-status.mjs';

test('model transport publishes bounded public waiting phases without diagnostic internals', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  for (const [phase, expected] of [['start','preparing'], ['request_created','connecting'], ['request_sent','waiting'], ['response_headers','receiving']]) {
    const [update] = project({ type: 'model_diagnostic', sessionId: 'parent', phase, status: 200, timings: [{ private: 'diagnostic' }], requestId: 'internal-request' });
    assert.equal(update.status.data.model_request_phase, expected);
    assert.equal(update.status.data.phase, 'model');
    assert.doesNotMatch(JSON.stringify(update), /diagnostic|internal-request|timings/);
  }
  assert.equal(project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'response_headers', status: 401 })[0].status.data.model_request_phase, undefined);
  project({ type: 'subagent_start', sessionId: 'parent', childSessionId: 'child' });
  assert.equal(project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'request_sent' })[0].status.data.phase, 'children');
});

test('live child work has a specific wait target without exposing child receipts', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  const waiting = project({ type: 'subagent_start', sessionId: 'parent', childSessionId: 'child' });
  assert.equal(waiting[0].status.data.phase, 'children');
  assert.equal(waiting[0].status.data.child_count, 1);
  assert.equal(waiting[0].status.data.source_user_message_id, 'input');
  assert.deepEqual(project({ type: 'tool_result', sessionId: 'child', result: 'private receipt' }), []);
  assert.equal(JSON.stringify(waiting).includes('private receipt'), false);
  assert.equal(project({ type: 'subagent_end', childSessionId: 'child' })[0].status.data.phase, 'child_result');
  assert.equal(project({ type: 'assistant_start', sessionId: 'parent' })[0].status.data.phase, 'model');
});

test('reused child turns and multiple workers keep the wait accurate', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  const turn = (id, type) => project({ type: 'harness_event', sessionId: id, event: { type } });
  assert.equal(turn('reused', 'turn/start')[0].status.data.child_count, 1);
  assert.equal(turn('second', 'turn/start')[0].status.data.child_count, 2);
  assert.equal(turn('reused', 'turn/end')[0].status.data.child_count, 1);
  assert.equal(turn('second', 'turn/end')[0].status.data.phase, 'child_result');
  assert.deepEqual(turn('second', 'turn/end'), []);
});

test('cancelled requests cannot publish late activity or execution conclusions', () => {
  const controller = new AbortController();
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run', signal: controller.signal });
  controller.abort();
  assert.deepEqual(project({ type: 'subagent_start', sessionId: 'parent', childSessionId: 'late' }), []);
});
