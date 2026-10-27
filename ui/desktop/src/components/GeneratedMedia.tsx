import { useMemo } from 'react';
import type { ToolResponseMessageContent } from '../types/message';
import { WorkspaceFileReferences } from './WorkspaceFileReferences';
import { generatedMediaReceipt } from '../utils/mediaToolReceipt';

export function generatedMediaPaths(
  toolName: string,
  response?: ToolResponseMessageContent
): string[] {
  if (!['generate_image', 'generate_video'].includes(toolName.split(/__|::/).pop() ?? ''))
    return [];
  const receipt = generatedMediaReceipt(response);
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
  return paths.length ? (
    <WorkspaceFileReferences sessionId={sessionId} content="" paths={paths} />
  ) : null;
}
