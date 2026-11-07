import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { getAcpControlClient } from '../acp/acpConnection';

export function RuntimeUpdateNotice() {
  const intl = useIntl();
  const [restartRequired, setRestartRequired] = useState(false);
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const client = await getAcpControlClient();
        const status = await client.extMethod('_goose/unstable/runtime/status', {});
        if (active) setRestartRequired(status.restartRequired === true);
      } catch (error) {
        // A new renderer can be hot-reloaded over a pre-diagnostic backend.
        // Only its structured method-not-found response proves that mismatch.
        if (active && error && typeof error === 'object' && 'code' in error && error.code === -32601)
          setRestartRequired(true);
      }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  if (!restartRequired) return null;
  return <div role="status" data-runtime-update className="shrink-0 px-4 py-2 text-sm bg-background-secondary text-text-default border-b border-border-default">
    {intl.formatMessage({ id: 'runtime.sourceChanged', defaultMessage: 'The runtime has been updated. Finish active tasks, then close and restart CodeBuddy to load the changes.' })}
  </div>;
}
