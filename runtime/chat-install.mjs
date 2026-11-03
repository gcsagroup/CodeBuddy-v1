import { delimiter, isAbsolute, join } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extensionConfigKey } from './session-extensions.mjs';

const nameField = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' };
export const isChatInstallProposal = name => name === 'install_mcp_extension' || name === 'install_skill';

// Read only the publisher's manifest from the requested GitHub repository.
// Registry metadata and argument hints are proposals, never executable config.
async function inspectRepository(source, signal, fetchManifest) {
  const repo = new URL(source);
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(repo.pathname);
  if (repo.origin !== 'https://github.com' || repo.username || repo.password || !match)
    throw Error('Supply the HTTPS GitHub repository root or the documented MCP launch configuration.');
  const [, owner, project] = match;
  const url = `https://api.github.com/repos/${owner}/${project.replace(/\.git$/i, '')}/contents/server.json`;
  const response = await fetchManifest(url, { headers: { accept: 'application/vnd.github.raw+json' }, redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) {
    await response.body?.cancel();
    return { installed: false, manifestStatus: response.status, guidance: 'Read the repository README and its linked MCP setup guide for the launch command or HTTP endpoint.' };
  }
  const buffers = [];
  let bytes = 0;
  for await (const part of response.body) {
    bytes += part.length;
    if (bytes > 65536) throw Error('MCP manifest exceeds 64 KiB.');
    buffers.push(part);
  }
  const manifest = JSON.parse(Buffer.concat(buffers).toString('utf8'));
  if (!manifest || (!Array.isArray(manifest.packages) && !Array.isArray(manifest.remotes)))
    throw Error('No MCP packages or remotes in server.json. Read the publisher’s setup guide.');
  return { installed: false, source: url, repository: manifest.repository?.url, publisherSetupUrl: manifest.websiteUrl,
    packages: (manifest.packages ?? []).map(p => ({ registryType: p.registryType, identifier: p.identifier,
      runtimeHint: p.runtimeHint, transport: p.transport?.type, packageArguments: p.packageArguments,
      requiresConfiguration: Boolean(p.runtimeArguments?.length || p.environmentVariables?.length) })),
    remotes: (manifest.remotes ?? []).map(r => ({ type: r.type, url: r.url })),
    guidance: 'Use the publisher setup page to confirm the MCP server executable and arguments. Submit the launch configuration to this tool for approval and handshake. Package installation commands do not speak MCP.' };
}

// A package name need not be an executable name. An existing same-name CLI is
// only a candidate: the desktop approves its exact absolute path, and a real
// MCP handshake must succeed before settings can publish it.
async function localManifestCandidate(manifest, repositoryUrl, searchPath) {
  const identity = url => url?.replace(/\/?$/, '').replace(/\.git$/i, '').toLowerCase();
  if (typeof manifest.repository !== 'string' || identity(manifest.repository) !== identity(repositoryUrl)) return;
  const packages = manifest.packages.filter(p => p.registryType === 'pypi' && p.transport === 'stdio' && !p.requiresConfiguration &&
    typeof p.identifier === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(p.identifier) &&
    Array.isArray(p.packageArguments) && p.packageArguments.length && p.packageArguments.every(a =>
      a?.type === 'positional' && (a.value !== undefined || a.isFixed === true) &&
      typeof (a.value ?? a.valueHint) === 'string' && /^[a-z][a-z0-9_-]*$/i.test(a.value ?? a.valueHint)));
  if (packages.length !== 1) return;
  const [pkg] = packages;
  for (const directory of searchPath.split(delimiter).filter(isAbsolute)) {
    const command = join(directory, pkg.identifier + (process.platform === 'win32' ? '.exe' : ''));
    try {
      if (!(await stat(command)).isFile()) continue;
      await access(command, constants.X_OK);
      return { name: pkg.identifier.toLowerCase(), command, args: pkg.packageArguments.map(a => a.value ?? a.valueHint) };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
}

// Installation is a foreground settings operation. A proposal may only be
// applied by the root chat that owns its live desktop confirmation.
export function chatInstallTools({ session, settings, library, foreground, confirm, fetchManifest = fetch, searchPath = process.env.PATH ?? '' }) {
  const admit = context => {
    context.signal.throwIfAborted();
    if (context.sessionId !== session.id || !foreground()?.ask) throw Error('Open the requesting chat to install this item.');
  };
  return [{
    name: 'install_mcp_extension',
    rootOnly: true,
    description: 'Add or connect a repository tool to CodeBuddy / 从仓库添加或连接工具。For a GitHub repository, call this directly with only repository_url. It reads the publisher MCP manifest and proposes a compatible local CLI for desktop confirmation. If no candidate exists, use the returned setup information to submit name and server command with args, or name and HTTP MCP endpoint. Only a verified connection is saved. Never include credentials.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' }, command: { type: 'string', minLength: 1 }, args: { type: 'array', items: { type: 'string' } },
      url: { type: 'string', minLength: 1 }, repository_url: { type: 'string', description: 'GitHub repository root for manifest discovery and a confirmed local connection.' },
    }, additionalProperties: false },
    async execute(input, context) {
      admit(context);
      const source = input.repository_url;
      if (source) {
        if (input.command || input.args || input.url) throw Error('Inspect the repository and submit the launch configuration in separate calls.');
        const manifest = await inspectRepository(source, context.signal, fetchManifest);
        const candidate = await localManifestCandidate(manifest, source, searchPath);
        if (!candidate) return manifest;
        input = candidate;
      }
      if (!input.name) throw Error('Provide the extension name with its MCP launch configuration.');
      if (input.url ? input.command !== undefined || input.args !== undefined : !input.command || !Array.isArray(input.args))
        throw Error('Provide an HTTP MCP URL or a command with its argument array.');
      const extension = { type: 'mcp', server: { ...input, ...(input.url ? { type: 'http', headers: [] } : { env: [] }) } };
      if ((await settings.extensionSnapshot()).configured.some(entry => entry.configKey === extensionConfigKey(input.name)))
        throw Error('An extension with this name already exists. Review it in extension settings.');
      const confirmation = input.command
        ? '允许 CodeBuddy 运行下方程序，测试 MCP 连接吗？连接成功后会在本机保存并启用此扩展。即使处于完全访问模式，每次安装也需要确认。'
        : '允许 CodeBuddy 连接下方 MCP 地址吗？连接成功后会在本机保存并启用此扩展。即使处于完全访问模式，每次安装也需要确认。';
      await confirm('install_mcp_extension', { ...input, ...(source ? { repository_url: source } : {}) }, confirmation, context);
      admit(context);
      const tested = await settings.request('config/extensions/test', { extension, workingDir: session.cwd });
      if (!tested.success) throw Error('MCP connection test failed: ' + tested.error);
      admit(context);
      await settings.saveExtension({ extension, enabled: true }, false, { installingSessionId: session.id, signal: context.signal });
      return { installed: true, connectionVerified: true, tools: tested.tools, availableFrom: 'next turn' };
    },
  }, {
    name: 'install_skill',
    rootOnly: true,
    description: 'Install an existing skill using its official GitHub tree URL (the directory containing SKILL.md) or direct HTTPS SKILL.md file. Choose project or global scope. The desktop previews and requests approval before saving. Do not edit CodeBuddy source.',
    inputSchema: { type: 'object', properties: {
      name: nameField, url: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'] },
    }, required: ['name', 'url', 'scope'], additionalProperties: false },
    async execute(input, context) {
      admit(context);
      const rootKind = input.scope === 'global' ? 'global' : 'project_agents';
      const root = (await library.roots(session.cwd)).find(candidate => candidate.rootKind === rootKind);
      const owner = {};
      const release = () => library.disconnect(owner);
      context.signal.addEventListener('abort', release, { once: true });
      try {
        admit(context);
        const preview = await library.previewDownload({ projectDir: session.cwd, url: input.url,
          destination: { rootKind, rootId: root.rootId, name: input.name } }, owner);
        if (preview.hasConflict) throw Error('A skill already exists at the selected destination.');
        await confirm('install_skill', { ...input, target: preview.target, files: preview.files }, '将从指定来源安装技能到以下目录。', context);
        admit(context);
        const { skill } = await library.apply(preview.previewToken, owner);
        const receipt = { installed: true, name: skill.name, path: skill.displayPath, version: skill.version, enabled: skill.enabled };
        try {
          const catalog = await library.catalog(session.cwd);
          const entry = catalog.candidates.find(candidate => candidate.name === skill.name &&
            candidate.path === join(skill.displayPath, 'SKILL.md'));
          return { ...receipt, availableForModel: Boolean(entry?.invocation.modelInvocable && !entry.shadowedBy) };
        } catch {
          return { ...receipt, catalogVerification: 'unavailable' };
        }
      } finally { context.signal.removeEventListener('abort', release); release(); }
    },
  }];
}
