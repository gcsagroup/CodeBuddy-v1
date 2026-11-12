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
    <main className="h-full overflow-y-auto bg-background-primary px-5 pb-8 pt-14 text-text-primary sm:px-10">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="app-page-heading flex items-center gap-2"><CalendarClock className="size-5" aria-hidden="true" />{intl.formatMessage(m.title)}</h1>
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
        <div
          role="tablist"
          aria-label={intl.formatMessage(m.title)}
          className="mb-4 flex gap-3 text-sm"
        >
          {(['all', 'active', 'paused', 'inactive'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-xl px-3 py-1.5 ${filter === value ? 'bg-background-secondary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {intl.formatMessage(m[value])}
            </button>
          ))}
        </div>
        <div className="mb-4 flex h-10 items-center gap-2 rounded-xl border border-border-primary px-3 text-text-secondary">
          <Search className="size-4 shrink-0" />
          <input
            aria-label={intl.formatMessage(m.search)}
            placeholder={intl.formatMessage(m.search)}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
          />
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
        <div className="space-y-1">
          {visible.map((record) => (
            <button
              key={record.id}
              type="button"
              onClick={() => openNativeSchedule(record.id)}
              className="flex w-full gap-3 rounded-xl px-3 py-4 text-left hover:bg-background-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-primary"
            >
              <Clock3 className="mt-0.5 size-4 shrink-0 text-text-secondary" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{record.title}</div>
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
