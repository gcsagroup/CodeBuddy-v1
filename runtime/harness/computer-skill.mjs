import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';

export const name = 'codebuddy-computer-skill';
export const inject = ['skills'];

// Use Harness's catalog, invocation, precedence and persistence for this guide.
// Loading instructions does not enable an extension or grant input permission.
export function apply(ctx) {
  const directory = fileURLToPath(new URL('./skills/computer-use/', import.meta.url));
  const candidate = {
    name: 'computer-use',
    description: '电脑控制：操作 Windows/macOS 桌面应用、窗口、鼠标键盘及聊天软件。Desktop computer use: observe apps, interact and verify results. Load before GUI tasks; prefer the desktop MCP over shell UI scripts.',
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory },
  };
  ctx.skills.registerProvider(() => ({
    name,
    list: async () => [candidate],
    async get(entry, options) {
      const { rank: _rank, ...summary } = entry;
      return { ...summary, content: await readFile(new URL('./skills/computer-use/SKILL.md', import.meta.url), { encoding: 'utf8', signal: options.signal }) };
    },
  }));
}
