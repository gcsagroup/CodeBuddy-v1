import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import zhMessages from '../../../../i18n/compiled/zh-CN.json';
import type { FixedExtensionEntry } from '../../../ConfigContext';
import { getFriendlyTitle, getSubtitle } from './ExtensionList';

const zhIntl = createIntl({
  locale: 'zh-CN',
  messages: zhMessages,
});

const developerExtension = {
  name: 'Developer',
  type: 'builtin',
  enabled: true,
} as FixedExtensionEntry;

describe('built-in extension localization', () => {
  it('shows the localized name without changing the extension identifier', () => {
    expect(getFriendlyTitle(developerExtension, zhIntl)).toBe('开发工具');
    expect(developerExtension.name).toBe('Developer');
  });

  it('shows the localized description', () => {
    expect(getSubtitle(developerExtension, zhIntl).description).toBe(
      '用于软件工程的通用开发工具。'
    );
  });

  it('keeps custom extension metadata unchanged', () => {
    const customExtension = {
      name: 'My Internal Tool',
      description: 'Company-specific commands',
      type: 'stdio',
      cmd: 'internal-tool',
      enabled: false,
    } as FixedExtensionEntry;

    expect(getFriendlyTitle(customExtension, zhIntl)).toBe('My Internal Tool');
    expect(getSubtitle(customExtension, zhIntl).description).toBe('Company-specific commands');
  });

  it('localizes the fallback description for an unknown built-in extension', () => {
    const extension = {
      name: 'Unknown Built In',
      type: 'builtin',
      enabled: false,
    } as FixedExtensionEntry;

    expect(getSubtitle(extension, zhIntl).description).toBe('内置扩展');
  });

  it('localizes transport descriptions while preserving technical protocol names', () => {
    const sseExtension = {
      name: 'Remote Tools',
      type: 'sse',
      uri: 'https://example.com/sse',
      enabled: false,
    } as FixedExtensionEntry;

    expect(getSubtitle(sseExtension, zhIntl).description).toBe('SSE 扩展');
  });
});
