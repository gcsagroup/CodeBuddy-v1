use chrono::{TimeZone, Utc};
use goose::agents::protocol::{
    AgentId, AgentState, EventId, FailureClass, ProtocolVersion, RunEvent, RunEventPayload, RunId,
    RunState, TaskFailure, TaskId, TaskState,
};
use goose::agents::reporting::{
    ProjectionDifference, ProjectionReconciliation, MAX_PROJECTION_RECONCILIATION_BYTES,
    PROJECTION_RECONCILIATION_FILE_NAME,
};
use goose::agents::reporting::{ProjectionError, RunProjection};
use goose::agents::{AgentRole, CodeProRunStatus, CodeProStateStore};
use std::time::{Duration, Instant};

fn event(
    run_id: &RunId,
    sequence: u64,
    event_id: &str,
    task_id: Option<&TaskId>,
    agent_id: Option<&AgentId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(event_id).unwrap();
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
            .with_ymd_and_hms(2026, 8, 5, 3, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn started(run_id: &RunId, sequence: u64, event_id: &str) -> RunEvent {
    event(
        run_id,
        sequence,
        event_id,
        None,
        None,
        RunEventPayload::RunStarted {
            goal: "build deterministic projections".to_string(),
        },
    )
}

fn independent_lifecycle_stream() -> Vec<RunEvent> {
    let run_id = RunId::new("run-projection-1").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    vec![
        started(&run_id, 1, "event-1"),
        event(
            &run_id,
            2,
            "event-2",
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
            "event-3",
            Some(&task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "implement store".to_string(),
                role: None,
            },
        ),
        event(
            &run_id,
            4,
            "event-4",
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
            "event-5",
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
            6,
            "event-6",
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Starting,
                to: AgentState::Running,
            },
        ),
        event(
            &run_id,
            7,
            "event-7",
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
            8,
            "event-8",
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Running,
                to: AgentState::Crashed,
            },
        ),
        event(
            &run_id,
            9,
            "event-9",
            Some(&task_id),
            None,
            RunEventPayload::TaskFailed {
                task_id: task_id.clone(),
                failure: TaskFailure {
                    class: FailureClass::Implementation,
                    message: "worker crashed after writing invalid code".to_string(),
                    evidence_refs: vec![],
                },
            },
        ),
        event(
            &run_id,
            10,
            "event-10",
            None,
            None,
            RunEventPayload::RunFailed {
                class: FailureClass::Implementation,
                message: "no recovery candidate remained".to_string(),
                evidence_refs: vec![],
            },
        ),
    ]
}

#[test]
fn replay_is_deterministic_and_lifecycles_are_independent() {
    let events = independent_lifecycle_stream();

    let first = RunProjection::rebuild(&events).unwrap();
    let second = RunProjection::rebuild(&events).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.state, RunState::Failed);
    assert_eq!(first.last_sequence, 10);
    assert_eq!(
        first.tasks[&TaskId::new("task-1").unwrap()].state,
        TaskState::Failed
    );
    assert_eq!(
        first.agents[&AgentId::new("agent-1").unwrap()].state,
        AgentState::Crashed
    );

    let before_task_failure = RunProjection::rebuild(&events[..8]).unwrap();
    assert_eq!(before_task_failure.state, RunState::Running);
    assert_eq!(
        before_task_failure.tasks[&TaskId::new("task-1").unwrap()].state,
        TaskState::Running
    );
    assert_eq!(
        before_task_failure.agents[&AgentId::new("agent-1").unwrap()].state,
        AgentState::Crashed
    );
}

#[test]
fn replay_rejects_invalid_order_identity_and_references() {
    let run_id = RunId::new("run-invalid").unwrap();
    let task_id = TaskId::new("task-missing").unwrap();

    let missing_start = event(
        &run_id,
        1,
        "event-1",
        Some(&task_id),
        None,
        RunEventPayload::TaskCreated {
            task_id: task_id.clone(),
            name: "not allowed first".to_string(),
            role: None,
        },
    );
    assert!(matches!(
        RunProjection::rebuild(&[missing_start]).unwrap_err(),
        ProjectionError::FirstEventMustStartRun
    ));

    assert!(matches!(
        RunProjection::rebuild(&[
            started(&run_id, 1, "event-1"),
            started(&run_id, 2, "event-2")
        ])
        .unwrap_err(),
        ProjectionError::RunAlreadyStarted
    ));

    let unknown_task = event(
        &run_id,
        2,
        "event-2",
        Some(&task_id),
        None,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Proposed,
            to: TaskState::Ready,
        },
    );
    assert!(matches!(
        RunProjection::rebuild(&[started(&run_id, 1, "event-1"), unknown_task]).unwrap_err(),
        ProjectionError::UnknownTask(_)
    ));

    let foreign = RunId::new("run-foreign").unwrap();
    assert!(matches!(
        RunProjection::rebuild(&[
            started(&run_id, 1, "event-1"),
            started(&foreign, 2, "event-2")
        ])
        .unwrap_err(),
        ProjectionError::RunMismatch { .. }
    ));

    assert!(matches!(
        RunProjection::rebuild(&[
            started(&run_id, 1, "event-1"),
            started(&run_id, 3, "event-3")
        ])
        .unwrap_err(),
        ProjectionError::SequenceGap {
            expected: 2,
            actual: 3
        }
    ));

    assert!(matches!(
        RunProjection::rebuild(&[
            started(&run_id, 1, "event-1"),
            started(&run_id, 2, "event-1")
        ])
        .unwrap_err(),
        ProjectionError::DuplicateEvent(_)
    ));
}

#[test]
fn replay_rejects_invalid_transitions_unknown_agents_and_post_terminal_events() {
    let mut events = independent_lifecycle_stream();
    let run_id = events[0].run_id.clone();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-missing").unwrap();

    let unknown_agent = event(
        &run_id,
        4,
        "event-4x",
        Some(&task_id),
        Some(&agent_id),
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Starting,
            to: AgentState::Running,
        },
    );
    assert!(matches!(
        RunProjection::rebuild(&[
            events[0].clone(),
            events[1].clone(),
            events[2].clone(),
            unknown_agent
        ])
        .unwrap_err(),
        ProjectionError::UnknownAgent(_)
    ));

    let mut invalid_transition = events[..4].to_vec();
    invalid_transition[3] = event(
        &run_id,
        4,
        "event-4",
        Some(&task_id),
        None,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Ready,
            to: TaskState::Running,
        },
    );
    assert!(matches!(
        RunProjection::rebuild(&invalid_transition).unwrap_err(),
        ProjectionError::StateMismatch { .. }
    ));

    events.push(event(
        &run_id,
        11,
        "event-11",
        None,
        None,
        RunEventPayload::LegacyActivityObserved {
            kind: "tool_completed".to_string(),
            status: "completed".to_string(),
            title: "too late".to_string(),
        },
    ));
    assert!(matches!(
        RunProjection::rebuild(&events).unwrap_err(),
        ProjectionError::RunIsTerminal(RunState::Failed)
    ));
}

#[test]
fn replay_accepts_only_the_explicit_cancelled_run_recovery_transition() {
    let run_id = RunId::new("run-projection-cancelled-resume").unwrap();
    let task_id = TaskId::new("desktop-acceptance").unwrap();
    let events = vec![
        started(&run_id, 1, "event-1"),
        event(
            &run_id,
            2,
            "event-2",
            Some(&task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "desktop acceptance".to_string(),
                role: Some(AgentRole::Tester),
            },
        ),
        event(
            &run_id,
            3,
            "event-3",
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
            4,
            "event-4",
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            5,
            "event-5",
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
            "event-6",
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Running,
                to: TaskState::Cancelled,
            },
        ),
        event(
            &run_id,
            7,
            "event-7",
            None,
            None,
            RunEventPayload::RunCancelled {
                reason: "Prompt cancelled by the user".to_string(),
            },
        ),
        event(
            &run_id,
            8,
            "event-8",
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Cancelled,
                to: RunState::Recovering,
            },
        ),
        event(
            &run_id,
            9,
            "event-9",
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Cancelled,
                to: TaskState::Paused,
            },
        ),
    ];

    let projection = RunProjection::rebuild(&events).unwrap();
    assert_eq!(projection.state, RunState::Recovering);
    assert_eq!(projection.tasks[&task_id].state, TaskState::Paused);
}

#[test]
fn discarded_projection_rebuilds_identically_from_events() {
    let events = independent_lifecycle_stream();
    let projection = RunProjection::rebuild(&events).unwrap();
    let serialized = serde_json::to_vec(&projection).unwrap();
    let cached: RunProjection = serde_json::from_slice(&serialized).unwrap();
    assert_eq!(cached, projection);

    drop(cached);
    assert_eq!(RunProjection::rebuild(&events).unwrap(), projection);
}

#[test]
fn observation_events_advance_identity_without_changing_business_state() {
    let run_id = RunId::new("run-observation").unwrap();
    let running = event(
        &run_id,
        2,
        "event-2",
        None,
        None,
        RunEventPayload::RunStateChanged {
            from: RunState::Planning,
            to: RunState::Running,
        },
    );
    let before =
        RunProjection::rebuild(&[started(&run_id, 1, "event-1"), running.clone()]).unwrap();
    let after = RunProjection::rebuild(&[
        started(&run_id, 1, "event-1"),
        running,
        event(
            &run_id,
            3,
            "event-3",
            None,
            None,
            RunEventPayload::LegacyActivityObserved {
                kind: "tool_completed".to_string(),
                status: "completed".to_string(),
                title: "legacy observation".to_string(),
            },
        ),
    ])
    .unwrap();

    assert_eq!(after.state, before.state);
    assert_eq!(after.goal, before.goal);
    assert_eq!(after.plan_revision, before.plan_revision);
    assert_eq!(after.tasks, before.tasks);
    assert_eq!(after.agents, before.agents);
    assert_eq!(after.last_sequence, 3);
}

#[test]
fn reconciliation_is_empty_for_matching_status_and_explicit_for_mismatch() {
    let run_id = RunId::new("run-reconciliation").unwrap();
    for (legacy_status, projected_status) in [
        (CodeProRunStatus::Completed, RunState::Completed),
        (CodeProRunStatus::Failed, RunState::Failed),
        (CodeProRunStatus::Discarded, RunState::Cancelled),
    ] {
        let matching =
            ProjectionReconciliation::new(run_id.clone(), legacy_status, projected_status);
        assert!(matching.differences.is_empty());
    }

    let mismatch =
        ProjectionReconciliation::new(run_id, CodeProRunStatus::Completed, RunState::Failed);
    assert_eq!(
        mismatch.differences,
        vec![ProjectionDifference::StatusMismatch {
            legacy_status: CodeProRunStatus::Completed,
            projected_status: RunState::Failed,
        }]
    );
    assert_eq!(
        serde_json::to_vec(&mismatch).unwrap(),
        serde_json::to_vec(&ProjectionReconciliation::new(
            RunId::new("run-reconciliation").unwrap(),
            CodeProRunStatus::Completed,
            RunState::Failed,
        ))
        .unwrap()
    );
}

#[tokio::test]
async fn reconciliation_report_is_atomic_bounded_and_does_not_touch_legacy_state() {
    let directory = tempfile::tempdir().unwrap();
    let store = CodeProStateStore::new(directory.path());
    let run_id = RunId::new("run-reconciliation").unwrap();
    let run_dir = directory.path().join(run_id.as_str()).join("run");
    std::fs::create_dir_all(&run_dir).unwrap();
    let state_path = run_dir.join("state.json");
    let state_bytes = br#"{
        "goal":"SECRET_GOAL_MUST_NOT_LEAK",
        "model_prompt":"SECRET_PROMPT_MUST_NOT_LEAK",
        "command_output":"SECRET_COMMAND_OUTPUT_MUST_NOT_LEAK"
    }"#;
    std::fs::write(&state_path, state_bytes).unwrap();

    let mismatch = ProjectionReconciliation::new(
        run_id.clone(),
        CodeProRunStatus::Running,
        RunState::Recovering,
    );
    store
        .record_projection_reconciliation(&mismatch)
        .await
        .unwrap();
    let report_path = run_dir.join(PROJECTION_RECONCILIATION_FILE_NAME);
    let first_bytes = std::fs::read(&report_path).unwrap();

    assert!(first_bytes.len() <= MAX_PROJECTION_RECONCILIATION_BYTES);
    let first_text = String::from_utf8(first_bytes).unwrap();
    for forbidden in [
        "SECRET_GOAL_MUST_NOT_LEAK",
        "SECRET_PROMPT_MUST_NOT_LEAK",
        "SECRET_COMMAND_OUTPUT_MUST_NOT_LEAK",
        "goal",
        "model_prompt",
        "command_output",
    ] {
        assert!(!first_text.contains(forbidden));
    }
    assert_eq!(std::fs::read(&state_path).unwrap(), state_bytes);

    let matching =
        ProjectionReconciliation::new(run_id, CodeProRunStatus::Completed, RunState::Completed);
    store
        .record_projection_reconciliation(&matching)
        .await
        .unwrap();
    let replaced: ProjectionReconciliation =
        serde_json::from_slice(&std::fs::read(&report_path).unwrap()).unwrap();
    assert!(replaced.differences.is_empty());
    assert_eq!(std::fs::read(&state_path).unwrap(), state_bytes);
    assert!(!report_path.with_extension("json.tmp").exists());
}

#[test]
fn ten_thousand_events_replay_under_local_gate_and_rebuild_after_cache_deletion() {
    const EVENT_COUNT: u64 = 10_000;
    let run_id = RunId::new("run-scale-10000").unwrap();
    let base_time = Utc.with_ymd_and_hms(2026, 8, 5, 5, 0, 0).unwrap();
    let mut events = Vec::with_capacity(EVENT_COUNT as usize);
    events.push(started(&run_id, 1, "scale-event-1"));
    events.push(RunEvent {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        event_id: EventId::new("scale-event-2").unwrap(),
        sequence: 2,
        task_id: None,
        agent_id: None,
        causation_id: None,
        correlation_id: EventId::new("scale-event-2").unwrap(),
        occurred_at: base_time,
        payload: RunEventPayload::RunStateChanged {
            from: RunState::Planning,
            to: RunState::Running,
        },
        evidence_refs: vec![],
    });
    for sequence in 3..=EVENT_COUNT {
        let event_id = EventId::new(format!("scale-event-{sequence}")).unwrap();
        events.push(RunEvent {
            protocol_version: ProtocolVersion::V1,
            run_id: run_id.clone(),
            event_id: event_id.clone(),
            sequence,
            task_id: None,
            agent_id: None,
            causation_id: None,
            correlation_id: event_id,
            occurred_at: base_time + chrono::Duration::milliseconds(sequence as i64),
            payload: RunEventPayload::LegacyActivityObserved {
                kind: "scale_observation".to_string(),
                status: "completed".to_string(),
                title: "bounded replay observation".to_string(),
            },
            evidence_refs: vec![],
        });
    }

    let started_at = Instant::now();
    let projection = RunProjection::rebuild(&events).unwrap();
    let elapsed = started_at.elapsed();
    println!(
        "CODEPRO_10000_EVENT_REPLAY_MS={}",
        elapsed.as_secs_f64() * 1000.0
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "10,000-event replay took {elapsed:?}"
    );
    assert_eq!(projection.last_sequence, EVENT_COUNT);

    let cache_dir = tempfile::tempdir().unwrap();
    let cache_path = cache_dir.path().join("projection-cache.json");
    std::fs::write(&cache_path, serde_json::to_vec(&projection).unwrap()).unwrap();
    std::fs::remove_file(&cache_path).unwrap();
    assert!(!cache_path.exists());
    assert_eq!(RunProjection::rebuild(&events).unwrap(), projection);
}
