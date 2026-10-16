import { useEffect, useState } from 'react';
import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import type { TokenState } from '../types/chat';
import { ChatState } from '../types/chatState';
import { parseCompactionLifecycle, type CompactionLifecycle } from '../types/compactionLifecycle';
import type { Message, NotificationEvent } from '../types/message';
import type { Session } from '../types/session';
import { parseSessionMode } from '../utils/sessionMode';
import { isTerminalActivityEventStatus, parseActivityEvent } from '../types/activityEvent';
import {
  createAcpSessionNotificationAdapter,
  type AcpChatStateChange,
  type AcpSessionNotificationAdapter,
} from './sessionNotificationAdapter';
import type { ElicitationStatus } from './adapter/elicitations';
import type { CodeProWorkspaceReconfirmationRequest } from '../codepro/resumeCodeProSession';
import { cloneMessage, getGooseActiveRunId, getGooseMessageMeta } from './adapter/shared';
import type { AcpElicitationRequest } from './elicitationRequests';
import {
  createCancelledToolTurnTerminalMessage,
  isTurnTerminalRecord,
} from '../types/turnTerminal';

// Reception observations only. They do not describe the model's internal work.
export interface PromptActivity {
  promptAttemptId: string;
  sourceUserMessageId: string;
  startedAt: number;
  receivedAt?: number;
  kind?: 'text' | 'thought' | 'tool';
}

export interface AcpChatSessionSnapshot {
  session: Session | undefined;
  messages: Message[];
  tokenState: TokenState;
  notifications: NotificationEvent[];
  progressMessage: string | undefined;
  compactionLifecycle?: CompactionLifecycle;
  chatState: ChatState;
  sessionLoadError: string | undefined;
  workspaceReconfirmation?: CodeProWorkspaceReconfirmationRequest;
  promptError: string | undefined;
  activePromptAttemptId: string | null;
  // Transport occupancy is independent of the authoritative display terminal.
  promptRequestId?: string | null;
  activeRunId: string | null;
  activeToolCallIds?: string[];
  // Ephemeral UI activity, never persisted or used for execution/completion.
  thinkingActivity?: { messageId?: string; receivedAt: number };
  promptActivity?: PromptActivity;
  pendingCancelPromptAttemptId: string | null;
}

type SnapshotListener = (snapshot: AcpChatSessionSnapshot) => void;

interface StoreEntry extends AcpChatSessionSnapshot {
  liveToolCallIds: Set<string>;
  adapter: AcpSessionNotificationAdapter;
  sessionReplayActive: boolean;
  activePromptSourceUserMessageId: string | null;
  promptCancellationRestoreState: {
    activeRunId: string | null;
    chatState: ChatState;
    pendingUserInputRequestIds: Set<string>;
    terminalMessageId: string | null;
    sealedRunId: string;
    nativeTerminalReceived: boolean;
    nativeReleaseReceived: boolean;
  } | null;
  pendingUserInputRequestIds: Set<string>;
  pendingLocalSteerMessageIds: Set<string>;
  sealedRunIds: Set<string>;
  sealedIdleBoundaryActive: boolean;
}

const initialTokenState: TokenState = {
  contextUsageKnown: false,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  accumulatedInputTokens: 0,
  accumulatedOutputTokens: 0,
  accumulatedTotalTokens: 0,
};

export interface AcpChatSessionStore {
  getSnapshot(sessionId: string): AcpChatSessionSnapshot | undefined;
  getActivePromptSourceUserMessageId(sessionId: string): string | null;
}

export interface AcpChatSessionActions {
  deleteSnapshot(sessionId: string): void;

  applyAcpSessionNotification(notification: SessionNotification): AcpChatSessionSnapshot;
  applyAcpGooseSessionNotification(
    notification: GooseSessionNotification_unstable
  ): AcpChatSessionSnapshot;
  applyPermissionRequest(request: RequestPermissionRequest): AcpChatSessionSnapshot;
  applyElicitationRequest(request: AcpElicitationRequest): AcpChatSessionSnapshot;
  setElicitationStatus(
    sessionId: string,
    elicitationId: string,
    status: ElicitationStatus
  ): AcpChatSessionSnapshot | undefined;

  setSessionMetadata(sessionId: string, session: Session | undefined): AcpChatSessionSnapshot;
  startSessionLoad(sessionId: string): AcpChatSessionSnapshot;
  finishSessionLoad(sessionId: string, session: Session): AcpChatSessionSnapshot;
  failSessionLoad(sessionId: string, sessionLoadError: string): AcpChatSessionSnapshot;
  requireWorkspaceReconfirmation(
    sessionId: string,
    request: CodeProWorkspaceReconfirmationRequest
  ): AcpChatSessionSnapshot;
  setSessionLoadError(
    sessionId: string,
    sessionLoadError: string | undefined
  ): AcpChatSessionSnapshot;
  clearPromptError(sessionId: string): AcpChatSessionSnapshot;

  setMessages(sessionId: string, messages: Message[]): AcpChatSessionSnapshot;
  addPendingLocalSteerMessage(sessionId: string, message: Message): AcpChatSessionSnapshot;
  setChatState(sessionId: string, chatState: ChatState): AcpChatSessionSnapshot;
  resolveUserInputRequest(
    sessionId: string,
    userInputRequestId: string
  ): AcpChatSessionSnapshot | undefined;

  startPromptRequest(sessionId: string, requestId: string): boolean;
  finishPromptRequest(sessionId: string, requestId: string): void;
  startPromptAttempt(
    sessionId: string,
    promptAttemptId: string,
    sourceUserMessageId: string
  ): AcpChatSessionSnapshot;
  startPromptCancellation(
    sessionId: string,
    promptAttemptId: string
  ): AcpChatSessionSnapshot | undefined;
  clearPromptCancellation(
    sessionId: string,
    promptAttemptId: string
  ): AcpChatSessionSnapshot | undefined;
  restorePromptCancellation(
    sessionId: string,
    promptAttemptId: string
  ): AcpChatSessionSnapshot | undefined;
  waitForPromptCancellation(sessionId: string, promptAttemptId: string): Promise<void>;
  finishPromptAttemptIfCurrent(sessionId: string, promptAttemptId: string, error?: string): boolean;
  clearActivePromptAttempt(sessionId: string): AcpChatSessionSnapshot | undefined;
  isCurrentPromptAttempt(sessionId: string, promptAttemptId: string): boolean;
}

interface AcpChatSessionStoreInternal extends AcpChatSessionStore, AcpChatSessionActions {
  subscribe(sessionId: string, listener: (snapshot: AcpChatSessionSnapshot) => void): () => void;
}

function createAcpChatSessionStoreInternal(): AcpChatSessionStoreInternal {
  const sessionsById = new Map<string, StoreEntry>();
  const listenersBySessionId = new Map<string, Set<SnapshotListener>>();

  const getSnapshot: AcpChatSessionStore['getSnapshot'] = (sessionId) => {
    const entry = sessionsById.get(sessionId);
    return entry ? snapshotFromEntry(entry) : undefined;
  };

  const getActivePromptSourceUserMessageId: AcpChatSessionStore['getActivePromptSourceUserMessageId'] =
    (sessionId) => sessionsById.get(sessionId)?.activePromptSourceUserMessageId ?? null;

  const subscribe: AcpChatSessionStoreInternal['subscribe'] = (sessionId, listener) => {
    const listeners = listenersBySessionId.get(sessionId) ?? new Set<SnapshotListener>();
    listeners.add(listener);
    listenersBySessionId.set(sessionId, listeners);

    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      const currentListeners = listenersBySessionId.get(sessionId);
      if (!currentListeners) {
        return;
      }

      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        listenersBySessionId.delete(sessionId);
      }
    };
  };

  const deleteSnapshot: AcpChatSessionActions['deleteSnapshot'] = (sessionId) => {
    sessionsById.delete(sessionId);
  };

  const getOrCreateEntry = (sessionId: string): StoreEntry => {
    const existing = sessionsById.get(sessionId);
    if (existing) {
      return existing;
    }

    const entry: StoreEntry = {
      session: undefined,
      messages: [],
      tokenState: { ...initialTokenState },
      notifications: [],
      progressMessage: undefined,
      compactionLifecycle: undefined,
      chatState: ChatState.Idle,
      sessionLoadError: undefined,
      promptError: undefined,
      activePromptAttemptId: null,
      promptRequestId: null,
      activePromptSourceUserMessageId: null,
      activeRunId: null,
      liveToolCallIds: new Set(),
      pendingCancelPromptAttemptId: null,
      promptCancellationRestoreState: null,
      pendingUserInputRequestIds: new Set(),
      pendingLocalSteerMessageIds: new Set(),
      sealedRunIds: new Set(),
      sealedIdleBoundaryActive: false,
      sessionReplayActive: false,
      adapter: createAcpSessionNotificationAdapter(),
    };
    sessionsById.set(sessionId, entry);
    return entry;
  };

  const notify = (sessionId: string, entry: StoreEntry): AcpChatSessionSnapshot => {
    const snapshot = snapshotFromEntry(entry);
    const listeners = listenersBySessionId.get(sessionId);
    if (listeners) {
      for (const listener of listeners) {
        listener(snapshot);
      }
    }
    return snapshot;
  };

  const setSessionMetadata: AcpChatSessionActions['setSessionMetadata'] = (sessionId, session) => {
    const entry = getOrCreateEntry(sessionId);
    entry.session = session;
    return notify(sessionId, entry);
  };

  const startSessionLoad: AcpChatSessionActions['startSessionLoad'] = (sessionId) => {
    const entry = getOrCreateEntry(sessionId);
    resetReplayState(entry);
    entry.sessionReplayActive = true;
    entry.sessionLoadError = undefined;
    entry.workspaceReconfirmation = undefined;
    entry.promptError = undefined;
    entry.progressMessage = undefined;
    entry.compactionLifecycle = undefined;
    entry.chatState = ChatState.LoadingConversation;
    return notify(sessionId, entry);
  };

  const finishSessionLoad: AcpChatSessionActions['finishSessionLoad'] = (sessionId, session) => {
    const entry = getOrCreateEntry(sessionId);
    entry.sessionReplayActive = false;
    entry.session = session;
    entry.sessionLoadError = undefined;
    entry.workspaceReconfirmation = undefined;
    entry.promptError = undefined;
    entry.progressMessage = undefined;
    const hasLiveRun = Boolean(entry.activePromptAttemptId || entry.activeRunId);
    if (!hasLiveRun) {
      entry.compactionLifecycle = undefined;
      terminalizeCodeProActivities(entry, sessionId, 'interrupted');
      entry.adapter = createAdapterForEntry(entry);
    }
    entry.chatState = hasLiveRun
      ? entry.compactionLifecycle?.status === 'started'
        ? ChatState.Compacting
        : ChatState.Streaming
      : ChatState.Idle;
    return notify(sessionId, entry);
  };

  const failSessionLoad: AcpChatSessionActions['failSessionLoad'] = (
    sessionId,
    sessionLoadError
  ) => {
    const entry = getOrCreateEntry(sessionId);
    entry.sessionLoadError = sessionLoadError;
    entry.sessionReplayActive = false;
    entry.workspaceReconfirmation = undefined;
    entry.progressMessage = undefined;
    entry.compactionLifecycle = undefined;
    entry.chatState = ChatState.Idle;
    return notify(sessionId, entry);
  };

  const requireWorkspaceReconfirmation: AcpChatSessionActions['requireWorkspaceReconfirmation'] = (
    sessionId,
    request
  ) => {
    const entry = getOrCreateEntry(sessionId);
    entry.sessionLoadError = undefined;
    entry.workspaceReconfirmation = request;
    entry.sessionReplayActive = false;
    entry.progressMessage = undefined;
    entry.compactionLifecycle = undefined;
    entry.chatState = ChatState.Idle;
    return notify(sessionId, entry);
  };

  const setMessages: AcpChatSessionActions['setMessages'] = (sessionId, messages) => {
    const entry = getOrCreateEntry(sessionId);
    entry.messages = cloneMessages(messages);
    retainPendingLocalSteerMessageIds(entry);
    entry.adapter = createAdapterForEntry(entry);
    return notify(sessionId, entry);
  };

  const addPendingLocalSteerMessage: AcpChatSessionActions['addPendingLocalSteerMessage'] = (
    sessionId,
    message
  ) => {
    const entry = getOrCreateEntry(sessionId);
    if (!message.id || entry.messages.some((existing) => existing.id === message.id)) {
      return notify(sessionId, entry);
    }

    entry.messages = [...entry.messages, cloneMessage(message)];
    entry.pendingLocalSteerMessageIds.add(message.id);
    entry.adapter = createAdapterForEntry(entry);
    return notify(sessionId, entry);
  };

  const setChatState: AcpChatSessionActions['setChatState'] = (sessionId, chatState) => {
    const entry = getOrCreateEntry(sessionId);
    if (chatState === ChatState.Idle) {
      entry.progressMessage = undefined;
      entry.compactionLifecycle = undefined;
    }
    entry.chatState = chatState;
    return notify(sessionId, entry);
  };

  const resolveUserInputRequest: AcpChatSessionActions['resolveUserInputRequest'] = (
    sessionId,
    userInputRequestId
  ) => {
    const entry = sessionsById.get(sessionId);
    if (!entry) {
      return undefined;
    }

    entry.pendingUserInputRequestIds.delete(userInputRequestId);

    if (
      (entry.activePromptAttemptId || entry.liveToolCallIds.size > 0) &&
      entry.chatState === ChatState.WaitingForUserInput &&
      entry.pendingUserInputRequestIds.size === 0
    ) {
      entry.chatState = ChatState.Streaming;
      return notify(sessionId, entry);
    }

    return snapshotFromEntry(entry);
  };

  const setSessionLoadError: AcpChatSessionActions['setSessionLoadError'] = (
    sessionId,
    sessionLoadError
  ) => {
    const entry = getOrCreateEntry(sessionId);
    entry.sessionLoadError = sessionLoadError;
    return notify(sessionId, entry);
  };

  const clearPromptError: AcpChatSessionActions['clearPromptError'] = (sessionId) => {
    const entry = getOrCreateEntry(sessionId);
    entry.promptError = undefined;
    return notify(sessionId, entry);
  };

  const startPromptRequest: AcpChatSessionActions['startPromptRequest'] = (
    sessionId,
    requestId
  ) => {
    const entry = getOrCreateEntry(sessionId);
    if (entry.promptRequestId != null) return false;
    entry.promptRequestId = requestId;
    notify(sessionId, entry);
    return true;
  };

  const finishPromptRequest: AcpChatSessionActions['finishPromptRequest'] = (
    sessionId,
    requestId
  ) => {
    const entry = sessionsById.get(sessionId);
    if (!entry || entry.promptRequestId !== requestId) return;
    entry.promptRequestId = null;
    notify(sessionId, entry);
  };

  const startPromptAttempt: AcpChatSessionActions['startPromptAttempt'] = (
    sessionId,
    promptAttemptId,
    sourceUserMessageId
  ) => {
    const entry = getOrCreateEntry(sessionId);
    discardPendingLocalSteerMessages(entry);
    entry.activePromptAttemptId = promptAttemptId;
    entry.liveToolCallIds.clear();
    entry.thinkingActivity = undefined;
    entry.promptActivity = {
      promptAttemptId,
      sourceUserMessageId,
      startedAt: Date.now(),
    };
    entry.activePromptSourceUserMessageId = sourceUserMessageId;
    entry.activeRunId = null;
    entry.pendingCancelPromptAttemptId = null;
    entry.promptCancellationRestoreState = null;
    entry.sealedIdleBoundaryActive = false;
    entry.pendingUserInputRequestIds.clear();
    entry.chatState = ChatState.Streaming;
    entry.sessionLoadError = undefined;
    entry.promptError = undefined;
    entry.notifications = [];
    entry.progressMessage = undefined;
    entry.compactionLifecycle = undefined;
    return notify(sessionId, entry);
  };

  const startPromptCancellation: AcpChatSessionActions['startPromptCancellation'] = (
    sessionId,
    promptAttemptId
  ) => {
    const entry = sessionsById.get(sessionId);
    if (
      !entry ||
      (entry.activePromptAttemptId !== promptAttemptId &&
        !(entry.activePromptAttemptId === null && entry.activeRunId === promptAttemptId))
    ) {
      return undefined;
    }

    const sealedRunId = entry.activeRunId ?? promptAttemptId;
    entry.promptCancellationRestoreState = {
      activeRunId: entry.activeRunId,
      chatState: entry.chatState,
      pendingUserInputRequestIds: new Set(entry.pendingUserInputRequestIds),
      terminalMessageId: null,
      sealedRunId,
      nativeTerminalReceived: false,
      nativeReleaseReceived: false,
    };
    entry.sealedRunIds.add(sealedRunId);
    entry.sealedIdleBoundaryActive = true;
    terminalizeCodeProActivities(entry, sessionId, 'stopped');
    const terminalMessage = createCancelledToolTurnTerminalMessage(
      sessionId,
      entry.activeRunId ?? promptAttemptId,
      entry.messages
    );
    if (terminalMessage) {
      entry.messages = [...entry.messages, terminalMessage];
      entry.promptCancellationRestoreState.terminalMessageId = terminalMessage.id ?? null;
    }
    entry.adapter = createAdapterForEntry(entry);
    entry.activePromptAttemptId = null;
    entry.pendingCancelPromptAttemptId = promptAttemptId;
    entry.pendingUserInputRequestIds.clear();
    discardPendingLocalSteerMessages(entry);
    entry.progressMessage = undefined;
    entry.compactionLifecycle = undefined;
    entry.chatState = ChatState.Idle;
    return notify(sessionId, entry);
  };

  const clearPromptCancellation: AcpChatSessionActions['clearPromptCancellation'] = (
    sessionId,
    promptAttemptId
  ) => {
    const entry = sessionsById.get(sessionId);
    if (!entry || entry.pendingCancelPromptAttemptId !== promptAttemptId) {
      return undefined;
    }

    entry.pendingCancelPromptAttemptId = null;
    entry.promptCancellationRestoreState = null;
    entry.activePromptSourceUserMessageId = null;
    return notify(sessionId, entry);
  };

  const restorePromptCancellation: AcpChatSessionActions['restorePromptCancellation'] = (
    sessionId,
    promptAttemptId
  ) => {
    const entry = sessionsById.get(sessionId);
    if (
      !entry ||
      entry.pendingCancelPromptAttemptId !== promptAttemptId ||
      !entry.promptCancellationRestoreState
    ) {
      return undefined;
    }

    const restoreState = entry.promptCancellationRestoreState;
    if (
      hasAuthoritativeTerminalForRun(
        entry,
        restoreState.sealedRunId,
        restoreState.terminalMessageId
      )
    ) {
      // A terminal prevents restoring the old run, but is not transport release.
      finishNativeCancellationIfConfirmed(entry);
      return notify(sessionId, entry);
    }
    entry.sealedRunIds.delete(restoreState.sealedRunId);
    entry.sealedIdleBoundaryActive = false;
    if (restoreState.terminalMessageId) {
      entry.messages = entry.messages.filter(
        (message) => message.id !== restoreState.terminalMessageId
      );
      entry.adapter = createAdapterForEntry(entry);
    }
    entry.activePromptAttemptId = promptAttemptId;
    entry.activeRunId = restoreState.activeRunId;
    entry.pendingCancelPromptAttemptId = null;
    entry.promptCancellationRestoreState = null;
    entry.sealedIdleBoundaryActive = false;
    entry.pendingUserInputRequestIds = new Set(restoreState.pendingUserInputRequestIds);
    entry.chatState = restoreState.chatState;
    return notify(sessionId, entry);
  };

  const waitForPromptCancellation: AcpChatSessionActions['waitForPromptCancellation'] = (
    sessionId,
    promptAttemptId
  ) => {
    const entry = sessionsById.get(sessionId);
    if (!entry || entry.pendingCancelPromptAttemptId !== promptAttemptId) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const unsubscribe = subscribe(sessionId, (snapshot) => {
        if (snapshot.pendingCancelPromptAttemptId !== promptAttemptId) {
          unsubscribe();
          resolve();
        }
      });
    });
  };

  const finishPromptAttemptIfCurrent: AcpChatSessionActions['finishPromptAttemptIfCurrent'] = (
    sessionId,
    promptAttemptId,
    error
  ) => {
    const entry = sessionsById.get(sessionId);
    if (!entry || entry.activePromptAttemptId !== promptAttemptId) {
      return false;
    }

    entry.activePromptAttemptId = null;
    entry.activePromptSourceUserMessageId = null;
    entry.activeRunId = null;
    entry.liveToolCallIds.clear();
    entry.pendingCancelPromptAttemptId = null;
    entry.promptCancellationRestoreState = null;
    entry.pendingUserInputRequestIds.clear();
    discardPendingLocalSteerMessages(entry);
    entry.progressMessage = undefined;
    entry.compactionLifecycle = undefined;
    entry.chatState = ChatState.Idle;
    entry.sealedIdleBoundaryActive = false;
    entry.promptError = error;
    notify(sessionId, entry);
    return true;
  };

  const clearActivePromptAttempt: AcpChatSessionActions['clearActivePromptAttempt'] = (
    sessionId
  ) => {
    const entry = sessionsById.get(sessionId);
    if (!entry) {
      return undefined;
    }

    entry.activePromptAttemptId = null;
    entry.activePromptSourceUserMessageId = null;
    entry.activeRunId = null;
    entry.liveToolCallIds.clear();
    entry.pendingUserInputRequestIds.clear();
    discardPendingLocalSteerMessages(entry);
    entry.chatState = ChatState.Idle;
    return notify(sessionId, entry);
  };

  const isCurrentPromptAttempt: AcpChatSessionActions['isCurrentPromptAttempt'] = (
    sessionId,
    promptAttemptId
  ) => sessionsById.get(sessionId)?.activePromptAttemptId === promptAttemptId;

  const applyAcpSessionNotification: AcpChatSessionActions['applyAcpSessionNotification'] = (
    notification
  ) => {
    const entry = getOrCreateEntry(notification.sessionId);
    if (shouldIgnoreAcpNotificationForSealedTurn(entry, notification)) {
      return snapshotFromEntry(entry);
    }
    if (
      entry.compactionLifecycle?.status !== 'started' &&
      shouldClearProgressMessage(notification, entry.progressMessage)
    ) {
      entry.progressMessage = undefined;
    }
    if (notification.update.sessionUpdate === 'current_mode_update' && entry.session) {
      entry.session = {
        ...entry.session,
        goose_mode: parseSessionMode(notification.update.currentModeId),
      };
    }
    const update = notification.update;
    const currentPromptActivity =
      !entry.sessionReplayActive &&
      entry.activePromptAttemptId !== null &&
      isCurrentPromptActivity(entry, notification);
    if (currentPromptActivity && entry.promptActivity) {
      const kind =
        (update.sessionUpdate === 'agent_message_chunk' ||
          update.sessionUpdate === 'agent_thought_chunk') &&
        update.content.type === 'text' &&
        update.content.text.length > 0
          ? update.sessionUpdate === 'agent_message_chunk'
            ? 'text'
            : 'thought'
          : update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
            ? 'tool'
            : undefined;
      if (kind) entry.promptActivity = { ...entry.promptActivity, kind, receivedAt: Date.now() };
    }
    if (currentPromptActivity) {
      if (
        update.sessionUpdate === 'agent_thought_chunk' &&
        update.content.type === 'text' &&
        update.content.text.length > 0
      ) {
        entry.thinkingActivity = {
          messageId: update.messageId ?? getGooseMessageMeta(update).messageId,
          receivedAt: Date.now(),
        };
      } else if (
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update'
      ) {
        entry.thinkingActivity = undefined;
      }
    }
    // Presentation only: admit new calls during this session's live attempt.
    // Replayed/history calls and late updates cannot acquire a new running badge.
    if (
      !entry.sessionReplayActive &&
      (entry.activePromptAttemptId !== null || hasDirectToolOrigin(update._meta)) &&
      update.sessionUpdate === 'tool_call' &&
      !entry.messages.some((message) =>
        message.content.some(
          (content) =>
            (content.type === 'toolRequest' || content.type === 'toolResponse') &&
            content.id === update.toolCallId
        )
      )
    ) {
      entry.liveToolCallIds.add(update.toolCallId);
    }
    const changes = entry.adapter.apply(notification);
    applyChatStateChanges(entry, changes);
    if (
      update.sessionUpdate === 'tool_call_update' &&
      (update.status === 'completed' || update.status === 'failed')
    ) {
      entry.liveToolCallIds.delete(update.toolCallId);
      if (
        hasDirectToolOrigin(update._meta) &&
        !entry.activePromptAttemptId &&
        !entry.activeRunId &&
        entry.liveToolCallIds.size === 0 &&
        entry.pendingUserInputRequestIds.size === 0
      )
        entry.chatState = ChatState.Idle;
    }
    return notify(notification.sessionId, entry);
  };

  const applyAcpGooseSessionNotification: AcpChatSessionActions['applyAcpGooseSessionNotification'] =
    (notification) => {
      const entry = getOrCreateEntry(notification.sessionId);
      registerTurnTerminalSeal(entry, notification);
      if (shouldIgnoreGooseNotificationForSealedTurn(entry, notification)) {
        return snapshotFromEntry(entry);
      }
      const changes = entry.adapter.applyGoose(notification, entry.sessionReplayActive);
      applyChatStateChanges(entry, changes);
      return notify(notification.sessionId, entry);
    };

  const applyPermissionRequest: AcpChatSessionActions['applyPermissionRequest'] = (request) => {
    const entry = getOrCreateEntry(request.sessionId);
    if (entry.sealedIdleBoundaryActive && !hasDirectToolOrigin(request._meta)) {
      return snapshotFromEntry(entry);
    }
    const changes = entry.adapter.applyPermissionRequest(request);
    applyChatStateChanges(entry, changes);
    entry.pendingUserInputRequestIds.add(
      acpPermissionUserInputRequestId(request.toolCall.toolCallId)
    );
    entry.chatState = ChatState.WaitingForUserInput;
    return notify(request.sessionId, entry);
  };

  const applyElicitationRequest: AcpChatSessionActions['applyElicitationRequest'] = (request) => {
    const entry = getOrCreateEntry(request.sessionId);
    if (entry.sealedIdleBoundaryActive) {
      return snapshotFromEntry(entry);
    }
    const changes = entry.adapter.applyElicitationRequest(request);
    applyChatStateChanges(entry, changes);
    entry.pendingUserInputRequestIds.add(acpElicitationUserInputRequestId(request.id));
    entry.chatState = ChatState.WaitingForUserInput;
    return notify(request.sessionId, entry);
  };

  const setElicitationStatus: AcpChatSessionActions['setElicitationStatus'] = (
    sessionId,
    elicitationId,
    status
  ) => {
    const entry = sessionsById.get(sessionId);
    if (!entry) {
      return undefined;
    }

    const changes = entry.adapter.applyElicitationStatus(elicitationId, status);
    if (changes.length === 0) {
      return snapshotFromEntry(entry);
    }

    applyChatStateChanges(entry, changes);
    return notify(sessionId, entry);
  };

  return {
    getSnapshot,
    getActivePromptSourceUserMessageId,
    subscribe,
    deleteSnapshot,
    setSessionMetadata,
    startSessionLoad,
    finishSessionLoad,
    failSessionLoad,
    requireWorkspaceReconfirmation,
    setSessionLoadError,
    clearPromptError,
    setMessages,
    addPendingLocalSteerMessage,
    setChatState,
    resolveUserInputRequest,
    startPromptRequest,
    finishPromptRequest,
    startPromptAttempt,
    startPromptCancellation,
    clearPromptCancellation,
    restorePromptCancellation,
    waitForPromptCancellation,
    finishPromptAttemptIfCurrent,
    clearActivePromptAttempt,
    isCurrentPromptAttempt,
    applyAcpSessionNotification,
    applyAcpGooseSessionNotification,
    applyPermissionRequest,
    applyElicitationRequest,
    setElicitationStatus,
  };
}

const acpChatSessionStoreInternal = createAcpChatSessionStoreInternal();

export const acpChatSessionStore: AcpChatSessionStore = storeFromInternal(
  acpChatSessionStoreInternal
);

export const acpChatSessionActions: AcpChatSessionActions = actionsFromStore(
  acpChatSessionStoreInternal
);

export function subscribeToAcpChatSession(
  sessionId: string,
  listener: (snapshot: AcpChatSessionSnapshot) => void
): () => void {
  return acpChatSessionStoreInternal.subscribe(sessionId, listener);
}

interface AcpChatSessionSnapshotState {
  sessionId: string;
  snapshot: AcpChatSessionSnapshot | undefined;
}

export function useAcpChatSessionSnapshot(sessionId: string): AcpChatSessionSnapshot | undefined {
  const [snapshotState, setSnapshotState] = useState<AcpChatSessionSnapshotState>(() => ({
    sessionId,
    snapshot: acpChatSessionStoreInternal.getSnapshot(sessionId),
  }));

  useEffect(() => {
    setSnapshotState({
      sessionId,
      snapshot: acpChatSessionStoreInternal.getSnapshot(sessionId),
    });

    return acpChatSessionStoreInternal.subscribe(sessionId, (snapshot) => {
      setSnapshotState({ sessionId, snapshot });
    });
  }, [sessionId]);

  if (snapshotState.sessionId !== sessionId) {
    return acpChatSessionStoreInternal.getSnapshot(sessionId);
  }

  return snapshotState.snapshot;
}

function storeFromInternal(store: AcpChatSessionStoreInternal): AcpChatSessionStore {
  return {
    getSnapshot: store.getSnapshot,
    getActivePromptSourceUserMessageId: store.getActivePromptSourceUserMessageId,
  };
}

function actionsFromStore(store: AcpChatSessionStoreInternal): AcpChatSessionActions {
  return {
    deleteSnapshot: store.deleteSnapshot,
    applyAcpSessionNotification: store.applyAcpSessionNotification,
    applyAcpGooseSessionNotification: store.applyAcpGooseSessionNotification,
    applyPermissionRequest: store.applyPermissionRequest,
    applyElicitationRequest: store.applyElicitationRequest,
    setElicitationStatus: store.setElicitationStatus,
    setSessionMetadata: store.setSessionMetadata,
    startSessionLoad: store.startSessionLoad,
    finishSessionLoad: store.finishSessionLoad,
    failSessionLoad: store.failSessionLoad,
    requireWorkspaceReconfirmation: store.requireWorkspaceReconfirmation,
    setSessionLoadError: store.setSessionLoadError,
    clearPromptError: store.clearPromptError,
    setMessages: store.setMessages,
    addPendingLocalSteerMessage: store.addPendingLocalSteerMessage,
    setChatState: store.setChatState,
    resolveUserInputRequest: store.resolveUserInputRequest,
    startPromptRequest: store.startPromptRequest,
    finishPromptRequest: store.finishPromptRequest,
    startPromptAttempt: store.startPromptAttempt,
    startPromptCancellation: store.startPromptCancellation,
    clearPromptCancellation: store.clearPromptCancellation,
    restorePromptCancellation: store.restorePromptCancellation,
    waitForPromptCancellation: store.waitForPromptCancellation,
    finishPromptAttemptIfCurrent: store.finishPromptAttemptIfCurrent,
    clearActivePromptAttempt: store.clearActivePromptAttempt,
    isCurrentPromptAttempt: store.isCurrentPromptAttempt,
  };
}

function applyChatStateChanges(entry: StoreEntry, changes: AcpChatStateChange[]): void {
  for (const change of changes) {
    switch (change.type) {
      case 'messages':
        entry.messages = cloneMessages(change.messages);
        retainPendingLocalSteerMessageIds(entry);
        break;
      case 'tokenState':
        entry.tokenState = {
          ...entry.tokenState,
          ...change.tokenState,
          ...(change.tokenState.totalTokens !== undefined ? { contextUsageKnown: true } : {}),
        };
        break;
      case 'progressMessage':
        entry.progressMessage = change.message;
        break;
      case 'compactionLifecycle':
        if (
          change.lifecycle.runId &&
          (entry.sealedRunIds.has(change.lifecycle.runId) ||
            (entry.activeRunId && change.lifecycle.runId !== entry.activeRunId))
        )
          break;
        entry.compactionLifecycle =
          [...entry.messages]
            .reverse()
            .flatMap((message) => message.content)
            .filter((content) => content.type === 'systemNotification')
            .map((content) => parseCompactionLifecycle(content.data))
            .find(
              (lifecycle) =>
                lifecycle?.status === 'started' &&
                (!lifecycle.runId || lifecycle.runId === change.lifecycle.runId)
            ) ?? change.lifecycle;
        if (entry.compactionLifecycle.status === 'started') {
          entry.chatState = ChatState.Compacting;
        } else if (entry.activePromptAttemptId || entry.activeRunId) {
          entry.chatState = ChatState.Streaming;
        } else if (entry.chatState === ChatState.Compacting) {
          entry.chatState = ChatState.Idle;
        }
        break;
      case 'sessionInfo':
        if (change.name && entry.session) {
          entry.session = { ...entry.session, name: change.name };
        }
        if (change.activeRunId !== undefined) {
          const cancellation = entry.promptCancellationRestoreState;
          if (
            cancellation &&
            change.activeRunId !== null &&
            change.activeRunId !== cancellation.sealedRunId
          )
            cancellation.nativeReleaseReceived = false;
          if (
            change.activeRunId === null &&
            cancellation &&
            (entry.activeRunId === null || entry.activeRunId === cancellation.sealedRunId)
          )
            cancellation.nativeReleaseReceived = true;
          entry.activeRunId = change.activeRunId;
          if (change.activeRunId !== null) {
            entry.sealedRunIds.delete(change.activeRunId);
            entry.sealedIdleBoundaryActive = false;
          }
          finishNativeCancellationIfConfirmed(entry);
        }
        break;
      case 'localSteerConfirmed':
        entry.pendingLocalSteerMessageIds.delete(change.messageId);
        break;
      case 'notification':
        entry.notifications = [...entry.notifications, change.notification];
        break;
    }
  }
}

function shouldClearProgressMessage(
  notification: SessionNotification,
  currentProgressMessage: string | undefined
): boolean {
  if (currentProgressMessage?.trimStart().startsWith('CodePro')) {
    return false;
  }

  switch (notification.update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
      return true;
    default:
      return false;
  }
}

function resetReplayState(entry: StoreEntry): void {
  entry.liveToolCallIds.clear();
  entry.thinkingActivity = undefined;
  entry.messages = [];
  entry.tokenState = { ...initialTokenState };
  entry.notifications = [];
  entry.progressMessage = undefined;
  entry.compactionLifecycle = undefined;
  entry.activeRunId = null;
  entry.pendingCancelPromptAttemptId = null;
  entry.promptCancellationRestoreState = null;
  entry.pendingUserInputRequestIds.clear();
  entry.pendingLocalSteerMessageIds.clear();
  entry.sealedRunIds.clear();
  entry.sealedIdleBoundaryActive = false;
  entry.adapter = createAcpSessionNotificationAdapter();
}

function shouldIgnoreAcpNotificationForSealedTurn(
  entry: StoreEntry,
  notification: SessionNotification
): boolean {
  if (entry.sessionReplayActive) {
    return false;
  }
  if (!entry.sealedIdleBoundaryActive) {
    return false;
  }
  if (
    (notification.update.sessionUpdate === 'tool_call' ||
      notification.update.sessionUpdate === 'tool_call_update') &&
    hasDirectToolOrigin(notification.update._meta)
  )
    return false;

  if (
    notification.update.sessionUpdate === 'usage_update' ||
    notification.update.sessionUpdate === 'current_mode_update'
  ) {
    return false;
  }
  if (notification.update.sessionUpdate !== 'session_info_update') {
    return true;
  }

  const activeRunId = getGooseActiveRunId(notification.update);
  return activeRunId !== undefined && activeRunId !== null;
}

function hasDirectToolOrigin(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || !('goose' in meta)) return false;
  const goose = meta.goose;
  return (
    !!goose &&
    typeof goose === 'object' &&
    'directToolCall' in goose &&
    goose.directToolCall === true
  );
}

function isCurrentPromptActivity(entry: StoreEntry, notification: SessionNotification): boolean {
  const update = notification.update;
  const runId = getGooseActiveRunId(update);
  if (
    runId &&
    (entry.sealedRunIds.has(runId) || (entry.activeRunId && runId !== entry.activeRunId))
  )
    return false;
  const boundary = entry.messages.findIndex((m) => m.id === entry.activePromptSourceUserMessageId);
  if (boundary < 0) return true;
  // Old receipts/text may update history, not this turn's activity or thinking lifecycle.
  const history = entry.messages.slice(0, boundary);
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    return !history.some((m) =>
      m.content.some(
        (c) => (c.type === 'toolRequest' || c.type === 'toolResponse') && c.id === update.toolCallId
      )
    );
  }
  const messageId =
    (update.sessionUpdate === 'agent_message_chunk' ||
    update.sessionUpdate === 'agent_thought_chunk'
      ? update.messageId
      : undefined) ?? getGooseMessageMeta(update).messageId;
  return !messageId || !history.some((m) => m.id === messageId);
}

function finishNativeCancellationIfConfirmed(entry: StoreEntry): void {
  const cancellation = entry.promptCancellationRestoreState;
  if (!cancellation?.nativeTerminalReceived || !cancellation.nativeReleaseReceived) return;
  if (entry.activeRunId !== null && entry.activeRunId !== cancellation.sealedRunId) return;
  entry.pendingCancelPromptAttemptId = null;
  entry.promptCancellationRestoreState = null;
  entry.activePromptSourceUserMessageId = null;
}

function registerTurnTerminalSeal(
  entry: StoreEntry,
  notification: GooseSessionNotification_unstable
): void {
  if (notification.update.sessionUpdate !== 'status_message') {
    return;
  }
  if (notification.update.status.type !== 'progress') {
    return;
  }
  const record = notification.update.status.data;
  if (!isTurnTerminalRecord(record)) {
    return;
  }

  const belongsToActivePrompt =
    entry.activePromptSourceUserMessageId === record.source_user_message_id;
  const terminatesActivePrompt =
    entry.activePromptAttemptId !== null &&
    belongsToActivePrompt &&
    (entry.activeRunId === record.run_id ||
      (entry.chatState === ChatState.LoadingConversation && entry.activeRunId === null));
  const isStaleTerminalForReusedActiveRun =
    entry.activePromptAttemptId !== null &&
    entry.activeRunId === record.run_id &&
    !belongsToActivePrompt;
  if (!isStaleTerminalForReusedActiveRun) {
    entry.sealedRunIds.add(record.run_id);
  }
  if (entry.activeRunId === record.run_id && !isStaleTerminalForReusedActiveRun) {
    entry.activeRunId = null;
  }
  const terminalMatchesObservedRun =
    entry.activeRunId === null || entry.activeRunId === record.run_id;
  const terminalMatchesCancellation =
    entry.pendingCancelPromptAttemptId === null ||
    entry.promptCancellationRestoreState?.sealedRunId === record.run_id;
  if (
    entry.pendingCancelPromptAttemptId !== null &&
    (belongsToActivePrompt || entry.activePromptSourceUserMessageId === null) &&
    entry.promptCancellationRestoreState?.sealedRunId === record.run_id
  ) {
    entry.promptCancellationRestoreState.nativeTerminalReceived = true;
    finishNativeCancellationIfConfirmed(entry);
  }
  if (
    terminatesActivePrompt ||
    (entry.activePromptAttemptId === null &&
      terminalMatchesObservedRun &&
      terminalMatchesCancellation)
  ) {
    // A persisted turn terminal is authoritative even if the ACP prompt Promise is
    // delayed or was cancelled by a disconnected WebSocket. Clear the stale
    // transport attempt so a completed replay cannot be overwritten back to
    // Streaming by finishSessionLoad.
    entry.activePromptAttemptId = null;
    if (entry.pendingCancelPromptAttemptId === null) {
      entry.activePromptSourceUserMessageId = null;
      entry.promptCancellationRestoreState = null;
    }
    entry.pendingUserInputRequestIds.clear();
    entry.progressMessage = undefined;
    if (entry.chatState !== ChatState.LoadingConversation) {
      entry.chatState = ChatState.Idle;
    }
    entry.sealedIdleBoundaryActive = true;
  }
}

function shouldIgnoreGooseNotificationForSealedTurn(
  entry: StoreEntry,
  notification: GooseSessionNotification_unstable
): boolean {
  if (entry.sessionReplayActive) {
    return false;
  }
  const update = notification.update;
  if (update.sessionUpdate === 'usage_update' || update.sessionUpdate === 'message_usage') {
    return false;
  }
  if (update.sessionUpdate !== 'status_message') {
    return entry.sealedIdleBoundaryActive;
  }
  if (update.status.type !== 'progress') {
    return entry.sealedIdleBoundaryActive;
  }
  if (isTurnTerminalRecord(update.status.data)) {
    return false;
  }
  // Session maintenance can legitimately start after the task terminal.
  const compaction = parseCompactionLifecycle(update.status.data);
  if (compaction && !compaction.runId) return false;

  const activity = parseActivityEvent(update.status.data);
  if (activity && entry.sealedRunIds.has(activity.run_id)) {
    return true;
  }
  return entry.sealedIdleBoundaryActive;
}

function hasAuthoritativeTerminalForRun(
  entry: StoreEntry,
  runId: string,
  localTerminalMessageId: string | null
): boolean {
  return entry.messages.some(
    (message) =>
      message.id !== localTerminalMessageId &&
      message.content.some(
        (content) =>
          content.type === 'systemNotification' &&
          content.notificationType === 'turnTerminal' &&
          isTurnTerminalRecord(content.data) &&
          content.data.run_id === runId
      )
  );
}

export function acpPermissionUserInputRequestId(toolCallId: string): string {
  return `permission:${toolCallId}`;
}

export function acpElicitationUserInputRequestId(elicitationId: string): string {
  return `elicitation:${elicitationId}`;
}

function retainPendingLocalSteerMessageIds(entry: StoreEntry): void {
  if (entry.pendingLocalSteerMessageIds.size === 0) {
    return;
  }

  const messageIds = new Set(entry.messages.map((message) => message.id).filter(Boolean));
  entry.pendingLocalSteerMessageIds = new Set(
    [...entry.pendingLocalSteerMessageIds].filter((messageId) => messageIds.has(messageId))
  );
}

function discardPendingLocalSteerMessages(entry: StoreEntry): void {
  if (entry.pendingLocalSteerMessageIds.size === 0) {
    return;
  }

  entry.messages = entry.messages.filter(
    (message) => !message.id || !entry.pendingLocalSteerMessageIds.has(message.id)
  );
  entry.pendingLocalSteerMessageIds.clear();
  entry.adapter = createAdapterForEntry(entry);
}

function createAdapterForEntry(entry: StoreEntry): AcpSessionNotificationAdapter {
  return createAcpSessionNotificationAdapter(
    entry.messages,
    confirmedLocalSteerTextByMessageId(entry)
  );
}

function confirmedLocalSteerTextByMessageId(entry: StoreEntry): Map<string, string> {
  const textByMessageId = new Map<string, string>();

  for (const message of entry.messages) {
    if (
      !message.id ||
      !message.metadata.steer ||
      entry.pendingLocalSteerMessageIds.has(message.id)
    ) {
      continue;
    }

    const firstContent = message.content[0];
    if (firstContent?.type === 'text') {
      textByMessageId.set(message.id, firstContent.text);
    }
  }

  return textByMessageId;
}

function snapshotFromEntry(entry: StoreEntry): AcpChatSessionSnapshot {
  const chatState = entry.sessionReplayActive
    ? ChatState.LoadingConversation
    : entry.compactionLifecycle?.status === 'started' &&
        !entry.sealedIdleBoundaryActive &&
        (entry.activePromptAttemptId !== null || entry.activeRunId !== null)
      ? ChatState.Compacting
      : entry.chatState;
  return {
    session: entry.session,
    messages: cloneMessages(entry.messages),
    tokenState: { ...entry.tokenState },
    notifications: [...entry.notifications],
    progressMessage: entry.progressMessage,
    compactionLifecycle: entry.compactionLifecycle,
    chatState,
    sessionLoadError: entry.sessionLoadError,
    workspaceReconfirmation: entry.workspaceReconfirmation,
    promptError: entry.promptError,
    activePromptAttemptId: entry.activePromptAttemptId,
    promptRequestId: entry.promptRequestId ?? null,
    activeRunId: entry.activeRunId,
    promptActivity:
      entry.activePromptAttemptId !== null &&
      !entry.sealedIdleBoundaryActive &&
      !entry.sessionReplayActive
        ? entry.promptActivity
          ? { ...entry.promptActivity }
          : undefined
        : undefined,
    thinkingActivity:
      entry.activePromptAttemptId !== null &&
      !entry.sealedIdleBoundaryActive &&
      !entry.sessionReplayActive &&
      chatState === ChatState.Streaming
        ? entry.thinkingActivity
        : undefined,
    activeToolCallIds:
      entry.activePromptAttemptId !== null && !entry.sealedIdleBoundaryActive
        ? [...entry.liveToolCallIds]
        : [],
    pendingCancelPromptAttemptId: entry.pendingCancelPromptAttemptId,
  };
}

function cloneMessages(messages: Message[]): Message[] {
  return messages.map(cloneMessage);
}

function terminalizeCodeProActivities(
  entry: StoreEntry,
  sessionId: string,
  status: 'stopped' | 'interrupted'
): void {
  const finishedAt = new Date().toISOString();
  for (const message of entry.messages) {
    for (const content of message.content) {
      if (content.type !== 'systemNotification' || content.notificationType !== 'codeProActivity') {
        continue;
      }
      const event = parseActivityEvent(content.data);
      if (!event || event.session_id !== sessionId || isTerminalActivityEventStatus(event.status)) {
        continue;
      }
      content.data = {
        ...event,
        status,
        finished_at: event.finished_at ?? finishedAt,
      };
      const statusText = status === 'stopped' ? '已停止' : '已中断';
      if (!content.msg.includes(`状态：${statusText}`)) {
        content.msg = `${content.msg}\n状态：${statusText}`;
      }
    }
  }
}
