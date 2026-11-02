import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export async function openStore(dataDir, { replaceFile = rename, defaultModel, onTiming } = {}) {
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
  let serializedRoots = new Map();
  // Keys are committed session objects; writers and readers receive copies.
  let serializedSessions = new Map();
  const report = (measurement) => {
    try { Promise.resolve(onTiming?.(measurement)).catch(() => {}); } catch {}
  };
  const snapshot = (value, keys) => {
    const started = performance.now();
    const result = structuredClone(value);
    const elapsed = Math.round(performance.now() - started);
    if (elapsed >= 50) report({ operation: 'read', at_ms: Date.now(), elapsed_ms: elapsed, roots: keys ?? null });
    return result;
  };
  const update = (fn, keys, sessionId, durable = false) => {
    const queuedAt = Date.now(), queued = performance.now();
    // A scoped draft never exposes unchanged history to its writer. All
    // updates still share the same queue and atomically replace one snapshot.
    const roots = keys === undefined ? undefined : [...keys];
    const result = tail.then(async () => {
      const started = performance.now();
      const utilization = performance.eventLoopUtilization();
      let previous = started, committed = false;
      const phases = {};
      const measure = (name) => {
        const now = performance.now();
        phases[name] = Math.round(now - previous);
        previous = now;
      };
      try {
        const index = sessionId === undefined ? -1 : state.sessions.findIndex(session => session.id === sessionId);
        if (sessionId !== undefined && index === -1) throw new Error(`Transcript session is missing: ${sessionId}`);
        const draft = structuredClone(sessionId !== undefined ? state.sessions[index]
          : roots === undefined ? state : Object.fromEntries(roots.map(key => [key, state[key]])));
        measure('clone_ms');
        const value = await fn(draft);
        const next = roots === undefined ? draft : { ...state };
        if (sessionId !== undefined) {
          if (draft.id !== sessionId) throw new TypeError('Store session update changed its identity');
          // The writer may retain its draft or return a nested value. Neither
          // reference may mutate the committed session behind the byte cache.
          const committedSession = structuredClone(draft);
          next.sessions = state.sessions.map((session, i) => i === index ? committedSession : session);
        } else if (roots !== undefined) {
          if (Object.keys(draft).some(key => !roots.includes(key)))
            throw new TypeError('Store update wrote outside its selected roots');
          for (const key of roots) {
            if (Object.hasOwn(draft, key)) next[key] = draft[key];
            else delete next[key];
          }
        }
        measure('mutation_ms');
        const tmp = file + "." + randomUUID() + ".tmp";
        // Unselected roots still belong to the last committed snapshot. Reuse
        // their UTF-8 bytes rather than re-encoding every old image and message.
        // An unscoped write invalidates all roots; failed writes publish no cache.
        const encoded = new Map();
        let sessionBytes = serializedSessions;
        const serialized = [Buffer.from('{')];
        for (const key of Object.keys(next)) {
          const cached = roots !== undefined && !roots.includes(key)
            ? serializedRoots.get(key) : undefined;
          let bytes = cached;
          if (!bytes && key === 'sessions' && Array.isArray(next.sessions)) {
            bytes = [Buffer.from('"sessions":[')];
            sessionBytes = new Map();
            for (const [i, session] of next.sessions.entries()) {
              if (i) bytes.push(Buffer.from(','));
              const item = serializedSessions.get(session) ?? Buffer.from(JSON.stringify(session) ?? 'null');
              bytes.push(item);
              sessionBytes.set(session, item);
            }
            bytes.push(Buffer.from(']'));
          } else if (!bytes) {
            const json = JSON.stringify(next[key]);
            bytes = json === undefined ? undefined : [Buffer.from(`${JSON.stringify(key)}:${json}`)];
            if (key === 'sessions') sessionBytes = new Map();
          }
          if (bytes === undefined) continue;
          if (encoded.size) serialized.push(Buffer.from(','));
          for (const chunk of bytes) serialized.push(chunk);
          encoded.set(key, bytes);
        }
        serialized.push(Buffer.from('}\n'));
        measure('serialize_ms');
        try {
          try {
            // Final transcript projection must reach disk before its journal
            // is removed. Sync the temporary file and close it inside this
            // queue, rather than opening the destination alongside another write.
            await writeFile(tmp, serialized, { mode: 0o600, flush: durable });
          } finally {
            measure('write_ms');
          }
          const replaceStarted = performance.now();
          const retryBudgetMs = process.platform === 'win32' ? 5000 : 700;
          let attempts = 0;
          try {
            for (;;) {
              attempts++;
              try { await replaceFile(tmp, file); break; }
              catch (error) {
                // Retry only this atomic replacement. A reader may outlive the
                // previous 700ms window; permanent locks still fail in bounded time.
                const remaining = retryBudgetMs - (performance.now() - replaceStarted);
                if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || remaining <= 0) throw error;
                await delay(Math.min(20 * 2 ** (attempts - 1), 200, remaining));
              }
            }
          } finally {
            phases.replace_attempts = attempts;
            measure('replace_ms');
          }
        } catch (error) {
          await unlink(tmp).catch(() => {});
          throw error;
        }
        state = next;
        serializedRoots = encoded;
        serializedSessions = sessionBytes;
        committed = true;
        return value;
      } finally {
        // Diagnostics cannot change admission, atomic publication or errors.
        const loop = performance.eventLoopUtilization(utilization);
        report({
          operation: 'commit', roots: roots ?? null,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
          queued_at_ms: queuedAt, at_ms: Date.now(),
          queued_ms: Math.round(started - queued),
          elapsed_ms: Math.round(performance.now() - started),
          event_loop_active_ms: Math.round(loop.active), event_loop_idle_ms: Math.round(loop.idle),
          ...phases, committed,
        });
      }
    });
    tail = result.catch(() => {});
    return result;
  };
  return {
    directory: path.resolve(dataDir),
    // Settings requests must not clone every conversation and tool receipt.
    // Both forms return detached snapshots of the last committed state.
    read: (keys, { sessionFields } = {}) => {
      let selected = keys === undefined ? state
        : Object.fromEntries(keys.map(key => [key, state[key]]));
      if (sessionFields) selected = { ...selected, sessions: selected.sessions.map(session =>
        Object.fromEntries(sessionFields.map(key => [key, session[key]]))) };
      return snapshot(selected, keys);
    },
    readSession: (id, { fields } = {}) => {
      const session = state.sessions.find(session => session.id === id);
      return snapshot(session === undefined || fields === undefined ? session
        : Object.fromEntries(fields.map(key => [key, session[key]])), ['sessions']);
    },
    update: (fn, keys) => update(fn, keys),
    // Session projection joins the same commit queue; it cannot see or mutate
    // other conversations, and still replaces the same complete JSON snapshot.
    updateSession(id, fn, { durable = false } = {}) {
      if (typeof id !== 'string' || !id.length) return Promise.reject(new TypeError('Session id is required'));
      return update(fn, ['sessions'], id, durable);
    },
    flush: () => tail,
  };
}
