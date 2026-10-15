use chrono::{TimeZone, Utc};
use goose::agents::protocol::{
    AgentId, AgentState, EventId, FailureClass, ProtocolVersion, RecoveryAction, RecoveryDecision,
    RunEvent, RunEventPayload, RunId, RunState, TaskFailure, TaskId, TaskResult, TaskState,
    WorkerOutcome,
};
use goose::agents::reporting::RunProjection;
use goose::agents::AgentRole;

fn event(
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    agent_id: Option<&AgentId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(format!("outcome-event-{sequence}")).unwrap();
    RunEvent {
        protocol_version: if sequence < 8 {
            ProtocolVersion::V1
        } else {
            ProtocolVersion::V2
        },
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: agent_id.cloned(),
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 22, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn running_worker_stream() -> (RunId, TaskId, AgentId, Vec<RunEvent>) {
    let run_id = RunId::new("run-worker-outcome").unwrap();
    let task_id = TaskId::new("task-worker-outcome").unwrap();
    let agent_id = AgentId::new("agent-worker-outcome").unwrap();
    let events = vec![
        event(
            &run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "adjudicate worker evidence".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            3,
            Some(&task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "perform bounded work".to_string(),
                role: None,
            },
        ),
        event(
            &run_id,
            4,
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            &run_id,
            5,
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
        event(
            &run_id,
            6,
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::AgentSpawned {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                role: AgentRole::Coder,
            },
        ),
        event(
            &run_id,
            7,
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Starting,
                to: AgentState::Running,
            },
        ),
    ];
    (run_id, task_id, agent_id, events)
}

#[test]
fn accepted_outcome_and_retry_schedule_replay_authoritatively() {
    let (run_id, task_id, agent_id, mut events) = running_worker_stream();
    let failure = TaskFailure {
        class: FailureClass::TransientInfrastructure,
        message: "provider connection reset".to_string(),
        evidence_refs: vec![],
    };
    let outcome = WorkerOutcome::Failed(failure.clone());
    events.extend([
        event(
            &run_id,
            8,
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::TaskOutcomeAccepted {
                task_id: task_id.clone(),
                agent_id: Some(agent_id.clone()),
                outcome: outcome.clone(),
                recovery_decision: Some(outcome.recovery_decision()),
            },
        ),
        event(
            &run_id,
            9,
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Running,
                to: TaskState::WaitingForCoordinator,
            },
        ),
        event(
            &run_id,
            10,
            Some(&task_id),
            None,
            RunEventPayload::TaskRetryScheduled {
                task_id: task_id.clone(),
                attempt: 1,
                delay_ms: 250,
                failure,
            },
        ),
        event(
            &run_id,
            11,
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::WaitingForCoordinator,
                to: TaskState::Ready,
            },
        ),
    ]);

    let projection = RunProjection::rebuild(&events).unwrap();
    let task = &projection.tasks[&task_id];
    assert_eq!(task.latest_outcome, Some(outcome));
    let recovery = task
        .latest_recovery_decision
        .expect("new outcome events persist their recovery decision");
    assert_eq!(recovery.state, RunState::WaitingForEnvironment);
    assert_eq!(recovery.action, RecoveryAction::DiagnoseEnvironment);
    assert!(!recovery.terminal);
    assert_eq!(task.retry_attempts, 1);
    assert_eq!(task.state, TaskState::Ready);
}

#[test]
fn outcome_events_require_v2_exact_scope_and_monotonic_retry_attempts() {
    let (run_id, task_id, agent_id, mut events) = running_worker_stream();
    let outcome = WorkerOutcome::Succeeded(TaskResult {
        summary: "completed with evidence".to_string(),
        evidence_refs: vec![],
    });
    let accepted = event(
        &run_id,
        8,
        Some(&task_id),
        Some(&agent_id),
        RunEventPayload::TaskOutcomeAccepted {
            task_id: task_id.clone(),
            agent_id: Some(agent_id.clone()),
            recovery_decision: Some(outcome.recovery_decision()),
            outcome,
        },
    );
    assert!(accepted.validate().is_ok());

    let mut v1 = accepted.clone();
    v1.protocol_version = ProtocolVersion::V1;
    assert!(v1.validate().is_err());

    let mut wrong_scope = accepted.clone();
    wrong_scope.agent_id = None;
    assert!(wrong_scope.validate().is_err());

    let mut mismatched_recovery = accepted.clone();
    if let RunEventPayload::TaskOutcomeAccepted {
        recovery_decision, ..
    } = &mut mismatched_recovery.payload
    {
        *recovery_decision = Some(RecoveryDecision {
            state: RunState::Fatal,
            action: RecoveryAction::Finish,
            terminal: true,
        });
    }
    assert!(mismatched_recovery.validate().is_err());

    events.push(accepted);
    events.push(event(
        &run_id,
        9,
        Some(&task_id),
        None,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Running,
            to: TaskState::WaitingForCoordinator,
        },
    ));
    events.push(event(
        &run_id,
        10,
        Some(&task_id),
        None,
        RunEventPayload::TaskRetryScheduled {
            task_id: task_id.clone(),
            attempt: 2,
            delay_ms: 250,
            failure: TaskFailure {
                class: FailureClass::TransientInfrastructure,
                message: "retry jumped an attempt".to_string(),
                evidence_refs: vec![],
            },
        },
    ));
    assert!(RunProjection::rebuild(&events).is_err());

    let mut zero_delay = events.pop().unwrap();
    if let RunEventPayload::TaskRetryScheduled { delay_ms, .. } = &mut zero_delay.payload {
        *delay_ms = 0;
    }
    assert!(zero_delay.validate().is_err());
}
