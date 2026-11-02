import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { invalid, requireString, providerStatus, readProvider, saveProvider, contextProfile, outputBudgetProfile, resolvedInventory, resolvedModelInfo, resolveImageCapability, thinkingProfile, discover } from './providers.mjs';
import { applyModelThinking, modelThinkingOptions, THINKING_EFFORTS } from './model-settings.mjs';
import { protectSecret, revealSecret } from './secrets.mjs';
import { extensionName, extensionConfigKey, extensionSnapshotChanged } from './session-extensions.mjs';
import { comfyuiUrl } from './comfyui-tool.mjs';
import { permissionPresets } from './permission-presets.mjs';
import { listAvailableBuiltins } from './builtin-extensions.mjs';

const permissionLevels = new Set(['always_allow', 'ask_before', 'never_allow']);
const roles = new Set(['main', 'planner', 'coder', 'tester', 'reviewer']);
export const DEFAULT_SYSTEM_PROMPT = 'You are CodeBuddy, a software engineering assistant. Work in the selected workspace. Inspect existing code, keep changes scoped to the user request, and verify your work using the actual project tools. Report observed results separately from unverified work.';
const promptTemplates = [{ name: 'system', description: 'Harness agent instructions', defaultContent: DEFAULT_SYSTEM_PROMPT }];
const configKey = e => extensionConfigKey(requireString(extensionName(e), 'extension name'));

export function validatePreference(key, value) {
  if (value == null) return;
  if (key === 'comfyuiBaseUrl') {
    if (typeof value !== 'string' || !value.trim()) throw invalid('ComfyUI URL is required');
    try { comfyuiUrl(value); } catch (error) { throw invalid(error.message); }
  }
  if (key === 'gooseMode' && !permissionPresets.includes(value)) throw invalid('Unknown native permission preset');
  if (key === 'gooseThinkingEffort' && !THINKING_EFFORTS.includes(value)) throw invalid('Unknown reasoning effort');
  if (key === 'gooseMaxTurns' && (!Number.isSafeInteger(value) || value < 1 || value > 100000)) throw invalid('Maximum turns must be between 1 and 100000');
  if (key === 'autoCompactThreshold' && (!Number.isFinite(value) || value <= 0 || value >= 1)) throw invalid('Compaction threshold must be between zero and one');
  if (key === 'personalizedMemoryEnabled' && typeof value !== 'boolean') throw invalid('Memory preference must be boolean');
}

export class RuntimeSettings {
  constructor(store, { changed = () => {}, testExtension, checkProviderMutation = () => {}, reveal = revealSecret } = {}) { this.store = store; this.changed = changed; this.testExtension = testExtension; this.checkProviderMutation = checkProviderMutation; this.extensionRevision = 0; this.reveal = reveal; this.decodedExtensions = new Map(); }
  async initialize() {
    const commonQueriesAvailable = this.store.read(['extensions']).extensions.some(e => e.configKey === 'commonqueries')
      ? false
      : (await listAvailableBuiltins()).some(e => e.configKey === 'commonqueries' && e.available);
    await this.store.update(s => {
      if (!s.extensions.some(e => e.configKey === 'commonqueries')) s.extensions.push({ configKey: 'commonqueries', enabled: commonQueriesAvailable, extension: { type: 'builtin', name: 'commonqueries', display_name: '时间与天气', description: '读取主机时间、解析城市并按设置查询天气。' } });
      if (!s.extensions.some(e => e.configKey === 'developer')) s.extensions.push({ configKey: 'developer', enabled: true, extension: { type: 'builtin', name: 'developer', description: 'Official Harness file, search and shell tools' } });
      if (!s.extensions.some(e => e.configKey === 'projectmemory')) s.extensions.push({ configKey: 'projectmemory', enabled: true, extension: { type: 'platform', name: 'projectmemory', description: 'Project memory stored by Harness with candidate review and controlled recall' } });
      if (!s.extensions.some(e => e.configKey === 'git')) s.extensions.push({ configKey: 'git', enabled: true, extension: { type: 'builtin', name: 'git', description: 'Inspect repository changes and manage staging, commits, and local branches' } });
    });
    this.extensionRevision += 1;
    this.decodedExtensions.clear();
  }
  async decodeExtension(entry) {
    if (!entry.protected) return structuredClone(entry.extension);
    const key = JSON.stringify(entry.protected);
    // Only current configuration definitions live in this settings owner's
    // memory. Credentials remain encrypted on disk, never in logs.
    if (!this.decodedExtensions.has(key)) {
      const pending = this.reveal(entry.protected).then(JSON.parse).catch(error => { this.decodedExtensions.delete(key); throw error; });
      this.decodedExtensions.set(key, pending);
    }
    return structuredClone(await this.decodedExtensions.get(key));
  }
  async extensions() {
    return Promise.all(this.store.read(["extensions"]).extensions.map(async entry => ({
      extension: await this.decodeExtension(entry),
      enabled: entry.enabled, configKey: entry.configKey,
    })));
  }
  async extensionSnapshot() {
    const revision = this.extensionRevision;
    const registry = this.store.read(["extensions"]).extensions;
    const assertCurrent = () => {
      if (revision !== this.extensionRevision) throw extensionSnapshotChanged('Extension settings changed; retry the operation');
    };
    const configured = registry.map(entry => ({ configKey: entry.configKey, enabled: entry.enabled, name: extensionName(entry.extension) }));
    const entries = await Promise.all(registry.filter(entry => entry.enabled).map(async entry => ({
      extension: await this.decodeExtension(entry),
      enabled: entry.enabled, configKey: entry.configKey,
    })));
    assertCurrent();
    return { configured, entries, assertCurrent };
  }
  async saveExtension(p, replacing = false) {
    const extension = structuredClone(p.extension);
    if (!extension || !['builtin', 'platform', 'mcp'].includes(extension.type)) throw invalid('Invalid extension type');
    const key = configKey(extension);
    if (!key) throw invalid('Extension name requires an identifier');
    if (extension.type === 'mcp') {
      const s = extension.server;
      if (s.command != null) {
        requireString(s.command, 'MCP command');
        if (!Array.isArray(s.args) || !s.args.every(a => typeof a === 'string')) throw invalid('MCP args must be strings');
      } else {
        let url; try { url = new URL(s.url); } catch { throw invalid('Invalid MCP URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('MCP URL must use HTTP(S) without embedded credentials');
      }
    }
    if (p.enabled != null && typeof p.enabled !== 'boolean') throw invalid('enabled must be boolean');
    const protectedValue = extension.type === 'mcp' ? await protectSecret(JSON.stringify(extension)) : undefined;
    const changed = await this.store.update(async state => {
      const index = state.extensions.findIndex(x => x.configKey === (replacing ? p.configKey : key));
      if (replacing && index < 0) throw invalid('Extension was removed; reload configuration');
      if (state.extensions.some((x, i) => i !== index && x.configKey === key)) throw invalid('Extension name already exists');
      const old = state.extensions[index];
      const enabled = p.enabled ?? old?.enabled ?? false;
      if (old && old.configKey === key && old.enabled === enabled) {
        let definition;
        // An explicit replacement must also repair credentials that no longer
        // decrypt (for example after moving a profile to a different account).
        try { definition = old.protected ? JSON.parse(await revealSecret(old.protected)) : old.extension; } catch {}
        if (isDeepStrictEqual(definition, extension)) return false;
      }
      const entry = { configKey: key, enabled,
        ...(protectedValue ? { protected: protectedValue } : { extension }) };
      if (index < 0) state.extensions.push(entry); else state.extensions[index] = entry;
      return true;
    });
    if (changed) {
      this.extensionRevision += 1;
      this.decodedExtensions.clear();
      await this.changed({ extensionConfigKeys: [...new Set([key, ...(replacing ? [p.configKey] : [])])] });
    }
    return {};
  }
  async request(name, p) {
    switch (name) {
      case 'config/extensions/list': return { extensions: await this.extensions(), warnings: [] };
      case 'config/extensions/add': return this.saveExtension(p);
      case 'config/extensions/update': return this.saveExtension(p, true);
      case 'config/extensions/remove':
      case 'config/extensions/set-enabled': {
        requireString(p.configKey, 'configKey');
        if (name.endsWith('set-enabled') && typeof p.enabled !== 'boolean') throw invalid('enabled must be boolean');
        const changed = await this.store.update(state => {
          const entry = state.extensions.find(e => e.configKey === p.configKey);
          if (!entry) throw invalid('Unknown extension');
          if (name.endsWith('set-enabled') && entry.enabled === p.enabled) return false;
          if (name.endsWith('remove')) state.extensions = state.extensions.filter(e => e !== entry);
          else entry.enabled = p.enabled;
          return true;
        });
        if (changed) {
          this.extensionRevision += 1;
          this.decodedExtensions.clear();
          await this.changed({ extensionConfigKeys: [p.configKey] });
        }
        return {};
      }
      case 'config/extensions/test': {
        const started = Date.now();
        try {
          if (!this.testExtension) throw Error('Extension runtime is not ready');
          const result = await this.testExtension(p);
          return { success: true, latencyMs: Date.now() - started, tools: result.tools, resourceCount: result.resourceCount ?? 0, supportsResources: result.supportsResources ?? false };
        } catch (e) { return { success: false, latencyMs: Date.now() - started, supportsResources: false, error: e.message }; }
      }
      case 'extensions/available': return { extensions: (await this.extensions()).map(x => x.extension) };
      case 'tools/permissions/set': {
        if (!Array.isArray(p.toolPermissions)) throw invalid('toolPermissions must be an array');
        for (const item of p.toolPermissions) { requireString(item.toolName, 'toolName'); if (!permissionLevels.has(item.permission)) throw invalid('Invalid tool permission'); }
        await this.store.update(s => { s.toolPermissions ??= {}; for (const item of p.toolPermissions) s.toolPermissions[item.toolName] = item.permission; });
        return {};
      }
      case 'codepro/model-routing/read': return { config: this.store.read(["modelRouting"]).modelRouting ?? null };
      case 'codepro/model-routing/save': {
        const c = p.config;
        if (!c || ![1, 2].includes(c.version) || typeof c.advancedRoutingEnabled !== 'boolean' || !Array.isArray(c.routes) || !Number.isSafeInteger(c.maxParallelCoders) || c.maxParallelCoders < 1 || c.maxParallelCoders > 32) throw invalid('Invalid model routing configuration');
        const seen = new Set();
        for (const r of c.routes) {
          if (!roles.has(r.role) || seen.has(r.role)) throw invalid('Unknown or duplicate model routing role');
          seen.add(r.role); requireString(r.providerId, 'providerId'); requireString(r.modelId, 'modelId');
          if (c.advancedRoutingEnabled && !this.store.read(["providers"]).providers.some(provider => provider.id === r.providerId && provider.models.includes(r.modelId) && providerStatus(provider).isConfigured)) throw invalid('Configure the selected role model first');
        }
        if (c.advancedRoutingEnabled && ['main', 'planner', 'coder', 'tester', 'reviewer'].some(role => !seen.has(role))) throw invalid('Enabled routing requires all five roles');
        if (!c.visionRoute || typeof c.visionRoute.enabled !== 'boolean' || !['auto', 'always', 'disabled'].includes(c.visionRoute.mode)) throw invalid('Invalid vision routing');
        let visionSelection;
        if (c.visionRoute.enabled) {
          const providerId = requireString(c.visionRoute.providerId, 'vision providerId'), modelId = requireString(c.visionRoute.modelId, 'vision modelId');
          const snapshot = this.store.read(['providers', 'modelCapabilities']);
          const provider = snapshot.providers.find(provider => provider.id === providerId && providerStatus(provider).isConfigured);
          const fail = (reason, message) => invalid(message, { kind: 'vision_error', reason });
          if (!provider) throw fail('provider_unavailable', '备用识图连接尚未配置或已不可用，请重新选择连接。');
          let available;
          try { available = await discover(provider, provider, { timeoutMs: 5000 }); }
          catch { throw fail('capability_unavailable', '暂时无法核实备用识图模型，请检查连接后重试；原设置未更改。'); }
          if (!available.includes(modelId)) throw fail('model_unavailable', '所选备用识图模型已不在服务列表中，请重新选择。');
          const capability = await this.request('model-capabilities/resolve', { providerId, modelId });
          if (capability.imageInput !== 'supported') throw fail('image_not_supported', '所选备用模型尚未确认支持图片，请选择支持图片的模型。');
          visionSelection = { provider, override: snapshot.modelCapabilities?.overrides.find(item => item.providerId === providerId && item.modelId === modelId) };
        }
        await this.store.update(s => {
          if (visionSelection) {
            const { providerId, modelId } = c.visionRoute;
            if (!isDeepStrictEqual(s.providers.find(item => item.id === providerId), visionSelection.provider) ||
              !isDeepStrictEqual(s.modelCapabilities?.overrides.find(item => item.providerId === providerId && item.modelId === modelId), visionSelection.override))
              throw invalid('识图连接或能力设置刚发生变化，请重新确认后保存。', { kind: 'vision_error', reason: 'configuration_changed' });
          }
          s.modelRouting = structuredClone(c);
        });
        await this.changed(); return { config: c };
      }
      case 'model-capabilities/read': return { config: this.store.read(["modelCapabilities"]).modelCapabilities ?? { version: 1, overrides: [] } };
      case 'model-capabilities/save': {
        const c = p.config;
        if (c?.version !== 1 || !Array.isArray(c.overrides)) throw invalid('Invalid capability overrides');
        const seen = new Set();
        for (const o of c.overrides) {
          requireString(o.providerId, 'providerId'); requireString(o.modelId, 'modelId');
          const id = JSON.stringify([o.providerId, o.modelId]);
          if (seen.has(id) || !['auto', 'force_supported', 'force_unsupported'].includes(o.imageInput)) throw invalid('Invalid or duplicated capability override');
          seen.add(id);
        }
        await this.store.update(s => { s.modelCapabilities = structuredClone(c); }); await this.changed(); return { config: c };
      }
      case 'model-capabilities/resolve': {
        const o = this.store.read(["modelCapabilities"]).modelCapabilities?.overrides.find(o => o.providerId === p.providerId && o.modelId === p.modelId);
        if (o && o.imageInput !== 'auto') return { providerId: p.providerId, modelId: p.modelId,
          imageInput: o.imageInput === 'force_supported' ? 'supported' : 'unsupported', source: 'user_override' };
        // The service inventory may include newly published IDs that are not
        // yet in the connection's saved picker defaults (for example :1017).
        const provider = this.store.read(["providers"]).providers.find(item => item.id === p.providerId);
        const capability = provider && providerStatus(provider).isConfigured
          ? await resolveImageCapability(provider, p.modelId)
          : { imageInput: 'unknown', source: 'unknown' };
        return { providerId: p.providerId, modelId: p.modelId, ...capability };
      }
      case 'config/prompts/list': return { prompts: promptTemplates.map(t => ({ ...t, userContent: this.store.read(["prompts"]).prompts?.[t.name] ?? null, isCustomized: this.store.read(["prompts"]).prompts?.[t.name] != null })) };
      case 'config/prompts/get': {
        const t = promptTemplates.find(t => t.name === p.name); if (!t) throw invalid('Unknown prompt template');
        const custom = this.store.read(["prompts"]).prompts?.[t.name]; return { name: t.name, content: custom ?? t.defaultContent, defaultContent: t.defaultContent, isCustomized: custom != null };
      }
      case 'config/prompts/save':
      case 'config/prompts/reset': {
        if (!promptTemplates.some(t => t.name === p.name)) throw invalid('Unknown prompt template');
        if (name.endsWith('save') && typeof p.content !== 'string') throw invalid('Prompt content must be a string');
        await this.store.update(s => { s.prompts ??= {}; if (name.endsWith('reset')) delete s.prompts[p.name]; else s.prompts[p.name] = p.content; });
        await this.changed(); return { message: 'Saved' };
      }
      case 'providers/config/status': return { statuses: this.store.read(["providers"]).providers.filter(x => !p.providerIds?.length || p.providerIds.includes(x.id)).map(providerStatus) };
      case 'providers/config/read': {
        const provider = this.store.read(["providers"]).providers.find(x => x.id === p.providerId); if (!provider) throw invalid('Unknown provider');
        await resolvedInventory(provider);
        return { fields: [ { key: 'apiUrl', value: provider.apiUrl, isSet: true, isSecret: false, required: true }, { key: 'apiKey', isSet: Boolean(provider.secret), isSecret: true, required: provider.requiresAuth }, ...provider.models.flatMap(model => [
          { key: `contextWindow:${model}`, value: JSON.stringify({ ...contextProfile(provider, model), configured: provider.contextWindows?.[model] ?? null }), isSet: provider.contextWindows?.[model] != null, isSecret: false, required: false },
          { key: `maxTokens:${model}`, value: JSON.stringify(outputBudgetProfile(provider, model)), isSet: provider.outputBudgets?.[model] != null, isSecret: false, required: false },
          { key: `thinkingEffort:${model}`, value: JSON.stringify(modelThinkingOptions(thinkingProfile(provider, model), provider.thinkingEfforts?.[model], this.store.read(['preferences']).preferences?.gooseThinkingEffort)), isSet: provider.thinkingEfforts?.[model] != null, isSecret: false, required: false },
        ]) ] };
      }
      case 'providers/config/save': {
        const thinkingFields = [...(p.fields ?? []).map(f => f.key), ...(p.clearFields ?? [])];
        if (thinkingFields.length && thinkingFields.every(key => key.startsWith('thinkingEffort:'))) {
          const provider = this.store.read(['providers']).providers.find(item => item.id === p.providerId);
          if (!provider) throw invalid('Unknown provider');
          const updates = new Map();
          for (const key of thinkingFields) {
            const model = key.slice('thinkingEffort:'.length);
            if (!provider.models.includes(model)) throw invalid('Unknown model for thinking effort');
            const field = p.fields?.find(item => item.key === key);
            const value = field?.value ?? null;
            if (value !== null) {
              // The picker can outlive the metadata cache, and refreshing the
              // model list also replaces it. Resolve this model before checking.
              await resolvedModelInfo(provider, model);
              const profile = thinkingProfile(provider, model);
              const options = modelThinkingOptions(profile);
              if (!THINKING_EFFORTS.includes(value) || !options.options.includes(value)) throw invalid('Selected thinking effort is unavailable for this model');
              applyModelThinking(profile, value);
            }
            updates.set(model, value);
          }
          await this.store.update(state => {
            const target = state.providers.find(item => item.id === provider.id);
            if (!target) throw invalid('Provider was removed');
            if (!isDeepStrictEqual({ ...target, thinkingEfforts: undefined }, { ...provider, thinkingEfforts: undefined }))
              throw invalid('Model connection changed; reload model settings');
            target.thinkingEfforts ??= {};
            for (const [model, value] of updates) {
              if (value === null) delete target.thinkingEfforts[model];
              else Object.defineProperty(target.thinkingEfforts, model, { value, enumerable: true, writable: true, configurable: true });
            }
          });
          // Preferences apply on the next prepared turn; active native requests keep their snapshot.
          await this.changed({ kind: 'model-thinking' });
          return { status: providerStatus(provider), refresh: { started: [] } };
        }
        await this.checkProviderMutation(p.providerId);
        const provider = this.store.read(["providers"]).providers.find(x => x.id === p.providerId); if (!provider) throw invalid('Unknown provider');
        const contextFields = [...(p.fields ?? []).map(f => f.key), ...(p.clearFields ?? [])];
        if (contextFields.length && contextFields.every(key => key.startsWith('maxTokens:'))) {
          const updates = new Map();
          for (const key of contextFields) {
            const model = key.slice('maxTokens:'.length);
            if (!provider.models.includes(model)) throw invalid('Unknown model for output budget');
            const field = p.fields?.find(item => item.key === key);
            const value = field ? Number(field.value) : null;
            if (value !== null) {
              if (!Number.isSafeInteger(value) || value < 1) throw invalid('Output budget must be a positive integer');
              await resolvedModelInfo(provider, model);
              const { capacityTokens } = outputBudgetProfile(provider, model);
              if (capacityTokens !== null && value > capacityTokens) throw invalid('Output budget exceeds the known model capacity');
            }
            updates.set(model, value);
          }
          await this.checkProviderMutation(p.providerId);
          await this.store.update(state => {
            const target = state.providers.find(item => item.id === provider.id);
            if (!target) throw invalid('Provider was removed');
            if (!isDeepStrictEqual({ ...target, outputBudgets: undefined }, { ...provider, outputBudgets: undefined }))
              throw invalid('Model connection changed; reload model settings');
            target.outputBudgets ??= {};
            for (const [model, value] of updates) {
              if (value === null) delete target.outputBudgets[model];
              else Object.defineProperty(target.outputBudgets, model, { value, enumerable: true, writable: true, configurable: true });
            }
          });
          await this.changed({ kind: 'model-output-budget' });
          return { status: providerStatus(provider), refresh: { started: [] } };
        }
        if (contextFields.length && contextFields.every(key => key.startsWith('contextWindow:'))) {
          const updates = {};
          for (const key of contextFields) {
            const model = key.slice('contextWindow:'.length);
            if (!provider.models.includes(model)) throw invalid('Unknown model for context capacity');
            const field = p.fields?.find(f => f.key === key);
            const value = field ? Number(field.value) : null;
            if (value !== null && (!Number.isSafeInteger(value) || value < 8192 || value > 10_000_000)) throw invalid('Context capacity must be an integer between 8192 and 10000000');
            updates[model] = value;
          }
          await this.store.update(state => {
            const target = state.providers.find(x => x.id === provider.id);
            target.contextWindows ??= {};
            for (const [model, value] of Object.entries(updates)) {
              if (value === null) delete target.contextWindows[model]; else target.contextWindows[model] = value;
            }
          });
          await this.changed();
          return { status: providerStatus(provider), refresh: { started: [] } };
        }
        const updates = {};
        for (const f of p.fields ?? []) { if (!['apiUrl', 'apiKey'].includes(f.key)) throw invalid('Unknown provider field'); updates[f.key] = f.value; }
        if (p.clearFields?.includes('apiKey')) updates.apiKey = '';
        const result = await saveProvider(this.store, { ...(await readProvider(provider)).provider, ...updates, providerId: provider.id }, true);
        await this.changed(); return result;
      }
      case 'providers/secrets/list': return { secrets: this.store.read(["providers"]).providers.filter(p => p.secret).map(p => ({ id: `provider:${p.id}`, provider: p.id, providerDisplayName: p.displayName, name: 'API key', storage: 'secret_store', status: 'unknown', configured: true, hasSecret: true, canDelete: true, canConfigure: false, configureProvider: p.id })) };
      case 'providers/secrets/delete': {
        const id = requireString(p.id, 'secret id');
        const target = this.store.read(["providers"]).providers.find(x => `provider:${x.id}` === id);
        if (target) await this.checkProviderMutation(target.id);
        await this.store.update(s => { const provider = s.providers.find(x => `provider:${x.id}` === id); if (!provider) throw invalid('Unknown credential'); provider.secret = null; });
        await this.changed(); return {};
      }
      case 'capability-usage/list': return { records: Object.values(this.store.read(["capabilityUsage"]).capabilityUsage ?? {}) };
      case 'capability-usage/record-success': {
        requireString(p.eventId, 'eventId'); requireString(p.capabilityId, 'capabilityId');
        if (!['skill', 'external', 'app', 'common_task', 'automatic_task'].includes(p.kind)) throw invalid('Invalid capability kind');
        return this.store.update(s => {
          s.capabilityUsageEvents ??= []; if (s.capabilityUsageEvents.includes(p.eventId)) return { recorded: false };
          s.capabilityUsage ??= {}; const key = createHash('sha256').update(JSON.stringify([p.kind, p.capabilityId])).digest('hex');
          s.capabilityUsage[key] = { kind: p.kind, capabilityId: p.capabilityId, successCount: (s.capabilityUsage[key]?.successCount ?? 0) + 1, lastSuccessAt: new Date().toISOString(), recentResult: String(p.recentResult ?? ''), reference: p.reference ?? null };
          s.capabilityUsageEvents.push(p.eventId); return { recorded: true };
        });
      }
      default: return undefined;
    }
  }
}
