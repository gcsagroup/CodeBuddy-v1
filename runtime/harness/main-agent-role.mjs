import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';
import { agentAllowsTool } from '../agent-profiles.mjs';
import { bindMainAgentPolicy } from './agent-policy.mjs';
import { MCP_RESOURCE_TOOL_NAMES } from '../mcp-settings.mjs';
import { installRoleSkills } from './role-skills.mjs';

const collaboration = new Set(['subagent', 'subagent_explorer', 'subagent_browser', 'send_message', 'interrupt_agent', 'list_agents']);
const identity = profile => profile ? `${profile.id}:${profile.revision}` : 'default';
const defaultPersona = 'You are CodeBuddy, an AI software engineering assistant working in the current workspace.';

/** Native input identities select configuration; the native log owns admission. */
export function installMainAgentRole(ctx, agent, capabilities, source, events = [], resourceServers = []) {
  let committed = source.baseline(), candidate, invalid;
  let releaseMask, maskSignature;
  const offered = [];
  let hasCustomRoleHistory = Boolean(committed);
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'user' || !event.data.source.rpcId) continue;
    committed = source.input(event.data.source.rpcId);
    hasCustomRoleHistory ||= Boolean(committed);
  }
  const current = () => {
    if (invalid) throw invalid;
    return candidate === undefined ? committed : candidate;
  };
  const roleSkills = installRoleSkills(ctx, current);
  let skillIdentity;
  let updating = false;
  const refresh = () => {
    if (updating) return;
    updating = true;
    try {
      const profile = current();
      const nextSkillIdentity = identity(profile);
      if (skillIdentity !== nextSkillIdentity) {
        skillIdentity = nextSkillIdentity;
        roleSkills.invalidate();
      }
      // Default/inherited roles have no tool mask. Restricted roles need names,
      // not a deep copy of every schema on each registry notification.
      const deny = !profile || profile.capabilities === 'inherit' ? []
        : [...ctx.tools.view(capabilities).visible.keys()].filter(name => !collaboration.has(name) && !agentAllowsTool(profile, name)).sort();
      const signature = JSON.stringify(deny);
      if (signature === maskSignature) return;
      const next = deny.length ? ctx.tools.restrict({ deny }) : undefined;
      const previous = releaseMask;
      releaseMask = next;
      maskSignature = signature;
      previous?.();
    } finally { updating = false; }
  };
  const reset = () => {
    candidate = undefined;
    invalid = undefined;
    offered.length = 0;
    refresh();
  };
  refresh();
  ctx.effect(() => () => releaseMask?.(), 'CodeBuddy current role tool mask');
  ctx.effect(() => bindMainAgentPolicy(agent, current), 'CodeBuddy main role skills');
  ctx.tools.guard(exec => {
    const profile = current();
    if (profile && profile.capabilities !== 'inherit' && MCP_RESOURCE_TOOL_NAMES.includes(exec.name)
        && !profile.mcpServers.includes(exec.arguments?.server)) return 'MCP service is not selected for the current agent';
  });
  ctx.on('tools/change', () => { if (!invalid) refresh(); }, { global: true });
  ctx.on('agent/inbox/claimed', ({ message }) => {
    if (message.source?.kind !== 'user' || !message.source.rpcId) return;
    try {
      const profile = source.input(message.source.rpcId);
      // The normal queue owns one new user request; steering in that request
      // retains its configuration. Never combine unrelated role revisions.
      if (offered.some(value => identity(value) !== identity(profile)))
        throw new Error('Inputs for different agents reached one native step; no role was guessed');
      offered.push(profile);
      candidate = profile;
      refresh();
    } catch (error) { invalid = error; }
  });
  ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    interpolate: false,
    text: () => {
      const profile = current();
      return profile ? `You are using the custom agent ${JSON.stringify(profile.name)}.\n${profile.prompt}` : defaultPersona;
    },
  });
  ctx.systemPrompt.context({
    name: 'codebuddy:current-agent', order: 125, required: true, interpolate: false,
    text: () => {
      const profile = current();
      return profile ? `Current main agent: ${JSON.stringify(profile.name)} (${identity(profile)}). Earlier roles in this conversation are historical. Subagents keep their own responsibilities.`
        : hasCustomRoleHistory ? 'Current agent: CodeBuddy (default). Earlier custom roles are historical; retain user instructions and confirmed facts.' : '';
    },
  });
  ctx.systemPrompt.section({
    name: 'mcp-resource-servers', order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false,
    text: () => {
      const profile = current();
      const names = resourceServers.filter(name => !profile || profile.capabilities === 'inherit' || profile.mcpServers.includes(name));
      return names.length ? `## MCP resource servers\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these server names: ${JSON.stringify(names)}.` : '';
    },
  });
  // Emit listeners are not admission gates. The awaited waterfall performs
  // validation, and rejected/aborted candidates never become durable roles.
  ctx.on('agent/pre-step', async (_input, next) => {
    try {
      current();
      const decision = await next();
      if (decision.kind === 'reject') reset();
      return decision;
    } catch (error) { reset(); throw error; }
  }, { prepend: true });
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'user/message' || event.data.source?.kind !== 'user' || !event.data.source.rpcId) return;
    committed = source.input(event.data.source.rpcId);
    hasCustomRoleHistory ||= Boolean(committed);
    candidate = undefined;
    invalid = undefined;
    offered.length = 0;
  });
  ctx.on('agent/status', ({ status }) => { if (status === 'idle') reset(); });
  ctx.on('agent/error', reset);
  return { current, skillUnavailable: roleSkills.unavailable };
}
