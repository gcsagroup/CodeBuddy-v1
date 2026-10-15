use chrono::{TimeZone, Utc};
use goose::agents::protocol::{
    EventId, EvidenceRef, ProtocolVersion, RunEvent, RunEventPayload, RunId, TaskDependency, TaskId,
};

#[test]
fn ids_versions_and_evidence_ownership_are_fail_closed() {
    assert!(RunId::new("run-1").is_ok());
    assert!(RunId::new("").is_err());
    assert!(RunId::new("run/escape").is_err());
    assert!(serde_json::from_str::<ProtocolVersion>("1").is_ok());
    assert_eq!(
        serde_json::from_str::<ProtocolVersion>("2").unwrap(),
        ProtocolVersion::V2
    );
    assert!(serde_json::from_str::<ProtocolVersion>("3").is_err());

    let current = RunId::new("run-1").unwrap();
    let foreign = EvidenceRef::new(
        RunId::new("run-2").unwrap(),
        EventId::new("event-1").unwrap(),
        "artifacts/stdout.txt",
    )
    .unwrap();
    assert!(foreign.validate_for_run(&current).is_err());
    assert!(EvidenceRef::new(current, EventId::new("event-2").unwrap(), "../secret.txt",).is_err());
}

#[test]
fn state_machines_reject_impossible_transitions() {
    use goose::agents::protocol::{AgentState, RunState, TaskState};

    assert!(RunState::Planning
        .validate_transition(RunState::Running)
        .is_ok());
    assert!(RunState::Completed
        .validate_transition(RunState::Running)
        .is_err());
    assert!(TaskState::Running
        .validate_transition(TaskState::Succeeded)
        .is_ok());
    assert!(TaskState::Succeeded
        .validate_transition(TaskState::Running)
        .is_err());
    assert!(AgentState::Running
        .validate_transition(AgentState::Crashed)
        .is_ok());
    assert!(AgentState::Crashed
        .validate_transition(AgentState::Running)
        .is_err());
}

#[test]
fn worker_outcomes_and_coordinator_candidates_validate_evidence_ownership() {
    use goose::agents::protocol::{
        CoordinatorDecision, CoordinatorDecisionCandidate, TaskResult, WorkerOutcome,
    };

    let run_id = RunId::new("run-1").unwrap();
    let current_evidence = EvidenceRef::new(
        run_id.clone(),
        EventId::new("event-1").unwrap(),
        "artifacts/result.txt",
    )
    .unwrap();
    let outcome = WorkerOutcome::Succeeded(TaskResult {
        summary: "implemented the change".to_string(),
        evidence_refs: vec![current_evidence],
    });
    assert!(outcome.validate_for_run(&run_id).is_ok());

    let foreign_evidence = EvidenceRef::new(
        RunId::new("run-2").unwrap(),
        EventId::new("event-2").unwrap(),
        "artifacts/decision.txt",
    )
    .unwrap();
    let candidate = CoordinatorDecisionCandidate {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        decision_id: EventId::new("decision-1").unwrap(),
        decision: CoordinatorDecision::ContinueTask,
        reason: "continue with current evidence".to_string(),
        target_task_id: None,
        target_agent_id: None,
        evidence_refs: vec![foreign_evidence],
        requested_budget: None,
        required_permissions: vec![],
        expected_completion: "task reaches a terminal state".to_string(),
        supersedes_plan_revision: None,
    };
    assert!(candidate.validate_for_run(&run_id).is_err());
}

#[test]
fn v1_run_event_fixture_roundtrips_and_rejects_invalid_envelopes() {
    use goose::agents::protocol::{RunEvent, RunEventPayload};

    let fixture = include_str!("fixtures/protocol/v1/run_started.json");
    let event = RunEvent::from_json(fixture).unwrap();
    assert!(matches!(
        event.payload,
        RunEventPayload::RunStarted { ref goal } if goal == "build the project"
    ));
    let serialized = event.to_json().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(fixture).unwrap(),
        serde_json::from_str::<serde_json::Value>(&serialized).unwrap()
    );

    let base = serde_json::from_str::<serde_json::Value>(fixture).unwrap();
    for mutation in [
        "unknown_version",
        "zero_sequence",
        "task_scope",
        "foreign_evidence",
    ] {
        let mut invalid = base.clone();
        match mutation {
            "unknown_version" => invalid["protocol_version"] = 3.into(),
            "zero_sequence" => invalid["sequence"] = 0.into(),
            "task_scope" => invalid["task_id"] = "task-1".into(),
            "foreign_evidence" => {
                invalid["evidence_refs"] = serde_json::json!([{
                    "run_id": "run-2",
                    "event_id": "event-2",
                    "artifact_ref": "artifacts/output.txt"
                }]);
            }
            _ => unreachable!(),
        }
        assert!(
            RunEvent::from_json(&invalid.to_string()).is_err(),
            "mutation must fail: {mutation}"
        );
    }
}

#[test]
fn v2_task_graph_roundtrips_but_v1_and_malformed_graphs_fail_closed() {
    let run_id = RunId::new("run-v2-graph").unwrap();
    let root = TaskId::new("task-root").unwrap();
    let child = TaskId::new("task-child").unwrap();
    let event_id = EventId::new("event-v2-graph").unwrap();
    let graph = RunEvent {
        protocol_version: ProtocolVersion::V2,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence: 6,
        task_id: None,
        agent_id: None,
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc.with_ymd_and_hms(2026, 8, 5, 21, 0, 0).unwrap(),
        payload: RunEventPayload::TaskGraphDeclared {
            plan_revision: 1,
            dependencies: vec![
                TaskDependency {
                    task_id: root.clone(),
                    depends_on: vec![],
                },
                TaskDependency {
                    task_id: child.clone(),
                    depends_on: vec![root.clone()],
                },
            ],
        },
        evidence_refs: vec![],
    };

    let json = graph.to_json().unwrap();
    assert_eq!(RunEvent::from_json(&json).unwrap(), graph);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&json).unwrap()["event_type"],
        "task_graph_declared"
    );

    let mut v1 = graph.clone();
    v1.protocol_version = ProtocolVersion::V1;
    assert!(v1.validate().is_err());

    let mut duplicate_task = graph.clone();
    if let RunEventPayload::TaskGraphDeclared { dependencies, .. } = &mut duplicate_task.payload {
        dependencies.push(TaskDependency {
            task_id: root.clone(),
            depends_on: vec![],
        });
    }
    assert!(duplicate_task.validate().is_err());

    let mut duplicate_edge = graph.clone();
    if let RunEventPayload::TaskGraphDeclared { dependencies, .. } = &mut duplicate_edge.payload {
        dependencies[1].depends_on.push(root.clone());
    }
    assert!(duplicate_edge.validate().is_err());

    let mut self_edge = graph.clone();
    if let RunEventPayload::TaskGraphDeclared { dependencies, .. } = &mut self_edge.payload {
        dependencies[1].depends_on = vec![child.clone()];
    }
    assert!(self_edge.validate().is_err());

    let mut oversized = graph;
    if let RunEventPayload::TaskGraphDeclared { dependencies, .. } = &mut oversized.payload {
        dependencies.extend((0..128).map(|index| TaskDependency {
            task_id: TaskId::new(format!("task-extra-{index}")).unwrap(),
            depends_on: vec![],
        }));
    }
    assert!(oversized.validate().is_err());
}

#[test]
fn run_state_changed_events_validate_the_declared_transition() {
    use goose::agents::protocol::RunEvent;

    let fixture = include_str!("fixtures/protocol/v1/run_started.json");
    let mut valid = serde_json::from_str::<serde_json::Value>(fixture).unwrap();
    valid["event_type"] = "run_state_changed".into();
    valid["payload"] = serde_json::json!({
        "from": "planning",
        "to": "running"
    });
    assert!(RunEvent::from_json(&valid.to_string()).is_ok());

    let mut invalid = valid;
    invalid["payload"] = serde_json::json!({
        "from": "completed",
        "to": "running"
    });
    assert!(RunEvent::from_json(&invalid.to_string()).is_err());
}

#[test]
fn legacy_activity_events_adapt_to_valid_v1_run_events() {
    use chrono::{TimeZone, Utc};
    use goose::agents::protocol::{RunEvent, RunEventPayload};
    use goose::agents::{
        ActivityEvent, ActivityEventKind, ActivityEventStatus, ACTIVITY_EVENT_SCHEMA_VERSION,
    };

    let started_at = Utc.with_ymd_and_hms(2026, 8, 5, 1, 2, 3).unwrap();
    let activity = ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: "event-legacy-1".to_string(),
        event_type: ActivityEventKind::RunCompleted,
        session_id: "session-1".to_string(),
        run_id: "run-1".to_string(),
        task_id: None,
        parent_task_id: None,
        agent_role: None,
        effective_model: None,
        status: ActivityEventStatus::Completed,
        started_at,
        finished_at: Some(started_at),
        title: "run completed".to_string(),
        technical_details: Some("all verified work completed".to_string()),
        path: None,
        command_summary: None,
        exit_code: Some(0),
        diff_summary: None,
        failure_kind: None,
        risk_tier: None,
        previous_risk_tier: None,
        risk_reasons: Vec::new(),
        selected_roles: Vec::new(),
        review_required: None,
        routing_evidence: None,
        include_in_model_context: false,
        retryable: false,
        retry_from_event_id: None,
    };

    let event = RunEvent::from_activity_event(7, &activity).unwrap();

    assert_eq!(event.sequence, 7);
    assert_eq!(event.run_id.as_str(), "run-1");
    assert_eq!(event.event_id.as_str(), "event-legacy-1");
    assert_eq!(event.correlation_id, event.event_id);
    assert_eq!(event.occurred_at, started_at);
    assert!(matches!(
        event.payload,
        RunEventPayload::RunCompleted { ref summary, .. }
            if summary == "all verified work completed"
    ));
    assert!(event.validate().is_ok());
}
