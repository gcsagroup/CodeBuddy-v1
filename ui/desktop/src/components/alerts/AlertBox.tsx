import React, { useState, useEffect } from 'react';
import { IoIosCloseCircle, IoIosWarning, IoIosInformationCircle } from 'react-icons/io';
import { FaPencilAlt, FaSave } from 'react-icons/fa';
import { cn } from '../../utils';
import { readPreferences, savePreferences } from '../../acp/preferences';
import { Alert, AlertType } from './types';
import { defineMessages, useIntl } from '../../i18n';

const AUTO_COMPACT_THRESHOLD_KEY = 'autoCompactThreshold' as const;
const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.8;
type ThresholdStatus = 'loading' | 'ready' | 'unavailable';

type PreferencesSnapshot = Awaited<ReturnType<typeof readPreferences>>;

function thresholdFromSnapshot(
  snapshot: PreferencesSnapshot,
  missingValue: number | null
): number | null {
  const entries = snapshot.values.filter(({ key }) => key === AUTO_COMPACT_THRESHOLD_KEY);
  if (entries.length === 0) return missingValue;
  if (entries.length !== 1) return null;

  const value = entries[0].value;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1
    ? value
    : null;
}

const alertIcons: Record<AlertType, React.ReactNode> = {
  [AlertType.Error]: <IoIosCloseCircle className="h-5 w-5" />,
  [AlertType.Warning]: <IoIosWarning className="h-5 w-5" />,
  [AlertType.Info]: <IoIosInformationCircle className="h-5 w-5" />,
};

interface AlertBoxProps {
  alert: Alert;
  className?: string;
  compactButtonEnabled?: boolean;
}

const i18n = defineMessages({
  autoCompactAt: {
    id: 'alertBox.autoCompactAt',
    defaultMessage: 'Auto compact at',
  },
  autoCompactUnavailable: {
    id: 'alertBox.autoCompactUnavailable',
    defaultMessage: 'Auto compact threshold unavailable',
  },
  saveAutoCompactThreshold: {
    id: 'alertBox.saveAutoCompactThreshold',
    defaultMessage: 'Save auto-compact threshold',
  },
  editAutoCompactThreshold: {
    id: 'alertBox.editAutoCompactThreshold',
    defaultMessage: 'Edit auto-compact threshold',
  },
  compactNow: {
    id: 'alertBox.compactNow',
    defaultMessage: 'Compact now',
  },
  failedToSaveThreshold: {
    id: 'alertBox.failedToSaveThreshold',
    defaultMessage: 'Failed to save threshold: {error}',
  },
});

const alertStyles: Record<AlertType, string> = {
  [AlertType.Error]: 'bg-[#d7040e] text-white',
  [AlertType.Warning]: 'bg-[#cc4b03] text-white',
  [AlertType.Info]: 'dark:bg-white dark:text-black bg-black text-white',
};

export const AlertBox = ({ alert, className }: AlertBoxProps) => {
  const intl = useIntl();
  const [isEditingThreshold, setIsEditingThreshold] = useState(false);
  const [loadedThreshold, setLoadedThreshold] = useState<number>(DEFAULT_AUTO_COMPACT_THRESHOLD);
  const [thresholdValue, setThresholdValue] = useState(80);
  const [isSaving, setIsSaving] = useState(false);
  const [isThresholdEditable, setIsThresholdEditable] = useState(false);
  const [thresholdStatus, setThresholdStatus] = useState<ThresholdStatus>('loading');

  useEffect(() => {
    let active = true;

    const loadThreshold = async () => {
      try {
        const snapshot = await readPreferences([AUTO_COMPACT_THRESHOLD_KEY]);
        if (!active) return;

        const threshold = thresholdFromSnapshot(snapshot, DEFAULT_AUTO_COMPACT_THRESHOLD);
        if (threshold === null) {
          setIsThresholdEditable(false);
          setThresholdStatus('unavailable');
          return;
        }

        setLoadedThreshold(threshold);
        setThresholdValue(Math.max(1, Math.round(threshold * 100)));
        setIsThresholdEditable(true);
        setThresholdStatus('ready');
      } catch {
        if (!active) return;
        console.error('Unable to load the auto-compact threshold.');
        setIsThresholdEditable(false);
        setThresholdStatus('unavailable');
      }
    };

    loadThreshold();
    return () => {
      active = false;
    };
  }, []);

  const currentThreshold = loadedThreshold;

  const handleSaveThreshold = async () => {
    if (isSaving || !isThresholdEditable) return; // Prevent double-clicks and fail closed.

    const validThreshold = Math.max(1, Math.min(99, thresholdValue));
    if (validThreshold !== thresholdValue) {
      setThresholdValue(validThreshold);
    }

    setIsSaving(true);
    let committedThreshold: number | null = null;
    try {
      const requestedThreshold = validThreshold / 100; // Convert percentage to decimal
      const snapshot = await savePreferences([
        { key: AUTO_COMPACT_THRESHOLD_KEY, value: requestedThreshold, isMutable: true },
      ]);
      const authoritativeThreshold = thresholdFromSnapshot(snapshot, null);
      if (authoritativeThreshold === null) {
        throw new Error('Invalid authoritative preference snapshot');
      }

      setIsEditingThreshold(false);
      setLoadedThreshold(authoritativeThreshold);
      setThresholdValue(Math.max(1, Math.round(authoritativeThreshold * 100)));
      committedThreshold = authoritativeThreshold;
    } catch {
      console.error('Unable to save the auto-compact threshold.');
      window.alert(intl.formatMessage(i18n.failedToSaveThreshold, { error: 'Unknown error' }));
    } finally {
      setIsSaving(false);
    }

    if (committedThreshold === null || !alert.onThresholdChange) return;
    try {
      const callbackResult = alert.onThresholdChange(committedThreshold);
      void Promise.resolve(callbackResult).catch(() => {
        console.error('Unable to notify the auto-compact threshold change.');
      });
    } catch {
      console.error('Unable to notify the auto-compact threshold change.');
    }
  };

  return (
    <div
      className={cn('flex flex-col gap-2 px-3 py-3', alertStyles[alert.type], className)}
      onMouseDown={(e) => {
        // Prevent popover from closing when clicking inside the alert box
        if (isEditingThreshold) {
          e.stopPropagation();
        }
      }}
    >
      {alert.progress ? (
        <div className="flex flex-col gap-2">
          {/* Auto-compact threshold indicator with edit */}
          <div className="flex items-center justify-center gap-1 min-h-[20px]">
            {isEditingThreshold ? (
              <>
                <span className="text-[10px] opacity-70">
                  {intl.formatMessage(i18n.autoCompactAt)}
                </span>
                <input
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  value={thresholdValue}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (e.target.value === '') {
                      setThresholdValue(1);
                    } else if (!isNaN(val)) {
                      setThresholdValue(Math.max(1, Math.min(99, val)));
                    }
                  }}
                  onBlur={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (isNaN(val) || val < 1) {
                      setThresholdValue(1);
                    } else if (val > 99) {
                      setThresholdValue(99);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveThreshold();
                    } else if (e.key === 'Escape') {
                      setIsEditingThreshold(false);
                      const resetValue = Math.round(currentThreshold * 100);
                      setThresholdValue(Math.max(1, resetValue));
                    }
                  }}
                  onFocus={(e) => {
                    e.target.select();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                  className="w-12 px-1 text-[10px] bg-white/10 border border-current/30 rounded outline-none text-center focus:bg-white/20 focus:border-current/50 transition-colors"
                  disabled={isSaving || !isThresholdEditable}
                  autoFocus
                />
                <span className="text-[10px] opacity-70">%</span>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSaveThreshold();
                  }}
                  aria-label={intl.formatMessage(i18n.saveAutoCompactThreshold)}
                  disabled={isSaving || !isThresholdEditable}
                  className="p-1 hover:opacity-60 transition-opacity cursor-pointer relative z-50"
                  style={{ minWidth: '20px', minHeight: '20px', pointerEvents: 'auto' }}
                >
                  <FaSave className="w-3 h-3" />
                </button>
              </>
            ) : (
              <>
                <span className="text-[10px] opacity-70">
                  {thresholdStatus === 'ready'
                    ? `${intl.formatMessage(i18n.autoCompactAt)} ${Math.round(currentThreshold * 100)}%`
                    : thresholdStatus === 'unavailable'
                      ? intl.formatMessage(i18n.autoCompactUnavailable)
                      : `${intl.formatMessage(i18n.autoCompactAt)} …`}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isThresholdEditable) return;
                    setIsEditingThreshold(true);
                  }}
                  aria-label={intl.formatMessage(i18n.editAutoCompactThreshold)}
                  disabled={!isThresholdEditable}
                  className="p-1 hover:opacity-60 transition-opacity cursor-pointer relative z-10"
                  style={{ minWidth: '20px', minHeight: '20px' }}
                >
                  <FaPencilAlt className="w-3 h-3 opacity-70" />
                </button>
              </>
            )}
          </div>
          {alert.showCompactButton && alert.onCompact && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                alert.onCompact!();
              }}
              disabled={alert.compactButtonDisabled}
              className={cn(
                'flex items-center justify-center gap-1.5 text-[11px] outline-none',
                alert.compactButtonDisabled
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:opacity-80 cursor-pointer'
              )}
            >
              {alert.compactIcon}
              <span>{intl.formatMessage(i18n.compactNow)}</span>
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="flex-shrink-0">{alertIcons[alert.type]}</div>
            <div className="flex flex-col gap-2 flex-1">
              <span className="text-[11px] break-words whitespace-pre-line">{alert.message}</span>
              {alert.action && (
                <a
                  role="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    alert.action?.onClick();
                  }}
                  className="text-[11px] text-left underline hover:opacity-80 cursor-pointer outline-none"
                >
                  {alert.action.text}
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
