import { execFile } from 'node:child_process';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import { AclWriteGrant, assertTempRootOutsideWorkspace, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl';
import { createNamespaceObserver } from './windows-namespace-observer.mjs';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./WorkspaceLabelAccess.cs', import.meta.url));

// materializeAclGrant and its maps are private in alpha2's TypeScript seam.
// Keep this narrow lifetime split pinned; do not guess across SDK upgrades.
if (process.platform === 'win32' && createHash('sha256')
  .update(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-sandbox-local')))).digest('hex') !==
  'be6e1107871cf8d94c040090b13c405bc833822e2f51ed5280e93eececf762be')
  throw Error('Review the pinned sandbox workspace/session grant lifetime contract.');

export default class NativeWindowsSandboxProvider extends LocalSandboxProvider {
  constructor(ctx, config) {
    super(ctx, config);
    this.labelStates = new Map();
    ctx.effect(() => () => Promise.all([...this.labelStates.values()].map(state => state.watcher?.close())));
  }

  noteFileMutation(path) {
    for (const state of this.labelStates.values()) {
      const inside = relative(state.root, resolve(path));
      if (inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)) {
        if (state.dirty.size < 2048) state.dirty.add(resolve(path));
        else { state.hasBaseline = false; state.generation++; state.dirty.clear(); state.deferred.clear(); }
      }
    }
  }

  async labelState(root) {
    const key = root.toLowerCase();
    const previous = this.labelStates.get(key);
    const changed = () => Object.assign(new Error('Workspace directory identity changed; retry with a fresh preparation process.'),
      { code: 'CODEBUDDY_WORKSPACE_CHANGED' });
    let info;
    try { info = await lstat(root, { bigint: true }); }
    catch (error) {
      if (previous && ['ENOENT', 'ENOTDIR'].includes(error.code)) throw changed();
      throw error;
    }
    const identity = `${info.dev}:${info.ino}`;
    if (previous) {
      // The native provider also caches its root grant. A replacement requires
      // a fresh provider, rather than just a fresh label scan.
      previous.watcher?.drain();
      if (previous.identity !== identity || previous.rootInvalidated) throw changed();
      return previous;
    }
    const state = { root, identity, hasBaseline: false, generation: 0, dirty: new Set(), deferred: new Set() };
    const invalidate = () => { state.hasBaseline = false; state.generation++; state.dirty.clear(); state.deferred.clear(); };
    try {
      // libuv also subscribes to SECURITY. Our own ACL writes can overflow its
      // buffer and falsely invalidate every completed baseline. Subscribe only
      // to namespace changes, retaining real loss/overflow as full invalidation.
      state.watcher = createNamespaceObserver(root, path => this.noteFileMutation(path), error => {
        invalidate();
        if (error.code === 'CODEBUDDY_NAMESPACE_ROOT_CHANGED' ||
          error.api === 'CreateFileW' && [2, 3].includes(error.win32Code)) state.rootInvalidated = true;
      });
    } catch { /* No reliable observer: retain bounded full checks per call. */ }
    this.labelStates.set(key, state);
    return state;
  }

  windowsAclRunnerInvocation() {
    const [node, ...args] = super.windowsAclRunnerInvocation();
    // Keep the native runner, policy arguments, token, pipes and Job lifecycle.
    const startup = new URL('./windows-sandbox-startup.mjs', import.meta.url);
    if (this.pwshCodecFamily) startup.searchParams.set('pwshCodec', this.pwshCodecFamily);
    return [node, '--import', startup.href, ...args];
  }

  materializeAclGrant(sessionId, workspaceRoot) {
    if (!this.externalSessionTemps) return super.materializeAclGrant(sessionId, workspaceRoot);
    const capability = this.sessionTempCapability;
    if (!capability || capability.workspaceRoot !== workspaceRoot || capability.sessionId !== String(sessionId))
      throw Object.assign(Error('Session TEMP capability does not match the canonical workspace and session.'),
        { code: 'CODEBUDDY_WORKSPACE_CHANGED' });
    assertTempRootOutsideWorkspace(workspaceRoot, tmpdir());
    if (!this.workspaceGrants.has(workspaceRoot)) {
      const grant = AclWriteGrant.create(workspaceWriteSid(workspaceRoot));
      try { grant.add(workspaceRoot, true); }
      catch (error) {
        try { grant.dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Workspace grant failed and cleanup also failed'); }
        throw error;
      }
      this.workspaceGrants.set(workspaceRoot, grant);
    }
    return capability;
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
      const full = !state.hasBaseline || !state.watcher?.active;
      if (!full && !state.dirty.size && !state.deferred.size) { this.onPreparationPhase?.('labels-current'); return; }
      const paths = full ? undefined : [...new Set([...state.dirty, ...state.deferred])];
      const generation = state.generation;
      state.dirty.clear();
      state.deferred.clear();
      this.onPreparationPhase?.(full ? 'existing-file-labels' : 'changed-file-labels');
      try {
        const result = await this.runLabelPreparation(root, paths, signal);
        // This is the final async handoff barrier: verify the same root and
        // consume known namespace changes before deciding whether to rescan.
        await this.labelState(root);
        for (const path of result.DeferredPaths) state.deferred.add(path);
        state.hasBaseline = Boolean(state.watcher?.active) && state.generation === generation && !result.DeferredOverflow;
        if (state.deferred.size || result.DeferredOverflow) this.onPreparationPhase?.('labels-deferred');
        // Retry locked objects next time, without holding unrelated commands
        // behind them or repeating a full tree in this invocation on overflow.
        if (result.DeferredOverflow) return;
      } catch (error) { state.hasBaseline = false; throw error; }
      // If observation was lost during a selected-path pass, repair the
      // unobserved namespace once before this handoff. A full pass without an
      // observer cannot become reliable by repeating it in the same call.
      if (!state.watcher?.active && full) return;
    } while (!state.hasBaseline || state.dirty.size);
  }

  async runLabelPreparation(root, paths, signal) {
    const control = await mkdtemp(join(tmpdir(), 'codebuddy-label-control-'));
    const cancelFile = join(control, 'cancel');
    const changedFile = join(control, 'paths.json');
    const resultFile = join(control, 'result.json');
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
      await run(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; Add-Type -Path $env:CODEBUDDY_LABEL_HELPER; if ($env:CODEBUDDY_LABEL_PATHS) { $paths=[string[]](Get-Content -LiteralPath $env:CODEBUDDY_LABEL_PATHS -Raw -Encoding UTF8 | ConvertFrom-Json); $result=[WorkspaceLabelAccess]::PrepareChangedBounded($env:CODEBUDDY_LABEL_ROOT, $paths, [int]$env:CODEBUDDY_LABEL_BUDGET, $env:CODEBUDDY_LABEL_CANCEL) } else { $result=[WorkspaceLabelAccess]::PrepareExistingBounded($env:CODEBUDDY_LABEL_ROOT, [int]$env:CODEBUDDY_LABEL_BUDGET, $env:CODEBUDDY_LABEL_CANCEL) }; [IO.File]::WriteAllText($env:CODEBUDDY_LABEL_RESULT, ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))"],
        // Keep the process fallback beyond the parent's preparation deadline and
        // 2s cooperative cleanup window; it must not preempt DACL restoration.
        { cwd: system, windowsHide: true, timeout: 123000, maxBuffer: 16384,
          env: { ...process.env, PSModulePath: join(system, 'WindowsPowerShell', 'v1.0', 'Modules'),
            CODEBUDDY_LABEL_ROOT: root, CODEBUDDY_LABEL_HELPER: helper,
            CODEBUDDY_LABEL_RESULT: resultFile,
            CODEBUDDY_LABEL_PATHS: paths ? changedFile : '',
            CODEBUDDY_LABEL_BUDGET: String(budget), CODEBUDDY_LABEL_CANCEL: cancelFile } });
      signal?.throwIfAborted();
      // Paths must not pass through Windows PowerShell's locale stdout codec.
      const result = JSON.parse(await readFile(resultFile, 'utf8'));
      if (!['complete', 'partial'].includes(result.Status)) throw new Error(
        `Existing-file label preparation ${result.Status}; visited ${result.Visited} objects, labelled ${result.Changed}. The user command was not started.`);
      return result;
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
