import { memo, useMemo } from 'react';
import type { ToolResponseMessageContent } from '../types/message';
import { WorkspaceFileReferences } from './WorkspaceFileReferences';
import { generatedMediaReceipt } from '../utils/mediaToolReceipt';
import { useWorkspaceFileReferences } from './useWorkspaceFileReferences';
import { WorkspaceMedia } from '../workspace-panel/WorkspaceMedia';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';

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
  return <GeneratedMediaFiles sessionId={sessionId} paths={paths} />;
}

export function GeneratedMediaFiles({
  sessionId,
  paths,
  inline = false,
}: {
  sessionId: string;
  paths: string[];
  inline?: boolean;
}) {
  return inline ? (
    <MediaTaskOutputs sessionId={sessionId} paths={paths} />
  ) : paths.length ? (
    <WorkspaceFileReferences sessionId={sessionId} content="" paths={paths} />
  ) : null;
}

const MediaTaskOutputs = memo(
  function MediaTaskOutputs({ sessionId, paths }: { sessionId: string; paths: string[] }) {
    const files = useWorkspaceFileReferences({ sessionId, content: '', paths });
    return files.length ? (
      <div className="ml-6 my-2 grid max-w-xl gap-3">
        {files.map((file) => {
          const title = file.path.replace(/\\/g, '/').split('/').pop()!;
          return (
            <div
              key={file.path}
              className="min-w-0 [&_img]:!max-h-[28rem] [&_video]:!max-h-[28rem]"
            >
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
            </div>
          );
        })}
      </div>
    ) : null;
  },
  (previous, next) =>
    previous.sessionId === next.sessionId &&
    previous.paths.length === next.paths.length &&
    previous.paths.every((path, index) => path === next.paths[index])
);
