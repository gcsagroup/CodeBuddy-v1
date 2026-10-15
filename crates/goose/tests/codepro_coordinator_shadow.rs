use async_trait::async_trait;
use chrono::Utc;
use goose::agents::coordinator::{
    CoordinatorDecisionProposal, CoordinatorModelCallError, CoordinatorModelClient,
    CoordinatorModelRequest, CoordinatorPrompt, CoordinatorProposalAction,
    DecisionValidationSnapshot, ShadowCoordinator, COORDINATOR_PROMPT_VERSION,
    COORDINATOR_PROPOSAL_SCHEMA_VERSION,
};
use goose::agents::protocol::{
    CoordinatorCandidateStatus, CoordinatorComparisonClass, CoordinatorDecision,
    CoordinatorDecisionPoint, CoordinatorRejectionReason, EventId, EvidenceRef, ProtocolVersion,
    RunEvent, RunId, RunState, TaskId, TaskState,
};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
struct FakeModel {
    responses: Arc<Mutex<VecDeque<Result<String, CoordinatorModelCallError>>>>,
    delay: Duration,
}

impl FakeModel {
    fn responses(values: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            responses: Arc::new(Mutex::new(
                values.into_iter().map(|value| Ok(value.into())).collect(),
            )),
            delay: Duration::ZERO,
        }
    }

    fn error(message: &str) -> Self {
        Self {
            responses: Arc::new(Mutex::new(VecDeque::from([Err(
                CoordinatorModelCallError::new(message),
            )]))),
            delay: Duration::ZERO,
        }
    }

    fn delayed(response: String, delay: Duration) -> Self {
        Self {
            responses: Arc::new(Mutex::new(VecDeque::from([Ok(response)]))),
            delay,
        }
    }
}

#[async_trait]
impl CoordinatorModelClient for FakeModel {
    async fn generate(
        &self,
        _request: CoordinatorModelRequest,
    ) -> Result<String, CoordinatorModelCallError> {
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(CoordinatorModelCallError::new("no response")))
    }
}

fn prompt() -> CoordinatorPrompt {
    CoordinatorPrompt {
        version: COORDINATOR_PROMPT_VERSION,
        text: "bounded shadow prompt".into(),
        estimated_tokens: 17,
    }
}

fn snapshot() -> DecisionValidationSnapshot {
    let run_id = RunId::new("run-shadow").unwrap();
    let mut snapshot = DecisionValidationSnapshot::new(run_id.clone(), RunState::Running, 2);
    snapshot.insert_task(
        TaskId::new("task-shadow").unwrap(),
        TaskState::WaitingForCoordinator,
    );
    snapshot.record_evidence_ref(
        EvidenceRef::new(
            run_id,
            EventId::new("event-shadow-evidence").unwrap(),
            "artifacts/shadow.json",
        )
        .unwrap(),
    );
    snapshot
}

fn valid_response(decision: CoordinatorDecision) -> String {
    let task_id = TaskId::new("task-shadow").unwrap();
    let decision = match decision {
        CoordinatorDecision::ContinueTask => CoordinatorProposalAction::ContinueTask { task_id },
        CoordinatorDecision::RetryTask => CoordinatorProposalAction::RetryTask { task_id },
        _ => panic!("unsupported test decision"),
    };
    serde_json::to_string(&CoordinatorDecisionProposal {
        schema_version: COORDINATOR_PROPOSAL_SCHEMA_VERSION,
        reason: "current worker evidence supports this choice".into(),
        evidence_event_ids: vec![EventId::new("event-shadow-evidence").unwrap()],
        decision,
    })
    .unwrap()
}

#[tokio::test]
async fn shadow_records_match_but_returns_only_the_legacy_action() {
    let shadow = ShadowCoordinator::try_new(
        FakeModel::responses([valid_response(CoordinatorDecision::ContinueTask)]),
        Duration::from_secs(1),
    )
    .unwrap();
    let observation = shadow
        .observe(
            CoordinatorDecisionPoint::WorkerBlocked,
            &prompt(),
            &snapshot(),
            CoordinatorDecision::ContinueTask,
        )
        .await;

    assert_eq!(
        observation.execution_action(),
        CoordinatorDecision::ContinueTask
    );
    assert_eq!(
        observation.audit().comparison,
        CoordinatorComparisonClass::Match
    );
    assert_eq!(
        observation.audit().candidate_status,
        CoordinatorCandidateStatus::Valid
    );
    assert_eq!(observation.audit().prompt_tokens, 17);
    assert!(observation.audit().completion_bytes > 0);
}

#[tokio::test]
async fn divergent_coordinator_advice_never_changes_shadow_execution() {
    let shadow = ShadowCoordinator::try_new(
        FakeModel::responses([valid_response(CoordinatorDecision::RetryTask)]),
        Duration::from_secs(1),
    )
    .unwrap();
    let observation = shadow
        .observe(
            CoordinatorDecisionPoint::WorkerFailed,
            &prompt(),
            &snapshot(),
            CoordinatorDecision::ContinueTask,
        )
        .await;

    assert_eq!(
        observation.execution_action(),
        CoordinatorDecision::ContinueTask
    );
    assert_eq!(
        observation.audit().comparison,
        CoordinatorComparisonClass::Divergent
    );
    assert_eq!(
        observation.audit().coordinator_action,
        Some(CoordinatorDecision::RetryTask)
    );
}

#[tokio::test]
async fn repeated_format_failure_and_model_error_remain_audit_only() {
    let malformed = ShadowCoordinator::try_new(
        FakeModel::responses(["bad-json", "still-bad"]),
        Duration::from_secs(1),
    )
    .unwrap()
    .observe(
        CoordinatorDecisionPoint::PlanReview,
        &prompt(),
        &snapshot(),
        CoordinatorDecision::PauseTask,
    )
    .await;
    assert_eq!(malformed.execution_action(), CoordinatorDecision::PauseTask);
    assert_eq!(
        malformed.audit().rejection_reason,
        Some(CoordinatorRejectionReason::RepeatedFormatFailure)
    );

    let failed = ShadowCoordinator::try_new(
        FakeModel::error("provider unavailable with internal details"),
        Duration::from_secs(1),
    )
    .unwrap()
    .observe(
        CoordinatorDecisionPoint::PlanReview,
        &prompt(),
        &snapshot(),
        CoordinatorDecision::PauseTask,
    )
    .await;
    assert_eq!(
        failed.audit().rejection_reason,
        Some(CoordinatorRejectionReason::ModelError)
    );
    assert_eq!(failed.audit().completion_bytes, 0);
}

#[tokio::test]
async fn shadow_timeout_is_bounded_and_does_not_replace_legacy_action() {
    let shadow = ShadowCoordinator::try_new(
        FakeModel::delayed(
            valid_response(CoordinatorDecision::ContinueTask),
            Duration::from_millis(50),
        ),
        Duration::from_millis(1),
    )
    .unwrap();
    let observation = shadow
        .observe(
            CoordinatorDecisionPoint::UserSteering,
            &prompt(),
            &snapshot(),
            CoordinatorDecision::PauseTask,
        )
        .await;

    assert_eq!(
        observation.execution_action(),
        CoordinatorDecision::PauseTask
    );
    assert_eq!(
        observation.audit().candidate_status,
        CoordinatorCandidateStatus::TimedOut
    );
    assert_eq!(
        observation.audit().rejection_reason,
        Some(CoordinatorRejectionReason::Timeout)
    );
}

#[tokio::test]
async fn shadow_audit_is_a_valid_v2_event_but_not_a_v1_event() {
    let observation = ShadowCoordinator::try_new(
        FakeModel::responses([valid_response(CoordinatorDecision::ContinueTask)]),
        Duration::from_secs(1),
    )
    .unwrap()
    .observe(
        CoordinatorDecisionPoint::CompletionCheck,
        &prompt(),
        &snapshot(),
        CoordinatorDecision::ContinueTask,
    )
    .await;
    let mut event = RunEvent {
        protocol_version: ProtocolVersion::CURRENT,
        run_id: RunId::new("run-shadow").unwrap(),
        event_id: EventId::new("event-shadow-audit").unwrap(),
        sequence: 1,
        task_id: None,
        agent_id: None,
        causation_id: None,
        correlation_id: EventId::new("event-shadow-audit").unwrap(),
        occurred_at: Utc::now(),
        payload: observation.audit_event(),
        evidence_refs: vec![],
    };
    assert!(event.validate().is_ok());
    event.protocol_version = ProtocolVersion::V1;
    assert!(event.validate().is_err());
}
