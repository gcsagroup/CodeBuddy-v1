import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const stage = path.resolve(process.argv[2]);
const evidence = await mkdtemp(path.join(path.dirname(stage), 'service-check-'));
const { createCompatServer } = await import(pathToFileURL(path.join(stage, 'runtime/server.mjs')));
const { createHarnessDriver } = await import(pathToFileURL(path.join(stage, 'runtime/harness/index.mjs')));
const driver = await createHarnessDriver({ dataDir: path.join(evidence, 'harness'), cwd: evidence });
let service;
try {
  const native = await driver.createSession({ cwd: evidence, provider: { id: 'build-fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: {} });
  assert.ok(native.sessionId);
  const shell = await driver.callTool(native.sessionId, 'pwsh', {
    description: 'Verify bundled native subprocess runner', command: 'Write-Output HARNESS_PACKAGED_SHELL_OK',
  }, { onPermission: () => true });
  assert.equal(shell.isError, false, JSON.stringify(shell));
  assert.match(JSON.stringify(shell), /HARNESS_PACKAGED_SHELL_OK/);
  await writeFile(path.join(evidence, 'packaged-search.txt'), 'HARNESS_SEARCH_OK');
  const search = await driver.callTool(native.sessionId, 'glob', { pattern: '*.txt' }, { onPermission: () => true });
  assert.equal(search.isError, false, JSON.stringify(search));
  assert.match(JSON.stringify(search), /packaged-search.txt/);
  const secret = randomUUID();
  service = await createCompatServer({ dataDir: path.join(evidence, 'backend'), secret, driver });
  const url = await service.listen(0, '127.0.0.1');
  const status = await fetch(url + '/status', { headers: { 'X-Secret-Key': secret } }).then(response => response.json());
  assert.equal(status.engine, 'deepseek-harness');
  assert.equal(status.modelConfigured, false);
  const manifest = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
  const receipt = { passed: true, sourceDigest: manifest.sourceDigest, nodeVersion: process.versions.node, nodeExecutable: process.execPath, nativeSessionCreated: true, nativeSubprocessVerified: true, compatServiceStarted: true };
  await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, evidence }));
} finally {
  if (service) await service.close();
  else await driver.close();
}
