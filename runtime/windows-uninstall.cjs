'use strict';

// Called by the Inno uninstaller after explicit consent, before app files are removed.
// No arbitrary delete-list input: only known data children, never project folders.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { locationFile, readDataRoot, readMigration } = require('./storage-management.cjs');
const managedNames = ['backend', 'profiles', 'state', 'logs', 'plugins', 'config'];
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (parent, file) => key(file) === key(parent) || key(file).startsWith(key(parent) + path.sep);
async function stat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if ((await stat(current))?.isSymbolicLink()) throw new Error(`Link/junction requires manual cleanup: ${current}`);
    if (path.dirname(current) === current) break;
  }
}
async function json(file, fallback) {
  const info = await stat(file);
  if (!info) return fallback;
  await noLinks(file);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function projectPaths(root) {
  const projects = [path.join(root, 'workspaces'), path.join(root, 'backend/workspaces')];
  const add = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Invalid project path; cleanup stopped');
    projects.push(path.resolve(value));
  };
  const state = await json(path.join(root, 'backend/state.json'), { sessions: [] });
  if (!Array.isArray(state.sessions)) throw new Error('Invalid session registry; cleanup stopped');
  for (const session of state.sessions) if (session.cwd != null) add(session.cwd);
  const recent = await json(path.join(root, 'state/electron-app/recent-dirs.json'), { dirs: [] });
  if (!Array.isArray(recent.dirs)) throw new Error('Invalid recent projects; cleanup stopped');
  for (const directory of recent.dirs) add(directory);
  const metadata = path.join(root, 'backend/projects');
  await noLinks(metadata);
  const entries = await fs.readdir(metadata).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(metadata, name);
    await noLinks(file);
    const text = await fs.readFile(file, 'utf8');
    const end = text.indexOf('\n---\n', 4);
    if (!text.startsWith('---\n') || end < 0) throw new Error('Invalid project metadata; cleanup stopped');
    const data = JSON.parse(text.slice(4, end));
    if (data.workingDirs !== undefined && !Array.isArray(data.workingDirs)) throw new Error('Invalid project metadata paths; cleanup stopped');
    for (const directory of data.workingDirs ?? []) add(directory);
  }
  return [...new Set(projects)];
}
const identity = info => info && `${info.dev}:${info.ino}`;

async function createPlan({ root, home, app, locator }) {
  for (const file of [root, home, app, locator]) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n"]/.test(file)) throw new Error('Invalid cleanup path');
    await noLinks(file);
  }
  root = path.resolve(root);
  const protectedLocations = [home, path.parse(root).root,
    ...['Desktop', 'Documents', 'Downloads', 'AppData', 'AppData/Roaming', 'AppData/Local', 'AppData/Local/Temp'].map(name => path.join(home, name)),
    ...['Windows', 'Program Files', 'Program Files (x86)', 'Users', 'ProgramData'].map(name => path.join(path.parse(root).root, name))];
  if (protectedLocations.some(file => inside(root, file)) || inside(app, root) || inside(root, app))
    throw new Error('Cleanup overlaps a protected location');
  // Re-read the same locator used by the installer; a changed location is not consent.
  if (key(readDataRoot(locator, path.join(home, '.CodeBuddy'))) !== key(root))
    throw new Error('Data location changed since confirmation');
  const migration = readMigration(locator);
  if (migration && ['pending', 'copying'].includes(migration.status)) throw new Error('Data migration is pending; cleanup stopped');
  const preserved = await projectPaths(root);
  const files = [];
  const directories = [];
  async function walk(file) {
    if (preserved.some(project => inside(project, file))) return;
    // Keep the native runtime lock (and SQLite sidecars) while cleanup owns it.
    const lock = path.join(root, 'backend/.profile-lock.sqlite');
    if ([lock, lock + '-journal', lock + '-wal', lock + '-shm'].some(item => key(item) === key(file))) return;
    await noLinks(file);
    const info = await stat(file);
    if (!info) return;
    if (info.isDirectory()) {
      for (const name of await fs.readdir(file)) await walk(path.join(file, name));
      directories.push({ path: file, identity: identity(info) });
    } else {
      if (!info.isFile() || info.nlink > 1) throw new Error(`Unsupported file identity: ${file}`);
      files.push({ path: file, identity: identity(info) });
    }
  }
  for (const name of managedNames) await walk(path.join(root, name));
  // A locator is configuration, but never remove it if it belongs to a project.
  if (!preserved.some(project => inside(project, path.join(root, 'backend/state.json')))) await walk(locator);
  return { root, home, app, locator, preserved, files, directories, rootIdentity: identity(await stat(root)) };
}

async function executePlan(plan) {
  // Recompute scope and identities immediately before the first deletion.
  const fresh = await createPlan(plan);
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error('Data changed since cleanup planning; retry after closing CodeBuddy');
  for (const entry of [...plan.files, ...plan.directories]) {
    await noLinks(entry.path);
    if (identity(await stat(entry.path)) !== entry.identity) throw new Error(`File identity changed: ${entry.path}`);
  }
  const removed = [];
  for (const entry of plan.files) {
    await noLinks(entry.path);
    if (identity(await stat(entry.path)) !== entry.identity) throw new Error(`File identity changed: ${entry.path}`);
    await fs.unlink(entry.path);
    removed.push(entry.path);
  }
  for (const entry of plan.directories) {
    await noLinks(entry.path);
    if (identity(await stat(entry.path)) !== entry.identity) throw new Error(`Directory identity changed: ${entry.path}`);
    // Nonempty directories can contain retained projects or newly created files.
    await fs.rmdir(entry.path).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  }
  return { status: 'complete', removed, preserved: plan.preserved };
}

async function cleanData(options) {
  await createPlan(options); // Validate paths before acquiring a potentially creating lease.
  const backend = path.join(options.root, 'backend');
  let lease;
  try {
    if (await stat(backend)) {
      const { acquireProfileLock } = await import('./profile-lock.mjs');
      lease = await acquireProfileLock(backend);
    }
    return await executePlan(await createPlan(options));
  } finally { lease?.close(); }
}

module.exports = { createPlan, executePlan, cleanData };
if (require.main === module) {
  (async () => {
    const [action, root, app, report, ...extra] = process.argv.slice(2);
    if (process.platform !== 'win32' || action !== 'clean' || !report || extra.length)
      throw new Error('Use the CodeBuddy Inno uninstaller');
    let result;
    try {
      result = await cleanData({ root, app, home: os.homedir(), locator: locationFile() });
    } catch (error) {
      process.exitCode = 1;
      result = { status: 'failed', error: error.message, note: 'Application files were not removed; cleanup can be partial if an IO error occurred.' };
    }
    await fs.writeFile(report, JSON.stringify(result, null, 2), { mode: 0o600 });
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
