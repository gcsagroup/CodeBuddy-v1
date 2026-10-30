import { defineTool } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';
import { TYPERT } from '@deepseek-ai/dsh-schedule/typert';

export const SCHEDULE_CONTROL_TOOLS = ['schedule_status', 'schedule_pause', 'schedule_resume'];
const update = TYPERT.invocations.find(item => item.method === 'update');
const taskInstructionGuidance = [
  'Based on the user request, generate the prompt as a concise, self-contained task instruction in the user’s language. It is the instruction executed on each scheduled run and displayed as the task description, not a copy of the request or a prewritten answer.',
  'Preserve the requested action, subject, relevant context, and output requirements. Do not invent additional requirements. Put recurrence in the timing fields, not in an instruction to create another schedule.',
  'For example, “每分钟说一句你好” becomes every_seconds: 60 and prompt: “说一句‘你好’。”; “每分钟说哈哈” becomes every_seconds: 60 and prompt: “说一句‘哈哈’。” The scheduled run should perform the action, not repeat the task description.',
  'When only changing timing, preserve the existing task instruction. When the user changes the task itself, update the instruction to match that request.',
].join(' ');

export function parseSchedulePauseRequest(input) {
  if (typeof input?.paused !== 'boolean' || !['active', 'paused', 'inactive'].includes(input.expectedStatus))
    throw new TypeError('A boolean paused and an observed expectedStatus are required.');
  const parsed = update.parameters[0].codec.create().parse(input);
  if (!parsed.id.trim() || !parsed.sessionId.trim() || parsed.expected.id !== parsed.id)
    throw new TypeError('A matching task id and original chat id are required.');
  return { id: parsed.id, sessionId: parsed.sessionId, expected: parsed.expected,
    paused: input.paused, expectedStatus: input.expectedStatus };
}

export function installScheduleControls(ctx) {
  ctx.systemPrompt.section({ name: 'codebuddy:schedule-controls', order: 105, interpolate: false,
    text: 'For automatic tasks, stopping future execution and deleting the task are different actions. When the user wants a reminder to stop, pause it with schedule_pause and preserve its rule and history so it can be resumed. Use schedule_delete only for an explicit request to remove the task record itself. Do not interpret a general stop request as permission to erase a task. Use schedule_status to inspect paused tasks; ask only when the target task is genuinely ambiguous.',
  });
  // Project model-facing guidance without replacing the native tool definition,
  // identity, permission checks or deletion implementation.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    return { ...assembly, tools: assembly.tools.map(tool => tool.name === 'schedule_delete'
      ? { ...tool, description: 'Permanently remove a reminder task record from this chat. It will disappear from the task list and cannot be resumed. Use only when the user explicitly asks to delete/remove the task record. To stop or cancel future reminders while keeping the task, use schedule_pause instead. Already queued work is not retracted.' }
      : tool.name === 'schedule_list'
        ? { ...tool, description: 'List active reminders in this chat. Use schedule_status to include paused and ended tasks, especially before resuming.' }
        : tool.name === 'schedule_create' || tool.name === 'schedule_update'
          ? { ...tool, description: `${tool.description ?? ''}\n${taskInstructionGuidance}` }
          : tool) };
  });
  for (const name of SCHEDULE_CONTROL_TOOLS) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name,
      description: name === 'schedule_status'
        ? 'List this chat’s reminders, including paused and ended tasks. Use before pause or resume to find the exact task id.'
        : name === 'schedule_pause'
          ? 'Stop future executions of this chat’s reminder while keeping its rule and history for resuming. Use for pause/stop/cancel-reminders requests unless the user explicitly wants the task record deleted. Already delivered/running work continues.'
          : 'Resume this chat’s paused reminder on its original cadence. Missed occurrences are skipped; an expired one-shot ends without delivery. Results remain in this chat.',
      parameters: name === 'schedule_status' ? {} : { id: { type: 'string', required: true, description: 'Exact task id from schedule_status.' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        if (!exec.agent || delegationDepthOf(exec.agent) > 0)
          return { code: 'subagent_session', message: 'Reminder control belongs to the original root chat.' };
        exec.signal.throwIfAborted();
        const records = (await ctx.schedule.catalog()).filter(row => row.sessionId === exec.agent.session.id);
        if (name === 'schedule_status') return records;
        const entry = records.find(row => row.id === args.id);
        if (!entry) return { id: args.id, changed: false, code: 'schedule_not_found' };
        const { sessionId, status, lastDelivery: _delivery, ...expected } = entry;
        return ctx.schedule.setPaused(parseSchedulePauseRequest({ id: args.id, sessionId, expected,
          expectedStatus: status, paused: name === 'schedule_pause' }), exec.signal);
      },
      presentCall: args => ({ card: 'generic', title: name === 'schedule_status' ? 'Reminder status' : name === 'schedule_pause' ? 'Pause reminder' : 'Resume reminder', kind: name === 'schedule_status' ? 'read' : 'other', rawInput: args }),
    })), `codebuddy:${name}`);
  }
}
