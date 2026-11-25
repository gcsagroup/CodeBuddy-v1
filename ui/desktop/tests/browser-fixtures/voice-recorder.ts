import { useState, useRef, useCallback } from 'react';
import type { VoiceInputNotice } from '../../src/hooks/useAudioRecorder';

// UI-only fixture. PCM filtering and upload counts are covered by recorder tests.
export function useAudioRecorder() {
  const [isRecording, setRecording] = useState(false);
  const active = useRef(false);
  const [notice, setNotice] = useState<VoiceInputNotice | null>(null);
  const stopRecording = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    setRecording(false);
    setNotice(new URLSearchParams(location.search).get('notice') === 'empty' ? 'empty-transcript' : 'no-speech');
  }, []);
  return {
    isRecording, isStarting: false, isTranscribing: false, waveform: [], notice,
    startRecording: async () => { setNotice(null); active.current = true; setRecording(true); },
    stopRecording,
    clearNotice: () => setNotice(null),
  };
}
