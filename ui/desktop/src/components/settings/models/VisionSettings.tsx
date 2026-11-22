import { SearchableSelect } from '../../ui/SearchableSelect';
import { useEffect, useState } from 'react';
import { ScanEye } from 'lucide-react';
import distribution from '../../../../../../runtime/default-model.json';
import {
  readCodeProModelRouting,
  saveCodeProModelRouting,
  DISABLED_CODEPRO_MODEL_ROUTING,
  type CodeProVisionRoute,
} from '../../../acp/codeproModelRouting';
import type { ProviderDetails } from '../../../types/providers';
import { button, field, primary, t } from './mediaServices';

const defaultVisionModel =
  'visionModelId' in distribution && typeof distribution.visionModelId === 'string'
    ? distribution.visionModelId
    : distribution.modelId;

const modes = ['auto', 'always', 'disabled'] as const;
const modeLabel = (mode: CodeProVisionRoute['mode']) =>
  ({
    always: t('Dedicated model', '专用模型识图', '專用模型識圖'),
    auto: t('Main model first', '主模型优先', '主模型優先'),
    disabled: t('Main model only', '仅用主模型', '僅用主模型'),
  })[mode];
const modelKey = (route: Pick<CodeProVisionRoute, 'providerId' | 'modelId'>) =>
  JSON.stringify([route.providerId, route.modelId]);

export default function VisionSettings({ providers }: { providers: ProviderDetails[] }) {
  const [saved, setSaved] = useState<CodeProVisionRoute>();
  const [draft, setDraft] = useState<CodeProVisionRoute>();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setError('');
    readCodeProModelRouting()
      .then((config) => {
        if (!current) return;
        const route = config?.visionRoute ?? DISABLED_CODEPRO_MODEL_ROUTING.visionRoute;
        setSaved(route);
        setDraft(route);
      })
      .catch((cause) => {
        if (current) setError(String(cause.message ?? cause));
      });
    return () => {
      current = false;
    };
  }, [attempt]);

  const models = providers.flatMap((p) => {
    const ids = new Set(p.metadata.known_models?.map((m) => m.name));
    if (p.name === distribution.providerId) ids.add(defaultVisionModel);
    if (saved?.providerId === p.name && saved.modelId) ids.add(saved.modelId);
    return [...ids].map((modelId) => ({
      providerId: p.name,
      modelId,
      connection: p.metadata.display_name || p.name,
    }));
  });
  const chosen = models.find((m) => draft && modelKey(m) === modelKey(draft));
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const latest = await readCodeProModelRouting();
      await saveCodeProModelRouting({
        ...(latest ?? DISABLED_CODEPRO_MODEL_ROUTING),
        visionRoute: draft,
      });
      setSaved(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const dirty =
    saved &&
    draft &&
    (saved.enabled !== draft.enabled ||
      saved.mode !== draft.mode ||
      modelKey(saved) !== modelKey(draft));
  return (
    <div className="runtime-sheet w-full space-y-5 text-text-primary">
      <header className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-background-secondary text-text-secondary">
          <ScanEye size={19} aria-hidden="true" />
        </span>
        <h3 className="runtime-title text-lg font-semibold">{t('Image understanding', '图像理解', '圖像理解')}</h3>
      </header>
      {draft && (
        <section className="space-y-5">
          <fieldset disabled={busy} className="min-w-0 space-y-3">
            <legend className="text-sm font-semibold">
              {t('How to read images', '识图方式', '識圖方式')}
            </legend>
            <div className="grid gap-1 rounded-xl border border-border-subtle bg-background-secondary p-1 sm:grid-cols-3">
              {modes.map((mode) => (
                <label
                  key={mode}
                  className={
                    'relative flex cursor-pointer items-center justify-center rounded-lg px-2 py-2 text-center text-sm focus-within:ring-2 focus-within:ring-text-info ' +
                    (draft.mode === mode
                      ? 'bg-background-primary font-semibold text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary')
                  }
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="vision-mode"
                    value={mode}
                    checked={draft.mode === mode}
                    onChange={() => {
                      const builtin = models.find(
                        (m) =>
                          m.providerId === distribution.providerId &&
                          m.modelId === defaultVisionModel
                      );
                      setDraft({
                        providerId: draft.providerId ?? builtin?.providerId,
                        modelId: draft.modelId ?? builtin?.modelId,
                        enabled: mode !== 'disabled',
                        mode,
                      });
                      setError('');
                    }}
                  />
                  {modeLabel(mode)}
                </label>
              ))}
            </div>
            <p className="text-sm text-text-secondary">
              {draft.mode === 'always'
                ? t(
                    'The selected model reads images and screenshots. The main model decides what to do.',
                    '所选模型负责识别图片和截图，主模型负责判断。',
                    '所選模型負責辨識圖片和截圖，主模型負責判斷。'
                  )
                : draft.mode === 'auto'
                  ? t(
                      'Use the current chat model when it is confirmed to support images; otherwise use the backup model below.',
                      '当前聊天模型已确认支持图片时，直接识图；否则使用下方备用模型。',
                      '目前聊天模型已確認支援圖片時，直接識圖；否則使用下方備用模型。'
                    )
                  : t(
                      'Images go directly to the chat model if it supports them.',
                      '当前聊天模型支持图片时，直接接收图片。',
                      '目前聊天模型支援圖片時，直接接收圖片。'
                    )}
            </p>
            {draft.enabled && (
              <label className="block space-y-1.5 pt-2 text-sm">
                <span>{draft.mode === 'auto'
                  ? t('Backup image model', '备用识图模型', '備用識圖模型')
                  : t('Vision model', '识图模型', '識圖模型')}</span>
                <SearchableSelect
                  aria-label={t('Vision model', '识图模型', '識圖模型')}
                  disabled={busy}
                  className={field}
                  value={chosen ? modelKey(draft) : ''}
                  onValueChange={(nextValue) => {
                    const model = models.find(
                      (m) => modelKey(m) === nextValue
                    );
                    if (model)
                      setDraft({ ...draft, providerId: model.providerId, modelId: model.modelId });
                    setError('');
                  }}
                >
                  {!chosen && (
                    <option value="">{t('Choose a model', '选择模型', '選擇模型')}</option>
                  )}
                  {models.map((m) => (
                    <option
                      key={modelKey(m)}
                      value={modelKey(m)}
                    >
                      {m.modelId} · {m.connection}
                    </option>
                  ))}
                </SearchableSelect>
              </label>
            )}
          </fieldset>
          <div className="flex justify-end border-t border-border-subtle pt-4">
            <button
              className={primary}
              disabled={busy || !dirty || (draft.enabled && !chosen)}
              onClick={() => void save()}
            >
              {busy
                ? t('Saving…', '保存中…', '儲存中…')
                : t('Save settings', '保存设置', '儲存設定')}
            </button>
          </div>
        </section>
      )}
      {error && (
        <div role="alert" className="rounded-lg border border-border-subtle p-3 text-sm">
          {error}{' '}
          {!saved && (
            <button className={button} onClick={() => setAttempt((n) => n + 1)}>
              {t('Retry', '重试', '重試')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
