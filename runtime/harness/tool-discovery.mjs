import { getMcpToolMetadata, mcpServerStates, pendingMcpServers, waitForMcpServers } from './mcp-bridge.mjs';

// Optional adapter capabilities share Harness's registry and logged assembly.
// The canonical registry, authorization, execution and inventory stay unchanged.
const optionalNative = new Set(['browser_control', 'generate_image', 'generate_video', 'create_desktop_pet', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'read_image', 'working_directory',
  'web_fetch', 'load_workspace_dependencies', 'todo_write', 'project_memory', 'create_goal', 'get_goal', 'update_goal', 'subagent', 'subagent_explorer', 'subagent_browser', 'list_agents',
  'interrupt_agent', 'send_message', 'job_kill', 'job_list', 'job_output',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
const deferred = name => optionalNative.has(name) || name.startsWith('mcp__') || name.startsWith('git_') || name === 'github_runtime_status' || /^subagent_(coder|planner|reviewer|tester)$/.test(name);
// Basic delivery actions remain visible, but only when the scoped registry
// permits them. Discovery and permission/execution ownership stay unchanged.
const deliveryTools = new Set(['write', 'edit', 'browser_control', 'install_mcp_extension', 'install_skill']);
for (const name of deliveryTools) optionalNative.add(name);
// Real Ollama Cloud calls emitted null for optional nullable values and strings
// for referenced objects. Advertise omission and inline acyclic local references;
// the registry retains the original schema and validates the actual call.
export function projectOptionalValues(schema, optional = false, root = schema, references = new Set()) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  // A nested resource has its own reference scope; leave it intact.
  if (schema !== root && schema.$id) return schema;
  let result = { ...schema };
  if (optional) {
    if (Array.isArray(result.type) && result.type.includes('null') && result.type.length > 1) {
      const types = result.type.filter(type => type !== 'null');
      result.type = types.length === 1 ? types[0] : types;
    }
    for (const union of ['anyOf', 'oneOf']) {
      const branches = result[union];
      if (!Array.isArray(branches)) continue;
      const nonNull = branches.filter(branch => !(branch?.type === 'null' && Object.keys(branch).length === 1));
      if (!nonNull.length || nonNull.length === branches.length) continue;
      const { [union]: _, ...rest } = result;
      const annotations = new Set(['title', 'description', 'default']);
      if (nonNull.length === 1 && Object.keys(nonNull[0]).every(key => !(key in rest) || annotations.has(key)))
        result = { ...nonNull[0], ...rest };
      else result[union] = nonNull;
    }
    if (result.default === null && (result.type !== schema.type || result.anyOf !== schema.anyOf || result.oneOf !== schema.oneOf))
      delete result.default;
  }
  const ref = result.$ref;
  if (typeof ref === 'string' && /^#\/(\$defs|definitions)\//.test(ref) && !references.has(ref)) {
    const target = ref.slice(2).split('/').reduce((value, key) => {
      const decoded = key.replace(/~1/g, '/').replace(/~0/g, '~');
      return value && Object.hasOwn(value, decoded) ? value[decoded] : undefined;
    }, root);
    if (target && typeof target === 'object' && !Array.isArray(target) && !target.$id) {
      references = new Set([...references, ref]);
      const { $ref: _, ...siblings } = result;
      const annotations = new Set(['title', 'description', 'default']);
      result = Object.keys(target).every(key => !(key in siblings) || annotations.has(key))
        ? { ...target, ...siblings }
        : { ...siblings, allOf: [target, ...(siblings.allOf ?? [])] };
      return projectOptionalValues(result, optional, root, references);
    }
  }
  const required = new Set(result.required ?? []);
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, projectOptionalValues(value, !required.has(key), root, references)]));
  for (const key of ['$defs', 'definitions', 'patternProperties'])
    if (result[key]) result[key] = Object.fromEntries(Object.entries(result[key]).map(([name, value]) => [name, projectOptionalValues(value, false, root, references)]));
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'])
    if (Array.isArray(result[key])) result[key] = result[key].map(value => projectOptionalValues(value, false, root, references));
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else'])
    if (result[key]) result[key] = projectOptionalValues(result[key], false, root, references);
  return result;
}
export function installToolDiscovery(ctx, agent, modelEndpoint = () => undefined, applicable = () => true) {
  const project = tool => {
    const endpoint = modelEndpoint();
    if (!endpoint || new URL(endpoint).hostname !== 'ollama.com') return tool;
    return { ...tool, parameters: projectOptionalValues(tool.parameters) };
  };
  const previous = agent.session.requestHeader()?.tools ?? [];
  // Older headers contained the whole catalog. Only restore headers written
  // by discovery, otherwise reopening an old conversation reloads every tool.
  const selected = new Set(previous.some(tool => tool.name === 'search_mcp_tools')
    ? previous.filter(tool => deferred(tool.name)).slice(-16).map(tool => tool.name) : []);
  function select(name) {
    selected.delete(name);
    selected.add(name);
    if (selected.size > 16) selected.delete(selected.values().next().value);
  }
  const available = () => ctx.tools.schemas(agent).filter(tool => deferred(tool.name) && applicable(tool.name));
  let computerSkillLoaded = false;
  // A successful, model-selected skill load reveals its bounded tool surface
  // without another model round-trip. Registry masks and execution gates remain
  // authoritative; merely inspecting the skill catalog never enables tools.
  ctx.on('tools/result', (exec, result) => {
    // A model can name a registered deferred tool without first discovering it.
    // After its result (including validation failure), expose the real schema so
    // the next request can correct its arguments instead of guessing repeatedly.
    // This neither retries the action nor changes the registry/execution gates.
    if (exec.agent.id === agent.id && available().some(tool => tool.name === exec.name)) {
      select(exec.name);
    }
    if (exec.agent.id === agent.id && !result.isError && result.value?.kind === 'activation' &&
        typeof result.value.subagentId === 'string' && ['subagent', 'subagent_explorer', 'subagent_browser'].includes(exec.name)) {
      for (const tool of available()) if (tool.name === 'send_message' || tool.name === 'list_agents') {
        select(tool.name);
      }
    }
    if (exec.agent.id === agent.id && exec.name === 'skill' && !result.isError &&
        result.value?.name === 'comfyui' && result.value?.provider === 'codebuddy-comfyui-skill') {
      for (const tool of available()) if (['generate_image', 'generate_video'].includes(tool.name)) select(tool.name);
      return;
    }
    if (exec.agent.id !== agent.id || exec.name !== 'skill' || result.isError ||
        result.value?.name !== 'computer-use' || result.value?.provider !== 'codebuddy-computer-skill') return;
    computerSkillLoaded = true;
    const entryTools = new Set(['open_path', 'list_apps', 'get_app_state', 'click', 'press_key', 'type_text', 'drag', 'scroll', 'set_value', 'perform_secondary_action'].map(name => `mcp__qwen_computer__${name}`));
    for (const tool of available()) if (entryTools.has(tool.name)) select(tool.name);
  });
  // Restricted observers/reviewers must keep their exact tool boundary.
  if (!available().length && !pendingMcpServers(agent).length) return;
  ctx.tools.register({
    name: 'search_mcp_tools',
    description: 'Find and load tools by keywords or exact names. Includes file edits, shell, skills, memory, goals, jobs, subagents, Git, desktop, browser and web. Empty query lists a page. Loaded tools keep their original permissions and execute through CodeBuddy.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Short search keywords; empty lists tools.' },
      names: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Exact tool names to load.' },
      servers: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Exact pending MCP server names to wait for before searching. Other connections do not block this search.' },
      offset: { type: 'integer', minimum: 0, description: 'Page offset, default 0.' },
    }, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ query = '', names = [], servers = [], offset = 0 }, exec) {
      const pending = pendingMcpServers(agent);
      const requested = pending.filter(server => servers.includes(server) || names.some(name => name.startsWith(`mcp__${server}__`)));
      await waitForMcpServers(agent, requested, exec?.signal);
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const tools = available();
      const scored = tools.map(tool => ({ tool, score: terms.reduce((n, term) => n + (tool.name.toLowerCase().includes(term) ? 3 : 0) + (tool.description?.toLowerCase().includes(term) ? 1 : 0), 0) }));
      const matches = names.length ? tools.filter(tool => names.includes(tool.name))
        : scored.filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).map(item => item.tool);
      const page = matches.slice(offset, offset + 5);
      for (const tool of page) select(tool.name);
      return { pendingServers: pendingMcpServers(agent), serverStatuses: mcpServerStates(agent).filter(server => servers.includes(server.serverName) || names.some(name => name.startsWith(`mcp__${server.serverName}__`))), tools: page.map(project), totalMatches: matches.length, ...(offset + page.length < matches.length ? { nextOffset: offset + page.length } : {}), missingNames: names.filter(name => !tools.some(tool => tool.name === name)),
        ...(!matches.length ? { availableNativeTools: tools.filter(tool => optionalNative.has(tool.name)).map(tool => tool.name),
          guidance: pendingMcpServers(agent).length ? 'Some selected MCP servers are still connecting. Use servers with an exact pending server name to wait, then search. Pending is not missing or disabled.' : 'No match in this session. Choose an available tool; repeating the same search cannot install or enable one.' } : {}) };
    },
  });
  ctx.systemPrompt.section({ name: 'codebuddy:mcp-discovery', order: 99, interpolate: false,
    text: () => {
      const count = available().length;
      const pending = pendingMcpServers(agent);
      return (pending.length ? `Selected MCP servers connecting in the background: ${JSON.stringify(pending)}. Their tools are not missing or disabled. To use one, call search_mcp_tools with servers containing its exact name; this waits for its actual catalog. ` : '') + (count ? `${count} tools are available through search_mcp_tools. Call tools already present in the current tool schemas directly; search only for missing schemas. Native names: ${available().filter(t => optionalNative.has(t.name)).map(t => t.name).join(', ')}. Search other capabilities by keywords; use English names/keywords for discovery.${available().some(t => t.name.startsWith('mcp__qwen_computer__')) ? ' Desktop GUI work: consult the computer-use skill before acting. Use the desktop MCP for input and fresh screenshots for verification. If focus, permission or visual observation fails, report that blocker; do not substitute shell UI scripts or treat shell exit status as delivery evidence.' : ''}` : '');
    },
  });
  ctx.systemPrompt.section({ name: 'codebuddy:desktop-availability', order: 100, interpolate: false,
    text: () => {
      if (!computerSkillLoaded) return '';
      const names = available().filter(t => t.name.startsWith('mcp__qwen_computer__')).map(t => t.name);
      return names.length
        ? `Current desktop tool registry (complete for this chat): ${names.join(', ')}. Entry tool schemas are loaded. Desktop names absent from this registry are unavailable; searching aliases will not add a capability. ${names.includes('mcp__qwen_computer__open_path') ? 'Use open_path for a known local document/folder, then observe its result.' : 'open_path is unavailable in this connection. Use an observed desktop launcher or file manager for navigation; do not search for open_path or substitute shell UI automation. For an exact provided path, navigate there directly in the file manager; do not enumerate its parent first just to confirm existence. Filesystem discovery is useful when the target path is unknown.'} Reuse each action's returned after-state; list_apps is needed only for target discovery or changed/ambiguous window identity.`
        : 'Current desktop tool registry: no computer-control tools are available in this chat. Do not keep searching for desktop tool aliases or launch GUI programs through the confined shell. The user can open Toolbox from this conversation, enable computer control if disabled, then use Add to this conversation and check its connection. The existing conversation supports adding tools while idle; do not claim a new conversation is required. A global enabled switch does not prove this session selected or connected the extension. Filesystem reading can still answer the independent file-listing part.';
    },
  });
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    const tools = assembly.tools.filter(tool => applicable(tool.name) && (!deferred(tool.name) || deliveryTools.has(tool.name) || selected.has(tool.name)));
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
    return { ...assembly, ...(sections ? { sections } : {}), tools: tools.map(project) };
  });
  return ctx.tools.get('search_mcp_tools', agent);
}
