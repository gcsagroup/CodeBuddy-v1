use crate::custom_requests::{CodeProAgentRole, CodeProRunSnapshot, CustomMethodSchema};
use agent_client_protocol::{JsonRpcMessage, JsonRpcNotification};
use schemars::{JsonSchema, SchemaGenerator};
use serde::{Deserialize, Serialize};

/// Goose-custom session update notification — a parallel to ACP's
/// `session/update` carrying goose-specific update variants.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcNotification)]
#[notification(method = "_goose/unstable/session/update")]
#[serde(rename_all = "camelCase")]
pub struct GooseSessionNotification {
    pub session_id: String,
    pub update: GooseSessionUpdate,
}

/// Backend-authored CodePro run projection. Clients must reject unsupported
/// snapshot schema versions and must not treat this transport as an authority.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcNotification)]
#[notification(method = "_goose/unstable/codepro/run/update")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProRunNotification {
    pub snapshot: CodeProRunSnapshot,
}

pub const TEST_EXECUTION_PROGRESS_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TestExecutionPhase {
    CapturingBaseline,
    DiscoveringWorkspace,
    ResolvingDependencies,
    WaitingForCargoLock,
    Compiling,
    RunningTests,
    CapturingResults,
    Repairing,
    Retesting,
    WaitingForUser,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReadOutcome {
    Succeeded,
    NotFound,
    PathCorrected,
    PermissionRequired,
    OutsideWorkspace,
    Locked,
    Busy,
    InfrastructureFailed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TestExecutionOutcome {
    Succeeded,
    NotFound,
    PathCorrected,
    PermissionRequired,
    OutsideWorkspace,
    Locked,
    Busy,
    PrerequisiteUnavailable,
    VerificationFailed,
    InfrastructureFailed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestExecutionProgress {
    pub schema_version: u8,
    pub session_id: String,
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub phase: TestExecutionPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TestExecutionOutcome>,
    pub command: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_crate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_test: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output_at: Option<String>,
    pub heartbeat_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_tail_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_tail_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output: Option<String>,
    pub retry_attempt: u16,
    pub repair_attempt: u16,
    pub can_cancel: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_permission: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestExecutionProgressUpdate {
    pub progress: TestExecutionProgress,
}

pub const PUBLIC_PROGRESS_EVENT_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicProgressPhase {
    Planning,
    Coding,
    Testing,
    Reviewing,
    ToolUse,
    Waiting,
    Completing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicProgressStatus {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicProgressEvent {
    pub schema_version: u8,
    pub session_id: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub attempt_id: String,
    pub role: CodeProAgentRole,
    pub phase: PublicProgressPhase,
    pub status: PublicProgressStatus,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incremental_output: Option<String>,
    pub started_at: String,
    pub last_activity_at: String,
    pub heartbeat_at: String,
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_step: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicProgressUpdate {
    pub progress: PublicProgressEvent,
}

/// Discriminated union of goose-specific session update payloads.
/// Variant tag matches ACP's convention (`sessionUpdate: "<snake_case>"`).
///
/// `discriminator.mapping` is what makes TS codegen (`@hey-api/openapi-ts`)
/// emit the correct snake_case tag value even when this enum has a single
/// variant. Add a mapping entry per variant.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
#[schemars(extend("discriminator" = {
    "propertyName": "sessionUpdate",
    "mapping": {
        "usage_update": "#/$defs/SessionUsageUpdate",
        "status_message": "#/$defs/StatusMessageUpdate",
        "message_usage": "#/$defs/MessageUsageUpdate",
        "test_execution_progress": "#/$defs/TestExecutionProgressUpdate",
        "public_progress": "#/$defs/PublicProgressUpdate"
    }
}))]
pub enum GooseSessionUpdate {
    UsageUpdate(SessionUsageUpdate),
    StatusMessage(StatusMessageUpdate),
    MessageUsage(MessageUsageUpdate),
    TestExecutionProgress(Box<TestExecutionProgressUpdate>),
    PublicProgress(Box<PublicProgressUpdate>),
}

impl Default for GooseSessionUpdate {
    fn default() -> Self {
        GooseSessionUpdate::UsageUpdate(SessionUsageUpdate::default())
    }
}

/// Streaming context-window usage update for a session.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageUpdate {
    pub used: u64,
    pub context_limit: u64,
    pub accumulated_input_tokens: u64,
    pub accumulated_output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accumulated_cost: Option<f64>,
}

/// Per-message token usage/cost/timing, keyed by the message id used for
/// chunk matching. Sent live after a turn's messages and on replay.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsageUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    pub usage: MessageUsageData,
}

/// Wire mirror of the conversation `MessageUsage` (this crate cannot depend on
/// goose-provider-types); field names and serde casing MUST stay in parity.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsageData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_source: Option<CostSourceData>,
    /// Wall-clock generation time, used by the client for a tokens/sec readout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_to_first_token_ms: Option<u64>,
    /// Usage from a compaction/summarization call rather than a normal turn.
    #[serde(default)]
    pub is_compaction: bool,
}

/// Wire mirror of the conversation `CostSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CostSourceData {
    /// Cost returned directly by the provider (e.g. OpenRouter `usage.cost`).
    ProviderReported,
    /// Cost computed from the canonical pricing table.
    Estimated,
}

/// Live UI/session status. This is not conversation transcript content, and
/// should not be persisted or replayed as history.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatusMessageUpdate {
    pub status: StatusMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StatusMessage {
    #[serde(rename_all = "camelCase")]
    Notice {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
    },
}

fn notification_schema<T>(generator: &mut SchemaGenerator) -> CustomMethodSchema
where
    T: Default + JsonRpcMessage + JsonSchema,
{
    let dummy = T::default();
    let type_name = std::any::type_name::<T>()
        .rsplit("::")
        .next()
        .unwrap_or(std::any::type_name::<T>())
        .to_string();
    CustomMethodSchema {
        method: dummy.method().to_string(),
        params_schema: Some(generator.subschema_for::<T>()),
        params_type_name: Some(type_name),
        response_schema: None,
        response_type_name: None,
    }
}

/// Schemas for every goose-custom outbound notification. To register a new
/// notification, define the struct above (with `JsonRpcNotification` +
/// `Default`) and add one line below.
pub fn custom_notification_schemas(generator: &mut SchemaGenerator) -> Vec<CustomMethodSchema> {
    vec![
        notification_schema::<GooseSessionNotification>(generator),
        notification_schema::<CodeProRunNotification>(generator),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_message_serializes_to_expected_wire_shape() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate {
                status: StatusMessage::Notice {
                    message: "Compaction complete".to_string(),
                    data: None,
                },
            }),
        };

        let value = serde_json::to_value(notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "status_message",
                    "status": {
                        "type": "notice",
                        "message": "Compaction complete"
                    }
                }
            })
        );
    }

    #[test]
    fn progress_status_message_carries_optional_structured_data() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate {
                status: StatusMessage::Progress {
                    message: "CodePro activity".to_string(),
                    data: Some(json!({
                        "schema_version": 1,
                        "event_id": "tool-1",
                        "event_type": "file_read",
                        "status": "running"
                    })),
                },
            }),
        };

        let value = serde_json::to_value(notification).unwrap();
        assert_eq!(value["update"]["status"]["data"]["event_id"], "tool-1");
    }

    #[test]
    fn message_usage_serializes_to_expected_wire_shape() {
        let notification = GooseSessionNotification {
            session_id: "s1".to_string(),
            update: GooseSessionUpdate::MessageUsage(MessageUsageUpdate {
                message_id: Some("m1".to_string()),
                usage: MessageUsageData {
                    input_tokens: Some(1200),
                    output_tokens: Some(340),
                    total_tokens: Some(1540),
                    cache_read_tokens: Some(1000),
                    cache_write_tokens: None,
                    cost: Some(0.0123),
                    cost_source: Some(CostSourceData::Estimated),
                    elapsed_ms: Some(4200),
                    time_to_first_token_ms: Some(840),
                    is_compaction: false,
                },
            }),
        };

        let value = serde_json::to_value(notification).unwrap();

        assert_eq!(
            value,
            json!({
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "message_usage",
                    "messageId": "m1",
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 340,
                        "totalTokens": 1540,
                        "cacheReadTokens": 1000,
                        "cost": 0.0123,
                        "costSource": "estimated",
                        "elapsedMs": 4200,
                        "timeToFirstTokenMs": 840,
                        "isCompaction": false
                    }
                }
            })
        );
    }

    #[test]
    fn codepro_run_notification_wraps_the_versioned_snapshot() {
        let notification = CodeProRunNotification {
            snapshot: CodeProRunSnapshot {
                schema_version: 1,
                session_id: "session-1".to_string(),
                run_id: "run-1".to_string(),
                ..CodeProRunSnapshot::default()
            },
        };

        let value = serde_json::to_value(notification).unwrap();
        assert_eq!(value["snapshot"]["schemaVersion"], 1);
        assert_eq!(value["snapshot"]["sessionId"], "session-1");
        assert_eq!(value["snapshot"]["runId"], "run-1");
    }

    #[test]
    fn test_execution_progress_is_a_typed_session_update() {
        let notification = GooseSessionNotification {
            session_id: "session-1".to_string(),
            update: GooseSessionUpdate::TestExecutionProgress(Box::new(
                TestExecutionProgressUpdate {
                    progress: TestExecutionProgress {
                        schema_version: TEST_EXECUTION_PROGRESS_SCHEMA_VERSION,
                        session_id: "session-1".to_string(),
                        run_id: "run-1".to_string(),
                        task_id: "tester-1".to_string(),
                        attempt_id: "tester-1:1".to_string(),
                        phase: TestExecutionPhase::Compiling,
                        outcome: None,
                        command: "cargo test --jobs 1".to_string(),
                        cwd: r"D:\project".to_string(),
                        manifest_path: Some(r"D:\project\Cargo.toml".to_string()),
                        elapsed_ms: 12_000,
                        current_crate: Some("goose".to_string()),
                        current_test: None,
                        completed: None,
                        total: None,
                        pid: Some(42),
                        last_output_at: None,
                        heartbeat_at: "2026-08-26T00:00:00Z".to_string(),
                        stdout_tail_ref: Some("test-progress://run-1/tester-1/stdout".to_string()),
                        stderr_tail_ref: Some("test-progress://run-1/tester-1/stderr".to_string()),
                        last_output: Some("Compiling goose".to_string()),
                        retry_attempt: 0,
                        repair_attempt: 0,
                        can_cancel: true,
                        required_path: None,
                        required_permission: None,
                        reason: None,
                    },
                },
            )),
        };

        let value = serde_json::to_value(notification).unwrap();
        assert_eq!(value["update"]["sessionUpdate"], "test_execution_progress");
        assert_eq!(value["update"]["progress"]["phase"], "compiling");
        assert_eq!(value["update"]["progress"]["canCancel"], true);
    }

    #[test]
    fn public_progress_event_is_safe_structured_ui_data() {
        let notification = GooseSessionNotification {
            session_id: "session-1".to_string(),
            update: GooseSessionUpdate::PublicProgress(Box::new(PublicProgressUpdate {
                progress: PublicProgressEvent {
                    schema_version: PUBLIC_PROGRESS_EVENT_SCHEMA_VERSION,
                    session_id: "session-1".to_string(),
                    run_id: "run-1".to_string(),
                    task_id: Some("task-1".to_string()),
                    attempt_id: "task-1:1".to_string(),
                    role: crate::custom_requests::CodeProAgentRole::Coder,
                    phase: PublicProgressPhase::Coding,
                    status: PublicProgressStatus::Running,
                    summary: "Applying the verified repair".to_string(),
                    current_tool: Some("edit".to_string()),
                    current_file: Some("src/lib.rs".to_string()),
                    current_command: None,
                    incremental_output: Some("Updated the bounded target".to_string()),
                    started_at: "2026-08-29T00:00:00Z".to_string(),
                    last_activity_at: "2026-08-29T00:00:03Z".to_string(),
                    heartbeat_at: "2026-08-29T00:00:03Z".to_string(),
                    elapsed_ms: 3_000,
                    completed: Some(1),
                    total: Some(2),
                    next_step: Some("Retest the same command".to_string()),
                    wait_reason: None,
                },
            })),
        };

        let value = serde_json::to_value(notification).unwrap();
        assert_eq!(value["update"]["sessionUpdate"], "public_progress");
        assert_eq!(value["update"]["progress"]["role"], "coder");
        assert_eq!(value["update"]["progress"]["phase"], "coding");
        assert!(value["update"]["progress"].get("systemPrompt").is_none());
        assert!(value["update"]["progress"].get("reasoning").is_none());
    }
}
