export const codeproInstructions = `Use the official Harness agent loop and tools. Answer ordinary conversation directly. For complex or long-running work, use the native goal, todo and subagent tools as appropriate. Keep the goal active while useful work remains, preserve completed work across continuation, and verify changes with actual tools before reporting success. Distinguish a completed response from a completed project objective. After an interruption, inspect the persisted conversation and current workspace before continuing; never blindly replay an uncertain external action.`;

// Kept only to replay and test the older preview contract. New sessions use
// native Harness goal/todo tools; this is not injected into their tool surface.
export function codeproTools(compat, sessionId) {
  return [{
    name: 'codebuddy_task',
    description: 'Inspect and update this task durable plan. Host validates evidence and completion. Read inspect after tool execution for evidence IDs.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['inspect', 'answer', 'submit_plan', 'start_task', 'task_result', 'propose_finish', 'report_blocked'] },
      expectedPlanRevision: { type: 'integer' },
      tasks: { type: 'array', items: { type: 'object', properties: { taskId: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['implementation', 'verification', 'analysis'] }, dependsOn: { type: 'array', items: { type: 'string' } } }, required: ['taskId', 'name', 'kind'] } },
      taskId: { type: 'string' }, outcome: { type: 'string', enum: ['succeeded', 'failed'] },
      answer: { type: 'string' }, summary: { type: 'string' }, evidenceIds: { type: 'array', description: 'Use receipts[].eventId returned by inspect, never effectId or tool call ID.', items: { type: 'string' } },
      kind: { type: 'string', enum: ['user', 'environment'] }, reason: { type: 'string' },
    }, required: ['action'], additionalProperties: false },
    async execute(args, execution = {}) {
      const active = compat.active.get(sessionId);
      if (!active?.run) throw Error('No active CodePro run');
      const binding = { sessionId, runId: active.run.runId, attemptId: active.attemptId };
      if (compat.runs.context(binding).executionOwner === 'harness') throw Error('This session uses native Harness goal and todo tools');
      const methods = { answer: 'proposeAnswer', submit_plan: 'submitPlan', start_task: 'startTask', task_result: 'proposeTaskResult', propose_finish: 'proposeFinish', report_blocked: 'reportBlocked' };
      const operation = async () => {
        if (args.action !== 'inspect') {
          const method = methods[args.action]; if (!method) throw Error('Unknown CodePro task action');
          await compat.runs[method]({ ...args, ...binding });
        }
      };
      if (active.roles) await active.roles.taskAction(execution.sessionId ?? sessionId, args, operation);
      else {
        await operation();
        active.taskIds ??= new Map();
        const actor = execution.sessionId ?? sessionId;
        if (args.action === 'start_task') active.taskIds.set(actor, args.taskId);
        if (args.action === 'task_result') active.taskIds.delete(actor);
      }
      return compat.runs.context(binding);
    },
  }];
}
