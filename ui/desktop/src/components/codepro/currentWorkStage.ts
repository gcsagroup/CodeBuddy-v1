import { getToolRequests, getToolResponses, type Message } from '../../types/message';
import { isProgressTool, presentedToolCall } from './CodeProToolContent';
import { getResponsePhase } from '../../types/responsePhase';
import { getTurnTerminalRecord } from '../../types/turnTerminal';

// Match the most recent returned action by receipt order (parallel tools can
// finish out of order). A return is not proof of success or current execution.
export function latestReturnedAction(messages: Message[], sourceId: string) {
  const start = messages.findIndex(m => m.id === sourceId);
  if (start < 0) return undefined;
  let returnedId: string | undefined;
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (getTurnTerminalRecord(message) || (i > start && message.role === 'user' &&
        message.metadata.userVisible && !message.metadata.steer && message.content.some(c => c.type === 'text'))) break;
    if (!returnedId) {
      const responses = getToolResponses(message);
      returnedId = responses[responses.length - 1]?.id;
    }
    if (!returnedId) continue;
    const request = getToolRequests(message).find(item => item.id === returnedId);
    if (request) return presentedToolCall(request);
  }
  return undefined;
}

// Public presentation only: never use a stage title to infer execution state.
export function currentWorkStage(
  messages: Message[],
  sourceUserMessageId?: string
): string | undefined {
  if (sourceUserMessageId !== undefined) {
    const boundary = messages.findIndex((message) => message.id === sourceUserMessageId);
    if (boundary < 0) return undefined;
    messages = messages.slice(boundary);
  }
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message.role === 'user' &&
      message.metadata.userVisible &&
      !message.metadata.steer &&
      message.content.some((content) => content.type === 'text')
    ) {
      start = index;
      break;
    }
  }
  const current = messages.slice(start);
  // A formal answer/terminal is an existing presentation boundary, never inferred from prose.
  if (
    current.some((message) => {
      const boundary = getResponsePhase(message) ?? getTurnTerminalRecord(message);
      return (
        boundary &&
        (!sourceUserMessageId || boundary.source_user_message_id === sourceUserMessageId)
      );
    })
  )
    return undefined;
  const responses = new Map(
    current.flatMap(getToolResponses).map((response) => [response.id, response])
  );
  for (const request of current.flatMap(getToolRequests).reverse()) {
    const call = presentedToolCall(request);
    // This is the last published context, not the currently executing action.
    // The live UI scopes it to an active prompt and prioritizes host waiting/terminal states.
    if (!call || !isProgressTool(call.name)) continue;
    const result = responses.get(request.id)?.toolResult;
    const value =
      result?.value && typeof result.value === 'object'
        ? (result.value as Record<string, unknown>)
        : result;
    if (!value || result?.status === 'error' || value.isError === true) return undefined;
    const structured = value.structuredContent as Record<string, unknown> | undefined;
    const stage = structured?.published === true ? structured.stage : undefined;
    // An update without a stage ends the previous stage instead of leaving a stale title.
    return typeof stage === 'string' && stage.trim() && [...stage].length <= 100
      ? stage.trim()
      : undefined;
  }
  return undefined;
}
