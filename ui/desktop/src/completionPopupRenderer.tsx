import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider, useIntl } from 'react-intl';
import { CompletionReminderCard } from './components/CompletionReminderCard';
import type { CompletionPopupBridge } from './completionPopupPreload';
import { loadMessages } from './i18n';
import { applyThemeTokens } from './theme/theme-tokens';
import './styles/main.css';
import './components/extension-toast.css';

declare global { interface Window { completionPopup: CompletionPopupBridge } }
const bridge = window.completionPopup;
function Popup({ title, body }: { title: string; body: string }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const intl = useIntl();
  useLayoutEffect(() => {
    if (!ref.current) return;
    void bridge.show(ref.current.offsetHeight).then(() => setVisible(true));
  }, []);
  return <main className="completion-popup" ref={ref}>
    <button className="completion-popup-close" aria-label={intl.formatMessage({ id: 'dialog.close', defaultMessage: 'Close' })}
      onClick={bridge.dismiss}>×</button>
    <CompletionReminderCard title={title} body={body} open={bridge.open} send={bridge.reply}
      onExpire={visible ? bridge.dismiss : undefined} />
  </main>;
}

void (async () => {
  const { title, body, locale } = await bridge.read();
  const messages = await loadMessages(locale);
  document.documentElement.lang = locale;
  applyThemeTokens();
  createRoot(document.getElementById('root')!).render(
    <IntlProvider locale={locale} messages={messages}><Popup title={title} body={body} /></IntlProvider>
  );
})();
