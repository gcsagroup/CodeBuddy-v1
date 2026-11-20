import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';

export const name = 'codebuddy-modern-web-guidance-skill';
export const inject = ['skills'];

export function apply(ctx) {
  const candidate = {
    name: 'modern-web-guidance',
    description: 'Modern Web development guidance for creating, updating and reviewing browser interfaces: HTML, CSS, forms, accessibility, interaction and performance. 现代 Web 开发与审查离线指南。',
    invocation: { modelInvocable: true, userInvocable: true }, provider: name, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('./skills/modern-web-guidance/', import.meta.url)) },
  };
  ctx.skills.registerProvider(() => ({
    name, list: async () => [candidate],
    async get(entry, options) {
      const { rank: _rank, ...summary } = entry;
      return { ...summary, content: await readFile(new URL('./skills/modern-web-guidance/SKILL.md', import.meta.url), { encoding: 'utf8', signal: options.signal }) };
    },
  }));
}
