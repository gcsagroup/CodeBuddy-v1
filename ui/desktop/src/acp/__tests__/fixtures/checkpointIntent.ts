import type { AcpChatSessionSnapshot } from '../../chatSessionStore';
import { ChatState } from '../../../types/chatState';
import type { Message } from '../../../types/message';

export function createCheckpointIntentFixture() {
  const sessionId = 'checkpoint-intent-audit';
  const metadata = { userVisible: true, agentVisible: true };
  const retry = {
    schemaVersion: 1,
    strategy: 'continue_checkpoint',
    checkpointId: 'checkpoint-1',
    sourceRunId: 'run-1',
    sourceUserMessageId: 'source-1',
  };
  const source: Message = {
    id: 'source-1',
    role: 'user',
    created: 1,
    content: [{ type: 'text', text: '修改 app.ts 中的登录校验并运行测试。' }],
    metadata,
  };
  const waiting: Message = {
    id: 'terminal-1',
    role: 'assistant',
    created: 2,
    metadata,
    content: [
      {
        type: 'systemNotification',
        notificationType: 'turnTerminal',
        msg: '请提供验证命令，或明确跳过动态验证。',
        data: {
          schema_version: 1,
          session_id: sessionId,
          run_id: 'run-1',
          terminal_message_id: 'terminal-1',
          source_user_message_id: 'source-1',
          status: 'interrupted',
          checkpoint_id: 'checkpoint-1',
          retry_strategy: 'continue_checkpoint',
          visible_text_available: true,
          tool_action_count: 2,
          copy_artifact_ref: null,
          finished_at: '2026-09-13T00:00:00.000Z',
          report: {
            outcome: 'waiting_for_user',
            classification_counts: {
              confirmed_bug: 0,
              test_failure: 0,
              environment_problem: 1,
              codepro_incomplete: 1,
              unverified: 0,
            },
            changed_files: [],
            verification_summary: [],
            limitations: [],
            recovery_action: 'ask_user',
          },
        },
      },
    ],
  };
  const image = {
    type: 'image' as const,
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=',
  };

  function snapshot(messages: Message[]): AcpChatSessionSnapshot {
    return {
      session: undefined,
      messages,
      tokenState: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        accumulatedInputTokens: 0,
        accumulatedOutputTokens: 0,
        accumulatedTotalTokens: 0,
      },
      notifications: [],
      progressMessage: undefined,
      chatState: ChatState.Idle,
      sessionLoadError: undefined,
      promptError: undefined,
      activePromptAttemptId: null,
      activeRunId: null,
      pendingCancelPromptAttemptId: null,
    };
  }

  const secondImage = {
    type: 'image' as const,
    mimeType: 'image/gif',
    data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  };
  return {
    sessionId,
    metadata,
    retry,
    source,
    waiting,
    image,
    images: [image, secondImage],
    snapshot,
  };
}
