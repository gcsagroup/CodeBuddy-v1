import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SessionIndicators } from './SessionIndicators';

describe('SessionIndicators', () => {
  it('uses a distinct named icon and tooltip for unread activity', () => {
    const { container } = render(
      <IntlTestWrapper>
        <SessionIndicators isStreaming={false} hasUnread hasError={false} />
      </IntlTestWrapper>
    );

    expect(screen.getByLabelText('Has new activity')).toHaveAttribute('title', 'Has new activity');
    expect(container.querySelector('.lucide-circle-dot')).toBeInTheDocument();
  });

  it('gives error and streaming icons matching accessible names and tooltips', () => {
    const view = render(
      <IntlTestWrapper>
        <SessionIndicators isStreaming hasUnread={false} hasError={false} />
      </IntlTestWrapper>
    );
    expect(screen.getByLabelText('Streaming')).toHaveAttribute('title', 'Streaming');

    view.rerender(
      <IntlTestWrapper>
        <SessionIndicators isStreaming={false} hasUnread={false} hasError />
      </IntlTestWrapper>
    );
    expect(screen.getByLabelText('Session encountered an error')).toHaveAttribute(
      'title',
      'Session encountered an error'
    );
  });
});
