import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function openStore(dataDir, { replaceFile = rename } = {}) {
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
