import { checkDictationService } from '../../../acp/dictation';
import { useEffect, useState } from 'react';
import { acpReadConfig, acpUpsertConfig } from '../../../acp/config';
import { Button } from '../../ui/button';

const fields = [
  { key: 'REMOTE_ASR_URL', label: '识别接口地址', initial: 'http://192.168.9.101:18003/v1/audio/transcriptions' },
  { key: 'REMOTE_ASR_MODEL', label: '识别模型', initial: 'Qwen3-ASR-0.6B' },
  { key: 'REMOTE_TTS_URL', label: '合成接口地址', initial: '' },
  { key: 'REMOTE_TTS_MODEL', label: '合成模型', initial: '' },
];
export function SpeechSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
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
}
