import { createRequire } from 'node:module';

// Only the native ACL carrier imports this module, before PowerShell starts.
// Console encoding readers may cache at startup, so changing CP inside a
// PowerShell preamble is too late. Never modify an inherited shared console.
export function initializePwshConsole(family) {
  if (!['core', 'legacy'].includes(family)) throw Error('Invalid PowerShell console family.');
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-win32-process'));
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll'), user32 = koffi.load('user32.dll');
  const bind = (name, type, args = []) => kernel32.func('__stdcall', name, type, args);
  const api = {
    getStd: bind('GetStdHandle', 'void *', ['int']),
    setStd: bind('SetStdHandle', 'int', ['int', 'void *']),
    type: bind('GetFileType', 'uint32', ['void *']),
    pids: bind('GetConsoleProcessList', 'uint32', ['void *', 'uint32']),
    input: bind('GetConsoleCP', 'uint32'),
    output: bind('GetConsoleOutputCP', 'uint32'),
    setInput: bind('SetConsoleCP', 'int', ['uint32']),
    setOutput: bind('SetConsoleOutputCP', 'int', ['uint32']),
    free: bind('FreeConsole', 'int'),
    alloc: bind('AllocConsole', 'int'),
    window: bind('GetConsoleWindow', 'void *'),
    visible: user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *']),
  };
  const startup = koffi.struct('CodeBuddyPwshStartupInfo', {
    cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
    dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
    dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
    dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
    lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
  });
  const info = Buffer.alloc(koffi.sizeof(startup));
  bind('GetStartupInfoW', 'void', ['void *'])(info);
  if (!(info.readUInt32LE(koffi.offsetof(startup, 'dwFlags')) & 1) ||
    info.readUInt16LE(koffi.offsetof(startup, 'wShowWindow')) !== 0)
    throw Error('PowerShell codec requires a hidden carrier startup.');
  const handles = [-10, -11, -12].map(id => {
    const handle = api.getStd(id), type = api.type(handle);
    if (type !== 1 && type !== 3) throw Error('PowerShell codec requires redirected file or pipe standard handles.');
    return { id, handle, type };
  });
  const pids = Buffer.alloc(4);
  const originalInput = api.input();
  if (api.pids(pids, 1) && !api.free()) throw Error('PowerShell carrier could not detach its inherited console.');
  if (!api.alloc()) throw Error('PowerShell carrier could not allocate its private console.');
  // AllocConsole initializes std handles. Restore only borrowed PIPE/DISK
  // handles; console handles would have become invalid during FreeConsole.
  for (const { id, handle, type } of handles) {
    if (api.type(handle) !== type || !api.setStd(id, handle) || api.getStd(id) !== handle)
      throw Error('PowerShell carrier could not preserve redirected standard handles.');
  }
  if (api.pids(pids, 1) !== 1 || pids.readUInt32LE() !== process.pid || api.visible(api.window()))
    throw Error('PowerShell codec requires its own hidden console.');
  // Framework 5.1 retains its legacy input semantics. Core uses UTF-8 before
  // either Console.In or the PowerShell async input reader can cache them.
  const input = family === 'core' ? 65001 : originalInput || api.input();
  if (!api.setInput(input) || !api.setOutput(65001) || api.input() !== input || api.output() !== 65001)
    throw Error('PowerShell carrier could not initialize its console code pages.');
}
