import { useRef, useState } from 'react';
import { GitBranch, LoaderCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { acpForkSession } from '../acp/sessions';
import { AppEvents } from '../constants/events';
import { defineMessages, useIntl } from '../i18n';
import { isConversationTurnStart, type Message } from '../types/message';
import { errorMessage } from '../utils/conversionUtils';

const m = defineMessages({
  branch: { id: 'conversationBranch.action', defaultMessage: 'Branch after this turn' },
  failed: { id: 'sessionActionsHeader.duplicateFailed', defaultMessage: 'Failed to branch conversation: {error}' },
  boundary: { id: 'conversationBranch.boundary', defaultMessage: 'This message has changed. Reload the conversation before branching.' },
});

export function ConversationBranchButton({ sessionId, message, messages }: {
  sessionId: string; message: Message; messages: Message[];
}) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const branch = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const index = messages.findIndex((item) => item === message || (!!message.id && item.id === message.id));
      const next = messages.slice(index + 1).find(isConversationTurnStart);
      if (index < 0 || (next && !next.id)) throw new Error(intl.formatMessage(m.boundary));
      const id = await acpForkSession(sessionId, undefined, next?.id ?? undefined);
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_FORKED, { detail: { newSessionId: id } }));
    } catch (error) {
      toast.error(intl.formatMessage(m.failed, { error: errorMessage(error) }));
    } finally { pending.current = false; setBusy(false); }
  };
  return <button type="button" disabled={busy} onClick={() => void branch()}
    aria-label={intl.formatMessage(m.branch)} title={intl.formatMessage(m.branch)}
    className="rounded-md p-1 text-text-secondary hover:bg-background-secondary hover:text-text-primary focus-visible:ring-1 focus-visible:ring-border-active disabled:opacity-50">
    {busy ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> : <GitBranch className="size-3.5" />}
  </button>;
}
