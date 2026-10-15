export const OPEN_CONVERSATION_CHANGE = 'codebuddy:open-conversation-change';

export interface ConversationChangeTarget {
  sessionId: string;
  turnId?: string;
  filePath?: string;
}

export function openConversationChange(target: ConversationChangeTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_CHANGE, { detail: target }));
}
