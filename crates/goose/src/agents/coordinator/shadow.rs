use super::{
    Coordinator, CoordinatorDecisionOutcome, CoordinatorModelClient, CoordinatorPrompt,
    DecisionValidationError, DecisionValidationSnapshot,
};
use crate::agents::protocol::{
    CoordinatorAuditRecord, CoordinatorCandidateStatus, CoordinatorComparisonClass,
    CoordinatorDecision, CoordinatorDecisionPoint, CoordinatorExecutionDisposition,
    CoordinatorFallbackReason, CoordinatorMode, CoordinatorQualificationResult,
    CoordinatorRejectionReason, RunEventPayload, COORDINATOR_AUDIT_SCHEMA_VERSION,
};
use std::time::Duration;
use tokio::time::{timeout, Instant};

const MAX_SHADOW_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ShadowCoordinator<C> {
    coordinator: Coordinator<C>,
    timeout: Duration,
}

impl<C> ShadowCoordinator<C>
where
    C: CoordinatorModelClient,
{
    pub fn try_new(client: C, timeout: Duration) -> Result<Self, ShadowConfigurationError> {
        if timeout.is_zero() || timeout > MAX_SHADOW_TIMEOUT {
            return Err(ShadowConfigurationError::InvalidTimeout {
                milliseconds: timeout.as_millis(),
                maximum_milliseconds: MAX_SHADOW_TIMEOUT.as_millis(),
            });
        }
        Ok(Self {
            coordinator: Coordinator::new(client),
            timeout,
        })
    }

    pub async fn observe(
        &self,
        decision_point: CoordinatorDecisionPoint,
        prompt: &CoordinatorPrompt,
        snapshot: &DecisionValidationSnapshot,
        legacy_action: CoordinatorDecision,
    ) -> ShadowObservation {
        let started = Instant::now();
        let result = timeout(
            self.timeout,
            self.coordinator.decide_with_metrics(prompt, snapshot),
        )
        .await;
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let (candidate_status, coordinator_action, comparison, rejection_reason, completion_bytes) =
            match result {
                Err(_) => (
                    CoordinatorCandidateStatus::TimedOut,
                    None,
                    CoordinatorComparisonClass::NotCompared,
                    Some(CoordinatorRejectionReason::Timeout),
                    0,
                ),
                Ok(Err(_)) => (
                    CoordinatorCandidateStatus::ModelError,
                    None,
                    CoordinatorComparisonClass::NotCompared,
                    Some(CoordinatorRejectionReason::ModelError),
                    0,
                ),
                Ok(Ok(result)) => match result.outcome {
                    CoordinatorDecisionOutcome::Validated(validated) => {
                        let action = validated.envelope().candidate.decision;
                        let comparison = if action == legacy_action {
                            CoordinatorComparisonClass::Match
                        } else {
                            CoordinatorComparisonClass::Divergent
                        };
                        (
                            CoordinatorCandidateStatus::Valid,
                            Some(action),
                            comparison,
                            None,
                            result.completion_bytes,
                        )
                    }
                    CoordinatorDecisionOutcome::Rejected { decision, error } => (
                        CoordinatorCandidateStatus::Rejected,
                        Some(decision),
                        CoordinatorComparisonClass::NotCompared,
                        Some(rejection_reason(&error)),
                        result.completion_bytes,
                    ),
                    CoordinatorDecisionOutcome::SafePause(_) => (
                        CoordinatorCandidateStatus::InvalidFormat,
                        None,
                        CoordinatorComparisonClass::NotCompared,
                        Some(CoordinatorRejectionReason::RepeatedFormatFailure),
                        result.completion_bytes,
                    ),
                },
            };

        let audit = CoordinatorAuditRecord {
            schema_version: COORDINATOR_AUDIT_SCHEMA_VERSION,
            requested_mode: CoordinatorMode::Shadow,
            effective_mode: CoordinatorMode::Shadow,
            qualification: CoordinatorQualificationResult::NotRequired,
            decision_point,
            candidate_status,
            legacy_action: Some(legacy_action),
            coordinator_action,
            comparison,
            rejection_reason,
            execution_disposition: CoordinatorExecutionDisposition::Legacy,
            fallback_reason: Some(CoordinatorFallbackReason::ShadowMode),
            latency_ms,
            prompt_tokens: prompt.estimated_tokens,
            completion_bytes,
        };
        debug_assert!(audit.validate().is_ok());
        ShadowObservation {
            execution_action: legacy_action,
            audit,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowObservation {
    execution_action: CoordinatorDecision,
    audit: CoordinatorAuditRecord,
}

impl ShadowObservation {
    pub fn execution_action(&self) -> CoordinatorDecision {
        self.execution_action
    }

    pub fn audit(&self) -> &CoordinatorAuditRecord {
        &self.audit
    }

    pub fn audit_event(&self) -> RunEventPayload {
        RunEventPayload::CoordinatorAuditRecorded {
            audit: self.audit.clone(),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ShadowConfigurationError {
    #[error("shadow timeout {milliseconds}ms is outside 1..={maximum_milliseconds}ms")]
    InvalidTimeout {
        milliseconds: u128,
        maximum_milliseconds: u128,
    },
}

pub(super) fn rejection_reason(error: &DecisionValidationError) -> CoordinatorRejectionReason {
    match error {
        DecisionValidationError::UnsupportedSchema(_) => {
            CoordinatorRejectionReason::UnsupportedSchema
        }
        DecisionValidationError::UnsupportedProtocol(_) => {
            CoordinatorRejectionReason::UnsupportedProtocol
        }
        DecisionValidationError::InvalidEnvelope(_) => CoordinatorRejectionReason::InvalidEnvelope,
        DecisionValidationError::ActionMismatch => CoordinatorRejectionReason::ActionMismatch,
        DecisionValidationError::RunMismatch { .. } => CoordinatorRejectionReason::RunMismatch,
        DecisionValidationError::RunTerminal(_) => CoordinatorRejectionReason::RunTerminal,
        DecisionValidationError::InvalidRunState(_) => CoordinatorRejectionReason::InvalidState,
        DecisionValidationError::StalePlan { .. } => CoordinatorRejectionReason::StalePlan,
        DecisionValidationError::MissingEvidence => CoordinatorRejectionReason::MissingEvidence,
        DecisionValidationError::ReplayedDecision(_) => {
            CoordinatorRejectionReason::ReplayedDecision
        }
        DecisionValidationError::UnknownEvidence(_) => CoordinatorRejectionReason::UnknownEvidence,
        DecisionValidationError::PermissionEscalation(_) => {
            CoordinatorRejectionReason::PermissionEscalation
        }
        DecisionValidationError::BudgetEscalation => CoordinatorRejectionReason::BudgetEscalation,
        DecisionValidationError::MissingTargetTask
        | DecisionValidationError::MissingTargetAgent => CoordinatorRejectionReason::MissingTarget,
        DecisionValidationError::UnexpectedTarget => CoordinatorRejectionReason::UnexpectedTarget,
        DecisionValidationError::UnknownTask(_) | DecisionValidationError::UnknownAgent(_) => {
            CoordinatorRejectionReason::UnknownTarget
        }
        DecisionValidationError::InvalidTaskState { .. }
        | DecisionValidationError::InvalidAgentState { .. } => {
            CoordinatorRejectionReason::InvalidState
        }
        DecisionValidationError::AgentTaskMismatch { .. } => {
            CoordinatorRejectionReason::AgentTaskMismatch
        }
        DecisionValidationError::RunNotConverged => CoordinatorRejectionReason::RunNotConverged,
        DecisionValidationError::InvalidPlanRevision { .. } => {
            CoordinatorRejectionReason::InvalidPlanRevision
        }
        DecisionValidationError::InvalidTaskProposal(_) => {
            CoordinatorRejectionReason::InvalidTaskProposal
        }
        DecisionValidationError::WriteScopeExpansion { .. } => {
            CoordinatorRejectionReason::WriteScopeExpansion
        }
        DecisionValidationError::UnsafeWriteOwnership(_) => {
            CoordinatorRejectionReason::UnsafeWriteOwnership
        }
    }
}
