import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';
import { driverProvider } from '../providers.mjs';
import { applyModelThinking } from '../model-settings.mjs';

test('catalog reasoning capabilities admit both Responses and Completions sessions', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'gpt-6.1-sol' }] }));
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-provider-admission-'));
  const driver = await createHarnessDriver({ dataDir: root, cwd: root });
  t.after(() => driver.close());
  for (const basePath of ['/v1/responses', '/v1/chat/completions']) {
    const resolved = await driverProvider({ id: 'fixture', engine: 'openai_compatible', apiUrl: 'https://api.openai.com', basePath,
      models: ['gpt-6.1-sol'], requiresAuth: false }, 'gpt-6.1-sol');
    const configured = applyModelThinking(resolved, 'xhigh');
    // Admission must not need any real model request or real credentials.
    configured.provider.baseUrl = 'http://127.0.0.1:1/v1';
    const created = await driver.createSession({ cwd: root, provider: configured.provider, model: 'gpt-6.1-sol',
      options: { tools: [], thinkingEffort: configured.thinkingEffort } });
    assert.ok(created.sessionId);
  }
});
