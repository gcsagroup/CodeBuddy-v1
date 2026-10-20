import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const stage = path.resolve(process.argv[2]);
// A signed .app must remain immutable during post-sign verification.
const evidence = await mkdtemp(path.join(process.argv[3] ? path.resolve(process.argv[3]) : path.dirname(stage), 'service-check-'));
const { createCompatServer } = await import(pathToFileURL(path.join(stage, 'runtime/server.mjs')));
const { createHarnessDriver } = await import(pathToFileURL(path.join(stage, 'runtime/harness/index.mjs')));
const driver = await createHarnessDriver({ dataDir: path.join(evidence, 'harness'), cwd: evidence });
let service;
try {
  const native = await driver.createSession({ cwd: evidence, provider: { id: 'build-fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, model: 'fixture', options: {} });
  assert.ok(native.sessionId);
  const shell = await driver.callTool(native.sessionId, process.platform === 'win32' ? 'pwsh' : 'bash', {
    description: 'Verify bundled native subprocess runner', command: process.platform === 'win32' ? 'Write-Output HARNESS_PACKAGED_SHELL_OK' : "printf '%s\\n' HARNESS_PACKAGED_SHELL_OK",
  }, { onPermission: () => true });
  assert.equal(shell.isError, false, JSON.stringify(shell));
  assert.match(JSON.stringify(shell), /HARNESS_PACKAGED_SHELL_OK/);
  await writeFile(path.join(evidence, 'packaged-search.txt'), 'HARNESS_SEARCH_OK');
  const search = await driver.callTool(native.sessionId, 'glob', { pattern: '*.txt' }, { onPermission: () => true });
  assert.equal(search.isError, false, JSON.stringify(search));
  assert.match(JSON.stringify(search), /packaged-search.txt/);
  const dependencies = await driver.callTool(native.sessionId, 'load_workspace_dependencies', {}, { onPermission: () => true });
  assert.equal(dependencies.isError, false, JSON.stringify(dependencies));
  assert.ok(path.resolve(dependencies.value.python).startsWith(stage + path.sep), 'Office must use the installed payload');
  const python = spawnSync(dependencies.value.python, ['-I', '-B', '-c',
    'import docx, openpyxl, pandas, pptx; d=docx.Document(); d.add_paragraph("PACKAGE_OFFICE_OK"); d.save("check.docx"); w=openpyxl.Workbook(); w.active["A1"]=42; w.save("check.xlsx"); assert docx.Document("check.docx").paragraphs[0].text=="PACKAGE_OFFICE_OK"; assert openpyxl.load_workbook("check.xlsx").active["A1"].value==42'],
  { cwd: evidence, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(python.error, undefined);
  assert.equal(python.status, 0, python.stderr);
  const office = await driver.callTool(native.sessionId, 'skill', { name: 'office-docx' }, { onPermission: () => true });
  assert.equal(office.isError, false, JSON.stringify(office));
  assert.ok((await driver.listTools(native.sessionId)).some(tool => tool.name === 'web_fetch'));
  const secret = randomUUID();
  service = await createCompatServer({ dataDir: path.join(evidence, 'backend'), secret, driver });
  const url = await service.listen(0, '127.0.0.1');
  const status = await fetch(url + '/status', { headers: { 'X-Secret-Key': secret } }).then(response => response.json());
  assert.equal(status.engine, 'deepseek-harness');
  assert.equal(status.modelConfigured, false);
  const manifest = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
  assert.ok(!manifest.files.some(file => /(?:^|\/)(?:goose|goosed)(?:\.exe)?$/i.test(file.path)), 'Legacy Agent binaries must not be packaged');
  const tools = path.join(stage, 'runtime/tools/bin', process.platform === 'win32' ? 'codebuddy-tools.exe' : 'codebuddy-tools');
  for (const command of ['agent', 'serve', 'acp']) {
    const rejected = spawnSync(tools, [command], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.status, 1, `Tool-only binary must reject ${command}`);
  }
  const { builtinMcp, builtinToolNames } = await import(pathToFileURL(path.join(stage, 'runtime/builtin-extensions.mjs')));
  const configurations = [];
  for (const name of ['commonqueries', 'computercontroller', 'autovisualiser', 'qwen_computer']) {
    const configuration = await builtinMcp({ type: 'builtin', name }, { cwd: evidence, dataDir: evidence });
    configurations.push(configuration);
    const discovered = await driver.testExtension(configuration);
    assert.deepEqual(discovered.map(tool => tool.name).sort(), builtinToolNames(name).map(tool => `mcp__${name}__${tool}`).sort());
  }
  const { commonQueryMetadata } = await import(pathToFileURL(path.join(stage, 'runtime/common-query-settings.mjs')));
  const { openStore } = await import(pathToFileURL(path.join(stage, 'runtime/store.mjs')));
  const queryStore = await openStore(path.join(evidence, 'query-settings'));
  await driver.configureSession(native.sessionId, {
    mcpServers: configurations.filter(config => ['commonqueries', 'computercontroller'].includes(config.serverName)),
    mcpRequestMetadata: name => name === 'commonqueries' ? commonQueryMetadata(queryStore) : undefined,
  });
  for (const [name, args] of [['mcp__commonqueries__time_now', {}], ['mcp__computercontroller__cache', { command: 'list' }]]) {
    const result = await driver.callTool(native.sessionId, name, args, { onPermission: () => true });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(result.content?.length > 0);
  }
  const { protectSecret, revealSecret } = await import(pathToFileURL(path.join(stage, 'runtime/secrets.mjs')));
  const credentialFixture = 'PACKAGE_CREDENTIAL_FIXTURE 中文 🔑\n  whitespace  ';
  const protectedCredential = await protectSecret(credentialFixture);
  const credentialFile = path.join(evidence, 'credential-fixture.json');
  await writeFile(credentialFile, JSON.stringify(protectedCredential));
  assert.ok(!(await readFile(credentialFile, 'utf8')).includes('PACKAGE_CREDENTIAL_FIXTURE'));
  assert.equal(protectedCredential.kind, process.platform === 'darwin' ? 'macos-keychain-aesgcm-v1' : 'windows-dpapi');
  assert.equal(await revealSecret(JSON.parse(await readFile(credentialFile, 'utf8'))), credentialFixture);
  const receipt = { passed: true, sourceDigest: manifest.sourceDigest, nodeVersion: process.versions.node, nodeExecutable: process.execPath, nativeSessionCreated: true, nativeSubprocessVerified: true, officePayloadVerified: true, builtinMcpDiscoveryVerified: true, builtinMcpCallsVerified: true, credentialProtectionVerified: true, desktopInputVerified: false, compatServiceStarted: true };
  await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, evidence }));
} finally {
  if (service) await service.close();
  else await driver.close();
}
