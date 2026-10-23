import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';

const messages = defineMessages({
  back: { id: 'settingsMenu.back', defaultMessage: 'Back to menu' },
  unsaved: { id: 'promptsSettings.unsavedChanges', defaultMessage: 'You have unsaved changes' },
});

export default function SettingsMenu({
  items,
  visible = true,
}: {
  visible?: boolean;
  items: {
    id: string;
    title: string;
    description: string;
    icon: ReactNode;
    content: ReactNode;
    dirty?: boolean;
    keepAlive?: boolean;
    hideBack?: boolean;
  }[];
}) {
  const intl = useIntl();
  const id = useId();
  const [active, setActive] = useState<string | null>(null);
  const [visited, setVisited] = useState<string[]>([]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const headings = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (visible && active) headings.current.get(active)?.focus();
  }, [active, visible]);
  return (
    <div className="space-y-4 pb-4">
      <div
        hidden={active !== null}
        className="divide-y divide-border-subtle rounded-xl border border-border-subtle"
      >
        {items.map((item) => (
          <button
            key={item.id}
            ref={(node) => {
              if (node) buttons.current.set(item.id, node);
              else buttons.current.delete(item.id);
            }}
            type="button"
            aria-label={item.title}
            aria-describedby={`${id}-${item.id}`}
            className="flex w-full items-center gap-4 px-4 py-4 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-background-muted/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-default"
            onClick={() => {
              setVisited((current) =>
                current.includes(item.id) ? current : [...current, item.id]
              );
              setActive(item.id);
            }}
          >
            <span className="shrink-0 text-text-secondary">{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text-primary">{item.title}</span>
              <span id={`${id}-${item.id}`} className="mt-1 block text-xs text-text-secondary">
                {item.dirty ? intl.formatMessage(messages.unsaved) : item.description}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
          </button>
        ))}
      </div>
      {items
        .filter(
          (item) => (item.keepAlive && visited.includes(item.id)) || (visible && active === item.id)
        )
        .map((item) => (
          // Preserve drafts only where requested. Modal owners unmount when hidden,
          // so late async results cannot open a portal over another settings page.
          <section
            key={item.id}
            hidden={!visible || active !== item.id}
            aria-label={item.title}
            className="space-y-4"
          >
            <h3
              className="sr-only"
              tabIndex={-1}
              ref={(node) => {
                if (node) headings.current.set(item.id, node);
                else headings.current.delete(item.id);
              }}
            >
              {item.title}
            </h3>
            {!item.hideBack && (
              <button
                type="button"
                className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary"
                onClick={() => {
                  setActive(null);
                  window.requestAnimationFrame(() => buttons.current.get(item.id)?.focus());
                }}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden />
                {intl.formatMessage(messages.back)}
              </button>
            )}
            {item.content}
          </section>
        ))}
    </div>
  );
}
