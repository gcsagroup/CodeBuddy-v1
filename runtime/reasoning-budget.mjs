// Separate the reasoning allowance from the completion allowance. The native
// pi-ai serializer reserves answer room and emits the backend-specific field.
// Both upper effort levels use xhigh's ceiling when the model offers them.
export const REASONING_BUDGETS = Object.freeze({ minimal: 512, low: 2048, medium: 4096, high: 8192, xhigh: 16384 });

export function advertisesThinkingBudget(schema) {
  return Object.hasOwn(schema?.components?.schemas?.ChatCompletionRequest?.properties ?? {}, 'thinking_token_budget');
}
