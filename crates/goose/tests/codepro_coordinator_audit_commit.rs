use goose::agents::control_plane::{FileRunEventStore, RunEngine, RunEventStore, SystemRunClock};
use goose::agents::coordinator::{CoordinatorAuditCommitter, RunEngineAuditCommitter};
use goose::agents::protocol::{
    ControlCommand, CoordinatorAuditRecord, CoordinatorCandidateStatus, CoordinatorComparisonClass,
    CoordinatorDecision, CoordinatorDecisionPoint, CoordinatorExecutionDisposition,
    CoordinatorFallbackReason, CoordinatorMode, CoordinatorQualificationResult, RunEventPayload,
    RunId, COORDINATOR_AUDIT_SCHEMA_VERSION,
};

fn audit() -> CoordinatorAuditRecord {
    CoordinatorAuditRecord {
        schema_version: COORDINATOR_AUDIT_SCHEMA_VERSION,
        requested_mode: CoordinatorMode::Shadow,
        effective_mode: CoordinatorMode::Shadow,
        qualification: CoordinatorQualificationResult::NotRequired,
        decision_point: CoordinatorDecisionPoint::WorkerFailed,
        candidate_status: CoordinatorCandidateStatus::Valid,
        legacy_action: Some(CoordinatorDecision::RetryTask),
        coordinator_action: Some(CoordinatorDecision::ContinueTask),
        comparison: CoordinatorComparisonClass::Divergent,
        rejection_reason: None,
        execution_disposition: CoordinatorExecutionDisposition::Legacy,
        fallback_reason: Some(CoordinatorFallbackReason::ShadowMode),
        latency_ms: 25,
        prompt_tokens: 500,
        completion_bytes: 750,
    }
}

#[tokio::test]
async fn run_engine_commits_audit_before_returning_receipt_and_never_emits_effects() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let engine = RunEngine::new(store.clone(), SystemRunClock);
    let run_id = RunId::new("run-audit-commit").unwrap();
    engine
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "audit coordinator rollout".into(),
        })
        .await
        .unwrap();

    let committer = RunEngineAuditCommitter::new(&engine, run_id.clone());
    let receipt = committer.commit(&audit()).await.unwrap();
    let events = store.load(&run_id).await.unwrap();

    assert_eq!(events.len(), 2);
    assert_eq!(events[1].event_id, receipt.audit_event_id);
    assert!(matches!(
        events[1].payload,
        RunEventPayload::CoordinatorAuditRecorded { .. }
    ));
    let projection = engine.load_projection(&run_id).await.unwrap().unwrap();
    assert_eq!(projection.last_sequence, 2);
}
