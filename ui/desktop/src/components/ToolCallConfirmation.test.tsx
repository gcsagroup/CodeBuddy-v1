import { render, screen } from '@testing-library/react';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPermissionRequest } from '../acp/adapter/permissions';
import type { AdapterState } from '../acp/adapter/shared';
import { IntlTestWrapper } from '../i18n/test-utils';
import ToolConfirmation, { ToolApprovalTarget } from './ToolCallConfirmation';
import {
  cancelAcpPermissionRequestsForSession,
  requestAcpPermission,
} from '../acp/permissionRequests';

afterEach(() => {
  for (const sessionId of ['session-memory', 'session-invalid-memory'])
    cancelAcpPermissionRequestsForSession(sessionId);
});

it.each([
  ['open', 'Open page'],
  ['observe', 'Read page'],
  ['click', 'Click page element'],
  ['type', 'Enter text on page'],
  ['key', 'Send key to page'],
  ['screenshot', 'Capture page'],
  ['console', 'Read page console'],
  ['close', 'Close page'],
])('shows the actual browser action and target before approving %s', (operation, label) => {
  render(
    <ToolApprovalTarget
      toolName="browser_control"
      argumentsValue={{
        operation,
        url: 'https://example.com/文档?q=1&x=2',
        id: 'test-tab',
        node: 7,
        text: '<button>fixture text</button>',
        key: 'Enter',
        token: 'must-not-appear',
      }}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByRole('heading', { name: label })).toBeVisible();
  expect(
    screen.getByText(`https://example.com${new URL('https://example.com/文档').pathname}`)
  ).toBeVisible();
  expect(screen.getByText('Tab test-tab')).toBeVisible();
  expect(screen.getByText('Element 7')).toBeVisible();
  expect(screen.queryByText('must-not-appear')).not.toBeInTheDocument();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.queryByText('<button>fixture text</button>') !== null).toBe(operation === 'type');
  expect(screen.queryByText('Enter') !== null).toBe(operation === 'key');
});

it('reports a missing browser target without repairing malformed model arguments', () => {
  render(
    <ToolApprovalTarget
      toolName="browser_control"
      argumentsValue={{
        operation: 'observe',
        'id\\"': 'a malformed field is not a tab id',
      }}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByText('Target not provided')).toBeVisible();
  expect(screen.queryByText('a malformed field is not a tab id')).not.toBeInTheDocument();
});

function pendingMemoryPermission(sessionId: string, toolCallId: string) {
  void requestAcpPermission({
    sessionId,
    toolCall: { toolCallId, title: 'project_memory_remember', rawInput: {} },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'deny_once', name: 'Deny once', kind: 'reject_once' },
    ],
  });
}

function renderPermissionRequest(request: RequestPermissionRequest) {
  const state: AdapterState = { messages: [], localSteerTextByMessageId: new Map() };
  applyPermissionRequest(state, request);
  const content = state.messages[0]?.content[0];
  if (content?.type !== 'actionRequired') {
    throw new Error('expected an action-required permission message');
  }
  render(
    <ToolConfirmation
      sessionId={request.sessionId}
      isClicked={false}
      actionRequiredContent={content}
    />,
    { wrapper: IntlTestWrapper }
  );
}

describe('ToolConfirmation', () => {
  it('shows desktop-wide CU scope and retains the concrete tool call', () => {
    renderPermissionRequest({
      sessionId: 'business-scope',
      toolCall: { toolCallId: 'cu-list', title: 'mcp__qwen_computer__list_apps', rawInput: {} },
      options: [
        { optionId: 'allow_business_session', name: 'Allow computer use', kind: 'allow_always' },
      ],
      _meta: {
        codepro: {
          authorizationScope: 'session',
          extensionSource: 'builtin',
          permissionClass: 'external_write',
          businessApproval: { id: 'computer-use', tools: ['list_apps', 'click'] },
        },
      },
    });
    expect(screen.getByText('computer use')).toBeVisible();
    expect(
      screen.getByText(/current desktop, rather than a single application or read-only access/)
    ).toBeVisible();
    expect(
      screen.getByText(
        /Existing safety checks, disabled tools and per-call confirmation rules still apply/
      )
    ).toBeVisible();
    expect(screen.getByText('Included operations')).toBeVisible();
  });

  it.each(['image-generation', 'video-generation'] as const)(
    'shows actual service, workspace and output for %s',
    (id) => {
      const output = id === 'image-generation' ? 'generated-images' : 'generated-videos';
      renderPermissionRequest({
        sessionId: id,
        toolCall: {
          toolCallId: id,
          title: id === 'image-generation' ? 'generate_image' : 'generate_video',
          rawInput: {},
        },
        options: [
          { optionId: 'allow_business_session', name: 'Allow media', kind: 'allow_always' },
        ],
        _meta: {
          codepro: {
            authorizationScope: 'session',
            businessApproval: {
              id,
              service: 'http://fixture.test:8188',
              workspace: 'C:\\fixture',
              outputDirectory: `C:\\fixture\\${output}`,
            },
          },
        },
      });
      expect(screen.getByText('http://fixture.test:8188')).toBeVisible();
      expect(screen.getByText('C:\\fixture')).toBeVisible();
      expect(screen.getByText(`C:\\fixture\\${output}`)).toBeVisible();
      expect(screen.getByText(/upload PNG references from this workspace/)).toBeVisible();
      expect(screen.getByText(/includes later generations and changed parameters/)).toBeVisible();
    }
  );
  it('uses the same computer operation label in approval without changing its policy facts', () => {
    render(
      <ToolConfirmation
        sessionId="friendly-computer"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'friendly-computer-approval',
            toolName: 'mcp__qwen_computer__perform_secondary_action',
            arguments: { action: 'Invoke' },
            permissionClass: 'external_write',
            extensionSource: 'external_stdio',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(
      screen.getByText('CodeBuddy would like to call Interact with a window control. Allow?')
    ).toBeVisible();
    expect(screen.getByText('Extension action (confirmation required)')).toBeVisible();
    expect(screen.queryByText(/qwen_computer|secondary_action/)).not.toBeInTheDocument();
  });

  it.each(['path', 'htmlPath'])('shows the local browser preview target from %s', (field) => {
    renderPermissionRequest({
      sessionId: 'session-browser-local',
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      toolCall: {
        toolCallId: 'local-preview',
        title: 'browser_control',
        rawInput: { operation: 'open', [field]: 'reports/orders.html' },
      },
    });
    expect(screen.getByText('reports/orders.html')).toBeInTheDocument();
  });
  it('explains a browser approval without disclosing URL credentials or form values', () => {
    renderPermissionRequest({
      sessionId: 'session-browser',
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      toolCall: {
        toolCallId: 'browser-approval',
        title: 'browser_control',
        rawInput: {
          operation: 'open',
          url: 'https://name:secret@example.com/form?token=private#secret',
          text: 'private-form-value',
        },
      },
    });
    expect(screen.getByRole('heading', { name: 'Open page' })).toBeInTheDocument();
    expect(screen.getByText('https://example.com/form')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret');
    expect(document.body.textContent).not.toContain('private');
  });

  it('discloses the actual workspace covered by a durable task-level file grant', () => {
    renderPermissionRequest({
      sessionId: 'session-task-grant',
      options: [
        { optionId: 'allow_always', name: 'Allow for this task', kind: 'allow_always' },
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      ],
      toolCall: {
        toolCallId: 'approval-task-grant',
        title: 'Write',
        rawInput: { path: 'src/app.js' },
      },
      _meta: {
        codepro: {
          permissionClass: 'workspace_write',
          extensionSource: 'platform',
          authorizationScope: 'task',
          taskWorkspaceRoot: 'C:\\project',
        },
      } as RequestPermissionRequest['_meta'],
    });

    const scope = screen.getByTestId('task-workspace-grant-scope');
    expect(scope).toHaveTextContent('C:\\project');
    expect(scope).toHaveTextContent('Shell commands');
    expect(screen.getByText('src/app.js')).toBeInTheDocument();
  });

  it('describes conservative external-tool approval without claiming a read request writes files', () => {
    render(
      <ToolConfirmation
        sessionId="session-external-read"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'external-read-card',
            toolName: 'filesystem__get_file_info',
            arguments: { path: 'D:\\project\\Cargo.toml' },
            permissionClass: 'external_write',
            extensionSource: 'external_stdio',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Extension action (confirmation required)')).toBeInTheDocument();
    expect(screen.queryByText('External write')).not.toBeInTheDocument();
  });

  it('shows trusted risk, source, and scope without copying raw arguments', () => {
    render(
      <ToolConfirmation
        sessionId="session-card"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'tool-card',
            toolName: 'external__deploy',
            arguments: { token: 'must-not-appear' },
            prompt: 'Host policy requires approval.',
            permissionClass: 'high_risk',
            extensionSource: 'external_http',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'always_allow', 'deny_once'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('High risk')).toBeInTheDocument();
    expect(screen.getByTestId('tool-permission-risk-icon')).toBeInTheDocument();
    expect(screen.getByText('External network extension')).toBeInTheDocument();
    expect(screen.getByText('This task')).toBeInTheDocument();
    expect(screen.getByText('Host policy requires approval.')).toBeInTheDocument();
    expect(screen.queryByText('must-not-appear')).not.toBeInTheDocument();
  });

  it('shows the bound force-push summary without exposing the preflight id', () => {
    render(
      <ToolConfirmation
        sessionId="session-force"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'force-card',
            toolName: 'git_force_push',
            arguments: {
              remote: 'origin',
              branch: 'main',
              head: '1111111111111111111111111111111111111111',
              expected_remote_oid: '2222222222222222222222222222222222222222',
              local_only_commit_count: 2,
              remote_only_commit_count: 3,
              preflight_id: 'must-not-appear',
            },
            permissionClass: 'high_risk',
            extensionSource: 'platform',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Force push confirmation')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByText('origin')).toBeInTheDocument();
    expect(screen.getByText('Branch')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('1111111111111111111111111111111111111111')).toBeInTheDocument();
    expect(screen.getByText('2222222222222222222222222222222222222222')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('must-not-appear')).not.toBeInTheDocument();
  });

  it('shows only the exact path or command being approved', () => {
    const { rerender } = render(
      <ToolConfirmation
        sessionId="session-path"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'path-card',
            toolName: 'developer__read_document',
            arguments: { path: 'C:\\Users\\tester\\Desktop\\report.docx', token: 'hidden-token' },
            permissionClass: 'legacy',
            extensionSource: 'builtin',
            authorizationScope: 'global',
            availableActions: ['allow_once', 'deny_once'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Path')).toBeInTheDocument();
    expect(screen.getByText('C:\\Users\\tester\\Desktop\\report.docx')).toBeInTheDocument();
    expect(screen.queryByText('hidden-token')).not.toBeInTheDocument();

    rerender(
      <ToolConfirmation
        sessionId="session-command"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'command-card',
            toolName: 'developer__shell',
            arguments: { command: 'Get-ChildItem C:\\CodeProProjects', token: 'still-hidden' },
            permissionClass: 'legacy',
            extensionSource: 'builtin',
            authorizationScope: 'global',
            availableActions: ['allow_once', 'deny_once'],
          },
        }}
      />
    );

    expect(screen.getByText('Command')).toBeInTheDocument();
    expect(screen.getByText('Get-ChildItem C:\\CodeProProjects')).toBeInTheDocument();
    expect(screen.queryByText('still-hidden')).not.toBeInTheDocument();
  });

  it('shows exact platform memory payload fields before approval', () => {
    pendingMemoryPermission('session-memory', 'memory-card');
    render(
      <ToolConfirmation
        sessionId="session-memory"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'memory-card',
            toolName: 'project_memory_remember',
            arguments: {
              kind: 'preference',
              subject: '  response.style  ',
              content: '  Keep answers compact.  ',
              confidence: 'high',
              reason: '  The user requested it.  ',
              scope: 'user',
              user_confirmed: true,
            },
            permissionClass: 'workspace_write',
            extensionSource: 'platform',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByText('Review memory before saving')).toBeInTheDocument();
    for (const value of [
      '  response.style  ',
      '  Keep answers compact.  ',
      '  The user requested it.  ',
    ]) {
      expect(
        screen.getByText(
          (_content, element) => element?.tagName === 'PRE' && element.textContent === value
        )
      ).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
  });

  it('renders the inferred-memory summary from an ACP permission payload with raw identity', () => {
    renderPermissionRequest({
      sessionId: 'session-memory-adapter',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'memory-adapter-card',
        title: 'Project Memory Remember',
        rawInput: {
          kind: 'preference',
          subject: 'response.style.inline_candidate_92',
          content: '回答末尾输出 INLINE-CAND-92',
          confidence: 'medium',
          reason: '用于对话内确认卡验收',
          scope: 'user',
          user_confirmed: false,
        },
        _meta: {
          goose: { toolCall: { toolName: 'project_memory_remember' } },
        },
      },
      _meta: {
        codepro: {
          permissionClass: 'workspace_write',
          extensionSource: 'platform',
          authorizationScope: 'session',
        },
      },
    });

    expect(screen.getByText('Review memory before saving')).toBeInTheDocument();
    expect(screen.getByText('Inferred user-preference candidate request')).toBeInTheDocument();
    expect(screen.getByText('response.style.inline_candidate_92')).toBeInTheDocument();
  });

  it('keeps a permission payload without raw identity on the generic approval path', () => {
    renderPermissionRequest({
      sessionId: 'session-memory-generic',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'memory-generic-card',
        title: 'Project Memory Remember',
        rawInput: {
          kind: 'preference',
          subject: 'must-not-be-trusted-from-title',
          content: 'must-not-be-trusted-from-title',
          confidence: 'medium',
          reason: 'must-not-be-trusted-from-title',
          scope: 'user',
          user_confirmed: false,
        },
      },
      _meta: {
        codepro: {
          permissionClass: 'workspace_write',
          extensionSource: 'platform',
          authorizationScope: 'session',
        },
      },
    });

    expect(screen.queryByText('Review memory before saving')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Inferred user-preference candidate request')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('must-not-be-trusted-from-title')).not.toBeInTheDocument();
  });

  it('removes allow actions for malformed platform memory while preserving deny', () => {
    pendingMemoryPermission('session-invalid-memory', 'invalid-memory-card');
    render(
      <ToolConfirmation
        sessionId="session-invalid-memory"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'invalid-memory-card',
            toolName: 'project_memory_remember',
            arguments: {
              kind: 'preference',
              subject: 'response.style',
              content: 'Keep answers compact.',
              confidence: 'high',
              reason: 'The user requested it.',
              source: 'user_explicit',
            },
            permissionClass: 'workspace_write',
            extensionSource: 'platform',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'always_allow', 'deny_once', 'always_deny'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/malformed/i);
    expect(screen.queryByRole('button', { name: 'Allow Once' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Allow for this task/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny Once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny for this task' })).toBeInTheDocument();
  });

  it('does not expose arguments for an external same-name tool', () => {
    render(
      <ToolConfirmation
        sessionId="session-external-memory"
        isClicked={false}
        actionRequiredContent={{
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'external-memory-card',
            toolName: 'project_memory_remember',
            arguments: {
              kind: 'preference',
              subject: 'must-not-appear',
              content: 'must-not-appear',
              confidence: 'high',
              reason: 'must-not-appear',
            },
            permissionClass: 'external_write',
            extensionSource: 'external_stdio',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          },
        }}
      />,
      { wrapper: IntlTestWrapper }
    );

    expect(screen.queryByText('Review memory before saving')).not.toBeInTheDocument();
    expect(screen.queryByText('must-not-appear')).not.toBeInTheDocument();
  });
});
