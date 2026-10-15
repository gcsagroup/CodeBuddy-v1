export const OPEN_SUBAGENT_CONVERSATION = 'codebuddy:open-subagent-conversation';

export interface SubagentConversationTarget {
  parentSessionId: string;
  childSessionId: string;
  title: string;
}

export function openSubagentConversation(target: SubagentConversationTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_CONVERSATION, { detail: target }));
}
