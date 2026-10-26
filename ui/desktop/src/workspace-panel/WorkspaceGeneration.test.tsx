import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { WorkspaceGeneration, type MediaJob } from './WorkspaceGeneration';
const scope = { sessionId: 'session-a', root: 'D:/fixture' };
it('shows local animation with real progress, ignores legacy frames, and opens completed video', async () => {
  const job: MediaJob = {
    job_id: 'job-a',
    kind: 'video',
    created_at: new Date().toISOString(),
    status: 'running',
    live: {
      connected: true,
      node: '140:125',
      stage: 'sample',
      step: 7,
      total: 20,
      ...{ preview: 'data:image/png;base64,aGVsbG8=' },
    },
  };
  window.electron.workspacePanel = vi.fn().mockResolvedValue({
    document: {
      path: 'clip.mp4',
      media: { kind: 'video', mimeType: 'video/mp4', url: 'codebuddy-media://preview/token' },
    },
  });
  const view = render(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected={false} />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.getByText('Sampling')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByTestId('generation-wait')).toBeInTheDocument();
  expect(window.electron.workspacePanel).not.toHaveBeenCalled();
  view.rerender(
    <WorkspaceGeneration
      scope={scope}
      jobs={[{ ...job, status: 'completed', videos: [{ path: 'clip.mp4' }] }]}
      disconnected={false}
    />
  );
  await waitFor(() => expect(view.container.querySelector('video')).toHaveAttribute('controls'));
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByTestId('generation-wait')).toBeNull();
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
  expect(screen.queryByTestId('generation-wait')).toBeNull();
  expect(screen.getByText('Connection interrupted. Retrying…')).toBeInTheDocument();
});

it('shows the same animation for images without invented progress and replaces it with the final image', async () => {
  const job: MediaJob = {
    job_id: 'image-a',
    kind: 'image',
    created_at: new Date().toISOString(),
    status: 'queued',
    live: { connected: true },
  };
  window.electron.workspacePanel = vi
    .fn()
    .mockResolvedValue({
      document: {
        media: { kind: 'image', mimeType: 'image/png', url: 'codebuddy-media://preview/image' },
      },
    });
  const view = render(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected={false} />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.getByTestId('generation-wait')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByText('Please wait')).toBeInTheDocument();
  view.rerender(
    <WorkspaceGeneration
      scope={scope}
      jobs={[{ ...job, status: 'cancelled' }]}
      disconnected={false}
    />
  );
  expect(screen.queryByTestId('generation-wait')).toBeNull();
  view.rerender(
    <WorkspaceGeneration
      scope={scope}
      jobs={[{ ...job, status: 'completed', images: [{ path: 'result.png' }] }]}
      disconnected={false}
    />
  );
  await waitFor(() =>
    expect(screen.getByRole('img')).toHaveAttribute('src', 'codebuddy-media://preview/image')
  );
  expect(screen.queryByTestId('generation-wait')).toBeNull();
});
