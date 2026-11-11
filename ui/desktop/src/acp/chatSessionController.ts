import {
  ensureSessionLoadTiming,
  finishSessionLoadTiming,
  traceSessionLoad,
} from './sessionLoadTiming';
import { v7 as uuidv7 } from 'uuid';
import type { GooseExtension } from '@aaif/goose-sdk';
import { AppEvents } from '../constants/events';
import { ChatState } from '../types/chatState';
import type { Session } from '../types/session';
import { acpErrorData, errorMessage } from '../utils/conversionUtils';
import { showExtensionLoadResults } from '../utils/extensionErrorUtils';
import {
  createUserMessage,
  getTextAndImageContent,
  type Message,
} from '../types/message';
import { getTurnTerminalRecord, type MessageEditType } from '../types/turnTerminal';
import {
  CodeProWorkspaceReconfirmationRequiredError,
  resumeCodeProSession as resumeCodeProSessionWithFreshLease,
  type CodeProWorkspaceReconfirmationRequest,
} from '../codepro/resumeCodeProSession';
import type { CodeProWorkspaceInspection } from '../codepro/projectWorkspace';
import {
  acpChatSessionActions,
  acpChatSessionStore,
  subscribeToAcpChatSession,
  type AcpChatSessionSnapshot,
} from './chatSessionStore';
import { cancelAcpElicitationRequestsForSession } from './elicitationRequests';
import { parseAcpCreditsExhaustedError, type AcpCreditsExhaustedError } from './errors';
import {
  cancelAcpPermissionRequestsForSession,
  restoreAcpPermissionRequestsForSession,
} from './permissionRequests';
import { acquireWorkspaceLease, releaseWorkspaceLease } from './workspaceLease';
import { acpCancelPrompt, acpPromptSession, type CodeProTurnRetryMetadata } from './prompt';
import { applyThinkingDraft, readThinkingDraft } from './providers';
import { isAcpRecovering } from './acpConnection';
import {
  acpForkSession,
  acpLoadSession,
  acpNewSession,
  acpTruncateSessionConversation,
  isAcpSessionLoadInFlight,
  sessionInfoToSession,
  type AcpRecipeOptions,
} from './sessions';

export interface AcpLoadSessionOptions {
  onSessionLoaded?: () => void;
}

export interface AcpSnapshotOptions {
  getCurrentSnapshot(): AcpChatSessionSnapshot | undefined;
}

export interface AcpSubmitMessageOptions extends AcpSnapshotOptions {
  submittedAtMs?: number;
  onFinish(error?: string): void | Promise<void>;
  onAccepted?(): void;
  onRejectedBeforeAcceptance?(): void;
  onDeliveryUncertain?(): void;
}

export interface AcpChatSessionController {
  createSession(
    cwd: string,
    gooseExtensions: GooseExtension[],
    recipe?: AcpRecipeOptions
  ): Promise<Session>;
  loadSession(sessionId: string, options?: AcpLoadSessionOptions): Promise<void>;
  restoreSession(sessionId: string): Promise<void>;
  reconfirmCodeProWorkspace(
    request: CodeProWorkspaceReconfirmationRequest,
    candidate: CodeProWorkspaceInspection
  ): Promise<void>;
  submitMessage(
    sessionId: string,
    userMessage: Message,
    options: AcpSubmitMessageOptions
  ): Promise<void>;
  resumeAfterWorkspace(
    sessionId: string,
    sourceMessage: Message,
    sourceRunId: string,
    options: AcpSubmitMessageOptions
  ): Promise<void>;
  stop(sessionId: string): void;
  updateMessage(
    sessionId: string,
    messageId: string,
    newContent: string,
    editType: MessageEditType | undefined,
    options: AcpSubmitMessageOptions
  ): Promise<void>;
}

const SESSION_LOAD_RETRY_DELAYS_MS = [250, 750];
const MAX_AUTOMATIC_CHECKPOINT_RESUMES = 3;

function isTransientAcpConnectionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('acp connection closed') ||
    message.includes('connection closed') ||
    message.includes('connection lost') ||
    message.includes('websocket')
  );
}

function waitForSessionLoadRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function createAcpCreditsExhaustedMessage(error: AcpCreditsExhaustedError): Message {
  return {
    id: uuidv7(),
    role: 'assistant',
    created: Math.floor(Date.now() / 1000),
    content: [
      {
        type: 'systemNotification',
        notificationType: 'creditsExhausted',
        msg: error.message,
        ...(error.url ? { data: { top_up_url: error.url } } : {}),
      },
    ],
    metadata: { userVisible: true, agentVisible: false },
  };
}

function assertNoPendingPromptCancellation(sessionId: string): void {
  const snapshot = acpChatSessionStore.getSnapshot(sessionId);
  if (snapshot?.pendingCancelPromptAttemptId) {
    throw new Error('Cannot submit while prompt cancellation is pending');
  }
}

function findNewCheckpointTerminal(
  snapshot: AcpChatSessionSnapshot | undefined,
  existingTerminalIds: ReadonlySet<string>
) {
  const messages = snapshot?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const terminal = getTurnTerminalRecord(messages[index]);
    if (
      terminal?.status === 'interrupted' &&
      terminal.retry_strategy === 'continue_checkpoint' &&
      terminal.checkpoint_id &&
      terminal.report?.recovery_action === 'continue_checkpoint' &&
      !existingTerminalIds.has(terminal.terminal_message_id)
    ) {
      return terminal;
    }
  }
  return undefined;
}

function findPendingUserCheckpointTerminal(
  snapshot: AcpChatSessionSnapshot | undefined,
  userMessage: Message
) {
  if (!userMessage.metadata.userVisible) return undefined;

  const messages = snapshot?.messages ?? [];
  const submittedMessageIndex = userMessage.id
    ? messages.findIndex((message) => message.id === userMessage.id)
    : -1;
  const searchEnd = submittedMessageIndex >= 0 ? submittedMessageIndex : messages.length;

  for (let index = searchEnd - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const terminal = getTurnTerminalRecord(message);
    if (terminal) {
      return terminal.status === 'interrupted' &&
        terminal.retry_strategy === 'continue_checkpoint' &&
        terminal.checkpoint_id &&
        terminal.report?.recovery_action === 'ask_user'
        ? terminal
        : undefined;
    }
    if (message.role === 'user' && message.metadata.userVisible) return undefined;
  }
  return undefined;
}

type ReplayTerminal = NonNullable<ReturnType<typeof getTurnTerminalRecord>>;

function findReplaySource(
  messages: Message[],
  terminal: ReplayTerminal
): { messages: Message[]; source: Message; sourceText: string } | undefined {
  const terminalIndex = messages.findIndex(
    (candidate) => candidate.id === terminal.terminal_message_id && candidate.role === 'assistant'
  );
  if (terminalIndex < 0) return undefined;

  const authoritativeTerminal = getTurnTerminalRecord(messages[terminalIndex]);
  if (
    authoritativeTerminal?.terminal_message_id !== terminal.terminal_message_id ||
    authoritativeTerminal.source_user_message_id !== terminal.source_user_message_id ||
    authoritativeTerminal.run_id !== terminal.run_id ||
    authoritativeTerminal.retry_strategy !== 'replay_user_request' ||
    authoritativeTerminal.checkpoint_id !== null
  ) {
    return undefined;
  }

  const source = messages
    .slice(0, terminalIndex)
    .find(
      (candidate) =>
        candidate.id === terminal.source_user_message_id &&
        candidate.role === 'user' &&
        candidate.metadata.userVisible
    );
  if (!source) return undefined;
  const sourceText = getTextAndImageContent(source).textContent;
  return sourceText.trim() ? { messages, source, sourceText } : undefined;
}

async function forkSessionWithEditedMessage(
  sessionId: string,
  message: Message,
  editedMessage: string
): Promise<void> {
  const targetSessionId = await acpForkSession(sessionId, message.created);

  const event = new CustomEvent(AppEvents.SESSION_FORKED, {
    detail: {
      newSessionId: targetSessionId,
      shouldStartAgent: true,
      editedMessage,
    },
  });
  window.dispatchEvent(event);
}

async function createSession(
  cwd: string,
  gooseExtensions: GooseExtension[],
  recipe?: AcpRecipeOptions
): Promise<Session> {
  const { sessionId, sessionInfo, meta } = await acpNewSession(cwd, gooseExtensions, recipe);
  const session = sessionInfoToSession(sessionInfo, meta);

  showExtensionLoadResults(meta.extensionResults);
  window.dispatchEvent(
    new CustomEvent(AppEvents.SESSION_EXTENSIONS_LOADED, { detail: { sessionId } })
  );
  acpChatSessionActions.finishSessionLoad(sessionId, session);
  restoreAcpPermissionRequestsForSession(sessionId);

  return session;
}

async function loadSession(sessionId: string, options: AcpLoadSessionOptions = {}): Promise<void> {
  ensureSessionLoadTiming(sessionId);
  const cached = acpChatSessionStore.getSnapshot(sessionId);
  if (cached?.session) {
    traceSessionLoad(sessionId, 'cache_hit', { messages: cached.messages.length });
    restoreAcpPermissionRequestsForSession(sessionId);
    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_EXTENSIONS_LOADED, { detail: { sessionId } })
    );
    options.onSessionLoaded?.();
    return;
  }

  await loadSessionFromServer(sessionId, options);
}

async function restoreSession(sessionId: string): Promise<void> {
  await loadSessionFromServer(sessionId);
}

async function reconfirmCodeProWorkspace(
  request: CodeProWorkspaceReconfirmationRequest,
  candidate: CodeProWorkspaceInspection
): Promise<void> {
  await resumeCodeProSessionWithFreshLease(
    { sessionId: request.sessionId, candidate },
    {
      acquireWorkspaceLease,
      releaseWorkspaceLease,
      confirmWorkspace: (input) => window.electron.confirmCodeProWorkspace(input),
      loadSession: async (sessionId, options) => {
        const { sessionInfo, meta } = await acpLoadSession(sessionId, options);
        showExtensionLoadResults(meta.extensionResults);
        window.dispatchEvent(
          new CustomEvent(AppEvents.SESSION_EXTENSIONS_LOADED, { detail: { sessionId } })
        );
        acpChatSessionActions.finishSessionLoad(sessionId, sessionInfoToSession(sessionInfo, meta));
        restoreAcpPermissionRequestsForSession(sessionId);
      },
    }
  );
}

// Share the complete restore transaction, not only the transport request: duplicate
// mounts must not publish readiness or restore permissions twice for one replay.
const restoringSessions = new Map<string, Promise<boolean>>();
async function loadSessionFromServer(
  sessionId: string,
  options: AcpLoadSessionOptions = {}
): Promise<void> {
  let pending = restoringSessions.get(sessionId);
  if (!pending) {
    pending = restoreSessionFromServer(sessionId);
    restoringSessions.set(sessionId, pending);
  }
  try {
    if (await pending) options.onSessionLoaded?.();
  } finally {
    if (restoringSessions.get(sessionId) === pending) restoringSessions.delete(sessionId);
  }
}

async function restoreSessionFromServer(sessionId: string): Promise<boolean> {
  ensureSessionLoadTiming(sessionId);
  traceSessionLoad(sessionId, 'load_start');
  if (!isAcpSessionLoadInFlight(sessionId)) {
    acpChatSessionActions.startSessionLoad(sessionId);
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      const { sessionInfo, meta } = await acpLoadSession(sessionId);

      showExtensionLoadResults(meta.extensionResults);
      window.dispatchEvent(
        new CustomEvent(AppEvents.SESSION_EXTENSIONS_LOADED, { detail: { sessionId } })
      );
      acpChatSessionActions.finishSessionLoad(sessionId, sessionInfoToSession(sessionInfo, meta));
      restoreAcpPermissionRequestsForSession(sessionId);
      return true;
    } catch (error) {
      if (error instanceof CodeProWorkspaceReconfirmationRequiredError) {
        acpChatSessionActions.requireWorkspaceReconfirmation(sessionId, error.request);
        finishSessionLoadTiming(sessionId, 'workspace_reconfirmation');
        return false;
      }
      const retryDelay = SESSION_LOAD_RETRY_DELAYS_MS[attempt];
      if (retryDelay !== undefined && isTransientAcpConnectionError(error)) {
        console.warn(
          `ACP session load connection interrupted; retrying (${attempt + 1}/${SESSION_LOAD_RETRY_DELAYS_MS.length})`,
          error
        );
        await waitForSessionLoadRetry(retryDelay);
        acpChatSessionActions.startSessionLoad(sessionId);
        continue;
      }

      console.error('Failed to load ACP session:', error);
      acpChatSessionActions.failSessionLoad(sessionId, errorMessage(error));
      finishSessionLoadTiming(sessionId, 'failed');
      return false;
    }
  }
}

async function submitMessage(
  sessionId: string,
  userMessage: Message,
  options: AcpSubmitMessageOptions,
  turnRetry?: CodeProTurnRetryMetadata,
  automaticCheckpointResumeCount = 0
): Promise<void> {
  assertNoPendingPromptCancellation(sessionId);

  const snapshot = acpChatSessionStore.getSnapshot(sessionId);
  if (snapshot?.activePromptAttemptId || snapshot?.promptRequestId != null) {
    options.onRejectedBeforeAcceptance?.();
    return;
  }

  const userMessageAlreadyPresent = snapshot?.messages.some(
    (message) => message.role === 'user' && message.id === userMessage.id
  );

  const existingTerminalIds = new Set(
    (options.getCurrentSnapshot()?.messages ?? [])
      .map(getTurnTerminalRecord)
      .filter((terminal) => terminal !== undefined)
      .map((terminal) => terminal.terminal_message_id)
  );
  const userCheckpoint =
    turnRetry === undefined
      ? findPendingUserCheckpointTerminal(options.getCurrentSnapshot(), userMessage)
      : undefined;
  const checkpointContext = userCheckpoint
    ? {
        schemaVersion: 1 as const,
        checkpointId: userCheckpoint.checkpoint_id!,
        sourceRunId: userCheckpoint.run_id,
        sourceUserMessageId: userCheckpoint.source_user_message_id,
        sourceTerminalMessageId: userCheckpoint.terminal_message_id,
      }
    : undefined;

  const promptAttemptId = uuidv7();
  if (!userMessage.id) {
    throw new Error('Prompt message requires an id');
  }
  if (!acpChatSessionActions.startPromptRequest(sessionId, promptAttemptId)) {
    options.onRejectedBeforeAcceptance?.();
    return;
  }
  acpChatSessionActions.startPromptAttempt(sessionId, promptAttemptId, userMessage.id);
  const startedAtMs = Date.now();
  const composerStartedAtMs = options.submittedAtMs;
  const fromComposer = automaticCheckpointResumeCount === 0 &&
    typeof composerStartedAtMs === 'number' && Number.isFinite(composerStartedAtMs) &&
    composerStartedAtMs <= startedAtMs;
  const submittedAtMs = fromComposer ? composerStartedAtMs : startedAtMs;
  const trace = (stage: string, fields: Record<string, string | number | boolean | null> = {}) => {
    if (!import.meta.env.DEV) return;
    try {
      window.electron.logInfo(JSON.stringify({
        tag: 'stream_timing', stage, at_ms: Date.now(), session_id: sessionId,
        prompt_attempt_id: promptAttemptId, source_user_message_id: userMessage.id,
        submitted_at_ms: submittedAtMs, prompt_started_at_ms: startedAtMs, ...fields,
      }));
    } catch { /* Diagnostics must not affect submission or delivery. */ }
  };
  trace('prompt_submitted', { origin: fromComposer ? 'composer' : 'prompt' });
  let firstOutputLogged = false;
  let accepted = false;
  let manualCompactionId: string | undefined;
  let manualCompactionFailed = false;
  const unsubscribe = subscribeToAcpChatSession(sessionId, (nextSnapshot) => {
    if (nextSnapshot.activePromptAttemptId === promptAttemptId) {
      const compaction = nextSnapshot.compactionLifecycle;
      if (compaction?.trigger === 'manual' && compaction.status === 'started')
        manualCompactionId = compaction.operationId;
      if (compaction?.operationId === manualCompactionId && compaction?.status === 'failed')
        manualCompactionFailed = true;
    }
    const activity = nextSnapshot.promptActivity;
    if (!firstOutputLogged && nextSnapshot.activePromptAttemptId === promptAttemptId &&
      activity?.promptAttemptId === promptAttemptId && activity.receivedAt !== undefined &&
      (activity.kind === 'text' || activity.kind === 'thought')) {
      firstOutputLogged = true;
      trace('ui_first_token_received', {
        kind: activity.kind, received_at_ms: activity.receivedAt,
        elapsed_ms: activity.receivedAt - submittedAtMs,
        document_visibility: document.visibilityState,
      });
    }
    if (
      !accepted &&
      nextSnapshot.activePromptAttemptId === promptAttemptId &&
      (nextSnapshot.activeRunId !== null ||
        (!userMessageAlreadyPresent &&
          nextSnapshot.messages.some(
            (message) => message.role === 'user' && message.id === userMessage.id
          )))
    ) {
      // Consume the draft with its server-echoed bubble, before slow run startup.
      // A message already in history is not a receipt for this submission.
      accepted = true;
      trace('user_message_accepted');
      options.onAccepted?.();
    }
  });

  try {
    const selected = snapshot?.session;
    if (automaticCheckpointResumeCount === 0 && !turnRetry &&
      selected?.provider_name && selected.model_config?.model_name &&
      readThinkingDraft(selected.provider_name, selected.model_config.model_name) !== undefined) {
      await applyThinkingDraft(selected.provider_name, selected.model_config.model_name);
      assertNoPendingPromptCancellation(sessionId);
    }
    const response = checkpointContext
      ? await acpPromptSession(sessionId, userMessage, turnRetry, checkpointContext)
      : await acpPromptSession(sessionId, userMessage, turnRetry);
    if (!accepted && response.stopReason === 'cancelled') {
      options.onRejectedBeforeAcceptance?.();
    } else if (!accepted) {
      accepted = true;
      options.onAccepted?.();
    }
    if (acpChatSessionActions.clearPromptCancellation(sessionId, promptAttemptId)) {
      return;
    }
    if (
      response.stopReason === 'cancelled' &&
      acpChatSessionActions.startPromptCancellation(sessionId, promptAttemptId)
    ) {
      acpChatSessionActions.clearPromptCancellation(sessionId, promptAttemptId);
      void options.onFinish();
      return;
    }
    const stopError = response.stopReason === 'max_tokens'
      ? '模型因输出长度限制结束，本轮未正常完成。已执行的操作请先核对，再决定是否继续。'
      : undefined;
    if (stopError) {
      if (acpChatSessionActions.finishPromptAttemptIfCurrent(sessionId, promptAttemptId, stopError))
        void options.onFinish(stopError);
      return;
    }
    if (!acpChatSessionActions.finishPromptAttemptIfCurrent(sessionId, promptAttemptId)) {
      return;
    }

    const checkpoint = findNewCheckpointTerminal(options.getCurrentSnapshot(), existingTerminalIds);
    if (checkpoint && automaticCheckpointResumeCount < MAX_AUTOMATIC_CHECKPOINT_RESUMES) {
      const continuationMessage = createUserMessage('继续执行已保存的任务');
      continuationMessage.metadata.userVisible = false;
      acpChatSessionActions.finishPromptRequest(sessionId, promptAttemptId);
      await submitMessage(
        sessionId,
        continuationMessage,
        options,
        {
          schemaVersion: 1,
          strategy: 'continue_checkpoint',
          checkpointId: checkpoint.checkpoint_id,
          sourceRunId: checkpoint.run_id,
          sourceUserMessageId: checkpoint.source_user_message_id,
        },
        automaticCheckpointResumeCount + 1
      );
      return;
    }
    void options.onFinish();
  } catch (error) {
    trace('prompt_failed');
    if (
      acpChatSessionStore.getSnapshot(sessionId)?.pendingCancelPromptAttemptId === promptAttemptId
    ) {
      // A rejected transport request does not confirm that native cancellation
      // finished. A matching terminal or the existing reload path reconciles it.
      return;
    }

    if (isTransientAcpConnectionError(error) && isAcpRecovering()) {
      // The durable CodePro run outlives its ACP WebSocket request. Keep the
      // prompt/run identity intact while the reconnect path reloads the
      // session and replays its authoritative terminal record. Retrying the
      // prompt here would execute the user's request twice.
      if (!accepted && acpChatSessionStore.getSnapshot(sessionId)?.activeRunId != null) {
        accepted = true;
        options.onAccepted?.();
      }
      return;
    }

    const creditsExhaustedError = parseAcpCreditsExhaustedError(error);
    if (creditsExhaustedError) {
      if (!acpChatSessionActions.isCurrentPromptAttempt(sessionId, promptAttemptId)) {
        return;
      }

      const messages = [
        ...(options.getCurrentSnapshot()?.messages ?? []),
        createAcpCreditsExhaustedMessage(creditsExhaustedError),
      ];
      if (!accepted) options.onRejectedBeforeAcceptance?.();
      acpChatSessionActions.setMessages(sessionId, messages);
      if (acpChatSessionActions.finishPromptAttemptIfCurrent(sessionId, promptAttemptId)) {
        void options.onFinish();
      }
      return;
    }

    const errorData = acpErrorData(error);
    // The matching durable receipt already explains this failed maintenance
    // operation. Do not add a second red transport-error banner to the composer.
    if (manualCompactionFailed) {
      if (acpChatSessionActions.finishPromptAttemptIfCurrent(sessionId, promptAttemptId))
        void options.onFinish();
      return;
    }
    const visionError =
      typeof errorData === 'object' &&
      errorData !== null &&
      'kind' in errorData &&
      errorData.kind === 'vision_error';
    const submitError =
      acpChatSessionStore.getSnapshot(sessionId)?.promptError ??
      (visionError ? errorMessage(error) : 'Submit error: ' + errorMessage(error));
    if (
      acpChatSessionActions.finishPromptAttemptIfCurrent(sessionId, promptAttemptId, submitError)
    ) {
      if (!accepted) options.onDeliveryUncertain?.();
      void options.onFinish(submitError);
    }
  } finally {
    trace('prompt_finished', { first_output_received: firstOutputLogged, accepted });
    unsubscribe();
    acpChatSessionActions.finishPromptRequest(sessionId, promptAttemptId);
  }
}

async function resumeAfterWorkspace(
  sessionId: string,
  sourceMessage: Message,
  sourceRunId: string,
  options: AcpSubmitMessageOptions
): Promise<void> {
  if (!sourceMessage.id || sourceMessage.role !== 'user') {
    throw new Error('Workspace continuation requires the original user message');
  }
  const currentMessages = options.getCurrentSnapshot()?.messages ?? [];
  const normalizedMessages: Message[] = [];
  let sourceFound = false;
  let sourceChanged = false;
  for (const message of currentMessages) {
    const sameSourceId = message.role === 'user' && message.id === sourceMessage.id;
    const sameReplayContent =
      message.role === 'user' &&
      message.id !== sourceMessage.id &&
      Math.abs(message.created - sourceMessage.created) <= 1 &&
      JSON.stringify(message.content) === JSON.stringify(sourceMessage.content);
    if (!sameSourceId && !sameReplayContent) {
      normalizedMessages.push(message);
      continue;
    }
    if (sourceFound) {
      sourceChanged = true;
      continue;
    }
    sourceFound = true;
    sourceChanged ||= message !== sourceMessage;
    normalizedMessages.push(sourceMessage);
  }
  if (sourceChanged) {
    acpChatSessionActions.setMessages(sessionId, normalizedMessages);
  }
  const continuationMessage: Message = {
    ...sourceMessage,
    content: [],
    metadata: {
      ...sourceMessage.metadata,
      userVisible: false,
      agentVisible: false,
    },
  };
  await submitMessage(sessionId, continuationMessage, options, {
    schemaVersion: 1,
    strategy: 'resume_after_workspace',
    checkpointId: null,
    sourceRunId,
    sourceUserMessageId: sourceMessage.id,
  });
}

function stop(sessionId: string): void {
  const storedSnapshot = acpChatSessionStore.getSnapshot(sessionId);
  // Replayed native runs may have no local session/prompt Promise to cancel.
  const storedPromptAttemptId =
    storedSnapshot?.activePromptAttemptId ?? storedSnapshot?.activeRunId;
  const hasStoredAcpPrompt = storedPromptAttemptId !== null && storedPromptAttemptId !== undefined;

  cancelAcpPermissionRequestsForSession(sessionId);
  cancelAcpElicitationRequestsForSession(sessionId);

  if (hasStoredAcpPrompt) {
    acpChatSessionActions.startPromptCancellation(sessionId, storedPromptAttemptId);
    acpCancelPrompt(sessionId).catch((error) => {
      console.warn('Failed to cancel ACP prompt:', error);
    });
    return;
  }

  acpChatSessionActions.setChatState(sessionId, ChatState.Idle);
}

async function updateMessage(
  sessionId: string,
  messageId: string,
  newContent: string,
  editType: MessageEditType | undefined,
  options: AcpSubmitMessageOptions
): Promise<void> {
  assertNoPendingPromptCancellation(sessionId);

  const resolvedEditType = editType ?? 'edit';
  const currentSnapshot = options.getCurrentSnapshot();
  const storedSnapshot = acpChatSessionStore.getSnapshot(sessionId);
  const activePromptAttemptId = storedSnapshot?.activePromptAttemptId;
  const currentMessages = currentSnapshot?.messages ?? [];
  const message = currentMessages.find((m) => m.id === messageId);

  if (!message) {
    throw new Error(`Message with id ${messageId} not found in current messages`);
  }

  if (resolvedEditType === 'retry_validation') {
    const terminal = getTurnTerminalRecord(message);
    const hasDirectSuccessor = currentMessages
      .slice(currentMessages.indexOf(message) + 1)
      .some(
        (candidate) =>
          getTurnTerminalRecord(candidate)?.retry_of_terminal_message_id ===
          terminal?.terminal_message_id
      );
    if (
      message.role !== 'assistant' ||
      terminal?.status !== 'failed' ||
      terminal.retry_strategy !== 'retry_failed_validation' ||
      terminal.checkpoint_id !== null ||
      terminal.terminal_message_id !== message.id ||
      !terminal.validation_retry ||
      hasDirectSuccessor
    ) {
      throw new Error('Only the latest failed validation terminal can be retried');
    }
    const retryMessage = createUserMessage('重新运行失败验证');
    acpChatSessionActions.setMessages(sessionId, [...currentMessages, retryMessage]);
    await submitMessage(sessionId, retryMessage, options, {
      schemaVersion: 1,
      strategy: 'retry_failed_validation',
      checkpointId: null,
      sourceRunId: terminal.run_id,
      sourceUserMessageId: terminal.source_user_message_id,
      sourceTerminalMessageId: terminal.terminal_message_id,
    });
    return;
  }

  if (resolvedEditType === 'continue') {
    const terminal = getTurnTerminalRecord(message);
    if (
      message.role !== 'assistant' ||
      !newContent.trim() ||
      terminal?.retry_strategy !== 'continue_checkpoint' ||
      !terminal.checkpoint_id
    ) {
      throw new Error('Only an assistant checkpoint can continue a paused run');
    }
    await submitMessage(sessionId, createUserMessage(newContent), options, {
      schemaVersion: 1,
      strategy: 'continue_checkpoint',
      checkpointId: terminal.checkpoint_id,
      sourceRunId: terminal.run_id,
      sourceUserMessageId: terminal.source_user_message_id,
    });
    return;
  }

  if (resolvedEditType === 'replay') {
    const terminal = getTurnTerminalRecord(message);
    if (
      message.role !== 'assistant' ||
      terminal?.retry_strategy !== 'replay_user_request' ||
      terminal.checkpoint_id !== null ||
      terminal.terminal_message_id !== message.id
    ) {
      throw new Error('Only a terminal with an original user request can create a linked replay');
    }

    let replaySource = findReplaySource(currentMessages, terminal);
    if (!replaySource) {
      await loadSessionFromServer(sessionId);
      replaySource = findReplaySource(
        acpChatSessionStore.getSnapshot(sessionId)?.messages ?? [],
        terminal
      );
    }
    if (!replaySource) {
      throw new Error('Only a terminal with an original user request can create a linked replay');
    }

    const replayMessage = createUserMessage(replaySource.sourceText);
    replayMessage.content.push(
      ...replaySource.source.content.filter((content) => content.type === 'image')
    );
    acpChatSessionActions.setMessages(sessionId, [...replaySource.messages, replayMessage]);
    await submitMessage(sessionId, replayMessage, options, {
      schemaVersion: 1,
      strategy: 'replay_user_request',
      checkpointId: null,
      sourceRunId: terminal.run_id,
      sourceUserMessageId: terminal.source_user_message_id,
    });
    return;
  }

  if (resolvedEditType === 'retry') {
    if (activePromptAttemptId) {
      throw new Error('Cannot retry while a prompt is active');
    }
    const sourceContent = getTextAndImageContent(message);
    const sourceImages = message.content.filter((content) => content.type === 'image');
    if (
      message.role !== 'user' ||
      !message.metadata.userVisible ||
      (!sourceContent.textContent.trim() && sourceImages.length === 0)
    ) {
      throw new Error('Only a visible user request can be retried');
    }

    // Keep the native history and completed tool receipts. Replaying the source
    // prompt (especially its attachments) starts the work over instead of resuming it.
    const retryMessage = createUserMessage('请从当前对话已有的进度继续完成任务。保留已经完成的工作和工具结果；有执行结果不确定的操作，先检查状态，不要直接重复执行。');
    retryMessage.metadata.userVisible = false;
    retryMessage.metadata.presentation = {
      afterMessageId: currentMessages[currentMessages.length - 1]?.id ?? message.id!,
      continuation: true,
    };
    acpChatSessionActions.setMessages(sessionId, [...currentMessages, retryMessage]);
    await submitMessage(sessionId, retryMessage, options);
    return;
  }

  if (resolvedEditType === 'fork') {
    await forkSessionWithEditedMessage(sessionId, message, newContent);
    return;
  }

  if (resolvedEditType !== 'edit') {
    throw new Error(`Unsupported message edit type: ${String(resolvedEditType)}`);
  }

  const editSnapshot = storedSnapshot ?? currentSnapshot;
  if (
    editSnapshot?.chatState !== ChatState.Idle ||
    activePromptAttemptId ||
    editSnapshot?.activeRunId
  ) {
    throw new Error('Messages can only be edited after the current response has stopped');
  }

  acpChatSessionActions.setChatState(sessionId, ChatState.Thinking);

  try {
    await acpTruncateSessionConversation(sessionId, message.created);

    const truncatedMessages = currentMessages.slice(0, currentMessages.indexOf(message));
    const updatedUserMessage = createUserMessage(newContent);

    for (const content of message.content) {
      if (content.type === 'image') {
        updatedUserMessage.content.push(content);
      }
    }

    const messagesForUI = [...truncatedMessages, updatedUserMessage];
    acpChatSessionActions.setMessages(sessionId, messagesForUI);

    await submitMessage(sessionId, updatedUserMessage, options);
  } catch (error) {
    acpChatSessionActions.setChatState(sessionId, ChatState.Idle);
    throw error;
  }
}

export const acpChatSessionController: AcpChatSessionController = {
  createSession,
  loadSession,
  restoreSession,
  reconfirmCodeProWorkspace,
  submitMessage,
  resumeAfterWorkspace,
  stop,
  updateMessage,
};
