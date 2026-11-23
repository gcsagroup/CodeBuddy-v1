import { VoiceInputStatus } from '../components/VoiceInputStatus';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useHoldToTalk } from '../hooks/useHoldToTalk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PetSprite } from './PetSprite';
import type { PetAnimation, PetSnapshot, PetTask } from './petTypes';
import { petActionCycles } from './petTypes';
import { petPanelHeight, petPanelWidth } from './petPolicy';
import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import {
  Mic,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  FileText,
  MessageCircle,
  Paperclip,
  Plus,
  Bot,
  Target,
  ListChecks,
  Pause,
  X,
} from 'lucide-react';
import { compressImageDataUrl } from '../utils/conversionUtils';
import type { ImageData } from '../types/message';
import { parsePetMessage, type PetComposerAction } from './petMessage';
import './desktopPet.css';

const t = (en: string, cn: string, tw: string) => selectNativeText(currentLocale, en, cn, tw);
type Attachment = {
  id: string;
  name: string;
  path?: string;
  image?: ImageData;
  preview?: string;
  error?: boolean;
};
const labels = {
  idle: '',
  working: t('Working', '工作中', '工作中'),
  completed: t('Done', '已完成', '已完成'),
  blocked: t('Blocked · click to view', '受阻 · 点击查看', '受阻 · 點擊查看'),
  input: t('Waiting for you · click to view', '等待你处理 · 点击查看', '等待你處理 · 點擊查看'),
};
const activityLabels = {
  waiting: t('Waiting for model response', '等待模型响应', '等待模型回應'),
  thinking: t('Receiving model activity', '正在思考', '正在思考'),
  responding: t('Writing a response', '正在撰写回复', '正在撰寫回覆'),
  tool: t('Running tool', '正在执行工具', '正在執行工具'),
  compacting: t('Compacting context', '正在整理上下文', '正在整理上下文'),
  starting: t('Starting agent', '正在启动 Agent', '正在啟動 Agent'),
  stopping: t('Stopping…', '正在停止…', '正在停止…'),
};
function TaskCard({ task }: { task: PetTask }) {
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const permission = task.inputRequest?.permission;
  useEffect(() => { setApproving(false); setApprovalError(''); }, [permission?.token]);
  const decide = async (action: import('../types/permissions').Permission) => {
    if (!permission || approving) return;
    setApproving(true); setApprovalError('');
    try {
      await window.electron.desktopPet({ action: 'resolve-permission', sessionId: task.sessionId,
        permission: { requestId: permission.requestId, token: permission.token, action } });
    } catch (error) { setApprovalError(error instanceof Error ? error.message : '审批失败'); setApproving(false); }
  };
  const activity = task.state === 'working' && task.activity;
  const inputLabel =
    task.inputRequest?.kind === 'question'
      ? t('Waiting for your reply', '等待你回复', '等待你回覆')
      : task.inputRequest?.kind === 'permission'
        ? t('Waiting for your approval', '等待你确认权限', '等待你確認權限')
        : task.inputRequest?.kind === 'workspace'
          ? t('Confirm workspace', '等待确认工作区', '等待確認工作區')
          : null;
  const question = task.questions?.[0];
  const detail = question ? t('Awaiting reply', '待回复', '待回覆') : activity
    ? `${activityLabels[activity.kind]}${activity.toolName ? ` · ${activity.toolName}` : ''}`
    : inputLabel || labels[task.state];
  return (
    <div className="pet-task-card" data-state={question ? 'input' : task.state}>
      <button
        type="button"
        aria-label={`${task.title} · ${detail}`}
        title={[task.title, detail, activity && activity.stage].filter(Boolean).join('\n')}
        onClick={() =>
          void window.electron.desktopPet({ action: 'open-task', sessionId: task.sessionId })
        }
        className="pet-task-open"
      >
        <div className="pet-task-heading">
          <span aria-hidden="true" className="pet-task-indicator">
            {question ? '?' : task.state === 'completed' ? '✓' : task.state === 'working' ? '●' : '!'}
          </span>
          <strong>{task.title}</strong>
        </div>
        <div className="pet-task-detail">{detail}</div>
        {activity && activity.stage && (
          <div className="pet-task-detail pet-task-step">
            {t('Step', '当前步骤', '目前步驟')} · {activity.stage}
          </div>
        )}
        {(question?.summary || task.inputRequest?.summary) && (
          <div className="pet-task-question" title={question?.summary || task.inputRequest?.summary}>
            {question?.summary || task.inputRequest?.summary}
          </div>
        )}
      </button>
      <div className="pet-task-actions">
        {permission?.choices.map(choice => <button key={choice.action} type="button" disabled={approving} onClick={() => void decide(choice.action)}>{choice.label}</button>)}
        {task.state === 'working' && activity && activity.kind !== 'stopping' && (
          <button
            type="button"
            onClick={() =>
              void window.electron.desktopPet({ action: 'pause-task', sessionId: task.sessionId })
            }
          >
            <Pause size={11} aria-hidden="true" />
            {t('Pause', '暂停', '暫停')}
          </button>
        )}
        <button
          type="button"
          className="pet-task-follow"
          onClick={() =>
            void window.electron.desktopPet({ action: 'open-task', sessionId: task.sessionId })
          }
        >
          {question ? t('Reply', '去回复', '去回覆') : task.state === 'input'
            ? t('Reply', '去处理', '去處理')
            : t('Follow up', '继续跟进', '繼續跟進')}
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </div>
      {permission && <details className="pet-approval-details"><summary>审批详情</summary><pre>{permission.details}</pre></details>}
      {approvalError && <div role="alert" className="pet-approval-details">{approvalError}</div>}
    </div>
  );
}
export default function DesktopPet() {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const [temporary, setTemporary] = useState<PetAnimation | null>(null);
  const [interactionId, setInteractionId] = useState(0);
  const [gazing, setGazing] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [composing, setComposing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [attachmentError, setAttachmentError] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const readingRef = useRef(false);
  const sendingRef = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const [voiceError, setVoiceError] = useState('');
  const { isRecording, isStarting, startupStage, waveform, isTranscribing, startRecording, stopRecording } = useAudioRecorder({
    pushToTalk: true,
    scopeId: composing ? 'pet-composer' : 'closed',
    onTranscription: text => setMessage(current => current ? `${current} ${text}` : text),
    onError: setVoiceError,
  });
  const { begin: beginVoice, end: endVoice } = useHoldToTalk(
    startRecording, stopRecording, composing && !message.trim() && !sending && !isTranscribing, composing
  );
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panel = useRef<HTMLDivElement>(null);
  const spriteContainer = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0, reducedMotion: false });
  const alpha = useRef<Uint8ClampedArray | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pet =
    snapshot?.pets.find((p) => p.id === snapshot.preferences.selectedId) || snapshot?.pets[0];
  const blockedTaskKey =
    snapshot?.task?.state === 'blocked'
      ? JSON.stringify([snapshot.task.sessionId, snapshot.task.terminalId ?? null])
      : null;
  const petFps = pet?.fps;
  const [settledBlockedTask, setSettledBlockedTask] = useState<string | null>(null);
  useEffect(() => {
    setSettledBlockedTask(null);
    if (!blockedTaskKey || !petFps) return;
    // Failure is a brief reaction; the task badge retains the blocked state.
    // Repeated snapshots and cursor updates must not restart the reaction.
    const timer = setTimeout(
      () => setSettledBlockedTask(blockedTaskKey),
      (6000 * petActionCycles) / petFps
    );
    return () => clearTimeout(timer);
  }, [blockedTaskKey, petFps]);
  const onAlphaMap = useCallback((value: Uint8ClampedArray) => {
    alpha.current = value;
  }, []);
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.cssText =
      'background:transparent!important;margin:0;overflow:hidden;user-select:none';
    const changed = (_event: unknown, value: unknown) => setSnapshot(value as PetSnapshot);
    const moved = (_event: unknown, value: unknown) => setCursor(value as typeof cursor);
    void window.electron
      .desktopPet({ action: 'get' })
      .then(setSnapshot)
      .catch((error) => console.error('Pet snapshot failed', error));
    window.electron.on('pet-changed', changed);
    window.electron.on('pet-cursor', moved);
    return () => {
      window.electron.off('pet-changed', changed);
      window.electron.off('pet-cursor', moved);
      clearTimeout(release.current);
      clearTimeout(clickTimer.current);
    };
  }, []);
  useEffect(() => {
    const size = snapshot?.preferences.size ?? 160;
    const spriteBounds = spriteContainer.current?.querySelector('canvas')?.getBoundingClientRect();
    const x = Math.floor(
      ((cursor.x - (spriteBounds?.left ?? (petPanelWidth - size) / 2)) /
        (spriteBounds?.width || size)) *
        192
    );
    const y = Math.floor(
      ((cursor.y - (spriteBounds?.top ?? petPanelHeight)) /
        (spriteBounds?.height || (size * 208) / 192)) *
        208
    );
    const sprite =
      x >= 0 &&
      x < 192 &&
      y >= 0 &&
      y < 208 &&
      Boolean(alpha.current && alpha.current[(y * 192 + x) * 4 + 3] > 24);
    const bounds = panel.current?.getBoundingClientRect();
    const badge = Boolean(
      bounds &&
      cursor.x >= bounds.left &&
      cursor.x < bounds.right &&
      cursor.y >= bounds.top &&
      cursor.y < bounds.bottom
    );
    window.electron.petSignal('pet-hit-test', Boolean(pointer.current) || sprite || badge);
  }, [cursor, snapshot, expanded, composing]);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = '44px';
    input.current.style.height = `${Math.min(88, Math.max(44, input.current.scrollHeight))}px`;
  }, [message, composing]);
  const attachFiles = async (files: File[]) => {
    if (readingRef.current || sendingRef.current) return;
    if (attachments.length + files.length > 10) {
      setAttachmentError(true);
      return;
    }
    readingRef.current = true;
    setReadingFiles(true);
    setAttachmentError(false);
    const added: Attachment[] = [];
    for (const file of files) {
      const attachment: Attachment = { id: window.crypto.randomUUID(), name: file.name };
      try {
        if (file.type.startsWith('image/')) {
          if (file.size > 20 * 1024 * 1024) throw new Error('Image too large');
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('Image read failed'));
            reader.readAsDataURL(file);
          });
          attachment.preview = await compressImageDataUrl(dataUrl);
          const [prefix, data] = attachment.preview.split(',');
          attachment.image = { mimeType: prefix.slice(5).split(';')[0], data };
        } else {
          attachment.path = window.electron.getPathForFile(file);
          if (!attachment.path) throw new Error('Missing file path');
        }
      } catch {
        attachment.error = true;
      }
      added.push(attachment);
    }
    setAttachments((current) => [...current, ...added]);
    readingRef.current = false;
    setReadingFiles(false);
    input.current?.focus();
  };
  const openComposer = async () => {
    setComposing(true);
    setSendError(false);
    try {
      await window.electron.desktopPet({ action: 'compose', composing: true });
      input.current?.focus();
    } catch {
      setSendError(true);
    }
  };
  const closeComposer = async () => {
    if (sendingRef.current) return;
    try {
      await window.electron.desktopPet({ action: 'compose', composing: false });
      setComposing(false);
      setAddOpen(false);
    } catch {
      setSendError(true);
    }
  };
  const sendMessage = async (composerAction?: PetComposerAction) => {
    if (
      (!composerAction && !message.trim() && !attachments.length) ||
      sendingRef.current ||
      readingRef.current ||
      attachments.some((a) => a.error)
    )
      return;
    sendingRef.current = true;
    setSending(true);
    setSendError(false);
    try {
      const paths = attachments.flatMap((a) => (a.path ? [JSON.stringify(a.path)] : []));
      const payload = parsePetMessage({
        msg: [message.trim(), ...paths].filter(Boolean).join('\n'),
        images: attachments.flatMap((a) => (a.image ? [a.image] : [])),
      }, !!composerAction);
      await window.electron.desktopPet({
        action: composerAction ? 'open-composer' : 'send-message',
        ...(composerAction ? { composerAction } : {}),
        message: payload.msg,
        ...(payload.images.length ? { images: payload.images } : {}),
      });
      setMessage('');
      setAttachments([]);
      setComposing(false);
      setAddOpen(false);
    } catch {
      // Keep the draft intact when delivery to the main window fails.
      setSendError(true);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  useEffect(() => {
    setGazing(true);
    const timeout = setTimeout(() => setGazing(false), 1200);
    return () => clearTimeout(timeout);
  }, [cursor.x, cursor.y]);
  if (!snapshot) return null;
  if (!pet) return null;
  const task = snapshot.task;
  const tasks = snapshot.tasks ?? (task ? [task] : []);
  const reducedMotion = snapshot.preferences.reducedMotion || cursor.reducedMotion;
  const stateAnimation: PetAnimation =
    task?.questions?.length || task?.state === 'input'
      ? 'waiting'
      : task?.state === 'blocked'
        ? settledBlockedTask === blockedTaskKey
          ? 'idle'
          : 'failed'
        : task?.state === 'completed'
          ? 'review'
          : task?.state === 'working'
            ? 'working'
            : 'idle';
  const dx = cursor.x - petPanelWidth / 2;
  const dy = cursor.y - petPanelHeight - snapshot.preferences.size / 2;
  const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const gazeFrame =
    angle < 30 || angle >= 330
      ? 0
      : angle < 90
        ? 1
        : angle < 150
          ? 2
          : angle < 210
            ? 3
            : angle < 270
              ? 4
              : 5;
  // Brief gaze glances yield to the task animation; temporary interactions always expire.
  const glance =
    gazing && (!task || task.state === 'idle') && !reducedMotion && Math.hypot(dx, dy) > 40;
  return (
    <div
      className="desktop-pet"
      style={{
        position: 'relative',
        width: petPanelWidth,
        height: petPanelHeight + Math.round((snapshot.preferences.size * 208) / 192),
      }}
    >
      {(task || composing) && (
        <div
          ref={panel}
          className={`pet-task-panel${composing ? ' pet-compose-panel' : ''}`}
          style={{
            position: 'absolute',
            bottom: Math.round((snapshot.preferences.size * 208) / 192) + 8,
            left: composing ? 24 : 10,
            right: composing ? 24 : 10,
          }}
        >
          {composing ? (
            <form
              className="pet-composer"
              onKeyDownCapture={(event) => {
                if (event.key === 'Escape' && addOpen) {
                  event.preventDefault(); event.stopPropagation(); setAddOpen(false); input.current?.focus();
                }
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
            >
              <div className="pet-composer-heading">
                <MessageCircle size={14} aria-hidden="true" />
                <strong>{t('Main conversation', '主对话', '主對話')}</strong>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => void closeComposer()}
                  aria-label={t('Close', '关闭', '關閉')}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
              <textarea
                ref={input}
                value={message}
                maxLength={8000}
                disabled={sending}
                readOnly={isRecording}
                rows={2}
                aria-label={t('Message', '消息', '訊息')}
                placeholder={t(
                  'What can I help you with?',
                  '有什么想让我帮忙的？',
                  '有什麼想讓我幫忙的？'
                )}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.code === 'Space' && !message.trim() && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); if (!event.repeat) beginVoice(); return; }
                  if (event.key === 'Escape') void closeComposer();
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label={t('Choose attachments', '选择附件', '選擇附件')}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void attachFiles(files);
                }}
              />
              {!!attachments.length && (
                <div className="pet-attachments" aria-label={t('Attachments', '附件', '附件')}>
                  {attachments.map((attachment) => (
                    <div
                      className="pet-attachment"
                      key={attachment.id}
                      data-error={attachment.error || undefined}
                      title={attachment.path || attachment.name}
                    >
                      {attachment.preview ? (
                        <img src={attachment.preview} alt="" />
                      ) : (
                        <FileText size={13} />
                      )}
                      <span>
                        {attachment.name}
                        {attachment.error ? t(' · Read failed', ' · 读取失败', ' · 讀取失敗') : ''}
                      </span>
                      <button
                        type="button"
                        disabled={sending}
                        aria-label={`${t('Remove', '移除', '移除')} ${attachment.name}`}
                        onClick={() =>
                          setAttachments((current) => current.filter((a) => a.id !== attachment.id))
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachmentError && (
                <p role="alert">
                  {t(
                    'Up to 10 attachments per message.',
                    '每条消息最多添加 10 个附件。',
                    '每則訊息最多加入 10 個附件。'
                  )}
                </p>
              )}
              <VoiceInputStatus recording={isRecording} starting={isStarting} startupStage={startupStage} transcribing={isTranscribing} waveform={waveform} />
              {voiceError && <p role="alert">{voiceError}</p>}
              {sendError && (
                <p role="alert">
                  {t(
                    'Could not send. Your draft is kept; try again.',
                    '发送未成功，草稿已保留，请重试。',
                    '傳送未成功，草稿已保留，請重試。'
                  )}
                </p>
              )}
              {addOpen && (
                <div role="group" aria-label={t('Add', '添加', '新增')} className="pet-add-menu">
                  <button type="button" disabled={sending || readingFiles} onClick={() => { setAddOpen(false); fileInput.current?.click(); }}><Paperclip size={14} />{t('File', '文件', '檔案')}</button>
                  <button type="button" disabled={sending || readingFiles} onClick={() => void sendMessage('agent')}><Bot size={14} />{t('Custom agent', '自定义智能体', '自訂智能體')}</button>
                  <button type="button" disabled={sending || readingFiles} onClick={() => void sendMessage('goal')}><Target size={14} />{t('Goal', '目标', '目標')}</button>
                  <button type="button" disabled={sending || readingFiles} onClick={() => void sendMessage('plan')}><ListChecks size={14} />{t('Plan', '计划', '計畫')}</button>
                  <button type="button" disabled={sending || readingFiles} onClick={() => void sendMessage('add')}><Plus size={14} />{t('Skills and tools in main conversation', '在主对话选择技能和工具', '在主對話選擇技能和工具')}</button>
                </div>
              )}
              <div className="pet-composer-footer">
                <button
                  className="pet-attach-button"
                  type="button"
                  disabled={sending || readingFiles}
                  title={t('Add attachments or features', '添加附件或功能', '加入附件或功能')}
                  aria-label={t('Add attachments or features', '添加附件或功能', '加入附件或功能')}
                  aria-expanded={addOpen}
                  onClick={() => setAddOpen(value => !value)}
                >
                  <Plus size={18} aria-hidden="true" />
                </button>
                <span>
                  {readingFiles
                    ? t('Reading…', '读取中…', '讀取中…')
                    : t('Enter to send', 'Enter 发送', 'Enter 傳送')}
                </span>
                {!message.trim() && !attachments.length ? (
                  <button type="button" className="pet-send-button" disabled={sending || isTranscribing}
                    aria-label={isRecording ? '松开结束录音' : isTranscribing ? '正在识别语音' : '按住说话'}
                    style={{ touchAction: 'none' }}
                    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setVoiceError(''); beginVoice(); }}
                    onPointerUp={endVoice} onPointerCancel={endVoice} onLostPointerCapture={endVoice}
                    onKeyDown={event => { if (event.code === 'Space' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) beginVoice(); } }}
                    onKeyUp={endVoice}
                  ><Mic size={16} /></button>
                ) : (
                <button
                  className="pet-send-button"
                  type="submit"
                  disabled={
                    sending ||
                    readingFiles ||
                    attachments.some((a) => a.error) ||
                    (!message.trim() && !attachments.length)
                  }
                  aria-label={t('Send', '发送', '傳送')}
                >
                  {sending ? '…' : <ArrowUp size={17} aria-hidden="true" />}
                </button>)}
              </div>
            </form>
          ) : (
            <>
              {tasks.length > 1 && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                  className="pet-task-toggle"
                >
                  <MessageCircle size={13} aria-hidden="true" />
                  <span>{t('Conversations', '对话', '對話')}</span>
                  <span className="pet-task-count">{tasks.length}</span>
                  <ChevronDown
                    size={13}
                    aria-hidden="true"
                    style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
                  />
                </button>
              )}
              <div className="pet-task-list">
                {(expanded ? tasks : task ? [task] : []).map((item) => (
                  <TaskCard key={item.sessionId} task={item} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        aria-label={t('Message your pet', '点击宠物发消息', '點擊寵物發訊息')}
        onContextMenu={(event) => {
          event.preventDefault();
          clearTimeout(clickTimer.current);
          if (sendingRef.current) return;
          void (async () => {
            await closeComposer();
            await window.electron.desktopPet({ action: 'context-menu' });
          })().catch(() => setSendError(true));
        }}
        onClick={(event) => {
          // Accessibility activation dispatches click without a pointer gesture.
          if (event.detail === 0) void openComposer();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openComposer();
          }
        }}
        style={{
          position: 'absolute',
          top: petPanelHeight,
          left: (petPanelWidth - snapshot.preferences.size) / 2,
          width: snapshot.preferences.size,
          color: '#fff',
          font: '12px system-ui',
          cursor: 'pointer',
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pointer.current = { x: event.screenX, y: event.screenY };
          event.currentTarget.setPointerCapture(event.pointerId);
          void window.electron.desktopPet({
            action: 'drag-start',
            pointer: { x: event.clientX, y: event.clientY },
          });
        }}
        onPointerUp={(event) => {
          if (event.button !== 0) return;
          const start = pointer.current;
          pointer.current = null;
          void window.electron.desktopPet({ action: 'drag-end' });
          if (start && Math.hypot(event.screenX - start.x, event.screenY - start.y) < 6) {
            setTemporary('wave');
            setInteractionId((id) => id + 1);
            clearTimeout(release.current);
            release.current = setTimeout(() => setTemporary(null), (6000 * petActionCycles) / pet.fps);
            clearTimeout(clickTimer.current);
            clickTimer.current = setTimeout(() => void openComposer(), 300);
          }
        }}
        onPointerCancel={() => {
          pointer.current = null;
          void window.electron.desktopPet({ action: 'drag-end' });
        }}
        onDoubleClick={() => {
          clearTimeout(clickTimer.current);
          setTemporary('jump');
          setInteractionId((id) => id + 1);
          clearTimeout(release.current);
          release.current = setTimeout(() => setTemporary(null), (6000 * petActionCycles) / pet.fps);
        }}
      >
        <div
          ref={spriteContainer}
          className="pet-pose"
          style={{
            width: snapshot.preferences.size,
            height: (snapshot.preferences.size * 208) / 192,
            transform:
              glance && !temporary
                ? `translate(${Math.tanh(dx / 700) * 3}px, ${Math.tanh(dy / 700) * 2}px)`
                : 'translate(0, 0)',
            transition: reducedMotion ? 'none' : 'transform 220ms ease-out',
          }}
        >
          <PetSprite
            pet={pet}
            animation={temporary || (glance ? 'look' : stateAnimation)}
            playbackKey={
              temporary
                ? interactionId
                : JSON.stringify([
                    task?.sessionId,
                    task?.terminalId,
                    task?.inputRequest?.permission?.token,
                  ])
            }
            reducedMotion={reducedMotion}
            gazeFrame={gazeFrame}
            onAlphaMap={onAlphaMap}
          />
        </div>
      </div>
    </div>
  );
}
