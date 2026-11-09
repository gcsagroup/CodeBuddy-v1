'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { previewEnvironment, startPreview } = require('./start-harness-preview.cjs');

test('duplicate launch preserves the active receipt and refuses to prepare another desktop', async t => {
  const { options } = fixture(t);
  let duplicate;
  options.onReady = receipt => {
    const receiptPath = path.join(receipt.dataDirectory, 'logs/preview/launch.json');
    const original = fs.readFileSync(receiptPath, 'utf8');
    duplicate = assert.rejects(startPreview({ ...options, onReady: undefined }), /已有运行中的后台/)
      .then(() => assert.equal(fs.readFileSync(receiptPath, 'utf8'), original));
  };
  assert.equal(await startPreview(options), 0);
  await duplicate;
});

test('an older backend lease protects its receipt even without a launcher lease', async t => {
  const { options } = fixture(t);
  const { acquireProfileLock } = await import('../runtime/profile-lock.mjs');
  const lock = await acquireProfileLock(path.join(options.dataDirectory, 'backend'));
  const receiptPath = path.join(options.dataDirectory, 'logs/preview/launch.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, 'existing receipt');
  try {
    await assert.rejects(startPreview(options), /已有运行中的后台/);
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), 'existing receipt');
  } finally { lock.close(); }
});

function fixture(t, parent = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(parent, 'codebuddy-harness-launcher-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(parent));
    assert.ok(path.basename(root).startsWith('codebuddy-harness-launcher-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const serverPath = path.join(root, 'server.cjs');
  const desktopPath = path.join(root, 'desktop.cjs');
  const artifactModule = path.join(root, 'runtime', 'builtin-artifacts.mjs');
  const toolFile = path.join(root, 'runtime', 'tools', 'bin', 'fixture-tools.exe');
  const toolBytes = Buffer.from('fixture-pinned-tool');
  fs.mkdirSync(path.dirname(toolFile), { recursive: true });
  fs.writeFileSync(toolFile, toolBytes, { mode: 0o755 });
  // Use the unchanged production validator against tiny isolated artifacts.
  fs.copyFileSync(path.join(__dirname, '../runtime/builtin-artifacts.mjs'), path.join(root, 'runtime/artifact-validation.mjs'));
  const artifact = { file: path.basename(toolFile), bytes: toolBytes.length, sha256: createHash('sha256').update(toolBytes).digest('hex') };
  fs.writeFileSync(artifactModule, `
    import fs from 'node:fs';
    import { verifiedBinary as verify } from './artifact-validation.mjs';
    const root = new URL('../', import.meta.url);
    export async function builtinArtifacts() {
      return ${JSON.stringify({ tools: artifact })};
    }
    export async function verifiedBinary(artifact) {
      const file = await verify(artifact);
      fs.writeFileSync(new URL('artifacts-checked.txt', root), 'checked');
      return file;
    }
  `);
  fs.writeFileSync(serverPath, `
    const http = require('node:http');
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const valid = (req.headers['x-secret-key'] || url.searchParams.get('token')) === process.env.CODEBUDDY_SERVER__SECRET_KEY;
      if (!valid) { res.writeHead(401); res.end(); return; }
      if (url.pathname === '/status') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ modelConfigured: process.env.FIXTURE_CONFIGURED === '1' }));
      } else { res.writeHead(406); res.end(); }
    }).listen(port, '127.0.0.1');
  `);
  fs.writeFileSync(desktopPath, `
    const fs = require('node:fs');
    const path = require('node:path');
    let stdinEnded = false;
    process.stdin.on('end', () => { stdinEnded = true; });
    process.stdin.resume();
    setTimeout(() => {
      fs.writeFileSync(path.join(process.cwd(), 'desktop-observed.json'), JSON.stringify({
      home: process.env.CODEBUDDY_HOME,
      workspaceRoot: process.env.CODEBUDDY_WORKSPACE_ROOT,
      workingDir: process.env.GOOSE_WORKING_DIR,
      preview: process.env.CODEBUDDY_HARNESS_PREVIEW,
      initialRoute: process.env.CODEBUDDY_PREVIEW_INITIAL_ROUTE || null,
      protocol: process.env.CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION,
      legacyRoot: process.env.GOOSE_PATH_ROOT || null,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
      stdinEnded,
      }));
      process.exit(0);
    }, 100);
  `);
  return {
    root, toolFile, toolBytes,
    options: {
      repoRoot: root, serverPath,
      dataDirectory: path.join(root, '.preview-data'),
      env: { ...process.env, CODEBUDDY_WORKSPACE_ROOT: path.join(root, 'user-workspace') },
      commands: { prepare: [], desktop: { args: [desktopPath], cwd: root } },
      readinessTimeoutMs: 5000,
    },
  };
}

test('preview uses the product data root, supports isolation and rejects legacy aliases', (t) => {
  const isolatedConfig = fixture(t).root;
  const root = path.resolve('preview-fixture');
  const inherited = {
    Path: process.env.Path || process.env.PATH,
    CODEBUDDY_HOME: path.join(root, 'user-data'), CODEBUDDY_USER_DATA_DIR: 'legacy-ui',
    CODEAGENTPRO_HOME: 'legacy-alias', GOOSE_PATH_ROOT: 'legacy-root',
    CODEBUDDY_MIGRATE_LEGACY: 'true', CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION: 'false',
    ELECTRON_RUN_AS_NODE: '1', ENABLE_DEV_UPDATES: 'true',
  };
  const env = previewEnvironment(root, 12345, 'fixture-secret', inherited);
  assert.equal(env.CODEBUDDY_HOME, inherited.CODEBUDDY_HOME);
  assert.equal(env.CODEBUDDY_USER_DATA_DIR, path.join(inherited.CODEBUDDY_HOME, 'state', 'electron-app'));
  assert.equal(env.CODEBUDDY_WORKSPACE_ROOT, path.join(inherited.CODEBUDDY_HOME, 'workspaces'));
  assert.equal(env.GOOSE_WORKING_DIR, env.CODEBUDDY_WORKSPACE_ROOT);
  assert.equal(env.CODEBUDDY_MIGRATE_LEGACY, 'false');
  assert.equal(env.CODEBUDDY_DISABLE_PROTOCOL_REGISTRATION, 'true');
  assert.equal(env.ENABLE_DEV_UPDATES, 'false');
  assert.equal(env.CODEAGENTPRO_HOME, undefined);
  assert.equal(env.GOOSE_PATH_ROOT, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(inherited.CODEBUDDY_HOME, path.join(root, 'user-data'));
  const isolatedHome = path.join(root, '.controlled-e2e');
  const isolated = previewEnvironment(root, 12346, 'fixture-secret', inherited, isolatedHome);
  assert.equal(isolated.CODEBUDDY_HOME, isolatedHome);
  assert.equal(isolated.CODEBUDDY_USER_DATA_DIR, path.join(isolatedHome, 'state', 'electron-app'));
  assert.equal(isolated.CODEBUDDY_WORKSPACE_ROOT, path.join(isolatedHome, 'workspaces'));
  if (process.platform === 'win32') assert.notEqual(isolated.TEMP, env.TEMP);
  const configEnv = { APPDATA: isolatedConfig, XDG_CONFIG_HOME: isolatedConfig };
  const defaults = previewEnvironment(root, 12345, 'fixture-secret', configEnv);
  assert.equal(defaults.CODEBUDDY_HOME, path.join(os.homedir(), '.CodeBuddy'));
  assert.equal(defaults.CODEBUDDY_WORKSPACE_ROOT, path.join(defaults.CODEBUDDY_HOME, 'workspaces'));
  const locator = require('../runtime/storage-management.cjs').locationFile(configEnv);
  fs.mkdirSync(path.dirname(locator), { recursive: true });
  const selected = path.join(isolatedConfig, 'selected-data');
  fs.writeFileSync(locator, selected + '\n');
  assert.equal(previewEnvironment(root, 12345, 'fixture-secret', configEnv).CODEBUDDY_HOME, selected);
  assert.equal(previewEnvironment(root, 12345, 'fixture-secret', configEnv, isolatedHome).CODEBUDDY_HOME, isolatedHome);
  assert.throws(() => previewEnvironment(root, 12346, 'fixture-secret', inherited, 'relative-data'), /absolute path/);
  assert.throws(() => previewEnvironment(root, 12346, 'fixture-secret', { CODEBUDDY_HOME: 'relative' }), /absolute non-root/);
  assert.throws(() => previewEnvironment(root, 12346, 'fixture-secret', {}, path.parse(root).root), /non-root/);
});

for (const configured of [false, true]) {
  test(`starts authenticated bridge, sets configuration route=${!configured}, then reaps owned runtime`, async (t) => {
    const { root, options } = fixture(t);
    const dataDirectory = configured ? options.dataDirectory : path.join(root, '.controlled-e2e');
    const expectedHome = dataDirectory || path.join(root, '.preview-data');
    const code = await startPreview({ ...options, dataDirectory, env: { ...options.env, FIXTURE_CONFIGURED: configured ? '1' : '0' } });
    assert.equal(code, 0);
    const observed = JSON.parse(fs.readFileSync(path.join(root, 'desktop-observed.json'), 'utf8'));
    assert.equal(observed.home, expectedHome);
    assert.equal(observed.workspaceRoot, path.join(root, 'user-workspace'));
    assert.equal(observed.workingDir, observed.workspaceRoot);
    assert.notEqual(observed.workingDir, root);
    assert.ok(fs.statSync(observed.workspaceRoot).isDirectory());
    assert.ok(fs.statSync(path.join(expectedHome, 'state', 'electron-app')).isDirectory());
    assert.ok(fs.statSync(path.join(expectedHome, 'profiles', 'local', 'state', 'electron')).isDirectory());
    assert.equal(observed.preview, '1');
    assert.equal(observed.initialRoute, configured ? null : '/configure-providers');
    assert.equal(observed.protocol, 'true');
    assert.equal(observed.legacyRoot, null);
    assert.equal(observed.electronRunAsNode, null);
    assert.equal(observed.stdinEnded, false, 'Vite must not receive parent stdin EOF during startup');
    const receiptText = fs.readFileSync(path.join(expectedHome, 'logs', 'preview', 'launch.json'), 'utf8');
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.status, 'stopped');
    assert.equal(receipt.artifactCheck.status, 'passed');
    assert.ok(fs.existsSync(path.join(root, 'artifacts-checked.txt')));
    assert.ok(receipt.runtimePid > 0);
    assert.ok(receipt.desktopPid > 0);
    assert.throws(() => process.kill(receipt.runtimePid, 0));
    assert.equal(receiptText.includes('SECRET_KEY'), false);
    assert.equal(receiptText.includes('?token='), false);
  });
}

for (const directory of ['.local', '.local/启动 对抗 空格']) test(`Windows preview shares workspace-local temp files with the native esbuild child (${directory})`, { skip: process.platform !== 'win32' }, async (t) => {
  // The real native executable has the same workspace restrictions as the app.
  const fixtureParent = path.resolve(__dirname, '..', directory);
  fs.mkdirSync(fixtureParent, { recursive: true });
  const { root, options } = fixture(t, fixtureParent);
  const esbuildPath = require.resolve('esbuild', { paths: [path.join(__dirname, '../ui/desktop')] });
  const inherited = { ...options.env, TEMP: os.tmpdir(), TMP: os.tmpdir(), Temp: os.tmpdir() };
  const probe = path.join(root, 'large-transform.cjs');
  fs.writeFileSync(probe, `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const esbuild = require(${JSON.stringify(esbuildPath)});
    esbuild.transform('/*' + 'x'.repeat(2 * 1024 * 1024) + '*/\\nexport const probe = 1;', { loader: 'js' })
      .then(result => fs.writeFileSync(path.join(process.cwd(), 'transform-observed.json'), JSON.stringify({
        temp: os.tmpdir(), code: result.code, exists: fs.statSync(os.tmpdir()).isDirectory(),
      })))
      .catch(error => { console.error(error); process.exitCode = 1; })
      .finally(() => esbuild.stop());
  `);
  const code = await startPreview({ ...options, env: inherited,
    commands: { prepare: [], desktop: { args: [probe], cwd: root } },
  });
  assert.equal(code, 0, code === 0 ? undefined : fs.readFileSync(path.join(options.dataDirectory, 'logs/preview/electron.log'), 'utf8'));
  const observed = JSON.parse(fs.readFileSync(path.join(root, 'transform-observed.json'), 'utf8'));
  const relative = path.relative(path.join(root, '.local', 'preview-temp'), observed.temp);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(observed.exists, true);
  assert.match(observed.code, /export const probe = 1/);
  assert.equal(inherited.TEMP, os.tmpdir(), 'launching must not change its parent environment');
  const receipt = JSON.parse(fs.readFileSync(path.join(options.dataDirectory, 'logs/preview/launch.json'), 'utf8'));
  assert.equal(receipt.temporaryDirectory, observed.temp);
});

test('Windows preview refuses an unusable temp directory before starting backend or desktop', { skip: process.platform !== 'win32' }, async t => {
  const { root, options } = fixture(t);
  const env = previewEnvironment(root, 12345, 'fixture-secret', options.env, options.dataDirectory);
  fs.mkdirSync(path.dirname(env.TEMP), { recursive: true });
  fs.writeFileSync(env.TEMP, 'owned fixture: this is a file, not a directory');
  const backendMarker = path.join(root, 'backend-started.txt');
  fs.writeFileSync(options.serverPath, `require('node:fs').writeFileSync(${JSON.stringify(backendMarker)}, 'unexpected');` + fs.readFileSync(options.serverPath, 'utf8'));
  await assert.rejects(startPreview(options), error => ['EEXIST', 'ENOTDIR'].includes(error.code));
  assert.equal(fs.existsSync(backendMarker), false);
  assert.equal(fs.existsSync(path.join(root, 'desktop-observed.json')), false);
  assert.equal(fs.readFileSync(env.TEMP, 'utf8'), 'owned fixture: this is a file, not a directory');
});

test('failed bridge startup never launches desktop and records a failed receipt', async (t) => {
  const { root, options } = fixture(t);
  fs.writeFileSync(options.serverPath, 'process.exit(7);');
  await assert.rejects(startPreview(options), /exited before readiness/);
  assert.equal(fs.existsSync(path.join(root, 'desktop-observed.json')), false);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.preview-data', 'logs', 'preview', 'launch.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.desktopPid, null);
});

for (const defect of ['missing', 'size', 'checksum']) {
  test(`artifact ${defect} failure stops backend and desktop before startup`, async (t) => {
    const { root, options, toolFile, toolBytes } = fixture(t);
    if (defect === 'missing') fs.unlinkSync(toolFile);
    else fs.writeFileSync(toolFile, Buffer.alloc(toolBytes.length + (defect === 'size' ? 1 : 0), 0x78));
    options.commands.prepare.push({
      cwd: root,
      args: ['-e', `require('node:fs').writeFileSync('preparation-started.txt', 'unexpected')`],
    });
    await assert.rejects(startPreview(options), error => {
      assert.match(error.message, /Preview tool check failed/);
      assert.ok(error.message.includes(path.join(root, 'runtime', 'tools', 'bin', 'fixture-tools.exe')));
      assert.match(error.message, defect === 'missing' ? /ENOENT/ : defect === 'size' ? /identity is invalid/ : /checksum differs/);
      assert.ok(error.message.includes(`${toolBytes.length} bytes`));
      assert.match(error.message, /README.md/);
      assert.match(error.message, /Git 不同步/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(root, 'preparation-started.txt')), process.platform === 'darwin');
    assert.equal(fs.existsSync(path.join(root, 'desktop-observed.json')), false);
    const receipt = JSON.parse(fs.readFileSync(path.join(options.dataDirectory, 'logs', 'preview', 'launch.json'), 'utf8'));
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.runtimePid, null);
    assert.equal(receipt.desktopPid, null);
  });
}
