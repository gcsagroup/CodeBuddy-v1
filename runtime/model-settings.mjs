import { invalid } from './providers.mjs';

export const THINKING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function modelThinkingPreference(profile, saved, legacy) {
  // A service can change capabilities after a preference was saved. Preserve
  // the stored choice but do not send a level the current model rejects.
  const savedLevel = saved === 'none' ? 'off' : saved;
  if (typeof saved === 'string' && (!Object.hasOwn(profile, 'reasoningEfforts') ||
    profile.reasoningEfforts && Object.hasOwn(profile.reasoningEfforts, savedLevel))) return saved;
  // Legacy global preferences remain a fallback only for a declared capability.
  const level = legacy === 'none' ? 'off' : legacy;
  if (profile.reasoningEfforts && Object.hasOwn(profile.reasoningEfforts, level)) return legacy;
  return profile.reasoningEfforts && Object.hasOwn(profile.reasoningEfforts, profile.thinkingDefault)
    ? profile.thinkingDefault : undefined;
}

export function modelThinkingOptions(profile, saved, legacy) {
  const levels = profile.reasoningEfforts;
  if (!levels) return { options: [], value: null, toggle: false };
  const selected = applyModelThinking(profile, modelThinkingPreference(profile, saved, legacy));
  const value = selected.thinkingEffort === 'off' ? 'none' : selected.thinkingEffort ?? null;
  return {
    options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => Object.hasOwn(levels, level) && (!profile.thinkingToggle || ['off', 'medium'].includes(level))).map(level => level === 'off' ? 'none' : level),
    value: profile.thinkingToggle && value !== 'none' && value !== null ? 'medium' : value,
    toggle: profile.thinkingToggle === true,
  };
}

// This creates a request-scoped compatibility override, not discovered model
// capability metadata. Unknown models remain unknown until a user picks an
// effort. The endpoint still decides whether that requested control is valid.
export function applyModelThinking(provider, requestedEffort) {
  const configured = structuredClone(provider);
  if (requestedEffort == null) {
    // Only an established model profile can supply an enabled default. An
    // unknown endpoint must not receive an invented reasoning protocol.
    const efforts = provider.reasoningEfforts;
    const thinkingEffort = efforts && (provider.thinkingDefault && Object.hasOwn(efforts, provider.thinkingDefault)
      ? provider.thinkingDefault : ['medium', 'low', 'high', 'minimal', 'xhigh', 'max'].find(level => Object.hasOwn(efforts, level)));
    return thinkingEffort
      ? { provider: configured, thinkingEffort, source: 'model_default' }
      : { provider: configured, source: 'provider_default' };
  }
  if (!THINKING_EFFORTS.includes(requestedEffort)) throw invalid('Unknown reasoning effort');
  const protocol = provider.protocol ?? 'openai-completions';
  if (!['openai-completions', 'openai-responses'].includes(protocol)) throw invalid('Thinking controls require a configured protocol adapter');
  if (provider.reasoningEfforts === false) throw invalid('The configured model explicitly disables reasoning controls');
  const templateThinking = protocol === 'openai-completions' && provider.compat?.thinkingFormat === 'chat-template';
  if (protocol === 'openai-completions' && !templateThinking && (provider.compat?.supportsReasoningEffort === false || provider.compat?.thinkingFormat && provider.compat.thinkingFormat !== 'openai')) throw invalid('The configured provider uses a different thinking control protocol');

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
  if (protocol === 'openai-completions' && !templateThinking) configured.compat = {
    ...provider.compat,
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
    // pi-ai defaults reasoning models to developer-role instructions. An effort
    // preference alone does not establish that capability on a custom endpoint.
    supportsDeveloperRole: provider.compat?.supportsDeveloperRole ?? false,
  };
  return { provider: configured, thinkingEffort, requestedEffort, source: 'user_preference', verified: false };
}
