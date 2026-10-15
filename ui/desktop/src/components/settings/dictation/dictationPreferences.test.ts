import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readDictationSettings,
  setDictationPreferredMic,
  setDictationProvider,
} from './dictationPreferences';

const typedPreferenceMocks = vi.hoisted(() => ({
  readDictationPreferences: vi.fn(),
  setDictationPreferences: vi.fn(),
}));

vi.mock('../../../acp/dictationPreferences', () => typedPreferenceMocks);

describe('dictation settings typed preference boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads the authoritative typed preference snapshot without generic config access', async () => {
    const snapshot = { revision: 7, provider: 'groq' as const, preferredMic: 'mic-7' };
    typedPreferenceMocks.readDictationPreferences.mockResolvedValue(snapshot);

    await expect(readDictationSettings()).resolves.toBe(snapshot);
    expect(typedPreferenceMocks.readDictationPreferences).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['enables a provider', 'openai'],
    ['disables dictation', null],
  ] as const)('%s with the exact typed provider value', async (_label, provider) => {
    typedPreferenceMocks.setDictationPreferences.mockResolvedValue(undefined);

    await setDictationProvider(provider);

    expect(typedPreferenceMocks.setDictationPreferences).toHaveBeenCalledWith({ provider });
  });

  it.each([
    ['selects a microphone', 'mic-8'],
    ['clears the microphone', null],
  ] as const)('%s with the exact typed microphone value', async (_label, preferredMic) => {
    typedPreferenceMocks.setDictationPreferences.mockResolvedValue(undefined);

    await setDictationPreferredMic(preferredMic);

    expect(typedPreferenceMocks.setDictationPreferences).toHaveBeenCalledWith({ preferredMic });
  });
});
