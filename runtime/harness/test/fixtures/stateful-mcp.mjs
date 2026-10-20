import http from 'node:http';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(20); }
  assert.fail('MCP fixture did not reach the expected state');
}

export async function statefulMcp(t, { stateless = false } = {}) {
  const wire = [], valid = new Set();
  const control = { status: 404, message: 'Session not found', toolError: false, rejectInitialize: false, drop: false };
  let initializations = 0, executions = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw), sessionId = req.headers['mcp-session-id'];
    if (req.url !== '/mcp') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); return;
    }
    wire.push({ method: msg.method, sessionId, authorization: req.headers.authorization });
    let result, headers = {};
    if (msg.method === 'initialize') {
      initializations++;
      if (control.rejectInitialize) { res.writeHead(503).end(); return; }
      const id = `fixture-session-${initializations}`; valid.add(id);
      if (!stateless) headers = { 'mcp-session-id': id };
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, ...(control.tasks ? { tasks: { requests: { tools: { call: {} } } } } : {}) }, serverInfo: { name: 'session-fixture', version: '1' } };
    } else if ((!stateless && !valid.has(sessionId)) || control.fault) {
      res.writeHead(control.status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 'server-error', error: { code: -32600, message: control.message } })); return;
    } else if (!('id' in msg)) { res.writeHead(202).end(); return; }
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'health', description: `Generation ${initializations}`, inputSchema: { type: 'object', properties: {} }, ...(control.tasks ? { execution: { taskSupport: 'optional' } } : {}) }] };
    else if (msg.method === 'tools/call') {
      executions++;
      if (control.drop) { req.socket.destroy(); return; }
      result = { ...(control.toolError ? { isError: true } : {}), content: [{ type: 'text', text: control.toolError ? 'Session not found' : 'healthy' }] };
      if (control.tasks) {
        result = { task: { taskId: 'accepted-task', status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null, pollInterval: 100 } };
        valid.clear();
      }
    } else if (msg.method === 'resources/list') result = { resources: [] };
    else result = {};
    res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { wire, control, baseUrl: `http://127.0.0.1:${server.address().port}`, expire: () => valid.clear(), initializations: () => initializations, executions: () => executions };
}
