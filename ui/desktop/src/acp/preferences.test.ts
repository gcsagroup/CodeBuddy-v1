import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreferenceValue, PreferencesReadResponse_unstable } from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';
import { readPreferences, removePreferences, savePreferences } from './preferences';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const preference = (value: unknown): PreferenceValue => ({
  key: 'voiceDictationPreferredMic',
  value,
  isMutable: true,
});

describe('typed ACP preferences adapter', () => {
  const preferencesRead_unstable = vi.fn();
  const preferencesSave_unstable = vi.fn();
  const preferencesRemove_unstable = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: {
        preferencesRead_unstable,
        preferencesSave_unstable,
        preferencesRemove_unstable,
      },
    } as never);
  });

  it('reads through the generated typed client and returns its validated revision', async () => {
    const response: PreferencesReadResponse_unstable = {
      revision: 7,
      values: [preference('mic-7')],
    };
    preferencesRead_unstable.mockResolvedValue(response);

    await expect(readPreferences(['voiceDictationPreferredMic'])).resolves.toEqual(response);
    expect(preferencesRead_unstable).toHaveBeenCalledWith({
      keys: ['voiceDictationPreferredMic'],
    });
  });

  it('serializes the full read-mutate-refresh transaction across concurrent callers', async () => {
    const firstRefresh = deferred<PreferencesReadResponse_unstable>();
    preferencesRead_unstable
      .mockResolvedValueOnce({ revision: 0, values: [] })
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce({ revision: 1, values: [preference('mic-a')] })
      .mockResolvedValueOnce({ revision: 2, values: [preference('mic-b')] });
    preferencesSave_unstable.mockResolvedValue(undefined);

    const first = savePreferences([preference('mic-a')]);
    const second = savePreferences([preference('mic-b')]);
    await vi.waitFor(() => expect(preferencesRead_unstable).toHaveBeenCalledTimes(2));

    expect(preferencesSave_unstable).toHaveBeenCalledTimes(1);
    firstRefresh.resolve({ revision: 1, values: [preference('mic-a')] });

    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(second).resolves.toMatchObject({ revision: 2 });
    expect(preferencesSave_unstable.mock.calls).toEqual([
      [{ expectedRevision: 0, values: [preference('mic-a')] }],
      [{ expectedRevision: 1, values: [preference('mic-b')] }],
    ]);
  });

  it('refreshes and retries exactly once for an own-property typed revision conflict', async () => {
    preferencesRead_unstable
      .mockResolvedValueOnce({ revision: 3, values: [] })
      .mockResolvedValueOnce({ revision: 4, values: [] })
      .mockResolvedValueOnce({ revision: 5, values: [preference('mic-5')] });
    preferencesSave_unstable
      .mockRejectedValueOnce({
        data: {
          code: 'preference_revision_conflict',
          expectedRevision: 3,
          actualRevision: 4,
        },
      })
      .mockResolvedValueOnce(undefined);

    await expect(savePreferences([preference('mic-5')])).resolves.toMatchObject({ revision: 5 });
    expect(preferencesSave_unstable.mock.calls).toEqual([
      [{ expectedRevision: 3, values: [preference('mic-5')] }],
      [{ expectedRevision: 4, values: [preference('mic-5')] }],
    ]);
  });

  it.each([
    ['text-only error', new Error('preference_revision_conflict')],
    [
      'inherited data',
      Object.create({
        data: {
          code: 'preference_revision_conflict',
          expectedRevision: 1,
          actualRevision: 2,
        },
      }),
    ],
    ['wrong code', { data: { code: 'preference_store_unavailable' } }],
  ])('does not retry a non-authoritative conflict shape: %s', async (_label, reason) => {
    preferencesRead_unstable.mockResolvedValue({ revision: 1, values: [] });
    preferencesRemove_unstable.mockRejectedValue(reason);

    await expect(removePreferences(['voiceDictationProvider'])).rejects.toBe(reason);
    expect(preferencesRemove_unstable).toHaveBeenCalledTimes(1);
    expect(preferencesRead_unstable).toHaveBeenCalledTimes(1);
  });

  it('does not replay a committed mutation when the authoritative refresh fails', async () => {
    const refreshFailure = new Error('refresh unavailable');
    preferencesRead_unstable
      .mockResolvedValueOnce({ revision: 9, values: [] })
      .mockRejectedValueOnce(refreshFailure);
    preferencesRemove_unstable.mockResolvedValue(undefined);

    await expect(removePreferences(['voiceDictationPreferredMic'])).rejects.toBe(refreshFailure);
    expect(preferencesRemove_unstable).toHaveBeenCalledTimes(1);
    expect(preferencesRemove_unstable).toHaveBeenCalledWith({
      expectedRevision: 9,
      keys: ['voiceDictationPreferredMic'],
    });
    expect(preferencesRead_unstable).toHaveBeenCalledTimes(2);
  });
});
