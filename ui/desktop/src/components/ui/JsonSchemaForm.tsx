import { useCallback, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
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
  customAnswer: { id: 'jsonSchemaForm.customAnswer', defaultMessage: 'Your own answer (optional)' },
  answerPlaceholder: { id: 'jsonSchemaForm.answerPlaceholder', defaultMessage: 'Type your answer…' },
  customPlaceholder: {
    id: 'jsonSchemaForm.customPlaceholder',
    defaultMessage: 'Or write your own response',
  },
  recommended: { id: 'jsonSchemaForm.recommended', defaultMessage: 'Recommended' },
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
  _meta?: {
    'codepro.dev/optionDescriptions'?: Record<string, string>;
    'codepro.dev/suggestedOptions'?: JsonSchemaChoice[];
    'codepro.dev/questionIntent'?: unknown;
    'codepro.dev/feedbackField'?: string;
  };
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
  questionLabelId?: string;
}

interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

function choicesFor(prop: JsonSchemaProperty): ChoiceOption[] {
  const descriptions = prop._meta?.['codepro.dev/optionDescriptions'] ?? {};
  const titled = prop._meta?.['codepro.dev/suggestedOptions'] ?? prop.oneOf ?? prop.items?.anyOf;
  if (Array.isArray(titled)) {
    return titled
      .filter((choice) => choice && typeof choice.const === 'string')
      .map((choice) => ({
        value: choice.const,
        label: typeof choice.title === 'string' && choice.title ? choice.title : choice.const,
        description:
          typeof choice.description === 'string'
            ? choice.description
            : typeof descriptions[choice.const] === 'string'
              ? descriptions[choice.const]
              : undefined,
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
  questionLabelId,
}: JsonSchemaFormProps) {
  const intl = useIntl();
  const fields = useMemo(() => {
    const entries = Object.entries(schema.properties ?? {});
    const feedbackKeys = new Set(
      entries
        .map(([, prop]) => prop._meta?.['codepro.dev/feedbackField'])
        .filter((key) => key && schema.properties?.[key]?.type === 'string')
    );
    return entries.filter(([key]) => !feedbackKeys.has(key));
  }, [schema.properties]);
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, prop]) => [key, initialValue(prop)])
    )
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
    const field = schema.properties?.[key];
    const feedback = field?._meta?.['codepro.dev/feedbackField'];
    setFormData((current) => ({
      ...current,
      [key]: value,
      ...(field?.type === 'string' && feedback && schema.properties?.[feedback]?.type === 'string'
        ? { [feedback]: '' }
        : {}),
    }));
    setError(undefined);
  };

  if (!fields.length) {
    return <div className="text-text-secondary text-sm">{intl.formatMessage(i18n.noFields)}</div>;
  }

  const [key, prop] = fields[step];
  const value = formData[key];
  const required = schema.required?.includes(key) ?? false;
  const options = choicesFor(prop);
  const values = Array.isArray(value) ? value : [value];
  const feedbackKey = prop._meta?.['codepro.dev/feedbackField'];
  const customKey =
    feedbackKey && feedbackKey !== key && schema.properties?.[feedbackKey]?.type === 'string'
      ? feedbackKey
      : undefined;
  const allowsCustom = Boolean(customKey || prop._meta?.['codepro.dev/suggestedOptions']);
  const customValue = customKey
    ? String(formData[customKey] ?? '')
    : Array.isArray(value)
      ? value.filter((entry) => !options.some((option) => option.value === entry)).join('\n')
      : options.some((option) => option.value === value)
        ? ''
        : String(value ?? '');
  const titleId = questionLabelId ?? `${key}-title`;
  const inlineAnswer =
    compact &&
    Boolean(questionLabelId) &&
    !options.length &&
    !allowsCustom &&
    (!prop.type || prop.type === 'string');
  const isLastStep = step === fields.length - 1;

  const advance = () => {
    const nextError = customKey && customValue.trim() ? undefined : validateField(key, prop, value);
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
      aria-label={option.label}
      aria-description={
        index === 0 && options.length ? intl.formatMessage(i18n.recommended) : undefined
      }
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
        compact && 'rounded-lg border-transparent px-2 py-1'
      )}
    >
      <span className={cn('flex items-start gap-3', compact && 'gap-2')}>
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border',
            compact && 'h-4 w-4 text-[11px]',
            compact || prop.type === 'array' ? 'rounded-md' : 'rounded-full',
            selected
              ? 'border-text-primary bg-text-primary text-background-primary'
              : 'border-border-secondary'
          )}
        >
          {compact ? index + 1 : selected ? <Check className="h-3.5 w-3.5" /> : null}
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-text-primary',
              compact && 'text-xs leading-4'
            )}
          >
            {option.label}
            {index === 0 && options.length > 0 && (
              <span className="rounded bg-background-secondary px-1.5 py-0.5 text-[11px] font-normal text-text-secondary">
                {intl.formatMessage(i18n.recommended)}
              </span>
            )}
          </span>
          {option.description && (
            <span
              className={cn(
                'mt-0.5 block text-xs leading-5 text-text-secondary',
                compact && 'mt-0 text-[11px] leading-4'
              )}
            >
              {option.description}
            </span>
          )}
        </span>
        {selected && compact && (
          <ArrowRight
            className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-text-secondary"
            aria-hidden="true"
          />
        )}
      </span>
    </button>
  );

  const renderField = () => {
    if (options.length && prop.type === 'array') {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div
          className={cn('flex flex-col gap-2', compact && 'gap-0.5')}
          role="group"
          aria-labelledby={titleId}
        >
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
        <div
          className={cn('flex flex-col gap-2', compact && 'gap-0.5')}
          role="radiogroup"
          aria-labelledby={titleId}
        >
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
          aria-labelledby={titleId}
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
          aria-labelledby={titleId}
          rows={compact ? 2 : undefined}
          placeholder={compact ? intl.formatMessage(i18n.answerPlaceholder) : undefined}
          value={String(value ?? '')}
          maxLength={prop.maxLength}
          disabled={disabled}
          onChange={(event) => updateValue(key, event.target.value)}
          className={cn(
            'min-h-32 w-full resize-y rounded-xl border border-border-primary bg-background-primary px-3 py-3 pb-7 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary hover:border-border-secondary focus:border-border-secondary disabled:cursor-not-allowed disabled:opacity-50',
            compact &&
              'block min-h-16 max-h-40 resize-none rounded-lg px-3 py-2 text-base leading-[22px] [field-sizing:content] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-secondary',
            compact && prop.maxLength !== undefined && 'pb-5'
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
    <form
      onSubmit={(event) => {
        event.preventDefault();
        advance();
      }}
      className={cn(
        'flex flex-col gap-4',
        compact && 'gap-1.5',
        inlineAnswer &&
          '@min-[18rem]:grid @min-[18rem]:grid-cols-[minmax(0,1fr)_auto] @min-[18rem]:items-end'
      )}
    >
      <div
        className={cn(
          'flex flex-col gap-3',
          compact && 'min-w-0 max-h-[min(26vh,14rem)] gap-1.5 overflow-y-auto'
        )}
      >
        {(!questionLabelId || prop.description) && (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {!questionLabelId && (
                <h3
                  id={`${key}-title`}
                  className={cn(
                    'text-base font-semibold text-text-primary',
                    compact && 'text-xs leading-4'
                  )}
                >
                  {prop.title || key}
                  {required && !compact && <span className="ml-1 text-red-500">*</span>}
                </h3>
              )}
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
        )}

        {renderField()}
        {allowsCustom && (
          <Input
            aria-label={intl.formatMessage(i18n.customAnswer)}
            placeholder={intl.formatMessage(i18n.customPlaceholder)}
            value={customValue}
            disabled={disabled}
            onChange={(event) => {
              if (customKey && prop.type === 'string') {
                setFormData((current) => ({
                  ...current,
                  [key]: '',
                  [customKey]: event.target.value,
                }));
                setError(undefined);
              } else
                updateValue(
                  customKey ?? key,
                  !customKey && prop.type === 'array'
                    ? [
                        ...values.filter((item) => options.some((option) => option.value === item)),
                        ...(event.target.value ? [event.target.value] : []),
                      ]
                    : event.target.value
                );
            }}
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
      </div>

      <div
        className={cn(
          'mt-1 flex items-center justify-end gap-2 border-t border-border-primary pt-3',
          compact && 'mt-0 gap-1 border-0 pt-0'
        )}
      >
        {onCancel && (
          <Button
            type="button"
            size={compact ? 'sm' : 'default'}
            variant={compact ? 'ghost' : 'outline'}
            onClick={onCancel}
            disabled={disabled}
          >
            {cancelLabel ?? intl.formatMessage(i18n.cancel)}
          </Button>
        )}
        {step > 0 && (
          <Button
            type="button"
            size={compact ? 'sm' : 'default'}
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
        <Button type="submit" size={compact ? 'sm' : 'default'} disabled={disabled}>
          {isLastStep
            ? (submitLabel ?? intl.formatMessage(i18n.submit))
            : intl.formatMessage(i18n.next)}
          {!isLastStep && <ChevronRight className="ml-1 h-4 w-4" />}
        </Button>
      </div>
    </form>
  );
}
