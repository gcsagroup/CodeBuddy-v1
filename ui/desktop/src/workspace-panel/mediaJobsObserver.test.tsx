import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaJobsProvider, useMediaJobs } from './WorkspaceGeneration';

const { extMethod } = vi.hoisted(() => ({ extMethod: vi.fn() }));
vi.mock('../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod }) }));
const job = (id: string) => ({
  job_id: id,
  kind: 'image',
  status: 'running',
  created_at: '2026-10-28T00:00:00Z',
  live: {},
});
function Probe({ sessionId, name = 'jobs' }: { sessionId: string; name?: string }) {
  const { jobs, disconnected } = useMediaJobs(sessionId);
  return (
    <output aria-label={name}>
      {JSON.stringify({ ids: jobs.map((value) => value.job_id), disconnected })}
    </output>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  extMethod.mockReset();
});
afterEach(() => vi.useRealTimers());

it('shares one non-overlapping observer between conversation and preview and disposes it on unmount', async () => {
  let finish!: (value: unknown) => void;
  extMethod.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const view = render(
    <MediaJobsProvider sessionId="a">
      <Probe sessionId="a" name="chat" />
      <Probe sessionId="a" name="preview" />
    </MediaJobsProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(extMethod).toHaveBeenCalledTimes(1);
  await act(async () => finish({ sessionId: 'a', jobs: [job('same-job')] }));
  expect(screen.getByLabelText('chat')).toHaveTextContent('same-job');
  expect(screen.getByLabelText('preview')).toHaveTextContent('same-job');
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(extMethod).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => finish({ sessionId: 'a', jobs: [] }));
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(extMethod).toHaveBeenCalledTimes(2);
});

it('never exposes the previous session snapshot or its late response after switching sessions', async () => {
  let finishOld!: (value: unknown) => void;
  extMethod
    .mockResolvedValueOnce({ sessionId: 'a', jobs: [job('old-job')] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    )
    .mockResolvedValue({ sessionId: 'b', jobs: [job('new-job')] });
  const view = render(
    <MediaJobsProvider sessionId="a">
      <Probe sessionId="a" />
    </MediaJobsProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByLabelText('jobs')).toHaveTextContent('old-job');
  await act(() => vi.advanceTimersByTimeAsync(2000));
  view.rerender(
    <MediaJobsProvider sessionId="b">
      <Probe sessionId="b" />
      <Probe sessionId="a" name="wrong-session" />
    </MediaJobsProvider>
  );
  expect(screen.getByLabelText('jobs')).not.toHaveTextContent('old-job');
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => finishOld({ sessionId: 'a', jobs: [job('late-old-job')] }));
  expect(screen.getByLabelText('jobs')).toHaveTextContent('new-job');
  expect(screen.getByLabelText('jobs')).not.toHaveTextContent('old-job');
  expect(screen.getByLabelText('wrong-session')).not.toHaveTextContent('new-job');
});

it('retains the last confirmed job with a disconnected flag after an invalid status response', async () => {
  extMethod
    .mockResolvedValueOnce({ sessionId: 'a', jobs: [job('retained-job')] })
    .mockResolvedValue({ sessionId: 'other', jobs: [] });
  render(
    <MediaJobsProvider sessionId="a">
      <Probe sessionId="a" />
    </MediaJobsProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByLabelText('jobs')).toHaveTextContent('retained-job');
  expect(screen.getByLabelText('jobs')).toHaveTextContent('"disconnected":true');
});
