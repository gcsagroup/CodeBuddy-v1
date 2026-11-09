import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { useIntl } from '../../../i18n';
import type { ProviderDetails } from '../../../types/providers';
import { selectNativeText } from '../../../utils/nativeLocalization';
import { Button } from '../../ui/button';

type Choice = { providerId: string; modelId: string } | null;
const key = 'compactionModel';
const choiceKey = (choice: Choice) =>
  choice ? JSON.stringify([choice.providerId, choice.modelId]) : '';

export default function CompactionModelSettings({
  providers,
  catalogState = 'ready',
  onRetry,
  onDirtyChange,
}: {
  providers: ProviderDetails[];
  catalogState?: 'loading' | 'failed' | 'ready';
  onRetry?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { locale } = useIntl();
  const t = (en: string, cn: string, tw: string) => selectNativeText(locale, en, cn, tw);
  const id = useId();
  const generation = useRef(0);
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const choices = useMemo(
    () =>
      providers
        .filter((provider) => provider.is_configured && provider.category !== 'agent')
        .flatMap((provider) =>
          provider.metadata.known_models.map((model) => ({
            value: choiceKey({ providerId: provider.name, modelId: model.name }),
            label: `${provider.metadata.display_name} / ${model.name}`,
          }))
        ),
    [providers]
  );
  const unavailable = Boolean(value && !choices.some((choice) => choice.value === value));
  const dirty = ready && value !== saved;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const current = ++generation.current;
    setReady(false);
    setError('');
    void acpReadConfig(key)
      .then((data) => {
        if (current !== generation.current) return;
        const choice = data as Choice;
        if (
          choice !== null &&
          (typeof choice !== 'object' ||
            typeof choice.providerId !== 'string' ||
            typeof choice.modelId !== 'string')
        )
          throw new Error('Invalid saved compaction model');
        const initial = choiceKey(choice);
        setValue(initial);
        setSaved(initial);
        setReady(true);
      })
      .catch((reason) => {
        if (current === generation.current) setError(String(reason));
      });
    return () => {
      generation.current = current + 1;
    };
  }, [reload]);
  async function save() {
    if (!dirty || busy || unavailable) return;
    const current = generation.current;
    const choice: Choice = value
      ? (() => {
          const [providerId, modelId] = JSON.parse(value) as string[];
          return { providerId, modelId };
        })()
      : null;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await acpUpsertConfig(key, choice, false);
      if (current !== generation.current) return;
      setSaved(value);
      setNotice(
        t(
          'Saved. Applies to subsequent requests and manual compaction.',
          '已保存，后续请求和手动压缩使用此设置。',
          '已儲存，後續請求和手動壓縮使用此設定。'
        )
      );
    } catch (reason) {
      if (current === generation.current) setError(String(reason));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-busy={(!ready && !error) || busy}
      className="space-y-3 rounded-lg border border-border-subtle p-4"
    >
      <h3 id={`${id}-title`} className="font-medium">
        {t('Context compaction', '上下文压缩', '上下文壓縮')}
      </h3>
      <p id={`${id}-description`} className="max-w-prose text-sm text-text-secondary">
        {t(
          'Choose the model that summarizes conversation history for manual and automatic compaction. This setting is shared across chats; the conversation model stays unchanged.',
          '选择手动和自动压缩历史时使用的模型。此设置在对话间共享，不改变各对话的模型。',
          '選擇手動和自動壓縮歷史時使用的模型。此設定在聊天間共用，不改變各聊天的模型。'
        )}
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor={`${id}-model`} className="block text-sm">
          {t('Compaction model', '压缩模型', '壓縮模型')}
        </label>
        <select
          id={`${id}-model`}
          aria-describedby={`${id}-description`}
          value={value}
          disabled={!ready || busy || catalogState === 'loading'}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
            setNotice('');
          }}
          className="block w-full min-w-0 rounded-md border border-border-primary bg-background-primary px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-default"
        >
          <option value="">
            {t('Follow the current conversation model', '跟随当前对话模型', '跟隨目前聊天模型')}
          </option>
          {unavailable && (
            <option value={value} disabled>
              {t('Saved model unavailable', '已保存的模型不可用', '已儲存的模型無法使用')}
            </option>
          )}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {catalogState === 'failed' ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
            <p>
              {t(
                'Could not load model connections.',
                '模型连接列表加载失败。',
                '模型連線清單載入失敗。'
              )}
            </p>
            {onRetry && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t('Retry connections', '重试加载连接', '重試載入連線')}
              </Button>
            )}
          </div>
        ) : unavailable && catalogState === 'ready' ? (
          <p role="status" className="text-sm text-text-secondary">
            {t(
              'The saved model is unavailable. Choose another model or follow the conversation model.',
              '已保存的模型不可用，请重新选择，或改为跟随当前对话模型。',
              '已儲存的模型無法使用，請重新選擇，或改為跟隨目前聊天模型。'
            )}
          </p>
        ) : catalogState === 'ready' && !choices.length ? (
          <p className="text-sm text-text-secondary">
            {t(
              'Add a model connection to choose a separate compaction model.',
              '添加模型连接后，即可选择独立压缩模型。',
              '新增模型連線後，即可選擇獨立壓縮模型。'
            )}
          </p>
        ) : null}
        <Button type="submit" disabled={!dirty || busy || unavailable}>
          {busy
            ? t('Saving…', '保存中…', '儲存中…')
            : t('Save compaction model', '保存压缩模型', '儲存壓縮模型')}
        </Button>
      </form>
      {error && (
        <div role="alert" className="space-y-2 text-sm text-text-danger">
          <p>{error}</p>
          {!ready && (
            <Button variant="outline" onClick={() => setReload((count) => count + 1)}>
              {t('Retry settings', '重试加载设置', '重試載入設定')}
            </Button>
          )}
        </div>
      )}
      {!ready && !error && (
        <p role="status" className="text-sm text-text-secondary">
          {t('Loading settings…', '正在加载设置…', '正在載入設定…')}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-text-secondary">
          {notice}
        </p>
      )}
    </section>
  );
}
