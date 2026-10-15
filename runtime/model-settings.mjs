import { invalid } from './providers.mjs';

export const THINKING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

// This creates a request-scoped compatibility override, not discovered model
// capability metadata. Unknown models remain unknown until a user picks an
// effort. The endpoint still decides whether that requested control is valid.
export function applyModelThinking(provider, requestedEffort) {
  const configured = structuredClone(provider);
  if (requestedEffort == null) return { provider: configured, source: 'provider_default' };
  if (!THINKING_EFFORTS.includes(requestedEffort)) throw invalid('Unknown reasoning effort');
  const protocol = provider.protocol ?? 'openai-completions';
  if (!['openai-completions', 'openai-responses'].includes(protocol)) throw invalid('Thinking controls require a configured protocol adapter');
  if (provider.reasoningEfforts === false) throw invalid('The configured model explicitly disables reasoning controls');
  if (protocol === 'openai-completions' && (provider.compat?.supportsReasoningEffort === false || provider.compat?.thinkingFormat && provider.compat.thinkingFormat !== 'openai')) throw invalid('The configured provider uses a different thinking control protocol');

  let thinkingEffort = requestedEffort === 'none' ? 'off' : requestedEffort;
  if (provider.reasoningEfforts != null) {
    if (!Object.hasOwn(provider.reasoningEfforts, thinkingEffort)) throw invalid('Selected reasoning effort is absent from the configured model profile');
  } else {
    // The official pi-ai profile rejects an off-only capability and has no
    // `none` level. Its minimal transport slot may map to any wire value. Using
    // that one slot sends exactly `none` without advertising extra high levels.
    thinkingEffort = requestedEffort === 'none' ? 'minimal' : requestedEffort;
    configured.reasoningEfforts = { [thinkingEffort]: requestedEffort };
  }
  if (protocol === 'openai-completions') configured.compat = {
    ...provider.compat,
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
    // pi-ai defaults reasoning models to developer-role instructions. An effort
    // preference alone does not establish that capability on a custom endpoint.
    supportsDeveloperRole: provider.compat?.supportsDeveloperRole ?? false,
  };
  return { provider: configured, thinkingEffort, requestedEffort, source: 'user_preference', verified: false };
}
