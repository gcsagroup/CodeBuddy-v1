import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGitEnvironmentResolver } from '../git-environment.mjs';
import { createGitReader } from '../git-extension.mjs';

const win = path.win32;
function fixture({ files = [], locations = { paths: [], installs: [] }, denied = [] } = {}) {
  let time = 0, reads = 0, stats = 0;
  const existing = new Set(files.map(p => p.toLowerCase()));
  const blocked = new Set(denied.map(p => p.toLowerCase()));
  const ensure = createGitEnvironmentResolver({ platform: 'win32', now: () => time,
    statFile: async p => { stats++; if (blocked.has(p.toLowerCase())) throw Object.assign(new Error('denied'), { code: 'EACCES' }); if (!existing.has(p.toLowerCase())) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { isFile: () => true }; },
    readLocations: async () => { reads++; return locations; },
  });
  return { ensure, existing, advance: n => time += n, reads: () => reads, stats: () => stats };
}

test('keep an inherited custom Git and do not probe registry on normal or concurrent calls', async () => {
  const f = fixture({ files: ['D:\\Portable Git\\bin\\git.exe'] });
  const env = { Path: 'D:\\Portable Git\\bin;C:\\Windows', OTHER: 'keep' };
  const before = { ...env };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.ensure(env)));
  assert.ok(results.every(r => r.status === 'located' && r.source === 'inherited'));
  assert.equal(f.reads(), 0);
  assert.deepEqual(env, before);
  const count = f.stats(); await f.ensure(env);
  assert.equal(f.stats(), count + 1, 'warm lookup only checks the cached file');
});

test('recover stale PATH using registered PATH; expand variables, quotes and Chinese paths without replacing other entries', async () => {
  const f = fixture({ files: ['D:\\工具 Git\\cmd\\git.exe'], locations: { paths: ['"%GIT_HOME%\\cmd";.;relative;D:\\unrelated'], installs: [] } });
  const env = { Path: 'C:\\Windows', GIT_HOME: 'D:\\工具 Git', OTHER: 'keep' };
  const result = await f.ensure(env);
  assert.equal(result.status, 'located');
  assert.equal(env.Path, 'C:\\Windows;D:\\工具 Git\\cmd');
  assert.equal(env.OTHER, 'keep');
  await f.ensure(env);
  assert.equal(f.reads(), 1);
});

test('registered nonstandard installation and standard install outside PATH are found without hard-coded user paths', async () => {
  for (const [env, locations, executable] of [
    [{ PATH: 'C:\\Windows' }, { paths: [], installs: ['E:\\custom Git'] }, 'E:\\custom Git\\cmd\\git.exe'],
    [{ Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, { paths: [], installs: [] }, 'C:\\Program Files\\Git\\cmd\\git.exe'],
  ]) {
    const f = fixture({ files: [executable], locations });
    assert.equal((await f.ensure(env)).executable, executable);
    assert.equal(env.Path ?? env.PATH, `C:\\Windows;${win.dirname(executable)}`);
  }
});

test('permission denial is not treated as absence and never selects another executable', async () => {
  const f = fixture({ files: ['D:\\other\\git.exe'], denied: ['C:\\blocked\\git.exe'], locations: { paths: ['D:\\other'], installs: [] } });
  const env = { Path: 'C:\\blocked' };
  assert.equal((await f.ensure(env)).status, 'inaccessible');
  assert.equal(f.reads(), 0);
  assert.equal(env.Path, 'C:\\blocked');
});

test('absent Git is bounded, newly installed Git is found after short cache expiry, and removed Git is rechecked', async () => {
  const executable = 'E:\\new\\git.exe';
  const f = fixture({ locations: { paths: ['E:\\new'], installs: [] } });
  const env = { PATH: 'C:\\Windows' };
  assert.equal((await f.ensure(env)).status, 'unresolved');
  await f.ensure(env); assert.equal(f.reads(), 1);
  f.existing.add(executable.toLowerCase()); f.advance(5001);
  assert.equal((await f.ensure(env)).status, 'located');
  f.existing.clear();
  assert.equal((await f.ensure(env)).status, 'unresolved');
  assert.equal(f.reads(), 3);
});

test('registry read failure does not claim Git is uninstalled or mutate PATH; non-Windows is unchanged', async () => {
  const env = { PATH: 'C:\\Windows' };
  const ensure = createGitEnvironmentResolver({ platform: 'win32', statFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, readLocations: async () => { throw new Error('registry denied'); } });
  assert.deepEqual(await ensure(env), { status: 'unresolved', diagnostic: 'Windows Git installation metadata could not be read' });
  assert.equal(env.PATH, 'C:\\Windows');
  const posix = createGitEnvironmentResolver({ platform: 'darwin', readLocations: () => assert.fail('Windows reader must not run') });
  assert.deepEqual(await posix(env), { status: 'unchanged' });
});

test('missing working directory and invalid executable remain errors rather than Git-uninstalled results', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-git-environment-')));
  const missing = createGitReader(path.join(root, 'gone')).tools.find(t => t.name === 'git_runtime_status');
  await assert.rejects(missing.execute({}), { code: 'ENOENT' });
  const invalid = createGitReader(root, { gitCommand: process.execPath }).tools.find(t => t.name === 'git_runtime_status');
  await assert.rejects(invalid.execute({}), /Invalid executable version response/);
});

test('actual Windows metadata recovers a stripped child PATH and two independent shells find Git', { skip: process.platform !== 'win32' }, async () => {
  // No registry/user PATH changes. Only an isolated child inherits the stale PATH.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codebuddy-git-environment-')));
  const script = path.join(root, 'probe.mjs');
  await writeFile(script, `
    import { ensureGitEnvironment } from ${JSON.stringify(new URL('../git-environment.mjs', import.meta.url).href)};
    import { execFileSync } from 'node:child_process';
    import path from 'node:path';
    const before = process.env.Path ?? process.env.PATH;
    const started = performance.now();
    const result = await ensureGitEnvironment();
    const coldMs = performance.now() - started;
    const warmStart = performance.now(); await ensureGitEnvironment();
    const warmMs = performance.now() - warmStart;
    if(result.status !== 'located') throw Error(JSON.stringify(result));
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const outputs = [1, 2].map(() => execFileSync(shell, ['-NoProfile','-NonInteractive','-Command','git --version; where.exe git'], {encoding:'utf8',windowsHide:true}));
    console.log(JSON.stringify({before, result, coldMs, warmMs, outputs}));
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.Path = path.join(process.env.SystemRoot, 'System32');
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env, windowsHide: true, timeout: 15000 });
  const result = JSON.parse(stdout);
  assert.equal(result.result.source, 'discovered');
  assert.ok(result.outputs.every(output => /git version /u.test(output)));
  console.log('Windows Git discovery timing', JSON.stringify({ coldMs: result.coldMs, warmMs: result.warmMs, executable: result.result.executable }));
});
