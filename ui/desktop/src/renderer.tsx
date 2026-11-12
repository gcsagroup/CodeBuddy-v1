import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import './styles/main.css';
import { ConfigProvider } from './components/ConfigContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import SuspenseLoader from './suspense-loader';
import { applyThemeTokens } from './theme/theme-tokens';
import { currentLocale, currentMessageLocale, loadMessages } from './i18n';
import { initializeNewTaskDrafts } from './utils/newTaskDraft';

// Apply theme tokens to :root before first paint.
applyThemeTokens();

const App = lazy(async () => {
  const [app] = await Promise.all([import('./App'), initializeNewTaskDrafts()]);
  return app;
});

let warnedFallbackLocale = false;
function handleIntlError(err: { code: string; message?: string }) {
  if (err.code === 'MISSING_TRANSLATION' && currentLocale !== currentMessageLocale) {
    if (!warnedFallbackLocale) {
      warnedFallbackLocale = true;
      console.warn(
        `[i18n] Locale "${currentLocale}" has no translations; falling back to "${currentMessageLocale}".`
      );
    }
    return;
  }
  console.error(err);
}

(async () => {
  if (window.location.hash.startsWith('#/desktop-pet')) {
    const [{ default: DesktopPet }, { ThemeProvider }] = await Promise.all([
      import('./pets/DesktopPet'), import('./contexts/ThemeContext'),
    ]);
    ReactDOM.createRoot(document.getElementById('root')!).render(<ThemeProvider><DesktopPet /></ThemeProvider>);
    return;
  }
  const messages = await loadMessages(currentMessageLocale);

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <IntlProvider
        locale={currentLocale}
        defaultLocale="en"
        messages={messages}
        onError={handleIntlError}
      >
        <Suspense fallback={<SuspenseLoader />}>
          <ConfigProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </ConfigProvider>
        </Suspense>
      </IntlProvider>
    </React.StrictMode>
  );
})();
