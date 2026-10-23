import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function openStore(dataDir, { replaceFile = rename, defaultModel } = {}) {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "state.json");
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    if (state.version !== 1) throw Error("Unsupported preview data version");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = {
      version: 1,
      defaults: { providerId: null, modelId: null },
      providers: [],
      config: {},
      preferences: {},
      revision: 0,
      sessions: [],
      extensions: [],
    };
    if (defaultModel) {
      const url = new URL(defaultModel.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          typeof defaultModel.modelId !== 'string' || !defaultModel.modelId.trim() ||
          !/^custom_[a-z0-9_]+$/.test(defaultModel.providerId) ||
          !Number.isSafeInteger(defaultModel.contextWindow) || defaultModel.contextWindow <= 0) {
        throw Error('Invalid distribution model configuration');
      }
      state.providers.push({
        id: defaultModel.providerId, engine: 'openai', displayName: 'CodeBuddy LAN',
        apiUrl: defaultModel.baseUrl, basePath: null, requiresAuth: false,
        models: [defaultModel.modelId], contextWindows: { [defaultModel.modelId]: defaultModel.contextWindow },
        supportsStreaming: true, preservesThinking: true, catalogProviderId: null,
        secret: null, headersProtected: null,
      });
      const additionalProviders = defaultModel.additionalProviders ?? [];
      if (!Array.isArray(additionalProviders)) throw Error('Invalid distribution providers');
      for (const preset of additionalProviders) {
        const fields = ['providerId', 'displayName', 'engine', 'baseUrl', 'requiresAuth', 'models'];
        if (!preset || Object.keys(preset).some(key => !fields.includes(key)) ||
            !/^custom_[a-z0-9_]+$/.test(preset.providerId) ||
            state.providers.some(provider => provider.id === preset.providerId) ||
            typeof preset.displayName !== 'string' || !preset.displayName.trim() ||
            !['openai_compatible', 'ollama_compatible'].includes(preset.engine) ||
            typeof preset.requiresAuth !== 'boolean' ||
            !Array.isArray(preset.models) || !preset.models.length ||
            !preset.models.every(model => typeof model === 'string' && model.trim()) ||
            new Set(preset.models).size !== preset.models.length) {
          throw Error('Invalid distribution provider configuration');
        }
        const endpoint = new URL(preset.baseUrl);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
          throw Error('Invalid distribution provider endpoint');
        // Distribution presets contain metadata only; credentials are user-owned.
        state.providers.push({
          id: preset.providerId, engine: preset.engine, displayName: preset.displayName,
          apiUrl: preset.baseUrl, basePath: null, requiresAuth: preset.requiresAuth,
          models: [...preset.models], supportsStreaming: true, preservesThinking: true,
          catalogProviderId: null, secret: null, headersProtected: null,
        });
      }
      state.defaults = { providerId: defaultModel.providerId, modelId: defaultModel.modelId };
      state.modelRouting = {
        version: 2, advancedRoutingEnabled: false, routes: [], maxParallelCoders: 1,
        visionRoute: { enabled: true, mode: 'auto', ...state.defaults },
      };
      if (defaultModel.imageInput === true) {
        state.modelCapabilities = { version: 1, overrides: [
          { ...state.defaults, imageInput: 'force_supported' },
        ] };
      }
    }
  }
  let tail = Promise.resolve();
  return {
    directory: path.resolve(dataDir),
    // Settings requests must not clone every conversation and tool receipt.
    // Both forms return detached snapshots of the last committed state.
    read: (keys) => structuredClone(keys === undefined
      ? state
      : Object.fromEntries(keys.map(key => [key, state[key]]))),
    // Select before cloning: one active chat must not copy every saved transcript.
    readSession: (id) => structuredClone(state.sessions.find(session => session.id === id)),
    update(fn) {
      const result = tail.then(async () => {
        const next = structuredClone(state);
        const value = await fn(next);
        const tmp = file + "." + randomUUID() + ".tmp";
        // This is a machine-owned snapshot, not an edited configuration file.
        // Avoid rewriting indentation for every historical message on each turn.
        await writeFile(tmp, JSON.stringify(next) + "\n", {
          mode: 0o600,
        });
        try {
          for (let attempt = 0; ; attempt++) {
            try { await replaceFile(tmp, file); break; }
            catch (error) {
              // Windows readers and scanners can briefly hold the destination.
              // Retry only the atomic replace; never delete the existing state.
              if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 6) throw error;
              await delay(Math.min(20 * 2 ** attempt, 200));
            }
          }
        } catch (error) {
          await unlink(tmp).catch(() => {});
          throw error;
        }
        state = next;
        return value;
      });
      tail = result.catch(() => {});
      return result;
    },
    flush: () => tail,
  };
}
