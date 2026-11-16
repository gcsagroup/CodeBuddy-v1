import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessDriver } from '../harness/index.mjs';

test('native Python pipes declare UTF-8 and preserve ambiguous Chinese headers on stdout/stderr', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cb-python-output-'));
  const driver = await createHarnessDriver({ dataDir: join(root, 'state'), cwd: root });
  t.after(() => driver.close());
  const { sessionId } = await driver.createSession({ provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture' });
  const code = `import sys,time
print(sys.stdout.encoding)
sys.stdout.write('ID    状态    任务\\n');sys.stdout.flush()
time.sleep(0.05)
sys.stderr.write('状态\\n');sys.stderr.flush()
print('中文任务🚀')`;
  const encoded = Buffer.from(code).toString('base64');
  const result = await driver.callTool(sessionId, 'pwsh', {
    command: `python -c 'exec(__import__("base64").b64decode("${encoded}"))'`, description: 'Audit Python pipe encoding',
  }, { onPermission: () => true });
  assert.equal(result.value.exitCode, 0, JSON.stringify(result));
  assert.match(result.value.stdout.text, /utf-8/i);
  assert.match(result.value.stdout.text, /ID    状态    任务/);
  assert.match(result.value.stdout.text, /中文任务🚀/);
  assert.equal(result.value.stderr.text.trim(), '状态');
  assert.doesNotMatch(result.value.stdout.text + result.value.stderr.text, /\u05f4\u032c|\uFFFD/);
});
