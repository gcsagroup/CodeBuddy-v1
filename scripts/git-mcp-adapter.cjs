// Adapter for @cyanheads/git-mcp-server 2.15.3 (Apache-2.0).
// Keep Git execution and schemas upstream; repair transport ownership and porcelain decoding.
const fs = require('node:fs');
const path = require('node:path');

function normalizeGitArguments(args) {
  if (process.platform !== 'win32' || !args || typeof args.path !== 'string') return args;
  let filename = args.path;
  // Rust canonical paths use the Win32 verbatim prefix. Preserve the same path,
  // then let the upstream root check run on its ordinary Windows spelling.
  if (filename.startsWith('\\\\?\\UNC\\')) filename = '\\\\' + filename.slice(8);
  else if (/^\\\\\?\\[A-Za-z]:\\/.test(filename)) filename = filename.slice(4);
  return filename === args.path ? args : { ...args, path: filename };
}

function parseGitStatus(output) {
  const records = output.split('\0');
  const result = { currentBranch: null, stagedChanges: {}, unstagedChanges: {}, untrackedFiles: [], conflictedFiles: [], isClean: true };
  const add = (group, kind, value) => (group[kind] ??= []).push(value);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [, field, ...values] = record.split(' ');
      if (field === 'branch.head') result.currentBranch = values[0] === '(detached)' ? null : values[0];
      if (field === 'branch.upstream') result.upstream = values.join(' ');
      if (field === 'branch.ab') { result.ahead = Number(values[0]); result.behind = Math.abs(Number(values[1])); }
      continue;
    }
    if (record.startsWith('! ')) continue;
    result.isClean = false;
    const fields = record.split(' '), type = fields[0], xy = fields[1];
    if (type === '?') { result.untrackedFiles.push(record.slice(2)); continue; }
    if (type === 'u') { result.conflictedFiles.push(fields.slice(10).join(' ')); continue; }
    if (type !== '1' && type !== '2') throw Error('Unknown Git porcelain record');
    const filename = fields.slice(type === '2' ? 9 : 8).join(' ');
    const original = type === '2' ? records[++i] : undefined;
    if (type === '2' && original === undefined) throw Error('Incomplete Git rename record');
    const kinds = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'modified' };
    for (const [position, group] of [[0, result.stagedChanges], [1, result.unstagedChanges]]) {
      const code = xy[position], kind = kinds[code];
      if (kind) add(group, kind, (code === 'R' || code === 'C') ? `${original} -> ${filename}` : filename);
    }
  }
  return result;
}

function patchedBundle(source) {
  const prelude = `import { AsyncLocalStorage as CodeBuddyAsyncLocalStorage } from 'node:async_hooks';
const codebuddyGitSignal = new CodeBuddyAsyncLocalStorage();
const codebuddyNormalizeGitArguments = ${normalizeGitArguments.toString()};\n`;
  const headerEnd = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  source = source.slice(0, headerEnd) + prelude + source.slice(headerEnd);
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw Error('Upstream Git adapter anchor changed: ' + from.slice(0, 75));
    source = source.replace(from, to);
  };
  const start = source.indexOf('function parseGitStatus(output) {');
  const end = source.indexOf('function parseGitDiffStat(output)', start);
  if (start < 0 || end < 0) throw Error('Upstream Git status parser missing');
  source = source.slice(0, start) + parseGitStatus.toString() + '\n' + source.slice(end);
  replace('const args = ["--porcelain=v2", "-b"];', 'const args = ["--porcelain=v2", "-b", "-z"];');
  replace('...tool.annotations && { annotations: tool.annotations }\n      }, handler);', '...tool.annotations && { annotations: tool.annotations }\n      }, (args, extra) => codebuddyGitSignal.run({signal:extra.signal}, async () => { const result = await handler(codebuddyNormalizeGitArguments(args), extra); const state = codebuddyGitSignal.getStore(); if (result.isError && state.mergeConflict && !extra.signal.aborted) return {...result, structuredContent:{success:false, strategy:args.strategy || "default", fastForward:false, conflicts:true, conflictedFiles:state.mergeConflictFiles, mergedFiles:[], message:"Merge requires conflict resolution.", codebuddyGitOutcome:state.mergeConflict}}; return result; }));');
  replace('GIT_COMMAND_TIMEOUT_MS, undefined, options.allowNonZeroExit)', 'GIT_COMMAND_TIMEOUT_MS, codebuddyGitSignal.getStore()?.signal, options.allowNonZeroExit)');
  // Advertise the existing structured conflict marker without relaxing normal merge output fields.
  replace('var OutputSchema20 = exports_external.object({', 'var OutputSchema20 = exports_external.object({\n  codebuddyGitOutcome: exports_external.object({kind: exports_external.literal("merge_conflict"), exitCode: exports_external.literal(1)}).optional(),');
  const mergeStart = source.indexOf('async function executeMerge(options, context, execGit) {');
  const mergeEnd = source.indexOf('function parseConflictedFiles(combined)', mergeStart);
  if (mergeStart < 0 || mergeEnd < 0) throw Error('Upstream merge boundaries changed');
  let merge = source.slice(mergeStart, mergeEnd);
  merge = merge.replace('if (options.abort) {\n      return {', 'if (options.abort) {\n      if (result.exitCode !== 0) throw new Error(`Merge abort failed: ${result.stderr}`);\n      return {');
  // Git's index is authoritative and filenames are NUL-delimited, regardless of locale.
  const conflictStart = merge.indexOf('    const hasConflicts =');
  const conflictEnd = merge.indexOf('    const mergedFiles =', conflictStart);
  if (conflictStart < 0 || conflictEnd < 0) throw Error('Upstream merge conflict handling changed');
  merge = merge.slice(0, conflictStart) + `    const unmerged = await execGit(["status", "--porcelain=v2", "-z"], context.workingDirectory, context.requestContext);
    const conflictedFiles = parseGitStatus(unmerged.stdout).conflictedFiles;
    const hasConflicts = conflictedFiles.length > 0;
    if (hasConflicts && result.exitCode === 1) { const state = codebuddyGitSignal.getStore(); if (state) { state.mergeConflict = {kind:"merge_conflict", exitCode:1}; state.mergeConflictFiles = conflictedFiles; } }
    if (hasConflicts) throw new Error("Merge requires conflict resolution. Unmerged files: " + JSON.stringify(conflictedFiles) + ". Read both sides, edit, test, then git_add and git_commit; or use abort=true. The merge and working files are preserved.");
    if ((result.exitCode ?? 1) !== 0) throw new Error(result.stderr || result.stdout || "Git merge failed");
    const isFastForward = result.stdout.includes("Fast-forward");
` + merge.slice(conflictEnd);
  source = source.slice(0, mergeStart) + merge + source.slice(mergeEnd);
  replace('const proc = import_cross_spawn.default("git", args, {', `const runner = process.env.CODEBUDDY_GIT_RUNNER;
    if (process.platform === "win32" && !runner) { reject(new Error("CodeBuddy Git process supervisor is not configured")); return; }
    const proc = import_cross_spawn.default(runner || "git", runner ? ["__git-mcp-exec", ...args] : args, {`);
  // A killed process has a null exit code and must never be reported as success.
  const runtimeStart = source.indexOf('async function spawnWithNode(');
  const runtimeEnd = source.indexOf('async function spawnGitCommand(', runtimeStart);
  if (runtimeStart < 0 || runtimeEnd < 0) throw Error('Upstream runtime boundaries changed');
  let runtime = source.slice(runtimeStart, runtimeEnd);
  if (!runtime.includes('const code = exitCode ?? 0;')) throw Error('Upstream exit handling changed');
  runtime = runtime.replace('const code = exitCode ?? 0;', 'const code = exitCode ?? 1;');
  source = source.slice(0, runtimeStart) + runtime + source.slice(runtimeEnd);
  return source;
}

function configure(runtimeRoot, runner) {
  const pkg = path.join(runtimeRoot, 'node_modules/@cyanheads/git-mcp-server');
  if (JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version !== '2.15.3') throw Error('Adapter requires @cyanheads/git-mcp-server 2.15.3');
  if (!fs.statSync(runner).isFile()) throw Error('Git supervisor executable missing');
  fs.writeFileSync(path.join(pkg, 'dist/index.codebuddy.js'), patchedBundle(fs.readFileSync(path.join(pkg, 'dist/index.js'), 'utf8')));
  fs.writeFileSync(path.join(runtimeRoot, 'git-launch.cjs'), `const path=require('node:path');
const {pathToFileURL}=require('node:url');
process.env.MCP_TRANSPORT_TYPE='stdio';
process.env.MCP_LOG_LEVEL='error';
process.env.MCP_RESPONSE_FORMAT='json';
process.env.GIT_BASE_DIR=process.cwd();
process.env.OTEL_ENABLED='false';
process.env.GIT_SIGN_COMMITS ??= 'false';
process.env.GIT_MERGE_AUTOEDIT='no';
process.env.GIT_TERMINAL_PROMPT='0';
process.env.GCM_INTERACTIVE='never';
process.env.LOGS_DIR=path.join(__dirname,'logs');
process.env.CODEBUDDY_GIT_RUNNER=${JSON.stringify(path.resolve(runner))};
import(pathToFileURL(path.join(__dirname,'node_modules/@cyanheads/git-mcp-server/dist/index.codebuddy.js')).href)
 .catch(()=>{process.stderr.write('Local Git MCP failed to start.\\n');process.exitCode=1;});
`);
}

module.exports = { normalizeGitArguments, parseGitStatus, patchedBundle, configure };
if (require.main === module) {
  if (process.argv.length !== 4) throw Error('Usage: node git-mcp-adapter.cjs RUNTIME_ROOT GOOSE_EXECUTABLE');
  configure(process.argv[2], process.argv[3]);
  console.log('Configured Git MCP 2.15.3 adapter');
}
