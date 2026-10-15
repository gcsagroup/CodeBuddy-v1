import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildForkSeed, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';

/** Public Harness factories own the immutable fork and its new sandbox root. */
export async function forkWorkingDirectory(ctx, agent, workingDir, { signal, selection, isBusy } = {}) {
  if (typeof workingDir !== 'string' || !isAbsolute(workingDir)) throw Object.assign(new TypeError('Working directory must be an absolute path'), { code: -32602 });
  const checkIdle = () => {
    signal?.throwIfAborted();
    if (agent.status !== 'idle' || isBusy?.()) throw new Error('Stop the active session operation before changing its working directory');
  };
  checkIdle();
  if (agent.session.header.origin === 'subagent') throw new Error('A delegated agent cannot change its project directory');
  if (agent.session.header.agentPreset) throw new Error('Working-directory forks of preset-composed sessions require preset composition support');
  const target = await ctx.fs.resolve(workingDir, { signal });
  if ((await ctx.fs.stat(target, signal))?.type !== 'directory') throw Object.assign(new Error('Working directory must be an existing directory'), { code: -32602 });
  const cwd = ctx.fs.processPath(target), previousCwd = ctx.workingDirectory.get(agent.session);
  checkIdle();
  if (cwd === previousCwd) return { sessionId: agent.id, cwd, previousCwd };
  const events = agent.session.snapshotEvents(), count = events.length;
  const seed = count ? buildForkSeed(events, SessionSeq(count - 1)) : [];
  const sessionId = `session-${randomUUID()}`;
  const handle = await ctx.agents.create({ sessionId, seed, inheritedEventCount: SessionLogOffset(count),
    meta: { cwd, parentSession: agent.id, isSeeded: true }, agentOptions: selection, signal });
  try {
    checkIdle();
    if (agent.session.snapshotEvents().length !== count) throw new Error('Source session changed while preparing the new working directory');
    // An inherited directory-change event takes precedence over the new header.
    // Reconcile it through its official owner rather than editing the seed.
    await ctx.workingDirectory.set(handle.agent, cwd, signal);
    await ctx.sessions.flush(handle.agent.session);
    return { sessionId, cwd, previousCwd };
  } catch (error) { await handle.dispose(); throw error; }
}
