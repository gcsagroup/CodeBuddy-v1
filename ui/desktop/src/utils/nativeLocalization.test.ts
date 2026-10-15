import { describe, expect, it } from 'vitest';
import { selectNativeText } from './nativeLocalization';

describe('selectNativeText', () => {
  it.each([
    ['zh-CN', '简体'],
    ['zh_Hans_CN', '简体'],
    ['zh-TW', '繁體'],
    ['zh-Hant-HK', '繁體'],
    ['en', 'English'],
  ])('selects the user-visible native text for %s', (locale, expected) => {
    expect(selectNativeText(locale, 'English', '简体', '繁體')).toBe(expected);
  });
});
