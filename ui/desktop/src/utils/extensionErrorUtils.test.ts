import { expect, it, vi } from 'vitest';
import {
  createExtensionRecoverHints,
  formatExtensionErrorMessage,
  showExtensionLoadResults,
} from './extensionErrorUtils';
import { toastService } from '../toasts';
vi.mock('../toasts', () => ({ toastService: { extensionLoading: vi.fn() } }));

it('preserves long diagnostic detail and does not repeatedly toast the same outcome', () => {
  const error = 'ImportError: cannot import ModelWrapValidatorHandler from pydantic. '.repeat(3);
  expect(formatExtensionErrorMessage(error)).toBe(error.trim());
  expect(createExtensionRecoverHints(error)).toContain(error);
  expect(createExtensionRecoverHints(error)).not.toContain('VPN');
  const failed = [{ name: 'scrapling', success: false, error }];
  showExtensionLoadResults(failed);
  showExtensionLoadResults(failed);
  expect(toastService.extensionLoading).toHaveBeenCalledTimes(1);
  showExtensionLoadResults([{ name: 'scrapling', success: true }]);
  showExtensionLoadResults(failed);
  expect(toastService.extensionLoading).toHaveBeenCalledTimes(2);
});

it('does not repeat an unchanged failure when other connections or session selections change', () => {
  vi.mocked(toastService.extensionLoading).mockClear();
  const failed = { name: 'isolated-test', success: false, error: 'Dependency unavailable' };
  showExtensionLoadResults([failed, { name: 'peer', success: true }]);
  showExtensionLoadResults([{ name: 'peer', success: false, error: 'HTTP 503' }, failed]);
  expect(toastService.extensionLoading).toHaveBeenCalledTimes(2);
  showExtensionLoadResults([{ name: 'peer', success: true }]);
  showExtensionLoadResults([failed]);
  expect(toastService.extensionLoading).toHaveBeenCalledTimes(2);
  showExtensionLoadResults([{ ...failed, error: 'HTTP 401' }]);
  expect(toastService.extensionLoading).toHaveBeenCalledTimes(3);
});
