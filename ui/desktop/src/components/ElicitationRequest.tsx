import { useState, useEffect, useRef } from 'react';
import { MessageCircleQuestion, ChevronDown, ChevronUp } from 'lucide-react';
import type { ActionRequired } from '../types/message';
import { defineMessages, useIntl } from '../i18n';
import { Button } from './ui/button';
import JsonSchemaForm from './ui/JsonSchemaForm';
import type { JsonSchema } from './ui/JsonSchemaForm';
import { cn } from '../utils';

const i18n = defineMessages({
  question: { id: 'elicitationRequest.question', defaultMessage: 'Question' },
  collapse: { id: 'elicitationRequest.collapse', defaultMessage: 'Collapse question' },
  expand: {
    id: 'elicitationRequest.expand',
    defaultMessage: 'Expand question awaiting your reply',
  },
  skip: { id: 'elicitationRequest.skip', defaultMessage: 'Skip' },
  submitting: { id: 'elicitationRequest.submitting', defaultMessage: 'Submitting…' },
  cancelled: {
    id: 'elicitationRequest.cancelled',
    defaultMessage: 'Information request was cancelled.',
  },
  submitted: {
    id: 'elicitationRequest.submitted',
    defaultMessage: 'Information submitted',
  },
  expired: {
    id: 'elicitationRequest.expired',
    defaultMessage: 'This request has expired. The extension will need to ask again.',
  },
  defaultMessage: {
    id: 'elicitationRequest.defaultMessage',
    defaultMessage: 'CodeBuddy needs some information from you.',
  },
  submit: {
    id: 'elicitationRequest.submit',
    defaultMessage: 'Submit',
  },
  accept: {
    id: 'elicitationRequest.accept',
    defaultMessage: 'Accept',
  },
  waitingForResponse: {
    id: 'elicitationRequest.waitingForResponse',
    defaultMessage: 'Waiting for your response ({timeRemaining} remaining)',
  },
  submitError: {
    id: 'elicitationRequest.submitError',
    defaultMessage: 'This request is no longer active. The extension will need to ask again.',
  },
});

const ELICITATION_TIMEOUT_SECONDS = 300;

interface ElicitationRequestProps {
  standalone?: boolean;
  isCancelledMessage: boolean;
  isClicked: boolean;
  actionRequiredContent: ActionRequired & { type: 'actionRequired' };
  onSubmit: (
    elicitationId: string,
    userData: Record<string, unknown>,
    action?: 'accept' | 'cancel'
  ) => Promise<boolean>;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function ElicitationRequest({
  isCancelledMessage,
  isClicked,
  actionRequiredContent,
  onSubmit,
  standalone = false,
}: ElicitationRequestProps) {
  const intl = useIntl();
  const [submitted, setSubmitted] = useState(isClicked);
  const [submittedAction, setSubmittedAction] = useState<'accept' | 'cancel'>('accept');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(ELICITATION_TIMEOUT_SECONDS);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    if (isClicked) {
      setSubmitted(true);
      setSubmitError(undefined);
    }
  }, [isClicked]);

  useEffect(() => {
    if (submitted || isCancelledMessage || isClicked) return;

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const remaining = Math.max(0, ELICITATION_TIMEOUT_SECONDS - elapsed);
      setTimeRemaining(remaining);

      if (remaining === 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [submitted, isCancelledMessage, isClicked]);

  if (actionRequiredContent.data.actionType !== 'elicitation') {
    return null;
  }

  const { id: elicitationId, message, requested_schema } = actionRequiredContent.data;

  const schema = (requested_schema ?? {}) as JsonSchema;
  const hasSchemaFields = Boolean(schema.properties && Object.keys(schema.properties).length > 0);

  const submitResponse = async (
    formData: Record<string, unknown>,
    action: 'accept' | 'cancel' = 'accept'
  ) => {
    setSubmittedAction(action);
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      const didSubmit =
        action === 'cancel'
          ? await onSubmit(elicitationId, formData, action)
          : await onSubmit(elicitationId, formData);
      if (didSubmit) {
        setSubmitted(true);
      } else {
        setSubmitted(false);
        setSubmitError(intl.formatMessage(i18n.submitError));
      }
    } catch (error) {
      console.error('Error submitting elicitation response:', error);
      setSubmitted(false);
      setSubmitError(intl.formatMessage(i18n.submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = (formData: Record<string, unknown>) => {
    void submitResponse(formData);
  };

  const handleAccept = () => {
    void submitResponse({});
  };

  const handleCancel = () => {
    void submitResponse({}, 'cancel');
  };

  if (isCancelledMessage) {
    return (
      <div className="goose-message-content bg-background-secondary rounded-2xl px-4 py-2 text-text-primary">
        {intl.formatMessage(i18n.cancelled)}
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="goose-message-content bg-background-secondary rounded-2xl px-4 py-2 text-text-primary">
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-gray-500"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span>
            {intl.formatMessage(submittedAction === 'cancel' ? i18n.cancelled : i18n.submitted)}
          </span>
        </div>
      </div>
    );
  }

  const isUrgent = timeRemaining <= 60;
  const isExpired = timeRemaining === 0;

  if (isExpired) {
    return (
      <div className="goose-message-content bg-background-secondary rounded-2xl px-4 py-2 text-text-primary">
        <div className="flex items-center gap-2 text-text-secondary">
          <svg
            className="w-5 h-5"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>{intl.formatMessage(i18n.expired)}</span>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label={intl.formatMessage(i18n.question)}
      className={cn(
        'flex flex-col',
        standalone &&
          'shrink-0 rounded-2xl border border-border-primary bg-background-primary shadow-sm'
      )}
    >
      {standalone && (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-t-2xl px-4 py-2 text-text-secondary hover:bg-background-secondary focus-visible:ring-1 focus-visible:ring-border-secondary"
          aria-label={intl.formatMessage(collapsed ? i18n.expand : i18n.collapse)}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="flex items-center gap-2 text-xs text-text-secondary">
            <MessageCircleQuestion className="h-4 w-4" aria-hidden="true" />
            {intl.formatMessage(collapsed ? i18n.expand : i18n.question)}
          </span>
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      )}
      <div hidden={standalone && collapsed}>
        {(message || !hasSchemaFields) && (
          <div
            className={cn(
              'goose-message-content px-4 py-2 text-sm text-text-primary',
              !standalone && 'bg-background-secondary rounded-2xl rounded-b-none'
            )}
          >
            {message || intl.formatMessage(i18n.defaultMessage)}
          </div>
        )}
        <div
          className={cn(
            'goose-message-content bg-background-primary px-4 pb-3 pt-1',
            !standalone && 'border border-border-primary dark:border-gray-700 rounded-b-2xl py-3'
          )}
        >
          {hasSchemaFields ? (
            <JsonSchemaForm
              compact={standalone}
              schema={schema}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              submitLabel={intl.formatMessage(isSubmitting ? i18n.submitting : i18n.submit)}
              cancelLabel={standalone ? intl.formatMessage(i18n.skip) : undefined}
              disabled={isSubmitting}
            />
          ) : (
            <div className="flex gap-2">
              <Button type="button" onClick={handleAccept} disabled={isSubmitting}>
                {intl.formatMessage(isSubmitting ? i18n.submitting : i18n.accept)}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                disabled={isSubmitting}
              >
                {standalone
                  ? intl.formatMessage(i18n.skip)
                  : intl.formatMessage({ id: 'jsonSchemaForm.cancel', defaultMessage: 'Cancel' })}
              </Button>
            </div>
          )}
          {submitError && (
            <div role="alert" className="mt-3 text-sm text-red-500">
              {submitError}
            </div>
          )}
          <div className={`mt-2 text-xs ${isUrgent ? 'text-red-500' : 'text-text-secondary'}`}>
            <span>
              {intl.formatMessage(i18n.waitingForResponse, {
                timeRemaining: formatTime(timeRemaining),
              })}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
