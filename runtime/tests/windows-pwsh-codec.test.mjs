import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const workerFlag = '--pwsh-codec-worker';
const text = '中文🚀';
const units = [...Array(text.length)].map((_, index) => text.charCodeAt(index)).join(',');

async function sourceIdentity() {
  const hashes = {};
  for (const file of ['pwsh-executor.mjs', 'windows-pwsh-codec.mjs', 'windows-sandbox.mjs', 'windows-sandbox-startup.mjs', 'windows-shell-output.mjs']) {
    try { hashes[file] = createHash('sha256').update(await readFile(new URL('../harness/' + file, import.meta.url))).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hashes[file] = null; }
  }
  return { revision: (await run('git', ['rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim(), hashes };
}

async function collect(root) {
  await import('../harness/index.mjs');
  const require = createRequire(new URL('../harness/package.json', import.meta.url));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const { default: SessionProjections } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-projection')));
  const { default: SandboxPolicy } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sandbox-policy')));
  const { resolvePwshPath } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pwsh-local')));
  const { default: CodeBuddyPwshExecutor } = await import('../harness/pwsh-executor.mjs');
  const { default: WindowsSandboxProvider } = await import('../harness/windows-sandbox.mjs');
  const { default: WindowsSubprocessRuntime } = await import('../harness/windows-shell-output.mjs');
  const { WindowsSessionTemps } = await import('../harness/windows-session-temps.mjs');
  const native = join(root, 'native.cjs'), pipe = join(root, 'pipe.cjs');
  await writeFile(native, 'process.stdout.write("NATIVE|中文🚀\\n");');
  await writeFile(pipe, 'let b=[];process.stdin.on("data",c=>b.push(c));process.stdin.on("end",()=>process.stdout.write("PIPE64|"+Buffer.concat(b).toString("base64")+"\\n"));');
  const metadata = "Write-Output ('META|' + $PSVersionTable.PSVersion + '|' + $ExecutionContext.SessionState.LanguageMode + '|' + [Console]::InputEncoding.CodePage + '|' + [Console]::OutputEncoding.CodePage + '|' + $OutputEncoding.CodePage)";
  // Report UTF-16 units as ASCII: legacy input/output code-page round trips can otherwise hide corruption.
  const input = '$seen=@($input); Write-Output ("STDIN_UNITS|" + (([char[]]($seen -join "`n") | ForEach-Object { [int]$_ }) -join ","))';
  const boundary = "try { Set-Content -LiteralPath 'must-not-write.txt' -Value 'unexpected'; Write-Output 'WRITE|ALLOWED' } catch { Write-Output 'WRITE|DENIED' }";
  const rows = {};
  for (const [family, shell] of [['core', resolvePwshPath()], ['legacy', join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')]]) {
    const context = new Context(), temps = new WindowsSessionTemps();
    context.provide('codebuddyWindowsSessionTemps', temps);
    context.effect(() => async () => { await temps.quiesceProcesses(); await temps.close(true); });
    try {
      await context.plugin(SessionProjections);
      await context.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: root });
      await context.plugin(WindowsSubprocessRuntime);
      await context.plugin(WindowsSandboxProvider, {});
      await context.plugin(CodeBuddyPwshExecutor, { pwshPath: shell, cwd: root, timeoutMs: 7000, maxTimeoutMs: 7000, maxOutputBytes: 128 * 1024, maxSpillBytes: 128 * 1024, graceMs: 1000 });
      assert.equal(context.sandbox.sessionTemps, temps, 'Use the actual shared Host TEMP owner');
      assert.equal(context.subprocess.sessionResources, temps);
      const execute = async (command, stdin) => {
        const spec = context.shell.resolve({ command, ...(stdin === undefined ? {} : { stdin }), workdir: root,
          sandboxPolicy: { mode: 'read-only', workspaceRoot: root, sessionId: 'codec-' + family },
          env: { CB_NODE: process.execPath, CB_NATIVE: native, CB_PIPE: pipe } });
        return (await context.shell.execute(spec)).result();
      };
      rows[family + 'Eof'] = await execute("$input | ForEach-Object { Write-Output ('UNEXPECTED_INPUT|' + $_) }; Write-Output 'EOF_DONE'");
      rows[family + 'Text'] = await execute([
        metadata, input,
        ...(family === 'core' ? ["Write-Output 'DIRECT|中文🚀'", '& $env:CB_NODE $env:CB_NATIVE',
          '$captured=& $env:CB_NODE $env:CB_NATIVE', "Write-Output ('CAPTURE|' + $captured)"] : []),
        "'中文🚀' | & $env:CB_NODE $env:CB_PIPE",
        ...(family === 'core' ? ["([string][char]0xD800) | & $env:CB_NODE $env:CB_PIPE"] : []),
        boundary,
      ].join('; '), text + '\n');
      if (family === 'core') rows.coreError = await execute("Write-Error 'USER_ERROR|中文🚀' -ErrorAction Continue; exit 29");
    } finally { await context.fiber.dispose(); }
  }
  return rows;
}

function meta(result) {
  const line = result.stdout.text.split(/\r?\n/).find(value => value.startsWith('META|'));
  assert.ok(line, JSON.stringify(result));
  const [, version, languageMode, inputCp, outputCp, pipeCp] = line.split('|');
  return { version, major: Number(version.split('.')[0]), languageMode, inputCp: Number(inputCp), outputCp: Number(outputCp), pipeCp: Number(pipeCp) };
}

if (process.argv.includes(workerFlag)) {
  const root = process.argv[process.argv.indexOf(workerFlag) + 1];
  const before = await sourceIdentity();
  const rows = await collect(root);
  const after = await sourceIdentity();
  assert.deepEqual(after, before, 'Owning sources changed while the codec probes were running');
  process.stdout.write(JSON.stringify({ identity: before, rows }));
} else {
  test('Windows PowerShell codec uses the actual executor, sandbox and subprocess owner', {
    skip: process.platform !== 'win32', timeout: 30000,
  }, async t => {
    const base = await mkdtemp(join(tmpdir(), 'codebuddy-pwsh-codec-'));
    const root = join(base, 'work'); await mkdir(root);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), workerFlag, root], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    const outputChunks = [], errorChunks = [];
    let timedOut = false, killing;
    child.stdout.on('data', bytes => { outputChunks.push(bytes); });
    child.stderr.on('data', bytes => { errorChunks.push(bytes); });
    const kill = () => killing ??= run(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
    // node:test timeout alone cannot interrupt a stuck native call. Own a separate process-tree watchdog.
    // https://nodejs.org/docs/latest-v24.x/api/test.html#testname-options-fn
    const watchdog = setTimeout(() => { timedOut = true; void kill().catch(() => {}); }, 25000);
    t.after(async () => {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) await kill();
      await closed; if (killing) await killing;
      const inside = relative(tmpdir(), resolve(base));
      assert.ok(inside.startsWith('codebuddy-pwsh-codec-') && !isAbsolute(inside) && !inside.includes(sep));
      await rm(base, { recursive: true, force: true });
    });
    const [exitCode] = await closed;
    clearTimeout(watchdog);
    const output = Buffer.concat(outputChunks).toString('utf8'), errors = Buffer.concat(errorChunks).toString('utf8');
    assert.equal(timedOut, false, 'External 25s process-tree watchdog expired: ' + errors);
    assert.equal(exitCode, 0, errors + output);
    const evidence = JSON.parse(output), { rows } = evidence;
    const core = meta(rows.coreText), legacy = meta(rows.legacyText);
    t.diagnostic('source identity: ' + JSON.stringify(evidence.identity));
    t.diagnostic('PS5 compatibility observation: ' + JSON.stringify({ ...legacy,
      stdinUnits: rows.legacyText.stdout.text.match(/^STDIN_UNITS\|([^\r\n]*)/m)?.[1], expectedUnicodeUnits: units,
      pipeBytesBase64: rows.legacyText.stdout.text.match(/^PIPE64\|([^\r\n]*)/m)?.[1],
      note: 'Legacy input/code-page limitations are observed separately; this is not PS5 Unicode certification.' }));
    await t.test('PS7 default stdin is immediate EOF with no extra line or bootstrap errors', { skip: core.major < 6 }, () => {
      assert.equal(rows.coreEof.exitCode, 0, JSON.stringify(rows.coreEof));
      assert.equal(rows.coreEof.timedOut, false);
      assert.equal(rows.coreEof.stdout.text, 'EOF_DONE\r\n');
      assert.equal(rows.coreEof.stderr.text, '');
    });
    await t.test('PS7 preserves UTF8 stdin, direct/native text, BOM-free bytes and replacement fallback under read-only CLM', { skip: core.major < 6 }, () => {
      const result = rows.coreText, out = result.stdout.text;
      assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.timedOut, false);
      assert.equal(core.languageMode, 'ConstrainedLanguage');
      assert.equal(out.split(/\r?\n/).find(value => value.startsWith('STDIN_UNITS|')), 'STDIN_UNITS|' + units);
      assert.ok(out.includes('DIRECT|' + text + '\r\n'), out);
      assert.ok(out.includes('NATIVE|' + text + '\n'), out);
      assert.ok(out.includes('CAPTURE|NATIVE|' + text + '\r\n'), out);
      assert.deepEqual(out.split(/\r?\n/).filter(value => value.startsWith('PIPE64|')),
        [text, '�'].map(value => 'PIPE64|' + Buffer.from(value + '\r\n', 'utf8').toString('base64')));
      assert.ok(out.includes('WRITE|DENIED\r\n'), out);
      assert.equal(result.stderr.text, '');
    });
    await t.test('PS7 preserves a real user error and explicit nonzero exit', { skip: core.major < 6 }, () => {
      assert.equal(rows.coreError.exitCode, 29, JSON.stringify(rows.coreError));
      assert.equal(rows.coreError.stdout.text, '');
      assert.match(rows.coreError.stderr.text, /USER_ERROR\|中文🚀/);
      assert.doesNotMatch(rows.coreError.stderr.text, /CannotCreateTypeConstrainedLanguage|PropertySetterNotSupportedInConstrainedLanguage/);
    });
    await t.test('PS5 compatibility guard removes bootstrap noise without injecting stdin data', () => {
      assert.equal(legacy.major, 5);
      assert.equal(rows.legacyEof.exitCode, 0, JSON.stringify(rows.legacyEof));
      assert.equal(rows.legacyEof.timedOut, false);
      assert.equal(rows.legacyEof.stdout.text, 'EOF_DONE\r\n');
      assert.equal(rows.legacyEof.stderr.text, '');
    });
    await t.test('PS5 keeps its measured legacy CLM pipeline boundary separate from PS7 UTF8 support', () => {
      const result = rows.legacyText;
      assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.timedOut, false);
      assert.equal(legacy.languageMode, 'ConstrainedLanguage'); assert.equal(legacy.pipeCp, 20127);
      const bytes = result.stdout.text.match(/^PIPE64\|([^\r\n]*)/m)?.[1];
      // .NET Framework already emits a BOM when the original console input CP is 65001.
      const expected = Buffer.concat([legacy.inputCp === 65001 ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from('????\r\n', 'ascii')]);
      assert.equal(bytes, expected.toString('base64'));
      assert.ok(result.stdout.text.includes('WRITE|DENIED\r\n'));
      assert.equal(result.stderr.text, '');
    });
  });
}
