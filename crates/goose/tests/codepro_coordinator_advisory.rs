use async_trait::async_trait;
use goose::agents::coordinator::{
    AdvisoryCoordinator, AdvisoryExecution, CoordinatorAuditCommitError, CoordinatorAuditCommitter,
    CoordinatorAuditReceipt, CoordinatorDecisionProposal, CoordinatorModelCallError,
    CoordinatorModelClient, CoordinatorModelRequest, CoordinatorPrompt, CoordinatorProposalAction,
    DecisionValidationSnapshot, COORDINATOR_PROMPT_VERSION, COORDINATOR_PROPOSAL_SCHEMA_VERSION,
};
use goose::agents::protocol::{
    CoordinatorAuditRecord, CoordinatorDecision, CoordinatorDecisionPoint,
    CoordinatorExecutionDisposition, CoordinatorFallbackReason, EventId, EvidenceRef, RunId,
    RunState, TaskId, TaskState,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct FakeModel(String);

#[async_trait]
impl CoordinatorModelClient for FakeModel {
    async fn generate(
        &self,
        _request: CoordinatorModelRequest,
    ) -> Result<String, CoordinatorModelCallError> {
        Ok(self.0.clone())
    }
}

#[derive(Clone, Default)]
struct RecordingCommitter {
    records: Arc<Mutex<Vec<CoordinatorAuditRecord>>>,
    fail: bool,
}

#[async_trait]
impl CoordinatorAuditCommitter for RecordingCommitter {
    async fn commit(
        &self,
        audit: &CoordinatorAuditRecord,
    ) -> Result<CoordinatorAuditReceipt, CoordinatorAuditCommitError> {
        if self.fail {
            return Err(CoordinatorAuditCommitError::new("disk unavailable"));
        }
        audit
            .validate()
            .map_err(|error| CoordinatorAuditCommitError::new(error.to_string()))?;
        self.records.lock().unwrap().push(audit.clone());
        Ok(CoordinatorAuditReceipt {
            audit_event_id: EventId::new("event-advisory-audit").unwrap(),
        })
    }
}

fn prompt() -> CoordinatorPrompt {
    CoordinatorPrompt {
        version: COORDINATOR_PROMPT_VERSION,
        text: "advisory prompt".into(),
        estimated_tokens: 12,
    }
}

fn snapshot(failure_evidence: bool) -> DecisionValidationSnapshot {
    let run_id = RunId::new("run-advisory").unwrap();
    let mut snapshot = DecisionValidationSnapshot::new(run_id.clone(), RunState::Running, 3);
    let task_id = TaskId::new("task-advisory").unwrap();
    snapshot.insert_task(task_id.clone(), TaskState::WaitingForCoordinator);
    let evidence = EventId::new("event-advisory-evidence").unwrap();
    if failure_evidence {
        snapshot.record_failure_evidence(evidence.clone());
    }
    snapshot.record_evidence_ref(
        EvidenceRef::new(run_id, evidence, "artifacts/advisory.json").unwrap(),
    );
    snapshot.set_task_retry_count(task_id, 0);
    snapshot.set_max_semantic_retries(1);
    snapshot
}

fn response(decision: CoordinatorDecision) -> String {
    let task_id = TaskId::new("task-advisory").unwrap();
    let decision = match decision {
        CoordinatorDecision::ContinueTask => CoordinatorProposalAction::ContinueTask { task_id },
        CoordinatorDecision::RetryTask => CoordinatorProposalAction::RetryTask { task_id },
        CoordinatorDecision::CancelTask => CoordinatorProposalAction::CancelTask { task_id },
        CoordinatorDecision::PauseRun => CoordinatorProposalAction::PauseRun,
        _ => panic!("unsupported advisory test action"),
    };
    serde_json::to_string(&CoordinatorDecisionProposal {
        schema_version: COORDINATOR_PROPOSAL_SCHEMA_VERSION,
        reason: "current evidence supports the bounded action".into(),
        evidence_event_ids: vec![EventId::new("event-advisory-evidence").unwrap()],
        decision,
    })
    .unwrap()
}

#[tokio::test]
async fn allowlisted_continue_executes_only_after_audit_commit() {
    let committer = RecordingCommitter::default();
    let advisory = AdvisoryCoordinator::try_new(
        FakeModel(response(CoordinatorDecision::ContinueTask)),
        committer.clone(),
        Duration::from_secs(1),
    )
    .unwrap();

    let execution = advisory
        .decide(
            CoordinatorDecisionPoint::WorkerBlocked,
            &prompt(),
            &snapshot(false),
            CoordinatorDecision::RetryTask,
        )
        .await
        .unwrap();
    let AdvisoryExecution::Coordinator(committed) = execution else {
        panic!("allowlisted decision should execute");
    };
    assert_eq!(committer.records.lock().unwrap().len(), 1);
    assert_eq!(
        committed.decision().envelope().candidate.decision,
        CoordinatorDecision::ContinueTask
    );
    assert_eq!(
        committed.audit().execution_disposition,
        CoordinatorExecutionDisposition::Coordinator
    );
}

#[tokio::test]
async fn valid_but_non_allowlisted_action_commits_audit_and_uses_legacy() {
    let committer = RecordingCommitter::default();
    let advisory = AdvisoryCoordinator::try_new(
        FakeModel(response(CoordinatorDecision::CancelTask)),
        committer.clone(),
        Duration::from_secs(1),
    )
    .unwrap();

    let execution = advisory
        .decide(
            CoordinatorDecisionPoint::UserSteering,
            &prompt(),
            &snapshot(false),
            CoordinatorDecision::PauseTask,
        )
        .await
        .unwrap();
    let AdvisoryExecution::Legacy(committed) = execution else {
        panic!("cancellation must remain legacy in advisory mode");
    };
    assert_eq!(committed.action(), CoordinatorDecision::PauseTask);
    assert_eq!(
        committed.audit().fallback_reason,
        Some(CoordinatorFallbackReason::AdvisoryActionNotAllowed)
    );
    assert_eq!(committer.records.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn retry_requires_current_failure_evidence_and_the_first_retry_slot() {
    let allowed = AdvisoryCoordinator::try_new(
        FakeModel(response(CoordinatorDecision::RetryTask)),
        RecordingCommitter::default(),
        Duration::from_secs(1),
    )
    .unwrap()
    .decide(
        CoordinatorDecisionPoint::WorkerFailed,
        &prompt(),
        &snapshot(true),
        CoordinatorDecision::PauseTask,
    )
    .await
    .unwrap();
    assert!(matches!(allowed, AdvisoryExecution::Coordinator(_)));

    let denied = AdvisoryCoordinator::try_new(
        FakeModel(response(CoordinatorDecision::RetryTask)),
        RecordingCommitter::default(),
        Duration::from_secs(1),
    )
    .unwrap()
    .decide(
        CoordinatorDecisionPoint::WorkerFailed,
        &prompt(),
        &snapshot(false),
        CoordinatorDecision::PauseTask,
    )
    .await
    .unwrap();
    assert!(matches!(denied, AdvisoryExecution::Legacy(_)));
}

#[tokio::test]
async fn pause_run_is_allowlisted_but_audit_failure_yields_no_capability() {
    let advisory = AdvisoryCoordinator::try_new(
        FakeModel(response(CoordinatorDecision::PauseRun)),
        RecordingCommitter {
            fail: true,
            ..Default::default()
        },
        Duration::from_secs(1),
    )
    .unwrap();

    let failure = advisory
        .decide(
            CoordinatorDecisionPoint::UserSteering,
            &prompt(),
            &snapshot(false),
            CoordinatorDecision::PauseTask,
        )
        .await
        .unwrap_err();
    assert_eq!(failure.legacy_action, CoordinatorDecision::PauseTask);
    assert!(failure.error.to_string().contains("audit commit failed"));
}
