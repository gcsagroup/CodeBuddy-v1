/** @vitest-environment jsdom */
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
import { addSessionExtension } from '../../acp/session-extensions';
import { listTools } from '../../acp/permissions';
import { readToolboxSession, retryToolboxSession } from '../../acp/toolboxSession';

vi.mock('../../acp/toolboxSession', () => ({ readToolboxSession: vi.fn().mockResolvedValue({ cwd: '/conversation-project', mode: 'follow', pending: false, running: false, selected: [], statuses: [] }), setToolboxSessionMode: vi.fn(), retryToolboxSession: vi.fn() }));
vi.mock('../../acp/session-extensions', () => ({ getSessionExtensions: vi.fn(), addSessionExtension: vi.fn() }));
vi.mock('../../acp/permissions', () => ({ listTools: vi.fn() }));

const configContext = vi.hoisted(() => ({ setExtensionEnabled: vi.fn(), extensionsList: [] }));
vi.mock('../settings/auth/RepositoryConnections', () => ({
  default: () => <div>Local Git controls and GitHub account connection</div>,
}));

vi.mock('../../acp/toolbox', () => ({ loadToolbox: vi.fn() }));
vi.mock('../../acp/extensions', () => ({ testConfigExtension: vi.fn() }));
vi.mock('../ConfigContext', () => ({ useConfig: () => configContext }));
vi.mock('../../acp/skillManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acp/skillManagement')>()),
  applySkillChange: vi.fn(),
  previewSkillChange: vi.fn(),
}));
vi.mock('../../utils/workingDir', () => ({ getInitialWorkingDir: () => 'D:\\project' }));
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

  it('shows per-conversation selections, adds custom MCP, and preserves the return link', async () => {
    const computer = { type: 'builtin' as const, name: 'qwen_computer', enabled: true };
    const custom = { type: 'stdio' as const, name: 'custom_fixture', enabled: true, cmd: 'node', args: ['fixture.cjs'], envs: {} };
    vi.mocked(loadToolbox).mockResolvedValue({ model: buildToolboxModel({ skills: [], apps: [], extensions: [computer, custom] }), errors: {}, warnings: [] });
    const state = { cwd: '/conversation-project', mode: 'custom' as const, pending: false, running: false, selected: [computer.name], statuses: [] };
    vi.mocked(readToolboxSession).mockResolvedValue(state);
    vi.mocked(addSessionExtension).mockImplementation(async () => { vi.mocked(readToolboxSession).mockResolvedValue({ ...state, selected: [computer.name, custom.name], statuses: [{serverName: custom.name, status: 'ready'}] }); });
    renderView('/codepro/toolbox?sessionId=existing');
    expect(await screen.findByText('Added to this conversation · connection not checked')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Follow toolbox' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry connections' })).not.toBeInTheDocument();
    await waitFor(() => expect(loadToolbox).toHaveBeenCalledWith('/conversation-project', undefined, expect.objectContaining({ onPartial: expect.any(Function) })));
    expect(screen.getByText('Not loaded in this conversation')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Return to conversation' })).toHaveAttribute('href', '/codepro/pair?resumeSessionId=existing');
    await userEvent.click(screen.getByRole('button', { name: 'Add to this conversation' }));
    expect(await screen.findByText('Connected', { selector: '[role="status"]' })).toBeVisible();
    expect(addSessionExtension).toHaveBeenCalledWith('existing', expect.objectContaining({ name: 'custom_fixture', type: 'stdio' }));
    expect(retryToolboxSession).toHaveBeenCalledWith('existing');
    expect(listTools).not.toHaveBeenCalled();
  });
  it.each(['builtin:git', 'external:github_official', 'builtin:repository'])(
    'opens the unified controls from the %s link without changing settings',
    async (id) => {
      vi.mocked(loadToolbox).mockResolvedValue({
        model: buildToolboxModel({
          skills: [],
          apps: [],
          extensions: [
            { type: 'platform', name: 'git', enabled: false },
            {
              type: 'streamable_http',
              name: 'github_official',
              enabled: true,
              uri: 'https://api.githubcopilot.com/mcp/',
            },
          ],
        }),
        errors: {},
        warnings: [],
      });
      renderView(`/toolbox?section=external&item=${encodeURIComponent(id)}`);
      expect(await screen.findByRole('dialog')).toHaveTextContent(
        'Local Git controls and GitHub account connection'
      );
      expect(configContext.setExtensionEnabled).not.toHaveBeenCalled();
    }
  );

  it('separates tools, instruction skills and remote services without hiding their controls', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        apps: [],
        skills: [
          {
            type: 'builtinSkill',
            name: 'computer-use',
            description: 'guide',
            path: '/builtin/computer-use',
            content: 'fixture guide',
            global: true,
          },
        ],
        extensions: [
          { type: 'builtin', name: 'qwen_computer', enabled: false },
          { type: 'builtin', name: 'git', enabled: true },
          {
            type: 'streamable_http',
            name: 'github_official',
            uri: 'https://api.githubcopilot.com/mcp/',
            enabled: false,
          },
        ],
      }),
      errors: {},
      warnings: [],
    });
    renderView();
    const tools = await screen.findByRole('region', { name: 'Built-in capabilities' });
    expect(within(tools).getByRole('button', { name: 'Computer Use' })).toBeVisible();
    expect(within(tools).queryByRole('button', { name: 'Code repositories' })).toBeNull();
    expect(
      within(tools).getByRole('switch', { name: 'Enable Computer Use' })
    ).not.toBeChecked();
    const skills = screen.getByRole('region', { name: 'Skills' });
    expect(within(skills).getByRole('button', { name: 'Code repositories' })).toBeVisible();
    expect(within(skills).getByRole('button', { name: 'Desktop operation guide' })).toBeVisible();
    expect(within(skills).queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'GitHub' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Local Git' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Code repositories' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Local Git controls and GitHub account connection'
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' })
    );
    await userEvent.type(screen.getByPlaceholderText('Search tools'), 'computer-use');
    expect(screen.getByRole('button', { name: 'Desktop operation guide' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'External MCP' })).toBeNull();
  });

  it('opens the exact MCP entry selected from the composer without enabling it', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: {
        capabilities: [],
        methods: [],
        apps: [],
        external: [
          {
            id: 'external:fixture',
            kind: 'external',
            source: 'extension',
            name: 'Fixture',
            description: 'Selected from slash menu',
            status: 'disabled',
            actions: ['configure'],
            reference: { key: 'configKey', value: 'fixture' },
            extensionSource: { type: 'stdio', name: 'fixture', cmd: 'fixture-server', args: ['mcp'], enabled: true },
          },
        ],
      },
      errors: {},
      warnings: [],
    });
    renderView('/toolbox?item=external%3Afixture');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Update Extension');
    expect(screen.getByDisplayValue(/fixture-server/)).toBeVisible();
    expect(configContext.setExtensionEnabled).not.toHaveBeenCalled();
  });

  it('groups upstream Office skills and keeps their details and search accessible', async () => {
    vi.mocked(loadToolbox).mockResolvedValue({
      model: buildToolboxModel({
        skills: ['office-docx', 'office-xlsx', 'office-pptx'].map((name) => ({
          source: { rootKind: 'builtin' as const, rootId: 'builtin', relativePath: name },
          name,
          description: name,
          scope: 'builtin' as const,
          readOnly: true,
          enabled: true,
          displayPath: `builtin/${name}`,
          version: 'v1',
          rawDocument: name,
          originalMetadata: {},
          displayMetadata: { locales: {} },
          companionFiles: [],
        })),
        apps: [],
        extensions: [],
      }),
      errors: {},
      warnings: [],
    });
    renderView();
    const office = await screen.findByRole('region', { name: 'Office documents' });
    expect(within(office).getAllByRole('button')).toHaveLength(3);
    await userEvent.click(within(office).getAllByRole('button')[0]);
    expect(screen.getByRole('dialog')).toHaveTextContent('Skill details: office-');
    await userEvent.type(screen.getByRole('searchbox'), 'office-xlsx');
    expect(
      within(screen.getByRole('region', { name: 'Office documents' })).getAllByRole('button')
    ).toHaveLength(1);
  });

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
            extensionSource: { type: 'stdio', name: 'filesystem', cmd: 'filesystem-server', args: ['mcp'], enabled: true },
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
    expect(screen.getByRole('dialog')).toHaveTextContent('Update Extension');
    expect(screen.getByDisplayValue(/filesystem-server/)).toBeVisible();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/toolbox?section=external');
  });

  it.each([
    ['zh-CN', zhCN, '已配置并启用'],
    ['zh-TW', zhTW, '已設定並啟用'],
    ['en', {}, 'Configured and enabled'],
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
            name: 'Computer Use',
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
    expect(await screen.findByText('Computer Use')).toBeVisible();
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

    await screen.findByRole('button', { name: 'Computer Use' });
    await userEvent.type(screen.getByRole('searchbox'), '电脑控制');
    const card = await screen.findByRole('button', { name: 'Computer Use' });
    expect(screen.getByRole('switch', { name: 'Disable Computer Use' })).toBeChecked();
    expect(
      screen.queryByRole('button', { name: /delete computer control/i })
    ).not.toBeInTheDocument();

    await userEvent.click(card);
    expect(screen.getByRole('dialog')).toHaveTextContent('Computer Use');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('qwen_computer');
    expect(screen.getByRole('dialog')).toHaveTextContent('Example use');
    expect(screen.getByRole('dialog')).toHaveTextContent('list_apps');
    expect(screen.getByRole('dialog')).toHaveTextContent('click');
    expect(screen.getByRole('dialog')).toHaveTextContent('Not verified for this installation');
    vi.mocked(testConfigExtension).mockResolvedValue({
      success: true,
      tools: ['mcp__qwen_computer__get_app_state'],
      latencyMs: 1,
      resourceCount: 0,
      supportsResources: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Read tool inventory' }));
    expect(await screen.findByText('computer__get_app_state')).toBeVisible();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('mcp__qwen');
    expect(screen.getByRole('dialog')).toHaveTextContent('not successful execution');
    expect(screen.getByRole('dialog')).toHaveTextContent('Observe and control');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await userEvent.click(screen.getByRole('switch', { name: 'Disable Computer Use' }));
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

    const card = await screen.findByRole('button', { name: 'Computer Use' });
    const control = screen.getByRole('switch', { name: 'Disable Computer Use' });
    await userEvent.click(control);

    expect(await screen.findByText('Stopping…')).toBeVisible();
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
    expect(card.isConnected).toBe(true);
    expect(control).toBeDisabled();

    await act(async () => finishShutdown());
    expect(await screen.findByText('Disabled')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Computer Use' })).toBe(card);
    expect(screen.getByRole('switch', { name: 'Enable Computer Use' })).toBe(control);
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
    const card = await screen.findByRole('button', { name: 'Computer Use' });
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
    expect(screen.getByRole('button', { name: 'Computer Use' })).toBe(card);
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

    expect(await screen.findByRole('heading', { name: 'Computer Use' })).toBeVisible();
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


it('searches the full toolbox beyond mounted pages and opens the matching detail', async () => {
  const external: ToolboxLoadResult['model']['external'] = Array.from({ length: 200 }, (_, i) => ({
    id: `external:bulk_${i}`, kind: 'external', source: 'extension', name: `bulk_${String(i).padStart(3, '0')}`, description: '', status: 'disabled', actions: ['configure'],
    reference: { key: 'configKey', value: `bulk_${i}` }, extensionSource: { type: 'stdio', name: `bulk_${i}`, cmd: 'fixture', args: [], enabled: false },
  }));
  vi.mocked(loadToolbox).mockResolvedValue({ model: { capabilities: [], methods: [], apps: [], external }, errors: {}, warnings: [] });
  renderView('/toolbox?section=external');
  expect(await screen.findByRole('button', { name: 'bulk_000' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'bulk_199' })).not.toBeInTheDocument();
  await userEvent.type(screen.getByRole('searchbox'), 'bulk_199');
  await userEvent.click(await screen.findByRole('button', { name: 'bulk_199' }));
  expect(await screen.findByRole('dialog')).toBeVisible();
});


it('renders an available inventory before slower parallel loading finishes', async () => {
  const partial: ToolboxLoadResult = { model: { capabilities: [], methods: [], apps: [], external: [{ id: 'early', name: 'Early inventory', description: '', kind: 'external', source: 'extension', status: 'configured', actions: [] }] }, errors: {}, warnings: [] };
  let finish!: (value: ToolboxLoadResult) => void;
  vi.mocked(loadToolbox).mockImplementation(async (_cwd, _session, options) => {
    options?.onPartial?.(partial);
    return new Promise<ToolboxLoadResult>(resolve => { finish = resolve; });
  });
  renderView('/toolbox');
  expect(await screen.findByRole('button', { name: 'Early inventory' })).toBeVisible();
  await act(async () => finish(partial));
});

it('groups built-in development skills and expands matching search results', async () => {
  vi.mocked(loadToolbox).mockResolvedValue({
    model: buildToolboxModel({ skills: [
      { type: 'builtinSkill', name: 'code-navigation', description: 'Semantic references', content: '', global: true, path: 'builtin://skills/code-navigation' },
      { type: 'builtinSkill', name: 'web-acceptance', description: 'Browser checks', content: '', global: true, path: 'builtin://skills/web-acceptance' },
    ], apps: [], extensions: [] }), errors: {}, warnings: [],
  });
  renderView('/toolbox');
  expect(await screen.findByText(/Development and debugging/)).toBeVisible();
  expect(screen.getByText(/Web development and acceptance/)).toBeVisible();
  await userEvent.type(screen.getByRole('searchbox'), 'Semantic references');
  expect(await screen.findByRole('button', { name: /Code definitions and references/ })).toBeVisible();
});

it('lets general skills collapse and restores that choice after search', async () => {
  vi.mocked(loadToolbox).mockResolvedValue({
    model: buildToolboxModel({ skills: [
      { type: 'builtinSkill', name: 'computer-use', description: 'Desktop guide', content: '', global: true, path: 'builtin://skills/computer-use' },
    ], apps: [], extensions: [] }), errors: {}, warnings: [],
  });
  renderView('/toolbox');
  const heading = await screen.findByText('General skills');
  const group = heading.closest('details')!;
  expect(group).toHaveAttribute('open');
  await userEvent.click(heading);
  expect(group).not.toHaveAttribute('open');
  await userEvent.type(screen.getByRole('searchbox'), 'computer-use');
  expect(group).toHaveAttribute('open');
  await userEvent.clear(screen.getByRole('searchbox'));
  expect(group).not.toHaveAttribute('open');
});
