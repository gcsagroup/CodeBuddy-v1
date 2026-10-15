import { describe, expect, it } from 'vitest';
import { adaptLegacyCodeProActivity } from './legacyCodeProActivityAdapter';

describe('legacy CodePro activity adapter', () => {
  it('converts a legacy file activity into ActivityEvent v1', () => {
    const event = adaptLegacyCodeProActivity(
      [
        'CodePro · 正在读取文件',
        '活动ID：tool-1',
        '功能：读取项目文件',
        '路径：D:\\CodeBuddy\\README.md',
      ].join('\n'),
      {
        sessionId: 'session-01',
        receivedAt: '2026-07-30T12:00:00Z',
      }
    );

    expect(event).toMatchObject({
      schema_version: 1,
      event_id: 'tool-1',
      event_type: 'file_read',
      session_id: 'session-01',
      run_id: 'legacy:session-01',
      status: 'running',
      started_at: '2026-07-30T12:00:00Z',
      finished_at: null,
      title: '正在读取文件',
      path: 'D:\\CodeBuddy\\README.md',
      include_in_model_context: false,
    });
  });

  it('updates the same event to a terminal state without losing its start time', () => {
    const started = adaptLegacyCodeProActivity(
      'CodePro · 正在运行测试\n活动ID：tool-2\n命令：cargo test',
      {
        sessionId: 'session-01',
        receivedAt: '2026-07-30T12:00:00Z',
      }
    );
    const completed = adaptLegacyCodeProActivity(
      [
        'CodePro · 测试执行完成',
        '活动ID：tool-2',
        '命令：cargo test',
        '状态：成功',
        '结果：4 passed',
      ].join('\n'),
      {
        sessionId: 'session-01',
        receivedAt: '2026-07-30T12:00:05Z',
        previous: started,
      }
    );

    expect(completed).toMatchObject({
      event_id: 'tool-2',
      event_type: 'test_completed',
      status: 'completed',
      started_at: '2026-07-30T12:00:00Z',
      finished_at: '2026-07-30T12:00:05Z',
      command_summary: 'cargo test',
    });
  });

  it('leaves milestones without an activity id in live progress', () => {
    expect(
      adaptLegacyCodeProActivity('CodePro · 任务规划完成', {
        sessionId: 'session-01',
        receivedAt: '2026-07-30T12:00:00Z',
      })
    ).toBeNull();
  });

  it('ignores unrelated status messages', () => {
    expect(
      adaptLegacyCodeProActivity('Still working', {
        sessionId: 'session-01',
        receivedAt: '2026-07-30T12:00:00Z',
      })
    ).toBeNull();
  });

  it('marks text-inferred cancellation as legacy instead of a host fact', () => {
    const event = adaptLegacyCodeProActivity('CodePro · 任务已取消\n活动ID：legacy-cancel-1', {
      sessionId: 'session-01',
      receivedAt: '2026-07-30T12:00:05Z',
    });

    expect(event).toMatchObject({
      status: 'cancelled',
      failure_kind: 'cancelled',
      failure_source: 'legacy_text',
      retryable: true,
    });
  });
});
