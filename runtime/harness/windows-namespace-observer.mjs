import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { extendWin32ProcessBindings, isNullPtr, Win32Error } from '@deepseek-ai/dsh-win32-process';

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-win32-process'));
let native;
function bindings() {
  if (native) return native;
  const koffi = require('koffi');
  const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
    createFile: bind(kernel32, 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
    getFileInformation: bind(kernel32, 'GetFileInformationByHandle', 'int', ['void *', 'void *']),
    getLongPath: bind(kernel32, 'GetLongPathNameW', 'uint32', ['str16', 'void *', 'uint32']),
    createEvent: bind(kernel32, 'CreateEventW', 'void *', ['void *', 'int', 'int', 'str16']),
    resetEvent: bind(kernel32, 'ResetEvent', 'int', ['void *']),
    readChanges: bind(kernel32, 'ReadDirectoryChangesW', 'int', ['void *', 'void *', 'uint32', 'int', 'uint32', 'void *', 'void *', 'void *']),
    getResult: bind(kernel32, 'GetOverlappedResult', 'int', ['void *', 'void *', 'void *', 'int']),
    cancel: bind(kernel32, 'CancelIoEx', 'int', ['void *', 'void *']),
  }));
  return native = { api, koffi };
}

const invalidHandle = value => isNullPtr(value) || value === -1n || value === 0xffffffffffffffffn;
const observerError = (code, message) => Object.assign(new Error(message), { code });

// The observer reports candidates, never permission decisions. The label helper
// still pins ancestors and rejects links, foreign owners and protected policy.
export function createNamespaceObserver(root, onChange, onInvalidate, { bufferSize = 65536, pollIntervalMs = 10 } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Namespace observation requires Windows x64');
  if (!Number.isInteger(bufferSize) || bufferSize < 4096 || bufferSize > 65536 || bufferSize % 4 ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) throw new RangeError('Invalid namespace observer buffer or polling interval');
  root = resolve(root);
  const { api, koffi } = bindings();
  const apiError = name => new Win32Error(name, api.getLastError(), root);
  const openRoot = overlapped => api.createFile('\\\\?\\' + root, 1, 7, null, 3,
    0x02000000 | 0x00200000 | (overlapped ? 0x40000000 : 0), null);
  let directory, event, buffer, overlapped, identity, timer, closing;
  let pending = false, active = false;

  function fileIdentity(handle) {
    const info = Buffer.alloc(52);
    if (!api.getFileInformation(handle, info)) throw apiError('GetFileInformationByHandle');
    if ((info.readUInt32LE(0) & (16 | 1024)) !== 16) throw observerError('CODEBUDDY_NAMESPACE_ROOT_CHANGED', 'The namespace observer root is not a plain directory');
    return info.subarray(28, 32).toString('hex') + ':' + info.subarray(44, 52).toString('hex');
  }
  function arm() {
    // Windows retains these pointers after returning. JS Buffers are unsafe here.
    // https://koffi.dev/output#stable-pointers
    koffi.encode(overlapped, 'uint64', [0n, 0n, 0n, 0n], 4);
    koffi.encode(overlapped, 24, 'void *', event);
    if (!api.resetEvent(event)) throw apiError('ResetEvent');
    // Names include creation/deletion/rename; SECURITY and timestamp filters
    // would flood the buffer with the label helper's own writes.
    if (!api.readChanges(directory, buffer, bufferSize, 1, 3, null, overlapped, null)) throw apiError('ReadDirectoryChangesW');
    pending = true;
  }
  function completed() {
    const transferred = Buffer.alloc(4);
    if (!api.getResult(directory, overlapped, transferred, 0)) {
      const code = api.getLastError();
      if (code === 996) return undefined; // ERROR_IO_INCOMPLETE: never wait on Node's thread.
      pending = false;
      if (code === 995 && !active) return null;
      if (code === 1022) return null; // ERROR_NOTIFY_ENUM_DIR requires a new baseline.
      throw new Win32Error('GetOverlappedResult', code, root);
    }
    pending = false;
    const bytes = transferred.readUInt32LE();
    if (bytes > bufferSize) throw observerError('CODEBUDDY_NAMESPACE_RECORD_INVALID', 'Namespace notification exceeded its buffer');
    return bytes ? Buffer.from(koffi.decode(buffer, 'uint8', bytes)) : null;
  }
  function candidate(name, action) {
    let path = resolve(root, name);
    const inside = relative(root, path);
    if (!name || name.includes('\0') || name.split('\\').some(part => !part || part === '..' || part.includes(':')) ||
        !inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw observerError('CODEBUDDY_NAMESPACE_RECORD_INVALID', 'Namespace notification escaped its root');
    // Win32 may report an 8.3 alias. Preserve canonical candidates for the
    // label helper's exact final-path check; vanished old names need no repair.
    if (action === 1 || action === 5) {
      let nameBuffer = Buffer.alloc((path.length + 5) * 2);
      let length = api.getLongPath('\\\\?\\' + path, nameBuffer, nameBuffer.length / 2);
      if (length >= nameBuffer.length / 2 && length <= 32768) {
        nameBuffer = Buffer.alloc(length * 2);
        length = api.getLongPath('\\\\?\\' + path, nameBuffer, length);
      }
      if (!length) {
        const code = api.getLastError();
        if (code !== 2 && code !== 3) throw new Win32Error('GetLongPathNameW', code, path);
      } else {
        if (length >= nameBuffer.length / 2) throw observerError('CODEBUDDY_NAMESPACE_RECORD_INVALID', 'Namespace path exceeded its buffer');
        const longName = nameBuffer.subarray(0, length * 2).toString('utf16le');
        path = longName.startsWith('\\\\?\\') ? longName.slice(4) : longName;
        const canonicalInside = relative(root, path);
        if (!canonicalInside || isAbsolute(canonicalInside) || canonicalInside === '..' || canonicalInside.startsWith('..' + sep)) throw observerError('CODEBUDDY_NAMESPACE_RECORD_INVALID', 'Canonical namespace path escaped its root');
      }
    }
    return path;
  }
  function dispatch(bytes) {
    let offset = 0;
    while (active) {
      if (offset + 12 > bytes.length) throw observerError('CODEBUDDY_NAMESPACE_RECORD_INVALID', 'Truncated namespace notification');
      const next = bytes.readUInt32LE(offset), action = bytes.readUInt32LE(offset + 4), length = bytes.readUInt32LE(offset + 8);
      if (!length || length % 2 || offset + 12 + length > bytes.length || ![1, 2, 4, 5].includes(action) ||
          next && (next % 4 || next < 12 + length || offset + next >= bytes.length)) throw observerError('CODEBUDDY_NAMESPACE_RECORD_INVALID', 'Invalid namespace notification');
      onChange(candidate(bytes.subarray(offset + 12, offset + 12 + length).toString('utf16le'), action));
      if (!next) return;
      offset += next;
    }
  }
  function lose(error) {
    if (!active) return;
    active = false;
    clearInterval(timer);
    void close().catch(() => {}); // Callers can still await the same rejected close barrier.
    onInvalidate(error);
  }
  function pump() {
    for (let batch = 0; active && batch < 16; batch++) {
      const bytes = completed();
      if (bytes === undefined) return;
      arm(); // Copy completed bytes, then rearm before dispatching callbacks.
      if (bytes) dispatch(bytes);
      else onInvalidate(observerError('CODEBUDDY_NAMESPACE_OVERFLOW', 'Namespace notifications were lost; a full baseline is required'));
    }
    if (active) onInvalidate(observerError('CODEBUDDY_NAMESPACE_BUSY', 'Namespace notification drain reached its bound; a full baseline is required'));
  }
  function drain() {
    if (!active) return;
    try {
      // ReadDirectoryChangesW excludes changes to its root itself. Check the
      // pathname still selects the opened object at explicit handoff barriers.
      const current = openRoot(false);
      if (invalidHandle(current)) throw apiError('CreateFileW');
      try { if (fileIdentity(current) !== identity) throw observerError('CODEBUDDY_NAMESPACE_ROOT_CHANGED', 'The namespace observer root identity changed'); }
      finally { api.closeHandle(current); }
      pump();
    } catch (error) { lose(error); }
  }
  function close() {
    if (closing) return closing;
    active = false;
    clearInterval(timer);
    closing = (async () => {
      if (pending) {
        // Cancellation requests are not completions. Keep the native pointers
        // alive until GetOverlappedResult confirms completion/abortion.
        // https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex
        const requested = api.cancel(directory, overlapped), code = requested ? 0 : api.getLastError();
        if (!requested && code !== 1168) throw new Win32Error('CancelIoEx', code, root);
        const deadline = performance.now() + 1000;
        while (pending) {
          completed();
          if (!pending) break;
          if (performance.now() >= deadline) throw observerError('CODEBUDDY_NAMESPACE_DRAIN_TIMEOUT', 'Namespace I/O did not finish cancellation; retire the owning preparation process before reclaiming its native memory');
          await delay(5);
        }
      }
      const failures = [];
      for (const handle of [directory, event]) if (handle && !invalidHandle(handle) && !api.closeHandle(handle)) failures.push(apiError('CloseHandle'));
      koffi.free(overlapped); koffi.free(buffer);
      if (failures.length) throw new AggregateError(failures, 'Could not close namespace observer handles');
    })();
    return closing;
  }
  try {
    directory = openRoot(true);
    if (invalidHandle(directory)) throw apiError('CreateFileW');
    identity = fileIdentity(directory);
    event = api.createEvent(null, 1, 0, null);
    if (isNullPtr(event)) throw apiError('CreateEventW');
    buffer = koffi.alloc('uint32', bufferSize / 4);
    overlapped = koffi.alloc('uint64', 4); // Windows x64 OVERLAPPED: 32 bytes, hEvent at 24.
    arm();
    active = true;
    timer = setInterval(() => { try { pump(); } catch (error) { lose(error); } }, pollIntervalMs);
    timer.unref();
  } catch (error) {
    if (pending) { void close().catch(() => {}); throw error; }
    for (const handle of [directory, event]) if (handle && !invalidHandle(handle)) api.closeHandle(handle);
    if (overlapped) koffi.free(overlapped);
    if (buffer) koffi.free(buffer);
    throw error;
  }
  return { drain, close, get active() { return active; } };
}
