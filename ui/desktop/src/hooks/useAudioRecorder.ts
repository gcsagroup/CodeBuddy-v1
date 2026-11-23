import { useState, useRef, useCallback, useEffect } from 'react';
import { checkDictationService, getDictationConfig, transcribeDictation } from '../acp/dictation';
import { readDictationPreferences } from '../acp/dictationPreferences';
import type { DictationProvider } from '../types/dictation';
import { errorMessage } from '../utils/conversionUtils';

interface UseAudioRecorderOptions {
  onTranscription: (text: string) => void;
  onError: (message: string) => void;
  pushToTalk?: boolean;
  scopeId?: string | null;
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

function withStartupTimeout<T>(operation: Promise<T>, message: string, discardLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(message));
    }, 8000);
    operation.then(value => {
      clearTimeout(timer);
      if (timedOut) discardLate?.(value);
      else resolve(value);
    }, error => {
      clearTimeout(timer);
      if (!timedOut) reject(error);
    });
  });
}

function requestMicrophone(constraints: MediaTrackConstraints): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('当前窗口无法访问麦克风，请检查系统麦克风权限。'));
  }
  return withStartupTimeout(
    navigator.mediaDevices.getUserMedia({ audio: constraints }),
    '麦克风开启超时，请检查权限提示、系统麦克风权限及设备连接后重试。',
    stopStream
  );
}

function recordingError(reason: unknown): string {
  if (reason instanceof DOMException) {
    switch (reason.name) {
      case 'NotAllowedError': case 'SecurityError':
        return '麦克风权限被拒绝，请在系统隐私设置中允许 CodeBuddy 使用麦克风。';
      case 'NotFoundError': case 'OverconstrainedError':
        return '未找到可用麦克风，请连接设备或更换输入设备。';
      case 'NotReadableError': case 'AbortError':
        return '无法打开麦克风，设备可能被占用或已断开，请检查后重试。';
    }
  }
  return errorMessage(reason);
}

function closeAudioContext(context: AudioContext | null): void {
  if (!context) return;
  try {
    void context.close().catch(() => undefined);
  } catch {
    // The context is already unusable; the remaining resources are still released.
  }
}

async function readConfiguredDictation(parallel = false): Promise<{
  provider: DictationProvider | null;
  preferredMic: string | null;
  enabled: boolean;
}> {
  const preferencesRequest = readDictationPreferences();
  const providersRequest = parallel ? getDictationConfig() : preferencesRequest.then(() => getDictationConfig());
  const [preferences, providers] = await Promise.all([preferencesRequest, providersRequest]);
  if (providers.remote?.configured) return { provider: 'remote', preferredMic: preferences.preferredMic, enabled: true };
  if (!preferences.provider) {
    return { provider: null, preferredMic: preferences.preferredMic, enabled: false };
  }
  return {
    provider: preferences.provider,
    preferredMic: preferences.preferredMic,
    enabled: Boolean(providers[preferences.provider]?.configured),
  };
}

export const useAudioRecorder = ({ onTranscription, onError, pushToTalk = false, scopeId }: UseAudioRecorderOptions) => {
  const scopeRef = useRef({ id: scopeId });
  if (scopeRef.current.id !== scopeId) scopeRef.current = { id: scopeId };
  const recordingScope = useRef(scopeRef.current);
  const recordingProvider = useRef<DictationProvider | null>(null);
  const [startupStage, setStartupStage] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [waveform, setWaveform] = useState<number[]>([]);
  const waveformTick = useRef(0);
  const waveformPeak = useRef(0);
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
      const transcriptionScope = recordingScope.current;
      pendingTranscriptions.current++;
      if (mountedRef.current) setIsTranscribing(true);

      try {
        let selectedProvider = recordingProvider.current;
        if (!pushToTalk) {
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
          selectedProvider = state.provider;
        }
        if (!selectedProvider) return;
        const encodingStarted = performance.now();
        const wav = new Blob([encodeWav(samples, SAMPLE_RATE)], { type: 'audio/wav' });
        const base64 = await blobToBase64(wav);
        if (!mountedRef.current) return;
        console.debug('[voice-input] audio encoding ms', Math.round(performance.now() - encodingStarted));
        const requestStarted = performance.now();
        const text = await transcribeDictation(base64, 'audio/wav', selectedProvider);
        console.debug('[voice-input] transcription round trip ms', Math.round(performance.now() - requestStarted));
        if (mountedRef.current && scopeRef.current === transcriptionScope && text) {
          onTranscriptionRef.current(text);
        }
      } catch (reason) {
        if (mountedRef.current && scopeRef.current === transcriptionScope) onErrorRef.current(errorMessage(reason));
      } finally {
        pendingTranscriptions.current--;
        if (mountedRef.current && pendingTranscriptions.current === 0) {
          setIsTranscribing(false);
        }
      }
    },
    [applyDictationState, pushToTalk]
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
    waveformPeak.current = Math.max(waveformPeak.current, rms(samples));
    const tick = performance.now();
    // Limit visual updates while retaining the loudest sample block in each interval.
    if (tick - waveformTick.current >= 50) {
      const level = Math.min(1, Math.sqrt(waveformPeak.current) * 2);
      setWaveform(previous => [...previous.slice(-31), level]);
      waveformPeak.current = 0;
      waveformTick.current = tick;
    }
    if (pushToTalk) {
      samplesRef.current.push(new Float32Array(samples));
      isSpeakingRef.current = true;
      return;
    }
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
  }, [pushToTalk]);

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
    if (mountedRef.current) {
      setIsRecording(false);
      setIsStarting(false);
      setWaveform([]);
    }
    waveformPeak.current = 0;
    waveformTick.current = 0;
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
      setStartupStage('正在读取语音配置…');
      let loadedPreferences = false;
      let stageStarted = performance.now();
      try {
        const preferenceGeneration = ++preferenceGenerationRef.current;
        const state = await withStartupTimeout(readConfiguredDictation(pushToTalk), '读取语音输入配置超时，请重试。');
        console.debug('[voice-input] configuration ms', Math.round(performance.now() - stageStarted));
        loadedPreferences = true;
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;
        if (preferenceGeneration === preferenceGenerationRef.current) {
          applyDictationState(state);
        }
        if (!state.enabled || !state.provider) {
          onErrorRef.current('Voice dictation is not enabled');
          return;
        }

        recordingProvider.current = state.provider;
        setStartupStage('正在读取服务检测结果…');
        const checkStarted = performance.now();
        await withStartupTimeout(checkDictationService(state.provider), '语音识别服务状态读取超时，请重试。');
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;
        console.debug('[voice-input] cached service status ms', Math.round(performance.now() - checkStarted));
        setStartupStage('正在打开麦克风…');
        stageStarted = performance.now();
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
          stream = await requestMicrophone(audioConstraints);
        } catch (reason) {
          if (
            state.preferredMic &&
            reason instanceof DOMException &&
            (reason.name === 'NotFoundError' || reason.name === 'OverconstrainedError')
          ) {
            if (!mountedRef.current || generation !== captureGenerationRef.current) return;
            const fallbackConstraints = { ...audioConstraints };
            delete fallbackConstraints.deviceId;
            stream = await requestMicrophone(fallbackConstraints);
          } else {
            throw reason;
          }
        }
        if (!mountedRef.current || generation !== captureGenerationRef.current) {
          stopStream(stream);
          return;
        }
        console.debug('[voice-input] microphone acquisition ms', Math.round(performance.now() - stageStarted));
        stageStarted = performance.now();
        streamRef.current = stream;

        setStartupStage('正在初始化音频…');
        const context = new AudioContext({ sampleRate: SAMPLE_RATE });
        audioContextRef.current = context;
        await withStartupTimeout(context.audioWorklet.addModule(WORKLET_URL), '麦克风音频模块初始化超时，请重试。');
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;
        if (context.state === 'suspended') {
          await withStartupTimeout(context.resume(), '麦克风音频处理启动超时，请重试。');
        }
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;

        const source = context.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(context, 'audio-capture');
        workletRef.current = worklet;
        let firstAudioFrame = true;
        const streamStarted = performance.now();
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (mountedRef.current && generation === captureGenerationRef.current) {
            if (firstAudioFrame) {
              firstAudioFrame = false;
              console.debug('[voice-input] first audio frame ms', Math.round(performance.now() - streamStarted));
            }
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

        console.debug('[voice-input] audio initialization ms', Math.round(performance.now() - stageStarted));
        isRecordingRef.current = true;
        if (mountedRef.current) setIsRecording(true);
      } catch (reason) {
        if (!mountedRef.current || generation !== captureGenerationRef.current) return;
        if (!loadedPreferences) applyDictationState({ provider: null, enabled: false });
        cleanupCapture(true);
        onErrorRef.current(recordingError(reason));
      }
    },
    [applyDictationState, cleanupCapture, handleSamples, pushToTalk]
  );

  const startRecording = useCallback((): Promise<void> => {
    const activeAttempt = startAttemptRef.current;
    if (activeAttempt) return activeAttempt.promise;
    if (isRecordingRef.current) return Promise.resolve();

    setIsStarting(true);
    recordingScope.current = scopeRef.current;
    const generation = ++captureGenerationRef.current;
    const promise = runStartAttempt(generation);
    const attempt = { generation, promise };
    startAttemptRef.current = attempt;
    void promise.finally(() => {
      if (startAttemptRef.current === attempt) {
        startAttemptRef.current = null;
        if (mountedRef.current) setIsStarting(false);
      }
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
    isStarting,
    startupStage,
    waveform,
    isEnabled,
    dictationProvider: provider,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
  };
};
