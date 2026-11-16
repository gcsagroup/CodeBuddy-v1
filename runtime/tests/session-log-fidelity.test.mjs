import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionLogDiagnostics } from '../session-log-diagnostics.mjs';

const encode = rows => rows.map(JSON.stringify).join('\n');
const decode = value => value.trim().split('\n').map(JSON.parse);
const fixture = () => [
  { type: 'session', version: 4, id: 'session-fidelity', cwd: 'C:/Users/PrivatePerson/PrivateProject' },
  { type: 'user/message', seq: 0, time: 1730000000000, data: { message: { id: 'user-1', content: [{ type: 'text', text: 'PRIVATE_BUSINESS_PAYLOAD_123' }] } } },
  { type: 'request/header', seq: 1, time: 1730000000010, data: { header: { config: {
    provider: 'openai_compatible', model: 'qwen3.8-flash-next', maxTokens: 32768, reasoningEffort: 'high',
    apiKey: 'KnownCredential123', baseUrl: 'http://198.51.100.25:8001/v1/chat/completions?max_tokens=32768&api_key=KnownCredential123',
  }, tools: [{ name: 'custom_check', parameters: { type: 'object', properties: { custom_limit: { type: 'integer' } }, required: ['custom_limit'] } }] } } },
  { type: 'tool/call', seq: 2, time: 1730000000020, data: { callId: 'call-' + 'a'.repeat(64), name: 'custom_check', arguments: JSON.stringify({ limit: 12, timeout: 30, file_path: 'C:/Users/PrivatePerson/PrivateProject/src/app.ts' }) } },
  { type: 'tool/result', seq: 3, time: 1730000000030, data: { message: { toolCallId: 'call-' + 'a'.repeat(64), isError: false, content: [{ type: 'text', text: 'Checked 12 entries' }] } } },
  { type: 'compaction/end', seq: 4, time: 1730000000040, data: { compactionId: 'compact-1', error: 'summarization truncated at the token cap (incomplete checkpoint)' } },
  { type: 'turn/end', seq: 5, time: 1730000000050, data: { reason: { kind: 'error', error: {
    code: 'provider_invalid_parameter', status: 400, requestId: 'req-' + 'b'.repeat(64),
    message: 'Unsupported parameter tools; model=qwen3.8-flash-next; api_key=KnownCredential123; messages=[{"role":"user","content":"PRIVATE_BUSINESS_PAYLOAD_123"}]',
    stack: 'ProviderError: unsupported tools\n at C:/Users/PrivatePerson/PrivateProject/src/app.ts:18:4',
    cause: { code: 'ENOTFOUND', message: 'DNS lookup failed for https://private-service.internal/v1/chat/completions' },
  } } } },
];

test('standard logs preserve real models, concrete errors, long request IDs and technical parameters', () => {
  const rows = fixture(), original = encode(rows), out = decode(sessionLogDiagnostics(original));
  assert.equal(out[2].data.request.config.model, 'qwen3.8-flash-next');
  assert.equal(out[2].data.request.config.provider, 'openai_compatible');
  assert.equal(out[2].data.request.tools.declarations[0].name, 'custom_check');
  assert.equal(out[2].data.request.tools.declarations[0].parameters.required[0], 'custom_limit');
  assert.equal(out[3].data.callId, 'call-' + 'a'.repeat(64));
  assert.equal(out[3].data.callId, out[4].data.callId);
  assert.equal(out[3].data.arguments.fields.find(item => item.field === 'limit').value, 12);
  assert.equal(out[6].data.error.code, 'provider_invalid_parameter');
  assert.equal(out[6].data.error.requestId, 'req-' + 'b'.repeat(64));
  assert.match(out[6].data.error.message, /Unsupported parameter tools/);
  assert.match(out[6].data.error.stack, /src\/app.ts:18:4/);
  assert.equal(out[6].data.error.cause.code, 'ENOTFOUND');
  assert.equal(out[6].data.diagnostic.httpStatus, 400);
  assert.equal(out[5].data.diagnostic.code, 'UNKNOWN_FAILURE');
  assert.match(out[5].data.error.message, /incomplete checkpoint/);
  assert.equal(out[5].data.route, undefined, 'failed summaries do not invent a historical route');
  assert.equal(out[6].time, rows[6].time);
  assert.equal(encode(rows), original);
});

test('both log modes remove secrets and request-body echoes without removing the technical cause', () => {
  for (const detail of ['standard', 'detailed']) {
    const value = sessionLogDiagnostics(encode(fixture()), { detail });
    assert.doesNotMatch(value, /KnownCredential123|PRIVATE_BUSINESS_PAYLOAD_123|PrivatePerson|PrivateProject|198\.51\.100\.25|private-service\.internal/);
    assert.match(value, /Unsupported parameter tools/);
    assert.match(value, /qwen3\.8-flash-next/);
    assert.match(value, /\/v1\/chat\/completions/);
    assert.match(value, /max_tokens=32768/);
    assert.match(value, /DNS lookup failed/);
    assert.equal(value.includes('Checked 12 entries'), detail === 'detailed');
  }
});

test('empty and absent native tool declarations remain distinguishable without claiming wire evidence', () => {
  const rows = [{ type: 'session' }, ...[undefined, [], null].map((tools, seq) => ({ type: 'request/header', seq, data: { header: tools === undefined ? {} : { tools } } }))];
  const out = decode(sessionLogDiagnostics(encode(rows)));
  assert.deepEqual(out.slice(1).map(row => row.data.request.tools.state), ['absent', 'empty', 'null']);
  assert.ok(out.slice(1).every(row => row.data.request.wirePayload === 'not_recorded'));
});

test('error response metadata and JSON-embedded authentication protect actual secrets without masking model environment values', () => {
  const rows = fixture();
  rows[0].env = { OPENAI_MODEL: 'qwen3.8-flash-next', OPENAI_API_KEY: 'EnvironmentCredential123' };
  const error = rows.at(-1).data.reason.error;
  error.headers = { 'x-request-id': 'req-' + 'c'.repeat(64), 'Retry-After': '30', Authorization: 'Bearer HeaderCredential123' };
  error.message = 'Rejected qwen3.8-flash-next; ' + JSON.stringify({ error: { code: 'unsupported_option', message: 'response_format unsupported' }, headers: { 'x-company-auth': 'EmbeddedHeader123' } }) + '; echoed EmbeddedHeader123 and EnvironmentCredential123';
  const out = decode(sessionLogDiagnostics(encode(rows)));
  const text = JSON.stringify(out);
  assert.equal(out[2].data.request.config.model, 'qwen3.8-flash-next');
  assert.equal(out.at(-1).data.error.headers['Retry-After'], '30');
  assert.equal(out.at(-1).data.error.headers['x-request-id'], error.headers['x-request-id']);
  assert.match(out.at(-1).data.error.message, /response_format unsupported/);
  assert.doesNotMatch(text, /EnvironmentCredential123|EmbeddedHeader123|HeaderCredential123/);
});

test('unrecognised event names remain visible without exporting arbitrary payload values', () => {
  const out = decode(sessionLogDiagnostics(encode([{ type: 'session' }, { type: 'session/new-native-observation', seq: 0, data: { unexpectedBody: 'PRIVATE_PAYLOAD' } }])));
  assert.equal(out[1].type, 'session/new-native-observation');
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_PAYLOAD/);
});

test('personal fields and multiply encoded quoted authentication values are removed without hiding the failure', () => {
  const rows = fixture();
  rows[0].personal = { username: 'PrivatePersonName123', phone: '+86-138-0013-8000', account_id: 'PrivateAccount123' };
  const encoded = JSON.stringify(JSON.stringify({ headers: { 'X-Custom-Auth': 'QuotedPrivate_"_Credential123' } }));
  rows.at(-1).data.reason.error.message = 'Unsupported tools; username=PrivatePersonName123; account=PrivateAccount123; contact=+86-138-0013-8000; upstream=' + encoded;
  for (const detail of ['standard', 'detailed']) {
    const value = sessionLogDiagnostics(encode(rows), { detail });
    assert.match(value, /Unsupported tools/);
    assert.doesNotMatch(value, /PrivatePersonName123|PrivateAccount123|138-0013|QuotedPrivate/);
  }
});

test('all valid JSON error fragments and snake-case body echoes are checked rather than silently skipping a suffix', () => {
  const rows = fixture();
  rows.at(-1).data.reason.error.message = 'Unsupported tools; ' + '{"ok":true} '.repeat(40)
    + JSON.stringify({ headers: { 'X-Custom-Auth': 'LastFragmentCredential123' } })
    + '; request_body={"customer":"PrivateCustomer123"}; response_body={"record":"PrivateRecord123"}; max_tokens=32768';
  const value = sessionLogDiagnostics(encode(rows));
  assert.match(value, /Unsupported tools/);
  assert.match(value, /max_tokens=32768/);
  assert.doesNotMatch(value, /LastFragmentCredential123|PrivateCustomer123|PrivateRecord123/);
});

test('private-body budget exhaustion does not erase independent technical facts', () => {
  const rows = [{ type: 'session', id: 'session-large' }];
  for (let i = 0; i < 5; i++) rows.push({ type: 'user/message', data: { content: [{ type: 'text', text: `${i}:` + 'private body '.repeat(85000) }] } });
  rows.push({ type: 'request/header', data: { header: { config: { provider: 'openai_compatible', model: 'qwen3.8-log-fixture', maxTokens: 32768 } } } });
  rows.push({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', requestId: 'request-large', message: 'Unsupported tools' } } } });
  const out = decode(sessionLogDiagnostics(encode(rows)));
  assert.equal(out[1].type, 'user/message');
  assert.equal(out.at(-2).data.request.config.model, 'qwen3.8-log-fixture');
  assert.equal(out.at(-1).data.error.code, 'INVALID_REQUEST');
  assert.equal(out.at(-1).data.error.requestId, 'request-large');
  assert.equal(out.at(-1).data.error.truncated, true);
  assert.doesNotMatch(JSON.stringify(out), /private body/);
});

test('numeric and boolean schema constraints remain available for parameter compatibility debugging', () => {
  const rows = fixture();
  const schema = rows[2].data.header.tools[0].parameters;
  schema.additionalProperties = false;
  schema.properties.custom_limit = { type: 'integer', minimum: 0, maximum: 600000 };
  const declaration = decode(sessionLogDiagnostics(encode(rows)))[2].data.request.tools.declarations[0].parameters;
  assert.equal(declaration.additionalProperties, false);
  assert.equal(declaration.properties[0].minimum, 0);
  assert.equal(declaration.properties[0].maximum, 600000);
});

test('loopback endpoints retain their nonprivate host and port while remote addresses are hidden', () => {
  const rows = fixture();
  rows.at(-1).data.reason.error.message = 'ECONNREFUSED http://127.0.0.1:8001/v1/chat/completions and http://[::1]:8001/v1/messages';
  const text = sessionLogDiagnostics(encode(rows));
  assert.match(text, /127\.0\.0\.1:8001\/v1\/chat\/completions/);
  assert.match(text, /\[::1\]:8001\/v1\/messages/);
  assert.doesNotMatch(text, /198\.51\.100\.25/);
});

test('ordinary failure explanations containing input or content are not mistaken for request-body echoes', () => {
  const rows = fixture();
  rows.at(-1).data.reason.error.message = 'Invalid input: expected text or image content; invalid content: expected an array';
  const out = decode(sessionLogDiagnostics(encode(rows)));
  assert.equal(out.at(-1).data.error.message, rows.at(-1).data.reason.error.message);
});
