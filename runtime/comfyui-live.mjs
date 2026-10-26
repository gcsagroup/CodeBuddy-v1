import WebSocket from 'ws';

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
  if (event.type === 'executing') {
    state.node = typeof data.node === 'string' ? data.node : null;
    delete state.step; delete state.total;
  }
  if (event.type === 'progress' && Number.isFinite(data.value) && Number.isFinite(data.max) && data.max > 0 && data.value >= 0 && data.value <= data.max) {
    if (typeof data.node === 'string') state.node = data.node;
    state.step = data.value; state.total = data.max;
  }
  state.updatedAt = Date.now();
}
export async function watchMedia(key, server, job, { Socket = WebSocket } = {}) {
  let entry = streams.get(key);
  if (entry) { entry.touched = Date.now(); return entry.ready; }
  const state = { connected: false };
  const url = new URL(`${server}/ws`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', job.job_id);
  const socket = new Socket(url, { handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024 });
  entry = { state, socket, touched: Date.now() }; streams.set(key, entry);
  entry.ready = new Promise(resolve => {
    const timer = setTimeout(resolve, 1500); timer.unref?.();
    const done = () => { clearTimeout(timer); resolve(); };
    socket.on('open', () => { state.connected = true; done(); });
    socket.on('error', done);
    socket.on('close', () => { state.connected = false; done(); if (streams.get(key) === entry) streams.delete(key); });
  });
  socket.on('message', (data, binary) => consumeMediaEvent(state, data, binary, job.prompt_id));
  return entry.ready;
}
export const mediaObservation = key => streams.get(key)?.state ?? { connected: false };
export function stopMedia(key) { const item = streams.get(key); streams.delete(key); item?.socket.close(); }
export function closeMediaStreams(dataDir) {
  for (const key of streams.keys()) if (JSON.parse(key)[0] === dataDir) stopMedia(key);
}
const cleanup = setInterval(() => {
  for (const [key, entry] of streams) if (Date.now() - entry.touched > 120_000) stopMedia(key);
}, 30_000);
cleanup.unref();
