import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

class UnchangedCheckpoint extends Error {}

// Compatibility guard for 0.2.1-alpha.2. A large retained unit can leave only
// the prior checkpoint in the upstream-selected head. Re-summarizing that head
// before each tool step pays for no new facts and can progressively erode them.
// Keep selection, balancing, transaction, retry and overflow policy upstream.
export default class CompactionEngine extends BasicCompactionEngine {
  pressureAttempts = new WeakMap();

  async compactIfNeeded(agent, trigger, signal) {
    if (trigger !== 'pressure') return super.compactIfNeeded(agent, trigger, signal);
    const attempt = { result: null };
    this.pressureAttempts.set(agent, attempt);
    try { return await super.compactIfNeeded(agent, trigger, signal); }
    catch (error) {
      if (error instanceof UnchangedCheckpoint) return attempt.result;
      throw error;
    } finally { this.pressureAttempts.delete(agent); }
  }

  async compactRegion(start, end, agent, signal) {
    signal?.throwIfAborted();
    const attempt = this.pressureAttempts.get(agent);
    const event = start === end ? agent.session.eventAt(start) : undefined;
    if (attempt && event?.type === 'user/message' && event.data.source?.kind === 'compact-checkpoint')
      throw new UnchangedCheckpoint();
    const result = await super.compactRegion(start, end, agent, signal);
    if (attempt) attempt.result = result;
    return result;
  }
}
