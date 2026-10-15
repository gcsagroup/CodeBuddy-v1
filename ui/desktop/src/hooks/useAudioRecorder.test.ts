import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioRecorder } from './useAudioRecorder';

const mocks = vi.hoisted(() => ({
  readDictationPreferences: vi.fn(),
  getDictationConfig: vi.fn(),
  transcribeDictation: vi.fn(),
  useConfig: vi.fn(),
  readDictationPreference: vi.fn(),
}));

vi.mock('../acp/dictationPreferences', () => ({
  readDictationPreferences: mocks.readDictationPreferences,
}));

vi.mock('../acp/dictation', () => ({
  getDictationConfig: mocks.getDictationConfig,
  transcribeDictation: mocks.transcribeDictation,
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
        data: new Float32Array([0.5, 0.5]),
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
        data: new Float32Array([0.5, 0.5]),
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
});
