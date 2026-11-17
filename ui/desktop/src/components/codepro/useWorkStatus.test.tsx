import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { ChatState } from '../../types/chatState';
import { useWorkStatus, selectRunAdvice } from './useWorkStatus';

afterEach(() => vi.useRealTimers());

describe('evidence-based run advice', () => {
  const input = { chatState: ChatState.Thinking, checking: false, activity: {
    promptAttemptId: 'run', sourceUserMessageId: 'user', startedAt: 1_000,
    execution: { phase: 'model' as const, childCount: 0, modelRequestPhase: 'waiting' as const, modelRequestStartedAt: 1_000 },
  } };
  it('uses bounded waiting/generation clocks instead of total task age', () => {
    expect(selectRunAdvice(input, 90_999)).toBeUndefined();
    expect(selectRunAdvice(input, 91_000)).toEqual({ kind: 'waiting', seconds: 90 });
    const receiving = { ...input, activity: { ...input.activity, execution: { ...input.activity.execution, modelRequestPhase: 'receiving' as const } } };
    expect(selectRunAdvice(receiving, 180_999)).toBeUndefined();
    expect(selectRunAdvice(receiving, 181_000)?.kind).toBe('generation');
    expect(selectRunAdvice({ ...input, activity: { ...input.activity, execution: { ...input.activity.execution, modelRequestStartedAt: 180_000 } } }, 181_000)).toBeUndefined();
  });
  it('suppresses notices during approvals, tools, compaction, cancellation and review', () => {
    for (const chatState of [ChatState.Idle, ChatState.Compacting, ChatState.WaitingForUserInput])
      expect(selectRunAdvice({ ...input, chatState }, 999_000)).toBeUndefined();
    for (const override of [{ checking: true }, { cancelling: true }, { action: 'Running tests' }, { toolPending: true }])
      expect(selectRunAdvice({ ...input, ...override }, 999_000)).toBeUndefined();
    expect(selectRunAdvice({ ...input, activity: { ...input.activity, execution: { ...input.activity.execution, childCount: 1 } } }, 999_000)).toBeUndefined();
  });
  it('uses host counters, not model prose, and remains compatible with absent observations', () => {
    expect(selectRunAdvice({ ...input, stage: 'Everything failed' }, 1_001)).toBeUndefined();
    expect(selectRunAdvice({ ...input, activity: { ...input.activity, execution: undefined } }, 999_000)).toBeUndefined();
    for (const [field, kind] of [['consecutiveToolFailures', 'tools'], ['responseRetries', 'responses']] as const) {
      expect(selectRunAdvice({ ...input, activity: { ...input.activity, execution: { ...input.activity.execution, [field]: 3 } } }, 1_001)?.kind).toBe(kind);
    }
  });
});

describe('specific live execution feedback', () => {
  it('recovers the request age on mount and starts a fresh clock on the next model call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(200_000);
    const { result, rerender } = renderHook(({ start, number }) => useWorkStatus({
      chatState: ChatState.Thinking, checking: false, activity: {
        promptAttemptId: 'a', sourceUserMessageId: 'u', startedAt: 1_000,
        execution: { phase: 'model', childCount: 0, modelRequestPhase: 'waiting',
          modelRequestNumber: number, modelRequestStartedAt: start },
      },
    }), { initialProps: { start: 105_000, number: 2 }, wrapper: IntlTestWrapper });
    expect(result.current.message).toContain('1m 35s on this call');
    rerender({ start: 200_000, number: 3 });
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.message).toContain('2s on this call');
  });
  it('shows file preparation without claiming a write, keeps its clock across size updates and respects approval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const input = {
      chatState: ChatState.Streaming,
      checking: false,
      activity: {
        promptAttemptId: 'attempt',
        sourceUserMessageId: 'u',
        startedAt: 100_000,
        receivedAt: 100_000,
        execution: {
          phase: 'model' as const,
          childCount: 0,
          toolInput: { id: 'file', name: 'write', path: 'app.js', kilobytes: 1 },
        },
      },
    };
    const { result, rerender } = renderHook((props) => useWorkStatus(props), {
      initialProps: input,
      wrapper: IntlTestWrapper,
    });
    expect(result.current.message).toContain('Generating file contents app.js');
    act(() => vi.advanceTimersByTime(5000));
    rerender({
      ...input,
      activity: {
        ...input.activity,
        execution: {
          ...input.activity.execution,
          toolInput: { ...input.activity.execution.toolInput, kilobytes: 10 },
        },
      },
    });
    expect(result.current.elapsedSeconds).toBe(5);
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current.hint).toBeUndefined();
    rerender({ ...input, activity: { ...input.activity, receivedAt: Date.now() } });
    expect(result.current.hint).toBeUndefined();
    expect(result.current.elapsedSeconds).toBe(25);
    rerender({ ...input, chatState: ChatState.WaitingForUserInput });
    expect(result.current.message).toBe('Your input is needed');
    rerender({ ...input, chatState: ChatState.Idle });
    expect(result.current.source).toBe('chat_state');
  });
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
    expect(result.current.message).toMatch(/^Waiting for an activity update/);
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
    act(() => vi.advanceTimersByTime(206000));
    expect(result.current.hint).toContain('has not returned content');
    expect(result.current.message).toContain('Waiting for the model service');
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
    expect(result.current.message).toContain('Waiting for the model service');
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
    expect(result.current.message).toBe('Waiting for the model service');
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
    expect(result.current.message).toMatch(/^Waiting for an activity update(?: \d+s)?$/);
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
          activity: {
            promptAttemptId: 'tool',
            sourceUserMessageId: 'user',
            startedAt: 1_000,
            execution: { phase: 'model', childCount: 0, detail: 'Generating tool arguments' },
          },
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
