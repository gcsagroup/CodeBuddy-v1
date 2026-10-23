import { currentLocale } from '../i18n';

let formatters:
  | {
      locale: string;
      time: Intl.DateTimeFormat;
      date: Intl.DateTimeFormat;
    }
  | undefined;

export function formatMessageTimestamp(timestamp?: number): string {
  const date = timestamp ? new Date(timestamp * 1000) : new Date();
  const now = new Date();

  // Format time using locale's default hour cycle
  if (formatters?.locale !== currentLocale) {
    formatters = {
      locale: currentLocale,
      time: new Intl.DateTimeFormat(currentLocale, { hour: 'numeric', minute: '2-digit' }),
      date: new Intl.DateTimeFormat(currentLocale, {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
      }),
    };
  }
  const timeStr = formatters.time.format(date);

  // Check if the message is from today
  if (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  ) {
    return timeStr;
  }

  // If not today, format as localized date + time
  const dateStr = formatters.date.format(date);

  return `${dateStr} ${timeStr}`;
}
