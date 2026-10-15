import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_EVENT_SCHEMA_VERSION,
  isActivityEvent,
  isTerminalActivityEventStatus,
  normalizeActivityEventStatus,
  normalizeActivityEventType,
  parseActivityEvent,
  type ActivityEvent,
} from './activityEvent';

function runningEvent(): ActivityEvent {
  return {
    schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: 'event-0001',
    event_type: 'command_started',
    session_id: 'session-01',
    run_id: 'run-01',
    task_id: 'task-01',
    parent_task_id: null,
    agent_role: 'tester',
    effective_model: 'provider/model',
    status: 'running',
    started_at: '2026-07-30T12:00:00Z',
    finished_at: null,
    title: '运行目标测试',
    technical_details: 'pnpm test:run',
    path: 'ui/desktop',
    command_summary: 'pnpm test:run',
    exit_code: null,
    diff_summary: null,
    include_in_model_context: false,
    retryable: true,
    retry_from_event_id: null,
  };
}

describe('ActivityEvent v1 contract', () => {
  it('preserves host routing evidence without requiring it on legacy events', () => {
    const evidence = {
      schema_version: 1,
      classification_source: 'workspace_constraint',
      classified_intent: 'change',
      semantic_warning: null,
      effective_intent: 'conversation',
      effective_intent_reason: 'tools_explicitly_forbidden',
      goal_source: 'execution_message',
      simple_change_check: 'not_applicable',
      execution_route: 'unified_executor',
    };
    const parsed = parseActivityEvent({
      ...runningEvent(),
      event_type: 'intent_completed',
      routing_evidence: evidence,
    });
    expect(parsed).not.toBeNull();
    expect(JSON.parse(JSON.stringify(parsed)).routing_evidence).toEqual(evidence);
    expect(parseActivityEvent(runningEvent())).not.toBeNull();
    expect(JSON.parse(JSON.stringify(parseActivityEvent(runningEvent())))).not.toHaveProperty(
      'routing_evidence'
    );
  });

  it('uses the same stable wire fields as the Rust contract', () => {
    expect(JSON.parse(JSON.stringify(runningEvent()))).toEqual({
      schema_version: 1,
      event_id: 'event-0001',
      event_type: 'command_started',
      session_id: 'session-01',
      run_id: 'run-01',
      task_id: 'task-01',
      parent_task_id: null,
      agent_role: 'tester',
      effective_model: 'provider/model',
      status: 'running',
      started_at: '2026-07-30T12:00:00Z',
      finished_at: null,
      title: '运行目标测试',
      technical_details: 'pnpm test:run',
      path: 'ui/desktop',
      command_summary: 'pnpm test:run',
      exit_code: null,
      diff_summary: null,
      include_in_model_context: false,
      retryable: true,
      retry_from_event_id: null,
    });
  });

  it('degrades unknown future event types instead of displaying them as known', () => {
    expect(normalizeActivityEventType('future_activity')).toBe('unknown');
    expect(normalizeActivityEventStatus('future_status')).toBe('unknown');
    expect(isTerminalActivityEventStatus('unknown')).toBe(true);
  });

  it('recognizes host strategy events independently from planner events', () => {
    expect(normalizeActivityEventType('strategy_selected')).toBe('strategy_selected');
    expect(normalizeActivityEventType('strategy_updated')).toBe('strategy_updated');
    expect(normalizeActivityEventType('plan_created')).toBe('plan_created');
  });

  it('recognizes stop, failure, cancellation and recovery interruption as terminal', () => {
    expect(isTerminalActivityEventStatus('stopped')).toBe(true);
    expect(isTerminalActivityEventStatus('failed')).toBe(true);
    expect(isTerminalActivityEventStatus('cancelled')).toBe(true);
    expect(isTerminalActivityEventStatus('interrupted')).toBe(true);
    expect(isTerminalActivityEventStatus('running')).toBe(false);
  });

  it('rejects incomplete structured events at the UI boundary', () => {
    expect(isActivityEvent(runningEvent())).toBe(true);
    const { event_type: _eventType, ...withoutEventType } = runningEvent();
    expect(parseActivityEvent(withoutEventType)).toBeNull();
    expect(
      isActivityEvent({
        schema_version: 1,
        event_id: 'event-incomplete',
        session_id: 'session-01',
        run_id: 'run-01',
        started_at: '2026-07-30T12:00:00Z',
      })
    ).toBe(false);
  });

  it('accepts only a closed host failure kind and keeps old v1 events compatible', () => {
    expect(parseActivityEvent(runningEvent())).toMatchObject({ failure_kind: null });
    expect(
      parseActivityEvent({ ...runningEvent(), failure_kind: 'outside_workspace' })
    ).toMatchObject({ failure_kind: 'outside_workspace' });
    expect(parseActivityEvent({ ...runningEvent(), failure_kind: 'future_failure' })).toBeNull();
  });

  it('parses risk topology while failing closed for a future tier', () => {
    expect(
      parseActivityEvent({
        ...runningEvent(),
        event_type: 'plan_created',
        risk_tier: 'l2_feature',
        risk_reasons: ['multi_file_or_unknown_write_scope'],
        selected_roles: ['planner', 'coder', 'tester'],
        review_required: false,
      })
    ).toMatchObject({
      risk_tier: 'l2_feature',
      selected_roles: ['planner', 'coder', 'tester'],
      review_required: false,
    });

    expect(
      parseActivityEvent({
        ...runningEvent(),
        event_type: 'plan_updated',
        risk_tier: 'l4_future',
        previous_risk_tier: 'l3_high_risk_release',
        risk_reasons: ['future_reason'],
        selected_roles: ['planner', 'coder', 'tester', 'reviewer'],
        review_required: true,
      })
    ).toMatchObject({
      risk_tier: 'unknown',
      previous_risk_tier: 'l3_high_risk_release',
      review_required: true,
    });
  });
});
