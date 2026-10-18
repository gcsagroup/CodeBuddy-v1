import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const templates = {
  explorer: 'You are explorer, a reusable workspace exploration specialist. Read and search files, trace code and explain findings. Do not edit files or run commands. Keep this responsibility across tasks; a different file, module or date is a new task, not a new role.',
  browser: 'You are browser, a reusable web and browser research specialist. Use the available web/browser tools to investigate sources and interact with pages as requested. Report sources, observations and limitations. Keep this responsibility across topics and dates. Browser resources may be shared; do not assume a private browser profile.',
};
const explorerTools = ['read', 'read_image', 'glob', 'grep', 'working_directory', 'skill', 'send_message', 'list_agents'];

export const SUBAGENT_TEMPLATE_TOOLS = ['subagent_explorer', 'subagent_browser'];

/** Translate template/role choices to DSH's native continuable activation API.
 * DSH still owns admission, parent ownership, history, cancellation and resume.
 */
export function installSubagentTemplates(ctx, base, { models = {}, generic = true, allow, deny = [] } = {}) {
  const definitions = [];
  for (const role of [...Object.keys(templates), ...(generic ? ['generic'] : [])]) {
    const name = role === 'generic' ? 'subagent' : `subagent_${role}`;
    if ((allow && !allow.includes(name)) || deny.includes(name)) continue;
    const definition = {
      ...base,
      name,
      description: role === 'generic'
        ? `${base.description} Set role to a stable responsibility (for example code reviewer), not the current file or month. Reuse the returned id with send_message for later tasks in that responsibility within this chat.`
        : `Start a chat-local, continuable ${role} from the default template. ${templates[role]} Reuse its id with send_message for later tasks. This creates a new instance; prefer an existing matching child.`,
      parameters: role === 'generic' ? {
        ...base.parameters,
        properties: { ...base.parameters.properties, role: { type: 'string', minLength: 1, maxLength: 1000, description: 'Stable responsibility for this chat, separate from the task in prompt. Omit only for compatibility with an unnamed general worker.' } },
      } : base.parameters,
      async execute(args, exec) {
        const issues = validateJsonSchemaValue(definition.parameters, args);
        if (issues.length) throw new TypeError(`Invalid tool arguments: ${issues.join('; ')}`);
        const parent = exec.agent;
        if (!parent) throw new Error('Subagent delegation requires the calling agent');
        const selected = models[role];
        if (selected?.error) throw new Error(selected.error);
        // Use the same public route preflight as DSH's delegation tool. Route
        // changes select the adapter default effort; inheritance stays native.
        if (selected) await ctx.get('llm').resolveCallConfig(selected, exec.signal);
        exec.signal.throwIfAborted();
        const responsibility = args.role?.trim();
        if (args.role !== undefined && !responsibility) throw new Error('role must be nonempty');
        // Persona sections are interpolated by DSH. Encode literal braces in
        // the JSON string so a role containing {{...}} cannot become a variable.
        const persona = role === 'generic' && responsibility
          ? 'You are a reusable specialist for this conversation. Keep the following responsibility across tasks; do not change it merely because a file, module or date changes. Responsibility (JSON string):\n' + JSON.stringify(responsibility).replaceAll('{', '\\u007b').replaceAll('}', '\\u007d')
          : templates[role];
        const subagents = ctx.get('subagents');
        const maxDepth = subagents.resolveMaxDepth();
        const request = {
          parent,
          prompt: [{ type: 'text', text: args.prompt }],
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(selected ? { agentOptions: selected } : {}),
          ...(persona ? { persona: persona + '\nComplete only the current delegated request. Do not invent the next assignment. Report the findings once, then finish this turn and await a new parent message. Finishing a task leaves this conversation reusable.' } : {}),
          ...(role === 'explorer' ? { toolFilter: { allow: explorerTools } } : {}),
          ...(maxDepth === undefined ? {} : { maxDepth }),
        };
        const activation = await subagents.startActivation({
          provider: 'spawn', label: role === 'generic' ? responsibility ?? args.description : role,
          request, signal: exec.signal, delivery: 'parent',
        });
        return { kind: 'activation', subagentId: activation.childId };
      },
    };
    ctx.tools.register(definition);
    definitions.push(definition);
  }
  if (generic) ctx.systemPrompt.section({
    name: 'codebuddy:subagent-reuse', order: 101, interpolate: false,
    text: 'Default templates: subagent_explorer for read-only workspace exploration; subagent_browser for web/browser work. Other responsibilities use subagent with a stable role. These tools create chat-local children with independent conversation histories, not a copy of your transcript; provide the context they need. Before creating a child, reuse a matching child id from this chat using send_message (list_agents if needed). Changing a date, file or frontend/backend target usually keeps the same responsibility. Create only as many independent workers as the current work needs; the concurrency limit is a ceiling, not a target. Never reuse a child from another chat. A child keeps its creation-time model; settings changes apply to newly created children. Native notifications deliver results; do not repeatedly poll list_agents. Retain useful child ids for later turns. A task completion notice does not close or delete a continuable child. Avoid repeating a full result when the settlement notice adds no new findings.',
  });
  return definitions;
}
