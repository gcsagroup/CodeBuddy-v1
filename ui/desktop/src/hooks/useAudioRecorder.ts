import { useState, useRef, useCallback, useEffect } from 'react';
import { getDictationConfig, transcribeDictation } from '../acp/dictation';
import { readDictationPreferences } from '../acp/dictationPreferences';
import type { DictationProvider } from '../types/dictation';
import { errorMessage } from '../utils/conversionUtils';

interface UseAudioRecorderOptions {
  onTranscription: (text: string) => void;
  onError: (message: string) => void;
}

const SAMPLE_RATE = 16000;
const SILENCE_MS = 800;
const MIN_SPEECH_MS = 200;
// RMS threshold for speech detection. Audio samples are Float32 in [-1, 1] range.
// 0.015 (~1.5% of full-scale) distinguishes normal speech from background noise
// without clipping early speech onsets. Determined empirically for 16kHz mono input.
const RMS_THRESHOLD = 0.015;

// Resolve worklet URL at runtime from window.location so it works under both
// the dev server (http://localhost) and packaged builds (file://).
const WORKLET_URL = new URL('audio-capture-worklet.js', window.location.href.split('#')[0]).href;

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return buf;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve((r.result as string).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function closeAudioContext(context: AudioContext | null): void {
  if (!context) return;
  try {
    void context.close().catch(() => undefined);
  } catch {
    // The context is already unusable; the remaining resources are still released.
  }
}

async function readConfiguredDictation(): Promise<{
  provider: DictationProvider | null;
  preferredMic: string | null;
  enabled: boolean;
}> {
  const preferences = await readDictationPreferences();
  if (!preferences.provider) {
    return { provider: null, preferredMic: preferences.preferredMic, enabled: false };
  }
  const providers = await getDictationConfig();
  return {
    provider: preferences.provider,
    preferredMic: preferences.preferredMic,
    enabled: Boolean(providers[preferences.provider]?.configured),
  };
}

export const useAudioRecorder = ({ onTranscription, onError }: UseAudioRecorderOptions) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isEnabled, setIsEnabled] = useState(false);
  const [provider, setProvider] = useState<DictationProvider | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const connectedNodesRef = useRef<Array<{ disconnect?: () => void }>>([]);
  const mountedRef = useRef(true);
  const captureGenerationRef = useRef(0);
  const preferenceGenerationRef = useRef(0);
  const isRecordingRef = useRef(false);
  const startAttemptRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);

  // VAD state (all refs to avoid re-render/stale closure issues)
  const samplesRef = useRef<Float32Array[]>([]);
  const isSpeakingRef = useRef(false);
  const silenceStartRef = useRef(0);
  const speechStartRef = useRef(0);
  const pendingTranscriptions = useRef(0);

  // Keep callback refs fresh
  const onTranscriptionRef = useRef(onTranscription);
  onTranscriptionRef.current = onTranscription;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const applyDictationState = useCallback(
    (next: { provider: DictationProvider | null; enabled: boolean }) => {
      if (!mountedRef.current) return;
      setProvider(next.provider);
      setIsEnabled(next.enabled);
    },
    []
  );

  const transcribeChunk = useCallback(
    async (samples: Float32Array) => {
      pendingTranscriptions.current++;
      if (mountedRef.current) setIsTranscribing(true);

      try {
        const preferenceGeneration = ++preferenceGenerationRef.current;
        let state: Awaited<ReturnType<typeof readConfiguredDictation>>;
        try {
          state = await readConfiguredDictation();
        } catch (reason) {
          if (mountedRef.current && preferenceGeneration === preferenceGenerationRef.current) {
            applyDictationState({ provider: null, enabled: false });
            onErrorRef.current(errorMessage(reason));
          }
          return;
        }
        if (!mountedRef.current) return;
        if (preferenceGeneration === preferenceGenerationRef.current) {
          applyDictationState(state);
        }
        if (!state.enabled || !state.provider) return;

        const wav = new Blob([encodeWav(samples, SAMPLE_RATE)], { type: 'audio/wav' });
        const base64 = await blobToBase64(wav);
        if (!mountedRef.current) return;
        const text = await transcribeDictation(base64, 'audio/wav', state.provider);
        if (mountedRef.current && text) {
          onTranscriptionRef.current(text);
        }
      } catch (reason) {
        if (mountedRef.current) onErrorRef.current(errorMessage(reason));
      } finally {
        pendingTranscriptions.current--;
        if (mountedRef.current && pendingTranscriptions.current === 0) {
          setIsTranscribing(false);
        }
      }
    },
    [applyDictationState]
  );

  const flush = useCallback(() => {
    const chunks = samplesRef.current;
    if (chunks.length === 0) return;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    samplesRef.current = [];
    void transcribeChunk(merged);
  }, [transcribeChunk]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const handleSamples = useCallback((samples: Float32Array) => {
    const now = Date.now();

    if (rms(samples) > RMS_THRESHOLD) {
      if (!isSpeakingRef.current) {
        isSpeakingRef.current = true;
        speechStartRef.current = now;
      }
      silenceStartRef.current = 0;
      samplesRef.current.push(new Float32Array(samples));
    } else if (isSpeakingRef.current) {
      samplesRef.current.push(new Float32Array(samples));

      if (silenceStartRef.current === 0) {
        silenceStartRef.current = now;
      } else if (now - silenceStartRef.current > SILENCE_MS) {
        if (now - speechStartRef.current > MIN_SPEECH_MS) {
          flushRef.current();
        } else {
          samplesRef.current = [];
        }
        isSpeakingRef.current = false;
        silenceStartRef.current = 0;
      }
    }
  }, []);

  const cleanupCapture = useCallback((discardSamples: boolean) => {
    const worklet = workletRef.current;
    workletRef.current = null;
    if (worklet) worklet.port.onmessage = null;

    for (const node of connectedNodesRef.current) {
      try {
        node.disconnect?.();
      } catch {
        // A partially initialized node may already be disconnected.
      }
    }
    connectedNodesRef.current = [];

    const context = audioContextRef.current;
    audioContextRef.current = null;
    closeAudioContext(context);

    const stream = streamRef.current;
    streamRef.current = null;
    stopStream(stream);

    if (discardSamples) samplesRef.current = [];
    isSpeakingRef.current = false;
    silenceStartRef.current = 0;
    speechStartRef.current = 0;
    isRecordingRef.current = false;
    if (mountedRef.current) setIsRecording(false);
  }, []);

  const stopRecording = useCallback(() => {
    if (isSpeakingRef.current && samplesRef.current.length > 0) {
      flushRef.current();
    }
    captureGenerationRef.current++;
    startAttemptRef.current = null;
    cleanupCapture(true);
  }, [cleanupCapture]);

  const runStartAttempt = useCallback(
    async (generation: number) => {
      let loadedPreferences = false;
      try {
        const preferenceGeneration = ++preferenceGenerationRef.current;
        const state = await readConfiguredDictation();
        loadedPreferences = true;
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;
        if (preferenceGeneration === preferenceGenerationRef.current) {
          applyDictationState(state);
        }
        if (!state.enabled || !state.provider) {
          onErrorRef.current('Voice dictation is not enabled');
          return;
        }

        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (state.preferredMic) {
          audioConstraints.deviceId = { exact: state.preferredMic };
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        } catch (reason) {
          if (
            state.preferredMic &&
            reason instanceof DOMException &&
            (reason.name === 'NotFoundError' || reason.name === 'OverconstrainedError')
          ) {
            if (!mountedRef.current || generation !== captureGenerationRef.current) return;
            const fallbackConstraints = { ...audioConstraints };
            delete fallbackConstraints.deviceId;
            stream = await navigator.mediaDevices.getUserMedia({ audio: fallbackConstraints });
          } else {
            throw reason;
          }
        }
        if (!mountedRef.current || generation !== captureGenerationRef.current) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;

        const context = new AudioContext({ sampleRate: SAMPLE_RATE });
        audioContextRef.current = context;
        await context.audioWorklet.addModule(WORKLET_URL);
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;

        const source = context.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(context, 'audio-capture');
        workletRef.current = worklet;
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (mountedRef.current && generation === captureGenerationRef.current) {
            handleSamples(event.data);
          }
        };

        // Connect through silent gain to keep worklet processing alive.
        const silence = context.createGain();
        silence.gain.value = 0;
        source.connect(worklet);
        worklet.connect(silence);
        silence.connect(context.destination);
        connectedNodesRef.current = [source, worklet, silence];

        isRecordingRef.current = true;
        if (mountedRef.current) setIsRecording(true);
      } catch (reason) {
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;
        if (!loadedPreferences) applyDictationState({ provider: null, enabled: false });
        cleanupCapture(true);
        onErrorRef.current(errorMessage(reason));
      }
    },
    [applyDictationState, cleanupCapture, handleSamples]
  );

  const startRecording = useCallback((): Promise<void> => {
    const activeAttempt = startAttemptRef.current;
    if (activeAttempt) return activeAttempt.promise;
    if (isRecordingRef.current) return Promise.resolve();

    const generation = ++captureGenerationRef.current;
    const promise = runStartAttempt(generation);
    const attempt = { generation, promise };
    startAttemptRef.current = attempt;
    void promise.finally(() => {
      if (startAttemptRef.current === attempt) startAttemptRef.current = null;
    });
    return promise;
  }, [runStartAttempt]);

  useEffect(() => {
    const captureGeneration = captureGenerationRef;
    const preferenceGeneration = preferenceGenerationRef;
    mountedRef.current = true;
    const requestGeneration = ++preferenceGeneration.current;
    void readConfiguredDictation()
      .then((state) => {
        if (mountedRef.current && requestGeneration === preferenceGeneration.current) {
          applyDictationState(state);
        }
      })
      .catch(() => {
        if (mountedRef.current && requestGeneration === preferenceGeneration.current) {
          applyDictationState({ provider: null, enabled: false });
        }
      });

    return () => {
      mountedRef.current = false;
      captureGeneration.current++;
      preferenceGeneration.current++;
      startAttemptRef.current = null;
      cleanupCapture(true);
    };
  }, [applyDictationState, cleanupCapture]);

  return {
    isEnabled,
    dictationProvider: provider,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
  };
};
