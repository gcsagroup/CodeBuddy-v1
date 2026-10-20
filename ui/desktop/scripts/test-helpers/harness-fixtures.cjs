const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '../../../..');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-harness-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Run the real entry point with filesystem fixtures and intercepted external
// processes. Tests must never build, install or start the user's application.
function windowsBuild(t, { args = [], failStep } = {}) {
  const root = temporaryRoot(t);
  const desktop = path.join(root, 'ui/desktop');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(desktop, { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime/py'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime/py/runtime.json'), '{}');
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const manifest = JSON.stringify({ engine: 'deepseek-harness', schemaVersion: 1, files: [] });
  const calls = [];
  const writeStage = () => {
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'manifest.json'), manifest);
  };
  const mockFs = { ...fs, readFileSync(file, ...rest) {
    if (file === path.join(root, 'forge/package.json')) return JSON.stringify({ bin: { 'electron-forge': 'forge.js' } });
    return fs.readFileSync(file, ...rest);
  } };
  const load = name => {
    if (name === 'node:fs') return mockFs;
    if (name === 'node:child_process') return { spawnSync(executable, argv, options) {
      calls.push({ kind: 'run', executable, args: argv, options });
      return { status: failStep?.(argv) ? 1 : 0 };
    } };
    if (name === './stage-harness-distribution.cjs') return { async stageHarness() {
      calls.push({ kind: 'stage' }); writeStage();
    } };
    if (name === './windows-installer-tools.cjs') return {
      stageInstallerTools() { return path.join(root, 'vendor'); },
      assertSquirrelRuntimePaths() { return 10; },
      async finalizeInstaller(options) { calls.push({ kind: 'finalize', options }); return 'fixture-installer'; },
    };
    if (name === './windows-wizard-installer.cjs') return {
      ...require(path.join(repoRoot, 'scripts/windows-wizard-installer.cjs')),
      resolveCompiler() { return { compiler: 'fixture-ISCC' }; },
      makeWizardInstaller(options) { calls.push({ kind: 'wizard', options }); return {}; },
    };
    return require(name);
  };
  load.resolve = name => name === '@electron-forge/cli/package.json'
    ? path.join(root, 'forge/package.json') : path.join(root, name);
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/build-harness-windows.cjs'), 'utf8');
  const entry = source.lastIndexOf('\nmain().catch(');
  if (entry < 0) throw Error('Update the build fixture for the changed CLI entry point');
  const module = { exports: {} };
  vm.runInNewContext(source.slice(0, entry) + '\nmodule.exports = main;', {
    require: load, module, __dirname: path.join(root, 'scripts'), console: { log() {} },
    process: { platform: 'win32', versions: { node: '24.0.0' }, execPath: process.execPath,
      argv: ['node', 'build-harness-windows.cjs', stage, ...args], env: { LOCALAPPDATA: path.join(root, 'local') } },
  });
  function packaged(relative = 'out/CodeBuddy-win32-x64', contents = manifest) {
    writeStage();
    const app = path.join(desktop, relative);
    fs.mkdirSync(path.join(app, 'resources/harness-distribution'), { recursive: true });
    fs.writeFileSync(path.join(app, 'CodeBuddy.exe'), 'fixture');
    fs.writeFileSync(path.join(app, 'resources/harness-distribution/manifest.json'), contents);
    return app;
  }
  return { root, desktop, stage, calls, packaged, run: module.exports };
}

function harnessService(t) {
  const root = temporaryRoot(t);
  const resourcesPath = path.join(root, 'resources');
  const distribution = path.join(resourcesPath, 'harness-distribution');
  fs.mkdirSync(path.join(distribution, 'node'), { recursive: true });
  fs.writeFileSync(path.join(distribution, 'manifest.json'), JSON.stringify({ engine: 'deepseek-harness', schemaVersion: 1 }));
  fs.writeFileSync(path.join(distribution, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), 'fixture');
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), connected: true });
  const calls = [], timers = new Map();
  child.send = message => calls.push({ kind: 'send', message });
  child.kill = () => { calls.push({ kind: 'kill' }); child.emit('exit', 0); };
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(repoRoot, 'ui/desktop/src/harnessService.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    exports, process: { platform: process.platform, env: {} }, URL,
    setTimeout(fn, delay) { const key = Symbol(); timers.set(key, { fn, delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    require(name) {
      if (name === 'node:child_process') return { spawn(...args) { calls.push({ kind: 'spawn', args }); return child; } };
      return require(name);
    },
  });
  let unexpected = 0;
  const ready = exports.startHarnessService({ resourcesPath, home: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'), onUnexpectedExit: () => unexpected++ });
  return { ready, child, calls, timers, root, unexpected: () => unexpected,
    announce(url = 'http://127.0.0.1:4567') { child.emit('message', { type: 'ready', engine: 'deepseek-harness', url, pid: 123 }); } };
}

module.exports = { temporaryRoot, windowsBuild, harnessService };
