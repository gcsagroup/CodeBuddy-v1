import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { generatedMediaPaths, GeneratedMediaFiles } from './GeneratedMedia';
import type { ToolResponseMessageContent } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { PanelReply, PanelRequest } from '../workspace-panel/workspacePanelTypes';

vi.mock('../acp/chatSessionStore', () => ({
  useAcpChatSessionSnapshot: () => ({
    session: { working_dir: 'D:/media-fixture', extension_data: { workspaceBinding: 'bound' } },
  }),
}));

it('uses completed image/video receipts, including persisted text receipts, without trusting prose or URLs', () => {
  const receipt = {
    status: 'completed',
    videos: [{ path: 'generated-videos/1.mp4', preview_url: 'http://server/view' }],
  };
  const response: ToolResponseMessageContent = {
    type: 'toolResponse',
    id: 'one',
    toolResult: {
      status: 'success',
      value: { content: [{ type: 'text', text: JSON.stringify(receipt) }] },
    },
  };
  expect(generatedMediaPaths('generate_video', response)).toEqual(['generated-videos/1.mp4']);
  expect(generatedMediaPaths('pwsh', response)).toEqual([]);
  response.toolResult.value = { structuredContent: { ...receipt, status: 'running' } };
  expect(generatedMediaPaths('generate_video', response)).toEqual([]);
  response.toolResult.value = {
    structuredContent: { status: 'completed', images: [{ path: 'photo.png' }] },
  };
  expect(generatedMediaPaths('generate_image', response)).toEqual(['photo.png']);
  response.toolResult.value = { isError: true, structuredContent: receipt };
  expect(generatedMediaPaths('generate_video', response)).toEqual([]);
});

it('keeps all 16 results accessible in one gallery and retains selection when another result arrives', async () => {
  const oldInspect = window.electron.workspacePanel;
  window.electron.workspacePanel = vi.fn(
    async (request: PanelRequest): Promise<PanelReply> => ({
      file: {
        path: 'path' in request ? request.path : '',
        size: 1,
        openExternally: true,
        media: {
          kind: 'image',
          mimeType: 'image/png',
          url: 'workspace-media://' + ('path' in request ? request.path : ''),
        },
      },
    })
  );
  try {
    const paths = Array.from({ length: 16 }, (_, i) => `generated-images/${i}.png`);
    const view = render(<GeneratedMediaFiles sessionId="many" paths={paths} inline />, {
      wrapper: IntlTestWrapper,
    });
    expect(await screen.findByRole('button', { name: '16: 15.png' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous media' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '16: 15.png' }));
    expect(screen.getByRole('img', { name: '15.png' })).toHaveAttribute(
      'src',
      'workspace-media://generated-images/15.png'
    );
    expect(screen.getByRole('button', { name: 'Next media' })).toBeDisabled();
    view.rerender(
      <GeneratedMediaFiles sessionId="many" paths={[...paths, 'generated-images/16.png']} inline />
    );
    expect(screen.getByRole('img', { name: '15.png' })).toBeVisible();
    await screen.findByRole('button', { name: '17: 16.png' });
    expect(screen.getByRole('img', { name: '15.png' })).toBeVisible();
    expect(view.container.querySelectorAll('.media-gallery')).toHaveLength(1);
    expect(view.container.querySelectorAll('.media-output')).toHaveLength(1);
    expect(window.electron.workspacePanel).toHaveBeenCalledTimes(17);
  } finally {
    window.electron.workspacePanel = oldInspect;
  }
});

it('mounts one video player, pauses it on selection changes and does not preload other videos', async () => {
  const oldInspect = window.electron.workspacePanel;
  const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  window.electron.workspacePanel = vi.fn(
    async (request: PanelRequest): Promise<PanelReply> => ({
      file: {
        path: 'path' in request ? request.path : '',
        size: 1,
        openExternally: true,
        media: {
          kind: 'video',
          mimeType: 'video/mp4',
          url: 'workspace-media://' + ('path' in request ? request.path : ''),
        },
      },
    })
  );
  try {
    const paths = ['one.mp4', 'two.mp4', 'three.mp4'];
    const view = render(<GeneratedMediaFiles sessionId="videos" paths={paths} inline />, {
      wrapper: IntlTestWrapper,
    });
    await screen.findByRole('button', { name: '3: three.mp4' });
    expect(view.container.querySelectorAll('video')).toHaveLength(1);
    expect(view.container.querySelector('video')).not.toHaveAttribute('autoplay');
    fireEvent.click(screen.getByRole('button', { name: 'Next media' }));
    await waitFor(() =>
      expect(view.container.querySelector('video')).toHaveAttribute(
        'src',
        'workspace-media://two.mp4'
      )
    );
    expect(pause).toHaveBeenCalled();
    expect(view.container.querySelectorAll('video')).toHaveLength(1);
    view.unmount();
  } finally {
    window.electron.workspacePanel = oldInspect;
    pause.mockRestore();
  }
});

it('keeps verified primary media stable during unrelated renders and rebinds changed output paths', async () => {
  const inspect = vi.fn<(request: PanelRequest) => Promise<PanelReply>>(async (request) => ({
    file: {
      path: 'path' in request ? request.path : '',
      size: 3505445,
      openExternally: true,
      media: {
        kind: 'image',
        mimeType: 'image/png',
        url: 'workspace-media://' + ('path' in request ? request.path : ''),
      },
    },
  }));
  const oldInspect = window.electron.workspacePanel;
  window.electron.workspacePanel = inspect;
  const opened = vi.fn();
  window.addEventListener('codebuddy:open-workspace-file', opened);
  try {
    const first = 'generated-images/job-one/1.png';
    const second = 'generated-images/job-two/1.png';
    const view = render(<GeneratedMediaFiles sessionId="media" paths={[first]} inline />, {
      wrapper: IntlTestWrapper,
    });
    expect(await screen.findByRole('img', { name: '1.png' })).toHaveAttribute(
      'src',
      'workspace-media://' + first
    );
    for (let i = 0; i < 3; i++) {
      view.rerender(<GeneratedMediaFiles sessionId="media" paths={[first]} inline />);
      await act(async () => {});
    }
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(view.container).not.toHaveTextContent('Related files');
    expect(view.container).not.toHaveTextContent('3,505,445');
    view.rerender(<GeneratedMediaFiles sessionId="media" paths={[second]} inline />);
    expect(await screen.findByRole('img', { name: '1.png' })).toHaveAttribute(
      'src',
      'workspace-media://' + second
    );
    fireEvent.click(screen.getByRole('button', { name: '1.png' }));
    expect(opened.mock.calls[0][0].detail).toEqual({ sessionId: 'media', filePath: second });
    expect(inspect).toHaveBeenCalledTimes(2);
  } finally {
    window.electron.workspacePanel = oldInspect;
    window.removeEventListener('codebuddy:open-workspace-file', opened);
  }
});
