import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessDriver } from '../harness/index.mjs';

test('Python can create and replace a nested PID file written by file tools, while sibling writes stay denied', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const evidence = fileURLToPath(new URL('../../.local/', import.meta.url));
  await mkdir(evidence, { recursive: true });
  const base = await mkdtemp(join(evidence, 'cb-python-audit-'));
  const root = join(base, 'workspace');
  await mkdir(root);
  const driver = await createHarnessDriver({ dataDir: join(base, 'state'), cwd: root });
  t.after(() => driver.close());
  const session = await driver.createSession({ cwd: root, provider: { id: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: {} });
  const callbacks = { onPermission: () => false };
  const shell = (command, extra = {}) => driver.callTool(session.sessionId, 'pwsh', { command, description: 'Python sandbox acceptance', ...extra }, callbacks);
  // Initialize the sandbox first, then create new descendants via the native
  // file backend (the same order observed in project generation).
  assert.equal((await shell('python --version')).value.exitCode, 0);
  const script = "from pathlib import Path\np = Path(__file__).with_name('server.pid')\np.write_text('1234')\nprint(p.read_text())\n";
  const write = await driver.callTool(session.sessionId, 'write', { file_path: 'project/serve.py', content: script }, callbacks);
  assert.equal(write.isError, false, JSON.stringify(write));
  const spawned = await shell("$p = Start-Process python -ArgumentList 'serve.py' -PassThru -WindowStyle Hidden; $p.WaitForExit(); Write-Output $p.ExitCode", { workdir: join(root, 'project') });
  assert.equal(spawned.value?.exitCode, 0, JSON.stringify(spawned));
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await driver.callTool(session.sessionId, 'write', { file_path: 'project/server.pid', content: 'host-written' }, callbacks);
    const ran = await shell('python serve.py', { workdir: join(root, 'project') });
    assert.equal(ran.value?.exitCode, 0, JSON.stringify(ran));
    assert.equal(await readFile(join(root, 'project/server.pid'), 'utf8'), '1234');
  }
  await shell("Remove-Item -LiteralPath server.pid", { workdir: join(root, 'project') });
  const background = await shell('python serve.py', { workdir: join(root, 'project'), run_in_background: true });
  assert.equal(background.isError, false, JSON.stringify(background));
  const jobs = await driver.callTool(session.sessionId, 'job_list', {}, callbacks);
  const job = jobs.value.find(job => job.kind === 'pwsh' && job.label.includes('python serve.py'));
  assert.ok(job, JSON.stringify(jobs));
  const output = await driver.callTool(session.sessionId, 'job_output', { job_id: job.id, wait: true, timeout_ms: 10000 }, callbacks);
  assert.equal(output.isError, false, JSON.stringify(output));
  assert.match(output.value.text, /1234/);
  assert.equal(await readFile(join(root, 'project/server.pid'), 'utf8'), '1234');
  const outside = await shell('python -c "from pathlib import Path; Path(\'../outside.pid\').write_text(\'no\')"');
  assert.notEqual(outside.value?.exitCode, 0);
  await assert.rejects(readFile(join(base, 'outside.pid')), { code: 'ENOENT' });
});
