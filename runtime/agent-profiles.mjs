import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { invalid } from './providers.mjs';
import { workspaceIdentity } from './workspaces.mjs';

export const AGENT_AVATARS = ['app-logo', '🤖', '🐱', '🦊', '🎨', '📚', '🔬', '🌱', '✨'];
const list = (value, field) => {
  if (!Array.isArray(value) || value.length > 1000 || value.some(x => typeof x !== 'string' || !x || x.length > 200)) throw invalid(`Invalid ${field}`);
  return [...new Set(value)];
};
export function validateAgentProfile(input) {
  if (!input || typeof input !== 'object') throw invalid('Agent profile is required');
  for (const [field, limit] of [['name', 80], ['providerId', 200], ['modelId', 200], ['prompt', 32000]])
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > limit) throw invalid(`Invalid ${field}`);
  if (!AGENT_AVATARS.includes(input.avatar)) {
    const match = typeof input.avatar === 'string' && input.avatar.length <= 350000 && /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.avatar);
    const png = match ? Buffer.from(match[1], 'base64') : null;
    if (!png || png.length < 33 || png.length > 256 * 1024 || png.toString('base64') !== match[1] ||
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii', 12, 16) !== 'IHDR' ||
        png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 256 || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 256)
      throw invalid('Choose an available avatar or a PNG avatar up to 256 pixels and 256 KB');
  }
  return { name: input.name.trim(), avatar: input.avatar, providerId: input.providerId, modelId: input.modelId,
    prompt: input.prompt.trim(), skills: list(input.skills, 'skills'), tools: list(input.tools, 'tools'), mcpServers: list(input.mcpServers, 'MCP services') };
}
function savedProfile(input) {
  if (typeof input?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1) throw invalid('Invalid saved agent profile');
  return { ...validateAgentProfile(input), id: input.id, revision: input.revision };
}

// This is an availability policy, not a filesystem sandbox. Native permissions
// remain an independent upper bound, including for shell and filesystem tools.
export function agentAllowsTool(profile, name) {
  if (!profile) return true;
  // Discovery only reveals already admitted schemas; it is the transport for
  // deferred tools, not an additional executable capability.
  if (name === 'search_mcp_tools') return profile.tools.length > 0 || profile.mcpServers.length > 0;
  if (name === 'skill') return profile.skills.length > 0;
  if (name.startsWith('mcp__')) return profile.mcpServers.some(server => name.startsWith(`mcp__${server}__`));
  return profile.tools.includes(name);
}

export async function workspaceAgent(store, cwd) {
  const bindings = store.read(['agentWorkspaces']).agentWorkspaces ?? {};
  if (!Object.keys(bindings).length) return null;
  const canonical = workspaceIdentity(await realpath(cwd));
  const match = Object.entries(bindings).filter(([root]) => {
    const relative = path.relative(root, canonical);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }).sort(([a], [b]) => b.length - a.length)[0];
  return match ? savedProfile(match[1]) : null;
}

export async function agentProfileRequest(host, action, input, connection) {
  const store = host.store;
  if (action === 'workspaces') return { directories: Object.keys(store.read(['agentWorkspaces']).agentWorkspaces ?? {}) };
  if (action === 'list') return { profiles: (store.read(['agentProfiles']).agentProfiles ?? []).map(savedProfile), avatars: AGENT_AVATARS };
  if (action === 'save') {
    const profile = validateAgentProfile(input.profile);
    const provider = host.provider(profile.providerId);
    if (!provider.models.includes(profile.modelId)) throw invalid('Select an available model');
    const id = input.profile.id ?? randomUUID();
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw invalid('Invalid agent ID');
    let saved;
    await store.update(state => {
      state.agentProfiles ??= [];
      const index = state.agentProfiles.findIndex(p => p.id === id);
      if (input.profile.id && index < 0) throw invalid('Agent no longer exists');
      const previous = state.agentProfiles[index];
      if (previous && input.profile.revision !== previous.revision) throw invalid('Agent was edited elsewhere; refresh before saving');
      saved = { ...profile, id, revision: (previous?.revision ?? 0) + 1 };
      if (index < 0) state.agentProfiles.push(saved); else state.agentProfiles[index] = saved;
    }, ['agentProfiles']);
    return { profile: saved };
  }
  if (action === 'delete') {
    await store.update(state => { state.agentProfiles = (state.agentProfiles ?? []).filter(p => p.id !== input.id); }, ['agentProfiles']);
    return {};
  }
  if (action === 'create-workspace') {
    const stored = (store.read(['agentProfiles']).agentProfiles ?? []).find(p => p.id === input.id);
    if (!stored) throw invalid('Agent no longer exists');
    const profile = savedProfile(stored);
    const root = path.resolve(process.env.CODEBUDDY_WORKSPACE_ROOT ?? path.join(store.directory, 'workspaces'));
    await mkdir(root, { recursive: true });
    const requestedPath = path.join(await realpath(root), `agent-${randomUUID()}`);
    const lease = await host.workspaces.acquire({ requestedPath, expectedState: 'missing', expectedIdentity: workspaceIdentity(requestedPath) }, connection);
    const key = workspaceIdentity(lease.workingDir);
    try {
      await store.update(state => { state.agentWorkspaces ??= {}; state.agentWorkspaces[key] = profile; }, ['agentWorkspaces']);
      const created = await host.request('session/new', { cwd: lease.workingDir, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } }, connection);
      return { ...created, workingDir: lease.workingDir, workspaceName: profile.name };
    } catch (error) {
      // session/new may report a permission-service failure after committing
      // the conversation. Never detach a committed workspace's role policy.
      if (store.read(['sessions'], { sessionFields: ['cwd'] }).sessions.some(s => workspaceIdentity(s.cwd) === key)) throw error;
      await store.update(state => { delete state.agentWorkspaces?.[key]; }, ['agentWorkspaces']);
      await host.workspaces.release(lease.leaseId, connection);
      throw error;
    }
  }
  throw invalid('Unknown agent operation');
}
