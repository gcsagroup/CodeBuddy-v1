import { WorkspacePageTitle } from '../Layout/WorkspacePageTitle';
import { SearchableSelect } from '../ui/SearchableSelect';
import { buttonVariants } from '../ui/button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Images, MessageSquare, RefreshCw } from 'lucide-react';
import { getAcpControlClient } from '../../acp/acpConnection';
import { useNavigation } from '../../hooks/useNavigation';
import { WorkspaceMedia } from '../../workspace-panel/WorkspaceMedia';
import { mediaText as t } from '../../workspace-panel/WorkspaceGeneration';
import { getProjectAlias } from '../../utils/projectAliases';
import { getProjectLabel } from '../../utils/projectSessions';
import type { PanelMedia } from '../../workspace-panel/workspacePanelTypes';

interface Asset {
  id: string;
  sessionId: string;
  sessionName: string;
  root: string;
  kind: 'image' | 'video';
  path: string;
  filename: string;
  available: boolean;
  sizeBytes?: number;
  createdAt: string;
  displayName?: string;
  prompt: string;
}
interface LibraryPage {
  items: Asset[];
  projects: string[];
  total: number;
  totalBytes?: number;
  libraryBytes?: number;
  libraryCount?: number;
  projectStats?: { root: string; count: number; sizeBytes: number }[];
  unreadableRecords: number;
  nextCursor: string | null;
}
const buttonClass = buttonVariants({ variant: 'outline', size: 'sm' });

export function formatBytes(value?: number) {
  if (value === undefined) return '—';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = value > 0 ? Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)) : 0;
  return `${(value / 1024 ** (exponent + 1)).toFixed(1)} ${units[exponent]}`;
}
function AssetCard({ asset, selected, editing, disabled, onSelect, onEnter }: { asset: Asset; selected: boolean; editing: boolean; disabled: boolean; onSelect: () => void; onEnter: () => void }) {
  const title = asset.displayName || asset.prompt || asset.filename;
  const navigate = useNavigation();
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const cancelHold = () => { clearTimeout(hold.current); hold.current = undefined; };
  useEffect(() => cancelHold, []);
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [media, setMedia] = useState<PanelMedia>();
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !asset.available) return;
    let disposed = false;
    setMedia(undefined);
    setError(false);
    void window.electron.workspacePanel({
      scope: { sessionId: asset.sessionId, root: asset.root }, action: 'read', path: asset.path,
    }).then(reply => {
      if (!disposed) { setMedia(reply.document?.media); setError(!reply.document?.media); }
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [visible, asset.available, asset.path, asset.root, asset.sessionId]);
  const reveal = async () => {
    setActionError(false);
    try {
      await window.electron.workspacePanel({
        scope: { sessionId: asset.sessionId, root: asset.root }, action: 'reveal', path: asset.path,
      });
    } catch { setActionError(true); }
  };
  return (
    <article ref={container} tabIndex={0} aria-label={t('Media: ', '素材：', '素材：') + title}
      className={`overflow-hidden rounded-xl border bg-background-primary outline-offset-2 ${selected ? 'border-text-primary ring-2 ring-text-primary' : 'border-border-primary'}`}
      onPointerDown={event => {
        suppressClick.current = false;
        if (editing || disabled || event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('[data-media-actions]')) return;
        cancelHold(); origin.current = { x: event.clientX, y: event.clientY };
        hold.current = setTimeout(() => { hold.current = undefined; suppressClick.current = true; onEnter(); }, 500);
      }}
      onPointerMove={event => { if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) cancelHold(); }}
      onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold}
      onDragStart={event => { event.preventDefault(); cancelHold(); }}
      onContextMenu={event => { if (editing || hold.current) event.preventDefault(); }}
      onClickCapture={event => {
        if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); return; }
        if (editing && !(event.target as HTMLElement).closest('input')) { event.preventDefault(); event.stopPropagation(); if (!disabled) onSelect(); }
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || ![' ', 'Enter'].includes(event.key) || disabled) return;
        event.preventDefault(); if (editing) onSelect(); else onEnter();
      }}>

      <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-text-secondary">
        {editing ? <span className="flex items-center gap-2"><input type="checkbox" aria-label={t('Select ', '选择 ', '選擇 ') + title} checked={selected} disabled={disabled} onChange={onSelect} />{t('Select', '选择', '選擇')}</span> : <span>{asset.kind === 'image' ? t('Image', '图片', '圖片') : t('Video', '视频', '影片')}</span>}
        <span>{formatBytes(asset.sizeBytes)}</span>
      </div>
      <div className="flex h-52 items-center justify-center overflow-hidden bg-background-secondary p-2">
        {media ? <WorkspaceMedia media={media} title={title} /> : (
          <p className="p-4 text-sm text-text-secondary" role="status">
            {!asset.available || error
              ? t('File unavailable. It may have been moved or deleted.', '文件不可用，可能已移动或删除。', '檔案無法使用，可能已移動或刪除。')
              : t('Loading preview…', '加载预览…', '載入預覽…')}
          </p>
        )}
      </div>
      <div className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>{asset.kind === 'image' ? t('Image', '图片', '圖片') : t('Video', '视频', '影片')}</span>
          <time dateTime={asset.createdAt}>{new Date(asset.createdAt).toLocaleString()}</time>
        </div>
        <p className="line-clamp-2 text-sm" title={asset.prompt || title}>{title}</p>
        <p className="truncate text-xs text-text-secondary" title={asset.root}>{asset.root}</p>
        <p className="truncate text-xs text-text-secondary" title={asset.sessionName}>{asset.sessionName}</p>
        {actionError && <p role="alert" className="text-xs">{t('Could not open the file location.', '无法打开文件位置。', '無法開啟檔案位置。')}</p>}
        {!editing && <div data-media-actions className="flex flex-wrap gap-2 pt-1">
          <button className={buttonClass} onClick={() => navigate('pair', { resumeSessionId: asset.sessionId })}>
            <MessageSquare className="mr-1 inline size-3.5" aria-hidden="true" />
            {t('Source chat', '来源对话', '來源對話')}
          </button>
          <button className={buttonClass} disabled={!asset.available} onClick={() => void reveal()}>
            <FolderOpen className="mr-1 inline size-3.5" aria-hidden="true" />
            {t('Show in folder', '打开文件位置', '開啟檔案位置')}
          </button>
        </div>}
      </div>
    </article>
  );
}

export function MediaLibrary() {
  const [editing, setEditing] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectionAssets, setSelectionAssets] = useState<Asset[]>([]);
  const [completeGroups, setCompleteGroups] = useState<Map<string, string[]>>(new Map());
  const [, updateNames] = useState(0);
  useEffect(() => {
    const update = () => updateNames(value => value + 1);
    window.addEventListener('codebuddy-project-alias-changed', update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener('codebuddy-project-alias-changed', update); window.removeEventListener('storage', update); };
  }, []);
  const projectName = (root: string) => getProjectAlias(root, getProjectLabel(root));
  const [view, setView] = useState('time');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Asset[]>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirmation) dialog.current?.showModal(); }, [confirmation]);
  const [deleting, setDeleting] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [kind, setKind] = useState('all');
  const [project, setProject] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<LibraryPage>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(async (cursor = '') => {
    const generation = ++request.current;
    setLoading(true);
    setFailed(false);
    if (!cursor) { setPage(undefined); setSelected(new Set()); setSelectionAssets([]); setCompleteGroups(new Map()); setEditing(false); }
    try {
      const client = await getAcpControlClient();
      const next = await client.extMethod('_codebuddy/media/library', { kind, project, search: query, cursor, ...(view === 'workspace' ? { view } : {}) }) as unknown as LibraryPage;
      if (!Array.isArray(next.items) || !Array.isArray(next.projects) || typeof next.total !== 'number')
        throw new Error('Invalid media library response');
      if (generation === request.current) setPage(previous => ({ ...next,
        items: cursor && previous ? [...new Map([...previous.items, ...next.items].map(item => [item.id, item])).values()] : next.items,
      }));
    } catch { if (generation === request.current) setFailed(true); }
    finally { if (generation === request.current) setLoading(false); }
  }, [kind, project, query, view]);
  useEffect(() => {
    const activeRequest = request;
    void load();
    return () => { activeRequest.current++; };
  }, [load]);
  const toggle = (id: string) => setSelected(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const selectAll = async (root?: string) => {
    if (selecting) return;
    const generation = request.current;
    setSelecting(true); setDeleteError('');
    try {
      const client = await getAcpControlClient();
      const result = await client.extMethod('_codebuddy/media/library', { kind, project: root ?? project, search: query, all: true }) as unknown as LibraryPage;
      if (!Array.isArray(result.items) || result.nextCursor || result.items.length !== result.total) throw new Error('Incomplete selection');
      if (generation !== request.current) return;
      setCompleteGroups(previous => {
        const next = new Map(previous);
        const roots = root ? [root] : [...new Set(result.items.map(item => item.root))];
        for (const groupRoot of roots) next.set(groupRoot, result.items.filter(item => item.root === groupRoot).map(item => item.id));
        return next;
      });
      setSelectionAssets(previous => [...new Map([...previous, ...result.items].map(item => [item.id, item])).values()]);
      setSelected(previous => new Set([...(root ? previous : []), ...result.items.map(item => item.id)]));
    } catch { setDeleteError(t('Could not select all media. Refresh and retry.', '无法全选素材，请刷新后重试。', '無法全選素材，請重新整理後重試。')); }
    finally { setSelecting(false); }
  };
  const deleteSelected = async () => {
    if (!confirmation || deleting) return;
    setDeleting(true); setDeleteError(''); setDeleteNotice('');
    try {
      const client = await getAcpControlClient();
      const reply: { results: { id: string; deleted: boolean; error?: string }[] } = { results: [] };
      // Keep the server's bounded deletion contract while allowing cross-page selection.
      for (let offset = 0; offset < confirmation.length; offset += 500) {
        const batch = confirmation.slice(offset, offset + 500);
        const result = await client.extMethod('_codebuddy/media/delete', { ids: batch.map(item => item.id), confirm: true }) as unknown as typeof reply;
        if (!Array.isArray(result.results) || batch.some(item => !result.results.some(entry => entry.id === item.id && typeof entry.deleted === 'boolean'))) throw new Error('Invalid deletion response');
        reply.results.push(...result.results);
      }
      const failures = reply.results.filter(result => !result.deleted);
      setDeleteNotice(t('Deleted', '已删除', '已刪除') + ' ' + reply.results.filter(result => result.deleted).length +
        (failures.length ? ' · ' + t('Failed', '失败', '失敗') + ' ' + failures.length + ': ' + failures.map(result => (confirmation.find(item => item.id === result.id)?.filename ?? result.id) + ' — ' + result.error).join('; ') : ''));
      setConfirmation(undefined);
      await load();
    } catch { setDeleteError(t('Deletion could not be confirmed. Refresh before retrying.', '无法确认删除结果，请刷新核对后重试。', '無法確認刪除結果，請重新整理後重試。')); }
    finally { setDeleting(false); }
  };
  const card = (asset: Asset) => <AssetCard key={asset.id} asset={asset} editing={editing} onEnter={() => { setEditing(true); setSelected(new Set([asset.id])); }} selected={selected.has(asset.id)} disabled={loading || deleting || Boolean(confirmation) || selecting} onSelect={() => toggle(asset.id)} />;
  return (
    <main className="flex h-full min-h-0 flex-col bg-background-primary text-text-primary">
      <header className="border-b border-border-primary px-4 pt-6 pb-4 sm:px-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <WorkspacePageTitle icon={Images} description={t('Generated images and videos from all project conversations', '所有项目对话中生成的图片与视频', '所有專案對話中產生的圖片與影片')}>
              {t('Media Library', '素材库', '素材庫')}
            </WorkspacePageTitle>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-text-secondary">
            <p className="rounded-md bg-background-secondary px-2.5 py-1.5" data-testid="library-summary">{page && (page.libraryCount === undefined || page.libraryBytes === undefined) ? t('Restart the app to update media statistics.', '请重启应用以更新素材统计。', '請重新啟動應用程式以更新素材統計。') : <>{page?.libraryCount ?? '—'} {t('items', '项素材', '項素材')} · {formatBytes(page?.libraryBytes)}</>}</p>
              <button className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-primary px-2 py-1 text-sm leading-5 hover:bg-background-secondary disabled:opacity-50" disabled={loading || selecting || deleting || Boolean(confirmation)} onClick={() => void load()}>
                <RefreshCw className="size-3.5" aria-hidden="true" />{t('Refresh', '刷新', '重新整理')}
              </button>
            </div>
          </div>
          <fieldset disabled={selecting || deleting || Boolean(confirmation)} className="flex min-w-0 flex-wrap gap-2 rounded-lg bg-background-secondary p-2">
            <input className="min-w-0 flex-[1_1_12rem] rounded-lg border border-border-primary bg-background-primary px-3 py-2 text-sm"
              aria-label={t('Search media', '搜索素材', '搜尋素材')} placeholder={t('Search prompt, project or conversation', '搜索描述、项目或对话', '搜尋描述、專案或對話')}
              value={search} onChange={event => setSearch(event.target.value)} />
            <select className={buttonClass + ' bg-background-primary'} aria-label={t('Media type', '素材类型', '素材類型')} value={kind} onChange={event => setKind(event.target.value)}>
              <option value="all">{t('All types', '全部类型', '全部類型')}</option>
              <option value="image">{t('Images', '图片', '圖片')}</option>
              <option value="video">{t('Videos', '视频', '影片')}</option>
            </select>
            <SearchableSelect className={buttonClass + ' max-w-72 bg-background-primary'} aria-label={t('Project', '项目', '專案')} value={project} onValueChange={(nextValue) => setProject(nextValue)}>
              <option value="">{t('All projects', '全部项目', '全部專案')}</option>
              {[...new Set([...(page?.projects ?? []), ...(project ? [project] : [])])].map(root => <option key={root} value={root}>{projectName(root)}</option>)}
            </SearchableSelect>
            <select className={buttonClass + ' bg-background-primary'} aria-label={t('View', '视图', '檢視')} value={view} onChange={event => setView(event.target.value)}>
              <option value="time">{t('Timeline', '按时间排列', '依時間排列')}</option>
              <option value="workspace">{t('By workspace', '按工作区分类', '依工作區分類')}</option>
            </select>
          </fieldset>
          {editing && <div className="flex flex-wrap items-center gap-3 text-sm">
            <button className={buttonClass} disabled={loading || selecting || deleting || Boolean(confirmation) || !page?.items.length} onClick={() => void selectAll()}>{t('Select all', '全选', '全選')}</button>
            <button className={buttonClass} disabled={!selected.size || loading || selecting || deleting || Boolean(confirmation)} onClick={() => { setDeleteError(''); setConfirmation([...new Map([...selectionAssets, ...(page?.items ?? [])].map(item => [item.id, item])).values()].filter(item => selected.has(item.id))); }}>{t('Delete selected', '删除选中', '刪除選取')} ({selected.size})</button>
            <button className={buttonClass} disabled={selecting || deleting || Boolean(confirmation)} onClick={() => { setEditing(false); setSelected(new Set()); setSelectionAssets([]); }}>{t('Clear selection', '取消选择', '取消選取')}</button>
          </div>}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-8" aria-busy={loading}>
        <div className="mx-auto max-w-6xl">
          {deleteNotice && <p role="status" className="mb-4 break-words text-sm">{deleteNotice}</p>}
          {deleteError && !confirmation && <p role="alert">{deleteError}</p>}
          {failed && <p role="alert" className="mb-4 text-sm">{t('Could not load media. Please refresh to retry.', '素材加载失败，请刷新重试。', '素材載入失敗，請重新整理重試。')}</p>}
          {Boolean(page?.unreadableRecords) && <p role="status" className="mb-4 text-sm text-text-secondary">{t('Some generation records could not be read.', '部分生成记录无法读取，已展示其余素材。', '部分產生記錄無法讀取，已顯示其餘素材。')}</p>}
          {!loading && !failed && page?.items.length === 0 && <p role="status" className="py-12 text-center text-text-secondary">{t('No matching media. Generate an image or video in a conversation to see it here.', '暂无匹配素材。在对话中生成图片或视频后，可在这里查看。', '暫無符合的素材。在對話中產生圖片或影片後，可在這裡查看。')}</p>}
          {view === 'time' ? <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4">{page?.items.map(card)}</div> :
            [...new Set(page?.items.map(item => item.root))].map(root => {
              const stats = page?.projectStats?.find(entry => entry.root === root);
              const groupIds = completeGroups.get(root) ?? [...new Map([...selectionAssets, ...(page?.items ?? [])].filter(item => item.root === root).map(item => [item.id, item])).keys()];
              const chosen = groupIds.filter(id => selected.has(id)).length;
              const complete = completeGroups.has(root) || groupIds.length === stats?.count;
              const checked = complete && groupIds.length > 0 && chosen === groupIds.length;
              return <section key={root} className="mb-8" aria-label={projectName(root)}>
                <div className="mb-3 flex items-center gap-2">
                  {editing && <button type="button" className="flex size-6 shrink-0 items-center justify-center rounded border border-border-primary text-lg leading-none hover:bg-background-secondary disabled:opacity-50" aria-label={(checked ? t('Deselect workspace ', '取消选择工作区 ', '取消選取工作區 ') : t('Select workspace ', '选择工作区 ', '選取工作區 ')) + projectName(root)} aria-pressed={checked} disabled={selecting || loading || deleting || Boolean(confirmation)} onClick={() => {
                    if (checked) { const ids = new Set(groupIds); setSelected(previous => new Set([...previous].filter(id => !ids.has(id)))); }
                    else void selectAll(root);
                  }}>{checked ? '−' : '+'}</button>}
                  <h2 className="min-w-0 break-words text-base font-semibold" title={root}>{projectName(root)}</h2>
                  <span className="ml-auto whitespace-nowrap text-sm text-text-secondary">{formatBytes(stats?.sizeBytes)}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4">{page?.items.filter(item => item.root === root).map(card)}</div>
              </section>;
            })}
          {loading && <p role="status" className="py-6 text-center text-sm">{t('Loading…', '加载中…', '載入中…')}</p>}
          {page?.nextCursor && <div className="pt-6 text-center"><button className={buttonClass} disabled={loading} onClick={() => void load(page.nextCursor!)}>{t('Load more', '加载更多', '載入更多')}</button></div>}
        </div>
      </div>
      {confirmation && <dialog ref={dialog} aria-labelledby="delete-media-title" onCancel={event => { event.preventDefault(); if (!deleting) setConfirmation(undefined); }} className="m-auto max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl bg-background-primary p-0 text-text-primary backdrop:bg-black/50">
        <div className="w-full max-w-lg rounded-xl border border-border-primary bg-background-primary p-6 shadow-xl">
          <h2 id="delete-media-title" className="text-lg font-semibold">{t('Delete selected media?', '删除选中的素材？', '刪除選取的素材？')}</h2>
          <p className="my-3 text-sm">{confirmation.length} · {formatBytes(confirmation.reduce((total, item) => total + (item.sizeBytes ?? 0), 0))}</p>
          <p className="text-sm">{t('Permanently delete these generated files and remove them from the library. This cannot be undone. Chats and workspaces are kept. Missing files are removed from this list only.', '将永久删除这些生成文件并从素材库移除，无法撤销。对话和工作区保留；已缺失的文件仅移除列表记录。', '將永久刪除這些產生檔案並從素材庫移除，無法復原。對話和工作區保留；已缺失檔案僅移除清單記錄。')}</p>
          <ul className="my-4 max-h-48 overflow-auto text-xs text-text-secondary">{confirmation.map(item => <li key={item.id} className="mb-2 break-all"><span className="line-clamp-2">{item.displayName || item.prompt || item.filename}</span><span>{item.path}</span></li>)}</ul>
          {deleteError && <p role="alert" className="mb-3 text-sm">{deleteError}</p>}
          <div className="flex justify-end gap-3"><button autoFocus className={buttonClass} disabled={deleting} onClick={() => setConfirmation(undefined)}>{t('Cancel', '取消', '取消')}</button><button className={buttonClass} disabled={deleting} onClick={() => void deleteSelected()}>{deleting ? t('Deleting…', '删除中…', '刪除中…') : t('Permanently delete', '永久删除', '永久刪除')}</button></div>
        </div>
      </dialog>}
    </main>
  );
}
