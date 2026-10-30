import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializeNewTaskDrafts,
  readNewTaskDraft,
  updateNewTaskDraft,
  clearNewTaskDraft,
  hasDraftStorageError,
} from './newTaskDraft';

describe('draft persistence boundary', () => {
  afterEach(() => {
    delete (window.electron as Partial<typeof window.electron>).newTaskDraft;
  });
  it('hydrates before use, restores attachments, and sends only changed fields', async () => {
    window.electron.newTaskDraft = vi.fn().mockResolvedValue({
      codepro: {
        text: 'saved',
        images: [{ id: 'image', dataUrl: 'data:image/png;base64,YQ==', isLoading: false }],
        files: [],
      },
    });
    await initializeNewTaskDrafts();
    expect(readNewTaskDraft('codepro').images).toHaveLength(1);
    updateNewTaskDraft('codepro', { text: 'edited' });
    updateNewTaskDraft('codepro', { text: 'edited' });
    expect(window.electron.newTaskDraft).toHaveBeenCalledTimes(2);
    expect(window.electron.newTaskDraft).toHaveBeenLastCalledWith({
      action: 'update',
      key: 'codepro',
      patch: { text: 'edited' },
    });
    clearNewTaskDraft('codepro');
    expect(readNewTaskDraft('codepro')).toEqual({});
  });
  it('does not overwrite a corrupt draft after restore failure', async () => {
    window.electron.newTaskDraft = vi.fn().mockRejectedValue(new Error('corrupt'));
    await initializeNewTaskDrafts();
    updateNewTaskDraft('codepro', { text: 'new' });
    expect(window.electron.newTaskDraft).toHaveBeenCalledTimes(1);
    expect(hasDraftStorageError()).toBe(true);
    window.electron.newTaskDraft = vi.fn().mockResolvedValue({});
    await initializeNewTaskDrafts();
  });
  it('does not hide an attachment save error when a later text save succeeds', async () => {
    window.electron.newTaskDraft = vi.fn().mockResolvedValue({});
    await initializeNewTaskDrafts();
    vi.mocked(window.electron.newTaskDraft).mockRejectedValueOnce(new Error('disk'));
    updateNewTaskDraft('codepro', { files: [] });
    await Promise.resolve();
    updateNewTaskDraft('codepro', { text: 'still typing' });
    await Promise.resolve();
    expect(hasDraftStorageError()).toBe(true);
    updateNewTaskDraft('codepro', { files: [] });
    await Promise.resolve();
    expect(hasDraftStorageError()).toBe(false);
  });
});
