import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { SearchView } from './SearchView';

type FindHandler = Parameters<typeof window.electron.on>[1];
const commands = new Map<string, Set<FindHandler>>();
const findEvent = {} as Parameters<FindHandler>[0];
beforeEach(() => {
  commands.clear();
  vi.mocked(window.electron.on).mockImplementation((event, callback) => {
    if (!commands.has(event)) commands.set(event, new Set());
    commands.get(event)!.add(callback);
  });
  vi.mocked(window.electron.off).mockImplementation((event, callback) => {
    commands.get(event)?.delete(callback);
  });
});

function Chats({ firstActive }: { firstActive: boolean }) {
  return (
    <>
      <section aria-label="First chat">
        <SearchView active={firstActive} highlightMatches={false}>
          First history
        </SearchView>
      </section>
      <section aria-label="Second chat">
        <SearchView active={!firstActive} highlightMatches={false}>
          Second history
        </SearchView>
      </section>
    </>
  );
}

describe('find command scope', () => {
  it('pauses a hidden chat query and searches the latest typed term on return', async () => {
    const onSearch = vi.fn();
    const onQueryActiveChange = vi.fn();
    const view = (active: boolean) => (
      <SearchView active={active} onSearch={onSearch} onQueryActiveChange={onQueryActiveChange}>
        Unrelated history
      </SearchView>
    );
    const { rerender } = render(view(true), { wrapper: IntlTestWrapper });
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, metaKey: true });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'first term' } });
    await waitFor(() => expect(onQueryActiveChange).toHaveBeenLastCalledWith(true));
    fireEvent.change(input, { target: { value: 'last term' } });
    rerender(view(false));
    expect(onQueryActiveChange).toHaveBeenLastCalledWith(false);
    expect(input).toHaveValue('last term');
    rerender(view(true));
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith('last term', false));
  });

  it.each(['keyboard', 'menu'])(
    'opens search only in the active kept-alive chat via %s',
    (command) => {
      const view = render(<Chats firstActive />, { wrapper: IntlTestWrapper });
      if (command === 'keyboard')
        fireEvent.keyDown(window, { key: 'f', ctrlKey: true, metaKey: true });
      else act(() => commands.get('find-command')?.forEach((callback) => callback(findEvent)));
      const first = screen.getByRole('region', { name: 'First chat' });
      const second = screen.getByRole('region', { name: 'Second chat' });
      fireEvent.change(within(first).getByRole('textbox'), { target: { value: '独立搜索' } });
      expect(within(second).queryByRole('textbox')).not.toBeInTheDocument();
      view.rerender(<Chats firstActive={false} />);
      expect(within(second).queryByRole('textbox')).not.toBeInTheDocument();
      act(() => commands.get('find-command')?.forEach((callback) => callback(findEvent)));
      expect(within(second).getByRole('textbox')).toHaveFocus();
      expect(within(first).getByRole('textbox')).toHaveValue('独立搜索');
      expect(within(second).getByRole('textbox')).toHaveValue('');
    }
  );
});
