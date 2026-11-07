import { describe, expect, it } from 'vitest';
import {
  sessionListTypes,
  sessionTypeMatchesWorkspace,
} from './sessions';

describe('ACP session workspace filters', () => {
  it('keeps the legacy Code filter for existing callers', () => {
    expect(sessionListTypes('code')).toEqual(['user', 'scheduled']);
  });

  it('keeps the legacy CodePro-only filter for existing callers', () => {
    expect(sessionListTypes('codepro')).toEqual(['code_pro']);
  });

  it('includes every readable desktop history type in unified mode', () => {
    expect(sessionListTypes('unified')).toEqual(['user', 'scheduled', 'code_pro']);
  });

  it('accepts all user-visible creation notifications only in unified mode', () => {
    for (const sessionType of ['user', 'scheduled', 'code_pro']) {
      expect(sessionTypeMatchesWorkspace(sessionType, 'unified')).toBe(true);
    }
    expect(sessionTypeMatchesWorkspace('sub_agent', 'unified')).toBe(false);
    expect(sessionTypeMatchesWorkspace(undefined, 'unified')).toBe(false);
    expect(sessionTypeMatchesWorkspace('user', 'codepro')).toBe(false);
    expect(sessionTypeMatchesWorkspace('code_pro', 'codepro')).toBe(true);
  });
});
