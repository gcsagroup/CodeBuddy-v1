import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioRecorder } from './useAudioRecorder';

const mocks = vi.hoisted(() => ({
  readDictationPreferences: vi.fn(),
  getDictationConfig: vi.fn(),
  transcribeDictation: vi.fn(),
  checkDictationService: vi.fn(),
  useConfig: vi.fn(),
  readDictationPreference: vi.fn(),
}));

vi.mock('../acp/dictationPreferences', () => ({
  readDictationPreferences: mocks.readDictationPreferences,
}));

vi.mock('../acp/dictation', () => ({
  getDictationConfig: mocks.getDictationConfig,
  transcribeDictation: mocks.transcribeDictation,
  checkDictationService: mocks.checkDictationService,
}));

vi.mock('../components/ConfigContext', () => ({
  useConfig: mocks.useConfig,
}));

vi.mock('../components/settings/dictation/dictationPreferences', () => ({
  DICTATION_PROVIDER_KEY: { canonical: 'VOICE_DICTATION_PROVIDER', legacy: 'provider' },
  DICTATION_PREFERRED_MIC_KEY: {
    canonical: 'VOICE_DICTATION_PREFERRED_MIC',
    legacy: 'microphone',
  },
  readDictationPreference: mocks.readDictationPreference,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeStream() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: vi.fn(() => [track]) } as unknown as MediaStream;
  return { stream, track };
}

function makeAudioContext() {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  return {
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    destination: {},
    close: vi.fn().mockResolvedValue(undefined),
    source,
    gain,
  };
}

describe('useAudioRecorder typed preferences and lifecycle', () => {
  const genericRead = vi.fn();
  const genericUpsert = vi.fn();
  const genericRemove = vi.fn();
  const getUserMedia = vi.fn();
  const workletNodes: Array<{
    port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  let audioContext = makeAudioContext();
  let AudioContextConstructor: ReturnType<typeof vi.fn>;
  let AudioWorkletNodeConstructor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkDictationService.mockResolvedValue(undefined);
    workletNodes.length = 0;
    audioContext = makeAudioContext();

    mocks.useConfig.mockReturnValue({
      read: genericRead,
      upsert: genericUpsert,
      remove: genericRemove,
      config: {},
    });
    mocks.readDictationPreference.mockImplementation(async (_read, _upsert, _remove, key) =>
      key.canonical === 'VOICE_DICTATION_PROVIDER' ? 'openai' : 'device-a'
    );
    mocks.readDictationPreferences.mockResolvedValue({
      revision: 1,
      provider: 'openai',
      preferredMic: 'device-a',
    });
    mocks.getDictationConfig.mockResolvedValue({ openai: { configured: true } });
    mocks.transcribeDictation.mockResolvedValue('transcribed');

    AudioContextConstructor = vi.fn(function AudioContextFake() {
      return audioContext;
    });
    AudioWorkletNodeConstructor = vi.fn(function AudioWorkletNodeFake() {
      const node = { port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
      workletNodes.push(node);
      return node;
    });
    vi.stubGlobal('AudioContext', AudioContextConstructor);
    vi.stubGlobal('AudioWorkletNode', AudioWorkletNodeConstructor);
    vi.stubGlobal(
      'FileReader',
      class FileReaderFake {
        result: string | null = null;
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        readAsDataURL() {
          this.result = 'data:audio/wav;base64,d2F2';
          void Promise.resolve().then(() => this.onloadend?.());
        }
      }
    );
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderRecorder() {
    const onTranscription = vi.fn();
    const onError = vi.fn();
    const hook = renderHook(() => useAudioRecorder({ onTranscription, onError }));
    return { ...hook, onTranscription, onError };
  }

  async function waitUntilEnabled(result: ReturnType<typeof renderRecorder>['result']) {
    await waitFor(() => expect(result.current.isEnabled).toBe(true));
  }

  it('uses fresh typed preferences for init, start, and transcription with zero useConfig calls', async () => {
    const { stream } = makeStream();
    getUserMedia.mockResolvedValue(stream);
    mocks.readDictationPreferences
      .mockResolvedValueOnce({ revision: 1, provider: 'openai', preferredMic: 'device-a' })
      .mockResolvedValueOnce({ revision: 2, provider: 'openai', preferredMic: 'device-a' })
      .mockResolvedValueOnce({ revision: 3, provider: 'groq', preferredMic: 'device-a' });
    mocks.getDictationConfig.mockResolvedValue({
      openai: { configured: true },
      groq: { configured: true },
    });
    const { result, onTranscription } = renderRecorder();
    await waitUntilEnabled(result);

    await act(async () => result.current.startRecording());
    act(() => {
      workletNodes[0].port.onmessage?.({
        data: new Float32Array(3200).fill(0.1),
      } as MessageEvent<Float32Array>);
      result.current.stopRecording();
    });

    await waitFor(() => expect(onTranscription).toHaveBeenCalledWith('transcribed'));
    expect(mocks.readDictationPreferences).toHaveBeenCalledTimes(3);
    expect(mocks.transcribeDictation).toHaveBeenCalledWith('d2F2', 'audio/wav', 'groq');
    expect(mocks.useConfig).not.toHaveBeenCalled();
    expect(genericRead).not.toHaveBeenCalled();
    expect(genericUpsert).not.toHaveBeenCalled();
    expect(genericRemove).not.toHaveBeenCalled();
  });

  it('fails closed to disabled when the authoritative preference read fails', async () => {
    mocks.readDictationPreferences.mockRejectedValue(new Error('preferences unavailable'));
    mocks.readDictationPreference.mockRejectedValue(new Error('legacy unavailable'));
    const { result } = renderRecorder();

    await waitFor(() => expect(result.current.dictationProvider).toBeNull());
    expect(result.current.isEnabled).toBe(false);
    expect(mocks.getDictationConfig).not.toHaveBeenCalled();
  });

  it('coalesces a double start while media acquisition is pending', async () => {
    const pendingStream = deferred<MediaStream>();
    const { stream } = makeStream();
    getUserMedia.mockReturnValue(pendingStream.promise);
    const { result } = renderRecorder();
    await waitUntilEnabled(result);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.startRecording();
      second = result.current.startRecording();
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    pendingStream.resolve(stream);
    await act(async () => Promise.all([first, second]));
    act(() => result.current.stopRecording());
  });

  it('stops a stream that resolves after unmount without creating audio state or callbacks', async () => {
    const pendingStream = deferred<MediaStream>();
    const { stream, track } = makeStream();
    getUserMedia.mockReturnValue(pendingStream.promise);
    const { result, unmount, onError, onTranscription } = renderRecorder();
    await waitUntilEnabled(result);

    let start!: Promise<void>;
    act(() => {
      start = result.current.startRecording();
    });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    unmount();
    pendingStream.resolve(stream);
    await start;

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(AudioContextConstructor).not.toHaveBeenCalled();
    expect(AudioWorkletNodeConstructor).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscription).not.toHaveBeenCalled();
  });

  it('fully disconnects an active audio graph on unmount without emitting callbacks', async () => {
    const { stream, track } = makeStream();
    getUserMedia.mockResolvedValue(stream);
    const { result, unmount, onError, onTranscription } = renderRecorder();
    await waitUntilEnabled(result);
    await act(async () => result.current.startRecording());

    const worklet = workletNodes[0];
    expect(worklet.port.onmessage).not.toBeNull();
    unmount();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(audioContext.source.disconnect).toHaveBeenCalledTimes(1);
    expect(worklet.disconnect).toHaveBeenCalledTimes(1);
    expect(audioContext.gain.disconnect).toHaveBeenCalledTimes(1);
    expect(worklet.port.onmessage).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    expect(onTranscription).not.toHaveBeenCalled();
  });

  it('cleans a stream when AudioContext construction fails', async () => {
    const { stream, track } = makeStream();
    const contextFailure = new Error('context unavailable');
    getUserMedia.mockResolvedValue(stream);
    AudioContextConstructor.mockImplementationOnce(function AudioContextFailure() {
      throw contextFailure;
    });
    const { result, onError } = renderRecorder();
    await waitUntilEnabled(result);

    await act(async () => result.current.startRecording());

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('context unavailable');
    expect(result.current.isRecording).toBe(false);
  });

  it('does not resurrect capture when addModule resolves after stop', async () => {
    const addModule = deferred<void>();
    const { stream, track } = makeStream();
    getUserMedia.mockResolvedValue(stream);
    audioContext.audioWorklet.addModule.mockReturnValue(addModule.promise);
    const { result } = renderRecorder();
    await waitUntilEnabled(result);

    let start!: Promise<void>;
    act(() => {
      start = result.current.startRecording();
    });
    await waitFor(() => expect(audioContext.audioWorklet.addModule).toHaveBeenCalled());
    act(() => result.current.stopRecording());
    addModule.resolve();
    await act(async () => start);

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(AudioWorkletNodeConstructor).not.toHaveBeenCalled();
    expect(result.current.isRecording).toBe(false);
  });

  it('cleans up an addModule failure without flushing or transcribing', async () => {
    const { stream, track } = makeStream();
    getUserMedia.mockResolvedValue(stream);
    audioContext.audioWorklet.addModule.mockRejectedValue(new Error('worklet unavailable'));
    const { result, onError } = renderRecorder();
    await waitUntilEnabled(result);

    await act(async () => result.current.startRecording());

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeDictation).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('worklet unavailable');
    expect(result.current.isRecording).toBe(false);
  });

  it('falls back from a missing preferred microphone and cleans the fallback stream', async () => {
    const { stream, track } = makeStream();
    const requestedAudio: MediaTrackConstraints[] = [];
    getUserMedia.mockImplementation(
      async ({ audio }: { audio?: boolean | MediaTrackConstraints }) => {
        requestedAudio.push(JSON.parse(JSON.stringify(audio)) as MediaTrackConstraints);
        if (requestedAudio.length === 1) {
          throw new DOMException('missing', 'NotFoundError');
        }
        return stream;
      }
    );
    const { result } = renderRecorder();
    await waitUntilEnabled(result);

    await act(async () => result.current.startRecording());

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(requestedAudio[0].deviceId).toEqual({ exact: 'device-a' });
    expect(requestedAudio[1].deviceId).toBeUndefined();
    act(() => result.current.stopRecording());
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
  });

  it('suppresses a late transcription callback after unmount', async () => {
    const transcription = deferred<string>();
    const { stream } = makeStream();
    getUserMedia.mockResolvedValue(stream);
    mocks.transcribeDictation.mockReturnValue(transcription.promise);
    const { result, unmount, onTranscription, onError } = renderRecorder();
    await waitUntilEnabled(result);
    await act(async () => result.current.startRecording());

    act(() => {
      workletNodes[0].port.onmessage?.({
        data: new Float32Array(3200).fill(0.1),
      } as MessageEvent<Float32Array>);
      result.current.stopRecording();
    });
    await waitFor(() => expect(mocks.transcribeDictation).toHaveBeenCalled());
    unmount();
    transcription.resolve('too late');
    await Promise.resolve();

    expect(onTranscription).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it('holds audible audio until release and ignores a transcription after changing conversations', async () => {
    const { stream } = makeStream();
    getUserMedia.mockResolvedValue(stream);
    mocks.getDictationConfig.mockResolvedValue({ remote: { configured: true } });
    const transcription = deferred<string>();
    mocks.transcribeDictation.mockReturnValue(transcription.promise);
    const onTranscription = vi.fn();
    const { result, rerender } = renderHook(({ scopeId }) => useAudioRecorder({
      onTranscription, onError: vi.fn(), pushToTalk: true, scopeId,
    }), { initialProps: { scopeId: 'first' } });
    await waitUntilEnabled(result);
    await act(async () => result.current.startRecording());
    act(() => {
      workletNodes[0].port.onmessage?.({ data: new Float32Array(3200).fill(0.1) } as MessageEvent<Float32Array>);
    });
    expect(mocks.transcribeDictation).not.toHaveBeenCalled();
    act(() => result.current.stopRecording());
    await waitFor(() => expect(mocks.transcribeDictation).toHaveBeenCalledWith('d2F2', 'audio/wav', 'remote'));
    expect(mocks.readDictationPreferences).toHaveBeenCalledTimes(2);
    expect(mocks.getDictationConfig).toHaveBeenCalledTimes(2);
    rerender({ scopeId: 'second' });
    await act(async () => transcription.resolve('old conversation'));
    expect(onTranscription).not.toHaveBeenCalled();
  });

  it('shows microphone startup and derives waveform levels from audio, clearing them on release', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const { result } = renderRecorder();
    await waitUntilEnabled(result);
    let starting!: Promise<void>;
    act(() => { starting = result.current.startRecording(); });
    expect(result.current.isStarting).toBe(true);
    await act(async () => { permission.resolve(makeStream().stream); await starting; });
    expect(result.current.isStarting).toBe(false);
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValue(1000);
    act(() => workletNodes[0].port.onmessage?.({ data: new Float32Array(128) } as MessageEvent<Float32Array>));
    expect(result.current.waveform[result.current.waveform.length - 1]).toBe(0);
    clock.mockReturnValue(1050);
    act(() => workletNodes[0].port.onmessage?.({ data: new Float32Array(128).fill(0.1) } as MessageEvent<Float32Array>));
    expect(result.current.waveform[result.current.waveform.length - 1]).toBeGreaterThan(0);
    act(() => result.current.stopRecording());
    expect(result.current.waveform).toEqual([]);
    clock.mockRestore();
  });

  it('reports an unavailable recognition service before opening the microphone', async () => {
    mocks.checkDictationService.mockRejectedValue(new Error('语音识别服务不可用'));
    const { result, onError } = renderRecorder();
    await waitUntilEnabled(result);
    await act(async () => result.current.startRecording());
    expect(onError).toHaveBeenCalledWith('语音识别服务不可用');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.isStarting).toBe(false);
    expect(result.current.isRecording).toBe(false);
  });

  it.each(['silence', 'low-noise', 'click', 'no-frames'])('does not upload %s and offers a retry', async kind => {
    getUserMedia.mockResolvedValue(makeStream().stream);
    const onTranscription = vi.fn();
    const { result } = renderHook(() => useAudioRecorder({ onTranscription, onError: vi.fn(), pushToTalk: true }));
    await waitUntilEnabled(result);
    await act(async () => result.current.startRecording());
    const audio = new Float32Array(16000);
    if (kind === 'low-noise') audio.fill(0.002);
    if (kind === 'click') audio.fill(0.8, 0, 320);
    act(() => {
      if (kind !== 'no-frames') workletNodes[0].port.onmessage?.({ data: audio } as MessageEvent<Float32Array>);
      result.current.stopRecording();
    });
    expect(mocks.transcribeDictation).not.toHaveBeenCalled();
    expect(onTranscription).not.toHaveBeenCalled();
    expect(result.current.notice).toBe('no-speech');
    expect(result.current.isTranscribing).toBe(false);
    await act(async () => result.current.startRecording());
    expect(result.current.notice).toBeNull();
    act(() => {
      workletNodes[1].port.onmessage?.({ data: new Float32Array(3200).fill(0.1) } as MessageEvent<Float32Array>);
      result.current.stopRecording();
    });
    await waitFor(() => expect(onTranscription).toHaveBeenCalledWith('transcribed'));
    expect(mocks.transcribeDictation).toHaveBeenCalledOnce();
  });

  it.each(['', '   \n'])('shows an empty-transcript notice without inserting %j', async text => {
    getUserMedia.mockResolvedValue(makeStream().stream);
    mocks.transcribeDictation.mockResolvedValue(text);
    const onTranscription = vi.fn();
    const { result, rerender } = renderHook(({ scopeId }) => useAudioRecorder({
      onTranscription, onError: vi.fn(), pushToTalk: true, scopeId,
    }), { initialProps: { scopeId: 'first' } });
    await waitUntilEnabled(result);
    await act(async () => result.current.startRecording());
    act(() => {
      workletNodes[0].port.onmessage?.({ data: new Float32Array(3200).fill(0.1) } as MessageEvent<Float32Array>);
      result.current.stopRecording();
    });
    await waitFor(() => expect(result.current.notice).toBe('empty-transcript'));
    expect(onTranscription).not.toHaveBeenCalled();
    expect(result.current.isTranscribing).toBe(false);
    rerender({ scopeId: 'second' });
    expect(result.current.notice).toBeNull();
  });

  it('times out a microphone permission prompt and releases a stream returned later', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const { result, onError } = renderRecorder();
    await waitUntilEnabled(result);
    vi.useFakeTimers();
    try {
      await act(async () => { void result.current.startRecording(); });
      expect(getUserMedia).toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('麦克风开启超时'));
      expect(result.current.isStarting).toBe(false);
      expect(result.current.isRecording).toBe(false);
      const late = makeStream();
      await act(async () => permission.resolve(late.stream));
      expect(late.track.stop).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['NotAllowedError', '权限被拒绝'],
    ['NotFoundError', '未找到可用麦克风'],
    ['NotReadableError', '设备可能被占用'],
  ])('explains microphone failure %s', async (name, message) => {
    getUserMedia.mockRejectedValue(new DOMException('Device error', name));
    const { result, onError } = renderRecorder();
    await waitUntilEnabled(result);
    await act(async () => result.current.startRecording());
    expect(onError).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(result.current.isStarting).toBe(false);
  });


});
