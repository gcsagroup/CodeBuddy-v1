import { invalid } from './providers.mjs';

export const SUBAGENT_LIMITS_KEY = 'subagentLimits';
export const DEFAULT_SUBAGENT_LIMITS = Object.freeze({ maxDepth: 1, maxActiveSubagents: 3 });

export function validateSubagentLimits(value, isSecret = false) {
  if (isSecret || !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      Object.keys(value).some(key => !Object.hasOwn(DEFAULT_SUBAGENT_LIMITS, key)) ||
      !Number.isSafeInteger(value.maxDepth) || value.maxDepth < 0 ||
      !Number.isSafeInteger(value.maxActiveSubagents) || value.maxActiveSubagents < 1)
    throw invalid('最大递归深度须为非负整数，子智能体并行数量上限须为正整数。');
  return { maxDepth: value.maxDepth, maxActiveSubagents: value.maxActiveSubagents };
}
