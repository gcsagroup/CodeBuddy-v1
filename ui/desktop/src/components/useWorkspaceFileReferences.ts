import { useEffect, useMemo, useState } from 'react';
import { useAcpChatSessionSnapshot } from '../acp/chatSessionStore';
import type { PanelFileInfo } from '../workspace-panel/workspacePanelTypes';
import { fileIdentity } from './codepro/conversationChanges';

// These are navigation candidates, never evidence that a file was written or a task completed.
function fileReferenceCandidates(content: string): string[] {
  const prose = content.replace(/```[\s\S]*?(?:```|$)/g, '');
  const candidates = new Set<string>();
  for (const match of prose.matchAll(/`([^`\r\n]+)`|\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)) {
    const value = (match[1] ?? match[2]).trim();
    if (value.length > 1024 || value.includes('://') || !/\.[a-z\d]{1,12}$/i.test(value)) continue;
    candidates.add(value);
    if (candidates.size >= 12) break;
  }
  // Models also return a standalone media path inside a code block. Treat it only
  // as a candidate and let the main process verify its workspace and existence.
  for (const line of content.split(/\r?\n/)) {
    const value = line.trim();
    if (
      value.length <= 1024 &&
      /^(?:[a-z]:[\\/]|\/)[^\r\n]*\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(value)
    )
      candidates.add(value);
    if (candidates.size >= 12) break;
  }
  return [...candidates].slice(0, 12);
}

export function useWorkspaceFileReferences({
  sessionId,
  content,
  paths,
  excludePaths,
}: {
  sessionId?: string;
  content: string;
  paths?: string[];
  excludePaths?: string[];
}) {
  const snapshot = useAcpChatSessionSnapshot(sessionId ?? '');
  const session = snapshot?.session;
  const binding = session?.extension_data.workspaceBinding;
  const root =
    session?.extension_data.readonlyHistory ||
    binding === 'project_container' ||
    binding === 'root_container' ||
    binding === 'unbound'
      ? ''
      : (session?.working_dir ?? '');
  const candidates = useMemo(
    () => [...new Set([...(paths ?? []), ...fileReferenceCandidates(content)])].slice(0, 12),
    [content, paths]
  );
  const key = JSON.stringify([sessionId, root, candidates]);
  const [verified, setVerified] = useState<{ key: string; files: PanelFileInfo[] }>();
  useEffect(() => {
    if (!sessionId || !root || !candidates.length || !window.electron?.workspacePanel) return;
    let cancelled = false;
    void Promise.allSettled(
      candidates.map((path) =>
        window.electron.workspacePanel({
          scope: { sessionId, root },
          action: 'inspect',
          path,
        })
      )
    ).then((results) => {
      if (cancelled) return;
      const files = new Map<string, PanelFileInfo>();
      for (const result of results)
        if (result.status === 'fulfilled' && result.value?.file) {
          files.set(fileIdentity(result.value.file.path, root), result.value.file);
        }
      setVerified({ key, files: [...files.values()] });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, root, candidates, key]);
  const excluded = new Set(excludePaths?.map((path) => fileIdentity(path, root)));
  const files =
    verified?.key === key
      ? verified.files.filter((file) => !excluded.has(fileIdentity(file.path, root)))
      : [];
  return files;
}
