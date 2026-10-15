use super::{CoordinatorDecision, ProtocolError};
use serde::{Deserialize, Serialize};

pub const COORDINATOR_AUDIT_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorMode {
    Off,
    Shadow,
    Advisory,
    Authoritative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorQualificationResult {
    NotRequired,
    Qualified,
    Missing,
    Expired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorCandidateStatus {
    NotCalled,
    Valid,
    InvalidFormat,
    Rejected,
    ModelError,
    TimedOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorComparisonClass {
    NotCompared,
    Match,
    Divergent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorExecutionDisposition {
    Legacy,
    Coordinator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorFallbackReason {
    CoordinatorOff,
    ShadowMode,
    CandidateUnavailable,
    CandidateRejected,
    AdvisoryActionNotAllowed,
    Unqualified,
    Rollback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorDecisionPoint {
    WorkerBlocked,
    WorkerFailed,
    WorkerNeedsHelp,
    TaskPaused,
    PlanReview,
    CompletionCheck,
    UserSteering,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorRejectionReason {
    UnsupportedSchema,
    UnsupportedProtocol,
    InvalidEnvelope,
    ActionMismatch,
    RunMismatch,
    RunTerminal,
    StalePlan,
    MissingEvidence,
    ReplayedDecision,
    UnknownEvidence,
    PermissionEscalation,
    BudgetEscalation,
    MissingTarget,
    UnexpectedTarget,
    UnknownTarget,
    InvalidState,
    AgentTaskMismatch,
    RunNotConverged,
    InvalidPlanRevision,
    InvalidTaskProposal,
    WriteScopeExpansion,
    UnsafeWriteOwnership,
    ModelError,
    Timeout,
    RepeatedFormatFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorAuditRecord {
    pub schema_version: u16,
    pub requested_mode: CoordinatorMode,
    pub effective_mode: CoordinatorMode,
    pub qualification: CoordinatorQualificationResult,
    pub decision_point: CoordinatorDecisionPoint,
    pub candidate_status: CoordinatorCandidateStatus,
    pub legacy_action: Option<CoordinatorDecision>,
    pub coordinator_action: Option<CoordinatorDecision>,
    pub comparison: CoordinatorComparisonClass,
    pub rejection_reason: Option<CoordinatorRejectionReason>,
    pub execution_disposition: CoordinatorExecutionDisposition,
    pub fallback_reason: Option<CoordinatorFallbackReason>,
    pub latency_ms: u64,
    pub prompt_tokens: usize,
    pub completion_bytes: usize,
}

impl CoordinatorAuditRecord {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.schema_version != COORDINATOR_AUDIT_SCHEMA_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.schema_version));
        }
        if self.candidate_status == CoordinatorCandidateStatus::Valid
            && self.coordinator_action.is_none()
        {
            return Err(ProtocolError::InvalidEnvelope(
                "valid coordinator audit requires an action".into(),
            ));
        }
        if self.candidate_status != CoordinatorCandidateStatus::Valid
            && self.coordinator_action.is_some()
            && self.candidate_status != CoordinatorCandidateStatus::Rejected
        {
            return Err(ProtocolError::InvalidEnvelope(
                "non-candidate coordinator audit must not contain an action".into(),
            ));
        }
        let rejected = matches!(
            self.candidate_status,
            CoordinatorCandidateStatus::InvalidFormat
                | CoordinatorCandidateStatus::Rejected
                | CoordinatorCandidateStatus::ModelError
                | CoordinatorCandidateStatus::TimedOut
        );
        if rejected != self.rejection_reason.is_some() {
            return Err(ProtocolError::InvalidEnvelope(
                "coordinator rejection status and reason disagree".into(),
            ));
        }
        match self.comparison {
            CoordinatorComparisonClass::NotCompared => {}
            CoordinatorComparisonClass::Match => {
                if self.legacy_action.is_none() || self.legacy_action != self.coordinator_action {
                    return Err(ProtocolError::InvalidEnvelope(
                        "matching audit requires equal legacy and coordinator actions".into(),
                    ));
                }
            }
            CoordinatorComparisonClass::Divergent => {
                if self.legacy_action.is_none()
                    || self.coordinator_action.is_none()
                    || self.legacy_action == self.coordinator_action
                {
                    return Err(ProtocolError::InvalidEnvelope(
                        "divergent audit requires different actions".into(),
                    ));
                }
            }
        }
        if self.effective_mode == CoordinatorMode::Off
            && self.candidate_status != CoordinatorCandidateStatus::NotCalled
            && (self.execution_disposition != CoordinatorExecutionDisposition::Legacy
                || self.fallback_reason != Some(CoordinatorFallbackReason::Rollback))
        {
            return Err(ProtocolError::InvalidEnvelope(
                "an in-flight coordinator call observed after off rollback must use legacy".into(),
            ));
        }
        match self.execution_disposition {
            CoordinatorExecutionDisposition::Coordinator => {
                if self.candidate_status != CoordinatorCandidateStatus::Valid
                    || !matches!(
                        self.effective_mode,
                        CoordinatorMode::Advisory | CoordinatorMode::Authoritative
                    )
                    || self.fallback_reason.is_some()
                {
                    return Err(ProtocolError::InvalidEnvelope(
                        "coordinator execution requires a valid enabled candidate".into(),
                    ));
                }
            }
            CoordinatorExecutionDisposition::Legacy => {
                if self.fallback_reason.is_none() {
                    return Err(ProtocolError::InvalidEnvelope(
                        "legacy execution requires a fallback reason".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}
