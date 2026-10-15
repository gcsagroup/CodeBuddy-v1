/** @vitest-environment jsdom */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { loadToolbox, type ToolboxLoadResult } from '../../acp/toolbox';
import { testConfigExtension } from '../../acp/extensions';
import ToolboxView from './ToolboxView';
import { IntlProvider } from 'react-intl';
import zhCN from '../../i18n/messages/zh-CN.json';
import zhTW from '../../i18n/messages/zh-TW.json';
import { buildToolboxModel } from './toolboxModel';
import { applySkillChange, previewSkillChange } from '../../acp/skillManagement';

const configContext = vi.hoisted(() => ({ setExtensionEnabled: vi.fn() }));

vi.mock('../../acp/toolbox', () => ({ loadToolbox: vi.fn() }));
vi.mock('../../acp/extensions', () => ({ testConfigExtension: vi.fn() }));
vi.mock('../ConfigContext', () => ({ useConfig: () => configContext }));
vi.mock('../../acp/skillManagement', () => ({
  applySkillChange: vi.fn(),
  previewSkillChange: vi.fn(),
}));
vi.mock('../../utils/workingDir', () => ({ getInitialWorkingDir: () => 'D:\\project' }));
vi.mock('../settings/extensions/ExtensionsSection', () => ({
  default: ({
    controlledConfigKey,
    hideList,
  }: {
    controlledConfigKey?: string;
    hideList?: boolean;
  }) => (
    <div>
      {!hideList && <button>Connect external tool</button>}
      {controlledConfigKey && <div role="dialog">MCP configuration: {controlledConfigKey}</div>}
    </div>
  ),
}));
vi.mock('../skills/SkillManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skills/SkillManager')>();
  return {
    ...actual,
    default: ({
      request,
    }: {
      request?: { type: string; skill?: { name: string; enabled?: boolean; rawDocument?: string } };
    }) =>
      request ? (
        <div role="dialog">
          {request.type === 'create' ? 'Create skill' : `Skill details: ${request.skill?.name}`}
          {request.skill && (
            <span>{`${request.skill.enabled ? 'enabled' : 'disabled'}: ${request.skill.rawDocument}`}</span>
          )}
        </div>
      ) : null,
  };
});

function renderView(path = '/toolbox') {
  return render(
    <IntlTestWrapper>
      <MemoryRouter initialEntries={[path]}>
        <ToolboxView />
      </MemoryRouter>
    </IntlTestWrapper>
  );
}

function CurrentPath() {
  const location = useLocation();
  return <div data-testid="current-path">{`${location.pathname}${location.search}`}</div>;
}

describe('ToolboxView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates an already open skill detail when refreshed state arrives', async () => {
    const skill = {
      source: { rootKind: 'global' as const, rootId: 'global', relativePath: 'refresh-skill' },
      name: 'refresh-skill',
      description: 'Refresh fixture',
      scope: 'global' as const,
      readOnly: false,
      enabled: true,
      displayPath: 'skills/refresh-skill',
      version: 'v1',
      rawDocument: 'original instructions',
      originalMetadata: {},
      displayMetadata: { locales: {} },
      companionFiles: [],
    };
    const snapshot = (enabled: boolean): ToolboxLoadResult => ({
      model: buildToolboxModel({
        skills: [
          {
            ...skill,
            enabled,
            version: enabled ? 'v1' : 'v2',
            rawDocument: enabled ? 'original instructions' : 'updated instructions',
          },
        ],
        apps: [],
        extensions: [],
      }),
      errors: {},
      warnings: [],
    });
    vi.mocked(loadToolbox).mockResolvedValueOnce(snapshot(true));
    renderView('/toolbox?section=methods');
    await userEvent.click(await screen.findByRole('button', { name: 'refresh-skill' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('enabled: original instructions');
    vi.mocked(loadToolbox).mockResolvedValueOnce(snapshot(false));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent('disabled: updated instructions')
    );
    vi.mocked(loadToolbox).mockResolvedValueOnce({
      model: buildToolboxModel({ skills: [], apps: [], extensions: [] }),
      errors: {},
      warnings: [],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it.each(['/toolbox', '/codepro/toolbox'])(
    'opens skill creation in a dialog without leaving %s',
    async (path) => {
      vi.mocked(loadToolbox).mockResolvedValue({
        model: {
          capabilities: [],
          methods: [],
          apps: [],
          external: [],
        },
        errors: {},
        warnings: [],
      });

      render(
        <IntlTestWrapper>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="*" element={<ToolboxView />} />
            </Routes>
            <CurrentPath />
          </MemoryRouter>
        </IntlTestWrapper>
      );

      await userEvent.click(await screen.findByRole('button', { name: 'Add skill' }));
      expect(screen.getByRole('dialog')).toHaveTextContent('Create skill');
      expect(screen.getByTestId('current-path')).toHaveTextContent(path);
    }
  );

  it.each(['/toolbox?section=methods', '/codepro/toolbox?section=methods'])(
    'opens the selected skill detail in a dialog at %s',
    async (path) => {
      vi.mocked(loadToolbox).mockResolvedValue({
        model: {
          capabilities: [],
          methods: [
            {
              id: 'skill:documentation-guide',
              kind: 'skill',
              source: 'source',
              name: 'documentation-guide',
              description: 'Find project documentation',
              status: 'ready',
              actions: ['inspect'],
              reference: { key: 'path', value: 'skills/docs/SKILL.md' },
              skillSource: {
                source: {
                  rootKind: 'global',
                  rootId: 'global',
                  relativePath: 'documentation-guide',
                },
                name: 'documentation-guide',
                description: 'Find project documentation',
                scope: 'global',
                readOnly: false,
                enabled: true,
                displayPath: 'skills/docs/SKILL.md',
                version: 'v1',
                rawDocument: '---\nname: documentation-guide\n---\n',
                originalMetadata: {},
                displayMetadata: { locales: {} },
                companionFiles: [],
              },
            },
          ],
          apps: [],
          external: [],
        },
        errors: {},
        warnings: [],
      });

      render(
        <IntlTestWrapper>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="*" element={<ToolboxView />} />
            </Routes>
            <CurrentPath />
          </MemoryRouter>
        </IntlTestWrapper>
      );

      await userEvent.click(await screen.findByRole('button', { name: 'documentation-guide' }));
      expect(screen.getByRole('dialog')).toHaveTextContent('Skill details: documentation-guide');
      expect(screen.getByTestId('current-path')).toHaveTextContent(path);
    }
  );

  it('opens MCP configuration in the same toolbox surface', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: {
        capabilities: [],
        methods: [],
        apps: [],
        external: [
          {
            id: 'external:filesystem',
            kind: 'external',
            source: 'extension',
            name: 'Filesystem',
            description: 'Local files',
            status: 'ready',
            actions: ['configure'],
            reference: { key: 'configKey', value: 'filesystem' },
          },
        ],
      },
      errors: {},
      warnings: [],
    });

    render(
      <IntlTestWrapper>
        <MemoryRouter initialEntries={['/toolbox?section=external']}>
          <Routes>
            <Route path="*" element={<ToolboxView />} />
          </Routes>
          <CurrentPath />
        </MemoryRouter>
      </IntlTestWrapper>
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Filesystem' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('MCP configuration: filesystem');
    expect(screen.getByTestId('current-path')).toHaveTextContent('/toolbox?section=external');
  });

  it.each([
    ['zh-CN', zhCN, '已启用，未验证连接'],
    ['zh-TW', zhTW, '已啟用，未驗證連線'],
    ['en', {}, 'Enabled, connection not verified'],
  ] as const)(
    'labels configured external tools accurately in %s',
    async (locale, messages, label) => {
      vi.mocked(loadToolbox).mockResolvedValue({
        model: {
          capabilities: [],
          methods: [],
          apps: [],
          external: [
            {
              id: 'external:knowledge-base',
              kind: 'external',
              source: 'extension',
              name: 'knowledge-base',
              description: 'Remote knowledge',
              status: 'configured',
              actions: ['configure'],
              reference: { key: 'configKey', value: 'knowledge-base' },
            },
          ],
        },
        errors: {},
        warnings: [],
      });

      render(
        <IntlProvider
          locale={locale}
          messages={Object.fromEntries(
            Object.entries(messages).map(([key, value]) => [key, value.defaultMessage])
          )}
        >
          <MemoryRouter initialEntries={['/toolbox?section=external']}>
            <ToolboxView />
          </MemoryRouter>
        </IntlProvider>
      );

      expect(await screen.findByRole('heading', { name: 'knowledge-base' })).toBeVisible();
      const badge = screen.getByText(label);
      expect(badge).toBeVisible();
      expect(badge).toHaveClass('rounded-md', 'text-[11px]');
      expect(badge.parentElement).toHaveClass('flex-wrap');
    }
  );

  it('searches translated content and changes language without fetching again', async () => {
    vi.mocked(loadToolbox).mockClear();
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        skills: [
          {
            type: 'skill',
            name: 'review',
            description: '发现并使用技能',
            content: '',
            path: 'skills/review/SKILL.md',
            global: true,
            writable: true,
            supportingFiles: [],
            properties: {},
          },
        ],
        apps: [],
        extensions: [],
      }),
      errors: {},
      warnings: [],
    });
    const renderLocale = (locale: string) => (
      <IntlProvider
        locale={locale}
        messages={
          locale === 'zh-CN'
            ? Object.fromEntries(
                Object.entries(zhCN).map(([key, value]) => [key, value.defaultMessage])
              )
            : {}
        }
      >
        <MemoryRouter>
          <ToolboxView />
        </MemoryRouter>
      </IntlProvider>
    );
    const view = render(renderLocale('zh-CN'));
    expect(await screen.findByRole('heading', { name: 'review' })).toBeVisible();
    await userEvent.type(screen.getByRole('searchbox'), '发现');
    expect(screen.getByRole('tab', { name: '技能' })).toBeVisible();
    view.rerender(renderLocale('en'));
    expect(screen.getByRole('heading', { name: 'review' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Skills' })).toBeVisible();
    expect(screen.getByRole('searchbox')).toHaveValue('发现');
    expect(loadToolbox).toHaveBeenCalledTimes(1);
  });

  it('searches retained ids and reference keys and values when names differ', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: {
        capabilities: [],
        methods: [
          {
            id: 'skill:documentation-guide',
            kind: 'skill',
            source: 'source',
            name: 'Documentation guide',
            description: 'Find project documentation',
            status: 'ready',
            actions: [],
            reference: { key: 'path', value: 'skills/codebuddy-docs/SKILL.md' },
          },
        ],
        apps: [],
        external: [],
      },
      errors: {},
      warnings: [],
    });

    renderView('/toolbox?section=methods');
    const search = await screen.findByRole('searchbox');
    for (const identifier of [
      'skill:documentation-guide',
      'path',
      'skills/codebuddy-docs/SKILL.md',
    ]) {
      await userEvent.clear(search);
      await userEvent.type(search, identifier);
      expect(screen.getByRole('heading', { name: 'Documentation guide' })).toBeVisible();
    }
  });

  it('shows built-in tools, skills, and external MCP while preserving partial results', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: {
        capabilities: [],
        methods: [
          {
            id: 'skill:computer-control',
            kind: 'skill',
            source: 'source',
            name: 'Computer control',
            description: 'Desktop control skill',
            status: 'ready',
            actions: ['inspect'],
          },
        ],
        apps: [],
        external: [],
      },
      errors: { apps: 'apps unavailable' },
      warnings: [],
    });

    renderView();
    expect(await screen.findByText('Computer control')).toBeVisible();
    expect(screen.getByText('apps unavailable')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Skills' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'External MCP' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Built-in capabilities' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'My mini tools' })).not.toBeInTheDocument();
  });

  it.each(['all', 'capabilities'])(
    'hides managed capabilities even during search in %s',
    async (section) => {
      vi.mocked(loadToolbox).mockResolvedValue({
        model: buildToolboxModel({
          skills: [],
          apps: [],
          extensions: [
            ...['tom', 'code_execution', 'summarize', 'todo', 'apps'].map((name) => ({
              type: 'platform' as const,
              name,
              enabled: true,
            })),
            { type: 'builtin', name: 'autovisualiser', enabled: true },
            { type: 'platform', name: 'projectmemory', enabled: true },
          ],
        }),
        errors: {},
        warnings: [],
      });
      renderView(`/toolbox?section=${section}`);
      await screen.findByRole('button', { name: 'Project memory' });
      expect(screen.queryByText(/Advanced and compatibility capabilities/)).not.toBeInTheDocument();
      for (const name of ['tom', 'code_execution', 'summarize', 'todo', 'apps', 'autovisualiser']) {
        await userEvent.clear(screen.getByRole('searchbox'));
        await userEvent.type(screen.getByRole('searchbox'), name);
        expect(screen.queryByRole('switch')).not.toBeInTheDocument();
      }
    }
  );

  it('shows Computer MCP as a non-deletable built-in tool with details and a persisted toggle', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        skills: [],
        apps: [],
        extensions: [
          {
            type: 'builtin',
            name: 'qwen_computer',
            description: 'Observe and control Windows applications',
            enabled: true,
            configKey: 'qwen_computer',
            available_tools: ['list_apps', 'click'],
          },
        ],
      }),
      errors: {},
      warnings: [],
    });
    configContext.setExtensionEnabled.mockResolvedValue(undefined);

    renderView('/toolbox?section=capabilities');

    const card = await screen.findByRole('button', { name: 'Computer control' });
    expect(screen.getByRole('switch', { name: 'Disable Computer control' })).toBeChecked();
    expect(
      screen.queryByRole('button', { name: /delete computer control/i })
    ).not.toBeInTheDocument();

    await userEvent.click(card);
    expect(screen.getByRole('dialog')).toHaveTextContent('Computer Use (qwen_computer)');
    expect(screen.getByRole('dialog')).toHaveTextContent('Example use');
    expect(screen.getByRole('dialog')).toHaveTextContent('list_apps');
    expect(screen.getByRole('dialog')).toHaveTextContent('click');
    expect(screen.getByRole('dialog')).toHaveTextContent('Not verified for this installation');
    vi.mocked(testConfigExtension).mockResolvedValue({
      success: true,
      tools: ['get_app_state'],
      latencyMs: 1,
      resourceCount: 0,
      supportsResources: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Read tool inventory' }));
    expect(await screen.findByText('get_app_state')).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveTextContent('not successful execution');
    expect(screen.getByRole('dialog')).toHaveTextContent('Observe and control');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await userEvent.click(screen.getByRole('switch', { name: 'Disable Computer control' }));
    await waitFor(() =>
      expect(configContext.setExtensionEnabled).toHaveBeenCalledWith('qwen_computer', false)
    );
    expect(loadToolbox).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows stopping until backend shutdown completes, then renders disabled in place', async () => {
    const snapshot = (enabled: boolean): ToolboxLoadResult => ({
      model: buildToolboxModel({
        skills: [],
        apps: [],
        extensions: [
          {
            type: 'builtin',
            name: 'qwen_computer',
            description: 'Observe and control Windows applications',
            enabled,
            configKey: 'qwen_computer',
          },
        ],
      }),
      errors: {},
      warnings: [],
    });
    vi.mocked(loadToolbox)
      .mockResolvedValueOnce(snapshot(true))
      .mockResolvedValueOnce(snapshot(false));
    let finishShutdown!: () => void;
    configContext.setExtensionEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        })
    );
    renderView('/toolbox?section=capabilities');

    const card = await screen.findByRole('button', { name: 'Computer control' });
    const control = screen.getByRole('switch', { name: 'Disable Computer control' });
    await userEvent.click(control);

    expect(await screen.findByText('Stopping…')).toBeVisible();
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
    expect(card.isConnected).toBe(true);
    expect(control).toBeDisabled();

    await act(async () => finishShutdown());
    expect(await screen.findByText('Disabled')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Computer control' })).toBe(card);
    expect(screen.getByRole('switch', { name: 'Enable Computer control' })).toBe(control);
    expect(control).toBeEnabled();
  });

  it('keeps visible cards mounted throughout consecutive toggle refreshes', async () => {
    const snapshot = (enabled: boolean): ToolboxLoadResult => ({
      model: buildToolboxModel({
        skills: [],
        apps: [],
        extensions: [{ type: 'platform', name: 'chatrecall', configKey: 'chatrecall', enabled }],
      }),
      errors: {},
      warnings: [],
    });
    vi.mocked(loadToolbox).mockResolvedValueOnce(snapshot(true));
    configContext.setExtensionEnabled.mockResolvedValue(undefined);
    renderView('/toolbox?section=capabilities');
    const card = await screen.findByRole('button', { name: 'Conversation recall' });

    for (const enabled of [false, true]) {
      let resolveRefresh!: (value: ToolboxLoadResult) => void;
      vi.mocked(loadToolbox).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          })
      );
      const control = screen.getByRole('switch');
      await userEvent.click(control);
      await waitFor(() => expect(resolveRefresh).toBeDefined());
      expect(card.isConnected).toBe(true);
      expect(control).toBeDisabled();
      expect(screen.queryByText('Loading tools…')).not.toBeInTheDocument();
      await act(async () => resolveRefresh(snapshot(enabled)));
      expect(screen.getByRole('button', { name: 'Conversation recall' })).toBe(card);
      expect(screen.getByRole('switch')).toBe(control);
      expect(control).toHaveAttribute('aria-checked', String(enabled));
      expect(control).toBeEnabled();
    }
    expect(configContext.setExtensionEnabled.mock.calls).toEqual([
      ['chatrecall', false],
      ['chatrecall', true],
    ]);
  });

  it('ignores an older refresh that resolves after newer tool state', async () => {
    const snapshot = (enabled: boolean): ToolboxLoadResult => ({
      model: buildToolboxModel({
        skills: [],
        apps: [],
        extensions: [
          { type: 'builtin', name: 'qwen_computer', configKey: 'qwen_computer', enabled },
        ],
      }),
      errors: {},
      warnings: [],
    });
    vi.mocked(loadToolbox).mockResolvedValueOnce(snapshot(true));
    renderView('/toolbox?section=capabilities');
    const card = await screen.findByRole('button', { name: 'Computer control' });
    let resolveOlder!: (value: ToolboxLoadResult) => void;
    let resolveNewer!: (value: ToolboxLoadResult) => void;
    vi.mocked(loadToolbox)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewer = resolve;
          })
      );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => resolveNewer(snapshot(false)));
    expect(screen.getByRole('switch')).not.toBeChecked();
    await act(async () => resolveOlder(snapshot(true)));
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Computer control' })).toBe(card);
  });

  it('locks required built-in tools on', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        skills: [],
        apps: [],
        extensions: [
          {
            type: 'platform',
            name: 'developer',
            description: 'Edit files and run commands',
            enabled: true,
            configKey: 'developer',
          },
        ],
      }),
      errors: {},
      warnings: [],
    });

    renderView('/toolbox?section=capabilities');
    expect(
      await screen.findByRole('switch', { name: 'Development tools is required' })
    ).toBeDisabled();
  });

  it('shows built-in tools, skills, and MCP together in the All section', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        skills: [
          {
            source: { rootKind: 'global', rootId: 'global', relativePath: 'review' },
            name: 'review',
            description: 'Review work',
            scope: 'global',
            readOnly: false,
            enabled: true,
            displayPath: 'C:\\skills\\review',
            version: 'v1',
            rawDocument: '---\nname: review\n---\n',
            originalMetadata: {},
            displayMetadata: { locales: {} },
            companionFiles: [],
          },
        ],
        apps: [],
        extensions: [
          {
            type: 'builtin',
            name: 'qwen_computer',
            description: 'Observe and control Windows applications',
            enabled: true,
            configKey: 'qwen_computer',
          },
          {
            type: 'stdio',
            name: 'Filesystem',
            description: 'Local files',
            enabled: true,
            configKey: 'filesystem',
            cmd: 'filesystem-server',
          },
        ],
      }),
      errors: {},
      warnings: [],
    });

    renderView('/toolbox?section=all');

    expect(await screen.findByRole('heading', { name: 'Computer control' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'review' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Filesystem' })).toBeVisible();
    expect(screen.getAllByRole('switch')).toHaveLength(3);
  });

  it('persists skill and MCP switches through their existing controlled APIs', async () => {
    const skill = {
      source: { rootKind: 'global' as const, rootId: 'global', relativePath: 'review' },
      name: 'review',
      description: 'Review work',
      scope: 'global' as const,
      readOnly: false,
      enabled: true,
      displayPath: 'C:\\skills\\review',
      version: 'v1',
      rawDocument: '---\nname: review\n---\n',
      originalMetadata: {},
      displayMetadata: { locales: {} },
      companionFiles: [],
    };
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        skills: [skill],
        apps: [],
        extensions: [
          {
            type: 'stdio',
            name: 'Filesystem',
            enabled: true,
            configKey: 'filesystem',
            cmd: 'filesystem-server',
          },
        ],
      }),
      errors: {},
      warnings: [],
    });
    vi.mocked(previewSkillChange).mockResolvedValue({
      previewToken: 'preview-disable-review',
      expiresAt: '2026-09-09T00:00:00Z',
      operation: 'set_enabled',
      target: 'review',
      requiresConfirmation: false,
      hasConflict: false,
      files: [],
    });
    vi.mocked(applySkillChange).mockResolvedValue({ skill });
    configContext.setExtensionEnabled.mockResolvedValue(undefined);

    renderView('/toolbox?section=all');

    await userEvent.click(await screen.findByRole('switch', { name: 'Disable review' }));
    await waitFor(() =>
      expect(previewSkillChange).toHaveBeenCalledWith(
        {
          operation: 'set_enabled',
          source: skill.source,
          expectedVersion: 'v1',
          enabled: false,
        },
        'D:\\project'
      )
    );
    expect(applySkillChange).toHaveBeenCalledWith('preview-disable-review');

    await userEvent.click(screen.getByRole('switch', { name: 'Disable Filesystem' }));
    await waitFor(() =>
      expect(configContext.setExtensionEnabled).toHaveBeenCalledWith('filesystem', false)
    );
  });

  it('groups built-in and installed skills so bundled skills are visible', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        skills: [
          {
            source: { rootKind: 'builtin', rootId: 'builtin', relativePath: 'quality-guide' },
            name: 'quality-guide',
            description: 'Quality checks',
            scope: 'builtin',
            readOnly: true,
            enabled: true,
            displayPath: 'builtin/quality-guide',
            version: 'v1',
            rawDocument: '---\nname: quality-guide\n---\n',
            originalMetadata: {},
            displayMetadata: { locales: {} },
            companionFiles: [],
          },
          {
            source: { rootKind: 'global', rootId: 'global', relativePath: 'review' },
            name: 'review',
            description: 'Review work',
            scope: 'global',
            readOnly: false,
            enabled: true,
            displayPath: 'C:\\skills\\review',
            version: 'v1',
            rawDocument: '---\nname: review\n---\n',
            originalMetadata: {},
            displayMetadata: { locales: {} },
            companionFiles: [],
          },
        ],
        apps: [],
        extensions: [],
      }),
      errors: {},
      warnings: [],
    });

    renderView('/toolbox?section=methods');
    expect(await screen.findByRole('heading', { name: 'Built in Skills' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Installed Skills' })).toBeVisible();
    expect(screen.getByText('quality-guide')).toBeVisible();
    expect(screen.getByText('review')).toBeVisible();
  });

  it('opens the legacy-selected section and searches cards', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: {
        capabilities: [],
        methods: [],
        apps: [],
        external: [
          {
            id: 'external:fs',
            kind: 'external',
            source: 'extension',
            name: 'Filesystem',
            description: 'Local files',
            status: 'ready',
            actions: ['configure'],
          },
        ],
      },
      errors: {},
      warnings: [],
    });

    renderView('/toolbox?section=external');
    expect(await screen.findByText('Filesystem')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Connect external tool' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'missing');
    await waitFor(() => expect(screen.queryByText('Filesystem')).not.toBeInTheDocument());
    expect(screen.getByText('No matching tools')).toBeVisible();
  });
});
