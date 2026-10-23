import { defineMessages, useIntl } from '../i18n';
import MarkdownContent from './MarkdownContent';
import JsonSchemaForm from './ui/JsonSchemaForm';
import type { JsonSchema } from './ui/JsonSchemaForm';

const messages = defineMessages({
  hint: { id: 'planReview.hint', defaultMessage: 'Review the plan before implementation begins.' },
  approve: { id: 'planReview.approve', defaultMessage: 'Approve and implement' },
  keepPlanning: { id: 'planReview.keepPlanning', defaultMessage: 'Keep planning' },
  choose: { id: 'planReview.choose', defaultMessage: 'How would you like to proceed?' },
  skip: { id: 'elicitationRequest.skip', defaultMessage: 'Skip' },
  send: { id: 'planReview.send', defaultMessage: 'Send' },
  submitting: { id: 'planReview.submitting', defaultMessage: 'Submitting…' },
});

interface PlanReview {
  key: string;
  plan: string;
  approve: string;
  keepPlanning: string;
  feedbackKey: string;
}

// The native presentation hint selects this view. Text and option labels never
// determine approval intent; unsupported schemas retain the generic question UI.
export function getPlanReview(schema: JsonSchema): PlanReview | undefined {
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length !== 2) return;
  const question = entries.find(([, field]) => field._meta?.['codepro.dev/questionIntent']);
  if (!question) return;
  const [key, field] = question;
  const feedbackKey = field._meta?.['codepro.dev/feedbackField'];
  if (!feedbackKey || feedbackKey === key || schema.properties?.[feedbackKey]?.type !== 'string')
    return;
  const intent = field._meta?.['codepro.dev/questionIntent'];
  if (
    !intent ||
    typeof intent !== 'object' ||
    !('kind' in intent) ||
    intent.kind !== 'plan-review' ||
    !('approve' in intent) ||
    typeof intent.approve !== 'string' ||
    field.type !== 'string' ||
    typeof field.description !== 'string' ||
    !field.description.trim()
  )
    return;
  const options = field._meta?.['codepro.dev/suggestedOptions'];
  if (
    !Array.isArray(options) ||
    options.length !== 2 ||
    options.some((option) => !option || typeof option.const !== 'string') ||
    !options.some((option) => option.const === intent.approve)
  )
    return;
  const keepPlanning = options.find((option) => option.const !== intent.approve)?.const;
  if (!keepPlanning) return;
  return { key, plan: field.description, approve: intent.approve, keepPlanning, feedbackKey };
}

export default function PlanReviewForm({
  review,
  disabled,
  onSubmit,
  onCancel,
}: {
  review: PlanReview;
  disabled: boolean;
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-xs leading-5 text-text-secondary">{intl.formatMessage(messages.hint)}</p>
      <div className="max-h-[min(22vh,16rem)] overflow-y-auto overscroll-contain rounded-xl border border-border-primary bg-background-secondary/40 px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere] [&_pre]:max-w-full">
        <MarkdownContent
          content={review.plan}
          className="prose-h1:!text-base prose-h1:!font-semibold prose-h1:!mb-3 prose-h2:!text-base prose-h2:!font-medium prose-h2:!mb-2 prose-h3:!text-sm"
        />
      </div>
      <JsonSchemaForm
        compact
        disabled={disabled}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitLabel={intl.formatMessage(disabled ? messages.submitting : messages.send)}
        cancelLabel={intl.formatMessage(messages.skip)}
        schema={{
          type: 'object',
          required: [review.key],
          properties: {
            [review.key]: {
              type: 'string',
              title: intl.formatMessage(messages.choose),
              _meta: {
                'codepro.dev/suggestedOptions': [
                  { const: review.approve, title: intl.formatMessage(messages.approve) },
                  { const: review.keepPlanning, title: intl.formatMessage(messages.keepPlanning) },
                ],
                'codepro.dev/feedbackField': review.feedbackKey,
              },
            },
            [review.feedbackKey]: { type: 'string' },
          },
        }}
      />
    </div>
  );
}
