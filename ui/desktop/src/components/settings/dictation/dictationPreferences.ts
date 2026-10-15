import type { DictationProvider } from '../../../types/dictation';
import {
  readDictationPreferences,
  setDictationPreferences,
} from '../../../acp/dictationPreferences';

export function readDictationSettings() {
  return readDictationPreferences();
}

export async function setDictationProvider(provider: DictationProvider | null): Promise<void> {
  await setDictationPreferences({ provider });
}

export async function setDictationPreferredMic(preferredMic: string | null): Promise<void> {
  await setDictationPreferences({ preferredMic });
}
