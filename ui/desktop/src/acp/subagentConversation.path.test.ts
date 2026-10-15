import { beforeEach, expect, it, vi } from 'vitest';
import { getAcpControlClient } from './acpConnection';
import { readSubagentConversation } from './subagentConversation';
vi.mock('./acpConnection', () => ({ getAcpControlClient: vi.fn() }));
const extMethod = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAcpControlClient).mockResolvedValue({ extMethod } as unknown as Awaited<
    ReturnType<typeof getAcpControlClient>
  >);
});
const page = {
  sessionId: 'root',
  childSessionId: 'leaf',
  throughSeq: -1,
  hasMore: false,
  events: [],
};
it('preserves the old direct-child request while binding explicit catalog ancestry', async () => {
  extMethod.mockResolvedValueOnce(page);
  await expect(readSubagentConversation('root', 'leaf', -1)).resolves.toEqual(page);
  expect(extMethod).toHaveBeenLastCalledWith('_goose/unstable/subagent/conversation/get', {
    sessionId: 'root',
    childSessionId: 'leaf',
    afterSeq: -1,
  });
  extMethod.mockResolvedValueOnce({ ...page, ancestorSessionIds: ['a'] });
  await readSubagentConversation('root', 'leaf', -1, ['a']);
  expect(extMethod).toHaveBeenLastCalledWith('_goose/unstable/subagent/conversation/get', {
    sessionId: 'root',
    childSessionId: 'leaf',
    afterSeq: -1,
    ancestorSessionIds: ['a'],
  });
});
it('rejects a mismatched ancestry instead of displaying a neighboring child response', async () => {
  extMethod.mockResolvedValueOnce({ ...page, ancestorSessionIds: ['other'] });
  await expect(readSubagentConversation('root', 'leaf', -1, ['a'])).rejects.toThrow(
    'Invalid subagent conversation response'
  );
});
