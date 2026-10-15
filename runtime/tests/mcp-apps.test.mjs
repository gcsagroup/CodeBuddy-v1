import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.mjs';
import { McpApps } from '../mcp-apps.mjs';
import { zAppsListResponse_unstable, zAppsImportResponse_unstable, zAppsExportResponse_unstable, zAppsDeleteResponse_unstable, zReadResourceResponse_unstable } from '../../ui/sdk/src/generated/zod.gen.ts';

const envelope = (name, more = {}) => `<html><head><script type="application/ld+json">${JSON.stringify({ name, ...more }).replaceAll('<', '\\u003c')}</script></head><body><h1>真实内容</h1></body></html>`;
async function fixture(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codebuddy-mcp-apps-')), store = await openStore(directory);
  const apps = new McpApps(store, { resolveContext: async id => { assert.equal(id, 'session'); return context ?? { extensions: [] }; } });
  await apps.initialize(); return { apps, store, directory };
}

test('original HTML import/list/export/resource/delete contracts persist, escape metadata and resolve concurrent names', async () => {
  const { apps, directory } = await fixture();
  const name = 'App </script><script>literal', meta = { ui: { csp: { connectDomains: ['https://example.test'] } } };
  const imported = await apps.request('apps/import', { html: envelope(name, { width: 900, _meta: meta, mcpServers: ['arbitrary-other-server'] }) });
  zAppsImportResponse_unstable.parse(imported);
  const listed = zAppsListResponse_unstable.parse(await apps.request('apps/list'));
  assert.equal(listed.apps[0].name, name); assert.equal(listed.apps[0].width, 900); assert.equal(listed.apps[0].height, 600);
  assert.deepEqual(listed.apps[0].mcpServers, ['apps']); assert.deepEqual(listed.apps[0]._meta, meta);
  const { html } = zAppsExportResponse_unstable.parse(await apps.request('apps/export', { name }));
  assert.ok(!html.includes('</script><script>literal')); assert.match(html, /\\u003c/);
  const repeated = await Promise.all([apps.request('apps/import', { html }), apps.request('apps/import', { html })]);
  assert.deepEqual(repeated.map(app => app.name), [`${name}_1`, `${name}_2`]);
  const reopened = new McpApps(await openStore(directory), { resolveContext: async () => ({ extensions: [] }) });
  const resource = zReadResourceResponse_unstable.parse(await reopened.request('resources/read', { sessionId: 'session', extensionName: 'apps', uri: listed.apps[0].uri }));
  assert.match(resource.result.contents[0].text, /真实内容/); assert.deepEqual(resource.result.contents[0]._meta, meta);
  zAppsDeleteResponse_unstable.parse(await reopened.request('apps/delete', { name }));
  await assert.rejects(reopened.request('apps/export', { name }), /not found/);
  await assert.rejects(apps.request('apps/import', { html: '<h1>No metadata</h1>' }), /metadata/);
});

test('remote apps use exact scoped resources, preserve blob/meta and never delete remote servers', async () => {
  const calls = [], meta = { ui: { prefersBorder: false, csp: { resourceDomains: ['https://cdn.example.test'] } } };
  const { apps } = await fixture({ extensions: ['chart'],
    async listResources(extension, cursor) { calls.push(['list', extension, cursor]); return cursor ? { resources: [{ uri: 'ui://chart/view', name: 'Chart', mimeType: 'text/html;profile=mcp-app' }] } : { resources: [], nextCursor: 'page2' }; },
    async readResource(extension, uri) { calls.push(['read', extension, uri]); return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', blob: Buffer.from('<h1>Chart</h1>').toString('base64'), _meta: meta }], _meta: { receipt: 'outer' } }; },
  });
  const { apps: listed } = await apps.request('apps/list', { sessionId: 'session' });
  assert.equal(listed[0].text, '<h1>Chart</h1>'); assert.equal(listed[0].deletable, false); assert.deepEqual(listed[0]._meta, meta);
  assert.deepEqual(calls.slice(0, 3), [['list', 'chart', undefined], ['list', 'chart', 'page2'], ['read', 'chart', 'ui://chart/view']]);
  const raw = await apps.request('resources/read', { sessionId: 'session', extensionName: 'chart', uri: 'ui://chart/view' });
  assert.equal(raw.result._meta.receipt, 'outer'); assert.ok(raw.result.contents[0].blob);
  await assert.rejects(apps.request('resources/read', { sessionId: 'session', extensionName: 'unselected', uri: 'ui://chart/view' }), /not enabled/);
  await assert.rejects(apps.request('apps/delete', { name: 'Chart' }), /Only imported/);
});

test('bad pagination and invalid HTML leave the last complete cache untouched', async () => {
  let broken = false;
  const { apps } = await fixture({ extensions: ['chart'], listResources: async () => broken ? { resources: [], nextCursor: 'loop' } : { resources: [{ uri: 'ui://chart/app', name: 'Chart', mimeType: 'text/html' }] }, readResource: async () => ({ contents: [{ uri: 'ui://chart/app', text: '<p>accepted</p>' }] }) });
  await apps.request('apps/list', { sessionId: 'session' }); broken = true;
  await assert.rejects(apps.request('apps/list', { sessionId: 'session' }), /pagination/);
  assert.equal((await apps.request('apps/list')).apps[0].text, '<p>accepted</p>');
});
