import { render, screen, act } from '@testing-library/react';
import { Suspense, lazy } from 'react';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import SuspenseLoader from './suspense-loader';

describe('startup loading screen', () => {
  it.each([
    ['zh-CN', '正在加载…'],
    ['zh-TW', '載入中…'],
    ['en', 'Loading...'],
  ])('announces loading in %s without reporting a made-up percentage', (locale, loading) => {
    render(
      <IntlProvider locale={locale} messages={{ 'suspenseLoader.loading': loading }}>
        <SuspenseLoader />
      </IntlProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent(loading);
    expect(screen.getByRole('heading', { name: loading })).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('yields to the application as soon as the module is ready', async () => {
    let finish!: (module: { default: () => React.ReactNode }) => void;
    const Application = lazy(
      () =>
        new Promise<{ default: () => React.ReactNode }>((resolve) => {
          finish = resolve;
        })
    );
    render(
      <IntlProvider locale="en">
        <Suspense fallback={<SuspenseLoader />}>
          <Application />
        </Suspense>
      </IntlProvider>
    );
    expect(screen.getByRole('status')).toBeVisible();
    await act(async () => finish({ default: () => <main>Application ready</main> }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('Application ready');
  });
});
