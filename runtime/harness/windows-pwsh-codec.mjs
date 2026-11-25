import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local';
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox';

export const pwshCodec = Symbol('Windows PowerShell byte-stream family');
export const windowsPwshCodec = Symbol('Windows ACL carrier codec support');

// confine and spawnSpec are private in the locked SDK. Keep native execution,
// process facts and cancellation; re-review dispatch before accepting upgrades.
if (process.platform === 'win32') {
  for (const [name, sha256] of [
    ['@deepseek-ai/dsh-pwsh-sandbox', 'bed19d2cea875b152f9e811116b59c2a45e6711b1c6cf1d8bacc4d20e15c6783'],
    ['@deepseek-ai/dsh-pwsh-local', '8b7b57eb7f6c597caa5ee72e4dfd88cec7b5ac51e450ed3521b6b6b29306b88e'],
  ]) if (createHash('sha256').update(readFileSync(new URL(import.meta.resolve(name)))).digest('hex') !== sha256)
    throw Error('Review the pinned PowerShell confinement and stdio contract.');
}

function abortable(pending, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function preparationFailure(mode, cause) {
  const detail = 'Windows PowerShell encoding preparation failed; the requested command was not started. ' +
    (cause instanceof Error ? cause.message : String(cause));
  const error = new SandboxUnavailableError(mode, detail);
  error.message = detail;
  error.cause = cause;
  return error;
}

export async function preparePwshCodec(executor, spec, policy, signal) {
  // Capture resolution once. The same executable, cwd and environment are used
  // for a read-only ASCII probe and the requested invocation. No filename guess,
  // unconfined version execution or persistent launcher-identity cache.
  const argv = executor.argv(spec);
  const stop = new AbortController();
  const bounded = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const deadlineAt = performance.now() + 5000;
  const timer = setTimeout(() => stop.abort(Error('PowerShell version preparation exceeded 5000ms.')), 5000);
  const checkDeadline = () => {
    bounded.throwIfAborted();
    if (performance.now() >= deadlineAt) throw Error('PowerShell version preparation deadline expired.');
  };
  let handle;
  try {
    const probe = [...argv.slice(0, -1), 'Write-Output $PSVersionTable.PSVersion.Major'];
    const confined = await abortable(executor.ctx.sandbox.confine(probe, { ...policy, mode: 'read-only' }, bounded), bounded);
    checkDeadline();
    const spawn = executor.spawnSpec({ ...spec, stdin: '' }, 256, bounded, confined.argv);
    checkDeadline();
    handle = executor.ctx.subprocess.spawn(spawn);
    const result = await abortable(handle.done, bounded);
    if (!await abortable(handle.waitForExit(bounded), bounded)) throw Error('PowerShell version probe did not quiesce.');
    checkDeadline();
    const output = handle.collected.stdout.readFrom(0);
    const errors = handle.collected.stderr.readFrom(0);
    if (result.exitCode !== 0 || output.lossy || errors.text || !/^\d+\r?\n$/.test(output.text))
      throw Error('The restricted PowerShell version probe did not return a clean numeric version.');
    const major = Number(output.text.trim());
    if (!Number.isSafeInteger(major) || major < 5) throw Error('Unsupported PowerShell runtime version.');
    const family = major >= 6 ? 'core' : 'legacy';
    if (!argv.at(-1).startsWith(ENCODING_PREAMBLE)) throw Error('PowerShell encoding prefix no longer matches the locked SDK.');
    // A configured launcher may select a different engine on a later launch.
    // Fail in that actual process, without replaying a potentially run command.
    const expectedVersion = family === 'core' ? '$PSVersionTable.PSVersion.Major -ge 6' : '$PSVersionTable.PSVersion.Major -eq 5';
    const fence = `if (!(${expectedVersion})) { Write-Error 'PowerShell runtime changed after preparation; requested command was not executed. Retry to re-probe the runtime.'; exit 78 }; `;
    const encoding = family === 'core' ? '$OutputEncoding=[Text.Encoding]::Default; '
      : `if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { ${ENCODING_PREAMBLE}}; `;
    argv[argv.length - 1] = fence + encoding + argv.at(-1).slice(ENCODING_PREAMBLE.length);
    argv[pwshCodec] = family;
    checkDeadline();
    return argv;
  } catch (cause) {
    if (handle) {
      try {
        handle.terminate();
        // The aborted preparation signal cannot confirm native Job exit.
        const [, exited] = await abortable(
          Promise.all([handle.done.catch(() => {}), handle.waitForExit()]),
          AbortSignal.timeout(5000),
        );
        if (!exited) throw Error('The subprocess owner did not confirm the version probe exit.');
      } catch (cleanup) {
        throw preparationFailure(policy.mode, new Error('The version probe process range could not be confirmed stopped.', { cause: cleanup }));
      }
    }
    signal?.throwIfAborted();
    if (cause instanceof SandboxUnavailableError) throw cause;
    throw preparationFailure(policy.mode, cause);
  } finally { clearTimeout(timer); }
}
