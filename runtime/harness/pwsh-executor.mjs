import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox';

// Keep the native executor, sandbox and cancellation lifecycle. Only change
// the public argv seam so a failing statement cannot be masked by a later
// successful statement in the same model-authored script. Explicit try/catch
// remains available for intentional error recovery.
export default class CodeBuddyPwshExecutor extends SandboxPwshExecutor {
  argv(spec) {
    return super.argv({ ...spec, command: "$ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$true; " + spec.command });
  }
}
