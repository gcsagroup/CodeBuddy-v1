import { apply as applyOfficialInstructions, inject } from '@deepseek-ai/dsh-agent-instructions';
import { abortable } from './abortable.mjs';

export { inject };
export const name = 'codebuddy-agent-instructions';

// macOS may leave open(2) pending while the desktop waits for a privacy decision.
// Start the budget only when DSH's other pre-step hooks have returned. An
// unread instruction must fail this step before the model can issue tools.
export function boundedInstructionStep(hook, timeoutMs = 45000) {
  return async (step, next) => {
    step.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([step.signal, controller.signal]);
    let timer;
    try {
      const result = hook({ ...step, signal }, async () => {
        const decision = await next();
        signal.throwIfAborted();
        timer = setTimeout(() => controller.abort(new Error(
          '读取项目指令超时。请检查 CodeBuddy 对工作区及其上级目录中 AGENTS.md 的读取权限。'
        )), timeoutMs);
        return decision;
      });
      return await abortable(result, signal);
    } finally { clearTimeout(timer); }
  };
}

// This fixed upstream version captures its homes synchronously in apply() and
// ignores home fields in row config. Bind only that capture to this embedding;
// discovery, precedence, budgets and durable updates stay upstream-owned.
export function apply(ctx, { instructionsHome, agentsHome, ...config }) {
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
  try {
    process.env.DSH_HOME = instructionsHome;
    process.env.DSH_AGENTS_HOME = agentsHome;
    if (process.platform !== 'darwin') return applyOfficialInstructions(ctx, config);
    const instructions = Object.create(ctx);
    Object.defineProperty(instructions, 'on', { value: (event, hook) =>
      ctx.on(event, event === 'agent/pre-step' ? boundedInstructionStep(hook) : hook) });
    return applyOfficialInstructions(instructions, config);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
