import { useEffect, useRef, useState } from 'react';
import { Search, MessageSquare, LoaderCircle } from 'lucide-react';
import { useIntl } from '../../i18n';
import { selectNativeText } from '../../utils/nativeLocalization';
import { acpListSessions, type SessionListItem } from '../../acp/sessions';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/dialog';

export function SessionSearchDialog({ open, onOpenChange, onSelect }: {
  open: boolean; onOpenChange: (open: boolean) => void; onSelect: (id: string) => void;
}) {
  const intl = useIntl();
  const text = (en: string, cn: string, tw: string) => selectNativeText(intl.locale, en, cn, tw);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true); setError(false); setItems([]); setSelected(0);
    const timer = window.setTimeout(async () => {
      try {
        const found = new Map<string, SessionListItem>();
        let cursor: string | null | undefined;
        do {
          const page = await acpListSessions(cursor, { keyword: query.trim() }, 'unified');
          if (!active) return;
          page.sessions.forEach(item => found.set(item.id, item));
          cursor = page.nextCursor;
        } while (cursor);
        setItems([...found.values()]);
      } catch { if (active) setError(true); }
      finally { if (active) setBusy(false); }
    }, query.trim() ? 250 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, query, retry]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [selected]);
  const choose = (item: SessionListItem) => { onOpenChange(false); onSelect(item.id); };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-xl gap-3" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}>
      <DialogTitle>{text('Search conversations', '搜索会话', '搜尋對話')}</DialogTitle>
      <DialogDescription>{text('Search titles and message text. Archived conversations are available in History.', '搜索标题和聊天正文；归档会话请在历史记录中查看。', '搜尋標題與聊天內文；封存對話請在歷史紀錄中查看。')}</DialogDescription>
      <div className="flex items-center gap-2 rounded-lg border border-border-primary px-3 py-2">
        <Search size={18} className="shrink-0 text-text-secondary" />
        <input ref={input} className="min-w-0 flex-1 bg-transparent outline-none" value={query}
          role="combobox" aria-expanded="true" aria-controls="session-search-results" aria-autocomplete="list"
          aria-activedescendant={!busy && items[selected] ? `session-search-${selected}` : undefined}
          aria-label={text('Search conversations', '搜索会话', '搜尋對話')}
          placeholder={text('Search titles or messages…', '输入标题或聊天内容…', '輸入標題或聊天內容…')}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing || busy) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
            if (event.key === 'Enter' && items[selected]) { event.preventDefault(); choose(items[selected]); }
          }} />
        {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
      </div>
      <div className="text-xs text-text-secondary" role="status">{busy ? text('Searching…', '正在搜索…', '正在搜尋…') : query.trim() ? text(`${items.length} results`, `${items.length} 个结果`, `${items.length} 個結果`) : text('Recent conversations', '最近会话', '最近對話')}</div>
      {error && <div role="alert" className="text-sm">{text('Could not load conversations.', '会话加载失败。', '對話載入失敗。')} <button className="underline" onClick={() => setRetry(value => value + 1)}>{text('Retry', '重试', '重試')}</button></div>}
      <div ref={list} id="session-search-results" role="listbox" aria-label={text('Conversations', '会话列表', '對話清單')} className="max-h-[45vh] overflow-y-auto space-y-1">
        {items.map((item, index) => <button key={item.id} id={`session-search-${index}`} role="option" aria-selected={selected === index} tabIndex={-1}
          onMouseEnter={() => setSelected(index)} onClick={() => choose(item)}
          className={`flex w-full gap-3 rounded-lg p-3 text-left ${selected === index ? 'bg-background-secondary' : 'hover:bg-background-secondary'}`}>
          <MessageSquare size={17} className="mt-1 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span>
            <span className="block truncate text-xs text-text-secondary">{item.workingDir || text('No workspace', '无工作区', '無工作區')}</span></span>
          <span className="shrink-0 text-xs text-text-secondary">{Number.isFinite(Date.parse(item.updatedAt)) ? intl.formatDate(item.updatedAt) : ''}</span>
        </button>)}
      </div>
      {!busy && !error && !items.length && <p className="py-6 text-center text-sm text-text-secondary">{text('No matching conversations. Try another keyword.', '没有匹配的会话，试试其他关键词。', '沒有符合的對話，試試其他關鍵字。')}</p>}
      <div className="border-t border-border-primary pt-3 text-xs text-text-secondary">{text('↑ ↓ Select · Enter Open · Esc Close', '↑ ↓ 选择 · Enter 打开 · Esc 关闭', '↑ ↓ 選擇 · Enter 開啟 · Esc 關閉')}</div>
    </DialogContent>
  </Dialog>;
}
