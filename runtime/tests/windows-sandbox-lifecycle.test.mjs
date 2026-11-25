import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, access, writeFile, readFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessDriver } from '../harness/index.mjs';
import { WindowsSessionTemps } from '../harness/windows-session-temps.mjs';
import WindowsSubprocessRuntime from '../harness/windows-shell-output.mjs';
import '../harness/index.mjs';

const require = createRequire(new URL('../harness/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { default: WindowsSandboxProvider } = await import('../harness/windows-sandbox.mjs');

async function until(check, message) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw Error(message);
}

async function removeFixtureTemp(dir) {
  const child = relative(tmpdir(), resolve(dir));
  assert.ok(child.startsWith('dsh-') && !isAbsolute(child) && !child.includes(sep));
  await rm(dir, { recursive: true, force: true });
}

async function commandUsingTemp(t, sandbox, root, sessionId) {
  const source = `const fs=require('node:fs'),p=require('node:path');
    const file=p.join(process.env.TEMP,'retained.txt'); fs.writeFileSync(file,'before');
    console.log(JSON.stringify({temp:process.env.TEMP}));
    const timer=setTimeout(()=>process.exit(3),15000);
    process.stdin.once('data',()=>{try{if(fs.readFileSync(file,'utf8')!=='before')throw Error('lost');
      fs.writeFileSync(file,'after');console.log('TEMP_RETAINED');clearTimeout(timer);process.exit(0)
    }catch(e){console.error(e.code||e.message);process.exit(2)}});`;
  const confined = await sandbox.confine([process.execPath, '-e', source], { mode: 'workspace-write', workspaceRoot: root, sessionId });
  const child = spawn(confined.argv[0], confined.argv.slice(1), { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  const ready = await until(() => {
    const line = output.split('\n')[0]; return line.endsWith('}') && JSON.parse(line);
  }, 'Restricted command did not publish TEMP: ' + errors);
  return { ...ready, child, closed, async continue() {
    child.stdin.end('continue\n');
    const [code] = await closed;
    assert.equal(code, 0, errors); assert.match(output, /TEMP_RETAINED/);
  } };
}

test('a running restricted command retains its session TEMP across preparation process eviction', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-temp-lifetime-'));
  const root = join(base, 'work'); await mkdir(root);
  const context = new Context(); await context.plugin(WindowsSandboxProvider, {});
  let child, closed;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await context.fiber.dispose();
    await rm(base, { recursive: true, force: true });
  });
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'temp-lifetime' };
  const source = `const fs=require('node:fs'),p=require('node:path');
    const file=p.join(process.env.TEMP,'retained.txt'); fs.writeFileSync(file,'before');
    console.log(JSON.stringify({temp:process.env.TEMP}));
    const timer=setTimeout(()=>process.exit(3),15000);
    process.stdin.once('data',()=>{try{if(fs.readFileSync(file,'utf8')!=='before')throw Error('lost');
      fs.writeFileSync(file,'after');console.log('TEMP_RETAINED');clearTimeout(timer);process.exit(0)
    }catch(e){console.error(e.code||e.message);process.exit(2)}});`;
  const confined = await context.sandbox.confine([process.execPath, '-e', source], policy);
  const worker = context.sandbox.slots.get(context.sandbox.workerKey(root, policy.mode)).worker;
  child = spawn(confined.argv[0], confined.argv.slice(1), { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  closed = once(child, 'close');
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Restricted command did not publish TEMP: ' + errors)), 5000);
    child.stdout.on('data', () => {
      const line = output.split('\n')[0];
      if (line.endsWith('}')) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  for (let index = 0; index < 4; index++) {
    const other = join(base, `other-${index}`); await mkdir(other);
    await context.sandbox.confine(['pwsh.exe'], { mode: 'read-only', workspaceRoot: other, sessionId: `other-${index}` });
  }
  await worker.closed;
  await access(join(ready.temp, 'retained.txt'));
  child.stdin.end('continue\n');
  const [code] = await closed;
  assert.equal(code, 0, errors);
  assert.match(output, /TEMP_RETAINED/);
  const next = await context.sandbox.confine([process.execPath, '-e', ''], policy);
  assert.equal(next.argv[next.argv.indexOf('--temp') + 1], ready.temp, 'workspace preparation eviction must retain the session TEMP identity');
});

test('a successful native IPC delivered after its deadline cannot bypass the expired timer', {
  skip: process.platform !== 'win32', timeout: 10000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-deadline-delivery-'));
  const context = new Context(); await context.plugin(WindowsSandboxProvider, {});
  t.after(async () => { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const sandbox = context.sandbox;
  const policy = { mode: 'read-only', workspaceRoot: root, sessionId: 'delivery-deadline' };
  await sandbox.confine(['pwsh.exe'], policy);
  sandbox.internals.preparationTimeoutMs = 100;
  const worker = [...sandbox.slots.values()][0].worker;
  const emit = worker.child.emit;
  let delayed = false;
  worker.child.emit = function (event, ...args) {
    if (event === 'message' && args[0]?.result && !delayed) {
      delayed = true;
      // Hold this real IPC callback across the deadline. The timer is due but
      // cannot run until this callback yields: success must check time itself.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
    return emit.call(this, event, ...args);
  };
  try {
    await assert.rejects(sandbox.confine(['pwsh.exe'], policy), error => error.code === 'SANDBOX_UNAVAILABLE' && /deadline/.test(error.message));
    assert.equal(delayed, true, 'the regression must exercise successful native IPC, not startup timeout');
  } finally { worker.child.emit = emit; }
});

for (const disruption of ['cancellation', 'preparation crash', 'resource owner crash']) {
  test(`a running command retains TEMP through ${disruption} without reusing a crashed resource owner`, {
    skip: process.platform !== 'win32', timeout: 30000,
  }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'codebuddy-temp-disruption-'));
    const context = new Context(); await context.plugin(WindowsSandboxProvider, {});
    const sandbox = context.sandbox;
    let command;
    t.after(async () => {
      if (command?.child.exitCode === null && command.child.signalCode === null) { command.child.kill(); await command.closed; }
      await context.fiber.dispose();
      if (disruption === 'resource owner crash' && command) await removeFixtureTemp(command.temp);
      await rm(root, { recursive: true, force: true });
    });
    command = await commandUsingTemp(t, sandbox, root, 'survivor');
    const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'survivor' };
    const worker = sandbox.slots.get(sandbox.workerKey(root, policy.mode)).worker;
    if (disruption === 'cancellation') {
      const file = join(root, 'new.txt'); await writeFile(file, 'new');
      const abort = new AbortController();
      const pending = sandbox.confine(['pwsh.exe'], policy, abort.signal);
      const rejected = assert.rejects(pending, error => error.name === 'AbortError');
      await until(() => worker.phase === 'existing-file-labels', 'The cancellation did not reach label preparation');
      abort.abort(); await rejected; await worker.closed;
    } else if (disruption === 'preparation crash') { worker.child.kill(); await worker.closed; }
    else {
      const owner = sandbox.sessionTemps.worker;
      owner.child.kill(); await owner.closed;
    }
    await command.continue();
    const next = await sandbox.confine(['pwsh.exe'], policy);
    const nextTemp = next.argv[next.argv.indexOf('--temp') + 1];
    if (disruption === 'resource owner crash') assert.notEqual(nextTemp, command.temp);
    else assert.equal(nextTemp, command.temp);
  });
}

test('subprocess quiescence seals commands with previously prepared argv before waiting for native exit', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-process-admission-'));
  const context = new Context(); await context.plugin(WindowsSubprocessRuntime, {});
  t.after(async () => { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const owner = context.subprocess;
  const handle = owner.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: root,
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 100 });
  const prepared = { argv: [process.execPath, '-e', "require('fs').writeFileSync('must-not-start.txt','bad')"], cwd: root,
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 100 };
  const draining = owner.quiesce();
  assert.equal(owner.quiesce(), draining, 'native and Host teardown must share a single barrier');
  assert.throws(() => owner.spawn(prepared), /closing/);
  await draining;
  assert.equal(await handle.waitForExit(), true);
  await assert.rejects(access(join(root, 'must-not-start.txt')));
});

test('cancelling one TEMP waiter preserves another waiter and already-issued session capabilities', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-temp-waiters-'));
  const context = new Context(); await context.plugin(WindowsSandboxProvider, {});
  let command, owner, send;
  t.after(async () => {
    if (owner && send) owner.child.send = send;
    if (command?.child.exitCode === null && command.child.signalCode === null) { command.child.kill(); await command.closed; }
    await context.fiber.dispose(); await rm(root, { recursive: true, force: true });
  });
  const sandbox = context.sandbox;
  command = await commandUsingTemp(t, sandbox, root, 'existing');
  const resources = sandbox.sessionTemps;
  owner = resources.worker; send = owner.child.send;
  const held = [];
  owner.child.send = function (...args) {
    if (args[0].type === 'acquire') { held.push(args); return true; }
    return send.apply(this, args);
  };
  const policy = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'new-session' };
  const stop = new AbortController();
  const first = resources.acquire(policy, stop.signal, performance.now() + 2000);
  const rejected = assert.rejects(first, error => error.name === 'AbortError');
  const second = resources.acquire(policy, undefined, performance.now() + 2000);
  assert.equal(held.length, 1, 'same-key callers must share one bounded resource allocation');
  stop.abort(); await rejected;
  assert.equal([...resources.pending.values()][0].waiters.size, 1);
  const existing = await resources.acquire({ ...policy, sessionId: 'existing' }, undefined, performance.now() + 1000);
  assert.equal(existing.dir, command.temp, 'an unrelated stalled allocation cannot hold a ready capability');
  send.apply(owner.child, held.shift());
  assert.notEqual((await second).dir, command.temp);
  assert.equal(resources.worker, owner);
  await command.continue();
});

test('a stalled TEMP resource operation has a bounded owner generation while running commands retain old grants', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-temp-watchdog-'));
  const context = new Context(); await context.plugin(WindowsSandboxProvider, {});
  let command;
  t.after(async () => {
    if (command?.child.exitCode === null && command.child.signalCode === null) { command.child.kill(); await command.closed; }
    await context.fiber.dispose();
    if (command) await removeFixtureTemp(command.temp);
    await rm(root, { recursive: true, force: true });
  });
  const sandbox = context.sandbox;
  command = await commandUsingTemp(t, sandbox, root, 'existing');
  const resources = sandbox.sessionTemps, owner = resources.worker, send = owner.child.send;
  resources.internals.resourceTimeoutMs = 100;
  // Fault injection holds real resource IPC, not the host event loop. This
  // verifies recovery without deliberately hanging a Win32 system call.
  owner.child.send = function (...args) {
    return args[0].type === 'acquire' ? true : send.apply(this, args);
  };
  await assert.rejects(resources.acquire({ workspaceRoot: root, sessionId: 'blocked' }, undefined, performance.now() + 2000),
    /resource operation deadline expired/);
  await owner.closed;
  assert.equal(resources.pending.size, 0);
  await command.continue();
  resources.internals.resourceTimeoutMs = 2000;
  const next = await sandbox.confine(['pwsh.exe'], { mode: 'workspace-write', workspaceRoot: root, sessionId: 'existing' });
  assert.notEqual(next.argv[next.argv.indexOf('--temp') + 1], command.temp);
  assert.notEqual(resources.worker, owner);
});

test('ordinary shutdown gives slow session TEMP disposal its resource-operation budget', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codebuddy-temp-slow-disposal-'));
  const resources = new WindowsSessionTemps();
  const capability = await resources.acquire({ workspaceRoot: root, sessionId: 'slow-disposal' }, undefined, performance.now() + 5000);
  t.after(async () => {
    await resources.close(); await removeFixtureTemp(capability.dir); await rm(root, { recursive: true, force: true });
  });
  const worker = resources.worker, send = worker.child.send;
  // Hold only the disposal IPC to model a slower clean exit without building a
  // large TEMP tree. The real resource owner must still remove its directory.
  worker.child.send = function (message, ...args) {
    if (message.type !== 'dispose') return send.call(this, message, ...args);
    setTimeout(() => { if (this.connected) send.call(this, message, ...args); }, 3000);
    return true;
  };
  await resources.close(true); await worker.closed;
  await assert.rejects(access(capability.dir), { code: 'ENOENT' });
});

test('Host shutdown waits for the replacement subprocess owner before releasing session TEMP', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-host-owner-reload-'));
  const root = join(base, 'work'); await mkdir(root);
  const confine = WindowsSandboxProvider.prototype.confine;
  const resourceClose = WindowsSessionTemps.prototype.close;
  const nativePrototype = Object.getPrototypeOf(WindowsSubprocessRuntime.prototype);
  const nativeDrain = nativePrototype.disposeManagedProcesses;
  let loader, information, entered = false, observed = false;
  WindowsSandboxProvider.prototype.confine = function (...args) {
    loader = this.ctx.loader;
    return confine.apply(this, args);
  };
  const driver = await createHarnessDriver({ dataDir: join(base, 'data'), cwd: root });
  t.after(async () => {
    WindowsSandboxProvider.prototype.confine = confine;
    WindowsSessionTemps.prototype.close = resourceClose;
    nativePrototype.disposeManagedProcesses = nativeDrain;
    await driver.close(); await rm(base, { recursive: true, force: true });
  });
  const { sessionId } = await driver.createSession({ cwd: root, model: 'unused', provider: {
    id: 'unused', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only',
  } });
  await driver.callTool(sessionId, 'pwsh', { command: 'Write-Output CAPTURE', description: 'Capture the real Host loader' }, { onPermission: () => true });
  WindowsSandboxProvider.prototype.confine = confine;
  const entry = [...loader.entries()].find(entry => entry.options.id === 'subprocess');
  assert.ok(entry);
  await entry.update({ disabled: true }); await loader.await();
  await entry.update({ disabled: false }); await loader.await();
  nativePrototype.disposeManagedProcesses = async function (...args) {
    entered = true;
    // The native range is real; only its teardown scheduling is delayed.
    // A stale boot-time owner reference would release TEMP during this gap.
    await delay(250);
    return nativeDrain.apply(this, args);
  };
  WindowsSessionTemps.prototype.close = async function (cleanup) {
    if (cleanup && information) {
      assert.equal(entered, true);
      assert.throws(() => process.kill(information.pid, 0));
      await access(join(information.temp, 'retained.txt'));
      observed = true;
    }
    return resourceClose.call(this, cleanup);
  };
  const result = await driver.callTool(sessionId, 'pwsh', {
    command: "$info=@{temp=$env:TEMP;pid=$PID}|ConvertTo-Json -Compress;[IO.File]::WriteAllText((Join-Path (Get-Location) 'probe.json'),$info);[IO.File]::WriteAllText((Join-Path $env:TEMP 'retained.txt'),'before');Start-Sleep -Seconds 60",
    description: 'Background command owned by the replacement subprocess service', run_in_background: true,
  }, { onPermission: () => true });
  assert.equal(result.isError, false, JSON.stringify(result));
  information = await until(async () => {
    try { return JSON.parse(await readFile(join(root, 'probe.json'), 'utf8')); } catch { return false; }
  }, 'The replacement subprocess owner did not start the restricted command');
  await driver.close();
  assert.equal(observed, true);
  await assert.rejects(access(information.temp));
});

test('Host teardown removes session TEMP only after its real background process range has exited', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-host-temp-shutdown-'));
  const root = join(base, 'work'); await mkdir(root);
  const driver = await createHarnessDriver({ dataDir: join(base, 'data'), cwd: root });
  const close = WindowsSessionTemps.prototype.close;
  let observed = false, information;
  WindowsSessionTemps.prototype.close = async function (cleanup) {
    if (cleanup && information) {
      assert.throws(() => process.kill(information.pid, 0), 'TEMP cleanup cannot run before the command process exits');
      await access(join(information.temp, 'retained.txt'));
      observed = true;
    }
    return close.call(this, cleanup);
  };
  t.after(async () => {
    WindowsSessionTemps.prototype.close = close;
    await driver.close(); await rm(base, { recursive: true, force: true });
  });
  const { sessionId } = await driver.createSession({ cwd: root, model: 'unused', provider: {
    id: 'unused', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-only',
  } });
  const result = await driver.callTool(sessionId, 'pwsh', {
    command: "$info=@{temp=$env:TEMP;pid=$PID}|ConvertTo-Json -Compress;[IO.File]::WriteAllText((Join-Path (Get-Location) 'probe.json'),$info);[IO.File]::WriteAllText((Join-Path $env:TEMP 'retained.txt'),'before');Start-Sleep -Seconds 60",
    description: 'Isolated background TEMP lifecycle', run_in_background: true,
  }, { onPermission: () => true });
  assert.equal(result.isError, false, JSON.stringify(result));
  information = await until(async () => {
    try { return JSON.parse(await readFile(join(root, 'probe.json'), 'utf8')); } catch { return false; }
  }, 'The real background command did not start');
  assert.doesNotThrow(() => process.kill(information.pid, 0));
  await driver.close();
  assert.equal(observed, true, 'The Host did not reach its resource cleanup barrier');
  await assert.rejects(access(information.temp));
});
