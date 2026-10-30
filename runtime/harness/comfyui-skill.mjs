import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';

export const name = 'codebuddy-comfyui-skill';
export const inject = ['skills'];

export function apply(ctx) {
  const candidate = {
    name: 'comfyui',
    description: 'ComfyUI 生图、图片编辑、MiniMax H3 文生视频／图生视频／参考生视频：选择已保存工作流，调整时长、采样与 Turbo 参数，等待并交付产物。ComfyUI image/video workflow selection, tuning and job waiting.',
    invocation: { modelInvocable: true, userInvocable: true }, provider: name, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('./skills/comfyui/', import.meta.url)) },
  };
  ctx.skills.registerProvider(() => ({
    name, list: async () => [candidate],
    async get(entry, options) {
      const { rank: _rank, ...summary } = entry;
      return { ...summary, content: await readFile(new URL('./skills/comfyui/SKILL.md', import.meta.url), { encoding: 'utf8', signal: options.signal }) };
    },
  }));
}
