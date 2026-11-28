import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, readFile, realpath, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { developmentTools, assertCodeNavigationRuntime } from '../development-tools.mjs';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
const prepared = existsSync(path.join(assets, 'serena/serena/cli.py')) &&
  existsSync(path.join(assets, 'pyright/dist/pyright-langserver.js'));

test('Serena bootstrap checks all services and freezes the inspected configuration before activation',
  { skip: !prepared, timeout: 30000 }, async () => {
    const python = path.join(assets, '../py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    const script = fileURLToPath(new URL('./code_navigation_runtime_test.py', import.meta.url));
    const { stdout } = await promisify(execFile)(python, ['-I', '-B', script, process.execPath],
      { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /BOOTSTRAP_CONTRACT_TESTS 10\b/);
  });

test('trusted read-only navigation uses the existing policy while explicit review and replacement still win',
  { timeout: 30000 }, async t => {
    const { createHarnessDriver } = await import('../harness/index.mjs');
    const { Compat } = await import('../compat.mjs');
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-policy-')));
    const driver = await createHarnessDriver({ dataDir: path.join(root, 'native'), cwd: root });
    t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
    for (const scenario of [
      { expected: 'allow', asks: 0 },
      { permission: 'ask_before', expected: 'ask', asks: 2 },
      { permission: 'never_allow', expected: 'deny', asks: 0 },
      { safety: true, expected: 'ask', asks: 2 },
      { replacement: true, expected: 'ask', asks: 2 },
    ]) {
      const original = developmentTools({ cwd: root, dataDir: root }).find(tool => tool.name === 'code_navigation');
      const { annotations, ...unmarked } = original;
      const tool = scenario.replacement ? { ...unmarked, execute() { throw Error('Must not dispatch'); } } : original;
      const { sessionId } = await driver.createSession({ cwd: root,
        provider: { id: 'not-called', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' }, model: 'not-called',
        options: { tools: [tool] } });
      const session = { id: sessionId, cwd: root }, host = Object.create(Compat.prototype);
      Object.assign(host, {
        store: { read: () => ({ toolPermissions: scenario.permission ? { code_navigation: scenario.permission } : {} }),
          readSession: id => id === sessionId ? session : undefined },
        active: new Map(), toolAvailable: async () => true,
        safety: { inspect: async () => ({ requiresApproval: scenario.safety === true }) },
      });
      let asks = 0;
      const decisions = [];
      for (let i = 0; i < 2; i++) await driver.callTool(sessionId, 'code_navigation', { operation: 'overview', path: 'sample.py' }, {
        onToolPolicy: async call => {
          const decision = await host.toolPolicy(session, call);
          decisions.push({ readOnly: call.readOnly, kind: decision.kind });
          return decision.kind === 'allow' ? { kind: 'deny', reason: 'Policy regression stops before subprocess dispatch' } : decision;
        },
        onPermission: async () => { asks++; return false; },
      });
      assert.deepEqual(decisions, Array.from({ length: 2 }, () => ({ readOnly: !scenario.replacement, kind: scenario.expected })));
      assert.equal(asks, scenario.asks);
    }
  });

test('bundled Python code queries work without uv or system Node and retain workspace boundaries',
  { skip: !prepared && 'Prepare Serena and Pyright native payloads first', timeout: 120000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy navigation ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const source = 'def add(left, right):\n    return left + right\n\nresult = add(7, 11)\n';
    await writeFile(path.join(workspace, 'sample.py'), source);
    await writeFile(path.join(root, 'outside.py'), 'private = 1\n');
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
    const tool = developmentTools({ cwd: workspace, dataDir: path.join(root, 'state') })
      .find(tool => tool.name === 'code_navigation');
    await assert.rejects(tool.execute({ operation: 'overview', path: '../outside.py' }), /inside the current workspace/);
    for (const operation of ['overview', 'definition', 'references']) {
      const result = await tool.execute({ operation, path: 'sample.py', symbol: 'add' }, { signal: t.signal });
      assert.notEqual(result.isError, true);
      assert.match(JSON.stringify(result), operation === 'references' ? /result = add/ : /add/);
    }
    assert.equal(await readFile(path.join(workspace, 'sample.py'), 'utf8'), source);
    assert.equal(await readFile(path.join(root, 'outside.py'), 'utf8'), 'private = 1\n');
  });

test('read-only navigation does not run a trusted project activation command',
  { skip: !prepared, timeout: 45000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-project-command-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
    const state = path.join(dataDir, 'tool-runtime', 'serena');
    await mkdir(path.join(workspace, '.serena'), { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(path.join(workspace, 'sample.py'), 'def add(a, b):\n    return a + b\n');
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('activation-ran','unsafe')"`;
    await writeFile(path.join(workspace, '.serena', 'project.yml'),
      `project_name: fixture\nlanguage_servers: [python]\nactivation_command: ${JSON.stringify(command)}\n`);
    await writeFile(path.join(state, 'serena_config.yml'), 'projects: []\ntrusted_project_path_patterns: ["**"]\n');
    const tool = developmentTools({ cwd: workspace, dataDir }).find(tool => tool.name === 'code_navigation');
    const result = await tool.execute({ operation: 'overview', path: 'sample.py' }, { signal: t.signal });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /add/);
    assert.equal(existsSync(path.join(workspace, 'activation-ran')), false, 'A read-only query never authorizes a project command');
  });

test('read-only queries ignore project pickle caches and leave project configuration untouched',
  { skip: !prepared, timeout: 90000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-untrusted-cache-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
    const project = path.join(workspace, '.serena'), marker = path.join(root, 'cache-executed');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(workspace, 'sample.py'), 'def add(a, b):\n    return a + b\n');
    const config = 'project_name: fixture\nlanguage_servers: [python]\n';
    await writeFile(path.join(project, 'project.yml'), config);
    const otherProject = path.join(root, 'previous-project');
    const oldState = path.join(dataDir, 'tool-runtime/serena');
    await mkdir(path.join(otherProject, '.serena'), { recursive: true });
    await mkdir(oldState, { recursive: true });
    await writeFile(path.join(otherProject, '.serena/project.yml'), config);
    const oldConfig = JSON.stringify({ projects: [otherProject], trusted_project_path_patterns: ['**'] });
    await writeFile(path.join(oldState, 'serena_config.yml'), oldConfig);
    const python = path.join(assets, '../py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
    // A harmless marker proves deserialization occurred, even when the cache
    // version is rejected afterwards. No shell or external input is executed.
    await promisify(execFile)(python, ['-I', '-B', '-c',
      'import pathlib,pickle,sys\nclass Marker:\n def __reduce__(self):\n  return eval,("__import__(\'pathlib\').Path("+repr(sys.argv[2])+").write_text(\'executed\')",)\ncache=pathlib.Path(sys.argv[1])/"cache"/"python"\ncache.mkdir(parents=True)\nfor name in ("raw_document_symbols.pkl","document_symbols.pkl","document_symbols_cache_v23-06-25.pkl"):\n (cache/name).write_bytes(pickle.dumps(Marker()))', project, marker],
      { windowsHide: true, timeout: 10000 });
    const tool = developmentTools({ cwd: workspace, dataDir }).find(tool => tool.name === 'code_navigation');
    const result = await tool.execute({ operation: 'overview', path: 'sample.py' }, { signal: t.signal });
    assert.notEqual(result.isError, true);
    assert.match(JSON.stringify(result), /add/);
    assert.equal(existsSync(marker), false, 'A read-only query must never deserialize project-owned pickle caches');
    assert.equal(await readFile(path.join(project, 'project.yml'), 'utf8'), config,
      'Loading a project must not migrate or fill in its YAML on disk');
    if (process.platform === 'win32' && process.arch === 'x64') {
      const { createHarnessDriver } = await import('../harness/index.mjs');
      const driver = await createHarnessDriver({ dataDir, cwd: workspace });
      t.after(() => driver.close());
      const { sessionId } = await driver.createSession({ cwd: workspace,
        provider: { id: 'not-called', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' }, model: 'not-called',
        options: { tools: [tool] } });
      let asks = 0;
      const native = await driver.callTool(sessionId, 'code_navigation', { operation: 'overview', path: 'sample.py' }, {
        onPermission: async () => { asks++; return false; },
      });
      assert.equal(native.isError, false, JSON.stringify(native));
      assert.match(JSON.stringify(native.content), /add/);
      assert.equal(asks, 0);
      assert.equal(existsSync(marker), false, 'The persistent native entry must not deserialize project caches either');
      assert.equal(await readFile(path.join(project, 'project.yml'), 'utf8'), config);
      await driver.close();
    }
    assert.equal(await readFile(path.join(otherProject, '.serena/project.yml'), 'utf8'), config,
      'The factory must not reload and migrate projects registered in the old global profile');
    assert.equal(await readFile(path.join(oldState, 'serena_config.yml'), 'utf8'), oldConfig);
  });

test('a linked project configuration is rejected without modifying the external target',
  { skip: process.platform !== 'win32' || !prepared, timeout: 45000 }, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-linked-config-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'), outside = path.join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(workspace, 'sample.py'), 'def add(a, b):\n    return a + b\n');
    const config = 'project_name: external\nlanguage_servers: [python]\n';
    await writeFile(path.join(outside, 'project.yml'), config);
    await fsPromises.symlink(outside, path.join(workspace, '.serena'), 'junction');
    const tool = developmentTools({ cwd: workspace, dataDir: path.join(root, 'data') }).find(tool => tool.name === 'code_navigation');
    await assert.rejects(tool.execute({ operation: 'overview', path: 'sample.py' }, { signal: t.signal }), /configuration must stay inside/);
    assert.equal(await readFile(path.join(outside, 'project.yml'), 'utf8'), config);
    assert.deepEqual((await fsPromises.readdir(outside)).sort(), ['project.yml']);
  });


test('missing and incomplete navigation payloads fail before spawning a language server', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'navigation-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(assertCodeNavigationRuntime(root), error =>
    error.code === 'CODE_NAVIGATION_UNAVAILABLE' && /Serena.*Pyright/.test(error.message));
  for (const file of ['py/dependencies/python/' + (process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    'assets/code-navigation.py', 'assets/code_navigation_runtime.py', 'assets/serena/serena/cli.py', 'assets/serena/mcp/__init__.py']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'fixture');
  }
  await assert.rejects(assertCodeNavigationRuntime(root), { code: 'CODE_NAVIGATION_UNAVAILABLE' });
  const pyright = path.join(root, 'assets/pyright/dist/pyright-langserver.js');
  await mkdir(path.dirname(pyright), { recursive: true });
  await writeFile(pyright, 'fixture');
  await assert.doesNotReject(assertCodeNavigationRuntime(root));
});

test('a directory overview gives a specific-file correction without starting Serena', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-directory-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = developmentTools({ cwd: root, dataDir: path.join(root, 'state') }).find(t => t.name === 'code_navigation');
  await assert.rejects(tool.execute({ operation: 'overview', path: root }), /source file.*directory/i);
});


test('the actual navigation tool checks missing payloads before subprocess dispatch', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-entry-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'sample.py'), 'def add(a, b):\n    return a + b\n');
  const missing = path.join(assets, 'serena/serena/cli.py');
  const original = fsPromises.stat;
  t.mock.method(fsPromises, 'stat', async (file, ...args) => {
    if (path.resolve(file) === missing) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return original(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const tool = developmentTools({ cwd: root, dataDir: path.join(root, 'state') }).find(t => t.name === 'code_navigation');
  await assert.rejects(tool.execute({ operation: 'overview', path: 'sample.py' }), { code: 'CODE_NAVIGATION_UNAVAILABLE' });
});

test('a reused native navigation connection observes edits before the next definition and references query',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' || !prepared, timeout: 45000 }, async t => {
    const { createHarnessDriver } = await import('../harness/index.mjs');
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-index-refresh-')));
    const dataDir = path.join(root, 'data'), source = path.join(root, 'sample.py');
    const driver = await createHarnessDriver({ dataDir, cwd: root });
    t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
    await writeFile(source, 'def add(a, b):\n    return a + b\n\nresult = add(7, 11)\n');
    const { sessionId } = await driver.createSession({ cwd: root,
      provider: { id: 'not-called', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' }, model: 'not-called',
      options: { tools: developmentTools({ cwd: root, dataDir }) },
    });
    const query = (operation, symbol) => driver.callTool(sessionId, 'code_navigation', { operation, path: 'sample.py', symbol }, { onPermission: async () => true });
    const before = await query('overview', 'add');
    assert.equal(before.isError, false, JSON.stringify(before));
    assert.match(JSON.stringify(before.content), /add/);
    const changed = 'def multiply(a, b):\n    return a * b\n\nresult = multiply(4, 5)\n';
    await writeFile(source, changed);
    for (const operation of ['definition', 'references']) {
      const after = await query(operation, 'multiply');
      assert.equal(after.isError, false, JSON.stringify(after));
      assert.match(JSON.stringify(after.content), operation === 'references' ? /result = multiply/ : /multiply/);
    }
    assert.equal(await readFile(source, 'utf8'), changed);
  });

test('concurrent native navigation sessions keep different projects and their source gates separate',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' || !prepared, timeout: 45000 }, async t => {
    const { createHarnessDriver } = await import('../harness/index.mjs');
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-project-isolation-')));
    const dataDir = path.join(root, 'data'), first = path.join(root, 'first'), second = path.join(root, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    await writeFile(path.join(first, 'sample.py'), 'def add(a, b):\n    return a + b\n\nresult = add(7, 11)\n');
    await writeFile(path.join(second, 'sample.py'), 'def multiply(a, b):\n    return a * b\n\nresult = multiply(4, 5)\n');
    const driver = await createHarnessDriver({ dataDir, cwd: root });
    t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
    const sessions = await Promise.all([first, second].map(async cwd => (await driver.createSession({ cwd,
      provider: { id: 'not-called', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' }, model: 'not-called',
      options: { tools: developmentTools({ cwd, dataDir }) },
    })).sessionId));
    const query = (id, operation, symbol, path = 'sample.py') => driver.callTool(id, 'code_navigation', { operation, symbol, path }, { onPermission: async () => true });
    const before = await Promise.all([query(sessions[0], 'overview', 'add'), query(sessions[1], 'overview', 'multiply')]);
    for (const result of before) assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(before[0].content), /add/); assert.doesNotMatch(JSON.stringify(before[0].content), /multiply/);
    assert.match(JSON.stringify(before[1].content), /multiply/); assert.doesNotMatch(JSON.stringify(before[1].content), /"add"/);
    assert.equal((await query(sessions[0], 'overview', 'multiply', '../second/sample.py')).isError, true);
    const references = await Promise.all([query(sessions[0], 'references', 'add'), query(sessions[1], 'references', 'multiply')]);
    for (const result of references) assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(references[0].content), /result = add/);
    assert.match(JSON.stringify(references[1].content), /result = multiply/);
  });

test('a prepared TypeScript pair serves real queries from the controlled host cache without permission prompts',
  { skip: !prepared || process.platform !== 'win32' || process.arch !== 'x64' || !process.env.CODEBUDDY_TEST_TS_LSP,
    timeout: 60000 }, async t => {
    const { createHarnessDriver } = await import('../harness/index.mjs');
    const { Compat } = await import('../compat.mjs');
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'navigation-typescript-')));
    const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    await writeFile(path.join(workspace, 'main.ts'), 'import { add } from "./math";\nexport const result = add(4, 5);\n');
    await writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'commonjs' } }));
    await cp(process.env.CODEBUDDY_TEST_TS_LSP, path.join(dataDir, 'tool-runtime/serena/language_servers/static/TypeScriptLanguageServer/ts-lsp'), { recursive: true });
    const driver = await createHarnessDriver({ dataDir: path.join(root, 'native'), cwd: workspace });
    t.after(async () => { await driver.close(); await rm(root, { recursive: true, force: true }); });
    const { sessionId } = await driver.createSession({ cwd: workspace,
      provider: { id: 'not-called', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' }, model: 'not-called',
      options: { tools: developmentTools({ cwd: workspace, dataDir }) } });
    const session = { id: sessionId, cwd: workspace }, host = Object.create(Compat.prototype);
    Object.assign(host, {
      store: { read: () => ({ toolPermissions: {} }), readSession: id => id === sessionId ? session : undefined },
      active: new Map(), toolAvailable: async () => true, safety: { inspect: async () => ({ requiresApproval: false }) },
    });
    let asks = 0;
    for (const operation of ['overview', 'definition', 'references']) {
      const result = await driver.callTool(sessionId, 'code_navigation', { operation, path: 'math.ts', symbol: 'add' }, {
        onToolPolicy: call => host.toolPolicy(session, call), onPermission: async () => { asks++; return false; },
      });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), operation === 'references' ? /main\.ts/ : /add/);
    }
    assert.equal(asks, 0);
  });
