import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acpChatSessionController } from '../chatSessionController';
import { acpChatSessionActions, acpChatSessionStore } from '../chatSessionStore';
import { getTurnTerminalRecord } from '../../types/turnTerminal';
import type { Message } from '../../types/message';
import { createCheckpointIntentFixture } from './fixtures/checkpointIntent';

const { transportPrompt } = vi.hoisted(() => ({ transportPrompt: vi.fn() }));

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn(async () => ({ prompt: transportPrompt })),
  isAcpRecovering: vi.fn(() => false),
}));
vi.mock('../../utils/extensionErrorUtils', () => ({ showExtensionLoadResults: vi.fn() }));
vi.mock('../chatSessionStore', () => ({
  subscribeToAcpChatSession: vi.fn(() => () => undefined),
  acpChatSessionStore: { getSnapshot: vi.fn() },
  acpChatSessionActions: {
    startPromptAttempt: vi.fn(),
    finishPromptAttemptIfCurrent: vi.fn(() => true),
    clearPromptCancellation: vi.fn(() => false),
  },
}));
vi.mock('../sessions', () => ({
  acpForkSession: vi.fn(),
  acpLoadSession: vi.fn(),
  acpNewSession: vi.fn(),
  acpTruncateSessionConversation: vi.fn(),
  isAcpSessionLoadInFlight: vi.fn(),
  sessionInfoToSession: vi.fn(),
}));
vi.mock('../../codepro/resumeCodeProSession', () => ({
  CodeProWorkspaceReconfirmationRequiredError: class extends Error {},
  resumeCodeProSession: vi.fn(),
}));
vi.mock('../workspaceLease', () => ({
  acquireWorkspaceLease: vi.fn(),
  releaseWorkspaceLease: vi.fn(),
}));
vi.mock('../elicitationRequests', () => ({
  cancelAcpElicitationRequestsForSession: vi.fn(),
}));
vi.mock('../permissionRequests', () => ({
  cancelAcpPermissionRequestsForSession: vi.fn(),
}));

const { sessionId, metadata, source, waiting, image, images, snapshot } =
  createCheckpointIntentFixture();

async function submit(text: string, options: { images?: typeof images; history?: Message[] } = {}) {
  const reply: Message = {
    id: 'reply-1',
    role: 'user',
    created: 3,
    metadata,
    content: [...(text ? [{ type: 'text' as const, text }] : []), ...(options.images ?? [])],
  };
  const current = snapshot([...(options.history ?? [source, waiting]), reply]);
  vi.mocked(acpChatSessionStore.getSnapshot).mockReturnValue(current);
  await acpChatSessionController.submitMessage(sessionId, reply, {
    getCurrentSnapshot: () => current,
    onFinish: vi.fn(),
  });
  expect(transportPrompt).toHaveBeenCalledOnce();
  const request = transportPrompt.mock.calls[0][0];
  expect(request._meta['codeagentpro/source-message-id']).toBe(reply.id);
  expect(request.prompt).toEqual(reply.content);
  return request;
}

describe('ask_user checkpoint input routing: production controller through ACP serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transportPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  });

  it('uses an authoritative terminal fixture accepted by the production parser', () => {
    expect(getTurnTerminalRecord(waiting)).toMatchObject({
      checkpoint_id: 'checkpoint-1',
      report: { recovery_action: 'ask_user' },
    });
  });

  it.each(['继续', '验证命令是 pnpm test -- app.test.ts', '跳过该命令，只做静态分析。'])(
    'preserves existing legitimate checkpoint reply: %s',
    async (text) => {
      const request = await submit(text);
      expect(request._meta['codeagentpro/turn-retry']).toBeUndefined();
      expect(request._meta['codeagentpro/checkpoint-context']).toEqual({
        schemaVersion: 1,
        checkpointId: 'checkpoint-1',
        sourceRunId: 'run-1',
        sourceUserMessageId: 'source-1',
        sourceTerminalMessageId: 'terminal-1',
      });
      expect(request.prompt).toEqual([{ type: 'text', text }]);
    }
  );

  it.each([
    '先别改，只分析app.ts',
    '取消当前任务',
    '停止',
    '不要继续了',
    '改做一个新任务：只解释 README 的安装步骤',
    '解释“继续”是什么意思',
  ])('does not manufacture checkpoint continuation for changed intent: %s', async (text) => {
    const request = await submit(text);
    expect(request.prompt).toEqual([{ type: 'text', text }]);
    expect(request._meta['codeagentpro/source-message-id']).toBe('reply-1');
    expect(request._meta['codeagentpro/turn-retry']).toBeUndefined();
  });

  it('does not treat an image-only new input as unconditional approval to resume', async () => {
    const request = await submit('', { images: [image] });
    expect(request.prompt).toEqual([image]);
    expect(request._meta['codeagentpro/turn-retry']).toBeUndefined();
  });

  it('preserves a new goal and ordered images without forcing the previous change workflow', async () => {
    const text = '只解释这张截图，不要继续之前的修改。';
    const request = await submit(text, { images });
    expect(request.prompt).toEqual([{ type: 'text', text }, ...images]);
    expect(request._meta['codeagentpro/turn-retry']).toBeUndefined();
  });

  it('records that relevant ordered screenshots are preserved even though intent has not been reclassified', async () => {
    const text = '这是你刚才要的错误截图。';
    const request = await submit(text, { images });
    expect(request.prompt).toEqual([{ type: 'text', text }, ...images]);
  });

  it('does not reuse a checkpoint across an intervening user turn', async () => {
    const intervening: Message = {
      ...source,
      id: 'already-replied',
      content: [{ type: 'text', text: '已回答过一次' }],
    };
    const request = await submit('继续', { history: [source, waiting, intervening] });
    expect(request._meta['codeagentpro/turn-retry']).toBeUndefined();
    expect(acpChatSessionActions.startPromptAttempt).toHaveBeenCalledOnce();
    expect(request._meta['codeagentpro/checkpoint-context']).toBeUndefined();
  });
});
