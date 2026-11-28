import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { extendWin32ProcessBindings, isNullPtr, isJobEmpty, terminateJob, closeHandleChecked, throwWin32 } from '@deepseek-ai/dsh-win32-process';

// The pinned Win32 provider uses the x64 extended-limit layout below. Keeping
// one host handle also owns late bootstrap attempts until startup is retired.
export function createNavigationJob() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Managed code navigation requires Windows x64');
  const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
    createNamedJob: bind(kernel32, 'CreateJobObjectW', 'void *', ['void *', 'str16']),
    resetLastError: bind(kernel32, 'SetLastError', 'void', ['uint32']),
    openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
  }));
  const name = `Local\\CodeBuddyNavigation-${randomUUID()}`;
  api.resetLastError(0);
  const handle = api.createNamedJob(null, name), error = api.getLastError();
  if (isNullPtr(handle)) throwWin32(api, 'CreateJobObjectW', error);
  if (error === 183) {
    closeHandleChecked(api, handle, 'unowned navigation job');
    throw Error('Navigation job name already exists');
  }
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!api.setInformationJobObject(handle, 9, limits, limits.length)) {
    const code = api.getLastError();
    closeHandleChecked(api, handle, 'navigation job setup');
    throwWin32(api, 'SetInformationJobObject', code);
  }
  let closed = false, closedProof = false, closing, untracked = false, rootPending = false;
  const roots = new Set();
  const jobEmpty = () => closed || isJobEmpty(api, handle);
  const empty = () => closed ? closedProof : !untracked && !rootPending && jobEmpty() && [...roots].every(root => api.waitForSingleObject(root, 0) === 0);
  return {
    name,
    empty,
    beginRoot() { rootPending = true; },
    rootStartSettledWithoutPid() {
      // The pinned SDK spawns synchronously inside start(). Its public PID is
      // sampled in that same stack and again on settlement. Neither observation
      // has a PID only when spawn failed or that root has already exited.
      rootPending = false;
    },
    trackRoot(pid) {
      if (closed) throw Error('Navigation startup was retired');
      // Only observe the SDK root. Never signal a process identified by PID:
      // termination is restricted to members that joined our exact Job.
      const root = api.openProcess(0x00100000, 0, pid);
      if (isNullPtr(root)) {
        const code = api.getLastError();
        if (code === 87) { rootPending = false; return; } // The failed bootstrap already exited.
        untracked = true;
        throwWin32(api, 'OpenProcess', code);
      }
      roots.add(root);
      rootPending = false;
    },
    close(shutdown) {
      return closing ??= (async () => {
        let settled = false;
        const work = Promise.resolve().then(shutdown).finally(() => { settled = true; });
        work.catch(() => {});
        try {
          const deadline = Date.now() + 4500;
          while ((!settled || !empty()) && Date.now() < deadline) await delay(20);
          if (!jobEmpty()) {
            terminateJob(api, handle, 1);
            const killed = Date.now() + 1000;
            while (!empty() && Date.now() < killed) await delay(20);
          }
          closedProof = settled && empty();
          return closedProof;
        } finally {
          // Revoke late bootstrap access even on failure. KILL_ON_JOB_CLOSE is
          // cleanup only: it cannot turn an unproven close into permission to
          // create a replacement. The caller keeps that owner quarantined.
          try { closeHandleChecked(api, handle, 'navigation job'); closed = true; }
          finally {
            for (const root of roots) closeHandleChecked(api, root, 'navigation SDK root');
            roots.clear();
          }
        }
      })();
    },
  };
}
