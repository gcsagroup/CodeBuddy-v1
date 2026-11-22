import { useState } from 'react';
import { useIntl } from 'react-intl';
import { getAcpControlClient } from '../acp/acpConnection';

type Change = { kind: 'removed' | 'capabilities'; model: string; fields?: string[] };
export type InventoryNotice = { providerId: string; providerName: string; noticeId?: string; failed?: boolean; changes: Change[] };

export function parseInventoryNotices(value: unknown): InventoryNotice[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is InventoryNotice => item && typeof item === 'object' &&
    typeof item.providerId === 'string' && typeof item.providerName === 'string' &&
    (item.noticeId === undefined || typeof item.noticeId === 'string') &&
    (item.failed === undefined || typeof item.failed === 'boolean') &&
    Array.isArray(item.changes) && item.changes.every((change: Change) => change &&
      ['removed', 'capabilities'].includes(change.kind) && typeof change.model === 'string' &&
      (change.fields === undefined || Array.isArray(change.fields) && change.fields.every(field => typeof field === 'string'))));
}

export function ModelInventoryNotice({ notices, refresh }: { notices: InventoryNotice[]; refresh: () => Promise<void> }) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!notices.length) return null;
  const action = async (notice: InventoryNotice, retry: boolean) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      const client = await getAcpControlClient();
      await client.extMethod(retry ? '_goose/unstable/providers/inventory/refresh' : '_goose/unstable/providers/inventory/acknowledge',
        retry ? { providerIds: [notice.providerId] } : { providerId: notice.providerId, noticeId: notice.noticeId });
      await refresh();
      window.dispatchEvent(new Event('codebuddy:model-inventory-updated'));
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const labels: Record<string, string> = {
    context: intl.formatMessage({ id: 'modelInventory.context', defaultMessage: 'context capacity' }),
    output: intl.formatMessage({ id: 'modelInventory.output', defaultMessage: 'output limit' }),
    image: intl.formatMessage({ id: 'modelInventory.image', defaultMessage: 'image input' }),
    thinking: intl.formatMessage({ id: 'modelInventory.thinking', defaultMessage: 'thinking options' }),
    tools: intl.formatMessage({ id: 'modelInventory.tools', defaultMessage: 'tool calling' }),
  };
  return <section role="alert" style={window.electron?.platform === 'darwin' ? { paddingTop: 32 } : undefined} className="shrink-0 max-h-60 overflow-y-auto border-b border-border-default bg-background-secondary px-4 py-3 text-sm text-text-default">
    <strong>{intl.formatMessage({ id: 'modelInventory.title', defaultMessage: 'Model connection updates' })}</strong>
    <p>{intl.formatMessage({ id: 'modelInventory.preserved', defaultMessage: 'Your selected model has not been changed. If it is unavailable, choose another model manually from the model menu.' })}</p>
    {notices.map(notice => <div key={notice.providerId} className="mt-2">
      <strong>{notice.providerName}</strong>
      {notice.failed && <p>{intl.formatMessage({ id: 'modelInventory.failed', defaultMessage: 'Could not refresh this connection. Keeping the last saved list; this does not mean its models were removed.' })}</p>}
      <ul>{notice.changes.map(change => <li key={`${change.kind}:${change.model}`}>
        {change.kind === 'removed'
          ? intl.formatMessage({ id: 'modelInventory.removed', defaultMessage: '{model} is no longer in the provider model list. It may have been removed or access may have changed.' }, { model: change.model })
          : intl.formatMessage({ id: 'modelInventory.changed', defaultMessage: '{model}: the provider changed {fields}. Review the model settings before continuing.' },
            { model: change.model, fields: (change.fields ?? []).map(field => labels[field] ?? field).join(', ') })}
      </li>)}</ul>
      <button disabled={busy} className="mt-1 mr-4 underline" onClick={() => void action(notice, true)}>{intl.formatMessage({ id: 'modelInventory.retry', defaultMessage: 'Refresh again' })}</button>
      {!!notice.noticeId && notice.changes.length > 0 && <button disabled={busy} className="underline" onClick={() => void action(notice, false)}>{intl.formatMessage({ id: 'modelInventory.acknowledge', defaultMessage: 'Dismiss changes' })}</button>}
    </div>)}
    {failed && <p>{intl.formatMessage({ id: 'modelInventory.actionFailed', defaultMessage: 'The action failed. Your model selection was not changed. Try again.' })}</p>}
  </section>;
}
