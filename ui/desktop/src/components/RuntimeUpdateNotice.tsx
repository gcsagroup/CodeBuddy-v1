import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { getAcpControlClient } from '../acp/acpConnection';
import { ModelInventoryNotice, parseInventoryNotices, type InventoryNotice } from './ModelInventoryNotice';

export function RuntimeUpdateNotice() {
  const intl = useIntl();
  const [restartRequired, setRestartRequired] = useState(false);
  const [notices, setNotices] = useState<InventoryNotice[]>([]);
  const poll = useRef<() => Promise<void>>(async () => {});
  const inventoryRevision = useRef<unknown>(undefined);
  const refreshNotices = useCallback(() => poll.current(), []);
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const client = await getAcpControlClient();
        const status = await client.extMethod('_goose/unstable/runtime/status', {});
        if (active) {
          setRestartRequired(status.restartRequired === true);
          setNotices(parseInventoryNotices(status.modelInventory));
          if (typeof status.modelInventoryRevision === 'number' && status.modelInventoryRevision !== inventoryRevision.current) {
            inventoryRevision.current = status.modelInventoryRevision;
            window.dispatchEvent(new Event('codebuddy:model-inventory-updated'));
          }
        }
      } catch (error) {
        // A new renderer can be hot-reloaded over a pre-diagnostic backend.
        // Only its structured method-not-found response proves that mismatch.
        if (active && error && typeof error === 'object' && 'code' in error && error.code === -32601)
          setRestartRequired(true);
      }
      finally { pending = false; }
    };
    poll.current = refresh;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  return <>{restartRequired && <div role="status" data-runtime-update className="shrink-0 px-4 py-2 text-sm bg-background-secondary text-text-default border-b border-border-default">
    {intl.formatMessage({ id: 'runtime.sourceChanged', defaultMessage: 'The runtime has been updated. Finish active tasks, then close and restart CodeBuddy to load the changes.' })}
  </div>}<ModelInventoryNotice notices={notices} refresh={refreshNotices} /></>;
}
