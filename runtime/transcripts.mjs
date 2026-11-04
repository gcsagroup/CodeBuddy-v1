import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const version = 1;
const identity = (sessionId, turnId) => createHash('sha256').update(JSON.stringify([sessionId, turnId])).digest('hex');

function requireId(value, field) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${field} is required`);
}

function readRecords(text, file) {
  // append() commits a record with its newline. A torn final write has no commit
  // delimiter and is ignored; corruption in an earlier complete record is surfaced.
  const lines = text.split('\n');
  lines.pop();
  const records = lines.map((line) => JSON.parse(line));
  if (!records.length) return [];
  const first = records[0];
  requireId(first.sessionId, 'sessionId');
  requireId(first.turnId, 'turnId');
  for (const [i, record] of records.entries()) {
    if (record.version !== version || record.sessionId !== first.sessionId || record.turnId !== first.turnId || record.seq !== i + 1 || (i === 0 ? record.kind !== 'begin' || !Array.isArray(record.users) : !['update', 'usage'].includes(record.kind))) {
      throw new Error(`Invalid transcript journal record ${i + 1}: ${file}`);
    }
  }
  if (first.title !== undefined && typeof first.title !== 'string') throw new TypeError('Transcript title must be text');
  return records;
}

/** Durable ACP projection only. Harness remains the execution-history owner. */
export async function openTranscriptJournal(store) {
  if (typeof store?.directory !== 'string' || typeof store?.updateSession !== 'function' || typeof store?.read !== 'function') throw new TypeError('A persistent session runtime store is required');
  const directory = join(store.directory, 'transcript-journal');
  await mkdir(directory, { recursive: true });
  const writers = new Map();
  const unsettled = new Map();

  async function project(records) {
    if (!records.length) return undefined;
    const first = records[0], last = records.at(-1);
    return store.updateSession(first.sessionId, (session) => {
      session.transcriptTurns ??= {};
      const key = identity(first.sessionId, first.turnId);
      const prior = session.transcriptTurns[key];
      const previousSeq = prior?.seq ?? 0;
      if (previousSeq >= last.seq) return { sessionId: first.sessionId, turnId: first.turnId, updates: 0, usageUpdates: 0, duplicate: true };
      session.updates ??= [];
      session.usageUpdates ??= [];
      let updates = 0, usageUpdates = 0;
      for (const record of records) {
        if (record.seq <= previousSeq) continue;
        if (record.kind === 'begin') { session.updates.push(...record.users); updates += record.users.length; }
        if (record.kind === 'update') { session.updates.push(record.update); updates += 1; }
        if (record.kind === 'usage') { session.usageUpdates.push(record.update); usageUpdates += 1; }
      }
      const messageCount = Number(first.users.length > 0) + Number(records.some((record) => record.kind === 'update'));
      session.messageCount = (session.messageCount ?? 0) + messageCount - (prior?.messageCount ?? 0);
      session.updatedAt = last.createdAt;
      if (first.title && !session.userSetName && session.title === 'New Session') session.title = first.title;
      // The high water mark and projected chunks share the store's atomic commit.
      // If removal fails or the process dies here, replay does not duplicate them.
      session.transcriptTurns[key] = { turnId: first.turnId, seq: last.seq, messageCount };
      return { sessionId: first.sessionId, turnId: first.turnId, updates, usageUpdates, duplicate: false };
    }, { durable: true });
  }

  async function settle(file, records) {
    const result = await project(records);
    await unlink(file);
    return result;
  }

  const pending = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.ndjson$/.test(entry.name)) continue;
    const file = join(directory, entry.name);
    const records = readRecords(await readFile(file, 'utf8'), file);
    if (records.length && entry.name !== `${identity(records[0].sessionId, records[0].turnId)}.ndjson`) throw new Error(`Transcript journal identity does not match its file: ${file}`);
    pending.push({ file, records });
  }
  pending.sort((a, b) => (a.records[0]?.createdAt ?? '').localeCompare(b.records[0]?.createdAt ?? ''));
  const recovered = [];
  for (const { file, records } of pending) {
    const result = await settle(file, records);
    if (result) recovered.push(result);
  }

  return {
    directory,
    recovered,
    async begin({ sessionId, turnId = randomUUID(), users = [], title } = {}) {
      requireId(sessionId, 'sessionId');
      requireId(turnId, 'turnId');
      if (!Array.isArray(users)) throw new TypeError('Transcript users must be an array');
      if (title !== undefined && typeof title !== 'string') throw new TypeError('Transcript title must be text');
      if (writers.has(sessionId)) throw new Error(`A transcript turn is already active for ${sessionId}`);
      const key = identity(sessionId, turnId);
      const file = join(directory, `${key}.ndjson`);
      const records = [];
      let tail = Promise.resolve(), finalization;
      writers.set(sessionId, key);
      let handle;
      const write = (fields) => {
        const json = JSON.stringify(fields);
        const work = tail.then(async () => {
          const record = { ...JSON.parse(json), version, sessionId, turnId, seq: records.length + 1, createdAt: new Date().toISOString() };
          await handle.writeFile(`${JSON.stringify(record)}\n`);
          await handle.sync();
          records.push(record);
        });
        tail = work;
        work.catch(() => {});
        return work;
      };
      try {
        // A failed atomic snapshot leaves the durable journal authoritative.
        // Project it before admitting a later turn, preserving transcript order.
        const previous = unsettled.get(sessionId);
        if (previous) {
          await settle(previous.file, previous.records);
          unsettled.delete(sessionId);
        }
        const session = store.readSession ? store.readSession(sessionId) : store.read(['sessions']).sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error(`Transcript session is missing: ${sessionId}`);
        if (session.transcriptTurns?.[key]) throw new Error(`Transcript turn was already finalized: ${turnId}`);
        handle = await open(file, 'wx', 0o600);
        await write({ kind: 'begin', users, ...(title === undefined ? {} : { title }) });
      } catch (error) {
        await handle?.close().catch(() => {});
        writers.delete(sessionId);
        throw error;
      }
      const append = (kind, update) => {
        if (finalization) return Promise.reject(new Error('Transcript turn is finalizing'));
        if (!update || typeof update !== 'object' || Array.isArray(update)) return Promise.reject(new TypeError('Transcript update must be an object'));
        return write({ kind, update });
      };
      return {
        sessionId, turnId,
        append(update) { return append('update', update); },
        appendUsage(update) { return append('usage', update); },
        finalize() {
          if (!finalization) {
            finalization = (async () => {
              let settled = false;
              try {
                await tail;
                await handle.close();
                const result = await settle(file, records);
                settled = true;
                return result;
              } finally {
                await handle.close().catch(() => {});
                if (!settled) unsettled.set(sessionId, { file, records });
                writers.delete(sessionId);
              }
            })();
            finalization.catch(() => {});
          }
          return finalization;
        },
      };
    },
  };
}
