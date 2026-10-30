let profiles: Record<string, unknown>[] = [];
export async function getAcpControlClient() {
  return { extMethod: async (method: string, input: Record<string, unknown>) => {
    if (method.endsWith('/list')) return { profiles, avatars: ['🤖', '🐱', '🎨', '📚', '🔬', '🌱'] };
    if (method.endsWith('/catalog')) return {
      models: [{ providerId: 'fixture', modelId: 'research-model', label: '测试模型 / research-model' }],
      skills: [{ name: 'research', description: '整理资料与核对引用。' }, { name: 'writing', description: '清晰表达复杂内容。' }],
      tools: [{ name: 'read', description: '读取工作区文件' }, { name: 'write', description: '写入工作区文件' }],
      mcpServers: [{ name: 'knowledge', description: '检索知识库资料' }],
    };
    if (method.endsWith('/save')) {
      const profile = { ...(input.profile as Record<string, unknown>), id: 'fixture-agent', revision: 1 };
      profiles = [profile]; return { profile };
    }
    if (method.endsWith('/create-workspace')) return { sessionId: 'fixture-workspace' };
    if (method.endsWith('/delete')) { profiles = []; return {}; }
    throw new Error('Unexpected fixture request');
  } };
}
