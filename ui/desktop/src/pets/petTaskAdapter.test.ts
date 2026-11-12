import { describe, expect, it } from 'vitest';
import { petTaskFromSnapshot } from './petTaskAdapter';
import type { AcpChatSessionSnapshot } from '../acp/chatSessionStore';
import { ChatState } from '../types/chatState';

describe('pet task observer', () => {
  const snapshot = { messages: [], chatState: ChatState.Idle } as unknown as AcpChatSessionSnapshot;
  it('shows an admitted background run before its first chat update', () => {
    const running = { ...snapshot, activeRunId: 'live', completedPromptAttemptId: 'previous' };
    expect(petTaskFromSnapshot('child', running).state).toBe('working');
    expect(petTaskFromSnapshot('child', { ...running, chatState: ChatState.WaitingForUserInput }).state).toBe('input');
  });
  it('identifies the main task from session metadata even when another chat has the same title', () => {
    const session = { name: '主对话' } as NonNullable<AcpChatSessionSnapshot['session']>;
    const working = { ...snapshot, chatState: ChatState.Thinking, session };
    expect(petTaskFromSnapshot('ordinary', working).globalConversation).toBeUndefined();
    expect(petTaskFromSnapshot('main', {
      ...working, session: { ...session, global_conversation: true },
    })).toMatchObject({ globalConversation: true, state: 'working' });
  });
  it('identifies a new running conversation before its first turn is named and preserves user titles', () => {
    const pending = {
      ...snapshot,
      session: { name: 'New Session', user_set_name: false },
      messages: [
        { id: 'u', role: 'user', content: [{ type: 'text', text: 'Build my weather app' }] },
      ],
      chatState: ChatState.Streaming,
    } as unknown as AcpChatSessionSnapshot;
    expect(petTaskFromSnapshot('new', pending).title).toBe('新对话');
    expect(
      petTaskFromSnapshot('new', {
        ...pending,
        session: { ...pending.session!, user_set_name: true },
      }).title
    ).toBe('New Session');
  });
  it('reads structured input/work/error states and ignores message text', () => {
    expect(
      petTaskFromSnapshot('a', { ...snapshot, chatState: ChatState.WaitingForUserInput }).state
    ).toBe('input');
    expect(petTaskFromSnapshot('a', { ...snapshot, chatState: ChatState.Streaming }).state).toBe(
      'working'
    );
    expect(petTaskFromSnapshot('a', { ...snapshot, promptError: 'network' }).state).toBe('blocked');
    expect(
      petTaskFromSnapshot('a', {
        ...snapshot,
        messages: [
          { id: 'a', role: 'assistant', content: [{ type: 'text', text: '任务已经完成，failed' }] },
        ] as AcpChatSessionSnapshot['messages'],
      }).state
    ).toBe('idle');
  });
  it('shows the actual pending question, never an old question or a phrase in model prose', () => {
    const waiting = {
      ...snapshot,
      chatState: ChatState.WaitingForUserInput,
      pendingInputRequestIds: ['elicitation:current'],
      messages: [
        {
          id: 'm',
          role: 'assistant',
          content: [
            {
              type: 'actionRequired',
              data: { actionType: 'elicitation', id: 'old', message: 'Old question' },
            },
            {
              type: 'actionRequired',
              data: {
                actionType: 'elicitation',
                id: 'current',
                message: 'What color should the rabbit be?',
              },
            },
          ],
        },
      ],
    } as unknown as AcpChatSessionSnapshot;
    expect(petTaskFromSnapshot('a', waiting).inputRequest).toEqual({
      kind: 'question',
      summary: 'What color should the rabbit be?',
    });
    expect(
      petTaskFromSnapshot('a', {
        ...waiting,
        chatState: ChatState.Streaming,
        pendingInputRequestIds: [],
      }).inputRequest
    ).toBeUndefined();
  });
  it('shows only live tool activity and gives stopping precedence without inventing progress', () => {
    const working = {
      ...snapshot,
      chatState: ChatState.Streaming,
      activeToolCallIds: ['live'],
      messages: [
        {
          id: 'm',
          role: 'assistant',
          created: 0,
          metadata: { agentVisible: true, userVisible: true },
          content: [
            {
              type: 'toolRequest',
              id: 'old',
              toolCall: { status: 'success', value: { name: 'old_tool', arguments: {} } },
            },
            {
              type: 'toolRequest',
              id: 'live',
              toolCall: {
                status: 'success',
                value: { name: 'read', arguments: { path: 'README.md' } },
              },
            },
          ],
        },
      ],
    } as AcpChatSessionSnapshot;
    expect(petTaskFromSnapshot('a', working).activity).toEqual({ kind: 'tool', toolName: 'read' });
    expect(petTaskFromSnapshot('a', { ...working, activeToolCallIds: [] }).activity).toEqual({
      kind: 'waiting',
    });
    expect(
      petTaskFromSnapshot('a', { ...working, pendingCancelPromptAttemptId: 'cancel' }).activity
        ?.kind
    ).toBe('stopping');
    expect(
      petTaskFromSnapshot('a', { ...working, chatState: ChatState.WaitingForUserInput }).activity
    ).toBeUndefined();
  });
});
