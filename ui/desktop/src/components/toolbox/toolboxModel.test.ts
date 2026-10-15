import { describe, expect, it } from 'vitest';
import { buildToolboxModel } from './toolboxModel';

describe('buildToolboxModel', () => {
  it('shows one external Git entry when full Git MCP is configured', () => {
    const model = buildToolboxModel({skills: [], apps: [], extensions: [
      {type: 'platform', name: 'git', enabled: false},
      {type: 'stdio', name: 'local_git', enabled: true, cmd: 'node', args: []},
    ]});
    expect(model.capabilities).toHaveLength(0);
    expect(model.external.map(item => item.id)).toEqual(['external:local_git']);
  });

  it('omits a retired tutorial from older backends without claiming enabled tools are verified', () => {
    const model = buildToolboxModel({
      skills: [],
      apps: [],
      extensions: [
        { type: 'builtin', name: 'tutorial', enabled: true },
        { type: 'platform', name: 'git', enabled: true },
      ],
    });
    expect(model.capabilities.map((item) => item.id)).toEqual(['builtin:git']);
    expect(model.capabilities[0].status).toBe('configured');
  });
  it('never exposes the retired documentation guide returned by an older backend', () => {
    const model = buildToolboxModel({
      skills: [
        {
          type: 'builtinSkill',
          name: 'goose-doc-guide',
          description: 'Legacy documentation guide',
          path: 'builtin/goose-doc-guide',
        },
        { type: 'skill', name: 'review', description: 'Review code', path: 'managed/review' },
      ] as never,
      apps: [],
      extensions: [],
    });

    expect(model.methods.map((item) => item.id)).toEqual(['skill:review']);
  });

  it('keeps source ownership while grouping managed capabilities', () => {
    const model = buildToolboxModel({
      skills: [
        { type: 'skill', name: 'review', description: 'Review code', path: 'managed/review' },
      ] as never,
      apps: [
        { name: 'dashboard', uri: 'ui://dashboard', mimeType: 'text/html', mcpServers: ['apps'] },
        { name: 'foreign', uri: 'ui://foreign', mimeType: 'text/html', mcpServers: ['other'] },
      ],
      extensions: [
        {
          type: 'builtin',
          name: 'qwen_computer',
          description: 'Control desktop',
          enabled: true,
          configKey: 'qwen_computer',
        },
        {
          type: 'platform',
          name: 'developer',
          description: 'Edit code',
          enabled: true,
          configKey: 'developer',
        },
        {
          type: 'streamable_http',
          name: 'knowledge-base',
          description: 'Remote knowledge',
          uri: 'https://example.invalid/mcp',
          enabled: true,
          configKey: 'kb',
        },
        {
          type: 'stdio',
          name: 'filesystem',
          description: 'Read files',
          cmd: 'server',
          enabled: false,
          configKey: 'fs',
        },
      ],
      usage: [
        {
          kind: 'external',
          capabilityId: 'kb',
          lastSuccessAt: '2026-09-01T01:02:03Z',
          successCount: 8,
          recentResult: 'search succeeded',
        },
        {
          kind: 'external',
          capabilityId: 'fs',
          lastSuccessAt: '2026-09-04T01:02:03Z',
          successCount: 3,
          recentResult: 'read_file succeeded',
        },
      ],
    });

    expect([...model.capabilities].sort((a, b) => b.id.localeCompare(a.id))).toMatchObject([
      {
        id: 'builtin:qwen_computer',
        kind: 'builtin',
        status: 'configured',
        locked: false,
        actions: ['inspect', 'disable'],
        reference: { key: 'configKey', value: 'qwen_computer' },
      },
      {
        id: 'builtin:developer',
        kind: 'builtin',
        status: 'configured',
        locked: true,
        actions: ['inspect'],
      },
    ]);
    expect(model.capabilities.every((item) => !item.actions.includes('delete' as never))).toBe(
      true
    );
    expect(model.methods.map((item) => item.id)).toEqual(['skill:review']);
    expect(model.apps).toEqual([]);
    expect(model.external.map((item) => item.id)).toEqual(['external:fs', 'external:kb']);
    expect(model.external[0]).toMatchObject({
      status: 'disabled',
      source: 'extension',
      usage: {
        lastUsedAt: '2026-09-04T01:02:03Z',
        successCount: 3,
        recentResult: 'read_file succeeded',
      },
    });
    expect(model.external[1]).toMatchObject({
      id: 'external:kb',
      name: 'knowledge-base',
      status: 'ready',
      reference: { key: 'configKey', value: 'kb' },
      usage: {
        lastUsedAt: '2026-09-01T01:02:03Z',
        successCount: 8,
        recentResult: 'search succeeded',
      },
    });
  });

  it('locks enabled required tools by stable config key without trapping disabled tools', () => {
    const model = buildToolboxModel({
      skills: [],
      apps: [],
      extensions: [
        {
          type: 'platform',
          name: 'Extension Manager',
          enabled: true,
          configKey: 'extensionmanager',
        },
        {
          type: 'platform',
          name: 'developer',
          enabled: false,
          configKey: 'developer',
        },
        {
          type: 'platform',
          name: 'orchestrator',
          enabled: false,
          configKey: 'orchestrator',
        },
      ],
    });

    expect(
      model.capabilities.find((item) => item.reference?.value === 'extensionmanager')
    ).toMatchObject({
      locked: true,
      actions: ['inspect'],
    });
    expect(model.capabilities.find((item) => item.reference?.value === 'developer')).toMatchObject({
      locked: false,
      actions: ['inspect', 'enable'],
    });
    expect(
      model.capabilities.find((item) => item.reference?.value === 'orchestrator')
    ).toMatchObject({
      locked: false,
      actions: ['inspect', 'enable'],
    });
  });
});
