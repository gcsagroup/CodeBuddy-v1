import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
import { addRecentDir, loadRecentDirs, onRecentDirsChanged } from './recentDirs';

describe('recent-directory menu refresh notifications', () => {
  afterEach(() => {
    if (state.root) rmSync(state.root, { recursive: true, force: true });
  });
  it('publishes the saved list immediately for the first entry, additions and reorder', () => {
    state.root = mkdtempSync(path.join(tmpdir(), 'codebuddy-recent-'));
    const first = path.join(state.root, '项目 甲 [1]');
    const second = path.join(state.root, '项目 乙');
    mkdirSync(first);
    mkdirSync(second);
    const lists: string[][] = [];
    const unsubscribe = onRecentDirsChanged(() => lists.push(loadRecentDirs()));
    try {
      addRecentDir(first);
      addRecentDir(second);
      addRecentDir(first);
      expect(lists).toEqual([[first], [second, first], [first, second]]);
      const file = path.join(state.root, 'file.txt');
      writeFileSync(file, 'fixture');
      addRecentDir(file);
      addRecentDir(path.join(state.root, 'missing'));
      expect(lists).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });
});
