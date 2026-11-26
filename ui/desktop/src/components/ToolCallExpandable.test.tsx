import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import userEvent from '@testing-library/user-event';
import { ToolCallExpandable } from './ToolCallExpandable';
import { ScrollFollowingContext } from './ui/scroll-follow-context';

function renderExpandable(props: Partial<ComponentProps<typeof ToolCallExpandable>> = {}) {
  return render(
    <ToolCallExpandable label="运行测试" accessibleName="活动：运行测试" {...props}>
      <div>测试输出</div>
    </ToolCallExpandable>,
    { wrapper: IntlTestWrapper }
  );
}

describe('ToolCallExpandable', () => {
  it('keeps process defaults closed while reading elsewhere and resets only at a new summary boundary', () => {
    const show = (settled: boolean) => (
      <ScrollFollowingContext.Provider value={false}>
        <ToolCallExpandable
          label="phase process"
          compact
          groupHeading
          live={!settled}
          autoExpandOnReading={false}
          collapseOnSettle={settled}
          resetOnSettle
        >
          <p>Detailed operations</p>
        </ToolCallExpandable>
      </ScrollFollowingContext.Provider>
    );
    const view = render(show(false));
    const toggle = screen.getByRole('button', { name: 'phase process' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('Detailed operations')).toBeVisible();
    view.rerender(show(true));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    view.rerender(show(true));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('stops live following immediately on upward wheel input and resumes only at the bottom', () => {
    const show = (label: string) => (
      <ToolCallExpandable label="scrolling work" compact groupHeading live isStartExpanded>
        <p>{label}</p>
      </ToolCallExpandable>
    );
    const view = render(show('First operation'));
    const viewport = screen.getByText('First operation').parentElement!;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 700;
    fireEvent.wheel(viewport, { deltaY: -60 });
    viewport.scrollTop = 500;
    // A new chunk may commit before the browser dispatches the scroll event.
    view.rerender(show('Second operation'));
    expect(viewport.scrollTop).toBe(500);
    fireEvent.scroll(viewport);
    view.rerender(show('Third operation'));
    expect(viewport.scrollTop).toBe(500);
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    view.rerender(show('Fourth operation'));
    expect(viewport.scrollTop).toBe(900);
  });

  it('does not scroll a selected passage away when live details grow', () => {
    const show = (extra: boolean) => (
      <ToolCallExpandable label="selected work" compact groupHeading live isStartExpanded>
        <p>Selected reasoning</p>
        {extra && <p>Next operation</p>}
      </ToolCallExpandable>
    );
    const view = render(show(false));
    const paragraph = screen.getByText('Selected reasoning');
    const viewport = paragraph.parentElement!;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 700;
    fireEvent.pointerDown(paragraph);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.addRange(range);
    fireEvent.pointerUp(paragraph);
    view.rerender(show(true));
    expect(viewport.scrollTop).toBe(700);
    selection.removeAllRanges();
  });

  it('resumes automatic folding after a reader returns to the latest output', () => {
    const show = (following: boolean, settled: boolean) => (
      <ScrollFollowingContext.Provider value={following}>
        <ToolCallExpandable
          label="temporary reading"
          live={!settled}
          isStartExpanded={!settled}
          collapseOnSettle={settled}
        >
          <p>Live operation details</p>
        </ToolCallExpandable>
      </ScrollFollowingContext.Provider>
    );
    const view = render(show(false, false));
    expect(screen.getByRole('button', { name: 'temporary reading' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    view.rerender(show(true, false));
    view.rerender(show(true, true));
    expect(screen.getByRole('button', { name: 'temporary reading' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
  it('keeps live work open when settlement arrives while the reader is inspecting it', () => {
    const viewFor = (settled: boolean) => (
      <ScrollFollowingContext.Provider value={false}>
        <ToolCallExpandable label="reading work" collapsible={settled} collapseOnSettle={settled}>
          <p>Current reading position</p>
        </ToolCallExpandable>
      </ScrollFollowingContext.Provider>
    );
    const view = render(viewFor(false));
    view.rerender(viewFor(true));
    expect(screen.getByRole('button', { name: 'reading work' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Current reading position')).toBeVisible();
  });
  it('keeps an independent header action outside the disclosure buttons and keyboard accessible', async () => {
    const user = userEvent.setup();
    let opened = 0;
    renderExpandable({ headerAction: <button onClick={() => opened++}>receipt.ts</button> });
    const toggle = screen.getByRole('button', { name: '活动：运行测试' });
    const file = screen.getByRole('button', { name: 'receipt.ts' });
    expect(file.closest('button')).toBe(file);
    expect(toggle.contains(file)).toBe(false);
    await user.click(file);
    expect(opened).toBe(1);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    file.focus();
    await user.keyboard('{Enter}');
    expect(opened).toBe(2);
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('folds only at the settlement transition, preserving later manual expansion and historical state', () => {
    const renderView = (settled: boolean) => (
      <ToolCallExpandable
        label="process"
        storageKey="settlement-fixture"
        isStartExpanded
        collapseOnSettle={settled}
      >
        <div>output</div>
      </ToolCallExpandable>
    );
    const view = render(renderView(false));
    const toggle = screen.getByRole('button', { name: 'process' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    view.rerender(renderView(true));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    view.rerender(renderView(true));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    view.unmount();
    render(renderView(true));
    expect(screen.getByRole('button', { name: 'process' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    window.sessionStorage.removeItem('codepro-operation:settlement-fixture');
  });
  it('is collapsed by default and exposes its state to assistive technology', () => {
    renderExpandable();

    const button = screen.getByRole('button', { name: '活动：运行测试' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('测试输出')).not.toBeInTheDocument();
  });

  it('expands and collapses from the native button', () => {
    renderExpandable();

    const button = screen.getByRole('button', { name: '活动：运行测试' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('测试输出')).toBeVisible();

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('测试输出')).not.toBeInTheDocument();
  });

  it('supports initial and forced expansion without losing user toggling', async () => {
    const { rerender } = renderExpandable({ isStartExpanded: true });
    const button = screen.getByRole('button', { name: '活动：运行测试' });
    expect(button).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <IntlTestWrapper>
        <ToolCallExpandable label="运行测试" accessibleName="活动：运行测试" isForceExpand>
          <div>测试输出</div>
        </ToolCallExpandable>
      </IntlTestWrapper>
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '活动：运行测试' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    );
  });
});

describe('tool display preference', () => {
  it('opens detailed history, stays open on completion, and applies setting changes after manual choices', async () => {
    let style = 'detailed';
    const mock = vi.spyOn(window.electron, 'getSetting').mockImplementation(async () => style);
    try {
      const show = (settled: boolean) => (
        <ToolCallExpandable
          compact
          respectToolDisplayStyle
          label="Preference history"
          storageKey="preference-regression"
          collapseOnSettle={settled}
          resetOnSettle
        >
          <p>Visible receipt</p>
        </ToolCallExpandable>
      );
      const view = render(show(false), { wrapper: IntlTestWrapper });
      const toggle = screen.getByRole('button', { name: 'Preference history' });
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
      view.rerender(show(true));
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      style = 'concise';
      fireEvent(window, new Event('responseStyleChanged'));
      await waitFor(() =>
        expect(window.sessionStorage.getItem('codepro-operation:preference-regression')).toBeNull()
      );
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      style = 'detailed';
      fireEvent(window, new Event('responseStyleChanged'));
      await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      view.unmount();
    } finally {
      mock.mockRestore();
      window.sessionStorage.removeItem('codepro-operation:preference-regression');
    }
  });
});
