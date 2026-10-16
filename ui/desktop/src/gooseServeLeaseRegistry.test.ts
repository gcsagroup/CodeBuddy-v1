import { describe, expect, it, vi } from 'vitest';
import { GooseServeLeaseRegistry } from './gooseServeLeaseRegistry';

describe('Harness backend window leases', () => {
  it('shares an existing transport and cleans up after the last window closes', async () => {
    const cleanup = vi.fn(async () => undefined);
    const store = new GooseServeLeaseRegistry({ error: vi.fn() });
    const lease = store.createExternal('ws://127.0.0.1:1234/acp', 'secret', cleanup);
    store.attachWindow(1, lease);
    store.attachWindow(2, lease);
    expect(store.getAcpUrl(1)).toBe('ws://127.0.0.1:1234/acp');
    expect(store.getSecretKey(2)).toBe('secret');
    await store.releaseWindow(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(store.activeLeaseCount()).toBe(1);
    await store.releaseWindow(2);
    await store.cleanupLease(lease);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(store.getSecretKey(2)).toBeNull();
    expect(store.activeLeaseCount()).toBe(0);
  });
  it('removes all bindings even if cleanup fails', async () => {
    const logger = { error: vi.fn() };
    const store = new GooseServeLeaseRegistry(logger);
    const lease = store.createExternal('ws://127.0.0.1:1234/acp', 'secret', async () => { throw Error('closed'); });
    store.attachWindow(1, lease);
    store.attachWindow(2, lease);
    await store.cleanupAll();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(store.getAcpUrl(1)).toBeNull();
    expect(store.getSecretKey(2)).toBeNull();
  });
});
