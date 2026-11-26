import { expect, it } from 'vitest';
import { createExtensionRecoverHints, formatExtensionErrorMessage } from './extensionErrorUtils';
it('preserves diagnostic detail for explicit extension actions', () => {
 const error='ImportError: cannot import ModelWrapValidatorHandler from pydantic. '.repeat(3);
 expect(formatExtensionErrorMessage(error)).toBe(error.trim());
 expect(createExtensionRecoverHints(error)).toContain(error);
 expect(createExtensionRecoverHints(error)).not.toContain('VPN');
});
