use chrono::{TimeZone, Utc};
use goose::agents::protocol::{
    AgentId, AgentState, EventId, ProtocolVersion, RunEvent, RunEventPayload, RunId, RunState,
    TaskId, TaskState,
};
use goose::agents::reporting::RunProjection;
use goose::agents::workers::{
    OutcomeAdmission, OutcomeSuppression, RegistryError, WorkerRegistry, WorkerRuntimeState,
    WorkerTerminalState,
};
use goose::agents::AgentRole;

fn event(
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    agent_id: Option<&AgentId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(format!("registry-event-{sequence}")).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: agent_id.cloned(),
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 15, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn projection(task_state: TaskState, agent_state: AgentState) -> RunProjection {
    let run_id = RunId::new("run-registry").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let mut events = vec![
        event(
            &run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "test worker registry".to_string(),
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
                name: "registry task".to_string(),
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
    if agent_state != AgentState::Running {
        events.push(event(
            &run_id,
            8,
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Running,
                to: agent_state,
            },
        ));
    }
    if task_state != TaskState::Running {
        let sequence = events.len() as u64 + 1;
        events.push(event(
            &run_id,
            sequence,
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Running,
                to: task_state,
            },
        ));
    }
    RunProjection::rebuild(&events).unwrap()
}

#[test]
fn registry_owns_exact_generation_token_and_processes() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-registry").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_1 = AgentId::new("agent-1").unwrap();
    let agent_2 = AgentId::new("agent-2").unwrap();

    let first = registry
        .register(run_id.clone(), Some(task_id.clone()), agent_1.clone())
        .unwrap();
    let second = registry
        .register(run_id.clone(), Some(task_id), agent_2)
        .unwrap();
    assert_eq!(first.generation(), 1);
    assert!(!registry.cancellation_token(&first).unwrap().is_cancelled());
    assert!(matches!(
        registry.register(run_id, None, agent_1),
        Err(RegistryError::DuplicateLiveWorker { .. })
    ));

    registry.register_process(&first, 1001).unwrap();
    registry.register_process(&first, 1002).unwrap();
    assert!(matches!(
        registry.register_process(&first, 0),
        Err(RegistryError::InvalidProcessId)
    ));

    let stop = registry.request_stop(&first).unwrap();
    assert!(stop.newly_cancelled);
    assert_eq!(stop.process_ids, vec![1001, 1002]);
    assert!(registry.cancellation_token(&first).unwrap().is_cancelled());
    assert!(!registry.cancellation_token(&second).unwrap().is_cancelled());
    assert_eq!(
        registry.state(&first).unwrap(),
        WorkerRuntimeState::Stopping
    );

    registry.register_process(&first, 1003).unwrap();
    let repeated = registry.request_stop(&first).unwrap();
    assert!(!repeated.newly_cancelled);
    assert_eq!(repeated.process_ids, vec![1001, 1002, 1003]);
}

#[test]
fn terminal_generation_can_be_replaced_but_stale_handle_loses_authority() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-registry").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let old = registry
        .register(run_id.clone(), Some(task_id.clone()), agent_id.clone())
        .unwrap();
    registry
        .mark_terminal(&old, WorkerTerminalState::Stopped)
        .unwrap();

    let replacement = registry.register(run_id, Some(task_id), agent_id).unwrap();
    assert_eq!(replacement.generation(), 2);
    assert!(matches!(
        registry.register_process(&old, 2001),
        Err(RegistryError::StaleGeneration { .. })
    ));
    assert!(matches!(
        registry.request_stop(&old),
        Err(RegistryError::StaleGeneration { .. })
    ));
    assert_eq!(
        registry.admit_outcome(&old, &projection(TaskState::Running, AgentState::Running)),
        OutcomeAdmission::Suppressed(OutcomeSuppression::StaleGeneration)
    );
    assert_eq!(
        registry.admit_outcome(
            &replacement,
            &projection(TaskState::Running, AgentState::Running)
        ),
        OutcomeAdmission::Accepted
    );
}

#[test]
fn stopping_terminal_and_cancelled_task_outcomes_are_suppressed() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-registry").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let handle = registry
        .register(run_id.clone(), Some(task_id), agent_id)
        .unwrap();
    let active = projection(TaskState::Running, AgentState::Running);
    assert_eq!(
        registry.admit_outcome(&handle, &active),
        OutcomeAdmission::Accepted
    );
    assert_eq!(
        registry.admit_outcome(
            &handle,
            &projection(TaskState::Running, AgentState::Stopping)
        ),
        OutcomeAdmission::Suppressed(OutcomeSuppression::WorkerStopping)
    );

    registry.request_stop(&handle).unwrap();
    assert_eq!(
        registry.admit_outcome(&handle, &active),
        OutcomeAdmission::Suppressed(OutcomeSuppression::WorkerStopping)
    );
    registry
        .mark_terminal(&handle, WorkerTerminalState::Stopped)
        .unwrap();
    assert_eq!(
        registry.admit_outcome(&handle, &active),
        OutcomeAdmission::Suppressed(OutcomeSuppression::WorkerTerminal)
    );

    let other_agent = AgentId::new("agent-2").unwrap();
    let cancelled_handle = registry
        .register(run_id, Some(TaskId::new("task-1").unwrap()), other_agent)
        .unwrap();
    assert_eq!(
        registry.admit_outcome(
            &cancelled_handle,
            &projection(TaskState::Cancelled, AgentState::Running)
        ),
        OutcomeAdmission::Suppressed(OutcomeSuppression::TaskTerminal)
    );
}

#[test]
fn admission_rejects_foreign_projection_and_unknown_handle() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-registry").unwrap();
    let handle = registry
        .register(
            run_id,
            Some(TaskId::new("task-1").unwrap()),
            AgentId::new("agent-1").unwrap(),
        )
        .unwrap();
    let mut foreign = projection(TaskState::Running, AgentState::Running);
    foreign.run_id = RunId::new("run-foreign").unwrap();
    assert_eq!(
        registry.admit_outcome(&handle, &foreign),
        OutcomeAdmission::Suppressed(OutcomeSuppression::RunMismatch)
    );

    let unknown_registry = WorkerRegistry::new();
    assert_eq!(
        unknown_registry.admit_outcome(
            &handle,
            &projection(TaskState::Running, AgentState::Running)
        ),
        OutcomeAdmission::Suppressed(OutcomeSuppression::UnknownWorker)
    );
}

#[test]
fn outcome_claim_is_atomic_releasable_and_generation_bound() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-registry").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let handle = registry.register(run_id, Some(task_id), agent_id).unwrap();
    let active = projection(TaskState::Running, AgentState::Running);

    let first = registry.claim_outcome(&handle, &active).unwrap();
    assert_eq!(
        registry.state(&handle).unwrap(),
        WorkerRuntimeState::CommittingOutcome
    );
    assert_eq!(
        registry.claim_outcome(&handle, &active),
        Err(OutcomeSuppression::OutcomeCommitting)
    );

    registry.release_outcome(first).unwrap();
    assert_eq!(registry.state(&handle).unwrap(), WorkerRuntimeState::Active);
    let second = registry.claim_outcome(&handle, &active).unwrap();
    registry.finalize_outcome(second).unwrap();
    assert_eq!(
        registry.state(&handle).unwrap(),
        WorkerRuntimeState::Stopped
    );
    assert_eq!(
        registry.claim_outcome(&handle, &active),
        Err(OutcomeSuppression::WorkerTerminal)
    );
}

#[test]
fn cancellation_wins_a_runtime_race_with_an_uncommitted_outcome_claim() {
    let registry = WorkerRegistry::new();
    let run_id = RunId::new("run-registry").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let handle = registry.register(run_id, Some(task_id), agent_id).unwrap();
    let claim = registry
        .claim_outcome(
            &handle,
            &projection(TaskState::Running, AgentState::Running),
        )
        .unwrap();

    assert!(registry.request_stop(&handle).unwrap().newly_cancelled);
    assert!(matches!(
        registry.finalize_outcome(claim),
        Err(RegistryError::OutcomeLostRace { .. })
    ));
    assert_eq!(
        registry.state(&handle).unwrap(),
        WorkerRuntimeState::Stopping
    );
}
