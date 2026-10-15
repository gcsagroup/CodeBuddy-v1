use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CODEPRO_RUN_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/run/get",
    response = CodeProRunSnapshotResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRunGetRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub run_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/run/control",
    response = CodeProRunControlResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRunControlRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub command_id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sequence: Option<u64>,
    pub action: CodeProRunControlAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CodeProRunControlAction {
    StopWorker {
        agent_id: String,
        reason: String,
    },
    CancelTask {
        task_id: String,
        reason: String,
    },
    CancelBranch {
        root_task_id: String,
        reason: String,
    },
    PauseRun {
        reason: String,
    },
    ResumeRun {},
    EmergencyStop {
        reason: String,
    },
}

impl Default for CodeProRunControlAction {
    fn default() -> Self {
        Self::ResumeRun {}
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/effects/resolve",
    response = CodeProRunSnapshotResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProEffectResolveRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub run_id: String,
    pub effect_id: String,
    pub resolution: CodeProEffectResolution,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProEffectResolution {
    ConfirmedApplied,
    #[default]
    ConfirmedNotApplied,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRunSnapshotResponse {
    pub snapshot: CodeProRunSnapshot,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRunControlResponse {
    pub command_id: String,
    pub previous_sequence: u64,
    pub committed_event_ids: Vec<String>,
    pub snapshot: CodeProRunSnapshot,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRunSnapshot {
    pub schema_version: u16,
    pub session_id: String,
    pub run_id: String,
    pub state: CodeProRunState,
    pub goal: String,
    #[serde(default)]
    pub user_requirement_revision: u32,
    #[serde(default)]
    pub user_requirements: Vec<CodeProUserRequirementProjection>,
    pub plan_revision: u32,
    pub last_sequence: u64,
    #[serde(default)]
    pub tasks: Vec<CodeProTaskProjection>,
    #[serde(default)]
    pub agents: Vec<CodeProAgentProjection>,
    #[serde(default)]
    pub recent_events: Vec<CodeProRunEventSummary>,
    #[serde(default)]
    pub effects: Vec<CodeProEffectProjection>,
    pub coordinator: CodeProCoordinatorProjection,
    #[serde(default)]
    pub recovery: CodeProRecoveryProjection,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProUserRequirementProjection {
    pub requirement_id: String,
    pub source_message_id: String,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProRunState {
    #[default]
    NotStarted,
    Planning,
    Running,
    VerificationFailed,
    Repairing,
    Retesting,
    WaitingForUser,
    WaitingForEnvironment,
    Paused,
    Recovering,
    Completing,
    Completed,
    Exhausted,
    Fatal,
    Failed,
    Cancelled,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProRecoveryAction {
    #[default]
    RetrySameStep,
    RepairThenRetest,
    AskUserThenResume,
    DiagnoseEnvironment,
    Replan,
    Finish,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRecoveryDecision {
    pub state: CodeProRunState,
    pub action: CodeProRecoveryAction,
    pub terminal: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProTaskState {
    #[default]
    Proposed,
    Ready,
    Running,
    VerificationFailed,
    RepairPending,
    WaitingForUser,
    WaitingForCoordinator,
    WaitingForApproval,
    Paused,
    Succeeded,
    RepairExhausted,
    Failed,
    Cancelled,
    Skipped,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProAgentState {
    #[default]
    Starting,
    Running,
    Idle,
    Stopping,
    Stopped,
    Crashed,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProAgentRole {
    #[default]
    Planner,
    Coder,
    Tester,
    Reviewer,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProTaskProjection {
    pub task_id: String,
    pub name: String,
    pub state: CodeProTaskState,
    /// Membership in the authoritative current plan, not a task outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_current_plan: Option<bool>,
    pub retry_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_decision: Option<CodeProRecoveryDecision>,
    #[serde(default)]
    pub evidence: Vec<CodeProEvidenceProjection>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProAgentProjection {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub role: CodeProAgentRole,
    pub state: CodeProAgentState,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProEvidenceProjection {
    pub event_id: String,
    pub artifact_ref: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRunEventSummary {
    pub event_id: String,
    pub sequence: u64,
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub occurred_at: String,
    #[serde(default)]
    pub evidence: Vec<CodeProEvidenceProjection>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProEffectState {
    Prepared,
    Pending,
    Claimed,
    Completed,
    Uncertain,
    Abandoned,
    #[default]
    Unknown,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProEffectProjection {
    pub effect_id: String,
    pub trigger_event_id: String,
    pub state: CodeProEffectState,
    pub summary: String,
    pub requires_resolution: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProCoordinatorMode {
    #[default]
    Off,
    Shadow,
    Advisory,
    Authoritative,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProQualificationResult {
    #[default]
    NotRequired,
    Qualified,
    Missing,
    Expired,
    Failed,
    NotMeasured,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProCoordinatorProjection {
    pub requested_mode: CodeProCoordinatorMode,
    pub effective_mode: CodeProCoordinatorMode,
    pub qualification: CodeProQualificationResult,
    pub reason: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRecoveryProjection {
    pub truncated_event_bytes: u64,
    pub truncated_effect_bytes: u64,
    pub pending_effects: u32,
    pub uncertain_effects: u32,
    pub abandoned_effects: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn control_action_uses_a_strict_discriminated_wire_shape() {
        let request = CodeProRunControlRequest {
            schema_version: CODEPRO_RUN_SCHEMA_VERSION,
            session_id: "session-1".to_string(),
            command_id: "command-1".to_string(),
            run_id: "run-1".to_string(),
            expected_sequence: Some(7),
            action: CodeProRunControlAction::CancelTask {
                task_id: "task-1".to_string(),
                reason: "No longer needed".to_string(),
            },
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "schemaVersion": 1,
                "sessionId": "session-1",
                "commandId": "command-1",
                "runId": "run-1",
                "expectedSequence": 7,
                "action": {
                    "type": "cancel_task",
                    "taskId": "task-1",
                    "reason": "No longer needed"
                }
            })
        );
    }

    #[test]
    fn request_rejects_unknown_top_level_and_action_fields() {
        let unknown_top = json!({
            "schemaVersion": 1,
            "sessionId": "session-1",
            "commandId": "command-1",
            "runId": "run-1",
            "action": { "type": "resume_run" },
            "optimistic": true
        });
        assert!(serde_json::from_value::<CodeProRunControlRequest>(unknown_top).is_err());

        let unknown_action = json!({
            "schemaVersion": 1,
            "sessionId": "session-1",
            "commandId": "command-1",
            "runId": "run-1",
            "action": { "type": "resume_run", "reason": "ignored?" }
        });
        assert!(serde_json::from_value::<CodeProRunControlRequest>(unknown_action).is_err());
    }
}
