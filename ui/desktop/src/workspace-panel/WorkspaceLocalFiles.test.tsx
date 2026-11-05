import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceLocalFiles } from './WorkspaceLocalFiles';
import type { PanelRequest } from './workspacePanelTypes';

vi.mock('./dshDocumentRenderer', () => ({
  loadDshDocumentRenderer: vi.fn().mockResolvedValue({}),
  DshDocumentRenderer: () => <div>Document preview</div>,
}));

it('browses a selected directory, previews a file and returns without invoking writes', async () => {
  const original = window.electron.workspacePanel;
  const scope = { sessionId: 'desktop-files:test', root: 'C:/picked' };
  const ipc = vi.fn(async (request: PanelRequest) =>
    request.action === 'list'
      ? {
          entries:
            request.path === ''
              ? [{ name: 'sub', path: 'sub', kind: 'directory' }]
              : request.path === 'sub'
                ? [{ name: 'deep', path: 'sub/deep', kind: 'directory' }]
                : [{ name: 'note.txt', path: 'sub/deep/note.txt', kind: 'file' }],
        }
      : { document: { path: 'sub/note.txt', content: 'Acceptance contents', version: '1' } }
  );
  window.electron.workspacePanel = ipc as typeof original;
  try {
    render(
      <WorkspaceLocalFiles selection={{ scope, kind: 'directory', path: '', name: 'picked' }} />,
      { wrapper: IntlTestWrapper }
    );
    await screen.findByRole('button', { name: 'sub' });
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(await screen.findByRole('button', { name: 'sub' }));
    fireEvent.click(await screen.findByRole('button', { name: 'deep' }));
    fireEvent.click(await screen.findByRole('button', { name: 'note.txt' }));
    expect(await screen.findByText('Acceptance contents')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to folder' }));
    expect(await screen.findByRole('button', { name: 'note.txt' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to folder' }));
    expect(await screen.findByRole('button', { name: 'deep' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to folder' }));
    expect(await screen.findByRole('button', { name: 'sub' })).toBeInTheDocument();
    expect(
      ipc.mock.calls.every(
        ([request]) => request.scope === scope && ['list', 'read'].includes(request.action)
      )
    ).toBe(true);
  } finally {
    cleanup();
    window.electron.workspacePanel = original;
  }
});

it('shows only one open and refresh toolbar for a local document', async () => {
  const original = window.electron.workspacePanel;
  window.electron.workspacePanel = vi.fn().mockResolvedValue({
    documentPreview: { kind: 'pdf', data: new Uint8Array([1]), missingFonts: [] },
  });
  try {
    render(
      <WorkspaceLocalFiles
        selection={{
          scope: { sessionId: 'local-document-toolbar', root: 'C:/picked' },
          kind: 'file',
          path: 'report.pdf',
          name: 'report.pdf',
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByText('Document preview')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Open with' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Refresh' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Reload file from disk' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Document preview')).toBeVisible();
  } finally {
    cleanup();
    window.electron.workspacePanel = original;
  }
});

it('ignores stale folder results after switching to another selection', async () => {
  const original = window.electron.workspacePanel;
  let resolveOld!: (reply: {
    entries: Array<{ name: string; path: string; kind: 'file' }>;
  }) => void;
  window.electron.workspacePanel = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValue({ entries: [{ name: 'new.txt', path: 'new.txt', kind: 'file' }] });
  try {
    const { rerender } = render(
      <WorkspaceLocalFiles
        selection={{
          scope: { sessionId: 'desktop-files:old', root: 'C:/old' },
          kind: 'directory',
          path: '',
          name: 'old',
        }}
      />,
      { wrapper: IntlTestWrapper }
    );
    rerender(
      <WorkspaceLocalFiles
        selection={{
          scope: { sessionId: 'desktop-files:new', root: 'C:/new' },
          kind: 'directory',
          path: '',
          name: 'new',
        }}
      />
    );
    expect(await screen.findByRole('button', { name: 'new.txt' })).toBeInTheDocument();
    resolveOld({ entries: [{ name: 'stale.txt', path: 'stale.txt', kind: 'file' }] });
    await waitFor(() => expect(screen.queryByText('stale.txt')).not.toBeInTheDocument());
  } finally {
    cleanup();
    window.electron.workspacePanel = original;
  }
});
