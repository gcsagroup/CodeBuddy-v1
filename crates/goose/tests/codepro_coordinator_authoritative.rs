use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, Utc};
use goose::agents::coordinator::{
    AuthoritativeCoordinator, AuthoritativeExecution, CoordinatorAuditCommitError,
    CoordinatorAuditCommitter, CoordinatorAuditReceipt, CoordinatorDecisionProposal,
    CoordinatorModelCallError, CoordinatorModelClient, CoordinatorModelRequest, CoordinatorPrompt,
    CoordinatorProposalAction, CoordinatorRunPolicy, DecisionValidationSnapshot,
    InMemoryQualificationRegistry, QualificationKey, QualificationRecord, QualificationStatus,
    COORDINATOR_PROMPT_VERSION, COORDINATOR_PROPOSAL_SCHEMA_VERSION,
};
use goose::agents::protocol::{
    CoordinatorAuditRecord, CoordinatorDecision, CoordinatorDecisionPoint,
    CoordinatorExecutionDisposition, CoordinatorFallbackReason, CoordinatorMode,
    CoordinatorQualificationResult, EventId, EvidenceRef, ProtocolVersion, RunId, RunState, TaskId,
    TaskState,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
struct FakeModel {
    response: String,
    calls: Arc<AtomicUsize>,
    delay: Duration,
}

#[async_trait]
impl CoordinatorModelClient for FakeModel {
    async fn generate(
        &self,
        _request: CoordinatorModelRequest,
    ) -> Result<String, CoordinatorModelCallError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        Ok(self.response.clone())
    }
}

#[derive(Clone, Default)]
struct RecordingCommitter(Arc<Mutex<Vec<CoordinatorAuditRecord>>>);

#[async_trait]
impl CoordinatorAuditCommitter for RecordingCommitter {
    async fn commit(
        &self,
        audit: &CoordinatorAuditRecord,
    ) -> Result<CoordinatorAuditReceipt, CoordinatorAuditCommitError> {
        audit
            .validate()
            .map_err(|error| CoordinatorAuditCommitError::new(error.to_string()))?;
        self.0.lock().unwrap().push(audit.clone());
        Ok(CoordinatorAuditReceipt {
            audit_event_id: EventId::new("event-authoritative-audit").unwrap(),
        })
    }
}

fn key() -> QualificationKey {
    QualificationKey {
        provider: "openai".into(),
        model: "gpt-codepro".into(),
        reasoning_level: "high".into(),
        protocol_version: ProtocolVersion::CURRENT,
        prompt_version: COORDINATOR_PROMPT_VERSION.into(),
        evaluator_version: "eval-v1".into(),
    }
}

fn qualified_policy() -> CoordinatorRunPolicy {
    let now = Utc::now();
    let registry = InMemoryQualificationRegistry::new(vec![QualificationRecord {
        key: key(),
        status: QualificationStatus::Passed,
        evaluated_at: now - ChronoDuration::days(1),
        expires_at: now + ChronoDuration::days(30),
        evidence_sha256: "b".repeat(64),
    }])
    .unwrap();
    CoordinatorRunPolicy::snapshot(CoordinatorMode::Authoritative, Some(key()), &registry, now)
}

fn unqualified_policy() -> CoordinatorRunPolicy {
    CoordinatorRunPolicy::snapshot(
        CoordinatorMode::Authoritative,
        Some(key()),
        &InMemoryQualificationRegistry::default(),
        Utc::now(),
    )
}

fn prompt() -> CoordinatorPrompt {
    CoordinatorPrompt {
        version: COORDINATOR_PROMPT_VERSION,
        text: "authoritative prompt".into(),
        estimated_tokens: 23,
    }
}

fn snapshot() -> DecisionValidationSnapshot {
    let run_id = RunId::new("run-authoritative").unwrap();
    let mut snapshot = DecisionValidationSnapshot::new(run_id.clone(), RunState::Running, 7);
    snapshot.insert_task(
        TaskId::new("task-authoritative").unwrap(),
        TaskState::WaitingForCoordinator,
    );
    snapshot.record_evidence_ref(
        EvidenceRef::new(
            run_id,
            EventId::new("event-authoritative-evidence").unwrap(),
            "artifacts/authoritative.json",
        )
        .unwrap(),
    );
    snapshot
}

fn response(decision: CoordinatorDecision) -> String {
    let decision = match decision {
        CoordinatorDecision::CancelTask => CoordinatorProposalAction::CancelTask {
            task_id: TaskId::new("task-authoritative").unwrap(),
        },
        CoordinatorDecision::CompleteRun => CoordinatorProposalAction::CompleteRun {
            summary: "claimed complete".into(),
        },
        _ => panic!("unsupported authoritative test action"),
    };
    serde_json::to_string(&CoordinatorDecisionProposal {
        schema_version: COORDINATOR_PROPOSAL_SCHEMA_VERSION,
        reason: "host evidence supports the decision".into(),
        evidence_event_ids: vec![EventId::new("event-authoritative-evidence").unwrap()],
        decision,
    })
    .unwrap()
}

fn model(decision: CoordinatorDecision) -> (FakeModel, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    (
        FakeModel {
            response: response(decision),
            calls: calls.clone(),
            delay: Duration::ZERO,
        },
        calls,
    )
}

#[tokio::test]
async fn qualified_authoritative_run_can_select_non_advisory_action_after_commit() {
    let policy = qualified_policy();
    let (model, calls) = model(CoordinatorDecision::CancelTask);
    let committer = RecordingCommitter::default();
    let controller =
        AuthoritativeCoordinator::try_new(model, committer.clone(), policy, Duration::from_secs(1))
            .unwrap();

    let execution = controller
        .decide(
            CoordinatorDecisionPoint::UserSteering,
            &prompt(),
            &snapshot(),
            CoordinatorDecision::PauseTask,
        )
        .await
        .unwrap();
    let AuthoritativeExecution::Coordinator(committed) = execution else {
        panic!("qualified authoritative action should be selected");
    };
    assert!(committed.authorize().is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(committer.0.lock().unwrap().len(), 1);
    assert_eq!(
        committed.audit().execution_disposition,
        CoordinatorExecutionDisposition::Coordinator
    );
}

#[tokio::test]
async fn unqualified_authoritative_request_runs_shadow_and_keeps_legacy() {
    let (model, calls) = model(CoordinatorDecision::CancelTask);
    let controller = AuthoritativeCoordinator::try_new(
        model,
        RecordingCommitter::default(),
        unqualified_policy(),
        Duration::from_secs(1),
    )
    .unwrap();

    let execution = controller
        .decide(
            CoordinatorDecisionPoint::UserSteering,
            &prompt(),
            &snapshot(),
            CoordinatorDecision::PauseTask,
        )
        .await
        .unwrap();
    let AuthoritativeExecution::Legacy(committed) = execution else {
        panic!("unqualified request must remain legacy");
    };
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(committed.audit().effective_mode, CoordinatorMode::Shadow);
    assert_eq!(
        committed.audit().qualification,
        CoordinatorQualificationResult::Missing
    );
    assert_eq!(
        committed.audit().fallback_reason,
        Some(CoordinatorFallbackReason::Unqualified)
    );
}

#[tokio::test]
async fn host_convergence_still_rejects_fabricated_completion() {
    let (model, _) = model(CoordinatorDecision::CompleteRun);
    let controller = AuthoritativeCoordinator::try_new(
        model,
        RecordingCommitter::default(),
        qualified_policy(),
        Duration::from_secs(1),
    )
    .unwrap();
    let execution = controller
        .decide(
            CoordinatorDecisionPoint::CompletionCheck,
            &prompt(),
            &snapshot(),
            CoordinatorDecision::PauseTask,
        )
        .await
        .unwrap();
    let AuthoritativeExecution::Legacy(committed) = execution else {
        panic!("fabricated completion must be rejected");
    };
    assert_eq!(
        committed.audit().fallback_reason,
        Some(CoordinatorFallbackReason::CandidateRejected)
    );
}

#[tokio::test]
async fn rollback_to_off_skips_model_and_revokes_already_committed_capability() {
    let policy = qualified_policy();
    let (first_model, _) = model(CoordinatorDecision::CancelTask);
    let first = AuthoritativeCoordinator::try_new(
        first_model,
        RecordingCommitter::default(),
        policy.clone(),
        Duration::from_secs(1),
    )
    .unwrap()
    .decide(
        CoordinatorDecisionPoint::UserSteering,
        &prompt(),
        &snapshot(),
        CoordinatorDecision::PauseTask,
    )
    .await
    .unwrap();
    let AuthoritativeExecution::Coordinator(committed) = first else {
        panic!("first action should be authorized");
    };
    assert!(committed.authorize().is_ok());

    policy.rollback_to(CoordinatorMode::Off).unwrap();
    assert!(committed.authorize().is_err());
    assert_eq!(committed.fallback_action(), CoordinatorDecision::PauseTask);

    let (second_model, calls) = model(CoordinatorDecision::CancelTask);
    let second = AuthoritativeCoordinator::try_new(
        second_model,
        RecordingCommitter::default(),
        policy,
        Duration::from_secs(1),
    )
    .unwrap()
    .decide(
        CoordinatorDecisionPoint::UserSteering,
        &prompt(),
        &snapshot(),
        CoordinatorDecision::PauseTask,
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let AuthoritativeExecution::Legacy(off) = second else {
        panic!("off mode must use legacy");
    };
    assert_eq!(off.audit().effective_mode, CoordinatorMode::Off);
    assert_eq!(off.audit().prompt_tokens, 0);
}

#[tokio::test]
async fn rollback_during_model_call_records_history_but_discards_candidate() {
    let policy = qualified_policy();
    let calls = Arc::new(AtomicUsize::new(0));
    let controller = AuthoritativeCoordinator::try_new(
        FakeModel {
            response: response(CoordinatorDecision::CancelTask),
            calls: calls.clone(),
            delay: Duration::from_millis(50),
        },
        RecordingCommitter::default(),
        policy.clone(),
        Duration::from_secs(1),
    )
    .unwrap();
    let rollback = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(2)).await;
        policy.rollback_to(CoordinatorMode::Off).unwrap();
    });

    let execution = controller
        .decide(
            CoordinatorDecisionPoint::UserSteering,
            &prompt(),
            &snapshot(),
            CoordinatorDecision::PauseTask,
        )
        .await
        .unwrap();
    rollback.await.unwrap();
    let AuthoritativeExecution::Legacy(committed) = execution else {
        panic!("candidate completed after rollback and must be discarded");
    };
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(committed.audit().effective_mode, CoordinatorMode::Off);
    assert_eq!(
        committed.audit().fallback_reason,
        Some(CoordinatorFallbackReason::Rollback)
    );
    assert_eq!(
        committed.audit().coordinator_action,
        Some(CoordinatorDecision::CancelTask)
    );
}
