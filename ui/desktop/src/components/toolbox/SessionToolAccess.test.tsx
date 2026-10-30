/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { SessionToolAccess } from './SessionToolAccess';
import { addSessionExtension } from '../../acp/session-extensions';
import { listTools } from '../../acp/permissions';
vi.mock('../../acp/session-extensions', () => ({ addSessionExtension: vi.fn() }));
vi.mock('../../acp/permissions', () => ({ listTools: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
});
const refresh = vi.fn().mockResolvedValue(undefined);
function show(selected: boolean | undefined, name = 'qwen_computer') {
  return render(
    <IntlTestWrapper>
      <SessionToolAccess
        sessionId="existing"
        extension={{ type: 'builtin', name }}
        selected={selected}
        refresh={refresh}
      />
    </IntlTestWrapper>
  );
}
it.each(['qwen_computer', 'my_custom_mcp'])(
  'adds %s to the existing conversation and verifies discovered tools',
  async (name) => {
    vi.mocked(listTools).mockResolvedValue([{ name: `${name}__hello` }] as never);
    const view = show(false, name);
    expect(screen.getByText('Not loaded in this conversation')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add to this conversation' }));
    await waitFor(() => expect(listTools).toHaveBeenCalledWith('existing', name));
    expect(addSessionExtension).toHaveBeenCalledWith('existing', expect.objectContaining({ name }));
    view.rerender(
      <IntlTestWrapper>
        <SessionToolAccess
          sessionId="existing"
          extension={{ type: 'builtin', name }}
          selected
          refresh={refresh}
        />
      </IntlTestWrapper>
    );
    expect(await screen.findByText('Loaded · 1 tools available')).toBeVisible();
  }
);
it('does not claim a saved selection is a working connection', async () => {
  vi.mocked(listTools).mockResolvedValue([]);
  show(true);
  expect(screen.getByText('Added to this conversation · connection not checked')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Check connection' }));
  expect(await screen.findByText('Added · no tools discovered yet')).toBeVisible();
  expect(addSessionExtension).not.toHaveBeenCalled();
});
it('keeps failure visible and permits retry instead of creating another conversation', async () => {
  vi.mocked(addSessionExtension)
    .mockRejectedValueOnce(new Error('busy'))
    .mockResolvedValue(undefined);
  vi.mocked(listTools).mockResolvedValue([]);
  show(false);
  await userEvent.click(screen.getByRole('button', { name: 'Add to this conversation' }));
  expect(await screen.findByText(/Load failed/)).toBeVisible();
  expect(listTools).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Add to this conversation' }));
  await waitFor(() => expect(listTools).toHaveBeenCalledOnce());
});
it('keeps unknown state distinct from absent tools', () => {
  show(undefined);
  expect(screen.getByRole('button')).toBeDisabled();
  expect(screen.queryByText('Not loaded in this conversation')).toBeNull();
});

it('does not try to load a globally disabled tool', async () => {
  render(
    <IntlTestWrapper>
      <SessionToolAccess
        sessionId="existing"
        extension={{ type: 'builtin', name: 'qwen_computer' }}
        selected={false}
        enabled={false}
        refresh={refresh}
      />
    </IntlTestWrapper>
  );
  expect(screen.getByText('Enable this tool first')).toBeVisible();
  await userEvent.click(screen.getByRole('button'));
  expect(addSessionExtension).not.toHaveBeenCalled();
});
