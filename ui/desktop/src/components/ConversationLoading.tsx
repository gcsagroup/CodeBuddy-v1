import ConversationSpinner from './ConversationSpinner';
import { useIntl } from '../i18n';

export default function ConversationLoading() {
  const intl = useIntl();
  return (
    <div
      data-testid="conversation-loading"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background-primary px-6 pointer-events-none"
    >
      <div role="status" aria-live="polite" aria-atomic="true"
        className="flex flex-col items-center gap-5 px-5 py-4 text-lg font-semibold text-text-primary">
        <ConversationSpinner size="large" />
        <span>{intl.formatMessage({ id: 'loadingGoose.loadingConversation', defaultMessage: 'Loading conversation…' })}</span>
      </div>
    </div>
  );
}
