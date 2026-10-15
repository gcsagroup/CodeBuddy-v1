import { describe, expect, it } from 'vitest';
import {
  getProjectAlias,
  PROJECT_ALIAS_MAX_LENGTH,
  PROJECT_ALIAS_STORAGE_KEY,
  saveProjectAlias,
} from '../utils/projectAliases';

function createStorage(initialValue?: string) {
  const values = new Map<string, string>();
  if (initialValue !== undefined) values.set(PROJECT_ALIAS_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('project aliases', () => {
  it('uses the normalized Windows path as the stable identity', () => {
    const storage = createStorage();
    saveProjectAlias('D:\\Code-Agent\\', '旗舰项目', 'Code-Agent', storage);

    expect(getProjectAlias('d:/code-agent', 'Code-Agent', storage)).toBe('旗舰项目');
  });

  it('falls back safely when stored data is malformed', () => {
    const storage = createStorage('{invalid-json');

    expect(getProjectAlias('D:\\Code-Agent', 'Code-Agent', storage)).toBe('Code-Agent');
  });

  it('limits custom labels and clears aliases when the input is empty', () => {
    const storage = createStorage();
    const longName = '项'.repeat(PROJECT_ALIAS_MAX_LENGTH + 10);

    expect(saveProjectAlias('D:\\Code-Agent', longName, 'Code-Agent', storage)).toHaveLength(
      PROJECT_ALIAS_MAX_LENGTH
    );
    expect(saveProjectAlias('D:\\Code-Agent', '  ', 'Code-Agent', storage)).toBe('Code-Agent');
    expect(getProjectAlias('D:\\Code-Agent', 'Code-Agent', storage)).toBe('Code-Agent');
  });
});
