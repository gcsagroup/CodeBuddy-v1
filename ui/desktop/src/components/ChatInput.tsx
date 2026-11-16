import { receiveMainConversationMessages } from '../pets/mainConversation';
import { droppedImageUrls, videoEvidenceContext, videoTimestamp } from '../utils/videoEvidence';
import { ComposerGoalBar } from './ComposerGoalBar';
import { ComposerPlanMode } from './ComposerPlanMode';
import {
  composerCommandFailure,
  composerMessages,
  isComposerControl,
  parseComposerCommand,
  parseComposerUiCommand,
  prepareComposerCommand,
} from './composerCommands';
import { getSessionGoal } from '../acp/goals';
import { acpExportSession } from '../acp/sessions';
import { GOAL_CHANGED, openGoalEditor } from '../workspace-panel/goalPanel';
import { AppEvents } from '../constants/events';
import {
  ATTACH_WORKSPACE_IMAGE,
  type WorkspaceImageAttachment,
} from '../workspace-panel/workspaceFilePanel';
import { getSessionExtensions, addSessionExtension } from '../acp/session-extensions';
import React, { useRef, useState, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { ArrowUp, Play, Plus, ScrollText } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/Tooltip';
import { Button } from './ui/button';
import type { View, ViewOptions } from '../utils/navigationUtils';
import { ChatInputStopButton } from './ChatInputStopButton';
import { ImageLightbox } from './ImagePreview';
import { Close, Microphone } from './icons';
import type { RequestBudget } from '../types/chat';
import { ChatState } from '../types/chatState';
import debounce from 'lodash/debounce';
import { LocalMessageStorage } from '../utils/localMessageStorage';
import { readNewTaskDraft, updateNewTaskDraft, type NewTaskDraftKey } from '../utils/newTaskDraft';
import { DirSwitcher } from './bottom_menu/DirSwitcher';
import ModelsBottomBar from './settings/models/bottom_bar/ModelsBottomBar';
import { ComposerStats } from './ComposerStats';
import { ChatInputCard } from './ChatInputCard';
import type { TokenState } from '../types/chat';
import { cn } from '../utils';
import { useAlerts } from './alerts';
import { getContextAlertType, shouldShowContextAlert } from './contextWindowAlert';
import { useModelAndProvider } from './ModelAndProviderContext';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { toastError } from '../toasts';
import MentionPopover, { DisplayItem, DisplayItemWithMatch } from './MentionPopover';
import { ConversationReferences } from './ConversationReferences';
import {
  conversationMentions,
  splitConversationDraft,
  combineConversationDraft,
} from './conversationMention';
import { ContextWindowIndicator } from './bottom_menu/ContextWindowIndicator';
import { DroppedFile, useFileDrop } from '../hooks/useFileDrop';
import { Recipe } from '../recipe';
import { MessageQueue, QueuedMessage } from './MessageQueue';
import { getDesktopOwnership } from '../desktopOwnership';
import { createUserMessage, getToolRequests, getToolResponses, isConversationTurnStart, isToolCallInProgress, type Message } from '../types/message';
import { getInitialWorkingDir } from '../utils/workingDir';
import { trackFileAttached, trackVoiceDictation } from '../utils/analytics';
import { getNavigationShortcutText } from '../utils/keyboardShortcuts';
import { UserInput, ImageData } from '../types/message';
import type { MessageSubmissionLifecycle } from '../hooks/useChatSessionTypes';
import {
  acceptSubmittedDraft,
  createSubmittedDraftState,
  rejectSubmittedDraft,
} from './chatInputSubmissionLifecycle';
import { compressImageDataUrl } from '../utils/conversionUtils';
import { useModelCapacity } from '../hooks/useModelCapacity';
import { defineMessages, useIntl } from '../i18n';
import TurndownService from 'turndown';
import type { NextChatExtensionDraft } from '../utils/nextChatExtensions';
import { AgentSelector } from './custom-agents/AgentSelector';
import { QueuedMessageStorage, QueueStorageConflict } from '../utils/queuedMessageStorage';
import { isLargeText, useCompactTextInput } from './pastedText';
import { PastedTextPreview } from './PastedTextPreview';
import { ComposerAttachmentTray } from './ComposerAttachmentTray';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

turndown.addRule('complexLinks', {
  filter: (node) => {
    return (
      node.nodeName === 'A' && !!node.getAttribute('href') && /\n/.test(node.textContent || '')
    );
  },
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const href = el.getAttribute('href')!;
    const label = content.replace(/\n+/g, ' ').trim();
    return `[${label}](${href})`;
  },
});

interface PastedImage {
  id: string;
  dataUrl: string;
  isLoading: boolean;
  error?: string;
}

const removeQueuedMessage = (messages: QueuedMessage[], messageId: string): QueuedMessage[] =>
  messages.filter((msg) => msg.id !== messageId);

const MAX_IMAGES_PER_MESSAGE = 10;

// Manual compact trigger message - must match backend constant
const MANUAL_COMPACT_TRIGGER = '/compact';

const i18n = defineMessages({
  referenceLimit: {
    id: 'chatInput.referenceLimit',
    defaultMessage:
      'You can reference up to 3 conversations in one message. Remove a reference before adding another.',
  },
  dictationError: {
    id: 'chatInput.dictationError',
    defaultMessage: 'Dictation Error',
  },
  removeImage: {
    id: 'chatInput.removeImage',
    defaultMessage: 'Remove image',
  },
  removeFile: {
    id: 'chatInput.removeFile',
    defaultMessage: 'Remove file',
  },
  unknownType: {
    id: 'chatInput.unknownType',
    defaultMessage: 'Unknown type',
  },
  contextWindow: {
    id: 'chatInput.contextWindow',
    defaultMessage: 'Context window',
  },
  waitingForImages: {
    id: 'chatInput.waitingForImages',
    defaultMessage: 'Waiting for images to save...',
  },
  processingDroppedFiles: {
    id: 'chatInput.processingDroppedFiles',
    defaultMessage: 'Processing dropped files...',
  },
  recording: {
    id: 'chatInput.recording',
    defaultMessage: 'Recording...',
  },
  transcribing: {
    id: 'chatInput.transcribing',
    defaultMessage: 'Transcribing...',
  },
  restartingSession: {
    id: 'chatInput.restartingSession',
    defaultMessage: 'Restarting session...',
  },
  typeMessage: {
    id: 'chatInput.typeMessage',
    defaultMessage: 'Type a message to send',
  },
  send: {
    id: 'chatInput.send',
    defaultMessage: 'Send',
  },
  queueMessage: {
    id: 'chatInput.queueMessage',
    defaultMessage: 'Queue message',
  },
  waitingForCancellation: {
    id: 'messageQueue.waitingForCancellation',
    defaultMessage: 'Stopping the previous turn. Your new message will be sent after confirmation.',
  },
  waitingForPreviousPrompt: {
    id: 'messageQueue.waitingForPreviousPrompt',
    defaultMessage:
      'Waiting for the previous request to finish. Your queued message has not been sent.',
  },
  failedToReadImage: {
    id: 'chatInput.failedToReadImage',
    defaultMessage: 'Failed to read image file',
  },
  imageLimit: {
    id: 'chatInput.imageLimit',
    defaultMessage: 'You can attach up to {count} images to one message.',
  },
  viewEditRecipe: {
    id: 'chatInput.viewEditRecipe',
    defaultMessage: 'View/Edit Recipe',
  },
  listening: {
    id: 'chatInput.listening',
    defaultMessage: 'Listening',
  },
  attachFile: {
    id: 'chatInput.attachFile',
    defaultMessage: 'Attach file',
  },
  dictationNotConfigured: {
    id: 'chatInput.dictationNotConfigured',
    defaultMessage: 'Dictation not configured (Settings)',
  },
  voiceDictation: {
    id: 'chatInput.voiceDictation',
    defaultMessage: 'Voice dictation',
  },
  voiceDictationHint: {
    id: 'chatInput.voiceDictationHint',
    defaultMessage: 'Voice dictation • Say "submit" to send',
  },
  stop: {
    id: 'chatInput.stop',
    defaultMessage: 'Stop',
  },
  continueTask: { id: 'chatInput.continueTask', defaultMessage: 'Continue task' },
  pastedImage: {
    id: 'chatInput.pastedImage',
    defaultMessage: 'Pasted image {id}',
  },
});

interface ChatInputProps {
  submissionDisabled?: boolean;
  onOpenPermissions?: () => void;
  modelToolbarSlot?: React.ReactNode;
  placeholder?: string;
  sessionId: string | null;
  handleSubmit: (input: UserInput, lifecycle?: MessageSubmissionLifecycle) => Promise<void> | void;
  onSubmissionAccepted?: () => void;
  chatState: ChatState;
  onStop?: () => void;
  onContinue?: () => void;
  onSteerQueuedMessage?: (input: UserInput) => Promise<boolean>;
  automaticSteeringAllowed?: boolean;
  onPendingMessageChange?: (sessionId: string, message: Message | undefined) => void;
  pauseQueueOnStop?: boolean;
  queueProcessingBlocked?: boolean;
  queueBlockedReason?: string;
  canSubmitQueuedMessageWhileLoading?: boolean;
  commandHistory?: string[];
  initialValue?: string;
  draftDelivery?: { id: string; text: string };
  newTaskDraftKey?: NewTaskDraftKey;
  droppedFiles?: DroppedFile[];
  onFilesProcessed?: () => void;
  setView: (view: View, options?: ViewOptions) => void;
  totalTokens?: number;
  contextLimit?: number;
  requestBudget?: RequestBudget;
  contextUsageSource?: 'provider_actual' | 'local_estimate' | 'streaming_estimate';
  sessionStats?: TokenState['sessionStats'];
  liveSpeed?: TokenState['liveSpeed'];
  lastSampledSpeed?: TokenState['lastSampledSpeed'];
  contextCapacitySource?: 'service' | 'catalog' | 'configured' | 'fallback';
  accumulatedInputTokens?: number;
  accumulatedOutputTokens?: number;
  accumulatedCost?: number | null;
  messages?: Message[];
  disableAnimation?: boolean;
  recipe?: Recipe | null;
  recipeId?: string | null;
  recipeAccepted?: boolean;
  initialPrompt?: string;
  append?: (message: Message) => void;
  onWorkingDirChange?: (newDir: string) => Promise<void> | void;
  hideWorkingDirSwitcher?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  sessionModel?: string | null;
  externalModelOpenRequest?: number;
  sessionProvider?: string | null;
  sessionLoaded?: boolean;
  workingDir?: string | null;
  globalConversation?: boolean;
  latestInference?: Message['metadata']['inference'] | null;
  nextChatExtensionDraft?: NextChatExtensionDraft;
  onNextChatExtensionDraftChange?: (draft: NextChatExtensionDraft) => void;
}

export function chatInputActionVisibility(isLoading: boolean, hasSubmittableContent: boolean) {
  return {
    showStop: isLoading && !hasSubmittableContent,
    showSend: !isLoading || hasSubmittableContent,
  };
}

export function shouldShowWorkingDirectorySwitcher(canChangeWorkingDirectory: boolean): boolean {
  return canChangeWorkingDirectory;
}

export default function ChatInput({
  submissionDisabled = false,
  onOpenPermissions,
  modelToolbarSlot,
  placeholder,
  sessionId,
  handleSubmit,
  onSubmissionAccepted,
  chatState = ChatState.Idle,
  onStop,
  onContinue,
  onSteerQueuedMessage,
  automaticSteeringAllowed = false,
  onPendingMessageChange,
  pauseQueueOnStop = false,
  queueProcessingBlocked = false,
  queueBlockedReason,
  canSubmitQueuedMessageWhileLoading = false,
  commandHistory = [],
  initialValue = '',
  newTaskDraftKey,
  draftDelivery,
  droppedFiles = [],
  onFilesProcessed,
  setView,
  totalTokens,
  contextLimit,
  requestBudget,
  contextUsageSource,
  sessionStats,
  liveSpeed,
  lastSampledSpeed,
  contextCapacitySource,
  messages = [],
  disableAnimation = false,
  recipe: _recipe,
  recipeId: _recipeId,
  recipeAccepted,
  initialPrompt,
  append: _append,
  onWorkingDirChange,
  hideWorkingDirSwitcher = false,
  inputRef,
  sessionModel,
  externalModelOpenRequest = 0,
  sessionProvider,
  sessionLoaded,
  workingDir,
  globalConversation = false,
  latestInference,
  nextChatExtensionDraft,
  onNextChatExtensionDraftChange,
}: ChatInputProps) {
  const [startingValue] = useState(
    () => initialValue || (newTaskDraftKey ? (readNewTaskDraft(newTaskDraftKey).text ?? '') : '')
  );
  const [_value, setValue] = useState(startingValue);
  const [displayValue, setDisplayValue] = useState(
    () => splitConversationDraft(startingValue).body
  );
  const [referenceText, setReferenceText] = useState(
    () => splitConversationDraft(startingValue).references
  );
  const draftText = combineConversationDraft(displayValue, referenceText);
  const restoreDraft = useCallback((text: string) => {
    const parsed = splitConversationDraft(text);
    setDisplayValue(parsed.body);
    setReferenceText(parsed.references);
  }, []);
  const compactText = useCompactTextInput(displayValue);
  const previousInitialValue = useRef(initialValue);
  const consumedDraftDelivery = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (newTaskDraftKey) updateNewTaskDraft(newTaskDraftKey, { text: draftText });
  }, [draftText, newTaskDraftKey]);
  const [attachmentPreview, setAttachmentPreview] = useState<{ src: string; title: string } | null>(
    null
  );
  useEffect(() => setAttachmentPreview(null), [sessionId]);
  const [pastedImages, setPastedImages] = useState<(PastedImage & { sourceSessionId?: string })[]>(
    () => (newTaskDraftKey ? (readNewTaskDraft(newTaskDraftKey).images ?? []) : [])
  );
  const [isFilePickerOpen, setIsFilePickerOpen] = useState(false);
  const submitInFlightRef = useRef(false);
  const inputRevisionRef = useRef(0);
  const [pendingDraft, setPendingDraft] = useState<{
    sessionId: string | null;
    revision: number;
  }>();
  const isCurrentDraftSubmitted =
    pendingDraft?.sessionId === sessionId && pendingDraft?.revision === inputRevisionRef.current;

  // Derived state - chatState != Idle means we're in some form of loading state
  const isLoading = chatState !== ChatState.Idle;
  const isLoadingRef = useRef(isLoading);
  const queueProcessingBlockedRef = useRef(queueProcessingBlocked);
  isLoadingRef.current = isLoading;
  queueProcessingBlockedRef.current = queueProcessingBlocked;

  const [queuedMessages, setQueuedMessagesState] = useState<QueuedMessage[]>([]);
  const queuedMessagesRef = useRef<QueuedMessage[]>([]);
  const queueStorageRef = useRef<QueuedMessageStorage | null>(null);
  const queueStorageFailedRef = useRef(false);
  const [queueStorageError, setQueueStorageError] = useState<'save' | 'read' | 'conflict' | null>(
    null
  );
  const [composerMode, setComposerMode] = useState<'goal' | 'plan' | null>(null);
  const [modelOpenRequest, setModelOpenRequest] = useState(0);
  const [agentOpenRequest, setAgentOpenRequest] = useState(0);
  const [goalRefresh, setGoalRefresh] = useState(0);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<{ text: string } | null>(null);
  useEffect(() => {
    if (!attachmentNotice) return;
    const timer = window.setTimeout(() => setAttachmentNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [attachmentNotice]);
  const commandControlInFlight = useRef<symbol | null>(null);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId)
        setGoalRefresh((value) => value + 1);
    };
    window.addEventListener(GOAL_CHANGED, changed);
    return () => window.removeEventListener(GOAL_CHANGED, changed);
  }, [sessionId]);
  const queueSessionIdRef = useRef(sessionId);
  queueSessionIdRef.current = sessionId;
  const queuePausedRef = useRef(false);
  const persistQueue = useCallback((messages: QueuedMessage[]) => {
    if (!queueStorageRef.current) return !queueStorageFailedRef.current;
    if (queueStorageFailedRef.current) return false;
    try {
      queueStorageRef.current.write(messages);
      return true;
    } catch (error) {
      queueStorageFailedRef.current = true;
      queuePausedRef.current = true;
      setQueueStorageError(error instanceof QueueStorageConflict ? 'conflict' : 'save');
      return false;
    }
  }, []);
  const setQueuedMessages = useCallback(
    (update: React.SetStateAction<QueuedMessage[]>) => {
      const next = typeof update === 'function' ? update(queuedMessagesRef.current) : update;
      queuedMessagesRef.current = next;
      persistQueue(next);
      setQueuedMessagesState(next);
    },
    [persistQueue]
  );
  const editingMessageIdRef = useRef<string | null>(null);
  const pendingSendMessageIdRef = useRef<string | null>(null);
  const pendingSendPauseRemainingRef = useRef(false);
  const [pendingSendMessageId, setPendingSendMessageId] = useState<string | null>(null);
  const cancellationRequestedForQueueRef = useRef(false);
  const sendNowInFlightMessageIdsRef = useRef<Set<string>>(new Set());
  const [sendNowInFlightMessageIds, setSendNowInFlightMessageIds] = useState<ReadonlySet<string>>(
    new Set()
  );

  const setSendNowInFlightMessage = useCallback(
    (messageId: string, isInFlight: boolean) => {
      if (isInFlight) {
        setQueuedMessages((items) =>
          items.map((item) => (item.id === messageId ? { ...item, delivery: 'submitting' } : item))
        );
      }
      const nextMessageIds = new Set(sendNowInFlightMessageIdsRef.current);
      if (isInFlight) {
        nextMessageIds.add(messageId);
      } else {
        nextMessageIds.delete(messageId);
      }
      sendNowInFlightMessageIdsRef.current = nextMessageIds;
      setSendNowInFlightMessageIds(nextMessageIds);
    },
    [setQueuedMessages]
  );

  useEffect(() => {
    queueStorageRef.current = null;
    queueStorageFailedRef.current = false;
    setQueueStorageError(null);
    let restored: QueuedMessage[] = [];
    try {
      if (sessionId) {
        const storage = new QueuedMessageStorage(window.localStorage, sessionId);
        restored = storage.read();
        queueStorageRef.current = storage;
      }
    } catch {
      queueStorageFailedRef.current = true;
      setQueueStorageError('read');
    }
    queuedMessagesRef.current = restored;
    setQueuedMessagesState(restored);
    queuePausedRef.current = restored.length > 0 || queueStorageFailedRef.current;
    editingMessageIdRef.current = null;
    pendingSendMessageIdRef.current = null;
    pendingSendPauseRemainingRef.current = false;
    setPendingSendMessageId(null);
    cancellationRequestedForQueueRef.current = false;
    sendNowInFlightMessageIdsRef.current = new Set();
    setSendNowInFlightMessageIds(new Set());
  }, [sessionId]);

  useLayoutEffect(() => {
    if (
      !sessionId ||
      queueStorageRef.current?.sessionId !== sessionId ||
      queuedMessages !== queuedMessagesRef.current
    )
      return;
    // A restored or stopped queue is held as drafts. Only the current explicit
    // pending send is projected into the transcript; keep stored identity for
    // acknowledgement reconciliation without displaying a second copy.
    const pending = queuedMessages.find(
      (item) => item.presentation && item.id === pendingSendMessageId
    );
    onPendingMessageChange?.(
      sessionId,
      pending
        ? {
            ...createUserMessage(pending.content, pending.images),
            id: pending.id,
            created: pending.timestamp / 1000,
            metadata: {
              userVisible: true,
              agentVisible: false,
              pendingDelivery: pending.delivery === 'submitting' ? 'unconfirmed' : 'pending',
              presentation: pending.presentation,
            },
          }
        : undefined
    );
  }, [queuedMessages, sessionId, onPendingMessageChange, pendingSendMessageId]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const storage = queueStorageRef.current;
      if (!storage || (event.key !== null && event.key !== storage.key)) return;
      try {
        if (storage.isCurrent()) return;
      } catch {
        /* A failed read must also block stale writes. */
      }
      queueStorageFailedRef.current = true;
      queuePausedRef.current = true;
      setQueueStorageError('conflict');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const pauseRemainingQueue = useCallback(() => {
    queuePausedRef.current = true;
  }, []);

  const clearPendingSend = useCallback((messageId?: string) => {
    if (!messageId || pendingSendMessageIdRef.current === messageId) {
      pendingSendMessageIdRef.current = null;
      pendingSendPauseRemainingRef.current = false;
      setPendingSendMessageId(null);
      cancellationRequestedForQueueRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isLoading && !queueProcessingBlocked) {
      cancellationRequestedForQueueRef.current = false;
    }
  }, [isLoading, queueProcessingBlocked]);

  const clearQueueState = useCallback(() => {
    queuePausedRef.current = false;
    pendingSendMessageIdRef.current = null;
    pendingSendPauseRemainingRef.current = false;
    setPendingSendMessageId(null);
    cancellationRequestedForQueueRef.current = false;
  }, []);

  useEffect(() => {
    if (
      queuedMessages !== queuedMessagesRef.current ||
      queueStorageRef.current?.sessionId !== sessionId ||
      !queuedMessages.some((item) => item.presentation)
    )
      return;
    const confirmed = new Set(
      messages.filter((item) => item.role === 'user').map((item) => item.id)
    );
    const delivered = queuedMessages.filter((item) => item.presentation && confirmed.has(item.id));
    if (!delivered.length) return;
    // Recover an acknowledgement lost during reload; never replay this request.
    queuePausedRef.current = true;
    for (const item of delivered) clearPendingSend(item.id);
    setQueuedMessages((items) =>
      items.filter((item) => !item.presentation || !confirmed.has(item.id))
    );
  }, [messages, queuedMessages, sessionId, setQueuedMessages, clearPendingSend]);

  const { alerts, addAlert, clearAlerts } = useAlerts();
  const dropdownRef: React.RefObject<HTMLDivElement> = useRef<HTMLDivElement>(
    null
  ) as React.RefObject<HTMLDivElement>;
  const intl = useIntl();
  const { currentModel: configModel, currentProvider: configProvider } = useModelAndProvider();

  // Local override for when the user changes the model in the modal,
  // before the session object is re-fetched from the backend.
  const [modelOverride, setModelOverride] = useState<{ model: string; provider: string } | null>(
    null
  );
  const effectiveModel = modelOverride?.model ?? sessionModel ?? configModel;
  const effectiveProvider = modelOverride?.provider ?? sessionProvider ?? configProvider;

  // Clear override when the underlying data catches up (session props for
  // active chats, config defaults for Hub / no-session contexts).
  useEffect(() => {
    if (!modelOverride) return;
    const sessionCaughtUp =
      sessionModel === modelOverride.model && sessionProvider === modelOverride.provider;
    const configCaughtUp =
      !sessionId &&
      configModel === modelOverride.model &&
      configProvider === modelOverride.provider;
    if (sessionCaughtUp || configCaughtUp) {
      setModelOverride(null);
    }
  }, [sessionModel, sessionProvider, configModel, configProvider, sessionId, modelOverride]);
  const capacity = useModelCapacity(effectiveProvider, effectiveModel, contextLimit);
  const tokenLimit = capacity?.contextLimit ?? 0;
  const isTokenLimitLoaded = capacity !== null;
  const [workingDirOverride, setWorkingDirOverride] = useState<string | null>(null);
  const currentWorkingDir = workingDirOverride ?? workingDir ?? getInitialWorkingDir();

  // The composer width, not the window breakpoint, determines which controls fit.
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [isBottomBarNarrow, setIsBottomBarNarrow] = useState(false);
  useEffect(() => {
    const el = bottomBarRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsBottomBarNarrow(width < 620);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setWorkingDirOverride(null);
  }, [sessionId, workingDir]);

  const submitQueuedMessage = useCallback(
    async (
      message: QueuedMessage,
      pauseAfterAcceptance = false,
      allowWhileLoading = false,
      delivery: 'queue' | 'steer' = 'queue'
    ) => {
      const submittedSessionId = sessionId;
      const submittedStorage = queueStorageRef.current;
      const isCurrentQueueSession = () => queueSessionIdRef.current === submittedSessionId;
      if (
        message.delivery === 'submitting' ||
        queueStorageFailedRef.current ||
        (delivery === 'queue' &&
          ((isLoadingRef.current && !allowWhileLoading) || queueProcessingBlockedRef.current)) ||
        [...sendNowInFlightMessageIdsRef.current].some(
          (id) => delivery === 'queue' || queuedMessagesRef.current.some((item) => item.id === id)
        ) ||
        editingMessageIdRef.current === message.id
      ) {
        return;
      }

      let accepted = false;
      let deliveryResolved = false;
      setSendNowInFlightMessage(message.id, true);
      if (queueStorageFailedRef.current) {
        setSendNowInFlightMessage(message.id, false);
        setQueuedMessages((items) =>
          items.map((item) => (item.id === message.id ? { ...item, delivery: 'pending' } : item))
        );
        return;
      }
      const pauseUnaccepted = (uncertain: boolean) => {
        deliveryResolved = true;
        if (accepted || !isCurrentQueueSession()) return;
        clearPendingSend(message.id);
        pauseRemainingQueue();
        if (!uncertain) {
          setQueuedMessages((items) =>
            items.map((item) => (item.id === message.id ? { ...item, delivery: 'pending' } : item))
          );
        }
      };
      try {
        const input: UserInput = {
          ...(message.queuedWhileBusy ? { queuedWhileBusy: true } : {}),
          msg: message.content,
          images: message.images,
          messageId: message.id,
          desktopGeneration:
            typeof message.desktopGeneration === 'string' ? message.desktopGeneration : '',
          ...(message.presentation
            ? { messageId: message.id, presentation: message.presentation }
            : {}),
        };
        const lifecycle: MessageSubmissionLifecycle = {
          onAccepted: () => {
            if (accepted) return;
            accepted = true;
            if (!isCurrentQueueSession()) {
              try {
                if (submittedStorage)
                  submittedStorage.write(
                    submittedStorage.read().filter((item) => item.id !== message.id)
                  );
              } catch {
                setQueueStorageError('save');
              }
              return;
            }
            LocalMessageStorage.addMessage(message.content);
            clearPendingSend(message.id);
            if (pauseAfterAcceptance) {
              pauseRemainingQueue();
            }
            setQueuedMessages((previous) => {
              const next = removeQueuedMessage(previous, message.id);
              if (next.length === 0) clearQueueState();
              return next;
            });
          },
          onRejectedBeforeAcceptance: () => pauseUnaccepted(false),
          onDeliveryUncertain: () => pauseUnaccepted(true),
        };
        if (delivery === 'steer') {
          // A false return is a local refusal before dispatch. An exception can
          // mean a lost receipt: preserve it as uncertain, never cancel/resend.
          if (await onSteerQueuedMessage?.(input)) lifecycle.onAccepted();
          else lifecycle.onRejectedBeforeAcceptance();
        } else {
          await handleSubmit(input, lifecycle);
        }
        if (!accepted && !deliveryResolved) pauseUnaccepted(true);
      } catch {
        pauseUnaccepted(true);
      } finally {
        if (isCurrentQueueSession()) {
          setSendNowInFlightMessage(message.id, false);
        }
      }
    },
    [
      handleSubmit,
      onSteerQueuedMessage,
      setSendNowInFlightMessage,
      clearPendingSend,
      pauseRemainingQueue,
      clearQueueState,
      setQueuedMessages,
      sessionId,
    ]
  );

  useEffect(() => {
    if (queuedMessages !== queuedMessagesRef.current || queueStorageFailedRef.current) return;
    if (sendNowInFlightMessageIds.size > 0) return;
    const pendingId = pendingSendMessageIdRef.current;
    const message = pendingId
      ? queuedMessages.find((item) => item.id === pendingId)
      : queuedMessages[0];
    if (!message || editingMessageIdRef.current === message.id) return;
    if (queuePausedRef.current && !pendingId) return;
    if (isLoading) {
      if (!automaticSteeringAllowed || cancellationRequestedForQueueRef.current ||
          !message.queuedWhileBusy || !onSteerQueuedMessage || pendingId ||
          (chatState !== ChatState.Thinking && chatState !== ChatState.Streaming)) return;
      const desktop = getDesktopOwnership();
      if (desktop.paused || (message.desktopGeneration ?? '') !== (desktop.generation ?? '')) return;
      let latestUser = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index];
        if (isConversationTurnStart(item) && item.metadata.agentVisible && !item.metadata.pendingDelivery) {
          latestUser = index;
          break;
        }
      }
      const currentMessages = messages.slice(Math.max(0, latestUser));
      const returnedIds = new Set(currentMessages.flatMap(getToolResponses).map(response => response.id));
      const toolRunning = currentMessages.flatMap(getToolRequests).some(request =>
        !returnedIds.has(request.id) && isToolCallInProgress(request, true, []));
      if (!toolRunning) return;
      // Admit supplemental input at the native next-step boundary while the
      // current tool is running. Deferring it until turn/end loses that task
      // boundary and invites the model to reconstruct completed operations.
      void submitQueuedMessage(message, false, true, 'steer');
      return;
    }
    if (queueProcessingBlocked) return;
    const keepPaused = Boolean(pendingId && pendingSendPauseRemainingRef.current);
    if (pendingId && !keepPaused) queuePausedRef.current = false;
    void submitQueuedMessage(message, keepPaused);
  }, [
    isLoading,
    queueProcessingBlocked,
    queuedMessages,
    pendingSendMessageId,
    sendNowInFlightMessageIds,
    submitQueuedMessage,
    onSteerQueuedMessage,
    automaticSteeringAllowed,
    chatState,
    messages,
  ]);
  const [mentionPopover, setMentionPopover] = useState<{
    isOpen: boolean;
    query: string;
    mentionStart: number;
    selectedIndex: number;
    isSlashCommand: boolean;
    addOnly?: boolean;
  }>({
    isOpen: false,
    query: '',
    mentionStart: -1,
    selectedIndex: 0,
    isSlashCommand: false,
  });
  const mentionPopoverRef = useRef<{
    getDisplayFiles: () => DisplayItemWithMatch[];
    selectFile: (index: number) => void;
  }>(null);

  // Audio recorder hook for voice dictation
  const {
    isEnabled,
    dictationProvider,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
  } = useAudioRecorder({
    onTranscription: (text) => {
      trackVoiceDictation('transcribed');

      let filteredText = text.replace(/\([^)]*\)/g, '').trim();

      if (!filteredText) {
        return;
      }

      const shouldAutoSubmit = /\bsubmit[.,!?;'"\s]*$/i.test(filteredText);

      const cleanedText = shouldAutoSubmit
        ? filteredText.replace(/\bsubmit[.,!?;'"\s]*$/i, '').trim()
        : filteredText;

      const newValue =
        displayValue.trim() && cleanedText
          ? `${displayValue.trim()} ${cleanedText}`
          : displayValue.trim() || cleanedText;

      setDisplayValue(newValue);
      setValue(newValue);

      if (shouldAutoSubmit && newValue.trim()) {
        trackVoiceDictation('auto_submit');
        setTimeout(() => {
          performSubmit(newValue);
        }, 100);
      } else {
        textAreaRef.current?.focus();
      }
    },
    onError: (message) => {
      const errorType = 'DictationError';
      trackVoiceDictation('error', undefined, errorType);
      toastError({
        title: intl.formatMessage(i18n.dictationError),
        msg: message,
      });
    },
  });
  const internalTextAreaRef = useRef<HTMLTextAreaElement>(null);
  const textAreaRef = inputRef || internalTextAreaRef;
  const timeoutRefsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    if (newTaskDraftKey && previousInitialValue.current === initialValue) return;
    previousInitialValue.current = initialValue;
    setValue(initialValue);
    restoreDraft(initialValue);
    setPastedImages([]);
    setHistoryIndex(-1);
    setIsInGlobalHistory(false);
    setHasUserTyped(false);
  }, [initialValue, newTaskDraftKey, restoreDraft]);

  useEffect(() => {
    if (!draftDelivery || consumedDraftDelivery.current === draftDelivery.id) return;
    consumedDraftDelivery.current = draftDelivery.id;
    inputRevisionRef.current += 1;
    setDisplayValue((previous) => [previous, draftDelivery.text].filter(Boolean).join('\n'));
    textAreaRef.current?.focus();
  }, [draftDelivery, textAreaRef]);

  useEffect(() => {
    if (!sessionId || sessionLoaded === false || chatState === ChatState.LoadingConversation)
      return;
    return receiveMainConversationMessages(sessionId, (input) => {
      if (input.composerAction) {
        if (attachmentCountRef.current + input.images.length > MAX_IMAGES_PER_MESSAGE)
          throw new Error('主对话附件过多，请先处理现有附件');
        // Reserve before publishing state: several cross-window deliveries can arrive in one render.
        attachmentCountRef.current += input.images.length;
        inputRevisionRef.current += 1;
        // Opening a picker is draft delivery, never a queued or submitted turn.
        if (input.msg)
          setDisplayValue((previous) => [previous, input.msg].filter(Boolean).join('\n'));
        setPastedImages((previous) => [
          ...previous,
          ...input.images.map((image) => ({
            id: globalThis.crypto.randomUUID(),
            dataUrl: `data:${image.mimeType};base64,${image.data}`,
            isLoading: false,
            sourceSessionId: sessionId,
          })),
        ]);
        if (input.composerAction === 'goal' || input.composerAction === 'plan')
          setComposerMode(input.composerAction);
        else if (input.composerAction === 'agent') setAgentOpenRequest((value) => value + 1);
        else
          setMentionPopover({
            isOpen: true,
            isSlashCommand: true,
            addOnly: true,
            query: '',
            mentionStart: 0,
            selectedIndex: 0,
          });
        textAreaRef.current?.focus();
        return;
      }
      if (queueStorageFailedRef.current || !queueStorageRef.current)
        throw new Error('无法保存主对话消息，请重试');
      if (input.messageId && queuedMessagesRef.current.some((item) => item.id === input.messageId))
        return;
      const next = [
        ...queuedMessagesRef.current,
        {
          id: input.messageId ?? globalThis.crypto.randomUUID(),
          content: input.msg,
          images: input.images,
          timestamp: Date.now(),
          desktopGeneration: getDesktopOwnership().generation ?? '',
        },
      ];
      if (!persistQueue(next)) throw new Error('无法保存主对话消息，请检查消息队列');
      if (queuedMessagesRef.current.length === 0) queuePausedRef.current = false;
      queuedMessagesRef.current = next;
      setQueuedMessagesState(next);
    });
  }, [sessionId, sessionLoaded, chatState, persistQueue, textAreaRef]);

  // Handle recipe prompt updates
  useEffect(() => {
    // If recipe is accepted and we have an initial prompt, and no messages yet, and we haven't set it before
    if (recipeAccepted && initialPrompt && messages.length === 0) {
      restoreDraft(initialPrompt);
      setValue(initialPrompt);
      setTimeout(() => {
        textAreaRef.current?.focus();
      }, 0);
    }
  }, [recipeAccepted, initialPrompt, messages.length, textAreaRef, restoreDraft]);

  const [isComposing, setIsComposing] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState('');
  const [isInGlobalHistory, setIsInGlobalHistory] = useState(false);
  const [hasUserTyped, setHasUserTyped] = useState(false);

  // Use shared file drop hook for ChatInput
  const {
    droppedFiles: localDroppedFiles,
    setDroppedFiles: setLocalDroppedFiles,
    handleDrop: handleLocalDrop,
    handleDragOver: handleLocalDragOver,
    addFiles: addLocalFiles,
  } = useFileDrop(newTaskDraftKey ? readNewTaskDraft(newTaskDraftKey).files : []);

  // Merge local dropped files with parent dropped files
  const allDroppedFiles = useMemo(
    () => [
      ...new Map([...localDroppedFiles, ...droppedFiles].map((file) => [file.id, file])).values(),
    ],
    [droppedFiles, localDroppedFiles]
  );
  const attachmentSessionRef = useRef(sessionId);
  attachmentSessionRef.current = sessionId;
  const attachmentIntlRef = useRef(intl);
  attachmentIntlRef.current = intl;
  useEffect(() => {
    setPastedImages((current) =>
      current.filter((image) => !image.sourceSessionId || image.sourceSessionId === sessionId)
    );
  }, [sessionId]);
  const attachmentCountRef = useRef(0);
  attachmentCountRef.current =
    pastedImages.length + allDroppedFiles.filter((file) => file.isImage).length;
  useEffect(() => {
    let disposed = false;
    const attach = (event: Event) => {
      const image = (event as CustomEvent<WorkspaceImageAttachment>).detail;
      if (!image || image.sessionId !== sessionId) return;
      if (attachmentCountRef.current >= MAX_IMAGES_PER_MESSAGE) {
        setAttachmentNotice({
          text: attachmentIntlRef.current.formatMessage(i18n.imageLimit, {
            count: MAX_IMAGES_PER_MESSAGE,
          }),
        });
        return;
      }
      attachmentCountRef.current += 1;
      inputRevisionRef.current += 1;
      const id = `workspace-image-${globalThis.crypto.randomUUID()}`;
      setPastedImages((current) => [
        ...current,
        { id, sourceSessionId: image.sessionId, dataUrl: image.dataUrl, isLoading: true },
      ]);
      // Use the same normalization as pasted/uploaded images; never submit automatically.
      void compressImageDataUrl(image.dataUrl)
        .then((dataUrl) => {
          if (disposed || attachmentSessionRef.current !== image.sessionId) return;
          setPastedImages((current) =>
            current.map((item) => (item.id === id ? { ...item, dataUrl, isLoading: false } : item))
          );
        })
        .catch(() => {
          if (disposed || attachmentSessionRef.current !== image.sessionId) return;
          setPastedImages((current) =>
            current.map((item) =>
              item.id === id
                ? {
                    ...item,
                    isLoading: false,
                    error: attachmentIntlRef.current.formatMessage(i18n.failedToReadImage),
                  }
                : item
            )
          );
        });
      textAreaRef.current?.focus();
    };
    window.addEventListener(ATTACH_WORKSPACE_IMAGE, attach);
    return () => {
      disposed = true;
      window.removeEventListener(ATTACH_WORKSPACE_IMAGE, attach);
    };
  }, [sessionId, textAreaRef]);

  useEffect(() => {
    if (newTaskDraftKey) updateNewTaskDraft(newTaskDraftKey, { images: pastedImages });
  }, [newTaskDraftKey, pastedImages]);
  useEffect(() => {
    if (newTaskDraftKey) updateNewTaskDraft(newTaskDraftKey, { files: allDroppedFiles });
  }, [newTaskDraftKey, allDroppedFiles]);

  const handleRemoveDroppedFile = (idToRemove: string) => {
    inputRevisionRef.current += 1;
    // Remove from local dropped files
    setLocalDroppedFiles((prev) => prev.filter((file) => file.id !== idToRemove));

    // If it's from parent, call the parent's callback
    if (onFilesProcessed && droppedFiles.some((file) => file.id === idToRemove)) {
      onFilesProcessed();
    }
  };

  const handleRemovePastedImage = (idToRemove: string) => {
    inputRevisionRef.current += 1;
    setPastedImages((currentImages) => currentImages.filter((img) => img.id !== idToRemove));
  };

  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.focus();
    }
  }, [textAreaRef]);

  // Handle token usage alerts
  useEffect(() => {
    clearAlerts();

    // Show alert when either there is registered token usage, or we know the limit
    if (shouldShowContextAlert(totalTokens || 0, tokenLimit, isTokenLimitLoaded)) {
      addAlert({
        type: getContextAlertType(totalTokens || 0, tokenLimit),
        message: intl.formatMessage(i18n.contextWindow),
        progress: {
          current: totalTokens || 0,
          total: tokenLimit,
        },
        showCompactButton: true,
        compactButtonDisabled: !totalTokens || isLoading,
        onCompact: () => {
          window.dispatchEvent(new CustomEvent(AppEvents.HIDE_ALERT_POPOVER));
          handleSubmit({ msg: MANUAL_COMPACT_TRIGGER, images: [] });
        },
        compactIcon: <ScrollText size={12} />,
      });
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalTokens, tokenLimit, isTokenLimitLoaded, isLoading, addAlert, clearAlerts]);

  // Cleanup effect for component unmount - prevent memory leaks
  useEffect(() => {
    return () => {
      // Clear all tracked timeouts
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const timeouts = timeoutRefsRef.current;
      timeouts.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      timeouts.clear();

      // Clear alerts to prevent memory leaks
      clearAlerts();
    };
  }, [clearAlerts]);

  const maxHeight = 10 * 24;

  // Immediate function to update actual value - no debounce for better responsiveness
  const updateValue = React.useCallback((value: string) => {
    setValue(value);
  }, []);

  const minTextareaHeight = 38;

  const debouncedAutosize = useMemo(
    () =>
      debounce((element: HTMLTextAreaElement) => {
        // Store current scroll position to prevent jump
        const scrollTop = element.scrollTop;

        // Temporarily set to auto to measure natural height, but use minHeight to prevent collapse
        element.style.height = `${minTextareaHeight}px`;
        const scrollHeight = element.scrollHeight;
        const newHeight = Math.max(minTextareaHeight, Math.min(scrollHeight, maxHeight));
        element.style.height = `${newHeight}px`;

        // Restore scroll position
        element.scrollTop = scrollTop;
      }, 50),
    [maxHeight, minTextareaHeight]
  );

  useEffect(() => {
    if (textAreaRef.current) {
      debouncedAutosize(textAreaRef.current);
    }
    return () => debouncedAutosize.cancel();
  }, [debouncedAutosize, compactText.editorValue, textAreaRef]);

  // Set consistent minimum height when displayValue is empty
  useEffect(() => {
    if (textAreaRef.current && displayValue === '') {
      textAreaRef.current.style.height = `${minTextareaHeight}px`;
    }
  }, [displayValue, textAreaRef, minTextareaHeight]);

  const handleChange = (evt: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = compactText.prefix + evt.target.value;
    const cursorPosition = compactText.prefix.length + evt.target.selectionStart;

    setDisplayValue(val);
    updateValue(val);
    inputRevisionRef.current += 1;
    setHasUserTyped(true);
    checkForMentionOrSlash(val, cursorPosition);
  };

  const checkForMentionOrSlash = (text: string, cursorPosition: number) => {
    const offset = compactText.prefix.length;
    const isSlashCommand = offset === 0 && text.startsWith('/');
    const beforeCursor = text.slice(offset, cursorPosition);
    const lastAtIndex = isSlashCommand ? 0 : beforeCursor.lastIndexOf('@');

    if (
      lastAtIndex === -1 ||
      (!isSlashCommand && /[a-zA-Z0-9._%+-]/.test(beforeCursor[lastAtIndex - 1] ?? ''))
    ) {
      // No @ found, close mention popover
      setMentionPopover((prev) => ({ ...prev, isOpen: false }));
      return;
    }

    // File and conversation names may contain spaces; slash commands still end at a space.
    const afterAt = beforeCursor.slice(lastAtIndex + 1);
    if (
      (isSlashCommand && afterAt.includes(' ')) ||
      afterAt.includes('\n') ||
      afterAt.startsWith('[')
    ) {
      setMentionPopover((prev) => ({ ...prev, isOpen: false }));
      return;
    }

    setMentionPopover((prev) => ({
      ...prev,
      isOpen: true,
      query: afterAt,
      mentionStart: offset + lastAtIndex,
      selectedIndex: 0, // Reset selection when query changes
      isSlashCommand,
      addOnly: false,
      // filteredFiles will be populated by the MentionPopover component
    }));
  };

  const convertImagesToImageData = useCallback((): ImageData[] => {
    const pastedImageData: ImageData[] = pastedImages
      .filter((img) => img.dataUrl && !img.error && !img.isLoading)
      .map((img) => {
        const matches = img.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          return {
            data: matches[2],
            mimeType: matches[1],
          };
        }
        return null;
      })
      .filter((img): img is ImageData => img !== null);

    const droppedImageData: ImageData[] = allDroppedFiles
      .filter((file) => !file.error && !file.isLoading)
      .flatMap(droppedImageUrls)
      .map((dataUrl) => {
        const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        return matches ? { data: matches[2], mimeType: matches[1] } : null;
      })
      .filter((image): image is ImageData => image !== null);

    return [...pastedImageData, ...droppedImageData];
  }, [pastedImages, allDroppedFiles]);

  const appendDroppedFilePaths = useCallback(
    (text: string): string => {
      const droppedFilePaths = allDroppedFiles
        .filter((file) => !file.isImage && !file.error && !file.isLoading)
        .map(
          (file) =>
            (newTaskDraftKey
              ? readNewTaskDraft(newTaskDraftKey).files?.find((saved) => saved.id === file.id)?.path
              : undefined) ?? file.path
        );

      const evidence = videoEvidenceContext(
        allDroppedFiles,
        pastedImages.filter(
          (image) =>
            !image.error && !image.isLoading && /^data:[^;]+;base64,.+$/.test(image.dataUrl)
        ).length
      );
      if (droppedFilePaths.length > 0) {
        const pathsString = droppedFilePaths.join(' ');
        return (text ? `${text} ${pathsString}` : pathsString) + evidence;
      }
      return text;
    },
    [allDroppedFiles, newTaskDraftKey, pastedImages]
  );

  const clearInputState = useCallback(() => {
    if (newTaskDraftKey) updateNewTaskDraft(newTaskDraftKey, { text: '', images: [], files: [] });
    setComposerMode(null);
    setDisplayValue('');
    setReferenceText('');
    setValue('');
    setPastedImages([]);
    if (onFilesProcessed && droppedFiles.length > 0) {
      onFilesProcessed();
    }
    if (localDroppedFiles.length > 0) {
      setLocalDroppedFiles([]);
    }
  }, [
    droppedFiles.length,
    localDroppedFiles.length,
    onFilesProcessed,
    setLocalDroppedFiles,
    newTaskDraftKey,
  ]);

  const handlePaste = async (evt: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isRecording) return;

    const files = Array.from(evt.clipboardData.files || []);
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));

    if (imageFiles.length === 0) {
      const plain = evt.clipboardData.getData('text/plain');
      if (isLargeText(plain)) {
        evt.preventDefault();
        const textarea = textAreaRef.current;
        const start = compactText.prefix.length + (textarea?.selectionStart ?? 0);
        const end = compactText.prefix.length + (textarea?.selectionEnd ?? 0);
        const next = displayValue.slice(0, start) + plain + displayValue.slice(end);
        // Intercept before HTML parsing and before Chromium lays out the paste.
        compactText.appendBlock(next);
        setDisplayValue(next);
        updateValue(next);
        inputRevisionRef.current += 1;
        setHasUserTyped(true);
        setMentionPopover((prev) => ({ ...prev, isOpen: false }));
        return;
      }
      const html = evt.clipboardData.getData('text/html');
      if (html && !isLargeText(html)) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const hasLinks = doc.querySelectorAll('a[href]').length > 0;
        if (hasLinks) {
          const markdown = turndown.turndown(doc.body).trim();
          if (markdown) {
            evt.preventDefault();
            const textarea = textAreaRef.current;
            if (textarea) {
              const start = compactText.prefix.length + textarea.selectionStart;
              const end = compactText.prefix.length + textarea.selectionEnd;
              const newValue =
                displayValue.substring(0, start) + markdown + displayValue.substring(end);
              const cursorPos = start + markdown.length;
              setDisplayValue(newValue);
              updateValue(newValue);
              inputRevisionRef.current += 1;
              setHasUserTyped(true);
              checkForMentionOrSlash(newValue, cursorPos);
              requestAnimationFrame(() => {
                textarea.selectionStart = textarea.selectionEnd =
                  cursorPos - compactText.prefix.length;
              });
            }
          }
        }
      }
      return;
    }

    inputRevisionRef.current += 1;

    // Check if adding these images would exceed the limit
    if (pastedImages.length + imageFiles.length > MAX_IMAGES_PER_MESSAGE) {
      // Show error message to user
      setPastedImages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          dataUrl: '',
          isLoading: false,
          error: `Cannot paste ${imageFiles.length} image(s). Maximum ${MAX_IMAGES_PER_MESSAGE} images per message allowed. Currently have ${pastedImages.length}.`,
        },
      ]);

      // Remove the error message after 5 seconds with cleanup tracking
      const timeoutId = setTimeout(() => {
        setPastedImages((prev) => prev.filter((img) => !img.id.startsWith('error-')));
        timeoutRefsRef.current.delete(timeoutId);
      }, 5000);
      timeoutRefsRef.current.add(timeoutId);

      return;
    }

    evt.preventDefault();

    // Process each image file
    const newImages: PastedImage[] = [];

    for (const file of imageFiles) {
      const imageId = `img-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Add the image with loading state
      newImages.push({
        id: imageId,
        dataUrl: '',
        isLoading: true,
      });

      // Process the image asynchronously
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string;
        if (dataUrl) {
          const compressedDataUrl = await compressImageDataUrl(dataUrl);
          setPastedImages((prev) =>
            prev.map((img) =>
              img.id === imageId ? { ...img, dataUrl: compressedDataUrl, isLoading: false } : img
            )
          );
        }
      };
      reader.onerror = () => {
        console.error('Failed to read image file:', file.name);
        setPastedImages((prev) =>
          prev.map((img) =>
            img.id === imageId
              ? { ...img, error: intl.formatMessage(i18n.failedToReadImage), isLoading: false }
              : img
          )
        );
      };
      reader.readAsDataURL(file);
    }

    // Add all new images to the existing list
    setPastedImages((prev) => [...prev, ...newImages]);
  };

  // Cleanup debounced functions on unmount
  useEffect(() => {
    return () => {
      debouncedAutosize.cancel?.();
    };
  }, [debouncedAutosize]);

  // Handlers for composition events, which are crucial for proper IME behavior
  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
  };

  const handleHistoryNavigation = (evt: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isUp = evt.key === 'ArrowUp';
    const isDown = evt.key === 'ArrowDown';

    // Only handle up/down keys with Cmd/Ctrl modifier
    if ((!isUp && !isDown) || !(evt.metaKey || evt.ctrlKey) || evt.altKey || evt.shiftKey) {
      return;
    }

    // Only prevent history navigation if the user has actively typed something
    // This allows history navigation when text is populated from history or other sources
    // but prevents it when the user is actively editing text
    if (hasUserTyped && displayValue.trim() !== '') {
      return;
    }

    evt.preventDefault();

    // Get global history once to avoid multiple calls
    const globalHistory = LocalMessageStorage.getRecentMessages() || [];

    // Save current input if we're just starting to navigate history
    if (historyIndex === -1) {
      setSavedInput(draftText || '');
      setIsInGlobalHistory(commandHistory.length === 0);
    }

    // Determine which history we're using
    const currentHistory = isInGlobalHistory ? globalHistory : commandHistory;
    let newIndex = historyIndex;
    let newValue = '';

    // Handle navigation
    if (isUp) {
      // Moving up through history
      if (newIndex < currentHistory.length - 1) {
        // Still have items in current history
        newIndex = historyIndex + 1;
        newValue = currentHistory[newIndex];
      } else if (!isInGlobalHistory && globalHistory.length > 0) {
        // Switch to global history
        setIsInGlobalHistory(true);
        newIndex = 0;
        newValue = globalHistory[newIndex];
      }
    } else {
      // Moving down through history
      if (newIndex > 0) {
        // Still have items in current history
        newIndex = historyIndex - 1;
        newValue = currentHistory[newIndex];
      } else if (isInGlobalHistory && commandHistory.length > 0) {
        // Switch to chat history
        setIsInGlobalHistory(false);
        newIndex = commandHistory.length - 1;
        newValue = commandHistory[newIndex];
      } else {
        // Return to original input
        newIndex = -1;
        newValue = savedInput;
      }
    }

    // Update display if we have a new value
    if (newIndex !== historyIndex) {
      setHistoryIndex(newIndex);
      if (newIndex === -1) {
        restoreDraft(savedInput || '');
        setValue(savedInput || '');
      } else {
        restoreDraft(newValue || '');
        setValue(newValue || '');
      }
      // Reset hasUserTyped when we populate from history
      setHasUserTyped(false);
    }
  };

  const queueWhileBusy = () => {
    if (isCurrentDraftSubmitted) return false;
    if ((!isLoading && !queueProcessingBlocked) || !hasSubmittableContent) return false;
    const newMessage: QueuedMessage = {
      queuedWhileBusy: true,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      content: appendDroppedFilePaths(draftText.trim()),
      timestamp: Date.now(),
      desktopGeneration: getDesktopOwnership().generation ?? '',
      images: convertImagesToImageData(),
    };
    if (
      !isLoading &&
      queueProcessingBlocked &&
      cancellationRequestedForQueueRef.current &&
      onPendingMessageChange &&
      !pendingSendMessageIdRef.current
    ) {
      const anchor = [...messages].reverse().find((message) => message.id)?.id;
      if (anchor) {
        newMessage.presentation = { afterMessageId: anchor };
        pendingSendMessageIdRef.current = newMessage.id;
        pendingSendPauseRemainingRef.current = true;
        setPendingSendMessageId(newMessage.id);
      }
    }
    setQueuedMessages((prev) => {
      if (prev.length === 0) queuePausedRef.current = false;
      return [...prev, newMessage];
    });
    clearInputState();
    return true;
  };

  const canSubmit =
    !isLoading &&
    !queueProcessingBlocked &&
    (draftText.trim() ||
      pastedImages.some((img) => img.dataUrl && !img.error && !img.isLoading) ||
      allDroppedFiles.some((file) => !file.error && !file.isLoading));

  const performSubmit = useCallback(
    async (text?: string, preserveDraft = false) => {
      if (submissionDisabled) return;
      // Control commands must remain usable while the ordinary prompt awaits completion.
      const commandText =
        text ?? (composerMode ? `/${composerMode} ${displayValue.trim()}` : displayValue.trim());
      const uiCommand = parseComposerUiCommand(commandText);
      if (uiCommand) {
        const revision = inputRevisionRef.current;
        try {
          if (uiCommand === 'file') {
            if (isFilePickerOpen) return;
            fileInputRef.current?.click();
          } else if (uiCommand === 'agent') setAgentOpenRequest((value) => value + 1);
          else if (uiCommand === 'permission') {
            if (!onOpenPermissions) {
              setCommandNotice(intl.formatMessage(composerMessages.noSession));
              return;
            }
            onOpenPermissions();
          } else if (uiCommand === 'model') setModelOpenRequest((value) => value + 1);
          else {
            if (!sessionId) {
              setCommandNotice(intl.formatMessage(composerMessages.noSession));
              return;
            }
            const json = await acpExportSession(sessionId);
            const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
            const anchor = document.createElement('a');
            try {
              anchor.href = url;
              anchor.download = `conversation-${sessionId}.json`;
              document.body.appendChild(anchor);
              anchor.click();
            } finally {
              anchor.remove();
              URL.revokeObjectURL(url);
            }
            setCommandNotice(intl.formatMessage(composerMessages.exported));
          }
          if (!preserveDraft && inputRevisionRef.current === revision) {
            inputRevisionRef.current += 1;
            setDisplayValue('');
            setReferenceText('');
            setValue('');
            setComposerMode(null);
          }
        } catch {
          setCommandNotice(composerCommandFailure(intl));
        }
        return;
      }
      if (isComposerControl(commandText)) {
        if (commandControlInFlight.current) return;
        const operation = Symbol('composer-command');
        commandControlInFlight.current = operation;
        const revision = inputRevisionRef.current;
        const release = () => {
          if (commandControlInFlight.current === operation) commandControlInFlight.current = null;
        };
        const clearCommand = () => {
          // Status-bar actions must preserve the user's unrelated message draft.
          if (preserveDraft) return;
          if (revision !== inputRevisionRef.current) return;
          inputRevisionRef.current += 1;
          setComposerMode(null);
          setDisplayValue('');
          setReferenceText('');
          setValue('');
        };
        try {
          const result = await prepareComposerCommand(
            { msg: commandText, images: [] },
            sessionId,
            isLoading,
            intl
          );
          if (result.notice) setCommandNotice(result.notice);
          if (result.input) {
            setCommandNotice(null);
            await handleSubmit(result.input, {
              onAccepted: () => {
                setGoalRefresh((value) => value + 1);
                clearCommand();
                release();
                if (queueSessionIdRef.current === sessionId) onSubmissionAccepted?.();
              },
              onRejectedBeforeAcceptance: () => setCommandNotice(composerCommandFailure(intl)),
            });
          } else {
            setGoalRefresh((value) => value + 1);
            clearCommand();
          }
        } catch {
          setCommandNotice(composerCommandFailure(intl));
        } finally {
          release();
        }
        return;
      }
      const submittedAtMs = Date.now();
      if (submitInFlightRef.current || sendNowInFlightMessageIdsRef.current.size > 0) return;

      const imageData = convertImagesToImageData();
      const textToSend = appendDroppedFilePaths(
        combineConversationDraft(commandText, referenceText)
      );

      if (textToSend || imageData.length > 0) {
        const submittedDraft = createSubmittedDraftState(
          draftText,
          imageData,
          inputRevisionRef.current
        );
        const submittedPastedImages = [...pastedImages];
        const submittedLocalDroppedFiles = [...localDroppedFiles];
        const pending = { sessionId, revision: submittedDraft.revision };
        const clearPendingDraft = () =>
          setPendingDraft((current) => (current === pending ? undefined : current));
        let accepted = false;
        const lifecycle: MessageSubmissionLifecycle = {
          submittedAtMs,
          onAccepted: () => {
            if (accepted) return;
            accepted = true;
            clearPendingDraft();
            setGoalRefresh((value) => value + 1);
            if (draftText.trim()) {
              LocalMessageStorage.addMessage(draftText);
            } else {
              const droppedFilePaths = allDroppedFiles
                .filter((file) => !file.isImage && !file.error && !file.isLoading)
                .map((file) => file.path);
              if (droppedFilePaths.length > 0) {
                LocalMessageStorage.addMessage(droppedFilePaths.join(' '));
              }
            }
            if (acceptSubmittedDraft(submittedDraft, inputRevisionRef.current).shouldClear) {
              inputRevisionRef.current += 1;
              clearInputState();
              setHistoryIndex(-1);
              setSavedInput('');
              setIsInGlobalHistory(false);
              setHasUserTyped(false);
            }
            // An explicit send resumes this viewport; automatic queued delivery
            // and unrelated session events must leave the reader in control.
            if (queueSessionIdRef.current === sessionId) onSubmissionAccepted?.();
          },
          onRejectedBeforeAcceptance: () => {
            clearPendingDraft();
            const rejected = rejectSubmittedDraft(submittedDraft, inputRevisionRef.current);
            if (!rejected.shouldRestore) return;
            restoreDraft(rejected.text);
            setValue(rejected.text);
            setPastedImages(submittedPastedImages);
            setLocalDroppedFiles(submittedLocalDroppedFiles);
          },
        };
        submitInFlightRef.current = true;
        setPendingDraft(pending);
        try {
          const prepared = await prepareComposerCommand(
            { msg: textToSend, images: imageData },
            sessionId,
            isLoading,
            intl
          );
          if (prepared.notice) {
            setCommandNotice(prepared.notice);
            return;
          }
          setCommandNotice(null);
          if (prepared.input)
            await handleSubmit(
              {
                ...prepared.input,
              },
              lifecycle
            );
        } catch {
          lifecycle.onRejectedBeforeAcceptance();
          return;
        } finally {
          submitInFlightRef.current = false;
          clearPendingDraft();
        }
      }
    },
    [
      submissionDisabled, composerMode,
      isFilePickerOpen,
      onOpenPermissions,
      sessionId,
      isLoading,
      intl,
      convertImagesToImageData,
      appendDroppedFilePaths,
      displayValue,
      draftText,
      referenceText,
      restoreDraft,
      pastedImages,
      localDroppedFiles,
      allDroppedFiles,
      handleSubmit,
      clearInputState,
      onSubmissionAccepted,
      setLocalDroppedFiles,
    ]
  );

  const handleKeyDown = (evt: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (submissionDisabled && evt.key === 'Enter' && !evt.shiftKey && !evt.altKey && !isComposing && !evt.nativeEvent.isComposing) { evt.preventDefault(); return; }
    if (evt.key === 'Enter' && (isComposing || evt.nativeEvent.isComposing)) return;
    if (mentionPopover.isOpen && mentionPopoverRef.current) {
      if (evt.key === 'ArrowDown') {
        evt.preventDefault();
        const displayFiles = mentionPopoverRef.current.getDisplayFiles();
        const maxIndex = Math.max(0, displayFiles.length - 1);
        setMentionPopover((prev) => ({
          ...prev,
          selectedIndex: Math.min(prev.selectedIndex + 1, maxIndex),
        }));
        return;
      }
      if (evt.key === 'ArrowUp') {
        evt.preventDefault();
        setMentionPopover((prev) => ({
          ...prev,
          selectedIndex: Math.max(prev.selectedIndex - 1, 0),
        }));
        return;
      }
      if (evt.key === 'Enter' || (evt.key === 'Tab' && !evt.shiftKey)) {
        evt.preventDefault();
        mentionPopoverRef.current.selectFile(mentionPopover.selectedIndex);
        return;
      }
      if (evt.key === 'Escape') {
        evt.preventDefault();
        setMentionPopover((prev) => ({ ...prev, isOpen: false }));
        return;
      }
    }

    if (composerMode && !displayValue && evt.key === 'Backspace') {
      setComposerMode(null);
      return;
    }
    handleHistoryNavigation(evt);

    if (evt.key === 'Enter') {
      // should not trigger submit on Enter if it's composing (IME input in progress) or shift/alt(option) is pressed
      if (evt.shiftKey || isComposing) {
        // Allow line break for Shift+Enter, or during IME composition
        return;
      }

      if (evt.altKey) {
        const newValue = displayValue + '\n';
        setDisplayValue(newValue);
        setValue(newValue);
        return;
      }

      evt.preventDefault();

      if (
        composerMode ||
        parseComposerCommand(displayValue) ||
        parseComposerUiCommand(displayValue)
      ) {
        void performSubmit();
        return;
      }
      // Enter queues a follow-up; Send now steers, and only Stop cancels work.
      if (queueWhileBusy()) {
        return;
      }

      if (canSubmit) {
        performSubmit();
      }
    }
  };

  const onFormSubmit = (e: React.FormEvent | React.MouseEvent) => {
    e.preventDefault();
    if (submissionDisabled) return;
    if (
      composerMode ||
      parseComposerCommand(displayValue) ||
      parseComposerUiCommand(displayValue)
    ) {
      void performSubmit();
      return;
    }
    if (queueWhileBusy()) return;
    const canSubmit =
      !isLoading &&
      !queueProcessingBlocked &&
      (draftText.trim() ||
        pastedImages.some((img) => img.dataUrl && !img.error && !img.isLoading) ||
        allDroppedFiles.some((file) => !file.error && !file.isLoading));
    if (canSubmit) {
      performSubmit();
    }
  };

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picker = e.currentTarget;
    const files = Array.from(picker.files ?? []);
    if (!files.length) return;
    inputRevisionRef.current += 1;
    let imageSlots = Math.max(0, MAX_IMAGES_PER_MESSAGE - attachmentCountRef.current);
    const accepted = files.filter((file) => !file.type.startsWith('image/') || imageSlots-- > 0);
    if (accepted.length !== files.length) {
      setAttachmentNotice({
        text: intl.formatMessage(i18n.imageLimit, { count: MAX_IMAGES_PER_MESSAGE }),
      });
    }
    setIsFilePickerOpen(true);
    try {
      accepted.forEach(() => trackFileAttached('file'));
      await addLocalFiles(accepted);
    } finally {
      picker.value = '';
      setIsFilePickerOpen(false);
      textAreaRef.current?.focus();
    }
  };

  const toolboxSelectionRef = useRef(false);
  const selectionSessionRef = useRef(sessionId);
  selectionSessionRef.current = sessionId;

  const handleMentionItemSelect = async (itemText: string, item?: DisplayItem) => {
    const incoming = conversationMentions(itemText)[0];
    if (incoming) {
      const selected = new Set(
        conversationMentions(referenceText).map((reference) => reference.uri)
      );
      if (!selected.has(incoming.uri) && selected.size >= 3) {
        setCommandNotice(intl.formatMessage(i18n.referenceLimit));
        setMentionPopover((previous) => ({ ...previous, isOpen: false }));
        return;
      }
      setCommandNotice(null);
      const selectedMention = itemText.trim();
      if (!selected.has(incoming.uri)) {
        setReferenceText((previous) => combineConversationDraft(previous, selectedMention));
      }
      itemText = '';
    }
    if (item?.toolboxItem) {
      if (toolboxSelectionRef.current) return;
      const selected = item.toolboxItem;
      const revision = inputRevisionRef.current;
      const selectedSession = sessionId;
      setMentionPopover((prev) => ({ ...prev, isOpen: false }));
      if (selected.kind === 'skill' && selected.status === 'disabled') {
        setCommandNotice(intl.formatMessage(composerMessages.disabledSkill));
        return;
      }
      toolboxSelectionRef.current = true;
      try {
        const extension = selected.extensionSource;
        if (extension && sessionId) {
          setCommandNotice(intl.formatMessage(composerMessages.loadingTool));
          const loaded = await getSessionExtensions(sessionId);
          if (!loaded.some((entry) => entry.name === extension.name)) {
            await addSessionExtension(sessionId, extension);
            window.dispatchEvent(new Event(AppEvents.SESSION_EXTENSIONS_LOADED));
          }
        } else if (extension && nextChatExtensionDraft && onNextChatExtensionDraftChange) {
          onNextChatExtensionDraftChange({
            selectedNames: new Set([...nextChatExtensionDraft.selectedNames, extension.name]),
          });
        } else if (extension) {
          throw new Error('No conversation extension selection is available');
        }
        // Do not overwrite typing or a different conversation while a server connects.
        if (
          selectionSessionRef.current !== selectedSession ||
          inputRevisionRef.current !== revision
        )
          return;
        itemText = intl.formatMessage(
          selected.kind === 'skill' ? composerMessages.useSkill : composerMessages.useTool,
          { name: selected.name }
        );
        setCommandNotice(null);
      } catch {
        if (selectionSessionRef.current === selectedSession)
          setCommandNotice(intl.formatMessage(composerMessages.toolLoadFailed));
        return;
      } finally {
        toolboxSelectionRef.current = false;
      }
    }
    if (mentionPopover.isSlashCommand && parseComposerUiCommand(itemText)) {
      setMentionPopover((prev) => ({ ...prev, isOpen: false }));
      void performSubmit(itemText.trim(), mentionPopover.addOnly);
      return;
    }
    if (mentionPopover.isSlashCommand && ['/goal', '/plan'].includes(itemText.trim())) {
      if (itemText.trim() === '/goal' && sessionId) {
        setMentionPopover((prev) => ({ ...prev, isOpen: false }));
        const revision = inputRevisionRef.current;
        void getSessionGoal(sessionId)
          .then((goal) => {
            if (revision !== inputRevisionRef.current) return;
            if (goal && goal.phase !== 'complete') {
              openGoalEditor(sessionId);
              if (!mentionPopover.addOnly) {
                setDisplayValue('');
                setReferenceText('');
                setValue('');
              }
            } else {
              setComposerMode('goal');
              if (!mentionPopover.addOnly) {
                setDisplayValue('');
                setReferenceText('');
                setValue('');
              }
              textAreaRef.current?.focus();
            }
            inputRevisionRef.current += 1;
          })
          .catch(() => setCommandNotice(composerCommandFailure(intl)));
        return;
      }
      setComposerMode(itemText.trim() === '/goal' ? 'goal' : 'plan');
      if (!mentionPopover.addOnly) {
        setDisplayValue('');
        setReferenceText('');
        setValue('');
      }
      inputRevisionRef.current += 1;
      setCommandNotice(null);
      setMentionPopover((prev) => ({ ...prev, isOpen: false }));
      textAreaRef.current?.focus();
      return;
    }
    if (
      mentionPopover.isSlashCommand &&
      isComposerControl(itemText) &&
      !['/goal', '/plan'].includes(itemText.trim())
    ) {
      setMentionPopover((prev) => ({ ...prev, isOpen: false }));
      void performSubmit(itemText.trim());
      return;
    }
    // Replace the @ mention with the file path
    const beforeMention = displayValue.slice(0, mentionPopover.mentionStart);
    const afterMention = displayValue.slice(
      mentionPopover.mentionStart + (mentionPopover.addOnly ? 0 : 1 + mentionPopover.query.length)
    );
    const newValue = `${beforeMention}${itemText}${afterMention}`;

    inputRevisionRef.current += 1;
    setDisplayValue(newValue);
    setValue(newValue);
    setMentionPopover((prev) => ({ ...prev, isOpen: false }));
    textAreaRef.current?.focus();

    // Set cursor position after the inserted file path
    setTimeout(() => {
      if (textAreaRef.current) {
        const newCursorPosition =
          beforeMention.length + itemText.length - compactText.prefix.length;
        textAreaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
      }
    }, 0);
  };

  const hasSubmittableContent =
    draftText.trim() ||
    pastedImages.some((img) => img.dataUrl && !img.error && !img.isLoading) ||
    allDroppedFiles.some((file) => !file.error && !file.isLoading);
  const actionVisibility = chatInputActionVisibility(
    isLoading,
    Boolean(hasSubmittableContent) && !isCurrentDraftSubmitted
  );
  const isAnyImageLoading = pastedImages.some((img) => img.isLoading);
  const isAnyDroppedFileLoading = allDroppedFiles.some((file) => file.isLoading);
  const continueAction = chatState === ChatState.Idle && !draftText.trim() &&
    !pastedImages.length && !allDroppedFiles.length && !isRecording && !isTranscribing
    ? onContinue : undefined;
  const primaryActionDisabled = submissionDisabled || !continueAction && (
    isCurrentDraftSubmitted ||
    !hasSubmittableContent ||
    isAnyImageLoading ||
    isAnyDroppedFileLoading ||
    isRecording ||
    isTranscribing ||
    chatState === ChatState.RestartingAgent
  );

  const getSubmitButtonTooltip = (): string => {
    if (chatState === ChatState.RestartingAgent) return intl.formatMessage(i18n.restartingSession);
    if (isComposerControl(displayValue)) return intl.formatMessage(i18n.send);
    if (isLoading || queueProcessingBlocked)
      return queueBlockedReason ?? intl.formatMessage(i18n.queueMessage);
    if (isAnyImageLoading) return intl.formatMessage(i18n.waitingForImages);
    if (isAnyDroppedFileLoading) return intl.formatMessage(i18n.processingDroppedFiles);
    if (isRecording) return intl.formatMessage(i18n.recording);
    if (isTranscribing) return intl.formatMessage(i18n.transcribing);
    if (!hasSubmittableContent) return intl.formatMessage(i18n.typeMessage);
    return intl.formatMessage(i18n.send);
  };

  const handleConfirmNotSent = (messageId: string) => {
    if (sendNowInFlightMessageIdsRef.current.has(messageId)) return;
    pauseRemainingQueue();
    setQueuedMessages((items) =>
      items.map((item) => (item.id === messageId ? { ...item, delivery: 'pending' } : item))
    );
  };

  const handleRemoveQueuedMessage = (messageId: string) => {
    if (sendNowInFlightMessageIdsRef.current.has(messageId)) return;
    clearPendingSend(messageId);
    setQueuedMessages((prev) => prev.filter((msg) => msg.id !== messageId));
  };

  const handleClearQueue = () => {
    if (sendNowInFlightMessageIdsRef.current.size > 0) return;
    setQueuedMessages([]);
    clearQueueState();
  };

  const handleReorderMessages = (reorderedMessages: QueuedMessage[]) => {
    if (reorderedMessages.some((message) => sendNowInFlightMessageIdsRef.current.has(message.id))) {
      return;
    }
    const reorderedIds = new Set(reorderedMessages.map((message) => message.id));
    let index = 0;
    setQueuedMessages((items) => items.map((item) =>
      reorderedIds.has(item.id) ? reorderedMessages[index++] : item
    ));
  };

  const handleSteerMessage = (id: string) => {
    const item = queuedMessagesRef.current.find((message) => message.id === id);
    if (!item || pendingSendMessageIdRef.current || editingMessageIdRef.current) return;
    void submitQueuedMessage(
      { ...item, desktopGeneration: getDesktopOwnership().generation ?? '' },
      queuePausedRef.current, false, 'steer'
    );
  };

  const handleEditMessage = (messageId: string, newContent: string) => {
    if (sendNowInFlightMessageIdsRef.current.has(messageId)) return;
    setQueuedMessages((prev) =>
      prev.map((msg) => (msg.id === messageId ? { ...msg, content: newContent } : msg))
    );
  };

  const handleSendNow = async () => {
    if (
      queueStorageFailedRef.current ||
      editingMessageIdRef.current ||
      pendingSendMessageIdRef.current
    )
      return;
    // Freeze only known-unsent input at the click. An unconfirmed delivery is
    // never replayed, and later additions remain ordinary follow-ups.
    const pending = queuedMessagesRef.current.filter(
      (message) =>
        message.delivery !== 'submitting' && !sendNowInFlightMessageIdsRef.current.has(message.id)
    );
    if (!pending.length) return;
    let messageToSend: QueuedMessage =
      pending.length === 1
        ? pending[0]
        : {
            ...pending[0],
            content: pending.map((message) => message.content).join('\n\n'),
            images: pending.flatMap((message) => message.images),
          };
    // An explicit send is a new user decision; automatic queue delivery keeps
    // the desktop generation captured when the message was composed.
    messageToSend = { ...messageToSend, desktopGeneration: getDesktopOwnership().generation ?? '' };
    const messageId = messageToSend.id;
    const mergedIds = new Set(pending.map((message) => message.id));
    const keepOtherMessagesPaused = queuedMessagesRef.current.some(
      (message) => !mergedIds.has(message.id)
    );
    setQueuedMessages((previous) => [
      messageToSend,
      ...previous.filter((message) => !mergedIds.has(message.id)),
    ]);
    if (queueStorageFailedRef.current) return;
    if (isLoading && !canSubmitQueuedMessageWhileLoading && onSteerQueuedMessage) {
      await submitQueuedMessage(messageToSend, keepOtherMessagesPaused, false, 'steer');
      return;
    }
    if (
      (!isLoading || canSubmitQueuedMessageWhileLoading) &&
      !queueProcessingBlocked &&
      sendNowInFlightMessageIdsRef.current.size === 0
    ) {
      if (!keepOtherMessagesPaused) queuePausedRef.current = false;
      await submitQueuedMessage(
        messageToSend,
        keepOtherMessagesPaused,
        canSubmitQueuedMessageWhileLoading
      );
      return;
    }

    // If no active steer endpoint is available, keep the message for the next
    // turn. Never turn Send now into cancellation or overlap ordinary prompts.
    pendingSendMessageIdRef.current = messageId;
    pendingSendPauseRemainingRef.current = keepOtherMessagesPaused;
    setPendingSendMessageId(messageId);
    pauseRemainingQueue();
    let anchor: string | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].id) {
        anchor = messages[index].id!;
        break;
      }
    }
    setQueuedMessages((prev) =>
      prev.map(({ presentation, ...item }) => ({
        ...item,
        ...(item.id === messageId && onPendingMessageChange && anchor
          ? { presentation: presentation ?? { afterMessageId: anchor } }
          : {}),
      }))
    );
    if (queueStorageFailedRef.current) {
      clearPendingSend(messageId);
      return;
    }
  };

  const handleStop = () => {
    clearPendingSend();
    cancellationRequestedForQueueRef.current = (isLoading || queueProcessingBlocked) && !!onStop;
    if (pauseQueueOnStop && queuedMessages.length > 0) {
      pauseRemainingQueue();
    }
    if (onStop) onStop();
  };

  const handleQueueEditComplete = () => {
    if (editingMessageIdRef.current) return;
    setQueuedMessages((previous) => [...previous]);
  };

  const canSteerCurrentTurn = (chatState === ChatState.Thinking || chatState === ChatState.Streaming)
    && !canSubmitQueuedMessageWhileLoading && !!onSteerQueuedMessage;
  const visibleQueuedMessages = queuedMessages.filter(
    (message) => !message.presentation || message.id !== pendingSendMessageId
  );
  const messageQueue = visibleQueuedMessages.length > 0 && (
    <MessageQueue
      queuedMessages={visibleQueuedMessages}
      onRemoveMessage={handleRemoveQueuedMessage}
      onConfirmNotSent={handleConfirmNotSent}
      onClearQueue={handleClearQueue}
      onSendNow={handleSendNow}
      onSteerMessage={canSteerCurrentTurn ? handleSteerMessage : undefined}
      onReorderMessages={handleReorderMessages}
      onEditMessage={handleEditMessage}
      onTriggerQueueProcessing={handleQueueEditComplete}
      editingMessageIdRef={editingMessageIdRef}
      sendingMessageIds={sendNowInFlightMessageIds}
      waitingMessageId={pendingSendMessageId}
      isPaused={queuePausedRef.current}
      isBusy={isLoading || queueProcessingBlocked}
      blockedReason={queueBlockedReason ?? (
        queueProcessingBlocked && (!isLoading || !!pendingSendMessageId || cancellationRequestedForQueueRef.current)
          ? intl.formatMessage(
              cancellationRequestedForQueueRef.current
                ? i18n.waitingForCancellation
                : i18n.waitingForPreviousPrompt
            )
          : undefined
      )}
      className="mx-2 rounded-t-xl border border-b-0 border-border-primary bg-background-primary px-1 py-1"
    />
  );

  const inputCard = (
    <ChatInputCard
      className={`shell-composer @container/composer flex min-w-0 flex-col relative h-auto p-3 transition-colors ${
        disableAnimation ? '' : 'page-transition'
      } z-10`}
      data-drop-zone="true"
      onDrop={handleLocalDrop}
      onDragOver={handleLocalDragOver}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
        accept="*/*"
      />
      <ComposerGoalBar
        sessionId={sessionId}
        busy={isLoading}
        refreshKey={goalRefresh}
        onCommand={(command) => performSubmit(command, true)}
        onEdit={() => {
          if (sessionId) openGoalEditor(sessionId);
        }}
      />
      {/* Message Queue Display */}
      {queueStorageError && (
        <div role="alert" className="p-3 text-sm text-text-primary">
          {queueStorageError === 'conflict'
            ? intl.formatMessage({
                id: 'messageQueue.storageConflict',
                defaultMessage:
                  'This queue changed in another window. Sending and saving are paused to avoid overwriting it. Keep this window open and compare the queued messages.',
              })
            : intl.formatMessage({
                id: 'messageQueue.storageFailure',
                defaultMessage:
                  'The queue could not be saved or restored. Messages and attachments in this window are kept in memory. Keep this window open to avoid losing them.',
              })}
          {queueStorageError === 'save' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                queueStorageFailedRef.current = false;
                if (persistQueue(queuedMessagesRef.current)) setQueueStorageError(null);
              }}
            >
              {intl.formatMessage({
                id: 'messageQueue.retrySave',
                defaultMessage: 'Retry saving queue',
              })}
            </Button>
          )}
        </div>
      )}
      {pendingSendMessageId &&
        queuedMessages.some(
          (message) => message.id === pendingSendMessageId && message.presentation
        ) && (
          <p role="status" className="px-3 pb-2 text-xs text-text-secondary">
            {intl.formatMessage(i18n.waitingForCancellation)}
          </p>
        )}
      {attachmentNotice && (
        <p
          role="status"
          className="mx-3 mb-2 rounded-lg bg-background-secondary px-3 py-2 text-xs text-text-secondary"
        >
          {attachmentNotice.text}
        </p>
      )}
      {commandNotice && (
        <div
          role="status"
          className="mx-3 mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background-secondary px-3 py-2 text-xs leading-5 text-text-secondary"
        >
          {commandNotice}
        </div>
      )}
      {/* Input row with inline action buttons wrapped in form */}
      <ConversationReferences
        text={referenceText}
        onChange={(next) => {
          inputRevisionRef.current += 1;
          setReferenceText(next);
          setCommandNotice(null);
          textAreaRef.current?.focus();
        }}
      />
      {/* All attachment types share a separate tray above the full-width editor. */}
      {attachmentPreview && (
        <ImageLightbox
          src={attachmentPreview.src}
          title={attachmentPreview.title}
          open
          onOpenChange={(open) => {
            if (!open) setAttachmentPreview(null);
          }}
        />
      )}
      {(compactText.prefix || pastedImages.length > 0 || allDroppedFiles.length > 0) && (
        <ComposerAttachmentTray>
          {compactText.blocks.map((block) => (
            <div key={block.id} data-attachment-kind="text" className="max-w-full pb-1">
              <PastedTextPreview
                text={block.text}
                onRemove={() => {
                  const remaining = compactText.removeBlock(block.id);
                  setDisplayValue(remaining);
                  updateValue(remaining);
                  inputRevisionRef.current += 1;
                  setHasUserTyped(true);
                }}
              />
            </div>
          ))}

          {/* Render pasted images first */}
          {pastedImages.map((img) => (
            <div key={img.id} data-attachment-kind="image" className="relative group w-20 h-20">
              {img.dataUrl && (
                <button
                  type="button"
                  className="h-full w-full rounded focus-visible:outline focus-visible:outline-2"
                  onClick={() =>
                    setAttachmentPreview({
                      src: img.dataUrl,
                      title: intl.formatMessage(i18n.pastedImage, { id: img.id }),
                    })
                  }
                >
                  <img
                    src={img.dataUrl}
                    alt={intl.formatMessage(i18n.pastedImage, { id: img.id })}
                    className={`w-full h-full object-cover rounded border ${img.error ? 'border-red-500' : 'border-border-primary'}`}
                  />
                </button>
              )}
              {img.isLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded">
                  <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white"></div>
                </div>
              )}
              {img.error && !img.isLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-75 rounded p-1 text-center">
                  <p className="text-red-400 text-[10px] leading-tight break-all">
                    {img.error.substring(0, 50)}
                  </p>
                </div>
              )}
              {!img.isLoading && (
                <Button
                  type="button"
                  shape="round"
                  onClick={() => handleRemovePastedImage(img.id)}
                  className="absolute -top-1 -right-1 z-10 bg-text-primary text-background-primary ring-2 ring-background-primary hover:bg-text-primary/85 hover:text-background-primary"
                  aria-label={intl.formatMessage(i18n.removeImage)}
                  variant="ghost"
                  size="xs"
                >
                  <Close />
                </Button>
              )}
            </div>
          ))}

          {/* Render dropped files after pasted images */}
          {allDroppedFiles.map((file) => (
            <div
              key={file.id}
              data-attachment-kind={file.isImage ? 'image' : file.isVideo ? 'video' : 'file'}
              className="relative group max-w-full"
            >
              {file.error && !file.isImage && (
                <p role="alert" className="text-xs text-red-500 max-w-[200px]">
                  {file.error}
                </p>
              )}
              {file.isImage ? (
                // Image preview
                <div className="w-20 h-20">
                  {file.dataUrl && (
                    <button
                      type="button"
                      className="h-full w-full rounded focus-visible:outline focus-visible:outline-2"
                      onClick={() => setAttachmentPreview({ src: file.dataUrl!, title: file.name })}
                    >
                      <img
                        src={file.dataUrl}
                        alt={file.name}
                        className={`w-full h-full object-cover rounded border ${file.error ? 'border-red-500' : 'border-border-primary'}`}
                      />
                    </button>
                  )}
                  {file.isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded">
                      <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white"></div>
                    </div>
                  )}
                  {file.error && !file.isLoading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black bg-opacity-75 rounded p-1 text-center">
                      <p className="text-red-400 text-[10px] leading-tight break-all">
                        {file.error.substring(0, 30)}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                // File box preview
                <div className="flex items-center gap-2 px-3 py-2 bg-bgSubtle border border-border-primary rounded-lg min-w-[120px] max-w-[200px]">
                  <div className="flex-shrink-0 w-8 h-8 bg-background-primary border border-border-primary rounded flex items-center justify-center text-xs font-mono text-text-secondary">
                    {file.name.split('.').pop()?.toUpperCase() || 'FILE'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary truncate" title={file.name}>
                      {file.name}
                    </p>
                    <p
                      className="text-xs text-text-secondary"
                      title={file.videoSample?.timestampsSeconds.map(videoTimestamp).join(', ')}
                    >
                      {file.isVideo && file.videoSample
                        ? intl.formatMessage(
                            {
                              id: 'chatInput.videoSampleScope',
                              defaultMessage: '{count} sampled frames · audio not analyzed',
                            },
                            { count: file.frameDataUrls?.length ?? 0 }
                          )
                        : file.type || intl.formatMessage(i18n.unknownType)}
                    </p>
                  </div>
                </div>
              )}
              {!file.isLoading && (
                <Button
                  type="button"
                  shape="round"
                  onClick={() => handleRemoveDroppedFile(file.id)}
                  className="absolute -top-1 -right-1 z-10 bg-text-primary text-background-primary ring-2 ring-background-primary hover:bg-text-primary/85 hover:text-background-primary"
                  aria-label={intl.formatMessage(i18n.removeFile)}
                  variant="ghost"
                  size="xs"
                >
                  <Close />
                </Button>
              )}
            </div>
          ))}
        </ComposerAttachmentTray>
      )}

      {/* Input row with inline action buttons wrapped in form */}
      <form
        onSubmit={onFormSubmit}
        data-testid="composer-input-row"
        className="relative w-full min-w-0"
      >
        <div className="relative flex w-full min-w-0 items-start">
          {composerMode && (
            <button
              type="button"
              className="ml-3 mt-3 shrink-0 text-sm text-blue-500 hover:underline"
              title={intl.formatMessage(composerMessages.cancelMode)}
              aria-label={intl.formatMessage(composerMessages.cancelMode)}
              onClick={() => {
                setComposerMode(null);
                textAreaRef.current?.focus();
              }}
            >
              /
              {intl.formatMessage(
                composerMode === 'plan' ? composerMessages.plan : composerMessages.goalPrefix
              )}
            </button>
          )}
          <textarea
            data-testid="chat-input"
            autoFocus
            id="dynamic-textarea"
            placeholder={
              isRecording
                ? ''
                : composerMode
                  ? intl.formatMessage(
                      composerMode === 'plan'
                        ? composerMessages.planPlaceholder
                        : composerMessages.goalPlaceholder
                    )
                  : (placeholder ?? intl.formatMessage(composerMessages.messagePlaceholder))
            }
            title={getNavigationShortcutText(intl)}
            aria-label={placeholder}
            value={compactText.editorValue}
            onChange={handleChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            ref={textAreaRef}
            rows={1}
            readOnly={isRecording}
            style={{
              minHeight: `${minTextareaHeight}px`,
              maxHeight: `${maxHeight}px`,
              overflowY: 'auto',
              scrollbarWidth: 'none',
            }}
            className="w-full min-w-0 flex-1 outline-none border-none focus:ring-0 bg-transparent px-2 pt-3 pb-1.5 text-sm resize-none text-text-primary placeholder:text-text-secondary [&::-webkit-scrollbar]:hidden"
          />

          {/* Recording/transcribing status indicator (floats above the bottom bar) */}
          {(isRecording || isTranscribing) && (
            <div className="absolute right-2 -bottom-2 bg-background-primary px-2 py-1 rounded text-xs whitespace-nowrap shadow-md border border-border-primary">
              <span className="flex items-center gap-2">
                {isRecording && (
                  <span className="flex items-center gap-1 text-text-secondary">
                    <span className="inline-block w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                    {intl.formatMessage(i18n.listening)}
                  </span>
                )}
                {isRecording && isTranscribing && <span className="text-text-secondary">•</span>}
                {isTranscribing && (
                  <span className="flex items-center gap-1 text-blue-500">
                    <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                    {intl.formatMessage(i18n.transcribing)}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      </form>

      {/* Move complete control groups together instead of wrapping individual actions. */}
      <div
        ref={bottomBarRef}
        data-compact={isBottomBarNarrow}
        className="group/composer-toolbar relative grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-center gap-x-1 px-1 pt-2 pb-1 @min-[36rem]/composer:gap-x-3"
      >
        <div className="flex min-w-0 max-w-full items-center gap-1">
          <button
            type="button"
            aria-label="添加附件或功能"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-primary hover:bg-background-secondary focus-visible:outline focus-visible:outline-2"
            onClick={() => {
              textAreaRef.current?.focus();
              setMentionPopover({
                isOpen: true,
                isSlashCommand: true,
                addOnly: true,
                query: '',
                mentionStart:
                  compactText.prefix.length + (textAreaRef.current?.selectionStart ?? 0),
                selectedIndex: 0,
              });
            }}
          >
            <Plus size={18} />
          </button>
          <div className="min-w-0 max-w-full">{modelToolbarSlot}</div>
          <AgentSelector
            sessionId={sessionId}
            busy={isLoading}
            openRequest={agentOpenRequest}
            onManage={(create) =>
              setView('custom-agents', {
                resumeSessionId: sessionId ?? undefined,
                ...(create ? { section: 'create' } : {}),
              })
            }
          />

          {/* Left: working directory (leaf folder name only) */}
          {!globalConversation &&
            !hideWorkingDirSwitcher &&
            shouldShowWorkingDirectorySwitcher(Boolean(onWorkingDirChange)) && (
              <DirSwitcher
                className=""
                sessionId={sessionId ?? undefined}
                workingDir={currentWorkingDir}
                onWorkingDirChange={async (newDir) => {
                  await onWorkingDirChange?.(newDir);
                  setWorkingDirOverride(newDir);
                }}
              />
            )}

          <ComposerPlanMode
            sessionId={sessionId}
            busy={isLoading}
            refreshKey={goalRefresh}
            onExit={() => void performSubmit('/plan off', true)}
          />
        </div>

        <div className="flex min-w-0 max-w-full items-center justify-end gap-1">
          <div className="min-w-0">
            <ModelsBottomBar
              sessionId={sessionId}
              openRequest={modelOpenRequest + externalModelOpenRequest}
              dropdownRef={dropdownRef}
              setView={setView}
              sessionModel={effectiveModel}
              sessionProvider={effectiveProvider}
              latestInference={latestInference}
              onModelChanged={setModelOverride}
              sessionLoaded={sessionLoaded}
            />
          </div>
          {/* Right: mic — ghost icon, no background when idle */}
          {!isBottomBarNarrow && dictationProvider && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  shape="round"
                  onClick={() => {
                    if (!isEnabled) return;
                    if (isRecording) {
                      trackVoiceDictation('stop');
                      stopRecording();
                    } else {
                      trackVoiceDictation('start');
                      startRecording();
                    }
                  }}
                  // Keep the button hoverable when only !isEnabled so the
                  // "Dictation not configured" tooltip stays reachable.
                  // We still natively disable while transcribing.
                  disabled={isTranscribing}
                  aria-disabled={!isEnabled}
                  className={cn(
                    'transition-colors',
                    isRecording
                      ? 'text-red-500 hover:text-red-600'
                      : 'text-text-primary/70 hover:text-text-primary',
                    isTranscribing && 'animate-pulse',
                    !isEnabled && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <Microphone size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {intl.formatMessage(
                    !isEnabled
                      ? i18n.dictationNotConfigured
                      : isRecording
                        ? i18n.voiceDictation
                        : i18n.voiceDictationHint
                  )}
                </p>
              </TooltipContent>
            </Tooltip>
          )}

          {actionVisibility.showStop && (
            <ChatInputStopButton label={intl.formatMessage(i18n.stop)} onStop={handleStop} />
          )}
          {actionVisibility.showSend && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    size="sm"
                    shape="round"
                    variant="ghost"
                    disabled={primaryActionDisabled}
                    aria-label={intl.formatMessage(continueAction ? i18n.continueTask : i18n.send)}
                    onClick={continueAction ?? onFormSubmit}
                    className={cn(
                      continueAction ? 'bg-text-primary text-background-primary hover:bg-text-primary/90' : 'bg-background-tertiary',
                      primaryActionDisabled
                        ? 'text-text-secondary cursor-not-allowed opacity-60'
                        : !continueAction && 'text-text-primary hover:bg-background-tertiary/70 hover:cursor-pointer'
                    )}
                  >
                    {continueAction ? <Play className="w-4 h-4" fill="currentColor" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.25} />}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{continueAction ? intl.formatMessage(i18n.continueTask) : getSubmitButtonTooltip()}</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <MentionPopover
          ref={mentionPopoverRef}
          isOpen={mentionPopover.isOpen}
          isSlashCommand={mentionPopover.isSlashCommand}
          addOnly={mentionPopover.addOnly}
          onClose={() => setMentionPopover((prev) => ({ ...prev, isOpen: false }))}
          onSelect={handleMentionItemSelect}
          anchorRef={textAreaRef}
          query={mentionPopover.query}
          selectedIndex={mentionPopover.selectedIndex}
          onSelectedIndexChange={(index) =>
            setMentionPopover((prev) => ({ ...prev, selectedIndex: index }))
          }
          workingDir={currentWorkingDir}
          sessionId={sessionId}
        />
      </div>
    </ChatInputCard>
  );

  const showStats = sessionId && (messages.length > 0 || !!liveSpeed || !!lastSampledSpeed || !!sessionStats?.decodeTokens);
  const generating = chatState === ChatState.Streaming || chatState === ChatState.Thinking;
  return (
    <>
      {messageQueue}
      {inputCard}
      {showStats && <ComposerStats messages={messages} stats={sessionStats}
        liveSpeed={generating ? liveSpeed : null} lastSampledSpeed={generating ? lastSampledSpeed : undefined}>
        <ContextWindowIndicator
          showLabel
          requestBudget={requestBudget?.model === effectiveModel ? requestBudget : undefined}
          totalTokens={totalTokens}
          tokenLimit={tokenLimit}
          usageSource={contextUsageSource}
          capacitySource={capacity?.contextLimit === contextLimit ? contextCapacitySource : undefined}
          alerts={alerts}
        />
      </ComposerStats>}
    </>
  );
}
