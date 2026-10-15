import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FriendlySchedulePicker } from '../FriendlySchedulePicker';
import { IntlTestWrapper } from '../../../i18n/test-utils';

describe('FriendlySchedulePicker', () => {
  it('explains runtime, missed-run, and test-before-enable behavior', () => {
    render(<FriendlySchedulePicker schedule={null} onChange={vi.fn()} isValid={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });
    expect(screen.getByText(/must remain running/i)).toBeInTheDocument();
    expect(screen.getByText(/Missed runs are not replayed/i)).toBeInTheDocument();
    expect(screen.getByText(/stays paused until its test run succeeds/i)).toBeInTheDocument();
  });
});
