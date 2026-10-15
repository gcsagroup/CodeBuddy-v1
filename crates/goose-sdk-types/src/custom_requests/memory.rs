use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CODEPRO_MEMORY_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProMemoryStatus {
    #[default]
    Candidate,
    Active,
    Disabled,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProMemoryTargetStatus {
    #[default]
    Active,
    Disabled,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/memory/list",
    response = CodeProMemoryListResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryListRequest {
    pub schema_version: u16,
    pub working_dir: String,
    #[serde(default)]
    pub include_expired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 50))]
    pub page_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        length(min = 1, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub cursor: Option<String>,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/memory/update",
    response = CodeProMemoryRecordResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryUpdateRequest {
    pub schema_version: u16,
    pub working_dir: String,
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub id: String,
    #[schemars(length(min = 1, max = 2000))]
    pub content: String,
    #[schemars(length(min = 1, max = 500))]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 3650))]
    pub ttl_days: Option<u32>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/memory/delete",
    response = CodeProMemoryDeleteResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryDeleteRequest {
    pub schema_version: u16,
    pub working_dir: String,
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/memory/export",
    response = CodeProMemoryExportResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryExportRequest {
    pub schema_version: u16,
    pub working_dir: String,
    #[serde(default)]
    pub include_expired: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/memory/get",
    response = CodeProMemoryGetResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryGetRequest {
    pub schema_version: u16,
    pub working_dir: String,
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/memory/status",
    response = CodeProMemoryStatusResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryStatusRequest {
    pub schema_version: u16,
    pub working_dir: String,
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub id: String,
    pub target_status: CodeProMemoryTargetStatus,
    pub expected_status: CodeProMemoryStatus,
    #[schemars(length(min = 1, max = 64))]
    pub expected_updated_at: String,
    #[schemars(length(min = 64, max = 64), regex(pattern = r"^[0-9a-fA-F]{64}$"))]
    pub review_fingerprint: String,
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub action_id: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryRecord {
    #[schemars(
        length(min = 36, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub id: String,
    #[schemars(length(min = 1, max = 32))]
    pub kind: String,
    #[schemars(length(min = 1, max = 120))]
    pub subject: String,
    #[schemars(length(max = 2000))]
    pub content: String,
    #[schemars(length(min = 1, max = 16))]
    pub scope: String,
    #[schemars(length(min = 1, max = 32))]
    pub source: String,
    pub status: CodeProMemoryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 64, max = 64), regex(pattern = r"^[0-9a-fA-F]{64}$"))]
    pub review_fingerprint: Option<String>,
    #[schemars(length(max = 500))]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 1024))]
    pub source_ref: Option<String>,
    #[schemars(length(min = 1, max = 16))]
    pub confidence: String,
    #[schemars(length(min = 1, max = 64))]
    pub created_at: String,
    #[schemars(length(min = 1, max = 64))]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 64))]
    pub last_verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 64))]
    pub expires_at: Option<String>,
    pub expired: bool,
    pub recallable: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryListResponse {
    pub schema_version: u16,
    #[schemars(length(min = 32, max = 32), regex(pattern = r"^[0-9a-fA-F]{32}$"))]
    pub project_identity: String,
    #[schemars(length(max = 50))]
    pub records: Vec<CodeProMemoryRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        length(min = 1, max = 36),
        regex(
            pattern = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
        )
    )]
    pub next_cursor: Option<String>,
    pub total_records: usize,
    pub usage_bytes: u64,
    pub soft_limit_bytes: u64,
    pub hard_limit_bytes: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryRecordResponse {
    pub schema_version: u16,
    pub record: CodeProMemoryRecord,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryDeleteResponse {
    pub schema_version: u16,
    pub removed: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryExportResponse {
    pub schema_version: u16,
    pub file_name: String,
    pub json: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryGetResponse {
    pub schema_version: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<CodeProMemoryRecord>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProMemoryStatusResponse {
    pub schema_version: u16,
    pub action_id: String,
    pub changed: bool,
    pub record: CodeProMemoryRecord,
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::JsonRpcMessage;
    use serde_json::json;

    #[test]
    fn review_methods_and_request_fields_use_the_strict_acp_contract() {
        assert_eq!(
            CodeProMemoryGetRequest::default().method(),
            "_goose/unstable/codepro/memory/get"
        );
        assert_eq!(
            CodeProMemoryStatusRequest::default().method(),
            "_goose/unstable/codepro/memory/status"
        );

        let request = CodeProMemoryStatusRequest {
            schema_version: CODEPRO_MEMORY_SCHEMA_VERSION,
            working_dir: "D:\\CodeBuddy".to_string(),
            id: "00000000-0000-4000-8000-000000000071".to_string(),
            target_status: CodeProMemoryTargetStatus::Active,
            expected_status: CodeProMemoryStatus::Candidate,
            expected_updated_at: "2026-09-12T00:00:01.000000000Z".to_string(),
            review_fingerprint: "a".repeat(64),
            action_id: "00000000-0000-4000-8000-000000000072".to_string(),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "schemaVersion": 1,
                "workingDir": "D:\\CodeBuddy",
                "id": "00000000-0000-4000-8000-000000000071",
                "targetStatus": "active",
                "expectedStatus": "candidate",
                "expectedUpdatedAt": "2026-09-12T00:00:01.000000000Z",
                "reviewFingerprint": "a".repeat(64),
                "actionId": "00000000-0000-4000-8000-000000000072"
            })
        );
    }

    #[test]
    fn review_request_rejects_unknown_fields_and_candidate_target() {
        let base = json!({
            "schemaVersion": 1,
            "workingDir": "D:\\CodeBuddy",
            "id": "00000000-0000-4000-8000-000000000071",
            "targetStatus": "active",
            "expectedStatus": "candidate",
            "expectedUpdatedAt": "2026-09-12T00:00:01.000000000Z",
            "reviewFingerprint": "a".repeat(64),
            "actionId": "00000000-0000-4000-8000-000000000072"
        });

        let mut unknown = base.clone();
        unknown["confirmed"] = json!(true);
        assert!(serde_json::from_value::<CodeProMemoryStatusRequest>(unknown).is_err());

        let mut candidate_target = base;
        candidate_target["targetStatus"] = json!("candidate");
        assert!(serde_json::from_value::<CodeProMemoryStatusRequest>(candidate_target).is_err());
    }
}
