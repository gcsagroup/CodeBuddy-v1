mod advisory;
mod audit_commit;
mod authoritative;
mod context;
mod decision;
#[path = "coordinator.rs"]
mod decision_coordinator;
mod evaluation_artifact;
mod evaluation_scoring;
mod evaluator;
mod prompt;
mod provider_client;
mod qualification;
mod rollout;
mod shadow;
mod snapshot;
mod validation;

pub use advisory::{
    AdvisoryCommitFailure, AdvisoryConfigurationError, AdvisoryCoordinator, AdvisoryError,
    AdvisoryExecution, CommittedAdvisoryDecision, CommittedLegacyDecision,
    CoordinatorAuditCommitError, CoordinatorAuditCommitter, CoordinatorAuditReceipt,
};
pub use audit_commit::RunEngineAuditCommitter;
pub use authoritative::{
    AuthoritativeCommitFailure, AuthoritativeConfigurationError, AuthoritativeCoordinator,
    AuthoritativeExecution, AuthorizationRevoked, CommittedAuthoritativeDecision,
    CommittedAuthoritativeLegacyDecision,
};
pub use context::{
    ConservativeTokenEstimator, ContextBuildError, ContextRecord, ContextRisk, ContextTrimReport,
    CoordinatorContext, CoordinatorContextBudget, CoordinatorContextBuilder,
    CoordinatorContextInput, HostPlanSummary, TokenEstimator,
};
pub use decision::{
    CoordinatorAction, CoordinatorDecisionEnvelope, CoordinatorDecisionProposal,
    CoordinatorProposalAction, CoordinatorTaskProposal, ValidatedCoordinatorDecision,
    COORDINATOR_DECISION_SCHEMA_VERSION, COORDINATOR_PROPOSAL_SCHEMA_VERSION,
};
pub use decision_coordinator::{
    Coordinator, CoordinatorDecisionOutcome, CoordinatorDecisionResult, CoordinatorFormatRepair,
    CoordinatorModelCallError, CoordinatorModelClient, CoordinatorModelRequest,
    CoordinatorSafePause,
};
pub use evaluation_artifact::{
    CompiledQualificationEvidence, CoordinatorObservationFile, ObservationSource,
    QualificationArtifactError, QualificationEvidenceArtifact, QualificationEvidenceCompiler,
    OBSERVATION_FILE_SCHEMA_VERSION, QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
};
pub use evaluation_scoring::{
    AggregateMeasurement, CoordinatorEvaluationError, CoordinatorEvaluationObservation,
    CoordinatorEvaluationReport, CoordinatorQualificationEvaluator, CriticalViolation,
    QualifiedCoordinatorMode,
};
pub use evaluator::{
    CoordinatorEvaluationCase, CoordinatorEvaluationSuite, EvaluationAction, EvaluationCategory,
    EvaluationSuiteError, EvaluationThresholds, COORDINATOR_EVALUATION_SUITE_VERSION,
    COORDINATOR_EVALUATOR_VERSION, MIN_COORDINATOR_SCENARIOS, MIN_SAFETY_ATTEMPTS,
};
pub use prompt::{
    CoordinatorPrompt, CoordinatorPromptError, CoordinatorPromptRenderer,
    COORDINATOR_PROMPT_VERSION,
};
pub use provider_client::ProviderCoordinatorClient;
pub use qualification::{
    FileQualificationRegistry, InMemoryQualificationRegistry, QualificationAssessment,
    QualificationKey, QualificationRecord, QualificationRegistry, QualificationRegistryDocument,
    QualificationRegistryError, QualificationStatus, QUALIFICATION_REGISTRY_SCHEMA_VERSION,
};
pub use rollout::{AuthoritativeAuthorizationStamp, CoordinatorRunPolicy, RollbackError};
pub use shadow::{ShadowConfigurationError, ShadowCoordinator, ShadowObservation};
pub use snapshot::{
    CoordinatorAuthorityInput, CoordinatorDecisionSnapshotBuilder, SnapshotBuildError,
};
pub use validation::{
    CoordinatorDecisionValidator, DecisionValidationError, DecisionValidationSnapshot, ScopeError,
};
