import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export async function openStore(dataDir, { replaceFile = rename, onTiming } = {}) {
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
  }
  let tail = Promise.resolve();
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
    // Select before cloning: one active chat must not copy every saved transcript.
    readSession: (id) => snapshot(state.sessions.find(session => session.id === id), ['sessions']),
    update(fn, keys) {
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
          const draft = structuredClone(roots === undefined ? state
            : Object.fromEntries(roots.map(key => [key, state[key]])));
          measure('clone_ms');
          const value = await fn(draft);
          const next = roots === undefined ? draft : { ...state };
          if (roots !== undefined) {
            if (Object.keys(draft).some(key => !roots.includes(key)))
              throw new TypeError('Store update wrote outside its selected roots');
            for (const key of roots) {
              if (Object.hasOwn(draft, key)) next[key] = draft[key];
              else delete next[key];
            }
          }
          measure('mutation_ms');
          const tmp = file + "." + randomUUID() + ".tmp";
          // This is a machine-owned snapshot, not an edited configuration file.
          // Avoid rewriting indentation for every historical message on each turn.
          const serialized = JSON.stringify(next) + "\n";
          measure('serialize_ms');
          await writeFile(tmp, serialized, { mode: 0o600 });
          measure('write_ms');
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
          measure('replace_ms');
          state = next;
          committed = true;
          return value;
        } finally {
          // Diagnostics cannot change admission, atomic publication or errors.
          const loop = performance.eventLoopUtilization(utilization);
          report({
            operation: 'commit', roots: roots ?? null,
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
    },
    flush: () => tail,
  };
}
