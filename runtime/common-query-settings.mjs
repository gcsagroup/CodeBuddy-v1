import { invalid } from './providers.mjs';

export const COMMON_QUERY_KEY = 'CODEBUDDY_COMMON_QUERIES';
const defaults = { network_enabled: true, default_city: '', country_code: '', timezone: '', units: 'metric' };

export function validateQuerySettings(value, isSecret = false) {
  const fail = () => { throw invalid('Invalid common query settings'); };
  if (isSecret || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) fail();
  const result = { ...defaults, ...value };
  if (typeof result.network_enabled !== 'boolean' || typeof result.default_city !== 'string' || [...result.default_city].length > 120 || typeof result.country_code !== 'string' || (result.country_code && !/^[A-Za-z]{2}$/.test(result.country_code)) || typeof result.timezone !== 'string' || !['metric', 'imperial'].includes(result.units)) fail();
  if (result.timezone) {
    try { result.timezone = new Intl.DateTimeFormat('en', { timeZone: result.timezone }).resolvedOptions().timeZone; } catch { fail(); }
    // Intl also accepts numeric offsets; the query tool requires an IANA zone.
    if (/^[+-]/.test(result.timezone)) fail();
  }
  return result;
}

// Read the committed owner on every invocation. Host metadata stays outside
// model-controlled tool arguments; no second settings copy exists.
export function commonQueryMetadata(store) {
  const entry = store.read(['config']).config?.[COMMON_QUERY_KEY];
  return { 'codebuddy/common-query-settings': entry ? validateQuerySettings(entry.value, Boolean(entry.secret)) : { ...defaults } };
}
