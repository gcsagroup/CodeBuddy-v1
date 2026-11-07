/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { ToolboxItem } from '../../types/toolbox';
import { ProgressiveToolboxGrid } from './ProgressiveToolboxGrid';

const entries: ToolboxItem[] = Array.from({ length: 1000 }, (_, i) => ({
  id: String(i), name: `tool-${i}`, description: '', kind: 'external', source: 'extension', status: 'configured', actions: [],
}));
afterEach(() => vi.unstubAllGlobals());
const card = (item: ToolboxItem) => <button key={item.id}>{item.name}</button>;
it('bounds initial cards and loads another page by keyboard/click', async () => {
  render(<IntlTestWrapper><ProgressiveToolboxGrid entries={entries} renderItem={card} /></IntlTestWrapper>);
  expect(screen.getAllByRole('button', { name: /^tool-/ })).toHaveLength(24);
  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(screen.getAllByRole('button', { name: /^tool-/ })).toHaveLength(48);
});
it('loads near the scroll boundary and disconnects on unmount', () => {
  const disconnect = vi.fn();
  let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const view = render(<IntlTestWrapper><ProgressiveToolboxGrid entries={entries} renderItem={card} /></IntlTestWrapper>);
  act(() => intersect([{ isIntersecting: true }]));
  expect(screen.getAllByRole('button', { name: /^tool-/ })).toHaveLength(48);
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
});
it('search results beyond the first page are visible and deletion does not retain stale cards', () => {
  const view = render(<IntlTestWrapper><ProgressiveToolboxGrid key="search" entries={[entries[999]]} renderItem={card} /></IntlTestWrapper>);
  expect(screen.getByRole('button', { name: 'tool-999' })).toBeVisible();
  view.rerender(<IntlTestWrapper><ProgressiveToolboxGrid key="search" entries={[]} renderItem={card} /></IntlTestWrapper>);
  expect(screen.queryByRole('button', { name: 'tool-999' })).not.toBeInTheDocument();
});
