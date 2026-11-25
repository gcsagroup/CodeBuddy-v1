import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createSourceStatus } from '../source-status.mjs';

const run = promisify(execFile), workerFlag = '--tool-timeout-worker', declaredBudgetMs = 1800;
async function identity() {
  const status = await (await createSourceStatus(resolve('runtime'), { intervalMs: 0 }))();
  return { revision: (await run('git', ['rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(),
    sourceHash: status.sourceHash,
    profileSha256: createHash('sha256').update(await readFile(new URL('../harness/profile.mjs', import.meta.url))).digest('hex') };
}
async function readReady(path) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(10);
  }
  throw Error('The actual managed stall did not publish its PID file');
}
function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return true; }
}

async function collect(root) {
  await import('../harness/index.mjs');
  const require = createRequire(new URL('../harness/package.json', import.meta.url));
  const { ToolRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')));
  const searchRequire = createRequire(require.resolve('@deepseek-ai/dsh-tool-fs-search'));
  const rgPath = searchRequire('@vscode/ripgrep').rgPath;
  const { default: WindowsSubprocessRuntime } = await import('../harness/windows-shell-output.mjs');
  const { createHarnessDriver } = await import('../harness/index.mjs');
  const originalRegister = ToolRuntime.prototype.register, originalSpawn = WindowsSubprocessRuntime.prototype.spawn;
  const definitions = [], managed = [];
  const stall = join(root, 'stall.cjs');
  await writeFile(stall, 'const fs=require("node:fs"),{spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"});fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,childPid:child.pid}));setInterval(()=>{},1000);');
  ToolRuntime.prototype.register = function (definition) {
    if (definition.name === 'glob' || definition.name === 'pwsh') definitions.push({ name: definition.name, originalTimeoutMs: definition.timeoutMs });
    return originalRegister.call(this, definition.name === 'glob' ? { ...definition, timeoutMs: declaredBudgetMs } : definition);
  };
  WindowsSubprocessRuntime.prototype.spawn = function (spec) {
    if (resolve(spec.argv[0]).toLowerCase() !== resolve(rgPath).toLowerCase()) return originalSpawn.call(this, spec);
    const pidFile = join(root, 'stall-' + managed.length + '.json');
    const handle = originalSpawn.call(this, { ...spec, argv: [process.execPath, stall, pidFile] });
    managed.push({ originalArgv: [...spec.argv], pidFile, handle });
    return handle;
  };
  let driver;
  try {
    driver = await createHarnessDriver({ dataDir: join(root, 'native'), cwd: root });
    const session = await driver.createSession({ cwd: root, provider: { id: 'offline', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }, model: 'offline' });
    await driver.permissions(session.sessionId, { preset: 'read-only' });
    await writeFile(join(root, 'fallback.txt'), 'CONTINUED_AFTER_TOOL_DEADLINE');
    const stop = new AbortController(); let lateCallerFired = false;
    const laterCancel = setTimeout(() => { lateCallerFired = true; stop.abort(); }, 4500);
    const firstStarted = performance.now();
    let first;
    try { first = await driver.callTool(session.sessionId, 'glob', { pattern: '*', path: root }, { signal: stop.signal, onPermission: () => false }); }
    finally { clearTimeout(laterCancel); }
    const firstElapsedMs = performance.now() - firstStarted;
    assert.equal(managed.length, 1, 'The native glob must dispatch exactly one real managed subprocess');
    const firstPids = await readReady(managed[0].pidFile);
    const firstRangeExited = await managed[0].handle.waitForExit(AbortSignal.timeout(5000));
    const firstProcessesExited = [firstPids.pid, firstPids.childPid].every(exited);
    const continued = await driver.callTool(session.sessionId, 'read', { file_path: 'fallback.txt' }, { onPermission: () => false });

    const userStop = new AbortController(), cancelStarted = performance.now();
    const pending = driver.callTool(session.sessionId, 'glob', { pattern: '*', path: root }, { signal: userStop.signal, onPermission: () => false });
    pending.catch(() => {});
    while (managed.length < 2 && performance.now() - cancelStarted < 5000) await delay(10);
    assert.equal(managed.length, 2);
    const cancelledPids = await readReady(managed[1].pidFile);
    const userCancelledAtMs = performance.now() - cancelStarted;
    userStop.abort();
    const cancelled = await pending;
    const cancelledRangeExited = await managed[1].handle.waitForExit(AbortSignal.timeout(5000));
    const cancelledProcessesExited = [cancelledPids.pid, cancelledPids.childPid].every(exited);

    const pwsh = await driver.callTool(session.sessionId, 'pwsh', { command: 'Start-Sleep -Seconds 30', description: 'Bound isolated native shell wait', timeoutMs: 900 }, { onPermission: () => false });
    return { definitions, declaredBudgetMs, first: { result: first, elapsedMs: firstElapsedMs, lateCallerFired,
      rangeExited: firstRangeExited, processesExited: firstProcessesExited, pids: firstPids, originalArgv: managed[0].originalArgv }, continued,
      userCancel: { result: cancelled, userCancelledAtMs, rangeExited: cancelledRangeExited, processesExited: cancelledProcessesExited, pids: cancelledPids }, pwsh };
  } finally {
    if (driver) await driver.close();
    ToolRuntime.prototype.register = originalRegister; WindowsSubprocessRuntime.prototype.spawn = originalSpawn;
  }
}

if (process.argv.includes(workerFlag)) {
  const root = process.argv[process.argv.indexOf(workerFlag) + 1], before = await identity();
  const observations = await collect(root), after = await identity();
  assert.deepEqual(after, before, 'Profile changed during the actual Driver probes');
  process.stdout.write(JSON.stringify({ identity: before, observations }));
} else {
  test('real Driver enforces declared tool deadlines without changing caller cancellation or pwsh budgets', {
    skip: process.platform !== 'win32', timeout: 30000,
  }, async t => {
    const base = await mkdtemp(join(tmpdir(), 'codebuddy-tool-timeout-'));
    const root = join(base, 'work'); await mkdir(root);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), workerFlag, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close'), stdout = [], stderr = [];
    child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
    let timedOut = false, killing;
    const kill = () => killing ??= run(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
    const watchdog = setTimeout(() => { timedOut = true; void kill().catch(() => {}); }, 25000);
    t.after(async () => {
      clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) await kill();
      await closed; if (killing) await killing;
      const owned = relative(tmpdir(), resolve(base));
      assert.ok(owned.startsWith('codebuddy-tool-timeout-') && !isAbsolute(owned) && !owned.includes(sep));
      await rm(base, { recursive: true, force: true });
    });
    const [exitCode] = await closed; clearTimeout(watchdog);
    const errorText = Buffer.concat(stderr).toString('utf8');
    assert.equal(timedOut, false, errorText); assert.equal(exitCode, 0, errorText + Buffer.concat(stdout).toString('utf8'));
    const evidence = JSON.parse(Buffer.concat(stdout).toString('utf8')), data = evidence.observations;
    t.diagnostic('actual source and native receipts: ' + JSON.stringify(evidence));
    await t.test('glob returns TOOL_TIMEOUT at its declared budget and its managed parent and descendant exit', () => {
      assert.equal(data.definitions.find(item => item.name === 'glob').originalTimeoutMs, 30000);
      assert.equal(data.first.result.error?.info?.code, 'TOOL_TIMEOUT');
      assert.equal(data.first.lateCallerFired, false);
      assert.ok(data.first.elapsedMs >= declaredBudgetMs && data.first.elapsedMs < 3500, String(data.first.elapsedMs));
      assert.equal(data.first.rangeExited, true); assert.equal(data.first.processesExited, true);
    });
    await t.test('the same real session can read after the timed-out search', () => {
      assert.equal(data.continued.isError, false);
      assert.match(JSON.stringify({ value: data.continued.value, content: data.continued.content }), /CONTINUED_AFTER_TOOL_DEADLINE/);
    });
    await t.test('a user cancellation that wins first remains SEARCH_ABORTED', () => {
      assert.ok(data.userCancel.userCancelledAtMs < declaredBudgetMs, String(data.userCancel.userCancelledAtMs));
      assert.equal(data.userCancel.result.error?.info?.code, 'SEARCH_ABORTED');
      assert.equal(data.userCancel.rangeExited, true); assert.equal(data.userCancel.processesExited, true);
    });
    await t.test('pwsh has no definition deadline and keeps its native per-call timeout', () => {
      assert.equal(data.definitions.find(item => item.name === 'pwsh').originalTimeoutMs, undefined);
      assert.equal(data.pwsh.value?.timedOut, true, JSON.stringify(data.pwsh));
      assert.equal(data.pwsh.value?.timeoutMs, 900);
      assert.notEqual(data.pwsh.error?.info?.code, 'TOOL_TIMEOUT');
    });
  });
}
