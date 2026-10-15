import type { PreferenceKey, PreferenceValue } from '@aaif/goose-sdk';
import type { DictationProvider } from '../types/dictation';
import { readPreferences, removePreferences, savePreferences } from './preferences';

const DICTATION_KEYS: PreferenceKey[] = ['voiceDictationProvider', 'voiceDictationPreferredMic'];
const DICTATION_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'elevenlabs', 'groq', 'local']);

export interface DictationPreferences {
  revision: number;
  provider: DictationProvider | null;
  preferredMic: string | null;
}

export interface DictationPreferenceUpdate {
  provider?: DictationProvider | null;
  preferredMic?: string | null;
}

function invalidPreference(name: string): Error {
  return new Error(`Invalid dictation preference: ${name}`);
}

function valueFor(values: PreferenceValue[], key: PreferenceKey): unknown {
  const matches = values.filter((preference) => preference.key === key);
  if (matches.length > 1) throw invalidPreference(key);
  return matches[0]?.value;
}

function parseProvider(value: unknown): DictationProvider | null {
  if (value === null || value === undefined || value === '' || value === '__disabled__')
    return null;
  if (typeof value !== 'string' || !DICTATION_PROVIDERS.has(value)) {
    throw invalidPreference('provider');
  }
  return value as DictationProvider;
}

function parseMicrophone(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw invalidPreference('preferred microphone');
  return value.trim() ? value : null;
}

export async function readDictationPreferences(): Promise<DictationPreferences> {
  const snapshot = await readPreferences(DICTATION_KEYS);
  return {
    revision: snapshot.revision,
    provider: parseProvider(valueFor(snapshot.values, 'voiceDictationProvider')),
    preferredMic: parseMicrophone(valueFor(snapshot.values, 'voiceDictationPreferredMic')),
  };
}

export async function setDictationPreferences(update: DictationPreferenceUpdate): Promise<void> {
  const saves: PreferenceValue[] = [];
  const removals: PreferenceKey[] = [];

  if (Object.prototype.hasOwnProperty.call(update, 'provider')) {
    if (update.provider === null) {
      removals.push('voiceDictationProvider');
    } else {
      const provider = parseProvider(update.provider);
      if (!provider) throw invalidPreference('provider');
      saves.push({ key: 'voiceDictationProvider', value: provider, isMutable: true });
    }
  }

  if (Object.prototype.hasOwnProperty.call(update, 'preferredMic')) {
    const preferredMic = parseMicrophone(update.preferredMic);
    if (preferredMic === null) {
      removals.push('voiceDictationPreferredMic');
    } else {
      saves.push({ key: 'voiceDictationPreferredMic', value: preferredMic, isMutable: true });
    }
  }

  if (saves.length > 0 && removals.length > 0) {
    throw new Error('Dictation preference update cannot mix save and remove operations');
  }
  if (saves.length > 0) {
    await savePreferences(saves);
  } else if (removals.length > 0) {
    await removePreferences(removals);
  }
}
