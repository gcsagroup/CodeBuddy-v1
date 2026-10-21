import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, File } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { useAcpChatSessionSnapshot } from '../acp/chatSessionStore';
import { useIntl } from '../i18n';
import { panelMessages } from '../workspace-panel/workspacePanelMessages';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';
import type { PanelFileInfo } from '../workspace-panel/workspacePanelTypes';
import { WorkspaceMedia } from '../workspace-panel/WorkspaceMedia';

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

export function WorkspaceFileReferences({
  sessionId,
  content,
  paths,
}: {
  sessionId: string;
  content: string;
  paths?: string[];
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  const snapshot = useAcpChatSessionSnapshot(sessionId);
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
    if (!root || !candidates.length || !window.electron?.workspacePanel) return;
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
          files.set(result.value.file.path, result.value.file);
        }
      setVerified({ key, files: [...files.values()] });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, root, candidates, key]);
  if (verified?.key !== key || !verified.files.length) return null;
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="mb-3 mt-4 overflow-hidden rounded-2xl border border-border-subtle"
      aria-label={intl.formatMessage(panelMessages.relatedFiles)}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm text-text-primary">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background-secondary"
          aria-hidden="true"
        >
          <File className="size-5" />
        </span>
        <span className="flex items-center gap-1.5 font-semibold">
          {intl.formatMessage(panelMessages.relatedFiles)}
          <ChevronRight
            className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="codepro-disclosure-content border-t border-border-subtle py-1">
        {verified.files.map((file) => (
          <button
            key={file.path}
            type="button"
            title={file.path}
            className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left text-sm text-text-secondary hover:text-text-primary"
            onClick={() => openWorkspaceFile({ sessionId, filePath: file.path })}
          >
            {file.media ? (
              <span className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <WorkspaceMedia
                  media={file.media}
                  title={file.path.replace(/\\/g, '/').split('/').pop()!}
                  thumbnail
                />
                <span>
                  {intl.formatMessage(panelMessages.previewMedia)} ·{' '}
                  {file.path.replace(/\\/g, '/').split('/').pop()}
                </span>
              </span>
            ) : (
              <File size={16} className="shrink-0 text-text-secondary" />
            )}
            {!file.media && (
              <span className="min-w-0 flex-1 truncate">
                {file.path.replace(/\\/g, '/').split('/').pop()}
              </span>
            )}
            <span className="shrink-0 text-xs text-text-secondary">
              {intl.formatNumber(file.size)} B
            </span>
          </button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
