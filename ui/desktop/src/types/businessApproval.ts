export interface BusinessApproval {
  id: 'computer-use' | 'image-generation' | 'video-generation';
  tools?: string[];
  service?: string;
  workspace?: string;
  outputDirectory?: string;
}

export const BUSINESS_SESSION_OPTION = 'allow_business_session';
const computerTools = new Set([
  'click',
  'drag',
  'get_app_state',
  'list_apps',
  'perform_secondary_action',
  'press_key',
  'scroll',
  'set_value',
  'type_text',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;

// An invalid group description must never fall back to a misleading tool-only button.
export function readBusinessApproval(meta: unknown): BusinessApproval | undefined {
  if (!record(meta) || !record(meta.codepro) || meta.codepro.authorizationScope !== 'session')
    return undefined;
  const value = meta.codepro.businessApproval;
  if (!record(value)) return undefined;
  if (value.id === 'computer-use') {
    if (
      !Array.isArray(value.tools) ||
      !value.tools.length ||
      value.tools.length > computerTools.size ||
      value.tools.some((tool) => typeof tool !== 'string' || !computerTools.has(tool)) ||
      new Set(value.tools).size !== value.tools.length
    )
      return undefined;
    return { id: value.id, tools: [...value.tools] as string[] };
  }
  if (value.id !== 'image-generation' && value.id !== 'video-generation') return undefined;
  if (!text(value.service) || !text(value.workspace) || !text(value.outputDirectory))
    return undefined;
  try {
    const url = new URL(value.service);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
  } catch {
    return undefined;
  }
  return {
    id: value.id,
    service: value.service,
    workspace: value.workspace,
    outputDirectory: value.outputDirectory,
  };
}
