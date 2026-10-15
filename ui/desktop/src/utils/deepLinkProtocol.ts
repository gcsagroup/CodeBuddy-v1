import distro from '../../codebuddy.distro.json';

export const PRIMARY_DEEP_LINK_SCHEME = distro.protocol;
export const PRIMARY_DEEP_LINK_PREFIX = `${PRIMARY_DEEP_LINK_SCHEME}://`;
export const LEGACY_DEEP_LINK_PREFIX = 'goose://';
const LEGACY_PRODUCT_DEEP_LINK_PREFIX = 'codeagentpro://';
export const PRIMARY_RECIPE_DEEP_LINK_PREFIX = `${PRIMARY_DEEP_LINK_PREFIX}recipe?config=`;
export const SUPPORTED_RECIPE_DEEP_LINK_PREFIXES = [
  PRIMARY_RECIPE_DEEP_LINK_PREFIX,
  `${LEGACY_DEEP_LINK_PREFIX}recipe?config=`,
  `${LEGACY_PRODUCT_DEEP_LINK_PREFIX}recipe?config=`,
] as const;

export function hasSupportedDeepLinkPrefix(value: string): boolean {
  return [PRIMARY_DEEP_LINK_PREFIX, LEGACY_DEEP_LINK_PREFIX, LEGACY_PRODUCT_DEEP_LINK_PREFIX].some(
    (prefix) => value.startsWith(prefix)
  );
}

export function toPrimaryDeepLink(value: string): string {
  const legacy = [LEGACY_DEEP_LINK_PREFIX, LEGACY_PRODUCT_DEEP_LINK_PREFIX].find((prefix) =>
    value.startsWith(prefix)
  );
  return legacy ? `${PRIMARY_DEEP_LINK_PREFIX}${value.slice(legacy.length)}` : value;
}

export function isSupportedSessionShareDeepLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      hasSupportedProtocol(url.protocol) && url.hostname === 'sessions' && url.pathname === '/nostr'
    );
  } catch {
    return false;
  }
}

export function hasSupportedProtocol(protocol: string): boolean {
  return [PRIMARY_DEEP_LINK_SCHEME, 'goose', 'codeagentpro'].some(
    (scheme) => protocol === `${scheme}:`
  );
}

export function isSupportedRecipeDeepLink(value: string): boolean {
  const cleanLink = value.trim();
  return SUPPORTED_RECIPE_DEEP_LINK_PREFIXES.some((prefix) => cleanLink.startsWith(prefix));
}

export function getRecipeConfigFromDeepLink(value: string): string | null {
  const cleanLink = value.trim();
  const prefix = SUPPORTED_RECIPE_DEEP_LINK_PREFIXES.find((candidate) =>
    cleanLink.startsWith(candidate)
  );
  return prefix ? cleanLink.slice(prefix.length) : null;
}
