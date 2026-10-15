import type { SourceEntry } from '@aaif/goose-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from './acpConnection';
import { findOrCreateCodeProProject } from './sources';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

function projectSource(overrides: Partial<SourceEntry> = {}): SourceEntry {
  return {
    type: 'project',
    name: 'ledger-a1b2c3d4e5f6',
    description: 'CodePro project',
    content: '',
    path: 'C:\\Users\\tester\\projects\\ledger-a1b2c3d4e5f6.md',
    global: true,
    writable: true,
    properties: {},
    ...overrides,
  };
}

function projectInput() {
  return {
    workingDir: 'D:\\CodeProCp01\\Ledger',
    normalizedIdentity: 'd:\\codeprocp01\\ledger',
    displayName: 'Ledger',
    suggestedProjectId: 'ledger-a1b2c3d4e5f6',
  };
}

describe('CodePro Project Source binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses a Project with the same trusted workspace identity', async () => {
    const source = projectSource({
      properties: {
        codeproWorkspaceIdentity: 'd:\\codeprocp01\\ledger',
        workingDirs: ['D:\\Older-Casing\\Ledger'],
        color: '#112233',
      },
    });
    const client = {
      goose: {
        sourcesList_unstable: vi.fn().mockResolvedValue({ sources: [source] }),
        sourcesCreate_unstable: vi.fn(),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await expect(findOrCreateCodeProProject(projectInput())).resolves.toEqual({
      projectId: source.name,
      source,
      created: false,
    });
    expect(client.goose.sourcesCreate_unstable).not.toHaveBeenCalled();
    expect(source.properties?.color).toBe('#112233');
  });

  it('reuses a legacy Project by case-insensitive normalized Windows workingDirs', async () => {
    const source = projectSource({
      name: 'legacy-ledger',
      properties: { workingDirs: ['d:/codeprocp01/ledger/'] },
    });
    const client = {
      goose: {
        sourcesList_unstable: vi.fn().mockResolvedValue({ sources: [source] }),
        sourcesCreate_unstable: vi.fn(),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const binding = await findOrCreateCodeProProject(projectInput());

    expect(binding).toMatchObject({ projectId: 'legacy-ledger', created: false });
    expect(client.goose.sourcesCreate_unstable).not.toHaveBeenCalled();
  });

  it('creates one global Project Source when the workspace is unknown', async () => {
    const createdSource = projectSource();
    const client = {
      goose: {
        sourcesList_unstable: vi.fn().mockResolvedValue({ sources: [] }),
        sourcesCreate_unstable: vi.fn().mockResolvedValue({ source: createdSource }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await expect(findOrCreateCodeProProject(projectInput())).resolves.toEqual({
      projectId: createdSource.name,
      source: createdSource,
      created: true,
    });
    expect(client.goose.sourcesCreate_unstable).toHaveBeenCalledWith({
      type: 'project',
      name: 'ledger-a1b2c3d4e5f6',
      description: 'CodePro workspace at D:\\CodeProCp01\\Ledger',
      content: '',
      target: { scope: 'global' },
      properties: {
        title: 'Ledger',
        workingDirs: ['D:\\CodeProCp01\\Ledger'],
        codeproWorkspaceIdentity: 'd:\\codeprocp01\\ledger',
      },
    });
  });

  it('re-lists once after a concurrent create collision and reuses the winner', async () => {
    const winner = projectSource();
    const client = {
      goose: {
        sourcesList_unstable: vi
          .fn()
          .mockResolvedValueOnce({ sources: [] })
          .mockResolvedValueOnce({
            sources: [
              projectSource({
                ...winner,
                properties: { codeproWorkspaceIdentity: projectInput().normalizedIdentity },
              }),
            ],
          }),
        sourcesCreate_unstable: vi.fn().mockRejectedValue(new Error('already exists')),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const binding = await findOrCreateCodeProProject(projectInput());

    expect(binding).toMatchObject({ projectId: winner.name, created: false });
    expect(client.goose.sourcesList_unstable).toHaveBeenCalledTimes(2);
  });
});
