import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { SourceEntry } from '@aaif/goose-sdk';
import zhCN from '../../i18n/messages/zh-CN.json';
import { buildToolboxModel } from './toolboxModel';
import { localizeToolboxItem } from './toolboxLocalization';

const sources = {
  skills: [
    {
      type: 'skill',
      name: 'company-guide',
      description: 'Company instructions',
      path: '/skills/company-guide',
    },
  ] as SourceEntry[],
  apps: [],
  extensions: [
    { type: 'builtin' as const, name: 'memory', enabled: true, description: 'Memory tools' },
    { type: 'platform' as const, name: 'skills', enabled: true, description: 'Skill tools' },
    {
      type: 'platform' as const,
      name: 'developer',
      enabled: true,
      description: 'Development tools',
    },
  ],
};

describe('toolbox localization', () => {
  it('shows one localized MCP computer control and removes the retired entry', () => {
    const intl = createIntl({
      locale: 'zh-CN',
      messages: Object.fromEntries(
        Object.entries(zhCN).map(([key, value]) => [key, value.defaultMessage])
      ),
    });
    const model = buildToolboxModel({
      skills: [],
      apps: [],
      extensions: [
        { type: 'platform', name: 'computer', enabled: false },
        { type: 'builtin', name: 'qwen_computer', enabled: true },
      ],
    });
    expect(model.capabilities).toHaveLength(1);
    const item = localizeToolboxItem(model.capabilities[0], intl);
    expect(item.name).toBe('Computer Use');
    expect(item.description).toBe('观察和控制桌面应用。');
    expect(item.description).not.toContain('MCP');
    expect(item.extensionSource?.name).toBe('qwen_computer');
  });
  it('does not translate third-party instructions or spoof built-in names', () => {
    const intl = createIntl({
      locale: 'zh-CN',
      messages: Object.fromEntries(
        Object.entries(zhCN).map(([key, value]) => [key, value.defaultMessage])
      ),
    });
    const model = buildToolboxModel(sources);
    const custom = model.methods.find((item) => item.name === 'company-guide')!;
    expect(localizeToolboxItem(custom, intl)).toEqual(custom);
    const external = buildToolboxModel({
      skills: [],
      apps: [],
      extensions: [
        {
          type: 'stdio',
          name: 'skills',
          cmd: 'server',
          description: 'External data',
          enabled: true,
        },
      ],
    }).external[0];
    expect(localizeToolboxItem(external, intl)).toEqual(external);
  });
});
