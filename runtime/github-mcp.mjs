import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { protectSecret } from './secrets.mjs';

const endpoint = 'https://api.githubcopilot.com/mcp/';
const key = 'CODEBUDDY_GITHUB_MCP_TOKEN';
const extensionKey = 'github_official';
const fingerprint = state => JSON.stringify([state.config[key], state.extensions.find(entry => entry.configKey === extensionKey)]);

async function runCli(args) {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  delete env.GH_DEBUG;
  delete env.GH_FORCE_TTY;
  return new Promise((resolve, reject) => execFile(candidates.find(existsSync) || 'gh', args,
    { env, windowsHide: true, timeout: 20000, maxBuffer: 65536 },
    (error, stdout) => error ? reject(new Error('github_cli_unavailable')) : resolve(stdout)));
}

// Invoked only by the explicit account-connect action. No token reaches the
// renderer, command arguments, diagnostics, or a user-supplied MCP endpoint.
export async function connectGithubMcp(host, login, { run = runCli } = {}) {
  if (typeof login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login))
    return { success: false, code: 'account_changed' };
  const initial = host.store.read(['config', 'extensions']);
  const expected = fingerprint(initial);
  const existing = initial.extensions.find(entry => entry.configKey === extensionKey);
  let extension;
  try {
    extension = existing ? await host.settings.decodeExtension(existing) : {
      type: 'mcp', bundled: true, envKeys: [key], timeout: 300,
      server: { name: extensionKey, type: 'http', url: endpoint, headers: [
        { name: 'Authorization', value: 'Bearer ${CODEBUDDY_GITHUB_MCP_TOKEN}' },
        { name: 'X-MCP-Toolsets', value: 'repos,issues,pull_requests,actions' },
      ] },
    };
    if (extension.type !== 'mcp' || extension.server?.name !== extensionKey ||
      extension.server.command || extension.server.url !== endpoint)
      return { success: false, code: 'endpoint_changed' };
    const verifyAccount = async () => {
      const status = JSON.parse(await run(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']));
      return status.hosts?.['github.com']?.some(account => account.active === true && account.state === 'success' && account.login === login);
    };
    if (!await verifyAccount()) return { success: false, code: 'account_changed' };
    const token = (await run(['auth', 'token', '--hostname', 'github.com', '--user', login])).trim();
    if (!token || /\s/.test(token)) return { success: false, code: 'github_cli_unavailable' };
    // Verify with fixed headers, then save exactly the definition we verified.
    extension = { ...extension, envKeys: [key], server: { name: extensionKey, type: 'http', url: endpoint,
      headers: [{ name: 'Authorization', value: 'Bearer ${CODEBUDDY_GITHUB_MCP_TOKEN}' },
        { name: 'X-MCP-Toolsets', value: 'repos,issues,pull_requests,actions' }] } };
    try {
      await host.testExtension({ extension, environment: { [key]: token } });
    } catch { return { success: false, code: 'connection_failed' }; }
    if (!await verifyAccount()) return { success: false, code: 'account_changed' };
    const [secret, protectedExtension] = await Promise.all([protectSecret(token), protectSecret(JSON.stringify(extension))]);
    await host.store.update(state => {
      if (fingerprint(state) !== expected) throw new Error('settings_changed');
      state.config[key] = { secret };
      const entry = { configKey: extensionKey, enabled: true, protected: protectedExtension };
      const index = state.extensions.findIndex(value => value.configKey === extensionKey);
      if (index < 0) state.extensions.push(entry); else state.extensions[index] = entry;
    });
    host.settings.extensionRevision++;
    host.settings.decodedExtensions.clear();
    await host.settings.changed({ extensionConfigKeys: [extensionKey] });
    return { success: true, login };
  } catch {
    // CLI/keychain errors may contain stdout; expose only a fixed diagnostic.
    return { success: false, code: 'configuration_not_saved' };
  }
}
