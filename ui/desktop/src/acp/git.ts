import { getAcpControlClient } from './acpConnection';

type JsonRecord = Record<string, unknown>;

export const GIT_CONFLICT_OPERATIONS = ['merge', 'rebase', 'cherry_pick', 'revert'] as const;
export type GitConflictOperation = (typeof GIT_CONFLICT_OPERATIONS)[number];
export const GITHUB_CLI_INSTALL_URL = 'https://cli.github.com/' as const;
export const GITHUB_CLI_LOGIN_COMMAND = 'gh auth login --hostname github.com --web' as const;

export interface GitStatusEntry {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatus {
  repositoryRoot: string;
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  truncated: boolean;
  entries: GitStatusEntry[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  commit: string;
}

export interface GitBranches {
  truncated: boolean;
  branches: GitBranch[];
}

export interface GitDiff {
  scope: string;
  text: string;
  truncated: boolean;
}

export interface GitConflictEntry {
  path: string;
  code: string;
  kind: string;
  stages: number[];
}

export interface GitConflicts {
  hasConflicts: boolean;
  operation: string;
  totalConflicts: number;
  truncated: boolean;
  conflicts: GitConflictEntry[];
}

export interface GitRepository {
  status: GitStatus;
  conflicts: GitConflicts;
  branches: GitBranches;
  diff: GitDiff;
  stagedDiff: GitDiff;
}

export interface GitRuntimeStatus {
  available: boolean;
  version: string | null;
  installUrl: string;
}

export interface GitHubRuntimeStatus {
  available: boolean;
  authenticated: boolean;
  version: string | null;
  hostname: 'github.com';
  installUrl: string;
  loginCommand: typeof GITHUB_CLI_LOGIN_COMMAND;
}

export interface GitStageReceipt {
  stagedPaths: string[];
}

export interface GitUnstageReceipt {
  unstagedPaths: string[];
}

export interface GitRestorePreview {
  paths: string[];
  changedPaths: string[];
  diff: string;
  diffTruncated: boolean;
  blockedReasons: string[];
  preflightId: string;
}

export interface GitRestoreReceipt {
  restoredPaths: string[];
}

export interface GitConflictAbortPreview {
  operation: string;
  head: string;
  changedPaths: string[];
  conflictedPaths: string[];
  workingDiff: string;
  workingDiffTruncated: boolean;
  stagedDiff: string;
  stagedDiffTruncated: boolean;
  blockedReasons: string[];
  preflightId: string;
}

export interface GitConflictActionReceipt {
  operation: string;
  status: string;
  head: string;
}

export interface GitBranchReceipt {
  branch: string;
  created: boolean;
}

export interface GitCommitReceipt {
  commit: string;
  branch: string;
  subject: string;
  committedPaths: string[];
}

export interface GitRemoteReceipt {
  operation: string;
  remote: string;
  branch: string;
  status: string;
}

export interface GitPushPreview {
  remote: string;
  remoteDestination: string;
  branch: string;
  head: string;
  outgoingCommitCount: number;
  outgoingCommits: Array<{ id: string; subject: string }>;
  changedPaths: string[];
  pathsTruncated: boolean;
  sensitivePaths: string[];
  blockedReasons: string[];
  preflightId: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid Git response: ${label}`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`invalid Git response: ${label}`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid Git response: ${label}`);
  return value;
}

function number(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`invalid Git response: ${label}`);
  }
  return Number(value);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, label);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid Git response: ${label}`);
  return value;
}

function officialGitInstallUrl(value: unknown): string {
  const candidate = string(value, 'install_url');
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('invalid Git response: install_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'git-scm.com' ||
    (!url.pathname.startsWith('/download/') && url.pathname !== '/downloads')
  ) {
    throw new Error('invalid Git response: install_url');
  }
  return url.toString().replace(/\/$/, '');
}

function officialGitHubCliInstallUrl(value: unknown): string {
  const candidate = string(value, 'install_url');
  if (candidate !== GITHUB_CLI_INSTALL_URL) {
    throw new Error('invalid Git response: install_url');
  }
  return GITHUB_CLI_INSTALL_URL;
}

function textContent(content: unknown): string | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const item = content as JsonRecord;
  return item.type === 'text' && typeof item.text === 'string' ? item.text : undefined;
}

function actionableAcpError(error: unknown): Error {
  if (error instanceof Error && 'data' in error) {
    const data = error.data;
    if (typeof data === 'string' && data.trim()) {
      return new Error(`${error.message}: ${data}`);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

const pendingGitCalls = new Map<string, Promise<unknown>>();

async function callGitTool(
  sessionId: string,
  name: string,
  args: JsonRecord = {}
): Promise<JsonRecord> {
  if (!sessionId) throw new Error('Git requires an active session');
  // Harness serializes operations in one conversation. Panel refreshes can
  // overlap each other and GitHub readiness checks, including on remount.
  const previous = pendingGitCalls.get(sessionId);
  const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    executeGitTool(sessionId, name, args)
  );
  pendingGitCalls.set(sessionId, operation);
  try {
    return await operation;
  } finally {
    if (pendingGitCalls.get(sessionId) === operation) pendingGitCalls.delete(sessionId);
  }
}

async function executeGitTool(
  sessionId: string,
  name: string,
  args: JsonRecord = {}
): Promise<JsonRecord> {
  if (!sessionId) throw new Error('Git requires an active session');
  const client = await getAcpControlClient();
  let response;
  try {
    response = await client.goose.toolsCall_unstable({
      sessionId,
      name,
      arguments: args,
    });
  } catch (error) {
    throw actionableAcpError(error);
  }
  const text = response.content?.map(textContent).find((value): value is string => !!value);
  if (response.isError) throw new Error(text || 'Git operation failed');
  if (!text) throw new Error('invalid Git response: missing text content');
  try {
    return record(JSON.parse(text), name);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid Git response: ${name}`);
    throw error;
  }
}

function parseStatus(value: JsonRecord): GitStatus {
  return {
    repositoryRoot: string(value.repository_root, 'repository_root'),
    branch: string(value.branch, 'branch'),
    detached: boolean(value.detached, 'detached'),
    upstream: nullableString(value.upstream, 'upstream'),
    ahead: number(value.ahead, 'ahead'),
    behind: number(value.behind, 'behind'),
    truncated: boolean(value.truncated, 'truncated'),
    entries: array(value.entries, 'entries').map((entry) => {
      const item = record(entry, 'status entry');
      return {
        path: string(item.path, 'path'),
        originalPath: nullableString(item.original_path, 'original_path'),
        indexStatus: string(item.index_status, 'index_status'),
        worktreeStatus: string(item.worktree_status, 'worktree_status'),
      };
    }),
  };
}

function parseBranches(value: JsonRecord): GitBranches {
  return {
    truncated: boolean(value.truncated, 'truncated'),
    branches: array(value.branches, 'branches').map((entry) => {
      const item = record(entry, 'branch');
      return {
        name: string(item.name, 'name'),
        current: boolean(item.current, 'current'),
        remote: boolean(item.remote, 'remote'),
        upstream: nullableString(item.upstream, 'upstream'),
        commit: string(item.commit, 'commit'),
      };
    }),
  };
}

function parseDiff(value: JsonRecord): GitDiff {
  return {
    scope: string(value.scope, 'scope'),
    text: string(value.text, 'text'),
    truncated: boolean(value.truncated, 'truncated'),
  };
}

function parseConflicts(value: JsonRecord): GitConflicts {
  return {
    hasConflicts: boolean(value.has_conflicts, 'has_conflicts'),
    operation: string(value.operation, 'operation'),
    totalConflicts: number(value.total_conflicts, 'total_conflicts'),
    truncated: boolean(value.truncated, 'truncated'),
    conflicts: array(value.conflicts, 'conflicts').map((entry) => {
      const item = record(entry, 'conflict');
      return {
        path: string(item.path, 'path'),
        code: string(item.code, 'code'),
        kind: string(item.kind, 'kind'),
        stages: array(item.stages, 'stages').map((stage) => number(stage, 'stage')),
      };
    }),
  };
}

export async function loadGitRepository(sessionId: string): Promise<GitRepository> {
  const snapshot = await callGitTool(sessionId, 'git_repository_snapshot');
  return {
    status: parseStatus(record(snapshot.status, 'status')),
    conflicts: parseConflicts(record(snapshot.conflicts, 'conflicts')),
    branches: parseBranches(record(snapshot.branches, 'branches')),
    diff: parseDiff(record(snapshot.diff, 'diff')),
    stagedDiff: parseDiff(record(snapshot.staged_diff, 'staged_diff')),
  };
}

export async function loadGitRuntimeStatus(sessionId: string): Promise<GitRuntimeStatus> {
  const value = await callGitTool(sessionId, 'git_runtime_status');
  return {
    available: boolean(value.available, 'available'),
    version: nullableString(value.version, 'version'),
    installUrl: officialGitInstallUrl(value.install_url),
  };
}

export async function loadGitHubRuntimeStatus(sessionId: string): Promise<GitHubRuntimeStatus> {
  const value = await callGitTool(sessionId, 'github_runtime_status');
  const hostname = string(value.hostname, 'hostname');
  const loginCommand = string(value.login_command, 'login_command');
  if (hostname !== 'github.com') throw new Error('invalid Git response: hostname');
  if (loginCommand !== GITHUB_CLI_LOGIN_COMMAND) {
    throw new Error('invalid Git response: login_command');
  }
  return {
    available: boolean(value.available, 'available'),
    authenticated: boolean(value.authenticated, 'authenticated'),
    version: nullableString(value.version, 'version'),
    hostname,
    installUrl: officialGitHubCliInstallUrl(value.install_url),
    loginCommand,
  };
}

export async function stageGitPaths(sessionId: string, paths: string[]): Promise<GitStageReceipt> {
  if (paths.length === 0) throw new Error('Select at least one path to stage');
  const value = await callGitTool(sessionId, 'git_stage', { paths });
  return {
    stagedPaths: array(value.staged_paths, 'staged_paths').map((path) => string(path, 'path')),
  };
}

export async function unstageGitPaths(
  sessionId: string,
  paths: string[]
): Promise<GitUnstageReceipt> {
  if (paths.length === 0) throw new Error('Select at least one path to unstage');
  const value = await callGitTool(sessionId, 'git_unstage', { paths });
  return {
    unstagedPaths: array(value.unstaged_paths, 'unstaged_paths').map((path) =>
      string(path, 'path')
    ),
  };
}

export async function previewGitRestore(
  sessionId: string,
  paths: string[]
): Promise<GitRestorePreview> {
  if (paths.length === 0) throw new Error('Select at least one path to restore');
  const value = await callGitTool(sessionId, 'git_restore_preview', { paths });
  return {
    paths: array(value.paths, 'paths').map((path) => string(path, 'path')),
    changedPaths: array(value.changed_paths, 'changed_paths').map((path) => string(path, 'path')),
    diff: string(value.diff, 'diff'),
    diffTruncated: boolean(value.diff_truncated, 'diff_truncated'),
    blockedReasons: array(value.blocked_reasons, 'blocked_reasons').map((reason) =>
      string(reason, 'reason')
    ),
    preflightId: string(value.preflight_id, 'preflight_id'),
  };
}

export async function restoreGitPaths(
  sessionId: string,
  preview: GitRestorePreview
): Promise<GitRestoreReceipt> {
  const value = await callGitTool(sessionId, 'git_restore', {
    paths: preview.paths,
    preflight_id: preview.preflightId,
  });
  return {
    restoredPaths: array(value.restored_paths, 'restored_paths').map((path) =>
      string(path, 'path')
    ),
  };
}

export async function previewGitConflictAbort(sessionId: string): Promise<GitConflictAbortPreview> {
  const value = await callGitTool(sessionId, 'git_conflict_abort_preview');
  return {
    operation: string(value.operation, 'operation'),
    head: string(value.head, 'head'),
    changedPaths: array(value.changed_paths, 'changed_paths').map((path) => string(path, 'path')),
    conflictedPaths: array(value.conflicted_paths, 'conflicted_paths').map((path) =>
      string(path, 'path')
    ),
    workingDiff: string(value.working_diff, 'working_diff'),
    workingDiffTruncated: boolean(value.working_diff_truncated, 'working_diff_truncated'),
    stagedDiff: string(value.staged_diff, 'staged_diff'),
    stagedDiffTruncated: boolean(value.staged_diff_truncated, 'staged_diff_truncated'),
    blockedReasons: array(value.blocked_reasons, 'blocked_reasons').map((reason) =>
      string(reason, 'reason')
    ),
    preflightId: string(value.preflight_id, 'preflight_id'),
  };
}

function parseConflictAction(value: JsonRecord): GitConflictActionReceipt {
  return {
    operation: string(value.operation, 'operation'),
    status: string(value.status, 'status'),
    head: string(value.head, 'head'),
  };
}

export async function continueGitConflict(
  sessionId: string,
  operation: GitConflictOperation
): Promise<GitConflictActionReceipt> {
  return parseConflictAction(await callGitTool(sessionId, 'git_conflict_continue', { operation }));
}

export async function abortGitConflict(
  sessionId: string,
  preview: GitConflictAbortPreview
): Promise<GitConflictActionReceipt> {
  return parseConflictAction(
    await callGitTool(sessionId, 'git_conflict_abort', {
      operation: preview.operation,
      preflight_id: preview.preflightId,
    })
  );
}

async function mutateGitBranch(
  sessionId: string,
  tool: 'git_branch_create' | 'git_branch_switch',
  name: string
): Promise<GitBranchReceipt> {
  if (!name.trim()) throw new Error('Branch name is required');
  const value = await callGitTool(sessionId, tool, { name: name.trim() });
  return {
    branch: string(value.branch, 'branch'),
    created: boolean(value.created, 'created'),
  };
}

export function createGitBranch(sessionId: string, name: string): Promise<GitBranchReceipt> {
  return mutateGitBranch(sessionId, 'git_branch_create', name);
}

export function switchGitBranch(sessionId: string, name: string): Promise<GitBranchReceipt> {
  return mutateGitBranch(sessionId, 'git_branch_switch', name);
}

export async function commitStagedGitChanges(
  sessionId: string,
  message: string
): Promise<GitCommitReceipt> {
  const value = await callGitTool(sessionId, 'git_commit', { message });
  return {
    commit: string(value.commit, 'commit'),
    branch: string(value.branch, 'branch'),
    subject: string(value.subject, 'subject'),
    committedPaths: array(value.committed_paths, 'committed_paths').map((path) =>
      string(path, 'path')
    ),
  };
}

export async function pullGitBranch(
  sessionId: string,
  input: { remote: string; branch: string }
): Promise<GitRemoteReceipt> {
  const value = await callGitTool(sessionId, 'git_pull', input);
  return {
    operation: string(value.operation, 'operation'),
    remote: string(value.remote, 'remote'),
    branch: string(value.branch, 'branch'),
    status: string(value.status, 'status'),
  };
}

export async function previewGitPush(
  sessionId: string,
  input: { remote: string; branch: string }
): Promise<GitPushPreview> {
  const value = await callGitTool(sessionId, 'git_push_preview', input);
  return {
    remote: string(value.remote, 'remote'),
    remoteDestination: string(value.remote_destination, 'remote_destination'),
    branch: string(value.branch, 'branch'),
    head: string(value.head, 'head'),
    outgoingCommitCount: number(value.outgoing_commit_count, 'outgoing_commit_count'),
    outgoingCommits: array(value.outgoing_commits, 'outgoing_commits').map((entry) => {
      const item = record(entry, 'outgoing commit');
      return { id: string(item.id, 'id'), subject: string(item.subject, 'subject') };
    }),
    changedPaths: array(value.changed_paths, 'changed_paths').map((path) => string(path, 'path')),
    pathsTruncated: boolean(value.paths_truncated, 'paths_truncated'),
    sensitivePaths: array(value.sensitive_paths, 'sensitive_paths').map((path) =>
      string(path, 'path')
    ),
    blockedReasons: array(value.blocked_reasons, 'blocked_reasons').map((reason) =>
      string(reason, 'reason')
    ),
    preflightId: string(value.preflight_id, 'preflight_id'),
  };
}

export async function pushGitBranch(
  sessionId: string,
  input: { remote: string; branch: string; preflightId: string }
): Promise<GitRemoteReceipt> {
  const value = await callGitTool(sessionId, 'git_push', {
    remote: input.remote,
    branch: input.branch,
    preflight_id: input.preflightId,
  });
  return {
    operation: string(value.operation, 'operation'),
    remote: string(value.remote, 'remote'),
    branch: string(value.branch, 'branch'),
    status: string(value.status, 'status'),
  };
}
