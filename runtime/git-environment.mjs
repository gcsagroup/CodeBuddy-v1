import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// Read only registered installation metadata. Never execute a discovered Git
// outside the caller's normal tool/sandbox path, or run a user's shell profile.
const WINDOWS_LOCATIONS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$installs = @()
foreach ($key in @('HKCU:\Software\GitForWindows', 'HKLM:\Software\GitForWindows', 'HKLM:\Software\WOW6432Node\GitForWindows')) {
  if (Test-Path -LiteralPath $key) {
    $value = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).InstallPath
    if ($value) { $installs += $value }
  }
}
@{ paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')); installs = $installs } | ConvertTo-Json -Compress
`;

function entry(env, name) {
  // Match Node's Windows ordering when a supplied environment contains aliases.
  const key = Object.keys(env).sort().find(key => key.toLowerCase() === name.toLowerCase());
  return { key: key ?? name, value: key ? env[key] ?? '' : '' };
}

async function registeredLocations(env) {
  const systemRoot = entry(env, 'SystemRoot').value;
  if (!path.win32.isAbsolute(systemRoot)) throw new Error('Windows installation directory is unavailable');
  const { stdout } = await exec(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_LOCATIONS],
    { env, windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024, encoding: 'utf8' });
  const value = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(value.paths) || !Array.isArray(value.installs) ||
      [...value.paths, ...value.installs].some(item => item !== null && typeof item !== 'string'))
    throw new Error('Invalid Git installation metadata');
  return value;
}

function directories(values, env) {
  const seen = new Set();
  return values.flatMap(value => (value ?? '').split(';')).map(value => {
    let directory = value.trim().replace(/^"(.*)"$/, '$1');
    directory = directory.replace(/%([^%]+)%/g, (match, name) => entry(env, name).value || match);
    return directory;
  }).filter(directory => {
    // Do not add working-directory-relative executables to the host PATH.
    if (!path.win32.isAbsolute(directory) || directory.includes('%') || directory.includes('\0')) return false;
    const identity = path.win32.normalize(directory).toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function createGitEnvironmentResolver({ platform = process.platform, statFile = stat, readLocations = registeredLocations, now = Date.now } = {}) {
  const states = new WeakMap();
  async function inspect(file) {
    try { return (await statFile(file)).isFile() ? 'located' : 'missing'; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return 'missing';
      return 'inaccessible';
    }
  }
  async function locate(env, current) {
    const inherited = directories([current.value], env);
    const extensions = (entry(env, 'PATHEXT').value || '.COM;.EXE;.BAT;.CMD').split(';')
      .filter(extension => /^\.[a-z0-9]+$/i.test(extension));
    for (const directory of inherited) {
      for (const extension of extensions) {
        const executable = path.win32.join(directory, `git${extension.toLowerCase()}`);
        const status = await inspect(executable);
        if (status !== 'missing') return { status, executable, source: 'inherited' };
      }
    }
    let registered = { paths: [], installs: [] }, diagnostic;
    try { registered = await readLocations(env); }
    catch { diagnostic = 'Windows Git installation metadata could not be read'; }
    const common = [
      ...registered.installs.filter(Boolean).map(root => path.win32.join(root, 'cmd')),
      ...['ProgramFiles', 'ProgramFiles(x86)'].map(name => entry(env, name).value).filter(Boolean).map(root => path.win32.join(root, 'Git', 'cmd')),
      ...(entry(env, 'LOCALAPPDATA').value ? [path.win32.join(entry(env, 'LOCALAPPDATA').value, 'Programs', 'Git', 'cmd')] : []),
    ];
    for (const directory of directories([...registered.paths, ...common], env)) {
      if (inherited.some(value => value.toLowerCase() === directory.toLowerCase())) continue;
      const executable = path.win32.join(directory, 'git.exe');
      const status = await inspect(executable);
      if (status === 'inaccessible') return { status, executable, source: 'discovered' };
      if (status !== 'located') continue;
      // Preserve all original entries/precedence, adding only the located Git
      // directory, not the user's entire changed environment.
      env[current.key] = [current.value, directory].filter(Boolean).join(';');
      for (const key of Object.keys(env))
        if (key !== current.key && key.toLowerCase() === 'path') delete env[key];
      return { status, executable, source: 'discovered' };
    }
    return { status: 'unresolved', ...(diagnostic ? { diagnostic } : {}) };
  }
  return async function ensureGitEnvironment(env = process.env) {
    if (platform !== 'win32') return { status: 'unchanged' };
    let state = states.get(env);
    if (!state) { state = {}; states.set(env, state); }
    if (state.pending) return state.pending;
    state.pending = (async () => {
      const current = entry(env, 'PATH');
      const fingerprint = JSON.stringify([current, ...['PATHEXT', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].map(name => entry(env, name).value)]);
      if (state.fingerprint === fingerprint) {
        if (state.result?.status === 'located' && await inspect(state.result.executable) === 'located') return state.result;
        // Avoid spawning a registry reader for every tool when Git is absent.
        if (state.result?.status !== 'located' && now() - state.checkedAt < 5000) return state.result;
      }
      const result = await locate(env, current);
      state.fingerprint = JSON.stringify([entry(env, 'PATH'), ...['PATHEXT', 'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].map(name => entry(env, name).value)]);
      state.checkedAt = now();
      state.result = result;
      return result;
    })();
    try { return await state.pending; } finally { state.pending = undefined; }
  };
}

export const ensureGitEnvironment = createGitEnvironmentResolver();
