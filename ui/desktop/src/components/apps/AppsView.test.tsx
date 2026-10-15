import { describe, expect, it, vi } from 'vitest';
import { launchAppWithUsage } from './AppsView';

describe('launchAppWithUsage', () => {
  it('records usage only after app initialization succeeds', async () => {
    const app = { name: 'Dashboard', uri: 'ui://dashboard', mimeType: 'text/html' };
    const launch = vi.fn().mockResolvedValue(undefined);
    const recordSuccess = vi.fn().mockResolvedValue(true);

    await launchAppWithUsage(app, {
      launch,
      recordSuccess,
      createEventId: () => 'app-open:1',
    });

    expect(launch).toHaveBeenCalledWith(app);
    expect(recordSuccess).toHaveBeenCalledWith({
      eventId: 'app-open:1',
      kind: 'app',
      capabilityId: 'ui://dashboard',
      recentResult: 'initialized',
      reference: 'app:ui://dashboard',
    });
  });

  it('does not record a failed launch', async () => {
    const recordSuccess = vi.fn();
    await expect(
      launchAppWithUsage(
        { name: 'Dashboard', uri: 'ui://dashboard', mimeType: 'text/html' },
        {
          launch: vi.fn().mockRejectedValue(new Error('launch failed')),
          recordSuccess,
          createEventId: () => 'app-open:2',
        }
      )
    ).rejects.toThrow('launch failed');
    expect(recordSuccess).not.toHaveBeenCalled();
  });
});
