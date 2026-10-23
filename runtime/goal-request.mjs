// UI actions are structured requests. Natural-language messages never select
// a goal transition; the official goal service remains its sole state owner.
export function parseGoalRequest(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid goal request');
  if (value.action === 'create') {
    if (typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 16000) throw new TypeError('Goal objective must contain 1–16000 characters');
    if (value.maxGoalRounds !== undefined && (!Number.isSafeInteger(value.maxGoalRounds) || value.maxGoalRounds < 1 || value.maxGoalRounds > 1000)) throw new TypeError('Goal round limit must be between 1 and 1000');
    return { action: 'create', objective: value.objective.trim(), ...(value.maxGoalRounds !== undefined ? { maxGoalRounds: value.maxGoalRounds } : {}) };
  }
  if (!['resume', 'pause', 'edit', 'clear'].includes(value.action) || typeof value.goalId !== 'string' || !value.goalId || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new TypeError('Invalid goal action or revision');
  if (value.action === 'edit' && (typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 16000)) throw new TypeError('Goal objective must contain 1–16000 characters');
  return { action: value.action, goalId: value.goalId, revision: value.revision, ...(value.action === 'edit' ? { objective: value.objective.trim() } : {}) };
}
