import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createNextChatExtensionDraft,
  type NextChatExtensionDraft,
} from '../../utils/nextChatExtensions';
import { useLocation, useNavigate } from 'react-router-dom';
import ChatInput from '../ChatInput';
import { CodeBuddyMark } from '../CodeBuddyMark';
import './welcome-orbit.css';
import { DirSwitcher } from '../bottom_menu/DirSwitcher';
import { useConfig } from '../ConfigContext';
import { AppEvents } from '../../constants/events';
import { ChatState } from '../../types/chatState';
import { createUserMessage, type Message, type UserInput } from '../../types/message';
import UserMessage from '../UserMessage';
import type { MessageSubmissionLifecycle } from '../../hooks/useChatSessionTypes';
import { useNavigation } from '../../hooks/useNavigation';
import { defineMessages, useIntl } from '../../i18n';
import { isFilesystemRoot, type CodeProWorkspaceInspection } from '../../codepro/projectWorkspace';
import { startCodeProSession } from '../../codepro/startCodeProSession';
import { CodeProRollbackError } from '../../codepro/failureSemantics';
import { createSession } from '../../sessions';
import type { MessageDescriptor } from 'react-intl';
import { recordCommonTaskSessionStarted } from '../../acp/capabilityUsage';
import { PermissionPicker, useInitialPermissionPreset } from '../SessionPermissionSummary';
import { readNewTaskDraft, updateNewTaskDraft, clearNewTaskDraft } from '../../utils/newTaskDraft';

type CodeProSetupMessageKey =
  | 'workspaceInspectionFailed'
  | 'rootContainerStartFailed'
  | 'leaseBackedStartFailed'
  | 'chooseProjectFolder'
  | 'directoryChooserFailed'
  | 'workspaceIdentityUnavailable'
  | 'workspacePermissionDenied';

const SAFE_CODEPRO_SETUP_DIAGNOSTICS: Record<string, CodeProSetupMessageKey> = {
  workspace_identity_unavailable: 'workspaceIdentityUnavailable',
  workspace_permission_denied: 'workspacePermissionDenied',
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function safeCodeProSetupError(
  reason: unknown,
  fallback: CodeProSetupMessageKey
): CodeProSetupMessageKey {
  const error = objectRecord(reason);
  if (!error) return fallback;
  const envelope = 'error' in error ? objectRecord(error.error) : error;
  const data = objectRecord(envelope?.data);
  const code = typeof data?.code === 'string' ? data.code : null;
  return code && Object.prototype.hasOwnProperty.call(SAFE_CODEPRO_SETUP_DIAGNOSTICS, code)
    ? SAFE_CODEPRO_SETUP_DIAGNOSTICS[code]
    : fallback;
}

export interface CodeProLaunchIntent {
  workingDir?: string;
  initialMessage?: UserInput;
  recipeDeeplink?: string;
  recipeId?: string;
  noAutoSubmit?: boolean;
  draftOnly?: boolean;
}

interface PendingCodeProStart {
  workspaceOrigin: 'default' | 'selected';
  intent: CodeProLaunchIntent;
  candidates: CodeProWorkspaceInspection[];
}

const i18n = defineMessages({
  creatingChat: { id: 'codeProHub.creatingChat', defaultMessage: 'Creating chat' },
  title: { id: 'baseChat.mainWelcome', defaultMessage: "I'm CodeBuddy. Let's work together." },
  introduction: { id: 'baseChat.mainIntroduction', defaultMessage: 'I can help you understand code, work with documents and data, and carry a task through to checked results. Tell me what you want to get done.' },
  code: { id: 'baseChat.mainCode', defaultMessage: 'Write and debug code' },
  data: { id: 'baseChat.mainData', defaultMessage: 'Organize documents and data' },
  tasks: { id: 'baseChat.mainTasks', defaultMessage: 'Plan, execute and check' },
  capabilities: { id: 'codeProHub.capabilities', defaultMessage: 'CodePro capabilities' },
  taskBreakdown: { id: 'codeProHub.taskBreakdown', defaultMessage: 'Automatic task breakdown' },
  modelCollaboration: {
    id: 'codeProHub.modelCollaboration',
    defaultMessage: 'Multi-model collaboration',
  },
  activityTrail: {
    id: 'codeProHub.activityTrail',
    defaultMessage: 'Edit in place with a complete activity trail',
  },
  workspaceInspectionFailed: {
    id: 'codeProHub.workspaceInspectionFailed',
    defaultMessage: 'Unable to inspect the project workspace.',
  },
  rootContainerStartFailed: {
    id: 'codeProHub.rootContainerStartFailed',
    defaultMessage: 'Unable to start CodePro with the root container.',
  },
  leaseBackedStartFailed: {
    id: 'codeProHub.leaseBackedStartFailed',
    defaultMessage: 'Unable to start CodePro in the selected workspace.',
  },
  chooseProjectFolder: {
    id: 'codeProHub.chooseProjectFolder',
    defaultMessage: 'Choose a project folder to continue',
  },
  directoryChooserFailed: {
    id: 'codeProHub.directoryChooserFailed',
    defaultMessage: 'Unable to choose a project folder. Try again.',
  },
  workspaceIdentityUnavailable: {
    id: 'codeProHub.workspaceIdentityUnavailable',
    defaultMessage:
      'The selected workspace could not be safely verified. Choose a supported local project folder and try again.',
  },
  workspacePermissionDenied: {
    id: 'codeProHub.workspacePermissionDenied',
    defaultMessage: 'Workspace access was denied. Check folder permissions and try again.',
  },
  retryWorkspaceSetup: {
    id: 'codeProHub.retryWorkspaceSetup',
    defaultMessage: 'Retry workspace setup',
  },
  goalPlaceholder: {
    id: 'codeProHub.goalPlaceholder',
    defaultMessage: 'Describe your task, / for commands, @ for files or conversations…',
  },
});

const setupMessages: Record<CodeProSetupMessageKey, MessageDescriptor> = {
  workspaceInspectionFailed: i18n.workspaceInspectionFailed,
  rootContainerStartFailed: i18n.rootContainerStartFailed,
  leaseBackedStartFailed: i18n.leaseBackedStartFailed,
  chooseProjectFolder: i18n.chooseProjectFolder,
  directoryChooserFailed: i18n.directoryChooserFailed,
  workspaceIdentityUnavailable: i18n.workspaceIdentityUnavailable,
  workspacePermissionDenied: i18n.workspacePermissionDenied,
};

export function CodeProHub({ launchIntent }: { launchIntent?: CodeProLaunchIntent }) {
  const intl = useIntl();
  const navigate = useNavigate();
  const location = useLocation();
  const setView = useNavigation();
  const { extensionsList } = useConfig();
  const [initialPermissionPreset, setInitialPermissionPreset] = useInitialPermissionPreset();
  const [extensionDraft, setExtensionDraft] = useState<NextChatExtensionDraft>();
  const draftForMenu = extensionDraft ?? createNextChatExtensionDraft(extensionsList);
  const sessionExtensions = useMemo(
    () =>
      extensionDraft
        ? extensionsList.map((extension) => ({
            ...extension,
            enabled: extensionDraft.selectedNames.has(extension.name),
          }))
        : extensionsList,
    [extensionsList, extensionDraft]
  );
  // Keep an explicit folder choice separate from the host process directory and prior chats.
  // When absent, the host allocates a fresh workspace for this conversation.
  const [workingDir, setWorkingDir] = useState(
    () => launchIntent?.workingDir ?? readNewTaskDraft('codepro').workingDir ?? ''
  );
  const [permissionOpenRequest, setPermissionOpenRequest] = useState(0);
  const [rootContainer, setRootContainer] = useState<string | null>(null);
  useEffect(() => {
    updateNewTaskDraft('codepro', { workingDir: workingDir || rootContainer || '' });
  }, [workingDir, rootContainer]);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [setupError, setSetupError] = useState<CodeProSetupMessageKey | null>(null);
  const [draftMessage, setDraftMessage] = useState(launchIntent?.initialMessage?.msg ?? '');
  const [pendingMessage, setPendingMessage] = useState<Message>();
  useEffect(() => {
    setPendingMessage(undefined);
  }, [location.key]);
  const [pendingStart, setPendingStart] = useState<PendingCodeProStart | null>(null);
  const [retryIntent, setRetryIntent] = useState<CodeProLaunchIntent | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launchConsumedRef = useRef(false);
  const inspectingRef = useRef(false);
  const submissionLifecycleRef = useRef<MessageSubmissionLifecycle | undefined>(undefined);

  const openSession = useCallback(
    (session: Awaited<ReturnType<typeof createSession>>, intent: CodeProLaunchIntent) => {
      const recipePrompt = session.recipe?.prompt;
      const initialMessage =
        intent.initialMessage ??
        (recipePrompt?.trim() ? { msg: recipePrompt, images: [] } : undefined);
      submissionLifecycleRef.current?.onAccepted();
      clearNewTaskDraft('codepro');
      // A user can return home before the conversation route finishes rendering.
      // Do not leave that still-mounted composer locked in the creation state.
      setIsCreating(false);
      setDraftMessage('');
      // Keep the sent-message preview until navigation commits. React Router
      // can defer that render after the creation state has already settled.
      submissionLifecycleRef.current = undefined;
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED, { detail: { session } }));
      window.dispatchEvent(
        new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
          detail: {
            sessionId: session.id,
            ...(initialMessage ? { initialMessage } : {}),
            ...(intent.noAutoSubmit !== undefined ? { noAutoSubmit: intent.noAutoSubmit } : {}),
            workspaceMode: 'codepro',
          },
        })
      );
      navigate(`/codepro/pair?resumeSessionId=${encodeURIComponent(session.id)}`, {
        state: {
          ...(initialMessage ? { initialMessage } : {}),
          ...(intent.noAutoSubmit !== undefined ? { noAutoSubmit: intent.noAutoSubmit } : {}),
        },
      });
    },
    [navigate]
  );

  const handleWorkingDirChange = useCallback((directory: string) => {
    if (isFilesystemRoot(directory)) {
      setRootContainer(directory);
      setWorkingDir('');
      return;
    }
    setRootContainer(null);
    setWorkingDir(directory);
  }, []);

  const inspectAndStage = useCallback(
    async (intent: CodeProLaunchIntent) => {
      if (isCreating || inspectingRef.current) return;
      inspectingRef.current = true;
      const initialMessage = intent.initialMessage ?? { msg: '', images: [] };
      if (!intent.noAutoSubmit && (initialMessage.msg.trim() || initialMessage.images.length)) {
        const preview = createUserMessage(initialMessage.msg, initialMessage.images);
        setPendingMessage(preview);
      }
      setDraftMessage(initialMessage.msg);
      setIsInspecting(true);
      setSetupError(null);
      setRetryIntent(null);
      try {
        if (!intent.noAutoSubmit && (initialMessage.msg.trim() || initialMessage.images.length) &&
            !await window.electron.requestNetworkAccess()) {
          submissionLifecycleRef.current?.onRejectedBeforeAcceptance();
          setPendingMessage(undefined);
          submissionLifecycleRef.current = undefined;
          return;
        }
        const explicitWorkingDir = workingDir || rootContainer;
        const selectedWorkingDir =
          explicitWorkingDir || (await window.electron.defaultCodeProWorkspacePath());
        const candidates = await window.electron.inspectCodeProWorkspace({
          // The directory chosen at chat creation is the stable project grouping. Paths in the
          // message are execution targets and must not silently reclassify the conversation.
          prompt: '',
          selectedWorkingDir,
        });
        if (candidates.length === 0) {
          throw new Error('No usable project workspace was found');
        }
        if (
          !explicitWorkingDir &&
          (candidates.find((candidate) => candidate.source === 'selected') ?? candidates[0])
            .state !== 'missing'
        ) {
          throw new Error('The allocated workspace is not empty');
        }
        setPendingStart({
          intent,
          candidates,
          workspaceOrigin: explicitWorkingDir ? 'selected' : 'default',
        });
      } catch (error) {
        submissionLifecycleRef.current?.onRejectedBeforeAcceptance();
        setPendingMessage(undefined);
        submissionLifecycleRef.current = undefined;
        setRetryIntent(intent);
        setSetupError(safeCodeProSetupError(error, 'workspaceInspectionFailed'));
        throw error;
      } finally {
        inspectingRef.current = false;
        setIsInspecting(false);
      }
    },
    [isCreating, rootContainer, workingDir]
  );

  useEffect(() => {
    if (!launchIntent || launchConsumedRef.current) return;
    launchConsumedRef.current = true;
    // Draft-only entry points must not allocate a conversation before Send.
    if (launchIntent.draftOnly) return;
    void inspectAndStage(launchIntent).catch(() => {});
  }, [inspectAndStage, launchIntent]);

  const handleSubmit = async (input: UserInput, lifecycle?: MessageSubmissionLifecycle) => {
    const { msg, images } = input;
    if (
      isCreating ||
      inspectingRef.current ||
      pendingStart ||
      (!msg.trim() && images.length === 0)
    ) {
      lifecycle?.onRejectedBeforeAcceptance();
      return;
    }
    submissionLifecycleRef.current = lifecycle;
    await inspectAndStage({ initialMessage: input });
  };

  const handleWorkspaceConfirm = useCallback(
    async (pending: PendingCodeProStart, candidate: CodeProWorkspaceInspection) => {
      if (isCreating) return;
      if (candidate.state === 'filesystem-root') {
        setIsCreating(true);
        setSetupError(null);
        try {
          const session = await createSession(candidate.normalizedPath, {
            allExtensions: sessionExtensions,
            workspaceMode: 'codepro',
            initialPermissionPreset,
            workspaceBinding: 'root_container',
            workspaceOrigin: 'selected',
            rootContainerPath: candidate.normalizedPath,
            ...(pending.intent.recipeDeeplink
              ? { recipeDeeplink: pending.intent.recipeDeeplink }
              : {}),
            ...(pending.intent.recipeId ? { recipeId: pending.intent.recipeId } : {}),
          });
          if (pending.intent.recipeId) {
            void recordCommonTaskSessionStarted(pending.intent.recipeId, session.id);
          }
          openSession(session, pending.intent);
        } catch (error) {
          submissionLifecycleRef.current?.onRejectedBeforeAcceptance();
          setPendingMessage(undefined);
          submissionLifecycleRef.current = undefined;
          setRetryIntent(pending.intent);
          setSetupError(safeCodeProSetupError(error, 'rootContainerStartFailed'));
          setIsCreating(false);
        }
        return;
      }
      setIsCreating(true);
      setSetupError(null);
      try {
        const { session } = await startCodeProSession({
          initialPermissionPreset,
          workspaceOrigin: pending.workspaceOrigin,
          candidate,
          initialMessage: pending.intent.initialMessage ?? { msg: '', images: [] },
          allExtensions: sessionExtensions,
          recipeDeeplink: pending.intent.recipeDeeplink,
          recipeId: pending.intent.recipeId,
        });
        if (pending.intent.recipeId) {
          void recordCommonTaskSessionStarted(pending.intent.recipeId, session.id);
        }
        openSession(session, pending.intent);
      } catch (error) {
        submissionLifecycleRef.current?.onRejectedBeforeAcceptance();
        setPendingMessage(undefined);
        submissionLifecycleRef.current = undefined;
        console.error(
          'CodePro workspace start failed',
          error,
          error instanceof CodeProRollbackError
            ? error.errors.map((cause) =>
                cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
              )
            : []
        );
        setRetryIntent(pending.intent);
        setSetupError(safeCodeProSetupError(error, 'leaseBackedStartFailed'));
        setIsCreating(false);
      }
    },
    [sessionExtensions, isCreating, openSession, initialPermissionPreset]
  );

  useEffect(() => {
    if (!pendingStart || isCreating) return;
    const staged = pendingStart;
    const candidate =
      staged.candidates.find((item) => item.source === 'selected') ?? staged.candidates[0];
    if (!candidate) {
      setPendingStart(null);
      setRetryIntent(staged.intent);
      setSetupError('workspaceInspectionFailed');
      return;
    }
    setPendingStart(null);
    void handleWorkspaceConfirm(staged, candidate);
  }, [handleWorkspaceConfirm, pendingStart, isCreating]);

  const showPendingMessage = Boolean(pendingMessage);
  const inputBlocked = isInspecting || isCreating || pendingStart !== null || showPendingMessage;

  return (
    <main
      className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-4 sm:px-6 sm:pb-6"
      aria-label={showPendingMessage ? intl.formatMessage(i18n.title) : undefined}
      aria-labelledby={showPendingMessage ? undefined : "codepro-title"}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        {showPendingMessage && pendingMessage && (
          <div className="flex-1">
            <UserMessage message={pendingMessage} readOnly />
            <p role="status" className="mt-6 text-sm text-text-secondary">
              <span className="chat-creation-shimmer">{intl.formatMessage(i18n.creatingChat)}</span>
            </p>
          </div>
        )}
        <div hidden={showPendingMessage} className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center py-8 hidden:hidden">
          <div className="welcome-heading">
            <div className="welcome-orbit" aria-hidden="true">
              <span className="welcome-orbit-glow" />
              <svg className="welcome-orbit-rings" viewBox="0 0 80 80" fill="none">
                <g className="welcome-orbit-track">
                  <ellipse cx="40" cy="40" rx="34" ry="22" stroke="#8cb4ff" strokeOpacity=".6" strokeWidth=".7" />
                  <circle cx="74" cy="40" r="2.6" fill="#9ccaff" />
                </g>
                <g className="welcome-orbit-track welcome-orbit-track-secondary">
                  <ellipse cx="40" cy="40" rx="23" ry="35" stroke="#bea2ff" strokeOpacity=".5" strokeWidth=".7" />
                  <circle cx="40" cy="5" r="2" fill="#b9a0ff" />
                </g>
              </svg>
              <CodeBuddyMark className="welcome-orbit-mark" />
            </div>
            <h1 id="codepro-title" className="text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
              {intl.formatMessage(i18n.title)}
            </h1>
          </div>
          <p className="welcome-copy mt-3 max-w-xl text-base leading-7 text-text-secondary">
            {intl.formatMessage(i18n.introduction)}
          </p>
          <ul className="welcome-copy mt-7 flex flex-wrap gap-2 text-sm text-text-secondary">
            {[i18n.code, i18n.data, i18n.tasks].map(message => (
              <li key={message.id} className="rounded-full border border-border-primary/70 bg-background-secondary/60 px-3 py-1.5">
                {intl.formatMessage(message)}
              </li>
            ))}
          </ul>
        </div>


        <fieldset
          disabled={inputBlocked}
          className="mx-2 -mb-2 flex min-w-0 items-center rounded-t-2xl border border-b-0 border-border-primary/60 bg-background-secondary px-2 pt-1 pb-3"
        >
          <DirSwitcher
            allowClear
            className=""
            sessionId={undefined}
            workingDir={workingDir || rootContainer || ''}
            onWorkingDirChange={handleWorkingDirChange}
          />
        </fieldset>

        <fieldset
          disabled={inputBlocked}
          aria-busy={isInspecting || isCreating}
          className="min-w-0"
          onDragOverCapture={(event) => {
            if (!inputBlocked) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onDropCapture={(event) => {
            if (!inputBlocked) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <ChatInput
            creationStatus={showPendingMessage ? intl.formatMessage(i18n.creatingChat) : undefined}
            submissionDisabled={inputBlocked}
            onOpenPermissions={() => setPermissionOpenRequest((value) => value + 1)}
            placeholder={intl.formatMessage(i18n.goalPlaceholder)}
            modelToolbarSlot={
              <PermissionPicker
                openRequest={permissionOpenRequest}
                inline
                draft
                mode={initialPermissionPreset}
                onModeChange={setInitialPermissionPreset}
                workingDirectory={workingDir || rootContainer || ''}
              />
            }
            sessionId={null}
            handleSubmit={handleSubmit}
            nextChatExtensionDraft={draftForMenu}
            onNextChatExtensionDraftChange={setExtensionDraft}
            chatState={ChatState.Idle}
            onStop={() => {}}
            initialValue={draftMessage}
            newTaskDraftKey="codepro"
            setView={setView}
            totalTokens={0}
            accumulatedInputTokens={0}
            accumulatedOutputTokens={0}
            droppedFiles={[]}
            onFilesProcessed={() => {}}
            messages={[]}
            disableAnimation={false}
            onWorkingDirChange={handleWorkingDirChange}
            hideWorkingDirSwitcher
            workingDir={workingDir || rootContainer || ''}
            inputRef={inputRef}
          />
        </fieldset>
        {setupError && (
          <div className="px-4 pb-3 text-sm text-text-primary">
            <p role="alert">{intl.formatMessage(setupMessages[setupError])}</p>
            {retryIntent && (
              <button
                type="button"
                className="mt-2 rounded bg-background-primary px-3 py-2"
                disabled={isInspecting}
                onClick={() => {
                  void inspectAndStage(retryIntent).catch(() => {});
                }}
              >
                {intl.formatMessage(i18n.retryWorkspaceSetup)}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
