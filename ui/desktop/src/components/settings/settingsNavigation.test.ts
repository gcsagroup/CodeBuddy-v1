import { describe, expect, it } from 'vitest';
import {
  matchesSettingsQuery,
  resolveSettingsPage,
  settingsNavigationItems,
} from './settingsNavigation';

describe('settings navigation', () => {
  it('keeps every legacy settings destination reachable', () => {
    expect(resolveSettingsPage('update')).toBe('app');
    expect(resolveSettingsPage('models')).toBe('models');
    expect(resolveSettingsPage('local-inference')).toBe('models');
    expect(resolveSettingsPage('modes')).toBe('chat');
    expect(resolveSettingsPage('styles')).toBe('chat');
    expect(resolveSettingsPage('tools')).toBe('chat');
    expect(resolveSettingsPage('sharing')).toBe('sharing');
    expect(resolveSettingsPage('prompts')).toBe('chat');
    expect(resolveSettingsPage('keyboard')).toBe('keyboard');
    expect(resolveSettingsPage('auth')).toBe('auth');
    expect(resolveSettingsPage('memory')).toBe('memory');
    expect(resolveSettingsPage('app')).toBe('app');
    expect(resolveSettingsPage('advanced')).toBe('chat');
  });

  it('includes every existing top-level settings page exactly once', () => {
    expect(settingsNavigationItems.map((item) => item.id).sort()).toEqual(
      ['app', 'auth', 'chat', 'input', 'keyboard', 'memory', 'models', 'security', 'sharing'].sort()
    );
  });

  it('does not expose internal system prompt templates in ordinary settings', () => {
    expect(settingsNavigationItems.map((item) => String(item.id))).not.toContain('prompts');
    expect(
      settingsNavigationItems.some((item) => matchesSettingsQuery(item, 'system prompt'))
    ).toBe(false);
  });

  it('moves legacy search language to the setting that owns the effect', () => {
    const pageFor = (query: string) =>
      settingsNavigationItems.find((item) => matchesSettingsQuery(item, query))?.id;
    expect(pageFor('dictation')).toBe('input');
    expect(pageFor('prompt injection')).toBe('security');
    expect(pageFor('maximum turns')).toBeUndefined();
    expect(pageFor('response style')).toBe('chat');
  });

  it('finds model settings through local deployment language', () => {
    const models = settingsNavigationItems.find((item) => item.id === 'models');
    expect(models).toBeDefined();
    expect(matchesSettingsQuery(models!, 'local inference')).toBe(true);
    expect(matchesSettingsQuery(models!, 'endpoint')).toBe(true);
    expect(matchesSettingsQuery(models!, 'memory')).toBe(false);
    expect(matchesSettingsQuery(models!, '本地部署')).toBe(true);
  });

  it('finds global AGENTS.md instructions with Chinese user language', () => {
    const chat = settingsNavigationItems.find((item) => item.id === 'chat');
    expect(chat).toBeDefined();
    expect(matchesSettingsQuery(chat!, 'AGENTS.md')).toBe(true);
    expect(matchesSettingsQuery(chat!, '全局规则')).toBe(true);
    expect(matchesSettingsQuery(chat!, '全域規則')).toBe(true);
    expect(matchesSettingsQuery(chat!, '项目说明')).toBe(false);
  });

  it('shows all items for an empty search', () => {
    expect(settingsNavigationItems.every((item) => matchesSettingsQuery(item, '  '))).toBe(true);
  });
});
