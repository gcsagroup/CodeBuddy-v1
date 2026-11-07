import { memo, useMemo, createContext, useContext, type ReactNode } from 'react';
import type { ToolResponseMessageContent } from '../types/message';
import { WorkspaceFileReferences } from './WorkspaceFileReferences';
import { generatedMediaReceipt } from '../utils/mediaToolReceipt';
import { useWorkspaceFileReferences } from './useWorkspaceFileReferences';
import { WorkspaceMedia } from '../workspace-panel/WorkspaceMedia';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';
import { useMediaJobs, resolveMediaOutput } from '../workspace-panel/WorkspaceGeneration';

const DeliveredMediaContext = createContext<ReadonlySet<string>>(new Set());
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
  return entries
    .flatMap((item) => (item && typeof item.path === 'string' ? [item.path] : []))
    .slice(0, 8);
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
}: {
  sessionId: string;
  paths: string[];
  inline?: boolean;
  taskLabel?: string;
}) {
  return inline ? (
    <MediaTaskOutputs sessionId={sessionId} paths={paths} taskLabel={taskLabel} />
  ) : paths.length ? (
    <WorkspaceFileReferences sessionId={sessionId} content="" paths={paths} />
  ) : null;
}

const MediaTaskOutputs = memo(
  function MediaTaskOutputs({
    sessionId,
    paths,
    taskLabel,
  }: {
    sessionId: string;
    paths: string[];
    taskLabel?: string;
  }) {
    const files = useWorkspaceFileReferences({ sessionId, content: '', paths });
    return files.length ? (
      <span className="media-output-grid">
        {files.map((file) => {
          const filename = file.path.replace(/\\/g, '/').split('/').pop()!;
          const title = taskLabel ? `${taskLabel} / ${filename}` : filename;
          return (
            <span key={file.path} className="media-output">
              {file.media && (
                <WorkspaceMedia
                  media={file.media}
                  title={title}
                  target={{ sessionId, filePath: file.path }}
                />
              )}
              <button
                type="button"
                className="mt-1 block max-w-full truncate text-xs text-text-secondary hover:text-text-primary"
                title={file.path}
                onClick={() => openWorkspaceFile({ sessionId, filePath: file.path })}
              >
                {title}
              </button>
            </span>
          );
        })}
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
    previous.paths.length === next.paths.length &&
    previous.paths.every((path, index) => path === next.paths[index])
);
