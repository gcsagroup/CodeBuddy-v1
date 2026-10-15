import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { CodeProPlan, CodeProToolContent } from './CodeProToolContent';
import type { ToolResponseMessageContent } from '../../types/message';

const receipt = (
  structuredContent: Record<string, unknown>,
  isError = false
): ToolResponseMessageContent => ({
  type: 'toolResponse',
  id: 'call',
  toolResult: {
    status: 'success',
    value: {
      content: [{ type: 'text', text: 'observed output' }],
      structuredContent,
      isError,
    },
  },
});
const show = (name: string, args: Record<string, unknown>, response?: ToolResponseMessageContent) =>
  render(
    <IntlProvider locale="en" messages={{}}>
      <CodeProToolContent name={name} args={args} response={response} />
    </IntlProvider>
  );

describe('user-readable operation evidence', () => {
  it.each(['', '- ', '* '])('renders checkbox plans consistently with prefix %s', (prefix) => {
    const { rerender } = render(
      <IntlProvider locale="en" messages={{}}>
        <CodeProPlan
          compact
          active
          requestId="plan"
          content={`${prefix}[x] Inspect\n${prefix}[-] Build\n${prefix}[ ] Verify`}
        >
          fallback
        </CodeProPlan>
      </IntlProvider>
    );
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(screen.queryByText('fallback')).not.toBeInTheDocument();
    expect(screen.getByLabelText('In progress')).toHaveClass('animate-spin');
    rerender(
      <IntlProvider locale="en" messages={{}}>
        <CodeProPlan compact historical requestId="plan" content={`${prefix}[-] Build`}>
          fallback
        </CodeProPlan>
      </IntlProvider>
    );
    expect(screen.getByText('Earlier plan for this task')).toBeInTheDocument();
    expect(screen.queryByText('0/1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Not currently running')).not.toHaveClass('animate-spin');
  });
  it('preserves the existing audience boundary for tool output', () => {
    const response = receipt({});
    response.toolResult = {
      status: 'success',
      value: {
        content: [
          { type: 'text', text: 'agent-only payload', annotations: { audience: ['assistant'] } },
          { type: 'text', text: 'public receipt', annotations: { audience: ['user'] } },
        ],
      },
    };
    show('read_document', { path: 'README.md' }, response);
    expect(screen.queryByText('agent-only payload')).not.toBeInTheDocument();
    expect(screen.getByText('public receipt')).toBeVisible();
  });
  it('keeps transport failures visible, including rejected plan updates', () => {
    show(
      'todo__todo_write',
      { content: '- [ ] Verify enrollment' },
      {
        type: 'toolResponse',
        id: 'call',
        toolResult: { status: 'error', error: 'transport failed' },
      }
    );
    expect(screen.getByText('transport failed')).toBeVisible();
    expect(screen.getByText('Proposed content — execution not confirmed')).toBeVisible();
  });
  it('renders the supplied business plan, not the todo transport receipt', () => {
    show(
      'todo__todo_write',
      { content: '- [ ] Verify student enrollment\n- [x] Inspect environment' },
      receipt({})
    );
    expect(screen.getByText('Verify student enrollment')).toBeVisible();
    expect(screen.queryByText('observed output')).not.toBeInTheDocument();
  });

  it('does not label a requested write as delivered before a successful receipt', () => {
    show('write', { path: 'app.py', content: 'print(1)' });
    expect(screen.getByText('Proposed content — execution not confirmed')).toBeVisible();
    expect(screen.getByText('print(1)')).toBeVisible();
  });

  it('shows nonzero command exit separately from a timeout', () => {
    show('shell', { command: 'python -m pytest' }, receipt({ exit_code: 2 }, true));
    expect(screen.getByText('Exit code: 2')).toBeVisible();
    expect(screen.queryByText(/Timed out/)).not.toBeInTheDocument();
  });

  it('does not invent an exit code for a timed out command', () => {
    show('shell', { command: 'python run.py' }, receipt({ timed_out: true }, true));
    expect(screen.getByText(/Timed out/)).toBeVisible();
    expect(screen.queryByText(/Exit code/)).not.toBeInTheDocument();
  });

  it('uses the actual edit tool schema for the requested replacement', () => {
    show('edit', { path: 'app.py', before: 'old_value', after: 'new_value' }, receipt({}));
    expect(screen.getByText('old_value')).toBeVisible();
    expect(screen.getByText('new_value')).toBeVisible();
  });
});
