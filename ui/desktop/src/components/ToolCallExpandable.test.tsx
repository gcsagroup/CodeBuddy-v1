import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import userEvent from '@testing-library/user-event';
import { ToolCallExpandable } from './ToolCallExpandable';

function renderExpandable(props: Partial<ComponentProps<typeof ToolCallExpandable>> = {}) {
  return render(
    <ToolCallExpandable label="运行测试" accessibleName="活动：运行测试" {...props}>
      <div>测试输出</div>
    </ToolCallExpandable>,
    { wrapper: IntlTestWrapper }
  );
}

describe('ToolCallExpandable', () => {
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
