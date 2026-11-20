import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';

export const name = 'codebuddy-development-skills';
export const inject = ['skills'];
const descriptions = {
  'web-acceptance': '网页交付与交互验收。Validate requested browser interactions, responsive layout and accessibility, then deliver with evidence.',
  'code-navigation': '跨文件代码定义与引用查询。Trace symbols and callers with semantic code navigation for debugging and change impact.',
  'versioned-docs': '按项目实际依赖版本查阅 API 文档。Retrieve version-matched library documentation before implementing APIs or upgrades.',
  'media-quality': '检查图片、动画、视频和桌宠的尺寸、透明轮廓、裁切、帧延时与显示间隔。Inspect media metadata and stable animation bounds.',
};
export function apply(ctx) {
  const entries = Object.entries(descriptions).map(([skill, description]) => ({
    name: skill, description, invocation: { modelInvocable: true, userInvocable: true },
    provider: name, source: 'bundled', rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`./skills/${skill}/`, import.meta.url)) },
  }));
  ctx.skills.registerProvider(() => ({
    name, list: async () => entries,
    async get({ rank: _rank, ...entry }, options) {
      return { ...entry, content: await readFile(new URL(`./skills/${entry.name}/SKILL.md`, import.meta.url), { encoding: 'utf8', signal: options.signal }) };
    },
  }));
}
