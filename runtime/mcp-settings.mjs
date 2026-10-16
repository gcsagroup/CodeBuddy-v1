import { invalid } from './providers.mjs';

export const DEFAULT_MCP_TIMEOUT_MS = 300_000;

export function mcpToolCallTimeoutMs(extension) {
  const seconds = extension.timeout ?? DEFAULT_MCP_TIMEOUT_MS / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw invalid('MCP timeout must be greater than 0 and at most 3600 seconds');
  return seconds * 1000;
}
