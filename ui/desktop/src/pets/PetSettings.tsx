import { useEffect, useState } from 'react';
import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import { PetSprite } from './PetSprite';
import { defaultPetId } from './petPolicy';
import { petStates, type PetAnimation, type PetPreferences, type PetSnapshot } from './petTypes';

const t = (en: string, cn: string, tw: string) => selectNativeText(currentLocale, en, cn, tw);
const button =
  'rounded-lg border border-border-subtle px-3 py-2 text-sm hover:bg-background-muted disabled:opacity-50';
export default function PetSettings() {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const [previewId, setPreviewId] = useState<string>();
  const [animation, setAnimation] = useState<PetAnimation>('idle');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.electron
      .desktopPet({ action: 'get' })
      .then(setSnapshot)
      .catch((e) => setError(String(e)));
    const changed = (_event: unknown, value: unknown) => setSnapshot(value as PetSnapshot);
    window.electron.on('pet-changed', changed);
    return () => window.electron.off('pet-changed', changed);
  }, []);
  const action = async (request: Parameters<typeof window.electron.desktopPet>[0]) => {
    setBusy(true);
    setError('');
    try {
      setSnapshot(await window.electron.desktopPet(request));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const configure = (preferences: Partial<PetPreferences>) =>
    action({ action: 'configure', preferences });
  if (!snapshot)
    return <p role="status">{error || t('Loading pets…', '正在读取宠物…', '正在讀取寵物…')}</p>;
  const { preferences, pets } = snapshot;
  const pet = pets.find((p) => p.id === (previewId || preferences.selectedId)) || pets[0];
  const names = [
    t('Idle', '待机', '待機'),
    t('Wave', '挥手', '揮手'),
    t('Jump', '跳跃', '跳躍'),
    t('Working', '工作', '工作'),
    t('Waiting', '等待输入', '等待輸入'),
    t('Failed', '受阻', '受阻'),
    t('Review', '检查', '檢查'),
    t('Look', '观察', '觀察'),
  ];
  return (
    <section className="space-y-6 text-text-primary">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {t(
            'A little companion for your desktop and tasks.',
            '陪伴桌面，也帮你留意任务进展。',
            '陪伴桌面，也幫你留意任務進展。'
          )}
        </p>
        <button
          className={button}
          disabled={busy || pets.length === 0}
          onClick={() => void configure({ visible: !preferences.visible })}
        >
          {preferences.visible
            ? t('Hide pet', '隐藏宠物', '隱藏寵物')
            : t('Show pet', '显示宠物', '顯示寵物')}
        </button>
      </div>
      <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-border-subtle bg-background-default p-6">
        {pet && (
          <div style={{ width: 192, height: 208 }}>
            <PetSprite pet={pet} animation={animation} reducedMotion={preferences.reducedMotion} />
          </div>
        )}
        <p className="font-medium">{pet?.name}</p>
        <p className="mt-1 max-w-lg break-words text-center text-sm text-text-muted">
          {pet?.description}
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          {t('Preview animation', '预览动作', '預覽動作')}
          <select
            className="rounded border border-border-subtle bg-background-primary p-1"
            value={animation}
            onChange={(e) => setAnimation(e.target.value as PetAnimation)}
          >
            {petStates.map((state, i) => (
              <option key={state} value={state}>
                {names[i]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-5 text-sm">
        <label className="flex items-center gap-2">
          {t('Size', '大小', '大小')}
          <select
            aria-label={t('Pet size', '宠物大小', '寵物大小')}
            value={preferences.size}
            disabled={busy}
            className="rounded border border-border-subtle bg-background-primary p-1"
            onChange={(e) => void configure({ size: Number(e.target.value) })}
          >
            {[96, 128, 160, 192, 256].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={preferences.reducedMotion}
            disabled={busy}
            onChange={(e) => void configure({ reducedMotion: e.target.checked })}
          />
          {t('Reduce motion', '减少动画', '減少動畫')}
        </label>
        <span className="text-text-muted">
          {t(
            'Drag to move · click to greet · double-click to jump',
            '拖动移动 · 点击打招呼 · 双击跳跃',
            '拖曳移動 · 點擊打招呼 · 雙擊跳躍'
          )}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{t('My pets', '我的虚拟宠物', '我的虛擬寵物')}</h3>
        <div className="flex gap-2">
          <button
            className={button}
            disabled={busy}
            onClick={() => void action({ action: 'refresh' })}
          >
            {t('Refresh', '刷新', '重新整理')}
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => void action({ action: 'create' })}
          >
            {t('Create a pet', '自定义宠物', '自訂寵物')}
          </button>
        </div>
      </div>
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' }}
      >
        {pets.map((item) => (
          <article
            key={item.id}
            className={`flex min-w-0 flex-col rounded-xl border p-4 ${preferences.selectedId === item.id ? 'border-text-primary' : 'border-border-subtle'}`}
          >
            <button
              className="flex w-full min-w-0 flex-1 flex-col items-center text-center"
              onClick={() => setPreviewId(item.id)}
              aria-label={`${t('Preview', '预览', '預覽')} ${item.name}`}
            >
              <div style={{ width: 112, height: 122 }}>
                <PetSprite pet={item} reducedMotion={preferences.reducedMotion} />
              </div>
              <span className="line-clamp-2 break-words font-medium">{item.name}</span>
              {item.id === defaultPetId && (
                <span className="mt-1 text-xs text-text-muted">
                  {t('Default companion', '默认宠物', '預設寵物')}
                </span>
              )}
              <span
                title={item.description}
                className="mt-2 line-clamp-3 break-words text-sm text-text-muted"
              >
                {item.description}
              </span>
            </button>
            <button
              className={`${button} mt-4 w-full shrink-0`}
              disabled={busy || preferences.selectedId === item.id}
              onClick={() => {
                setPreviewId(item.id);
                void configure({ selectedId: item.id, visible: true });
              }}
            >
              {preferences.selectedId === item.id
                ? t('Selected', '已选择', '已選擇')
                : t('Set as desktop pet', '设为桌面宠物', '設為桌面寵物')}
            </button>
          </article>
        ))}
      </div>
      <p className="text-xs text-text-muted">
        {t(
          'Your main Agent uses available image tools and the built-in pet tool. Validated pets appear here for preview; choose Set as desktop pet to activate one.',
          '主 Agent 调用可用的生图能力与内置宠物工具制作。通过检查后自动加入此处供预览，点击“设为桌面宠物”才启用。',
          '主 Agent 呼叫可用的生圖能力與內建寵物工具製作。通過檢查後自動加入此處供預覽，點擊「設為桌面寵物」才啟用。'
        )}
        <br />
        <span className="select-text break-all">{snapshot.creationDirectory}</span>
      </p>
      {(error || snapshot.errors.length > 0) && (
        <div role="alert" className="rounded border border-border-subtle p-3 text-sm">
          {t(
            'Some pet packages did not pass validation:',
            '部分宠物素材未通过检查：',
            '部分寵物素材未通過檢查：'
          )}
          {[error, ...snapshot.errors].filter(Boolean).map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
    </section>
  );
}
