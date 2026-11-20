import type {
  ForkSessionRequest,
  ListSessionsRequest,
  LoadSessionResponse,
  NewSessionRequest,
  SessionInfo,
} from '@agentclientprotocol/sdk';
import type { GooseExtension, SessionImportSource } from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';
import { DEFAULT_CHAT_TITLE } from '../contexts/ChatContext';
import type { ExtensionLoadResult } from '../types/extensions';
import type { Session } from '../types/session';
import type { Recipe } from '../recipe';
import { CodeProWorkspaceReconfirmationRequiredError } from '../codepro/resumeCodeProSession';
import { errorMessage } from '../utils/conversionUtils';
import { canForkSession } from '../utils/sessionCapabilities';
import { parseSessionMode } from '../utils/sessionMode';
import { AppEvents } from '../constants/events';
import { traceSessionLoad } from './sessionLoadTiming';
import { consumeNextChatAgent, getNextChatAgent } from '../utils/nextChatAgent';

// CurrentModeUpdate is the existing store's authority. Do not change the
// global preference or optimistically claim a session permission change.
export async function acpSetSessionMode(
  sessionId: string,
  mode: NonNullable<Session['goose_mode']>
): Promise<void> {
  const client = await getAcpClient();
  await client.setSessionMode({ sessionId, modeId: mode });
}

interface GooseSessionInfoMeta {
  globalConversation?: boolean;
  readonlyHistory?: boolean;
  messageCount?: number;
  createdAt?: string;
  lastMessageAt?: string;
  archivedAt?: string;
  projectId?: string;
  providerId?: string;
  modelId?: string;
  sessionType?: Session['session_type'];
  userSetName?: boolean;
  hasRecipe?: boolean;
  lastMessageSnippet?: string;
  workspaceBinding?: 'unbound' | 'root_container' | 'project_container' | 'writable_project';
  rootContainerPath?: string;
  sidebarPlacement?: 'tasks' | 'project';
  workspaceOrigin?: 'default' | 'selected';
}

export interface SessionListItem {
  globalConversation?: boolean;
  agentProfile?: Session['agent_profile'];
  sidebarPlacement?: 'tasks' | 'project';
  workspaceOrigin?: 'default' | 'selected';
  workspaceBinding?: GooseSessionInfoMeta['workspaceBinding'];
  id: string;
  name: string;
  workingDir: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt?: string;
  createdAt: string;
  archivedAt?: string;
  projectId?: string;
  providerId?: string;
  modelId?: string;
  userSetName?: boolean;
  hasRecipe?: boolean;
  sessionType?: Session['session_type'];
}

export interface SessionListPage {
  sessions: SessionListItem[];
  nextCursor: string | null;
}

export interface LoadSessionMeta {
  gooseMode?: Session['goose_mode'];
  recipe?: Recipe | null;
  userRecipeValues?: Record<string, string> | null;
  extensionResults?: ExtensionLoadResult[] | null;
  workingDir?: string;
}

export interface AcpLoadSessionResult {
  sessionInfo: SessionInfo;
  response: LoadSessionResponse;
  meta: LoadSessionMeta;
}

const inFlightSessionLoads = new Map<
  string,
  { options: AcpLoadSessionOptions; promise: Promise<AcpLoadSessionResult> }
>();

function parseSessionResponseMeta(rawMeta: unknown): LoadSessionMeta {
  const meta = (rawMeta ?? {}) as LoadSessionMeta;
  return {
    recipe: meta.recipe,
    userRecipeValues: meta.userRecipeValues,
    extensionResults: meta.extensionResults,
    workingDir: typeof meta.workingDir === 'string' ? meta.workingDir : undefined,
  };
}

export function parseLoadMeta(response: LoadSessionResponse): LoadSessionMeta {
  return {
    ...parseSessionResponseMeta(response._meta),
    gooseMode: parseSessionMode(response.modes?.currentModeId),
  };
}

function sessionInfoMeta(s: SessionInfo): GooseSessionInfoMeta {
  return (s._meta ?? {}) as GooseSessionInfoMeta;
}

export function sessionInfoToSession(s: SessionInfo, loadMeta: LoadSessionMeta = {}): Session {
  const meta = sessionInfoMeta(s);
  const role = s._meta?.agentProfile as Partial<NonNullable<Session['agent_profile']>> | undefined;
  const createdAt = meta.createdAt ?? s.updatedAt ?? '';
  const updatedAt = s.updatedAt ?? createdAt;
  const modelConfig: Session['model_config'] = meta.modelId
    ? {
        model_name: meta.modelId,
        toolshim: false,
      }
    : null;
  const hidesProcessCwd = meta.workspaceBinding === 'unbound';
  // root_container keeps the selected root container path visible as the workspace indicator;
  // only unbound sessions hide their process cwd because there is no user-selected workspace.

  return {
    id: String(s.sessionId),
    global_conversation: meta.globalConversation === true,
    ...(role && typeof role.id === 'string' && typeof role.name === 'string' && typeof role.avatar === 'string' && typeof role.revision === 'number'
      ? { agent_profile: { id: role.id, name: role.name, avatar: role.avatar, revision: role.revision } } : {}),
    name: s.title ?? DEFAULT_CHAT_TITLE,
    working_dir: hidesProcessCwd ? '' : (loadMeta.workingDir ?? s.cwd),
    created_at: createdAt,
    updated_at: updatedAt,
    last_message_at: meta.lastMessageAt,
    message_count: meta.messageCount ?? 0,
    extension_data: {
      ...(meta.sidebarPlacement ? { sidebarPlacement: meta.sidebarPlacement } : {}),
      ...(meta.readonlyHistory === true ? { readonlyHistory: true } : {}),
      ...(meta.workspaceBinding ? { workspaceBinding: meta.workspaceBinding } : {}),
      ...(meta.rootContainerPath ? { rootContainerPath: meta.rootContainerPath } : {}),
      ...(meta.workspaceOrigin === 'default' || meta.workspaceOrigin === 'selected'
        ? { workspaceOrigin: meta.workspaceOrigin }
        : {}),
    },
    archived_at: meta.archivedAt,
    project_id: meta.projectId,
    provider_name: meta.providerId,
    model_config: modelConfig,
    session_type: meta.sessionType,
    goose_mode: loadMeta.gooseMode,
    recipe: loadMeta.recipe as Session['recipe'],
    user_recipe_values: loadMeta.userRecipeValues,
    user_set_name: meta.userSetName,
    last_message_snippet: meta.lastMessageSnippet,
  };
}

function sessionInfoToListItem(s: SessionInfo): SessionListItem {
  const meta = sessionInfoMeta(s);
  return {
    id: String(s.sessionId),
    globalConversation: meta.globalConversation === true,
    name: s.title ?? DEFAULT_CHAT_TITLE,
    workingDir: meta.workspaceBinding === 'unbound' ? '' : s.cwd,
    updatedAt: s.updatedAt ?? '',
    messageCount: meta.messageCount ?? 0,
    lastMessageAt: meta.lastMessageAt,
    createdAt: meta.createdAt ?? s.updatedAt ?? '',
    archivedAt: meta.archivedAt,
    projectId: meta.projectId,
    providerId: meta.providerId,
    modelId: meta.modelId,
    userSetName: meta.userSetName,
    hasRecipe: meta.hasRecipe,
    sessionType: meta.sessionType,
    agentProfile: sessionInfoToSession(s).agent_profile,
    workspaceBinding: meta.workspaceBinding,
    sidebarPlacement: meta.sidebarPlacement,
    workspaceOrigin:
      meta.workspaceOrigin === 'default' || meta.workspaceOrigin === 'selected'
        ? meta.workspaceOrigin
        : undefined,
  };
}

export interface SessionListFilter {
  keyword?: string;
  includeArchived?: boolean;
}

export type SessionWorkspaceMode = 'code' | 'codepro' | 'unified';

export function sessionListTypes(workspaceMode: SessionWorkspaceMode) {
  if (workspaceMode === 'unified') {
    return ['user', 'scheduled', 'code_pro'] as const;
  }
  return workspaceMode === 'codepro' ? (['code_pro'] as const) : (['user', 'scheduled'] as const);
}

export function sessionTypeMatchesWorkspace(
  sessionType: string | undefined,
  workspaceMode: SessionWorkspaceMode
): boolean {
  return (
    typeof sessionType === 'string' &&
    (sessionListTypes(workspaceMode) as readonly string[]).includes(sessionType)
  );
}

export async function acpListSessions(
  cursor?: string | null,
  filter?: SessionListFilter,
  workspaceMode: SessionWorkspaceMode = 'code'
): Promise<SessionListPage> {
  const client = await getAcpClient();
  const request: ListSessionsRequest = {};
  if (cursor) {
    request.cursor = cursor;
  }
  const meta: Record<string, unknown> = { types: sessionListTypes(workspaceMode) };
  if (filter?.includeArchived) {
    meta.includeArchived = true;
  }
  const keyword = filter?.keyword?.trim();
  if (keyword) {
    meta.query = keyword;
  }
  request._meta = meta;
  const response = await client.listSessions(request);
  return {
    sessions: response.sessions.map(sessionInfoToListItem),
    nextCursor: response.nextCursor ?? null,
  };
}

export async function acpListRecentSessions(
  maxSessions: number,
  workspaceMode: SessionWorkspaceMode = 'code'
): Promise<SessionListItem[]> {
  if (maxSessions <= 0) {
    return [];
  }

  const client = await getAcpClient();
  const response = await client.listSessions({
    _meta: { types: sessionListTypes(workspaceMode) },
  });
  return response.sessions.slice(0, maxSessions).map(sessionInfoToListItem);
}

export async function acpGetSessionListItem(sessionId: string): Promise<SessionListItem> {
  const client = await getAcpClient();
  const response = await client.goose.sessionInfo_unstable({ sessionId });
  return sessionInfoToListItem(response.session);
}

export interface AcpLoadSessionOptions {
  cwd?: string;
  workspaceLeaseId?: string;
}

export async function acpLoadSession(
  sessionId: string,
  options: AcpLoadSessionOptions = {}
): Promise<AcpLoadSessionResult> {
  const pendingLoad = inFlightSessionLoads.get(sessionId);
  if (pendingLoad) {
    if (
      pendingLoad.options.cwd === options.cwd &&
      pendingLoad.options.workspaceLeaseId === options.workspaceLeaseId
    ) {
      return pendingLoad.promise;
    }
    // A confirmed resume must not inherit an older load's cwd or lease.
    // Serialize distinct requests even when the earlier load was rejected.
    await pendingLoad.promise.catch(() => undefined);
    return acpLoadSession(sessionId, options);
  }

  const requestedOptions = { ...options };
  const loadPromise = loadAcpSession(sessionId, requestedOptions);
  inFlightSessionLoads.set(sessionId, { options: requestedOptions, promise: loadPromise });
  try {
    return await loadPromise;
  } finally {
    if (inFlightSessionLoads.get(sessionId)?.promise === loadPromise) {
      inFlightSessionLoads.delete(sessionId);
    }
  }
}

export function isAcpSessionLoadInFlight(sessionId: string): boolean {
  return inFlightSessionLoads.has(sessionId);
}

async function loadAcpSession(
  sessionId: string,
  options: AcpLoadSessionOptions
): Promise<AcpLoadSessionResult> {
  const client = await getAcpClient();
  const initialSessionInfoResponse = await client.goose.sessionInfo_unstable({ sessionId });
  traceSessionLoad(sessionId, 'initial_metadata');
  const initialSessionInfo = initialSessionInfoResponse.session;
  let response: LoadSessionResponse;
  try {
    response = await client.loadSession({
      sessionId,
      cwd: options.cwd ?? initialSessionInfo.cwd,
      mcpServers: [],
      ...(options.workspaceLeaseId
        ? { _meta: { workspaceLeaseId: options.workspaceLeaseId } }
        : {}),
    });
    traceSessionLoad(sessionId, 'replay_response');
  } catch (error) {
    if (
      (sessionInfoMeta(initialSessionInfo).sessionType === 'code_pro' ||
        sessionInfoMeta(initialSessionInfo).sessionType === 'scheduled') &&
      (errorMessage(error).includes(
        'CodePro workspace must be re-confirmed before this session can be resumed'
      ) ||
        errorMessage(error).includes('invalid directory path'))
    ) {
      throw new CodeProWorkspaceReconfirmationRequiredError({
        sessionId,
        workingDir: initialSessionInfo.cwd,
      });
    }
    throw error;
  }
  // Loading can populate missing provider/model metadata.
  const loadedInfo = response._meta?.sessionInfo;
  const sessionInfo = loadedInfo && typeof loadedInfo === 'object' &&
    !Array.isArray(loadedInfo) && 'sessionId' in loadedInfo && loadedInfo.sessionId === sessionId &&
    'cwd' in loadedInfo && typeof loadedInfo.cwd === 'string'
    ? loadedInfo as unknown as SessionInfo
    : (await client.goose.sessionInfo_unstable({ sessionId })).session;

  traceSessionLoad(sessionId, 'final_metadata');

  return {
    sessionInfo,
    response,
    meta: parseLoadMeta(response),
  };
}

export interface AcpNewSessionResult {
  sessionId: string;
  sessionInfo: SessionInfo;
  meta: LoadSessionMeta;
}

export interface AcpRecipeOptions {
  extensionSelection?: 'follow' | 'custom';
  sidebarPlacement?: 'tasks' | 'project';
  workspaceOrigin?: 'default' | 'selected';
  initialPermissionPreset?: Session['goose_mode'];
  recipeId?: string;
  recipeDeeplink?: string;
  workspaceMode?: 'code' | 'codepro';
  projectId?: string;
  workspaceLeaseId?: string;
  workspaceBinding?: 'unbound' | 'root_container' | 'writable_project';
  rootContainerPath?: string;
}

export async function acpNewSession(
  cwd: string,
  gooseExtensions: GooseExtension[],
  recipe?: AcpRecipeOptions
): Promise<AcpNewSessionResult> {
  const client = await getAcpClient();
  const meta: Record<string, unknown> = { client: 'goose-desktop' };
  const agentId = getNextChatAgent();
  if (agentId) meta.customAgentId = agentId;
  if (recipe?.initialPermissionPreset)
    meta.initialPermissionPreset = recipe.initialPermissionPreset;
  if (gooseExtensions.length > 0 || recipe?.extensionSelection === 'custom') {
    meta.enabledExtensions = gooseExtensions;
  }
  if (recipe?.recipeId) {
    meta.recipeId = recipe.recipeId;
  } else if (recipe?.recipeDeeplink) {
    meta.recipeDeeplink = recipe.recipeDeeplink;
  }
  if (recipe?.workspaceMode) {
    meta.workspaceMode = recipe.workspaceMode;
  }
  if (recipe?.projectId) {
    meta.projectId = recipe.projectId;
  }
  if (recipe?.workspaceLeaseId) {
    meta.workspaceLeaseId = recipe.workspaceLeaseId;
  }
  if (recipe?.workspaceBinding) {
    meta.workspaceBinding = recipe.workspaceBinding;
  }
  if (recipe?.workspaceOrigin) meta.workspaceOrigin = recipe.workspaceOrigin;
  if (recipe?.rootContainerPath) {
    meta.rootContainerPath = recipe.rootContainerPath;
  }
  const request: NewSessionRequest = { cwd, mcpServers: [], _meta: meta };
  const response = await client.newSession(request);
  consumeNextChatAgent(agentId);
  const sessionId = String(response.sessionId);
  const loadMeta = parseLoadMeta(response);
  const sessionInfoResponse = await client.goose.sessionInfo_unstable({ sessionId });

  return {
    sessionId,
    sessionInfo: sessionInfoResponse.session,
    meta: loadMeta,
  };
}

export async function acpDeleteSession(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionDelete({ sessionId });
}

export async function acpCloseSession(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.unstable_closeSession({ sessionId });
}

export async function acpRenameSession(sessionId: string, title: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionRename_unstable({ sessionId, title });
}

export async function acpArchiveSession(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionArchive_unstable({ sessionId });
  window.dispatchEvent(new CustomEvent(AppEvents.SESSION_ARCHIVED, { detail: { sessionId } }));
}

export async function acpUnarchiveSession(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionUnarchive_unstable({ sessionId });
  window.dispatchEvent(new CustomEvent(AppEvents.SESSION_UNARCHIVED, { detail: { sessionId } }));
}

export async function acpUpdateWorkingDir(sessionId: string, workingDir: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionWorkingDirUpdate_unstable({ sessionId, workingDir });
}

export async function acpTruncateSessionConversation(
  sessionId: string,
  truncateFrom: number
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionConversationTruncate_unstable({ sessionId, truncateFrom });
  window.dispatchEvent(
    new CustomEvent(AppEvents.SESSION_CONVERSATION_CHANGED, { detail: { sessionId } })
  );
}

export async function acpForkSession(
  sessionId: string,
  conversationBefore?: number,
  conversationBeforeMessageId?: string
): Promise<string> {
  const client = await getAcpClient();
  const sessionInfo = await client.goose.sessionInfo_unstable({ sessionId });
  if (!canForkSession(sessionInfoMeta(sessionInfo.session).sessionType)) {
    throw new Error('This session cannot be forked; start a new task');
  }
  const { cwd } = sessionInfo.session;
  const request: ForkSessionRequest = { sessionId, cwd };
  if (conversationBefore !== undefined) {
    request._meta = { conversationBefore };
  }
  if (conversationBeforeMessageId !== undefined) {
    request._meta = { ...request._meta, conversationBeforeMessageId };
  }
  const response = await client.unstable_forkSession(request);
  return String(response.sessionId);
}

export async function acpExportSession(sessionId: string): Promise<string> {
  const client = await getAcpClient();
  const response = await client.goose.sessionExport_unstable({ sessionId });
  return response.data;
}

export type DiagnosticDetail = 'standard' | 'detailed';

export async function acpExportSessionLog(
  sessionId: string,
  detail: DiagnosticDetail = 'standard'
): Promise<string> {
  const client = await getAcpClient();
  const response = (await client.extMethod('_goose/unstable/session/log/export', {
    sessionId,
    detail,
  })) as { data?: unknown };
  if (typeof response?.data !== 'string') throw new Error('Invalid session log response');
  const header = JSON.parse(response.data.split('\n', 1)[0]) as {
    type?: unknown;
    revision?: unknown;
    detail?: unknown;
    restorable?: unknown;
  };
  if (
    header?.type !== 'log-export' ||
    header.revision !== 'codebuddy-log-v3' ||
    header.detail !== detail ||
    header.restorable !== false
  )
    throw new Error('The backend does not support this diagnostic format');
  return response.data;
}

export async function acpImportSession(input: string, source: SessionImportSource): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionImport_unstable({ input, source });
}
