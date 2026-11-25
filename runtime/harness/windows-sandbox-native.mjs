import { execFile } from 'node:child_process';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { watch } from 'node:fs';
import { promisify } from 'node:util';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./WorkspaceLabelAccess.cs', import.meta.url));

export default class NativeWindowsSandboxProvider extends LocalSandboxProvider {
  constructor(ctx, config) {
    super(ctx, config);
    this.labelStates = new Map();
    ctx.effect(() => () => {
      for (const state of this.labelStates.values()) state.watcher?.close();
    });
  }

  noteFileMutation(path) {
    for (const state of this.labelStates.values()) {
      const inside = relative(state.root, resolve(path));
      if (inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)) {
        if (state.dirty.size < 2048) state.dirty.add(resolve(path));
        else { state.complete = false; state.generation++; state.dirty.clear(); }
      }
    }
  }

  async labelState(root) {
    const info = await lstat(root, { bigint: true });
    const identity = `${info.dev}:${info.ino}`;
    const key = root.toLowerCase();
    const previous = this.labelStates.get(key);
    if (previous) {
      // The native provider also caches its root grant. A replacement requires
      // a fresh provider, rather than just a fresh label scan.
      if (previous.identity !== identity) throw Object.assign(new Error('Workspace directory identity changed; retry with a fresh preparation process.'),
        { code: 'CODEBUDDY_WORKSPACE_CHANGED' });
      return previous;
    }
    const state = { root, identity, complete: false, generation: 0, dirty: new Set() };
    const invalidate = () => { state.complete = false; state.generation++; state.dirty.clear(); };
    try {
      // On Windows this is one native subtree notification handle. It does not
      // enumerate the project. Notifications optimize availability, not access:
      // every selected object still passes the original pinned-handle checks.
      state.watcher = watch(root, { recursive: true }, (event, filename) => {
        if (!filename) invalidate(); // Includes native notification overflow.
        else if (event === 'rename') this.noteFileMutation(resolve(root, filename));
        // A modification is not evidence of a new object. Watching namespace
        // changes also avoids reacting to this helper's own security writes.
      });
      state.watcher.on('error', () => { state.watcher?.close(); state.watcher = undefined; invalidate(); });
    } catch { /* No reliable observer: retain bounded full checks per call. */ }
    this.labelStates.set(key, state);
    return state;
  }

  windowsAclRunnerInvocation() {
    const [node, ...args] = super.windowsAclRunnerInvocation();
    // Keep the native runner, policy arguments, token, pipes and Job lifecycle.
    return [node, '--import', new URL('./windows-sandbox-startup.mjs', import.meta.url).href, ...args];
  }

  async confine(argv, policy, signal) {
    const root = resolve(policy.workspaceRoot);
    if (policy.mode === 'workspace-write' && root !== parse(root).root) await this.labelState(root);
    this.onPreparationPhase?.('workspace-grant');
    const confined = await this.confineWorkspace(argv, policy, signal);
    signal?.throwIfAborted();
    if (policy.mode === 'workspace-write') {
      if (root !== parse(root).root) {
        await this.prepareLabels(root, signal);
      }
    }
    return confined;
  }

  async prepareLabels(root, signal) {
    const state = await this.labelState(root);
    // Native write/edit receipts reach this process before the next confine.
    // Preserve notifications received during preparation for a later pass.
    do {
      signal?.throwIfAborted();
      const full = !state.complete || !state.watcher;
      if (!full && !state.dirty.size) { this.onPreparationPhase?.('labels-current'); return; }
      const paths = full ? undefined : [...state.dirty];
      const generation = state.generation;
      state.dirty.clear();
      this.onPreparationPhase?.(full ? 'existing-file-labels' : 'changed-file-labels');
      try {
        await this.runLabelPreparation(root, paths, signal);
        state.complete = Boolean(state.watcher) && state.generation === generation;
      } catch (error) { state.complete = false; throw error; }
      // A missing observer cannot become reliable by rescanning in a loop.
      if (!state.watcher) return;
    } while (!state.complete || state.dirty.size);
  }

  async runLabelPreparation(root, paths, signal) {
    const control = await mkdtemp(join(tmpdir(), 'codebuddy-label-control-'));
    const cancelFile = join(control, 'cancel');
    const changedFile = join(control, 'paths.json');
    // Cancellation is cooperative inside the helper: killing PowerShell in
    // the middle of an object's temporary DACL edit skips its finally block.
    const cancel = () => { void writeFile(cancelFile, '').catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const system = join(process.env.SystemRoot, 'System32');
    try {
      if (paths) await writeFile(changedFile, JSON.stringify(paths));
      if (Date.now() >= (this.preparationDeadline ?? Infinity) - 2000)
        throw new Error('Existing-file label preparation deadline expired. The user command was not started.');
      const budget = Math.max(1, (this.preparationDeadline ?? Date.now() + 120000) - Date.now() - 2000);
      const { stdout } = await run(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; Add-Type -Path $env:CODEBUDDY_LABEL_HELPER; if ($env:CODEBUDDY_LABEL_PATHS) { $paths=[string[]](Get-Content -LiteralPath $env:CODEBUDDY_LABEL_PATHS -Raw -Encoding UTF8 | ConvertFrom-Json); $result=[WorkspaceLabelAccess]::PrepareChangedBounded($env:CODEBUDDY_LABEL_ROOT, $paths, [int]$env:CODEBUDDY_LABEL_BUDGET, $env:CODEBUDDY_LABEL_CANCEL) } else { $result=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CODEBUDDY_LABEL_ROOT, [int]$env:CODEBUDDY_LABEL_BUDGET, $env:CODEBUDDY_LABEL_CANCEL) }; $result | ConvertTo-Json -Compress"],
        // Keep the process fallback beyond the parent's preparation deadline and
        // 2s cooperative cleanup window; it must not preempt DACL restoration.
        { cwd: system, windowsHide: true, timeout: 123000, maxBuffer: 16384,
          env: { ...process.env, PSModulePath: join(system, 'WindowsPowerShell', 'v1.0', 'Modules'),
            CODEBUDDY_LABEL_ROOT: root, CODEBUDDY_LABEL_HELPER: helper,
            CODEBUDDY_LABEL_PATHS: paths ? changedFile : '',
            CODEBUDDY_LABEL_BUDGET: String(budget), CODEBUDDY_LABEL_CANCEL: cancelFile } });
      signal?.throwIfAborted();
      const result = JSON.parse(stdout.trim());
      if (result.Status !== 'complete') throw new Error(
        `Existing-file label preparation ${result.Status}; visited ${result.Visited} objects, labelled ${result.Changed}. The user command was not started.`);
    } catch (error) {
      signal?.throwIfAborted();
      if (error.killed) throw new Error('Existing-file label helper exceeded its process deadline; the user command was not started.');
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      await rm(control, { recursive: true, force: true });
    }
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
