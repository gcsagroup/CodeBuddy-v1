use crate::agents::protocol::{
    AgentId, CoordinatorDecision, CoordinatorDecisionCandidate, EventId, FailureClass,
    ProtocolError, ProtocolVersion, TaskId,
};
use crate::agents::AgentRole;
use serde::{Deserialize, Serialize};

pub const COORDINATOR_DECISION_SCHEMA_VERSION: u16 = 1;
pub const COORDINATOR_PROPOSAL_SCHEMA_VERSION: u16 = 1;
const MAX_TEXT_BYTES: usize = 4_096;
const MAX_NAME_BYTES: usize = 128;
const MAX_LIST_ITEMS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorDecisionEnvelope {
    pub schema_version: u16,
    pub candidate: CoordinatorDecisionCandidate,
    pub action: CoordinatorAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorDecisionProposal {
    pub schema_version: u16,
    pub reason: String,
    #[serde(default)]
    pub evidence_event_ids: Vec<EventId>,
    pub decision: CoordinatorProposalAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    content = "arguments",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum CoordinatorProposalAction {
    ContinueTask {
        task_id: TaskId,
    },
    SendInstruction {
        task_id: TaskId,
        agent_id: AgentId,
        instruction: String,
    },
    SpawnTask {
        task: CoordinatorTaskProposal,
    },
    RetryTask {
        task_id: TaskId,
    },
    ReplaceWorker {
        task_id: TaskId,
        agent_id: AgentId,
        role: AgentRole,
    },
    RevisePlan {
        tasks: Vec<CoordinatorTaskProposal>,
    },
    PauseTask {
        task_id: TaskId,
    },
    PauseRun,
    CancelTask {
        task_id: TaskId,
    },
    CancelBranch {
        root_task_id: TaskId,
    },
    AskUser {
        question: String,
    },
    CompleteRun {
        summary: String,
    },
    FailRun {
        class: FailureClass,
        message: String,
    },
}

impl CoordinatorProposalAction {
    pub fn decision_kind(&self) -> CoordinatorDecision {
        match self {
            Self::ContinueTask { .. } => CoordinatorDecision::ContinueTask,
            Self::SendInstruction { .. } => CoordinatorDecision::SendInstruction,
            Self::SpawnTask { .. } => CoordinatorDecision::SpawnTask,
            Self::RetryTask { .. } => CoordinatorDecision::RetryTask,
            Self::ReplaceWorker { .. } => CoordinatorDecision::ReplaceWorker,
            Self::RevisePlan { .. } => CoordinatorDecision::RevisePlan,
            Self::PauseTask { .. } => CoordinatorDecision::PauseTask,
            Self::PauseRun => CoordinatorDecision::PauseRun,
            Self::CancelTask { .. } => CoordinatorDecision::CancelTask,
            Self::CancelBranch { .. } => CoordinatorDecision::CancelBranch,
            Self::AskUser { .. } => CoordinatorDecision::AskUser,
            Self::CompleteRun { .. } => CoordinatorDecision::CompleteRun,
            Self::FailRun { .. } => CoordinatorDecision::FailRun,
        }
    }
}

impl CoordinatorDecisionProposal {
    pub(super) fn validate_shape(&self) -> Result<(), DecisionShapeError> {
        if self.schema_version != COORDINATOR_PROPOSAL_SCHEMA_VERSION {
            return Err(DecisionShapeError::UnsupportedSchema(self.schema_version));
        }
        validate_text("reason", &self.reason)?;
        validate_list("evidence event IDs", &self.evidence_event_ids, |_| true)?;
        reject_duplicates(
            "evidence event IDs",
            self.evidence_event_ids.iter().map(ToString::to_string),
        )?;
        match &self.decision {
            CoordinatorProposalAction::SendInstruction { instruction, .. } => {
                validate_text("instruction", instruction)?
            }
            CoordinatorProposalAction::SpawnTask { task } => task.validate_shape()?,
            CoordinatorProposalAction::RevisePlan { tasks } => {
                if tasks.is_empty() || tasks.len() > MAX_LIST_ITEMS {
                    return Err(DecisionShapeError::InvalidField(
                        "revised plan must contain between 1 and 128 tasks".into(),
                    ));
                }
                for task in tasks {
                    task.validate_shape()?;
                }
            }
            CoordinatorProposalAction::AskUser { question } => validate_text("question", question)?,
            CoordinatorProposalAction::CompleteRun { summary } => {
                validate_text("summary", summary)?
            }
            CoordinatorProposalAction::FailRun { message, .. } => {
                validate_text("message", message)?
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    content = "arguments",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum CoordinatorAction {
    ContinueTask,
    SendInstruction {
        instruction: String,
    },
    SpawnTask {
        plan_revision: u32,
        task: CoordinatorTaskProposal,
    },
    RetryTask,
    ReplaceWorker {
        role: AgentRole,
    },
    RevisePlan {
        plan_revision: u32,
        tasks: Vec<CoordinatorTaskProposal>,
    },
    PauseTask,
    PauseRun,
    CancelTask,
    CancelBranch,
    AskUser {
        question: String,
    },
    CompleteRun {
        summary: String,
    },
    FailRun {
        class: FailureClass,
        message: String,
    },
}

impl CoordinatorAction {
    pub fn decision_kind(&self) -> CoordinatorDecision {
        match self {
            Self::ContinueTask => CoordinatorDecision::ContinueTask,
            Self::SendInstruction { .. } => CoordinatorDecision::SendInstruction,
            Self::SpawnTask { .. } => CoordinatorDecision::SpawnTask,
            Self::RetryTask => CoordinatorDecision::RetryTask,
            Self::ReplaceWorker { .. } => CoordinatorDecision::ReplaceWorker,
            Self::RevisePlan { .. } => CoordinatorDecision::RevisePlan,
            Self::PauseTask => CoordinatorDecision::PauseTask,
            Self::PauseRun => CoordinatorDecision::PauseRun,
            Self::CancelTask => CoordinatorDecision::CancelTask,
            Self::CancelBranch => CoordinatorDecision::CancelBranch,
            Self::AskUser { .. } => CoordinatorDecision::AskUser,
            Self::CompleteRun { .. } => CoordinatorDecision::CompleteRun,
            Self::FailRun { .. } => CoordinatorDecision::FailRun,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorTaskProposal {
    pub task_id: TaskId,
    pub name: String,
    pub role: AgentRole,
    #[serde(default)]
    pub depends_on: Vec<TaskId>,
    pub acceptance_criteria: String,
    #[serde(default)]
    pub read_scope: Vec<String>,
    #[serde(default)]
    pub write_scope: Vec<String>,
    #[serde(default)]
    pub required_evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCoordinatorDecision {
    envelope: CoordinatorDecisionEnvelope,
}

impl ValidatedCoordinatorDecision {
    pub fn envelope(&self) -> &CoordinatorDecisionEnvelope {
        &self.envelope
    }

    pub(super) fn new(envelope: CoordinatorDecisionEnvelope) -> Self {
        Self { envelope }
    }
}

impl CoordinatorDecisionEnvelope {
    pub(super) fn validate_shape(&self) -> Result<(), DecisionShapeError> {
        if self.schema_version != COORDINATOR_DECISION_SCHEMA_VERSION {
            return Err(DecisionShapeError::UnsupportedSchema(self.schema_version));
        }
        if self.candidate.protocol_version != ProtocolVersion::CURRENT {
            return Err(DecisionShapeError::UnsupportedProtocol(
                self.candidate.protocol_version.get(),
            ));
        }
        self.candidate.validate_for_run(&self.candidate.run_id)?;
        if self.action.decision_kind() != self.candidate.decision {
            return Err(DecisionShapeError::ActionMismatch);
        }
        match &self.action {
            CoordinatorAction::SendInstruction { instruction } => {
                validate_text("instruction", instruction)?
            }
            CoordinatorAction::SpawnTask {
                plan_revision,
                task,
            } => {
                validate_revision(*plan_revision)?;
                task.validate_shape()?;
            }
            CoordinatorAction::RevisePlan {
                plan_revision,
                tasks,
            } => {
                validate_revision(*plan_revision)?;
                if tasks.is_empty() || tasks.len() > MAX_LIST_ITEMS {
                    return Err(DecisionShapeError::InvalidField(
                        "revised plan must contain between 1 and 128 tasks".into(),
                    ));
                }
                for task in tasks {
                    task.validate_shape()?;
                }
            }
            CoordinatorAction::AskUser { question } => validate_text("question", question)?,
            CoordinatorAction::CompleteRun { summary } => validate_text("summary", summary)?,
            CoordinatorAction::FailRun { message, .. } => validate_text("message", message)?,
            _ => {}
        }
        Ok(())
    }
}

impl CoordinatorTaskProposal {
    fn validate_shape(&self) -> Result<(), DecisionShapeError> {
        validate_name("task name", &self.name)?;
        validate_text("acceptance criteria", &self.acceptance_criteria)?;
        validate_list("dependencies", &self.depends_on, |_| true)?;
        validate_list("read scope", &self.read_scope, |value| {
            !value.trim().is_empty() && value.len() <= MAX_NAME_BYTES
        })?;
        validate_list("write scope", &self.write_scope, |value| {
            !value.trim().is_empty() && value.len() <= MAX_NAME_BYTES
        })?;
        validate_list("required evidence", &self.required_evidence, |value| {
            !value.trim().is_empty() && value.len() <= MAX_NAME_BYTES
        })?;
        if self.required_evidence.is_empty() {
            return Err(DecisionShapeError::InvalidField(
                "required evidence must not be empty".into(),
            ));
        }
        reject_duplicates(
            "dependencies",
            self.depends_on.iter().map(ToString::to_string),
        )?;
        reject_duplicates("read scope", self.read_scope.iter().cloned())?;
        reject_duplicates("write scope", self.write_scope.iter().cloned())?;
        reject_duplicates("required evidence", self.required_evidence.iter().cloned())?;
        Ok(())
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(super) enum DecisionShapeError {
    #[error("unsupported coordinator decision schema: {0}")]
    UnsupportedSchema(u16),
    #[error("unsupported coordinator protocol version: {0}")]
    UnsupportedProtocol(u16),
    #[error("coordinator action does not match candidate decision")]
    ActionMismatch,
    #[error("invalid coordinator decision field: {0}")]
    InvalidField(String),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

fn validate_revision(revision: u32) -> Result<(), DecisionShapeError> {
    if revision == 0 {
        Err(DecisionShapeError::InvalidField(
            "plan revision must be greater than zero".into(),
        ))
    } else {
        Ok(())
    }
}

fn validate_text(field: &str, value: &str) -> Result<(), DecisionShapeError> {
    if value.trim().is_empty() || value.len() > MAX_TEXT_BYTES {
        Err(DecisionShapeError::InvalidField(format!(
            "{field} must contain 1..={MAX_TEXT_BYTES} bytes"
        )))
    } else {
        Ok(())
    }
}

fn validate_name(field: &str, value: &str) -> Result<(), DecisionShapeError> {
    if value.trim().is_empty() || value.len() > MAX_NAME_BYTES {
        Err(DecisionShapeError::InvalidField(format!(
            "{field} must contain 1..={MAX_NAME_BYTES} bytes"
        )))
    } else {
        Ok(())
    }
}

fn validate_list<T>(
    field: &str,
    values: &[T],
    item_is_valid: impl Fn(&T) -> bool,
) -> Result<(), DecisionShapeError> {
    if values.len() > MAX_LIST_ITEMS || !values.iter().all(item_is_valid) {
        Err(DecisionShapeError::InvalidField(format!(
            "{field} is invalid or exceeds {MAX_LIST_ITEMS} items"
        )))
    } else {
        Ok(())
    }
}

fn reject_duplicates(
    field: &str,
    values: impl IntoIterator<Item = String>,
) -> Result<(), DecisionShapeError> {
    let mut seen = std::collections::BTreeSet::new();
    if values.into_iter().all(|value| seen.insert(value)) {
        Ok(())
    } else {
        Err(DecisionShapeError::InvalidField(format!(
            "{field} contains duplicate values"
        )))
    }
}
