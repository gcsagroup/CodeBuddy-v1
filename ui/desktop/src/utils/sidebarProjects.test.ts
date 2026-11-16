import { beforeEach, describe, expect, it } from 'vitest';
import { readSidebarProjects, rememberSidebarProjects, retainSidebarProjects, setSidebarProjectVisible } from './sidebarProjects';
import type { ProjectGroup } from './projectSessions';
beforeEach(() => localStorage.clear());
const group: ProjectGroup = { path: 'D:/project', label: 'project', sessions: [{ id: 'chat' } as ProjectGroup['sessions'][number]], lastActivityAt: '' };
describe('sidebar project lifetime', () => {
  it('retains an empty project after its final chat leaves and after rereading storage', () => {
    rememberSidebarProjects([group.path]);
    expect(retainSidebarProjects([], readSidebarProjects()).projects).toEqual([{ ...group, sessions: [] }]);
    expect(JSON.parse(localStorage.getItem('codebuddy.sidebarProjects.v1')!)).toEqual([{ path: group.path }]);
  });
  it('removal hides the project while keeping its chats accessible, without mutating their directory', () => {
    rememberSidebarProjects([group.path]); setSidebarProjectVisible(group.path, false);
    rememberSidebarProjects([group.path]);
    const result = retainSidebarProjects([group], readSidebarProjects());
    expect(result.projects).toEqual([]); expect(result.hiddenSessions).toEqual(group.sessions);
    expect(group.sessions).toHaveLength(1);
    setSidebarProjectVisible(group.path, true);
    expect(retainSidebarProjects([group], readSidebarProjects()).projects).toEqual([group]);
  });
  it('ignores corrupted saved entries and deduplicates Windows paths', () => {
    localStorage.setItem('codebuddy.sidebarProjects.v1', '[null, {"path": 3}]');
    expect(readSidebarProjects()).toEqual([]);
    rememberSidebarProjects(['D:/project', 'd:\\project']);
    expect(readSidebarProjects()).toHaveLength(1);
  });
});
