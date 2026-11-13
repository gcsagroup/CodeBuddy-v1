import { expect, it } from 'vitest';
import { formatFailureDiagnostic, parseFailureDiagnostic } from './failureDiagnostic';
import { acpErrorDiagnostic } from '../acp/errors';

it('only exposes known codes and bounded numeric status, excluding all arbitrary values', () => {
  const input = {
    code: 'AUTH',
    httpStatus: 401,
    message: 'PRIVATE',
    url: 'https://PRIVATE',
    transportCodes: ['PRIVATE', 'ECONNREFUSED', 'ECONNREFUSED'],
    headers: { authorization: 'PRIVATE' },
  };
  expect(parseFailureDiagnostic(input)).toEqual({
    code: 'AUTH',
    httpStatus: 401,
    transportCodes: ['ECONNREFUSED'],
  });
  expect(formatFailureDiagnostic(input)).toBe('AUTH; HTTP 401; ECONNREFUSED');
  for (const value of [null, undefined, 'PRIVATE', {}, { code: 'PRIVATE' }])
    expect(formatFailureDiagnostic(value)).toBeUndefined();
  for (const httpStatus of [-1, 600, 401.5, '401', NaN, Infinity])
    expect(parseFailureDiagnostic({ code: 'AUTH', httpStatus })).toEqual({ code: 'AUTH' });
  expect(acpErrorDiagnostic({ message: 'PRIVATE', data: { diagnostic: input } })).not.toContain(
    'PRIVATE'
  );
});
