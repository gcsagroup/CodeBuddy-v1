import { Recipe } from '../recipe';
import type { Message } from './message';

export type RequestBudget = {
  model: string;
  source: 'vllm-tokenizer' | 'pi-ai-estimate-context-tokens';
  input: number;
  output: number;
  window: number;
};

export type TokenState = {
  liveSpeed?: { rate: number | null; estimated: boolean } | null;
  lastSampledSpeed?: { rate: number; estimated: boolean };
  sessionStats?: { decodeTokens: number; decodeMs: number };
  requestBudget?: RequestBudget;
  contextLimit?: number;
  pressureThreshold?: number;
  contextUsageSource?: 'provider_actual' | 'local_estimate' | 'streaming_estimate';
  contextCapacitySource?: 'service' | 'catalog' | 'configured' | 'fallback';
  contextUsageKnown?: boolean;
  accumulatedCacheReadTokens?: number;
  accumulatedCacheWriteTokens?: number;
  accumulatedCost?: number | null;
  accumulatedInputTokens: number;
  accumulatedOutputTokens: number;
  accumulatedTotalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export interface ChatType {
  sessionId: string;
  name: string;
  messages: Message[];
  recipe?: Recipe | null; // Add recipe configuration to chat state
  resolvedRecipe?: Recipe | null; // Add resolved recipe with parameter values rendered to chat state
  recipeParameterValues?: Record<string, string> | null; // Add recipe parameters to chat state
}
