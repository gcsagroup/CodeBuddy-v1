import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import { MediaJobsProvider, type MediaJob } from '../workspace-panel/WorkspaceGeneration';
import {
  requestAcpPermission,
  cancelAcpPermissionRequestsForSession,
} from '../acp/permissionRequests';
import { collectMediaJobs, mediaJobObservation } from './mediaJobPresentation';
import { MediaTaskRows } from './MediaTaskRows';
import ProgressiveMessageList from './ProgressiveMessageList';

const { extMethod, verifiedFiles } = vi.hoisted(() => ({
  extMethod: vi.fn(),
  verifiedFiles: vi.fn(),
}));
vi.mock('../acp/acpConnection', () => ({ getAcpControlClient: async () => ({ extMethod }) }));
vi.mock('./useWorkspaceFileReferences', () => ({
  useWorkspaceFileReferences: (input: unknown) => verifiedFiles(input),
}));
const sessionId = 'media-display';
const jobA = '6e282e50-fd74-4b4b-b6d5-3dfab00402bd';
const jobB = 'b46621a1-46e9-40c1-ad9a-ed1736a43a0d';
const message = (id: string, role: Message['role'], content: Message['content']): Message => ({
  id,
  role,
  created: 1,
  content,
  metadata: { userVisible: true, agentVisible: true },
});
const request = (id: string, operation = 'generate', jobId = jobA, name = 'generate_image') =>
  message(id, 'assistant', [
    {
      type: 'toolRequest',
      id,
      toolCall: {
        status: 'success',
        value: {
          name,
          arguments: { operation, ...(operation !== 'generate' ? { job_id: jobId } : {}) },
        },
      },
    },
  ]);
const response = (
  id: string,
  jobId = jobA,
  status = 'queued',
  extra: Record<string, unknown> = {}
) =>
  message('result-' + id, 'user', [
    {
      type: 'toolResponse',
      id,
      toolResult: {
        status: 'success',
        value: {
          content: [
            { type: 'text', text: JSON.stringify({ job_id: jobId, status, images: [], ...extra }) },
          ],
        },
      },
    },
  ]);
const current = (jobId: string, status: string, kind: MediaJob['kind'] = 'image'): MediaJob => ({
  job_id: jobId,
  status,
  kind,
  created_at: '2026-10-28T00:00:00Z',
  live: {},
});
const history = (messages: Message[], streaming = false) => (
  <ProgressiveMessageList
    messages={messages}
    chat={{ sessionId }}
    isUserMessage={(item) => item.role === 'user'}
    isStreamingMessage={streaming}
    activeToolCallIds={streaming ? ['poll'] : []}
  />
);
const rows = (messages: Message[], readOnly = false) => (
  <MediaTaskRows
    jobs={[...new Set(collectMediaJobs(messages).values())]}
    sessionId={sessionId}
    readOnly={readOnly}
    renderCall={(call) => <span data-raw-call={call.request.id}>{call.request.id}</span>}
  />
);
const owner = (children: React.ReactNode) => (
  <MediaJobsProvider sessionId={sessionId}>{children}</MediaJobsProvider>
);
beforeEach(() => {
  window.sessionStorage.clear();
  extMethod.mockReset().mockResolvedValue({ sessionId, jobs: [] });
  verifiedFiles.mockReset().mockImplementation(({ paths }: { paths?: string[] }) =>
    (paths ?? []).map((path) => ({
      path,
      size: 3505445,
      openExternally: true,
      media: { kind: 'image', mimeType: 'image/png', url: 'workspace-media://' + path },
    }))
  );
});
afterEach(() => {
  vi.useRealTimers();
  cancelAcpPermissionRequestsForSession(sessionId);
});

describe('media task presentation', () => {
  it('keeps one task for twenty polls, the full 21-call audit, and a primary image outside collapsed details', () => {
    const path = 'generated-images/' + jobA + '/1.png';
    const trace = [
      message('user', 'user', [{ type: 'text', text: 'Generate a sheet.' }]),
      request('submit'),
      response('submit'),
    ];
    for (let i = 1; i <= 20; i++)
      trace.push(
        request('poll-' + i, 'status'),
        response(
          'poll-' + i,
          jobA,
          i === 20 ? 'completed' : 'running',
          i === 20 ? { images: [{ path }] } : {}
        )
      );
    const original = JSON.stringify(trace);
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    expect(view.container.querySelectorAll('[data-media-job-id]')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Image generation Completed');
    expect(screen.getByRole('img', { name: '1.png' })).toBeVisible();
    expect(view.container).not.toHaveTextContent('Related files');
    expect(view.container).not.toHaveTextContent('3,505,445');
    expect(view.container.querySelector('[data-tool-call-id]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Execution records (20 status checks)' }));
    const ids = [...view.container.querySelectorAll('[data-tool-call-id]')].map((node) =>
      node.getAttribute('data-tool-call-id')
    );
    expect(ids).toHaveLength(21);
    expect(new Set(ids).size).toBe(21);
    expect(screen.getAllByRole('img', { name: '1.png' })).toHaveLength(1);
    expect(JSON.stringify(trace)).toBe(original);
  });

  it('keeps the seven real jobs after the screenshot text separate, including their same-named image files', () => {
    const ids = [
      jobA,
      jobB,
      'c3144477-d0b1-4177-905e-aaaec95c2f59',
      'f5551332-ee83-4a44-b957-18bd0d49dd92',
      '0f4650cf-ddef-4280-a8fe-32ee2f9bd4dc',
      'c1c7e5d2-803c-41ec-8236-0bd0a5ace435',
      '46dddb0a-fa54-4f90-aec9-8d28de0645ad',
    ];
    const trace = ids.flatMap((id, i) => [
      request('submit-' + i),
      response('submit-' + i, id),
      request('poll-' + i, 'status', id),
      response('poll-' + i, id, 'completed', {
        images: [{ path: 'generated-images/' + id + '/1.png' }],
      }),
    ]);
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    expect(view.container.querySelectorAll('[data-media-job-id]')).toHaveLength(7);
    expect(
      screen
        .getAllByRole('status')
        .filter((node) => node.textContent?.includes('Image generation Completed'))
    ).toHaveLength(7);
    expect(new Set(screen.getAllByRole('img').map((node) => node.getAttribute('src'))).size).toBe(
      7
    );
  });

  it('does not call a failed generation completed just because both tool calls succeeded', async () => {
    const trace = [
      request('submit'),
      response('submit'),
      request('poll', 'status'),
      response('poll', jobA, 'failed', { error: 'KSampler: dimensions 4096 / 5120' }),
    ];
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    expect(screen.getByRole('status')).toHaveTextContent('Image generation Unsuccessful');
    expect(view.container).not.toHaveTextContent('Completed');
    expect(view.container).not.toHaveTextContent('KSampler');
    expect(screen.getByRole('status')).not.toHaveTextContent('·');
    fireEvent.click(screen.getByRole('button', { name: 'Execution records (1 status checks)' }));
    expect(view.container).toHaveTextContent('KSampler');
  });

  it('stops live activity on disconnect and lets a later completed receipt supersede an old running cache', async () => {
    vi.useFakeTimers();
    const trace = [request('submit'), response('submit', jobA, 'running')];
    extMethod
      .mockResolvedValueOnce({ sessionId, jobs: [current(jobA, 'running')] })
      .mockRejectedValue(Error('Disconnected'));
    const view = render(owner(rows(trace)), { wrapper: IntlTestWrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-media-active="true"]')).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('status')).toHaveTextContent('Status unconfirmed');
    expect(view.container.querySelector('[data-media-active="true"]')).toBeNull();
    view.rerender(
      owner(rows([...trace, request('poll', 'status'), response('poll', jobA, 'completed')]))
    );
    expect(screen.getByRole('status')).toHaveTextContent('Completed');
  });

  it.each([false, true])(
    'never promotes a cached terminal over conflicting history, disconnected=%s',
    (disconnected) => {
      const trace = [
        request('submit'),
        response('submit'),
        request('poll', 'status'),
        response('poll', jobA, 'completed'),
        request('late', 'status'),
        response('late', jobA, 'failed'),
      ];
      const job = collectMediaJobs(trace).get('submit')!;
      expect(
        mediaJobObservation(job, {
          jobs: [{ ...current(jobA, 'completed'), observation_error: !disconnected }],
          disconnected,
        })
      ).toMatchObject({ status: 'unavailable', active: false });
      const cancelled = [
        request('submit'),
        response('submit', jobA, 'cancelled'),
        request('cancel', 'cancel'),
        response('cancel', jobA, 'running', { cancellation_confirmed: false }),
      ];
      expect(
        mediaJobObservation(collectMediaJobs(cancelled).get('submit')!, {
          jobs: [current(jobA, 'cancelled')],
          disconnected,
        })
      ).toMatchObject({ status: 'unavailable', active: false });
      const unconfirmedCancel = [
        request('submit'),
        response('submit'),
        request('cancel', 'cancel'),
        response('cancel', jobA, 'running', { cancellation_confirmed: false }),
      ];
      expect(
        mediaJobObservation(collectMediaJobs(unconfirmedCancel).get('submit')!, {
          jobs: [current(jobA, 'cancelled')],
          disconnected,
        })
      ).toMatchObject({ status: 'unavailable', active: false });
      const oldCancellation = [request('submit'), response('submit', jobA, 'cancelled')];
      expect(
        mediaJobObservation(collectMediaJobs(oldCancellation).get('submit')!, {
          jobs: [current(jobA, 'running')],
          disconnected,
        })
      ).toMatchObject({ status: 'unavailable', active: false });
    }
  );

  it('does not turn a failed query or unconfirmed cancellation into a generation outcome', () => {
    const failed = message('query-error', 'user', [
      { type: 'toolResponse', id: 'poll', toolResult: { status: 'error', error: 'Query failed' } },
    ]);
    const trace = [
      request('submit'),
      response('submit', jobA, 'running'),
      request('poll', 'status'),
      failed,
    ];
    const view = render(rows(trace), { wrapper: IntlTestWrapper });
    expect(screen.getByRole('status')).toHaveTextContent('Status unconfirmed');
    view.rerender(
      rows([
        ...trace,
        request('cancel', 'cancel'),
        response('cancel', jobA, 'running', { cancellation_confirmed: false }),
      ])
    );
    expect(screen.getByRole('status')).toHaveTextContent('Generating');
    expect(view.container).not.toHaveTextContent('Cancelled');
    fireEvent.click(screen.getByRole('button', { name: 'Execution records (1 status checks)' }));
    expect(view.container).toHaveTextContent('Cancellation unconfirmed');
  });

  it('requires a native owner receipt and keeps kind, provider, mismatches and replay identities separate', () => {
    const trace = [
      request('submit'),
      response('submit'),
      request('video', 'generate', jobA, 'generate_video'),
      response('video', jobA, 'running', { kind: 'video' }),
      request('bad', 'status'),
      response('bad', jobB, 'completed'),
      request('foreign', 'generate', jobA, 'mcp__other__generate_image'),
      response('foreign'),
      request('unknown', 'status', jobB),
      request('invalid', 'status', 'invented-job'),
      response('invalid', 'invented-job', 'completed'),
    ];
    const jobs = collectMediaJobs([...trace, trace[0], trace[1]]);
    expect(jobs.get('submit')).not.toBe(jobs.get('video'));
    expect(jobs.get('submit')?.calls).toHaveLength(1);
    for (const id of ['bad', 'foreign', 'unknown', 'invalid']) expect(jobs.has(id)).toBe(false);
    const later = request('later', 'status');
    expect(collectMediaJobs([...trace, later], [later]).get('later')?.anchorId).toBe('later');
  });

  it('uses response order for concurrent queries and keeps late contradictory results unconfirmed', () => {
    const trace = [
      request('submit'),
      response('submit'),
      request('slow', 'status'),
      request('fast', 'status'),
      response('fast', jobA, 'completed'),
      response('slow', jobA, 'queued'),
    ];
    const job = collectMediaJobs(trace).get('submit')!;
    expect(job.latestReceipt?.call.request.id).toBe('slow');
    expect(
      mediaJobObservation(job, { jobs: [current(jobA, 'completed')], disconnected: false })
    ).toMatchObject({ status: 'unavailable', active: false });
  });

  it('ignores the live owner when displaying read-only history', async () => {
    const trace = [request('submit'), response('submit')];
    extMethod.mockResolvedValue({ sessionId, jobs: [current(jobA, 'failed')] });
    const view = render(owner(rows(trace, true)), { wrapper: IntlTestWrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Queued');
    expect(view.container).toHaveTextContent('Last confirmed receipt');
    expect(view.container.querySelector('[data-media-active="true"]')).toBeNull();
  });

  it('keeps a pending query only at its native approval position even after opening media and process details', async () => {
    const permission = requestAcpPermission({
      sessionId,
      toolCall: { toolCallId: 'poll', title: 'generate_image', status: 'pending' },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    });
    const trace = [
      message('user', 'user', [{ type: 'text', text: 'Check image.' }]),
      request('submit'),
      response('submit'),
      request('poll', 'status'),
      message('permission', 'assistant', [
        {
          type: 'actionRequired',
          data: {
            actionType: 'toolConfirmation',
            id: 'poll',
            toolName: 'generate_image',
            arguments: { operation: 'status', job_id: jobA },
            availableActions: ['allow_once', 'deny_once'],
          },
        },
      ]),
    ];
    const view = render(history(trace, true), { wrapper: IntlTestWrapper });
    expect(await screen.findByTestId('tool-approval-actions')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Execution records (0 status checks)' }));
    for (const group of view.container.querySelectorAll('[data-process-group]')) {
      const toggle = group.querySelector('.codepro-group-heading')?.closest('button');
      if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
    }
    expect(view.container.querySelectorAll('[data-tool-call-id="poll"]')).toHaveLength(1);
    expect(
      view.container.querySelector('[data-process-approval] [data-tool-call-id="poll"]')
    ).not.toBeNull();
    expect(screen.getAllByTestId('tool-approval-actions')).toHaveLength(1);
    act(() => cancelAcpPermissionRequestsForSession(sessionId));
    expect(await permission).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('preserves ordinary tool groups on both sides of a media call within the same source message', () => {
    const ordinary = (id: string) => ({
      type: 'toolRequest' as const,
      id,
      toolCall: { name: 'pwsh', arguments: { command: 'Write-Output ' + id } },
    });
    const media = request('submit').content[0];
    const trace = [
      message('mixed', 'assistant', [ordinary('before'), media, ordinary('after')]),
      response('before'),
      response('submit'),
      response('after'),
    ];
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    const ordered = [
      ...view.container.querySelectorAll('[data-process-group], [data-media-job-id]'),
    ];
    expect(ordered).toHaveLength(3);
    expect(ordered[1]).toHaveAttribute('data-media-job-id', jobA);
    for (const group of [ordered[0], ordered[2]])
      fireEvent.click(group.querySelector('.codepro-group-heading')!.closest('button')!);
    expect(ordered[0].querySelector('[data-tool-call-id="before"]')).not.toBeNull();
    expect(ordered[2].querySelector('[data-tool-call-id="after"]')).not.toBeNull();
    expect(view.container.querySelectorAll('[data-tool-call-id="submit"]')).toHaveLength(0);
  });
});
