use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const REQUEST_SKILL_MANAGEMENT_CONFIRMATION_METHOD: &str =
    "_goose/unstable/skills/manage/request-confirmation";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSourceRef {
    pub root_kind: SkillRootKind,
    pub root_id: String,
    pub relative_path: String,
}

#[derive(
    Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum SkillRootKind {
    #[default]
    ProjectAgents,
    ProjectGoose,
    ProjectClaude,
    Global,
    Plugin,
    Builtin,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedSkill {
    pub source: SkillSourceRef,
    pub name: String,
    pub description: String,
    pub scope: String,
    pub read_only: bool,
    pub enabled: bool,
    pub display_path: String,
    pub version: String,
    pub raw_document: String,
    #[serde(default)]
    pub original_metadata: serde_json::Value,
    #[serde(default)]
    pub display_metadata: SkillDisplayMetadata,
    #[serde(default)]
    pub companion_files: Vec<SkillCompanionFile>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCompanionFile {
    pub relative_path: String,
    pub size: u64,
    pub version: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillLocalizedDisplay {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillDisplayMetadata {
    #[serde(default)]
    pub locales: HashMap<String, SkillLocalizedDisplay>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillDestinationRoot {
    pub root_kind: SkillRootKind,
    pub root_id: String,
    pub display_path: String,
    pub read_only: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/skills/manage/list", response = SkillManagementListResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementListRequest {
    #[serde(default)]
    pub project_dir: Option<String>,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementListResponse {
    pub skills: Vec<ManagedSkill>,
    pub destination_roots: Vec<SkillDestinationRoot>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/skills/manage/read", response = SkillManagementReadResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementReadRequest {
    #[serde(default)]
    pub project_dir: Option<String>,
    pub source: SkillSourceRef,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementReadResponse {
    pub skill: ManagedSkill,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SkillManagementOperation {
    Create {
        destination: SkillDestination,
        raw_document: String,
    },
    ImportLocal {
        destination: SkillDestination,
        source_path: String,
    },
    UpdateRaw {
        source: SkillSourceRef,
        expected_version: String,
        raw_document: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_metadata: Option<SkillDisplayMetadata>,
    },
    SetEnabled {
        source: SkillSourceRef,
        expected_version: String,
        enabled: bool,
    },
    Delete {
        source: SkillSourceRef,
        expected_version: String,
    },
    Copy {
        source: SkillSourceRef,
        expected_version: String,
        destination: SkillDestination,
    },
    Restore {
        recovery_ref: String,
    },
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillDestination {
    pub root_kind: SkillRootKind,
    pub root_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/skills/manage/preview", response = SkillManagementPreviewResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementPreviewRequest {
    #[serde(default)]
    pub project_dir: Option<String>,
    pub change: SkillManagementOperation,
}

impl Default for SkillManagementPreviewRequest {
    fn default() -> Self {
        Self {
            project_dir: None,
            change: SkillManagementOperation::Create {
                destination: SkillDestination::default(),
                raw_document: String::new(),
            },
        }
    }
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementPreviewResponse {
    pub preview_token: String,
    pub expires_at: String,
    pub operation: String,
    pub target: String,
    pub requires_confirmation: bool,
    pub has_conflict: bool,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub diff: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/skills/manage/download-preview",
    response = SkillManagementPreviewResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementDownloadPreviewRequest {
    #[serde(default)]
    pub project_dir: Option<String>,
    pub destination: SkillDestination,
    pub url: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/skills/manage/apply", response = SkillManagementApplyResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementApplyRequest {
    pub preview_token: String,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementApplyResponse {
    #[serde(default)]
    pub skill: Option<ManagedSkill>,
    #[serde(default)]
    pub recovery_ref: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(method = "_goose/unstable/skills/manage/recovery/list", response = SkillManagementRecoveryListResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementRecoveryListRequest {
    #[serde(default)]
    pub project_dir: Option<String>,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillRecoveryEntry {
    pub recovery_ref: String,
    pub source: SkillSourceRef,
    pub name: String,
    pub version: String,
    pub deleted_at: String,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementRecoveryListResponse {
    pub entries: Vec<SkillRecoveryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSkillManagementConfirmation {
    pub preview_token: String,
    pub nonce: String,
    pub operation: String,
    pub target: String,
    pub source: Option<SkillSourceRef>,
    pub expected_version: Option<String>,
    pub expires_at: String,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillManagementConfirmationDecision {
    Confirm,
    #[default]
    Cancel,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManagementConfirmationResponse {
    pub decision: SkillManagementConfirmationDecision,
    pub nonce: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::JsonRpcMessage;
    #[test]
    fn methods_are_bounded_and_apply_has_no_confirmation_bit() {
        assert_eq!(
            SkillManagementApplyRequest::default().method(),
            "_goose/unstable/skills/manage/apply"
        );
        let value = serde_json::to_value(SkillManagementApplyRequest {
            preview_token: "opaque".into(),
        })
        .unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        let mut forged = value;
        forged["confirmed"] = serde_json::json!(true);
        assert!(serde_json::from_value::<SkillManagementApplyRequest>(forged).is_err());
    }

    #[test]
    fn operation_payload_fields_use_acp_camel_case() {
        let value = serde_json::to_value(SkillManagementOperation::Create {
            destination: SkillDestination::default(),
            raw_document: "document".into(),
        })
        .unwrap();

        assert_eq!(value["operation"], "create");
        assert_eq!(value["rawDocument"], "document");
        assert!(value.get("raw_document").is_none());
    }
}
