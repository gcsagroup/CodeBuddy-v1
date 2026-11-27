import { useEffect, useId, useSyncExternalStore } from 'react';
import { Loader2, Square, Volume2 } from 'lucide-react';
import { useIntl } from '../i18n';
import { selectNativeText } from '../utils/nativeLocalization';
import { speechPlayback } from '../utils/speechPlayback';
import { speechText } from '../utils/speechText';

export default function MessageSpeechButton({
  text,
  className,
}: {
  text: string;
  className: string;
}) {
  const id = useId(),
    { locale } = useIntl();
  const state = useSyncExternalStore(speechPlayback.subscribe, speechPlayback.getSnapshot);
  const active = state.id === id && state.status !== 'idle';
  const loading = active && state.status === 'loading';
  const label = selectNativeText(
    locale,
    loading ? 'Cancel queued playback' : active ? 'Stop playback' : 'Read aloud',
    loading ? '取消等待播报' : active ? '停止播报' : '语音播报',
    loading ? '取消等待播報' : active ? '停止播報' : '語音播報'
  );
  useEffect(() => () => speechPlayback.stop(id), [id]);
  return (
    <>
      <button
        type="button"
        className={className}
        title={label}
        aria-label={label}
        aria-pressed={active}
        aria-busy={loading}
        onClick={() => {
          if (active) {
            speechPlayback.stop(id);
            return;
          }
          // Use the reply's canonical text; DOM refs may also contain timestamps,
          // tool diagnostics, or action labels on terminal status cards.
          const spoken = speechText(text);
          if (spoken) void speechPlayback.start(id, spoken);
        }}
      >
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : active ? (
          <Square className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Volume2 className="h-3 w-3" aria-hidden="true" />
        )}
        <span>
          {loading ? selectNativeText(locale, 'Waiting…', '等待播报…', '等待播報…') : label}
        </span>
      </button>
    </>
  );
}
