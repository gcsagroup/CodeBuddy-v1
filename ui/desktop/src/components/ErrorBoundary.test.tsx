import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { ErrorBoundary, ErrorUI } from './ErrorBoundary';

const secret = 'PRIVATE_DIAGNOSTIC_PAYLOAD';
beforeEach(() => {
  window.electron.logInfo = vi.fn();
  window.electron.reloadApp = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

it('never renders raw error text in the reload screen', () => {
  render(
    <ErrorUI
      error={`Minified React error #185; ${secret} https://private.invalid/?token=${secret}`}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.queryByText(new RegExp(secret))).toBeNull();
  expect(screen.getByText(/185/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /reload/i }));
  expect(window.electron.reloadApp).toHaveBeenCalledTimes(1);
});

it('records a useful bounded React category without error payloads or machine paths', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const logged = vi.spyOn(window.electron, 'logInfo');
  const error = new Error(`Maximum update depth exceeded. ${secret}`);
  error.stack = `Error: ${secret}\n at BaseChat (https://${secret}.invalid/assets/main.js:123:45)\n at ${secret} (C:\\Users\\${secret}\\file.tsx:4:5)`;
  const Fail = () => {
    throw error;
  };
  render(
    <ErrorBoundary>
      <Fail />
    </ErrorBoundary>,
    { wrapper: IntlTestWrapper }
  );
  const output = JSON.stringify(logged.mock.calls);
  expect(output).not.toContain(secret);
  expect(output).not.toContain('https://');
  expect(output).not.toContain('C:');
  expect(output).toContain('185');
});

it('global rejection diagnostics exclude arbitrary object messages, causes and stacks', () => {
  const logged = vi.spyOn(window.electron, 'logInfo');
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', {
    value: { message: secret, apiKey: secret, cause: { stack: secret } },
  });
  window.dispatchEvent(event);
  expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
});
