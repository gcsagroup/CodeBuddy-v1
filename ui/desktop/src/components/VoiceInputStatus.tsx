import { LoaderCircle, Mic } from 'lucide-react';

export function VoiceInputStatus({
  recording,
  starting,
  startupStage,
  transcribing,
  waveform = [],
}: {
  recording: boolean;
  starting?: boolean;
  startupStage?: string;
  transcribing: boolean;
  waveform?: number[];
}) {
  if (!recording && !starting && !transcribing) return null;
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
