use crate::agents::agent_role::{AgentRole, CodeProRiskReason, CodeProRiskTier};
use crate::agents::codepro_routing_evidence::CodeProRoutingEvidence;
use crate::permission::failure_semantics::CodeProFailureKind;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const ACTIVITY_EVENT_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityEventKind {
    IntentStarted,
    IntentCompleted,
    StrategySelected,
    StrategyUpdated,
    PlanCreated,
    PlanUpdated,
    TaskQueued,
    TaskStarted,
    TaskCompleted,
    TaskFailed,
    TaskSkipped,
    EvidenceCommitted,
    ToolStarted,
    ToolCompleted,
    FileRead,
    FileChanged,
    CommandStarted,
    CommandCompleted,
    TestStarted,
    TestCompleted,
    ReviewStarted,
    ReviewCompleted,
    ApprovalRequested,
    ApprovalResolved,
    RunStopped,
    RunFailed,
    RunCompleted,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityEventStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Stopped,
    Interrupted,
    Skipped,
    #[serde(other)]
    Unknown,
}

impl ActivityEventStatus {
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::Failed
                | Self::Cancelled
                | Self::Stopped
                | Self::Interrupted
                | Self::Skipped
                | Self::Unknown
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEvent {
    pub schema_version: u8,
    pub event_id: String,
    pub event_type: ActivityEventKind,
    pub session_id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub agent_role: Option<AgentRole>,
    pub effective_model: Option<String>,
    pub status: ActivityEventStatus,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub title: String,
    pub technical_details: Option<String>,
    pub path: Option<PathBuf>,
    pub command_summary: Option<String>,
    pub exit_code: Option<i32>,
    pub diff_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<CodeProFailureKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_tier: Option<CodeProRiskTier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_risk_tier: Option<CodeProRiskTier>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub risk_reasons: Vec<CodeProRiskReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_roles: Vec<AgentRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_evidence: Option<CodeProRoutingEvidence>,
    pub include_in_model_context: bool,
    pub retryable: bool,
    pub retry_from_event_id: Option<String>,
}
