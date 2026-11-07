/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import {
  readToolboxSession,
  setToolboxSessionMode,
  retryToolboxSession,
} from '../../acp/toolboxSession';
import { ToolboxSessionScope } from './ToolboxSessionScope';

vi.mock('../../acp/toolboxSession', () => ({
  readToolboxSession: vi.fn(),
  setToolboxSessionMode: vi.fn(),
  retryToolboxSession: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

it('shows pending changes while running and switches an existing custom conversation to follow', async () => {
  const state = {
    mode: 'custom' as const,
    pending: true,
    running: true,
    selected: [],
    statuses: [],
  };
  vi.mocked(readToolboxSession).mockResolvedValue(state);
  vi.mocked(setToolboxSessionMode).mockImplementation(async () => {
    vi.mocked(readToolboxSession).mockResolvedValue({ ...state, mode: 'follow' });
  });
  const onChange = vi.fn().mockResolvedValue(undefined);
  render(
    <IntlTestWrapper>
      <ToolboxSessionScope sessionId="same-chat" state={state} onChange={onChange} />
    </IntlTestWrapper>
  );
  expect(await screen.findByRole('status')).toHaveTextContent('changes apply before the next turn');
  expect(screen.getByRole('button', { name: 'Retry connections' })).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole('combobox'), 'follow');
  await waitFor(() => expect(setToolboxSessionMode).toHaveBeenCalledWith('same-chat', 'follow'));
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(readToolboxSession).not.toHaveBeenCalled();
});

it('displays actual failure detail and retries without implying that historical success means ready', async () => {
  const state = {
    mode: 'follow' as const,
    pending: false,
    running: false,
    selected: ['scrapling'],
    statuses: [
      { serverName: 'scrapling', status: 'error', error: 'ImportError: ModelWrapValidatorHandler' },
    ],
  };
  render(
    <IntlTestWrapper>
      <ToolboxSessionScope sessionId="same-chat" state={state} onChange={vi.fn()} />
    </IntlTestWrapper>
  );
  expect(await screen.findByText('scrapling · Connection failed')).toBeVisible();
  await userEvent.click(screen.getByText('Connection failed', { selector: 'summary' }));
  expect(screen.getByText('ImportError: ModelWrapValidatorHandler')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Retry connections' }));
  expect(retryToolboxSession).toHaveBeenCalledWith('same-chat');
});


it('does not report a background connection as failed or connected', () => {
  render(<IntlTestWrapper><ToolboxSessionScope sessionId="same-chat" state={{ mode: 'follow', pending: false, running: false, selected: ['slow'], statuses: [{ serverName: 'slow', status: 'connecting' }] }} onChange={vi.fn()} /></IntlTestWrapper>);
  expect(screen.getByText('slow · Connecting in background…')).toBeVisible();
  expect(screen.queryByText(/Connection failed/)).not.toBeInTheDocument();
});
