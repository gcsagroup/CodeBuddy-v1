import { useState } from 'react';
import { ChevronDown, FolderOpen } from 'lucide-react';
import { useIntl } from '../i18n';
import { panelMessages as m } from './workspacePanelMessages';
import type { PanelScope } from './workspacePanelTypes';

export function WorkspaceOpenMenu({
  scope,
  path,
  reference,
  line,
}: {
  scope: PanelScope;
  path: string;
  reference?: boolean;
  line?: number;
}) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open(choose: boolean) {
    setBusy(true);
    setError('');
    try {
      await window.electron.workspacePanel({
        scope,
        action: 'open-target',
        path,
        reference,
        line,
        choose,
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wb-target-open">
      <div className="wb-open-button">
        <button
          disabled={busy}
          title={intl.formatMessage(m.openDocument)}
          aria-label={intl.formatMessage(m.openDocument)}
          onClick={() => void open(false)}
        >
          <FolderOpen size={16} />
        </button>
        <button
          disabled={busy}
          title={intl.formatMessage(m.openWith)}
          aria-label={intl.formatMessage(m.openWith)}
          onClick={() => void open(true)}
        >
          <ChevronDown size={12} />
        </button>
      </div>
      {error && (
        <div className="wb-open-error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label={intl.formatMessage(m.close)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
