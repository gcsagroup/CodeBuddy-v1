import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceFileReferences } from './WorkspaceFileReferences';
import { CodeProConversationFiles } from './codepro/CodeProConversationFiles';
import type { Message } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { PanelReply, PanelRequest } from '../workspace-panel/workspacePanelTypes';

vi.mock('../acp/chatSessionStore', () => ({
  useAcpChatSessionSnapshot: () => ({
    session: { working_dir: 'D:\\fixture', extension_data: { workspaceBinding: 'bound' } },
  }),
}));
const inspect = vi.fn<(request: PanelRequest) => Promise<PanelReply>>();
beforeEach(() => {
  inspect.mockReset();
  Object.assign(window.electron, { workspacePanel: inspect });
});

it('lists only existing workspace references and opens the exact verified path in the sidebar', async () => {
  inspect.mockImplementation(async (request) => {
    if (!('path' in request) || request.path !== 'titanic_filtered.csv')
      throw new Error('missing or outside');
    return { file: { path: request.path, size: 8251, openExternally: false } };
  });
  const opened = vi.fn();
  window.addEventListener('codebuddy:open-workspace-file', opened);
  try {
    render(
      <WorkspaceFileReferences
        sessionId="one"
        content={
          'Saved `titanic_filtered.csv`, `missing.docx`, and `../outside.docx`.\n```py\n`not-a-file.py`\n```'
        }
      />,
      { wrapper: IntlTestWrapper }
    );
    fireEvent.click(await screen.findByRole('button', { name: /titanic_filtered.csv/ }));
    expect(opened.mock.calls[0][0].detail).toEqual({
      sessionId: 'one',
      filePath: 'titanic_filtered.csv',
    });
    expect(screen.queryByRole('button', { name: /missing.docx/ })).toBeNull();
    expect(
      inspect.mock.calls.some(([request]) => 'path' in request && request.path === 'not-a-file.py')
    ).toBe(false);
  } finally {
    window.removeEventListener('codebuddy:open-workspace-file', opened);
  }
});

it('discards late verification after switching conversations', async () => {
  let oldResult!: (value: PanelReply) => void;
  inspect.mockImplementation((request) =>
    request.scope.sessionId === 'old'
      ? new Promise((resolve) => {
          oldResult = resolve;
        })
      : Promise.resolve({ file: { path: 'new.csv', size: 3, openExternally: false } })
  );
  const view = render(<WorkspaceFileReferences sessionId="old" content={'`old.docx`'} />, {
    wrapper: IntlTestWrapper,
  });
  await waitFor(() => expect(inspect).toHaveBeenCalled());
  view.rerender(<WorkspaceFileReferences sessionId="new" content={'`new.csv`'} />);
  expect(await screen.findByRole('button', { name: /new.csv/ })).toBeVisible();
  await act(async () => oldResult({ file: { path: 'old.docx', size: 3, openExternally: true } }));
  expect(screen.queryByRole('button', { name: /old.docx/ })).toBeNull();
});

it('omits files already covered by the recorded changes card, keeping unrelated references', async () => {
  inspect.mockImplementation(async (request) => ({
    file: { path: 'path' in request ? request.path : '', size: 3, openExternally: false },
  }));
  render(
    <WorkspaceFileReferences
      sessionId="one"
      content={'`app.py` and `guide.md`'}
      excludePaths={['D:/fixture/app.py']}
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(await screen.findByRole('button', { name: /guide.md/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /app.py/ })).toBeNull();
});

it('remains usable when an older desktop process does not support file inspection', async () => {
  inspect.mockResolvedValue(undefined as unknown as PanelReply);
  const view = render(<WorkspaceFileReferences sessionId="older" content={'`report.docx`'} />, {
    wrapper: IntlTestWrapper,
  });
  await act(async () => {});
  expect(view.container).toBeEmptyDOMElement();
});

it('previews verified local image and video cards and opens them in the same session panel', async () => {
  inspect.mockImplementation(async (request) => ({
    file: {
      path: 'path' in request ? request.path : '',
      size: 3000000,
      openExternally: false,
      media: {
        kind: 'path' in request && request.path.endsWith('.png') ? 'image' : 'video',
        mimeType: 'video/mp4',
        url: 'codebuddy-media://preview/token',
      },
    },
  }));
  const opened = vi.fn();
  window.addEventListener('codebuddy:open-workspace-file', opened);
  try {
    const view = render(
      <WorkspaceFileReferences sessionId="media" content={'`photo.png` and `clip.mp4`'} />,
      { wrapper: IntlTestWrapper }
    );
    expect(await screen.findByAltText('photo.png')).toHaveAttribute(
      'src',
      'codebuddy-media://preview/token'
    );
    fireEvent.click(await screen.findByRole('button', { name: /clip.mp4/ }));
    expect(opened.mock.calls[0][0].detail).toEqual({ sessionId: 'media', filePath: 'clip.mp4' });
    expect(view.container.querySelector('video')).not.toHaveAttribute('autoplay');
    fireEvent.error(view.container.querySelector('video')!);
    expect(screen.getByRole('status')).toHaveTextContent('Media could not be loaded');
  } finally {
    window.removeEventListener('codebuddy:open-workspace-file', opened);
  }
});

it('recognizes a standalone media path in a historical code block and verifies it first', async () => {
  inspect.mockResolvedValue({ file: { path: 'clip.mp4', size: 3, openExternally: false } });
  render(
    <WorkspaceFileReferences sessionId="fenced" content={'```text\nD:/fixture/clip.mp4\n```'} />,
    { wrapper: IntlTestWrapper }
  );
  await screen.findByRole('button', { name: /clip.mp4/ });
  expect(inspect).toHaveBeenCalledWith({
    scope: { sessionId: 'fenced', root: 'D:\\fixture' },
    action: 'inspect',
    path: 'D:/fixture/clip.mp4',
  });
});

const turnMessages: Message[] = [
  {
    id: 'turn',
    role: 'user',
    created: 1,
    metadata: { userVisible: true, agentVisible: true },
    content: [{ type: 'text', text: 'Create a page' }],
  },
  {
    id: 'answer',
    role: 'assistant',
    created: 2,
    metadata: { userVisible: true, agentVisible: true },
    content: [{ type: 'text', text: '`page.html`, `guide.md`, `missing.txt`' }],
  },
];

it('keeps the change card limited to recorded edits even when the answer references other files', async () => {
  inspect.mockImplementation(async (request) => {
    if (!('path' in request) || request.path === 'missing.txt') throw new Error('missing');
    return { file: { path: request.path, size: 20, openExternally: false } };
  });
  const opened = vi.spyOn(window, 'dispatchEvent');
  try {
    render(
      <CodeProConversationFiles
        sessionId="one"
        messages={turnMessages}
        workspaceRoot="D:/fixture"
        sourceChanges={[
          {
            id: 'turn',
            number: 1,
            created: 1,
            title: 'Create a page',
            added: 3,
            removed: 0,
            files: [
              {
                key: 'page',
                path: 'D:/fixture/PAGE.html',
                added: 3,
                removed: 0,
                changes: [],
                hasUnavailableDiff: true,
              },
            ],
          },
        ]}
      />,
      { wrapper: IntlTestWrapper }
    );
    await screen.findByRole('button', { name: 'Modified 1 files this turn' });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Related files' })).toBeNull();
    expect(screen.queryByText('missing.txt')).toBeNull();
    expect(screen.queryByRole('button', { name: 'guide.md' })).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'D:/fixture/PAGE.html' }));
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'codebuddy:open-conversation-change',
        detail: { sessionId: 'one', turnId: 'turn', filePath: 'D:/fixture/PAGE.html' },
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Modified 1 files this turn' }));
    expect(screen.queryByRole('listitem')).toBeNull();
  } finally {
    opened.mockRestore();
  }
});

it('does not create a file card for a reference-only turn', () => {
  inspect.mockResolvedValue({ file: { path: 'guide.md', size: 30, openExternally: false } });
  render(
    <CodeProConversationFiles
      sessionId="one"
      messages={turnMessages}
      sourceChanges={[]}
      workspaceRoot="D:/fixture"
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.queryByRole('button', { name: /files this turn/i })).toBeNull();
  expect(screen.queryByRole('listitem')).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'View changes' })).toBeNull();
  expect(screen.queryByText(/Modified/)).toBeNull();
});
