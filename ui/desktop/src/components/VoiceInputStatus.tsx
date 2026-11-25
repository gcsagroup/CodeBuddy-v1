import { LoaderCircle, Mic, X } from 'lucide-react';
import type { VoiceInputNotice } from '../hooks/useAudioRecorder';
import { currentLocale } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';

const t = (en: string, cn: string, tw: string) => selectNativeText(currentLocale, en, cn, tw);

export function VoiceInputStatus({
  recording,
  starting,
  startupStage,
  transcribing,
  waveform = [],
  notice,
  onDismiss,
  onRetry,
}: {
  recording: boolean;
  starting?: boolean;
  startupStage?: string;
  transcribing: boolean;
  waveform?: number[];
  notice?: VoiceInputNotice | null;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  if (!recording && !starting && !transcribing) {
    if (!notice) return null;
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-amber-500/15 bg-amber-500/5 px-3 py-2 text-text-secondary">
        <span role="status" className="min-w-0 flex-1 text-xs">
          {notice === 'no-speech'
            ? t('No speech detected. Hold the microphone to try again.', '未检测到清晰语音，请按住麦克风重试。', '未偵測到清晰語音，請按住麥克風重試。')
            : t('No transcript was returned. Hold the microphone to try again.', '未识别到文字，请按住麦克风重试。', '未辨識到文字，請按住麥克風重試。')}
        </span>
        {onRetry && <button type="button" className="shrink-0 text-xs underline underline-offset-2" onClick={onRetry}>{t('Retry', '重试', '重試')}</button>}
        {onDismiss && <button type="button" className="shrink-0 rounded p-1" aria-label={t('Dismiss voice notice', '关闭语音提示', '關閉語音提示')} onClick={onDismiss}><X size={14} aria-hidden="true" /></button>}
      </div>
    );
  }
  const label = recording ? '正在录音 · 松开结束' : starting ? (startupStage || '正在准备语音输入…') : '正在识别语音…';
  const levels = [...Array<number>(Math.max(0, 32 - waveform.length)).fill(0), ...waveform];
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl bg-violet-500/5 px-3 py-2 text-violet-600 dark:text-violet-300">
      {recording ? <Mic size={16} className="shrink-0" aria-hidden="true" /> : <LoaderCircle size={16} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {recording && (
        <div aria-hidden="true" className="flex h-7 min-w-0 flex-1 items-center justify-center gap-0.5 overflow-hidden">
          {levels.map((level, index) => (
            <span key={index} className="w-1 shrink-0 rounded-full bg-current" style={{ height: `${3 + level * 25}px`, opacity: 0.35 + level * 0.65 }} />
          ))}
        </div>
      )}
      <span role="status" className="text-xs">{label}</span>
    </div>
  );
}
