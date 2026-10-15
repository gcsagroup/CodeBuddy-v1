import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message } from '../types/message';
import UserMessage from './UserMessage';

describe('UserMessage', () => {
  const message: Message = {
    id: 'short-message',
    role: 'user',
    created: Date.now(),
    content: [{ type: 'text', text: '你好' }],
    metadata: { agentVisible: true, userVisible: true },
  };

  it('updates copy availability when the session type finishes loading', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<UserMessage message={message} />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    expect(screen.getByRole('button', { name: 'Fork session with edited message' })).toBeDisabled();
    rerender(<UserMessage message={message} sessionType="user" />);
    expect(screen.getByRole('button', { name: 'Fork session with edited message' })).toBeEnabled();
    rerender(<UserMessage message={message} sessionType="code_pro" />);
    expect(screen.getByRole('button', { name: 'Fork session with edited message' })).toBeDisabled();
  });

  it('keeps edit and copy actions on one line for a short message', () => {
    render(<UserMessage message={message} />, { wrapper: IntlTestWrapper });

    const editButton = screen.getByRole('button', { name: 'Edit message: 你好' });
    const copyButton = screen.getByRole('button', { name: 'Copy' });
    const actionBar = editButton.parentElement;

    expect(actionBar).toHaveClass('w-max', 'whitespace-nowrap');
    expect(editButton).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(copyButton).toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  it('does not write original or edited message content to renderer logs', async () => {
    const user = userEvent.setup();
    const logInfo = vi.fn();
    Object.assign(window.electron, { logInfo });
    render(<UserMessage message={message} />, { wrapper: IntlTestWrapper });

    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(editor);
    await user.type(editor, 'TOP_SECRET edited body');
    await user.keyboard('{Escape}');

    const logs = logInfo.mock.calls.flat().join('\n');
    expect(logs).not.toMatch(/你好|TOP_SECRET|edited body|Content changed|Entering edit mode/);
  });

  it('uses fork for the default keyboard resend and edit only for the explicit in-place action', async () => {
    const user = userEvent.setup();
    const onMessageUpdate = vi.fn();
    const { rerender } = render(
      <UserMessage message={message} onMessageUpdate={onMessageUpdate} sessionType="user" />,
      { wrapper: IntlTestWrapper }
    );

    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(editor);
    await user.type(editor, '分叉重发');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onMessageUpdate).toHaveBeenLastCalledWith('short-message', '分叉重发', 'fork');

    rerender(
      <UserMessage message={message} onMessageUpdate={onMessageUpdate} sessionType="user" />
    );
    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const inPlaceEditor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(inPlaceEditor);
    await user.type(inPlaceEditor, '原地重发');
    await user.click(screen.getByRole('button', { name: 'Edit message in place' }));
    expect(onMessageUpdate).toHaveBeenLastCalledWith('short-message', '原地重发', 'edit');
  });

  it('keeps CodePro edits open when the fork shortcut is used and permits explicit in-place edits', async () => {
    const user = userEvent.setup();
    const onMessageUpdate = vi.fn();
    render(
      <UserMessage message={message} onMessageUpdate={onMessageUpdate} sessionType="code_pro" />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: 'Edit message: 你好' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message content' });
    await user.clear(editor);
    await user.type(editor, 'Keep this draft');
    expect(screen.getByRole('button', { name: 'Fork session with edited message' })).toBeDisabled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onMessageUpdate).not.toHaveBeenCalled();
    expect(editor).toHaveValue('Keep this draft');
    expect(screen.getByRole('alert')).toHaveTextContent('Copying is unavailable');
    await user.click(screen.getByRole('button', { name: 'Edit message in place' }));
    expect(onMessageUpdate).toHaveBeenCalledWith('short-message', 'Keep this draft', 'edit');
  });
});
