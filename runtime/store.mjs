import { openSessionDeletionJournal } from './session-deletion-journal.mjs';
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

function* writeChunks(chunks) {
  const limit = 1024 * 1024;
  let pending = [];
  let size = 0;
  for (const chunk of chunks) {
    if (size && size + chunk.length > limit) {
      yield Buffer.concat(pending, size);
      pending = [];
      size = 0;
    }
    if (chunk.length >= limit) {
      yield chunk;
    } else {
      pending.push(chunk);
      size += chunk.length;
    }
  }
  if (size) yield Buffer.concat(pending, size);
}

export async function openStore(dataDir, { replaceFile = rename, defaultModel, onTiming, replaceDeletionFile } = {}) {
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
        models: [...new Set([defaultModel.modelId, defaultModel.visionModelId].filter(Boolean))], contextWindows: { [defaultModel.modelId]: defaultModel.contextWindow },
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
        visionRoute: defaultModel.visionModelId
          ? { enabled: true, mode: 'auto', providerId: defaultModel.providerId, modelId: defaultModel.visionModelId }
          : { enabled: true, mode: 'auto', ...state.defaults },
      };
      if (defaultModel.imageInput === true) {
        state.modelCapabilities = { version: 1, overrides: [
          { ...state.defaults, imageInput: 'force_supported' },
        ] };
      }
    }
  }
  const deletions = await openSessionDeletionJournal(dataDir, { replaceFile: replaceDeletionFile });
  const liveState = () => {
    if (!deletions.size) return state;
    const sessions = state.sessions.filter(session => !deletions.has(session.id));
    return sessions.length === state.sessions.length ? state : { ...state, sessions };
  };
  let tail = Promise.resolve();
  let serializedRoots = new Map();
  // Keys are committed session objects; writers and readers receive copies.
  let serializedSessions = new Map();
  const sessionVersions = new WeakMap();
  let nextSessionVersion = 0;
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
  const update = (fn, keys, { sessionId, insertingSession, pruningSessions, skipUnchanged } = {}) => {
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
        const base = liveState();
        const index = sessionId === undefined ? -1 : base.sessions.findIndex(session => session.id === sessionId);
        if (sessionId !== undefined && index === -1) throw new Error(`Transcript session is missing: ${sessionId}`);
        const draft = insertingSession || pruningSessions ? undefined : structuredClone(sessionId !== undefined ? base.sessions[index]
          : roots === undefined ? base : Object.fromEntries(roots.map(key => [key, base[key]])));
        measure('clone_ms');
        const value = await fn(draft);
        const next = roots === undefined ? draft : { ...base };
        if (pruningSessions) {
          next.sessions = base.sessions;
        } else if (insertingSession) {
          if (typeof value?.id !== 'string' || !value.id || (deletions.has(value.id) || base.sessions.some(session => session.id === value.id)))
            throw new TypeError('New session must have a unique identity');
          next.sessions = [...base.sessions, structuredClone(value)];
        } else if (sessionId !== undefined) {
          if (draft.id !== sessionId) throw new TypeError('Store session update changed its identity');
          // The writer may retain its draft or return a nested value. Neither
          // reference may mutate the committed session behind the byte cache.
          const committedSession = structuredClone(draft);
          next.sessions = base.sessions.map((session, i) => i === index ? committedSession : session);
        } else if (roots !== undefined) {
          if (Object.keys(draft).some(key => !roots.includes(key)))
            throw new TypeError('Store update wrote outside its selected roots');
          for (const key of roots) {
            if (Object.hasOwn(draft, key)) next[key] = draft[key];
            else delete next[key];
          }
          // Startup recovery often finds nothing to repair. Compare only its
          // selected roots, inside the commit queue, before encoding history.
          if (skipUnchanged && roots.every(key => isDeepStrictEqual(next[key], base[key]))) {
            return value;
          }
        }
        if (deletions.size) {
          const visible = next.sessions.filter(session => !deletions.has(session.id));
          if (visible.length !== next.sessions.length) next.sessions = visible;
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
          const cached = roots !== undefined && !roots.includes(key) && !(key === 'sessions' && next.sessions !== state.sessions)
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
            // A rename protects readers, but cannot preserve an unflushed file
            // across a system crash. Every replacement contains configuration
            // and history, even when this caller changed only one small root.
            // Batch small cached fragments to avoid a filesystem write per
            // session or separator. Large cached buffers need no extra copy.
            await writeFile(tmp, writeChunks(serialized), { mode: 0o600, flush: true });
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
    // Ephemeral cache token: changes only when a new committed object is published.
    // Failed writes cannot invalidate readers; no state is persisted or exposed.
    sessionVersion(id) {
      const session = deletions.has(id) ? undefined : state.sessions.find(session => session.id === id);
      if (!session) return undefined;
      if (!sessionVersions.has(session)) sessionVersions.set(session, ++nextSessionVersion);
      return sessionVersions.get(session);
    },
    // Settings requests must not clone every conversation and tool receipt.
    // Both forms return detached snapshots of the last committed state.
    read: (keys, { sessionFields, runFields, runSessionId, runId } = {}) => {
      const base = liveState();
      let selected = keys === undefined ? base
        : Object.fromEntries(keys.map(key => [key, base[key]]));
      if (sessionFields) selected = { ...selected, sessions: selected.sessions.map(session =>
        Object.fromEntries(sessionFields.map(key => [key, session[key]]))) };
      if (keys?.includes('codeproRuns') && (runFields || runSessionId !== undefined || runId !== undefined)) {
        let runs = selected.codeproRuns ?? [];
        if (runSessionId !== undefined) runs = runs.filter(run => run.sessionId === runSessionId);
        if (runId !== undefined) runs = runs.filter(run => run.runId === runId);
        selected = { ...selected, codeproRuns: runFields ? runs.map(run =>
          Object.fromEntries(runFields.map(key => [key, run[key]]))) : runs };
      }
      return snapshot(selected, keys);
    },
    readSession: (id, { fields } = {}) => {
      const session = deletions.has(id) ? undefined : state.sessions.find(session => session.id === id);
      return snapshot(session === undefined || fields === undefined ? session
        : Object.fromEntries(fields.map(key => [key, session[key]])), ['sessions']);
    },
    update: (fn, keys, { skipUnchanged = false } = {}) => update(fn, keys, { skipUnchanged }),
    // Session projection joins the same commit queue; it cannot see or mutate
    // other conversations, and still replaces the same complete JSON snapshot.
    // Keep the former options argument compatible; all commits are now durable.
    updateSession(id, fn, _options = {}) {
      if (typeof id !== 'string' || !id.length) return Promise.reject(new TypeError('Session id is required'));
      return update(fn, ['sessions'], { sessionId: id });
    },
    // The factory runs in the same durable commit queue. It can read current
    // metadata for uniqueness checks without copying unrelated transcripts.
    insertSession(create) {
      return update(create, ['sessions'], { insertingSession: true });
    },
    pendingSessionDeletions: () => deletions.list(),
    isSessionDeleted: id => deletions.has(id),
    async acceptSessionDeletion(id) {
      if (typeof id !== 'string' || !id) throw new TypeError('Session id is required');
      const existing = deletions.list().find(record => record.id === id);
      if (existing) return existing;
      const session = state.sessions.find(session => session.id === id);
      if (!session) return undefined;
      const started = performance.now();
      const record = await deletions.accept({ version: 1, id,
        nativeSessionId: session.nativeSessionId ?? id, acceptedAt: new Date().toISOString() });
      report({ operation: 'session_delete_accept', session_id: id, elapsed_ms: Math.round(performance.now() - started) });
      return record;
    },
    async finishSessionDeletion(id) {
      if (!deletions.has(id)) return;
      // No transcript clone: retain the byte cache of every surviving session.
      await update(() => {}, ['sessions'], { pruningSessions: true });
      await deletions.finish(id);
    },
    flush: async () => { await tail; await deletions.flush(); },
  };
}
