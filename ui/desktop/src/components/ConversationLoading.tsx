import { LoaderCircle } from 'lucide-react';
import { useIntl } from '../i18n';

export default function ConversationLoading() {
  const intl = useIntl();
  return (
    <div
      data-testid="conversation-loading"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background-primary px-6 pointer-events-none"
    >
      <div role="status" aria-live="polite" aria-atomic="true"
        className="flex items-center gap-3 rounded-xl border border-border-primary bg-background-secondary px-5 py-4 text-base font-medium text-text-primary shadow-sm">
        <LoaderCircle className="size-5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>{intl.formatMessage({ id: 'loadingGoose.loadingConversation', defaultMessage: 'Loading conversation…' })}</span>
      </div>
    </div>
  );
}
