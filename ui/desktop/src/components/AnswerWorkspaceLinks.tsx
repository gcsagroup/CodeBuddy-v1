import { useMemo } from 'react';
import { useIntl } from '../i18n';
import { openWorkspaceFile, workspaceLinkPath } from '../workspace-panel/workspaceFilePanel';
import { useWorkspaceFileReferences } from './useWorkspaceFileReferences';

// These are navigation hints. Only the main process can resolve a candidate to
// a file in this session. A filename in a prompt never establishes a write.
export function requestedFileReferences(text: string): string[] {
  const paths = new Set<string>();
  const candidates = /(?:「([^」\n]+)」|`([^`\n]+)`|“([^”\n]+)”|"([^"\n]+)"|([^\s，。；、：「」“”"`<>()[\]]+\.(?:docx|xlsx|pptx|pdf|txt)))/giu;
  for (const match of text.matchAll(candidates)) {
    const path = match.slice(1).find(Boolean)!;
    if (/\.[\w]{1,10}$/u.test(path) && path.length <= 1024 && !path.includes('://')) paths.add(path);
    if (paths.size >= 12) break;
  }
  return [...paths];
}

export function AnswerWorkspaceLinks({ sessionId, request, answer }: {
  sessionId: string; request: string; answer: string;
}) {
  const intl = useIntl();
  const paths = useMemo(() => requestedFileReferences(request), [request]);
  const excluded = useMemo(() => [...answer.matchAll(/\]\(\s*(?:<([^<>\n]+)>|([^()\s]+))\s*\)/g)]
    .flatMap(match => workspaceLinkPath(match[1] ?? match[2]) ?? []), [answer]);
  const files = useWorkspaceFileReferences({ sessionId, content: '', paths, excludePaths: excluded });
  if (!files.length) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
    <span className="text-text-secondary">{intl.formatMessage({ id: 'workspacePanel.files', defaultMessage: 'Workspace files' })}</span>
    {files.map(file => <a key={file.path} href={file.path.replace(/\\/g, '/')} className="break-all underline"
      onClick={event => {
        event.preventDefault();
        openWorkspaceFile({ sessionId, filePath: file.path, ...(event.ctrlKey || event.metaKey ? { action: 'open-external' as const } : {}) });
      }}>{file.path.replace(/\\/g, '/').split('/').pop()}</a>)}
  </div>;
}
