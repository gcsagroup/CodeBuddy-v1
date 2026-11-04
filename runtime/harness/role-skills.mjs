import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';
import { DEFAULT_AGENT_SKILLS } from '../agent-presets.mjs';

// Register on the main Agent's native scope. The same registry still owns
// discovery, invocation, caching and disposal; children do not gain this mount.
export function installRoleSkills(ctx, current) {
  let invalidate;
  const loads = new Map();
  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate;
    const reader = new FileSystemSkillProvider(ctx, control, { watch: false, includeDefaultRoots: false });
    ctx.effect(() => () => reader.dispose());
    const selected = name => current()?.skills?.includes(name) === true;
    const candidates = DEFAULT_AGENT_SKILLS.map(skill => {
      const path = fileURLToPath(new URL(`./skills/agent-presets/${skill.file}`, import.meta.url));
      return { name: skill.name, description: skill.description, invocation: skill.invocation,
        provider: 'codebuddy-role-skills', source: 'bundled', rank: BUNDLED_SKILL_RANK,
        locator: { path, directory: dirname(path) } };
    });
    return {
      name: 'codebuddy-role-skills',
      list: async () => candidates.filter(candidate => selected(candidate.name)),
      async get(candidate, options) {
        if (!selected(candidate.name)) return undefined;
        const original = DEFAULT_AGENT_SKILLS.find(skill => skill.name === candidate.name);
        // The provider owns this observation, not a second health registry.
        // Preserve retry discovery and ignore a late result from an older read.
        const load = { failed: loads.get(candidate.name)?.failed ?? false };
        loads.set(candidate.name, load);
        try {
          const definition = await reader.get(candidate, options);
          if (!definition || definition.name !== original.upstreamName) throw new Error(`Bundled agent skill is missing or invalid: ${candidate.name}`);
          if (loads.get(candidate.name) === load) load.failed = false;
          // Keep the upstream document intact; the alias avoids replacing an
          // independently installed skill with the same short name.
          return { ...definition, name: candidate.name, provider: 'codebuddy-role-skills' };
        } catch (error) {
          if (!options?.signal?.aborted && error?.name !== 'AbortError' && loads.get(candidate.name) === load) load.failed = true;
          throw error;
        }
      },
    };
  });
  return {
    invalidate: () => invalidate(),
    unavailable: profile => (profile?.skills ?? []).filter(name => loads.get(name)?.failed)
      .map(name => `Skill ${name}（上次加载失败，可重试）`),
  };
}
