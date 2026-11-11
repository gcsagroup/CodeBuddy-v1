// Separate the reasoning allowance from the completion allowance. The native
// pi-ai serializer reserves answer room and emits the backend-specific field.
// xhigh/max map to high in the pinned native adapter; none means no budget.
export const REASONING_BUDGETS = Object.freeze({ minimal: 256, low: 1024, medium: 2048, high: 8192 });

export function advertisesThinkingBudget(schema) {
  return Object.hasOwn(schema?.components?.schemas?.ChatCompletionRequest?.properties ?? {}, 'thinking_token_budget');
}
