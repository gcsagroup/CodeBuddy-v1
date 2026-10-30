export const items = [
  { id: 'one', sessionId: 'chat-one', sessionName: '风景生成', root: 'C:/projects/landscape', kind: 'image', path: 'C:/projects/landscape/generated-images/one/1.png', filename: '1.png', available: true, createdAt: '2026-10-29T08:00:00.000Z', prompt: '远山与湖泊' },
  { id: 'two', sessionId: 'chat-two', sessionName: '产品设计', root: 'C:/projects/product', kind: 'image', path: 'C:/projects/product/generated-images/two/1.png', filename: '1.png', available: true, createdAt: '2026-10-28T08:00:00.000Z', prompt: '蓝色产品示意图' },
  { id: 'three', sessionId: 'chat-two', sessionName: '产品设计', root: 'C:/projects/product', kind: 'video', path: 'C:/projects/product/generated-videos/three/1.mp4', filename: '1.mp4', available: false, createdAt: '2026-10-27T08:00:00.000Z', prompt: '已移动的视频文件' },
];

const deleted = new Set<string>();
export async function getAcpControlClient() {
  return { extMethod: async (method: string, query: { kind?: string; project?: string; search?: string; view?: string; ids?: string[]; confirm?: boolean }) => {
    if (method === '_codebuddy/media/delete') {
      if (!query.confirm) throw new Error('Confirmation required');
      for (const id of query.ids ?? []) deleted.add(id);
      return { results: (query.ids ?? []).map(id => ({ id, deleted: true })) };
    }
    const available = items.filter(item => !deleted.has(item.id)).map(item => ({ ...item, sizeBytes: item.available ? 2048 : 0 }));
    const filtered = available.filter(item => (query.kind === 'all' || query.kind === item.kind)
      && (!query.project || query.project === item.root)
      && (!query.search || item.prompt.includes(query.search)));
    if (query.view === 'workspace') filtered.sort((a, b) => a.root.localeCompare(b.root) || b.createdAt.localeCompare(a.createdAt));
    const size = (rows: typeof available) => rows.reduce((sum, item) => sum + item.sizeBytes, 0);
    return { items: filtered, total: filtered.length, totalBytes: size(filtered), libraryBytes: size(available), libraryCount: available.length,
      projects: [...new Set(available.map(item => item.root))],
      projectStats: [...new Set(filtered.map(item => item.root))].map(root => ({ root, count: filtered.filter(item => item.root === root).length, sizeBytes: size(filtered.filter(item => item.root === root)) })),
      unreadableRecords: 0, nextCursor: null };
  } };
}
