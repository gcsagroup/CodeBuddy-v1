import type { GooseSessionNotification_unstable } from '@aaif/goose-sdk';
import type { MessageUsage } from '../../types/message';
import { isTerminalActivityEventStatus, parseActivityEvent } from '../../types/activityEvent';
import { parseTestExecutionProgress } from '../../types/testExecutionProgress';
import { parsePublicProgress } from '../../types/publicProgress';
import { parseCompactionLifecycle } from '../../types/compactionLifecycle';
import { parseWorkerUsage } from '../../types/workerUsage';
import { parsePlanContext } from '../../types/codeproPlan';
import { parseResponsePhase } from '../../types/responsePhase';
import {
  getTurnTerminalRecord,
  isTurnTerminalRecord,
  type TurnTerminalRecord,
} from '../../types/turnTerminal';
import { adaptLegacyCodeProActivity } from './legacyCodeProActivityAdapter';
import { type AcpChatStateChange, type AdapterState, isRecord, messagesChange } from './shared';
import type { TokenState } from '../../types/chat';

function liveSpeedState(value: unknown): Partial<TokenState> {
  if (value === null) return { liveSpeed: null };
  if (!isRecord(value) || typeof value.estimated !== 'boolean') return {};
  const rate = value.rate;
  if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return {};
  const estimated = value.estimated;
  if (rate === null) return { liveSpeed: { rate, estimated } };
  const sample = { rate, estimated };
  return { liveSpeed: sample, lastSampledSpeed: sample };
}

function contextSources(update: unknown): Partial<TokenState> {
  const metadata = (
    update as { _meta?: { harness?: { source?: unknown; contextSource?: unknown; sessionStats?: unknown } } }
  )._meta?.harness;
  const source = metadata?.source;
  const capacity = metadata?.contextSource;
  const stats = metadata?.sessionStats;
  return {
    ...(isRecord(stats) && typeof stats.decodeTokens === 'number' && Number.isFinite(stats.decodeTokens) && stats.decodeTokens >= 0 &&
      typeof stats.decodeMs === 'number' && Number.isFinite(stats.decodeMs) && stats.decodeMs >= 0
      ? { sessionStats: { decodeTokens: stats.decodeTokens, decodeMs: stats.decodeMs } } : {}),
    ...(source === 'provider_actual' ||
    source === 'local_estimate' ||
    source === 'streaming_estimate'
      ? { contextUsageSource: source }
      : {}),
    ...(capacity === 'service' ||
    capacity === 'catalog' ||
    capacity === 'configured' ||
    capacity === 'fallback'
      ? { contextCapacitySource: capacity }
      : {}),
  };
}

export function applyGooseSessionNotification(
  state: AdapterState,
  notification: GooseSessionNotification_unstable,
  isSessionReplay = false
): AcpChatStateChange[] {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case 'usage_update':
      return [
        {
          type: 'tokenState',
          tokenState: {
            totalTokens: update.used,
            contextLimit: update.contextLimit,
            ...contextSources(update),
            accumulatedInputTokens: update.accumulatedInputTokens,
            accumulatedOutputTokens: update.accumulatedOutputTokens,
            accumulatedTotalTokens: update.accumulatedInputTokens + update.accumulatedOutputTokens,
            ...(update.accumulatedCost !== undefined
              ? { accumulatedCost: update.accumulatedCost }
              : {}),
          },
        },
      ];
    case 'status_message':
      if (update.status.data && typeof update.status.data === 'object') {
        const meter = update.status.data as Record<string, unknown>;
        if (meter.event === 'live_decode_speed' && meter.schema_version === 1)
          return isSessionReplay ? [] : [{ type: 'tokenState', tokenState: liveSpeedState(meter.liveSpeed) }];
        if (meter.event === 'request_budget' && meter.schema_version === 1) {
          const { model, source, input, output, window } = meter;
          if (typeof model !== 'string' || !model ||
              (source !== 'vllm-tokenizer' && source !== 'pi-ai-estimate-context-tokens') ||
              typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 ||
              typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0 ||
              typeof window !== 'number' || !Number.isSafeInteger(window) || window < 1) return [];
          return [{ type: 'tokenState', tokenState: { requestBudget: { model, source, input, output, window } } }];
        }
        if (
          meter.event === 'context_meter' &&
          meter.schema_version === 1 &&
          Number.isSafeInteger(meter.used) &&
          (meter.used as number) >= 0 &&
          Number.isSafeInteger(meter.contextLimit) &&
          (meter.contextLimit as number) > 0
        ) {
          return [
            {
              type: 'tokenState',
              tokenState: {
                totalTokens: meter.used as number,
                contextLimit: meter.contextLimit as number,
                ...contextSources({ _meta: { harness: meter } }),
                pressureThreshold: typeof meter.pressureThreshold === 'number' &&
                  Number.isSafeInteger(meter.pressureThreshold) && meter.pressureThreshold > 0 &&
                  meter.pressureThreshold <= (meter.contextLimit as number) ? meter.pressureThreshold : undefined,
                ...(!isSessionReplay ? liveSpeedState(meter.liveSpeed) : {}),
              },
            },
          ];
        }
      }
      return applyStatusMessage(state, notification.sessionId, update, isSessionReplay);
    case 'message_usage':
      return applyMessageUsage(state, update, isSessionReplay);
    case 'test_execution_progress':
      return upsertTestExecutionProgress(state, update.progress);
    case 'public_progress':
      return upsertPublicProgress(state, update.progress);
    default:
      return [];
  }
}

function upsertPublicProgress(state: AdapterState, value: unknown): AcpChatStateChange[] {
  const progress = parsePublicProgress(value);
  if (!progress) return [];
  const messageId = `acp_codepro_progress_${progress.runId}_${progress.attemptId}`;
  const content = {
    type: 'systemNotification' as const,
    notificationType: 'codeProActivity' as const,
    msg: progress.summary,
    data: progress,
  };
  const existing = state.messages.find((item) => item.id === messageId);
  if (existing) {
    existing.content = [content];
    existing.created = Math.floor(Date.now() / 1000);
  } else {
    state.messages.push({
      id: messageId,
      role: 'assistant',
      created: Math.floor(Date.now() / 1000),
      content: [content],
      metadata: { userVisible: true, agentVisible: false },
    });
  }
  return messagesChange(state);
}

function upsertTestExecutionProgress(state: AdapterState, value: unknown): AcpChatStateChange[] {
  const progress = parseTestExecutionProgress(value);
  if (!progress) return [];
  const messageId = `acp_codepro_test_${progress.runId}_${progress.attemptId}`;
  const content = {
    type: 'systemNotification' as const,
    notificationType: 'codeProActivity' as const,
    msg: 'CodePro test execution progress',
    data: progress,
  };
  const existing = state.messages.find((item) => item.id === messageId);
  if (existing) {
    existing.content = [content];
    existing.created = Math.floor(Date.now() / 1000);
  } else {
    state.messages.push({
      id: messageId,
      role: 'assistant',
      created: Math.floor(Date.now() / 1000),
      content: [content],
      metadata: { userVisible: true, agentVisible: false },
    });
  }
  return messagesChange(state);
}

function applyStatusMessage(
  state: AdapterState,
  sessionId: string,
  update: Extract<GooseSessionNotification_unstable['update'], { sessionUpdate: 'status_message' }>,
  isSessionReplay: boolean
): AcpChatStateChange[] {
  if (update.status.type === 'progress') {
    const responsePhase = parseResponsePhase(update.status.data);
    if (responsePhase && responsePhase.session_id === sessionId) {
      const id = `acp_response_phase_${responsePhase.event_id}`;
      if (!state.messages.some((message) => message.id === id))
        state.messages.push({
          id,
          role: 'assistant',
          created: responsePhase.created_at,
          content: [
            {
              type: 'systemNotification',
              notificationType: 'progressMessage',
              msg: '',
              data: responsePhase,
            },
          ],
          metadata: { userVisible: true, agentVisible: false },
        });
      return messagesChange(state);
    }
    const planContext = parsePlanContext(update.status.data);
    if (planContext && planContext.session_id === sessionId) {
      const id = `acp_plan_context_${planContext.event_id}`;
      if (!state.messages.some((message) => message.id === id))
        state.messages.push({
          id,
          role: 'assistant',
          created: Date.now() / 1000,
          content: [
            {
              type: 'systemNotification',
              notificationType: 'progressMessage',
              msg: '',
              data: planContext,
            },
          ],
          metadata: { userVisible: true, agentVisible: false },
        });
      return messagesChange(state);
    }
    if (isTurnTerminalRecord(update.status.data)) {
      return upsertTurnTerminal(state, update.status.message, update.status.data, isSessionReplay);
    }

    const compaction = parseCompactionLifecycle(update.status.data);
    if (compaction) {
      const id = `acp_compaction_${compaction.operationId}`;
      const existing = state.messages.find((item) => item.id === id);
      const previous = existing?.content.find((item) => item.type === 'systemNotification');
      const previousLifecycle = parseCompactionLifecycle(previous?.data);
      if (previousLifecycle && previousLifecycle.status !== 'started') return [];
      const content = {
        type: 'systemNotification' as const,
        notificationType: 'progressMessage' as const,
        msg: update.status.message,
        data: update.status.data,
      };
      if (existing) existing.content = [content];
      else
        state.messages.push({
          id,
          role: 'assistant',
          created: Date.now() / 1000,
          content: [content],
          metadata: { userVisible: true, agentVisible: false },
        });
      return [...messagesChange(state), { type: 'compactionLifecycle', lifecycle: compaction }];
    }

    const workerUsage = parseWorkerUsage(update.status.data);
    if (workerUsage) {
      const id = `acp_worker_usage_${workerUsage.runId}_${workerUsage.workerSessionId}`;
      const existing = state.messages.find((item) => item.id === id);
      const msg = `${workerUsage.role} · ${workerUsage.taskId} · ${workerUsage.isCompaction ? '压缩请求' : '最近模型请求'}：输入 ${workerUsage.inputTokens ?? '未知'} / ${workerUsage.contextLimit} token，输出 ${workerUsage.outputTokens ?? '未知'} token。不是累计消耗或父会话占用。`;
      const content = {
        type: 'systemNotification' as const,
        notificationType: 'inlineMessage' as const,
        msg,
        data: update.status.data,
      };
      if (existing) existing.content = [content];
      else
        state.messages.push({
          id,
          role: 'assistant',
          created: Date.now() / 1000,
          content: [content],
          metadata: { userVisible: true, agentVisible: false },
        });
      return messagesChange(state);
    }

    const structuredEvent = parseActivityEvent(update.status.data);
    if (structuredEvent) {
      return upsertCodeProActivity(state, sessionId, update.status.message, structuredEvent);
    }
    if (!update.status.message.trim().startsWith('CodePro')) {
      return [{ type: 'progressMessage', message: update.status.message }];
    }
    if (hasLegacyCodeProActivityId(update.status.message)) {
      return upsertCodeProToolActivity(state, sessionId, update.status.message);
    }
    return [{ type: 'progressMessage', message: update.status.message }];
  }

  const incomplete = update.status.data;
  if (isRecord(incomplete) && incomplete.event === 'managed_turn_result' &&
      typeof incomplete.requestId === 'string' && typeof incomplete.finishedAt === 'string') {
    const id = `managed_turn_result_${incomplete.requestId}`;
    if (state.messages.some(message => message.id === id)) return [];
    state.messages.push({
      id, role: 'assistant', created: Date.parse(incomplete.finishedAt) / 1000,
      content: [{ type: 'systemNotification', notificationType: 'inlineMessage',
        msg: update.status.message, data: incomplete }],
      metadata: { userVisible: true, agentVisible: false },
    });
    return messagesChange(state);
  }
  if (
    isRecord(incomplete) &&
    incomplete.type === 'output_attempt_rejected' &&
    typeof incomplete.message_id === 'string'
  ) {
    const rejected = state.messages.find((message) => message.id === incomplete.message_id);
    if (rejected) {
      // Native retry did not commit this attempt. Retract its provisional
      // content both live and during replay, retaining its usage identity.
      rejected.content = [];
      rejected.metadata = { ...rejected.metadata, userVisible: false, agentVisible: false };
    }
    return messagesChange(state);
  }
  if (
    isRecord(incomplete) &&
    incomplete.type === 'output_attempt_incomplete' &&
    typeof incomplete.message_id === 'string'
  ) {
    const receiptIndex = state.messages.findIndex(
      (message) =>
        message.id === incomplete.message_id &&
        message.content.length === 0 &&
        !!message.metadata.usage
    );
    if (receiptIndex >= 0) {
      const [receipt] = state.messages.splice(receiptIndex, 1);
      receipt.metadata = { ...receipt.metadata };
      delete receipt.metadata.usageUnattributed;
      state.messages.push(receipt);
    }
  }
  state.messages.push({
    id: `acp_status_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    role: 'assistant',
    created: Math.floor(Date.now() / 1000),
    content: [
      {
        type: 'systemNotification',
        notificationType: 'inlineMessage',
        msg: update.status.message,
        data: update.status.data,
      },
    ],
    metadata: {
      userVisible: true,
      agentVisible: false,
    },
  });

  return messagesChange(state);
}

function upsertTurnTerminal(
  state: AdapterState,
  message: string,
  record: TurnTerminalRecord,
  isSessionReplay: boolean
): AcpChatStateChange[] {
  const content = {
    type: 'systemNotification' as const,
    notificationType: 'turnTerminal' as const,
    msg: message,
    data: record,
  };
  const existingById = state.messages.find((item) => item.id === record.terminal_message_id);
  const optimisticCancellation = state.messages.find((item) => {
    const current = getTurnTerminalRecord(item);
    return (
      (record.status === 'cancelled' || (record.status === 'interrupted' && record.user_requested_stop === true)) &&
      record.checkpoint_id === null &&
      current?.status === 'cancelled' &&
      current.checkpoint_id === null &&
      current.session_id === record.session_id &&
      (current.run_id === record.run_id || record.terminal_message_id === 'stopped:' + record.source_user_message_id) &&
      current.source_user_message_id === record.source_user_message_id
    );
  });
  const existing = existingById ?? optimisticCancellation;

  if (existing) {
    if (existing.id !== record.terminal_message_id) {
      existing.id = record.terminal_message_id;
      existing.created = Math.floor(new Date(record.finished_at).getTime() / 1000);
      existing.content = [content];
      existing.metadata = { userVisible: true, agentVisible: false };
    } else {
      existing.content = [
        ...existing.content.filter(
          (item) => item.type !== 'systemNotification' || item.notificationType !== 'turnTerminal'
        ),
        content,
      ];
      if (isSessionReplay) {
        state.messages.splice(state.messages.indexOf(existing), 1);
        state.messages.push(existing);
      }
    }
  } else {
    state.messages.push({
      id: record.terminal_message_id,
      role: 'assistant',
      created: Math.floor(new Date(record.finished_at).getTime() / 1000),
      content: [content],
      metadata: {
        userVisible: true,
        agentVisible: false,
      },
    });
  }

  return messagesChange(state);
}

function hasLegacyCodeProActivityId(message: string): boolean {
  return /^活动ID：.+$/m.test(message);
}

function upsertCodeProToolActivity(
  state: AdapterState,
  sessionId: string,
  message: string
): AcpChatStateChange[] {
  const receivedAt = new Date().toISOString();
  const initialEvent = adaptLegacyCodeProActivity(message, { sessionId, receivedAt });
  if (!initialEvent) {
    return [];
  }

  const messageId = `acp_codepro_activity_${sessionId}_${initialEvent.event_id}`;
  const existing = state.messages.find((item) => item.id === messageId);
  const previousData = existing?.content.find((item) => item.type === 'systemNotification')?.data;
  const previousEvent = parseActivityEvent(previousData);
  const activityEvent = adaptLegacyCodeProActivity(message, {
    sessionId,
    receivedAt,
    previous: previousEvent,
  });
  if (!activityEvent) {
    return [];
  }

  return upsertCodeProActivity(state, sessionId, message, activityEvent);
}

function upsertCodeProActivity(
  state: AdapterState,
  sessionId: string,
  message: string,
  activityEvent: NonNullable<ReturnType<typeof parseActivityEvent>>
): AcpChatStateChange[] {
  const identity =
    activityEvent.tool_call_id === undefined
      ? activityEvent.event_id
      : `${activityEvent.run_id}:tool:${activityEvent.tool_call_id}`;
  const messageId = `acp_codepro_activity_${sessionId}_${identity}`;
  const existing = state.messages.find((item) => item.id === messageId);
  const previous = existing?.content.find((content) => content.type === 'systemNotification');
  const previousEvent =
    previous?.type === 'systemNotification' ? parseActivityEvent(previous.data) : null;
  if (
    previousEvent &&
    isTerminalActivityEventStatus(previousEvent.status) &&
    !isTerminalActivityEventStatus(activityEvent.status)
  )
    return [];
  const content = {
    type: 'systemNotification' as const,
    notificationType: 'codeProActivity' as const,
    msg: message,
    data: activityEvent,
  };

  if (existing) {
    existing.content = [content];
    existing.created = Math.floor(Date.now() / 1000);
  } else {
    state.messages.push({
      id: messageId,
      role: 'assistant',
      created: Math.floor(Date.now() / 1000),
      content: [content],
      metadata: {
        userVisible: true,
        agentVisible: false,
      },
    });
  }

  return messagesChange(state);
}

function applyMessageUsage(
  state: AdapterState,
  update: Extract<GooseSessionNotification_unstable['update'], { sessionUpdate: 'message_usage' }>,
  isSessionReplay: boolean
): AcpChatStateChange[] {
  const usage: MessageUsage = {
    inputTokens: update.usage.inputTokens,
    outputTokens: update.usage.outputTokens,
    totalTokens: update.usage.totalTokens,
    cacheReadTokens: update.usage.cacheReadTokens,
    cacheWriteTokens: update.usage.cacheWriteTokens,
    cost: update.usage.cost,
    costSource: update.usage.costSource,
    elapsedMs: update.usage.elapsedMs,
    timeToFirstTokenMs: update.usage.timeToFirstTokenMs,
    isCompaction: update.usage.isCompaction,
  };

  if (update.messageId) {
    const target = state.messages.find((message) => message.id === update.messageId);
    if (target) {
      target.metadata = { ...target.metadata, usage };
      return messagesChange(state, target);
    }
    // A truncated attempt may have no content. Its host notice still gives
    // an exact receipt identity and an original position in this turn.
    const incompleteIndex = state.messages.findIndex((message) =>
      message.content.some(
        (content) =>
          content.type === 'systemNotification' &&
          isRecord(content.data) &&
          content.data.type === 'output_attempt_incomplete' &&
          content.data.message_id === update.messageId
      )
    );
    // Usage can precede a tool-only message, or belong to internal work with
    // no visible row. Keep its identity for billing; content will reuse it.
    const message = {
      id: update.messageId,
      role: 'assistant' as const,
      created: Math.floor(Date.now() / 1000),
      content: [],
      metadata: {
        userVisible: false,
        agentVisible: false,
        usage,
        // History receipts arrive after all content. Their arrival position
        // cannot identify a turn when the corresponding content is absent.
        ...(isSessionReplay && incompleteIndex < 0 ? { usageUnattributed: true as const } : {}),
      },
    };
    if (incompleteIndex >= 0) state.messages.splice(incompleteIndex, 0, message);
    else state.messages.push(message);
    return messagesChange(state, message, true);
  }

  // Only legacy receipts with no identity may use the last provider message.
  const target = [...state.messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.content.some(
          (content) => content.type !== 'actionRequired' && content.type !== 'systemNotification'
        )
    );
  if (!target) return [];
  target.metadata = { ...target.metadata, usage };
  return messagesChange(state, target);
}
