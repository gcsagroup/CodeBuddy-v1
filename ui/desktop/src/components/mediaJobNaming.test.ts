import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { collectMediaJobs, mediaJobObservation } from './mediaJobPresentation';

const first = '11111111-2222-4333-8444-555555555555';
const second = '11111111-2222-4333-8444-666666666666';
function pair(
  id: string,
  args: Record<string, unknown>,
  receipt: Record<string, unknown>
): Message[] {
  return [
    {
      id,
      role: 'assistant',
      created: 1,
      metadata: { userVisible: true, agentVisible: true },
      content: [
        {
          type: 'toolRequest',
          id,
          toolCall: { status: 'success', value: { name: 'generate_image', arguments: args } },
        },
      ],
    },
    {
      id: id + '-result',
      role: 'user',
      created: 2,
      metadata: { userVisible: true, agentVisible: true },
      content: [
        {
          type: 'toolResponse',
          id,
          toolResult: {
            status: 'success',
            value: { content: [{ type: 'text', text: JSON.stringify(receipt) }] },
          },
        },
      ],
    },
  ];
}

describe('new generation business names', () => {
  it('keeps distinct submitted names through polling and replay when optional receipt metadata is absent', () => {
    const wave = pair(
      'wave',
      { operation: 'generate', display_name: '小熊猫招手动作图' },
      { job_id: first, status: 'queued' }
    );
    const jump = pair(
      'jump',
      { operation: 'generate', display_name: '小熊猫跳跃动作图' },
      { job_id: second, status: 'queued' }
    );
    const poll = pair(
      'poll',
      { operation: 'status', job_id: first, display_name: 'Must not rename' },
      { job_id: first, status: 'completed' }
    );
    const trace = [...wave, ...jump, ...poll];
    const original = JSON.stringify(trace);
    const jobs = collectMediaJobs(trace, poll);
    expect(jobs.get('poll')).toBe(jobs.get('wave'));
    expect(jobs.get('poll')?.displayName).toBe('小熊猫招手动作图');
    expect(jobs.get('jump')?.displayName).toBe('小熊猫跳跃动作图');
    expect(mediaJobObservation(jobs.get('jump')!, { jobs: [], disconnected: false }).status).toBe(
      'queued'
    );
    expect(collectMediaJobs(JSON.parse(original)).get('wave')?.displayName).toBe(
      '小熊猫招手动作图'
    );
    expect(JSON.stringify(trace)).toBe(original);
  });

  it('prefers acknowledged names and never creates a job or completion from display text', () => {
    const trace = pair(
      'submit',
      { operation: 'generate', display_name: '已完成' },
      { job_id: first, status: 'queued' }
    );
    expect(collectMediaJobs([trace[0]]).size).toBe(0);
    trace.push(
      ...pair(
        'poll',
        { operation: 'status', job_id: first },
        { job_id: first, status: 'running', display_name: '正式业务名' }
      )
    );
    const job = collectMediaJobs(trace).get('submit')!;
    expect(job.displayName).toBe('正式业务名');
    expect(mediaJobObservation(job, { jobs: [], disconnected: false }).status).toBe('running');
  });

  it('leaves unnamed legacy records unchanged even if a poll carries a name', () => {
    const trace = [
      ...pair(
        'old',
        { operation: 'generate', prompt: 'A detailed prompt, not a title' },
        { job_id: first, status: 'queued' }
      ),
      ...pair(
        'poll',
        { operation: 'status', job_id: first, display_name: 'Wrong source' },
        { job_id: first, status: 'failed' }
      ),
    ];
    expect(collectMediaJobs(trace).get('old')?.displayName).toBeUndefined();
    trace.push(
      ...pair(
        'retry',
        { operation: 'generate', request_id: first, display_name: 'Late proposed name' },
        { job_id: first, status: 'failed' }
      )
    );
    expect(collectMediaJobs(trace).get('retry')?.displayName).toBeUndefined();
  });
});
