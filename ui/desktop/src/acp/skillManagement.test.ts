import { describe, expect, it, vi } from 'vitest';
import { getAcpClient } from './acpConnection';
import {
  applySkillChange,
  listManagedSkills,
  previewSkillChange,
  previewSkillDownload,
  skillManagementErrorReason,
} from './skillManagement';

vi.mock('./acpConnection', () => ({ getAcpClient: vi.fn() }));

describe('skill management ACP client', () => {
  it('uses bounded list, preview, and apply methods', async () => {
    const skillsManageList_unstable = vi
      .fn()
      .mockResolvedValue({ skills: [], destinationRoots: [] });
    const skillsManagePreview_unstable = vi.fn().mockResolvedValue({ previewToken: 'preview' });
    const skillsManageApply_unstable = vi.fn().mockResolvedValue({ skill: { name: 'demo' } });
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: {
        skillsManageList_unstable,
        skillsManagePreview_unstable,
        skillsManageApply_unstable,
      },
    } as never);

    await listManagedSkills('D:\\project');
    await previewSkillChange(
      {
        operation: 'create',
        destination: { rootKind: 'global', rootId: 'global', name: 'demo' },
        rawDocument: 'document',
      },
      'D:\\project'
    );
    await applySkillChange('preview');

    expect(skillsManageList_unstable).toHaveBeenCalledWith({ projectDir: 'D:\\project' });
    expect(skillsManagePreview_unstable).toHaveBeenCalledWith({
      projectDir: 'D:\\project',
      change: {
        operation: 'create',
        destination: { rootKind: 'global', rootId: 'global', name: 'demo' },
        rawDocument: 'document',
      },
    });
    expect(skillsManageApply_unstable).toHaveBeenCalledWith({ previewToken: 'preview' });
  });

  it('uses the generated staged-download method', async () => {
    const skillsManageDownloadPreview_unstable = vi.fn().mockResolvedValue({
      previewToken: 'download-preview',
      files: ['SKILL.md'],
    });
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: { skillsManageDownloadPreview_unstable },
    } as never);

    await previewSkillDownload(
      'https://example.com/SKILL.md',
      { rootKind: 'global', rootId: 'global', name: 'downloaded' },
      'D:\\project'
    );

    expect(skillsManageDownloadPreview_unstable).toHaveBeenCalledWith({
      projectDir: 'D:\\project',
      destination: { rootKind: 'global', rootId: 'global', name: 'downloaded' },
      url: 'https://example.com/SKILL.md',
    });
  });

  it('extracts stable reasons without requiring English server prose', () => {
    expect(skillManagementErrorReason({ data: { reason: 'read_only' } })).toBe('read_only');
    expect(skillManagementErrorReason(new Error('request failed: stale_source'))).toBe(
      'stale_source'
    );
    expect(skillManagementErrorReason(new Error('backend unavailable'))).toBe('unknown');
  });
});
