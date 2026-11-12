import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox';
import { shellOutput } from './windows-shell-output.mjs';
import { projectScriptCall, projectScriptInvocation, resolveProjectScript } from './project-script.mjs';

// Keep the native executor, sandbox and cancellation lifecycle. Only change
// the public argv seam so a failing statement cannot be masked by a later
// successful statement in the same model-authored script. Explicit try/catch
// remains available for intentional error recovery.
export default class CodeBuddyPwshExecutor extends SandboxPwshExecutor {
  argv(spec) {
    const preamble = "$ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$true; ";
    return super.argv({ ...spec, command: preamble + spec.command });
  }

  async execute(spec) {
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
    return { ...super.spawnSpec(...args), [shellOutput]: true };
  }
}
