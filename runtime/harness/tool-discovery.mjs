import { getMcpToolMetadata } from './mcp-bridge.mjs';

// Optional adapter capabilities share Harness's registry and logged assembly.
// The canonical registry, authorization, execution and inventory stay unchanged.
const optionalNative = new Set(['generate_image', 'generate_video', 'create_desktop_pet', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'read_image', 'working_directory',
  'skill', 'web_fetch', 'load_workspace_dependencies', 'todo_write', 'project_memory', 'create_goal', 'get_goal', 'update_goal', 'subagent', 'subagent_explorer', 'subagent_browser', 'list_agents',
  'interrupt_agent', 'send_message', 'job_kill', 'job_list', 'job_output',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
const deferred = name => optionalNative.has(name) || name.startsWith('mcp__') || name.startsWith('git_') || name === 'github_runtime_status' || /^subagent_(coder|planner|reviewer|tester)$/.test(name);
export function installToolDiscovery(ctx, agent) {
  const previous = agent.session.requestHeader()?.tools ?? [];
  // Older headers contained the whole catalog. Only restore headers written
  // by discovery, otherwise reopening an old conversation reloads every tool.
  const selected = new Set(previous.some(tool => tool.name === 'search_mcp_tools')
    ? previous.filter(tool => deferred(tool.name)).slice(-16).map(tool => tool.name) : []);
  const available = () => ctx.tools.schemas(agent).filter(tool => deferred(tool.name));
  // Restricted observers/reviewers must keep their exact tool boundary.
  if (!available().length) return;
  ctx.tools.register({
    name: 'search_mcp_tools',
    description: 'Find and load tools by keywords or exact names. Includes file edits, shell, skills, memory, goals, jobs, subagents, Git, desktop, browser and web. Empty query lists a page. Loaded tools keep their original permissions and execute through CodeBuddy.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Short search keywords; empty lists tools.' },
      names: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Exact tool names to load.' },
      offset: { type: 'integer', minimum: 0, description: 'Page offset, default 0.' },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ query = '', names = [], offset = 0 }) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const tools = available();
      const scored = tools.map(tool => ({ tool, score: terms.reduce((n, term) => n + (tool.name.toLowerCase().includes(term) ? 3 : 0) + (tool.description?.toLowerCase().includes(term) ? 1 : 0), 0) }));
      const matches = names.length ? tools.filter(tool => names.includes(tool.name))
        : scored.filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).map(item => item.tool);
      const page = matches.slice(offset, offset + 5);
      for (const tool of page) { selected.delete(tool.name); selected.add(tool.name); }
      while (selected.size > 16) selected.delete(selected.values().next().value);
      return { tools: page, totalMatches: matches.length, ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}), missingNames: names.filter(name => !tools.some(tool => tool.name === name)) };
    },
  });
  ctx.systemPrompt.section({ name: 'codebuddy:mcp-discovery', order: 99, interpolate: false,
    text: () => {
      const count = available().length;
      return count ? `${count} tools are available through search_mcp_tools. Load schemas before calling. Native names: ${available().filter(t => optionalNative.has(t.name)).map(t => t.name).join(', ')}. Search other capabilities by keywords; use English names/keywords for discovery.` : '';
    },
  });
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    const tools = assembly.tools.filter(tool => !deferred(tool.name) || selected.has(tool.name));
    const servers = new Set(tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => getMcpToolMetadata(ctx, agent, tool.name)?.extensionName).filter(Boolean));
    // Server guidance is separate from schemas upstream. Keep it with loaded
    // server tools, without mutating shared connection scopes or their registry.
    const active = new Set(tools.map(t => t.name));
    const sections = assembly.sections?.filter(section => {
      if (section.name.startsWith('mcp:')) return servers.has(section.name.slice(4));
      if (section.name === 'mcp-resource-servers') return [...active].some(n => n.endsWith('mcp_resources') || n === 'read_mcp_resource' || n === 'list_mcp_resource_templates');
      if (section.name === 'tool:goal') return ['create_goal', 'get_goal', 'update_goal'].some(n => active.has(n));
      // Shell tools can create a background job before a job control is loaded.
      if (section.name === 'tool:jobs') return ['pwsh', 'bash', 'job_kill', 'job_list', 'job_output'].some(n => active.has(n));
      if (section.name.startsWith('tool:') && deferred(section.name.slice(5))) return active.has(section.name.slice(5));
      return true;
    });
    return { ...assembly, ...(sections ? { sections } : {}), tools };
  });
  return ctx.tools.get('search_mcp_tools', agent);
}
