import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

// Transient observations only. Durable job state and output publication remain in comfyui-tool.
const streams = new Map();
export function mediaStreamKey(dataDir, sessionId, kind, jobId) {
  return JSON.stringify([dataDir, sessionId, kind, jobId]);
}
export function consumeMediaEvent(state, bytes, binary, promptId) {
  // Older/in-flight jobs or custom nodes may still send image frames. Do not
  // retain, encode or forward them; the UI uses a local waiting animation.
  if (binary) return;
  let event; try { event = JSON.parse(bytes.toString()); } catch { return; }
  const data = event.data;
  if (!data || data.prompt_id !== promptId) return;
  if (['execution_success', 'execution_error', 'execution_interrupted'].includes(event.type) ||
      (event.type === 'executing' && data.node === null)) {
    if (state.historyHint !== event.type) {
      state.historyHint = event.type;
      state.checkRevision = (state.checkRevision ?? 0) + 1;
    }
  }
  const previous = [state.node, state.step, state.total];
  if (event.type === 'executing') {
    if (data.node !== null && typeof data.node !== 'string') return;
    if (state.node === data.node) return;
    state.node = typeof data.node === 'string' ? data.node : null;
    delete state.step; delete state.total;
  }
  if (event.type === 'progress' && Number.isFinite(data.value) && Number.isFinite(data.max) && data.max > 0 && data.value >= 0 && data.value <= data.max) {
    if (typeof data.node === 'string') state.node = data.node;
    state.step = data.value; state.total = data.max;
  }
  // A connected socket or a repeated status is not evidence of new work.
  if (previous.some((value, index) => value !== [state.node, state.step, state.total][index]))
    state.updatedAt = Date.now();
}
export async function watchMedia(key, server, job, { Socket = WebSocket } = {}) {
  let entry = streams.get(key);
  if (entry) { entry.touched = Date.now(); entry.promptId = job.prompt_id; return entry.ready; }
  const state = { connected: false };
  const url = new URL(`${server}/ws`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', job.job_id);
  const socket = new Socket(url, { handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024 });
  entry = { state, socket, promptId: job.prompt_id, touched: Date.now() }; streams.set(key, entry);
  entry.ready = new Promise(resolve => {
    const timer = setTimeout(resolve, 1500); timer.unref?.();
    const done = () => { clearTimeout(timer); resolve(); };
    socket.on('open', () => { state.connected = true; done(); });
    socket.on('error', done);
    socket.on('close', () => { state.connected = false; done(); if (streams.get(key) === entry) streams.delete(key); });
  });
  socket.on('message', (data, binary) => consumeMediaEvent(state, data, binary, entry.promptId));
  return entry.ready;
}
export const mediaObservation = key => streams.get(key)?.state ?? { connected: false };
// Terminal events wake a history check; they never publish completion themselves.
export function waitMediaCheck(key, milliseconds, signal, revision = 0) {
  const entry = streams.get(key);
  if (!entry) return delay(milliseconds, undefined, { signal });
  entry.touched = Date.now();
  signal?.throwIfAborted();
  if ((entry.state.checkRevision ?? 0) !== revision) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = error => {
      clearTimeout(timer); entry.socket.off('message', message); entry.socket.off('close', closed);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const message = (bytes, binary) => {
      if (binary) return;
      let event; try { event = JSON.parse(bytes.toString()); } catch { return; }
      if (event.data?.prompt_id !== entry.promptId) return;
      if (['execution_success', 'execution_error', 'execution_interrupted'].includes(event.type) ||
          (event.type === 'executing' && event.data.node === null)) done();
    };
    const closed = () => done();
    const aborted = () => done(signal.reason);
    const timer = setTimeout(() => done(), Math.max(0, milliseconds));
    entry.socket.on('message', message); entry.socket.on('close', closed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
export function stopMedia(key) { const item = streams.get(key); streams.delete(key); item?.socket.close(); }
export function closeMediaStreams(dataDir) {
  for (const key of streams.keys()) if (JSON.parse(key)[0] === dataDir) stopMedia(key);
}
const cleanup = setInterval(() => {
  for (const [key, entry] of streams) if (Date.now() - entry.touched > 120_000) stopMedia(key);
}, 30_000);
cleanup.unref();
