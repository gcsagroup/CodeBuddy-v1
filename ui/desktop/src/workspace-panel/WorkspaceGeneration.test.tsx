import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceGeneration, type MediaJob } from './WorkspaceGeneration';
const scope = { sessionId: 'session-a', root: 'D:/fixture' };
it('shows live node progress and replaces the preview frame with a playable completed file', async () => {
  const job: MediaJob = {
    job_id: 'job-a',
    kind: 'video',
    created_at: new Date().toISOString(),
    status: 'running',
    live: {
      connected: true,
      node: 'sample',
      step: 7,
      total: 20,
      preview: 'data:image/png;base64,aGVsbG8=',
    },
  };
  window.electron.workspacePanel = vi
    .fn()
    .mockResolvedValue({
      document: {
        path: 'clip.mp4',
        media: { kind: 'video', mimeType: 'video/mp4', url: 'codebuddy-media://preview/token' },
      },
    });
  const view = render(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected={false} />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '35');
  expect(screen.getByRole('img')).toHaveAttribute('alt', 'Live generation preview');
  view.rerender(
    <WorkspaceGeneration
      scope={scope}
      jobs={[{ ...job, status: 'completed', videos: [{ path: 'clip.mp4' }] }]}
      disconnected={false}
    />
  );
  await waitFor(() => expect(view.container.querySelector('video')).toHaveAttribute('controls'));
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('img')).toBeNull();
  expect(window.electron.workspacePanel).toHaveBeenCalledWith({
    scope,
    action: 'read',
    path: 'clip.mp4',
  });
  fireEvent.error(view.container.querySelector('video')!);
  expect(screen.getByText(/Media could not be loaded/)).toBeInTheDocument();
});
it('keeps failures visible and shows reconnect without submitting a new job', () => {
  render(
    <WorkspaceGeneration
      scope={scope}
      jobs={[
        {
          job_id: 'failed',
          kind: 'video',
          created_at: new Date().toISOString(),
          status: 'failed',
          error: 'GPU memory',
          live: {},
        },
      ]}
      disconnected
    />,
    { wrapper: IntlTestWrapper }
  );
  expect(screen.getByRole('alert')).toHaveTextContent('GPU memory');
  expect(screen.getByText('Connection interrupted. Retrying…')).toBeInTheDocument();
});
