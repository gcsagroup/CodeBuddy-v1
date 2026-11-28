import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { registerToolSessionApproval } from './tool-session-approval.mjs';
import { inspectImage } from './harness/skills/media-quality/inspect-image.mjs';

// These are the same bundled entry points used by distribution preparation.
// A source checkout may have no generated payload; report that before spawning.
export async function assertCodeNavigationRuntime(runtime) {
  const required = [
    path.join('py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
    'assets/code-navigation.py', 'assets/code_navigation_runtime.py', 'assets/serena/serena/cli.py', 'assets/serena/mcp/__init__.py',
    'assets/pyright/dist/pyright-langserver.js',
  ];
  const missing = (await Promise.all(required.map(async file => {
    try { return (await stat(path.join(runtime, file))).isFile() ? null : file; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return file; throw error; }
  }))).filter(Boolean);
  if (missing.length) throw Object.assign(new Error(
    'Code navigation runtime is not prepared: bundled Python, Serena and Pyright are required. ' +
    'Prepare the matching payloads with scripts/prepare-serena-runtime.cjs and scripts/prepare-pyright-runtime.cjs. ' +
    'Missing: ' + missing.join(', ')), { code: 'CODE_NAVIGATION_UNAVAILABLE' });
}

export function developmentTools({ cwd, dataDir, request = fetch }) {
  const root = path.resolve(cwd);
  return [
    registerToolSessionApproval({
      name: 'code_navigation',
      annotations: { readOnlyHint: true, destructiveHint: false },
      ...(process.platform === 'win32' && process.arch === 'x64' ? { codeNavigation: {
        workspace: root,
        runtime: fileURLToPath(new URL('./', import.meta.url)),
        state: path.join(dataDir ?? root, 'tool-runtime', 'serena'),
      } } : {}),
      description: 'Read-only semantic code queries using Serena: overview a file, locate a symbol definition, or find references. Scope is the current workspace.',
      inputSchema: { type: 'object', properties: {
        operation: { type: 'string', enum: ['overview', 'definition', 'references'] },
        path: { type: 'string', minLength: 1 }, symbol: { type: 'string', minLength: 1 },
      }, required: ['operation', 'path'], additionalProperties: false },
      async execute(args, { signal, sessionId, queryCodeNavigation } = {}) {
        const directory = await realpath(root), file = await realpath(path.resolve(root, args.path));
        const relative = path.relative(directory, file);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Code must be inside the current workspace');
        if (!(await stat(file)).isFile()) throw Error('Code navigation requires a source file, not a directory; choose a specific file for the symbol query.');
        if (args.operation !== 'overview' && !args.symbol) throw Error('A symbol name is required');
        const parameters = { relative_path: relative.replaceAll(path.sep, '/'), max_answer_chars: 18000 };
        if (args.operation === 'definition') parameters.name_path_pattern = args.symbol;
        if (args.operation === 'references') parameters.name_path = args.symbol;
        const runtime = fileURLToPath(new URL('./', import.meta.url));
        await assertCodeNavigationRuntime(runtime);
        if (process.platform === 'win32' && process.arch === 'x64' && sessionId) {
          if (!queryCodeNavigation) throw Error('Managed code navigation binding is unavailable');
          const deadline = AbortSignal.timeout(180000);
          const result = await queryCodeNavigation(args.operation, parameters, directory,
            AbortSignal.any([deadline, ...(signal ? [signal] : [])]));
          if (result.isError) throw Error(JSON.stringify(result.content));
          return result;
        }
        const python = path.join(runtime, 'py/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
        return new Promise((resolve, reject) => {
          const child = spawn(python, ['-I', '-B', path.join(runtime, 'assets/code-navigation.py')], { cwd: directory, windowsHide: true, signal,
            stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000 });
          let output = '', errors = '';
          child.stdout.on('data', data => { output += data; if (output.length > 1000000) child.kill(); });
          child.stderr.on('data', data => { errors = (errors + data).slice(-6000); });
          child.on('error', reject);
          child.on('close', code => {
            if (code !== 0) return reject(Error('Code navigation failed: ' + errors));
            try { const result = JSON.parse(output); if (result.isError) return reject(Error(JSON.stringify(result.content))); resolve(result); }
            catch (error) { reject(error); }
          });
          child.stdin.on('error', () => {});
          child.stdin.end(JSON.stringify({ operation: args.operation, workspace: directory, state: path.join(dataDir ?? directory, 'tool-runtime', 'serena'), nodeExecutable: process.execPath, arguments: parameters }));
        });
      },
    }, { key: JSON.stringify(['code_navigation', root]) }),
    registerToolSessionApproval({
      name: 'library_docs',
      description: 'Find library documentation matching the project dependency version. Search by library name, then query the returned library ID. Only send public API questions.',
      inputSchema: { type: 'object', properties: {
        operation: { type: 'string', enum: ['search', 'query'] }, library: { type: 'string', minLength: 1, maxLength: 200 },
        query: { type: 'string', minLength: 1, maxLength: 2000 },
      }, required: ['operation', 'library', 'query'], additionalProperties: false },
      async execute(args, { signal } = {}) {
        const url = new URL(args.operation === 'search' ? 'https://context7.com/api/v2/libs/search' : 'https://context7.com/api/v2/context');
        url.searchParams.set(args.operation === 'search' ? 'libraryName' : 'libraryId', args.library);
        url.searchParams.set('query', args.query);
        if (args.operation === 'query') url.searchParams.set('type', 'json');
        const response = await request(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
        if (!response.ok) throw Error(`Context7 HTTP ${response.status}. Authentication or service quota may be required.`);
        const body = await response.text();
        if (body.length > 250000) throw Error('Documentation response exceeds 250 KB; narrow the query');
        return { source: url.href, data: body, versionVerified: false };
      },
    }, { key: 'context7-public-docs', dependencies: [request] }),
    registerToolSessionApproval({
      name: 'inspect_media',
      description: 'Read image or sprite sheet metadata, per-frame alpha bounds and frame delays. Use for pet clipping, transparent margins, stable overlay placement and animation diagnostics.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, columns: { type: 'integer', minimum: 1, maximum: 24 }, rows: { type: 'integer', minimum: 1, maximum: 24 } }, required: ['path'], additionalProperties: false },
      async execute(args) {
        const directory = await realpath(root), file = await realpath(path.resolve(root, args.path));
        const relative = path.relative(directory, file);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Media must be inside the current workspace');
        if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(path.extname(file).toLowerCase())) {
          const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
            { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
          return { kind: 'video', metadata: JSON.parse(stdout), visualReviewRequired: true };
        }
        return inspectImage(file, args);
      },
    }, { key: JSON.stringify(['inspect_media', root]) }),
  ];
}
