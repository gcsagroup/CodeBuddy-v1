import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDictationPreferences, setDictationPreferences } from './dictationPreferences';

const preferenceMocks = vi.hoisted(() => ({
  readPreferences: vi.fn(),
  savePreferences: vi.fn(),
  removePreferences: vi.fn(),
}));

vi.mock('./preferences', () => preferenceMocks);

const { readPreferences, savePreferences, removePreferences } = preferenceMocks;

describe('dictation typed preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads both keys once and strictly returns the supported provider and microphone', async () => {
    vi.mocked(readPreferences).mockResolvedValue({
      revision: 12,
      values: [
        { key: 'voiceDictationProvider', value: 'groq' },
        { key: 'voiceDictationPreferredMic', value: 'device-12' },
      ],
    });

    await expect(readDictationPreferences()).resolves.toEqual({
      revision: 12,
      provider: 'groq',
      preferredMic: 'device-12',
    });
    expect(readPreferences).toHaveBeenCalledWith([
      'voiceDictationProvider',
      'voiceDictationPreferredMic',
    ]);
  });

  it.each([
    ['unknown provider', [{ key: 'voiceDictationProvider', value: 'unknown-provider' }]],
    ['non-string provider', [{ key: 'voiceDictationProvider', value: 7 }]],
    ['non-string microphone', [{ key: 'voiceDictationPreferredMic', value: 7 }]],
  ])('rejects malformed authoritative values: %s', async (_label, values) => {
    vi.mocked(readPreferences).mockResolvedValue({ revision: 1, values } as never);

    await expect(readDictationPreferences()).rejects.toThrow('Invalid dictation preference');
  });

  it('fails closed to disabled and no microphone when both values are absent', async () => {
    vi.mocked(readPreferences).mockResolvedValue({ revision: 2, values: [] });

    await expect(readDictationPreferences()).resolves.toEqual({
      revision: 2,
      provider: null,
      preferredMic: null,
    });
  });

  it('maps the authoritative disabled sentinel to null without dropping its revision or microphone', async () => {
    vi.mocked(readPreferences).mockResolvedValue({
      revision: 13,
      values: [
        { key: 'voiceDictationProvider', value: '__disabled__' },
        { key: 'voiceDictationPreferredMic', value: 'device-13' },
      ],
    });

    await expect(readDictationPreferences()).resolves.toEqual({
      revision: 13,
      provider: null,
      preferredMic: 'device-13',
    });
  });

  it.each([null, '', '   '])(
    'removes a null or empty microphone instead of saving it: %j',
    async (value) => {
      vi.mocked(removePreferences).mockResolvedValue({ revision: 3, values: [] });

      await setDictationPreferences({ preferredMic: value });

      expect(removePreferences).toHaveBeenCalledWith(['voiceDictationPreferredMic']);
      expect(savePreferences).not.toHaveBeenCalled();
    }
  );

  it('saves a supported provider and non-empty microphone in one typed mutation', async () => {
    vi.mocked(savePreferences).mockResolvedValue({ revision: 4, values: [] });

    await setDictationPreferences({ provider: 'openai', preferredMic: 'device-4' });

    expect(savePreferences).toHaveBeenCalledWith([
      { key: 'voiceDictationProvider', value: 'openai', isMutable: true },
      { key: 'voiceDictationPreferredMic', value: 'device-4', isMutable: true },
    ]);
    expect(removePreferences).not.toHaveBeenCalled();
  });

  it('rejects a mixed save/remove request before any preference I/O', async () => {
    await expect(
      setDictationPreferences({ provider: 'elevenlabs', preferredMic: null })
    ).rejects.toThrow('cannot mix save and remove');

    expect(readPreferences).not.toHaveBeenCalled();
    expect(savePreferences).not.toHaveBeenCalled();
    expect(removePreferences).not.toHaveBeenCalled();
  });

  it('rejects an unsupported provider before any preference I/O', async () => {
    await expect(
      setDictationPreferences({ provider: 'private-provider' as never })
    ).rejects.toThrow('Invalid dictation preference');

    expect(readPreferences).not.toHaveBeenCalled();
    expect(savePreferences).not.toHaveBeenCalled();
    expect(removePreferences).not.toHaveBeenCalled();
  });
});
