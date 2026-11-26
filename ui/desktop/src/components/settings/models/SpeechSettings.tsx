import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, Mic, Radio, Volume2 } from 'lucide-react';
import { checkDictationService } from '../../../acp/dictation';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { useIntl } from '../../../i18n';
import { selectNativeText } from '../../../utils/nativeLocalization';
import { Button } from '../../ui/button';
import './speech-settings.css';

const defaults = { REMOTE_ASR_URL: 'http://192.168.50.231:18003/v1/audio/transcriptions', REMOTE_ASR_MODEL: 'Qwen3-ASR-0.6B' };
type Values = typeof defaults;
export function SpeechSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { locale } = useIntl();
  const t = (en: string, cn: string, tw: string) => selectNativeText(locale, en, cn, tw);
  const [values, setValues] = useState<Values>(defaults);
  const [saved, setSaved] = useState<Values>(defaults);
  const config = useRef<Record<string, unknown>>({});
  const mounted = useRef(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'checking' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const dirty = values.REMOTE_ASR_URL !== saved.REMOTE_ASR_URL || values.REMOTE_ASR_MODEL !== saved.REMOTE_ASR_MODEL;
  const busy = phase === 'saving' || phase === 'checking';
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    void acpReadConfig('SPEECH_SERVICES').then(result => {
      if (!active) return;
      config.current = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const loaded = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof config.current[key] === 'string' ? config.current[key] : fallback])) as Values;
      setValues(loaded); setSaved(loaded); setReady(true);
    }).catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  const run = async (save: boolean) => {
    if (!ready || busy) return;
    let persisted = false;
    setMessage('');
    try {
      if (save) {
        let url: URL;
        try { url = new URL(values.REMOTE_ASR_URL.trim()); }
        catch { throw new Error(t('Enter a valid HTTP(S) endpoint.', '请输入有效的 HTTP(S) 接口地址。', '請輸入有效的 HTTP(S) 介面位址。')); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(t('Use HTTP(S) without credentials or a URL fragment.', '地址需使用 HTTP(S)，且不能包含账号、密码或片段标记。', '位址需使用 HTTP(S)，且不能包含帳號、密碼或片段標記。'));
        if (!values.REMOTE_ASR_MODEL.trim()) throw new Error(t('Enter a model name.', '请输入识别模型名称。', '請輸入辨識模型名稱。'));
        setPhase('saving');
        const next = { REMOTE_ASR_URL: values.REMOTE_ASR_URL.trim(), REMOTE_ASR_MODEL: values.REMOTE_ASR_MODEL.trim() };
        // Preserve existing synthesis and future configuration fields.
        const nextConfig = { ...config.current, ...next };
        await acpUpsertConfig('SPEECH_SERVICES', nextConfig);
        if (!mounted.current) return;
        config.current = nextConfig; setValues(next); setSaved(next); persisted = true;
      }
      setPhase('checking');
      await checkDictationService('remote', true);
      if (!mounted.current) return;
      setPhase('success');
      setMessage(persisted ? t('Saved. Speech service is reachable.', '已保存，识别服务连接正常。', '已儲存，辨識服務連線正常。') : t('Speech service is reachable.', '识别服务连接正常。', '辨識服務連線正常。'));
    } catch (error) {
      if (!mounted.current) return;
      setPhase('error');
      const detail = error instanceof Error ? error.message : t('Please try again.', '请稍后重试。', '請稍後重試。');
      setMessage((persisted ? t('Saved, but the connection check failed: ', '配置已保存，但连接检测失败：', '設定已儲存，但連線檢測失敗：') : '') + detail);
    }
  };
  const stateLabel = !ready ? t('Not loaded', '待加载', '待載入') : dirty ? t('Unsaved', '未保存', '未儲存') : phase === 'success' ? t('Connected', '连接正常', '連線正常') : phase === 'error' ? t('Needs attention', '需检查', '需檢查') : phase === 'checking' ? t('Checking', '检测中', '檢測中') : t('Not checked', '待检测', '待檢測');
  return <div className="speech-settings">
    <header className="speech-intro"><span className="speech-icon"><Mic size={23} /></span><div><h2>{t('Voice input', '语音输入', '語音輸入')}</h2><p>{t('Connect a speech service to turn your voice into text.', '连接识别服务，把说的话变成输入框里的文字。', '連接辨識服務，把說的話轉成輸入框裡的文字。')}</p></div></header>
    <form className="speech-panel" onSubmit={event => { event.preventDefault(); void run(true); }}>
      <div className="speech-panel-heading"><div><h3>{t('Recognition service', '识别服务', '辨識服務')}</h3><p>{t('OpenAI-compatible transcription endpoint', '支持 OpenAI 兼容的语音转写接口', '支援 OpenAI 相容的語音轉寫介面')}</p></div><span className="speech-status" data-state={dirty ? 'idle' : phase}><span />{stateLabel}</span></div>
      {loadFailed ? <div role="alert" className="speech-feedback"><CircleAlert size={16} /><span>{t('Unable to load settings.', '无法读取语音设置。', '無法讀取語音設定。')}</span><Button type="button" variant="outline" onClick={() => setAttempt(n => n + 1)}>{t('Retry', '重试', '重試')}</Button></div> : <fieldset disabled={!ready || busy} className="speech-fields">
        <label><span>{t('Endpoint URL', '识别接口地址', '辨識介面位址')}</span><input type="text" inputMode="url" autoComplete="off" spellCheck={false} value={values.REMOTE_ASR_URL} onChange={event => { setValues(v => ({ ...v, REMOTE_ASR_URL: event.target.value })); setPhase('idle'); setMessage(''); }} /><small>{t('Use the complete transcription URL provided by your service.', '填写服务提供的完整语音转写地址。', '填寫服務提供的完整語音轉寫位址。')}</small></label>
        <label><span>{t('Model name', '识别模型', '辨識模型')}</span><input autoComplete="off" spellCheck={false} value={values.REMOTE_ASR_MODEL} onChange={event => { setValues(v => ({ ...v, REMOTE_ASR_MODEL: event.target.value })); setPhase('idle'); setMessage(''); }} /><small>{t('Must match a model available on this service.', '名称需与识别服务中的模型一致。', '名稱需與辨識服務中的模型一致。')}</small></label>
      </fieldset>}
      {message && <div role={phase === 'error' ? 'alert' : 'status'} className="speech-feedback" data-state={phase}>{phase === 'success' ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}<span>{message}</span></div>}
      <footer className="speech-footer"><p>{dirty ? t('You have unsaved changes', '有尚未保存的修改', '有尚未儲存的修改') : t('Changes apply after saving', '保存后生效', '儲存後生效')}</p><div>
        {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setValues(saved); setPhase('idle'); setMessage(''); }}>{t('Discard', '放弃修改', '放棄修改')}</Button>}
        <Button type="button" variant="outline" disabled={!ready || busy || dirty} onClick={() => void run(false)}><Radio size={16} />{t('Test connection', '检测连接', '檢測連線')}</Button>
        <Button type="submit" disabled={!ready || busy}>{busy && <Loader2 className="animate-spin" size={16} />}{phase === 'saving' ? t('Saving…', '保存中…', '儲存中…') : phase === 'checking' ? t('Checking…', '检测中…', '檢測中…') : t('Save and test', '保存并检测', '儲存並檢測')}</Button>
      </div></footer>
    </form>
    <aside className="speech-guide"><Mic size={18} /><div><h3>{t('How to speak', '怎么使用', '如何使用')}</h3><p>{t('Hold the microphone in the composer, or hold Space when the input is empty. Release to transcribe, review the text, then send.', '在聊天输入框按住麦克风，或在空输入框中长按空格。松开后转成文字，确认内容再发送。', '在聊天輸入框按住麥克風，或在空輸入框中長按空白鍵。鬆開後轉成文字，確認內容再傳送。')}</p></div></aside>
    <div className="speech-coming"><Volume2 size={19} /><div><h3>{t('Speech synthesis', '语音合成', '語音合成')}<span>{t('Coming later', '暂未开放', '暫未開放')}</span></h3><p>{t('Voice playback is not connected yet. No setup is needed; existing settings are retained.', '语音播放尚未接入，暂时无需配置；已有设置会保留。', '語音播放尚未接入，暫時無需設定；已有設定會保留。')}</p></div></div>
  </div>;
}
