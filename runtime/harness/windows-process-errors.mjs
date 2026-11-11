// Process-local policy, inherited by children. Keep the OS failure/exit status;
// only prevent critical-error/WER dialogs from blocking unattended tool calls.
// Never change the system-wide WER configuration or the sandbox token.
if (process.platform === 'win32') {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-win32-process'));
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  const get = kernel32.func('__stdcall', 'GetErrorMode', 'uint32', []);
  const set = kernel32.func('__stdcall', 'SetErrorMode', 'uint32', ['uint32']);
  set(get() | 0x0001 | 0x0002 | 0x8000);
}
