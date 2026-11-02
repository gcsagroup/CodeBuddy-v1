import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';
import { acpListSessions, type SessionListItem } from '../../acp/sessions';
import { defineMessages, useIntl } from '../../i18n';
import type { WorkspaceMode } from '../../utils/navigationUtils';
import { Input } from '../ui/input';

const i18n = defineMessages({
  label: { id: 'scheduleChat.label', defaultMessage: 'Follow-up chat' },
  choose: { id: 'scheduleChat.choose', defaultMessage: 'Choose a chat' },
  search: { id: 'scheduleChat.search', defaultMessage: 'Search chats' },
  empty: { id: 'scheduleChat.empty', defaultMessage: 'No chats found' },
  error: { id: 'scheduleChat.error', defaultMessage: 'Could not read chats. Reopen to retry.' },
  loading: { id: 'scheduleModel.loading', defaultMessage: 'Reading…' },
  more: { id: 'scheduleChat.more', defaultMessage: 'Load more' },
});

interface Props {
  value?: { id: string; name: string };
  onChange: (chat: { id: string; name: string }) => void;
  workspaceMode: WorkspaceMode;
}

export function ScheduleChatPicker({ value, onChange, workspaceMode }: Props) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [chats, setChats] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setFailed(false);
    const timer = setTimeout(
      () => {
        void acpListSessions(cursor, { keyword: query }, workspaceMode)
          .then((page) => {
            if (!active) return;
            const available = page.sessions.filter((chat) => !chat.archivedAt);
            setChats((previous) => (cursor ? [...previous, ...available] : available));
            setNextCursor(page.nextCursor);
          })
          .catch(() => {
            if (active) setFailed(true);
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query ? 200 : 0
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, query, cursor, workspaceMode]);

  return (
    <div className="flex min-h-12 items-center justify-between gap-4 rounded-2xl border border-border-primary px-4 py-2">
      <span className="shrink-0 text-sm text-text-primary">{intl.formatMessage(i18n.label)}</span>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setQuery('');
            setCursor(null);
            setChats([]);
          }
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={intl.formatMessage(i18n.label)}
            className="flex min-w-0 items-center gap-2 rounded-lg py-1 text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
          >
            <span className="truncate">{value?.name ?? intl.formatMessage(i18n.choose)}</span>
            <ChevronDown className="size-3.5 shrink-0" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-[100] w-72 max-w-[calc(100vw-3rem)] rounded-2xl border border-border-primary bg-background-primary p-2 text-sm text-text-primary shadow-lg outline-none"
          >
            <Input
              aria-label={intl.formatMessage(i18n.search)}
              placeholder={intl.formatMessage(i18n.search)}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(null);
                setNextCursor(null);
                setChats([]);
              }}
              className="mb-1 h-8 rounded-lg text-sm"
            />
            <div className="max-h-56 overflow-y-auto">
              {!failed &&
                chats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
                    onClick={() => {
                      onChange({ id: chat.id, name: chat.name });
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{chat.name}</span>
                    {value?.id === chat.id && <Check className="size-3.5 shrink-0" />}
                  </button>
                ))}
              {(loading || failed || !chats.length) && (
                <p
                  role={failed ? 'alert' : 'status'}
                  className="px-3 py-2 text-xs text-text-secondary"
                >
                  {intl.formatMessage(loading ? i18n.loading : failed ? i18n.error : i18n.empty)}
                </p>
              )}
              {nextCursor && !failed && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => setCursor(nextCursor)}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs text-text-secondary hover:bg-background-secondary disabled:opacity-50"
                >
                  {intl.formatMessage(i18n.more)}
                </button>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
