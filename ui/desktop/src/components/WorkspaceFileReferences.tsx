import { useState } from 'react';
import { ChevronRight, File } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { useIntl } from '../i18n';
import { panelMessages } from '../workspace-panel/workspacePanelMessages';
import { openWorkspaceFile } from '../workspace-panel/workspaceFilePanel';
import { WorkspaceMedia } from '../workspace-panel/WorkspaceMedia';
import { useWorkspaceFileReferences } from './useWorkspaceFileReferences';

export function WorkspaceFileReferences({
  sessionId,
  content,
  paths,
  excludePaths,
}: {
  sessionId: string;
  content: string;
  paths?: string[];
  excludePaths?: string[];
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(true);
  const files = useWorkspaceFileReferences({ sessionId, content, paths, excludePaths });
  if (!files.length) return null;
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
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            title={file.path}
            className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left text-sm text-text-secondary hover:text-text-primary"
            onClick={(event) =>
              openWorkspaceFile({
                sessionId,
                filePath: file.path,
                ...(event.ctrlKey || event.metaKey ? { action: 'open-external' as const } : {}),
              })
            }
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openWorkspaceFile({ sessionId, filePath: file.path, action: 'file-menu' });
            }}
          >
            {file.media ? (
              <span className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <WorkspaceMedia
                  media={file.media}
                  title={file.path.replace(/\\/g, '/').split('/').pop()!}
                  thumbnail
                  target={{ sessionId, filePath: file.path }}
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
