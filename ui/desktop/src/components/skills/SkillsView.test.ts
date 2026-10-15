import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { SourceEntry } from '@aaif/goose-sdk';
import zhMessages from '../../i18n/compiled/zh-CN.json';
import { getSkillsLoadError, localizeSkillEntry } from './SkillsView';

const zhIntl = createIntl({
  locale: 'zh-CN',
  messages: zhMessages,
});

describe('skill localization', () => {
  it('keeps the user-facing error localized while retaining diagnostic detail', () => {
    expect(getSkillsLoadError({}, zhIntl)).toBe('技能操作失败');
    expect(getSkillsLoadError(new Error('backend unavailable'), zhIntl)).toBe(
      '技能操作失败：backend unavailable'
    );
  });

  it('keeps third-party skill metadata unchanged when no translation is available', () => {
    const source = {
      type: 'skill',
      name: 'company-release',
      description: 'Release the company application.',
      path: 'C:\\skills\\company-release',
    } as SourceEntry;

    expect(localizeSkillEntry(source, zhIntl)).toEqual({
      name: 'company-release',
      description: 'Release the company application.',
    });
  });
});
