import { WorkspaceOpenMenu } from './WorkspaceOpenMenu';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';
import type { PanelDocumentPreview, PanelScope } from './workspacePanelTypes';
import {
  DshDocumentRenderer,
  loadDshDocumentRenderer,
  type DocumentView,
} from './dshDocumentRenderer';
import './workspaceDocument.css';

type Loaded = {
  preview: PanelDocumentPreview;
  renderer: Awaited<ReturnType<typeof loadDshDocumentRenderer>>;
  signal: AbortSignal;
};
export function WorkspaceDocument({
  scope,
  path,
  title,
  view,
  onViewChange,
  reference,
  showToolbar = true,
}: {
  scope: PanelScope;
  path: string;
  title: string;
  view?: DocumentView;
  onViewChange?: (view: DocumentView) => void;
  reference?: boolean;
  showToolbar?: boolean;
}) {
  const intl = useIntl();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [localView, setLocalView] = useState<DocumentView>({ page: 1 });
  useEffect(() => {
    const lifetime = new AbortController();
    const requestId = globalThis.crypto.randomUUID();
    setLoading(true);
    setFailed(false);
    const kind = /\.xlsx$/i.test(path) ? 'excel' : 'pdf';
    void Promise.all([
      loadDshDocumentRenderer(kind),
      window.electron.workspacePanel({
        scope,
        action: 'document-preview',
        path,
        requestId,
        reference,
      }),
    ])
      .then(([renderer, reply]) => {
        if (lifetime.signal.aborted) return;
        if (!reply?.documentPreview || reply.documentPreview.kind !== kind)
          throw new Error('Missing document preview');
        setLoaded({
          renderer,
          preview: { ...reply.documentPreview, data: new Uint8Array(reply.documentPreview.data) },
          signal: lifetime.signal,
        });
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!lifetime.signal.aborted) setLoading(false);
      });
    return () => {
      lifetime.abort();
      void window.electron
        .workspacePanel({ scope, action: 'document-preview-cancel', requestId })
        .catch(() => {});
    };
  }, [scope, path, attempt, reference]);
  const progress = (
    <p
      className="flex h-full items-center justify-center p-4 text-sm text-text-secondary"
      role="status"
    >
      {intl.formatMessage(m.loading)}
    </p>
  );
  return (
    <section className="codebuddy-document flex min-h-0 min-w-0 flex-1 flex-col">
      {showToolbar && (
        <div className="wb-toolbar">
          <span className="min-w-0 flex-1 truncate" title={path}>
            {title}
          </span>
          <button
            className="wb-icon"
            title={intl.formatMessage(m.reload)}
            aria-label={intl.formatMessage(m.reload)}
            disabled={loading}
            onClick={() => setAttempt(attempt + 1)}
          >
            <RefreshCw size={15} />
          </button>
          <WorkspaceOpenMenu scope={scope} path={path} reference={reference} />
        </div>
      )}
      {failed ? (
        <p className="p-4 text-sm text-text-secondary" role="alert">
          {intl.formatMessage(m.documentPreviewFailed)}
        </p>
      ) : loading ? (
        progress
      ) : (
        loaded && (
          <div className="min-h-0 flex-1">
            <DshDocumentRenderer
              renderer={loaded.renderer}
              kind={loaded.preview.kind}
              data={loaded.preview.data as Uint8Array<ArrayBuffer>}
              locale={intl.locale}
              id={path}
              signal={loaded.signal}
              loading={progress}
              view={view ?? localView}
              onViewChange={onViewChange ?? setLocalView}
            />
          </div>
        )
      )}
      {!!loaded?.preview.missingFonts.length && (
        <p className="p-2 text-xs text-text-secondary">
          {intl.formatMessage(m.documentMissingFonts)}
        </p>
      )}
    </section>
  );
}
