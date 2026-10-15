import { apply as applyOfficialInstructions, inject } from '@deepseek-ai/dsh-agent-instructions';

export { inject };
export const name = 'codebuddy-agent-instructions';

// This fixed upstream version captures its homes synchronously in apply() and
// ignores home fields in row config. Bind only that capture to this embedding;
// discovery, precedence, budgets and durable updates stay upstream-owned.
export function apply(ctx, { instructionsHome, agentsHome, ...config }) {
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
  try {
    process.env.DSH_HOME = instructionsHome;
    process.env.DSH_AGENTS_HOME = agentsHome;
    return applyOfficialInstructions(ctx, config);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
