import { execFile } from 'node:child_process';
import { join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./WorkspaceLabelAccess.cs', import.meta.url));

export default class WindowsSandboxProvider extends LocalSandboxProvider {
  windowsAclRunnerInvocation() {
    const [node, ...args] = super.windowsAclRunnerInvocation();
    // Keep the native runner, policy arguments, token, pipes and Job lifecycle.
    return [node, '--import', new URL('./windows-sandbox-startup.mjs', import.meta.url).href, ...args];
  }

  async confine(argv, policy, signal) {
    const confined = await this.confineWorkspace(argv, policy, signal);
    if (policy.mode === 'workspace-write') {
      const root = resolve(policy.workspaceRoot);
      if (root !== parse(root).root) {
        const system = join(process.env.SystemRoot, 'System32');
        await run(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            "$ErrorActionPreference='Stop'; Add-Type -Path $env:CODEBUDDY_LABEL_HELPER; [void][WorkspaceLabelAccess]::PrepareExisting($env:CODEBUDDY_LABEL_ROOT)"],
          { cwd: system, windowsHide: true, signal, timeout: 30000,
            env: { ...process.env, PSModulePath: join(system, 'WindowsPowerShell', 'v1.0', 'Modules'),
              CODEBUDDY_LABEL_ROOT: root, CODEBUDDY_LABEL_HELPER: helper } });
      }
    }
    return confined;
  }

  async confineWorkspace(argv, policy, signal) {
    try {
      return await super.confine(argv, policy, signal);
    } catch (error) {
      if (policy.mode !== 'workspace-write' || error.api !== 'SetNamedSecurityInfoW' || error.win32Code !== 5) throw error;
      const root = resolve(policy.workspaceRoot);
      if (root === parse(root).root) throw error;
      signal?.throwIfAborted();
      const system = join(process.env.SystemRoot, 'System32');
      const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; Add-Type -Path $env:CODEBUDDY_LABEL_HELPER; if (![WorkspaceLabelAccess]::Prepare($env:CODEBUDDY_LABEL_ROOT)) { exit 2 }"],
        { cwd: system, windowsHide: true, signal, timeout: 15000,
          env: { ...process.env, PSModulePath: join(system, 'WindowsPowerShell', 'v1.0', 'Modules'),
            CODEBUDDY_LABEL_ROOT: root, CODEBUDDY_LABEL_HELPER: helper } });
      } catch (cause) {
        signal?.throwIfAborted();
        if (cause.code === 2) throw error;
        throw new Error('Could not prepare the Windows workspace for its sandbox label', { cause });
      }
      // Only the upstream provider may issue the restricted runner argv.
      return super.confine(argv, policy, signal);
    }
  }
}
