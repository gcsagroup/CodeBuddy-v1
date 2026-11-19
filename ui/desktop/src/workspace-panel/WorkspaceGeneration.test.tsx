import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import {
  MediaJobsProvider,
  useMediaJobs,
  WorkspaceGeneration,
  resolveMediaOutput,
  type MediaJob,
} from './WorkspaceGeneration';
const { mediaRequest } = vi.hoisted(() => ({ mediaRequest: vi.fn() }));
vi.mock('../acp/acpConnection', () => ({
  getAcpControlClient: async () => ({ extMethod: mediaRequest }),
}));
const scope = { sessionId: 'session-a', root: 'D:/fixture' };
it('cancels only the selected job and explains an unconfirmed remote cancellation', async () => {
  mediaRequest.mockResolvedValue({ status: 'running', cancellation_confirmed: false });
  const view = render(<WorkspaceGeneration scope={scope} jobs={[{
    job_id: 'job-a', kind: 'video', created_at: new Date().toISOString(), status: 'running', live: {},
  }]} disconnected={false} />, { wrapper: IntlTestWrapper });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));
  await waitFor(() => expect(mediaRequest).toHaveBeenCalledWith('_codebuddy/media/jobs', {
    sessionId: 'session-a', operation: 'cancel', kind: 'video', job_id: 'job-a',
  }));
  expect(await screen.findByText(/Cancellation is not confirmed/)).toBeVisible();
  view.rerender(<WorkspaceGeneration scope={scope} jobs={[{
    job_id: 'job-a', kind: 'video', created_at: new Date().toISOString(), status: 'cancelled', live: {},
  }]} disconnected={false} />);
  expect(screen.queryByText(/Cancellation is not confirmed/)).toBeNull();
  expect(screen.getByText(/Generation cancelled.*cannot resume/)).toBeVisible();
});
it('resolves old remote links only through completed receipts in the selected session', () => {
  const remote = 'http://comfy.test/view?filename=clip.mp4&subfolder=CodeBuddy&type=output';
  const job: MediaJob = {
    job_id: 'clip',
    kind: 'video',
    created_at: '2026-11-06',
    status: 'completed',
    live: {},
    videos: [{ path: 'D:\\workspace\\clip.mp4', preview_url: remote }],
  };
  expect(resolveMediaOutput([job], remote)?.path).toBe('D:\\workspace\\clip.mp4');
  expect(resolveMediaOutput([job], 'D:/workspace/clip.mp4')?.path).toBe(job.videos![0].path);
  expect(resolveMediaOutput([], remote)).toBeUndefined();
  expect(resolveMediaOutput([{ ...job, status: 'running' }], remote)).toBeUndefined();
  expect(resolveMediaOutput([job], remote.replace('comfy.test', 'untrusted.test'))).toBeUndefined();
  expect(resolveMediaOutput([job], 'http://comfy.test/other/clip.mp4')).toBeUndefined();
});
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mediaRequest.mockReset();
});

it('stops stale preview animation without changing the job result and resumes on fresh evidence', () => {
  const job: MediaJob = {
    job_id: 'a',
    kind: 'image',
    created_at: new Date().toISOString(),
    status: 'running',
    live: {},
  };
  const view = render(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected={false} />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.getByTestId('generation-wait')).toBeVisible();
  view.rerender(
    <WorkspaceGeneration
      scope={scope}
      jobs={[{ ...job, observation_error: true }]}
      disconnected={false}
    />
  );
  expect(screen.queryByTestId('generation-wait')).toBeNull();
  expect(screen.getByText('Status unavailable')).toBeVisible();
  view.rerender(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected />);
  expect(screen.queryByTestId('generation-wait')).toBeNull();
  view.rerender(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected={false} />);
  expect(screen.getByTestId('generation-wait')).toBeVisible();
  expect(job.status).toBe('running');
});

it('marks a hung observation disconnected, keeps one request in flight and accepts its later result', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  mediaRequest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const Observer = () => {
    const value = useMediaJobs('session-a');
    return (
      <span data-testid="observed">
        {value.disconnected ? 'unconfirmed' : 'connected'}:{value.jobs[0]?.status}
      </span>
    );
  };
  const view = render(
    <MediaJobsProvider sessionId="session-a">
      <Observer />
    </MediaJobsProvider>
  );
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(11_000));
  expect(screen.getByTestId('observed')).toHaveTextContent('unconfirmed');
  expect(mediaRequest).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      sessionId: 'session-a',
      jobs: [
        {
          job_id: 'a',
          kind: 'image',
          status: 'failed',
          created_at: '2026-10-28T00:00:00Z',
          live: {},
        },
      ],
    })
  );
  expect(screen.getByTestId('observed')).toHaveTextContent('connected:failed');
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mediaRequest).toHaveBeenCalledTimes(1);
});
it('distinguishes image pixels from a file link and routes plain and Ctrl clicks', async () => {
  const opened = vi.fn();
  window.addEventListener('codebuddy:open-workspace-file', opened);
  window.electron.workspacePanel = vi.fn().mockResolvedValue({
    document: {
      path: 'sun.png',
      media: { kind: 'image', mimeType: 'image/png', url: 'codebuddy-media://preview/sun' },
    },
  });
  try {
    render(
      <WorkspaceGeneration
        scope={scope}
        jobs={[
          {
            job_id: 'sun',
            kind: 'image',
            created_at: new Date().toISOString(),
            status: 'completed',
            images: [{ path: 'sun.png' }],
            live: {},
          },
        ]}
        disconnected={false}
      />,
      { wrapper: IntlTestWrapper }
    );
    const image = await screen.findByRole('img');
    fireEvent.contextMenu(image);
    expect(opened.mock.lastCall?.[0].detail).toEqual({
      sessionId: scope.sessionId,
      filePath: 'sun.png',
      action: 'file-menu',
      menuKind: 'image',
    });
    fireEvent.click(image);
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(image, { ctrlKey: true });
    expect(opened.mock.lastCall?.[0].detail.action).toBe('open-external');
  } finally {
    window.removeEventListener('codebuddy:open-workspace-file', opened);
  }
});
it('distinguishes stale progress from failure and clears the notice on progress or disconnection', () => {
  const job: MediaJob = {
    job_id: 'slow-video',
    kind: 'video',
    status: 'running',
    created_at: new Date(Date.now() - 2583000).toISOString(),
    live: { connected: true, stage: 'sample', step: 1, total: 8, updatedAt: Date.now() - 180000 },
  };
  const view = render(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected={false} />, {
    wrapper: IntlTestWrapper,
  });
  expect(screen.getByText(/Elapsed 43 min/)).toBeInTheDocument();
  expect(screen.getByTestId('generation-quiet')).toHaveTextContent('No new progress for 3 min');
  expect(screen.getByRole('status')).toHaveTextContent('Generating');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '13');
  for (const next of [
    { ...job, live: { ...job.live, step: 2, updatedAt: Date.now() } },
    { ...job, observation_error: true },
    { ...job, live: { ...job.live, connected: false } },
    { ...job, status: 'queued' },
    { ...job, live: { connected: true } },
    { ...job, status: 'failed', error: 'GPU error' },
  ]) {
    view.rerender(<WorkspaceGeneration scope={scope} jobs={[next]} disconnected={false} />);
    expect(screen.queryByTestId('generation-quiet')).toBeNull();
  }
  view.rerender(<WorkspaceGeneration scope={scope} jobs={[job]} disconnected />);
  expect(screen.queryByTestId('generation-quiet')).toBeNull();
});
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
  const player = view.container.querySelector('video')!;
  player.pause = vi.fn();
  player.currentTime = 2;
  fireEvent.click(screen.getByRole('button', { name: 'Expand video' }));
  const dialog = screen.getByRole('dialog');
  expect(player.pause).toHaveBeenCalled();
  const expanded = dialog.querySelector('video')!;
  fireEvent.loadedMetadata(expanded);
  expect(expanded.currentTime).toBe(2);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
  expect(
    screen.getByText('Task status is unconfirmed. Waiting for an update…')
  ).toBeInTheDocument();
});

it('shows the same animation for images without invented progress and replaces it with the final image', async () => {
  const job: MediaJob = {
    job_id: 'image-a',
    kind: 'image',
    created_at: new Date().toISOString(),
    status: 'queued',
    live: { connected: true },
  };
  window.electron.workspacePanel = vi.fn().mockResolvedValue({
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
