import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { getSessionPlanMode } from '../acp/goals';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ComposerPlanMode } from './ComposerPlanMode';

vi.mock('../acp/goals', () => ({ getSessionPlanMode: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('shows the native plan state and forwards exit without changing approval', async () => {
  vi.mocked(getSessionPlanMode).mockResolvedValue({ active: true });
  const onExit = vi.fn();
  render(<ComposerPlanMode sessionId="s" busy={false} refreshKey={0} onExit={onExit} />, {
    wrapper: IntlTestWrapper,
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Leave plan mode' }));
  expect(onExit).toHaveBeenCalledOnce();
  expect(getSessionPlanMode).toHaveBeenCalledExactlyOnceWith('s');
});

it('does not show another conversation’s plan state during a switch', async () => {
  vi.mocked(getSessionPlanMode).mockResolvedValue({ active: true });
  const props = { busy: false, refreshKey: 0, onExit: vi.fn() };
  const view = render(<ComposerPlanMode {...props} sessionId="first" />, {
    wrapper: IntlTestWrapper,
  });
  await screen.findByRole('button');
  vi.mocked(getSessionPlanMode).mockResolvedValue({ active: false });
  view.rerender(<ComposerPlanMode {...props} sessionId="second" />);
  await waitFor(() => expect(getSessionPlanMode).toHaveBeenCalledWith('second'));
  expect(screen.queryByRole('button')).toBeNull();
});
