import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

const openProcesses = (container: HTMLElement) => {
  for (const group of container.querySelectorAll('[data-process-group]')) {
    const toggle = group.querySelector('.codepro-group-heading')?.closest('button');
    if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
};
const named = (
  id: string,
  jobId = jobA,
  status = 'queued',
  name = '小熊猫招手动作图',
  extra: Record<string, unknown> = {}
) => response(id, jobId, status, { display_name: name, ...extra });

describe('media task presentation', () => {
  it('uses one collapsed process entry for eight distinct failures without assuming a batch or merging their receipts', () => {
    const ids = Array.from(
      { length: 8 },
      (_, index) => `11111111-2222-4333-8444-${String(index + 1).padStart(12, '0')}`
    );
    const trace = ids.flatMap((id, index) => [
      request('submit-' + index),
      response('submit-' + index, id),
      request('poll-' + index, 'status', id),
      response('poll-' + index, id, 'failed', {
        error: `KSampler: expected [*,4096], got [1,${2331 + index},5120]`,
      }),
    ]);
    const original = JSON.stringify(trace);
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    expect(
      screen.getByRole('button', { name: 'Image generation unsuccessful', expanded: false })
    ).toBeVisible();
    expect(view.container.querySelector('[data-media-job-id]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Image generation unsuccessful' }));
    const group = view.container.querySelector('.codepro-process-details');
    expect(group).not.toHaveClass('max-h-72', 'overflow-y-auto');
    const jobs = view.container.querySelectorAll('[data-media-job-id]');
    expect(jobs).toHaveLength(8);
    const first = jobs[0] as HTMLElement;
    expect(first).not.toHaveClass('my-1');
    fireEvent.click(within(first).getByRole('button', { name: 'Generate image Unsuccessful' }));
    expect(first.querySelector('.codepro-operation-details')).toHaveClass(
      'rounded-lg',
      'border',
      'max-h-72'
    );
    const specific = within(first).getByText('KSampler: expected [*,4096], got [1,2331,5120]');
    expect(specific).not.toBeVisible();
    expect(first).not.toHaveTextContent('The generation service reported a failure');
    fireEvent.click(within(first).getByText('Error details'));
    expect(specific).toBeVisible();
    expect(jobs[1]).not.toHaveTextContent('got [1,2331,5120]');
    expect(view.container).not.toHaveTextContent('Execution records');
    expect(collectMediaJobs(trace).get('poll-1')?.calls).toHaveLength(2);
    expect(JSON.stringify(trace)).toBe(original);
  });

  it('keeps separate public process boundaries even when different jobs return identical errors', () => {
    const trace = [
      request('first'),
      named('first', jobA, 'failed', '产品海报', { error: 'same remote error' }),
      message('boundary', 'assistant', [{ type: 'text', text: 'Starting another request.' }]),
      request('second'),
      named('second', jobB, 'failed', '动作图', { error: 'same remote error' }),
    ];
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    expect(
      screen.getAllByRole('button', { name: 'Image generation unsuccessful', expanded: false })
    ).toHaveLength(2);
    openProcesses(view.container);
    expect(view.container.querySelectorAll('[data-media-job-id]')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Generate 产品海报 Unsuccessful' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Generate 动作图 Unsuccessful' })).toBeVisible();
  });

  it('shows one business name and a collapsible image for twenty polls without execution records', () => {
    const path = 'generated-images/' + jobA + '/1.png';
    const trace = [request('submit'), named('submit')];
    for (let i = 1; i <= 20; i++)
      trace.push(
        request('poll-' + i, 'status'),
        named(
          'poll-' + i,
          jobA,
          i === 20 ? 'completed' : 'running',
          '小熊猫招手动作图',
          i === 20 ? { images: [{ path }] } : {}
        )
      );
    const original = JSON.stringify(trace);
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    openProcesses(view.container);
    expect(view.container.querySelectorAll('[data-media-job-id]')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Generate 小熊猫招手动作图 Completed');
    const task = within(
      view.container.querySelector('[data-media-job-id]') as HTMLElement
    ).getByRole('button', { name: 'Generate 小熊猫招手动作图 Completed', expanded: false });
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(task);
    expect(screen.getByRole('img', { name: '小熊猫招手动作图 / 1.png' })).toBeVisible();
    expect(view.container).not.toHaveTextContent('Related files');
    expect(view.container).not.toHaveTextContent('3,505,445');
    expect(view.container.querySelector('[data-tool-call-id]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Execution records/ })).toBeNull();
    expect(collectMediaJobs(trace).get('submit')?.calls).toHaveLength(21);
    fireEvent.click(task);
    expect(screen.queryByRole('img')).toBeNull();
    expect(JSON.stringify(trace)).toBe(original);
  });

  it.each(['completed', 'failed', 'mixed'])(
    'shows distinct business results for %s without treating transport success as generation success',
    (mode) => {
      const statuses = mode === 'mixed' ? ['completed', 'failed'] : [mode, mode];
      const names = ['产品海报', '小熊猫招手动作图'];
      const trace = [jobA, jobB].flatMap((id, i) => [
        request('submit-' + i),
        named('submit-' + i, id, 'queued', names[i]),
        request('poll-' + i, 'status', id),
        named(
          'poll-' + i,
          id,
          statuses[i],
          names[i],
          statuses[i] === 'failed'
            ? {
                error: 'KSampler: normalized_shape=[4096], input=[1,2331,5120]',
                failure_info: {
                  stage: 'remote_execution',
                  source: 'comfyui',
                  node_type: 'KSampler',
                  exception_type: 'RuntimeError',
                },
              }
            : {}
        ),
      ]);
      const view = render(history(trace), { wrapper: IntlTestWrapper });
      openProcesses(view.container);
      expect(view.container.querySelectorAll('[data-media-job-id]')).toHaveLength(2);
      expect(view.container.querySelectorAll('[data-tool-call-id]')).toHaveLength(0);
      for (let i = 0; i < 2; i++) {
        const row = view.container.querySelector(
          `[data-media-job-id="${[jobA, jobB][i]}"]`
        ) as HTMLElement;
        expect(within(row).getByRole('status')).toHaveTextContent(
          'Generate ' +
            names[i] +
            ' ' +
            (statuses[i] === 'completed' ? 'Completed' : 'Unsuccessful')
        );
        if (statuses[i] === 'failed') {
          expect(within(row).queryByText(/normalized_shape/)).toBeNull();
          fireEvent.click(
            within(row).getByRole('button', { name: 'Generate ' + names[i] + ' Unsuccessful' })
          );
          expect(within(row).getByText('External generation service error')).toBeVisible();
          expect(within(row).getByText(/normalized_shape/)).not.toBeVisible();
          fireEvent.click(within(row).getByText('Error details'));
          expect(within(row).getByText(/normalized_shape/)).toBeVisible();
        }
      }
      expect(view.container).not.toHaveTextContent('Completed 4 operations');
    }
  );

  it('preserves distinct jobs even when their business names and output filenames match', () => {
    const trace = [jobA, jobB].flatMap((id, i) => [
      request('submit-' + i),
      named('submit-' + i, id, 'completed', '产品海报', {
        images: [{ path: 'generated-images/' + id + '/1.png' }],
      }),
    ]);
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    openProcesses(view.container);
    const jobs = view.container.querySelectorAll('[data-media-job-id]');
    expect(jobs).toHaveLength(2);
    for (const row of jobs)
      fireEvent.click(
        within(row as HTMLElement).getByRole('button', { name: 'Generate 产品海报 Completed' })
      );
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual([
      '产品海报 / 1.png',
      '产品海报 / 1.png',
    ]);
    expect(new Set(screen.getAllByRole('img').map((image) => image.getAttribute('src'))).size).toBe(
      2
    );
  });

  it('does not invent names from numbers, workflow labels, prompt snippets or invalid optional fields', () => {
    const trace = [
      request('submit'),
      response('submit', jobA, 'failed', { display_name: 42, error: 'Original service error' }),
    ];
    const view = render(rows(trace), { wrapper: IntlTestWrapper });
    expect(screen.getByRole('status')).toHaveTextContent('Generate image Unsuccessful');
    expect(screen.queryByText('Original service error')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Generate image Unsuccessful' }));
    expect(screen.getByText('Original service error')).not.toBeVisible();
    fireEvent.click(screen.getByText('Error details'));
    expect(screen.getByText('Original service error')).toBeVisible();
    expect(view.container).not.toHaveTextContent(jobA);
    expect(view.container).not.toHaveTextContent('Execution records');
    view.rerender(
      rows([request('submit'), response('submit', jobA, 'failed', { display_name: 'a\u202Eb' })])
    );
    expect(screen.getByRole('status')).toHaveTextContent('Generate image Unsuccessful');
  });

  it('retains the acknowledged business name across query-only windows, replay and missing optional name in a later receipt', () => {
    const submit = request('submit');
    const poll = request('poll', 'status');
    const trace = [submit, named('submit'), poll, response('poll', jobA, 'completed'), submit];
    const jobs = collectMediaJobs(trace, [poll]);
    expect(jobs.get('poll')).toBe(jobs.get('submit'));
    expect(jobs.get('poll')?.anchorId).toBe('poll');
    render(<MediaTaskRows jobs={[jobs.get('poll')!]} sessionId={sessionId} />, {
      wrapper: IntlTestWrapper,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Generate 小熊猫招手动作图 Completed');
  });

  it('escapes business names and displays unrelated business names through the same contract', () => {
    render(
      rows([request('submit'), named('submit', jobA, 'failed', '<script>产品海报</script>')]),
      { wrapper: IntlTestWrapper }
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Generate <script>产品海报</script> Unsuccessful'
    );
    expect(document.querySelector('script')).toBeNull();
  });

  it.each(['query', 'output_retrieval', 'output_validation', 'output_publication'])(
    'distinguishes %s observation errors from a generation failure',
    async (stage) => {
      const info = { stage, source: 'host', message: 'Original ' + stage + ' error' };
      extMethod.mockResolvedValue({
        sessionId,
        jobs: [
          { ...current(jobA, 'running'), observation_error: true, observation_error_info: info },
        ],
      });
      const trace = [request('submit'), named('submit', jobA, 'running')];
      const view = render(owner(rows(trace)), { wrapper: IntlTestWrapper });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole('status')).toHaveTextContent('Status unconfirmed');
      expect(screen.queryByText('Original ' + stage + ' error')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Status unconfirmed/ }));
      expect(screen.getByText('Original ' + stage + ' error')).not.toBeVisible();
      fireEvent.click(screen.getByText('Error details'));
      expect(screen.getByText('Original ' + stage + ' error')).toBeVisible();
      expect(view.container).not.toHaveTextContent('Unsuccessful');
      expect(view.container.querySelector('[data-media-active="true"]')).toBeNull();
    }
  );

  it('does not merge root causes from similar error text or node and exception types', () => {
    const trace = [jobA, jobB].flatMap((id, i) => [
      request('submit-' + i),
      named('submit-' + i, id, 'failed', ['海报', '招手'][i], {
        error: 'KSampler dimensions ' + i,
        failure_info: {
          stage: 'remote_execution',
          source: 'comfyui',
          node_type: 'KSampler',
          exception_type: 'RuntimeError',
        },
      }),
    ]);
    const view = render(rows(trace), { wrapper: IntlTestWrapper });
    const jobs = [...view.container.querySelectorAll('[data-media-job-id]')];
    expect(jobs).toHaveLength(2);
    for (const row of jobs) {
      fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /Unsuccessful/ }));
      fireEvent.click(within(row as HTMLElement).getByText('Error details'));
    }
    expect(within(jobs[0] as HTMLElement).getByText('KSampler dimensions 0')).toBeVisible();
    expect(within(jobs[1] as HTMLElement).getByText('KSampler dimensions 1')).toBeVisible();
    expect(view.container).not.toHaveTextContent('same error');
  });

  it('stops live activity on disconnect and accepts a later terminal receipt without stale active state', async () => {
    vi.useFakeTimers();
    const trace = [request('submit'), named('submit', jobA, 'running')];
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
      owner(rows([...trace, request('poll', 'status'), named('poll', jobA, 'completed')]))
    );
    expect(screen.getByRole('status')).toHaveTextContent('Completed');
  });

  it.each([false, true])(
    'keeps contradictory terminal and cancellation evidence unknown, disconnected=%s',
    (disconnected) => {
      const traces = [
        [
          request('submit'),
          response('submit', jobA, 'completed'),
          request('poll', 'status'),
          response('poll', jobA, 'failed'),
        ],
        [
          request('submit'),
          response('submit', jobA, 'cancelled'),
          request('poll', 'cancel'),
          response('poll', jobA, 'running', { cancellation_confirmed: false }),
        ],
        [
          request('submit'),
          response('submit'),
          request('poll', 'cancel'),
          response('poll', jobA, 'running', { cancellation_confirmed: false }),
        ],
      ];
      for (const trace of traces)
        expect(
          mediaJobObservation(collectMediaJobs(trace).get('submit')!, {
            jobs: [current(jobA, 'cancelled')],
            disconnected,
          })
        ).toMatchObject({ status: 'unavailable', active: false });
    }
  );

  it('keeps query tool errors and unconfirmed cancellation separate from generation failure', () => {
    const failed = message('query-error', 'user', [
      { type: 'toolResponse', id: 'poll', toolResult: { status: 'error', error: 'Query failed' } },
    ]);
    const trace = [
      request('submit'),
      named('submit', jobA, 'running'),
      request('poll', 'status'),
      failed,
    ];
    const view = render(rows(trace), { wrapper: IntlTestWrapper });
    expect(screen.getByRole('status')).toHaveTextContent('Status unconfirmed');
    view.rerender(
      rows([
        ...trace,
        request('cancel', 'cancel'),
        named('cancel', jobA, 'running', '小熊猫招手动作图', { cancellation_confirmed: false }),
      ])
    );
    expect(screen.getByRole('status')).toHaveTextContent('Generating');
    expect(view.container).not.toHaveTextContent('Cancelled');
    expect(view.container).not.toHaveTextContent('Execution records');
  });

  it('requires an exact native contract, keeps media kinds separate and leaves external/inspect/unknown calls on the ordinary path', () => {
    const trace = [
      request('submit'),
      response('submit'),
      request('video', 'generate', jobA, 'generate_video'),
      response('video', jobA, 'running', { kind: 'video' }),
      request('bad', 'status'),
      response('bad', jobB, 'completed'),
      request('foreign', 'generate', jobA, 'mcp__other__generate_image'),
      response('foreign'),
      request('inspect', 'inspect'),
      response('inspect'),
      request('unknown', 'status', jobB),
      request('invalid', 'status', 'invented-job'),
      response('invalid', 'invented-job', 'completed'),
    ];
    const jobs = collectMediaJobs(trace);
    expect(jobs.get('submit')).not.toBe(jobs.get('video'));
    for (const id of ['bad', 'foreign', 'inspect', 'unknown', 'invalid'])
      expect(jobs.has(id)).toBe(false);
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    openProcesses(view.container);
    for (const id of ['bad', 'foreign', 'inspect', 'unknown', 'invalid'])
      expect(view.container.querySelector(`[data-tool-call-id="${id}"]`)).not.toBeNull();
  });

  it('uses actual response order and refuses a late contradictory terminal update', () => {
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

  it('does not promote a read-only history from the current live owner', async () => {
    extMethod.mockResolvedValue({ sessionId, jobs: [current(jobA, 'failed')] });
    const view = render(owner(rows([request('submit'), named('submit')], true)), {
      wrapper: IntlTestWrapper,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Queued');
    expect(view.container.querySelector('[data-media-active="true"]')).toBeNull();
  });

  it('keeps native approval actions exactly once outside the folded raw records', async () => {
    const permission = requestAcpPermission({
      sessionId,
      toolCall: { toolCallId: 'poll', title: 'generate_image', status: 'pending' },
      options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
    });
    const trace = [
      request('submit'),
      named('submit'),
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
    openProcesses(view.container);
    expect(await screen.findByTestId('tool-approval-actions')).toBeVisible();
    openProcesses(view.container);
    expect(view.container.querySelectorAll('[data-tool-call-id="poll"]')).toHaveLength(1);
    expect(
      view.container.querySelector('[data-process-approval] [data-tool-call-id="poll"]')
    ).not.toBeNull();
    expect(screen.getAllByTestId('tool-approval-actions')).toHaveLength(1);
    act(() => cancelAcpPermissionRequestsForSession(sessionId));
    expect(await permission).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it.each([false, true])(
    'preserves original thinking parents, ranges and order with mixed tools; sameMessage=%s',
    (sameMessage) => {
      const thought = (thinking: string) => ({
        type: 'thinking' as const,
        thinking,
        signature: '',
      });
      const command = {
        type: 'toolRequest' as const,
        id: 'command',
        toolCall: { name: 'pwsh', arguments: { command: 'Write-Output done' } },
      };
      const contents = [
        thought('Before media.'),
        request('submit').content[0],
        thought('After media.'),
        command,
      ];
      const trace = [
        ...(sameMessage
          ? [
              message('mixed', 'assistant', [
                ...contents,
                { type: 'text' as const, text: 'Public result.' },
              ]),
            ]
          : [
              ...contents.map((content, i) => message('part-' + i, 'assistant', [content])),
              message('public', 'assistant', [{ type: 'text', text: 'Public result.' }]),
            ]),
        named('submit', jobA, 'failed', '招手动作图', { error: 'Original remote error' }),
        response('command'),
      ];
      const original = JSON.stringify(trace);
      const view = render(history(trace), { wrapper: IntlTestWrapper });
      openProcesses(view.container);
      expect(view.container.querySelectorAll('[data-process-group]')).toHaveLength(1);
      openProcesses(view.container);
      expect(screen.queryByRole('button', { name: 'Reasoning details' })).toBeNull();
      expect(screen.getByText('Before media.')).toBeVisible();
      expect(screen.getByText('After media.')).toBeVisible();
      const thinking = [...view.container.querySelectorAll('.codepro-thinking-details')];
      expect(thinking).toHaveLength(2);
      for (const record of thinking) {
        expect(record.closest('[data-media-job-id]')).toBeNull();
        expect(record.closest('[data-process-group]')).not.toBeNull();
      }
      const ordered = [
        ...view.container.querySelectorAll(
          '.codepro-thinking-details, [data-media-job-id], [data-tool-call-id="command"]'
        ),
      ];
      expect(ordered).toEqual([
        thinking[0],
        view.container.querySelector('[data-media-job-id]'),
        thinking[1],
        view.container.querySelector('[data-tool-call-id="command"]'),
      ]);
      expect(screen.getByText('Public result.')).toBeVisible();
      expect(JSON.stringify(trace)).toBe(original);
    }
  );

  it('does not create a media task or change custom rendering without an acknowledged job', () => {
    const trace = [request('pending'), request('inspect', 'inspect'), response('inspect')];
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    openProcesses(view.container);
    expect(view.container.querySelector('[data-media-job-id]')).toBeNull();
    view.rerender(
      <ProgressiveMessageList
        messages={trace}
        chat={{ sessionId }}
        isUserMessage={(item) => item.role === 'user'}
        renderMessage={(item) => <span key={item.id}>custom {item.id}</span>}
      />
    );
    expect(view.container).toHaveTextContent('custom pending');
    expect(view.container.querySelector('[data-process-group]')).toBeNull();
  });

  it('anchors a task in the actual clipped subagent window while keeping its full call history', () => {
    const trace = [request('submit'), named('submit')];
    for (let i = 0; i < 25; i++)
      trace.push(
        message('public-' + i, 'assistant', [{ type: 'text', text: 'Progress ' + i }]),
        request('poll-' + i, 'status'),
        named('poll-' + i, jobA, i === 24 ? 'failed' : 'running')
      );
    const view = render(
      <ProgressiveMessageList
        messages={trace}
        chat={{ sessionId }}
        isUserMessage={(item) => item.role === 'user'}
        foldTurns={false}
        maxVisibleMessages={4}
        showLoadingThreshold={1000}
      />,
      { wrapper: IntlTestWrapper }
    );
    openProcesses(view.container);
    expect(view.container.querySelectorAll('[data-media-job-id]')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Generate 小熊猫招手动作图 Unsuccessful');
    expect(screen.queryByRole('button', { name: /Execution records/ })).toBeNull();
    expect(view.container.querySelectorAll('[data-tool-call-id]')).toHaveLength(0);
    expect(collectMediaJobs(trace).get('submit')?.calls).toHaveLength(26);
  });

  it('keeps reasoning at a later query position without another generated-completed headline or an empty polling shell', () => {
    const trace = [
      request('submit'),
      named('submit'),
      message('boundary', 'assistant', [{ type: 'text', text: 'Waiting for the result.' }]),
      message('reasoning', 'assistant', [
        { type: 'thinking', thinking: 'Checking the remote task.', signature: '' },
      ]),
      request('poll', 'status'),
      named('poll', jobA, 'failed'),
      message('boundary-2', 'assistant', [{ type: 'text', text: 'The task did not complete.' }]),
      request('late', 'status'),
      named('late', jobA, 'failed'),
    ];
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    openProcesses(view.container);
    expect(view.container.querySelectorAll('[data-media-job-id]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-process-group]')).toHaveLength(2);
    const later = view.container.querySelectorAll('[data-process-group]')[1] as HTMLElement;
    expect(later.querySelector('.codepro-group-heading')).not.toBeNull();
    expect(within(later).queryByRole('button', { name: 'Reasoning details' })).toBeNull();
    expect(within(later).getByText('Checking the remote task.')).toBeVisible();
    expect(later.querySelector('.codepro-thinking-details')).not.toBeNull();
    expect(later.querySelector('[data-media-job-id]')).toBeNull();
  });

  it.each([1, 2, 3])(
    'shows all %s thoughts directly after expanding their process',
    (count) => {
      const trace = Array.from({ length: count }, (_, index) =>
        message('thought-' + index, 'assistant', [
          { type: 'thinking', thinking: 'Reasoning part ' + index, signature: '' },
        ])
      );
      const view = render(history(trace), { wrapper: IntlTestWrapper });
      openProcesses(view.container);
      expect(screen.queryByRole('button', { name: 'Reasoning details' })).toBeNull();
      expect(view.container.querySelectorAll('.codepro-thinking-details')).toHaveLength(count);
      for (let index = 0; index < count; index++) {
        expect(screen.getByText('Reasoning part ' + index)).toBeVisible();
      }
    }
  );

  it('treats adjacent streaming thinking fragments as one original disclosure', () => {
    const view = render(
      history([
        message('fragments', 'assistant', [
          { type: 'thinking', thinking: 'First fragment.', signature: '' },
          { type: 'thinking', thinking: 'Second fragment.', signature: '' },
        ]),
      ]),
      { wrapper: IntlTestWrapper }
    );
    expect(screen.queryByRole('button', { name: 'Reasoning details' })).toBeNull();
    openProcesses(view.container);
    expect(view.container).toHaveTextContent('First fragment.');
    expect(view.container).toHaveTextContent('Second fragment.');
  });

  it('keeps one thought at its original position among media and ordinary tools without a middle thinking-details layer', () => {
    const ordinary = {
      type: 'toolRequest' as const,
      id: 'command',
      toolCall: { name: 'pwsh', arguments: { command: 'Write-Output done' } },
    };
    const trace = [
      message('mixed', 'assistant', [
        { type: 'thinking', thinking: 'Before the image.', signature: '' },
        request('submit').content[0],
        ordinary,
      ]),
      named('submit', jobA, 'failed', '产品海报', { error: 'KSampler: actual failure' }),
      response('command'),
    ];
    const original = JSON.stringify(trace);
    const view = render(history(trace), { wrapper: IntlTestWrapper });
    openProcesses(view.container);
    expect(screen.queryByRole('button', { name: 'Reasoning details' })).toBeNull();
    expect(screen.getByText('Before the image.')).toBeVisible();
    const ordered = [
      ...view.container.querySelectorAll(
        '.codepro-thinking-details, [data-media-job-id], [data-tool-call-id="command"]'
      ),
    ];
    expect(ordered).toHaveLength(3);
    expect(ordered[0]).toHaveClass('codepro-thinking-details');
    expect(ordered[1]).toHaveAttribute('data-media-job-id', jobA);
    expect(ordered[2]).toHaveAttribute('data-tool-call-id', 'command');
    expect(screen.queryByText('KSampler: actual failure')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Generate 产品海报 Unsuccessful' }));
    expect(screen.getByText('KSampler: actual failure')).not.toBeVisible();
    fireEvent.click(screen.getByText('Error details'));
    expect(screen.getByText('KSampler: actual failure')).toBeVisible();
    expect(view.container).not.toHaveTextContent('Execution records');
    expect(JSON.stringify(trace)).toBe(original);
  });
});
