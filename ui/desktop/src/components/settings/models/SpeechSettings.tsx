import { checkDictationService } from '../../../acp/dictation';
import { useEffect, useState } from 'react';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { Button } from '../../ui/button';
<<<<<<< Updated upstream

const fields = [
  { key: 'REMOTE_ASR_URL', label: '识别接口地址', initial: 'http://192.168.9.101:18003/v1/audio/transcriptions' },
  { key: 'REMOTE_ASR_MODEL', label: '识别模型', initial: 'Qwen3-ASR-0.6B' },
  { key: 'REMOTE_TTS_URL', label: '合成接口地址', initial: '' },
  { key: 'REMOTE_TTS_MODEL', label: '合成模型', initial: '' },
];
export function SpeechSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
=======
import './speech-settings.css';
import { checkSpeechService } from '../../../utils/speechPlayback';

const asrDefaults = {
  REMOTE_ASR_URL: 'http://192.168.50.231:18003/v1/audio/transcriptions',
  REMOTE_ASR_MODEL: 'Qwen3-ASR-0.6B',
};
const ttsDefaults = {
  REMOTE_TTS_URL: 'http://192.168.50.231:18004/v1/audio/speech',
  REMOTE_TTS_MODEL: 'Qwen3-TTS-12Hz-0.6B-Base-INT4',
};
type Values = Record<string, string>;
export function SpeechSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [asrDirty, setAsrDirty] = useState(false),
    [ttsDirty, setTtsDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(asrDirty || ttsDirty);
  }, [asrDirty, ttsDirty, onDirtyChange]);
  return (
    <>
      <SpeechServiceSettings onDirtyChange={setAsrDirty} />
      <SpeechServiceSettings synthesis onDirtyChange={setTtsDirty} />
    </>
  );
}
function SpeechServiceSettings({
  synthesis = false,
  onDirtyChange,
}: {
  synthesis?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const defaults = synthesis ? ttsDefaults : asrDefaults;
  const urlKey = synthesis ? 'REMOTE_TTS_URL' : 'REMOTE_ASR_URL';
  const modelKey = synthesis ? 'REMOTE_TTS_MODEL' : 'REMOTE_ASR_MODEL';
  const { locale } = useIntl();
  const t = (en: string, cn: string, tw: string) => selectNativeText(locale, en, cn, tw);
  const [values, setValues] = useState<Values>(defaults);
  const [saved, setSaved] = useState<Values>(defaults);
  const config = useRef<Record<string, unknown>>({});
  const mounted = useRef(false);
>>>>>>> Stashed changes
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
<<<<<<< Updated upstream
  useEffect(() => {
    let active = true;
    void acpReadConfig('SPEECH_SERVICES')
      .then(saved => {
        if (!active) return;
        const config = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
        setValues(Object.fromEntries(fields.map(field => {
          const value = config[field.key];
          return [field.key, typeof value === 'string' ? value : field.initial];
        })));
        setReady(true);
      })
      .catch(() => { if (active) setMessage('无法读取语音设置，请重新打开页面。'); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setSaving(true);
    setMessage('');
    try {
      for (const key of ['REMOTE_ASR_URL', 'REMOTE_TTS_URL']) {
        const value = values[key]?.trim();
        if (!value && key === 'REMOTE_TTS_URL') continue;
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('请输入有效的 HTTP(S) 接口地址。');
      }
      if (!values.REMOTE_ASR_MODEL.trim()) throw new Error('请输入识别模型名称。');
      await acpUpsertConfig('SPEECH_SERVICES', Object.fromEntries(fields.map(field => [field.key, values[field.key].trim()])));
      setMessage('已保存，请点击重新检测服务。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally { setSaving(false); }
  };
  const check = async () => {
    setChecking(true);
    setMessage('正在检测已保存的识别服务…');
    try {
      await checkDictationService('remote', true);
      setMessage('语音识别服务可连接，可以使用语音输入。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '语音识别服务不可用');
    } finally { setChecking(false); }
  };
  return <div className="max-w-xl space-y-6 pb-8">
    {['语音识别', '语音合成'].map((title, group) => <section key={title} className="space-y-4 rounded-xl border border-border-primary p-5">
      <h3 className="font-medium">{title}</h3>
      {group === 1 && <p className="text-sm text-text-secondary">预留服务配置，语音合成尚未接入。</p>}
      {fields.slice(group * 2, group * 2 + 2).map(field => <label key={field.key} className="block space-y-2 text-sm">
        <span>{field.label}</span>
        <input disabled={!ready || saving} value={values[field.key] ?? ''} onChange={event => { setValues(current => ({ ...current, [field.key]: event.target.value })); setMessage(''); }} className="w-full rounded-lg border border-border-primary bg-background-primary px-3 py-2" />
      </label>)}
    </section>)}
    <Button disabled={!ready || saving || checking} onClick={() => void save()}>{saving ? '正在保存…' : '保存'}</Button>
    <Button disabled={!ready || saving || checking} onClick={() => void check()}>{checking ? '正在检测…' : '重新检测服务'}</Button>
    {message && <p role="status" className="text-sm text-text-secondary">{message}</p>}
  </div>;
=======
  const dirty = values[urlKey] !== saved[urlKey] || values[modelKey] !== saved[modelKey];
  const busy = phase === 'saving' || phase === 'checking';
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    void acpReadConfig('SPEECH_SERVICES')
      .then((result) => {
        if (!active) return;
        config.current =
          result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
        const loaded = Object.fromEntries(
          Object.entries(defaults).map(([key, fallback]) => [
            key,
            typeof config.current[key] === 'string' ? config.current[key] : fallback,
          ])
        ) as Values;
        setValues(loaded);
        setSaved(loaded);
        setReady(true);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attempt, defaults]);
  const run = async (save: boolean) => {
    if (!ready || busy) return;
    let persisted = false;
    setMessage('');
    try {
      if (save) {
        let url: URL;
        try {
          url = new URL(values[urlKey].trim());
        } catch {
          throw new Error(
            t(
              'Enter a valid HTTP(S) endpoint.',
              '请输入有效的 HTTP(S) 接口地址。',
              '請輸入有效的 HTTP(S) 介面位址。'
            )
          );
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
          throw new Error(
            t(
              'Use HTTP(S) without credentials or a URL fragment.',
              '地址需使用 HTTP(S)，且不能包含账号、密码或片段标记。',
              '位址需使用 HTTP(S)，且不能包含帳號、密碼或片段標記。'
            )
          );
        if (!values[modelKey].trim())
          throw new Error(t('Enter a model name.', '请输入模型名称。', '請輸入模型名稱。'));
        setPhase('saving');
        const next = { [urlKey]: values[urlKey].trim(), [modelKey]: values[modelKey].trim() };
        // Preserve existing synthesis and future configuration fields.
        const latest = await acpReadConfig('SPEECH_SERVICES');
        const nextConfig = {
          ...(latest && typeof latest === 'object' ? latest : config.current),
          ...next,
        };
        await acpUpsertConfig('SPEECH_SERVICES', nextConfig);
        if (!mounted.current) return;
        config.current = nextConfig;
        setValues(next);
        setSaved(next);
        persisted = true;
      }
      setPhase('checking');
      if (synthesis) await checkSpeechService();
      else await checkDictationService('remote', true);
      if (!mounted.current) return;
      setPhase('success');
      setMessage(
        persisted
          ? t(
              'Saved. Speech service is reachable.',
              '已保存，语音服务连接正常。',
              '已儲存，語音服務連線正常。'
            )
          : t('Speech service is reachable.', '语音服务连接正常。', '語音服務連線正常。')
      );
    } catch (error) {
      if (!mounted.current) return;
      setPhase('error');
      const detail =
        error instanceof Error
          ? error.message
          : t('Please try again.', '请稍后重试。', '請稍後重試。');
      setMessage(
        (persisted
          ? t(
              'Saved, but the connection check failed: ',
              '配置已保存，但连接检测失败：',
              '設定已儲存，但連線檢測失敗：'
            )
          : '') + detail
      );
    }
  };
  const stateLabel = !ready
    ? t('Not loaded', '待加载', '待載入')
    : dirty
      ? t('Unsaved', '未保存', '未儲存')
      : phase === 'success'
        ? t('Connected', '连接正常', '連線正常')
        : phase === 'error'
          ? t('Needs attention', '需检查', '需檢查')
          : phase === 'checking'
            ? t('Checking', '检测中', '檢測中')
            : t('Not checked', '待检测', '待檢測');
  return (
    <div className="speech-settings">
      <header className="speech-intro">
        <span className="speech-icon">{synthesis ? <Volume2 size={23} /> : <Mic size={23} />}</span>
        <div>
          <h2>
            {synthesis
              ? t('Speech playback', '语音播报', '語音播報')
              : t('Voice input', '语音输入', '語音輸入')}
          </h2>
          <p>
            {synthesis
              ? t(
                  'Read replies aloud only when you click. Connection tests synthesize a short sample without playback.',
                  '点击回复下方的语音播报按钮才开始合成。检测连接会合成短句，但不播放。',
                  '點擊回覆下方的語音播報按鈕才開始合成。檢測連線會合成短句，但不播放。'
                )
              : t(
                  'Connect a speech service to turn your voice into text.',
                  '连接识别服务，把说的话变成输入框里的文字。',
                  '連接辨識服務，把說的話轉成輸入框裡的文字。'
                )}
          </p>
        </div>
      </header>
      <form
        aria-label={synthesis ? 'Synthesis service' : 'Recognition service'}
        className="speech-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void run(true);
        }}
      >
        <div className="speech-panel-heading">
          <div>
            <h3>
              {synthesis
                ? t('Synthesis service', '合成服务', '合成服務')
                : t('Recognition service', '识别服务', '辨識服務')}
            </h3>
            <p>
              {synthesis
                ? t(
                    'Streaming PCM or QwenTTS NDJSON',
                    '支持流式 PCM 或 QwenTTS NDJSON 音频',
                    '支援串流 PCM 或 QwenTTS NDJSON 音訊'
                  )
                : t(
                    'OpenAI-compatible transcription endpoint',
                    '支持 OpenAI 兼容的语音转写接口',
                    '支援 OpenAI 相容的語音轉寫介面'
                  )}
            </p>
          </div>
          <span className="speech-status" data-state={dirty ? 'idle' : phase}>
            <span />
            {stateLabel}
          </span>
        </div>
        {loadFailed ? (
          <div role="alert" className="speech-feedback">
            <CircleAlert size={16} />
            <span>{t('Unable to load settings.', '无法读取语音设置。', '無法讀取語音設定。')}</span>
            <Button type="button" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              {t('Retry', '重试', '重試')}
            </Button>
          </div>
        ) : (
          <fieldset disabled={!ready || busy} className="speech-fields">
            <label>
              <span>
                {synthesis
                  ? t('Synthesis endpoint URL', '合成接口地址', '合成介面位址')
                  : t('Endpoint URL', '识别接口地址', '辨識介面位址')}
              </span>
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={values[urlKey]}
                onChange={(event) => {
                  setValues((v) => ({ ...v, [urlKey]: event.target.value }));
                  setPhase('idle');
                  setMessage('');
                }}
              />
              <small>
                {synthesis
                  ? t(
                      'Use the complete speech URL, usually ending in /v1/audio/speech.',
                      '填写完整语音合成地址，通常以 /v1/audio/speech 结尾。',
                      '填寫完整語音合成位址，通常以 /v1/audio/speech 結尾。'
                    )
                  : t(
                      'Use the complete transcription URL provided by your service.',
                      '填写服务提供的完整语音转写地址。',
                      '填寫服務提供的完整語音轉寫位址。'
                    )}
              </small>
            </label>
            <label>
              <span>
                {synthesis
                  ? t('Synthesis model', '合成模型', '合成模型')
                  : t('Model name', '识别模型', '辨識模型')}
              </span>
              <input
                autoComplete="off"
                spellCheck={false}
                value={values[modelKey]}
                onChange={(event) => {
                  setValues((v) => ({ ...v, [modelKey]: event.target.value }));
                  setPhase('idle');
                  setMessage('');
                }}
              />
              <small>
                {t(
                  'Must match a model available on this service.',
                  '名称需与服务中的模型一致。',
                  '名稱需與服務中的模型一致。'
                )}
              </small>
            </label>
          </fieldset>
        )}
        {message && (
          <div
            role={phase === 'error' ? 'alert' : 'status'}
            className="speech-feedback"
            data-state={phase}
          >
            {phase === 'success' ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
            <span>{message}</span>
          </div>
        )}
        <footer className="speech-footer">
          <p>
            {dirty
              ? t('You have unsaved changes', '有尚未保存的修改', '有尚未儲存的修改')
              : t('Changes apply after saving', '保存后生效', '儲存後生效')}
          </p>
          <div>
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setValues(saved);
                  setPhase('idle');
                  setMessage('');
                }}
              >
                {t('Discard', '放弃修改', '放棄修改')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={!ready || busy || dirty}
              onClick={() => void run(false)}
            >
              <Radio size={16} />
              {t('Test connection', '检测连接', '檢測連線')}
            </Button>
            <Button type="submit" disabled={!ready || busy}>
              {busy && <Loader2 className="animate-spin" size={16} />}
              {phase === 'saving'
                ? t('Saving…', '保存中…', '儲存中…')
                : phase === 'checking'
                  ? t('Checking…', '检测中…', '檢測中…')
                  : t('Save and test', '保存并检测', '儲存並檢測')}
            </Button>
          </div>
        </footer>
      </form>
      {!synthesis && (
        <aside className="speech-guide">
          <Mic size={18} />
          <div>
            <h3>{t('How to speak', '怎么使用', '如何使用')}</h3>
            <p>
              {t(
                'Hold the microphone in the composer, or hold Space when the input is empty. Release to transcribe, review the text, then send.',
                '在聊天输入框按住麦克风，或在空输入框中长按空格。松开后转成文字，确认内容再发送。',
                '在聊天輸入框按住麥克風，或在空輸入框中長按空白鍵。鬆開後轉成文字，確認內容再傳送。'
              )}
            </p>
          </div>
        </aside>
      )}
    </div>
  );
>>>>>>> Stashed changes
}
