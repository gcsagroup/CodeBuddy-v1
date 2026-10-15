import { describe, expect, it } from 'vitest';
import { getAnyToolConfirmationData, type Message } from './message';

const metadata = { agentVisible: true, userVisible: true };

describe('getAnyToolConfirmationData', () => {
  it('preserves host permission context from action-required messages', () => {
    const message: Message = {
      role: 'assistant',
      created: 1,
      metadata,
      content: [
        {
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'memory-save',
            toolName: 'project_memory_remember',
            arguments: { subject: 'response.style' },
            permissionClass: 'workspace_write',
            extensionSource: 'platform',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          },
        },
      ],
    };

    expect(getAnyToolConfirmationData(message)).toMatchObject({
      permissionClass: 'workspace_write',
      extensionSource: 'platform',
      authorizationScope: 'task',
      availableActions: ['allow_once', 'deny_once'],
    });
  });

  it('does not upgrade legacy confirmation requests with inferred trust metadata', () => {
    const message: Message = {
      role: 'assistant',
      created: 1,
      metadata,
      content: [
        {
          type: 'toolConfirmationRequest',
          id: 'legacy-save',
          toolName: 'project_memory_remember',
          arguments: { subject: 'response.style' },
        },
      ],
    };

    expect(getAnyToolConfirmationData(message)).toEqual({
      id: 'legacy-save',
      toolName: 'project_memory_remember',
      arguments: { subject: 'response.style' },
      prompt: undefined,
    });
  });
});
