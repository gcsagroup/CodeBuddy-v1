import { SearchableChoiceList } from '../../ui/SearchableChoiceList';
import { useState, type FormEvent } from 'react';
import {
  button,
  field,
  mediaRequest,
  modes,
  names,
  primary,
  t,
  type Choice,
  type Model,
  type Registry,
  type Service,
  type ServiceType,
} from './mediaServices';

interface Props {
  choice: Choice;
  existing?: Service;
  state: Registry;
  onSaved: (r: Registry) => void;
  onBack: () => void;
}
export default function MediaServiceForm({ choice, existing, state, onSaved, onBack }: Props) {
  const initial = existing?.type ?? (choice === 'custom' ? 'openai' : choice);
  const [type, setType] = useState<ServiceType>(initial);
  const [name, setName] = useState(existing?.name ?? (choice === 'custom' ? '' : names[choice]));
  const [url, setUrl] = useState(
    existing?.url ??
      (choice === 'custom' ? '' : (state.catalog[type].urls[0] ?? 'http://127.0.0.1:8188'))
  );
  const [apiKey, setKey] = useState('');
  const [workspaceId, setWorkspaceId] = useState(existing?.workspaceId ?? '');
  const official = type === 'bailian' || type === 'ark';
  const defaultModelIds = new Set(Object.values(state.defaults)
    .filter(d => d && d.service === existing?.id)
    .map(d => d?.model));
  const [modelId, setModelId] = useState(
    existing?.models[0]?.id ?? (choice === 'openai' ? 'gpt-image-1' : '')
  );
  const [imageModes, setImageModes] = useState(
    existing?.type === 'openai'
      ? existing.models[0].modes
      : choice === 'openai'
        ? ['text_to_image', 'image_to_image']
        : ['text_to_image']
  );
  const [available, setAvailable] = useState<Model[]>([
    ...new Map(
      [...state.catalog[type].models, ...(existing?.models ?? [])].map((m) => [m.id, m])
    ).values(),
  ]);
  const [selected, setSelected] = useState(
    (existing?.models ?? state.catalog[type].models).map((m) => m.id)
  );
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  function protocol(next: ServiceType) {
    setType(next);
    setAvailable(state.catalog[next].models);
    setSelected(state.catalog[next].models.map((m) => m.id));
    setMessage('');
  }
  async function discover() {
    setBusy(true);
    setMessage('');
    try {
      const result = await mediaRequest<{ models: Model[]; blockers: number }>('workflows', {
        id: existing?.id,
        url,
        apiKey,
      });
      const all = [...state.catalog.comfy.models, ...result.models];
      setAvailable(all);
      setSelected((s) => s.filter((id) => all.some((m) => m.id === id)));
      setMessage(
        `${t('Connection verified · available workflows', '连接已验证 · 可用工作流', '連線已驗證 · 可用工作流')} ${result.models.length}`
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function refreshModels() {
    setBusy(true);
    setMessage('');
    try {
      const result = await mediaRequest<{ models: Model[] }>('models', {
        type, id: existing?.id, url, apiKey, workspaceId: workspaceId.trim(),
      });
      const catalog = new Map(state.catalog[type].models.map(m => [m.id, m]));
      for (const m of result.models) catalog.set(m.id, m);
      // Keep the exact definitions of checked models, including retired or unlisted ones.
      for (const m of available.filter(m => selected.includes(m.id)))
        catalog.set(m.id, { ...m, retiring: catalog.get(m.id)?.retiring ?? m.retiring });
      setAvailable([...catalog.values()]);
      setMessage(`${t('Compatible official models', '官方目录中的兼容模型', '官方目錄中的相容模型')} · ${result.models.length}`);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage('');
    const models =
      type === 'openai'
        ? [{ id: modelId.trim(), label: modelId.trim(), modes: imageModes }]
        : available.filter((m) => selected.includes(m.id));
    setBusy(true);
    try {
      onSaved(
        await mediaRequest<Registry>('save', {
          revision: state.revision,
          id: existing?.id,
          type,
          name,
          url,
          models,
          ...(type === 'bailian' ? { workspaceId: workspaceId.trim() } : {}),
          apiKey,
          custom: choice === 'custom',
        })
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  const fixed = choice !== 'custom' && type !== 'comfy';
  return (
    <form onSubmit={save}>
      <fieldset disabled={busy} className="grid gap-3 text-sm">
        {choice === 'custom' && (
          <label>
            {t('Protocol', '接口协议', '介面協定')}
            <select
              className={field}
              value={type}
              onChange={(e) => protocol(e.target.value as ServiceType)}
            >
              <option value="openai">OpenAI Images</option>
              <option value="comfy">ComfyUI</option>
            </select>
          </label>
        )}
        <label>
          {t('Service name', '服务名称', '服務名稱')}
          <input
            autoFocus
            className={field}
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {type === 'bailian' && (
          <label>
            {t('API key region', 'API Key 所属地域', 'API Key 所屬地域')}
            <select className={field} value={url} onChange={(e) => {
              setUrl(e.target.value);
              setWorkspaceId('');
              setAvailable(available.filter(m => selected.includes(m.id)).concat(
                state.catalog[type].models.filter(m => !selected.includes(m.id))));
              setMessage('');
            }}>
              {state.catalog[type].urls.map((v, i) => (
                <option key={v} value={v}>
                  {i ? t('Singapore', '新加坡', '新加坡') : t('Beijing', '北京', '北京')}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {t('Service address', '服务地址', '服務位址')}
          <input
            className={field}
            type="url"
            required
            readOnly={fixed}
            placeholder={
              type === 'comfy' ? 'http://localhost:8188' : 'https://gateway.example.com/v1'
            }
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (type === 'comfy') {
                setAvailable(state.catalog.comfy.models);
                setSelected(state.catalog.comfy.models.map((m) => m.id));
              }
              setMessage('');
            }}
          />
        </label>
        <label>
          API Key{' '}
          <input
            className={field}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              existing?.hasKey && url === existing.url
                ? t('Saved · leave blank to keep', '已保存，留空沿用', '已儲存，留空沿用')
                : t('Stored securely by the system', '由系统凭据存储保护', '由系統憑證儲存保護')
            }
          />
        </label>
        {type === 'openai' ? (
          <>
            <label>
              {t('Model ID', '模型 ID', '模型 ID')}
              <input
                className={field}
                required
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
            </label>
            <div className="flex gap-4">
              {['text_to_image', 'image_to_image'].map((x) => (
                <label key={x}>
                  <input
                    type="checkbox"
                    checked={imageModes.includes(x)}
                    onChange={(e) =>
                      setImageModes((s) =>
                        e.target.checked ? [...s, x] : s.filter((v) => v !== x)
                      )
                    }
                  />{' '}
                  {modes[x]}
                </label>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-2 rounded-lg border border-border-subtle p-3">
            {type === 'bailian' && (
              <label className="block">
                {t('Workspace ID for model discovery', '百炼业务空间 ID（刷新模型时填写）', '百煉業務空間 ID（重新整理模型時填寫）')}
                <input className={field} value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} />
              </label>
            )}
            {official && (
              <button className={button} type="button" onClick={refreshModels}>
                {t('Refresh official models', '刷新官方模型', '重新整理官方模型')}
              </button>
            )}
            {type === 'comfy' && (
              <button className={button} type="button" onClick={discover}>
                {t('Read server workflows', '读取服务端工作流', '讀取服務端工作流')}
              </button>
            )}
            <SearchableChoiceList items={available} searchText={(m) => m.label + ' ' + m.id}>
              {(visible) => visible.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    disabled={official && defaultModelIds.has(m.id)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked ? [...s, m.id] : s.filter((v) => v !== m.id)
                      )
                    }
                  />
                  <span>
                    {m.label}
                    <small className="ml-2 text-text-secondary">
                      {m.modes.map((x) => modes[x]).join(' / ')}
                      {m.retiring && ' · ' + t('Retiring', '即将下线', '即將下線')}
                      {official && defaultModelIds.has(m.id) &&
                        ' · ' + t('Current default', '当前默认', '目前預設')}
                    </small>
                  </span>
                </label>
              ))}
            </SearchableChoiceList>
          </div>
        )}
        {message && (
          <p role="status" className="break-words">
            {message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={button} onClick={onBack}>
            {t('Back', '返回', '返回')}
          </button>
          <button
            className={primary}
            disabled={type === 'openai' ? !imageModes.length : !selected.length}
          >
            {t('Save configuration', '保存配置', '儲存設定')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
