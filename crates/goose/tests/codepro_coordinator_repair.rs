use async_trait::async_trait;
use goose::agents::control_plane::ConvergenceStatus;
use goose::agents::coordinator::{
    Coordinator, CoordinatorDecisionOutcome, CoordinatorDecisionProposal,
    CoordinatorModelCallError, CoordinatorModelClient, CoordinatorModelRequest, CoordinatorPrompt,
    CoordinatorProposalAction, DecisionValidationError, DecisionValidationSnapshot,
    COORDINATOR_PROMPT_VERSION, COORDINATOR_PROPOSAL_SCHEMA_VERSION,
};
use goose::agents::protocol::{
    CoordinatorDecision, EventId, EvidenceRef, RunId, RunState, TaskId, TaskState,
};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeModel {
    responses: Arc<Mutex<VecDeque<String>>>,
    requests: Arc<Mutex<Vec<CoordinatorModelRequest>>>,
}

impl FakeModel {
    fn new(responses: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            responses: Arc::new(Mutex::new(responses.into_iter().map(Into::into).collect())),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

#[async_trait]
impl CoordinatorModelClient for FakeModel {
    async fn generate(
        &self,
        request: CoordinatorModelRequest,
    ) -> Result<String, CoordinatorModelCallError> {
        self.requests.lock().unwrap().push(request);
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| CoordinatorModelCallError::new("no fake response"))
    }
}

fn prompt() -> CoordinatorPrompt {
    CoordinatorPrompt {
        version: COORDINATOR_PROMPT_VERSION,
        text: "bounded coordinator prompt".into(),
        estimated_tokens: 10,
    }
}

fn snapshot() -> DecisionValidationSnapshot {
    let run_id = RunId::new("run-repair").unwrap();
    let mut snapshot = DecisionValidationSnapshot::new(run_id.clone(), RunState::Running, 4);
    snapshot.insert_task(
        TaskId::new("task-repair").unwrap(),
        TaskState::WaitingForCoordinator,
    );
    snapshot.record_evidence_ref(
        EvidenceRef::new(
            run_id,
            EventId::new("event-current").unwrap(),
            "artifacts/current.json",
        )
        .unwrap(),
    );
    snapshot.set_convergence_status(ConvergenceStatus::Blocked);
    snapshot
}

fn valid_proposal(decision: CoordinatorDecision) -> CoordinatorDecisionProposal {
    let decision = match decision {
        CoordinatorDecision::ContinueTask => CoordinatorProposalAction::ContinueTask {
            task_id: TaskId::new("task-repair").unwrap(),
        },
        CoordinatorDecision::CompleteRun => CoordinatorProposalAction::CompleteRun {
            summary: "fabricated completion".into(),
        },
        _ => panic!("test helper only supports two decisions"),
    };
    CoordinatorDecisionProposal {
        schema_version: COORDINATOR_PROPOSAL_SCHEMA_VERSION,
        reason: "current evidence supports the decision".into(),
        evidence_event_ids: vec![EventId::new("event-current").unwrap()],
        decision,
    }
}

#[tokio::test]
async fn malformed_json_gets_exactly_one_bounded_repair_attempt() {
    let valid = serde_json::to_string(&valid_proposal(CoordinatorDecision::ContinueTask)).unwrap();
    let model = FakeModel::new(["not-json".into(), valid]);
    let coordinator = Coordinator::new(model.clone());

    assert!(matches!(
        coordinator.decide(&prompt(), &snapshot()).await.unwrap(),
        CoordinatorDecisionOutcome::Validated(_)
    ));
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].repair.is_none());
    assert_eq!(requests[1].repair.as_ref().unwrap().attempt, 1);
    assert!(requests[1].repair.as_ref().unwrap().error.len() <= 512);
}

#[tokio::test]
async fn second_malformed_response_returns_typed_safe_pause() {
    let model = FakeModel::new(["not-json", "still-not-json"]);
    let coordinator = Coordinator::new(model.clone());

    let outcome = coordinator.decide(&prompt(), &snapshot()).await.unwrap();
    assert!(matches!(
        outcome,
        CoordinatorDecisionOutcome::SafePause(ref pause) if pause.attempts == 2
    ));
    assert_eq!(model.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn oversized_responses_are_repaired_once_then_paused() {
    let oversized = "x".repeat(65_537);
    let model = FakeModel::new([oversized.clone(), oversized]);
    let coordinator = Coordinator::new(model.clone());

    let outcome = coordinator.decide(&prompt(), &snapshot()).await.unwrap();
    assert!(matches!(
        outcome,
        CoordinatorDecisionOutcome::SafePause(ref pause)
            if pause.attempts == 2
                && pause.first_error.contains("exceeds")
                && pause.second_error.contains("exceeds")
    ));
    assert_eq!(model.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn valid_but_fabricated_completion_is_rejected_without_repair() {
    let response =
        serde_json::to_string(&valid_proposal(CoordinatorDecision::CompleteRun)).unwrap();
    let model = FakeModel::new([response]);
    let coordinator = Coordinator::new(model.clone());

    assert!(matches!(
        coordinator.decide(&prompt(), &snapshot()).await.unwrap(),
        CoordinatorDecisionOutcome::Rejected {
            error: DecisionValidationError::RunNotConverged,
            ..
        }
    ));
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}
