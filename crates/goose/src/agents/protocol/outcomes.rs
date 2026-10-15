use super::{EvidenceRef, ProtocolError, RecoveryAction, RecoveryDecision, RunId, RunState};
use serde::{Deserialize, Serialize};

pub(crate) const MAX_PROTOCOL_TEXT_BYTES: usize = 4_096;
pub(super) const MAX_PROTOCOL_NAME_BYTES: usize = 128;
pub(super) const MAX_PROTOCOL_LIST_ITEMS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    TransientInfrastructure,
    Environment,
    Validation,
    Implementation,
    PermissionDenied,
    PolicyViolation,
    ContextInsufficient,
    BudgetExhausted,
    NoProgress,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Environment,
    Permission,
    UserInput,
    Dependency,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskResult {
    pub summary: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskFailure {
    pub class: FailureClass,
    pub message: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockReason {
    pub kind: BlockKind,
    pub message: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistanceRequest {
    pub reason: String,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub checkpoint_id: String,
    pub summary: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancellationReport {
    pub reason: String,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", content = "details", rename_all = "snake_case")]
pub enum WorkerOutcome {
    Succeeded(TaskResult),
    Skipped(TaskResult),
    VerificationFailed(TaskFailure),
    RepairPending(Checkpoint),
    WaitingForUser(Checkpoint),
    RepairExhausted(TaskFailure),
    Failed(TaskFailure),
    Blocked(BlockReason),
    NeedsHelp(AssistanceRequest),
    Paused(Checkpoint),
    Cancelled(CancellationReport),
}

impl WorkerOutcome {
    pub fn recovery_decision(&self) -> RecoveryDecision {
        let (state, action, terminal) = match self {
            Self::Succeeded(_) | Self::Skipped(_) => {
                (RunState::Running, RecoveryAction::Finish, false)
            }
            Self::VerificationFailed(_) => (
                RunState::VerificationFailed,
                RecoveryAction::RepairThenRetest,
                false,
            ),
            Self::RepairPending(_) => {
                (RunState::Repairing, RecoveryAction::RepairThenRetest, false)
            }
            Self::WaitingForUser(_) => (
                RunState::WaitingForUser,
                RecoveryAction::AskUserThenResume,
                false,
            ),
            Self::RepairExhausted(_) => (RunState::Exhausted, RecoveryAction::Finish, true),
            Self::Failed(failure) => match failure.class {
                FailureClass::TransientInfrastructure | FailureClass::Environment => (
                    RunState::WaitingForEnvironment,
                    RecoveryAction::DiagnoseEnvironment,
                    false,
                ),
                FailureClass::Validation | FailureClass::Implementation => (
                    RunState::VerificationFailed,
                    RecoveryAction::RepairThenRetest,
                    false,
                ),
                FailureClass::PermissionDenied | FailureClass::ContextInsufficient => (
                    RunState::WaitingForUser,
                    RecoveryAction::AskUserThenResume,
                    false,
                ),
                FailureClass::BudgetExhausted => {
                    (RunState::Exhausted, RecoveryAction::Finish, true)
                }
                FailureClass::PolicyViolation => (RunState::Fatal, RecoveryAction::Finish, true),
                FailureClass::NoProgress | FailureClass::Unknown => {
                    (RunState::Running, RecoveryAction::Replan, false)
                }
            },
            Self::Blocked(reason) => match reason.kind {
                BlockKind::Environment | BlockKind::Dependency => (
                    RunState::WaitingForEnvironment,
                    RecoveryAction::DiagnoseEnvironment,
                    false,
                ),
                BlockKind::Permission | BlockKind::UserInput => (
                    RunState::WaitingForUser,
                    RecoveryAction::AskUserThenResume,
                    false,
                ),
                BlockKind::Other => (RunState::Running, RecoveryAction::Replan, false),
            },
            Self::NeedsHelp(_) => (RunState::Running, RecoveryAction::Replan, false),
            Self::Paused(_) => (RunState::Paused, RecoveryAction::RetrySameStep, false),
            Self::Cancelled(_) => (RunState::Cancelled, RecoveryAction::Finish, true),
        };
        RecoveryDecision {
            state,
            action,
            terminal,
        }
    }

    pub fn validate_for_run(&self, run_id: &RunId) -> Result<(), ProtocolError> {
        match self {
            Self::Succeeded(result) | Self::Skipped(result) => {
                validate_required_text("task_result.summary", &result.summary)?;
                validate_evidence_refs(&result.evidence_refs, run_id)
            }
            Self::Failed(failure) => {
                validate_required_text("task_failure.message", &failure.message)?;
                validate_evidence_refs(&failure.evidence_refs, run_id)
            }
            Self::VerificationFailed(failure) | Self::RepairExhausted(failure) => {
                validate_required_text("verification_failure.message", &failure.message)?;
                validate_evidence_refs(&failure.evidence_refs, run_id)
            }
            Self::RepairPending(checkpoint) | Self::WaitingForUser(checkpoint) => {
                validate_named_value("checkpoint.checkpoint_id", &checkpoint.checkpoint_id)?;
                validate_required_text("checkpoint.summary", &checkpoint.summary)?;
                validate_evidence_refs(&checkpoint.evidence_refs, run_id)
            }
            Self::Blocked(reason) => {
                validate_required_text("block_reason.message", &reason.message)?;
                validate_evidence_refs(&reason.evidence_refs, run_id)
            }
            Self::NeedsHelp(request) => {
                validate_required_text("assistance_request.reason", &request.reason)?;
                validate_string_list(
                    "assistance_request.required_capabilities",
                    &request.required_capabilities,
                    MAX_PROTOCOL_NAME_BYTES,
                )?;
                validate_evidence_refs(&request.evidence_refs, run_id)
            }
            Self::Paused(checkpoint) => {
                validate_named_value("checkpoint.checkpoint_id", &checkpoint.checkpoint_id)?;
                validate_required_text("checkpoint.summary", &checkpoint.summary)?;
                validate_evidence_refs(&checkpoint.evidence_refs, run_id)
            }
            Self::Cancelled(report) => {
                validate_required_text("cancellation_report.reason", &report.reason)?;
                validate_evidence_refs(&report.evidence_refs, run_id)
            }
        }
    }
}

pub(super) fn validate_required_text(
    field: &'static str,
    value: &str,
) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(ProtocolError::InvalidEnvelope(format!(
            "{field} must not be empty"
        )));
    }
    validate_length(field, value.len(), MAX_PROTOCOL_TEXT_BYTES)
}

pub(super) fn validate_named_value(field: &'static str, value: &str) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(ProtocolError::InvalidEnvelope(format!(
            "{field} must not be empty"
        )));
    }
    validate_length(field, value.len(), MAX_PROTOCOL_NAME_BYTES)
}

pub(super) fn validate_string_list(
    field: &'static str,
    values: &[String],
    max_item_bytes: usize,
) -> Result<(), ProtocolError> {
    validate_length(field, values.len(), MAX_PROTOCOL_LIST_ITEMS)?;
    for value in values {
        if value.trim().is_empty() {
            return Err(ProtocolError::InvalidEnvelope(format!(
                "{field} contains an empty item"
            )));
        }
        validate_length(field, value.len(), max_item_bytes)?;
    }
    Ok(())
}

pub(super) fn validate_evidence_refs(
    evidence_refs: &[EvidenceRef],
    run_id: &RunId,
) -> Result<(), ProtocolError> {
    validate_length(
        "evidence_refs",
        evidence_refs.len(),
        MAX_PROTOCOL_LIST_ITEMS,
    )?;
    for evidence_ref in evidence_refs {
        evidence_ref.validate_for_run(run_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::agents::protocol::{RecoveryAction, RunState};

    fn failure(class: FailureClass) -> TaskFailure {
        TaskFailure {
            class,
            message: "structured failure".to_string(),
            evidence_refs: Vec::new(),
        }
    }

    fn checkpoint() -> Checkpoint {
        Checkpoint {
            checkpoint_id: "checkpoint-1".to_string(),
            summary: "resume the same step".to_string(),
            evidence_refs: Vec::new(),
        }
    }

    #[test]
    fn recoverable_worker_outcomes_never_collapse_to_terminal_failure() {
        for (outcome, expected_state, expected_action) in [
            (
                WorkerOutcome::VerificationFailed(failure(FailureClass::Validation)),
                RunState::VerificationFailed,
                RecoveryAction::RepairThenRetest,
            ),
            (
                WorkerOutcome::Failed(failure(FailureClass::Environment)),
                RunState::WaitingForEnvironment,
                RecoveryAction::DiagnoseEnvironment,
            ),
            (
                WorkerOutcome::WaitingForUser(checkpoint()),
                RunState::WaitingForUser,
                RecoveryAction::AskUserThenResume,
            ),
            (
                WorkerOutcome::Failed(failure(FailureClass::NoProgress)),
                RunState::Running,
                RecoveryAction::Replan,
            ),
        ] {
            let decision = outcome.recovery_decision();
            assert_eq!(decision.state, expected_state);
            assert_eq!(decision.action, expected_action);
            assert!(!decision.terminal);
        }
    }

    #[test]
    fn only_cancel_exhaustion_and_fatal_faults_are_terminal() {
        for (outcome, expected_state) in [
            (
                WorkerOutcome::Cancelled(CancellationReport {
                    reason: "cancelled by user".to_string(),
                    evidence_refs: Vec::new(),
                }),
                RunState::Cancelled,
            ),
            (
                WorkerOutcome::RepairExhausted(failure(FailureClass::BudgetExhausted)),
                RunState::Exhausted,
            ),
            (
                WorkerOutcome::Failed(failure(FailureClass::PolicyViolation)),
                RunState::Fatal,
            ),
        ] {
            let decision = outcome.recovery_decision();
            assert_eq!(decision.state, expected_state);
            assert_eq!(decision.action, RecoveryAction::Finish);
            assert!(decision.terminal);
        }
    }
}

fn validate_length(
    field: &'static str,
    actual: usize,
    maximum: usize,
) -> Result<(), ProtocolError> {
    if actual <= maximum {
        Ok(())
    } else {
        Err(ProtocolError::LimitExceeded {
            field,
            actual,
            maximum,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_limits_are_rejected_without_truncation() {
        let run_id = RunId::new("run-1").unwrap();
        let outcome = WorkerOutcome::Succeeded(TaskResult {
            summary: "x".repeat(MAX_PROTOCOL_TEXT_BYTES + 1),
            evidence_refs: vec![],
        });
        assert!(matches!(
            outcome.validate_for_run(&run_id),
            Err(ProtocolError::LimitExceeded { .. })
        ));
    }
}
