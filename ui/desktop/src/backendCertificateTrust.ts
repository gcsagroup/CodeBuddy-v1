import { createHash } from 'node:crypto';

export interface BackendCertificateData {
  data: string;
}

export function getBackendCertificateSha256Fingerprint(
  certificate: BackendCertificateData
): string {
  const match = certificate.data.match(
    /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/
  );
  if (!match) {
    throw new Error('Certificate data is not PEM encoded');
  }

  const der = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  if (der.length === 0) {
    throw new Error('Certificate data is empty');
  }

  return createHash('sha256').update(der).digest('hex').match(/.{2}/g)!.join(':').toUpperCase();
}
