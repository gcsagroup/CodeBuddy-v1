import { beforeEach, expect, it, vi } from 'vitest';
const { extMethod } = vi.hoisted(() => ({ extMethod: vi.fn() }));
vi.mock('../acpConnection', () => ({ getAcpClient: async () => ({ extMethod }) }));
import { acpExportSessionLog } from '../sessions';
beforeEach(() => vi.clearAllMocks());
it('accepts only a matching non-restorable diagnostic preview from the backend', async () => {
  const data =
    JSON.stringify({
      type: 'log-export',
      revision: 'codebuddy-log-v2',
      detail: 'detailed',
      restorable: false,
    }) + '\n';
  extMethod.mockResolvedValue({ data });
  expect(await acpExportSessionLog('fixture', 'detailed')).toBe(data);
  expect(extMethod).toHaveBeenCalledWith('_goose/unstable/session/log/export', {
    sessionId: 'fixture',
    detail: 'detailed',
  });
});
it('refuses raw journals, older formats and mismatched detail instead of presenting them as redacted', async () => {
  for (const header of [
    { type: 'session' },
    { type: 'diagnostic-export', revision: 'codebuddy-safe-v1' },
    { type: 'log-export', revision: 'codebuddy-log-v2', detail: 'standard', restorable: false },
  ]) {
    extMethod.mockResolvedValue({ data: JSON.stringify(header) + '\n' });
    await expect(acpExportSessionLog('fixture', 'detailed')).rejects.toThrow();
  }
});
