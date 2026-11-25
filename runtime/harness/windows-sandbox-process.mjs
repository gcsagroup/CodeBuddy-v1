import { Context } from '@deepseek-ai/cordis';

await import('./windows-process-errors.mjs');
await import('./windows-acl-contract.mjs');
const { default: NativeWindowsSandboxProvider } = await import('./windows-sandbox-native.mjs');

let context, provider, tail = Promise.resolve(), closing = false;
const controllers = new Map();
const send = message => { if (process.connected) process.send(message, () => {}); };
const errorRecord = error => Object.fromEntries(['name', 'message', 'code', 'api', 'win32Code', 'errno', 'syscall', 'path']
  .filter(key => typeof error?.[key] === 'string' || typeof error?.[key] === 'number').map(key => [key, error[key]]));

async function close() {
  if (closing) return;
  closing = true;
  for (const controller of controllers.values()) controller.abort();
  try { await tail; await context?.fiber.dispose(); }
  finally { if (process.connected) process.disconnect(); }
}

process.on('disconnect', () => { void close(); });
process.on('message', message => {
  if (message.type === 'file-mutation') { provider?.noteFileMutation(message.path); return; }
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return; }
  if (message.type === 'dispose') { void close(); return; }
  if (message.type !== 'confine' || closing) return;
  const controller = new AbortController();
  controllers.set(message.id, controller);
  // Preserve one native provider and serialize its mutable grant cache. The
  // parent can cancel a waiter without waiting for a synchronous Win32 call.
  tail = tail.then(async () => {
    controller.signal.throwIfAborted();
    if (!provider) {
      context = new Context();
      await context.plugin(NativeWindowsSandboxProvider, message.config);
      provider = context.sandbox;
    }
    controller.signal.throwIfAborted();
    provider.preparationDeadline = message.deadline;
    provider.onPreparationPhase = phase => send({ id: message.id, phase });
    const result = await provider.confine(message.argv, message.policy, controller.signal);
    controller.signal.throwIfAborted();
    send({ id: message.id, result });
  }).catch(error => send({ id: message.id, error: errorRecord(error) }))
    .finally(() => controllers.delete(message.id));
});
