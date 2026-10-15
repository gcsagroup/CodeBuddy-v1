import { describe, expect, it } from 'vitest';
import { getProtocol, isProtocolSafe } from './urlSecurity';

describe('CodeBuddy URL protocol security', () => {
  it('trusts the primary CodeBuddy deep-link protocol', () => {
    expect(isProtocolSafe('codebuddy://recipe?config=test')).toBe(true);
    expect(getProtocol('codebuddy://recipe?config=test')).toBe('codebuddy:');
  });

  it('keeps the legacy Goose deep-link protocol safe for compatible imports', () => {
    expect(isProtocolSafe('goose://recipe?config=legacy')).toBe(true);
  });

  it('does not trust blocked or malformed URLs', () => {
    expect(isProtocolSafe('javascript:alert(1)')).toBe(false);
    expect(isProtocolSafe('not a url')).toBe(false);
  });
});
