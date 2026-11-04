import { AGENT_AVATARS, DEFAULT_AGENT_PRESETS, DEFAULT_AGENT_SKILLS } from '../../../../runtime/agent-presets.mjs';

let profiles: Record<string, unknown>[] = [];
export async function getAcpControlClient() {
  return { extMethod: async (method: string, input: Record<string, unknown>) => {
    if (method.endsWith('/list')) return { profiles, avatars: AGENT_AVATARS };
    if (method.endsWith('/catalog')) return {
      skills: [{ name: 'research', description: '整理资料与核对引用。' }, { name: 'writing', description: '清晰表达复杂内容。' }, ...DEFAULT_AGENT_SKILLS.map(skill => ({ ...skill, roleOnly: true }))],
      presets: DEFAULT_AGENT_PRESETS,
      tools: [{ name: 'read', description: '读取工作区文件' }, { name: 'write', description: '写入工作区文件' }],
      mcpServers: [{ name: 'knowledge', description: '检索知识库资料' }],
    };
    if (method.endsWith('/save')) {
      const draft = input.profile as Record<string, unknown>;
      const previous = profiles.find(profile => profile.id === draft.id);
      const profile = { ...draft, id: draft.id ?? crypto.randomUUID(), revision: Number(previous?.revision ?? 0) + 1 };
      profiles = [...profiles.filter(saved => saved.id !== profile.id), profile]; return { profile };
    }
    if (method.endsWith('/create-workspace')) return { sessionId: 'fixture-workspace' };
    if (method.endsWith('/delete')) { profiles = profiles.filter(profile => profile.id !== input.id); return {}; }
    throw new Error('Unexpected fixture request');
  } };
}
