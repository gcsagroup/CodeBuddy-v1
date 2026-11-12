import { useEffect, useState } from 'react';
import {
  Boxes,
  Braces,
  Cloud,
  Film,
  Image as ImageIcon,
  Network,
  Plus,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../../ui/dialog';
import landscape from '../../../images/media-landscape.jpg';
import MediaServiceForm from './MediaServiceForm';
import MediaServiceTest from './MediaServiceTest';
import {
  button,
  field,
  hints,
  kindOf,
  mediaRequest,
  modes,
  names,
  primary,
  t,
  type Choice,
  type Kind,
  type Registry,
  type Service,
} from './mediaServices';

const icons = {
  bailian: Braces,
  ark: Cloud,
  comfy: Network,
  openai: Sparkles,
  fal: Boxes,
  custom: Settings2,
};
const choices: Choice[] = ['bailian', 'ark', 'comfy', 'openai', 'fal', 'custom'];
type View = 'choose' | 'edit' | 'manage' | 'remove' | 'test';
export default function ImageGenerationSettings() {
  const [state, setState] = useState<Registry | null>(null),
    [view, setView] = useState<View | null>(null);
  const [choice, setChoice] = useState<Choice>('bailian'),
    [serviceId, setServiceId] = useState('');
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const service = state?.services.find((s) => s.id === serviceId);
  useEffect(() => {
    let live = true;
    mediaRequest<Registry>('read')
      .then((r) => {
        if (live) setState(r);
      })
      .catch((e) => {
        if (live) setMessage(String(e));
      });
    return () => {
      live = false;
    };
  }, []);
  async function mutate(op: string, p: Record<string, unknown>) {
    setBusy(true);
    setMessage('');
    try {
      setState(await mediaRequest<Registry>(op, { ...p, revision: state?.revision }));
      setView(null);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  function manage(s: Service) {
    setServiceId(s.id);
    setChoice(s.custom ? 'custom' : s.type);
    setView('manage');
    setMessage('');
  }
  const title =
    view === 'choose'
      ? t('Add generation service', '添加生成服务', '新增生成服務')
      : view === 'test'
        ? t('Generation test', '生成测试', '生成測試')
        : view === 'edit'
          ? service
            ? t('Edit service', '编辑服务', '編輯服務')
            : names[choice]
          : view === 'remove'
            ? t('Remove service', '移除服务', '移除服務')
            : (service?.name ?? '');
  return (
    <section className="space-y-5 text-text-primary">
      <p className="text-sm text-text-secondary">
        {t(
          'Choose the services used by image and video requests in chat. Your chat model is selected separately.',
          '在这里选择对话中生图和生成视频的服务。聊天继续使用你在对话中选择的模型。',
          '在此選擇對話中生圖和生成影片的服務。聊天繼續使用你在對話中選擇的模型。'
        )}
      </p>
      {state && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['image', 'video'] as Kind[]).map((kind) => {
              const label =
                kind === 'image'
                  ? t('Default image model', '默认图片模型', '預設圖片模型')
                  : t('Default video model', '默认视频模型', '預設影片模型');
              const selected = state.defaults[kind];
              return (
                <div key={kind} className="overflow-hidden rounded-xl border border-border-subtle">
                  <div
                    aria-hidden="true"
                    className={
                      'flex h-14 overflow-hidden ' + (kind === 'video' ? 'gap-1 bg-black py-1' : '')
                    }
                  >
                    {Array.from({ length: kind === 'video' ? 3 : 1 }, (_, i) => (
                      <img
                        key={i}
                        src={landscape}
                        alt=""
                        className="h-full min-w-0 flex-1 object-cover object-center"
                      />
                    ))}
                  </div>
                  <label className="block space-y-2 p-3 text-sm font-medium">
                    <span className="flex items-center gap-2">
                      {kind === 'image' ? <ImageIcon size={16} /> : <Film size={16} />} {label}
                    </span>
                    <select
                      className={field}
                      aria-label={label}
                      disabled={busy || !selected}
                      value={JSON.stringify(selected)}
                      onChange={(e) =>
                        void mutate('default', { kind, ...JSON.parse(e.target.value) })
                      }
                    >
                      {!selected && (
                        <option value="null">
                          {t(
                            'Add a compatible service',
                            '请先添加支持此类型的服务',
                            '請先新增支援此類型的服務'
                          )}
                        </option>
                      )}
                      {state.services.flatMap((s) =>
                        s.models
                          .filter((m) => kindOf(m) === kind)
                          .map((m) => (
                            <option
                              key={JSON.stringify([s.id, m.id])}
                              value={JSON.stringify({ service: s.id, model: m.id })}
                            >
                              {s.name} · {m.label}
                            </option>
                          ))
                      )}
                    </select>
                  </label>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold">
              {t('Configured services', '已配置的服务', '已設定的服務')}{' '}
              <span className="text-sm text-text-secondary">{state.services.length}</span>
            </h3>
            <button
              className={primary + ' flex items-center gap-1'}
              onClick={() => {
                setServiceId('');
                setChoice('bailian');
                setView('choose');
                setMessage('');
              }}
            >
              <Plus size={15} />
              {t('Add service', '添加服务', '新增服務')}
            </button>
          </div>
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
            {state.services.map((s) => {
              const Icon = icons[s.custom ? 'custom' : s.type];
              return (
                <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <Icon size={20} />
                  <div className="min-w-0 flex-1">
                    <strong className="text-sm">{s.name}</strong>
                    <p className="truncate text-xs text-text-secondary">
                      {names[s.type]} · {new URL(s.url).host}
                    </p>
                  </div>
                  <button
                    className={button}
                    aria-label={t('Manage ', '管理', '管理') + s.name}
                    onClick={() => manage(s)}
                  >
                    {t('Manage', '管理', '管理')}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
      {message && !view && <p role="alert">{message}</p>}
      {(!state || message) && !view && (
        <button
          className={button}
          onClick={() =>
            void mediaRequest<Registry>('read')
              .then((r) => {
                setState(r);
                setMessage('');
              })
              .catch((e) => setMessage(String(e)))
          }
        >
          {t('Refresh', '刷新', '重新整理')}
        </button>
      )}
      <Dialog
        open={view !== null}
        onOpenChange={(open) => {
          if (!open) setView(null);
        }}
      >
        <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-lg">
          <DialogTitle>{title}</DialogTitle>
          {view === 'choose' && (
            <>
              <div className="grid gap-2">
                {choices.map((key) => {
                  const Icon = icons[key];
                  return (
                    <button
                      key={key}
                      aria-pressed={choice === key}
                      className={
                        'flex items-center gap-3 rounded-lg border p-3 text-left ' +
                        (choice === key
                          ? 'border-text-primary bg-background-secondary'
                          : 'border-border-subtle')
                      }
                      onClick={() => setChoice(key)}
                    >
                      <Icon size={21} />
                      <span>
                        <strong className="text-sm">{names[key]}</strong>
                        <small className="block text-text-secondary">{hints[key]}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
              <button className={primary + ' justify-self-end'} onClick={() => setView('edit')}>
                {t('Next', '下一步', '下一步')}
              </button>
            </>
          )}
          {view === 'edit' && state && (
            <MediaServiceForm
              choice={choice}
              existing={service}
              state={state}
              onBack={() => setView(service ? 'manage' : 'choose')}
              onSaved={(r) => {
                setState(r);
                setView(null);
                setMessage('');
              }}
            />
          )}
          {view === 'manage' && service && (
            <>
              <p className="break-all text-sm">{service.url}</p>
              {service.models.map((m) => (
                <div key={m.id} className="text-sm">
                  {m.label} · {m.modes.map((k) => modes[k]).join(' / ')}
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <button className={primary} onClick={() => setView('test')}>
                  {t('Generation test', '生成测试', '生成測試')}
                </button>
                <button className={button} onClick={() => setView('edit')}>
                  {t('Edit', '编辑配置', '編輯設定')}
                </button>
                <button className={button} onClick={() => setView('remove')}>
                  {t('Remove', '移除服务', '移除服務')}
                </button>
              </div>
            </>
          )}
          {view === 'remove' && service && (
            <>
              <p>
                {t(
                  'Remove this connection? Pending jobs may lose access.',
                  '移除此连接后，进行中的任务可能无法继续查询。',
                  '移除此連線後，進行中的任務可能無法繼續查詢。'
                )}
              </p>
              <div className="flex justify-end gap-2">
                <button className={button} onClick={() => setView('manage')}>
                  {t('Keep', '保留', '保留')}
                </button>
                <button
                  className={primary}
                  disabled={busy}
                  onClick={() => void mutate('remove', { id: service.id })}
                >
                  {t('Remove', '确认移除', '確認移除')}
                </button>
              </div>
            </>
          )}
          {view === 'test' && service && <MediaServiceTest service={service} />}
          {message && view && <p role="alert">{message}</p>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
