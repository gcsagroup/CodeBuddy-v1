import { Fragment, type ReactNode } from 'react';
import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import { useMediaJobs } from '../workspace-panel/WorkspaceGeneration';
import { ToolCallExpandable } from './ToolCallExpandable';
import { ToolActivityIcon } from './ToolActivityIcon';
import { presentedToolCall } from './codepro/CodeProToolContent';
import {
  mediaJobObservation,
  type MediaJobCall,
  type MediaJobPresentation,
} from './mediaJobPresentation';
import { GeneratedMediaFiles, mediaOutputPaths } from './GeneratedMedia';

const text = (en: string, cn: string, tw: string) => selectNativeText(currentLocale, en, cn, tw);
const statusText = (status: string) => {
  switch (status) {
    case 'preparing':
      return text('Preparing', '准备中', '準備中');
    case 'queued':
      return text('Queued', '排队中', '排隊中');
    case 'running':
      return text('Generating', '生成中', '生成中');
    case 'completed':
      return text('Completed', '已完成', '已完成');
    case 'failed':
      return text('Unsuccessful', '未成功', '未成功');
    case 'cancelled':
      return text('Cancelled', '已取消', '已取消');
    case 'submission_unknown':
      return text('Submission unconfirmed', '提交待确认', '提交待確認');
    default:
      return text('Status unconfirmed', '状态待确认', '狀態待確認');
  }
};
const kindText = (kind: MediaJobPresentation['kind']) =>
  kind === 'video'
    ? text('Video generation', '视频生成', '影片生成')
    : text('Image generation', '图片生成', '圖片生成');

export function MediaTaskRows({
  jobs,
  sessionId,
  renderCall,
  renderBefore,
  pendingIds,
  readOnly = false,
}: {
  jobs: MediaJobPresentation[];
  sessionId: string;
  renderCall: (call: MediaJobCall) => ReactNode;
  renderBefore?: (job: MediaJobPresentation) => ReactNode;
  pendingIds?: ReadonlySet<string>;
  readOnly?: boolean;
}) {
  const snapshot = useMediaJobs(readOnly ? '' : sessionId);
  const entries = jobs.map((job) => ({ job, observation: mediaJobObservation(job, snapshot) }));
  const rows = entries.map(({ job, observation }) => {
    const last = job.latestReceipt;
    const calls = job.calls.filter((call) => !pendingIds?.has(call.request.id));
    const queries = calls.filter(
      (call) => call.response && presentedToolCall(call.request)?.arguments.operation === 'status'
    ).length;
    const cancelUnconfirmed =
      last?.value.cancellation_confirmed === false && observation.status !== 'cancelled';
    return (
      <div key={job.key} data-media-job-id={job.jobId} className="my-1 w-full max-w-[52rem]">
        {renderBefore?.(job)}
        <ToolCallExpandable
          compact
          scrollable={false}
          autoExpandOnReading={false}
          storageKey={'media-task-' + sessionId + '-' + job.key}
          label={
            <span
              role="status"
              data-media-status={observation.status}
              data-media-active={observation.active}
            >
              {kindText(job.kind)} {statusText(observation.status)}
            </span>
          }
          icon={
            <ToolActivityIcon
              name={job.kind === 'video' ? 'generate_video' : 'generate_image'}
              status={
                observation.active
                  ? 'loading'
                  : observation.status === 'failed'
                    ? 'error'
                    : 'pending'
              }
            />
          }
        >
          {observation.source === 'receipt' && (
            <p className="ml-6 text-xs text-text-secondary">
              {text('Last confirmed receipt', '最后确认的回执', '最後確認的回執')}
            </p>
          )}
          <GeneratedMediaFiles
            sessionId={sessionId}
            paths={mediaOutputPaths(observation.receipt)}
            inline
          />
          <div className="ml-6">
            <ToolCallExpandable
              compact
              label={
                text('Execution records', '执行记录', '執行紀錄') +
                ' (' +
                queries +
                ' ' +
                text('status checks', '次状态查询', '次狀態查詢') +
                ')'
              }
              storageKey={'media-' + sessionId + '-' + job.key}
              autoExpandOnReading={false}
              scrollable={false}
            >
              {observation.source === 'unavailable' && last && (
                <p className="mb-2 text-xs text-text-secondary">
                  {text('Last confirmed receipt', '最后确认的回执', '最後確認的回執')}:{' '}
                  {statusText(String(last.value.status))}
                </p>
              )}
              {cancelUnconfirmed && (
                <p className="mb-2 text-xs text-text-secondary">
                  {text('Cancellation unconfirmed', '取消未确认', '取消未確認')}
                </p>
              )}
              {typeof observation.receipt?.error === 'string' && observation.receipt.error && (
                <p className="mb-2 whitespace-pre-wrap break-words text-xs text-text-secondary">
                  {observation.receipt.error}
                </p>
              )}
              {calls.map((call) => (
                <Fragment key={call.request.id}>{renderCall(call)}</Fragment>
              ))}
            </ToolCallExpandable>
          </div>
        </ToolCallExpandable>
      </div>
    );
  });
  // This disclosure groups rows for reading, not jobs for execution. Every job
  // retains its own identity, state and complete calls inside the disclosure.
  if (
    entries.length > 1 &&
    entries.every(
      (entry) => entry.job.kind === entries[0].job.kind && entry.observation.status === 'failed'
    )
  )
    return (
      <div data-media-failure-group="" className="my-1 w-full max-w-[52rem]">
        <ToolCallExpandable
          compact
          scrollable={false}
          autoExpandOnReading={false}
          storageKey={'media-failures-' + sessionId + '-' + entries[0].job.key}
          label={
            <span role="status">
              {kindText(entries[0].job.kind)} {statusText('failed')}
            </span>
          }
          icon={
            <ToolActivityIcon
              name={entries[0].job.kind === 'video' ? 'generate_video' : 'generate_image'}
              status="error"
            />
          }
        >
          {rows}
        </ToolCallExpandable>
      </div>
    );
  return <>{rows}</>;
}
