import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpControlClient } from './acpConnection';
import { readSubagentCatalog } from './subagentCatalog';

vi.mock('./acpConnection', () => ({ getAcpControlClient: vi.fn() }));

const extMethod = vi.fn();
const entry = { id: 'child-a', createdAt: 1_792_000_000_000, mode: 'continuable', label: 'Review' };
const page = (ancestorSessionIds: string[] = []) => ({
  sessionId: 'root',
  ancestorSessionIds,
  children: [{ ...entry }],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAcpControlClient).mockResolvedValue({ extMethod } as unknown as Awaited<
    ReturnType<typeof getAcpControlClient>
  >);
});

describe('read-only native subagent catalog', () => {
  it('reads direct children over the control connection and preserves the native order and modes', async () => {
    const children = [
      { id: 'once', createdAt: 0, mode: 'one-shot' },
      entry,
      { id: 'external', createdAt: 7, mode: 'external', label: 'Remote execution' },
      { id: 'unknown', createdAt: 8, mode: 'unknown' },
    ];
    extMethod.mockResolvedValueOnce({ ...page(), children });
    await expect(readSubagentCatalog('root')).resolves.toEqual({ ...page(), children });
    expect(extMethod).toHaveBeenCalledExactlyOnceWith('_goose/unstable/subagent/catalog/list', {
      sessionId: 'root',
      ancestorSessionIds: [],
    });
  });

  it('binds a nested catalog to the exact ordered ancestry, excluding the product root', async () => {
    extMethod.mockResolvedValueOnce(page(['child-a', 'child-b']));
    const result = await readSubagentCatalog('root', ['child-a', 'child-b']);
    expect(result.ancestorSessionIds).toEqual(['child-a', 'child-b']);
    expect(extMethod).toHaveBeenCalledExactlyOnceWith('_goose/unstable/subagent/catalog/list', {
      sessionId: 'root',
      ancestorSessionIds: ['child-a', 'child-b'],
    });
  });

  it('accepts a confirmed empty catalog and does not substitute emptiness for a read failure', async () => {
    extMethod.mockResolvedValueOnce({ ...page(), children: [] });
    await expect(readSubagentCatalog('root')).resolves.toMatchObject({ children: [] });
    const failure = new Error('Parent catalog unavailable');
    extMethod.mockRejectedValueOnce(failure);
    await expect(readSubagentCatalog('root')).rejects.toBe(failure);
  });

  it('propagates a control connection failure without starting another transport or listing', async () => {
    const failure = new Error('Control connection closed');
    vi.mocked(getAcpControlClient).mockRejectedValueOnce(failure);
    await expect(readSubagentCatalog('root')).rejects.toBe(failure);
    expect(extMethod).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'foreign' },
    { ancestorSessionIds: undefined },
    { ancestorSessionIds: ['child-b', 'child-a'] },
    { ancestorSessionIds: ['child-a'] },
    { ancestorSessionIds: ['child-a', 'child-b', 'other'] },
    { ancestorSessionIds: ['child-a', null] },
    { children: null },
    { children: {} },
  ])(
    'rejects an unrelated or malformed response instead of showing it in the requested directory: %j',
    async (change) => {
      extMethod.mockResolvedValueOnce({ ...page(['child-a', 'child-b']), ...change });
      await expect(readSubagentCatalog('root', ['child-a', 'child-b'])).rejects.toThrow(
        'Invalid subagent catalog response'
      );
    }
  );

  it.each([null, undefined, [], { error: 'unavailable' }])(
    'rejects an invalid response envelope %j',
    async (value) => {
      extMethod.mockResolvedValueOnce(value);
      await expect(readSubagentCatalog('root')).rejects.toThrow(
        'Invalid subagent catalog response'
      );
    }
  );

  it.each([
    { id: '' },
    { id: 'x'.repeat(257) },
    { id: 4 },
    { createdAt: undefined },
    { createdAt: '2026-10-16T00:00:00Z' },
    { createdAt: -1 },
    { createdAt: 1.5 },
    { createdAt: Number.NaN },
    { createdAt: Number.POSITIVE_INFINITY },
    { createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { mode: 'local' },
    { mode: 'future-mode' },
    { label: undefined },
    { label: null },
    { label: 4 },
  ])(
    'rejects a malformed native child rather than silently filtering the row: %j',
    async (change) => {
      extMethod.mockResolvedValueOnce({
        ...page(),
        children: [entry, { ...entry, id: 'bad', ...change }],
      });
      await expect(readSubagentCatalog('root')).rejects.toThrow(
        'Invalid subagent catalog response'
      );
    }
  );

  it('does not promote unexpected status or activity fields into a directory fact', async () => {
    extMethod.mockResolvedValueOnce({
      ...page(),
      status: 'running',
      children: [
        { ...entry, status: 'running', activity: 'Writing', prompt: 'private instruction' },
      ],
    });
    const result = await readSubagentCatalog('root');
    expect(result).toEqual(page());
    expect(result.children[0]).not.toHaveProperty('status');
    expect(result.children[0]).not.toHaveProperty('activity');
    expect(result.children[0]).not.toHaveProperty('prompt');
  });

  it('keeps the original navigation identity when the caller mutates its array while awaiting the connection', async () => {
    const ancestors = ['child-a'];
    extMethod.mockResolvedValueOnce(page(['child-a']));
    const pending = readSubagentCatalog('root', ancestors);
    ancestors.push('other');
    await expect(pending).resolves.toMatchObject({ ancestorSessionIds: ['child-a'] });
    expect(extMethod).toHaveBeenCalledExactlyOnceWith('_goose/unstable/subagent/catalog/list', {
      sessionId: 'root',
      ancestorSessionIds: ['child-a'],
    });
  });

  it.each([
    ['', []],
    ['x'.repeat(257), []],
    ['root', ['root']],
    ['root', ['child-a', 'child-a']],
    ['root', ['']],
    ['root', ['x'.repeat(257)]],
    ['root', Array.from({ length: 33 }, (_, index) => `child-${index}`)],
  ] as [string, string[]][])(
    'rejects an invalid navigation request before contacting ACP: %j %j',
    async (sessionId, ancestors) => {
      await expect(readSubagentCatalog(sessionId, ancestors)).rejects.toThrow(
        'Invalid subagent catalog request'
      );
      expect(getAcpControlClient).not.toHaveBeenCalled();
      expect(extMethod).not.toHaveBeenCalled();
    }
  );
});
