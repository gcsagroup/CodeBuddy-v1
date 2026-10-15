import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { AdapterState } from './shared';
import { applyPermissionRequest } from './permissions';

function adapterState(): AdapterState {
  return { messages: [], localSteerTextByMessageId: new Map() };
}

function permissionRequest(meta: unknown): RequestPermissionRequest {
  return {
    sessionId: 'session-1',
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-once-copy', name: 'Allow once copy', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
    ],
    toolCall: {
      toolCallId: 'tool-1',
      title: 'Dangerous tool',
      rawInput: { secret: 'must-not-be-copied-into-context' },
    },
    _meta: meta as RequestPermissionRequest['_meta'],
  };
}

describe('ACP permission adapter', () => {
  it('parses fixed CodePro permission context and deduplicates available actions', () => {
    const state = adapterState();

    applyPermissionRequest(
      state,
      permissionRequest({
        codepro: {
          permissionClass: 'high_risk',
          extensionSource: 'external_http',
          authorizationScope: 'task',
        },
      })
    );

    expect(state.messages[0]?.content[0]).toMatchObject({
      type: 'actionRequired',
      data: {
        permissionClass: 'high_risk',
        extensionSource: 'external_http',
        authorizationScope: 'task',
        availableActions: ['allow_once', 'always_allow', 'deny_once', 'always_deny'],
      },
    });
  });

  it('downgrades malformed or unknown meta instead of guessing low risk', () => {
    const state = adapterState();

    applyPermissionRequest(
      state,
      permissionRequest({
        codepro: {
          permissionClass: 'definitely_safe',
          extensionSource: 42,
          authorizationScope: 'forever',
        },
      })
    );

    expect(state.messages[0]?.content[0]).toMatchObject({
      type: 'actionRequired',
      data: {
        permissionClass: 'legacy',
        extensionSource: 'unknown',
        authorizationScope: 'unknown',
      },
    });
  });

  it('never exposes an allow action for a forbidden host permission', () => {
    const state = adapterState();

    applyPermissionRequest(
      state,
      permissionRequest({
        codepro: {
          permissionClass: 'forbidden',
          extensionSource: 'platform',
          authorizationScope: 'task',
        },
      })
    );

    expect(state.messages[0]?.content[0]).toMatchObject({
      type: 'actionRequired',
      data: {
        permissionClass: 'forbidden',
        availableActions: ['deny_once', 'always_deny'],
      },
    });
  });
});
