import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import { useMediaJobs } from '../workspace-panel/WorkspaceGeneration';
import { ToolCallExpandable } from './ToolCallExpandable';
import { ToolActivityIcon } from './ToolActivityIcon';
import {
  mediaDisplayName,
  mediaFailureInfo,
  mediaJobObservation,
  type MediaJobObservation,
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
function taskName(job: MediaJobPresentation, observation: MediaJobObservation) {
  return (
    mediaDisplayName(observation.receipt?.display_name) ??
    job.displayName ??
    mediaDisplayName(job.latestReceipt?.value.display_name) ??
    (job.kind === 'video' ? text('video', '视频', '影片') : text('image', '图片', '圖片'))
  );
}
function taskTitle(job: MediaJobPresentation, observation: MediaJobObservation) {
  const name = taskName(job, observation);
  return (
    text(`Generate ${name}`, `生成${name}`, `生成${name}`) + ' ' + statusText(observation.status)
  );
}
export function mediaProcessSummary(jobs: MediaJobPresentation[]) {
  if (!jobs.length) return '';
  if (jobs.every((job) => job.kind === 'image'))
    return text('Image generation results', '图片生成结果', '圖片生成結果');
  if (jobs.every((job) => job.kind === 'video'))
    return text('Video generation results', '视频生成结果', '影片生成結果');
  return text('Generation results', '生成结果', '生成結果');
}
function failureSummary(observation: MediaJobObservation) {
  const info = observation.issue ?? mediaFailureInfo(observation.receipt?.failure_info);
  switch (info?.stage) {
    case 'query':
      return text(
        'Unable to check the generation status; result unconfirmed',
        '暂时无法查询生成状态，结果待确认',
        '暫時無法查詢生成狀態，結果待確認'
      );
    case 'output_retrieval':
      return text(
        'Unable to retrieve the generated result',
        '生成结果尚未获取成功',
        '生成結果尚未取得成功'
      );
    case 'output_validation':
      return text(
        'The returned file did not pass validation',
        '生成结果文件未通过校验',
        '生成結果檔案未通過校驗'
      );
    case 'output_publication':
      return text(
        'Unable to save the generated result',
        '生成结果尚未保存成功',
        '生成結果尚未儲存成功'
      );
    case 'submission':
      return text(
        'The generation request was not accepted',
        '生成请求未被接受',
        '生成請求未被接受'
      );
    case 'remote_execution':
      return text(
        'The external generation service failed',
        '外部生成服务执行失败',
        '外部生成服務執行失敗'
      );
    default:
      return observation.status === 'failed'
        ? text(
            'The generation service reported a failure',
            '生成服务返回失败结果',
            '生成服務返回失敗結果'
          )
        : undefined;
  }
}
export function MediaTaskRows({
  jobs,
  sessionId,
  readOnly = false,
}: {
  jobs: MediaJobPresentation[];
  sessionId: string;
  readOnly?: boolean;
}) {
  const snapshot = useMediaJobs(readOnly ? '' : sessionId);
  return (
    <>
      {jobs.map((job) => {
        const observation = mediaJobObservation(job, snapshot);
        const name = taskName(job, observation);
        const title = taskTitle(job, observation);
        const summary = failureSummary(observation);
        const info = observation.issue ?? mediaFailureInfo(observation.receipt?.failure_info);
        const error =
          typeof info?.message === 'string'
            ? info.message
            : typeof observation.receipt?.error === 'string'
              ? observation.receipt.error
              : undefined;
        const paths = mediaOutputPaths(observation.receipt);
        const label = (
          <span
            role="status"
            data-media-status={observation.status}
            data-media-active={observation.active}
          >
            {title}
          </span>
        );
        const icon = (
          <ToolActivityIcon
            name={job.kind === 'video' ? 'generate_video' : 'generate_image'}
            status={
              observation.active
                ? 'loading'
                : observation.status === 'failed'
                  ? 'error'
                  : observation.status === 'completed'
                    ? 'success'
                    : 'pending'
            }
          />
        );
        return (
          <div key={job.key} data-media-job-id={job.jobId} className="my-1 w-full max-w-[52rem]">
            {paths.length || summary ? (
              <ToolCallExpandable
                compact
                scrollable={false}
                autoExpandOnReading={false}
                storageKey={'media-task-' + sessionId + '-' + job.key}
                label={label}
                icon={icon}
              >
                <GeneratedMediaFiles sessionId={sessionId} paths={paths} taskLabel={name} inline />
                {summary && (
                  <div
                    data-media-failure-summary=""
                    className="ml-6 mb-1 text-sm text-text-secondary"
                  >
                    <p>{summary}</p>
                    {error && <p className="whitespace-pre-wrap break-words text-xs">{error}</p>}
                  </div>
                )}
              </ToolCallExpandable>
            ) : (
              <div className="flex items-start gap-2 py-1 text-sm">
                {icon}
                {label}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
