import { extendWin32ProcessBindings, isNullPtr, throwLastError } from '@deepseek-ai/dsh-win32-process';

// Own only sandbox helper processes. User commands retain the native Harness
// process owner and never join this preparation/resource Job.
export function ownSandboxHelper(pid) {
  const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
    openProcess: bind(kernel32, 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']),
  }));
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW');
  let processHandle;
  try {
    const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
    if (!api.setInformationJobObject(job, 9, limits, limits.length)) throwLastError(api, 'SetInformationJobObject');
    processHandle = api.openProcess(0x101, 0, pid);
    if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess');
    if (!api.assignProcessToJobObject(job, processHandle)) throwLastError(api, 'AssignProcessToJobObject');
  } catch (error) { api.closeHandle(job); throw error; }
  finally { if (!isNullPtr(processHandle)) api.closeHandle(processHandle); }
  let closed = false;
  return () => { if (!closed) { closed = true; api.closeHandle(job); } };
}
