import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { TechnicalValue } from './TechnicalValue';

const technicalValue =
  'pnpm exec vitest run C:\\projects\\code-buddy\\src\\very-long-folder\\feature.test.ts --reporter=verbose';

describe('TechnicalValue', () => {
  it('is truncated by default and expands from the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <IntlTestWrapper>
        <TechnicalValue value={technicalValue} label="Test command" />
      </IntlTestWrapper>
    );

    const toggle = screen.getByRole('button', { name: 'Expand Test command' });
    const value = screen.getByText(technicalValue);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('title', 'Expand Test command');
    expect(value).toHaveClass('whitespace-pre-wrap', 'break-all');

    toggle.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Collapse Test command' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(value).toHaveTextContent(technicalValue);
  });

  it('copies the exact original value and announces localized feedback', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <IntlTestWrapper>
        <TechnicalValue value={technicalValue} label="Test command" />
      </IntlTestWrapper>
    );

    const copy = screen.getByRole('button', { name: 'Copy Test command' });
    expect(copy).toHaveAttribute('title', 'Copy Test command');
    await user.click(copy);

    expect(writeText).toHaveBeenCalledWith(technicalValue);
    expect(screen.getByRole('status')).toHaveTextContent('Test command copied');
  });
});
