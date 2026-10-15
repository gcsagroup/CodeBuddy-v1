use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProReviewScope {
    #[default]
    WorkingTree,
    Staged,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProReviewStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    NoChanges,
    NoReviewableContent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProReviewCoverage {
    Complete,
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProReviewFreshness {
    Current,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProReviewSide {
    Old,
    New,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewModel {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewHunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub old_text: String,
    pub new_text: String,
    pub old_hash: String,
    pub new_hash: String,
    pub diff: String,
    pub hunks: Vec<CodeProReviewHunk>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProReviewExclusionReason {
    SensitivePath,
    NonRegularFile,
    BinaryOrNonUtf8,
    FileTooLarge,
    ContentLimit,
    FileLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewExclusion {
    pub path: String,
    pub reason: CodeProReviewExclusionReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewSnapshot {
    pub schema_version: u16,
    pub snapshot_id: String,
    pub session_id: String,
    pub scope: CodeProReviewScope,
    pub base_ref: Option<String>,
    pub head_oid: Option<String>,
    pub base_oid: Option<String>,
    pub model: CodeProReviewModel,
    pub files: Vec<CodeProReviewFile>,
    pub coverage: CodeProReviewCoverage,
    pub excluded_files: Vec<CodeProReviewExclusion>,
    pub fingerprint: String,
    pub captured_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewFinding {
    pub id: String,
    pub priority: u8,
    pub title: String,
    pub body: String,
    pub path: String,
    pub side: CodeProReviewSide,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeProReviewEvidenceMatch {
    Matching,
    Unverified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewTestEvidenceRef {
    pub id: String,
    pub version_match: CodeProReviewEvidenceMatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewResult {
    pub schema_version: u16,
    pub review_id: String,
    pub snapshot_id: String,
    pub revision: u64,
    pub status: CodeProReviewStatus,
    pub freshness: CodeProReviewFreshness,
    pub coverage: CodeProReviewCoverage,
    pub findings: Vec<CodeProReviewFinding>,
    pub excluded_files: Vec<CodeProReviewExclusion>,
    pub test_evidence_refs: Vec<CodeProReviewTestEvidenceRef>,
    pub error: Option<CodeProReviewError>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewTestEvidence {
    pub id: String,
    pub snapshot_fingerprint: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/review/snapshot",
    response = CodeProReviewSnapshotResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewSnapshotRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub scope: CodeProReviewScope,
    pub base_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewSnapshotResponse {
    pub snapshot: CodeProReviewSnapshot,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/review/start",
    response = CodeProReviewResultResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewStartRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub request_id: String,
    pub snapshot_id: String,
    #[serde(default)]
    pub test_evidence: Vec<CodeProReviewTestEvidence>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/review/get",
    response = CodeProReviewResultResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewGetRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub review_id: String,
    #[serde(default)]
    pub include_snapshot: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, JsonRpcRequest)]
#[request(
    method = "_goose/unstable/codepro/review/cancel",
    response = CodeProReviewResultResponse
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewCancelRequest {
    pub schema_version: u16,
    pub session_id: String,
    pub review_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, JsonRpcResponse)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeProReviewResultResponse {
    pub result: CodeProReviewResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<CodeProReviewSnapshot>,
}
