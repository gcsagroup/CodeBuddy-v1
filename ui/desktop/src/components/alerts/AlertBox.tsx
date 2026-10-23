import React from 'react';
import { IoIosCloseCircle, IoIosWarning, IoIosInformationCircle } from 'react-icons/io';
import { cn } from '../../utils';
import { Alert, AlertType } from './types';
import { defineMessages, useIntl } from '../../i18n';

const alertIcons: Record<AlertType, React.ReactNode> = {
  [AlertType.Error]: <IoIosCloseCircle className="h-5 w-5" />,
  [AlertType.Warning]: <IoIosWarning className="h-5 w-5" />,
  [AlertType.Info]: <IoIosInformationCircle className="h-5 w-5" />,
};

interface AlertBoxProps {
  alert: Alert;
  className?: string;
}

const i18n = defineMessages({
  compactNow: {
    id: 'alertBox.compactNow',
    defaultMessage: 'Compact now',
  },
});

const alertStyles: Record<AlertType, string> = {
  [AlertType.Error]: 'bg-[#d7040e] text-white',
  [AlertType.Warning]: 'bg-[#cc4b03] text-white',
  [AlertType.Info]: 'dark:bg-white dark:text-black bg-black text-white',
};

export const AlertBox = ({ alert, className }: AlertBoxProps) => {
  const intl = useIntl();
  if (alert.progress) {
    if (!alert.showCompactButton || !alert.onCompact) return null;
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          alert.onCompact!();
        }}
        disabled={alert.compactButtonDisabled}
        className={cn(
          'flex w-full items-center justify-center gap-1.5 bg-background-secondary px-3 py-2 text-xs text-text-secondary outline-none transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50 enabled:hover:bg-background-tertiary enabled:hover:text-text-primary',
          className
        )}
      >
        {alert.compactIcon}
        <span>{intl.formatMessage(i18n.compactNow)}</span>
      </button>
    );
  }
  return (
    <div className={cn('flex flex-col gap-2 px-3 py-3', alertStyles[alert.type], className)}>
      <div className="flex items-center gap-2">
        <div className="flex-shrink-0">{alertIcons[alert.type]}</div>
        <div className="flex flex-col gap-2 flex-1">
          <span className="text-[11px] break-words whitespace-pre-line">{alert.message}</span>
          {alert.action && (
            <a
              role="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                alert.action?.onClick();
              }}
              className="text-[11px] text-left underline hover:opacity-80 cursor-pointer outline-none"
            >
              {alert.action.text}
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
