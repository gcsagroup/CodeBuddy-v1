import type { ReactElement } from 'react';
import { fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findRestrictedReadonlySourceMessage,
  parseRestrictedReadonlyRequiredEvent,
  RestrictedReadonlyInline,
} from './RestrictedReadonlyInline';
import type { Message } from '../../types/message';
import { IntlTestWrapper } from '../../i18n/test-utils';

const render = (ui: ReactElement) => testingRender(ui, { wrapper: IntlTestWrapper });

const mocks = vi.hoisted(() => ({
  grantCodeProRestrictedReadonly: vi.fn(),
}));

vi.mock('../../acp/codeproPermissions', () => ({
  grantCodeProRestrictedReadonly: mocks.grantCodeProRestrictedReadonly,
}));

const event = {
  event: 'codepro.restricted_readonly_required' as const,
  sourceMessageId: 'message-1',
  writableRoot: null,
};

const sourceMessage: Message = {
  id: 'message-1',
  role: 'user',
  created: 1,
  content: [
    { type: 'text', text: 'analyze this' },
    { type: 'image', data: 'base64-image', mimeType: 'image/png' },
  ],
  metadata: { userVisible: true, agentVisible: true },
};

const notification = {
  notificationType: 'inlineMessage' as const,
  msg: '',
  data: event,
};

beforeEach(() => {
  mocks.grantCodeProRestrictedReadonly.mockReset();
  mocks.grantCodeProRestrictedReadonly.mockResolvedValue(undefined);
});

describe('parseRestrictedReadonlyRequiredEvent', () => {
  it('parses a valid event', () => {
    expect(parseRestrictedReadonlyRequiredEvent(event)).toEqual(event);
  });

  it('rejects malformed events', () => {
    expect(parseRestrictedReadonlyRequiredEvent(null)).toBeNull();
    expect(parseRestrictedReadonlyRequiredEvent({ event: 'other' })).toBeNull();
    expect(parseRestrictedReadonlyRequiredEvent({ ...event, sourceMessageId: '' })).toBeNull();
    expect(parseRestrictedReadonlyRequiredEvent({ ...event, writableRoot: 'D:\\' })).toBeNull();
  });
});

describe('findRestrictedReadonlySourceMessage', () => {
  it('finds the most recent matching user message', () => {
    const messages: Message[] = [
      {
        id: 'message-0',
        role: 'user',
        created: 0,
        content: [{ type: 'text', text: 'before' }],
        metadata: { userVisible: true, agentVisible: true },
      },
      sourceMessage,
    ];
    expect(findRestrictedReadonlySourceMessage(messages, event)).toBe(sourceMessage);
  });

  it('returns undefined when the source message is missing', () => {
    expect(findRestrictedReadonlySourceMessage([], event)).toBeUndefined();
  });
});

describe('RestrictedReadonlyInline', () => {
  it('does not grant permission until the user confirms', async () => {
    render(
      <RestrictedReadonlyInline
        messages={[sourceMessage]}
        notification={notification}
        sessionId="session-1"
        onResubmit={() => undefined}
      />
    );

    expect(mocks.grantCodeProRestrictedReadonly).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(mocks.grantCodeProRestrictedReadonly).toHaveBeenCalledTimes(1));
  });

  it('cancels without granting or resubmitting', () => {
    const onResubmit = vi.fn();
    render(
      <RestrictedReadonlyInline
        messages={[sourceMessage]}
        notification={notification}
        sessionId="session-1"
        onResubmit={onResubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.grantCodeProRestrictedReadonly).not.toHaveBeenCalled();
    expect(onResubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Authorization cancelled/)).toBeInTheDocument();
  });

  it('grants permission and resubmits the original message', async () => {
    const onResubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <RestrictedReadonlyInline
        messages={[sourceMessage]}
        notification={notification}
        sessionId="session-1"
        onResubmit={onResubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(mocks.grantCodeProRestrictedReadonly).toHaveBeenCalledTimes(1));
    expect(mocks.grantCodeProRestrictedReadonly).toHaveBeenCalledWith('session-1');
    await waitFor(() =>
      expect(onResubmit).toHaveBeenCalledWith({ msg: 'analyze this', images: [expect.any(Object)] })
    );
  });

  it('shows an error when the grant fails', async () => {
    mocks.grantCodeProRestrictedReadonly.mockRejectedValue(new Error('network error'));
    render(
      <RestrictedReadonlyInline
        messages={[sourceMessage]}
        notification={notification}
        sessionId="session-1"
        onResubmit={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(screen.getByText(/network error/)).toBeInTheDocument());
  });
});
