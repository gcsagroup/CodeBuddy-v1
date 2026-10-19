import { useEffect, useMemo, useState } from 'react';
import { File } from 'lucide-react';
import { useAcpChatSessionSnapshot } from '../acp/chatSessionStore';
import { useIntl } from '../i18n';
import { panelMessages } from '../workspace-panel/workspacePanelMessages';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';
import type { PanelFileInfo } from '../workspace-panel/workspacePanelTypes';

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
  return [...candidates];
}

export function WorkspaceFileReferences({
  sessionId,
  content,
}: {
  sessionId: string;
  content: string;
}) {
  const intl = useIntl();
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
  const candidates = useMemo(() => fileReferenceCandidates(content), [content]);
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
    <section
      className="my-3 rounded-xl border border-border-primary"
      aria-label={intl.formatMessage(panelMessages.relatedFiles)}
    >
      <div className="px-3 py-2 text-sm text-text-secondary">
        {intl.formatMessage(panelMessages.relatedFiles)}
      </div>
      {verified.files.map((file) => (
        <button
          key={file.path}
          type="button"
          title={file.path}
          className="flex w-full min-w-0 items-center gap-2 border-t border-border-primary px-3 py-2 text-left text-sm hover:bg-background-secondary"
          onClick={() => openWorkspaceFile({ sessionId, filePath: file.path })}
        >
          <File size={16} className="shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate underline underline-offset-2">
            {file.path.replace(/\\/g, '/').split('/').pop()}
          </span>
          <span className="shrink-0 text-xs text-text-secondary">
            {intl.formatNumber(file.size)} B
          </span>
        </button>
      ))}
    </section>
  );
}
