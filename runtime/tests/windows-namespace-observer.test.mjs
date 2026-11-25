import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createNamespaceObserver } from '../harness/windows-namespace-observer.mjs';

const windows = process.platform === 'win32' && process.arch === 'x64';
const run = promisify(execFile);
const ps = (script, env = {}) => run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';" + script],
  { windowsHide: true, timeout: 8000, encoding: 'utf8', env: { ...process.env, ...env,
    PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } });

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'codebuddy-namespace-test-'));
  const root = join(base, 'work'); await mkdir(root);
  const observers = [];
  t.after(async () => { for (const observer of observers) await observer.close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, observe: (...args) => { const observer = createNamespaceObserver(root, ...args); observers.push(observer); return observer; } };
}
async function eventually(observer, condition) {
  const deadline = performance.now() + 3000;
  do { observer.drain(); if (condition()) return; await delay(5); } while (performance.now() < deadline);
  assert.ok(condition(), 'the namespace notification did not arrive within its deadline');
}

test('namespace observation ignores real security writes and delivers Unicode create, rename and moved trees', {
  skip: !windows, timeout: 15000,
}, async t => {
  const { base, root, observe } = await fixture(t);
  for (let n = 0; n < 500; n++) await writeFile(join(root, `${n}.txt`), 'fixture');
  const changed = [], invalidated = [];
  const observer = observe(path => changed.push(path), error => invalidated.push(error));
  const { stdout } = await ps('Add-Type -Path $env:CB_HELPER;[WorkspaceLabelAccess]::PrepareExistingBounded($env:CB_ROOT,5000,\'\')|ConvertTo-Json -Compress', {
    CB_ROOT: root, CB_HELPER: fileURLToPath(new URL('../harness/WorkspaceLabelAccess.cs', import.meta.url)),
  });
  assert.equal(JSON.parse(stdout).Changed, 500, stdout);
  observer.drain();
  assert.deepEqual(changed, []);
  assert.deepEqual(invalidated, [], 'the label helper security writes must not overflow namespace observation');
  const old = join(root, '中文🚀-old.txt'), next = join(root, '中文🚀-new.txt');
  await writeFile(old, 'created'); await rename(old, next);
  const incoming = join(base, 'incoming'); await mkdir(incoming); await writeFile(join(incoming, 'nested.txt'), 'outside');
  await rename(incoming, join(root, 'incoming'));
  await eventually(observer, () => changed.includes(old) && changed.includes(next) && changed.includes(join(root, 'incoming')));
  assert.deepEqual(invalidated, []);
  assert.equal(await readFile(next, 'utf8'), 'created');
  assert.equal(observer.active, true);
});

test('a real namespace overflow invalidates the baseline and observation continues after rearming', {
  skip: !windows, timeout: 10000,
}, async t => {
  const { root, observe } = await fixture(t), changed = [], invalidated = [];
  const observer = observe(path => changed.push(path), error => invalidated.push(error), { bufferSize: 4096 });
  // Keep Node from draining callbacks until native namespace storage overflows.
  for (let n = 0; n < 400; n++) writeFileSync(join(root, `burst-${n}-中文🚀.txt`), 'fixture');
  await eventually(observer, () => invalidated.some(error => error.code === 'CODEBUDDY_NAMESPACE_OVERFLOW'));
  assert.equal(observer.active, true, 'overflow must invalidate completeness without discarding a usable observer');
  const after = join(root, 'after-overflow.txt'); await writeFile(after, 'after');
  await eventually(observer, () => changed.includes(after));
});

test('root replacement invalidates the old observer and close prevents all later callbacks', {
  skip: !windows, timeout: 10000,
}, async t => {
  const { base, root, observe } = await fixture(t), changed = [], invalidated = [];
  const observer = observe(path => changed.push(path), error => invalidated.push(error));
  await rename(root, join(base, 'previous')); await mkdir(root);
  observer.drain();
  assert.equal(observer.active, false);
  assert.equal(invalidated.at(-1)?.code, 'CODEBUDDY_NAMESPACE_ROOT_CHANGED');
  await observer.close();
  const count = changed.length, failures = invalidated.length;
  await writeFile(join(base, 'previous/old-tree.txt'), 'old');
  await writeFile(join(root, 'new-tree.txt'), 'new');
  await delay(30); observer.drain();
  assert.equal(changed.length, count);
  assert.equal(invalidated.length, failures);
});

test('loss of directory listing permission invalidates observation without changing that permission', {
  skip: !windows, timeout: 15000,
}, async t => {
  const { root, observe } = await fixture(t), invalidated = [];
  const { stdout } = await ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  const sid = stdout.trim();
  const observer = observe(() => {}, error => invalidated.push(error));
  try {
    await run('icacls.exe', [root, '/deny', '*' + sid + ':(RD)'], { windowsHide: true, timeout: 5000 });
    observer.drain();
    assert.equal(observer.active, false);
    assert.ok(invalidated.some(error => error.api === 'CreateFileW' && error.win32Code === 5), JSON.stringify(invalidated));
    await observer.close();
    await assert.rejects(readdir(root), error => error.code === 'EACCES' || error.code === 'EPERM', 'observer shutdown must leave the explicit listing denial intact');
  } finally { await run('icacls.exe', [root, '/remove:d', '*' + sid], { windowsHide: true, timeout: 5000 }); }
});

test('startup rejects junction roots and missing directories, and pending reads close idempotently', {
  skip: !windows, timeout: 10000,
}, async t => {
  const { base, root, observe } = await fixture(t), link = join(base, 'junction');
  await symlink(root, link, 'junction');
  try {
    assert.throws(() => createNamespaceObserver(link, () => {}, () => {}), error => error.code === 'CODEBUDDY_NAMESPACE_ROOT_CHANGED');
    assert.throws(() => createNamespaceObserver(join(base, 'missing'), () => {}, () => {}), error => error.api === 'CreateFileW');
  } finally { await rm(link); }
  const changed = [], invalidated = [];
  for (let n = 0; n < 20; n++) {
    const observer = observe(path => changed.push(path), error => invalidated.push(error));
    assert.equal(observer.active, true, 'returning from create is the first accepted kernel-read barrier');
    const first = observer.close(); assert.equal(first, observer.close()); await first;
    assert.equal(observer.active, false);
  }
  await writeFile(join(root, 'after-close.txt'), 'after'); await delay(30);
  assert.deepEqual(changed, []); assert.deepEqual(invalidated, []);
});
