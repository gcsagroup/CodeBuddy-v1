import { useState } from 'react';
import type { Message, SystemNotificationContent, UserInput } from '../../types/message';
import { grantCodeProRestrictedReadonly } from '../../acp/codeproPermissions';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  cancelled: {
    id: 'restrictedReadonly.cancelled',
    defaultMessage: 'Authorization cancelled. The read-only analysis was not run.',
  },
  complete: {
    id: 'restrictedReadonly.complete',
    defaultMessage: 'Authorized. Resuming the read-only analysis…',
  },
  capabilityRequired: {
    id: 'restrictedReadonly.capabilityRequired',
    defaultMessage:
      'This conversation has no bound workspace. This read-only analysis needs restricted system access.',
  },
  continuesReadOnly: {
    id: 'restrictedReadonly.continuesReadOnly',
    defaultMessage: 'After approval, the Agent will continue without modifying any files.',
  },
  grantFailed: {
    id: 'restrictedReadonly.grantFailed',
    defaultMessage: 'Authorization failed',
  },
  granting: { id: 'restrictedReadonly.granting', defaultMessage: 'Authorizing…' },
  allow: { id: 'restrictedReadonly.allow', defaultMessage: 'Allow' },
  cancel: { id: 'restrictedReadonly.cancel', defaultMessage: 'Cancel' },
});

export interface RestrictedReadonlyRequiredEvent {
  event: 'codepro.restricted_readonly_required';
  sourceMessageId: string;
  writableRoot: null;
}

export function parseRestrictedReadonlyRequiredEvent(
  data: unknown
): RestrictedReadonlyRequiredEvent | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (
    value.event !== 'codepro.restricted_readonly_required' ||
    typeof value.sourceMessageId !== 'string' ||
    !value.sourceMessageId ||
    value.writableRoot !== null
  ) {
    return null;
  }
  return value as unknown as RestrictedReadonlyRequiredEvent;
}

export function findRestrictedReadonlySourceMessage(
  messages: Message[],
  event: RestrictedReadonlyRequiredEvent
): Message | undefined {
  return messages
    .slice()
    .reverse()
    .find((message) => message.role === 'user' && message.id === event.sourceMessageId);
}

function messageToUserInput(message: Message): UserInput {
  const text = message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
  const images = message.content
    .filter((content) => content.type === 'image')
    .map((content) => ({ data: content.data, mimeType: content.mimeType }));
  return { msg: text, images };
}

interface RestrictedReadonlyInlineProps {
  messages: Message[];
  notification: SystemNotificationContent;
  sessionId: string;
  onResubmit: (input: UserInput) => void | Promise<void>;
}

export function RestrictedReadonlyInline({
  messages,
  notification,
  sessionId,
  onResubmit,
}: RestrictedReadonlyInlineProps) {
  const intl = useIntl();
  const event = parseRestrictedReadonlyRequiredEvent(notification.data);
  const [state, setState] = useState<'idle' | 'granting' | 'complete' | 'cancelled' | 'failed'>(
    'idle'
  );
  const [error, setError] = useState<string | null>(null);

  if (!event) return null;

  const sourceMessage = findRestrictedReadonlySourceMessage(messages, event);

  if (state === 'cancelled') {
    return <div>{intl.formatMessage(i18n.cancelled)}</div>;
  }

  if (state === 'complete') {
    return <div>{intl.formatMessage(i18n.complete)}</div>;
  }

  return (
    <div className="rounded-md border border-border bg-background-muted p-3 text-sm">
      <p>{intl.formatMessage(i18n.capabilityRequired)}</p>
      <p className="mt-1">{intl.formatMessage(i18n.continuesReadOnly)}</p>
      {error && <p role="alert">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="rounded bg-background-primary px-3 py-1.5 text-sm text-text-primary hover:bg-background-primary-hover disabled:opacity-50"
          disabled={state !== 'idle' || !sourceMessage}
          onClick={() => {
            setState('granting');
            setError(null);
            void grantCodeProRestrictedReadonly(sessionId)
              .then(() => {
                setState('complete');
                if (sourceMessage) {
                  void onResubmit(messageToUserInput(sourceMessage));
                }
              })
              .catch((reason) => {
                const message = reason instanceof Error ? reason.message : String(reason);
                setError(message || intl.formatMessage(i18n.grantFailed));
                setState('failed');
              });
          }}
        >
          {state === 'granting'
            ? intl.formatMessage(i18n.granting)
            : intl.formatMessage(i18n.allow)}
        </button>
        <button
          type="button"
          className="rounded border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-background-secondary disabled:opacity-50"
          disabled={state === 'granting'}
          onClick={() => setState('cancelled')}
        >
          {intl.formatMessage(i18n.cancel)}
        </button>
      </div>
    </div>
  );
}
