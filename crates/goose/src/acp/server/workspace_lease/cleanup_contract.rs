// Shared audit wire contract. Native platforms decide execution availability.

pub(super) const AUDIT_CLEANUP_METHOD: &str = "_goose/unstable/root-cleanup/audit";
pub(super) const EXECUTE_CLEANUP_METHOD: &str = "_goose/unstable/root-cleanup/execute";
pub(super) const PERMANENT_CLEANUP_METHOD: &str = "_goose/unstable/root-cleanup/permanent-delete";
pub(super) const RESTORE_QUARANTINE_METHOD: &str =
    "_goose/unstable/root-cleanup/restore-quarantine";
pub(super) const CANCEL_CLEANUP_METHOD: &str = "_goose/unstable/root-cleanup/cancel";
pub(super) const LIST_CLEANUP_RECOVERY_METHOD: &str = "_goose/unstable/root-cleanup/recovery/list";
pub(super) const RETRY_CLEANUP_RECOVERY_METHOD: &str =
    "_goose/unstable/root-cleanup/recovery/retry-original";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AuditRootCleanupRequest {
    pub root_path: String,
    pub targets: Vec<String>,
    pub capability: RootCapabilityContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExecuteRootCleanupRequest {
    pub audit_token: String,
    pub capability: RootCapabilityContext,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RootCleanupAuditResponse {
    pub audit_token: String,
    pub root_identity: String,
    pub target: RootCleanupTargetSummary,
    pub destructive_confirmation_required: bool,
    pub execution_available: bool,
}
