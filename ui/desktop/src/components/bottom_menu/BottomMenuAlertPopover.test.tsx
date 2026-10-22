import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppEvents } from '../../constants/events';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { AlertType } from '../alerts';
import BottomMenuAlertPopover from './BottomMenuAlertPopover';

afterEach(() => vi.useRealTimers());

const alert = (onCompact = vi.fn()) => ({
  type: AlertType.Info, message: 'Context', progress: { current: 64000, total: 1000000 },
  showCompactButton: true, onCompact,
});

it('opens only on click, stays open across pointer movement and usage updates, and toggles closed', () => {
  vi.useFakeTimers();
  const view = render(
    <BottomMenuAlertPopover alerts={[alert()]}><span>64k / 1M</span></BottomMenuAlertPopover>,
    { wrapper: IntlTestWrapper }
  );
  const trigger = screen.getByRole('button', { name: '64k / 1M' });
  fireEvent.mouseEnter(trigger);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.mouseLeave(trigger);
  fireEvent.mouseLeave(screen.getByRole('dialog'));
  view.rerender(<BottomMenuAlertPopover alerts={[alert()]}><span>65k / 1M</span></BottomMenuAlertPopover>);
  act(() => vi.advanceTimersByTime(3500));
  expect(screen.getByRole('dialog')).toBeVisible();
  fireEvent.click(trigger);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('dismisses on an outside button or Escape without swallowing the outside action', () => {
  const outside = vi.fn();
  render(
    <><BottomMenuAlertPopover alerts={[alert()]}><span>64k / 1M</span></BottomMenuAlertPopover>
      <button onClick={outside}>Outside</button></>,
    { wrapper: IntlTestWrapper }
  );
  const trigger = screen.getByRole('button', { name: '64k / 1M' });
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
  fireEvent.click(screen.getByRole('button', { name: 'Outside' }));
  expect(outside).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('keeps the existing compact action and dismiss event, without repeating the action', () => {
  const compact = vi.fn(() => window.dispatchEvent(new CustomEvent(AppEvents.HIDE_ALERT_POPOVER)));
  render(<BottomMenuAlertPopover alerts={[alert(compact)]}><span>64k / 1M</span></BottomMenuAlertPopover>,
    { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: '64k / 1M' }));
  fireEvent.click(screen.getByRole('button', { name: 'Compact now' }));
  expect(compact).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
