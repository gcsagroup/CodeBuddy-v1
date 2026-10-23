import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ActionRequired } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import ElicitationRequest from './ElicitationRequest';

const actionRequiredContent = {
  type: 'actionRequired',
  data: {
    actionType: 'elicitation',
    id: 'elicitation-1',
    message: 'Need more information',
    requested_schema: {
      type: 'object',
      properties: {},
    },
  },
} as ActionRequired & { type: 'actionRequired' };

type SubmitElicitationResponse = (
  elicitationId: string,
  userData: Record<string, unknown>,
  action?: 'accept' | 'cancel'
) => Promise<boolean>;

function renderElicitationRequest(onSubmit: SubmitElicitationResponse) {
  return render(
    <ElicitationRequest
      isCancelledMessage={false}
      isClicked={false}
      actionRequiredContent={actionRequiredContent}
      onSubmit={onSubmit}
    />,
    { wrapper: IntlTestWrapper }
  );
}

describe('ElicitationRequest', () => {
  it('keeps the native timed form answerable after the wait and shows the late-answer phase', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(true);
    const content = {
      ...actionRequiredContent,
      data: {
        ...actionRequiredContent.data,
        nativeQuestion: true,
        continued: true,
        expiresAt: Date.now() - 1000,
      },
    };
    render(
      <ElicitationRequest
        standalone
        isCancelledMessage={false}
        isClicked={false}
        actionRequiredContent={content}
        onSubmit={onSubmit}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByText('Not answered yet. You can still reply.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onSubmit).toHaveBeenCalledWith('elicitation-1', {});
  });
  it('keeps the original deadline when remounted and never submits an answer on timeout', async () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn<SubmitElicitationResponse>();
      const content = {
        ...actionRequiredContent,
        data: { ...actionRequiredContent.data, expiresAt: Date.now() + 300_000 },
      };
      const element = (
        <ElicitationRequest
          standalone
          isCancelledMessage={false}
          isClicked={false}
          actionRequiredContent={content}
          onSubmit={onSubmit}
        />
      );
      const first = render(element, { wrapper: IntlTestWrapper });
      await act(() => vi.advanceTimersByTimeAsync(290_000));
      first.unmount();
      render(element, { wrapper: IntlTestWrapper });
      expect(screen.getByText(/0:10 remaining/)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(screen.getByText(/This request has expired/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows submitted state when the response is accepted', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(true);

    renderElicitationRequest(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(onSubmit).toHaveBeenCalledWith('elicitation-1', {});
    expect(await screen.findByText('Information submitted')).toBeInTheDocument();
  });

  it('waits for confirmation before showing submitted state', async () => {
    let resolveSubmission: (value: boolean) => void = () => {};
    const submission = new Promise<boolean>((resolve) => {
      resolveSubmission = resolve;
    });
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockReturnValue(submission);

    renderElicitationRequest(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
    expect(screen.queryByText('Information submitted')).not.toBeInTheDocument();

    await act(async () => {
      resolveSubmission(true);
      await submission;
    });
    expect(await screen.findByText('Information submitted')).toBeInTheDocument();
  });

  it('keeps the request actionable when no ACP request is pending', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(false);

    renderElicitationRequest(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This request is no longer active. The extension will need to ask again.'
    );
    expect(screen.queryByText('Information submitted')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
  });

  it('sends an explicit cancel response and shows cancelled state', async () => {
    const onSubmit = vi.fn<SubmitElicitationResponse>().mockResolvedValue(true);

    renderElicitationRequest(onSubmit);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSubmit).toHaveBeenCalledWith('elicitation-1', {}, 'cancel');
    expect(await screen.findByText('Information request was cancelled.')).toBeInTheDocument();
  });
});
