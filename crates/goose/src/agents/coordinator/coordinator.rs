use super::{
    CoordinatorAction, CoordinatorDecisionEnvelope, CoordinatorDecisionProposal,
    CoordinatorDecisionValidator, CoordinatorPrompt, CoordinatorProposalAction,
    DecisionValidationError, DecisionValidationSnapshot, ValidatedCoordinatorDecision,
    COORDINATOR_PROPOSAL_SCHEMA_VERSION,
};
use crate::agents::protocol::{CoordinatorDecisionCandidate, EventId, ProtocolVersion};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

const MAX_REPAIR_ERROR_BYTES: usize = 512;
const MAX_RESPONSE_BYTES: usize = 65_536;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorModelRequest {
    pub prompt: String,
    pub repair: Option<CoordinatorFormatRepair>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinatorFormatRepair {
    pub attempt: u8,
    pub schema_version: u16,
    pub error: String,
}

#[async_trait]
pub trait CoordinatorModelClient: Send + Sync {
    async fn generate(
        &self,
        request: CoordinatorModelRequest,
    ) -> Result<String, CoordinatorModelCallError>;
}

pub struct Coordinator<C> {
    client: C,
}

impl<C> Coordinator<C>
where
    C: CoordinatorModelClient,
{
    pub fn new(client: C) -> Self {
        Self { client }
    }

    pub async fn decide(
        &self,
        prompt: &CoordinatorPrompt,
        snapshot: &DecisionValidationSnapshot,
    ) -> Result<CoordinatorDecisionOutcome, CoordinatorModelCallError> {
        Ok(self.decide_with_metrics(prompt, snapshot).await?.outcome)
    }

    pub async fn decide_with_metrics(
        &self,
        prompt: &CoordinatorPrompt,
        snapshot: &DecisionValidationSnapshot,
    ) -> Result<CoordinatorDecisionResult, CoordinatorModelCallError> {
        let first_response = self
            .client
            .generate(CoordinatorModelRequest {
                prompt: prompt.text.clone(),
                repair: None,
            })
            .await?;
        let mut completion_bytes = first_response.len();
        let mut attempts = 1;

        let envelope = match decode_response(&first_response, snapshot) {
            Ok(envelope) => envelope,
            Err(first_error) => {
                let first_error = bounded_error(&first_error.to_string());
                let second_response = self
                    .client
                    .generate(CoordinatorModelRequest {
                        prompt: prompt.text.clone(),
                        repair: Some(CoordinatorFormatRepair {
                            attempt: 1,
                            schema_version: COORDINATOR_PROPOSAL_SCHEMA_VERSION,
                            error: first_error.clone(),
                        }),
                    })
                    .await?;
                attempts = 2;
                completion_bytes = completion_bytes.saturating_add(second_response.len());
                match decode_response(&second_response, snapshot) {
                    Ok(envelope) => envelope,
                    Err(second_error) => {
                        return Ok(CoordinatorDecisionResult {
                            outcome: CoordinatorDecisionOutcome::SafePause(CoordinatorSafePause {
                                attempts: 2,
                                first_error,
                                second_error: bounded_error(&second_error.to_string()),
                            }),
                            attempts,
                            completion_bytes,
                        });
                    }
                }
            }
        };

        let decision = envelope.candidate.decision;
        Ok(CoordinatorDecisionResult {
            outcome: match CoordinatorDecisionValidator::validate(envelope, snapshot) {
                Ok(validated) => CoordinatorDecisionOutcome::Validated(Box::new(validated)),
                Err(error) => CoordinatorDecisionOutcome::Rejected { decision, error },
            },
            attempts,
            completion_bytes,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct CoordinatorDecisionResult {
    pub outcome: CoordinatorDecisionOutcome,
    pub attempts: u8,
    pub completion_bytes: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CoordinatorDecisionOutcome {
    Validated(Box<ValidatedCoordinatorDecision>),
    Rejected {
        decision: crate::agents::protocol::CoordinatorDecision,
        error: DecisionValidationError,
    },
    SafePause(CoordinatorSafePause),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoordinatorSafePause {
    pub attempts: u8,
    pub first_error: String,
    pub second_error: String,
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
#[error("coordinator model call failed: {message}")]
pub struct CoordinatorModelCallError {
    pub message: String,
}

impl CoordinatorModelCallError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

fn bounded_error(error: &str) -> String {
    if error.len() <= MAX_REPAIR_ERROR_BYTES {
        return error.to_string();
    }
    let mut boundary = MAX_REPAIR_ERROR_BYTES;
    while !error.is_char_boundary(boundary) {
        boundary -= 1;
    }
    error
        .get(..boundary)
        .expect("boundary is adjusted to a UTF-8 character boundary")
        .to_string()
}

fn decode_response(
    response: &str,
    snapshot: &DecisionValidationSnapshot,
) -> Result<CoordinatorDecisionEnvelope, String> {
    if response.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "coordinator response exceeds {MAX_RESPONSE_BYTES} bytes"
        ));
    }
    let proposal = serde_json::from_str::<CoordinatorDecisionProposal>(response)
        .map_err(|error| error.to_string())?;
    bind_proposal(proposal, snapshot).map_err(|error| error.to_string())
}

fn bind_proposal(
    proposal: CoordinatorDecisionProposal,
    snapshot: &DecisionValidationSnapshot,
) -> Result<CoordinatorDecisionEnvelope, DecisionBindingError> {
    proposal.validate_shape()?;
    let decision_id = EventId::new(format!("coordinator-decision-{}", uuid::Uuid::new_v4()))?;
    let next_revision = snapshot
        .plan_revision()
        .checked_add(1)
        .ok_or(DecisionBindingError::PlanRevisionOverflow)?;
    let (action, target_task_id, target_agent_id) = match proposal.decision {
        CoordinatorProposalAction::ContinueTask { task_id } => {
            (CoordinatorAction::ContinueTask, Some(task_id), None)
        }
        CoordinatorProposalAction::SendInstruction {
            task_id,
            agent_id,
            instruction,
        } => (
            CoordinatorAction::SendInstruction { instruction },
            Some(task_id),
            Some(agent_id),
        ),
        CoordinatorProposalAction::SpawnTask { task } => (
            CoordinatorAction::SpawnTask {
                plan_revision: next_revision,
                task,
            },
            None,
            None,
        ),
        CoordinatorProposalAction::RetryTask { task_id } => {
            (CoordinatorAction::RetryTask, Some(task_id), None)
        }
        CoordinatorProposalAction::ReplaceWorker {
            task_id,
            agent_id,
            role,
        } => (
            CoordinatorAction::ReplaceWorker { role },
            Some(task_id),
            Some(agent_id),
        ),
        CoordinatorProposalAction::RevisePlan { tasks } => (
            CoordinatorAction::RevisePlan {
                plan_revision: next_revision,
                tasks,
            },
            None,
            None,
        ),
        CoordinatorProposalAction::PauseTask { task_id } => {
            (CoordinatorAction::PauseTask, Some(task_id), None)
        }
        CoordinatorProposalAction::PauseRun => (CoordinatorAction::PauseRun, None, None),
        CoordinatorProposalAction::CancelTask { task_id } => {
            (CoordinatorAction::CancelTask, Some(task_id), None)
        }
        CoordinatorProposalAction::CancelBranch { root_task_id } => {
            (CoordinatorAction::CancelBranch, Some(root_task_id), None)
        }
        CoordinatorProposalAction::AskUser { question } => {
            (CoordinatorAction::AskUser { question }, None, None)
        }
        CoordinatorProposalAction::CompleteRun { summary } => {
            (CoordinatorAction::CompleteRun { summary }, None, None)
        }
        CoordinatorProposalAction::FailRun { class, message } => {
            (CoordinatorAction::FailRun { class, message }, None, None)
        }
    };
    let decision = action.decision_kind();
    let evidence_refs = snapshot.resolve_evidence_refs(&proposal.evidence_event_ids)?;
    Ok(CoordinatorDecisionEnvelope {
        schema_version: super::COORDINATOR_DECISION_SCHEMA_VERSION,
        candidate: CoordinatorDecisionCandidate {
            protocol_version: ProtocolVersion::CURRENT,
            run_id: snapshot.run_id().clone(),
            decision_id,
            decision,
            reason: proposal.reason.clone(),
            target_task_id,
            target_agent_id,
            evidence_refs,
            requested_budget: None,
            required_permissions: Vec::new(),
            expected_completion: proposal.reason,
            supersedes_plan_revision: Some(snapshot.plan_revision()),
        },
        action,
    })
}

#[derive(Debug, thiserror::Error)]
enum DecisionBindingError {
    #[error(transparent)]
    Shape(#[from] super::decision::DecisionShapeError),
    #[error(transparent)]
    Protocol(#[from] crate::agents::protocol::ProtocolError),
    #[error(transparent)]
    Validation(#[from] DecisionValidationError),
    #[error("coordinator plan revision overflow")]
    PlanRevisionOverflow,
}
