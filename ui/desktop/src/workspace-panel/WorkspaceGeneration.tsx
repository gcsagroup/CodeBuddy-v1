import { useEffect, useState } from 'react';
import { getAcpControlClient } from '../acp/acpConnection';
import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import { WorkspaceMedia } from './WorkspaceMedia';
import type { PanelMedia, PanelScope } from './workspacePanelTypes';

export const mediaText = (en: string, cn: string, tw: string) =>
  selectNativeText(currentLocale, en, cn, tw);
export interface MediaJob {
  job_id: string;
  kind: 'image' | 'video';
  created_at: string;
  status: string;
  observation_error?: boolean;
  workflow?: { id: string; label: string };
  queue_position?: number;
  error?: string | null;
  live: {
    stage?: string;
    connected?: boolean;
    node?: string;
    step?: number;
    total?: number;
    preview?: string;
  };
  images?: { path: string }[];
  videos?: { path: string }[];
}
export async function readMediaJobs(sessionId: string): Promise<MediaJob[]> {
  const client = await getAcpControlClient();
  const result = (await client.extMethod('_codebuddy/media/jobs', { sessionId })) as {
    sessionId?: string;
    jobs?: MediaJob[];
  };
  if (result.sessionId !== sessionId || !Array.isArray(result.jobs))
    throw new Error('Invalid media response');
  return result.jobs.filter(
    (job) =>
      typeof job.job_id === 'string' &&
      ['image', 'video'].includes(job.kind) &&
      typeof job.status === 'string' &&
      typeof job.created_at === 'string' &&
      job.live &&
      typeof job.live === 'object'
  );
}
export function useMediaJobs(sessionId: string) {
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    setJobs([]);
    setDisconnected(false);
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await readMediaJobs(sessionId);
        if (!disposed) {
          setJobs(next);
          setDisconnected(false);
        }
      } catch {
        if (!disposed) setDisconnected(true);
      }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId]);
  return { jobs, disconnected };
}
const stages: Record<string, [string, string, string]> = {
  prepare: ['Preparing generation', '准备生成', '準備生成'],
  reference: ['Loading reference images', '加载参考图片', '載入參考圖片'],
  encode: ['Preparing prompt and conditioning', '准备提示词和画面条件', '準備提示詞與畫面條件'],
  model: ['Loading model', '加载模型', '載入模型'],
  clip: ['Loading text encoder', '加载文本编码器', '載入文字編碼器'],
  sample: ['Sampling', '采样生成', '取樣生成'],
  decode: ['Decoding frames', '解码画面', '解碼畫面'],
  audio: ['Decoding audio', '解码音频', '解碼音訊'],
  video: ['Encoding video', '合成视频', '合成影片'],
  save: ['Saving output', '保存生成结果', '儲存生成結果'],
};
const statuses: Record<string, [string, string, string]> = {
  preparing: ['Preparing', '准备中', '準備中'],
  queued: ['Queued', '排队中', '排隊中'],
  running: ['Generating', '生成中', '生成中'],
  completed: ['Completed', '已完成', '已完成'],
  failed: ['Failed', '生成失败', '生成失敗'],
  cancelled: ['Cancelled', '已取消', '已取消'],
  unavailable: ['Status unavailable', '暂未取得任务状态', '暫未取得任務狀態'],
  submission_unknown: ['Confirming submission', '正在确认提交结果', '正在確認提交結果'],
};
function MediaJobPreview({ job, scope }: { job: MediaJob; scope: PanelScope }) {
  const [media, setMedia] = useState<PanelMedia>();
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const active = !['completed', 'failed', 'cancelled'].includes(job.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const file = (job.videos ?? job.images)?.[0]?.path;
  useEffect(() => {
    if (job.status !== 'completed' || !file) return;
    let disposed = false;
    void window.electron
      .workspacePanel({ scope, action: 'read', path: file })
      .then((reply) => {
        if (!disposed) {
          setMedia(reply.document?.media);
          setError(!reply.document?.media);
        }
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
    };
  }, [job.status, file, scope]);
  const live = job.live;
  const progress =
    typeof live.step === 'number' && typeof live.total === 'number' && live.total > 0
      ? Math.min(100, Math.max(0, Math.round((live.step / live.total) * 100)))
      : undefined;
  const preview =
    typeof live.preview === 'string' && /^data:image\/(png|jpeg);base64,/.test(live.preview)
      ? live.preview
      : undefined;
  const status = statuses[job.status];
  const stage = stages[live.stage ?? live.node ?? ''];
  return (
    <article className="rounded-xl border border-border-subtle p-4" data-job-id={job.job_id}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <strong>
          {job.kind === 'video'
            ? mediaText('Video', '视频', '影片')
            : mediaText('Image', '图片', '圖片')}
        </strong>
        <span role="status">
          {job.status === 'completed' ? '✓ ' : ''}
          {status ? mediaText(...status) : job.status}
        </span>
      </div>
      {job.workflow && <p className="mb-2 text-xs text-text-muted">{job.workflow.label}</p>}
      {active && (
        <p className="mb-3 text-xs text-text-muted">
          {mediaText('Elapsed', '已等待', '已等待')}{' '}
          {Math.max(0, Math.floor((now - Date.parse(job.created_at)) / 1000))} s
          {typeof job.queue_position === 'number' &&
            ` · ${mediaText('Queue position', '队列位置', '佇列位置')} ${job.queue_position}`}
        </p>
      )}
      {job.status === 'completed' ? (
        media ? (
          <WorkspaceMedia
            media={media}
            title={file ?? job.job_id}
            target={file ? { sessionId: scope.sessionId, filePath: file } : undefined}
          />
        ) : (
          <p>
            {error
              ? mediaText('Preview file unavailable', '预览文件暂不可用', '預覽檔案暫不可用')
              : mediaText('Loading preview…', '加载预览…', '載入預覽…')}
          </p>
        )
      ) : (
        <>
          {stage && <p className="mb-2 text-sm">{mediaText(...stage)}</p>}
          {progress !== undefined && (
            <div className="mb-3">
              <progress
                aria-label={mediaText('Current node progress', '当前阶段进度', '目前階段進度')}
                value={progress}
                max={100}
                className="w-full"
              />
              <p className="text-xs text-text-muted">
                {live.step} / {live.total} · {progress}%
              </p>
            </div>
          )}
          {preview ? (
            <img
              className="max-h-96 w-full rounded object-contain"
              src={preview}
              alt={mediaText('Live generation preview', '生成中的实时预览', '生成中的即時預覽')}
            />
          ) : (
            <p className="rounded-lg bg-background-muted p-8 text-center text-sm text-text-muted">
              {mediaText(
                'Waiting for the service to send a preview frame',
                '等待生成服务返回预览画面',
                '等待生成服務傳回預覽畫面'
              )}
            </p>
          )}
          {(!live.connected || job.observation_error) &&
            !['failed', 'cancelled'].includes(job.status) && (
              <p className="mt-2 text-xs text-text-muted">
                {mediaText(
                  'Reconnecting to progress updates; the job is not resubmitted.',
                  '正在恢复进度连接，任务不会重复提交。',
                  '正在恢復進度連線，任務不會重複提交。'
                )}
              </p>
            )}
        </>
      )}
      {job.error && (
        <p role="alert" className="mt-2 break-words text-sm">
          {job.error}
        </p>
      )}
      <p className="mt-2 text-xs text-text-muted">{new Date(job.created_at).toLocaleString()}</p>
    </article>
  );
}
export function WorkspaceGeneration({
  scope,
  jobs,
  disconnected,
}: {
  scope: PanelScope;
  jobs: MediaJob[];
  disconnected: boolean;
}) {
  return (
    <section
      className="min-h-0 flex-1 space-y-4 overflow-auto p-4"
      aria-label={mediaText('Generation preview', '生成预览', '生成預覽')}
    >
      {disconnected && (
        <p role="status">
          {mediaText(
            'Connection interrupted. Retrying…',
            '连接中断，正在重连…',
            '連線中斷，正在重連…'
          )}
        </p>
      )}
      {jobs.map((job) => (
        <MediaJobPreview key={job.job_id} scope={scope} job={job} />
      ))}
    </section>
  );
}
