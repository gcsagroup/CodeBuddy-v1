import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';

const messages = defineMessages({
  back: { id: 'settingsMenu.back', defaultMessage: 'Back to menu' },
  unsaved: { id: 'promptsSettings.unsavedChanges', defaultMessage: 'You have unsaved changes' },
});

export default function SettingsMenu({
  items,
  visible = true,
  groups,
  layout = 'grid',
}: {
  visible?: boolean;
  layout?: 'grid' | 'cards';
  groups?: { title: string; ids: string[] }[];
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
  const renderEntry = (item: (typeof items)[number]) => (
    <button
      key={item.id}
      data-entry={item.id}
      ref={(node) => {
        if (node) buttons.current.set(item.id, node);
        else buttons.current.delete(item.id);
      }}
      type="button"
      aria-label={item.title}
      aria-describedby={`${id}-${item.id}`}
      className={cn(
        'group w-full min-w-0 rounded-xl border border-border-primary bg-background-primary text-left transition-colors hover:border-border-info hover:bg-background-secondary focus-visible:outline-2 focus-visible:outline-border-info',
        layout === 'cards'
          ? 'grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_1fr] items-center gap-x-3 gap-y-3 p-4'
          : 'flex min-h-20 items-start gap-3 p-4'
      )}
      onClick={() => {
        setVisited((current) => (current.includes(item.id) ? current : [...current, item.id]));
        setActive(item.id);
      }}
    >
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-background-secondary text-text-primary group-hover:text-text-info"
      >
        {item.icon}
      </span>
      <span className={layout === 'cards' ? 'contents' : 'min-w-0 flex-1'}>
        <span className="block min-w-0 text-sm font-semibold text-text-primary">{item.title}</span>
        <span
          id={`${id}-${item.id}`}
          className={cn(
            'block text-xs leading-relaxed text-text-secondary',
            layout === 'cards' ? 'col-span-3 self-start border-t border-border-primary pt-3' : 'mt-1'
          )}
        >
          {item.dirty ? intl.formatMessage(messages.unsaved) : item.description}
        </span>
      </span>
      <ChevronRight
        className={cn('size-4 shrink-0 text-text-secondary', layout === 'cards' ? 'col-start-3 row-start-1' : 'mt-1')}
        aria-hidden
      />
    </button>
  );
  return (
    <div className="@container space-y-4 pb-4">
      {groups ? (
        <div hidden={active !== null} className="runtime-overview">
          {groups.map((group, index) => (
            <section
              key={group.ids[0]}
              className={index === 0 ? 'runtime-feature' : 'runtime-group'}
            >
              <h3>{group.title}</h3>
              <div className="runtime-entries">
                {group.ids
                  .map((key) => items.find((item) => item.id === key))
                  .filter((item) => item !== undefined)
                  .map(renderEntry)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div
          hidden={active !== null}
          className={
            layout === 'cards'
              ? 'grid grid-cols-1 gap-3 @min-[36rem]:grid-cols-2'
              : 'settings-entry-grid grid grid-cols-1 gap-3 @min-[36rem]:grid-cols-2'
          }
        >
          {items.map(renderEntry)}
        </div>
      )}
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
            data-detail={item.id}
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
