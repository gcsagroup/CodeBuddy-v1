import { act, fireEvent, render as testingRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveProjectAlias } from '../../utils/projectAliases';
import { MediaLibrary } from './MediaLibrary';
import { IntlTestWrapper } from '../../i18n/test-utils';

const { request, navigate } = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn() }));
vi.mock('../../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod: request }) }));
vi.mock('../../hooks/useNavigation', () => ({ useNavigation: () => navigate }));
vi.mock('../../workspace-panel/WorkspaceGeneration', () => ({ mediaText: (en: string) => en }));

function render(element: ReactElement) {
  return testingRender(element, { wrapper: IntlTestWrapper });
}
const workspacePanel = vi.fn();
const observers: Array<() => void> = [];

const asset = {
  id: 'session:job:0', sessionId: 'session', sessionName: 'My conversation', root: 'C:/project',
  path: 'C:/project/generated-images/job/1.png', filename: '1.png', kind: 'image',
  available: false, createdAt: '2026-10-29T00:00:00.000Z', prompt: 'Mountain image',
};
const page = { items: [asset], projects: ['C:/project'], total: 1, unreadableRecords: 0, nextCursor: null };

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  localStorage.clear();
  request.mockReset();
  navigate.mockReset();
  workspacePanel.mockReset();
  observers.length = 0;
  window.electron.workspacePanel = workspacePanel;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      observers.push(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('media library', () => {
  it('shows full sizes, switches to workspace grouping, and keeps deletion behind confirmation', async () => {
    const sized = { ...page, totalBytes: 2048, libraryCount: 2, libraryBytes: 4096, projectStats: [{ root: asset.root, count: 1, sizeBytes: 2048 }], items: [{ ...asset, sizeBytes: 2048 }] };
    request.mockResolvedValue(sized);
    render(<MediaLibrary />);
    await screen.findByText('Mountain image');
    expect(screen.getByTestId('library-summary')).toHaveTextContent('4.0 KB');
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'workspace' } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('_codebuddy/media/library', { kind: 'all', project: '', search: '', cursor: '', view: 'workspace' }));
    expect(await screen.findByRole('region', { name: 'project' })).toHaveTextContent('2.0 KB');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('article', { name: 'Media: Mountain image' }), { key: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('This cannot be undone');
    expect(request.mock.calls.some(([method]) => method === '_codebuddy/media/delete')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    request.mockResolvedValueOnce({ results: [{ id: asset.id, deleted: true }] }).mockResolvedValue({ ...sized, items: [], total: 0, totalBytes: 0, libraryBytes: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('_codebuddy/media/delete', { ids: [asset.id], confirm: true }));
    expect(await screen.findByText('Deleted 1')).toBeVisible();
    expect(screen.queryByText('Mountain image')).not.toBeInTheDocument();
  });

  it('clears stale selections on filter changes and reports per-item deletion failures', async () => {
    request.mockResolvedValue(page);
    render(<MediaLibrary />);
    await screen.findByText('Mountain image');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('article', { name: 'Media: Mountain image' }), { key: ' ' });
    fireEvent.change(screen.getByLabelText('Media type'), { target: { value: 'image' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument());
    await screen.findByText('Mountain image');
    fireEvent.keyDown(screen.getByRole('article', { name: 'Media: Mountain image' }), { key: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('article', { name: 'Media: Mountain image' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Delete selected/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    request.mockResolvedValueOnce({ results: [{ id: asset.id, deleted: false, error: 'File is in use' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
    expect(await screen.findByText(/Deleted 0 · Failed 1/)).toHaveTextContent('1.png — File is in use');
    expect(await screen.findByText('Mountain image')).toBeVisible();
  });
  it('selects unloaded media across pages and follows sidebar workspace renames', async () => {
    const all = Array.from({ length: 502 }, (_, index) => ({ ...asset, id: String(index), prompt: 'Media ' + index }));
    const result = { ...page, items: all.slice(0, 48), total: 502, libraryCount: 502, nextCursor: 'next', projectStats: [{ root: asset.root, count: 502, sizeBytes: 1024 }] };
    request.mockImplementation(async (method, query) => method === '_codebuddy/media/delete' ? { results: query.ids.map((id: string) => ({ id, deleted: true })) } : query.all ? { ...result, items: all, nextCursor: null } : result);
    render(<MediaLibrary />);
    await screen.findByText('Media 0');
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'workspace' } });
    await screen.findByRole('heading', { name: 'project' });
    act(() => { saveProjectAlias(asset.root, 'My studio', 'project'); });
    expect(screen.getByRole('heading', { name: 'My studio' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('article', { name: 'Media: Media 0' }), { key: ' ' });
    const group = screen.getByRole('button', { name: 'Select workspace My studio' });
    expect(group).toHaveTextContent('+');
    expect(group).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(group);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete selected (502)' })).toBeEnabled());
    expect(group).toHaveTextContent('−');
    expect(group).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(group);
    expect(screen.getByRole('button', { name: 'Delete selected (0)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete selected (502)' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (502)' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Media 501');
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('_codebuddy/media/delete', { ids: all.slice(500).map(item => item.id), confirm: true }));
    expect(request).toHaveBeenCalledWith('_codebuddy/media/delete', { ids: all.slice(0, 500).map(item => item.id), confirm: true });
  });

  it('toggles complete workspace selection without optional statistics and preserves other groups', async () => {
    const other = { ...asset, id: 'other', root: 'C:/other', prompt: 'Other image' };
    request.mockImplementation(async (_method, query) => query.all ? page : { ...page, items: [asset, other], total: 2 });
    render(<MediaLibrary />);
    await screen.findByText('Mountain image');
    expect(screen.getByTestId('library-summary')).toHaveTextContent('Restart the app');
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'workspace' } });
    await screen.findByRole('heading', { name: 'project' });
    fireEvent.keyDown(screen.getByRole('article', { name: 'Media: Other image' }), { key: ' ' });
    const group = screen.getByRole('button', { name: 'Select workspace project' });
    expect(group).toHaveTextContent('+');
    fireEvent.click(group);
    await waitFor(() => expect(group).toHaveAttribute('aria-pressed', 'true'));
    expect(group).toHaveTextContent('−');
    fireEvent.click(group);
    expect(group).toHaveTextContent('+');
    expect(screen.getByRole('checkbox', { name: 'Select Mountain image' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Other image' })).toBeChecked();
  });

  it('keeps missing assets visible and opens their source conversation', async () => {
    request.mockResolvedValue(page);
    render(<MediaLibrary />);
    expect(await screen.findByText('Mountain image')).toBeVisible();
    expect(screen.getByText('File unavailable. It may have been moved or deleted.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show in folder' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Source chat' }));
    expect(navigate).toHaveBeenCalledWith('pair', { resumeSessionId: 'session' });
  });

  it('filters across projects and replaces the previous result', async () => {
    request.mockResolvedValueOnce(page).mockResolvedValue({ ...page, items: [], total: 0 });
    render(<MediaLibrary />);
    await screen.findByText('Mountain image');
    fireEvent.change(screen.getByLabelText('Media type'), { target: { value: 'video' } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('_codebuddy/media/library', {
      kind: 'video', project: '', search: '', cursor: '',
    }));
    expect(await screen.findByText(/No matching media/)).toBeVisible();
    expect(screen.queryByText('Mountain image')).not.toBeInTheDocument();
  });

  it('appends paginated results and shows retry on request failure', async () => {
    request.mockResolvedValueOnce({ ...page, total: 2, nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce({ ...page, total: 2, items: [{ ...asset, id: 'second', prompt: 'Second image' }] });
    render(<MediaLibrary />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load media');
    expect(screen.getByText('Mountain image')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second image')).toBeVisible();
    expect(screen.getByText('Mountain image')).toBeVisible();
  });

  it('combines project and search filters', async () => {
    request.mockResolvedValue(page);
    render(<MediaLibrary />);
    await screen.findByText('Mountain image');
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'C:/project' } });
    fireEvent.change(screen.getByLabelText('Search media'), { target: { value: 'Mountain' } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith('_codebuddy/media/library', {
      kind: 'all', project: 'C:/project', search: 'Mountain', cursor: '',
    }));
  });

  it('does not let an older response replace the selected filter results', async () => {
    let resolveOld!: (value: typeof page) => void;
    request.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ ...page, items: [], total: 0 });
    render(<MediaLibrary />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Media type'), { target: { value: 'video' } });
    await screen.findByText(/No matching media/);
    await act(async () => resolveOld(page));
    expect(screen.queryByText('Mountain image')).not.toBeInTheDocument();
    expect(screen.getByText(/No matching media/)).toBeVisible();
  });

  it.each(['image', 'video'] as const)('loads a %s preview using its source session and project', async kind => {
    const availableAsset = { ...asset, kind, available: true };
    const media = { kind, mimeType: kind === 'image' ? 'image/png' : 'video/mp4', url: 'https://fixture.invalid/media' };
    request.mockResolvedValue({ ...page, items: [availableAsset] });
    workspacePanel.mockResolvedValue({ document: { media } });
    render(<MediaLibrary />);
    await screen.findByText('Mountain image');
    expect(workspacePanel).not.toHaveBeenCalled();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    act(() => observers.forEach(visible => visible()));
    await waitFor(() => expect(workspacePanel).toHaveBeenCalledWith({
      scope: { sessionId: asset.sessionId, root: asset.root }, action: 'read', path: asset.path,
    }));
    if (kind === 'image') {
      expect(await screen.findByRole('img', { name: 'Mountain image' })).toHaveAttribute('src', media.url);
    } else {
      const video = await screen.findByLabelText('Mountain image');
      expect(video.tagName).toBe('VIDEO');
      expect(video).toHaveAttribute('controls');
      expect(video).toHaveAttribute('src', media.url);
    }
    workspacePanel.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    await waitFor(() => expect(workspacePanel).toHaveBeenLastCalledWith({
      scope: { sessionId: asset.sessionId, root: asset.root }, action: 'reveal', path: asset.path,
    }));
  });

  it('reports preview and file-location failures without losing the source link', async () => {
    request.mockResolvedValue({ ...page, items: [{ ...asset, available: true }] });
    workspacePanel.mockRejectedValue(new Error('file unavailable'));
    render(<MediaLibrary />);
    await screen.findByText('Mountain image');
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    act(() => observers.forEach(visible => visible()));
    expect(await screen.findByText('File unavailable. It may have been moved or deleted.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the file location');
    expect(screen.getByRole('button', { name: 'Source chat' })).toBeEnabled();
  });
});
