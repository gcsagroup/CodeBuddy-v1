use chrono::Utc;
use goose::agents::control_plane::ConvergenceStatus;
use goose::agents::coordinator::{
    CoordinatorAction, CoordinatorAuthorityInput, CoordinatorDecisionEnvelope,
    CoordinatorDecisionSnapshotBuilder, CoordinatorDecisionValidator, SnapshotBuildError,
    COORDINATOR_DECISION_SCHEMA_VERSION,
};
use goose::agents::protocol::{
    CoordinatorDecision, CoordinatorDecisionCandidate, EventId, EvidenceRef, ProtocolVersion,
    RunEvent, RunEventPayload, RunId, RunState,
};
use goose::agents::reporting::RunProjection;

fn event(run_id: &RunId, sequence: u64, payload: RunEventPayload) -> RunEvent {
    let event_id = EventId::new(format!("event-snapshot-{sequence}")).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::CURRENT,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: None,
        agent_id: None,
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc::now(),
        payload,
        evidence_refs: vec![],
    }
}

fn events() -> Vec<RunEvent> {
    let run_id = RunId::new("run-snapshot").unwrap();
    vec![
        event(
            &run_id,
            1,
            RunEventPayload::RunStarted {
                goal: "build a host snapshot".into(),
            },
        ),
        event(
            &run_id,
            2,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
    ]
}

#[test]
fn projection_and_current_events_build_an_executable_host_snapshot() {
    let events = events();
    let projection = RunProjection::rebuild(&events).unwrap();
    let snapshot = CoordinatorDecisionSnapshotBuilder::build(
        &projection,
        &events,
        CoordinatorAuthorityInput {
            allowed_write_scopes: vec!["src/**".into()],
            convergence_status: ConvergenceStatus::Eligible,
            ..Default::default()
        },
    )
    .unwrap();
    let run_id = RunId::new("run-snapshot").unwrap();
    let envelope = CoordinatorDecisionEnvelope {
        schema_version: COORDINATOR_DECISION_SCHEMA_VERSION,
        candidate: CoordinatorDecisionCandidate {
            protocol_version: ProtocolVersion::CURRENT,
            run_id: run_id.clone(),
            decision_id: EventId::new("decision-snapshot").unwrap(),
            decision: CoordinatorDecision::CompleteRun,
            reason: "the host convergence assessment is eligible".into(),
            target_task_id: None,
            target_agent_id: None,
            evidence_refs: vec![EvidenceRef::new(
                run_id,
                EventId::new("event-snapshot-2").unwrap(),
                "artifacts/convergence.json",
            )
            .unwrap()],
            requested_budget: None,
            required_permissions: vec![],
            expected_completion: "run is committed complete".into(),
            supersedes_plan_revision: Some(0),
        },
        action: CoordinatorAction::CompleteRun {
            summary: "all host gates passed".into(),
        },
    };
    assert!(CoordinatorDecisionValidator::validate(envelope, &snapshot).is_ok());
}

#[test]
fn stale_events_cross_run_events_and_invalid_authority_scopes_fail_closed() {
    let events = events();
    let projection = RunProjection::rebuild(&events).unwrap();
    assert!(matches!(
        CoordinatorDecisionSnapshotBuilder::build(
            &projection,
            &events[..1],
            CoordinatorAuthorityInput::default(),
        ),
        Err(SnapshotBuildError::StaleEvents { .. })
    ));

    let mut mixed = events.clone();
    mixed[1].run_id = RunId::new("run-foreign").unwrap();
    assert!(matches!(
        CoordinatorDecisionSnapshotBuilder::build(
            &projection,
            &mixed,
            CoordinatorAuthorityInput::default(),
        ),
        Err(SnapshotBuildError::RunMismatch)
    ));

    assert!(matches!(
        CoordinatorDecisionSnapshotBuilder::build(
            &projection,
            &events,
            CoordinatorAuthorityInput {
                allowed_write_scopes: vec!["../outside/**".into()],
                ..Default::default()
            },
        ),
        Err(SnapshotBuildError::Scope(_))
    ));
}
