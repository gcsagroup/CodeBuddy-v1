use super::shadow::rejection_reason;
use super::{
    AdvisoryError, AuthoritativeAuthorizationStamp, Coordinator, CoordinatorAuditCommitter,
    CoordinatorAuditReceipt, CoordinatorDecisionOutcome, CoordinatorModelClient, CoordinatorPrompt,
    CoordinatorRunPolicy, DecisionValidationSnapshot, ValidatedCoordinatorDecision,
};
use crate::agents::protocol::{
    CoordinatorAuditRecord, CoordinatorCandidateStatus, CoordinatorComparisonClass,
    CoordinatorDecision, CoordinatorDecisionPoint, CoordinatorExecutionDisposition,
    CoordinatorFallbackReason, CoordinatorMode, CoordinatorRejectionReason,
    COORDINATOR_AUDIT_SCHEMA_VERSION,
};
use std::time::Duration;
use tokio::time::{timeout, Instant};

const MAX_AUTHORITATIVE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct AuthoritativeCoordinator<C, A> {
    coordinator: Coordinator<C>,
    audit_committer: A,
    policy: CoordinatorRunPolicy,
    timeout: Duration,
}

impl<C, A> AuthoritativeCoordinator<C, A>
where
    C: CoordinatorModelClient,
    A: CoordinatorAuditCommitter,
{
    pub fn try_new(
        client: C,
        audit_committer: A,
        policy: CoordinatorRunPolicy,
        timeout: Duration,
    ) -> Result<Self, AuthoritativeConfigurationError> {
        if policy.requested_mode() != CoordinatorMode::Authoritative {
            return Err(AuthoritativeConfigurationError::WrongRunMode(
                policy.requested_mode(),
            ));
        }
        if timeout.is_zero() || timeout > MAX_AUTHORITATIVE_TIMEOUT {
            return Err(AuthoritativeConfigurationError::InvalidTimeout {
                milliseconds: timeout.as_millis(),
                maximum_milliseconds: MAX_AUTHORITATIVE_TIMEOUT.as_millis(),
            });
        }
        Ok(Self {
            coordinator: Coordinator::new(client),
            audit_committer,
            policy,
            timeout,
        })
    }

    pub async fn decide(
        &self,
        decision_point: CoordinatorDecisionPoint,
        prompt: &CoordinatorPrompt,
        snapshot: &DecisionValidationSnapshot,
        legacy_action: CoordinatorDecision,
    ) -> Result<AuthoritativeExecution, AuthoritativeCommitFailure> {
        let initial_mode = self.policy.effective_mode();
        let authorization_stamp = self.policy.authorization_stamp();
        let started = Instant::now();
        let result = if initial_mode == CoordinatorMode::Off {
            None
        } else {
            Some(
                timeout(
                    self.timeout,
                    self.coordinator.decide_with_metrics(prompt, snapshot),
                )
                .await,
            )
        };
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let mut validated = None;
        let (candidate_status, coordinator_action, comparison, rejection, completion_bytes) =
            match result {
                None => (
                    CoordinatorCandidateStatus::NotCalled,
                    None,
                    CoordinatorComparisonClass::NotCompared,
                    None,
                    0,
                ),
                Some(Err(_)) => (
                    CoordinatorCandidateStatus::TimedOut,
                    None,
                    CoordinatorComparisonClass::NotCompared,
                    Some(CoordinatorRejectionReason::Timeout),
                    0,
                ),
                Some(Ok(Err(_))) => (
                    CoordinatorCandidateStatus::ModelError,
                    None,
                    CoordinatorComparisonClass::NotCompared,
                    Some(CoordinatorRejectionReason::ModelError),
                    0,
                ),
                Some(Ok(Ok(result))) => match result.outcome {
                    CoordinatorDecisionOutcome::Validated(decision) => {
                        let decision = *decision;
                        let action = decision.envelope().candidate.decision;
                        validated = Some(decision);
                        (
                            CoordinatorCandidateStatus::Valid,
                            Some(action),
                            compare(action, legacy_action),
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

        let effective_mode = self.policy.effective_mode();
        let executable = if effective_mode == CoordinatorMode::Authoritative
            && candidate_status == CoordinatorCandidateStatus::Valid
        {
            authorization_stamp.and_then(|stamp| {
                self.policy
                    .is_authorized(stamp)
                    .then(|| (validated.take(), stamp))
            })
        } else {
            None
        };
        let executable = match executable {
            Some((Some(decision), stamp)) => Some((decision, stamp)),
            _ => None,
        };
        let fallback_reason = if executable.is_some() {
            None
        } else {
            Some(fallback_reason(
                effective_mode,
                candidate_status,
                self.policy.qualification(),
            ))
        };
        let audit = CoordinatorAuditRecord {
            schema_version: COORDINATOR_AUDIT_SCHEMA_VERSION,
            requested_mode: self.policy.requested_mode(),
            effective_mode,
            qualification: self.policy.qualification(),
            decision_point,
            candidate_status,
            legacy_action: Some(legacy_action),
            coordinator_action,
            comparison,
            rejection_reason: rejection,
            execution_disposition: if executable.is_some() {
                CoordinatorExecutionDisposition::Coordinator
            } else {
                CoordinatorExecutionDisposition::Legacy
            },
            fallback_reason,
            latency_ms,
            prompt_tokens: if initial_mode == CoordinatorMode::Off {
                0
            } else {
                prompt.estimated_tokens
            },
            completion_bytes,
        };
        audit
            .validate()
            .map_err(|error| AuthoritativeCommitFailure {
                legacy_action,
                error: AdvisoryError::InvalidAudit(error.to_string()),
            })?;
        let receipt = self.audit_committer.commit(&audit).await.map_err(|error| {
            AuthoritativeCommitFailure {
                legacy_action,
                error: AdvisoryError::AuditCommit(error),
            }
        })?;

        if let Some((decision, stamp)) = executable {
            Ok(AuthoritativeExecution::Coordinator(Box::new(
                CommittedAuthoritativeDecision {
                    decision,
                    audit,
                    receipt,
                    policy: self.policy.clone(),
                    authorization_stamp: stamp,
                    legacy_action,
                },
            )))
        } else {
            Ok(AuthoritativeExecution::Legacy(
                CommittedAuthoritativeLegacyDecision {
                    action: legacy_action,
                    audit,
                    receipt,
                },
            ))
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

fn fallback_reason(
    effective_mode: CoordinatorMode,
    candidate_status: CoordinatorCandidateStatus,
    qualification: crate::agents::protocol::CoordinatorQualificationResult,
) -> CoordinatorFallbackReason {
    if effective_mode == CoordinatorMode::Off {
        CoordinatorFallbackReason::Rollback
    } else if effective_mode == CoordinatorMode::Shadow {
        if qualification == crate::agents::protocol::CoordinatorQualificationResult::Qualified {
            CoordinatorFallbackReason::Rollback
        } else {
            CoordinatorFallbackReason::Unqualified
        }
    } else if candidate_status == CoordinatorCandidateStatus::Rejected {
        CoordinatorFallbackReason::CandidateRejected
    } else {
        CoordinatorFallbackReason::CandidateUnavailable
    }
}

#[derive(Debug)]
pub enum AuthoritativeExecution {
    Coordinator(Box<CommittedAuthoritativeDecision>),
    Legacy(CommittedAuthoritativeLegacyDecision),
}

#[derive(Debug)]
pub struct CommittedAuthoritativeDecision {
    decision: ValidatedCoordinatorDecision,
    audit: CoordinatorAuditRecord,
    receipt: CoordinatorAuditReceipt,
    policy: CoordinatorRunPolicy,
    authorization_stamp: AuthoritativeAuthorizationStamp,
    legacy_action: CoordinatorDecision,
}

impl CommittedAuthoritativeDecision {
    pub fn authorize(&self) -> Result<&ValidatedCoordinatorDecision, AuthorizationRevoked> {
        if self.policy.is_authorized(self.authorization_stamp) {
            Ok(&self.decision)
        } else {
            Err(AuthorizationRevoked)
        }
    }

    pub fn fallback_action(&self) -> CoordinatorDecision {
        self.legacy_action
    }

    pub fn audit(&self) -> &CoordinatorAuditRecord {
        &self.audit
    }

    pub fn receipt(&self) -> &CoordinatorAuditReceipt {
        &self.receipt
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct CommittedAuthoritativeLegacyDecision {
    action: CoordinatorDecision,
    audit: CoordinatorAuditRecord,
    receipt: CoordinatorAuditReceipt,
}

impl CommittedAuthoritativeLegacyDecision {
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

#[derive(Debug, Clone, Copy, thiserror::Error, PartialEq, Eq)]
#[error("authoritative coordinator authorization was revoked")]
pub struct AuthorizationRevoked;

#[derive(Debug, PartialEq, Eq)]
pub struct AuthoritativeCommitFailure {
    pub legacy_action: CoordinatorDecision,
    pub error: AdvisoryError,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthoritativeConfigurationError {
    #[error("authoritative controller requires authoritative run mode, got {0:?}")]
    WrongRunMode(CoordinatorMode),
    #[error("authoritative timeout {milliseconds}ms is outside 1..={maximum_milliseconds}ms")]
    InvalidTimeout {
        milliseconds: u128,
        maximum_milliseconds: u128,
    },
}
