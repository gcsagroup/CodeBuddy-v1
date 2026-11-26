import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bell, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';
import { selectNativeText } from '../utils/nativeLocalization';
import './model-inventory-notice.css';
import { useIntl } from 'react-intl';
import { getAcpControlClient } from '../acp/acpConnection';
import { connectionMessages, connectionNetworkReason } from './settings/providers/connectionMessages';

type Change = { kind: 'removed' | 'capabilities'; model: string; fields?: string[] };
export type InventoryNotice = { providerId: string; providerName: string; noticeId?: string; failed?: boolean; loading?: boolean; httpStatus?: number; errorCode?: string; networkCode?: string; changes: Change[] };

export function parseInventoryNotices(value: unknown): InventoryNotice[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is InventoryNotice => item && typeof item === 'object' &&
    typeof item.providerId === 'string' && typeof item.providerName === 'string' &&
    (item.noticeId === undefined || typeof item.noticeId === 'string') &&
    (item.failed === undefined || typeof item.failed === 'boolean') &&
    (item.loading === undefined || typeof item.loading === 'boolean') &&
    Array.isArray(item.changes) && item.changes.every((change: Change) => change &&
      ['removed', 'capabilities'].includes(change.kind) && typeof change.model === 'string' &&
      (change.fields === undefined || Array.isArray(change.fields) && change.fields.every(field => typeof field === 'string'))));
}

export function ModelInventoryNotice({ notices, refresh }: { notices: InventoryNotice[]; refresh: () => Promise<void> }) {
  const intl = useIntl();
  const [actions, setActions] = useState<Record<string, { pending: boolean; message?: string; at?: number; error?: boolean }>>({});
  const pendingActions = useRef(new Set<string>());
  const busy = Object.values(actions).some(action => action.pending);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [toast, setToast] = useState<InventoryNotice[]>([]);
  const [toastHovered, setToastHovered] = useState(false);
  const [toastFocused, setToastFocused] = useState(false);
  const toastPaused = toastHovered || toastFocused;
  const previousNotices = useRef(new Map<string, string>());
  const root = useRef<HTMLDivElement>(null);
  // Polls create new objects; only meaningful notification changes should announce.
  const notificationState = JSON.stringify(notices.map(notice => ({
    providerId: notice.providerId, providerName: notice.providerName, noticeId: notice.noticeId,
    failed: notice.failed === true, loading: notice.loading === true,
    httpStatus: notice.httpStatus, errorCode: notice.errorCode, networkCode: notice.networkCode,
    changes: notice.changes,
  })));
  useEffect(() => {
    const current = new Map<string, string>();
    const incoming: InventoryNotice[] = [];
    const snapshot: InventoryNotice[] = JSON.parse(notificationState);
    for (const notice of snapshot) {
      const prior = previousNotices.current.get(notice.providerId);
      if (!notice.failed && !notice.changes.length) {
        if (notice.loading && prior) current.set(notice.providerId, prior);
        continue;
      }
      const key = JSON.stringify([notice.noticeId, notice.failed, notice.httpStatus,
        notice.errorCode, notice.networkCode, notice.changes]);
      current.set(notice.providerId, key);
      if (key !== prior) incoming.push(notice);
    }
    previousNotices.current = current;
    if (!snapshot.length || !collapsed) setToast([]);
    else if (incoming.length) setToast(incoming);
    else setToast(previous => {
      const remaining = previous.filter(notice => current.has(notice.providerId));
      return remaining.length === previous.length ? previous : remaining;
    });
  }, [notificationState, collapsed]);
  useEffect(() => {
    if (!toast.length || toastPaused) return;
    const timer = window.setTimeout(() => setToast([]), 5000);
    return () => window.clearTimeout(timer);
  }, [toast, toastPaused]);
  useEffect(() => {
    if (!toast.length) { setToastHovered(false); setToastFocused(false); }
  }, [toast.length]);
  useEffect(() => {
    if (!collapsed || !toast.length) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') {
      if (root.current?.contains(document.activeElement)) root.current.querySelector<HTMLButtonElement>('button')?.focus();
      setToast([]);
    } };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [collapsed, toast.length]);
  useEffect(() => {
    if (!notices.length) setCollapsed(true);
  }, [notices.length]);
  useEffect(() => {
    if (collapsed) return;
    const closeOutside = (event: globalThis.PointerEvent) => { if (!root.current?.contains(event.target as Node)) setCollapsed(true); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setCollapsed(true); root.current?.querySelector<HTMLButtonElement>('button')?.focus(); } };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [collapsed]);
  if (!notices.length) return null;
  const removed = notices.some(notice => notice.changes.some(change => change.kind === 'removed'));
  const refreshFailed = notices.some(notice => notice.failed);
  const loading = busy || notices.some(notice => notice.loading);
  const onlyLoading = !removed && !refreshFailed && loading;
  const title = onlyLoading ? selectNativeText(intl.locale, 'Refreshing model connections', '正在刷新模型连接', '正在重新整理模型連線') : removed
    ? intl.formatMessage({ id: 'modelInventory.reviewTitle', defaultMessage: 'Some models are no longer listed' })
    : refreshFailed
      ? intl.formatMessage({ id: 'modelInventory.refreshTitle', defaultMessage: 'Model list could not be refreshed' })
      : intl.formatMessage({ id: 'modelInventory.capabilityTitle', defaultMessage: 'Model capabilities have changed' });
  const summary = onlyLoading ? selectNativeText(intl.locale, 'Checking model lists and capabilities. You can keep working.', '正在检查模型列表与能力，你可以继续操作。', '正在檢查模型清單與能力，你可以繼續操作。') : refreshFailed && !removed
    ? intl.formatMessage({ id: 'modelInventory.refreshSummary', defaultMessage: 'Keeping the saved model list. This does not mean models were removed.' })
    : intl.formatMessage({ id: 'modelInventory.selectionSummary', defaultMessage: 'Your model selection is unchanged. Review the details before continuing.' });
  const detailsLabel = intl.formatMessage({ id: 'modelInventory.details', defaultMessage: 'View details' });
  const action = async (notice: InventoryNotice, retry: boolean) => {
    if (pendingActions.current.has(notice.providerId)) return;
    pendingActions.current.add(notice.providerId);
    setActions(previous => ({ ...previous, [notice.providerId]: { pending: true } }));
    let result: { pending: boolean; message?: string; at?: number; error?: boolean };
    try {
      const client = await getAcpControlClient();
      await client.extMethod(retry ? '_goose/unstable/providers/inventory/refresh' : '_goose/unstable/providers/inventory/acknowledge',
        retry ? { providerIds: [notice.providerId] } : { providerId: notice.providerId, noticeId: notice.noticeId });
      result = { pending: false, at: Date.now(), message: retry
        ? selectNativeText(intl.locale, 'Refresh completed', '本次刷新完成', '本次重新整理完成')
        : selectNativeText(intl.locale, 'Changes dismissed', '已确认变化', '已確認變更') };
    } catch {
      result = { pending: false, error: true, at: Date.now(), message: retry
        ? selectNativeText(intl.locale, 'Retry failed. Check the connection details above before retrying.', '本次重试失败，请检查上方连接原因后再试。', '本次重試失敗，請檢查上方連線原因後再試。')
        : selectNativeText(intl.locale, 'Could not dismiss changes. Try again.', '未能确认变化，请重试。', '未能確認變更，請重試。') };
    }
    // A failed discovery still updates the server-owned diagnostic state.
    try { await refresh(); }
    catch { result = { pending: false, error: true, at: Date.now(), message: selectNativeText(intl.locale,
      'Could not retrieve the latest result. The details above may be outdated.',
      '未能获取最新结果，上方详情可能仍是旧状态。', '未能取得最新結果，上方詳情可能仍是舊狀態。') }; }
    finally {
      pendingActions.current.delete(notice.providerId);
      setActions(previous => ({ ...previous, [notice.providerId]: result }));
      window.dispatchEvent(new Event('codebuddy:model-inventory-updated'));
    }
  };
  const labels: Record<string, string> = {
    context: intl.formatMessage({ id: 'modelInventory.context', defaultMessage: 'context capacity' }),
    output: intl.formatMessage({ id: 'modelInventory.output', defaultMessage: 'output limit' }),
    image: intl.formatMessage({ id: 'modelInventory.image', defaultMessage: 'image input' }),
    thinking: intl.formatMessage({ id: 'modelInventory.thinking', defaultMessage: 'thinking options' }),
    tools: intl.formatMessage({ id: 'modelInventory.tools', defaultMessage: 'tool calling' }),
  };
  const failureReason = (notice: InventoryNotice) => {
    const status = typeof notice.httpStatus === 'number' && notice.httpStatus >= 400 && notice.httpStatus <= 599 ? notice.httpStatus : undefined;
    const reasons: Record<string, { id: string; defaultMessage: string }> = {
      custom_provider_invalid_credentials: connectionMessages.invalidCredentials,
      custom_provider_api_key_required: connectionMessages.apiKeyRequiredForConnection,
      custom_provider_endpoint_unreachable: connectionMessages.endpointUnreachable,
      custom_provider_permission_denied: connectionMessages.permissionDenied,
      custom_provider_model_list_unavailable: connectionMessages.modelListUnavailable,
      custom_provider_invalid_response: connectionMessages.invalidResponse,
    };
    const reason = status === 401 ? connectionMessages.invalidCredentials : status === 403 ? connectionMessages.permissionDenied : status === 429 ? connectionMessages.rateLimited : status && status >= 500 ? connectionMessages.serviceUnavailable : Object.prototype.hasOwnProperty.call(reasons, notice.errorCode ?? '') ? reasons[notice.errorCode!] : undefined;
    const network = connectionNetworkReason(notice.networkCode, intl.locale);
    return [status && `HTTP ${status}`, network ?? (reason ? intl.formatMessage(reason) : selectNativeText(intl.locale, 'The service did not report a specific cause. Retry this connection.', '服务未提供具体原因，请重试此连接。', '服務未提供具體原因，請重試此連線。'))].filter(Boolean).join(' · ');
  };
  return <div ref={root} className="model-connection-center">
    <button className="model-connection-trigger" aria-label={selectNativeText(intl.locale, 'Model connection notifications', '模型连接通知', '模型連線通知')}
      aria-expanded={!collapsed} onClick={() => { setToast([]); setCollapsed(!collapsed); }}>
      {loading ? <RefreshCw size={17} className="model-inventory-spinning" /> : <Bell size={17} />}
      <span className="model-connection-count">{notices.length}</span>
    </button>
    {collapsed && toast.length > 0 && <section className="model-inventory-notice model-connection-toast"
      aria-label={selectNativeText(intl.locale, 'New model connection notifications', '模型连接新消息', '模型連線新訊息')}
      onMouseEnter={() => setToastHovered(true)} onMouseLeave={() => setToastHovered(false)}
      onFocusCapture={() => setToastFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setToastFocused(false); }}>
      <div className="model-inventory-header">
        <Bell size={18} aria-hidden="true" />
        <div className="model-inventory-summary" role="status">
          <strong>{selectNativeText(intl.locale, 'Model connection update', '模型连接有新消息', '模型連線有新訊息')}</strong>
          <p>{toast.map(notice => `${notice.providerName}：${notice.failed
            ? selectNativeText(intl.locale, 'Refresh failed', '刷新失败', '重新整理失敗')
            : selectNativeText(intl.locale, 'Model information changed', '模型信息有变化', '模型資訊有變更')}`).join('；')}</p>
        </div>
        <button className="model-inventory-close" aria-label={selectNativeText(intl.locale, 'Dismiss notification preview', '收起消息提示', '收起訊息提示')} onClick={() => setToast([])}><X size={16} /></button>
      </div>
      <button className="model-inventory-action" onClick={() => { setToast([]); setExpanded(true); setCollapsed(false); }}>{detailsLabel}<ChevronDown size={14} /></button>
    </section>}
    {!collapsed && <section aria-label={title} className="model-inventory-notice" data-attention={removed}>
    <div className="model-inventory-header">
      {loading ? <RefreshCw size={18} className="model-inventory-spinning" aria-hidden="true" /> : <AlertCircle size={18} aria-hidden="true" />}
      <div className="model-inventory-summary" role={removed ? 'alert' : 'status'}>
        <strong>{title}</strong>
        <p>{summary}</p>
      </div>
      <button className="model-inventory-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {detailsLabel}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      <button className="model-inventory-close" aria-label={intl.formatMessage({ id: 'modelInventory.collapse', defaultMessage: 'Hide for now' })} onClick={() => setCollapsed(true)}><X size={16} /></button>
    </div>
    {expanded && <div className="model-inventory-details">
    {removed && <p className="model-inventory-preserved">{intl.formatMessage({ id: 'modelInventory.preserved', defaultMessage: 'Your selected model has not been changed. If it is unavailable, choose another model manually from the model menu.' })}</p>}
    {notices.map(notice => <div key={notice.providerId} className="model-inventory-provider">
      <strong>{notice.providerName}</strong>
      {notice.failed && !actions[notice.providerId]?.pending && <p>{failureReason(notice)}</p>}
      <ul>{notice.changes.map(change => <li key={`${change.kind}:${change.model}`}>
        {change.kind === 'removed'
          ? intl.formatMessage({ id: 'modelInventory.removed', defaultMessage: '{model} is no longer in the provider model list. It may have been removed or access may have changed.' }, { model: change.model })
          : intl.formatMessage({ id: 'modelInventory.changed', defaultMessage: '{model}: the provider changed {fields}. Review the model settings before continuing.' },
            { model: change.model, fields: (change.fields ?? []).map(field => labels[field] ?? field).join(', ') })}
      </li>)}</ul>
      {(notice.loading || actions[notice.providerId]?.pending) && <p role="status">{selectNativeText(intl.locale, 'Loading model list…', '正在加载模型列表…', '正在載入模型清單…')}</p>}
      <button disabled={actions[notice.providerId]?.pending || notice.loading} className="model-inventory-action" onClick={() => void action(notice, true)}><RefreshCw size={13} className={actions[notice.providerId]?.pending ? 'model-inventory-spinning' : undefined} />{intl.formatMessage({ id: 'modelInventory.retry', defaultMessage: 'Refresh again' })}</button>
      {!!notice.noticeId && notice.changes.length > 0 && <button disabled={actions[notice.providerId]?.pending} className="model-inventory-action" onClick={() => void action(notice, false)}>{intl.formatMessage({ id: 'modelInventory.acknowledge', defaultMessage: 'Dismiss changes' })}</button>}
      {actions[notice.providerId]?.message && <p role={actions[notice.providerId].error ? 'alert' : 'status'} className={actions[notice.providerId].error ? 'model-inventory-action-error' : undefined}>
        {actions[notice.providerId].message} · {intl.formatTime(actions[notice.providerId].at, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </p>}
    </div>)}
    </div>}
  </section>}</div>;
}
