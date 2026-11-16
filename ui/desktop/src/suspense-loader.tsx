import type { ReactNode } from 'react';
import { CodeBuddyMark } from './components/CodeBuddyMark';
import { defineMessages, useIntl } from './i18n';
import './styles/startup-loader.css';

const i18n = defineMessages({
  loading: {
    id: 'suspenseLoader.loading',
    defaultMessage: 'Loading...',
  },
});

export default function SuspenseLoader({ label, action }: { label?: string; action?: ReactNode } = {}) {
  const intl = useIntl();
  return (
    <div className="startup-loader">
      <div className="startup-loader__content" role="status" aria-live="polite">
        <div className="startup-loader__mark conversation-loading-brand" aria-hidden="true">
          <CodeBuddyMark />
        </div>
        <h1 className="startup-loader__title">{label ?? intl.formatMessage(i18n.loading)}</h1>
        {action}
      </div>
    </div>
  );
}
