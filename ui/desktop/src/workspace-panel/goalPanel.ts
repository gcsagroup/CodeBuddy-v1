export const OPEN_GOAL_EDITOR = 'codebuddy:open-goal-editor';
export const GOAL_CHANGED = 'codebuddy:goal-changed';

export function openGoalEditor(sessionId: string) {
  window.dispatchEvent(new CustomEvent(OPEN_GOAL_EDITOR, { detail: { sessionId } }));
}

export function notifyGoalChanged(sessionId: string) {
  window.dispatchEvent(new CustomEvent(GOAL_CHANGED, { detail: { sessionId } }));
}
