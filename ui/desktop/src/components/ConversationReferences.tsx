import { MessageSquare, X } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { conversationMentions } from './conversationMention';

const messages = defineMessages({
  label: { id: 'conversationReferences.label', defaultMessage: 'Referenced conversations' },
  hint: {
    id: 'conversationReferences.hint',
    defaultMessage: 'Read-only background · Up to 3 conversations',
  },
  remove: { id: 'conversationReferences.remove', defaultMessage: 'Remove reference: {title}' },
});

export function ConversationReferences({
  text,
  onChange,
}: {
  text: string;
  onChange: (text: string) => void;
}) {
  const intl = useIntl();
  const references = conversationMentions(text);
  if (!references.length) return null;
  return (
    <div className="mx-3 mt-2 min-w-0" aria-label={intl.formatMessage(messages.label)}>
      <div className="flex flex-wrap gap-2">
        {references.map((reference) => (
          <button
            key={reference.start}
            type="button"
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border-primary bg-background-secondary px-2 py-1 text-xs text-text-secondary"
            title={reference.title}
            aria-label={intl.formatMessage(messages.remove, { title: reference.title })}
            onClick={() => onChange(text.slice(0, reference.start) + text.slice(reference.end))}
          >
            <MessageSquare className="size-3 shrink-0" />
            <span className="truncate">{reference.title}</span>
            <X className="size-3 shrink-0" />
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(messages.hint)}</p>
    </div>
  );
}
