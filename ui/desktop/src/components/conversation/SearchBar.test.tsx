import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import SearchBar from './SearchBar';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('searches a single Chinese character, keeps match navigation, and cancels pending searches on clear', () => {
  const onSearch = vi.fn();
  const onNavigate = vi.fn();
  render(
    <SearchBar
      onSearch={onSearch}
      onClose={vi.fn()}
      onNavigate={onNavigate}
      searchResults={{ count: 2, currentIndex: 1 }}
      showNavigation
      inHeader
    />,
    { wrapper: IntlTestWrapper }
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '你好' } });
  act(() => vi.advanceTimersByTime(200));
  expect(onSearch).toHaveBeenLastCalledWith('你好', false);

  fireEvent.change(input, { target: { value: '你' } });
  act(() => vi.advanceTimersByTime(200));
  expect(onSearch).toHaveBeenLastCalledWith('你', false);
  expect(screen.getByRole('status')).toHaveTextContent('1 / 2');
  fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
  expect(onNavigate).toHaveBeenLastCalledWith('next');

  fireEvent.change(input, { target: { value: '好' } });
  fireEvent.change(input, { target: { value: '' } });
  act(() => vi.advanceTimersByTime(200));
  expect(onSearch).toHaveBeenLastCalledWith('', false);
  expect(onSearch).not.toHaveBeenCalledWith('好', false);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('searches a one-character initial selection', () => {
  const onSearch = vi.fn();
  render(<SearchBar onSearch={onSearch} onClose={vi.fn()} initialSearchTerm="你" />, {
    wrapper: IntlTestWrapper,
  });
  act(() => vi.advanceTimersByTime(200));
  expect(onSearch).toHaveBeenCalledWith('你', false);
});
