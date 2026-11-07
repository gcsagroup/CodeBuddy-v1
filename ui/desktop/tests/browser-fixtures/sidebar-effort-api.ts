const records = [
  { id: 'a-new', title: '项目甲的新对话', cwd: 'D:/Alpha', updatedAt: '2026-11-06' },
  { id: 'b', title: '项目乙对话', cwd: 'D:/Beta', updatedAt: '2026-11-05' },
  { id: 'a-old', title: '项目甲的旧对话', cwd: 'D:/Alpha', updatedAt: '2026-11-01' },
  { id: 't-new', title: '新任务', cwd: '', updatedAt: '2026-11-06' },
  { id: 't-old', title: '旧任务', cwd: '', updatedAt: '2026-11-01' },
].map(s => ({ ...s, sessionId: s.id, _meta: { sessionType: 'user', messageCount: 2, createdAt: '2026-11-01' } }));
const request = (method: string, input: unknown) => (window as any).fixtureRequest(method, input);
const client = {
  listSessions: async () => ({ sessions: records.filter((s: any) => !s.archived) }),
  goose: {
    sessionInfo_unstable: async ({ sessionId }: any) => ({ session: records.find(s => s.id === sessionId) }),
    sessionArchive_unstable: async ({ sessionId }: any) => { await request('archive', { sessionId }); const record: any = records.find(s => s.id === sessionId); record.archived = true; },
    providersConfigSave_unstable: (input: unknown) => request('config-save', input),
  },
  extMethod: async (method: string) => method === '_codebuddy/agents/list' ? { profiles: [] } : { records: [] },
};
export async function getAcpClient() { return client; }
export async function getAcpControlClient() { return client; }
export function isAcpRecovering() { return false; }
export async function getAcpInitializeResponse() { return { capabilities: {} }; }

