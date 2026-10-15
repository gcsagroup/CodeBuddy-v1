use super::shadow::rejection_reason;
use super::{
    Coordinator, CoordinatorAction, CoordinatorDecisionOutcome, CoordinatorModelClient,
    CoordinatorPrompt, DecisionValidationSnapshot, ValidatedCoordinatorDecision,
};
use crate::agents::protocol::{
    CoordinatorAuditRecord, CoordinatorCandidateStatus, CoordinatorComparisonClass,
    CoordinatorDecision, CoordinatorDecisionPoint, CoordinatorExecutionDisposition,
    CoordinatorFallbackReason, CoordinatorMode, CoordinatorQualificationResult,
    CoordinatorRejectionReason, EventId, TaskState, COORDINATOR_AUDIT_SCHEMA_VERSION,
};
use async_trait::async_trait;
use std::time::Duration;
use tokio::time::{timeout, Instant};

const MAX_ADVISORY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorAuditReceipt {
    pub audit_event_id: EventId,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("coordinator audit commit failed: {message}")]
pub struct CoordinatorAuditCommitError {
    pub message: String,
}

impl CoordinatorAuditCommitError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait CoordinatorAuditCommitter: Send + Sync {
    async fn commit(
        &self,
        audit: &CoordinatorAuditRecord,
    ) -> Result<CoordinatorAuditReceipt, CoordinatorAuditCommitError>;
}

pub struct AdvisoryCoordinator<C, A> {
    coordinator: Coordinator<C>,
    audit_committer: A,
    timeout: Duration,
}

impl<C, A> AdvisoryCoordinator<C, A>
where
    C: CoordinatorModelClient,
    A: CoordinatorAuditCommitter,
{
    pub fn try_new(
        client: C,
        audit_committer: A,
        timeout: Duration,
    ) -> Result<Self, AdvisoryConfigurationError> {
        if timeout.is_zero() || timeout > MAX_ADVISORY_TIMEOUT {
            return Err(AdvisoryConfigurationError::InvalidTimeout {
                milliseconds: timeout.as_millis(),
                maximum_milliseconds: MAX_ADVISORY_TIMEOUT.as_millis(),
            });
        }
        Ok(Self {
            coordinator: Coordinator::new(client),
            audit_committer,
            timeout,
        })
    }

    pub async fn decide(
        &self,
        decision_point: CoordinatorDecisionPoint,
        prompt: &CoordinatorPrompt,
        snapshot: &DecisionValidationSnapshot,
        legacy_action: CoordinatorDecision,
    ) -> Result<AdvisoryExecution, AdvisoryCommitFailure> {
        let started = Instant::now();
        let result = timeout(
            self.timeout,
            self.coordinator.decide_with_metrics(prompt, snapshot),
        )
        .await;
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let mut validated = None;
        let (
            candidate_status,
            coordinator_action,
            comparison,
            rejection,
            completion_bytes,
            allowed,
        ) = match result {
            Err(_) => (
                CoordinatorCandidateStatus::TimedOut,
                None,
                CoordinatorComparisonClass::NotCompared,
                Some(CoordinatorRejectionReason::Timeout),
                0,
                false,
            ),
            Ok(Err(_)) => (
                CoordinatorCandidateStatus::ModelError,
                None,
                CoordinatorComparisonClass::NotCompared,
                Some(CoordinatorRejectionReason::ModelError),
                0,
                false,
            ),
            Ok(Ok(result)) => match result.outcome {
                CoordinatorDecisionOutcome::Validated(decision) => {
                    let decision = *decision;
                    let action = decision.envelope().candidate.decision;
                    let comparison = compare(action, legacy_action);
                    let allowed = advisory_allows(&decision, snapshot);
                    validated = Some(decision);
                    (
                        CoordinatorCandidateStatus::Valid,
                        Some(action),
                        comparison,
                        None,
                        result.completion_bytes,
                        allowed,
                    )
                }
                CoordinatorDecisionOutcome::Rejected { decision, error } => (
                    CoordinatorCandidateStatus::Rejected,
                    Some(decision),
                    CoordinatorComparisonClass::NotCompared,
                    Some(rejection_reason(&error)),
                    result.completion_bytes,
                    false,
                ),
                CoordinatorDecisionOutcome::SafePause(_) => (
                    CoordinatorCandidateStatus::InvalidFormat,
                    None,
                    CoordinatorComparisonClass::NotCompared,
                    Some(CoordinatorRejectionReason::RepeatedFormatFailure),
                    result.completion_bytes,
                    false,
                ),
            },
        };

        let execute_coordinator = candidate_status == CoordinatorCandidateStatus::Valid && allowed;
        let fallback_reason = if execute_coordinator {
            None
        } else if candidate_status == CoordinatorCandidateStatus::Valid {
            Some(CoordinatorFallbackReason::AdvisoryActionNotAllowed)
        } else if candidate_status == CoordinatorCandidateStatus::Rejected {
            Some(CoordinatorFallbackReason::CandidateRejected)
        } else {
            Some(CoordinatorFallbackReason::CandidateUnavailable)
        };
        let audit = CoordinatorAuditRecord {
            schema_version: COORDINATOR_AUDIT_SCHEMA_VERSION,
            requested_mode: CoordinatorMode::Advisory,
            effective_mode: CoordinatorMode::Advisory,
            qualification: CoordinatorQualificationResult::NotRequired,
            decision_point,
            candidate_status,
            legacy_action: Some(legacy_action),
            coordinator_action,
            comparison,
            rejection_reason: rejection,
            execution_disposition: if execute_coordinator {
                CoordinatorExecutionDisposition::Coordinator
            } else {
                CoordinatorExecutionDisposition::Legacy
            },
            fallback_reason,
            latency_ms,
            prompt_tokens: prompt.estimated_tokens,
            completion_bytes,
        };
        let executable = if execute_coordinator {
            Some(validated.ok_or_else(|| AdvisoryCommitFailure {
                legacy_action,
                error: AdvisoryError::InvalidAudit(
                    "coordinator execution is missing its validated capability".into(),
                ),
            })?)
        } else {
            None
        };
        audit.validate().map_err(|error| AdvisoryCommitFailure {
            legacy_action,
            error: AdvisoryError::InvalidAudit(error.to_string()),
        })?;
        let receipt =
            self.audit_committer
                .commit(&audit)
                .await
                .map_err(|error| AdvisoryCommitFailure {
                    legacy_action,
                    error: AdvisoryError::AuditCommit(error),
                })?;

        if let Some(decision) = executable {
            Ok(AdvisoryExecution::Coordinator(Box::new(
                CommittedAdvisoryDecision {
                    decision,
                    audit,
                    receipt,
                },
            )))
        } else {
            Ok(AdvisoryExecution::Legacy(CommittedLegacyDecision {
                action: legacy_action,
                audit,
                receipt,
            }))
        }
    }
}

fn compare(
    coordinator: CoordinatorDecision,
    legacy: CoordinatorDecision,
) -> CoordinatorComparisonClass {
    if coordinator == legacy {
        CoordinatorComparisonClass::Match
    } else {
        CoordinatorComparisonClass::Divergent
    }
}

fn advisory_allows(
    decision: &ValidatedCoordinatorDecision,
    snapshot: &DecisionValidationSnapshot,
) -> bool {
    let envelope = decision.envelope();
    if envelope.candidate.requested_budget.is_some()
        || !envelope.candidate.required_permissions.is_empty()
    {
        return false;
    }
    match &envelope.action {
        CoordinatorAction::ContinueTask => {
            envelope
                .candidate
                .target_task_id
                .as_ref()
                .and_then(|task_id| snapshot.task_state(task_id))
                == Some(TaskState::WaitingForCoordinator)
        }
        CoordinatorAction::RetryTask => {
            envelope
                .candidate
                .target_task_id
                .as_ref()
                .is_some_and(|task_id| snapshot.first_retry_is_available(task_id))
                && envelope
                    .candidate
                    .evidence_refs
                    .iter()
                    .any(|evidence| snapshot.is_failure_evidence(evidence.event_id()))
        }
        CoordinatorAction::SendInstruction { .. }
        | CoordinatorAction::PauseTask
        | CoordinatorAction::PauseRun => true,
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AdvisoryExecution {
    Coordinator(Box<CommittedAdvisoryDecision>),
    Legacy(CommittedLegacyDecision),
}

#[derive(Debug, PartialEq, Eq)]
pub struct CommittedAdvisoryDecision {
    decision: ValidatedCoordinatorDecision,
    audit: CoordinatorAuditRecord,
    receipt: CoordinatorAuditReceipt,
}

impl CommittedAdvisoryDecision {
    pub fn decision(&self) -> &ValidatedCoordinatorDecision {
        &self.decision
    }

    pub fn audit(&self) -> &CoordinatorAuditRecord {
        &self.audit
    }

    pub fn receipt(&self) -> &CoordinatorAuditReceipt {
        &self.receipt
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct CommittedLegacyDecision {
    action: CoordinatorDecision,
    audit: CoordinatorAuditRecord,
    receipt: CoordinatorAuditReceipt,
}

impl CommittedLegacyDecision {
    pub fn action(&self) -> CoordinatorDecision {
        self.action
    }

    pub fn audit(&self) -> &CoordinatorAuditRecord {
        &self.audit
    }

    pub fn receipt(&self) -> &CoordinatorAuditReceipt {
        &self.receipt
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct AdvisoryCommitFailure {
    pub legacy_action: CoordinatorDecision,
    pub error: AdvisoryError,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AdvisoryError {
    #[error(transparent)]
    AuditCommit(#[from] CoordinatorAuditCommitError),
    #[error("invalid coordinator audit: {0}")]
    InvalidAudit(String),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AdvisoryConfigurationError {
    #[error("advisory timeout {milliseconds}ms is outside 1..={maximum_milliseconds}ms")]
    InvalidTimeout {
        milliseconds: u128,
        maximum_milliseconds: u128,
    },
}
