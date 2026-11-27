import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { patchSteeringPwsh } from './steering-patch.mjs';

// Keep preparation settlement and error attribution with the native job.
// Its job view carries text, so retain the original startup promise until the
// foreground waiter has classified the outcome.
if (process.platform === 'win32') {
  const entry = import.meta.resolve('@deepseek-ai/dsh-tool-pwsh');
  const source = readFileSync(new URL(entry), 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== '2b71dff5421f95cf445f1a6f97e660e3ebaed187a77b4c0dddb493caf3ce00b1')
    throw new Error('Review the pinned PowerShell preparation-timeout receipt contract.');
  const start = source.indexOf('await stop("timed out during preparation");');
  const end = source.indexOf('\n\t\t\tif (view.status === "running"', start);
  const branch = source.slice(start, end);
  const previous = 'stderr: {\n\t\t\t\t\t\ttext: "",';
  if (start < 0 || end < start || branch.split(previous).length !== 2)
    throw new Error('Native PowerShell preparation-timeout receipt seam changed.');
  let replacement = source.slice(0, start) + branch.replace(previous,
    'stderr: {\n\t\t\t\t\t\ttext: "Sandbox preparation timed out; the user command was not started. Preparation may have updated workspace permissions.\\n",') + source.slice(end);
  const replaceSeam = (from, to) => {
    if (replacement.split(from).length !== 2)
      throw new Error('Native PowerShell preparation settlement seam changed.');
    replacement = replacement.replace(from, to);
  };
  replaceSeam('import { ESCALATION_TARGETS, approveEscalation,',
    'import { ESCALATION_TARGETS, SandboxUnavailableError, approveEscalation,');
  replaceSeam('let proc;\n\t\t\tlet stopped;', 'let proc;\n\t\t\tlet preparation;\n\t\t\tlet stopped;');
  replaceSeam('proc = await ctx.shell.execute({', 'preparation = ctx.shell.execute({');
  replaceSeam('\n\t\t\t\t\t\t\treturn proc;', '\n\t\t\t\t\t\t\tproc = await preparation;\n\t\t\t\t\t\t\treturn proc;');
  replaceSeam('process: () => proc,', 'process: () => proc,\n\t\t\t\tpreparation: () => preparation,');
  replaceSeam('const stop = async (reason) => {', `const preparationFailure = async () => {
				try { await attached.preparation(); }
				catch (error) { if (error instanceof SandboxUnavailableError) return error; }
			};
			const stop = async (reason) => {`);
  replaceSeam('registry.kill(attached.id, owner, reason);', `registry.kill(attached.id, owner, reason);
				const failure = attached.process() === void 0 ? await preparationFailure() : void 0;`);
  replaceSeam('return settled;', 'if (failure !== void 0) throw failure;\n\t\t\t\treturn settled;');
  replaceSeam('if (process === void 0) throw new Error(view.detail);',
    'if (process === void 0) throw (await preparationFailure()) ?? new Error(view.detail);');
  replacement = patchSteeringPwsh(replacement);
  let applied = false;
  const hook = registerHooks({ load(url, context, next) {
    const result = next(url, context);
    if (url !== entry) return result;
    if (Buffer.from(result.source).toString('utf8') !== source)
      throw new Error('Native PowerShell changed while installing its preparation receipt.');
    applied = true;
    return { ...result, source: replacement };
  } });
  try {
    await import(entry);
    if (!applied) throw new Error('Load the preparation receipt contract before native PowerShell tools.');
  } finally { hook.deregister(); }
}
