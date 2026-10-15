import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import ToolCallWithResponse from './ToolCallWithResponse';
import computerUnknown from './fixtures/computer-unknown.json';
import type { ToolResponseMessageContent } from '../types/message';
import zhCN from '../i18n/messages/zh-CN.json';
import zhTW from '../i18n/messages/zh-TW.json';

const expand = (button: HTMLElement) => {
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
};

const path = 'D:/a/very/long/project/documentation/project-guide.md';
const request = {
  type: 'toolRequest' as const,
  id: 'read-title',
  toolCall: { status: 'success', value: { name: 'developer__read_document', arguments: { path } } },
};
const success: ToolResponseMessageContent = {
  type: 'toolResponse',
  id: request.id,
  toolResult: {
    status: 'success',
    value: { content: [{ type: 'text', text: 'Actual file content' }], isError: false },
  },
};
const card = (
  props: Partial<React.ComponentProps<typeof ToolCallWithResponse>> = {},
  locale = 'en'
) => {
  const catalog: Record<string, { defaultMessage: string }> =
    locale === 'zh-CN' ? zhCN : locale === 'zh-TW' ? zhTW : {};
  const messages = Object.fromEntries(
    Object.entries(catalog).map(([key, entry]) => [key, entry.defaultMessage])
  );
  return (
    <IntlProvider locale={locale} messages={messages}>
      <ToolCallWithResponse
        toolRequest={request}
        isCancelledMessage={false}
        isPendingApproval={false}
        {...props}
      />
    </IntlProvider>
  );
};

describe('natural tool action presentation', () => {
  it('changes running to a completed call only after a response, and retains raw details', async () => {
    const view = render(card({ isStreamingMessage: true }));
    expect(await screen.findByText('Read file project-guide.md · in progress')).toBeVisible();
    expect(screen.getByText('Running')).toBeVisible();
    expect(screen.queryByText('Tool call completed')).toBeNull();
    view.rerender(card({ isStreamingMessage: true, toolResponse: success }));
    expect(screen.getByText('Tool call completed')).toBeVisible();
    expect(screen.queryByText('Running')).toBeNull();
    expand(screen.getByRole('button', { name: /Read file project-guide.md/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Tool Details' }));
    expect(screen.getByText('developer__read_document')).toBeVisible();
    expect(screen.getByText(path)).toBeVisible();
    expand(screen.getByRole('button', { name: 'Output' }));
    expect(screen.getByText('Actual file content')).toBeVisible();
    expect(screen.queryByText(/Task completed/)).toBeNull();
  });
  it('keeps a missing historical response unknown on remount', () => {
    const view = render(card());
    expect(screen.getByText('Unknown status')).toBeVisible();
    view.unmount();
    render(card());
    expect(screen.getByText('Unknown status')).toBeVisible();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });
  it('shows transport failure and preserves its exact error in details', () => {
    render(
      card({
        toolResponse: {
          ...success,
          toolResult: { status: 'error', error: 'EACCES: isolated fixture denied' },
        },
      })
    );
    expect(screen.getByText('Failed')).toBeVisible();
    expand(screen.getByRole('button', { name: /Read file project-guide.md/ }));
    expand(screen.getByRole('button', { name: 'Output' }));
    expect(screen.getByText('EACCES: isolated fixture denied')).toBeVisible();
  });
  it('shows a host-confirmed cancellation without a success indicator', () => {
    const response = {
      ...success,
      toolResult: { status: 'error', error: 'Cancelled by user' },
      metadata: {
        toolAudit: {
          ...computerUnknown.response.metadata.toolAudit,
          schemaVersion: 2,
          toolName: 'developer::read_document',
          outcome: 'cancelled',
          failureKind: 'cancelled',
        },
      },
    } as ToolResponseMessageContent;
    const view = render(card({ toolResponse: response }));
    expect(screen.getByText('Cancelled')).toBeVisible();
    expect(screen.queryByText('Task cancelled')).toBeNull();
    expect(screen.queryByLabelText('Tool status: success')).toBeNull();
    view.unmount();
    render(card({ toolResponse: JSON.parse(JSON.stringify(response)) }));
    expect(screen.getByText('Cancelled')).toBeVisible();
  });
  it('does not erase a completed call when the enclosing message was cancelled later', () => {
    render(card({ toolResponse: success, isCancelledMessage: true }));
    expect(screen.getByText('Tool call completed')).toBeVisible();
    expand(screen.getByRole('button', { name: /Read file project-guide.md/ }));
    expand(screen.getByRole('button', { name: 'Output' }));
    expect(screen.getByText('Actual file content')).toBeVisible();
  });
  it('shows waiting approval rather than running before authorization', () => {
    render(card({ isPendingApproval: true, isStreamingMessage: true }));
    expect(screen.getByText('Pending')).toBeVisible();
    expect(screen.queryByText('Running')).toBeNull();
  });
  it.each([
    ['zh-CN', '已查看文件 project-guide.md', '工具调用已完成'],
    ['zh-TW', '已查看文件 project-guide.md', '工具呼叫已完成'],
  ])('localizes title and status in %s', async (locale, title, status) => {
    render(card({ toolResponse: success }, locale));
    expect(await screen.findByText(new RegExp(title))).toBeVisible();
    expect(screen.getByText(status)).toBeVisible();
  });
  it('does not turn arbitrary code graph descriptions into success titles', () => {
    render(
      card({
        toolRequest: {
          ...request,
          toolCall: {
            status: 'success',
            value: {
              name: 'code_execution__execute_typescript',
              arguments: {
                tool_graph: [
                  {
                    tool: 'write',
                    description: 'All tasks completed successfully',
                    depends_on: [],
                  },
                ],
              },
            },
          },
        },
        isStreamingMessage: true,
      })
    );
    expect(screen.getByText('Execute code · in progress')).toBeVisible();
    expect(screen.queryByText('All tasks completed successfully')).toBeNull();
    expect(screen.getByText('Running')).toBeVisible();
  });
});

describe('command and unknown tool detail boundaries', () => {
  it('keeps a full shell command in details without presenting it as a task result', () => {
    const command = 'Get-Content -LiteralPath D:/project/README.md';
    render(
      card({
        toolRequest: {
          ...request,
          toolCall: {
            status: 'success',
            value: { name: 'developer__shell', arguments: { command } },
          },
        },
        toolResponse: success,
      })
    );
    expect(screen.getByText(`Ran command ${command}`)).toBeVisible();
    expect(screen.queryByText('Task completed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ran command/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Tool Details' }));
    expect(screen.getByText(command)).toBeVisible();
  });
  it('identifies an unknown tool without exposing arbitrary argument values in its title', () => {
    render(
      card({
        toolRequest: {
          ...request,
          toolCall: {
            status: 'success',
            value: { name: 'custom__inspect_item', arguments: { opaque: 'all tasks completed' } },
          },
        },
      })
    );
    expect(screen.getByText('Use tool Inspect Item')).toBeVisible();
    expect(screen.queryByText('all tasks completed')).toBeNull();
    expect(screen.getByText('Unknown status')).toBeVisible();
  });
});
