import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { AdapterState } from './shared';
import { applyPermissionRequest } from './permissions';

function adapterState(): AdapterState {
  return { messages: [], localSteerTextByMessageId: new Map() };
}

it.each(['read_only', 'legacy'])('validates web capability metadata with permission class %s', (permissionClass) => {
  const state = adapterState();
  applyPermissionRequest(state, permissionRequest({ codepro: { authorizationScope: 'session', authorizationGroup: 'web_read', permissionClass } }));
  const content = state.messages[0]?.content[0];
  if (content?.type !== 'actionRequired' || content.data.actionType !== 'toolConfirmation') throw Error('Missing approval card');
  expect(content.data.authorizationGroup).toBe(permissionClass === 'read_only' ? 'web_read' : undefined);
});

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
  it.each(['darwin', 'win32'])('accepts the complete native computer scope on %s', (platform) => {
    const tools = ['click', 'drag', 'get_app_state', 'list_apps', 'perform_secondary_action', 'press_key', 'scroll', 'set_value', 'type_text'];
    if (platform === 'win32') tools.unshift('open_path');
    const state = adapterState();
    const request = permissionRequest({ codepro: { authorizationScope: 'session', businessApproval: { id: 'computer-use', tools } } });
    request.options = [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_business_session', name: 'Allow computer use', kind: 'allow_always' },
    ];
    applyPermissionRequest(state, request);
    expect(state.messages[0]?.content[0]).toMatchObject({ data: {
      availableActions: ['allow_once', 'always_allow'],
      businessApproval: { id: 'computer-use', tools },
    } });
  });
  it('keeps business scope separate from the actual tool identity and rejects incomplete scope', () => {
    for (const valid of [true, false]) {
      const state = adapterState();
      const request = permissionRequest({
        codepro: {
          authorizationScope: 'session',
          businessApproval: {
            id: 'computer-use',
            tools: valid ? ['list_apps', 'click'] : ['invented_tool'],
          },
        },
      });
      request.options = [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_business_session', name: 'Allow computer use', kind: 'allow_always' },
      ];
      applyPermissionRequest(state, request);
      const content = state.messages[0]?.content[0];
      expect(content).toMatchObject({
        data: {
          id: 'tool-1',
          toolName: 'Dangerous tool',
          availableActions: valid ? ['allow_once', 'always_allow'] : ['allow_once'],
        },
      });
      if (content.type !== 'actionRequired' || content.data.actionType !== 'toolConfirmation')
        throw new Error('Expected permission request');
      expect(content.data.businessApproval).toEqual(
        valid ? { id: 'computer-use', tools: ['list_apps', 'click'] } : undefined
      );
    }
  });
  it.each([
    ['session', 'mcp_module', { name: 'custom_mcp', displayName: '我的工具' }, true],
    ['global', 'mcp_module', { name: 'custom_mcp', displayName: '我的工具' }, false],
    ['session', 'unknown', { name: 'custom_mcp', displayName: '我的工具' }, false],
    ['session', 'mcp_module', { name: '../bad', displayName: '我的工具' }, false],
    ['session', 'mcp_module', { name: 'custom_mcp', displayName: '' }, false],
    ['session', 'mcp_module', undefined, false],
  ])('validates module scope metadata (%s, %s)', (authorizationScope, authorizationGroup, authorizationModule, valid) => {
    const state = adapterState();
    applyPermissionRequest(state, permissionRequest({ codepro: { authorizationScope, authorizationGroup, authorizationModule } }));
    const content = state.messages[0]?.content[0];
    if (content?.type !== 'actionRequired' || content.data.actionType !== 'toolConfirmation') throw Error('Missing approval card');
    expect(content.data.authorizationModule).toEqual(valid ? authorizationModule : undefined);
    expect(content.data.authorizationGroup).toBe(valid ? 'mcp_module' : undefined);
  });
  it.each([
    ['session', 'computer_control', 'computer_control'],
    ['task', 'computer_control', undefined],
    ['session', 'unknown_group', undefined],
  ])(
    'accepts only the declared session computer group (%s, %s)',
    (authorizationScope, authorizationGroup, expected) => {
      const state = adapterState();
      applyPermissionRequest(
        state,
        permissionRequest({ codepro: { authorizationScope, authorizationGroup } })
      );
      const content = state.messages[0]?.content[0];
      expect(content?.type).toBe('actionRequired');
      if (content?.type === 'actionRequired' && content.data.actionType === 'toolConfirmation')
        expect(content.data.authorizationGroup).toBe(expected);
    }
  );
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
