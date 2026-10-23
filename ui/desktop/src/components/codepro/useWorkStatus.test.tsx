import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { ChatState } from '../../types/chatState';
import { useWorkStatus } from './useWorkStatus';

afterEach(() => vi.useRealTimers());

describe('specific live execution feedback', () => {
  it('uses thinking only for observed model activity, not transport silence', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const base = { chatState: ChatState.Streaming, checking: false };
    const { result, rerender } = renderHook((props) => useWorkStatus(props), {
      initialProps: {
        ...base,
        activity: {
          promptAttemptId: 'a',
          sourceUserMessageId: 'u',
          startedAt: 100_000,
          receivedAt: 100_000,
          kind: 'thought' as const,
        },
      },
      wrapper: IntlTestWrapper,
    });
    expect(result.current.message).toBe('Thinking');
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.message).toMatch(/^Working on your request/);
    rerender({
      ...base,
      chatState: ChatState.WaitingForUserInput,
      activity: {
        promptAttemptId: 'a',
        sourceUserMessageId: 'u',
        startedAt: 100_000,
        receivedAt: Date.now(),
        kind: 'thought' as const,
      },
    });
    expect(result.current.message).toBe('Your input is needed');
  });
  it('renders native reconnection feedback, while long waiting alone never becomes an error', () => {
    vi.useFakeTimers();
    const input = {
      chatState: ChatState.Streaming,
      checking: false,
      activity: {
        promptAttemptId: 'attempt',
        sourceUserMessageId: 'input',
        startedAt: 1,
        execution: {
          phase: 'model' as const,
          childCount: 0,
          modelRequestPhase: 'waiting' as const,
          detail: undefined as string | undefined,
        },
      },
    };
    const { result, rerender } = renderHook((props) => useWorkStatus(props), {
      initialProps: input,
      wrapper: IntlTestWrapper,
    });
    act(() => vi.advanceTimersByTime(600000));
    expect(result.current.message).toContain('Working on your request');
    expect(result.current.message).not.toMatch(/reconnect|error|failed/i);
    rerender({
      ...input,
      activity: {
        ...input.activity,
        execution: { ...input.activity.execution, detail: '连接发生错误；正在重新连接（1/5）' },
      },
    });
    expect(result.current.message).toBe('连接发生错误；正在重新连接（1/5）');
    rerender(input);
    expect(result.current.message).toContain('Working on your request');
  });
  it('shows actual transport stages and keeps approval above transport waiting', () => {
    const input = {
      chatState: ChatState.Streaming,
      checking: false,
      stage: 'Earlier published context',
      activity: {
        promptAttemptId: 'fixture',
        sourceUserMessageId: 'user',
        startedAt: 1,
        execution: {
          phase: 'model' as const,
          childCount: 0,
          modelRequestPhase: 'waiting' as const,
        },
      },
    };
    const { result, rerender } = renderHook((props) => useWorkStatus(props), {
      initialProps: input,
      wrapper: IntlTestWrapper,
    });
    expect(result.current.message).toBe('Working on your request');
    rerender({ ...input, chatState: ChatState.WaitingForUserInput });
    expect(result.current.message).toBe('Your input is needed');
  });
  it('returns to processing after output pauses and resumes writing when text arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const input = {
      chatState: ChatState.Streaming,
      checking: false,
      activity: {
        promptAttemptId: 'fixture',
        sourceUserMessageId: 'user',
        startedAt: Date.now(),
        receivedAt: Date.now(),
        kind: 'text' as const,
      },
    };
    const { result, rerender } = renderHook((props) => useWorkStatus(props), {
      initialProps: input,
      wrapper: IntlTestWrapper,
    });
    expect(result.current.message).toBe('Writing a response');
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.message).toMatch(/^Working on your request(?: \d+s)?$/);
    rerender({ ...input, activity: { ...input.activity, receivedAt: Date.now() } });
    expect(result.current.message).toBe('Writing a response');
    expect(result.current.source).toBe('text');
  });

  it('keeps the real child wait target during a long period without main-chat text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const input = {
      chatState: ChatState.Streaming,
      checking: false,
      activity: {
        promptAttemptId: 'fixture',
        sourceUserMessageId: 'input',
        startedAt: 1_000,
        receivedAt: 1_000,
        kind: 'thought' as const,
        execution: { phase: 'children' as const, childCount: 2 },
      },
    };
    const { result } = renderHook(() => useWorkStatus(input), { wrapper: IntlTestWrapper });
    act(() => vi.advanceTimersByTime(69_000));
    expect(result.current.message).toBe('2 assistants are working 69s');
    expect(result.current.source).toBe('children');
  });

  it('identifies returned child results without claiming verification or completion', () => {
    const { result } = renderHook(
      () =>
        useWorkStatus({
          chatState: ChatState.Streaming,
          checking: false,
          activity: {
            promptAttemptId: 'fixture',
            sourceUserMessageId: 'input',
            startedAt: 1,
            execution: { phase: 'child_result', childCount: 0 },
          },
        }),
      { wrapper: IntlTestWrapper }
    );
    expect(result.current.message).toBe('Bringing the results together');
  });

  it('keeps a real pending tool visible instead of inventing model or completion status', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { result } = renderHook(
      () =>
        useWorkStatus({
          chatState: ChatState.Streaming,
          checking: false,
          action: 'Running fixture command',
          toolPending: true,
          activity: { promptAttemptId: 'tool', sourceUserMessageId: 'user', startedAt: 1_000 },
        }),
      { wrapper: IntlTestWrapper }
    );
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current.message).toBe('Running fixture command 20s');
    expect(result.current.source).toBe('tool');
  });

  it('keeps approval and cancellation statuses authoritative during long silence', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook((props) => useWorkStatus(props), {
      initialProps: { chatState: ChatState.Streaming, checking: false, cancelling: true },
      wrapper: IntlTestWrapper,
    });
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current.message).toContain('Stopping the current operation');
    rerender({ chatState: ChatState.WaitingForUserInput, checking: false, cancelling: false });
    expect(result.current.message).toBe('Your input is needed');
  });
});
