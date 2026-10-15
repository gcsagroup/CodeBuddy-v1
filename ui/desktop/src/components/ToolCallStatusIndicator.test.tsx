import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { expect, it } from 'vitest';
import { ToolCallStatusIndicator } from './ToolCallStatusIndicator';

it('announces warning without an ongoing animation or success color', () => {
  render(
    <IntlProvider locale="en" messages={{}}>
      <ToolCallStatusIndicator status="warning" />
    </IntlProvider>
  );
  const indicator = screen.getByLabelText('Tool status: warning');
  expect(indicator).toHaveClass('bg-yellow-500');
  expect(indicator).not.toHaveClass('animate-pulse');
  expect(indicator).not.toHaveClass('bg-green-500');
});
