import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmCodeProWorkspace,
  extractWindowsWorkspaceCandidates,
  extractWorkspaceCandidates,
  independentSiblingWorkspacePath,
  inspectCodeProWorkspace,
  isFilesystemRoot,
} from './projectWorkspace';

const directoryStat = { isDirectory: () => true, isFile: () => false };
const fileStat = { isDirectory: () => false, isFile: () => true };

function fileSystemError(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

describe('independent project workspace naming', () => {
  it('places a new project beside the selected project instead of inside it', () => {
    expect(independentSiblingWorkspacePath('D:\\SchoolSystem', 1)).toBe('D:\\codepro-project');
    expect(independentSiblingWorkspacePath('D:\\SchoolSystem', 3)).toBe('D:\\codepro-project-3');
  });

  it('preserves POSIX path semantics and rejects invalid ordinals', () => {
    expect(independentSiblingWorkspacePath('/projects/school-system', 2)).toBe(
      '/projects/codepro-project-2'
    );
    expect(() => independentSiblingWorkspacePath('D:\\SchoolSystem', 0)).toThrow(
      'positive integer'
    );
  });
});

describe('CodePro Windows workspace candidate extraction', () => {
  it.each([
    ['请在 "D:\\Code Pro\\ledger app" 开发一个记账应用', ['D:\\Code Pro\\ledger app']],
    ['请在 `E:/team/ledger app` 创建项目', ['E:\\team\\ledger app']],
    ['workspace: D:\\CodePro\\ledger。', ['D:\\CodePro\\ledger']],
    ['use "\\\\server\\share\\team app"', ['\\\\server\\share\\team app']],
  ])('extracts one absolute candidate from %s', (prompt, expected) => {
    expect(extractWindowsWorkspaceCandidates(prompt)).toEqual(expected);
  });

  it('deduplicates equivalent drive paths without changing first-seen display casing', () => {
    expect(
      extractWindowsWorkspaceCandidates('D:\\CodePro\\Ledger 和 d:/codepro/ledger 是同一个目录')
    ).toEqual(['D:\\CodePro\\Ledger']);
  });

  it('preserves multiple distinct candidates for explicit user choice', () => {
    expect(
      extractWindowsWorkspaceCandidates('从 D:\\CodePro\\old 迁移到 E:\\CodePro\\new')
    ).toEqual(['D:\\CodePro\\old', 'E:\\CodePro\\new']);
  });

  it('preserves legal trailing punctuation inside an explicitly quoted path', () => {
    expect(
      extractWindowsWorkspaceCandidates('build in "D:\\CodePro\\Ledger)" and `E:\\Apps\\Notes]`')
    ).toEqual(['D:\\CodePro\\Ledger)', 'E:\\Apps\\Notes]']);
  });

  it('does not invent a workspace for ordinary natural language', () => {
    expect(extractWindowsWorkspaceCandidates('帮我开发一个记账应用')).toEqual([]);
  });
});

describe('CodePro workspace inspection', () => {
  it.each(['selected', 'prompt'] as const)(
    'inspects and confirms a real Unicode directory with punctuation from %s',
    async (source) => {
      const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'codepro-path-'));
      const workspace = path.join(fixture, '中文 项目)');
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, 'preserve.txt'), 'original 中文\n');
      try {
        const inspections = await inspectCodeProWorkspace({
          prompt: source === 'prompt' ? `在 "${workspace}" 继续开发` : '继续开发',
          selectedWorkingDir: source === 'selected' ? workspace : fixture,
        });
        expect(inspections).toHaveLength(1);
        const inspected = inspections[0];
        expect(inspected).toMatchObject({
          source,
          normalizedPath: workspace,
          canonicalPath: await fs.realpath(workspace),
          state: 'non-empty-directory',
          error: null,
        });
        const confirmed = await confirmCodeProWorkspace({
          normalizedPath: inspected.normalizedPath,
          expectedIdentity: inspected.normalizedIdentity,
          expectedState: 'non-empty-directory',
        });
        expect(confirmed.workingDir).toBe(await fs.realpath(workspace));
        expect(confirmed.created).toBe(false);
        expect(await fs.readdir(fixture)).toEqual(['中文 项目)']);
        expect(await fs.readFile(path.join(workspace, 'preserve.txt'), 'utf8')).toBe(
          'original 中文\n'
        );
      } finally {
        await fs.rm(fixture, { recursive: true, force: true });
      }
    }
  );

  it('preserves a selected POSIX workspace when no Windows path is in the prompt', async () => {
    const stat = vi.fn(async (candidate: string) => {
      if (candidate === '/Users/dev/app/.git') throw fileSystemError('ENOENT');
      return directoryStat;
    });
    const inspection = await inspectCodeProWorkspace(
      { prompt: 'build the selected project', selectedWorkingDir: '/Users/dev/app' },
      {
        stat,
        readdir: vi.fn().mockResolvedValue(['README.md']),
        realpath: vi.fn().mockResolvedValue('/Users/dev/app'),
        mkdir: vi.fn(),
      }
    );

    expect(inspection[0]).toMatchObject({
      normalizedPath: '/Users/dev/app',
      normalizedIdentity: '/Users/dev/app',
      canonicalPath: '/Users/dev/app',
      source: 'selected',
      state: 'non-empty-directory',
      displayName: 'app',
      error: null,
    });
    expect(stat).toHaveBeenCalledWith('/Users/dev/app/.git');
  });

  it('rejects a relative selected workspace without touching the filesystem', async () => {
    const stat = vi.fn();
    const inspection = await inspectCodeProWorkspace(
      { prompt: '', selectedWorkingDir: '..\\relative-project' },
      {
        stat,
        readdir: vi.fn(),
        realpath: vi.fn(),
        mkdir: vi.fn(),
      }
    );

    expect(inspection[0]).toMatchObject({
      state: 'unavailable',
      error: 'Workspace path must be absolute',
    });
    expect(stat).not.toHaveBeenCalled();
  });

  it('deduplicates junction aliases by their canonical workspace identity', async () => {
    const inspection = await inspectCodeProWorkspace(
      {
        prompt: '比较 D:\\Links\\Ledger 和 E:\\Projects\\Ledger',
        selectedWorkingDir: 'C:\\selected',
      },
      {
        stat: vi.fn(async (candidate: string) => {
          if (candidate.endsWith('\\.git')) throw fileSystemError('ENOENT');
          return directoryStat;
        }),
        readdir: vi.fn().mockResolvedValue(['README.md']),
        realpath: vi.fn().mockResolvedValue('E:\\Projects\\Ledger'),
        mkdir: vi.fn(),
      }
    );

    expect(inspection).toHaveLength(1);
    expect(inspection[0]).toMatchObject({
      requestedPath: 'D:\\Links\\Ledger',
      normalizedPath: 'D:\\Links\\Ledger',
      canonicalPath: 'E:\\Projects\\Ledger',
      normalizedIdentity: 'e:\\projects\\ledger',
    });
  });

  it('inspects a missing prompt path without creating it', async () => {
    const mkdir = vi.fn();
    const inspection = await inspectCodeProWorkspace(
      { prompt: '在 D:\\CodeProCp01\\ledger 开发应用', selectedWorkingDir: 'C:\\selected' },
      {
        stat: vi.fn(async (candidate: string) => {
          if (candidate === 'D:\\CodeProCp01\\ledger') throw fileSystemError('ENOENT');
          if (candidate === 'D:\\CodeProCp01') return directoryStat;
          throw new Error(`unexpected stat: ${candidate}`);
        }),
        readdir: vi.fn(),
        realpath: vi.fn().mockResolvedValue('D:\\CodeProCp01'),
        mkdir,
      }
    );

    expect(inspection).toHaveLength(1);
    expect(inspection[0]).toMatchObject({
      requestedPath: 'D:\\CodeProCp01\\ledger',
      normalizedPath: 'D:\\CodeProCp01\\ledger',
      normalizedIdentity: 'd:\\codeprocp01\\ledger',
      canonicalPath: 'D:\\CodeProCp01\\ledger',
      source: 'prompt',
      state: 'missing',
      isGitRepository: false,
      displayName: 'ledger',
      error: null,
    });
    expect(inspection[0].suggestedProjectId).toMatch(/^ledger-[a-f0-9]{12}$/u);
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('binds a missing child to the canonical identity of its nearest existing junction parent', async () => {
    const stat = vi.fn(async (candidate: string) => {
      if (candidate === 'D:\\Links\\Ledger\\new-app') throw fileSystemError('ENOENT');
      if (candidate === 'D:\\Links\\Ledger') return directoryStat;
      throw new Error(`unexpected stat: ${candidate}`);
    });
    const realpath = vi.fn(async (candidate: string) => {
      expect(candidate).toBe('D:\\Links\\Ledger');
      return 'E:\\Canonical\\Ledger';
    });

    const inspection = await inspectCodeProWorkspace(
      {
        prompt: '在 D:\\Links\\Ledger\\new-app 开发应用',
        selectedWorkingDir: 'C:\\selected',
      },
      { stat, readdir: vi.fn(), realpath, mkdir: vi.fn() }
    );

    expect(inspection[0]).toMatchObject({
      normalizedPath: 'D:\\Links\\Ledger\\new-app',
      canonicalPath: 'E:\\Canonical\\Ledger\\new-app',
      normalizedIdentity: 'e:\\canonical\\ledger\\new-app',
      state: 'missing',
    });
    expect(stat).toHaveBeenCalledWith('D:\\Links\\Ledger');
    expect(realpath).toHaveBeenCalledWith('D:\\Links\\Ledger');
  });

  it.each([
    [[], 'empty-directory'],
    [['README.md'], 'non-empty-directory'],
  ] as const)('classifies an existing directory containing %j as %s', async (entries, state) => {
    const inspection = await inspectCodeProWorkspace(
      { prompt: '', selectedWorkingDir: 'E:\\Team\\App' },
      {
        stat: vi.fn(async (candidate: string) => {
          if (candidate.endsWith('\\.git')) throw fileSystemError('ENOENT');
          return directoryStat;
        }),
        readdir: vi.fn().mockResolvedValue(entries),
        realpath: vi.fn().mockResolvedValue('E:\\Team\\App'),
        mkdir: vi.fn(),
      }
    );

    expect(inspection[0]).toMatchObject({
      source: 'selected',
      state,
      canonicalPath: 'E:\\Team\\App',
      isGitRepository: false,
    });
  });

  it('reports an existing Git repository without invoking git', async () => {
    const stat = vi.fn().mockResolvedValue(directoryStat);
    const inspection = await inspectCodeProWorkspace(
      { prompt: '"D:\\Repos\\App"', selectedWorkingDir: 'C:\\selected' },
      {
        stat,
        readdir: vi.fn().mockResolvedValue(['.git', 'src']),
        realpath: vi.fn().mockResolvedValue('D:\\Repos\\App'),
        mkdir: vi.fn(),
      }
    );

    expect(inspection[0]).toMatchObject({
      state: 'non-empty-directory',
      isGitRepository: true,
    });
    expect(stat).toHaveBeenCalledWith('D:\\Repos\\App\\.git');
  });

  it.each([
    ['D:\\payload.txt', fileStat, 'file'],
    ['D:\\', directoryStat, 'filesystem-root'],
  ] as const)('classifies %s as %s', async (candidate, stats, state) => {
    const inspection = await inspectCodeProWorkspace(
      { prompt: `"${candidate}"`, selectedWorkingDir: 'C:\\selected' },
      {
        stat: vi.fn().mockResolvedValue(stats),
        readdir: vi.fn().mockResolvedValue([]),
        realpath: vi.fn().mockResolvedValue(candidate),
        mkdir: vi.fn(),
      }
    );

    expect(inspection[0].state).toBe(state);
  });

  it('returns an unavailable state with a bounded error message', async () => {
    const inspection = await inspectCodeProWorkspace(
      { prompt: 'D:\\Denied\\App', selectedWorkingDir: 'C:\\selected' },
      {
        stat: vi.fn().mockRejectedValue(fileSystemError('EACCES', 'access denied')),
        readdir: vi.fn(),
        realpath: vi.fn(),
        mkdir: vi.fn(),
      }
    );

    expect(inspection[0]).toMatchObject({ state: 'unavailable', error: 'access denied' });
  });
});

describe('CodePro cross-platform workspace candidates', () => {
  it.each([
    ['在 "/Users/dev/中文 项目)" 继续开发', ['/Users/dev/中文 项目)']],
    ['使用 `/Users/dev/app.]`', ['/Users/dev/app.]']],
    ['workspace /Users/dev/app。', ['/Users/dev/app']],
    ['目录（/Users/dev/app）', ['/Users/dev/app']],
    ['/Users/dev/App /Users/dev/app /Users/dev/App/', ['/Users/dev/App', '/Users/dev/app']],
    ['从 /Users/dev/old 到 D:\\Projects\\new', ['/Users/dev/old', 'D:\\Projects\\new']],
    ['阅读 https://example.org/path 和 file:///Users/dev/app', []],
    ['relative/path ./src ../src @scope/package', []],
    ['"/Users/dev/project D:/notes"', ['/Users/dev/project D:/notes']],
  ])('extracts filesystem candidates from %s', (prompt, expected) => {
    expect(extractWorkspaceCandidates(prompt)).toEqual(expected);
  });

  it('inspects an explicit missing POSIX candidate without writing or using the selected path', async () => {
    const mkdir = vi.fn();
    const stat = vi.fn(async (candidate: string) => {
      if (candidate === '/Users/dev/new') throw fileSystemError('ENOENT');
      if (candidate === '/Users/dev') return directoryStat;
      throw new Error(`unexpected path ${candidate}`);
    });
    const result = await inspectCodeProWorkspace(
      { prompt: '在 /Users/dev/new 开发', selectedWorkingDir: '/Users/dev/old' },
      { stat, mkdir, realpath: async (value) => value, readdir: vi.fn() }
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'prompt',
      state: 'missing',
      canonicalPath: '/Users/dev/new',
    });
    expect(mkdir).not.toHaveBeenCalled();
  });
});

describe('CodePro workspace confirmation', () => {
  it('confirms an existing POSIX workspace without rewriting its path', async () => {
    const result = await confirmCodeProWorkspace(
      {
        normalizedPath: '/Users/dev/app',
        expectedState: 'non-empty-directory',
        expectedIdentity: '/Users/dev/app',
      },
      {
        stat: vi.fn().mockResolvedValue(directoryStat),
        readdir: vi.fn().mockResolvedValue(['README.md']),
        realpath: vi.fn().mockResolvedValue('/Users/dev/app'),
        mkdir: vi.fn(),
      }
    );

    expect(result).toMatchObject({
      workingDir: '/Users/dev/app',
      normalizedIdentity: '/Users/dev/app',
      created: false,
      displayName: 'app',
    });
  });

  it('retains path-based creation for a missing POSIX workspace', async () => {
    const missingError = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const stat = vi
      .fn()
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce(directoryStat)
      .mockRejectedValueOnce(missingError);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const readdir = vi.fn().mockResolvedValue([]);
    const realpath = vi
      .fn()
      .mockResolvedValueOnce('/workspace')
      .mockResolvedValueOnce('/workspace/new-app');

    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: '/workspace/new-app',
          expectedState: 'missing',
          expectedIdentity: '/workspace/new-app',
        },
        { stat, mkdir, readdir, realpath }
      )
    ).resolves.toMatchObject({
      workingDir: '/workspace/new-app',
      normalizedIdentity: '/workspace/new-app',
      created: true,
    });

    expect(mkdir).toHaveBeenCalledWith('/workspace/new-app', { recursive: true });
  });

  it('refuses to create a missing directory without an atomic workspace lease', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'D:\\Exact Target\\ledger',
          expectedState: 'missing',
          expectedIdentity: 'd:\\exact target\\ledger',
        },
        {
          stat: vi.fn(async (candidate: string) => {
            if (candidate === 'D:\\Exact Target\\ledger') throw fileSystemError('ENOENT');
            if (candidate === 'D:\\Exact Target') return directoryStat;
            throw new Error(`unexpected stat: ${candidate}`);
          }),
          readdir: vi.fn().mockResolvedValue([]),
          realpath: vi.fn(async (candidate: string) => candidate),
          mkdir,
        }
      )
    ).rejects.toThrow('Missing workspaces require an atomic workspace lease');

    expect(mkdir).not.toHaveBeenCalled();
  });

  it('does not inspect a missing directory after refusing path-based creation', async () => {
    const mkdir = vi.fn();
    const readdir = vi.fn();
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'D:\\Raced\\App',
          expectedState: 'missing',
          expectedIdentity: 'd:\\raced\\app',
        },
        {
          stat: vi.fn(async (candidate: string) => {
            if (candidate === 'D:\\Raced\\App') throw fileSystemError('ENOENT');
            if (candidate === 'D:\\Raced') return directoryStat;
            throw new Error(`unexpected stat: ${candidate}`);
          }),
          readdir,
          realpath: vi.fn(async (candidate: string) => candidate),
          mkdir,
        }
      )
    ).rejects.toThrow('Missing workspaces require an atomic workspace lease');
    expect(mkdir).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it('rejects a missing child when its junction parent resolves to a different target after inspection', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'D:\\Links\\Ledger\\new-app',
          expectedState: 'missing',
          expectedIdentity: 'e:\\reviewed-target\\ledger\\new-app',
        },
        {
          stat: vi.fn(async (candidate: string) => {
            if (candidate === 'D:\\Links\\Ledger\\new-app') {
              throw fileSystemError('ENOENT');
            }
            if (candidate === 'D:\\Links\\Ledger') return directoryStat;
            throw new Error(`unexpected stat: ${candidate}`);
          }),
          readdir: vi.fn().mockResolvedValue([]),
          realpath: vi.fn().mockResolvedValue('D:\\different-target\\ledger'),
          mkdir,
        }
      )
    ).rejects.toThrow('Workspace changed since inspection');
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('refuses path-based creation through a confirmed canonical junction target', async () => {
    const canonicalPath = 'E:\\reviewed-target\\ledger\\new-app';
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const readdir = vi.fn().mockResolvedValue([]);
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'D:\\Links\\Ledger\\new-app',
          expectedState: 'missing',
          expectedIdentity: canonicalPath.toLowerCase(),
        },
        {
          stat: vi.fn(async (candidate: string) => {
            if (candidate === 'D:\\Links\\Ledger\\new-app') {
              throw fileSystemError('ENOENT');
            }
            if (candidate === 'D:\\Links\\Ledger') return directoryStat;
            throw new Error(`unexpected stat: ${candidate}`);
          }),
          realpath: vi.fn(async (candidate: string) => {
            if (candidate === 'D:\\Links\\Ledger') return 'E:\\reviewed-target\\ledger';
            if (candidate === canonicalPath) return canonicalPath;
            throw new Error(`unexpected realpath: ${candidate}`);
          }),
          readdir,
          mkdir,
        }
      )
    ).rejects.toThrow('Missing workspaces require an atomic workspace lease');

    expect(mkdir).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'does not create a directory when a real Windows junction is retargeted after inspection',
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codepro-junction-confirm-'));
      const reviewedTarget = path.join(fixtureRoot, 'reviewed-target');
      const changedTarget = path.join(fixtureRoot, 'changed-target');
      const junctionPath = path.join(fixtureRoot, 'workspace-link');
      const requestedPath = path.join(junctionPath, 'new-app');

      try {
        await Promise.all([
          fs.mkdir(reviewedTarget, { recursive: true }),
          fs.mkdir(changedTarget, { recursive: true }),
        ]);
        await fs.symlink(reviewedTarget, junctionPath, 'junction');
        const [inspection] = await inspectCodeProWorkspace({
          prompt: `create an app in "${requestedPath}"`,
          selectedWorkingDir: fixtureRoot,
        });

        expect(inspection.state).toBe('missing');
        expect(inspection.canonicalPath).toBe(path.join(reviewedTarget, 'new-app'));

        await fs.unlink(junctionPath);
        await fs.symlink(changedTarget, junctionPath, 'junction');

        await expect(
          confirmCodeProWorkspace({
            normalizedPath: inspection.normalizedPath,
            expectedState: 'missing',
            expectedIdentity: inspection.normalizedIdentity,
          })
        ).rejects.toThrow('Workspace changed since inspection');
        await expect(fs.stat(path.join(changedTarget, 'new-app'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await fs.unlink(junctionPath).catch(() => undefined);
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === 'win32')(
    'does not create in a changed target when the canonical parent is replaced during confirmation',
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codepro-parent-swap-'));
      const reviewedParent = path.join(fixtureRoot, 'reviewed-parent');
      const preservedParent = path.join(fixtureRoot, 'reviewed-parent-preserved');
      const changedTarget = path.join(fixtureRoot, 'changed-target');
      const requestedPath = path.join(reviewedParent, 'new-app');

      try {
        await Promise.all([
          fs.mkdir(reviewedParent, { recursive: true }),
          fs.mkdir(changedTarget, { recursive: true }),
        ]);
        const [inspection] = await inspectCodeProWorkspace({
          prompt: `create an app in "${requestedPath}"`,
          selectedWorkingDir: fixtureRoot,
        });

        expect(inspection.state).toBe('missing');
        expect(inspection.canonicalPath).toBe(requestedPath);

        await expect(
          confirmCodeProWorkspace(
            {
              normalizedPath: inspection.normalizedPath,
              expectedState: 'missing',
              expectedIdentity: inspection.normalizedIdentity,
            },
            {
              mkdir: async (directory, options) => {
                await fs.rename(reviewedParent, preservedParent);
                await fs.symlink(changedTarget, reviewedParent, 'junction');
                return fs.mkdir(directory, options);
              },
            }
          )
        ).rejects.toThrow('Missing workspaces require an atomic workspace lease');
        await expect(fs.stat(path.join(changedTarget, 'new-app'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === 'win32')(
    'does not create in a changed target when an ancestor above the canonical parent is replaced',
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codepro-ancestor-swap-'));
      const reviewedAncestor = path.join(fixtureRoot, 'reviewed-ancestor');
      const preservedAncestor = path.join(fixtureRoot, 'reviewed-ancestor-preserved');
      const reviewedParent = path.join(reviewedAncestor, 'workspace');
      const changedAncestor = path.join(fixtureRoot, 'changed-ancestor');
      const changedParent = path.join(changedAncestor, 'workspace');
      const requestedPath = path.join(reviewedParent, 'new-app');

      try {
        await Promise.all([
          fs.mkdir(reviewedParent, { recursive: true }),
          fs.mkdir(changedParent, { recursive: true }),
        ]);
        const [inspection] = await inspectCodeProWorkspace({
          prompt: `create an app in "${requestedPath}"`,
          selectedWorkingDir: fixtureRoot,
        });

        expect(inspection.state).toBe('missing');
        expect(inspection.canonicalPath).toBe(requestedPath);

        await expect(
          confirmCodeProWorkspace(
            {
              normalizedPath: inspection.normalizedPath,
              expectedState: 'missing',
              expectedIdentity: inspection.normalizedIdentity,
            },
            {
              mkdir: async (directory, options) => {
                await fs.rename(reviewedAncestor, preservedAncestor);
                await fs.symlink(changedAncestor, reviewedAncestor, 'junction');
                return fs.mkdir(directory, options);
              },
            }
          )
        ).rejects.toThrow('Missing workspaces require an atomic workspace lease');
        await expect(fs.stat(path.join(changedParent, 'new-app'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  );

  it('reuses an existing directory without writing to it', async () => {
    const mkdir = vi.fn();
    const result = await confirmCodeProWorkspace(
      {
        normalizedPath: 'E:\\Existing\\App',
        expectedState: 'empty-directory',
        expectedIdentity: 'e:\\existing\\app',
      },
      {
        stat: vi.fn().mockResolvedValue(directoryStat),
        readdir: vi.fn().mockResolvedValue([]),
        realpath: vi.fn().mockResolvedValue('E:\\Existing\\App'),
        mkdir,
      }
    );

    expect(result.created).toBe(false);
    expect(result.workingDir).toBe('E:\\Existing\\App');
    expect(mkdir).not.toHaveBeenCalled();
  });

  it.each([
    ['D:\\', directoryStat, 'filesystem root'],
    ['D:\\payload.txt', fileStat, 'not a directory'],
  ] as const)('rejects unsafe confirmation target %s', async (candidate, stats, message) => {
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: candidate,
          expectedState: 'empty-directory',
          expectedIdentity: candidate.toLowerCase(),
        },
        {
          stat: vi.fn().mockResolvedValue(stats),
          readdir: vi.fn(),
          realpath: vi.fn().mockResolvedValue(candidate),
          mkdir: vi.fn(),
        }
      )
    ).rejects.toThrow(message);
  });

  it('rejects a missing candidate that appeared after inspection without writing', async () => {
    const mkdir = vi.fn();

    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'D:\\Changed\\App',
          expectedState: 'missing',
          expectedIdentity: 'd:\\changed\\app',
        },
        {
          stat: vi.fn().mockResolvedValue(directoryStat),
          readdir: vi.fn().mockResolvedValue([]),
          realpath: vi.fn().mockResolvedValue('D:\\Changed\\App'),
          mkdir,
        }
      )
    ).rejects.toThrow('Workspace changed since inspection');
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('rejects an existing candidate that disappeared after inspection without recreating it', async () => {
    const mkdir = vi.fn();

    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'E:\\Changed\\App',
          expectedState: 'non-empty-directory',
          expectedIdentity: 'e:\\changed\\app',
        },
        {
          stat: vi.fn().mockRejectedValue(fileSystemError('ENOENT')),
          readdir: vi.fn(),
          realpath: vi.fn(),
          mkdir,
        }
      )
    ).rejects.toThrow('Workspace changed since inspection');
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('rejects an empty candidate that gained files after inspection', async () => {
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'E:\\Changed\\App',
          expectedState: 'empty-directory',
          expectedIdentity: 'e:\\changed\\app',
        },
        {
          stat: vi.fn().mockResolvedValue(directoryStat),
          readdir: vi.fn().mockResolvedValue(['new-file.txt']),
          realpath: vi.fn().mockResolvedValue('E:\\Changed\\App'),
          mkdir: vi.fn(),
        }
      )
    ).rejects.toThrow('Workspace changed since inspection');
  });

  it('rejects an existing junction if its canonical target changed after inspection', async () => {
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'D:\\Reviewed\\App',
          expectedState: 'empty-directory',
          expectedIdentity: 'd:\\reviewed-target\\app',
        },
        {
          stat: vi.fn().mockResolvedValue(directoryStat),
          readdir: vi.fn().mockResolvedValue([]),
          realpath: vi.fn().mockResolvedValue('D:\\Different-Target\\App'),
          mkdir: vi.fn(),
        }
      )
    ).rejects.toThrow('Workspace changed since inspection');
  });

  it('requires the inspected canonical identity for an existing directory', async () => {
    await expect(
      confirmCodeProWorkspace(
        {
          normalizedPath: 'D:\\Reviewed\\App',
          expectedState: 'empty-directory',
          expectedIdentity: null as never,
        },
        {
          stat: vi.fn().mockResolvedValue(directoryStat),
          readdir: vi.fn().mockResolvedValue([]),
          realpath: vi.fn().mockResolvedValue('D:\\Reviewed\\App'),
          mkdir: vi.fn(),
        }
      )
    ).rejects.toThrow('Workspace identity is required');
  });
});

describe('isFilesystemRoot', () => {
  it('recognizes Windows drive roots without treating normal project folders as roots', () => {
    expect(isFilesystemRoot('D:\\')).toBe(true);
    expect(isFilesystemRoot('D:/')).toBe(true);
    expect(isFilesystemRoot('D:\\CodeProCp01\\todo-app')).toBe(false);
  });

  it('recognizes a UNC share root without rejecting a child project', () => {
    expect(isFilesystemRoot('\\\\server\\share\\')).toBe(true);
    expect(isFilesystemRoot('\\\\server\\share\\project')).toBe(false);
  });
});
