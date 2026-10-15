import { describe, expect, it, vi } from 'vitest';
import { FileOpenQueue } from './fileOpenQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Finder and Dock file opening', () => {
  it('holds cold-start events until application services are ready', async () => {
    const open = vi.fn().mockResolvedValue(true);
    const queue = new FileOpenQueue(open, vi.fn());
    queue.enqueue('/projects/中文 project/file.txt');
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    expect(queue.hasPending).toBe(true);
    expect(await queue.start()).toBe(true);
    expect(open).toHaveBeenCalledWith('/projects/中文 project/file.txt');
    expect(queue.hasPending).toBe(false);
  });

  it('does not suppress the default window when no external open succeeds', async () => {
    const queue = new FileOpenQueue(vi.fn().mockResolvedValue(false), vi.fn());
    expect(await queue.start()).toBe(false);
    queue.enqueue('/missing');
    expect(await queue.start()).toBe(false);
  });

  it('serializes separate open-file events and includes arrivals during startup', async () => {
    const first = deferred<boolean>();
    const open = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const queue = new FileOpenQueue(open, vi.fn());
    queue.enqueue('/first');
    const startup = queue.start();
    await Promise.resolve();
    queue.enqueue('/second');
    expect(open).toHaveBeenCalledTimes(1);
    expect(queue.hasPending).toBe(true);
    first.resolve(true);
    expect(await startup).toBe(true);
    expect(open.mock.calls).toEqual([['/first'], ['/second']]);
    expect(queue.hasPending).toBe(false);
  });

  it('continues after a failed file and uses the successful window', async () => {
    const failure = new Error('missing file');
    const open = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(true);
    const report = vi.fn();
    const queue = new FileOpenQueue(open, report);
    queue.enqueue('/missing');
    queue.enqueue('/valid');
    expect(await queue.start()).toBe(true);
    expect(report).toHaveBeenCalledWith(failure);
    expect(open).toHaveBeenCalledTimes(2);
    expect(queue.hasPending).toBe(false);
  });

  it('opens later events after a normal launch without restarting services', async () => {
    const opened = deferred<boolean>();
    const open = vi.fn().mockReturnValue(opened.promise);
    const queue = new FileOpenQueue(open, vi.fn());
    await queue.start();
    queue.enqueue('/later');
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('/later');
    expect(queue.hasPending).toBe(true);
    opened.resolve(true);
    await queue.start();
    expect(queue.hasPending).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
