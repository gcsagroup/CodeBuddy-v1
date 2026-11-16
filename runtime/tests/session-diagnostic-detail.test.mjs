import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionLogDiagnostics } from '../session-log-diagnostics.mjs';

const encode = rows => rows.map(JSON.stringify).join('\n');
const decode = text => text.trim().split('\n').map(JSON.parse);
const sample = () => [
  { type: 'session', id: 'private-session', cwd: 'C:/Users/private-name/private-project', version: 4 },
  { type: 'request/header', seq: 0, time: 1000, data: { reason: 'initial', header: {
    config: { provider: 'private-provider', model: 'private-model-a', maxTokens: 32768, reasoningEffort: 'high',
      apiKey: 'SYNTHETIC-SECRET-KEY' }, adapterDefaults: { maxTokens: true },
    tools: [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string', description: 'PRIVATE_DESCRIPTION' } } } }],
  } } },
  { type: 'request/context', seq: 1, time: 1010, data: { provider: 'private-provider', model: 'private-model-b', contextWindow: 65536 } },
  { type: 'tool/call', seq: 2, time: 1020, data: { callId: 'private-call', name: 'read', arguments: { path: 'C:/Users/private-name/private-project/key.txt' } } },
  { type: 'tool/result', seq: 3, time: 1030, data: { message: { toolCallId: 'private-call', isError: true,
    content: [{ type: 'text', text: 'ENOENT C:/Users/private-name/private-project/key.txt api_key=SYNTHETIC-SECRET-KEY alice@example.test' }] } } },
  { type: 'request/header', seq: 4, time: 1040, data: { header: { config: { provider: 'private-provider', model: 'private-model-b' } } } },
  { type: 'assistant/attempt', seq: 5, time: 1050, data: { turn: 2, step: 1, stream: [
    { type: 'reasoning-chunks', texts: ['PRIVATE_REASONING'], dt: [0] },
    { type: 'text-chunks', texts: ['PRIVATE_CONVERSATION'], dt: [1] },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 200000, outputTokens: 4096, reasoningTokens: 4096 } } },
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', status: 400,
      message: 'Unsupported tools parameter; Bearer SYNTHETIC-SECRET-KEY', requestId: 'private-request' } }, replayState: { secret: 'PRIVATE_REPLAY' } } },
  ] } },
  { type: 'compaction/start', seq: 6, time: 1060, data: { compactionId: 'private-compaction', turn: null } },
  { type: 'compaction/summary', seq: 7, time: 1070, data: { compactionId: 'private-compaction', provider: 'private-provider', model: 'private-model-a',
    maxTokens: 4096, shadowedRange: { start: 9, end: 3 }, shadowedSeqs: [1, 2, 3], shadowedTokenCount: 200000,
    summary: [{ type: 'text', text: 'PRIVATE_SUMMARY' }], rawOutput: [{ type: 'text', text: 'PRIVATE_RAW_OUTPUT' }],
    usage: { inputTokens: 200000, outputTokens: 4096 } } },
  { type: 'compaction/end', seq: 8, time: 1080, data: { compactionId: 'private-compaction', turn: null,
    error: 'summarization truncated at the token cap; api_key=SYNTHETIC-SECRET-KEY C:/Users/private-name/private-project/key.txt' } },
];

test('standard diagnostics retain routing, request declarations, compaction budgets and stream failures without private values', () => {
  const rows = sample(), original = encode(rows), text = sessionLogDiagnostics(original);
  const out = decode(text), data = out.slice(1).map(row => row.data);
  assert.equal(out[0].revision, 'codebuddy-log-v3');
  assert.equal(out[0].detail, 'standard'); assert.equal(out[0].restorable, false);
  assert.deepEqual(out.slice(1).map(row => row.seq), rows.slice(1).map(row => row.seq));
  assert.equal(data[0].request.source, 'native_header');
  assert.equal(data[0].request.config.maxTokens, 32768);
  assert.equal(data[0].request.adapterDefaults.maxTokens, true);
  assert.equal(data[0].request.config.adapterDefaults, undefined);
  assert.equal(data[0].request.config.provider, data[1].route.provider);
  assert.notEqual(data[0].request.config.model, data[1].route.model);
  assert.equal(data[1].contextWindow, 65536);
  assert.equal(data[4].request.tools.count, 0);
  assert.equal(data[4].request.tools.present, false);
  assert.equal(data[4].request.wirePayload, 'not_recorded');
  assert.equal(data[2].callId, data[3].callId);
  assert.equal(data[2].name, 'read');
  assert.equal(data[5].stream.usage[0].source, 'stream');
  assert.equal(data[5].stream.usage[0].reasoningTokens, 4096);
  assert.equal(data[5].stream.finishes[0].diagnostic.httpStatus, 400);
  assert.equal(data[7].maxTokens, 4096);
  assert.deepEqual(data[7].shadowedRange, { start: 9, end: 3 });
  assert.equal(data[7].usage.source, 'compaction/summary');
  assert.equal(data[6].compactionId, data[8].compactionId); assert.equal(data[6].turn, null);
  assert.equal(data[8].diagnostic.code, 'UNKNOWN_FAILURE');
  assert.doesNotMatch(text, /private-name|private-project|PRIVATE_|SYNTHETIC-SECRET|example\.test|Users/);
  assert.equal(data[0].request.config.model, 'private-model-a');
  assert.equal(data[2].callId, 'private-call');
  assert.equal(encode(rows), original);
});

test('detailed diagnostics scrub credentials and identifiers before exposing bounded technical excerpts', () => {
  const original = encode(sample());
  const text = sessionLogDiagnostics(original, { detail: 'detailed' });
  const out = decode(text), data = out.slice(1).map(row => row.data);
  assert.equal(out[0].containsTextExcerpts, true);
  assert.match(data[3].details.output, /ENOENT/);
  assert.match(data[8].error.message, /summarization truncated at the token cap/);
  assert.match(data[5].stream.finishes[0].error.message, /Unsupported tools parameter/);
  assert.doesNotMatch(text, /private-name|private-project|PRIVATE_|SYNTHETIC-SECRET|example\.test|Users/);
  assert.equal(encode(sample()), original);
});

test('missing historical facts stay unrecorded and arbitrary payloads do not become structured diagnoses', () => {
  const rows = [{ type: 'session' }, { type: 'compaction/end', seq: 0, data: { error: 'HTTP 401 private-model-a max_tokens=4096' } }];
  const out = decode(sessionLogDiagnostics(encode(rows)));
  assert.equal(out[1].data.diagnostic.code, 'UNKNOWN_FAILURE');
  assert.equal(out[1].data.route, undefined); assert.equal(out[1].data.maxTokens, undefined);
  assert.equal(out[1].data.diagnostic.httpStatus, undefined);
  for (const value of ['raw', '', true, null]) assert.throws(() => sessionLogDiagnostics(encode(rows), { detail: value }));
});

test('detailed output is bounded, explicit about truncation and never includes conversation or reasoning text', () => {
  const rows = sample(); rows[4].data.message.content[0].text = 'ENOENT '.repeat(100000);
  const out = decode(sessionLogDiagnostics(encode(rows), { detail: 'detailed' }));
  assert.equal(out.length, rows.length);
  assert.ok(out[4].data.details.output.length <= 4096);
  assert.equal(out[4].data.details.truncated, true);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_REASONING|PRIVATE_CONVERSATION|PRIVATE_SUMMARY|PRIVATE_RAW_OUTPUT/);
});

test('known credentials split across tool text blocks are removed and incomplete scans omit excerpts', () => {
  const rows = sample();
  rows[4].data.message.content = [{ type: 'text', text: 'SYNTHETIC-' }, { type: 'text', text: 'SECRET-KEY' }];
  const result = sessionLogDiagnostics(encode(rows), { detail: 'detailed' });
  assert.doesNotMatch(result.replace(/\\n/g, ''), /SYNTHETIC-SECRET-KEY/);
  assert.doesNotMatch(decode(result)[4].data.details.output, /SYNTHETIC|SECRET-KEY/);
  let nested = { apiKey: 'DeepCredential123' };
  for (let i = 0; i < 40; i++) nested = { nested };
  rows[0].extra = nested;
  rows[9].data.error = 'An error echoed DeepCredential123';
  const limited = decode(sessionLogDiagnostics(encode(rows), { detail: 'detailed' }));
  assert.doesNotMatch(JSON.stringify(limited), /DeepCredential123/);
  assert.equal(limited[9].data.error.truncated, true);
});

test('arbitrary authentication header values echoed without field names remain private', () => {
  const rows = sample();
  rows[0].extra = { headers: { 'x-api-key': 'PrivateHeaderKey123', 'x-company-auth': 'PrivateCustomAuth456' } };
  rows[9].data.error = 'Provider rejected PrivateHeaderKey123 and PrivateCustomAuth456';
  const text = sessionLogDiagnostics(encode(rows), { detail: 'detailed' });
  assert.doesNotMatch(text, /PrivateHeaderKey123|PrivateCustomAuth456/);
});

test('earlier tool output cannot consume the excerpt budget of the final compaction failure', () => {
  const rows = [{ type: 'session' }];
  for (let i = 0; i < 5; i++) rows.push({ type: 'tool/result', seq: i, data: { message: {
    content: [{ type: 'text', text: 'normal output '.repeat(2000) }], isError: false,
  } } });
  rows.push({ type: 'compaction/end', seq: 5, data: { error: 'summarization truncated at the token cap (incomplete checkpoint)' } });
  const out = decode(sessionLogDiagnostics(encode(rows), { detail: 'detailed' }));
  assert.match(out.at(-1).data.error.message, /summarization truncated/);
  assert.deepEqual(out.slice(1).map(row => row.seq), [0, 1, 2, 3, 4, 5]);
});

test('overlapping known credentials are removed together without exposing a suffix', () => {
  const rows = sample();
  rows[0].auth = { password: 'PrefixSecret', apiKey: 'PrefixSecretLongSuffix123' };
  rows[9].data.error = 'Rejected PrefixSecretLongSuffix123';
  const out = sessionLogDiagnostics(encode(rows), { detail: 'detailed' });
  assert.doesNotMatch(out, /PrefixSecret|LongSuffix123/);
});

test('signed Windows process status is preserved without accepting negative token counts', () => {
  const rows = [{ type: 'session' }, { type: 'tool/result', data: { exitCode: -1073741502, inputTokens: -1 } }];
  const out = decode(sessionLogDiagnostics(encode(rows)));
  assert.equal(out[1].data.exitCode, -1073741502); assert.equal(out[1].data.inputTokens, undefined);
});

test('terminal formatting cannot reconstruct a known credential after scrubbing', () => {
  for (const separator of ['\u001b[31m', '\u0000', '\u200c', '\u200d', '\u2060', '\u202e', '\u{e0001}']) {
    const rows = sample();
    rows[9].data.error = 'SYNTHETIC-' + separator + 'SECRET-KEY';
    const out = sessionLogDiagnostics(encode(rows), { detail: 'detailed' });
    assert.doesNotMatch(out, /SYNTHETIC-SECRET-KEY|SYNTHETIC-|SECRET-KEY/);
  }
});

test('credentials inside URL authentication and query fields cannot escape through a bare error echo', () => {
  for (const apiUrl of ['https://user:UrlCredential123@private-host.example/v1', 'https://private-host.example/v1?api_key=UrlCredential123']) {
    const rows = sample(); rows[0].apiUrl = apiUrl;
    rows[9].data.error = 'Rejected UrlCredential123 at private-host.example';
    const out = sessionLogDiagnostics(encode(rows), { detail: 'detailed' });
    assert.doesNotMatch(out, /UrlCredential123|private-host\.example/);
  }
});

test('saved structured observations retain HTTP status separately without rewriting native failure evidence', () => {
  const rows = [{ type: 'session' }, { type: 'turn/end', seq: 0, data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST' } } } }];
  const out = decode(sessionLogDiagnostics(encode(rows), { observations: [{ status: { data: {
    run_id: 'private-run', diagnostic: { code: 'INVALID_REQUEST', httpStatus: 400, message: 'PRIVATE_RESPONSE' },
  } } }] }));
  assert.equal(out[0].observations[0].diagnostic.httpStatus, 400);
  assert.equal(out[1].data.diagnostic.httpStatus, undefined);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_RESPONSE/);
  assert.equal(out[0].observations[0].runId, 'private-run');
});

test('overlapping occurrences of one known credential leave no unmatched tail', () => {
  const rows = sample();
  rows[0].auth = { apiKey: 'CutKnown123CutKnown123' };
  rows[9].data.error = 'Rejected CutKnown123CutKnown123CutKnown123';
  const out = sessionLogDiagnostics(encode(rows), { detail: 'detailed' });
  assert.doesNotMatch(out, /CutKnown123/);
});

test('native JSON argument strings retain field structure and contribute known credential values', () => {
  const rows = sample();
  rows[3].data.arguments = JSON.stringify({ api_key: 'ArgumentCredential123', path: '/private/file', limit: 10 });
  rows[9].data.error = 'Rejected ArgumentCredential123';
  const out = decode(sessionLogDiagnostics(encode(rows), { detail: 'detailed' }));
  assert.equal(out[3].data.arguments.type, 'object');
  assert.ok(out[3].data.arguments.fields.some(item => item.field === 'path'));
  assert.doesNotMatch(JSON.stringify(out), /ArgumentCredential123|\/private\/file/);
});

test('recorded Bearer and Basic authentication also protect separately echoed components', () => {
  const rows = sample();
  rows[0].headers = { authorization: 'Bearer PrivateBearer123', 'x-company-auth': 'Basic ' + Buffer.from('fixture-user:PrivateBasic456').toString('base64') };
  rows[9].data.error = 'Rejected PrivateBearer123 and PrivateBasic456';
  assert.doesNotMatch(sessionLogDiagnostics(encode(rows), { detail: 'detailed' }), /PrivateBearer123|PrivateBasic456/);
});
