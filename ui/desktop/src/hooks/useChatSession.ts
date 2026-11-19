import { useCallback, useEffect, useMemo, useRef } from 'react';
import { currentMessageLocale, defineMessages, useIntl } from '../i18n';
import { AppEvents } from '../constants/events';
import { ChatState } from '../types/chatState';

import type { TokenState } from '../types/chat';
import type { Session } from '../types/session';
import { getTurnTerminalRecord, type MessageEditType } from '../types/turnTerminal';

import {
  createUserMessage,
  getTextAndImageContent,
  isConversationTurnStart,
  insertPresentedUserMessage,
  type Message,
  type NotificationEvent,
  type UserInput,
} from '../types/message';
import { errorMessage } from '../utils/conversionUtils';
import type {
  MessageSubmissionLifecycle,
  UseChatSessionParams,
  UseChatSessionResult,
} from './useChatSessionTypes';
import {
  getPendingAcpElicitationRequests,
  submitAcpElicitationResponse,
} from '../acp/elicitationRequests';
import { acpChatSessionController } from '../acp/chatSessionController';
import {
  acpChatSessionActions,
  acpChatSessionStore,
  type AcpChatSessionSnapshot,
  useAcpChatSessionSnapshot,
} from '../acp/chatSessionStore';
import { acpSteerSession } from '../acp/prompt';
import { isAcpRecovering, subscribeToAcpRecovery } from '../acp/acpConnection';
import type { CodeProWorkspaceInspection } from '../codepro/projectWorkspace';

const initialTokenState: TokenState = {
  contextUsageKnown: false,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  accumulatedInputTokens: 0,
  accumulatedOutputTokens: 0,
  accumulatedTotalTokens: 0,
};

function isClearCommand(message: string): boolean {
  return message.trim() === '/clear';
}

function isSlashCommand(message: string): boolean {
  return message.trim().startsWith('/');
}

function isStaleRunnableSnapshot(snapshot: AcpChatSessionSnapshot | undefined): boolean {
  return (
    (snapshot?.chatState === ChatState.Thinking || snapshot?.chatState === ChatState.Streaming) &&
    snapshot.activePromptAttemptId == null &&
    snapshot.activeRunId == null &&
    snapshot.promptRequestId == null &&
    snapshot.pendingCancelPromptAttemptId == null
  );
}

const i18n = defineMessages({
  notificationTitle: {
    id: 'chat.notification.executionEnded.title',
    defaultMessage: 'CodeBuddy finished this execution turn.',
  },
  notificationBody: {
    id: 'chat.notification.taskComplete.body',
    defaultMessage: 'Click here to bring CodeBuddy back into focus.',
  },
});

export function useChatSession({
  sessionId,
  onStreamFinish,
  onSessionLoaded,
}: UseChatSessionParams): UseChatSessionResult {
  const intl = useIntl();
  const acpSnapshot = useAcpChatSessionSnapshot(sessionId);
  const session = acpSnapshot?.session;
  const chatState = acpSnapshot?.chatState ?? ChatState.LoadingConversation;
  // History arrives before its phase/terminal records and session metadata.
  // Keep those partial facts in the store, but do not present replay as live work.
  const messages = chatState === ChatState.LoadingConversation ? [] : (acpSnapshot?.messages ?? []);
  const progressMessage = acpSnapshot?.progressMessage;
  const sessionLoadError = acpSnapshot?.sessionLoadError;
  const workspaceReconfirmation = acpSnapshot?.workspaceReconfirmation;
  const promptError = acpSnapshot?.promptError;
  const tokenState = acpSnapshot?.tokenState ?? initialTokenState;
  const queueProcessingBlocked =
    acpSnapshot?.pendingCancelPromptAttemptId != null || acpSnapshot?.promptRequestId != null;
  const canSubmitQueuedMessageWhileLoading = isStaleRunnableSnapshot(acpSnapshot);

  const snapshotRef = useRef(acpSnapshot);
  snapshotRef.current = acpSnapshot;

  const getCurrentSnapshot = useCallback(
    () => snapshotRef.current ?? acpChatSessionStore.getSnapshot(sessionId),
    [sessionId]
  );
  const clearPromptError = useCallback(() => {
    acpChatSessionActions.clearPromptError(sessionId);
  }, [sessionId]);

  const reconfirmCodeProWorkspace = useCallback(
    async (candidate: CodeProWorkspaceInspection) => {
      const request = getCurrentSnapshot()?.workspaceReconfirmation ?? workspaceReconfirmation;
      if (!request || request.sessionId !== sessionId) {
        throw new Error('No CodePro workspace re-confirmation is pending');
      }
      await acpChatSessionController.reconfirmCodeProWorkspace(request, candidate);
    },
    [getCurrentSnapshot, sessionId, workspaceReconfirmation]
  );

  useEffect(() => {
    const handleSessionRenamed = (event: Event) => {
      const {
        sessionId: renamedSessionId,
        newName,
        userInitiated,
      } = (event as CustomEvent<{ sessionId: string; newName: string; userInitiated?: boolean }>)
        .detail;

      if (renamedSessionId !== sessionId) {
        return;
      }

      const currentSession = getCurrentSnapshot()?.session;
      if (!currentSession || (currentSession.name === newName && !userInitiated)) {
        return;
      }

      const updatedSession = {
        ...currentSession,
        name: newName,
        ...(userInitiated && { user_set_name: true }),
      };
      acpChatSessionActions.setSessionMetadata(sessionId, updatedSession);
    };

    window.addEventListener(AppEvents.SESSION_RENAMED, handleSessionRenamed);
    return () => window.removeEventListener(AppEvents.SESSION_RENAMED, handleSessionRenamed);
  }, [getCurrentSnapshot, sessionId]);

  const onFinish = useCallback(
    async (error?: string): Promise<void> => {
      const snapshot = acpChatSessionStore.getSnapshot(sessionId);
      const messages = snapshot?.messages ?? [];
      const latestTerminal = [...messages]
        .reverse()
        .map(getTurnTerminalRecord)
        .find((terminal) => terminal !== undefined);
      const terminalConfirmsCompletion =
        latestTerminal === undefined ||
        (latestTerminal.status === 'completed' &&
          (latestTerminal.report === undefined || latestTerminal.report.outcome === 'completed'));
      if (!error && terminalConfirmsCompletion) {
        try {
          if (await window.electron.getSetting('enableNotifications') === true) {
            let preview = '';
            for (let index = messages.length - 1; index >= 0; index--) {
              const message = messages[index];
              if (isConversationTurnStart(message)) break;
              if (message.role !== 'assistant' || message.metadata?.userVisible === false) continue;
              preview = getTextAndImageContent(message).textContent.replace(/\s+/g, ' ').trim();
              if (preview) break;
            }
            window.electron.showNotification({
              locale: currentMessageLocale,
              sessionId,
              title: snapshot?.session?.name?.trim().slice(0, 100) || intl.formatMessage(i18n.notificationTitle),
              body: preview.length > 180 ? preview.slice(0, 179) + '…' : preview || intl.formatMessage(i18n.notificationBody),
            });
          }
        } catch (notifyError) {
          console.warn('Failed to show task completion notification:', notifyError);
        }
      }

      onStreamFinish();
    },
    [sessionId, intl, onStreamFinish]
  );

  // Load session on mount or sessionId change
  useEffect(() => {
    if (!sessionId) return;

    void acpChatSessionController.loadSession(sessionId, { onSessionLoaded });
  }, [sessionId, onSessionLoaded]);

  useEffect(() => {
    let interrupted = isAcpRecovering();
    return subscribeToAcpRecovery((recovering) => {
      if (recovering) interrupted = true;
      else if (interrupted) {
        interrupted = false;
        // Reload the same authoritative transcript and live operation. Never
        // resend the prompt: it may have kept executing while disconnected.
        if (sessionId) void acpChatSessionController.loadSession(sessionId, { onSessionLoaded });
      }
    });
  }, [sessionId, onSessionLoaded]);

  const handleSubmit = useCallback(
    async (input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
      if (isAcpRecovering()) {
        lifecycle?.onRejectedBeforeAcceptance();
        return;
      }

      const { msg: userMessage, images } = input;
      const currentSnapshot = getCurrentSnapshot();
      const staleRunnableSnapshot = isStaleRunnableSnapshot(currentSnapshot);

      if (
        !currentSnapshot?.session ||
        currentSnapshot.chatState === ChatState.LoadingConversation ||
        ((currentSnapshot.chatState === ChatState.Streaming ||
          currentSnapshot.chatState === ChatState.Thinking) &&
          !staleRunnableSnapshot) ||
        currentSnapshot.chatState === ChatState.Compacting ||
        currentSnapshot.pendingCancelPromptAttemptId !== null ||
        currentSnapshot.promptRequestId != null
      ) {
        lifecycle?.onRejectedBeforeAcceptance();
        return;
      }

      const currentMessages = currentSnapshot.messages;
      const hasExistingMessages = currentMessages.length > 0;
      const hasNewMessage = userMessage.trim().length > 0 || images.length > 0;
      const clearsConversation = hasNewMessage && isClearCommand(userMessage);

      if (!hasNewMessage && !hasExistingMessages) {
        return;
      }

      // Emit session-created event for first message in a new session
      if (!hasExistingMessages && hasNewMessage) {
        window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
      }

      const newMessage = hasNewMessage
        ? {
            ...createUserMessage(userMessage, images),
            ...(input.messageId ? { id: input.messageId } : {}),
            metadata: {
              userVisible: true,
              agentVisible: true,
              presentation: input.presentation,
              ...(input.queuedWhileBusy ? { queuedWhileBusy: true as const } : {}),
            },
          }
        : currentMessages[currentMessages.length - 1];
      if (hasNewMessage && input.planMode !== undefined)
        newMessage.metadata.planMode = input.planMode;
      if (hasNewMessage && input.goalRequest) newMessage.metadata.goalRequest = input.goalRequest;
      if (hasNewMessage && input.desktopGeneration !== undefined)
        newMessage.metadata.desktopGeneration = input.desktopGeneration;

      let accepted = false;
      const onAccepted = () => {
        if (accepted) return;
        accepted = true;
        if (clearsConversation || hasNewMessage) {
          const latestMessages = acpChatSessionStore.getSnapshot(sessionId)?.messages ?? [];
          const alreadyPresent = newMessage.id
            ? latestMessages.some((message) => message.id === newMessage.id)
            : false;
          acpChatSessionActions.setMessages(
            sessionId,
            clearsConversation
              ? []
              : alreadyPresent
                ? latestMessages
                : insertPresentedUserMessage(latestMessages, newMessage)
          );
        }
        lifecycle?.onAccepted();
      };

      await acpChatSessionController.submitMessage(sessionId, newMessage, {
        submittedAtMs: lifecycle?.submittedAtMs,
        getCurrentSnapshot,
        onFinish,
        onAccepted,
        onRejectedBeforeAcceptance: lifecycle?.onRejectedBeforeAcceptance,
        onDeliveryUncertain: lifecycle?.onDeliveryUncertain,
      });
    },
    [getCurrentSnapshot, onFinish, sessionId]
  );

  const resumeAfterWorkspace = useCallback(
    async (sourceMessage: Message, sourceRunId: string) => {
      if (isAcpRecovering()) return;
      await acpChatSessionController.resumeAfterWorkspace(sessionId, sourceMessage, sourceRunId, {
        getCurrentSnapshot,
        onFinish,
      });
    },
    [getCurrentSnapshot, onFinish, sessionId]
  );

  const onSteerQueuedMessage = useCallback(
    async (input: UserInput): Promise<boolean> => {
      if (isAcpRecovering()) return false;
      const { msg: userMessage, images } = input;
      const hasTextContent = userMessage.trim().length > 0;
      const hasNewMessage = hasTextContent || images.length > 0;
      if (!hasNewMessage) {
        return false;
      }

      if (isSlashCommand(userMessage)) {
        return false;
      }

      const sessionSnapshot = acpChatSessionStore.getSnapshot(sessionId) ?? getCurrentSnapshot();
      if (sessionSnapshot?.pendingCancelPromptAttemptId) {
        return false;
      }
      const activeRunId = sessionSnapshot?.activeRunId;
      if (!activeRunId) {
        return false;
      }

      try {
        const steeredMessage = createUserMessage(userMessage, images);
        if (input.queuedWhileBusy === true) steeredMessage.metadata.queuedWhileBusy = true;
        const response = await acpSteerSession(sessionId, steeredMessage, activeRunId);
        const localSteerMessage: Message = {
          ...steeredMessage,
          id: response.messageId,
          metadata: { ...steeredMessage.metadata, steer: true },
        };
        const latestSnapshot = acpChatSessionStore.getSnapshot(sessionId) ?? getCurrentSnapshot();
        if (latestSnapshot?.activeRunId !== activeRunId) {
          return true;
        }

        const currentMessages = latestSnapshot.messages;

        if (!currentMessages.some((message) => message.id === response.messageId)) {
          acpChatSessionActions.addPendingLocalSteerMessage(sessionId, localSteerMessage);
        }

        return true;
      } catch (error) {
        console.warn('Failed to steer ACP session:', error);
        throw error;
      }
    },
    [getCurrentSnapshot, sessionId]
  );

  const submitElicitationResponse = useCallback(
    async (
      elicitationId: string,
      userData: Record<string, unknown>,
      action: 'accept' | 'cancel' = 'accept'
    ) => {
      const currentSnapshot = getCurrentSnapshot();

      if (
        !currentSnapshot?.session ||
        currentSnapshot.chatState === ChatState.LoadingConversation
      ) {
        return false;
      }

      const didResolve = await submitAcpElicitationResponse(
        sessionId,
        elicitationId,
        userData,
        action
      );
      if (!didResolve) {
        console.error('No pending ACP elicitation request found', { sessionId, elicitationId });
        return false;
      }

      return true;
    },
    [getCurrentSnapshot, sessionId]
  );

  const stopStreaming = useCallback(() => {
    acpChatSessionController.stop(sessionId);
  }, [sessionId]);

  const onMessageUpdate = useCallback(
    async (messageId: string, newContent: string, editType: MessageEditType = 'edit', retainedImageIndexes?: number[]) => {
      try {
        await acpChatSessionController.updateMessage(sessionId, messageId, newContent, editType, {
          getCurrentSnapshot,
          onFinish,
        }, retainedImageIndexes);
      } catch (error) {
        const errorMsg = errorMessage(error);
        console.error('Failed to edit message:', error);
        const { toastError } = await import('../toasts');
        toastError({
          title: 'Failed to edit message',
          msg: errorMsg,
        });
      }
    },
    [getCurrentSnapshot, onFinish, sessionId]
  );

  const updateSession = useCallback(
    (updater: (session: Session) => Session) => {
      const currentSession = getCurrentSnapshot()?.session;
      if (!currentSession) return;

      const nextSession = updater(currentSession);
      acpChatSessionActions.setSessionMetadata(sessionId, nextSession);
    },
    [getCurrentSnapshot, sessionId]
  );
  const notificationsMap = useMemo(() => {
    return (acpSnapshot?.notifications ?? []).reduce((map, notification) => {
      const key = notification.request_id;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(notification);
      return map;
    }, new Map<string, NotificationEvent[]>());
  }, [acpSnapshot?.notifications]);

  return {
    sessionLoadError,
    workspaceReconfirmation,
    reconfirmCodeProWorkspace,
    promptError,
    clearPromptError,
    messages,
    session,
    chatState,
    progressMessage,
    compactionLifecycle: acpSnapshot?.compactionLifecycle,
    updateSession,
    handleSubmit,
    resumeAfterWorkspace,
    onSteerQueuedMessage,
    submitElicitationResponse,
    stopStreaming,
    tokenState,
    notifications: notificationsMap,
    activeToolCallIds: acpSnapshot?.activeToolCallIds,
    pendingElicitationRequests:
      chatState === ChatState.LoadingConversation
        ? []
        : getPendingAcpElicitationRequests(sessionId),
    thinkingActivity: acpSnapshot?.thinkingActivity,
    promptActivity: acpSnapshot?.promptActivity,
    cancelling: acpSnapshot?.pendingCancelPromptAttemptId != null,
    activeRunId: acpSnapshot?.activeRunId,
    pauseQueueOnStop: true,
    queueProcessingBlocked,
    canSubmitQueuedMessageWhileLoading,
    onMessageUpdate,
  };
}
