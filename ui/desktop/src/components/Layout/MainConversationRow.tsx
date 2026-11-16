import { useState } from 'react';
import { MessageCircle, Trash2 } from 'lucide-react';
import { clearMainConversation, getMainConversation } from '../../pets/mainConversation';
import { acpChatSessionController } from '../../acp/chatSessionController';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { SessionIndicators } from '../SessionIndicators';
import type { PetTaskState } from '../../pets/petTypes';

export function MainConversationRow({ onOpen, taskState, active, awaitingReply }: {
  onOpen: (sessionId: string) => void;
  taskState?: PetTaskState;
  active?: boolean;
  awaitingReply?: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async () => {
    try { onOpen(await getMainConversation()); }
    catch (reason) { setError(String(reason)); }
  };
  const clear = async () => {
    setBusy(true); setError('');
    try {
      const id = await getMainConversation();
      await clearMainConversation(id);
      await acpChatSessionController.restoreSession(id);
      setConfirm(false);
      onOpen(id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '清空失败，请重试'); }
    finally { setBusy(false); }
  };
  return <>
    <div className="app-nav-link group/main mx-2 mt-3 shrink-0 gap-0 p-0">
      <button type="button" className="flex min-h-9 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring" aria-current={active ? 'page' : undefined} onClick={() => void open()}>
        <MessageCircle size={16} aria-hidden="true" /><span>主对话</span>
      </button>
      <SessionIndicators awaitingReply={awaitingReply} isStreaming={taskState === 'working'} hasUnread={taskState === 'completed'} hasError={taskState === 'blocked'} />
      <button type="button" className="mr-1 rounded-md p-2 text-text-secondary opacity-0 pointer-events-none group-hover/main:opacity-100 group-hover/main:pointer-events-auto group-focus-within/main:opacity-100 group-focus-within/main:pointer-events-auto hover:text-text-primary" aria-label="清空主对话历史" title="清空主对话历史" onClick={() => { setError(''); setConfirm(true); }}>
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>
    {error && !confirm && <p role="alert" className="px-4 text-xs text-text-danger">{error}</p>}
    <Dialog open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>清空主对话历史记录？</DialogTitle>
          <DialogDescription>仅清空当前主对话的消息和上下文，保留已保存的记忆、其他对话及项目文件。主对话正在执行任务时，请先等待任务结束或停止任务。</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-text-danger">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>取消</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void clear()}>{busy ? '正在清空…' : '清空历史'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
