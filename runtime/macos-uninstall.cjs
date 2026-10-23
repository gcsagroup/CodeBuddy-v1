'use strict';

// The desktop owns this operation. It is deliberately not an Agent/MCP tool.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const bundleId = 'local.codebuddy.desktop';
const managedNames = ['backend', 'profiles', 'state', 'logs', 'plugins', 'config'];
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
async function stat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function identity(file) {
  const info = await stat(file);
  return info ? { dev: info.dev, ino: info.ino } : null;
}
async function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file))
    throw new Error('Expected an absolute path');
  // Existing parents must be canonical too; this detects link substitution later.
  const parent = path.dirname(file);
  const resolved = await fs.realpath(parent);
  const result = path.join(resolved, path.basename(file));
  if ((await stat(result))?.isSymbolicLink()) throw new Error(`Symbolic link requires manual review: ${result}`);
  return result;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function projectPaths(root, workspace) {
  const state = await readJson(path.join(root, 'backend/state.json'), { sessions: [] });
  const recent = await readJson(path.join(root, 'state/electron-app/recent-dirs.json'), { dirs: [] });
  const projects = [path.join(root, 'workspaces'), path.join(root, 'backend/workspaces'), workspace,
    ...(state.sessions ?? []).map(session => session.cwd), ...(recent.dirs ?? [])];
  const metadata = path.join(root, 'backend/projects');
  if ((await stat(metadata))?.isSymbolicLink()) throw new Error('Project metadata directory is a symbolic link');
  for (const name of await fs.readdir(metadata).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })) {
    if (!name.endsWith('.md')) continue;
    const text = await fs.readFile(path.join(metadata, name), 'utf8');
    const end = text.indexOf('\n---\n', 4);
    if (!text.startsWith('---\n') || end < 0) throw new Error('Invalid project metadata; cleanup stopped');
    projects.push(...(JSON.parse(text.slice(4, end)).workingDirs ?? []));
  }
  return [...new Set(projects.filter(value => typeof value === 'string' && path.isAbsolute(value)).map(value => path.resolve(value)))];
}

async function sizeOf(file, preserved) {
  if (preserved.some(keep => inside(keep, file))) return 0;
  const info = await stat(file);
  if (!info || info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await fs.readdir(file)) bytes += await sizeOf(path.join(file, name), preserved);
  return bytes;
}

async function createPlan(options) {
  const { cleanData = false, deleteProjects = false } = options;
  if (typeof cleanData !== 'boolean' || typeof deleteProjects !== 'boolean' || (deleteProjects && !cleanData))
    throw new Error('Invalid uninstall choices');
  const home = await fs.realpath(options.home);
  const app = await canonical(options.app);
  const root = await canonical(options.dataRoot);
  if (!app.endsWith('.app'))
    throw new Error('Invalid uninstall location');
  const forbidden = [home, path.parse(root).root, ...['Applications', 'Users', 'System', 'Library', 'Volumes', 'private', 'usr', 'bin', 'sbin', 'opt'].map(name => path.join(path.parse(root).root, name)), ...['Desktop', 'Documents', 'Downloads', 'Library', 'Applications'].map(name => path.join(home, name))];
  if (forbidden.includes(root) || inside(app, root) || inside(root, app)) throw new Error('Application and data paths overlap a protected location');
  const plist = await fs.readFile(path.join(app, 'Contents/Info.plist'), 'utf8');
  if (!/<key>CFBundleIdentifier<\/key>\s*<string>local\.codebuddy\.desktop<\/string>/.test(plist))
    throw new Error('Application identity does not match CodeBuddy');
  const roots = [path.join(root, 'workspaces'), path.join(root, 'backend/workspaces')];
  const knownProjects = cleanData ? await projectPaths(root, options.workspace) : roots;
  const preserved = knownProjects.filter(file => !deleteProjects || !roots.some(base => inside(base, file)));
  const candidates = cleanData ? managedNames.map(name => path.join(root, name)) : [];
  if (deleteProjects) candidates.push(roots[0]);
  // Removing only known children preserves unknown user files and old migration copies.
  const targets = candidates.map(file => ({ path: file, kind: 'data' }));
  if (cleanData) targets.push(
    { path: path.join(home, 'Library/Preferences', `${bundleId}.plist`), kind: 'preference' },
    { path: path.join(home, 'Library/Application Support/CodeBuddy/data-root.txt'), kind: 'locator' },
  );
  targets.push({ path: app, kind: 'app' });
  for (const target of targets) {
    target.identity = await identity(target.path);
    target.bytes = await sizeOf(target.path, target.kind === 'data' ? preserved : []);
  }
  return { version: 1, app, root, home, cleanData, deleteProjects, preserved, targets,
    rootIdentity: await identity(root), appIdentity: await identity(app),
    bytes: targets.reduce((total, target) => total + target.bytes, 0) };
}

async function checkIdentity(file, expected) {
  if (JSON.stringify(await identity(file)) !== JSON.stringify(expected))
    throw new Error(`Location changed since confirmation: ${file}`);
}
async function removeKnown(file, preserved) {
  if (preserved.some(keep => inside(keep, file))) return;
  const info = await stat(file);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) { await fs.unlink(file); return; }
  for (const name of await fs.readdir(file)) await removeKnown(path.join(file, name), preserved);
  try { await fs.rmdir(file); }
  catch (error) {
    if (error.code !== 'ENOTEMPTY' || !preserved.some(keep => inside(file, keep))) throw error;
  }
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, shell: false });
  return { exitCode: result.status, error: result.error?.message || result.stderr?.trim() || null };
}
async function executePlan(plan, options = {}) {
  const command = options.command ?? run;
  // Recompute the allowlist instead of trusting arbitrary serialized target paths.
  const fresh = await createPlan({ home: plan.home, app: plan.app, dataRoot: plan.root,
    workspace: options.workspace, cleanData: plan.cleanData, deleteProjects: plan.deleteProjects });
  if (JSON.stringify(fresh.targets.map(t => t.path)) !== JSON.stringify(plan.targets.map(t => t.path)))
    throw new Error('Uninstall scope changed');
  await checkIdentity(plan.root, plan.rootIdentity);
  await checkIdentity(plan.app, plan.appIdentity);
  for (const target of plan.targets) {
    await checkIdentity(target.path, target.identity);
    // Parent links can point outside the selected data root without changing the leaf inode.
    if (await stat(target.path)) {
      if (await canonical(target.path) !== target.path) throw new Error(`Parent location changed: ${target.path}`);
    }
  }
  const preserved = [...new Set([...plan.preserved, ...fresh.preserved])];
  const results = [];
  for (const target of plan.targets.filter(item => item.kind !== 'app')) {
    try {
      await checkIdentity(target.path, target.identity);
      if (await stat(target.path) && await canonical(target.path) !== target.path) throw new Error('Parent location changed');
      await removeKnown(target.path, target.kind === 'data' ? preserved : []);
      results.push({ path: target.path, status: await stat(target.path) ? 'preserved-projects' : 'removed' });
    } catch (error) { results.push({ path: target.path, status: 'failed', error: error.message }); }
  }
  if (plan.cleanData) {
    const hasRetainedCredentials = Boolean(await stat(path.join(plan.root, 'backend/state.json'))) ||
      (plan.root !== path.join(plan.home, '.CodeBuddy') && Boolean(await stat(path.join(plan.home, '.CodeBuddy/backend/state.json'))));
    const credential = hasRetainedCredentials ? null : command('/usr/bin/security', ['delete-generic-password', '-s',
      'local.codebuddy.credentials.v1', '-a', 'aes-gcm-master-v1', path.join(plan.home, 'Library/Keychains/login.keychain-db')]);
    results.push({ path: 'Keychain: local.codebuddy.credentials.v1 / aes-gcm-master-v1',
      status: !credential ? 'preserved-shared-key' : [0, 44].includes(credential.exitCode) ? 'removed' : 'failed', error: credential?.error });
    const privacy = command('/usr/bin/tccutil', ['reset', 'All', bundleId]);
    results.push({ path: `TCC: ${bundleId}`, status: privacy.exitCode === 0 ? 'removed' : 'failed', error: privacy.error });
    // Empty root is optional: retained projects/unknown files keep it alive.
    await fs.rmdir(plan.root).catch(() => {});
  }
  const application = plan.targets.find(item => item.kind === 'app');
  try {
    await checkIdentity(application.path, application.identity);
    if (await canonical(application.path) !== application.path) throw new Error('Application parent changed');
    await removeKnown(application.path, []);
    if (await stat(application.path)) throw new Error('Application files remain');
    results.push({ path: application.path, status: 'removed' });
  } catch (error) { results.push({ path: application.path, status: 'failed', error: error.message }); }
  return { status: results.some(item => item.status === 'failed') ? 'partial' : 'complete',
    finishedAt: new Date().toISOString(), preserved, results };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function waitForExit(pids, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (pids.some(alive)) {
    if (Date.now() >= deadline) throw new Error('CodeBuddy is still running. Nothing was removed.');
    await delay(200);
  }
}

module.exports = { createPlan, executePlan, waitForExit };

if (require.main === module) {
  // Private IPC only. There is no command-line delete-path interface.
  if (process.platform !== 'darwin' || !process.send) throw new Error('Start uninstall from the CodeBuddy menu');
  process.send({ type: 'ready' });
  process.once('message', async message => {
    if (message?.type !== 'confirmed') return process.exit(1);
    process.disconnect();
    let result;
    try {
      if (!Array.isArray(message.pids) || !message.pids.every(pid => Number.isSafeInteger(pid) && pid > 1)) throw new Error('Invalid process identity');
      await waitForExit(message.pids);
      result = await executePlan(message.plan, { workspace: message.workspace });
    } catch (error) { result = { status: 'failed', error: error.message }; }
    const report = path.join(message.reportDirectory, 'result.json');
    await fs.writeFile(report, JSON.stringify(result, null, 2), { mode: 0o600 });
    const body = `${result.status === 'complete' ? message.doneText : message.failureText}\n\n${report}`;
    // argv carries text, never executable AppleScript interpolated from filesystem paths.
    spawnSync('/usr/bin/osascript', ['-e', 'on run argv\ndisplay dialog (item 1 of argv) with title "CodeBuddy" buttons {"OK"} default button "OK"\nend run', body], { timeout: 300000 });
  });
}
