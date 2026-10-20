import WebSocket from 'ws';

// Transient observations only. Durable job state and output publication remain in comfyui-tool.
const streams = new Map();
export function mediaStreamKey(dataDir, sessionId, kind, jobId) {
  return JSON.stringify([dataDir, sessionId, kind, jobId]);
}
export function consumeMediaEvent(state, bytes, binary, promptId) {
  if (binary) {
    if (bytes.length < 9 || bytes.length > 2 * 1024 * 1024) return;
    const type = bytes.readUInt32BE(0);
    let offset = 8;
    if (type === 4) {
      const length = bytes.readUInt32BE(4);
      if (length > 8192 || 8 + length >= bytes.length) return;
      let meta; try { meta = JSON.parse(bytes.toString('utf8', 8, 8 + length)); } catch { return; }
      if (meta.prompt_id !== promptId) return;
      offset += length;
    } else if (type !== 1 || !state.node) return;
    const data = bytes.subarray(offset);
    const mime = data[0] === 255 && data[1] === 216 ? 'image/jpeg'
      : data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : null;
    if (!mime) return;
    state.preview = `data:${mime};base64,${data.toString('base64')}`;
    state.previewAt = Date.now();
    return;
  }
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
    socket.on('open', () => { state.connected = true; socket.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } })); done(); });
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
