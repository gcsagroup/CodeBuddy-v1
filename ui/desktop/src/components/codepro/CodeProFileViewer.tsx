import { useEffect, useRef, useState } from 'react';
import { FileCode2, FileText, LoaderCircle, ChevronRight } from 'lucide-react';
import MarkdownContent from '../MarkdownContent';
import { FileChangeCount, FileChangeDiff, type FileChangeReceipt } from './CodeProFileChange';
import { defineMessages, useIntl } from '../../i18n';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

const i18n = defineMessages({
  noWorkspace: {
    id: 'codeProFileViewer.noWorkspace',
    defaultMessage: 'This session has no available working directory.',
  },
  readFailed: { id: 'codeProFileViewer.readFailed', defaultMessage: 'Could not read the file.' },
  empty: {
    id: 'codeProFileViewer.empty',
    defaultMessage: 'Files read or changed by this task will appear here.',
  },
  files: { id: 'codeProFileViewer.files', defaultMessage: 'CodePro files' },
  counts: {
    id: 'conversationFiles.changes',
    defaultMessage: 'Changes per operation (not a net workspace diff)',
  },
  reading: { id: 'codeProFileViewer.reading', defaultMessage: 'Reading file' },
});

interface CodeProFileViewerProps {
  files: string[];
  workspaceRoot?: string;
  changesForFile?: (path: string) => FileChangeReceipt[];
}

export function CodeProFileViewer({
  files,
  workspaceRoot,
  changesForFile,
}: CodeProFileViewerProps) {
  const intl = useIntl();
  const [selectedFile, setSelectedFile] = useState<string>();
  const [content, setContent] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const readSequence = useRef(0);
  useEffect(() => {
    // A pending read from another workspace must never populate this view.
    readSequence.current += 1;
    setSelectedFile(undefined);
    setContent('');
    setError(undefined);
    setLoading(false);
    return () => {
      readSequence.current += 1;
    };
  }, [workspaceRoot]);
  const displayPath = (filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/');
    const root = workspaceRoot?.replace(/\\/g, '/').replace(/\/$/, '');
    const windows = /^[A-Za-z]:\//.test(root ?? '');
    const candidate = windows ? normalized.toLowerCase() : normalized;
    const prefix = windows ? root?.toLowerCase() : root;
    return prefix && candidate.startsWith(`${prefix}/`)
      ? normalized.slice(prefix.length + 1)
      : normalized;
  };

  const openFile = async (filePath: string) => {
    if (changesForFile?.(filePath).length) {
      // Saved write evidence is independent of the file's current on-disk contents.
      readSequence.current += 1;
      setSelectedFile(filePath);
      setLoading(false);
      setError(undefined);
      setContent('');
      return;
    }
    if (!workspaceRoot) {
      readSequence.current += 1;
      setSelectedFile(filePath);
      setLoading(false);
      setError(intl.formatMessage(i18n.noWorkspace));
      return;
    }

    const sequence = ++readSequence.current;
    setSelectedFile(filePath);
    setLoading(true);
    setError(undefined);
    try {
      const response = await window.electron.readWorkspaceFile(workspaceRoot, filePath);
      if (sequence !== readSequence.current) return;
      setLoading(false);
      if (!response.found) {
        setContent('');
        setError(response.error || intl.formatMessage(i18n.readFailed));
        return;
      }
      setContent(response.file);
    } catch {
      if (sequence !== readSequence.current) return;
      setLoading(false);
      setContent('');
      setError(intl.formatMessage(i18n.readFailed));
    }
  };

  if (files.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border-primary p-4 text-sm text-text-secondary">
        {intl.formatMessage(i18n.empty)}
      </div>
    );
  }

  const closeFile = () => {
    readSequence.current += 1;
    setSelectedFile(undefined);
    setLoading(false);
    setError(undefined);
  };

  return (
    <ul className="min-w-0" aria-label={intl.formatMessage(i18n.files)}>
      {files.map((filePath) => {
        const Icon = /\.mdx?$/i.test(filePath) ? FileText : FileCode2;
        const fileChanges = changesForFile?.(filePath) ?? [];
        const totals = fileChanges.reduce(
          (total, change) => ({
            added: total.added + change.added,
            removed: total.removed + change.removed,
          }),
          { added: 0, removed: 0 }
        );
        const open = selectedFile === filePath;
        return (
          <Collapsible
            key={filePath}
            open={open}
            onOpenChange={(next) => (next ? void openFile(filePath) : closeFile())}
            asChild
          >
            <li className="min-w-0">
              <CollapsibleTrigger
                type="button"
                className="flex w-full items-center gap-1.5 rounded-[10px] px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:text-text-primary"
                aria-label={filePath}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate" title={filePath}>
                  {displayPath(filePath)}
                </span>
                <span className="shrink-0" aria-hidden="true">
                  {' '}
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  />
                </span>
                {fileChanges.length > 0 && (
                  <span className="ml-auto" title={intl.formatMessage(i18n.counts)}>
                    <FileChangeCount change={totals} />
                  </span>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="codepro-disclosure-content">
                <div className="max-h-[28rem] overflow-auto border-t border-border-subtle px-3 py-2">
                  {fileChanges.length > 0 ? (
                    <div className="space-y-2">
                      {fileChanges.map((change, index) => (
                        <FileChangeDiff key={index} change={change} />
                      ))}
                    </div>
                  ) : loading ? (
                    <div
                      role="status"
                      className="flex items-center gap-2 text-sm text-text-secondary"
                    >
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                      {intl.formatMessage(i18n.reading)}
                    </div>
                  ) : error ? (
                    <p role="alert" className="text-sm text-red-600">
                      {error}
                    </p>
                  ) : /\.mdx?$/i.test(filePath) ? (
                    <div className="text-sm">
                      <MarkdownContent content={content} />
                    </div>
                  ) : (
                    <pre className="overflow-auto whitespace-pre font-mono text-xs leading-5 text-text-primary">
                      <code className="block min-w-max">
                        {content.split('\n').map((line, index) => (
                          <span key={index} className="flex">
                            <span
                              className="min-w-[4ch] shrink-0 select-none pr-3 text-right opacity-60"
                              aria-hidden="true"
                            >
                              {index + 1}
                            </span>
                            <span>{line || ' '}</span>
                          </span>
                        ))}
                      </code>
                    </pre>
                  )}
                </div>
              </CollapsibleContent>
            </li>
          </Collapsible>
        );
      })}
    </ul>
  );
}
