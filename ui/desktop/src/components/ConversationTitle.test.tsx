import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationTitle } from './ConversationTitle';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps numbered branch suffixes outside the scrolling name', () => {
  render(<button><ConversationTitle>{'Long original conversation (12)'}</ConversationTitle></button>);
  expect(screen.getByRole('button', { name: 'Long original conversation (12)' })).toBeVisible();
  expect(screen.getByText('(12)')).toHaveClass('conversation-title-number');
  expect(screen.getByText('Long original conversation').parentElement).not.toContainElement(screen.getByText('(12)'));
});

it('preserves the complete title and recalculates overflow when the sidebar grows', () => {
  let width = 120;
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500);
  const title = '修复七项体验问题并验收 Windows 和 Mac 安装包，保留全部历史与证据';
  const view = render(<button><ConversationTitle>{title}</ConversationTitle></button>);
  const label = screen.getByText(title).parentElement!;
  expect(screen.getByRole('button', { name: title })).toBeVisible();
  expect(label).toHaveAttribute('data-overflow', 'true');
  expect(label.style.getPropertyValue('--title-travel')).toBe('-404px');
  act(() => { width = 600; resize(); });
  expect(label).toHaveAttribute('data-overflow', 'false');
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
