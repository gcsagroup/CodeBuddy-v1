// An unsent, window-local choice. The Host resolves the ID when it creates the
// conversation; this draft is never an active role or a permission snapshot.
export const NEXT_CHAT_AGENT_CHANGED = 'codebuddy:next-chat-agent-changed';
let nextAgentId: string | null = null;

export function getNextChatAgent(): string | null { return nextAgentId; }
export function setNextChatAgent(id: string | null): void {
  nextAgentId = id;
  window.dispatchEvent(new Event(NEXT_CHAT_AGENT_CHANGED));
}
export function consumeNextChatAgent(id: string | null): void {
  if (nextAgentId === id) setNextChatAgent(null);
}
