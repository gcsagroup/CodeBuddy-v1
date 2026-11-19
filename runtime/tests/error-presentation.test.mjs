import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFailure, publicRpcError } from '../error-presentation.mjs';
import { contextUpdates, publicErrorUpdate, recoveredCompactionUpdates } from '../context-updates.mjs';

const privateText = 'PRIVATE_BODY_KEY_COOKIE_PATH';
const unsafe = () => ({ message: privateText, body: privateText, headers: { authorization: privateText },
  url: `https://private.invalid/?token=${privateText}`, stack: `C:\\Users\\${privateText}\\work` });

test('vision failures keep actionable safe reasons in both terminal and RPC presentation', () => {
  for (const reason of ['vision_timeout', 'vision_not_configured', 'image_limit']) {
    const error = { ...unsafe(), code: -32602, data: { kind: 'vision_error', reason, imageCount: 9 } };
    const terminal = publicFailure(error), rpc = publicRpcError(error, 'session/prompt');
    assert.notEqual(terminal.code, 'UNKNOWN_FAILURE');
    assert.equal(rpc.message, terminal.message);
    assert.equal(JSON.stringify(rpc).includes(privateText), false);
    if (reason === 'image_limit') {
      assert.match(terminal.message, /9 张/);
      assert.match(terminal.message, /最多发送 8 张/);
      assert.match(terminal.message, /无需重新生成/);
    }
  }
});

test('only structured native/status/transport facts produce public advice; provider prose never escapes', () => {
  for (const [facts, pattern] of [
    [{ code: 'AUTH', status: 401 }, /身份验证/],
    [{ code: 'QUOTA', status: 429 }, /额度不足/],
    [{ code: 'RATE_LIMIT', status: 429 }, /请求受限/],
    [{ status: 503 }, /服务端错误/],
    [{ code: 'PI_AI_ERROR' }, /具体原因尚未确认/],
    [{ code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 }, /上下文放不下/],
    [{ code: 'TRANSPORT', cause: { code: 'ECONNREFUSED', ...unsafe() } }, /被拒绝/],
    [{ data: { code: 'custom_provider_invalid_credentials', httpStatus: 403, ...unsafe() } }, /拒绝访问/],
  ]) {
    const error = { ...unsafe(), ...facts }, before = structuredClone(error);
    const publicView = publicFailure(error);
    assert.match(publicView.message, pattern);
    assert.equal(JSON.stringify(publicView).includes(privateText), false);
    assert.deepEqual(error, before, 'presentation must not alter a failure used by retry/compaction');
  }
  assert.equal(publicFailure({ message: 'quota exceeded HTTP 429' }).code, 'UNKNOWN_FAILURE', 'prose is not a control/diagnostic fact');
});

test('structured compaction diagnostics survive live replay and durable recovery while malformed optional reports degrade', () => {
  const start = { sessionUpdate: 'status_message', status: { data: { event: 'compaction_lifecycle', operation_id: 'op', status: 'started' } } };
  const native = { type: 'compaction/end', data: { compactionId: 'op', error: { code: 'AUTH', status: 401, message: privateText } } };
  const [recovered] = recoveredCompactionUpdates([start], [native]);
  assert.deepEqual(recovered.status.data.diagnostic, { code: 'AUTH', httpStatus: 401 });
  assert.deepEqual(publicErrorUpdate(recovered), recovered);
  assert.equal(JSON.stringify(recovered).includes(privateText), false);
  for (const limitations of [undefined, null, 42, true, {}, 'legacy']) {
    const view = publicErrorUpdate({ sessionUpdate: 'status_message', status: { data: {
      terminal_message_id: 'terminal:x', status: 'failed', report: { limitations },
    } } });
    assert.equal(view.status.data.status, 'failed');
    assert.equal(view.status.data.report.limitations.length, 1);
  }
});

test('malformed and cyclic diagnostics cannot leak values or prevent error recovery', () => {
  const errors = [null, undefined, privateText, { code: privateText, status: privateText },
    { code: 'AUTH', status: 401.5, transportCodes: [privateText, 'ECONNRESET'] },
    Object.defineProperty({}, 'data', { get() { throw Error(privateText); } }),
    Object.defineProperty({}, 'code', { get() { throw Error(privateText); } }),
  ];
  const cyclic = { code: 'TRANSPORT' }; cyclic.cause = cyclic; errors.push(cyclic);
  for (const error of errors) {
    const result = publicRpcError(error, 'session/prompt');
    assert.equal(JSON.stringify(result).includes(privateText), false);
    assert.ok(result.data.diagnostic.code);
  }
  for (const observation of [null, { transportCodes: {} }, { transportCodes: privateText }])
    assert.equal(JSON.stringify(publicFailure({ code: 'TRANSPORT' }, observation)).includes(privateText), false);
});

test('model RPC failures keep existing safe discriminators and unrelated business errors keep their contract', () => {
  const result = publicRpcError({ code: -32602, message: privateText,
    data: { code: 'custom_provider_credentials_not_verified', httpStatus: 401, upstreamParam: privateText } }, 'session/set_config_option');
  assert.equal(result.code, -32602);
  assert.equal(result.data.code, 'custom_provider_credentials_not_verified');
  assert.equal(result.data.httpStatus, 401);
  assert.equal(JSON.stringify(result).includes(privateText), false);
  const vision = publicRpcError({ message: privateText, data: { kind: 'vision_error', reason: 'image_not_supported', payload: privateText } }, 'session/prompt');
  assert.equal(vision.data.reason, 'image_not_supported');
  assert.match(vision.message, /支持图片/);
  assert.equal(JSON.stringify(vision).includes(privateText), false);
  const business = { code: -32602, message: 'Workspace selection is required', data: { kind: 'workspace_confirmation' } };
  assert.deepEqual(publicRpcError(business, 'session/new'), business);
  const cancelled = publicRpcError({ message: privateText, data: { reason: 'recipe_params_cancelled' } }, 'session/prompt');
  assert.equal(cancelled.data.reason, 'recipe_params_cancelled');
  const busy = publicRpcError({ code: -32602, message: privateText, data: { code: 'SESSION_BUSY' } }, 'session/set_config_option');
  assert.equal(busy.data.code, 'SESSION_BUSY');
  assert.match(busy.message, /先停止本轮/);
  assert.doesNotMatch(busy.message, /检查.*连接|PRIVATE/);
});

test('live and historical compaction/failed terminal projections are safe, idempotent and non-mutating', () => {
  const emit = contextUpdates({ sessionId: 'isolated' });
  emit({ type: 'harness_event', sessionId: 'isolated', event: { type: 'compaction/start', time: 1000, data: { compactionId: 'test' } } });
  const [live] = emit({ type: 'harness_event', sessionId: 'isolated', event: { type: 'compaction/end', data: { compactionId: 'test', error: privateText } } });
  assert.equal(live.status.data.status, 'failed');
  assert.equal(JSON.stringify(live).includes(privateText), false);
  for (const data of [
    { event: 'compaction_lifecycle', status: 'failed', error: privateText },
    { event_type: 'run_failed', title: privateText, diagnostic: { code: 'AUTH', httpStatus: 401, payload: privateText } },
    { terminal_message_id: 'terminal:x', status: 'failed', retry_strategy: 'not_available', tool_action_count: 12,
      diagnostic: { code: 'AUTH', httpStatus: 401, payload: privateText }, report: { changed_files: ['result.txt'], limitations: [privateText,
        'Some tool effects still require inspection before retrying them.'] } },
  ]) {
    const update = { sessionUpdate: 'status_message', status: { message: privateText, data } };
    const before = structuredClone(update);
    const projected = publicErrorUpdate(update);
    assert.equal(JSON.stringify(projected).includes(privateText), false);
    assert.deepEqual(publicErrorUpdate(projected), projected);
    assert.deepEqual(update, before);
    if (data.tool_action_count) {
      assert.equal(projected.status.data.tool_action_count, 12);
      assert.equal(projected.status.data.retry_strategy, 'not_available');
      assert.deepEqual(projected.status.data.report.changed_files, ['result.txt']);
      assert.match(projected.status.data.report.limitations.at(-1), /inspection/);
    }
  }
});
