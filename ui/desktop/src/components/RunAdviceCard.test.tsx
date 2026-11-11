import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { RunAdviceCard } from './RunAdviceCard';

describe('RunAdviceCard', () => {
  it('is passive until clicked; dismisses only this attempt and never retries a task', () => {
    const stop = vi.fn();
    const view = render(
      <RunAdviceCard
        advice={{ kind: 'tools', count: 3 }}
        attemptId="a"
        stopping={false}
        onStopAndChoose={stop}
        statusMessage="Retry 3/5: connection unavailable"
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByText(/permission or environment/)).toBeVisible();
    expect(screen.getByText(/Retry 3\/5/)).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/Retry 3\/5/)).toBeVisible();
    expect(screen.getByText(/send the task again/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Retry 3/5');
    view.rerender(
      <RunAdviceCard
        advice={{ kind: 'responses', count: 4 }}
        attemptId="a"
        stopping={false}
        onStopAndChoose={stop}
      />
    );
    expect(screen.queryByRole('button')).toBeNull();
    view.rerender(
      <RunAdviceCard
        advice={{ kind: 'responses', count: 3 }}
        attemptId="b"
        stopping={false}
        onStopAndChoose={stop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop and choose a model' }));
    expect(stop).toHaveBeenCalledTimes(1);
    view.rerender(
      <RunAdviceCard
        advice={{ kind: 'responses', count: 3 }}
        attemptId="b"
        stopping
        onStopAndChoose={stop}
      />
    );
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });
});
