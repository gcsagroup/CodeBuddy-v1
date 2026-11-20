import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';

export const name = 'codebuddy-superpowers-skills';
export const inject = ['skills'];

const descriptions = {
  'systematic-debugging': 'Investigate software bugs, failing tests, and unexpected behavior. Reproduce the symptom and trace its cause before changing code. 排查故障、测试失败和异常行为。',
  'verification-before-completion': 'Before reporting a change finished or a bug fixed, run relevant checks and inspect fresh evidence for each claim. 在交付改动或报告修复前验证实际结果。',
};

export function apply(ctx) {
  const candidates = Object.entries(descriptions).map(([skill, description]) => ({
    name: skill, description, invocation: { modelInvocable: true, userInvocable: true },
    provider: name, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`./skills/superpowers/${skill}/`, import.meta.url)) },
  }));
  ctx.skills.registerProvider(() => ({
    name, list: async () => candidates,
    async get({ rank, ...entry }, options) {
      const file = new URL(`./skills/superpowers/${entry.name}/SKILL.md`, import.meta.url);
      return { ...entry, content: await readFile(file, { encoding: 'utf8', signal: options.signal }) };
    },
  }));
}
