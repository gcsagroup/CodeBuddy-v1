import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuedMessageStorage, QueueStorageConflict } from './queuedMessageStorage';

const message = {
  id: 'q1',
  content: 'inspect this file',
  timestamp: 123,
  images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
};

describe('queued message snapshots', () => {
  beforeEach(() => localStorage.clear());

  it('restores text, image bytes and uncertain submission state in the same session', () => {
    const store = new QueuedMessageStorage(localStorage, 'a');
    store.read();
    store.write([{ ...message, delivery: 'submitting' }]);
    expect(new QueuedMessageStorage(localStorage, 'a').read()).toEqual([
      { ...message, delivery: 'submitting' },
    ]);
    expect(new QueuedMessageStorage(localStorage, 'b').read()).toEqual([]);
  });

  it('keeps accepted removal, edits and order across reloads', () => {
    const store = new QueuedMessageStorage(localStorage, 'a');
    store.read();
    store.write([message, { ...message, id: 'q2', content: 'second' }]);
    store.write([{ ...message, id: 'q2', content: 'edited' }]);
    expect(new QueuedMessageStorage(localStorage, 'a').read().map((m) => m.content)).toEqual([
      'edited',
    ]);
    store.write([]);
    expect(new QueuedMessageStorage(localStorage, 'a').read()).toEqual([]);
  });

  it('rejects stale writers without overwriting the newer queue', () => {
    const first = new QueuedMessageStorage(localStorage, 'a');
    const stale = new QueuedMessageStorage(localStorage, 'a');
    first.read();
    stale.read();
    first.write([message]);
    expect(stale.isCurrent()).toBe(false);
    expect(() => stale.write([])).toThrow(QueueStorageConflict);
    expect(new QueuedMessageStorage(localStorage, 'a').read()).toEqual([message]);
  });

  it('does not overwrite damaged data or import unscoped legacy state', () => {
    localStorage.setItem('goose-queue-paused', 'true');
    const store = new QueuedMessageStorage(localStorage, 'a');
    localStorage.setItem(store.key, '{broken');
    expect(() => store.read()).toThrow();
    expect(() => store.write([])).toThrow();
    expect(localStorage.getItem(store.key)).toBe('{broken');
    expect(new QueuedMessageStorage(localStorage, 'b').read()).toEqual([]);
  });

  it('propagates quota errors and preserves the previous snapshot', () => {
    const backing = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
    };
    const store = new QueuedMessageStorage(backing, 'a');
    store.read();
    expect(() => store.write([message])).toThrow('quota');
    expect(message.images).toHaveLength(1);
  });
});
