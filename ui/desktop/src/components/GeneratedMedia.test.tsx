import { expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
