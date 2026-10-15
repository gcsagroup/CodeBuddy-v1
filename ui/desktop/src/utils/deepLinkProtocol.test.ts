import { describe, expect, it } from 'vitest';
import {
  getRecipeConfigFromDeepLink,
  hasSupportedDeepLinkPrefix,
  hasSupportedProtocol,
  isSupportedRecipeDeepLink,
  isSupportedSessionShareDeepLink,
  toPrimaryDeepLink,
} from './deepLinkProtocol';

describe('CodeBuddy deep-link protocol', () => {
  it('reads old product links and emits new product links', () => {
    expect(getRecipeConfigFromDeepLink('codeagentpro://recipe?config=legacy')).toBe('legacy');
    expect(isSupportedSessionShareDeepLink('codeagentpro://sessions/nostr?nevent=1')).toBe(true);
    expect(toPrimaryDeepLink('codeagentpro://sessions/nostr?nevent=1')).toBe(
      'codebuddy://sessions/nostr?nevent=1'
    );
    expect(hasSupportedProtocol('codeagentpro-evil:')).toBe(false);
  });
  it('uses codebuddy links as the primary format', () => {
    expect(hasSupportedDeepLinkPrefix('codebuddy://recipe?config=test')).toBe(true);
    expect(hasSupportedProtocol('codebuddy:')).toBe(true);
    expect(isSupportedRecipeDeepLink('codebuddy://recipe?config=test')).toBe(true);
    expect(getRecipeConfigFromDeepLink('codebuddy://recipe?config=test')).toBe('test');
  });

  it('accepts and upgrades legacy Goose links', () => {
    expect(hasSupportedProtocol('goose:')).toBe(true);
    expect(getRecipeConfigFromDeepLink('goose://recipe?config=legacy')).toBe('legacy');
    expect(toPrimaryDeepLink('goose://sessions/nostr?nevent=1')).toBe(
      'codebuddy://sessions/nostr?nevent=1'
    );
  });

  it('rejects unrelated protocols and malformed share links', () => {
    expect(hasSupportedDeepLinkPrefix('https://example.com')).toBe(false);
    expect(hasSupportedProtocol('https:')).toBe(false);
    expect(isSupportedRecipeDeepLink('codebuddy://extension?name=test')).toBe(false);
    expect(isSupportedSessionShareDeepLink('codebuddy://sessions/nostr?nevent=1')).toBe(true);
    expect(isSupportedSessionShareDeepLink('goose://sessions/nostr?nevent=1')).toBe(true);
    expect(isSupportedSessionShareDeepLink('codebuddy://sessions/nostr-evil')).toBe(false);
    expect(isSupportedSessionShareDeepLink('codebuddy://recipe?config=test')).toBe(false);
  });
});
