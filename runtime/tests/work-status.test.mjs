import test from 'node:test';
import assert from 'node:assert/strict';
import { workStatusUpdates } from '../work-status.mjs';

test('advice counts real parent failures including process exits without promoting them to a verdict', () => {
  const project = workStatusUpdates({ sessionId: 'root' });
  const result = (id, extra = {}) => project({ type: 'tool_result', sessionId: 'root', id, ...extra })[0]?.status.data;
  assert.equal(result('a', { isError: true }).consecutive_tool_failures, 1);
  project({ type: 'tool_result', sessionId: 'child', id: 'child', isError: true });
  assert.equal(result('b', { isError: false, executionFailed: true }).consecutive_tool_failures, 2);
  assert.equal(result('c', { isError: true }).consecutive_tool_failures, 3);
  assert.equal(result('ok', { isError: false, executionFailed: false }).consecutive_tool_failures, 0);
  assert.equal(result('next', { isError: true }).consecutive_tool_failures, 1);
  assert.equal(workStatusUpdates({ sessionId: 'root' })({ type: 'tool_result', sessionId: 'root', id: 'new', isError: true })[0].status.data.consecutive_tool_failures, 1);
});

test('response retry advice excludes HTTP and transport failures, and successful tools reset it', () => {
  const project = workStatusUpdates({ sessionId: 'root' });
  const retry = code => project({ type: 'harness_event', sessionId: 'root', event: { type: 'llm/retry', data: { failure: { code } } } })[0].status.data.response_retries;
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', status: 200 });
  assert.equal(retry('SERVER'), 1);
  assert.equal(retry('EMPTY_RESPONSE'), 2);
  assert.equal(retry('OUTPUT_TRUNCATED'), 3);
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', status: 503 });
  assert.equal(retry('SERVER'), 0);
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', status: 200, transportCodes: ['ECONNRESET'] });
  assert.equal(retry('EMPTY_RESPONSE'), 0);
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'start' });
  assert.equal(retry('EMPTY_RESPONSE'), 1);
  const [success] = project({ type: 'tool_result', sessionId: 'root', id: 'ok', isError: false });
  assert.equal(success.status.data.response_retries, 0);
});

test('model generation clock survives fragments and clears when tools actually start', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const project = workStatusUpdates({ sessionId: 'root' });
  const send = event => project({ sessionId: 'root', ...event })[0]?.status.data;
  assert.equal(send({ type: 'model_diagnostic', phase: 'start' }).model_request_started_at, 100_000);
  t.mock.timers.tick(190_000);
  assert.equal(send({ type: 'model_diagnostic', phase: 'first_reasoning' }).model_request_started_at, 100_000);
  assert.equal(send({ type: 'tool_call', id: 'run' }).model_request_started_at, undefined);
  send({ type: 'model_diagnostic', sessionId: 'child', phase: 'start' });
  send({ type: 'model_diagnostic', phase: 'start', purpose: 'compaction' });
  const second = send({ type: 'model_diagnostic', phase: 'start' });
  assert.equal(second.model_request_started_at, 290_000);
  assert.equal(second.model_request_number, 2);
  assert.equal(send({ type: 'model_diagnostic', phase: 'end' }).model_request_started_at, undefined);
});

test('length and context failures retain their cause and child recovery is scoped', () => {
  for (const [code, text] of [['OUTPUT_LIMIT_REACHED', '输出长度限制'], ['OUTPUT_TRUNCATED', '提前截断'], ['LOCAL_OUTPUT_BUDGET_EXHAUSTED', '上下文']]) {
    const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
    const updates = project({ type: 'harness_event', sessionId: 'parent', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { code } } } } });
    assert.ok(updates[0].status.message.includes(text));
    assert.doesNotMatch(updates[0].status.message, /原因尚未确认/);
  }
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  assert.match(project({ type: 'output_recovery', sessionId: 'child' })[0].status.message, /^子任务：/);
});

test('output recovery progress consumes the host count and limit, including legacy limits', () => {
  for (const limit of [1, 2]) {
    const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
    const update = project({ type: 'output_recovery', sessionId: 'parent', attempt: limit, maxAutomaticAttempts: limit });
    assert.match(update[0].status.message, new RegExp(`\\(${limit}/${limit}\\)|（${limit}/${limit}）`));
  }
});

test('native activity reconciles missing call results while preserving parallel calls and ignoring children', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  const active = event => project({ sessionId: 'parent', ...event })[0]?.status.data.active_tool_call_ids;
  assert.deepEqual(active({ type: 'tool_call', id: 'a' }), ['a']);
  assert.deepEqual(active({ type: 'tool_call', id: 'b' }), ['a', 'b']);
  assert.deepEqual(active({ type: 'tool_result', id: 'a', isError: true }), ['b']);
  assert.deepEqual(project({ type: 'assistant_start', sessionId: 'child' }), []);
  assert.deepEqual(active({ type: 'tool_call', id: 'c' }), ['b', 'c']);
  // The next native model stream starts after all calls have settled, even
  // when an individual result notification was lost by a downstream consumer.
  assert.deepEqual(active({ type: 'assistant_start' }), []);
  assert.deepEqual(active({ type: 'tool_call', id: 'd' }), ['d']);
  assert.deepEqual(active({ type: 'tool_result', id: 'a' }), ['d']);
});

test('model transport publishes bounded public waiting phases without diagnostic internals', () => {
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
  for (const [phase, expected] of [['start','preparing'], ['request_created','connecting'], ['request_sent','waiting']]) {
    const [update] = project({ type: 'model_diagnostic', sessionId: 'parent', phase, status: 200, timings: [{ private: 'diagnostic' }], requestId: 'internal-request' });
    assert.equal(update.status.data.model_request_phase, expected);
    assert.equal(update.status.data.phase, 'model');
    assert.equal(update.status.message, '');
    if (phase === 'start') {
      for (const purpose of [undefined, 'compaction']) {
        assert.deepEqual(project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'request_budget',
          purpose, source: 'pi-ai-estimate-context-tokens', input: 29047, output: 32768, window: 512000 }), []);
      }
    }
    assert.doesNotMatch(JSON.stringify(update), /diagnostic|internal-request|timings/);
  }
  assert.deepEqual(project({ type: 'model_diagnostic', sessionId: 'parent', requestId: 'internal-request', phase: 'response_headers', status: 200 }), [], 'headers alone must not change the waiting label or restart its clock');
  assert.equal(project({ type: 'model_diagnostic', sessionId: 'parent', requestId: 'internal-request', phase: 'response_headers', status: 401 })[0].status.data.model_request_phase, undefined);
  project({ type: 'subagent_start', sessionId: 'parent', childSessionId: 'child' });
  assert.equal(project({ type: 'model_diagnostic', sessionId: 'parent', requestId: 'internal-request', phase: 'request_sent' })[0].status.data.phase, 'children');
});

test('only actual model content ends waiting after successful response headers', () => {
  for (const phase of ['first_tool_arguments', 'first_text', 'first_reasoning']) {
    const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: 'run' });
    assert.equal(project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'response_headers', status: 200 })[0].status.data.model_request_phase, 'waiting');
    assert.equal(project({ type: 'model_diagnostic', sessionId: 'parent', phase })[0].status.data.model_request_phase, 'receiving');
  }
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

test('request errors give provider-neutral configuration guidance without leaking upstream messages', () => {
  for (const status of [400, 404, 422]) {
    const project = workStatusUpdates({ sessionId: 'parent' });
    project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'end', status });
    const [result] = project({ type: 'harness_event', sessionId: 'parent', event: {
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', message: 'PRIVATE_TOKEN' } } },
    } });
    assert.match(result.status.message, new RegExp(`HTTP ${status}`));
    assert.match(result.status.message, /API 基础路径/);
    assert.doesNotMatch(result.status.message, /PRIVATE_TOKEN|OpenAI|原因尚未确认/);
  }
});

test('image observation stages share the existing activity channel and retain child and cancellation facts', () => {
  let runId = 'preparation'; const controller = new AbortController();
  const project = workStatusUpdates({ sessionId: 'parent', sourceMessageId: 'input', runId: () => runId, signal: controller.signal });
  const start = project({ type: 'image_observation', sessionId: 'parent', phase: 'start', modelId: 'vision' });
  assert.match(start[0].status.message, /正在识别图片/);
  assert.equal(start[0].status.message.includes('vision'), false);
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

test('reasoning-only recovery reports received content and only announces a stop at native termination', () => {
  const project = workStatusUpdates({ sessionId: 'parent' });
  const diagnostic = (sessionId, phase, extra = {}) => project({ type: 'model_diagnostic', sessionId, phase, ...extra });
  const native = (type, data) => project({ type: 'harness_event', sessionId: 'parent', event: { type, data } });
  const failure = { code: 'EMPTY_RESPONSE', message: 'PRIVATE_MODEL_OUTPUT' };
  const counts = { status: 200, reasoningDeltaChars: 517, textDeltaChars: 0, toolCallBlocks: 0 };
  diagnostic('parent', 'end', counts);
  const retry = native('llm/retry', { retry: 1, maxRetries: 5, failure })[0].status;
  assert.equal(retry.type, 'progress');
  assert.match(retry.message, /正在重试模型请求（1\/5）.*只返回了思考内容/);
  assert.doesNotMatch(retry.message, /本轮已停止|测试失败|PRIVATE_MODEL_OUTPUT/);
  diagnostic('child', 'end', { ...counts, textDeltaChars: 100 });
  const terminal = native('turn/end', { reason: { kind: 'error', error: failure } })[0].status;
  assert.equal(terminal.type, 'notice');
  assert.match(terminal.message, /只返回了思考内容.*本轮已停止.*切换模型/);
  assert.doesNotMatch(JSON.stringify(terminal), /PRIVATE_MODEL_OUTPUT|DeltaChars|517|测试失败/);
  diagnostic('parent', 'start');
  const later = native('turn/end', { reason: { kind: 'error', error: failure } })[0].status;
  assert.doesNotMatch(later.message, /只返回了思考内容/, 'Do not reuse a prior attempt observation');
});

test('empty response wording never infers reasoning-only output from missing or contrary observations', () => {
  for (const observation of [
    {},
    { reasoningDeltaChars: 0, textDeltaChars: 0, toolCallBlocks: 0 },
    { reasoningDeltaChars: 100 },
    { reasoningDeltaChars: 100, textDeltaChars: 10, toolCallBlocks: 0 },
    { reasoningDeltaChars: 100, textDeltaChars: 0, toolCallBlocks: 1 },
    { reasoningDeltaChars: 100, textDeltaChars: 0, toolCallBlocks: 0, cancelled: true },
  ]) {
    const project = workStatusUpdates({ sessionId: 'parent' });
    project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'end', ...observation });
    const [result] = project({ type: 'harness_event', sessionId: 'parent', event: {
      type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'EMPTY_RESPONSE' } } },
    } });
    assert.doesNotMatch(result.status.message, /只返回了思考内容/);
    assert.match(result.status.message, /没有返回正文或有效工具调用/);
  }
});

test('rate limits and unknown errors do not get invented network causes', () => {
  const project = workStatusUpdates({ sessionId: 'parent' });
  project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'end', status: 429 });
  const limited = project({ type: 'harness_event', sessionId: 'parent', event: { type: 'llm/retry', data: { retry: 1, delayMs: 0, failure: { code: 'RATE_LIMIT' } } } });
  assert.match(limited[0].status.message, /^正在重试模型请求（第 1 次）.*HTTP 429/);
  assert.doesNotMatch(limited[0].status.message, /重新连接|额度不足/);
  project({ type: 'model_diagnostic', sessionId: 'parent', phase: 'start' });
  const unknown = project({ type: 'harness_event', sessionId: 'parent', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'UNRECOGNIZED' } } } } });
  assert.match(unknown[0].status.message, /具体原因尚未确认/);
  assert.doesNotMatch(unknown[0].status.message, /网络|额度不足|身份验证/);
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

test('a structured context overflow takes precedence over the observed HTTP 400', () => {
  const project = workStatusUpdates({ sessionId: 'root' });
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', status: 400 });
  const [notice] = project({ type: 'harness_event', sessionId: 'root', event: {
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } },
  } });
  assert.match(notice.status.message, /上下文/);
  assert.doesNotMatch(notice.status.message, /API 基础路径/);
});

test('known quota and generation failures cannot be relabeled by a generic HTTP status', () => {
  for (const [code, status, expected] of [
    ['QUOTA', 429, /额度不足/], ['ACCOUNT_QUOTA', 400, /额度不足/],
    ['OUTPUT_LIMIT_REACHED', 429, /输出长度限制/],
  ]) {
    const project = workStatusUpdates({ sessionId: 'root' });
    project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', status });
    const [notice] = project({ type: 'harness_event', sessionId: 'root', event: {
      type: 'turn/end', data: { reason: { kind: 'error', error: { code } } },
    } });
    assert.match(notice.status.message, expected);
    assert.doesNotMatch(notice.status.message, /请求参数|请求受限/);
  }
});

test('unknown errors give a bounded recovery path without echoing upstream data or guessing a cause', () => {
  for (const status of [200, 402, 409, undefined]) for (const code of ['PI_AI_ERROR', 'constructor']) {
    const project = workStatusUpdates({ sessionId: 'root' });
    project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', status });
    const [notice] = project({ type: 'harness_event', sessionId: 'root', event: {
      type: 'turn/end', data: { reason: { kind: 'error', error: { code, message: 'PRIVATE_KEY https://private.invalid/?token=secret' } } },
    } });
    assert.equal(typeof notice.status.message, 'string');
    assert.match(notice.status.message, /本轮已停止/);
    assert.match(notice.status.message, /查看未完成原因/);
    if (status >= 400) assert.match(notice.status.message, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(notice.status.message, /PRIVATE|private.invalid|token=secret|Function|Object|已保存|已回滚/);
  }
});

test('auxiliary requests never overwrite the main error, waiting clock or native retry message', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const project = workStatusUpdates({ sessionId: 'root' });
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'start', requestId: 'main' });
  t.mock.timers.tick(1000);
  for (const phase of ['start', 'end']) assert.deepEqual(project({ type: 'model_diagnostic', sessionId: 'root',
    requestId: 'summary', purpose: 'compaction', phase, status: 401, failureCode: 'AUTH' }), []);
  const waiting = project({ type: 'model_diagnostic', sessionId: 'root', requestId: 'main', phase: 'request_sent' });
  assert.equal(waiting[0].status.data.model_request_started_at, 100_000);
  project({ type: 'model_diagnostic', sessionId: 'root', requestId: 'main', phase: 'end', status: 429, failureCode: 'RATE_LIMIT' });
  const retry = { type: 'harness_event', sessionId: 'root', event: { type: 'llm/retry', data: { retry: 1, maxRetries: 5, delayMs: 1000, failure: { code: 'RATE_LIMIT' } } } };
  assert.match(project(retry)[0].status.message, /HTTP 429/);
  assert.deepEqual(project({ type: 'model_diagnostic', sessionId: 'root', requestId: 'judge', purpose: 'execution-report', phase: 'start' }), []);
  const [notice] = project({ type: 'harness_event', sessionId: 'root', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } } } });
  assert.match(notice.status.message, /HTTP 429/);
  assert.doesNotMatch(notice.status.message, /身份验证/);
});

test('late requests and mismatched failures cannot lend a stale HTTP cause to another attempt', () => {
  const project = workStatusUpdates({ sessionId: 'root' });
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'start', requestId: 'old' });
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'start', requestId: 'current' });
  assert.deepEqual(project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', requestId: 'old', status: 401, failureCode: 'AUTH' }), []);
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', requestId: 'current', status: 503, failureCode: 'SERVER' });
  const [notice] = project({ type: 'harness_event', sessionId: 'root', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'NO_ADAPTER' } } } } });
  assert.match(notice.status.message, /连接配置/);
  assert.doesNotMatch(notice.status.message, /HTTP 503|HTTP 401|服务返回错误/);
});

test('the terminal receipt cannot reuse HTTP headers from an earlier transport attempt', () => {
  const failures = [];
  const project = workStatusUpdates({
    sessionId: 'root',
    onTerminalHttpFailure: (code, status) => failures.push([code, status]),
  });
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'start', requestId: 'retry' });
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', requestId: 'retry',
    status: 503, failureCode: 'TRANSPORT', finishKind: 'error', timings: [{ status: 503 }, {}] });
  project({ type: 'harness_event', sessionId: 'root', event: {
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } },
  } });
  assert.deepEqual(failures, []);
});

test('a successful model response does not relabel a later host failure as a model or HTTP failure', () => {
  const project = workStatusUpdates({ sessionId: 'root' });
  project({ type: 'model_diagnostic', sessionId: 'root', requestId: 'done', phase: 'start' });
  project({ type: 'model_diagnostic', sessionId: 'root', requestId: 'done', phase: 'end', status: 200, finishKind: 'stop', textDeltaChars: 40 });
  const [notice] = project({ type: 'harness_event', sessionId: 'root', event: {
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'EACCES', message: 'PRIVATE_HOST_ERROR' } } },
  } });
  assert.match(notice.status.message, /具体原因尚未确认.*本轮已停止/);
  assert.doesNotMatch(notice.status.message, /模型服务|HTTP|响应未能|PRIVATE/);
});

test('payload limits have a concrete remedy without inventing a token overflow or changing retry facts', () => {
  const project = workStatusUpdates({ sessionId: 'root' });
  project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', status: 413, failureCode: 'INVALID_REQUEST', finishKind: 'error' });
  const [notice] = project({ type: 'harness_event', sessionId: 'root', event: {
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST' } } },
  } });
  assert.match(notice.status.message, /请求体过大.*HTTP 413/);
  assert.match(notice.status.message, /图片|附件/);
  assert.doesNotMatch(notice.status.message, /上下文放不下|API 基础路径|正在重试/);
  assert.equal(notice.status.data.response_retries, 0);
});

test('retry presentation survives absent or changing caps without inventing an attempt budget or a stop', () => {
  const project = workStatusUpdates({ sessionId: 'root' });
  for (const data of [{ retry: 3, maxRetries: 2, delayMs: 0 }, { retry: 1, delayMs: 1500 }, { retry: 4, maxRetries: 5, delayMs: Infinity }]) {
    const [update] = project({ type: 'harness_event', sessionId: 'root', event: { type: 'llm/retry', data: { ...data, failure: { code: 'RATE_LIMIT' } } } });
    assert.equal(update.status.type, 'progress');
    assert.doesNotMatch(update.status.message, /3\/2|undefined|Infinity|本轮已停止|查看未完成原因/);
    if (data.delayMs === 1500) assert.match(update.status.message, /约 2 秒后/);
    if (data.retry === 4) assert.match(update.status.message, /4\/5/);
  }
});

test('invalid status metadata and provider prose cannot invent an HTTP, quota or rate-limit verdict', () => {
  for (const status of [0, '429', 'PRIVATE_TOKEN', NaN, Infinity, 200.5, 600]) {
    const project = workStatusUpdates({ sessionId: 'root' });
    const failure = Object.freeze({ code: 'PI_AI_ERROR', status, message: 'request-id=429-503; insufficient_quota; PRIVATE_TOKEN' });
    const event = Object.freeze({ type: 'harness_event', sessionId: 'root', event: Object.freeze({ type: 'turn/end', data: Object.freeze({ reason: Object.freeze({ kind: 'error', error: failure }) }) }) });
    const [notice] = project(event);
    assert.match(notice.status.message, /具体原因尚未确认/);
    assert.doesNotMatch(notice.status.message, /HTTP|PRIVATE_TOKEN|额度不足|请求受限|429|503/);
    assert.equal(failure.status, status);
  }
});

test('native status takes precedence, and TLS and mid-stream failures stay separate from account errors', () => {
  for (const [failure, observation, expected] of [
    [{ code: 'PI_AI_ERROR', status: 402 }, { status: 500 }, /付费状态.*HTTP 402/],
    [{ code: 'TRANSPORT' }, { transportCodes: ['ERR_TLS_CERT_ALTNAME_INVALID'], finishKind: 'error' }, /TLS 证书验证失败/],
    [{ code: 'TRANSPORT' }, { status: 200, transportCodes: ['ECONNRESET'], finishKind: 'error' }, /连接发生错误.*原因尚未确认/],
    [{ code: 'SERVER' }, { status: 529, finishKind: 'error' }, /服务端错误.*HTTP 529/],
    [{ code: 'QUOTA' }, { status: 200, failureCode: 'QUOTA', finishKind: 'error' }, /额度不足/],
  ]) {
    const project = workStatusUpdates({ sessionId: 'root' });
    project({ type: 'model_diagnostic', sessionId: 'root', phase: 'end', ...observation });
    const [notice] = project({ type: 'harness_event', sessionId: 'root', event: { type: 'turn/end', data: { reason: { kind: 'error', error: failure } } } });
    assert.match(notice.status.message, expected);
    assert.doesNotMatch(notice.status.message, /关闭证书|已回滚|已保存|你的网络/);
  }
});
