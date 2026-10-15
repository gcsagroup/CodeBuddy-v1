import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
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
