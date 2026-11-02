import { monthlyCalendar } from './nativeScheduleCalendar';
import { ScheduleDayPicker } from './ScheduleDayPicker';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useNavigation } from '../../hooks/useNavigation';
import { acpGetSessionListItem } from '../../acp/sessions';
import { Check, ChevronDown, Clock3, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../ui/dropdown-menu';
import { useIntl } from '../../i18n';
import { cn } from '../../utils';
import {
  useNativeSchedules,
  refreshNativeSchedules,
  nativeScheduleRecord,
  updateNativeSchedule,
  deleteNativeSchedule,
  setNativeSchedulePaused,
  readNativeScheduleHistory,
  type ScheduleCatalogEntry,
  type ScheduleUpdateRequest,
} from '../../acp/nativeSchedules';
import { nativeScheduleMessages as m } from './nativeScheduleMessages';
import { ScheduleTimeZonePicker } from './ScheduleTimeZonePicker';
import { ScheduleTimePicker } from './ScheduleTimePicker';

function localTimestamp(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
function draftOf(record: ScheduleCatalogEntry) {
  const monthly = monthlyCalendar(record);
  const seconds = record.kind === 'every' ? record.everySeconds : 60;
  const unit = seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
  return {
    title: record.title,
    prompt: record.prompt,
    kind: (monthly
      ? 'monthly'
      : record.kind === 'after'
        ? 'at'
        : record.kind === 'weekly' && record.weekdays.join(',') === '1,2,3,4,5'
          ? 'workdays'
          : record.kind) as string,
    interval: String(seconds / unit),
    intervalUnit: String(unit),
    time:
      monthly?.time ??
      (record.kind === 'daily' || record.kind === 'weekly' ? record.time : '09:00:00'),
    monthDays: monthly?.days.join(',') ?? '1',
    zone:
      record.kind === 'daily' || record.kind === 'weekly' || record.kind === 'cron'
        ? record.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: record.kind === 'weekly' ? record.weekdays.join(',') : '1',
    at: localTimestamp(record.scheduledAt),
    expression: record.kind === 'cron' ? record.expression : '0 9 * * *',
  };
}
const fieldClass =
  'min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-right text-sm outline-none hover:border-border-primary focus:border-border-secondary focus:text-left disabled:opacity-50';

export function NativeScheduleDetails({ id, onClose }: { id: string; onClose: () => void }) {
  const intl = useIntl();
  const navigate = useNavigation();
  const location = useLocation();
  const catalog = useNativeSchedules();
  const record = catalog.records.find((entry) => entry.id === id);
  const linkedSessionId = record?.sessionId;
  const isLinkedChat =
    (location.pathname === '/pair' || location.pathname === '/codepro/pair') &&
    new URLSearchParams(location.search).get('resumeSessionId') === linkedSessionId;
  const [availableLinkedSessionId, setAvailableLinkedSessionId] = useState<string>();
  useEffect(() => {
    let current = true;
    setAvailableLinkedSessionId(undefined);
    if (linkedSessionId && !isLinkedChat) {
      void acpGetSessionListItem(linkedSessionId)
        .then((session) => {
          if (current && !session.archivedAt) setAvailableLinkedSessionId(linkedSessionId);
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [linkedSessionId, isLinkedChat]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (record?.status !== 'active') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [record?.status]);
  const [tab, setTab] = useState<'rule' | 'records'>('rule');
  const [base, setBase] = useState<ScheduleCatalogEntry>();
  const [draft, setDraft] = useState<ReturnType<typeof draftOf>>();
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [history, setHistory] = useState<Awaited<ReturnType<typeof readNativeScheduleHistory>>>();
  const historyVersion = useRef(0);
  const [historyBusy, setHistoryBusy] = useState(false);
  useEffect(() => {
    if (record && !dirty) {
      setBase(record);
      setDraft(draftOf(record));
    }
  }, [record, dirty]);
  useEffect(() => {
    if (tab !== 'records' || !record) return;
    const version = ++historyVersion.current;
    let current = true;
    setHistoryBusy(true);
    setError('');
    void readNativeScheduleHistory(record)
      .then((value) => {
        if (current && version === historyVersion.current) setHistory(value);
      })
      .catch((value) => {
        if (current) setError(String(value));
      })
      .finally(() => {
        if (current) setHistoryBusy(false);
      });
    return () => {
      current = false;
    };
  }, [tab, record]);
  const edit = (key: keyof NonNullable<typeof draft>, value: string) => {
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous));
    setDirty(true);
    setError('');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!base || !draft) return;
    setBusy(true);
    setError('');
    try {
      let change: ScheduleUpdateRequest['change'];
      if (draft.kind === 'every') {
        const seconds = Number(draft.interval) * Number(draft.intervalUnit);
        if (!Number.isSafeInteger(seconds) || seconds < 60) {
          setError(intl.formatMessage(m.invalidInterval));
          return;
        }
        change = { kind: 'every', every_seconds: seconds };
      } else if (draft.kind === 'monthly') {
        const [hour, minute] = draft.time.split(':');
        change = {
          kind: 'cron',
          cron: {
            expression: `${Number(minute)} ${Number(hour)} ${draft.monthDays} * *`,
            time_zone: draft.zone,
          },
        };
      } else if (draft.kind === 'daily')
        change = { kind: 'daily', daily: { time: draft.time, time_zone: draft.zone } };
      else if (draft.kind === 'weekly' || draft.kind === 'workdays')
        change = {
          kind: 'weekly',
          weekly: {
            time: draft.time,
            time_zone: draft.zone,
            weekdays:
              draft.kind === 'workdays'
                ? [1, 2, 3, 4, 5]
                : draft.days.split(',').map((value) => Number(value.trim())),
          },
        };
      else if (draft.kind === 'cron')
        change = { kind: 'cron', cron: { expression: draft.expression, time_zone: draft.zone } };
      else change = { kind: 'at', at: new Date(draft.at).toISOString() };
      const value = await updateNativeSchedule({
        id: base.id,
        sessionId: base.sessionId,
        expected: nativeScheduleRecord(base),
        title: draft.title,
        prompt: draft.prompt,
        // Native text-only updates preserve the already scheduled occurrence.
        ...(JSON.stringify({ ...draft, title: base.title, prompt: base.prompt }) !==
        JSON.stringify(draftOf(base))
          ? { change }
          : {}),
      });
      if ('record' in value) setDirty(false);
      else setError('message' in value ? value.message : intl.formatMessage(m.conflict));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const togglePaused = async () => {
    if (!record) return;
    setBusy(true);
    setError('');
    try {
      const value = await setNativeSchedulePaused(record, record.status !== 'paused');
      if (value.code) setError(intl.formatMessage(m.conflict));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!record || !window.confirm(intl.formatMessage(m.confirmRemove))) return;
    setBusy(true);
    setError('');
    try {
      const value = await deleteNativeSchedule(record);
      if (value.deleted) onClose();
      else setError(intl.formatMessage(m.missing));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      data-schedule-panel
      className="flex h-full min-h-0 min-w-0 flex-col bg-background-primary text-text-primary"
      aria-label={intl.formatMessage(m.title)}
    >
      <header className="flex shrink-0 items-center gap-4 border-b border-border-primary px-4 py-3 text-sm">
        <div role="tablist" className="flex min-w-0 flex-1 gap-4">
          {(['rule', 'records'] as const).map((value) => (
            <button
              type="button"
              role="tab"
              key={value}
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`border-b-2 py-1 ${tab === value ? 'border-blue-500 text-blue-500' : 'border-transparent text-text-secondary'}`}
            >
              {intl.formatMessage(m[value])}
            </button>
          ))}
        </div>
        {record && !isLinkedChat && (
          <button
            type="button"
            disabled={availableLinkedSessionId !== linkedSessionId}
            onClick={() => {
              navigate('pair', { resumeSessionId: record.sessionId });
              onClose();
            }}
            title={
              availableLinkedSessionId !== linkedSessionId
                ? intl.formatMessage(m.unavailable)
                : undefined
            }
            className="shrink-0 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            {intl.formatMessage(m.linked)}
          </button>
        )}
        <button
          type="button"
          aria-label={intl.formatMessage(m.close)}
          onClick={onClose}
          className="rounded-lg p-1 text-text-secondary hover:bg-background-secondary"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5">
        {catalog.status === 'loading' && !record && (
          <p role="status">{intl.formatMessage(m.loading)}</p>
        )}
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
        {catalog.status === 'ready' && !record && (
          <p className="text-sm text-text-secondary">{intl.formatMessage(m.missing)}</p>
        )}
        {error && (
          <p role="alert" className="mb-3 whitespace-pre-wrap text-sm text-text-danger">
            {error}
          </p>
        )}
        {record && tab === 'rule' && draft && (
          <form onSubmit={(event) => void save(event)} className="space-y-5">
            <div>
              <input
                aria-label={intl.formatMessage(m.name)}
                value={draft.title}
                onChange={(event) => edit('title', event.target.value)}
                disabled={busy || record.status === 'inactive'}
                required
                maxLength={120}
                className="w-full rounded-lg border border-transparent bg-transparent py-1 text-lg font-medium outline-none focus:border-border-primary"
              />
              <p className="mt-1 text-xs text-text-secondary">
                {record.status === 'active'
                  ? intl.formatMessage(m.next, {
                      time: `${intl.formatDate(new Date(record.scheduledAt), {
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })} (${new Intl.RelativeTimeFormat(intl.locale).format(
                        Math.max(0, Math.ceil((Date.parse(record.scheduledAt) - now) / 1000)),
                        'second'
                      )})`,
                    })
                  : intl.formatMessage(record.status === 'paused' ? m.paused : m.inactive)}
              </p>
            </div>
            <label className="block space-y-2">
              <span className="text-xs text-text-secondary">
                {intl.formatMessage(m.instructions)}
              </span>
              <textarea
                aria-label={intl.formatMessage(m.instructions)}
                value={draft.prompt}
                onChange={(event) => edit('prompt', event.target.value)}
                disabled={busy || record.status === 'inactive'}
                required
                rows={4}
                className="block min-h-28 w-full resize-none rounded-2xl border border-border-primary bg-transparent px-3 py-3 text-sm leading-6 outline-none focus:border-border-secondary"
              />
            </label>
            <section className="space-y-2">
              <h3 className="px-3 text-sm text-text-secondary">{intl.formatMessage(m.runTime)}</h3>
              <fieldset
                disabled={busy || record.status === 'inactive'}
                className="min-w-0 rounded-2xl border border-border-primary px-3"
              >
                <label className="flex min-h-12 items-center gap-3 border-b border-border-primary text-sm">
                  {intl.formatMessage(m.repeat)}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={intl.formatMessage(m.repeat)}
                        className="ml-auto flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-background-secondary"
                      >
                        {draft.kind === 'at'
                          ? intl.formatMessage(m.once)
                          : draft.kind === 'every'
                            ? intl.formatMessage(
                                draft.intervalUnit === '3600'
                                  ? m.everyHours
                                  : draft.intervalUnit === '1'
                                    ? m.everySeconds
                                    : m.every,
                                { count: 'N' }
                              )
                            : intl.formatMessage(m.custom)}
                        <ChevronDown className="size-3.5 text-text-secondary" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      collisionPadding={12}
                      className="w-44 max-w-[calc(100vw-24px)] rounded-xl"
                    >
                      <DropdownMenuLabel className="text-xs text-text-secondary">
                        {intl.formatMessage(m.repeat)}
                      </DropdownMenuLabel>
                      {(['at', '3600', '60', '1', 'custom'] as const).map((value) => (
                        <DropdownMenuItem
                          key={value}
                          disabled={busy || record.status === 'inactive'}
                          onSelect={() => {
                            if (value === 'at') edit('kind', 'at');
                            else if (value === 'custom')
                              edit(
                                'kind',
                                ['daily', 'weekly', 'workdays', 'monthly'].includes(draft.kind)
                                  ? draft.kind
                                  : 'daily'
                              );
                            else {
                              setDraft({
                                ...draft,
                                kind: 'every',
                                intervalUnit: value,
                                interval: value === '1' ? '60' : '1',
                              });
                              setDirty(true);
                              setError('');
                            }
                          }}
                          className="rounded-lg"
                        >
                          <span className="flex-1">
                            {value === 'at'
                              ? intl.formatMessage(m.once)
                              : value === 'custom'
                                ? intl.formatMessage(m.custom)
                                : intl.formatMessage(
                                    value === '3600'
                                      ? m.everyHours
                                      : value === '1'
                                        ? m.everySeconds
                                        : m.every,
                                    { count: 'N' }
                                  )}
                          </span>
                          {(draft.kind === 'at'
                            ? value === 'at'
                            : draft.kind === 'every'
                              ? value === draft.intervalUnit
                              : value === 'custom') && <Check className="size-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </label>
                {draft.kind === 'every' && (
                  <label className="flex min-h-14 items-center gap-3 text-sm">
                    {intl.formatMessage(m.intervalValue)}
                    <input
                      className="ml-auto w-20 rounded-2xl bg-background-secondary px-3 py-2 text-center text-sm outline-none focus:ring-1 focus:ring-border-secondary"
                      aria-label={intl.formatMessage(m.intervalValue)}
                      type="number"
                      required
                      min={60 / Number(draft.intervalUnit)}
                      step="any"
                      value={draft.interval}
                      onChange={(event) => edit('interval', event.target.value)}
                    />
                    <span>
                      {intl.formatMessage(
                        draft.intervalUnit === '3600'
                          ? m.hours
                          : draft.intervalUnit === '1'
                            ? m.seconds
                            : m.minutes
                      )}
                    </span>
                  </label>
                )}
                {['daily', 'weekly', 'workdays', 'monthly', 'cron'].includes(draft.kind) && (
                  <div className="flex min-h-12 items-center gap-3 border-b border-border-primary text-sm">
                    {intl.formatMessage(m.frequency)}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={intl.formatMessage(m.frequency)}
                          className="ml-auto flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-background-secondary"
                        >
                          {intl.formatMessage(
                            draft.kind === 'daily'
                              ? m.everyDay
                              : draft.kind === 'weekly'
                                ? m.everyWeek
                                : draft.kind === 'workdays'
                                  ? m.workdays
                                  : draft.kind === 'monthly'
                                    ? m.everyMonth
                                    : m.custom
                          )}
                          <ChevronDown className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        collisionPadding={12}
                        className="w-44 max-w-[calc(100vw-24px)] rounded-xl"
                      >
                        {(['daily', 'weekly', 'workdays', 'monthly'] as const).map((kind) => (
                          <DropdownMenuItem
                            key={kind}
                            onSelect={() => {
                              if (kind === 'monthly') {
                                setDraft({ ...draft, kind, time: `${draft.time.slice(0, 5)}:00` });
                                setDirty(true);
                                setError('');
                              } else edit('kind', kind);
                            }}
                          >
                            <span className="flex-1">
                              {intl.formatMessage(
                                kind === 'daily'
                                  ? m.everyDay
                                  : kind === 'weekly'
                                    ? m.everyWeek
                                    : kind === 'monthly'
                                      ? m.everyMonth
                                      : m.workdays
                              )}
                            </span>
                            {draft.kind === kind && <Check className="size-3.5" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
                {(draft.kind === 'weekly' || draft.kind === 'monthly') && (
                  <ScheduleDayPicker
                    monthly={draft.kind === 'monthly'}
                    value={(draft.kind === 'monthly' ? draft.monthDays : draft.days)
                      .split(',')
                      .map(Number)}
                    onChange={(days) =>
                      edit(draft.kind === 'monthly' ? 'monthDays' : 'days', days.join(','))
                    }
                  />
                )}
                {(draft.kind === 'daily' ||
                  draft.kind === 'weekly' ||
                  draft.kind === 'workdays' ||
                  draft.kind === 'monthly') && (
                  <div className="flex min-h-12 items-center gap-3 text-sm">
                    <span>{intl.formatMessage(m.time)}</span>
                    <ScheduleTimePicker
                      value={draft.time}
                      disabled={busy || record.status === 'inactive'}
                      onChange={(time) => edit('time', time)}
                    />
                  </div>
                )}
                {draft.kind === 'at' && (
                  <>
                    <label className="flex min-h-12 items-center gap-3 border-b border-border-primary text-sm">
                      {intl.formatMessage(m.date)}
                      <input
                        type="date"
                        required
                        className={cn(fieldClass, 'ml-auto flex-none [&::-webkit-datetime-edit]:text-right')}
                        aria-label={intl.formatMessage(m.date)}
                        value={draft.at.slice(0, 10)}
                        onChange={(event) =>
                          edit('at', `${event.target.value}T${draft.at.slice(11) || '09:00:00'}`)
                        }
                      />
                    </label>
                    <div className="flex min-h-12 items-center gap-3 text-sm">
                      <span>{intl.formatMessage(m.time)}</span>
                      <ScheduleTimePicker
                        value={draft.at.slice(11)}
                        disabled={busy || record.status === 'inactive'}
                        onChange={(time) => edit('at', `${draft.at.slice(0, 10)}T${time}`)}
                      />
                    </div>
                  </>
                )}
                {draft.kind === 'cron' && (
                  <label className="flex min-h-12 items-center gap-3 text-sm">
                    Cron
                    <input
                      className={fieldClass}
                      aria-label="Cron"
                      value={draft.expression}
                      onChange={(event) => edit('expression', event.target.value)}
                    />
                  </label>
                )}
                {(draft.kind === 'daily' ||
                  draft.kind === 'weekly' ||
                  draft.kind === 'workdays' ||
                  draft.kind === 'cron' ||
                  draft.kind === 'monthly') && (
                  <div className="flex min-h-12 items-center gap-3 border-t border-border-primary text-sm">
                    <span className="shrink-0 whitespace-nowrap">{intl.formatMessage(m.zone)}</span>
                    <ScheduleTimeZonePicker
                      value={draft.zone}
                      at={record.scheduledAt}
                      disabled={busy || record.status === 'inactive'}
                      onChange={(zone) => edit('zone', zone)}
                    />
                  </div>
                )}
              </fieldset>
            </section>
            {draft.kind === 'every' && (
              <p className="px-3 text-xs leading-5 text-text-secondary">
                {intl.formatMessage(m.intervalHint)}
              </p>
            )}
            {draft.kind === 'monthly' && (
              <p className="px-3 text-xs leading-5 text-text-secondary">
                {intl.formatMessage(m.monthHint)}
              </p>
            )}
            {draft.kind === 'at' && (
              <p className="px-3 text-xs leading-5 text-text-secondary">
                {intl.formatMessage(m.localZone, {
                  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                })}
              </p>
            )}
            {dirty && (
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(draftOf(record));
                    setBase(record);
                    setDirty(false);
                    setError('');
                  }}
                  className="rounded-full px-4 py-2 text-sm hover:bg-background-secondary"
                >
                  {intl.formatMessage(m.cancel)}
                </button>
                <button
                  type="submit"
                  disabled={busy || !draft.title.trim() || !draft.prompt.trim()}
                  className="rounded-full bg-text-primary px-4 py-2 text-sm text-background-primary disabled:opacity-50"
                >
                  {intl.formatMessage(m.save)}
                </button>
              </div>
            )}
            <div className="flex items-center gap-5">
              {record.status !== 'inactive' && (
                <button
                  type="button"
                  onClick={() => void togglePaused()}
                  disabled={busy || dirty}
                  title={intl.formatMessage(m.pauseHint)}
                  className="shrink-0 whitespace-nowrap text-xs text-text-secondary hover:text-text-primary hover:underline disabled:opacity-50"
                >
                  {intl.formatMessage(record.status === 'paused' ? m.resume : m.pause)}
                </button>
              )}
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="shrink-0 whitespace-nowrap text-xs text-text-danger hover:underline disabled:opacity-50"
              >
                {intl.formatMessage(m.remove)}
              </button>
            </div>
          </form>
        )}
        {record && tab === 'records' && (
          <div>
            <p className="mb-5 text-xs leading-5 text-text-secondary">
              {intl.formatMessage(m.deliveryHint)}
            </p>
            {historyBusy && (
              <p role="status" className="text-sm text-text-secondary">
                {intl.formatMessage(m.loading)}
              </p>
            )}
            {history && 'records' in history && (
              <>
                {history.earlierRecordsUnavailable && (
                  <p className="mb-3 text-xs text-text-secondary">
                    {intl.formatMessage(m.earlier)}
                  </p>
                )}
                {!history.records.length && !historyBusy && (
                  <p className="text-sm text-text-secondary">
                    {intl.formatMessage(m.emptyRecords)}
                  </p>
                )}
                {history.records.map((item) => (
                  <div key={`${item.messageId}:${item.scheduledAt}`} className="flex gap-3 py-3">
                    <Clock3 className="mt-0.5 size-4 shrink-0 text-text-secondary" />
                    <div className="min-w-0 flex-1 border-l border-border-primary pl-3 pb-4">
                      <div className="text-sm">
                        {new Date(item.deliveredAt).toLocaleString(intl.locale)}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
                        {item.prompt ?? intl.formatMessage(m.missingPrompt)}
                      </p>
                    </div>
                  </div>
                ))}
                {history.nextBefore && (
                  <button
                    type="button"
                    disabled={historyBusy}
                    onClick={async () => {
                      const version = historyVersion.current;
                      setHistoryBusy(true);
                      try {
                        const page = await readNativeScheduleHistory(record, history.nextBefore);
                        if (version !== historyVersion.current) return;
                        if ('records' in page)
                          setHistory({ ...page, records: [...history.records, ...page.records] });
                        else setError(page.code);
                      } catch (value) {
                        setError(String(value));
                      } finally {
                        setHistoryBusy(false);
                      }
                    }}
                    className="text-sm text-text-secondary hover:underline"
                  >
                    {intl.formatMessage(m.more)}
                  </button>
                )}
              </>
            )}
            {history && !('records' in history) && <p role="alert">{history.code}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
