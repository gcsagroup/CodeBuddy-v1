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

test('tool argument streaming is reported as preparation, never tool execution or completion', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  const [update] = project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'first_tool_arguments' });
  assert.equal(update.status.data.phase, 'model');
  assert.equal(update.status.data.model_request_phase, 'receiving');
  assert.equal(update.status.message, '正在生成工具调用参数');
  assert.equal(project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'end' })[0].status.message, '');
  assert.deepEqual(project({ type: 'model_diagnostic', sessionId: 'child', phase: 'first_tool_arguments' }), []);
});

test('file input previews stay ephemeral, deduplicate size ticks and clear at native dispatch or attempt end', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  const event = { type: 'tool_input', sessionId: 'parent', preview: { id: 'w', name: 'write', kilobytes: 3 } };
  const [update] = project(event);
  assert.deepEqual(update.status.data.tool_input, event.preview);
  assert.equal(update.status.data.phase, 'model');
  assert.deepEqual(project(event), []);
  assert.deepEqual(project({ ...event, sessionId: 'child' }), []);
  assert.equal(project({ type: 'tool_call', sessionId: 'parent' })[0].status.data.tool_input, undefined);
  project(event);
  assert.equal(project({ type: 'assistant_end', sessionId: 'parent' })[0].status.data.tool_input, undefined);
});

test('unchanged preview metadata reports real incoming fragments at a bounded rate, never on its own', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const controller = new AbortController();
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run', signal: controller.signal });
  const event = { type: 'tool_input', sessionId: 'parent', preview: { id: 'w', name: 'write', kilobytes: 3 } };
  assert.equal(project(event).length, 1);
  t.mock.timers.tick(999);
  assert.deepEqual(project(event), []);
  t.mock.timers.tick(1);
  assert.equal(project(event).length, 1);
  t.mock.timers.tick(25_000);
  assert.deepEqual(project({ type: 'unrelated' }), []);
  assert.equal(project(event).length, 1);
  controller.abort();
  t.mock.timers.tick(1000);
  assert.deepEqual(project(event), []);
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

test('image observation stages share the existing activity channel and retain child and cancellation facts', () => {
  let runId = 'preparation'; const controller = new AbortController();
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: () => runId, signal: controller.signal });
  const start = project({ type: 'image_observation', sessionId: 'parent', phase: 'start', modelId: 'vision' });
  assert.match(start[0].status.message, /正在识别图片/);
  assert.equal(start[0].status.data.run_id, 'preparation');
  runId = 'native-run';
  project({ type: 'subagent_start', sessionId: 'parent', childSessionId: 'child' });
  const end = project({ type: 'image_observation', sessionId: 'parent', phase: 'end', modelId: 'vision' });
  assert.equal(end[0].status.data.child_count, 1);
  assert.equal(end[0].status.data.run_id, 'native-run');
  const model = project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'request_sent' });
  assert.equal(model[0].status.message, '');
  controller.abort();
  assert.deepEqual(project({ type: 'image_observation', sessionId: 'parent', phase: 'end', modelId: 'vision' }), []);
});

test('only native failure and retry facts announce reconnection, and final failures remain notices', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  const slow = project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'request_sent', elapsedMs: 900000 });
  assert.equal(slow[0].status.message, '', 'Slowness alone is not a failure');
  project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'end', failureCode: 'TRANSPORT', transportCodes: ['UND_ERR_SOCKET'], timings: [{ private: 'never publish' }] });
  const retry = project({ type: 'harness_event', sessionId: 'parent', event: { type: 'llm/retry', data: { retry: 1, maxRetries: 5, delayMs: 1500, failure: { code: 'TRANSPORT', message: 'PRIVATE_UPSTREAM_MESSAGE' } } } });
  assert.match(retry[0].status.message, /原因尚未确认/);
  assert.match(retry[0].status.message, /^正在重新连接（1\/5）/);
  assert.equal(retry[0].status.type, 'progress');
  assert.doesNotMatch(JSON.stringify(retry), /PRIVATE_UPSTREAM_MESSAGE|never publish|UND_ERR_SOCKET/);
  const restarted = project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'start' });
  assert.equal(restarted[0].status.message, '');
  project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'end', failureCode: 'AUTH', status: 401 });
  const failed = project({ type: 'harness_event', sessionId: 'parent', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'PRIVATE_AUTH_DETAIL' } } } } });
  assert.equal(failed[0].status.type, 'notice');
  assert.match(failed[0].status.message, /HTTP 401/);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_AUTH_DETAIL|重新连接/);
});

test('rate limits and unknown errors do not get invented network causes', () => {
  const project = workStatusUpdates({ sessionId: 'parent' });
  project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'end', status: 429 });
  const limited = project({ type: 'harness_event', sessionId: 'parent', event: { type: 'llm/retry', data: { retry: 1, delayMs: 0, failure: { code: 'RATE_LIMIT' } } } });
  assert.match(limited[0].status.message, /^正在重试模型请求（第 1 次）.*HTTP 429/);
  assert.doesNotMatch(limited[0].status.message, /重新连接|额度不足/);
  project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'start' });
  const unknown = project({ type: 'harness_event', sessionId: 'parent', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'UNRECOGNIZED' } } } } });
  assert.equal(unknown[0].status.message, '请求失败，具体原因尚未确认');
});

test('child retries clear on that worker recovery without clearing another worker backoff', () => {
  const project = workStatusUpdates({ sessionId: 'parent' });
  const native = (sessionId, type, data) => project({ type: 'harness_event', sessionId, event: { type, data } });
  const diagnostic = (sessionId, phase) => project({ type: 'model_diagnostic', sessionId, phase, status: 200 });
  native('first', 'turn/start');
  native('second', 'turn/start');
  const retry = { retry: 1, maxRetries: 5, delayMs: 1000, failure: { code: 'TRANSPORT' } };
  assert.match(native('first', 'llm/retry', retry)[0].status.message, /子任务.*重新连接/);
  assert.deepEqual(diagnostic('second', 'start'), [], 'Unrelated worker activity cannot hide a pending retry');
  const recovered = diagnostic('first', 'start')[0];
  assert.equal(recovered.status.message, '');
  assert.equal(recovered.status.data.phase, 'children');
  assert.deepEqual(diagnostic('first', 'response_headers'), []);
  assert.deepEqual(project({ type: 'text_delta', sessionId: 'first', text: 'private child output' }), []);
  native('first', 'llm/retry', retry);
  native('second', 'llm/retry', { ...retry, retry: 2 });
  assert.deepEqual(native('first', 'llm/retry-started'), [], 'The other worker retry stays visible');
  assert.equal(native('second', 'llm/retry-started')[0].status.message, '');
});
