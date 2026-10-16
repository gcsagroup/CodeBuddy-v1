export const OPEN_SUBAGENT_CONVERSATION = 'codebuddy:open-subagent-conversation';
export const OPEN_SUBAGENT_CATALOG = 'codebuddy:open-subagent-catalog';

export function openSubagentCatalog(parentSessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_CATALOG, { detail: { parentSessionId } }));
}

export interface SubagentConversationTarget {
  parentSessionId: string;
  childSessionId: string;
  title: string;
  ancestorSessionIds?: string[];
}

export function openSubagentConversation(target: SubagentConversationTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_CONVERSATION, { detail: target }));
}
