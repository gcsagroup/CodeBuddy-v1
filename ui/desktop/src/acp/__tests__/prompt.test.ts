import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types/message';
import { isTurnTerminalRecord } from '../../types/turnTerminal';
import { getAcpClient } from '../acpConnection';
import { acpPromptSession, messageToAcpPromptContent } from '../prompt';

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('messageToAcpPromptContent', () => {
  it('converts text and image content into ACP prompt blocks', () => {
    const message: Message = {
      id: 'message-1',
      role: 'user',
      created: 123,
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', data: 'abc123', mimeType: 'image/png' },
      ],
      metadata: { userVisible: true, agentVisible: true },
    };

    expect(messageToAcpPromptContent(message)).toEqual([
      { type: 'text', text: 'Describe this' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
  });

  it('omits empty text content and unsupported content blocks', () => {
    const message: Message = {
      id: 'message-1',
      role: 'user',
      created: 123,
      content: [
        { type: 'text', text: '   ' },
        {
          type: 'toolResponse',
          id: 'tool-1',
          toolResult: { status: 'success', value: [] },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    } as Message;

    expect(messageToAcpPromptContent(message)).toEqual([]);
  });
});

describe('acpPromptSession', () => {
  it('transports explicit plan and goal selections without rewriting message text', async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    vi.mocked(getAcpClient).mockResolvedValue({ prompt } as never);
    const message: Message = {
      id: 'slash-message',
      role: 'user',
      created: 123,
      content: [{ type: 'text', text: 'Plan the project' }],
      metadata: { userVisible: true, agentVisible: true, planMode: true },
    };
    await acpPromptSession('session-1', message);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({ 'codebuddy/plan': true }),
        prompt: [{ type: 'text', text: 'Plan the project' }],
      })
    );
  });
  it('sends an image-only user message without inventing a text instruction', async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    vi.mocked(getAcpClient).mockResolvedValue({ prompt } as never);
    const image = {
      type: 'image' as const,
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
      mimeType: 'image/png',
    };
    await acpPromptSession('image-session', {
      id: 'image-source',
      role: 'user',
      created: 123,
      content: [image],
      metadata: { userVisible: true, agentVisible: true },
    });
    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'image-session',
      prompt: [image],
      _meta: { 'codeagentpro/source-message-id': 'image-source' },
    });
  });

  it('accepts only complete failed validation terminal evidence', () => {
    const terminal = {
      schema_version: 1,
      session_id: 'session-1',
      run_id: 'run-1',
      terminal_message_id: 'terminal-1',
      source_user_message_id: 'source-user-1',
      status: 'failed',
      checkpoint_id: null,
      retry_strategy: 'retry_failed_validation',
      visible_text_available: true,
      tool_action_count: 2,
      copy_artifact_ref: null,
      finished_at: '2026-08-01T12:00:00Z',
      retry_of_terminal_message_id: null,
      validation_retry: {
        target_path: 'D:\\project\\app.rs',
        command: 'cargo check',
        exit_code: 1,
      },
    };

    expect(isTurnTerminalRecord(terminal)).toBe(true);
    expect(isTurnTerminalRecord({ ...terminal, validation_retry: undefined })).toBe(false);
    expect(
      isTurnTerminalRecord({
        ...terminal,
        validation_retry: { ...terminal.validation_retry, command: '   ' },
      })
    ).toBe(false);
  });

  it('sends a namespaced structured checkpoint retry instead of relying on prompt text', async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    vi.mocked(getAcpClient).mockResolvedValue({ prompt } as never);
    const message: Message = {
      id: 'retry-message',
      role: 'user',
      created: 123,
      content: [{ type: 'text', text: '继续执行' }],
      metadata: { userVisible: true, agentVisible: true },
    };

    await acpPromptSession('session-1', message, {
      schemaVersion: 1,
      strategy: 'continue_checkpoint',
      checkpointId: 'checkpoint-1',
      sourceRunId: 'run-1',
      sourceUserMessageId: 'source-user-1',
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: '继续执行' }],
      _meta: {
        'codeagentpro/source-message-id': 'retry-message',
        'codeagentpro/turn-retry': {
          schemaVersion: 1,
          strategy: 'continue_checkpoint',
          checkpointId: 'checkpoint-1',
          sourceRunId: 'run-1',
          sourceUserMessageId: 'source-user-1',
        },
      },
    });
  });

  it('sends a namespaced linked replay without a checkpoint', async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    vi.mocked(getAcpClient).mockResolvedValue({ prompt } as never);
    const message: Message = {
      id: 'new-run-message',
      role: 'user',
      created: 124,
      content: [{ type: 'text', text: 'Original request' }],
      metadata: { userVisible: true, agentVisible: true },
    };

    await acpPromptSession('session-1', message, {
      schemaVersion: 1,
      strategy: 'replay_user_request',
      checkpointId: null,
      sourceRunId: 'run-1',
      sourceUserMessageId: 'source-user-1',
    } as never);

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'Original request' }],
      _meta: {
        'codeagentpro/source-message-id': 'new-run-message',
        'codeagentpro/turn-retry': {
          schemaVersion: 1,
          strategy: 'replay_user_request',
          checkpointId: null,
          sourceRunId: 'run-1',
          sourceUserMessageId: 'source-user-1',
        },
      },
    });
  });

  it('sends only failed-validation association ids to ACP', async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    vi.mocked(getAcpClient).mockResolvedValue({ prompt } as never);
    const message: Message = {
      id: 'retry-validation-message',
      role: 'user',
      created: 125,
      content: [{ type: 'text', text: '重新运行失败验证' }],
      metadata: { userVisible: true, agentVisible: true },
    };

    await acpPromptSession('session-1', message, {
      schemaVersion: 1,
      strategy: 'retry_failed_validation',
      checkpointId: null,
      sourceRunId: 'run-1',
      sourceUserMessageId: 'source-user-1',
      sourceTerminalMessageId: 'terminal-1',
    } as never);

    const metadata = prompt.mock.calls[0][0]._meta['codeagentpro/turn-retry'];
    expect(metadata).toEqual({
      schemaVersion: 1,
      strategy: 'retry_failed_validation',
      checkpointId: null,
      sourceRunId: 'run-1',
      sourceUserMessageId: 'source-user-1',
      sourceTerminalMessageId: 'terminal-1',
    });
    expect(metadata).not.toHaveProperty('command');
    expect(metadata).not.toHaveProperty('targetPath');
  });
});
