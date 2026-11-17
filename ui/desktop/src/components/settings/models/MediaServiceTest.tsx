import { SearchableSelect } from '../../ui/SearchableSelect';
import { useEffect, useState } from 'react';
import {
  button,
  field,
  kindOf,
  mediaRequest,
  modes,
  primary,
  t,
  type Service,
  type Trial,
} from './mediaServices';
interface Pending {
  model: string;
  mode: string;
  jobId: string;
  kind: 'image' | 'video';
}
export default function MediaServiceTest({ service }: { service: Service }) {
  const storageKey = 'media-test:' + service.id;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    } catch {
      return null;
    }
  });
  const previousModel = service.models.find((m) => m.id === pending?.model);
  const [modelId, setModelId] = useState((previousModel ?? service.models[0]).id);
  const model = service.models.find((m) => m.id === modelId) ?? service.models[0];
  const [mode, setMode] = useState(
    pending && previousModel?.modes.includes(pending.mode) ? pending.mode : model.modes[0]
  );
  const [result, setResult] = useState<Trial | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [openedJobId, setOpenedJobId] = useState<string | null>(null);
  const terminal = !!result && ['completed', 'failed', 'cancelled'].includes(result.status);
  const locked = busy || (!!pending && !terminal);
  async function start() {
    if (locked) return;
    const request = { model: model.id, kind: kindOf(model), mode, jobId: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      localStorage.setItem(storageKey, JSON.stringify(request));
      setResult(null);
      setPending(request);
      setResult(
        await mediaRequest<Trial>('test', { ...request, service: service.id, confirmCharge: true })
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!pending || busy || terminal) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await mediaRequest<Trial>('test-status', { ...pending, service: service.id });
        if (active) {
          setResult(next);
          setError('');
        }
      } catch (e) {
        if (active) setError(String(e));
      }
      if (active) timer = setTimeout(poll, 4500);
    }
    timer = setTimeout(poll, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pending, busy, terminal, service.id]);
  function reset() {
    localStorage.removeItem(storageKey);
    setPending(null);
    setResult(null);
    setError('');
    setOpenedJobId(null);
  }
  const statuses: Record<string, string> = {
    queued: t('Queued', '排队中', '排隊中'),
    running: t('Generating', '生成中', '生成中'),
    completed: t('File ready', '文件已就绪', '檔案已就緒'),
    failed: t('Failed', '生成失败', '生成失敗'),
    cancelled: t('Cancelled', '已取消', '已取消'),
    submission_unknown: t(
      'Check submission in the provider console',
      '提交状态待确认，请核对厂商控制台',
      '提交狀態待確認，請核對廠商控制台'
    ),
  };
  return (
    <div className="grid gap-3 text-sm">
      <label>
        {t('Test model', '测试模型', '測試模型')}
        <SearchableSelect
          className={field}
          disabled={locked}
          value={modelId}
          onValueChange={(nextValue) => {
            setModelId(nextValue);
            setMode(service.models.find((m) => m.id === nextValue)!.modes[0]);
          }}
        >
          {service.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </SearchableSelect>
      </label>
      <label>
        {t('Task', '任务类型', '任務類型')}
        <select
          className={field}
          disabled={locked}
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          {model.modes.map((m) => (
            <option key={m} value={m}>
              {modes[m]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-text-secondary">
        {t(
          'This sends a real request to',
          '将向以下服务提交一次真实生成请求',
          '將向以下服務提交一次真實生成請求'
        )}{' '}
        · {service.name} · {model.label}。
        {t(
          'The provider may charge. Reference inputs use the bundled landscape image.',
          '厂商可能扣费。需要参考图时使用随程序附带的风景图。',
          '廠商可能扣費。需要參考圖時使用隨程式附帶的風景圖。'
        )}
      </p>
      {pending && (
        <p role="status">
          {previousModel?.label ?? pending.model} · {modes[pending.mode] ?? pending.mode} ·{' '}
          {openedJobId === pending.jobId
            ? t(
                'Generation verified · file opened',
                '生成已验证 · 文件已打开',
                '生成已驗證 · 檔案已開啟'
              )
            : result
              ? (statuses[result.status] ?? result.status)
              : t('Checking request', '正在确认任务', '正在確認任務')}{' '}
          {result?.error}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {pending && (
          <>
            {result?.file && (
              <button
                className={button}
                onClick={async () => {
                  try {
                    if (await window.electron.openDirectoryInExplorer(result.file!))
                      setOpenedJobId(pending.jobId);
                    else setError(t('Could not open file', '无法打开文件', '無法開啟檔案'));
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                {t('Open result', '打开结果', '開啟結果')}
              </button>
            )}
            {(terminal || error || result?.status === 'submission_unknown') && !busy && (
              <button className={button} onClick={reset}>
                {t('Clear this test from the form', '清除此测试记录', '清除此測試記錄')}
              </button>
            )}
          </>
        )}
        {!locked && (
          <button className={primary} onClick={start}>
            {t('Confirm and generate', '确认生成', '確認生成')}
          </button>
        )}
      </div>
    </div>
  );
}
