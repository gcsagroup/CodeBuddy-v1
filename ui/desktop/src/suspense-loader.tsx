import GooseLogo from './components/GooseLogo';
import { defineMessages, useIntl } from './i18n';
import './styles/startup-loader.css';

const i18n = defineMessages({
  loading: {
    id: 'suspenseLoader.loading',
    defaultMessage: 'Loading...',
  },
});

export default function SuspenseLoader() {
  const intl = useIntl();
  return (
    <div className="startup-loader">
      <div className="startup-loader__content" role="status" aria-live="polite">
        <div className="startup-loader__mark" aria-hidden="true">
          <GooseLogo hover={false} />
        </div>
        <h1 className="startup-loader__title">CodeBuddy</h1>
        <p className="startup-loader__label">{intl.formatMessage(i18n.loading)}</p>
        <div className="startup-loader__activity" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
