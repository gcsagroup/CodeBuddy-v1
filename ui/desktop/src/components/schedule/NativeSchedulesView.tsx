import { WorkspacePageTitle } from '../Layout/WorkspacePageTitle';
import { buttonVariants } from '../ui/button';
import { useMemo, useState } from 'react';
import { CalendarClock, Clock3, Plus, Search } from 'lucide-react';
import { useIntl } from '../../i18n';
import { useNavigation } from '../../hooks/useNavigation';
import {
  useNativeSchedules,
  refreshNativeSchedules,
} from '../../acp/nativeSchedules';
import { nativeScheduleMessages as m } from './nativeScheduleMessages';
import { formatNativeSchedule } from './nativeScheduleFormat';
import { openNativeSchedule } from './scheduleEvents';

export default function NativeSchedulesView(_props: { onClose: () => void }) {
  const intl = useIntl(),
    navigate = useNavigation();
  const catalog = useNativeSchedules();
  const [filter, setFilter] = useState<'all' | 'active' | 'paused' | 'inactive'>('all');
  const [query, setQuery] = useState('');
  const visible = useMemo(
    () =>
      catalog.records.filter(
        (record) =>
          (filter === 'all' || record.status === filter) &&
          (!query.trim() ||
            `${record.title} ${record.prompt}`
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()))
      ),
    [catalog.records, filter, query]
  );
  return (
    <main className="h-full overflow-y-auto bg-background-primary px-4 py-6 text-text-primary sm:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border-primary pb-4">
          <WorkspacePageTitle icon={CalendarClock}>{intl.formatMessage(m.title)}</WorkspacePageTitle>
          <button
            type="button"
            onClick={() =>
              navigate('pair', {
                initialMessage: { msg: intl.formatMessage(m.newPrompt), images: [] },
                noAutoSubmit: true,
                draftOnly: true,
              })
            }
            className={buttonVariants({ size: 'sm' })}
          >
            <Plus className="size-4" />
            {intl.formatMessage(m.new)}
          </button>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label={intl.formatMessage(m.title)}
            className="flex max-w-full flex-wrap gap-1 rounded-lg bg-background-secondary p-1 text-sm"
          >
            {(['all', 'active', 'paused', 'inactive'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
                className={`rounded-md px-3 py-1.5 ${filter === value ? 'bg-background-primary font-medium text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {intl.formatMessage(m[value])}
              </button>
            ))}
          </div>
          <div className="flex h-9 min-w-40 flex-1 items-center gap-2 rounded-lg border border-border-primary px-3 text-text-secondary focus-within:ring-1 focus-within:ring-ring">
            <Search className="size-4 shrink-0" />
            <input
              aria-label={intl.formatMessage(m.search)}
              placeholder={intl.formatMessage(m.search)}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
            />
          </div>
        </div>
        {catalog.status === 'error' && (
          <div role="alert" className="mb-3 text-sm text-text-danger">
            {catalog.error}{' '}
            <button
              type="button"
              onClick={() => void refreshNativeSchedules()}
              className="underline"
            >
              {intl.formatMessage(m.retry)}
            </button>
          </div>
        )}
        {catalog.status === 'loading' && !catalog.records.length && (
          <p role="status" className="px-3 py-5 text-sm text-text-secondary">
            {intl.formatMessage(m.loading)}
          </p>
        )}
        {catalog.status === 'ready' && !visible.length && (
          <p className="px-3 py-5 text-sm text-text-secondary">{intl.formatMessage(m.empty)}</p>
        )}
        <div className="divide-y divide-border-primary overflow-hidden rounded-xl has-[button]:border has-[button]:border-border-primary">
          {visible.map((record) => (
            <button
              key={record.id}
              type="button"
              onClick={() => openNativeSchedule(record.id)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background-secondary"><Clock3 className="size-4 text-text-secondary" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-medium">{record.title}</div>
                <div className="mt-1 text-xs leading-5 text-text-secondary">
                  {formatNativeSchedule(record, intl)} ·{' '}
                  {record.status === 'active'
                    ? intl.formatMessage(m.next, {
                        time: new Date(record.scheduledAt).toLocaleString(intl.locale),
                      })
                    : intl.formatMessage(record.status === 'paused' ? m.paused : m.inactive)}
                </div>
              </div>
            </button>
          ))}
        </div>

      </div>
    </main>
  );
}
