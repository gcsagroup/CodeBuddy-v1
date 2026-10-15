import fs from 'node:fs/promises';
import * as posix from '@jsr/std__path/posix';
import * as win32 from '@jsr/std__path/windows';
import { normalizeWorkspaceIdentity } from './workspaceIdentity';

interface WorkspaceDependencies {
  mkdir: (directory: string, options: { recursive: boolean }) => Promise<unknown>;
  stat: (candidate: string) => Promise<{
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>;
  readdir: (directory: string) => Promise<unknown[]>;
  realpath: (candidate: string) => Promise<string>;
}

const DEFAULT_DEPENDENCIES: WorkspaceDependencies = {
  mkdir: (directory, options) => fs.mkdir(directory, options),
  stat: (candidate) => fs.stat(candidate),
  readdir: (directory) => fs.readdir(directory),
  realpath: (candidate) => fs.realpath(candidate),
};

function pathImplementation(value: string): typeof win32 | typeof posix {
  return /^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(value) ? win32 : posix;
}

export function independentSiblingWorkspacePath(
  selectedWorkspace: string,
  ordinal: number
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error('Independent workspace ordinal must be a positive integer');
  }
  const implementation = pathImplementation(selectedWorkspace);
  const parent = implementation.dirname(selectedWorkspace);
  const leaf = ordinal === 1 ? 'codepro-project' : `codepro-project-${ordinal}`;
  return implementation.join(parent, leaf);
}

const TRAILING_PATH_PUNCTUATION = /[.,;:!?，。；：！？)）\]}]+$/u;

function normalizeWindowsCandidate(value: string, stripTrailingPunctuation = true): string | null {
  const trimmedValue = value.trim();
  const trimmed = stripTrailingPunctuation
    ? trimmedValue.replace(TRAILING_PATH_PUNCTUATION, '')
    : trimmedValue;
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(trimmed)) return null;
  if (!win32.isAbsolute(trimmed)) return null;
  return win32.normalize(trimmed.replace(/\//gu, '\\'));
}

function normalizeWorkspaceCandidate(value: string): string | null {
  // Candidates from prompts have already had prose punctuation removed. Selected
  // and confirmed paths are literal filesystem names, including punctuation.
  const windowsCandidate = normalizeWindowsCandidate(value, false);
  if (windowsCandidate) return windowsCandidate;

  const trimmed = value.trim();
  if (!posix.isAbsolute(trimmed)) return null;
  return posix.normalize(trimmed);
}

export { normalizeWindowsWorkspaceIdentity } from './workspaceIdentity';

export function extractWindowsWorkspaceCandidates(prompt: string): string[] {
  return extractWorkspaceCandidates(prompt, false);
}

export function extractWorkspaceCandidates(prompt: string, includePosix = true): string[] {
  const matches: Array<{ index: number; value: string; stripTrailingPunctuation: boolean }> = [];
  const quotedRanges: Array<{ start: number; end: number }> = [];
  const quotedPath = /(["'`])((?:[a-zA-Z]:[\\/]|\\\\|\/)[^"'`\r\n]*?)\1/g;
  let match: RegExpExecArray | null;

  while ((match = quotedPath.exec(prompt)) !== null) {
    matches.push({
      index: match.index,
      value: match[2],
      stripTrailingPunctuation: false,
    });
    quotedRanges.push({ start: match.index, end: quotedPath.lastIndex });
  }

  const unquotedPath =
    /(?<![a-zA-Z0-9_])(?:[a-zA-Z]:[\\/][^\s"'`<>|]+|\\\\[^\\/\s"'`<>|]+[\\/][^\\/\s"'`<>|]+(?:[\\/][^\s"'`<>|]+)*)/g;
  while ((match = unquotedPath.exec(prompt)) !== null) {
    if (quotedRanges.some((range) => match!.index >= range.start && match!.index < range.end)) {
      continue;
    }
    matches.push({
      index: match.index,
      value: match[0],
      stripTrailingPunctuation: true,
    });
  }

  if (includePosix) {
    // Require a token boundary so URLs, relative paths and Windows path tails
    // are not presented as POSIX workspace candidates. These remain candidates
    // for inspection and user selection, not an authorization to switch roots.
    const posixPath = /(?:^|[\s(（[【])(\/(?!\/)[^\s"'`<>|]*)/gu;
    while ((match = posixPath.exec(prompt)) !== null) {
      const index = match.index + match[0].length - match[1].length;
      if (quotedRanges.some((range) => index >= range.start && index < range.end)) continue;
      matches.push({ index, value: match[1], stripTrailingPunctuation: true });
    }
  }

  matches.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of matches) {
    const value = candidate.stripTrailingPunctuation
      ? candidate.value.replace(TRAILING_PATH_PUNCTUATION, '')
      : candidate.value;
    const normalized = includePosix
      ? normalizeWorkspaceCandidate(value)
      : normalizeWindowsCandidate(value, false);
    if (!normalized) continue;
    const identity = normalizeWorkspaceIdentity(normalized);
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push(normalized);
  }
  return candidates;
}

export type CodeProWorkspaceState =
  | 'missing'
  | 'empty-directory'
  | 'non-empty-directory'
  | 'file'
  | 'filesystem-root'
  | 'unavailable';

export interface CodeProWorkspaceInspection {
  requestedPath: string;
  normalizedPath: string;
  normalizedIdentity: string;
  canonicalPath: string | null;
  source: 'prompt' | 'selected';
  state: CodeProWorkspaceState;
  isGitRepository: boolean;
  displayName: string;
  suggestedProjectId: string;
  error: string | null;
}

export interface CodeProWorkspaceConfirmation {
  workingDir: string;
  normalizedIdentity: string;
  created: boolean;
  displayName: string;
  suggestedProjectId: string;
}

export type CodeProConfirmableWorkspaceState = Extract<
  CodeProWorkspaceState,
  'missing' | 'empty-directory' | 'non-empty-directory'
>;

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

export function workspaceDisplayName(normalizedPath: string): string {
  const implementation = pathImplementation(normalizedPath);
  return implementation.basename(normalizedPath) || implementation.parse(normalizedPath).root;
}

function safeProjectSlug(displayName: string): string {
  const readable = displayName
    .normalize('NFKD')
    .toLowerCase()
    .match(/[a-z0-9]+/gu)
    ?.join('-')
    .slice(0, 48);
  return readable || 'project';
}

function fnv1aHex(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function suggestedProjectId(normalizedIdentity: string, displayName: string): string {
  const digest = (
    fnv1aHex(normalizedIdentity, 0x811c9dc5) + fnv1aHex(normalizedIdentity, 0x01000193)
  ).slice(0, 12);
  return `${safeProjectSlug(displayName)}-${digest}`;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function inspectionBase(
  requestedPath: string,
  normalizedPath: string,
  source: CodeProWorkspaceInspection['source']
) {
  const normalizedIdentity = normalizeWorkspaceIdentity(normalizedPath);
  const displayName = workspaceDisplayName(normalizedPath);
  return {
    requestedPath,
    normalizedPath,
    normalizedIdentity,
    source,
    displayName,
    suggestedProjectId: suggestedProjectId(normalizedIdentity, displayName),
  };
}

function canonicalInspectionBase(base: ReturnType<typeof inspectionBase>, canonicalPath: string) {
  const normalizedIdentity = normalizeWorkspaceIdentity(canonicalPath);
  return {
    ...base,
    normalizedIdentity,
    suggestedProjectId: suggestedProjectId(normalizedIdentity, base.displayName),
  };
}

async function canonicalizeMissingWorkspace(
  normalizedPath: string,
  dependencies: WorkspaceDependencies
): Promise<string> {
  const implementation = pathImplementation(normalizedPath);
  const missingSegments: string[] = [];
  let current = normalizedPath;

  while (true) {
    const parent = implementation.dirname(current);
    const segment = implementation.basename(current);
    if (!segment || parent === current) {
      throw new Error('Workspace has no existing parent directory');
    }
    missingSegments.unshift(segment);
    current = parent;

    try {
      const stats = await dependencies.stat(current);
      if (!stats.isDirectory()) {
        throw new Error('Workspace parent is not a directory');
      }
      const canonicalParent = await dependencies.realpath(current);
      return implementation.join(canonicalParent, ...missingSegments);
    } catch (error) {
      if (isFileSystemError(error, 'ENOENT')) continue;
      throw error;
    }
  }
}

async function inspectWorkspaceCandidate(
  requestedPath: string,
  source: CodeProWorkspaceInspection['source'],
  dependencies: WorkspaceDependencies
): Promise<CodeProWorkspaceInspection> {
  const normalizedPath = normalizeWorkspaceCandidate(requestedPath);
  if (!normalizedPath) {
    const fallbackPath = requestedPath.trim();
    const normalizedIdentity = fallbackPath.toLowerCase();
    const displayName = fallbackPath || 'workspace';
    return {
      requestedPath,
      normalizedPath: fallbackPath,
      normalizedIdentity,
      canonicalPath: null,
      source,
      state: 'unavailable',
      isGitRepository: false,
      displayName,
      suggestedProjectId: suggestedProjectId(normalizedIdentity, displayName),
      error: 'Workspace path must be absolute',
    };
  }

  const base = inspectionBase(requestedPath, normalizedPath, source);
  if (isFilesystemRoot(normalizedPath)) {
    return {
      ...base,
      canonicalPath: normalizedPath,
      state: 'filesystem-root',
      isGitRepository: false,
      error: null,
    };
  }

  try {
    const stats = await dependencies.stat(normalizedPath);
    if (!stats.isDirectory()) {
      const canonicalPath = await dependencies.realpath(normalizedPath);
      return {
        ...canonicalInspectionBase(base, canonicalPath),
        canonicalPath,
        state: 'file',
        isGitRepository: false,
        error: null,
      };
    }

    const [canonicalPath, entries] = await Promise.all([
      dependencies.realpath(normalizedPath),
      dependencies.readdir(normalizedPath),
    ]);
    let isGitRepository = false;
    try {
      const gitStats = await dependencies.stat(
        pathImplementation(normalizedPath).join(normalizedPath, '.git')
      );
      isGitRepository = gitStats.isDirectory() || gitStats.isFile();
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
    }

    return {
      ...canonicalInspectionBase(base, canonicalPath),
      canonicalPath,
      state: entries.length === 0 ? 'empty-directory' : 'non-empty-directory',
      isGitRepository,
      error: null,
    };
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      try {
        const canonicalPath = await canonicalizeMissingWorkspace(normalizedPath, dependencies);
        return {
          ...canonicalInspectionBase(base, canonicalPath),
          canonicalPath,
          state: 'missing',
          isGitRepository: false,
          error: null,
        };
      } catch (canonicalError) {
        return {
          ...base,
          canonicalPath: null,
          state: 'unavailable',
          isGitRepository: false,
          error: boundedErrorMessage(canonicalError),
        };
      }
    }
    return {
      ...base,
      canonicalPath: null,
      state: 'unavailable',
      isGitRepository: false,
      error: boundedErrorMessage(error),
    };
  }
}

export async function inspectCodeProWorkspace(
  input: { prompt: string; selectedWorkingDir: string },
  overrides: Partial<WorkspaceDependencies> = {}
): Promise<CodeProWorkspaceInspection[]> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const promptCandidates = extractWorkspaceCandidates(input.prompt);
  const candidates =
    promptCandidates.length > 0
      ? promptCandidates.map((requestedPath) => ({ requestedPath, source: 'prompt' as const }))
      : [{ requestedPath: input.selectedWorkingDir, source: 'selected' as const }];
  const inspections = await Promise.all(
    candidates.map(({ requestedPath, source }) =>
      inspectWorkspaceCandidate(requestedPath, source, dependencies)
    )
  );
  const seen = new Set<string>();
  return inspections.filter((inspection) => {
    if (seen.has(inspection.normalizedIdentity)) return false;
    seen.add(inspection.normalizedIdentity);
    return true;
  });
}

export async function confirmCodeProWorkspace(
  input: {
    normalizedPath: string;
    expectedState: CodeProConfirmableWorkspaceState;
    expectedIdentity: string;
  },
  overrides: Partial<WorkspaceDependencies> = {}
): Promise<CodeProWorkspaceConfirmation> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const normalizedPath = normalizeWorkspaceCandidate(input.normalizedPath);
  if (!normalizedPath) throw new Error('Workspace path must be absolute');
  if (isFilesystemRoot(normalizedPath)) throw new Error('Cannot use a filesystem root');
  if (typeof input.expectedIdentity !== 'string' || !input.expectedIdentity.trim()) {
    throw new Error('Workspace identity is required');
  }

  let confirmedPath = normalizedPath;
  let created = false;
  try {
    const stats = await dependencies.stat(normalizedPath);
    if (!stats.isDirectory()) throw new Error('Workspace target is not a directory');
    if (input.expectedState === 'missing') {
      throw new Error('Workspace changed since inspection');
    }
    const entries = await dependencies.readdir(normalizedPath);
    const actualState = entries.length === 0 ? 'empty-directory' : 'non-empty-directory';
    if (actualState !== input.expectedState) {
      throw new Error('Workspace changed since inspection');
    }
  } catch (error) {
    if (!isFileSystemError(error, 'ENOENT')) throw error;
    if (input.expectedState !== 'missing') {
      throw new Error('Workspace changed since inspection');
    }
    const plannedPath = await canonicalizeMissingWorkspace(normalizedPath, dependencies);
    if (normalizeWorkspaceIdentity(plannedPath) !== input.expectedIdentity) {
      throw new Error('Workspace changed since inspection');
    }
    if (pathImplementation(normalizedPath) === win32) {
      throw new Error('Missing workspaces require an atomic workspace lease');
    }
    confirmedPath = plannedPath;
    await dependencies.mkdir(confirmedPath, { recursive: true });
    const entries = await dependencies.readdir(confirmedPath);
    if (entries.length > 0) {
      throw new Error('Workspace changed since inspection');
    }
    created = true;
  }

  const workingDir = await dependencies.realpath(confirmedPath);
  const normalizedIdentity = normalizeWorkspaceIdentity(workingDir);
  if (normalizedIdentity !== input.expectedIdentity) {
    throw new Error('Workspace changed since inspection');
  }
  const displayName = workspaceDisplayName(workingDir);
  return {
    workingDir,
    normalizedIdentity,
    created,
    displayName,
    suggestedProjectId: suggestedProjectId(normalizedIdentity, displayName),
  };
}

export function isFilesystemRoot(workingDir: string): boolean {
  if (!workingDir.trim()) return false;

  const implementation = pathImplementation(workingDir);
  const normalized = implementation.resolve(workingDir);
  const root = implementation.parse(normalized).root;
  return implementation === win32
    ? normalized.toLowerCase() === root.toLowerCase()
    : normalized === root;
}
