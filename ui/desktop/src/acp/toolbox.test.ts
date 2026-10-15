import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadToolbox } from './toolbox';
import { listManagedSkills } from './skillManagement';
import { getConfiguredExtensions } from './extensions';
import { listCapabilityUsage } from './capabilityUsage';

vi.mock('./skillManagement', () => ({ listManagedSkills: vi.fn() }));
vi.mock('./extensions', () => ({ getConfiguredExtensions: vi.fn() }));
vi.mock('./capabilityUsage', () => ({ listCapabilityUsage: vi.fn() }));

describe('loadToolbox', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns successful sources when one source fails', async () => {
    vi.mocked(listManagedSkills).mockResolvedValue({ skills: [], destinationRoots: [] });
    vi.mocked(getConfiguredExtensions).mockResolvedValue({
      extensions: [{ type: 'builtin', name: 'developer', description: '', enabled: true }],
      warnings: ['legacy entry skipped'],
    });
    vi.mocked(listCapabilityUsage).mockResolvedValue({
      records: [],
      warning: 'usage data needs attention',
    });

    const result = await loadToolbox('D:\\project', 'session-1');

    expect(result.model.capabilities).toMatchObject([
      { id: 'builtin:developer', kind: 'builtin', status: 'configured' },
    ]);
    expect(result.errors).toEqual({});
    expect(result.warnings).toEqual(['legacy entry skipped', 'usage data needs attention']);
    expect(listManagedSkills).toHaveBeenCalledWith('D:\\project');
  });

  it('includes disabled managed skills so users can inspect and re-enable them', async () => {
    vi.mocked(listManagedSkills).mockResolvedValue({
      skills: [
        {
          source: { rootKind: 'global', rootId: 'global', relativePath: 'disabled-demo' },
          name: 'disabled-demo',
          description: 'Disabled skill',
          scope: 'global',
          readOnly: false,
          enabled: false,
          displayPath: 'C:\\skills\\disabled-demo',
          version: 'v1',
          rawDocument: '---\nname: disabled-demo\ndescription: Disabled skill\n---\n',
          originalMetadata: {},
          displayMetadata: { locales: {} },
          companionFiles: [],
        },
      ],
      destinationRoots: [],
    });
    vi.mocked(getConfiguredExtensions).mockResolvedValue({ extensions: [], warnings: [] });
    vi.mocked(listCapabilityUsage).mockResolvedValue({ records: [] });

    const result = await loadToolbox('D:\\project');

    expect(result.errors).toEqual({});
    expect(result.model.apps).toEqual([]);
    expect(result.model.methods).toMatchObject([{ id: 'skill:disabled-demo', status: 'disabled' }]);
  });
});
