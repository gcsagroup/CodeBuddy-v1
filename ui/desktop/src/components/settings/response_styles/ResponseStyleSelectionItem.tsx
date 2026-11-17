import { useId } from 'react';
import { defineMessages, useIntl } from '../../../i18n';
import type { MessageDescriptor } from 'react-intl';

const i18n = defineMessages({
  detailedLabel: {
    id: 'responseStyle.detailedLabel',
    defaultMessage: 'Detailed',
  },
  detailedDescription: {
    id: 'responseStyle.detailedDescription',
    defaultMessage: 'Tool calls are by default shown open to expose details',
  },
  conciseLabel: {
    id: 'responseStyle.conciseLabel',
    defaultMessage: 'Concise',
  },
  conciseDescription: {
    id: 'responseStyle.conciseDescription',
    defaultMessage: 'Tool calls are by default closed and only show the tool used',
  },
});

export interface ResponseStyle {
  key: string;
  label: MessageDescriptor;
  description: MessageDescriptor;
}

export const all_response_styles: ResponseStyle[] = [
  {
    key: 'detailed',
    label: i18n.detailedLabel,
    description: i18n.detailedDescription,
  },
  {
    key: 'concise',
    label: i18n.conciseLabel,
    description: i18n.conciseDescription,
  },
];

interface ResponseStyleSelectionItemProps {
  currentStyle: string;
  style: ResponseStyle;
  showDescription: boolean;
  disabled?: boolean;
  handleStyleChange: (newStyle: string) => void | Promise<void>;
}

export function ResponseStyleSelectionItem({
  currentStyle,
  style,
  showDescription,
  disabled = false,
  handleStyleChange,
}: ResponseStyleSelectionItemProps) {
  const intl = useIntl();
  const descriptionId = useId();
  const label = intl.formatMessage(style.label);

  return (
    <label className="group relative block cursor-pointer has-disabled:cursor-default has-disabled:opacity-60">
      <input
        type="radio"
        name="responseStyles"
        value={style.key}
        aria-label={label}
        aria-describedby={showDescription ? descriptionId : undefined}
        checked={currentStyle === style.key}
        disabled={disabled}
        onChange={() => void handleStyleChange(style.key)}
        className="peer sr-only"
      />
      <span className="flex items-start gap-3 rounded-lg border border-border-primary px-3 py-3 text-sm transition-colors group-hover:bg-background-secondary peer-checked:border-border-info peer-checked:bg-background-secondary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-border-info">
        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-border-primary" aria-hidden="true">
          {currentStyle === style.key && <span className="size-2 rounded-full bg-text-info" />}
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-text-primary">{label}</span>
          {showDescription && (
            <span id={descriptionId} className="mt-1 block text-xs leading-relaxed text-text-secondary">
              {intl.formatMessage(style.description)}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}
