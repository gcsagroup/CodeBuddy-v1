import { describe, expect, it } from 'vitest';
import { getBackendCertificateSha256Fingerprint } from './backendCertificateTrust';

describe('getBackendCertificateSha256Fingerprint', () => {
  it('derives a SHA-256 fingerprint from Electron certificate PEM data', () => {
    expect(
      getBackendCertificateSha256Fingerprint({
        data: '-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----',
      })
    ).toBe(
      '03:90:58:C6:F2:C0:CB:49:2C:53:3B:0A:4D:14:EF:77:CC:0F:78:AB:CC:CE:D5:28:7D:84:A1:A2:01:1C:FB:81'
    );
  });

  it('rejects data that is not a PEM certificate', () => {
    expect(() => getBackendCertificateSha256Fingerprint({ data: 'not-a-certificate' })).toThrow(
      'Certificate data is not PEM encoded'
    );
  });
});
