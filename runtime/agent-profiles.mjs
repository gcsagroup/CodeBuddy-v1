import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { invalid } from './providers.mjs';
import { workspaceIdentity } from './workspaces.mjs';
import { AGENT_AVATARS, DEFAULT_AGENT_PRESETS } from './agent-presets.mjs';

export { AGENT_AVATARS };
const list = (value, field) => {
  if (!Array.isArray(value) || value.length > 1000 || value.some(x => typeof x !== 'string' || !x || x.length > 200)) throw invalid(`Invalid ${field}`);
  return [...new Set(value)];
};
export function validateAgentProfile(input) {
  if (!input || typeof input !== 'object') throw invalid('Agent profile is required');
  for (const [field, limit] of [['name', 80], ['prompt', 32000]])
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > limit) throw invalid(`Invalid ${field}`);
  if (input.capabilities !== undefined && !['inherit', 'selected'].includes(input.capabilities)) throw invalid('Invalid agent capabilities');
  if (!AGENT_AVATARS.includes(input.avatar)) {
    const match = typeof input.avatar === 'string' && input.avatar.length <= 350000 && /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.avatar);
    const png = match ? Buffer.from(match[1], 'base64') : null;
    if (!png || png.length < 33 || png.length > 256 * 1024 || png.toString('base64') !== match[1] ||
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii', 12, 16) !== 'IHDR' ||
        png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 256 || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 256)
      throw invalid('Choose an available avatar or a PNG avatar up to 256 pixels and 256 KB');
  }
  // Older templates may contain model preferences. They are intentionally
  // ignored: only the conversation owns provider/model selection.
  return { name: input.name.trim(), avatar: input.avatar,
    prompt: input.prompt.trim(), skills: list(input.skills, 'skills'), tools: list(input.tools, 'tools'), mcpServers: list(input.mcpServers, 'MCP services'),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }) };
}
export function savedAgentProfile(input) {
  if (typeof input?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1) throw invalid('Invalid saved agent profile');
  return { ...validateAgentProfile(input), id: input.id, revision: input.revision };
}

// This is an availability policy, not a filesystem sandbox. Native permissions
// remain an independent upper bound, including for shell and filesystem tools.
export function agentAllowsTool(profile, name) {
  if (!profile || profile.capabilities === 'inherit') return true;
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
  return match ? savedAgentProfile(match[1]) : null;
}

const profileKey = profile => profile ? `${profile.id}:${profile.revision}` : 'default';
export function agentProfileChoice(store, id) {
  if (id === null) return null;
  const preset = DEFAULT_AGENT_PRESETS.find(item => item.profile.id === id);
  if (preset) return savedAgentProfile(preset.profile);
  const stored = (store.read(['agentProfiles']).agentProfiles ?? []).find(item => item.id === id);
  if (!stored) throw invalid('Agent no longer exists');
  return savedAgentProfile(stored);
}
export function createAgentSelection(profile, baseline = null) {
  return { version: 1, revision: 1, selected: profileKey(profile), baseline: profileKey(baseline),
    profiles: { [profileKey(baseline)]: baseline, [profileKey(profile)]: profile } };
}
export function sessionAgentSelection(session) {
  const selection = session.agentSelection;
  if (selection === undefined) return { revision: 0, profile: session.agentProfile ?? null, legacy: Boolean(session.agentProfile) };
  if (selection.version !== 1 || !Number.isSafeInteger(selection.revision) || selection.revision < 1 ||
      typeof selection.selected !== 'string' || !selection.profiles || Array.isArray(selection.profiles) ||
      typeof selection.profiles !== 'object' || !Object.hasOwn(selection.profiles, selection.selected))
    throw invalid('The conversation agent selection is invalid; restore its saved configuration');
  const value = selection.profiles[selection.selected];
  return { revision: selection.revision, profile: value === null ? null : savedAgentProfile(value), legacy: false };
}

// This is input configuration, not a second execution journal. Admission and
// completion remain in the native Inbox/log; its rpcId identifies this snapshot.
export async function bindAgentInput(store, sessionId, requestId, { profile } = {}) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw invalid('Invalid native input identity');
  return store.updateSession(sessionId, session => {
    session.agentInputs ??= {};
    // Record even ordinary in-flight inputs: the first role selection can
    // happen while that input is still preparing, before native Inbox sees it.
    if (!session.agentSelection) {
      const baseline = session.agentProfile ?? null;
      session.agentInputs = { ...session.agentInputs, [requestId]: profileKey(baseline) };
      return baseline;
    }
    const selected = sessionAgentSelection(session);
    if (Object.hasOwn(session.agentInputs, requestId)) return agentInputProfile(session, requestId);
    const value = profile === undefined ? selected.profile : profile === null ? null : savedAgentProfile(profile);
    const key = profileKey(value);
    session.agentSelection.profiles[key] ??= value;
    session.agentInputs = { ...session.agentInputs, [requestId]: key };
    return value;
  }, { durable: true });
}

export function agentInputProfile(session, requestId) {
  if (!session.agentSelection) return session.agentProfile ?? null;
  const key = session.agentInputs?.[requestId];
  if (key === undefined || !Object.hasOwn(session.agentSelection.profiles, key))
    throw invalid('This native input has no saved agent configuration; its role was not guessed');
  const value = session.agentSelection.profiles[key];
  return value === null ? null : savedAgentProfile(value);
}

export function agentBaselineProfile(session) {
  if (!session.agentSelection) return session.agentProfile ?? null;
  sessionAgentSelection(session);
  const key = session.agentSelection.baseline;
  if (!Object.hasOwn(session.agentSelection.profiles, key)) throw invalid('The original conversation agent configuration is missing');
  const value = session.agentSelection.profiles[key];
  return value === null ? null : savedAgentProfile(value);
}

export async function agentProfileRequest(host, action, input, connection) {
  const store = host.store;
  const current = async sessionId => {
    const committedInputs = await host.driver.agentInputIds?.(sessionId, { committedOnly: true }) ?? [];
    const session = host.session(sessionId);
    const selection = sessionAgentSelection(session);
    const effective = committedInputs.length ? agentInputProfile(session, committedInputs.at(-1)) : agentBaselineProfile(session);
    let unavailable = [];
    try { unavailable = await host.driver.mainAgentUnavailable?.(sessionId, selection.profile) ?? []; }
    catch { /* Availability hints cannot turn a committed selection into a failed save. */ }
    return { selection, effective, pending: profileKey(effective) !== profileKey(selection.profile), unavailable };
  };
  if (action === 'list') return { profiles: (store.read(['agentProfiles']).agentProfiles ?? []).map(savedAgentProfile), presets: DEFAULT_AGENT_PRESETS, avatars: AGENT_AVATARS };
  if (action === 'current') return current(input.sessionId);
  if (action === 'select' || action === 'convert') {
    const session = host.session(input.sessionId);
    if (host.sessionMutations?.has(session.id)) throw invalid('Wait for the session change to finish');
    if (session.readonlyHistory) throw invalid('This imported conversation is read-only');
    const previous = sessionAgentSelection(session);
    if (input.expectedRevision !== previous.revision) throw invalid('The conversation agent changed; refresh before selecting');
    if (previous.legacy && action !== 'convert') throw invalid('Convert this legacy workspace role before switching conversation agents; its existing capability limits will be retained');
    if (action === 'convert' && !previous.legacy) throw invalid('This conversation has no legacy workspace role to convert');
    const profile = action === 'convert' ? savedAgentProfile(session.agentProfile) : agentProfileChoice(store, input.id);
    // Existing requests predate this feature. Resolve their native identities
    // once so a later child report cannot accidentally adopt the latest role.
    const nativeInputs = session.agentSelection ? [] : await host.driver.agentInputIds?.(session.id) ?? [];
    await store.updateSession(session.id, saved => {
      if (sessionAgentSelection(saved).revision !== input.expectedRevision) throw invalid('The conversation agent changed; refresh before selecting');
      if (!saved.agentSelection) {
        const baseline = saved.agentProfile ?? null;
        saved.agentSelection = { version: 1, revision: 0, selected: profileKey(baseline),
          baseline: profileKey(baseline), profiles: { [profileKey(baseline)]: baseline } };
        saved.agentInputs = { ...saved.agentInputs, ...Object.fromEntries(nativeInputs.map(id => [id, profileKey(baseline)])) };
      }
      const key = profileKey(profile);
      if (Object.hasOwn(saved.agentSelection.profiles, key)) {
        const recorded = saved.agentSelection.profiles[key];
        if (!isDeepStrictEqual(recorded === null ? null : savedAgentProfile(recorded), profile))
          throw invalid('Agent configuration changed without a new revision; its saved snapshot was preserved');
      } else saved.agentSelection.profiles[key] = profile;
      saved.agentSelection.selected = key;
      saved.agentSelection.revision++;
    }, { durable: true });
    return current(session.id);
  }
  if (action === 'save') {
    if (DEFAULT_AGENT_PRESETS.some(item => item.profile.id === input.profile?.id)) throw invalid('Built-in agents are read-only; save a custom copy instead');
    const profile = validateAgentProfile(input.profile);
    const id = input.profile.id ?? randomUUID();
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw invalid('Invalid agent ID');
    let saved;
    await store.update(state => {
      state.agentProfiles ??= [];
      const index = state.agentProfiles.findIndex(p => p.id === id);
      if (input.profile.id && index < 0) throw invalid('Agent no longer exists');
      const previous = state.agentProfiles[index];
      if (previous && input.profile.revision !== previous.revision) throw invalid('Agent was edited elsewhere; refresh before saving');
      const name = profile.name.toLowerCase();
      if (state.agentProfiles.some(item => item.id !== id && item.name.trim().toLowerCase() === name))
        throw invalid(`已存在名为“${profile.name}”的自定义智能体，请换个名称。`);
      saved = { ...profile, id, revision: (previous?.revision ?? 0) + 1 };
      if (index < 0) state.agentProfiles.push(saved); else state.agentProfiles[index] = saved;
    }, ['agentProfiles']);
    return { profile: saved };
  }
  if (action === 'delete') {
    if (DEFAULT_AGENT_PRESETS.some(item => item.profile.id === input.id)) throw invalid('Built-in agents are read-only');
    await store.update(state => { state.agentProfiles = (state.agentProfiles ?? []).filter(p => p.id !== input.id); }, ['agentProfiles']);
    return {};
  }
  if (action === 'create-workspace') {
    const stored = (store.read(['agentProfiles']).agentProfiles ?? []).find(p => p.id === input.id);
    if (!stored) throw invalid('Agent no longer exists');
    const profile = savedAgentProfile(stored);
    const root = path.resolve(process.env.CODEBUDDY_WORKSPACE_ROOT ?? path.join(store.directory, 'workspaces'));
    await mkdir(root, { recursive: true });
    const requestedPath = path.join(await realpath(root), `agent-${randomUUID()}`);
    const lease = await host.workspaces.acquire({ requestedPath, expectedState: 'missing', expectedIdentity: workspaceIdentity(requestedPath) }, connection);
    const key = workspaceIdentity(lease.workingDir);
    try {
      await store.update(state => { state.agentWorkspaces ??= {}; state.agentWorkspaces[key] = profile; }, ['agentWorkspaces']);
      return await host.request('session/new', { cwd: lease.workingDir, mcpServers: [], _meta: { workspaceMode: 'codepro', workspaceLeaseId: lease.leaseId } }, connection);
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
