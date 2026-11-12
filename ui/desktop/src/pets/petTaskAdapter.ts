import type { AcpChatSessionSnapshot } from '../acp/chatSessionStore';
import { ChatState } from '../types/chatState';
import { isTurnTerminalRecord } from '../types/turnTerminal';
import type { PetTask } from './petTypes';
import { getToolRequests } from '../types/message';
import { presentedToolCall } from '../components/codepro/CodeProToolContent';
import { currentWorkStage } from '../components/codepro/currentWorkStage';
import { petPermissionRequest } from '../acp/permissionRequests';

export function petTaskFromSnapshot(sessionId: string, snapshot: AcpChatSessionSnapshot): PetTask {
  const name = snapshot.session?.name;
  const title =
    !name || (!snapshot.session?.user_set_name && name === 'New Session')
      ? '新对话'
      : name;
  const task: PetTask = {
    sessionId, title, state: 'idle',
    ...(snapshot.session?.global_conversation && { globalConversation: true }),
  };
  if (snapshot.chatState === ChatState.WaitingForUserInput || snapshot.workspaceReconfirmation) {
    const pending = new Set(snapshot.pendingInputRequestIds ?? []);
    const request = snapshot.messages
      .flatMap((m) => m.content)
      .find(
        (c) =>
          c.type === 'actionRequired' &&
          ((c.data.actionType === 'elicitation' && pending.has(`elicitation:${c.data.id}`)) ||
            (c.data.actionType === 'toolConfirmation' && pending.has(`permission:${c.data.id}`)))
      );
    const data = request?.type === 'actionRequired' ? request.data : undefined;
    const permission = data?.actionType === 'toolConfirmation' ? petPermissionRequest(sessionId, data.id) : undefined;
    return {
      ...task,
      state: 'input',
      inputRequest: snapshot.workspaceReconfirmation
        ? { kind: 'workspace' }
        : data?.actionType === 'elicitation'
          ? { kind: 'question', summary: data.message.slice(0, 240) }
          : data?.actionType === 'toolConfirmation'
            ? { kind: 'permission', summary: (data.prompt || data.toolName).slice(0, 240), ...(permission ? { permission: {
                ...permission, choices: permission.choices.filter(choice => data.availableActions?.includes(choice.action as import('../types/message').ToolPermissionAction)),
                details: `${data.toolName}\n${data.prompt ?? ''}\n${JSON.stringify(data.arguments, null, 2)}`,
              } } : {}) }
            : undefined,
    };
  }
  if (snapshot.promptError || snapshot.sessionLoadError) return { ...task, state: 'blocked' };
  if (
    [
      ChatState.Thinking,
      ChatState.Streaming,
      ChatState.Compacting,
      ChatState.RestartingAgent,
    ].includes(snapshot.chatState) || (snapshot.chatState === ChatState.Idle && !!snapshot.activeRunId)
  ) {
    const active = new Set(snapshot.activeToolCallIds ?? []);
    const request = snapshot.messages.flatMap(getToolRequests).find((item) => active.has(item.id));
    const call = request && presentedToolCall(request);
    const stage = snapshot.promptActivity
      ? currentWorkStage(snapshot.messages, snapshot.promptActivity.sourceUserMessageId)
      : undefined;
    return {
      ...task,
      state: 'working',
      activity: {
        kind: snapshot.pendingCancelPromptAttemptId
          ? 'stopping'
          : snapshot.chatState === ChatState.Compacting
            ? 'compacting'
            : snapshot.chatState === ChatState.RestartingAgent
              ? 'starting'
              : call
                ? 'tool'
                : snapshot.thinkingActivity
                  ? 'thinking'
                  : snapshot.promptActivity?.kind === 'text'
                    ? 'responding'
                    : 'waiting',
        ...(call ? { toolName: call.name } : {}),
        ...(stage ? { stage } : {}),
      },
    };
  }
  if (snapshot.completedPromptAttemptId) {
    return { ...task, state: 'completed', terminalId: snapshot.completedPromptAttemptId };
  }
  for (const message of [...snapshot.messages].reverse()) {
    for (const content of message.content) {
      if (
        content.type !== 'systemNotification' ||
        content.notificationType !== 'turnTerminal' ||
        !isTurnTerminalRecord(content.data)
      )
        continue;
      const terminal = content.data;
      return {
        ...task,
        terminalId: terminal.terminal_message_id,
        state:
          terminal.status === 'completed'
            ? 'completed'
            : terminal.status === 'failed' || terminal.status === 'interrupted'
              ? 'blocked'
              : 'idle',
      };
    }
  }
  return task;
}
