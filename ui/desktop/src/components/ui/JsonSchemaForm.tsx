import React, { useCallback, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { Input } from './input';
import { Button } from './button';
import { defineMessages, useIntl } from '../../i18n';
import { cn } from '../../utils';

const i18n = defineMessages({
  submit: { id: 'jsonSchemaForm.submit', defaultMessage: 'Submit' },
  cancel: { id: 'jsonSchemaForm.cancel', defaultMessage: 'Cancel' },
  back: { id: 'backButton.back', defaultMessage: 'Back' },
  next: { id: 'messageQueue.next', defaultMessage: 'Next' },
  fieldRequired: {
    id: 'jsonSchemaForm.fieldRequired',
    defaultMessage: 'This field is required',
  },
  minLength: {
    id: 'jsonSchemaForm.minLength',
    defaultMessage: 'Minimum length is {minLength}',
  },
  maxLength: {
    id: 'jsonSchemaForm.maxLength',
    defaultMessage: 'Maximum length is {maxLength}',
  },
  minValue: {
    id: 'jsonSchemaForm.minValue',
    defaultMessage: 'Minimum value is {minimum}',
  },
  maxValue: {
    id: 'jsonSchemaForm.maxValue',
    defaultMessage: 'Maximum value is {maximum}',
  },
  noFields: { id: 'jsonSchemaForm.noFields', defaultMessage: 'No fields to display' },
  selectPlaceholder: {
    id: 'jsonSchemaForm.selectPlaceholder',
    defaultMessage: 'Select...',
  },
});

interface JsonSchemaChoice {
  const: string;
  title?: string;
  description?: string;
}

interface JsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  oneOf?: JsonSchemaChoice[];
  items?: { enum?: string[]; anyOf?: JsonSchemaChoice[] };
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  _meta?: { 'codepro.dev/optionDescriptions'?: Record<string, string> };
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  title?: string;
  description?: string;
}

interface JsonSchemaFormProps {
  schema: JsonSchema;
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  disabled?: boolean;
  compact?: boolean;
}

interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

function choicesFor(prop: JsonSchemaProperty): ChoiceOption[] {
  const descriptions = prop._meta?.['codepro.dev/optionDescriptions'] ?? {};
  const titled = prop.oneOf ?? prop.items?.anyOf;
  if (titled) {
    return titled.map((choice) => ({
      value: choice.const,
      label: choice.title || choice.const,
      description: choice.description || descriptions[choice.const],
    }));
  }
  const values = prop.enum ?? prop.items?.enum ?? [];
  return values.map((value) => ({ value, label: value, description: descriptions[value] }));
}

function initialValue(prop: JsonSchemaProperty): unknown {
  if (prop.default !== undefined) return prop.default;
  if (prop.type === 'array') return [];
  if (prop.type === 'boolean') return false;
  return '';
}

export default function JsonSchemaForm({
  schema,
  onSubmit,
  onCancel,
  submitLabel,
  cancelLabel,
  disabled = false,
  compact = false,
}: JsonSchemaFormProps) {
  const intl = useIntl();
  const fields = useMemo(() => Object.entries(schema.properties ?? {}), [schema.properties]);
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map(([key, prop]) => [key, initialValue(prop)]))
  );
  const [error, setError] = useState<string>();

  const validateField = useCallback(
    (key: string, prop: JsonSchemaProperty, value: unknown): string | undefined => {
      const required = schema.required?.includes(key) ?? false;
      const empty =
        value === '' ||
        value === null ||
        value === undefined ||
        (Array.isArray(value) && !value.length);
      if (required && empty) return intl.formatMessage(i18n.fieldRequired);
      if (empty) return undefined;

      if (prop.type === 'string' && typeof value === 'string') {
        if (prop.minLength !== undefined && value.length < prop.minLength) {
          return intl.formatMessage(i18n.minLength, { minLength: prop.minLength });
        }
        if (prop.maxLength !== undefined && value.length > prop.maxLength) {
          return intl.formatMessage(i18n.maxLength, { maxLength: prop.maxLength });
        }
      }
      if ((prop.type === 'number' || prop.type === 'integer') && typeof value === 'number') {
        if (prop.minimum !== undefined && value < prop.minimum) {
          return intl.formatMessage(i18n.minValue, { minimum: prop.minimum });
        }
        if (prop.maximum !== undefined && value > prop.maximum) {
          return intl.formatMessage(i18n.maxValue, { maximum: prop.maximum });
        }
      }
      if (Array.isArray(value)) {
        if (prop.minItems !== undefined && value.length < prop.minItems) {
          return intl.formatMessage(i18n.fieldRequired);
        }
        if (prop.maxItems !== undefined && value.length > prop.maxItems) {
          return intl.formatMessage(i18n.maxValue, { maximum: prop.maxItems });
        }
      }
      return undefined;
    },
    [intl, schema.required]
  );

  const updateValue = (key: string, value: unknown) => {
    setFormData((current) => ({ ...current, [key]: value }));
    setError(undefined);
  };

  if (!fields.length) {
    return <div className="text-text-secondary text-sm">{intl.formatMessage(i18n.noFields)}</div>;
  }

  const [key, prop] = fields[step];
  const value = formData[key];
  const required = schema.required?.includes(key) ?? false;
  const options = choicesFor(prop);
  const isLastStep = step === fields.length - 1;

  const handleAdvance = (event: React.FormEvent) => {
    event.preventDefault();
    const nextError = validateField(key, prop, value);
    setError(nextError);
    if (nextError) return;
    if (isLastStep) {
      onSubmit(formData);
    } else {
      setStep((current) => current + 1);
    }
  };

  const renderChoice = (
    option: ChoiceOption,
    selected: boolean,
    onSelect: () => void,
    index = 0
  ) => (
    <button
      key={option.value}
      type="button"
      role={prop.type === 'array' ? 'checkbox' : 'radio'}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'w-full rounded-xl border px-4 py-3 text-left transition-colors',
        'hover:border-border-secondary hover:bg-background-secondary',
        selected
          ? 'border-border-secondary bg-background-secondary'
          : 'border-border-primary bg-background-primary',
        disabled && 'cursor-not-allowed opacity-50',
        compact && 'rounded-lg border-transparent px-3 py-2'
      )}
    >
      <span className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border',
            prop.type === 'array' ? 'rounded' : 'rounded-full',
            selected
              ? 'border-text-primary bg-text-primary text-background-primary'
              : 'border-border-secondary'
          )}
        >
          {selected ? <Check className="h-3.5 w-3.5" /> : compact ? index + 1 : null}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-text-primary">{option.label}</span>
          {option.description && (
            <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
              {option.description}
            </span>
          )}
        </span>
      </span>
    </button>
  );

  const renderField = () => {
    if (options.length && prop.type === 'array') {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-col gap-2" role="group" aria-labelledby={`${key}-title`}>
          {options.map((option, index) =>
            renderChoice(
              option,
              selected.includes(option.value),
              () => {
                const next = selected.includes(option.value)
                  ? selected.filter((item) => item !== option.value)
                  : [...selected, option.value];
                updateValue(key, next);
              },
              index
            )
          )}
        </div>
      );
    }
    if (options.length) {
      return (
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={`${key}-title`}>
          {options.map((option, index) =>
            renderChoice(
              option,
              value === option.value,
              () => updateValue(key, option.value),
              index
            )
          )}
        </div>
      );
    }
    if (prop.type === 'boolean') {
      return renderChoice(
        { value: 'true', label: prop.description || prop.title || key },
        Boolean(value),
        () => updateValue(key, !value)
      );
    }
    if (prop.type === 'number' || prop.type === 'integer') {
      return (
        <Input
          id={key}
          type="number"
          value={String(value ?? '')}
          min={prop.minimum}
          max={prop.maximum}
          step={prop.type === 'integer' ? 1 : 'any'}
          disabled={disabled}
          onChange={(event) => {
            const parsed =
              prop.type === 'integer'
                ? Number.parseInt(event.target.value, 10)
                : Number.parseFloat(event.target.value);
            updateValue(key, Number.isNaN(parsed) ? '' : parsed);
          }}
        />
      );
    }
    return (
      <div className="relative">
        <textarea
          id={key}
          value={String(value ?? '')}
          maxLength={prop.maxLength}
          disabled={disabled}
          onChange={(event) => updateValue(key, event.target.value)}
          className={cn(
            'min-h-32 w-full resize-y rounded-xl border border-border-primary bg-background-primary px-3 py-3 pb-7 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary hover:border-border-secondary focus:border-border-secondary disabled:cursor-not-allowed disabled:opacity-50',
            compact && 'min-h-20'
          )}
        />
        {prop.maxLength !== undefined && (
          <span className="pointer-events-none absolute bottom-2 right-3 text-xs text-text-secondary">
            {String(value ?? '').length}/{prop.maxLength}
          </span>
        )}
      </div>
    );
  };

  return (
    <form onSubmit={handleAdvance} className={cn('flex flex-col gap-4', compact && 'gap-3')}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3
            id={`${key}-title`}
            className={cn('text-base font-semibold text-text-primary', compact && 'text-sm')}
          >
            {prop.title || key}
            {required && !compact && <span className="ml-1 text-red-500">*</span>}
          </h3>
          {prop.description && (
            <p className="mt-1 text-sm text-text-secondary">{prop.description}</p>
          )}
        </div>
        {(!compact || fields.length > 1) && (
          <span className="shrink-0 text-sm tabular-nums text-text-secondary">
            {step + 1} / {fields.length}
          </span>
        )}
      </div>

      {renderField()}
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}

      <div className="mt-1 flex items-center justify-end gap-2 border-t border-border-primary pt-3">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
            {cancelLabel ?? intl.formatMessage(i18n.cancel)}
          </Button>
        )}
        {step > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(undefined);
              setStep((current) => current - 1);
            }}
            disabled={disabled}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            {intl.formatMessage(i18n.back)}
          </Button>
        )}
        <Button type="submit" disabled={disabled}>
          {isLastStep
            ? (submitLabel ?? intl.formatMessage(i18n.submit))
            : intl.formatMessage(i18n.next)}
          {!isLastStep && <ChevronRight className="ml-1 h-4 w-4" />}
        </Button>
      </div>
    </form>
  );
}
