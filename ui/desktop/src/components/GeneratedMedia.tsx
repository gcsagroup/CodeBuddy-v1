import {
  memo,
  useMemo,
  useState,
  useRef,
  createContext,
  useContext,
  type ReactNode,
  type ComponentRef,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import type { ToolResponseMessageContent } from '../types/message';
import { WorkspaceFileReferences } from './WorkspaceFileReferences';
import { generatedMediaReceipt } from '../utils/mediaToolReceipt';
import { useWorkspaceFileReferences } from './useWorkspaceFileReferences';
import { VideoFirstFrame } from './VideoFirstFrame';
import { WorkspaceMedia } from '../workspace-panel/WorkspaceMedia';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';
import { useMediaJobs, resolveMediaOutput } from '../workspace-panel/WorkspaceGeneration';

const DeliveredMediaContext = createContext<ReadonlySet<string>>(new Set());
export function useHasDeliveredMedia() {
  return useContext(DeliveredMediaContext).size > 0;
}
export function DeliveredMediaScope({ paths, children }: { paths: string[]; children: ReactNode }) {
  const key = JSON.stringify(paths.map((path) => path.replace(/\\/g, '/')));
  const value = useMemo(() => new Set<string>(JSON.parse(key)), [key]);
  return <DeliveredMediaContext.Provider value={value}>{children}</DeliveredMediaContext.Provider>;
}

export function GeneratedMediaReference({
  sessionId,
  href,
  fallback,
}: {
  sessionId: string;
  href: string;
  fallback: ReactNode;
}) {
  const { jobs } = useMediaJobs(sessionId);
  const artifact = resolveMediaOutput(jobs, href);
  const delivered = useContext(DeliveredMediaContext);
  if (delivered.has((artifact?.path ?? href).replace(/\\/g, '/'))) return null;
  return artifact ? (
    <GeneratedMediaFiles
      sessionId={sessionId}
      paths={[artifact.path]}
      taskLabel={artifact.title}
      inline
    />
  ) : (
    fallback
  );
}

export function generatedMediaPaths(
  toolName: string,
  response?: ToolResponseMessageContent
): string[] {
  if (!['generate_image', 'generate_video'].includes(toolName.split(/__|::/).pop() ?? ''))
    return [];
  const receipt = generatedMediaReceipt(response);
  return mediaOutputPaths(receipt);
}

export function mediaOutputPaths(receipt?: Record<string, unknown>): string[] {
  if (receipt?.status !== 'completed') return [];
  const entries = 'images' in receipt ? receipt.images : 'videos' in receipt ? receipt.videos : [];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((item) =>
    item && typeof item.path === 'string' && item.path.trim() ? [item.path] : []
  );
}

export function GeneratedMedia({
  sessionId,
  toolName,
  response,
}: {
  sessionId: string;
  toolName: string;
  response?: ToolResponseMessageContent;
}) {
  const paths = useMemo(() => generatedMediaPaths(toolName, response), [toolName, response]);
  return <GeneratedMediaFiles sessionId={sessionId} paths={paths} inline />;
}

export function GeneratedMediaFiles({
  sessionId,
  paths,
  inline = false,
  taskLabel,
  labels,
}: {
  sessionId: string;
  paths: string[];
  inline?: boolean;
  taskLabel?: string;
  labels?: Record<string, string>;
}) {
  return inline ? (
    <MediaTaskOutputs sessionId={sessionId} paths={paths} taskLabel={taskLabel} labels={labels} />
  ) : paths.length ? (
    <WorkspaceFileReferences sessionId={sessionId} content="" paths={paths} />
  ) : null;
}

const MediaTaskOutputs = memo(
  function MediaTaskOutputs({
    sessionId,
    paths,
    taskLabel,
    labels,
  }: {
    sessionId: string;
    paths: string[];
    taskLabel?: string;
    labels?: Record<string, string>;
  }) {
    const files = useWorkspaceFileReferences({
      sessionId,
      content: '',
      paths,
      retainVerified: true,
    });
    const [selected, setSelected] = useState<string>();
    const rail = useRef<ComponentRef<'span'>>(null);
    const index = Math.max(
      0,
      files.findIndex((file) => file.path === selected)
    );
    const file = files[index];
    const titleFor = (path: string) => {
      const name = path.replace(/\\/g, '/').split('/').pop()!;
      const normalized = path.replace(/\\/g, '/');
      const label =
        labels?.[path] ??
        Object.entries(labels ?? {}).find(([source]) =>
          source.replace(/\\/g, '/').endsWith('/' + normalized)
        )?.[1] ??
        taskLabel;
      return label ? `${label} / ${name}` : name;
    };
    const text = (en: string, cn: string, tw: string) =>
      selectNativeText(currentLocale, en, cn, tw);
    const choose = (next: number) => {
      const target = files[next];
      if (!target) return;
      setSelected(target.path);
      rail.current?.children[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    return files.length ? (
      <span
        className={`media-output-grid ${files.length > 1 ? 'media-gallery' : ''}`}
        role={files.length > 1 ? 'region' : undefined}
        aria-label={
          files.length > 1 ? text('Generated media', '生成的媒体', '生成的媒體') : undefined
        }
      >
        <span key={file.path} className="media-output">
          {file.media && (
            <WorkspaceMedia
              media={file.media}
              title={titleFor(file.path)}
              target={{ sessionId, filePath: file.path }}
            />
          )}
          <button
            type="button"
            className="mt-1 block max-w-full truncate text-xs text-text-secondary hover:text-text-primary"
            title={file.path}
            onClick={() => openWorkspaceFile({ sessionId, filePath: file.path })}
          >
            {titleFor(file.path)}
          </button>
        </span>
        {files.length > 1 && (
          <>
            <span className="media-gallery-controls">
              <button
                type="button"
                aria-label={text('Previous media', '上一个', '上一個')}
                disabled={index === 0}
                onClick={() => choose(index - 1)}
              >
                <ChevronLeft size={18} />
              </button>
              <span role="status" aria-live="polite">
                {index + 1} / {files.length}
              </span>
              <button
                type="button"
                aria-label={text('Next media', '下一个', '下一個')}
                disabled={index === files.length - 1}
                onClick={() => choose(index + 1)}
              >
                <ChevronRight size={18} />
              </button>
            </span>
            <span
              className="media-gallery-thumbnails"
              ref={rail}
              aria-label={text('Choose media', '选择媒体', '選擇媒體')}
            >
              {files.map((item, itemIndex) => (
                <button
                  type="button"
                  key={item.path}
                  aria-label={`${itemIndex + 1}: ${titleFor(item.path)}`}
                  aria-pressed={itemIndex === index}
                  title={titleFor(item.path)}
                  onClick={() => choose(itemIndex)}
                >
                  {item.media?.kind === 'image' ? (
                    <img src={item.media.url} alt="" loading="lazy" draggable={false} />
                  ) : (
                    item.media && <VideoFirstFrame key={item.media.url} src={item.media.url} />
                  )}
                  <span>{itemIndex + 1}</span>
                </button>
              ))}
            </span>
          </>
        )}
      </span>
    ) : (
      paths.map((path) => (
        <button
          key={path}
          type="button"
          className="underline text-sm"
          onClick={(event) =>
            openWorkspaceFile({
              sessionId,
              filePath: path,
              ...(event.ctrlKey || event.metaKey ? { action: 'open-external' as const } : {}),
            })
          }
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openWorkspaceFile({ sessionId, filePath: path, action: 'file-menu' });
          }}
        >
          {taskLabel ?? path.replace(/\\/g, '/').split('/').pop()}
        </button>
      ))
    );
  },
  (previous, next) =>
    previous.sessionId === next.sessionId &&
    previous.taskLabel === next.taskLabel &&
    JSON.stringify(previous.labels) === JSON.stringify(next.labels) &&
    previous.paths.length === next.paths.length &&
    previous.paths.every((path, index) => path === next.paths[index])
);
