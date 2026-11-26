import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox';
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox';
import { shellOutput } from './windows-shell-output.mjs';
import { projectScriptCall, projectScriptInvocation, resolveProjectScript } from './project-script.mjs';
import { preparePwshCodec, pwshCodec, windowsPwshCodec } from './windows-pwsh-codec.mjs';
import { projectSandboxPolicy } from './project-sandbox-policy.mjs';

// Keep command execution in the native executor. The Windows preparation
// step can now own a probe, so cancellation must join that step's cleanup.
export default class CodeBuddyPwshExecutor extends SandboxPwshExecutor {
  async executeArgv(spec, argvOrPrepare, onStarted) {
    if (typeof argvOrPrepare !== 'function' || !this.ctx.sandbox[windowsPwshCodec])
      return super.executeArgv(spec, argvOrPrepare, onStarted);
    let preparation;
    try {
      return await super.executeArgv(spec, signal => {
        preparation = argvOrPrepare(signal);
        return preparation;
      }, onStarted);
    } finally {
      // The native cancellation race prevents a late payload launch. Join
      // the very same prepare promise before exposing that native outcome.
      await preparation?.catch(error => {
        if (error instanceof SandboxUnavailableError) throw error;
      });
    }
  }

  async confine(spec, policy, signal) {
    if (!this.ctx.sandbox[windowsPwshCodec]) return super.confine(spec, policy, signal);
    const argv = await preparePwshCodec(this, spec, policy, signal);
    const prepared = await this.ctx.sandbox.confine(argv, policy, signal);
    prepared.argv[pwshCodec] = argv[pwshCodec];
    return prepared;
  }

  argv(spec) {
    const preamble = "$ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$true; ";
    return super.argv({ ...spec, command: preamble + spec.command });
  }

  async execute(spec) {
    if (spec.sandboxPolicy) spec = { ...spec, sandboxPolicy: await projectSandboxPolicy(this.ctx, spec.sandboxPolicy) };
    const target = projectScriptInvocation(spec.command);
    if (!target) return super.execute(spec);
    const result = await resolveProjectScript(spec.sandboxPolicy.workspaceRoot, target.name, spec.signal, spec.workdir)
      .catch(error => {
        spec.signal?.throwIfAborted();
        return { status: 'unavailable', name: target.name, detail: 'Cannot inspect this project for ' + target.name + ': ' + error.message };
      });
    if (result.status !== 'found') {
      projectScriptCall.getStore()?.(result);
      throw new Error(result.detail);
    }
    projectScriptCall.getStore()?.({ ...result, continueTask: target.continueTask });
    // Encode the verified Unicode path as data, even when it contains shell quotes.
    const literal = value => "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(value).toString('base64') + "')))";
    const command = '$scriptPath=' + literal(result.path) + '; $scriptArgs=@(' + target.args.map(literal).join(',') +
      "); Write-Output ('Project script: ' + $scriptPath); & $scriptPath @scriptArgs; if (!$?) { exit $LASTEXITCODE }";
    return super.execute({ ...spec, command });
  }

  spawnSpec(...args) {
    const spec = super.spawnSpec(...args);
    // The private console handoff preserves redirected handles. An empty pipe
    // gives the same EOF without carrying a console/CHAR handle across detach.
    if (args[3][pwshCodec] && args[0].stdin === undefined) spec.stdio.stdin = { data: '' };
    // Windows Python pipes otherwise use the locale code page. Some GBK
    // sequences are also valid UTF-8, so guessing after decoding loses text.
    // Preserve an explicitly configured interpreter encoding.
    return { ...spec, env: { ...spec.env,
      PYTHONIOENCODING: spec.env?.PYTHONIOENCODING ?? process.env.PYTHONIOENCODING ?? 'utf-8',
    }, [shellOutput]: true };
  }
}
