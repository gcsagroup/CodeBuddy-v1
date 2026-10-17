import { join, posix, win32 } from 'node:path';
import { existsSync, lstatSync, realpathSync, renameSync } from 'node:fs';

export function resolvePackagedCodeBuddyHome(
  userHome: string,
  onRenameDeferred?: (error: unknown) => void
): string {
  const home = realpathSync(userHome);
  const profile = join(home, '.CodeBuddy');
  const previousProfile = join(home, '.CodeBuddy-Harness');
  if (!existsSync(profile) && existsSync(previousProfile)) {
    const previous = lstatSync(previousProfile);
    if (previous.isDirectory() && !previous.isSymbolicLink()) {
      try {
        renameSync(previousProfile, profile);
      } catch (error) {
        // A running copy may hold this directory. Keep its data usable and retry
        // on a later launch instead of starting empty or merging two profiles.
        onRenameDeferred?.(error);
      }
    }
  }
  return existsSync(previousProfile) ? previousProfile : profile;
}

export const CURRENT_STORAGE_LAYOUT_VERSION = 1;
export const LOCAL_PROFILE_ID = 'local';
// Compatibility identifiers are kept only for existing installations.
export const LEGACY_DATA_DIRECTORY = '.CodeAgentPro';
export const LEGACY_KEYRING_SERVICE = 'codeagentpro';

export function applyLegacyEnvironment(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CODEAGENTPRO_')) {
      const currentKey = `CODEBUDDY_${key.slice('CODEAGENTPRO_'.length)}`;
      if (env[currentKey] === undefined) env[currentKey] = value;
    }
  }
}

export interface StoragePathInput {
  codeBuddyHome?: string;
  goosePathRoot?: string;
  userHome: string;
  platform: 'win32' | 'posix';
  directoryExists?: (path: string) => boolean;
}

export interface CodeBuddyPaths {
  homeDir: string;
  appConfigDir: string;
  profileDir: string;
  profileConfigDir: string;
  sessionsDir: string;
  runsDir: string;
  memoryDir: string;
  projectsDir: string;
  auditDir: string;
  modelsDir: string;
  agentsDir: string;
  skillsDir: string;
  promptsDir: string;
  recipesDir: string;
  profileStateDir: string;
  profileCacheDir: string;
  pluginsPackagesDir: string;
  logsDir: string;
  migrationsDir: string;
  electronUserDataDir: string;
  electronSessionDataDir: string;
  legacyOverrideSource?: string;
}

export function resolveCodeBuddyPaths(input: StoragePathInput): CodeBuddyPaths {
  const pathApi = input.platform === 'win32' ? win32 : posix;
  const requestedHome = validateOverride(
    'CODEBUDDY_HOME',
    input.codeBuddyHome,
    pathApi,
    input.platform
  );
  const legacyHome = validateOverride(
    'GOOSE_PATH_ROOT',
    input.goosePathRoot,
    pathApi,
    input.platform
  );
  const userHome = normalizeAbsolute('user home', input.userHome, pathApi, input.platform);
  const newDefault = pathApi.join(userHome, '.CodeBuddy');
  const oldDefault = pathApi.join(userHome, LEGACY_DATA_DIRECTORY);
  const exists = input.directoryExists ?? existsSync;
  const defaultHome = !exists(newDefault) && exists(oldDefault) ? oldDefault : newDefault;
  const homeDir = requestedHome ?? legacyHome ?? defaultHome;
  const profileDir = pathApi.join(homeDir, 'profiles', LOCAL_PROFILE_ID);

  return {
    homeDir,
    appConfigDir: pathApi.join(homeDir, 'config'),
    profileDir,
    profileConfigDir: pathApi.join(profileDir, 'config'),
    sessionsDir: pathApi.join(profileDir, 'sessions'),
    runsDir: pathApi.join(profileDir, 'runs'),
    memoryDir: pathApi.join(profileDir, 'memory'),
    projectsDir: pathApi.join(profileDir, 'projects'),
    auditDir: pathApi.join(profileDir, 'audit'),
    modelsDir: pathApi.join(profileDir, 'models'),
    agentsDir: pathApi.join(profileDir, 'agents'),
    skillsDir: pathApi.join(profileDir, 'skills'),
    promptsDir: pathApi.join(profileDir, 'prompts'),
    recipesDir: pathApi.join(profileDir, 'recipes'),
    profileStateDir: pathApi.join(profileDir, 'state'),
    profileCacheDir: pathApi.join(profileDir, 'cache'),
    pluginsPackagesDir: pathApi.join(homeDir, 'plugins', 'packages'),
    logsDir: pathApi.join(homeDir, 'logs'),
    migrationsDir: pathApi.join(homeDir, 'migrations'),
    electronUserDataDir: pathApi.join(homeDir, 'state', 'electron-app'),
    electronSessionDataDir: pathApi.join(profileDir, 'state', 'electron'),
    legacyOverrideSource:
      requestedHome !== undefined && legacyHome !== undefined && requestedHome !== legacyHome
        ? legacyHome
        : undefined,
  };
}

type PathApi = typeof win32;

function validateOverride(
  name: string,
  value: string | undefined,
  pathApi: PathApi,
  platform: StoragePathInput['platform']
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0) {
    throw new Error(`${name} must not be empty when it is set`);
  }
  return normalizeAbsolute(name, value, pathApi, platform);
}

function normalizeAbsolute(
  name: string,
  value: string,
  pathApi: PathApi,
  platform: StoragePathInput['platform']
): string {
  if (!pathApi.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path: ${value}`);
  }

  const root = pathApi.parse(value).root;
  const separator = platform === 'win32' ? /[\\/]+/ : /\/+/;
  const segments: string[] = [];
  for (const segment of value.slice(root.length).split(separator)) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`${name} escapes its filesystem root: ${value}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return pathApi.join(root, ...segments);
}
