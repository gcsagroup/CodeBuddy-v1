import { useCallback, useEffect, useRef, useState } from 'react';
import { PetSprite } from './PetSprite';
import type { PetAnimation, PetSnapshot, PetTask } from './petTypes';
import { petPanelHeight, petPanelWidth } from './petPolicy';
import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import { ArrowUpRight, ChevronDown, MessageCircle, Pause } from 'lucide-react';
import './desktopPet.css';

const t = (en: string, cn: string, tw: string) => selectNativeText(currentLocale, en, cn, tw);
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
  const activity = task.state === 'working' && task.activity;
  const inputLabel =
    task.inputRequest?.kind === 'question'
      ? t('Waiting for your reply', '等待你回复', '等待你回覆')
      : task.inputRequest?.kind === 'permission'
        ? t('Waiting for your approval', '等待你确认权限', '等待你確認權限')
        : task.inputRequest?.kind === 'workspace'
          ? t('Confirm workspace', '等待确认工作区', '等待確認工作區')
          : null;
  const detail = activity
    ? `${activityLabels[activity.kind]}${activity.toolName ? ` · ${activity.toolName}` : ''}`
    : inputLabel || labels[task.state];
  return (
    <div className="pet-task-card" data-state={task.state}>
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
            {task.state === 'completed' ? '✓' : task.state === 'working' ? '●' : '!'}
          </span>
          <strong>{task.title}</strong>
        </div>
        <div className="pet-task-detail">{detail}</div>
        {activity && activity.stage && (
          <div className="pet-task-detail pet-task-step">
            {t('Step', '当前步骤', '目前步驟')} · {activity.stage}
          </div>
        )}
        {task.inputRequest?.summary && (
          <div className="pet-task-question" title={task.inputRequest.summary}>
            {task.inputRequest.summary}
          </div>
        )}
      </button>
      <div className="pet-task-actions">
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
          {task.state === 'input'
            ? t('Reply', '去处理', '去處理')
            : t('Follow up', '继续跟进', '繼續跟進')}
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
export default function DesktopPet() {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const [temporary, setTemporary] = useState<PetAnimation | null>(null);
  const [gazing, setGazing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0, reducedMotion: false });
  const alpha = useRef<Uint8ClampedArray | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
    };
  }, []);
  useEffect(() => {
    const size = snapshot?.preferences.size ?? 160;
    const x = Math.floor(((cursor.x - (petPanelWidth - size) / 2) / size) * 192);
    const y = Math.floor(((cursor.y - petPanelHeight) / size) * 192);
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
  }, [cursor, snapshot, expanded]);
  useEffect(() => {
    setGazing(true);
    const timeout = setTimeout(() => setGazing(false), 1200);
    return () => clearTimeout(timeout);
  }, [cursor.x, cursor.y]);
  if (!snapshot) return null;
  const pet =
    snapshot.pets.find((p) => p.id === snapshot.preferences.selectedId) || snapshot.pets[0];
  if (!pet) return null;
  const task = snapshot.task;
  const tasks = snapshot.tasks ?? (task ? [task] : []);
  const reducedMotion = snapshot.preferences.reducedMotion || cursor.reducedMotion;
  const stateAnimation: PetAnimation =
    task?.state === 'input'
      ? 'waiting'
      : task?.state === 'blocked'
        ? 'failed'
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
    gazing && !task && !reducedMotion && Math.hypot(dx, dy) < 500 && Math.hypot(dx, dy) > 40;
  return (
    <div
      className="desktop-pet"
      style={{
        position: 'relative',
        width: petPanelWidth,
        height: petPanelHeight + Math.round((snapshot.preferences.size * 208) / 192),
      }}
    >
      {task && (
        <div
          ref={panel}
          className="pet-task-panel"
          style={{
            position: 'absolute',
            bottom: Math.round((snapshot.preferences.size * 208) / 192) + 8,
            left: 10,
            right: 10,
          }}
        >
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
            {(expanded ? tasks : [task]).map((item) => (
              <TaskCard key={item.sessionId} task={item} />
            ))}
          </div>
        </div>
      )}
      <div
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
          void window.electron.desktopPet({ action: 'drag-start' });
        }}
        onPointerUp={(event) => {
          const start = pointer.current;
          pointer.current = null;
          void window.electron.desktopPet({ action: 'drag-end' });
          if (start && Math.hypot(event.screenX - start.x, event.screenY - start.y) < 6) {
            setTemporary('wave');
            clearTimeout(release.current);
            release.current = setTimeout(() => setTemporary(null), 6000 / pet.fps);
            if (task)
              void window.electron.desktopPet({ action: 'open-task', sessionId: task.sessionId });
          }
        }}
        onPointerCancel={() => {
          pointer.current = null;
          void window.electron.desktopPet({ action: 'drag-end' });
        }}
        onDoubleClick={() => {
          setTemporary('jump');
          clearTimeout(release.current);
          release.current = setTimeout(() => setTemporary(null), 6000 / pet.fps);
        }}
      >
        <div
          style={{
            width: snapshot.preferences.size,
            height: (snapshot.preferences.size * 208) / 192,
          }}
        >
          <PetSprite
            pet={pet}
            animation={temporary || (glance ? 'look' : stateAnimation)}
            reducedMotion={reducedMotion}
            gazeFrame={gazeFrame}
            onAlphaMap={onAlphaMap}
          />
        </div>
      </div>
    </div>
  );
}
