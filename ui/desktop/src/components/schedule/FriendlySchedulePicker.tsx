import type { ScheduledJobDto } from '@aaif/goose-sdk';
import { CronPicker } from './CronPicker';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  runtimeWarning: {
    id: 'schedulePicker.runtimeWarning',
    defaultMessage:
      'CodeBuddy must remain running for automatic tasks. Missed runs are not replayed by default. A new automatic task stays paused until its test run succeeds.',
  },
});

interface FriendlySchedulePickerProps {
  schedule: ScheduledJobDto | null;
  onChange: (value: string) => void;
  isValid: (valid: boolean) => void;
}

export function FriendlySchedulePicker(props: FriendlySchedulePickerProps) {
  const intl = useIntl();

  return (
    <div className="space-y-3">
      <CronPicker {...props} />
      <p className="px-1 text-xs leading-5 text-text-secondary">
        {intl.formatMessage(i18n.runtimeWarning)}
      </p>
    </div>
  );
}
