import GooseLogo from './components/GooseLogo';
import { defineMessages, useIntl } from './i18n';

const i18n = defineMessages({
  loading: {
    id: 'suspenseLoader.loading',
    defaultMessage: 'Loading...',
  },
});

export default function SuspenseLoader() {
  const intl = useIntl();
  return (
    <div className="flex flex-col items-start justify-end w-screen h-screen overflow-hidden p-6 page-transition">
      <div className="flex gap-2 items-center justify-end">
        <GooseLogo size="small" />
        <span className="text-text-secondary">{intl.formatMessage(i18n.loading)}</span>
      </div>
    </div>
  );
}
