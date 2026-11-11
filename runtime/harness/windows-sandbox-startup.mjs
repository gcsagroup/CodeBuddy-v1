import './windows-process-errors.mjs';

// Run in the native ACL carrier, BEFORE it creates a restricted token. The
// upstream sandbox requires its children to inherit an existing console.
// The Job owner starts this carrier with STARTF_USESHOWWINDOW / SW_HIDE, so
// AllocConsole honors the hidden startup state; never hide a user's console.
if (process.platform === 'win32') {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-win32-process'));
  const koffi = require('koffi');
  const dll = koffi.load('kernel32.dll');
  const bind = (name, type, args = []) => dll.func('__stdcall', name, type, args);
  const getConsoleProcessList = bind('GetConsoleProcessList', 'uint32', ['void *', 'uint32']);
  const pids = Buffer.alloc(4);
  if (getConsoleProcessList(pids, 1) === 0) {
    // AllocConsole may reset the Windows standard handles. Preserve the native
    // runner's redirected pipes (and leave its CRT control descriptor alone).
    const getStd = bind('GetStdHandle', 'void *', ['int']);
    const setStd = bind('SetStdHandle', 'int', ['int', 'void *']);
    const handles = [-10, -11, -12].map(id => [id, getStd(id)]);
    if (!bind('AllocConsole', 'int')()) {
      throw new Error(`windows-acl-run: console initialization failed (Win32 ${bind('GetLastError', 'uint32')()})`);
    }
    for (const [id, handle] of handles) {
      if (!setStd(id, handle)) throw new Error('windows-acl-run: could not restore redirected standard handles');
    }
  }
}
