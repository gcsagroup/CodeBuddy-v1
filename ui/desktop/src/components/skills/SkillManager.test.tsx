import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import zhMessages from '../../i18n/compiled/zh-CN.json';
import {
  applySkillChange,
  listManagedSkills,
  listSkillRecoveries,
  previewSkillChange,
  previewSkillDownload,
} from '../../acp/skillManagement';
import SkillManager from './SkillManager';
import { requestSkillManagementConfirmation } from '../../acp/skillConfirmationRequests';

vi.mock('../../utils/workingDir', () => ({ getInitialWorkingDir: () => 'D:\\project' }));
vi.mock('../../acp/skillManagement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acp/skillManagement')>()),
  applySkillChange: vi.fn(),
  listManagedSkills: vi.fn(),
  listSkillRecoveries: vi.fn(),
  previewSkillChange: vi.fn(),
  previewSkillDownload: vi.fn(),
}));
vi.mock('../Layout/MainPanelLayout', () => ({
  MainPanelLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../conversation/SearchView', () => ({
  SearchView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const skill = {
  source: { rootKind: 'global' as const, rootId: 'global', relativePath: 'demo' },
  name: 'demo',
  description: 'Demo skill',
  scope: 'global',
  readOnly: false,
  enabled: true,
  displayPath: 'C:\\skills\\demo',
  version: 'version-1',
  rawDocument: '---\nname: demo\ndescription: Demo skill\n---\nDo the work.\n',
};

function CurrentLocation() {
  const location = useLocation();
  return (
    <div data-testid="current-location">{`${location.pathname}${location.search} ${JSON.stringify(location.state)}`}</div>
  );
}

function renderManager(path = '/skills', projectDir?: string) {
  return render(
    <IntlProvider locale="zh-CN" messages={zhMessages}>
      <MemoryRouter initialEntries={[path]}>
        <SkillManager projectDir={projectDir} />
        <CurrentLocation />
      </MemoryRouter>
    </IntlProvider>
  );
}

describe('SkillManager user workflows', () => {
  it('shared skills show source and pending state, require one trust confirmation, and refresh without an edit preview', async () => {
    const shared = { ...skill, source: { ...skill.source, rootKind: 'shared_user' as const }, scope: 'shared', readOnly: true, canToggle: true, enabled: false, availability: 'pending' as const };
    vi.mocked(listManagedSkills).mockResolvedValue({ skills: [shared], destinationRoots: [], diagnostics: ['bad/SKILL.md: invalid YAML'] });
    vi.mocked(applySkillChange).mockImplementation(async () => {
      const result = await requestSkillManagementConfirmation({ previewToken: 'shared-preview', nonce: 'nonce', operation: 'set_enabled', target: shared.displayPath, expiresAt: '2099-01-01T00:00:00Z' });
      if (result.decision === 'cancel') throw new Error('confirmation_cancelled');
      expect(result.decision).toBe('confirm');
      vi.mocked(listManagedSkills).mockResolvedValue({ skills: [{ ...shared, enabled: true, availability: 'available' }], destinationRoots: [] });
      return { skill: { ...shared, enabled: true } };
    });
    renderManager();
    expect(await screen.findByText('尚未在 CodeBuddy 启用')).toBeVisible();
    expect(screen.getByText('本机共享技能')).toBeVisible();
    expect(screen.getByText('bad/SKILL.md: invalid YAML')).toBeVisible();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '启用' }));
    let dialog = await screen.findByRole('dialog', { name: '启用这个共享技能？' });
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '启用这个共享技能？' })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('尚未在 CodeBuddy 启用')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '启用' }));
    dialog = await screen.findByRole('dialog', { name: '启用这个共享技能？' });
    await userEvent.click(within(dialog).getByRole('button', { name: '启用' }));
    await screen.findByRole('button', { name: '停用' });
    expect(applySkillChange).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('检查更改')).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listManagedSkills).mockResolvedValue({
      skills: [skill],
      destinationRoots: [
        {
          rootKind: 'global',
          rootId: 'global',
          displayPath: 'C:\\skills',
          readOnly: false,
        },
      ],
    });
    vi.mocked(listSkillRecoveries).mockResolvedValue([
      {
        recoveryRef: 'recovery-1',
        source: skill.source,
        name: 'deleted-demo',
        version: 'deleted-version',
        deletedAt: '2026-09-06T00:00:00Z',
      },
    ]);
    vi.mocked(previewSkillChange).mockImplementation(async (operation) => ({
      previewToken: `preview-${operation.operation}`,
      expiresAt: '2026-09-06T01:00:00Z',
      operation: operation.operation,
      target: 'demo',
      requiresConfirmation: operation.operation === 'delete',
      hasConflict: false,
      files: ['SKILL.md'],
      diff: 'preview diff',
    }));
    vi.mocked(applySkillChange).mockResolvedValue({ skill });
    vi.mocked(previewSkillDownload).mockResolvedValue({
      previewToken: 'preview-download',
      expiresAt: '2026-09-06T01:00:00Z',
      operation: 'download',
      target: 'downloaded',
      requiresConfirmation: false,
      hasConflict: false,
      files: ['SKILL.md', '.codebuddy-source.json'],
      diff: 'source: https://example.com/SKILL.md',
    });
    window.electron.selectFileOrDirectory = vi.fn().mockResolvedValue('D:\\fixtures\\imported');
  });

  it('shows Chinese CRUD controls and creates a skill through preview and apply', async () => {
    const user = userEvent.setup();
    renderManager();

    expect(await screen.findByRole('heading', { name: '技能' })).toBeVisible();
    expect(screen.getByRole('button', { name: '导入本地技能' })).toBeVisible();
    expect(screen.getByRole('button', { name: '从链接下载' })).toBeVisible();
    expect(screen.getByRole('button', { name: '新建技能' })).toBeVisible();
    expect(screen.getByRole('button', { name: '编辑' })).toBeVisible();
    expect(screen.getByRole('button', { name: '复制' })).toBeVisible();
    expect(screen.getByRole('button', { name: '删除' })).toBeVisible();
    expect(screen.getByRole('button', { name: '停用' })).toBeVisible();
    expect(screen.getByRole('button', { name: '恢复' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '新建技能' }));
    const editor = screen.getByRole('dialog');
    await user.type(within(editor).getByLabelText('技能名称'), 'new-skill');
    await user.type(within(editor).getByLabelText('说明'), '新技能说明');
    await user.type(within(editor).getByLabelText('技能指令'), '完成用户请求。');
    await user.click(within(editor).getByRole('button', { name: '检查更改' }));

    await waitFor(() =>
      expect(previewSkillChange).toHaveBeenCalledWith(
        {
          operation: 'create',
          destination: { rootKind: 'global', rootId: 'global', name: 'new-skill' },
          rawDocument: '---\nname: new-skill\ndescription: 新技能说明\n---\n完成用户请求。\n',
        },
        'D:\\project'
      )
    );
    const preview = await screen.findByRole('dialog');
    expect(preview).toHaveTextContent('检查技能更改');
    expect(preview).toHaveTextContent('preview diff');
    await user.click(within(preview).getByRole('button', { name: '应用更改' }));
    await waitFor(() => expect(applySkillChange).toHaveBeenCalledWith('preview-create'));
  });

  it('disables an installed user skill through preview and apply', async () => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText('demo');

    await user.click(screen.getByRole('button', { name: '停用' }));
    await waitFor(() =>
      expect(previewSkillChange).toHaveBeenCalledWith(
        {
          operation: 'set_enabled',
          source: skill.source,
          expectedVersion: 'version-1',
          enabled: false,
        },
        'D:\\project'
      )
    );
    const preview = await screen.findByRole('dialog');
    await user.click(within(preview).getByRole('button', { name: '应用更改' }));
    await waitFor(() => expect(applySkillChange).toHaveBeenCalledWith('preview-set_enabled'));
  });

  it('stages a link download for review before applying it', async () => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText('demo');

    await user.click(screen.getByRole('button', { name: '从链接下载' }));
    const editor = screen.getByRole('dialog');
    await user.type(within(editor).getByLabelText('技能名称'), 'downloaded');
    await user.type(
      within(editor).getByLabelText('GitHub 技能目录或 HTTPS SKILL.md 链接'),
      'https://example.com/SKILL.md'
    );
    await user.click(within(editor).getByRole('button', { name: '检查更改' }));

    await waitFor(() =>
      expect(previewSkillDownload).toHaveBeenCalledWith(
        'https://example.com/SKILL.md',
        { rootKind: 'global', rootId: 'global', name: 'downloaded' },
        'D:\\project'
      )
    );
    const preview = await screen.findByRole('dialog');
    expect(preview).toHaveTextContent('SKILL.md, .codebuddy-source.json');
    expect(applySkillChange).not.toHaveBeenCalled();
  });

  it('opens a distinct detail view and prepares the selected skill for use', async () => {
    const user = userEvent.setup();
    renderManager('/skills?skill=demo');

    const detail = await screen.findByRole('dialog', { name: 'demo' });
    expect(detail).toHaveTextContent('Demo skill');
    expect(detail).toHaveTextContent('Do the work.');
    expect(detail).toHaveTextContent('C:\\skills\\demo');
    await user.click(within(detail).getByRole('button', { name: '使用技能' }));
    expect(screen.getByTestId('current-location')).toHaveTextContent('/pair');
    expect(screen.getByTestId('current-location')).toHaveTextContent('"draftOnly":true');
    expect(screen.getByTestId('current-location')).toHaveTextContent('使用 demo 技能：');
  });

  it('keeps a project skill in its owning workspace when opening its conversation', async () => {
    vi.mocked(listManagedSkills).mockResolvedValue({
      skills: [
        {
          ...skill,
          scope: 'project',
          source: { rootKind: 'project_agents', rootId: 'project', relativePath: 'demo' },
        },
      ],
      destinationRoots: [],
    });
    renderManager('/codepro/skills?skill=demo');
    const detail = await screen.findByRole('dialog', { name: 'demo' });
    await userEvent.click(within(detail).getByRole('button', { name: '使用技能' }));
    expect(screen.getByTestId('current-location')).toHaveTextContent(
      JSON.stringify({
        initialMessage: { msg: '使用 demo 技能：', images: [] },
        draftOnly: true,
        noAutoSubmit: true,
        workingDir: 'D:\\project',
      })
    );
  });

  it('uses the conversation workspace and returns a draft to that same conversation', async () => {
    renderManager('/codepro/toolbox?skill=demo&sessionId=existing', 'D:\\conversation');
    const detail = await screen.findByRole('dialog', { name: 'demo' });
    expect(listManagedSkills).toHaveBeenCalledWith('D:\\conversation');
    expect(listSkillRecoveries).toHaveBeenCalledWith('D:\\conversation');
    await userEvent.click(within(detail).getByRole('button', { name: '使用技能' }));
    expect(screen.getByTestId('current-location')).toHaveTextContent('/codepro/pair?resumeSessionId=existing');
    expect(screen.getByTestId('current-location')).toHaveTextContent('"draftOnly":true');
    expect(screen.getByTestId('current-location')).toHaveTextContent('"noAutoSubmit":true');
  });

  it('renders the selected skill as a dialog-only toolbox controller', async () => {
    const onRequestClose = vi.fn();
    render(
      <IntlProvider locale="zh-CN" messages={zhMessages}>
        <MemoryRouter>
          <SkillManager
            dialogOnly
            request={{ type: 'detail', skill }}
            onRequestClose={onRequestClose}
          />
        </MemoryRouter>
      </IntlProvider>
    );

    const detail = await screen.findByRole('dialog', { name: 'demo' });
    expect(detail).toHaveTextContent('Demo skill');
    expect(within(detail).getByRole('button', { name: '编辑' })).toBeVisible();
    expect(within(detail).getByRole('button', { name: '复制' })).toBeVisible();
    expect(within(detail).getByRole('button', { name: '删除' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '技能' })).not.toBeInTheDocument();
    await userEvent.click(within(detail).getAllByRole('button', { name: '关闭' })[0]);
    expect(onRequestClose).toHaveBeenCalledOnce();
  });

  it('previews import, edit, delete, and restore using the selected skill identity', async () => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText('demo');

    await user.click(screen.getByRole('button', { name: '导入本地技能' }));
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('技能名称'), 'imported');
    await user.click(within(dialog).getByRole('button', { name: '浏览…' }));
    await user.click(within(dialog).getByRole('button', { name: '检查更改' }));
    await waitFor(() =>
      expect(previewSkillChange).toHaveBeenCalledWith(
        {
          operation: 'import_local',
          destination: { rootKind: 'global', rootId: 'global', name: 'imported' },
          sourcePath: 'D:\\fixtures\\imported',
        },
        'D:\\project'
      )
    );
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    await user.click(screen.getByRole('button', { name: '编辑' }));
    dialog = screen.getByRole('dialog');
    const document = within(dialog).getByLabelText('SKILL.md 内容');
    await user.clear(document);
    await user.type(document, 'updated document');
    await user.click(within(dialog).getByRole('button', { name: '检查更改' }));
    await waitFor(() =>
      expect(previewSkillChange).toHaveBeenCalledWith(
        {
          operation: 'update_raw',
          source: skill.source,
          expectedVersion: 'version-1',
          rawDocument: 'updated document',
        },
        'D:\\project'
      )
    );
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    await user.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() =>
      expect(previewSkillChange).toHaveBeenCalledWith(
        {
          operation: 'delete',
          source: skill.source,
          expectedVersion: 'version-1',
        },
        'D:\\project'
      )
    );
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    await user.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() =>
      expect(previewSkillChange).toHaveBeenCalledWith(
        { operation: 'restore', recoveryRef: 'recovery-1' },
        'D:\\project'
      )
    );
  });
});
