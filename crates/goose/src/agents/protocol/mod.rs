mod commands;
mod coordinator_audit;
mod events;
mod identifiers;
mod outcomes;
mod states;
mod versioning;

pub use commands::{
    BudgetRequest, ControlCommand, CoordinatorDecision, CoordinatorDecisionCandidate, PlannedTask,
};
pub use coordinator_audit::{
    CoordinatorAuditRecord, CoordinatorCandidateStatus, CoordinatorComparisonClass,
    CoordinatorDecisionPoint, CoordinatorExecutionDisposition, CoordinatorFallbackReason,
    CoordinatorMode, CoordinatorQualificationResult, CoordinatorRejectionReason,
    COORDINATOR_AUDIT_SCHEMA_VERSION,
};
pub use events::{
    EvidenceRequirement, ExecutionObligation, PlanRevisionAudit, RequirementContinuationSource,
    RequirementEffect, RequirementRevisionKind, RequirementRevisionRelation, RequirementSemantics,
    RunEvent, RunEventPayload, TaskDependency, TaskWorkspaceGrant, UserInputResolution,
    UserRequirement,
};
pub use identifiers::{AgentId, EventId, EvidenceRef, RunId, TaskId};
pub(crate) use outcomes::MAX_PROTOCOL_TEXT_BYTES;
pub use outcomes::{
    AssistanceRequest, BlockKind, BlockReason, CancellationReport, Checkpoint, FailureClass,
    TaskFailure, TaskResult, WorkerOutcome,
};
pub use states::{AgentState, RecoveryAction, RecoveryDecision, RunState, TaskState};
pub use versioning::{ProtocolVersion, CURRENT_PROTOCOL_VERSION};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("invalid {kind}: {value}")]
    InvalidIdentifier { kind: &'static str, value: String },
    #[error("unsupported CodePro protocol version: {0}")]
    UnsupportedVersion(u16),
    #[error("invalid evidence artifact reference: {0}")]
    InvalidArtifactRef(String),
    #[error("evidence belongs to run {actual}, expected {expected}")]
    CrossRunEvidence { expected: String, actual: String },
    #[error("protocol object belongs to run {actual}, expected {expected}")]
    RunMismatch { expected: String, actual: String },
    #[error("invalid {entity} state transition: {from} -> {to}")]
    InvalidStateTransition {
        entity: &'static str,
        from: String,
        to: String,
    },
    #[error("protocol limit exceeded for {field}: {actual} > {maximum}")]
    LimitExceeded {
        field: &'static str,
        actual: usize,
        maximum: usize,
    },
    #[error("invalid CodePro event envelope: {0}")]
    InvalidEnvelope(String),
}
