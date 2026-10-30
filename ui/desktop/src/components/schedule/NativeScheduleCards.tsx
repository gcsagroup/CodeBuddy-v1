import { useEffect, useMemo, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { useIntl } from '../../i18n';
import { getToolRequests, getToolResponses, type Message } from '../../types/message';
import {
  refreshNativeSchedules,
  useNativeSchedules,
  type ScheduleRecord,
} from '../../acp/nativeSchedules';
import { nativeScheduleMessages as m } from './nativeScheduleMessages';
import { formatNativeSchedule } from './nativeScheduleFormat';
import { openNativeSchedule } from './scheduleEvents';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
// Only the exact native tool's successful structured receipt can create a
// card. Assistant prose and text-only tool output have no control authority.
export function createdNativeSchedules(messages: Message[], message: Message): ScheduleRecord[] {
  if (
    message.role !== 'assistant' ||
    !message.content.some((part) => part.type === 'text' && part.text.trim())
  )
    return [];
  const index = messages.findIndex(
    (item) => item === message || (message.id && item.id === message.id)
  );
  if (index < 0) return [];
  const human = (item: Message) =>
    item.role === 'user' && !item.content.every((part) => part.type === 'toolResponse');
  let start = index;
  while (start > 0 && !human(messages[start])) start--;
  let end = index + 1;
  while (end < messages.length && !human(messages[end])) end++;
  if (
    messages
      .slice(index + 1, end)
      .some(
        (item) =>
          item.role === 'assistant' &&
          item.content.some((part) => part.type === 'text' && part.text.trim())
      )
  )
    return [];
  const turn = messages.slice(start, end);
  const calls = new Set(
    turn
      .flatMap(getToolRequests)
      .filter(
        (call) =>
          call.toolCall.status === 'success' &&
          object(call.toolCall.value) &&
          call.toolCall.value.name === 'schedule_create'
      )
      .map((call) => call.id)
  );
  const records = new Map<string, ScheduleRecord>();
  for (const response of turn.flatMap(getToolResponses)) {
    if (!calls.has(response.id) || response.toolResult.status !== 'success') continue;
    const value = response.toolResult.value;
    const receipt = object(value) ? value.structuredContent : undefined;
    if (
      !object(receipt) ||
      typeof receipt.id !== 'string' ||
      typeof receipt.title !== 'string' ||
      typeof receipt.prompt !== 'string' ||
      typeof receipt.scheduledAt !== 'string' ||
      !['after', 'at', 'every', 'daily', 'weekly', 'cron'].includes(String(receipt.kind))
    )
      continue;
    records.set(receipt.id, receipt as unknown as ScheduleRecord);
  }
  return [...records.values()];
}
export function NativeScheduleCards({
  messages,
  message,
  running,
}: {
  messages: Message[];
  message: Message;
  running: boolean;
}) {
  const records = useMemo(() => createdNativeSchedules(messages, message), [messages, message]);
  if (running || !records.length) return null;
  return <ScheduleCardList records={records} />;
}
function ScheduleCardList({ records }: { records: ScheduleRecord[] }) {
  const intl = useIntl();
  const catalog = useNativeSchedules();
  const [mountedRead] = useState(catalog.readRequest);
  useEffect(() => {
    void refreshNativeSchedules();
  }, []);
  // Only a successful read requested after this card appeared can establish
  // absence. An older or failed directory read cannot invalidate its receipt.
  const hasFreshDirectory = catalog.readSettled > mountedRead;
  return (
    <div className="my-3 space-y-2">
      {records.map((created) => {
        const current = catalog.records.find((record) => record.id === created.id);
        const record = current ?? created;
        const deleted = !current && hasFreshDirectory;
        return (
          <div
            key={record.id}
            className="flex items-center gap-3 rounded-2xl border border-border-primary bg-background-secondary/40 px-3 py-3"
          >
            <span className="rounded-xl border border-border-primary p-2 text-text-secondary">
              <Clock3 className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-text-primary">{record.title}</div>
              <div className="mt-1 text-xs text-text-secondary">
                {deleted
                  ? intl.formatMessage(m.deleted)
                  : current?.status === 'paused'
                    ? intl.formatMessage(m.paused)
                    : current?.status === 'inactive'
                    ? intl.formatMessage(m.inactive)
                    : formatNativeSchedule(record, intl)}
              </div>
            </div>
            {!deleted && (
              <button
                type="button"
                onClick={() => openNativeSchedule(record.id)}
                className="rounded-lg border border-border-primary px-3 py-1.5 text-xs hover:bg-background-secondary"
              >
                {intl.formatMessage(m.open)}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
