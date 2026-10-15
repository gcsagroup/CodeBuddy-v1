// Controlled provider, real Electron renderer, real ACP and official Harness.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startPreview } = require('./start-harness-preview.cjs');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(root, '.preview-evidence', 'first-version-'));
const events = [];
const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'desktop-codepro-fixture' }] }));
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  events.push({ model: body.model, stream: body.stream, tools: body.tools?.map(x => x.function.name), messages: body.messages });
  fs.writeFileSync(path.join(profile, 'model-requests.json'), JSON.stringify(events, null, 2));
  if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  const lastUser = body.messages.findLastIndex(x => x.role === 'user');
  const answered = body.messages.slice(lastUser + 1).some(x => x.role === 'tool');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (!answered && body.tools?.some(t => t.function.name === 'codebuddy_task')) {
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'codebuddy_task', arguments: JSON.stringify({ action: 'answer', answer: 'CODEPRO_DEFAULT_WORKSPACE_OK' }) } }] });
    emit({}, 'tool_calls');
  } else { emit({ role: 'assistant', content: 'CODEPRO_DEFAULT_WORKSPACE_OK' }); emit({}, 'stop'); }
  res.end('data: [DONE]\n\n');
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { openStore } = await import('../runtime/store.mjs');
  const { saveProvider } = await import('../runtime/providers.mjs');
  const store = await openStore(path.join(profile, 'backend'));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const configured = await saveProvider(store, { engine: 'openai_compatible', displayName: 'Desktop acceptance fixture', apiUrl: endpoint, requiresAuth: false, models: ['desktop-codepro-fixture'], supportsStreaming: true, headers: {} });
  await store.update(s => { s.defaults = { providerId: configured.providerId, modelId: 'desktop-codepro-fixture' }; });
  fs.writeFileSync(path.join(root, '.preview-evidence', 'first-version-fixture.json'), JSON.stringify({ profile, endpoint, devtoolsPort: 9389 }, null, 2));
  try { process.exitCode = await startPreview({ dataDirectory: profile, env: { ...process.env, CODEBUDDY_PREVIEW_DEVTOOLS_PORT: '9389', CODEPRO_UNIFIED_MODE: 'true', CODEBUDDY_WORKSPACE_ROOT: path.join(profile, 'workspaces') } }); }
  finally { server.closeAllConnections(); server.close(); }
})().catch(e => { console.error(e); server.closeAllConnections(); server.close(); process.exitCode = 1; });
