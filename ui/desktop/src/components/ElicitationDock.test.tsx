import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { ActionRequired } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import ElicitationDock from './ElicitationDock';

it('offers a late-answer bubble without submitting on open/close and removes it when the native turn closes', async () => {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const request: ActionRequired & { type: 'actionRequired' } = {
    type: 'actionRequired',
    data: {
      actionType: 'elicitation',
      id: 'native-question',
      message: '',
      nativeQuestion: true,
      continued: true,
      requested_schema: {
        type: 'object',
        properties: { color: { type: 'string', title: 'Which color?' } },
      },
    },
  };
  const user = userEvent.setup();
  const view = render(<ElicitationDock requests={[request]} onSubmit={onSubmit} />, {
    wrapper: IntlTestWrapper,
  });
  const bubble = screen.getByRole('button', { name: /Answer question.*Which color/ });
  expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  await user.click(bubble);
  expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(onSubmit).not.toHaveBeenCalled();
  await user.click(bubble);
  view.rerender(<ElicitationDock requests={[]} onSubmit={onSubmit} />);
  expect(screen.queryByRole('button', { name: /Answer question/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});
