import { WorkspaceOpenMenu } from './WorkspaceOpenMenu';
import { useEffect, useState } from 'react';
import { ArrowLeft, File, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';
import type { PanelDocument, PanelEntry, PanelLocalSelection } from './workspacePanelTypes';
import { WorkspaceCodePreview } from './WorkspaceCodePreview';
import { WorkspaceMedia } from './WorkspaceMedia';
import { WorkspaceDocument } from './WorkspaceDocument';
import MarkdownContent from '../components/MarkdownContent';

export function WorkspaceLocalFiles({ selection }: { selection: PanelLocalSelection }) {
  const intl = useIntl();
  const [directory, setDirectory] = useState('');
  const [file, setFile] = useState(selection.kind === 'file' ? selection.path : '');
  const [entries, setEntries] = useState<PanelEntry[]>([]);
  const [document, setDocument] = useState<PanelDocument>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const office = /\.(pdf|docx|xlsx|pptx)$/i.test(file);
  const relative = file || directory;
  const fullPath = `${selection.scope.root.replace(/[\\/]$/, '')}${relative ? '/' + relative : ''}`;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setDocument(undefined);
    setEntries([]);
    if (file && office) {
      setLoading(false);
      return;
    }
    void window.electron
      .workspacePanel(
        file
          ? { scope: selection.scope, action: 'read', path: file }
          : { scope: selection.scope, action: 'list', path: directory }
      )
      .then((reply) => {
        if (!active) return;
        setDocument(reply.document);
        setEntries(reply.entries ?? []);
        setTruncated(!!reply.truncated);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selection, directory, file, office, refresh]);
  const back = () => {
    if (file) setFile('');
    else setDirectory(directory.split(/[\\/]/).slice(0, -1).join('/'));
  };
  return (
    <section className="wb-local-files" aria-label={selection.name}>
      <div className="wb-toolbar wb-location">
        {selection.kind === 'directory' && (file || directory) && (
          <button className="wb-icon" title={intl.formatMessage(m.backToFolder)} onClick={back}>
            <ArrowLeft size={15} />
          </button>
        )}
        <FolderOpen size={15} className="shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate" title={fullPath}>
          {fullPath}
        </span>
        <button
          className="wb-icon"
          title={intl.formatMessage(m.refresh)}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw size={14} />
        </button>
        <WorkspaceOpenMenu scope={selection.scope} path={relative} />
      </div>
      {error && (
        <p role="alert" className="p-3 text-xs text-red-600">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status" className="wb-empty">
          {intl.formatMessage(m.loading)}
        </p>
      ) : file ? (
        office ? (
          <WorkspaceDocument
            key={`${file}:${refresh}`}
            scope={selection.scope}
            path={file}
            title={file.split(/[\\/]/).pop()!}
            showToolbar={false}
          />
        ) : document?.media ? (
          <div className="wb-media-preview">
            <WorkspaceMedia media={document.media} title={file} />
          </div>
        ) : document?.binary ? (
          <p className="wb-empty">{intl.formatMessage(m.binaryFile)}</p>
        ) : document ? (
          <div className="wb-file-preview">
            {/\.(md|mdx|markdown)$/i.test(file) ? (
              <MarkdownContent sessionId={selection.scope.sessionId} content={document.content} />
            ) : <WorkspaceCodePreview path={file} content={document.content} wrap />}
          </div>
        ) : null
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            {entries.map((entry) => (
              <button
                key={entry.path}
                className="wb-tree-entry"
                title={entry.name}
                disabled={entry.kind === 'link'}
                onClick={() => {
                  if (entry.kind === 'directory') {
                    setDirectory(entry.path);
                  } else setFile(entry.path);
                }}
              >
                {entry.kind === 'directory' ? (
                  <Folder size={16} className="shrink-0 text-amber-500" />
                ) : (
                  <File size={15} className="shrink-0 text-text-secondary" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {!entries.length && !error && (
              <p className="wb-empty">{intl.formatMessage(m.emptyFolder)}</p>
            )}
            {truncated && <p className="p-3 text-xs">{intl.formatMessage(m.searchLimit)}</p>}
          </div>
        </>
      )}
    </section>
  );
}
