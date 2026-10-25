import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { Compat } from '../compat.mjs';
import { connectGithubMcp } from '../github-mcp.mjs';
import { revealSecret } from '../secrets.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codebuddy-github-mcp-'));
  const store = await openStore(root);
  await store.update(state => {
    state.sessions.push({ id: 'chat', type: 'user', cwd: root, providerId: 'provider', modelId: 'model', extensions: null });
    state.providers.push({ id: 'provider', models: ['model'], requiresAuth: false });
  });
  const host = new Compat(store, { extensionStatus: () => [], invalidateMcpServers: async () => {} });
  return { host, store, root };
}
const extension = { type: 'mcp', envKeys: ['TOKEN'], server: { name: 'remote', type: 'http', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer ${TOKEN}' }] } };
const token = 'isolated-github-token';
const account = login => JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login }] } });
test('explicit GitHub connection verifies the official endpoint and atomically saves encrypted credentials', async () => {
  const { host, store, root } = await fixture();
  let tested = 0;
  host.testExtension = async input => {
    tested++;
    assert.equal(input.extension.server.url, 'https://api.githubcopilot.com/mcp/');
    assert.equal(input.environment.CODEBUDDY_GITHUB_MCP_TOKEN, token);
    assert.ok(!store.read().config.CODEBUDDY_GITHUB_MCP_TOKEN, 'do not save before verification');
    return { tools: [] };
  };
  const result = await connectGithubMcp(host, 'octocat', { run: async args => args[1] === 'status' ? account('octocat') : token });
  assert.deepEqual(result, { success: true, login: 'octocat' });
  assert.equal(tested, 1);
  assert.equal(await revealSecret(store.read().config.CODEBUDDY_GITHUB_MCP_TOKEN.secret), token);
  assert.equal(store.read().extensions.find(e => e.configKey === 'github_official').enabled, true);
  assert.ok(!(await readFile(path.join(root, 'state.json'), 'utf8')).includes(token));
});
test('failed verification, changed account and custom endpoints never save or leak credentials', async () => {
  const { host, store } = await fixture();
  host.testExtension = async () => { throw new Error(token); };
  const run = async args => args[1] === 'status' ? account('octocat') : token;
  assert.deepEqual(await connectGithubMcp(host, 'octocat', { run }), { success: false, code: 'connection_failed' });
  assert.deepEqual(await connectGithubMcp(host, 'different', { run }), { success: false, code: 'account_changed' });
  await host.settings.saveExtension({ extension: { ...extension, server: { ...extension.server, name: 'github_official' } }, enabled: true });
  assert.deepEqual(await connectGithubMcp(host, 'octocat', { run: async () => { assert.fail('custom endpoint must not read the token'); } }), { success: false, code: 'endpoint_changed' });
  assert.ok(!store.read().config.CODEBUDDY_GITHUB_MCP_TOKEN);
});
test('a concurrent credential edit prevents an older connection attempt from overwriting it', async () => {
  const { host, store } = await fixture();
  host.testExtension = async () => { await store.update(state => { state.config.CODEBUDDY_GITHUB_MCP_TOKEN = { value: 'new-user-selection' }; }); return { tools: [] }; };
  const result = await connectGithubMcp(host, 'octocat', { run: async args => args[1] === 'status' ? account('octocat') : token });
  assert.equal(result.success, false);
  assert.equal(store.read().config.CODEBUDDY_GITHUB_MCP_TOKEN.value, 'new-user-selection');
});
