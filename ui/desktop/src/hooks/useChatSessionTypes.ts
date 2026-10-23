import type { ChatState } from '../types/chatState';
import type { CompactionLifecycle } from '../types/compactionLifecycle';
import type { TokenState } from '../types/chat';
import type { Message, NotificationEvent, UserInput } from '../types/message';
import type { Session } from '../types/session';
import type { MessageEditType } from '../types/turnTerminal';
import type { CodeProWorkspaceInspection } from '../codepro/projectWorkspace';
import type { CodeProWorkspaceReconfirmationRequest } from '../codepro/resumeCodeProSession';
import type { AcpElicitationRequest } from '../acp/elicitationRequests';
import type { PromptActivity } from '../acp/chatSessionStore';

export interface UseChatSessionParams {
  sessionId: string;
  onStreamFinish: () => void;
  onSessionLoaded?: () => void;
}

export interface MessageSubmissionLifecycle {
  /** Diagnostic timestamp only; never used for admission or cancellation. */
  submittedAtMs?: number;
  onAccepted(): void;
  onRejectedBeforeAcceptance(): void;
  onDeliveryUncertain?(): void;
}

export interface UseChatSessionResult {
  activeRunId?: string | null;
  activeToolCallIds?: string[];
  pendingElicitationRequests?: AcpElicitationRequest[];
  thinkingActivity?: { messageId?: string; receivedAt: number };
  promptActivity?: PromptActivity;
  cancelling?: boolean;
  session?: Session;
  messages: Message[];
  chatState: ChatState;
  progressMessage?: string;
  compactionLifecycle?: CompactionLifecycle;
  updateSession: (updater: (session: Session) => Session) => void;
  handleSubmit: (input: UserInput, lifecycle?: MessageSubmissionLifecycle) => Promise<void>;
  resumeAfterWorkspace: (sourceMessage: Message, sourceRunId: string) => Promise<void>;
  onSteerQueuedMessage?: (input: UserInput) => Promise<boolean>;
  submitElicitationResponse: (
    elicitationId: string,
    userData: Record<string, unknown>,
    action?: 'accept' | 'cancel'
  ) => Promise<boolean>;
  stopStreaming: () => void;
  sessionLoadError?: string;
  workspaceReconfirmation?: CodeProWorkspaceReconfirmationRequest;
  reconfirmCodeProWorkspace: (candidate: CodeProWorkspaceInspection) => Promise<void>;
  promptError?: string;
  clearPromptError: () => void;
  tokenState: TokenState;
  notifications: Map<string, NotificationEvent[]>;
  pauseQueueOnStop: boolean;
  queueProcessingBlocked: boolean;
  canSubmitQueuedMessageWhileLoading: boolean;
  onMessageUpdate: (
    messageId: string,
    newContent: string,
    editType?: MessageEditType
  ) => Promise<void>;
}
