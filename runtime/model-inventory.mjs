import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { discover, discoveredModelCapabilities, modelConnectionIdentity, providerStatus, resolvedModelInfo, invalid } from './providers.mjs';
import { desktopNetworkAllowed } from './desktop-network-consent.mjs';

// One owner for startup and explicit refresh; selections belong to defaults
// and sessions and are deliberately never written here.
export class ModelInventory {
  constructor(store) { this.store = store; this.pending = new Map(); this.failures = new Map(); this.closed = false; this.revision = 0; }
  status() {
    return this.store.read(['providers']).providers.flatMap(provider => {
      const saved = provider.inventoryState;
      const valid = saved?.connection === modelConnectionIdentity(provider);
      const lastFailure = this.failures.get(provider.id);
      const failure = lastFailure?.connection === modelConnectionIdentity(provider) ? lastFailure.details : undefined;
      const changes = valid ? saved.changes ?? [] : [];
      if (!failure && !changes.length) return [];
      return [{ providerId: provider.id, providerName: provider.displayName, changes,
        noticeId: valid ? saved.noticeId : undefined, ...(failure ?? {}) }];
    });
  }
  async acknowledge(providerId, noticeId) {
    await this.store.update(state => {
      const saved = state.providers.find(p => p.id === providerId)?.inventoryState;
      if (saved?.noticeId === noticeId) saved.changes = [];
    }, ['providers'], { skipUnchanged: true });
  }
  async startup() {
    if (!desktopNetworkAllowed() || this.closed) return;
    const providers = this.store.read(['providers']).providers.filter(p => providerStatus(p).isConfigured);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, providers.length) }, async () => {
      while (next < providers.length && !this.closed) {
        const provider = providers[next++];
        await this.refresh(provider.id).catch(() => {});
      }
    }));
  }
  start() {
    if (!this.startupPromise && !this.closed && desktopNetworkAllowed())
      this.startupPromise = this.startup().catch(() => {});
    return this.startupPromise;
  }
  refresh(id) {
    if (!desktopNetworkAllowed()) return Promise.reject(invalid('Network access has not been approved'));
    if (this.closed) return Promise.reject(invalid('Runtime is shutting down'));
    if (this.pending.has(id)) return this.pending.get(id);
    const operation = this.refreshProvider(id).finally(() => this.pending.delete(id));
    this.pending.set(id, operation);
    return operation;
  }
  async refreshProvider(id) {
    const state = this.store.read(['providers', 'defaults']);
    const provider = state.providers.find(p => p.id === id);
    if (!provider) throw invalid('Unknown provider');
    const connection = modelConnectionIdentity(provider);
    try {
      const models = await discover(provider, provider, { refreshMetadata: true, allowEmpty: true, timeoutMs: 10000 });
      if (state.defaults?.providerId === id && models.includes(state.defaults.modelId))
        await resolvedModelInfo({ ...provider, models }, state.defaults.modelId);
      const capabilities = discoveredModelCapabilities(provider, models);
      if (this.closed) return;
      await this.store.update(current => {
        const saved = current.providers.find(p => p.id === id);
        if (!saved || modelConnectionIdentity(saved) !== connection || this.closed) return;
        const previous = saved.inventoryState?.connection === connection ? saved.inventoryState : undefined;
        const changes = [...(previous?.changes ?? [])];
        const add = change => {
          const index = changes.findIndex(item => item.model === change.model && item.kind === change.kind);
          if (index >= 0) changes[index] = change.kind === 'capabilities'
            ? { ...change, fields: [...new Set([...(changes[index].fields ?? []), ...change.fields])] } : change;
          else changes.push(change);
        };
        for (const model of saved.models) if (!models.includes(model)) add({ kind: 'removed', model });
        // A model coming back is no longer unavailable, even before dismissal.
        for (let i = changes.length - 1; i >= 0; i--)
          if (changes[i].kind === 'removed' && models.includes(changes[i].model)) changes.splice(i, 1);
        for (const model of models) {
          const before = previous?.capabilities?.[model];
          if (!before) continue;
          const fields = Object.keys(capabilities[model]).filter(field => Object.hasOwn(before, field) &&
            !isDeepStrictEqual(before[field], capabilities[model][field]));
          if (fields.length) add({ kind: 'capabilities', model, fields });
          // Preserve last known facts across an incomplete discovery response.
          capabilities[model] = { ...before, ...capabilities[model] };
        }
        const changed = !isDeepStrictEqual(changes, previous?.changes ?? []);
        // A healthy startup must not rewrite the entire conversation store
        // merely to record another successful poll of identical metadata.
        if (previous && !changed && isDeepStrictEqual(saved.models, models) &&
            isDeepStrictEqual(previous.capabilities, capabilities)) return;
        saved.models = models;
        saved.inventoryState = { connection, capabilities, changes,
          noticeId: changed ? randomUUID() : previous?.noticeId, checkedAt: Date.now() };
      }, ['providers'], { skipUnchanged: true });
      this.failures.delete(id);
      this.revision++;
    } catch (error) {
      const current = this.store.read(['providers']).providers.find(p => p.id === id);
      if (!this.closed && current && modelConnectionIdentity(current) === connection)
        this.failures.set(id, { connection, details: { failed: true, httpStatus: error?.data?.httpStatus } });
      throw error;
    }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.pending.values(), this.startupPromise]); }
}
