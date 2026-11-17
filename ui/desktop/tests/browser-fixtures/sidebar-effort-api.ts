const records = [
  { id: 'a-new', title: '项目甲的新对话', cwd: 'D:/Alpha', updatedAt: '2026-11-06' },
  { id: 'b', title: '项目乙对话', cwd: 'D:/Beta', updatedAt: '2026-11-05' },
  { id: 'a-old', title: '项目甲的旧对话', cwd: 'D:/Alpha', updatedAt: '2026-11-01' },
  { id: 't-new', title: '新任务', cwd: '', updatedAt: '2026-11-06' },
  { id: 't-old', title: '旧任务', cwd: '', updatedAt: '2026-11-01' },
].map(s => ({ ...s, sessionId: s.id, _meta: { sessionType: 'user', globalConversation: false, messageCount: 2, createdAt: '2026-11-01' } }));
if (new URLSearchParams(window.location.search).has('emptyWorkspace')) {
  records.splice(0, 3);
  records.push({ ...records[0], id: 'main', sessionId: 'main', title: '主对话',
    _meta: { ...records[0]._meta, globalConversation: true } });
}
if (new URLSearchParams(window.location.search).has('longTitles')) {
  records[0].title = '修复七项体验问题并验收 Windows 和 Mac 安装包，保留完整历史与验证证据 (12)';
  records.push(...Array.from({ length: 25 }, (_, i) => ({ ...records[3], id: `extra-${i}`, sessionId: `extra-${i}`, title: `滚动测试对话 ${i}` })));
}
if (new URLSearchParams(window.location.search).has('longFolders')) {
  records.filter(s => s.cwd === 'D:/Alpha').forEach(s => { s.cwd = 'D:/工作区/桌面产品跨平台体验设计与集成验收记录归档目录'; });
}
const request = (method: string, input: unknown) => (window as any).fixtureRequest(method, input);
const client = {
  listSessions: async ({ _meta }: { _meta?: { query?: string } } = {}) => {
    const query = _meta?.query?.toLocaleLowerCase() ?? '';
    return { sessions: records.filter((s: typeof records[number] & { archived?: boolean }) =>
      !s.archived && s.title.toLocaleLowerCase().includes(query)
    ) };
  },
  goose: {
    sessionInfo_unstable: async ({ sessionId }: any) => ({ session: records.find(s => s.id === sessionId) }),
    sessionArchive_unstable: async ({ sessionId }: any) => { await request('archive', { sessionId }); const record: any = records.find(s => s.id === sessionId); record.archived = true; },
    providersConfigSave_unstable: (input: unknown) => request('config-save', input),
  },
  extMethod: async (method: string, input: unknown) =>
    method === '_goose/unstable/native-schedules/catalog' && new URLSearchParams(location.search).get('listPage') === 'schedule'
      ? { records: [{ id: 'schedule-fixture', kind: 'every', everySeconds: 60,
          title: '定期检查项目', prompt: '检查项目进度', sessionId: 'a-new', status: 'active',
          scheduledAt: '2030-01-01T00:00:00Z' }] }
      : method === '_codebuddy/agents/list' ? { profiles: [] } : method === '_goose/unstable/session/navigation/move' ? request('navigation-move', input) : { records: [] },
};
export async function getAcpClient() { return client; }
export async function getAcpControlClient() { return client; }
export function isAcpRecovering() { return false; }
export async function getAcpInitializeResponse() { return { capabilities: {} }; }

