import { useMemo } from 'react';
import type { ToolResponseMessageContent } from '../types/message';
import { WorkspaceFileReferences } from './WorkspaceFileReferences';

// Read the tool's receipt, never infer successful generation from assistant prose.
export function generatedMediaPaths(
  toolName: string,
  response?: ToolResponseMessageContent
): string[] {
  if (!['generate_image', 'generate_video'].includes(toolName)) return [];
  const result = response?.toolResult;
  if (
    result?.status !== 'success' ||
    !result.value ||
    typeof result.value !== 'object' ||
    Array.isArray(result.value)
  )
    return [];
  const value = result.value as Record<string, unknown>;
  if (value.isError) return [];
  let receipt: unknown = value.structuredContent;
  if (!receipt) {
    const text = Array.isArray(value.content)
      ? value.content.find(
          (item) => item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text'
        )
      : undefined;
    if (text && typeof text === 'object' && !Array.isArray(text) && typeof text.text === 'string') {
      try {
        receipt = JSON.parse(text.text);
      } catch {
        return [];
      }
    }
  }
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('status' in receipt) ||
    receipt.status !== 'completed'
  )
    return [];
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
