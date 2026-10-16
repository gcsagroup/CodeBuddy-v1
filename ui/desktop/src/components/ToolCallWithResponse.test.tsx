import computerUnknown from './fixtures/computer-unknown.json';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAcpPermissionRequestPending } from '../acp/permissionRequests';
import { OPEN_SUBAGENT_CONVERSATION } from '../workspace-panel/subagentPanel';
import { OPEN_CONVERSATION_CHANGE } from '../workspace-panel/conversationChangePanel';
import userEvent from '@testing-library/user-event';
import ToolCallWithResponse, { resolveToolLoadingStatus } from './ToolCallWithResponse';
import type { ToolRequestMessageContent, ToolResponseMessageContent } from '../types/message';

vi.mock('./McpApps/McpAppRenderer', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="mcp-app">{JSON.stringify(props)}</div>
  ),
}));
// Permission lifecycle itself is covered with real RPCs in permissionRequests
// and ToolApprovalButtons tests; these cases exercise the resulting presentation.
vi.mock('../acp/permissionRequests', async (original) => ({
  ...(await original<typeof import('../acp/permissionRequests')>()),
  isAcpPermissionRequestPending: vi.fn(() => true),
}));
beforeEach(() => vi.mocked(isAcpPermissionRequestPending).mockReturnValue(true));

describe('tool response completion evidence', () => {
  it('opens the file receipt by call identity without toggling the row, including keyboard activation', async () => {
    const user = userEvent.setup(),
      open = vi.fn();
    window.addEventListener(OPEN_CONVERSATION_CHANGE, open);
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          compact
          sessionId="file-parent"
          isCancelledMessage={false}
          isPendingApproval={false}
          toolRequest={{
            type: 'toolRequest',
            id: 'historical-edit',
            metadata: { extensionName: 'harness' },
            toolCall: {
              status: 'success',
              value: { name: 'edit', arguments: { path: 'stale-argument.ts' } },
            },
          }}
          toolResponse={{
            type: 'toolResponse',
            id: 'historical-edit',
            toolResult: {
              status: 'success',
              value: {
                content: [],
                isError: false,
                structuredContent: { path: 'src/actual.ts', before: 'old\n', after: 'new\n' },
              },
            },
          }}
        />
      </IntlProvider>
    );
    const file = screen.getByRole('button', { name: 'src/actual.ts' });
    const toggle = screen.getByRole('button', { name: /Edited file actual.ts/ });
    expect(toggle.contains(file)).toBe(false);
    await user.click(file);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      sessionId: 'file-parent',
      toolCallId: 'historical-edit',
      filePath: 'src/actual.ts',
    });
    file.focus();
    await user.keyboard('{Enter}');
    expect(open).toHaveBeenCalledTimes(2);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('-old')).toBeVisible();
    expect(screen.getByText('+new')).toBeVisible();
    window.removeEventListener(OPEN_CONVERSATION_CHANGE, open);
  });

  it.each([true, false])(
    'shows only the real search query and source links in compact=%s',
    (compact) => {
      render(
        <IntlProvider locale="en" messages={{}}>
          <ToolCallWithResponse
            compact={compact}
            isCancelledMessage={false}
            isPendingApproval={false}
            toolRequest={{
              type: 'toolRequest',
              id: 'search-sources',
              toolCall: {
                status: 'success',
                value: {
                  name: 'mcp__exa__web_search_exa',
                  arguments: {
                    query: 'SGLang DeepSeek-V3 RadixAttention',
                    objective: 'internal search planning note',
                  },
                },
              },
            }}
            toolResponse={{
              type: 'toolResponse',
              id: 'search-sources',
              toolResult: {
                status: 'success',
                value: {
                  isError: false,
                  content: [
                    {
                      type: 'text',
                      text: 'Title: [P/D disagg] - support decode side radix cache\nURL: https://github.com/sgl-project/sglang/pull/19746\nPublished: N/A\nHighlights:\nLong source body is not a search action detail.\n\n---\nTitle: Unsafe source\nURL: javascript:alert(1)',
                    },
                  ],
                },
              },
            }}
          />
        </IntlProvider>
      );
      const toggle = screen.getByRole('button', { name: /Searched the web/ });
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
      expect(screen.getByText('SGLang DeepSeek-V3 RadixAttention')).toBeVisible();
      expect(
        screen.getByRole('link', { name: '[P/D disagg] - support decode side radix cache' })
      ).toHaveAttribute('href', 'https://github.com/sgl-project/sglang/pull/19746');
      expect(screen.queryByText('Diagnostic record')).not.toBeInTheDocument();
      expect(screen.queryByText(/mcp__exa/)).not.toBeInTheDocument();
      expect(screen.queryByText(/internal search planning/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Long source body/)).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Unsafe source' })).not.toBeInTheDocument();
    }
  );

  it('retains an actual provider notice without treating its prose as a failure status', () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          compact
          isCancelledMessage={false}
          isPendingApproval={false}
          toolRequest={{
            type: 'toolRequest',
            id: 'search-notice',
            toolCall: {
              status: 'success',
              value: {
                name: 'mcp__exa__web_search_exa',
                arguments: { query: 'inference frameworks' },
              },
            },
          }}
          toolResponse={{
            type: 'toolResponse',
            id: 'search-notice',
            toolResult: {
              status: 'success',
              value: {
                isError: false,
                content: [
                  {
                    type: 'text',
                    text: "You've hit Exa's free MCP rate limit.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys",
                  },
                ],
              },
            },
          }}
        />
      </IntlProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: /Searched the web/ }));
    expect(screen.getByText("You've hit Exa's free MCP rate limit.")).toBeVisible();
    expect(screen.queryByText(/Create API key/)).not.toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('opens a native child in the side panel with one click without opening another chat', () => {
    const open = vi.fn();
    window.addEventListener(OPEN_SUBAGENT_CONVERSATION, open);
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          compact
          sessionId="parent"
          isCancelledMessage={false}
          isPendingApproval={false}
          toolRequest={{
            type: 'toolRequest',
            id: 'spawn',
            toolCall: {
              status: 'success',
              value: { name: 'subagent_reviewer', arguments: { description: 'Review quantities' } },
            },
          }}
          toolResponse={{
            type: 'toolResponse',
            id: 'spawn',
            toolResult: { status: 'success', value: { content: [] } },
            metadata: { rawOutput: { kind: 'activation', subagentId: 'child' } },
          }}
        />
      </IntlProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review quantities' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect((open.mock.calls[0][0] as CustomEvent).detail).toEqual({
      parentSessionId: 'parent',
      childSessionId: 'child',
      title: 'Review quantities',
    });
    expect(screen.queryByText('Tool call completed')).not.toBeInTheDocument();
    window.removeEventListener(OPEN_SUBAGENT_CONVERSATION, open);
  });
  it('does not render approval controls from an expired historical confirmation', () => {
    vi.mocked(isAcpPermissionRequestPending).mockReturnValue(false);
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          compact
          sessionId="parent"
          isCancelledMessage={false}
          isPendingApproval
          isStreamingMessage={false}
          toolRequest={{
            type: 'toolRequest',
            id: 'expired',
            toolCall: { status: 'success', value: { name: 'read', arguments: {} } },
          }}
          confirmationContent={{ id: 'expired', toolName: 'read', arguments: {} }}
        />
      </IntlProvider>
    );
    expect(screen.queryByRole('button', { name: 'Allow Once' })).not.toBeInTheDocument();
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown status')).toBeVisible();
  });
  it.each([
    ['read', { file_path: 'D:\\fixture\\采购清单.txt' }, 'D:\\fixture\\采购清单.txt'],
    [
      'bash',
      { command: 'node --test packages/core.test.mjs' },
      'node --test packages/core.test.mjs',
    ],
  ])(
    'shows the approved %s target before execution, even with an incomplete streamed preview',
    (name, args, expected) => {
      render(
        <IntlProvider locale="en" messages={{}}>
          <ToolCallWithResponse
            compact
            sessionId="approval-target"
            isCancelledMessage={false}
            isPendingApproval
            isStreamingMessage
            toolRequest={{
              type: 'toolRequest',
              id: 'target-call',
              toolCall: { status: 'success', value: { name, arguments: {} } },
            }}
            confirmationContent={{
              id: 'target-call',
              toolName: name,
              arguments: args,
              availableActions: ['allow_once', 'deny_once'],
            }}
          />
        </IntlProvider>
      );
      expect(screen.getByText(expected)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Allow Once' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Deny Once' })).toBeVisible();
    }
  );
  it.each([true, false])(
    'renders MCP Apps with the backend identity in compact=%s',
    async (compact) => {
      render(
        <IntlProvider locale="en" messages={{}}>
          <ToolCallWithResponse
            compact={compact}
            sessionId="chart-session"
            isCancelledMessage={false}
            isPendingApproval={false}
            isStreamingMessage={false}
            toolRequest={{
              type: 'toolRequest',
              id: 'chart-call',
              toolCall: {
                status: 'success',
                value: { name: 'mcp__chart_server__render_donut', arguments: { data: [2, 3] } },
              },
            }}
            toolResponse={{
              type: 'toolResponse',
              id: 'chart-call',
              toolResult: {
                status: 'success',
                value: {
                  content: [],
                  structuredContent: { data: [2, 3] },
                  _meta: {
                    ui: { resourceUri: 'ui://charts/donut' },
                    extensionName: 'chart_server',
                    toolName: 'render_donut',
                  },
                },
              },
            }}
          />
        </IntlProvider>
      );
      const app = await screen.findByTestId('mcp-app');
      expect(app).toBeVisible();
      const props = JSON.parse(app.textContent ?? '{}');
      expect(props.extensionName).toBe('chart_server');
      expect(props.toolName).toBe('render_donut');
      expect(props.resourceUri).toBe('ui://charts/donut');
      expect(props.toolResult.structuredContent).toEqual({ data: [2, 3] });
    }
  );

  const response = (value: unknown): ToolResponseMessageContent =>
    ({ type: 'toolResponse', id: 'observe', toolResult: value }) as ToolResponseMessageContent;

  it('keeps an active call running but never assumes success when its stream ends without a result', () => {
    expect(resolveToolLoadingStatus(undefined, true)).toBe('loading');
    expect(resolveToolLoadingStatus(undefined, false)).toBe('unknown');
  });

  it('uses the compact command summary and keeps the exact command in expandable details', async () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          compact
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={true}
          toolRequest={{
            type: 'toolRequest',
            id: 'shell-title',
            metadata: { title: 'Check the project test result' },
            toolCall: {
              status: 'success',
              value: { name: 'developer__shell', arguments: { command: 'npm.cmd test' } },
            },
          }}
        />
      </IntlProvider>
    );
    const toggle = await screen.findByRole('button', { name: /Run command npm.cmd test/ });
    expect(toggle).toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByText('npm.cmd test')).toBeVisible();
  });

  it('distinguishes an empty successful result from a malformed or missing result body', () => {
    expect(
      resolveToolLoadingStatus(response({ status: 'success', value: { content: [] } }), false)
    ).toBe('success');
    for (const result of [
      null,
      undefined,
      {},
      { status: 'success' },
      { status: 'success', value: {} },
    ]) {
      expect(resolveToolLoadingStatus(response(result), false)).toBe('unknown');
    }
  });

  it('treats transport errors and MCP isError results as errors', () => {
    expect(
      resolveToolLoadingStatus(response({ status: 'success', value: { isError: true } }), false)
    ).toBe('error');
    expect(
      resolveToolLoadingStatus(response({ status: 'error', error: 'invalid argument' }), false)
    ).toBe('error');
    expect(
      resolveToolLoadingStatus(
        response({ status: 'success', value: { content: [], isError: true } }),
        false
      )
    ).toBe('error');
  });

  it('shows a native foreground command failure even when tool transport succeeded', async () => {
    const request: ToolRequestMessageContent = {
      type: 'toolRequest',
      id: 'native-test-failure',
      metadata: { extensionName: 'harness' },
      toolCall: {
        status: 'success',
        value: { name: 'pwsh', arguments: { command: 'node --test tests/invoice.test.mjs' } },
      },
    };
    const result = response({
      status: 'success',
      value: {
        isError: false,
        content: [{ type: 'text', text: 'tests 3, pass 1, fail 2' }],
        structuredContent: { kind: 'foreground', exitCode: 1 },
      },
    });
    result.id = request.id;
    expect(resolveToolLoadingStatus(result, false, request)).toBe('error');
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          compact
          toolRequest={request}
          toolResponse={result}
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={false}
        />
      </IntlProvider>
    );
    expect(await screen.findByRole('button', { name: /node --test.*Failed/i })).toBeVisible();
  });

  it('does not reinterpret unrelated MCP payloads or unfinished commands as native failures', () => {
    const nativeRequest: ToolRequestMessageContent = {
      type: 'toolRequest',
      id: 'observe',
      metadata: { extensionName: 'harness' },
      toolCall: { status: 'success', value: { name: 'pwsh', arguments: {} } },
    };
    const commandResult = (exitCode: number | null, kind = 'foreground') =>
      response({
        status: 'success',
        value: { content: [], structuredContent: { kind, exitCode } },
      });
    expect(resolveToolLoadingStatus(commandResult(0), false, nativeRequest)).toBe('success');
    expect(resolveToolLoadingStatus(commandResult(null), false, nativeRequest)).toBe('success');
    expect(resolveToolLoadingStatus(commandResult(1, 'background'), false, nativeRequest)).toBe(
      'success'
    );
    expect(
      resolveToolLoadingStatus(commandResult(1), false, {
        ...nativeRequest,
        metadata: { extensionName: 'external-mcp' },
      })
    ).toBe('success');
    expect(resolveToolLoadingStatus(commandResult(1), false)).toBe('success');
  });

  it('shows unknown status without a success indicator after a missing response', async () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={false}
          toolRequest={{
            type: 'toolRequest',
            id: 'observe',
            toolCall: {
              status: 'success',
              value: { name: 'computer__computer_observe', arguments: {} },
            },
          }}
        />
      </IntlProvider>
    );
    expect(await screen.findByText('Unknown status')).toBeVisible();
    expect(screen.getByLabelText('Tool status: pending')).toBeVisible();
    expect(screen.queryByLabelText('Tool status: success')).toBeNull();
  });

  it('keeps an MCP failure output visible with an error indicator', async () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={false}
          toolRequest={{
            type: 'toolRequest',
            id: 'observe',
            toolCall: {
              status: 'success',
              value: { name: 'computer__computer_observe', arguments: {} },
            },
          }}
          toolResponse={response({
            status: 'success',
            value: { content: [{ type: 'text', text: 'Window was not found' }], isError: true },
          })}
        />
      </IntlProvider>
    );
    expect(await screen.findByText('Window was not found')).toBeVisible();
    expect(screen.getByLabelText('Tool status: error')).toBeVisible();
    expect(screen.queryByLabelText('Tool status: success')).toBeNull();
  });
});

describe('internal task check presentation', () => {
  it.each([
    ['inspect', 'View task requirements'],
    ['revise', 'Update task requirements'],
    ['propose_coverage', 'Check delivery evidence'],
  ])(
    'keeps the rejected %s receipt readable without calling the task a failure',
    (operation, title) => {
      const error =
        'coverage rejected at revision 2; no coverage was committed: duplicate requirement coverage';
      render(
        <IntlProvider locale="en" messages={{}}>
          <ToolCallWithResponse
            compact
            isCancelledMessage={false}
            isPendingApproval={false}
            isStreamingMessage={false}
            toolRequest={{
              type: 'toolRequest',
              id: `check-${operation}`,
              toolCall: {
                status: 'success',
                value: { name: 'task_contract', arguments: { operation } },
              },
            }}
            toolResponse={{
              type: 'toolResponse',
              id: `check-${operation}`,
              toolResult: {
                status: 'error',
                error,
              },
            }}
          />
        </IntlProvider>
      );
      const toggle = screen.getByRole('button', {
        name: new RegExp(`${title}\\s*Not accepted · view details`),
      });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Failed')).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(
        within(screen.getByRole('region', { name: 'Execution result' })).getByText(error)
      ).toBeVisible();
      expect(screen.getByText(/not the overall task result/)).toBeVisible();
    }
  );

  it.each([
    ['unknown', 'Unknown status'],
    ['cancelled', 'Cancelled'],
    ['pending', 'Pending'],
  ])('does not relabel %s as a rejected check', (state, label) => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          compact
          sessionId="check-state"
          isCancelledMessage={state === 'cancelled'}
          isPendingApproval={state === 'pending'}
          isStreamingMessage={false}
          toolRequest={{
            type: 'toolRequest',
            id: `check-${state}`,
            toolCall: {
              status: 'success',
              value: { name: 'task_contract', arguments: { operation: 'propose_coverage' } },
            },
          }}
        />
      </IntlProvider>
    );
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText('Not accepted · view details')).not.toBeInTheDocument();
  });
});

describe('tool audit presentation', () => {
  it('renders the safe audit summary from tool response metadata', async () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          toolRequest={{
            type: 'toolRequest',
            id: 'tool-audit',
            toolCall: {
              status: 'success',
              value: { name: 'developer__shell', arguments: {} },
            },
          }}
          toolResponse={{
            type: 'toolResponse',
            id: 'tool-audit',
            toolResult: {
              status: 'success',
              value: { content: [], isError: false },
            },
            metadata: {
              toolAudit: {
                schemaVersion: 1,
                auditId: '0198f083-3f9f-7e4a-bd71-b8ec3cab37be',
                actor: 'codepro_coder',
                effectiveModel: 'openai/gpt-5.6-codex',
                extensionSource: 'platform',
                toolName: 'developer::shell',
                permissionClass: 'workspace_write',
                authorization: 'user_confirmed',
                outcome: 'success',
                taskScoped: true,
                startedAt: '2026-08-04T09:20:30.100Z',
                completedAt: '2026-08-04T09:20:30.142Z',
                durationMs: 42,
              },
            },
          }}
        />
      </IntlProvider>
    );

    expect(
      await screen.findByText('Safety check: Changes limited to this project · Tool call succeeded')
    ).toBeInTheDocument();
  });
});

describe('computer business outcome', () => {
  it('shows the captured unknown receipt without claiming success', async () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={false}
          toolRequest={computerUnknown.request as never}
          toolResponse={computerUnknown.response as never}
        />
      </IntlProvider>
    );
    expect(await screen.findByText(/Operation result unconfirmed/)).toBeVisible();
    expect(screen.getByLabelText('Tool status: warning')).toBeVisible();
    expect(screen.queryByLabelText('Tool status: success')).toBeNull();
    expect(screen.queryByText(/Tool call succeeded/)).toBeNull();
  });
});

describe('computer outcome rendering and history', () => {
  it.each([
    ['worked', 'Operation verified', 'success'],
    ['didnt', 'Operation failed', 'error'],
    ['rejected', 'Operation rejected', 'error'],
  ])('renders %s with its own wording', async (outcome, label, indicator) => {
    const response = globalThis.structuredClone(computerUnknown.response);
    const body = JSON.parse(response.toolResult.value.content[0].text);
    body.outcome = outcome;
    body.verification.matched = outcome === 'worked';
    response.toolResult.value.content[0].text = JSON.stringify(body);
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={false}
          toolRequest={computerUnknown.request as never}
          toolResponse={response as never}
        />
      </IntlProvider>
    );
    expect(await screen.findByText(new RegExp(label))).toBeVisible();
    expect(screen.getByLabelText(`Tool status: ${indicator}`)).toBeVisible();
  });
  it('preserves unknown on historical remount and keeps the original audit in details', async () => {
    const card = () => (
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={false}
          toolRequest={computerUnknown.request as never}
          toolResponse={JSON.parse(JSON.stringify(computerUnknown.response))}
        />
      </IntlProvider>
    );
    const first = render(card());
    expect(await screen.findByText(/Operation result unconfirmed/)).toBeVisible();
    first.unmount();
    render(card());
    expect(await screen.findByText(/Operation result unconfirmed/)).toBeVisible();
    expect(screen.getByLabelText('Tool status: warning')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Technical audit details' }));
    expect(screen.getByText('Tool call outcome')).toBeVisible();
    expect(screen.getByText('Tool call succeeded')).toBeVisible();
  });
  it('keeps an active physical action loading until its response arrives', () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={true}
          toolRequest={computerUnknown.request as never}
        />
      </IntlProvider>
    );
    expect(screen.getByLabelText('Tool status: loading')).toBeVisible();
    expect(screen.queryByLabelText('Tool status: error')).toBeNull();
    expect(screen.queryByText(/Operation result unconfirmed/)).toBeNull();
  });
});

describe('malformed computer transport payload', () => {
  it.each([null, 'invalid receipt', []])(
    'shows unconfirmed instead of successful audit for %j',
    async (value) => {
      const response = { ...computerUnknown.response, toolResult: { status: 'success', value } };
      render(
        <IntlProvider locale="en" messages={{}}>
          <ToolCallWithResponse
            isCancelledMessage={false}
            isPendingApproval={false}
            isStreamingMessage={false}
            toolRequest={computerUnknown.request as never}
            toolResponse={response as never}
          />
        </IntlProvider>
      );
      expect(await screen.findByText(/Operation result unconfirmed/)).toBeVisible();
      expect(screen.getByLabelText('Tool status: warning')).toBeVisible();
      expect(screen.queryByText(/Tool call succeeded/)).toBeNull();
      expect(screen.queryByLabelText('Tool status: success')).toBeNull();
    }
  );
  it('preserves a transport error indicator', () => {
    const response = {
      ...computerUnknown.response,
      toolResult: { status: 'error', error: 'transport failed' },
    };
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          isCancelledMessage={false}
          isPendingApproval={false}
          isStreamingMessage={false}
          toolRequest={computerUnknown.request as never}
          toolResponse={response as never}
        />
      </IntlProvider>
    );
    expect(screen.getByLabelText('Tool status: error')).toBeVisible();
    expect(screen.queryByLabelText('Tool status: warning')).toBeNull();
  });
});

describe('inline project memory approval', () => {
  const memoryToolRequest = {
    type: 'toolRequest' as const,
    id: 'memory-approval',
    toolCall: {
      status: 'success',
      value: {
        name: 'project_memory_remember',
        arguments: {
          kind: 'preference',
          subject: 'response.style',
          content: 'Keep answers compact.',
          confidence: 'high',
          reason: 'The user requested this preference.',
        },
      },
    },
  };

  it('shows the host-bound memory payload and preserves its permission actions', () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          sessionId="memory-session"
          isCancelledMessage={false}
          isPendingApproval
          toolRequest={memoryToolRequest}
          confirmationContent={{
            id: 'memory-approval',
            toolName: 'project_memory_remember',
            arguments: memoryToolRequest.toolCall.value.arguments,
            permissionClass: 'workspace_write',
            extensionSource: 'platform',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          }}
        />
      </IntlProvider>
    );

    expect(screen.getByText('Review memory before saving')).toBeInTheDocument();
    expect(screen.getByText('response.style')).toBeInTheDocument();
    expect(screen.getByText('Keep answers compact.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny Once' })).toBeInTheDocument();
  });

  it('preserves deny actions but removes allow actions for malformed memory input', () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          sessionId="invalid-memory-session"
          isCancelledMessage={false}
          isPendingApproval
          toolRequest={memoryToolRequest}
          confirmationContent={{
            id: 'memory-approval',
            toolName: 'project_memory_remember',
            arguments: {
              ...memoryToolRequest.toolCall.value.arguments,
              source: 'user_explicit',
            },
            permissionClass: 'workspace_write',
            extensionSource: 'platform',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'always_allow', 'deny_once', 'always_deny'],
          }}
        />
      </IntlProvider>
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/malformed/i);
    expect(screen.queryByRole('button', { name: 'Allow Once' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Allow for this task/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny Once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny for this task' })).toBeInTheDocument();
  });

  it('does not trust a legacy or external same-name tool as platform memory', () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <ToolCallWithResponse
          sessionId="external-memory-session"
          isCancelledMessage={false}
          isPendingApproval
          toolRequest={memoryToolRequest}
          confirmationContent={{
            id: 'memory-approval',
            toolName: 'project_memory_remember',
            arguments: memoryToolRequest.toolCall.value.arguments,
            permissionClass: 'external_write',
            extensionSource: 'external_stdio',
            authorizationScope: 'task',
            availableActions: ['allow_once', 'deny_once'],
          }}
        />
      </IntlProvider>
    );

    expect(screen.queryByText('Review memory before saving')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeInTheDocument();
  });
});
