use crate::agents::agent_role::CodeProTaskKind;
use crate::agents::checkpoint_transaction::{
    CheckpointApproval, CheckpointPrepareRequest, CheckpointRestoreOutcome,
    CheckpointRestoreRequest, CheckpointTransactionStore,
};
use crate::agents::codepro_evidence::CodeProEvidence;
use crate::agents::codepro_intent::CodeProWorkflow;
use crate::agents::codepro_workspace::{paths_equivalent, CodeProWorkspaceDescriptor};
use crate::agents::model_router::ModelRouterConfig;
use crate::agents::protocol::RunId;
use crate::agents::reporting::{
    ProjectionReconciliation, MAX_PROJECTION_RECONCILIATION_BYTES,
    PROJECTION_RECONCILIATION_FILE_NAME,
};
use crate::agents::reviewer_agent::ReviewVerdict;
use crate::agents::task_dag::TaskDAG;
use crate::config::paths::Paths;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tracing::warn;

#[cfg(windows)]
use std::ffi::{c_void, OsStr};
#[cfg(windows)]
use std::fs::{File, OpenOptions};
#[cfg(windows)]
use std::io::Write;
#[cfg(windows)]
use std::mem::MaybeUninit;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use winapi::um::fileapi::{
    GetFileInformationByHandle, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    FILE_DISPOSITION_INFO,
};
#[cfg(windows)]
use winapi::um::minwinbase::FileDispositionInfo;

const DEFAULT_CODEPRO_STORAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_CODEPRO_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
static CODEPRO_STATE_MUTATION_LOCK: Mutex<()> = Mutex::new(());

#[cfg(windows)]
const CLEANUP_PENDING_PREFIX: &str = ".codepro-cleanup-pending-";
const CLEANUP_RECOVERING_PREFIX: &str = ".codepro-cleanup-recovering-";
const CLEANUP_RECOVERY_MARKER: &str = ".codepro-cleanup-recovery-";
#[cfg(windows)]
const CLEANUP_COMMIT_MARKER: &str = "COMMITTED";
#[cfg(windows)]
const CLEANUP_RECEIPT_PREFIX: &str = ".codepro-cleanup-receipt-";
#[cfg(windows)]
const CLEANUP_RECEIPT_VERSION: u32 = 1;
#[cfg(windows)]
const MAX_CLEANUP_RECEIPT_BYTES: usize = 1024 * 1024;

#[cfg(windows)]
type CleanupHandle = *mut c_void;

#[cfg(windows)]
#[repr(C)]
struct CleanupIoStatusBlock {
    status: isize,
    information: usize,
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSetInformationFile(
        file_handle: CleanupHandle,
        io_status_block: *mut CleanupIoStatusBlock,
        file_information: *mut c_void,
        length: u32,
        file_information_class: u32,
    ) -> i32;
}

#[derive(Debug, Clone, Copy)]
pub struct CodeProCleanupPolicy {
    pub max_total_bytes: u64,
    pub retention: Duration,
}

impl Default for CodeProCleanupPolicy {
    fn default() -> Self {
        Self {
            max_total_bytes: DEFAULT_CODEPRO_STORAGE_BYTES,
            retention: DEFAULT_CODEPRO_RETENTION,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CodeProCleanupReport {
    pub removed_run_ids: Vec<String>,
    #[serde(default)]
    pub deferred_cleanup_run_ids: Vec<String>,
    pub reclaimed_bytes: u64,
    pub bytes_remaining: u64,
    pub over_capacity: bool,
    pub preserved_current_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProCleanupCandidate {
    pub run_id: String,
    pub bytes: u64,
    pub fingerprint_sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CodeProCleanupExactError {
    #[error("cleanup preview is stale")]
    StalePreview,
    #[error("cleanup persistence failure: {0}")]
    Persistence(String),
}

/// Lifecycle status of a single CodePro run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProRunStatus {
    #[default]
    Planning,
    Running,
    Paused,
    Reviewing,
    Completed,
    Failed,
    Discarded,
}

/// The typed reason a resumable CodePro run stopped. Legacy snapshots that
/// predate this field are migrated conservatively instead of being guessed
/// from report text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProPauseReason {
    RecoveryPaused,
    UserInputRequired,
    CheckpointPaused,
    LegacyUnclassified,
}

/// Persisted snapshot of a CodePro run. This is the unit that is written to disk
/// after every meaningful state change so a run can survive an app restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeProRunState {
    pub run_id: String,
    pub goal: String,
    pub source_repo: PathBuf,
    pub worktree_path: PathBuf,
    #[serde(default)]
    pub workspace: Option<CodeProWorkspaceDescriptor>,
    pub status: CodeProRunStatus,
    #[serde(default)]
    pub pause_reason: Option<CodeProPauseReason>,
    #[serde(default)]
    pub workflow: Option<CodeProWorkflow>,
    #[serde(default)]
    pub last_active_run_id: Option<String>,
    pub dag: TaskDAG,
    pub router_config: ModelRouterConfig,
    #[serde(default)]
    pub reviewer_action_budget: Option<crate::agents::task_dag::TaskActionBudgetState>,
    pub review_result: Option<ReviewVerdict>,
    pub final_report: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Simple file-backed store for CodePro run state.
pub struct CodeProStateStore {
    base_dir: PathBuf,
}

impl CodeProStateStore {
    /// Returns the default store location for the current platform.
    pub fn default_location() -> Result<PathBuf> {
        Ok(Paths::runs_dir())
    }

    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
        }
    }

    pub fn try_default() -> Result<Self> {
        Ok(Self::new(Self::default_location()?))
    }

    fn run_dir(&self, run_id: &str) -> PathBuf {
        self.base_dir.join(sanitize_run_id(run_id)).join("run")
    }

    fn state_path(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("state.json")
    }

    pub(crate) fn external_http_attempt_budget_path(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id)
            .join("external-http-attempt-budget.json")
    }

    pub fn undo_dir(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("undo")
    }

    fn checkpoint_store(&self, run_id: &str) -> CheckpointTransactionStore {
        CheckpointTransactionStore::new(self.run_dir(run_id).join("checkpoint-transactions-root"))
    }

    pub async fn commit_checkpoint_transaction(
        &self,
        state: &CodeProRunState,
        evidence: &CodeProEvidence,
        approvals: Vec<CheckpointApproval>,
        event_sequence: u64,
    ) -> Result<String> {
        let checkpoint_id = format!(
            "checkpoint-r{}-e{}",
            state.dag.plan_revision, event_sequence
        );
        self.commit_checkpoint_transaction_named(
            state,
            evidence,
            approvals,
            None,
            event_sequence,
            checkpoint_id,
        )
        .await
    }

    pub async fn commit_resume_authorization_transaction(
        &self,
        state: &CodeProRunState,
        evidence: &CodeProEvidence,
        approval: CheckpointApproval,
        event_sequence: u64,
    ) -> Result<String> {
        let scope = approval.scope.clone();
        let identity = blake3::hash(
            format!(
                "{}|{}|{}",
                approval.scope,
                approval.granted_at.to_rfc3339(),
                approval.expires_at.to_rfc3339()
            )
            .as_bytes(),
        )
        .to_hex()
        .to_string();
        let identity_prefix = identity.chars().take(12).collect::<String>();
        let checkpoint_id = format!(
            "checkpoint-r{}-e{}-approval-{}",
            state.dag.plan_revision, event_sequence, identity_prefix
        );
        self.commit_checkpoint_transaction_named(
            state,
            evidence,
            vec![approval],
            Some(scope),
            event_sequence,
            checkpoint_id,
        )
        .await
    }

    async fn commit_checkpoint_transaction_named(
        &self,
        state: &CodeProRunState,
        evidence: &CodeProEvidence,
        approvals: Vec<CheckpointApproval>,
        required_approval_scope: Option<String>,
        event_sequence: u64,
        checkpoint_id: String,
    ) -> Result<String> {
        if event_sequence == 0 {
            anyhow::bail!("checkpoint event sequence must be non-zero");
        }
        let state_json =
            serde_json::to_vec_pretty(state).context("serialize checkpoint CodePro state")?;
        let budget_json = serde_json::to_vec_pretty(&serde_json::json!({
            "task_budgets": state.dag.budgets,
            "action_budgets": state.dag.action_budget_states,
            "reviewer_action_budget": state.reviewer_action_budget,
        }))
        .context("serialize checkpoint budgets")?;
        let files = evidence.checkpoint_file_snapshots().await?;
        self.checkpoint_store(&state.run_id)
            .prepare_and_publish(CheckpointPrepareRequest {
                run_id: state.run_id.clone(),
                checkpoint_id: checkpoint_id.clone(),
                workspace: state.worktree_path.clone(),
                state_json,
                budget_json,
                plan_revision: state.dag.plan_revision,
                event_sequence,
                approvals,
                required_approval_scope,
                files,
            })
            .map_err(anyhow::Error::msg)?;
        Ok(checkpoint_id)
    }

    pub fn latest_checkpoint_id(&self, run_id: &str) -> Result<Option<String>> {
        self.checkpoint_store(run_id)
            .latest_checkpoint_id(run_id)
            .map_err(anyhow::Error::msg)
    }

    pub(crate) fn load_verified_checkpoint_state(
        &self,
        run_id: &str,
        checkpoint_id: &str,
        workspace: &std::path::Path,
    ) -> Result<(CodeProRunState, u32, u64)> {
        let (bytes, plan_revision, event_sequence) = self
            .checkpoint_store(run_id)
            .verified_published_state(run_id, checkpoint_id, workspace)
            .map_err(anyhow::Error::msg)?;
        let state = normalize_loaded_state(serde_json::from_slice(&bytes)?)?;
        anyhow::ensure!(
            state.run_id == run_id
                && state.dag.plan_revision == plan_revision
                && state.worktree_path.canonicalize()? == workspace.canonicalize()?,
            "checkpoint state does not match run/workspace/plan identity"
        );
        Ok((state, plan_revision, event_sequence))
    }

    pub(crate) fn save_host_input_state_if_unchanged(
        &self,
        expected: &CodeProRunState,
        recovered: &CodeProRunState,
    ) -> Result<()> {
        anyhow::ensure!(
            expected.run_id == recovered.run_id,
            "host input recovery cannot change run identity"
        );
        let _mutation_guard = CODEPRO_STATE_MUTATION_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("CodePro state mutation lock is unavailable"))?;
        let path = self.state_path(&expected.run_id);
        let current = normalize_loaded_state(serde_json::from_slice(&std::fs::read(&path)?)?)?;
        let expected = normalize_loaded_state(expected.clone())?;
        anyhow::ensure!(
            serde_json::to_value(&current)? == serde_json::to_value(&expected)?,
            "host input recovery state changed before persistence"
        );
        let recovered = normalize_loaded_state(recovered.clone())?;
        validate_pause_state(&recovered)?;
        let tmp = path.with_extension(format!("host-input-{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, serde_json::to_vec_pretty(&recovered)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn restore_checkpoint_transaction(
        &self,
        state: &CodeProRunState,
        checkpoint_id: String,
        workspace: &std::path::Path,
        required_scope: String,
        event_sequence: u64,
    ) -> Result<CheckpointRestoreOutcome> {
        self.checkpoint_store(&state.run_id)
            .restore(CheckpointRestoreRequest {
                run_id: state.run_id.clone(),
                checkpoint_id,
                workspace: workspace.to_path_buf(),
                required_scope,
                plan_revision: state.dag.plan_revision,
                event_sequence,
                now: chrono::Utc::now(),
            })
            .map_err(anyhow::Error::msg)
    }

    pub async fn record_projection_reconciliation(
        &self,
        report: &ProjectionReconciliation,
    ) -> Result<()> {
        let run_id = RunId::new(report.run_id.clone())
            .context("projection reconciliation run_id is invalid")?;
        let path = self
            .run_dir(run_id.as_str())
            .join(PROJECTION_RECONCILIATION_FILE_NAME);
        let dir = path
            .parent()
            .context("projection reconciliation path must have a run directory")?;
        tokio::fs::create_dir_all(dir).await.with_context(|| {
            format!(
                "failed to create CodePro reconciliation directory {}",
                dir.display()
            )
        })?;

        let mut json = serde_json::to_vec_pretty(report)
            .context("failed to serialize CodePro projection reconciliation")?;
        json.push(b'\n');
        if json.len() > MAX_PROJECTION_RECONCILIATION_BYTES {
            anyhow::bail!(
                "CodePro projection reconciliation exceeds {} bytes",
                MAX_PROJECTION_RECONCILIATION_BYTES
            );
        }

        let temporary = path.with_extension("json.tmp");
        tokio::fs::write(&temporary, &json).await.with_context(|| {
            format!(
                "failed to write temporary CodePro reconciliation {}",
                temporary.display()
            )
        })?;
        if let Err(error) = tokio::fs::rename(&temporary, &path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error).with_context(|| {
                format!(
                    "failed to publish CodePro reconciliation {} -> {}",
                    temporary.display(),
                    path.display()
                )
            });
        }
        Ok(())
    }

    /// Save or update a run snapshot.
    pub async fn save(&self, state: &CodeProRunState) -> Result<()> {
        self.save_without_cleanup(state).await?;
        if matches!(state.status, CodeProRunStatus::Planning) || is_terminal_status(state.status) {
            if let Err(error) = self
                .cleanup(&state.run_id, CodeProCleanupPolicy::default())
                .await
            {
                warn!("CodePro 后台存储清理失败，当前运行继续保留：{error}");
            }
        }
        Ok(())
    }

    async fn save_without_cleanup(&self, state: &CodeProRunState) -> Result<()> {
        let state = normalize_loaded_state(state.clone())?;
        validate_pause_state(&state)?;
        let path = self.state_path(&state.run_id);
        let dir = path.parent().context("state.json 路径必须有父目录")?;
        tokio::fs::create_dir_all(dir)
            .await
            .with_context(|| format!("创建 CodePro 状态目录失败: {}", dir.display()))?;

        let json = serde_json::to_string_pretty(&state).context("序列化 CodeProRunState 失败")?;
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, json)
            .await
            .with_context(|| format!("写入临时状态文件失败: {}", tmp.display()))?;
        commit_state_file(&tmp, &path).with_context(|| {
            format!(
                "重命名状态文件失败: {} -> {}",
                tmp.display(),
                path.display()
            )
        })?;
        Ok(())
    }

    pub async fn cleanup(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
    ) -> Result<CodeProCleanupReport> {
        self.cleanup_locked(current_run_id, policy)
            .map_err(anyhow::Error::msg)
    }

    pub fn validate_cleanup_candidates_exact(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
        expected: &[CodeProCleanupCandidate],
    ) -> Result<bool> {
        Ok(self.cleanup_plan(current_run_id, policy)?.selected == expected)
    }

    pub async fn cleanup_candidates_exact(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
        expected: &[CodeProCleanupCandidate],
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError> {
        self.cleanup_candidates_exact_locked(current_run_id, policy, expected)
    }

    #[cfg(test)]
    async fn cleanup_candidates_exact_with_hook<F>(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
        expected: &[CodeProCleanupCandidate],
        before_apply: F,
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError>
    where
        F: FnOnce(),
    {
        self.cleanup_candidates_exact_with_hooks(
            current_run_id,
            policy,
            expected,
            before_apply,
            |_| {},
            |_, _| {},
            |_, _| {},
            |_, _| {},
        )
        .await
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    async fn cleanup_candidates_exact_with_hooks<F, G, H, I, J>(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
        expected: &[CodeProCleanupCandidate],
        before_apply: F,
        after_candidate_revalidation: G,
        before_candidate_quarantine: H,
        before_candidate_delete: I,
        after_metadata_publish: J,
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError>
    where
        F: FnOnce(),
        G: FnMut(usize),
        H: FnMut(usize, &std::path::Path),
        I: FnMut(usize, &std::path::Path),
        J: FnMut(&std::path::Path, &std::path::Path),
    {
        self.cleanup_candidates_exact_with_hooks_locked(
            current_run_id,
            policy,
            expected,
            before_apply,
            after_candidate_revalidation,
            before_candidate_quarantine,
            before_candidate_delete,
            after_metadata_publish,
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn cleanup_candidates_exact_with_hooks_locked<F, G, H, I, J>(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
        expected: &[CodeProCleanupCandidate],
        before_apply: F,
        after_candidate_revalidation: G,
        before_candidate_quarantine: H,
        before_candidate_delete: I,
        after_metadata_publish: J,
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError>
    where
        F: FnOnce(),
        G: FnMut(usize),
        H: FnMut(usize, &std::path::Path),
        I: FnMut(usize, &std::path::Path),
        J: FnMut(&std::path::Path, &std::path::Path),
    {
        let _mutation_guard = CODEPRO_STATE_MUTATION_LOCK.lock().map_err(|_| {
            CodeProCleanupExactError::Persistence(
                "CodePro state mutation lock is unavailable".to_string(),
            )
        })?;
        #[cfg(windows)]
        let mut report = committed_cleanup_tombstone_report(&self.base_dir)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        #[cfg(not(windows))]
        let mut report = CodeProCleanupReport::default();
        #[cfg(windows)]
        recover_pending_cleanup_transactions(&self.base_dir)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        let plan = self
            .cleanup_plan(current_run_id, policy)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        if plan.selected != expected {
            return Err(CodeProCleanupExactError::StalePreview);
        }
        before_apply();
        let cleanup = self.apply_cleanup_plan_with_hooks(
            plan,
            after_candidate_revalidation,
            before_candidate_quarantine,
            before_candidate_delete,
            after_metadata_publish,
        )?;
        merge_cleanup_reports(&mut report, cleanup, policy.max_total_bytes);
        Ok(report)
    }

    fn cleanup_candidates_exact_locked(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
        expected: &[CodeProCleanupCandidate],
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError> {
        let _mutation_guard = CODEPRO_STATE_MUTATION_LOCK.lock().map_err(|_| {
            CodeProCleanupExactError::Persistence(
                "CodePro state mutation lock is unavailable".to_string(),
            )
        })?;
        #[cfg(windows)]
        let mut report = committed_cleanup_tombstone_report(&self.base_dir)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        #[cfg(not(windows))]
        let mut report = CodeProCleanupReport::default();
        #[cfg(windows)]
        recover_pending_cleanup_transactions(&self.base_dir)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        let plan = self
            .cleanup_plan(current_run_id, policy)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        if plan.selected != expected {
            return Err(CodeProCleanupExactError::StalePreview);
        }
        let cleanup = self.apply_cleanup_plan(plan)?;
        merge_cleanup_reports(&mut report, cleanup, policy.max_total_bytes);
        Ok(report)
    }

    fn cleanup_locked(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError> {
        let _mutation_guard = CODEPRO_STATE_MUTATION_LOCK.lock().map_err(|_| {
            CodeProCleanupExactError::Persistence(
                "CodePro state mutation lock is unavailable".to_string(),
            )
        })?;
        #[cfg(windows)]
        let mut report = committed_cleanup_tombstone_report(&self.base_dir)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        #[cfg(not(windows))]
        let mut report = CodeProCleanupReport::default();
        #[cfg(windows)]
        recover_pending_cleanup_transactions(&self.base_dir)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        let plan = self
            .cleanup_plan(current_run_id, policy)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        let cleanup = self.apply_cleanup_plan(plan)?;
        merge_cleanup_reports(&mut report, cleanup, policy.max_total_bytes);
        Ok(report)
    }

    fn apply_cleanup_plan(
        &self,
        plan: CodeProCleanupPlan,
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError> {
        self.apply_cleanup_plan_core(
            plan,
            #[cfg(test)]
            None,
        )
    }

    #[cfg(test)]
    fn apply_cleanup_plan_with_hooks<F, G, H, I>(
        &self,
        plan: CodeProCleanupPlan,
        mut after_candidate_revalidation: F,
        mut before_candidate_quarantine: G,
        mut before_candidate_delete: H,
        mut after_metadata_publish: I,
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError>
    where
        F: FnMut(usize),
        G: FnMut(usize, &std::path::Path),
        H: FnMut(usize, &std::path::Path),
        I: FnMut(&std::path::Path, &std::path::Path),
    {
        let mut hooks = CleanupTestHooks {
            after_candidate_revalidation: &mut after_candidate_revalidation,
            before_candidate_quarantine: &mut before_candidate_quarantine,
            before_candidate_delete: &mut before_candidate_delete,
            after_metadata_publish: &mut after_metadata_publish,
        };
        self.apply_cleanup_plan_core(plan, Some(&mut hooks))
    }

    fn apply_cleanup_plan_core(
        &self,
        plan: CodeProCleanupPlan,
        #[cfg(test)] mut hooks: Option<&mut CleanupTestHooks<'_>>,
    ) -> std::result::Result<CodeProCleanupReport, CodeProCleanupExactError> {
        let mut total_bytes = plan.total_bytes;
        let mut report = CodeProCleanupReport {
            preserved_current_run: plan.preserved_current_run,
            ..CodeProCleanupReport::default()
        };
        #[cfg_attr(not(test), allow(clippy::unused_enumerate_index))]
        for (_index, candidate) in plan.selected.iter().enumerate() {
            let expected_identity = plan
                .directory_identities
                .get(&candidate.run_id)
                .ok_or(CodeProCleanupExactError::StalePreview)?;
            if !self
                .cleanup_candidate_still_matches(candidate, expected_identity)
                .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?
            {
                return Err(CodeProCleanupExactError::StalePreview);
            }
            #[cfg(test)]
            if let Some(hooks) = hooks.as_deref_mut() {
                (hooks.after_candidate_revalidation)(_index);
            }
        }

        if plan.selected.is_empty() {
            report.bytes_remaining = total_bytes;
            report.over_capacity = total_bytes > plan.max_total_bytes;
            return Ok(report);
        }

        #[cfg(windows)]
        self.quarantine_and_delete_cleanup_candidates(
            &plan,
            &mut report,
            &mut total_bytes,
            #[cfg(test)]
            hooks,
        )?;
        #[cfg(not(windows))]
        {
            return Err(CodeProCleanupExactError::Persistence(
                "held-object CodePro cleanup is unavailable on this platform".to_string(),
            ));
        }
        report.bytes_remaining = total_bytes;
        report.over_capacity = total_bytes > plan.max_total_bytes;
        Ok(report)
    }

    #[cfg(windows)]
    fn quarantine_and_delete_cleanup_candidates(
        &self,
        plan: &CodeProCleanupPlan,
        report: &mut CodeProCleanupReport,
        total_bytes: &mut u64,
        #[cfg(test)] mut hooks: Option<&mut CleanupTestHooks<'_>>,
    ) -> std::result::Result<(), CodeProCleanupExactError> {
        let parent_handle = open_cleanup_parent(&self.base_dir)
            .map_err(|error| CodeProCleanupExactError::Persistence(error.to_string()))?;
        let transaction_id = uuid::Uuid::new_v4();
        let pending_name = format!("{CLEANUP_PENDING_PREFIX}{transaction_id}");
        let pending_path = self.base_dir.join(&pending_name);
        std::fs::create_dir(&pending_path).map_err(|error| {
            CodeProCleanupExactError::Persistence(format!(
                "failed to create cleanup transaction {}: {error}",
                pending_path.display()
            ))
        })?;
        let transaction_handle = match open_cleanup_transaction(&pending_path) {
            Ok(handle) => handle,
            Err(error) => {
                let removal = std::fs::remove_dir(&pending_path);
                let suffix = removal
                    .err()
                    .map(|remove_error| {
                        format!("; failed to remove empty transaction: {remove_error}")
                    })
                    .unwrap_or_default();
                return Err(CodeProCleanupExactError::Persistence(format!(
                    "failed to hold cleanup transaction: {error}{suffix}"
                )));
            }
        };
        let mut quarantined = Vec::with_capacity(plan.selected.len());

        #[cfg_attr(not(test), allow(clippy::unused_enumerate_index))]
        for (_index, candidate) in plan.selected.iter().enumerate() {
            let original_path = self.base_dir.join(&candidate.run_id);
            let expected_identity = match plan.directory_identities.get(&candidate.run_id) {
                Some(identity) => identity,
                None => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::StalePreview,
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            let root_handle = match open_held_cleanup_object(&original_path) {
                Ok(handle) => handle,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(format!(
                            "failed to hold exact cleanup candidate: {error}"
                        )),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            let handle_identity = match cleanup_directory_identity_from_handle(&root_handle) {
                Ok(identity) => identity,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.to_string()),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            let path_matches = match self.cleanup_candidate_at_path_still_matches(
                candidate,
                expected_identity,
                &original_path,
            ) {
                Ok(matches) => matches,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.to_string()),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            if handle_identity != *expected_identity || !path_matches {
                return Err(abort_cleanup_transaction(
                    CodeProCleanupExactError::StalePreview,
                    &parent_handle,
                    transaction_handle,
                    &pending_path,
                    &mut quarantined,
                ));
            }

            #[cfg(test)]
            if let Some(hooks) = hooks.as_deref_mut() {
                (hooks.before_candidate_quarantine)(_index, &original_path);
            }
            let path_matches = match self.cleanup_candidate_at_path_still_matches(
                candidate,
                expected_identity,
                &original_path,
            ) {
                Ok(matches) => matches,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.to_string()),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            if !path_matches {
                return Err(abort_cleanup_transaction(
                    CodeProCleanupExactError::StalePreview,
                    &parent_handle,
                    transaction_handle,
                    &pending_path,
                    &mut quarantined,
                ));
            }

            let quarantine_path = pending_path.join(&candidate.run_id);
            if let Err(error) = rename_cleanup_handle_relative(
                &root_handle,
                &transaction_handle,
                OsStr::new(&candidate.run_id),
            ) {
                let mut primary = CodeProCleanupExactError::Persistence(error.to_string());
                if cleanup_directory_identity(&quarantine_path)
                    .is_ok_and(|identity| identity == *expected_identity)
                {
                    quarantined.push(HeldCleanupCandidate {
                        candidate: candidate.clone(),
                        original_name: candidate.run_id.clone(),
                        quarantine_path: quarantine_path.clone(),
                        tree: HeldCleanupTree::root_only(root_handle),
                    });
                } else if !cleanup_directory_identity(&original_path)
                    .is_ok_and(|identity| identity == *expected_identity)
                {
                    primary = CodeProCleanupExactError::Persistence(format!(
                        "{primary}; failed rename left the held candidate at an unknown name"
                    ));
                }
                return Err(abort_cleanup_transaction(
                    primary,
                    &parent_handle,
                    transaction_handle,
                    &pending_path,
                    &mut quarantined,
                ));
            }
            let tree = match hold_cleanup_tree(quarantine_path.clone(), root_handle) {
                Ok(tree) => tree,
                Err(error) => {
                    quarantined.push(HeldCleanupCandidate {
                        candidate: candidate.clone(),
                        original_name: candidate.run_id.clone(),
                        quarantine_path,
                        tree: HeldCleanupTree::root_only(error.handle),
                    });
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.message),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            quarantined.push(HeldCleanupCandidate {
                candidate: candidate.clone(),
                original_name: candidate.run_id.clone(),
                quarantine_path,
                tree,
            });
            let held = quarantined.last().ok_or_else(|| {
                CodeProCleanupExactError::Persistence("cleanup hold disappeared".to_string())
            })?;
            let handle_identity = match cleanup_directory_identity_from_handle(&held.tree.handle) {
                Ok(identity) => identity,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.to_string()),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            let path_matches = match self.cleanup_candidate_at_path_still_matches(
                candidate,
                expected_identity,
                &held.quarantine_path,
            ) {
                Ok(matches) => matches,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.to_string()),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            if handle_identity != *expected_identity || !path_matches {
                return Err(abort_cleanup_transaction(
                    CodeProCleanupExactError::StalePreview,
                    &parent_handle,
                    transaction_handle,
                    &pending_path,
                    &mut quarantined,
                ));
            }
        }

        for held in &quarantined {
            let expected_identity = match plan.directory_identities.get(&held.candidate.run_id) {
                Some(identity) => identity,
                None => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::StalePreview,
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            let handle_identity = match cleanup_directory_identity_from_handle(&held.tree.handle) {
                Ok(identity) => identity,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.to_string()),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            let path_matches = match self.cleanup_candidate_at_path_still_matches(
                &held.candidate,
                expected_identity,
                &held.quarantine_path,
            ) {
                Ok(matches) => matches,
                Err(error) => {
                    return Err(abort_cleanup_transaction(
                        CodeProCleanupExactError::Persistence(error.to_string()),
                        &parent_handle,
                        transaction_handle,
                        &pending_path,
                        &mut quarantined,
                    ));
                }
            };
            if handle_identity != *expected_identity || !path_matches {
                return Err(abort_cleanup_transaction(
                    CodeProCleanupExactError::StalePreview,
                    &parent_handle,
                    transaction_handle,
                    &pending_path,
                    &mut quarantined,
                ));
            }
        }

        let receipt = match (|| {
            let transaction_identity = cleanup_receipt_identity(
                &cleanup_directory_identity_from_handle(&transaction_handle)?,
            );
            let mut candidates = Vec::with_capacity(plan.selected.len());
            for candidate in &plan.selected {
                let identity = plan
                    .directory_identities
                    .get(&candidate.run_id)
                    .ok_or_else(|| {
                        anyhow::anyhow!("cleanup plan lost a candidate directory identity")
                    })?;
                candidates.push(CleanupReceiptCandidate {
                    run_id: candidate.run_id.clone(),
                    bytes: candidate.bytes,
                    fingerprint_sha256: candidate.fingerprint_sha256.clone(),
                    directory_identity: cleanup_receipt_identity(identity),
                });
            }
            Ok::<_, anyhow::Error>(DeferredCleanupReceipt {
                version: CLEANUP_RECEIPT_VERSION,
                transaction_name: pending_name.clone(),
                transaction_identity,
                candidates,
            })
        })() {
            Ok(receipt) => receipt,
            Err(error) => {
                return Err(abort_cleanup_transaction(
                    CodeProCleanupExactError::Persistence(format!(
                        "failed to build cleanup receipt: {error}"
                    )),
                    &parent_handle,
                    transaction_handle,
                    &pending_path,
                    &mut quarantined,
                ));
            }
        };
        let commit_marker_path = pending_path.join(CLEANUP_COMMIT_MARKER);
        let marker_handle = match create_held_cleanup_marker(&commit_marker_path) {
            Ok(handle) => handle,
            Err(error) => {
                return Err(abort_cleanup_transaction(
                    CodeProCleanupExactError::Persistence(format!(
                        "failed to create cleanup commit marker: {error}"
                    )),
                    &parent_handle,
                    transaction_handle,
                    &pending_path,
                    &mut quarantined,
                ));
            }
        };
        report.removed_run_ids = receipt
            .candidates
            .iter()
            .map(|candidate| candidate.run_id.clone())
            .collect();
        report.deferred_cleanup_run_ids = report.removed_run_ids.clone();

        let (_receipt_path, receipt_handle) = match persist_cleanup_receipt(
            &self.base_dir,
            &parent_handle,
            &receipt,
        ) {
            Ok(published) => published,
            Err(error) => {
                warn!(%error, "CodePro cleanup receipt is unavailable; manual cleanup required");
                return Ok(());
            }
        };
        #[cfg(test)]
        if let Some(hooks) = hooks.as_deref_mut() {
            (hooks.after_metadata_publish)(&commit_marker_path, &_receipt_path);
        }
        drop(transaction_handle);
        let committed_handle = match open_held_cleanup_object(&pending_path) {
            Ok(handle)
                if cleanup_directory_identity_from_handle(&handle).is_ok_and(|identity| {
                    cleanup_receipt_identity(&identity) == receipt.transaction_identity
                }) && cleanup_directory_identity(&pending_path).is_ok_and(|identity| {
                    cleanup_receipt_identity(&identity) == receipt.transaction_identity
                }) =>
            {
                handle
            }
            Ok(_) => {
                warn!("CodePro committed cleanup object changed; manual cleanup required");
                return Ok(());
            }
            Err(error) => {
                warn!(%error, "CodePro committed cleanup object cannot be held; manual cleanup required");
                return Ok(());
            }
        };

        #[cfg_attr(not(test), allow(clippy::unused_enumerate_index))]
        for (_index, held) in quarantined.into_iter().enumerate() {
            #[cfg(test)]
            if let Some(hooks) = hooks.as_deref_mut() {
                (hooks.before_candidate_delete)(_index, &held.quarantine_path);
            }
            let run_id = held.candidate.run_id.clone();
            let bytes = held.candidate.bytes;
            if let Err(error) = delete_held_cleanup_tree(held.tree) {
                warn!(%run_id, %error, "CodePro physical cleanup stopped; manual cleanup required");
                return Ok(());
            }
            report.reclaimed_bytes = report.reclaimed_bytes.saturating_add(bytes);
            *total_bytes = total_bytes.saturating_sub(bytes);
        }

        if let Err(error) = delete_held_cleanup_tree(HeldCleanupTree::root_only(marker_handle)) {
            warn!(%error, "CodePro cleanup marker remains for manual cleanup");
            return Ok(());
        }
        if let Err(error) = delete_held_cleanup_tree(HeldCleanupTree::root_only(committed_handle)) {
            warn!(%error, "CodePro cleanup tombstone remains for manual cleanup");
            return Ok(());
        }
        if let Err(error) = delete_held_cleanup_tree(HeldCleanupTree::root_only(receipt_handle)) {
            warn!(%error, "CodePro cleanup receipt remains for manual cleanup");
            return Ok(());
        }
        report.deferred_cleanup_run_ids.clear();
        Ok(())
    }

    fn cleanup_candidate_still_matches(
        &self,
        candidate: &CodeProCleanupCandidate,
        expected_identity: &CleanupDirectoryIdentity,
    ) -> Result<bool> {
        let path = self.base_dir.join(&candidate.run_id);
        self.cleanup_candidate_at_path_still_matches(candidate, expected_identity, &path)
    }

    fn cleanup_candidate_at_path_still_matches(
        &self,
        candidate: &CodeProCleanupCandidate,
        expected_identity: &CleanupDirectoryIdentity,
        path: &std::path::Path,
    ) -> Result<bool> {
        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_dir() || is_link_or_reparse_point(&metadata) {
            return Ok(false);
        }
        let before_identity = cleanup_directory_identity(path)?;
        if &before_identity != expected_identity {
            return Ok(false);
        }
        let (bytes, content_fingerprint) = directory_metrics(path)?;
        if bytes != candidate.bytes || !stored_run_is_terminal(path) {
            return Ok(false);
        }
        if cleanup_directory_identity(path)? != before_identity {
            return Ok(false);
        }
        Ok(
            cleanup_fingerprint_bound_to_directory(&content_fingerprint, &before_identity)
                == candidate.fingerprint_sha256,
        )
    }

    pub fn preview_cleanup(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
    ) -> Result<Vec<CodeProCleanupCandidate>> {
        Ok(self.cleanup_plan(current_run_id, policy)?.selected)
    }

    fn cleanup_plan(
        &self,
        current_run_id: &str,
        policy: CodeProCleanupPolicy,
    ) -> Result<CodeProCleanupPlan> {
        if !self.base_dir.exists() {
            return Ok(CodeProCleanupPlan::default());
        }
        let current_run_id = sanitize_run_id(current_run_id);
        let now = SystemTime::now();
        let mut total_bytes = 0_u64;
        let mut candidates = Vec::new();
        for entry in std::fs::read_dir(&self.base_dir)
            .with_context(|| format!("读取 CodePro 存储目录失败: {}", self.base_dir.display()))?
        {
            let entry = entry.context("读取 CodePro 运行目录项失败")?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)
                .with_context(|| format!("读取 CodePro 运行元数据失败: {}", path.display()))?;
            if !metadata.is_dir() || is_link_or_reparse_point(&metadata) {
                continue;
            }
            let run_id = entry.file_name().to_string_lossy().to_string();
            if is_pending_cleanup_name(&run_id)
                || is_recovering_cleanup_name(&run_id)
                || is_recovery_cleanup_name(&run_id)
            {
                continue;
            }
            let directory_identity = cleanup_directory_identity(&path)?;
            let (bytes, content_fingerprint) = directory_metrics(&path)?;
            total_bytes = total_bytes.saturating_add(bytes);
            if run_id == current_run_id || !stored_run_is_terminal(&path) {
                continue;
            }
            if cleanup_directory_identity(&path)? != directory_identity {
                continue;
            }
            let fingerprint_sha256 =
                cleanup_fingerprint_bound_to_directory(&content_fingerprint, &directory_identity);
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let expired = now
                .duration_since(modified)
                .is_ok_and(|age| age >= policy.retention);
            candidates.push((
                run_id,
                bytes,
                fingerprint_sha256,
                directory_identity,
                modified,
                expired,
            ));
        }
        candidates.sort_by_key(|(_, _, _, _, modified, expired)| (!*expired, *modified));
        let mut remaining = total_bytes;
        let mut selected = Vec::new();
        let mut directory_identities = HashMap::new();
        for (run_id, bytes, fingerprint_sha256, directory_identity, _, expired) in candidates {
            if !expired && remaining <= policy.max_total_bytes {
                continue;
            }
            remaining = remaining.saturating_sub(bytes);
            directory_identities.insert(run_id.clone(), directory_identity);
            selected.push(CodeProCleanupCandidate {
                run_id,
                bytes,
                fingerprint_sha256,
            });
        }
        selected.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        Ok(CodeProCleanupPlan {
            selected,
            total_bytes,
            max_total_bytes: policy.max_total_bytes,
            preserved_current_run: self.base_dir.join(current_run_id).exists(),
            directory_identities,
        })
    }

    /// Load a previously saved run snapshot.
    pub async fn load(&self, run_id: &str) -> Result<CodeProRunState> {
        let checkpoint_store = self.checkpoint_store(run_id);
        checkpoint_store
            .recover(run_id)
            .map_err(anyhow::Error::msg)
            .context("恢复未完成的 checkpoint 事务")?;
        let restored = checkpoint_store
            .restored_state_json(run_id)
            .map_err(anyhow::Error::msg)?;
        let path = self.state_path(run_id);
        let json = match restored {
            Some(bytes) => String::from_utf8(bytes).context("恢复状态不是 UTF-8 JSON")?,
            None => tokio::fs::read_to_string(&path)
                .await
                .with_context(|| format!("读取 CodePro 状态文件失败: {}", path.display()))?,
        };
        let state = serde_json::from_str(&json)
            .with_context(|| format!("反序列化 CodePro 状态文件失败: {}", path.display()))?;
        normalize_loaded_state(state)
    }

    /// Delete all persisted state for a run.
    pub async fn delete(&self, run_id: &str) -> Result<()> {
        let dir = self.run_dir(run_id);
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir)
                .await
                .with_context(|| format!("删除 CodePro 运行状态失败: {}", dir.display()))?;
        }
        Ok(())
    }

    /// List all runs that are not in a terminal state.
    pub async fn list_incomplete(&self) -> Result<Vec<CodeProRunState>> {
        if !self.base_dir.exists() {
            return Ok(Vec::new());
        }
        let mut result = Vec::new();
        let mut entries = tokio::fs::read_dir(&self.base_dir)
            .await
            .with_context(|| format!("读取 CodePro 状态目录失败: {}", self.base_dir.display()))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .context("枚举 CodePro 状态目录失败")?
        {
            let path = entry.path();
            let state_file = path.join("run").join("state.json");
            if !state_file.is_file() {
                continue;
            }
            match tokio::fs::read_to_string(&state_file).await {
                Ok(json) => match serde_json::from_str::<CodeProRunState>(&json) {
                    Ok(state) if !is_terminal_status(state.status) => {
                        if let Ok(state) = normalize_loaded_state(state) {
                            result.push(state);
                        }
                    }
                    _ => {}
                },
                Err(_) => continue,
            }
        }
        result.sort_by_key(|state| std::cmp::Reverse(state.updated_at));
        Ok(result)
    }

    /// Return the path to the worktree for a run, if it exists.
    pub async fn worktree_path(&self, run_id: &str) -> Option<PathBuf> {
        self.load(run_id).await.ok().map(|s| s.worktree_path)
    }
}

#[derive(Debug, Default)]
struct CodeProCleanupPlan {
    selected: Vec<CodeProCleanupCandidate>,
    total_bytes: u64,
    max_total_bytes: u64,
    preserved_current_run: bool,
    directory_identities: HashMap<String, CleanupDirectoryIdentity>,
}

#[cfg(test)]
struct CleanupTestHooks<'a> {
    after_candidate_revalidation: &'a mut dyn FnMut(usize),
    before_candidate_quarantine: &'a mut dyn FnMut(usize, &std::path::Path),
    before_candidate_delete: &'a mut dyn FnMut(usize, &std::path::Path),
    after_metadata_publish: &'a mut dyn FnMut(&std::path::Path, &std::path::Path),
}

fn merge_cleanup_reports(
    target: &mut CodeProCleanupReport,
    source: CodeProCleanupReport,
    max_total_bytes: u64,
) {
    target.removed_run_ids.extend(source.removed_run_ids);
    target.removed_run_ids.sort();
    target.removed_run_ids.dedup();
    target
        .deferred_cleanup_run_ids
        .extend(source.deferred_cleanup_run_ids);
    target.deferred_cleanup_run_ids.sort();
    target.deferred_cleanup_run_ids.dedup();
    target.reclaimed_bytes = target
        .reclaimed_bytes
        .saturating_add(source.reclaimed_bytes);
    target.bytes_remaining = target
        .bytes_remaining
        .saturating_add(source.bytes_remaining);
    target.over_capacity = target.bytes_remaining > max_total_bytes;
    target.preserved_current_run |= source.preserved_current_run;
}

#[cfg(windows)]
struct HeldCleanupTree {
    handle: File,
    children: Vec<HeldCleanupTree>,
}

#[cfg(windows)]
impl HeldCleanupTree {
    fn root_only(handle: File) -> Self {
        Self {
            handle,
            children: Vec::new(),
        }
    }
}

#[cfg(windows)]
struct HeldCleanupTreeError {
    handle: File,
    message: String,
}

#[cfg(windows)]
struct HeldCleanupCandidate {
    candidate: CodeProCleanupCandidate,
    original_name: String,
    quarantine_path: PathBuf,
    tree: HeldCleanupTree,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupReceiptIdentity {
    volume_serial_number: u32,
    file_index: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupReceiptCandidate {
    run_id: String,
    bytes: u64,
    fingerprint_sha256: String,
    directory_identity: CleanupReceiptIdentity,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeferredCleanupReceipt {
    version: u32,
    transaction_name: String,
    transaction_identity: CleanupReceiptIdentity,
    candidates: Vec<CleanupReceiptCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CleanupDirectoryIdentity {
    #[cfg(windows)]
    Windows {
        volume_serial_number: u32,
        file_index: u64,
    },
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(not(any(windows, unix)))]
    Portable {
        created: Option<SystemTime>,
        modified: Option<SystemTime>,
    },
}

fn normalize_loaded_state(mut state: CodeProRunState) -> Result<CodeProRunState> {
    let workspace = match state.workspace.take() {
        Some(workspace) => workspace,
        None if paths_equivalent(&state.source_repo, &state.worktree_path)? => {
            CodeProWorkspaceDescriptor::direct(state.source_repo.clone())
        }
        None => CodeProWorkspaceDescriptor::legacy_unresolved(
            state.source_repo.clone(),
            state.worktree_path.clone(),
        ),
    };
    workspace.validate()?;
    anyhow::ensure!(
        paths_equivalent(&workspace.source_repo, &state.source_repo)?
            && paths_equivalent(&workspace.worktree_path, &state.worktree_path)?,
        "CodePro workspace descriptor does not match legacy path fields"
    );
    state.workspace = Some(workspace);
    match (state.status, state.pause_reason) {
        (CodeProRunStatus::Paused, None) => {
            state.pause_reason = Some(CodeProPauseReason::LegacyUnclassified);
        }
        (CodeProRunStatus::Paused, Some(_)) | (_, None) => {}
        (_, Some(reason)) => {
            anyhow::bail!("CodePro non-paused state cannot retain pause reason {reason:?}")
        }
    }
    let task_kind = state.dag.task_kind.unwrap_or(match state.workflow {
        Some(CodeProWorkflow::Test) => CodeProTaskKind::ProjectTest,
        Some(CodeProWorkflow::Change) | None => CodeProTaskKind::ComplexChange,
    });
    state
        .dag
        .ensure_action_budget(task_kind)
        .map_err(anyhow::Error::msg)?;
    Ok(state)
}

fn validate_pause_state(state: &CodeProRunState) -> Result<()> {
    match (state.status, state.pause_reason) {
        (CodeProRunStatus::Paused, Some(_)) => Ok(()),
        (CodeProRunStatus::Paused, None) => {
            anyhow::bail!("CodePro paused state requires a typed pause reason")
        }
        (_, None) => Ok(()),
        (_, Some(reason)) => {
            anyhow::bail!("CodePro non-paused state cannot retain pause reason {reason:?}")
        }
    }
}

fn commit_state_file(tmp: &std::path::Path, path: &std::path::Path) -> Result<()> {
    let _mutation_guard = CODEPRO_STATE_MUTATION_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("CodePro state mutation lock is unavailable"))?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(windows)]
fn open_cleanup_parent(path: &std::path::Path) -> Result<File> {
    const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
    const FILE_ADD_FILE: u32 = 0x0000_0002;
    const FILE_ADD_SUBDIRECTORY: u32 = 0x0000_0004;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    let handle = OpenOptions::new()
        .access_mode(
            FILE_LIST_DIRECTORY
                | FILE_ADD_FILE
                | FILE_ADD_SUBDIRECTORY
                | FILE_READ_ATTRIBUTES
                | SYNCHRONIZE,
        )
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .with_context(|| format!("failed to hold cleanup parent: {}", path.display()))?;
    if handle.metadata()?.file_attributes() & 0x0000_0400 != 0 {
        anyhow::bail!("cleanup parent cannot be a reparse point");
    }
    Ok(handle)
}

#[cfg(windows)]
fn open_cleanup_transaction(path: &std::path::Path) -> Result<File> {
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let handle = OpenOptions::new()
        .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .with_context(|| format!("failed to hold cleanup transaction: {}", path.display()))?;
    if handle.metadata()?.file_attributes() & 0x0000_0400 != 0 {
        anyhow::bail!("cleanup transaction cannot be a reparse point");
    }
    Ok(handle)
}

#[cfg(windows)]
fn create_held_cleanup_marker(path: &std::path::Path) -> Result<File> {
    const FILE_WRITE_DATA: u32 = 0x0000_0002;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let handle = OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE_ACCESS | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_OPEN_REPARSE_POINT)
        .open(path)
        .with_context(|| format!("failed to create held cleanup marker: {}", path.display()))?;
    let validation = (|| -> Result<()> {
        let metadata = handle.metadata()?;
        if !metadata.is_file() || metadata.file_attributes() & 0x0000_0400 != 0 {
            anyhow::bail!("cleanup marker must be a regular non-reparse file");
        }
        handle.sync_all().context("sync cleanup commit marker")?;
        Ok(())
    })();
    if let Err(error) = validation {
        let cleanup = delete_held_cleanup_tree(HeldCleanupTree::root_only(handle));
        if let Err(cleanup_error) = cleanup {
            anyhow::bail!("{error}; failed to remove incomplete cleanup marker: {cleanup_error}");
        }
        return Err(error);
    }
    Ok(handle)
}

#[cfg(windows)]
fn open_held_cleanup_object(path: &std::path::Path) -> Result<File> {
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let handle = OpenOptions::new()
        .access_mode(DELETE_ACCESS | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .with_context(|| format!("failed to hold cleanup object: {}", path.display()))?;
    if handle.metadata()?.file_attributes() & 0x0000_0400 != 0 {
        anyhow::bail!("held cleanup object cannot be a reparse point");
    }
    Ok(handle)
}

#[cfg(windows)]
fn hold_cleanup_tree(
    path: PathBuf,
    handle: File,
) -> std::result::Result<HeldCleanupTree, HeldCleanupTreeError> {
    let metadata = match handle.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(HeldCleanupTreeError {
                handle,
                message: format!("failed to read held cleanup object metadata: {error}"),
            });
        }
    };
    if metadata.file_attributes() & 0x0000_0400 != 0 {
        return Err(HeldCleanupTreeError {
            handle,
            message: "held cleanup tree contains a reparse point".to_string(),
        });
    }
    let mut tree = HeldCleanupTree::root_only(handle);
    if !metadata.is_dir() {
        return Ok(tree);
    }
    let mut entries = match std::fs::read_dir(&path)
        .and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>())
    {
        Ok(entries) => entries,
        Err(error) => {
            return Err(HeldCleanupTreeError {
                handle: tree.handle,
                message: format!("failed to enumerate held cleanup tree: {error}"),
            });
        }
    };
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let child_path = entry.path();
        let child_handle = match open_held_cleanup_object(&child_path) {
            Ok(handle) => handle,
            Err(error) => {
                return Err(HeldCleanupTreeError {
                    handle: tree.handle,
                    message: format!("failed to hold cleanup tree child: {error}"),
                });
            }
        };
        match hold_cleanup_tree(child_path, child_handle) {
            Ok(child) => tree.children.push(child),
            Err(error) => {
                return Err(HeldCleanupTreeError {
                    handle: tree.handle,
                    message: error.message,
                });
            }
        }
    }
    Ok(tree)
}

#[cfg(windows)]
fn rollback_cleanup_quarantines(
    parent_handle: &File,
    quarantined: &mut Vec<HeldCleanupCandidate>,
) -> std::result::Result<(), CodeProCleanupExactError> {
    let mut errors = Vec::new();
    for held in quarantined.iter_mut().rev() {
        held.tree.children.clear();
        if let Err(error) = rename_cleanup_handle_relative(
            &held.tree.handle,
            parent_handle,
            OsStr::new(&held.original_name),
        ) {
            let recovery_name = format!(
                "{}{CLEANUP_RECOVERY_MARKER}{}",
                held.original_name,
                uuid::Uuid::new_v4()
            );
            match rename_cleanup_handle_relative(
                &held.tree.handle,
                parent_handle,
                OsStr::new(&recovery_name),
            ) {
                Ok(()) => errors.push(format!(
                    "rollback to {} failed: {error}; cleanup candidate preserved at {}",
                    held.original_name, recovery_name
                )),
                Err(recovery_error) => errors.push(format!(
                    "rollback from {} failed: {error}; recovery rename also failed: {recovery_error}",
                    held.quarantine_path.display()
                )),
            }
        }
    }
    quarantined.clear();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(CodeProCleanupExactError::Persistence(errors.join("; ")))
    }
}

#[cfg(windows)]
fn abort_cleanup_transaction(
    primary: CodeProCleanupExactError,
    parent_handle: &File,
    transaction_handle: File,
    transaction_path: &std::path::Path,
    quarantined: &mut Vec<HeldCleanupCandidate>,
) -> CodeProCleanupExactError {
    let rollback_error = rollback_cleanup_quarantines(parent_handle, quarantined).err();
    let transaction_error =
        delete_held_cleanup_tree(HeldCleanupTree::root_only(transaction_handle))
            .err()
            .map(|error| {
                format!(
                    "failed to remove cleanup transaction {}: {error}",
                    transaction_path.display()
                )
            });
    if rollback_error.is_none() && transaction_error.is_none() {
        return primary;
    }
    let mut errors = vec![primary.to_string()];
    if let Some(error) = rollback_error {
        errors.push(error.to_string());
    }
    if let Some(error) = transaction_error {
        errors.push(error);
    }
    CodeProCleanupExactError::Persistence(errors.join("; "))
}

#[cfg(windows)]
fn cleanup_receipt_identity(identity: &CleanupDirectoryIdentity) -> CleanupReceiptIdentity {
    match identity {
        CleanupDirectoryIdentity::Windows {
            volume_serial_number,
            file_index,
        } => CleanupReceiptIdentity {
            volume_serial_number: *volume_serial_number,
            file_index: *file_index,
        },
    }
}

#[cfg(windows)]
fn cleanup_transaction_id(transaction_name: &str) -> Result<&str> {
    let transaction_id = transaction_name
        .strip_prefix(CLEANUP_PENDING_PREFIX)
        .or_else(|| transaction_name.strip_prefix(CLEANUP_RECOVERING_PREFIX))
        .filter(|value| !value.is_empty())
        .context("cleanup receipt transaction name is invalid")?;
    if std::path::Path::new(transaction_id).components().count() != 1 {
        anyhow::bail!("cleanup receipt transaction id is not one path segment");
    }
    Ok(transaction_id)
}

#[cfg(windows)]
fn original_pending_cleanup_name(transaction_name: &str) -> Result<String> {
    Ok(format!(
        "{CLEANUP_PENDING_PREFIX}{}",
        cleanup_transaction_id(transaction_name)?
    ))
}

#[cfg(windows)]
fn cleanup_receipt_path(base_dir: &std::path::Path, transaction_name: &str) -> Result<PathBuf> {
    let transaction_id = cleanup_transaction_id(transaction_name)?;
    Ok(base_dir.join(format!("{CLEANUP_RECEIPT_PREFIX}{transaction_id}.json")))
}

#[cfg(windows)]
fn persist_cleanup_receipt(
    base_dir: &std::path::Path,
    parent_handle: &File,
    receipt: &DeferredCleanupReceipt,
) -> Result<(PathBuf, File)> {
    let path = cleanup_receipt_path(base_dir, &receipt.transaction_name)?;
    if path.exists() {
        anyhow::bail!("cleanup receipt already exists: {}", path.display());
    }
    let temporary = base_dir.join(format!(
        ".codepro-cleanup-receipt-tmp-{}",
        uuid::Uuid::new_v4()
    ));
    let mut bytes = serde_json::to_vec_pretty(receipt).context("serialize cleanup receipt")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_CLEANUP_RECEIPT_BYTES {
        anyhow::bail!("cleanup receipt exceeds the size limit");
    }
    const FILE_WRITE_DATA: u32 = 0x0000_0002;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const DELETE_ACCESS: u32 = 0x0001_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE_ACCESS | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_OPEN_REPARSE_POINT)
        .open(&temporary)
        .with_context(|| format!("create cleanup receipt temp: {}", temporary.display()))?;
    let write_result = (|| -> Result<()> {
        file.write_all(&bytes)
            .context("write cleanup receipt temp")?;
        file.sync_all().context("sync cleanup receipt temp")?;
        let receipt_name = path
            .file_name()
            .context("cleanup receipt path has no file name")?;
        rename_cleanup_handle_relative(&file, parent_handle, receipt_name)
            .with_context(|| format!("publish cleanup receipt to {}", path.display()))?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.file_attributes() & 0x0000_0400 != 0 {
            anyhow::bail!("cleanup receipt must be a regular non-reparse file");
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        let cleanup = delete_held_cleanup_tree(HeldCleanupTree::root_only(file));
        if let Err(cleanup_error) = cleanup {
            anyhow::bail!("{error}; failed to remove incomplete cleanup receipt: {cleanup_error}");
        }
        return Err(error);
    }
    Ok((path, file))
}

#[cfg(windows)]
fn diagnostic_receipt_run_ids(
    receipt_path: &std::path::Path,
    expected_transaction: Option<&str>,
) -> Option<Vec<String>> {
    let metadata = std::fs::symlink_metadata(receipt_path).ok()?;
    if !metadata.is_file()
        || is_link_or_reparse_point(&metadata)
        || metadata.len() > MAX_CLEANUP_RECEIPT_BYTES as u64
    {
        return None;
    }
    let receipt: DeferredCleanupReceipt =
        serde_json::from_slice(&std::fs::read(receipt_path).ok()?).ok()?;
    if receipt.version != CLEANUP_RECEIPT_VERSION
        || expected_transaction.is_some_and(|name| receipt.transaction_name != name)
    {
        return None;
    }
    let mut run_ids = receipt
        .candidates
        .into_iter()
        .map(|candidate| candidate.run_id)
        .filter(|run_id| {
            !run_id.is_empty() && std::path::Path::new(run_id).components().count() == 1
        })
        .collect::<Vec<_>>();
    run_ids.sort();
    run_ids.dedup();
    (!run_ids.is_empty()).then_some(run_ids)
}

#[cfg(windows)]
fn diagnostic_transaction_run_ids(transaction_path: &std::path::Path) -> Vec<String> {
    let mut run_ids = std::fs::read_dir(transaction_path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(|entry| entry.ok()))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name != CLEANUP_COMMIT_MARKER && !name.is_empty())
        .collect::<Vec<_>>();
    run_ids.sort();
    run_ids.dedup();
    run_ids
}

#[cfg(windows)]
fn cleanup_artifact_exists(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

#[cfg(windows)]
fn cleanup_transaction_has_commit_marker(transaction_path: &std::path::Path) -> Result<bool> {
    Ok(std::fs::read_dir(transaction_path)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .any(|entry| entry.file_name() == OsStr::new(CLEANUP_COMMIT_MARKER)))
}

#[cfg(windows)]
fn committed_cleanup_tombstone_report(base_dir: &std::path::Path) -> Result<CodeProCleanupReport> {
    let mut report = CodeProCleanupReport::default();
    if !base_dir.exists() {
        return Ok(report);
    }
    let mut entries = std::fs::read_dir(base_dir)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_pending_cleanup_name(&name) && !is_recovering_cleanup_name(&name) {
            continue;
        }
        let original_name = original_pending_cleanup_name(&name)?;
        let receipt_path = cleanup_receipt_path(base_dir, &name)?;
        let is_tombstone = is_recovering_cleanup_name(&name)
            || cleanup_artifact_exists(&entry.path().join(CLEANUP_COMMIT_MARKER))
            || cleanup_artifact_exists(&receipt_path);
        if !is_tombstone {
            continue;
        }
        report.bytes_remaining = report
            .bytes_remaining
            .saturating_add(directory_metrics(&entry.path())?.0);
        let run_ids = diagnostic_receipt_run_ids(&receipt_path, Some(&original_name))
            .unwrap_or_else(|| diagnostic_transaction_run_ids(&entry.path()));
        report.deferred_cleanup_run_ids.extend(run_ids);
    }
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(CLEANUP_RECEIPT_PREFIX) || !name.ends_with(".json") {
            continue;
        }
        if let Some(run_ids) = diagnostic_receipt_run_ids(&entry.path(), None) {
            report.deferred_cleanup_run_ids.extend(run_ids);
        }
    }
    report.deferred_cleanup_run_ids.sort();
    report.deferred_cleanup_run_ids.dedup();
    Ok(report)
}

#[cfg(windows)]
fn recover_pending_cleanup_transactions(base_dir: &std::path::Path) -> Result<()> {
    recover_pending_cleanup_transactions_core(
        base_dir,
        #[cfg(test)]
        None,
    )
}

#[cfg(test)]
#[cfg(windows)]
fn recover_pending_cleanup_transactions_with_hook<F>(
    base_dir: &std::path::Path,
    mut after_initial_commit_check: F,
) -> Result<()>
where
    F: FnMut(&std::path::Path, &str),
{
    recover_pending_cleanup_transactions_core(base_dir, Some(&mut after_initial_commit_check))
}

#[cfg(windows)]
#[allow(clippy::type_complexity)]
fn recover_pending_cleanup_transactions_core(
    base_dir: &std::path::Path,
    #[cfg(test)] mut after_initial_commit_check: Option<&mut dyn FnMut(&std::path::Path, &str)>,
) -> Result<()> {
    if !base_dir.exists() {
        return Ok(());
    }
    let parent_handle = open_cleanup_parent(base_dir)?;
    let mut pending = std::fs::read_dir(base_dir)?
        .collect::<std::io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            is_pending_cleanup_name(&name)
                && !cleanup_artifact_exists(&entry.path().join(CLEANUP_COMMIT_MARKER))
                && !cleanup_receipt_path(base_dir, &name)
                    .is_ok_and(|path| cleanup_artifact_exists(&path))
        })
        .collect::<Vec<_>>();
    pending.sort_by_key(std::fs::DirEntry::file_name);
    let mut errors = Vec::new();
    for entry in pending {
        let pending_path = entry.path();
        let pending_name = entry.file_name().to_string_lossy().to_string();
        let receipt_path = cleanup_receipt_path(base_dir, &pending_name)?;
        if cleanup_artifact_exists(&pending_path.join(CLEANUP_COMMIT_MARKER))
            || cleanup_artifact_exists(&receipt_path)
        {
            continue;
        }
        #[cfg(test)]
        if let Some(hook) = after_initial_commit_check.as_deref_mut() {
            hook(&pending_path, &pending_name);
        }
        let transaction_handle = match open_held_cleanup_object(&pending_path) {
            Ok(handle) => handle,
            Err(error) => {
                errors.push(format!(
                    "failed to hold pending cleanup transaction {}: {error}",
                    pending_path.display()
                ));
                continue;
            }
        };
        let recovering_name = format!(
            "{CLEANUP_RECOVERING_PREFIX}{}",
            cleanup_transaction_id(&pending_name)?
        );
        let transaction_path = base_dir.join(&recovering_name);
        if let Err(error) = rename_cleanup_handle_relative(
            &transaction_handle,
            &parent_handle,
            OsStr::new(&recovering_name),
        ) {
            errors.push(format!(
                "failed to claim pending cleanup transaction {}: {error}",
                pending_path.display()
            ));
            continue;
        }
        let handle_identity = match cleanup_directory_identity_from_handle(&transaction_handle) {
            Ok(identity) => identity,
            Err(error) => {
                errors.push(format!(
                    "failed to identify claimed cleanup transaction {}: {error}",
                    transaction_path.display()
                ));
                continue;
            }
        };
        if !cleanup_directory_identity(&transaction_path)
            .is_ok_and(|identity| identity == handle_identity)
        {
            errors.push(format!(
                "claimed cleanup transaction changed at {}; manual recovery required",
                transaction_path.display()
            ));
            continue;
        }
        if cleanup_transaction_has_commit_marker(&transaction_path)?
            || cleanup_artifact_exists(&receipt_path)
        {
            errors.push(format!(
                "cleanup transaction {} committed while recovery was starting; claimed tombstone preserved",
                pending_name
            ));
            continue;
        }
        let mut children = match std::fs::read_dir(&transaction_path)
            .and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>())
        {
            Ok(children) => children,
            Err(error) => {
                errors.push(format!(
                    "failed to enumerate pending cleanup transaction {}: {error}",
                    transaction_path.display()
                ));
                continue;
            }
        };
        children.sort_by_key(std::fs::DirEntry::file_name);
        let collision = children.iter().find_map(|child| {
            let original_name = child.file_name().to_string_lossy().to_string();
            cleanup_artifact_exists(&base_dir.join(&original_name)).then_some(original_name)
        });
        if let Some(original_name) = collision {
            errors.push(format!(
                "pending cleanup candidate {original_name} collides with an existing run; transaction preserved"
            ));
            continue;
        }

        let mut held_children = Vec::with_capacity(children.len());
        let mut hold_error = None;
        for child in &children {
            let original_name = child.file_name().to_string_lossy().to_string();
            let child_handle = match open_held_cleanup_object(&child.path()) {
                Ok(handle) => handle,
                Err(error) => {
                    hold_error = Some(format!(
                        "failed to hold pending cleanup candidate {}: {error}",
                        child.path().display()
                    ));
                    break;
                }
            };
            held_children.push((original_name, child_handle));
        }
        if let Some(error) = hold_error {
            errors.push(error);
            continue;
        }

        if cleanup_transaction_has_commit_marker(&transaction_path)?
            || cleanup_artifact_exists(&receipt_path)
        {
            errors.push(format!(
                "cleanup transaction {} committed before restore; claimed tombstone preserved",
                pending_name
            ));
            continue;
        }

        let mut rename_error = None;
        for (original_name, child_handle) in held_children {
            if let Err(error) = rename_cleanup_handle_relative(
                &child_handle,
                &parent_handle,
                OsStr::new(&original_name),
            ) {
                rename_error = Some(format!(
                    "failed to restore pending cleanup candidate {original_name}; transaction preserved: {error}"
                ));
                break;
            }
        }
        if let Some(error) = rename_error {
            errors.push(error);
            continue;
        }
        if let Err(error) = delete_held_cleanup_tree(HeldCleanupTree::root_only(transaction_handle))
        {
            errors.push(format!(
                "failed to remove pending cleanup transaction {}: {error}",
                transaction_path.display()
            ));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(errors.join("; "))
    }
}

#[cfg(windows)]
fn delete_held_cleanup_tree(tree: HeldCleanupTree) -> Result<()> {
    for child in tree.children {
        delete_held_cleanup_tree(child)?;
    }
    let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let result = unsafe {
        SetFileInformationByHandle(
            tree.handle.as_raw_handle().cast(),
            FileDispositionInfo,
            (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to delete exact held cleanup object");
    }
    drop(tree.handle);
    Ok(())
}

#[cfg(windows)]
fn cleanup_rename_layout() -> Option<(usize, usize, usize)> {
    let pointer_size = std::mem::size_of::<usize>();
    let pointer_alignment = std::mem::align_of::<usize>();
    if !matches!(pointer_size, 4 | 8) || pointer_alignment != pointer_size {
        return None;
    }
    let root_offset = (1 + pointer_alignment - 1) & !(pointer_alignment - 1);
    let length_offset = root_offset.checked_add(pointer_size)?;
    let name_offset = length_offset.checked_add(std::mem::size_of::<u32>())?;
    Some((root_offset, length_offset, name_offset))
}

#[cfg(windows)]
fn rename_cleanup_handle_relative(target: &File, parent: &File, name: &OsStr) -> Result<()> {
    if name.is_empty() || std::path::Path::new(name).components().count() != 1 {
        anyhow::bail!("cleanup rename destination must be one path segment");
    }
    let wide = name.encode_wide().collect::<Vec<_>>();
    let name_bytes = wide
        .len()
        .checked_mul(2)
        .and_then(|length| u32::try_from(length).ok())
        .context("cleanup rename destination is too long")?;
    let (root_offset, length_offset, name_offset) = cleanup_rename_layout()
        .context("cleanup rename ABI is unsupported on this pointer layout")?;
    let mut information = vec![0_u8; name_offset + name_bytes as usize];
    information[0] = 0;
    information[root_offset..root_offset + std::mem::size_of::<usize>()]
        .copy_from_slice(&(parent.as_raw_handle() as usize).to_ne_bytes());
    information[length_offset..name_offset].copy_from_slice(&name_bytes.to_ne_bytes());
    for (index, unit) in wide.iter().enumerate() {
        let offset = name_offset + index * 2;
        information[offset..offset + 2].copy_from_slice(&unit.to_ne_bytes());
    }
    let mut io_status = CleanupIoStatusBlock {
        status: 0,
        information: 0,
    };
    let status = unsafe {
        NtSetInformationFile(
            target.as_raw_handle().cast(),
            &mut io_status,
            information.as_mut_ptr().cast(),
            u32::try_from(information.len()).context("cleanup rename buffer is too large")?,
            10,
        )
    };
    if status < 0 {
        anyhow::bail!(
            "held cleanup rename failed with NTSTATUS 0x{:08x}",
            status as u32
        );
    }
    Ok(())
}

fn sanitize_run_id(run_id: &str) -> String {
    run_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn is_pending_cleanup_name(name: &str) -> bool {
    name.starts_with(".codepro-cleanup-pending-")
}

fn is_recovering_cleanup_name(name: &str) -> bool {
    name.starts_with(CLEANUP_RECOVERING_PREFIX)
}

fn is_recovery_cleanup_name(name: &str) -> bool {
    name.contains(".codepro-cleanup-recovery-")
}

fn is_terminal_status(status: CodeProRunStatus) -> bool {
    matches!(
        status,
        CodeProRunStatus::Completed | CodeProRunStatus::Failed | CodeProRunStatus::Discarded
    )
}

fn stored_run_is_terminal(run_root: &std::path::Path) -> bool {
    let state_path = run_root.join("run").join("state.json");
    std::fs::read_to_string(state_path)
        .ok()
        .and_then(|json| serde_json::from_str::<CodeProRunState>(&json).ok())
        .is_some_and(|state| is_terminal_status(state.status))
}

fn directory_metrics(path: &std::path::Path) -> Result<(u64, String)> {
    let mut total = 0_u64;
    let mut hasher = Sha256::new();
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let mut entries = std::fs::read_dir(&directory)
            .with_context(|| format!("读取 CodePro 存储大小失败: {}", directory.display()))?
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let entry_path = entry.path();
            let metadata = std::fs::symlink_metadata(&entry_path).with_context(|| {
                format!("读取 CodePro 存储元数据失败: {}", entry_path.display())
            })?;
            if is_link_or_reparse_point(&metadata) {
                anyhow::bail!("CodePro run contains a link or reparse point");
            }
            let relative = entry_path.strip_prefix(path).unwrap_or(&entry_path);
            hasher.update(relative.to_string_lossy().as_bytes());
            if metadata.is_dir() {
                hasher.update(b"D");
                pending.push(entry_path);
                continue;
            }
            if !metadata.is_file() {
                anyhow::bail!("CodePro run contains an unsupported file type");
            }
            hasher.update(b"F");
            hasher.update(metadata.len().to_le_bytes());
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            hasher.update(modified.to_le_bytes());
            if relative == std::path::Path::new("run").join("state.json") {
                hasher.update(std::fs::read(&entry_path)?);
            }
            total = total.saturating_add(metadata.len());
        }
    }
    let digest = hasher.finalize();
    Ok((total, hex_digest(&digest)))
}

fn cleanup_fingerprint_bound_to_directory(
    content_fingerprint: &str,
    identity: &CleanupDirectoryIdentity,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"codepro-cleanup-directory-v1");
    hasher.update(content_fingerprint.as_bytes());
    match identity {
        #[cfg(windows)]
        CleanupDirectoryIdentity::Windows {
            volume_serial_number,
            file_index,
        } => {
            hasher.update(b"windows");
            hasher.update(volume_serial_number.to_le_bytes());
            hasher.update(file_index.to_le_bytes());
        }
        #[cfg(unix)]
        CleanupDirectoryIdentity::Unix { device, inode } => {
            hasher.update(b"unix");
            hasher.update(device.to_le_bytes());
            hasher.update(inode.to_le_bytes());
        }
        #[cfg(not(any(windows, unix)))]
        CleanupDirectoryIdentity::Portable { created, modified } => {
            hasher.update(b"portable");
            for timestamp in [created, modified] {
                hasher.update(
                    timestamp
                        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
                        .map(|value| value.as_nanos())
                        .unwrap_or(0)
                        .to_le_bytes(),
                );
            }
        }
    }
    hex_digest(&hasher.finalize())
}

#[cfg(windows)]
fn cleanup_directory_identity(path: &std::path::Path) -> Result<CleanupDirectoryIdentity> {
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    let directory = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .with_context(|| {
            format!(
                "failed to open cleanup directory identity: {}",
                path.display()
            )
        })?;
    cleanup_directory_identity_from_handle(&directory)
}

#[cfg(windows)]
fn cleanup_directory_identity_from_handle(directory: &File) -> Result<CleanupDirectoryIdentity> {
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let success = unsafe {
        GetFileInformationByHandle(directory.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if success == 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to query cleanup directory identity");
    }
    let information = unsafe { information.assume_init() };
    Ok(CleanupDirectoryIdentity::Windows {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    })
}

#[cfg(unix)]
fn cleanup_directory_identity(path: &std::path::Path) -> Result<CleanupDirectoryIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(path)?;
    Ok(CleanupDirectoryIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(any(windows, unix)))]
fn cleanup_directory_identity(path: &std::path::Path) -> Result<CleanupDirectoryIdentity> {
    let metadata = std::fs::symlink_metadata(path)?;
    Ok(CleanupDirectoryIdentity::Portable {
        created: metadata.created().ok(),
        modified: metadata.modified().ok(),
    })
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::permissions_set_readonly_false, clippy::string_slice)]

    use super::*;
    use crate::agents::action_budget::CodeProActionBudgetPolicy;
    use crate::agents::agent_role::{AgentRole, CodeProTaskKind};
    use crate::agents::codepro_intent::CodeProWorkflow;
    use crate::agents::task_dag::TaskDAG;

    fn workspace_state(source_repo: PathBuf, worktree_path: PathBuf) -> CodeProRunState {
        CodeProRunState {
            run_id: "workspace-migration".to_string(),
            goal: "resume".to_string(),
            source_repo,
            worktree_path,
            workspace: None,
            status: CodeProRunStatus::Paused,
            pause_reason: Some(CodeProPauseReason::CheckpointPaused),
            workflow: Some(CodeProWorkflow::Change),
            last_active_run_id: None,
            dag: TaskDAG::new("resume", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn cleanup_preview_excludes_in_progress_and_recovery_directories_on_all_platforms() {
        let root = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(root.path());
        let mut state = workspace_state(root.path().into(), root.path().into());
        state.status = CodeProRunStatus::Completed;
        for name in [
            "finished",
            ".codepro-cleanup-pending-transaction",
            ".codepro-cleanup-recovering-transaction",
            "finished.codepro-cleanup-recovery-transaction",
        ] {
            let run = root.path().join(name).join("run");
            std::fs::create_dir_all(&run).unwrap();
            std::fs::write(run.join("state.json"), serde_json::to_vec(&state).unwrap()).unwrap();
        }
        let candidates = store
            .preview_cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 0,
                    retention: Duration::ZERO,
                },
            )
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].run_id, "finished");
    }

    #[tokio::test]
    async fn checkpoint_input_verified_state_load_preserves_ordinary_load() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(root.path());
        let mut current = workspace_state(workspace.path().into(), workspace.path().into());
        current.status = CodeProRunStatus::Running;
        current.pause_reason = None;
        store.save_without_cleanup(&current).await.unwrap();
        let current = store.load(&current.run_id).await.unwrap();
        let mut waiting = current.clone();
        waiting.status = CodeProRunStatus::Paused;
        waiting.pause_reason = Some(CodeProPauseReason::UserInputRequired);
        store
            .checkpoint_store(&current.run_id)
            .prepare_and_publish(CheckpointPrepareRequest {
                run_id: current.run_id.clone(),
                checkpoint_id: "checkpoint-input".to_string(),
                workspace: workspace.path().into(),
                state_json: serde_json::to_vec(&waiting).unwrap(),
                budget_json: b"{}".to_vec(),
                plan_revision: waiting.dag.plan_revision,
                event_sequence: 7,
                approvals: Vec::new(),
                required_approval_scope: None,
                files: Vec::new(),
            })
            .unwrap();

        let (loaded, revision, sequence) = store
            .load_verified_checkpoint_state(&current.run_id, "checkpoint-input", workspace.path())
            .unwrap();
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(&waiting).unwrap()
        );
        assert_eq!((revision, sequence), (waiting.dag.plan_revision, 7));
        assert_eq!(
            serde_json::to_value(store.load(&current.run_id).await.unwrap()).unwrap(),
            serde_json::to_value(&current).unwrap()
        );
    }

    #[test]
    fn checkpoint_input_verified_state_rejects_state_identity_mismatches() {
        for mismatch in ["run", "workspace", "plan", "descriptor"] {
            let root = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let other_workspace = tempfile::tempdir().unwrap();
            let store = CodeProStateStore::new(root.path());
            let mut state = workspace_state(workspace.path().into(), workspace.path().into());
            let run_id = state.run_id.clone();
            let plan_revision = state.dag.plan_revision;
            match mismatch {
                "run" => state.run_id = "another-run".to_string(),
                "workspace" => {
                    state.source_repo = other_workspace.path().into();
                    state.worktree_path = other_workspace.path().into();
                }
                "plan" => state.dag.plan_revision += 1,
                "descriptor" => {
                    state.workspace = Some(CodeProWorkspaceDescriptor::direct(
                        other_workspace.path().into(),
                    ));
                }
                _ => unreachable!(),
            }
            store
                .checkpoint_store(&run_id)
                .prepare_and_publish(CheckpointPrepareRequest {
                    run_id: run_id.clone(),
                    checkpoint_id: "checkpoint-input".to_string(),
                    workspace: workspace.path().into(),
                    state_json: serde_json::to_vec(&state).unwrap(),
                    budget_json: b"{}".to_vec(),
                    plan_revision,
                    event_sequence: 7,
                    approvals: Vec::new(),
                    required_approval_scope: None,
                    files: Vec::new(),
                })
                .unwrap();
            assert!(
                store
                    .load_verified_checkpoint_state(&run_id, "checkpoint-input", workspace.path())
                    .is_err(),
                "accepted {mismatch}"
            );
            assert!(!store.state_path(&run_id).exists());
        }
    }

    #[tokio::test]
    async fn checkpoint_input_conditional_save_rejects_changed_current_state() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(root.path());
        let mut expected = workspace_state(workspace.path().into(), workspace.path().into());
        expected.status = CodeProRunStatus::Running;
        expected.pause_reason = None;
        store.save_without_cleanup(&expected).await.unwrap();
        let expected = store.load(&expected.run_id).await.unwrap();
        let mut recovered = expected.clone();
        recovered.status = CodeProRunStatus::Paused;
        recovered.pause_reason = Some(CodeProPauseReason::UserInputRequired);
        store
            .save_host_input_state_if_unchanged(&expected, &recovered)
            .unwrap();
        assert_eq!(
            serde_json::to_value(store.load(&expected.run_id).await.unwrap()).unwrap(),
            serde_json::to_value(&recovered).unwrap()
        );
        for change in ["goal", "status", "budget", "output"] {
            let mut newer = expected.clone();
            match change {
                "goal" => newer.goal = "new goal".to_string(),
                "status" => newer.status = CodeProRunStatus::Discarded,
                "budget" => {
                    newer.dag.budgets.insert("newer-budget".to_string(), 2);
                }
                "output" => newer.final_report = Some("newer result".to_string()),
                _ => unreachable!(),
            }
            store.save_without_cleanup(&newer).await.unwrap();
            let before = std::fs::read(store.state_path(&expected.run_id)).unwrap();
            assert!(
                store
                    .save_host_input_state_if_unchanged(&expected, &recovered)
                    .is_err(),
                "overwrote {change}"
            );
            assert_eq!(
                std::fs::read(store.state_path(&expected.run_id)).unwrap(),
                before
            );
        }
    }

    #[test]
    fn legacy_direct_state_migrates_without_git_authority() {
        let workspace = tempfile::tempdir().unwrap();
        let state = workspace_state(
            workspace.path().to_path_buf(),
            workspace.path().to_path_buf(),
        );
        let migrated = normalize_loaded_state(state).unwrap();
        let descriptor = migrated.workspace.unwrap();
        assert_eq!(
            descriptor.mode,
            crate::agents::codepro_workspace::CodeProWorkspaceMode::Direct
        );
        assert!(descriptor.git.is_none());
    }

    #[test]
    fn legacy_split_paths_remain_readable_but_unresolved() {
        let source = tempfile::tempdir().unwrap();
        let worktree = tempfile::tempdir().unwrap();
        let migrated = normalize_loaded_state(workspace_state(
            source.path().to_path_buf(),
            worktree.path().to_path_buf(),
        ))
        .unwrap();
        let descriptor = migrated.workspace.unwrap();
        assert_eq!(
            descriptor.mode,
            crate::agents::codepro_workspace::CodeProWorkspaceMode::LegacyUnresolved
        );
        assert!(descriptor.projection().execution_directory.is_none());
    }

    async fn save_terminal_cleanup_candidate(store: &CodeProStateStore, run_id: &str) {
        let state = CodeProRunState {
            run_id: run_id.to_string(),
            goal: "cleanup candidate".to_string(),
            source_repo: PathBuf::from("/src"),
            worktree_path: PathBuf::from("/work"),
            workspace: None,
            status: CodeProRunStatus::Completed,
            pause_reason: None,
            workflow: Some(CodeProWorkflow::Test),
            last_active_run_id: None,
            dag: TaskDAG::new("cleanup candidate", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save_without_cleanup(&state).await.unwrap();
        tokio::fs::write(
            store.run_dir(run_id).join("evidence.bin"),
            format!("evidence-{run_id}"),
        )
        .await
        .unwrap();
    }

    #[cfg(windows)]
    fn cleanup_transaction_entries(base_dir: &std::path::Path) -> Vec<PathBuf> {
        let mut entries = std::fs::read_dir(base_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.starts_with(".codepro-cleanup-pending-")
                    || name.starts_with(".codepro-cleanup-recovering-")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    #[cfg(windows)]
    fn cleanup_receipt_entries(base_dir: &std::path::Path) -> Vec<PathBuf> {
        let mut entries = std::fs::read_dir(base_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.starts_with(".codepro-cleanup-receipt-") && name.ends_with(".json")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    #[cfg(windows)]
    fn copy_tree_with_hard_links(source: &std::path::Path, destination: &std::path::Path) {
        std::fs::create_dir(destination).unwrap();
        let mut entries = std::fs::read_dir(source)
            .unwrap()
            .collect::<std::io::Result<Vec<_>>>()
            .unwrap();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let destination_path = destination.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree_with_hard_links(&entry.path(), &destination_path);
            } else {
                std::fs::hard_link(entry.path(), destination_path).unwrap();
            }
        }
    }

    #[cfg(windows)]
    fn rewrite_cleanup_receipt_for_current_objects(
        base_dir: &std::path::Path,
        transaction: &std::path::Path,
    ) {
        let receipt_path = cleanup_receipt_entries(base_dir).pop().unwrap();
        let mut receipt: DeferredCleanupReceipt =
            serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
        receipt.transaction_identity =
            cleanup_receipt_identity(&cleanup_directory_identity(transaction).unwrap());
        for candidate in &mut receipt.candidates {
            let candidate_path = transaction.join(&candidate.run_id);
            let identity = cleanup_directory_identity(&candidate_path).unwrap();
            let (bytes, fingerprint) = directory_metrics(&candidate_path).unwrap();
            candidate.bytes = bytes;
            candidate.directory_identity = cleanup_receipt_identity(&identity);
            candidate.fingerprint_sha256 =
                cleanup_fingerprint_bound_to_directory(&fingerprint, &identity);
        }
        std::fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }

    #[cfg(windows)]
    async fn create_single_deferred_cleanup(
        store: &CodeProStateStore,
    ) -> (CodeProCleanupReport, PathBuf) {
        save_terminal_cleanup_candidate(store, "candidate").await;
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();
        let report = store
            .cleanup_candidates_exact_with_hooks(
                "current",
                policy,
                &expected,
                || {},
                |_| {},
                |_, original_path| {
                    let evidence = original_path.join("run/evidence.bin");
                    let mut permissions = std::fs::metadata(&evidence).unwrap().permissions();
                    permissions.set_readonly(true);
                    std::fs::set_permissions(evidence, permissions).unwrap();
                },
                |_, _| {},
                |_, _| {},
            )
            .await
            .unwrap();
        let transactions = cleanup_transaction_entries(&store.base_dir);
        assert_eq!(transactions.len(), 1);
        clear_readonly_recursively(&transactions[0]);
        (report, transactions[0].clone())
    }

    #[cfg(windows)]
    fn clear_readonly_recursively(path: &std::path::Path) {
        if path.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() {
                clear_readonly_recursively(&entry.unwrap().path());
            }
        }
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    #[tokio::test]
    async fn test_save_load_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let mut reviewer_budget = crate::agents::task_dag::TaskActionBudgetState::for_role(
            CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ComplexChange),
            AgentRole::Reviewer,
        );
        reviewer_budget.turns_consumed = 3;
        reviewer_budget.consecutive_unchanged_effects = 1;
        let state = CodeProRunState {
            run_id: "run-123".to_string(),
            goal: "test".to_string(),
            source_repo: PathBuf::from("/src"),
            worktree_path: PathBuf::from("/work"),
            workspace: None,
            status: CodeProRunStatus::Running,
            pause_reason: None,
            workflow: Some(CodeProWorkflow::Test),
            last_active_run_id: Some("active-run-1".to_string()),
            dag: TaskDAG::new("goal", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: Some(reviewer_budget),
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save(&state).await.unwrap();
        let loaded = store.load("run-123").await.unwrap();
        assert_eq!(loaded.run_id, "run-123");
        assert_eq!(loaded.status, CodeProRunStatus::Running);
        assert_eq!(loaded.workflow, Some(CodeProWorkflow::Test));
        assert_eq!(loaded.last_active_run_id.as_deref(), Some("active-run-1"));
        let restored_budget = loaded.reviewer_action_budget.expect("reviewer budget");
        assert_eq!(restored_budget.turns_consumed, 3);
        assert_eq!(restored_budget.consecutive_unchanged_effects, 1);
    }

    #[tokio::test]
    async fn p2_state_store_entrypoint_commits_and_restores_state_budget_and_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        let target = workspace.path().join("src/value.txt");
        std::fs::write(&target, b"before\n").unwrap();
        let evidence = CodeProEvidence::capture(workspace.path()).await.unwrap();
        evidence.record_before_path("src/value.txt").await.unwrap();
        std::fs::write(&target, b"after\n").unwrap();

        let store = CodeProStateStore::new(tmp.path());
        let mut dag = TaskDAG::new("restore transaction", vec![]);
        dag.budgets.insert("repair".to_string(), 7);
        let state = CodeProRunState {
            run_id: "transaction-entry".to_string(),
            goal: "restore transaction".to_string(),
            source_repo: workspace.path().to_path_buf(),
            worktree_path: workspace.path().to_path_buf(),
            workspace: None,
            status: CodeProRunStatus::Discarded,
            pause_reason: None,
            workflow: Some(CodeProWorkflow::Change),
            last_active_run_id: Some("control-run".to_string()),
            dag,
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: Some("rollback completed".to_string()),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save_without_cleanup(&state).await.unwrap();
        let approval = CheckpointApproval {
            scope: "continue_checkpoint:transaction-entry".to_string(),
            granted_at: chrono::Utc::now() - chrono::Duration::minutes(1),
            expires_at: chrono::Utc::now() + chrono::Duration::minutes(15),
        };
        let checkpoint_id = store
            .commit_resume_authorization_transaction(&state, &evidence, approval, 7)
            .await
            .unwrap();
        assert_eq!(
            store
                .latest_checkpoint_id(&state.run_id)
                .unwrap()
                .as_deref(),
            Some(checkpoint_id.as_str())
        );

        let first = store
            .restore_checkpoint_transaction(
                &state,
                checkpoint_id.clone(),
                workspace.path(),
                String::new(),
                7,
            )
            .unwrap();
        assert!(matches!(first, CheckpointRestoreOutcome::Restored { .. }));
        assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
        let restored = store.load(&state.run_id).await.unwrap();
        assert_eq!(restored.status, CodeProRunStatus::Discarded);
        assert_eq!(restored.dag.budgets["repair"], 7);

        let second = store
            .restore_checkpoint_transaction(
                &state,
                checkpoint_id,
                workspace.path(),
                String::new(),
                7,
            )
            .unwrap();
        assert!(matches!(
            second,
            CheckpointRestoreOutcome::AlreadyRestored { .. }
        ));
    }

    #[tokio::test]
    async fn p2_load_recovers_a_durably_committed_checkpoint_after_prepare_crash() {
        use crate::agents::checkpoint_transaction::{
            CheckpointPrepareRequest, CheckpointWriteStage,
        };

        let tmp = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let state = CodeProRunState {
            run_id: "load-recovers-checkpoint".to_string(),
            goal: "recover committed prepare".to_string(),
            source_repo: workspace.path().to_path_buf(),
            worktree_path: workspace.path().to_path_buf(),
            workspace: None,
            status: CodeProRunStatus::Paused,
            pause_reason: Some(CodeProPauseReason::RecoveryPaused),
            workflow: Some(CodeProWorkflow::Change),
            last_active_run_id: Some("control-run".to_string()),
            dag: TaskDAG::new("recover committed prepare", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: Some("waiting".to_string()),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save_without_cleanup(&state).await.unwrap();
        let checkpoint_id = "checkpoint-r1-e9";
        let crashed = store
            .checkpoint_store(&state.run_id)
            .prepare_and_publish_with_hook(
                CheckpointPrepareRequest {
                    run_id: state.run_id.clone(),
                    checkpoint_id: checkpoint_id.to_string(),
                    workspace: workspace.path().to_path_buf(),
                    state_json: serde_json::to_vec_pretty(&state).unwrap(),
                    budget_json: br#"{}"#.to_vec(),
                    plan_revision: 1,
                    event_sequence: 9,
                    approvals: Vec::new(),
                    required_approval_scope: None,
                    files: Vec::new(),
                },
                |stage| {
                    if stage == CheckpointWriteStage::CommitMarkerWritten {
                        Err("simulated crash")
                    } else {
                        Ok(())
                    }
                },
            );
        assert!(crashed.is_err());
        assert!(store
            .checkpoint_store(&state.run_id)
            .published_checkpoint(&state.run_id, checkpoint_id)
            .is_none());

        let loaded = store.load(&state.run_id).await.unwrap();

        assert_eq!(loaded.status, CodeProRunStatus::Paused);
        assert_eq!(
            store
                .latest_checkpoint_id(&state.run_id)
                .unwrap()
                .as_deref(),
            Some(checkpoint_id)
        );
        assert!(store
            .checkpoint_store(&state.run_id)
            .published_checkpoint(&state.run_id, checkpoint_id)
            .is_some());
    }

    #[tokio::test]
    async fn r4_core5_pause_reason_roundtrips_as_typed_schema_data() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let state = CodeProRunState {
            run_id: "typed-pause".to_string(),
            goal: "resume safely".to_string(),
            source_repo: PathBuf::from("/src"),
            worktree_path: PathBuf::from("/work"),
            workspace: None,
            status: CodeProRunStatus::Paused,
            pause_reason: Some(CodeProPauseReason::RecoveryPaused),
            workflow: Some(CodeProWorkflow::Change),
            last_active_run_id: None,
            dag: TaskDAG::new("resume safely", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };

        store.save_without_cleanup(&state).await.unwrap();
        let stored: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(store.state_path("typed-pause"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(stored["pause_reason"], "recovery_paused");
        assert_eq!(
            store.load("typed-pause").await.unwrap().pause_reason,
            Some(CodeProPauseReason::RecoveryPaused)
        );
    }

    #[tokio::test]
    async fn r4_core5_legacy_paused_state_migrates_to_legacy_unclassified() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let state = CodeProRunState {
            run_id: "legacy-pause".to_string(),
            goal: "old checkpoint".to_string(),
            source_repo: PathBuf::from("/src"),
            worktree_path: PathBuf::from("/work"),
            workspace: None,
            status: CodeProRunStatus::Paused,
            pause_reason: Some(CodeProPauseReason::CheckpointPaused),
            workflow: Some(CodeProWorkflow::Test),
            last_active_run_id: None,
            dag: TaskDAG::new("old checkpoint", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save_without_cleanup(&state).await.unwrap();
        let path = store.state_path("legacy-pause");
        let mut stored: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
        stored.as_object_mut().unwrap().remove("pause_reason");
        tokio::fs::write(&path, serde_json::to_vec_pretty(&stored).unwrap())
            .await
            .unwrap();

        let migrated = store.load("legacy-pause").await.unwrap();

        assert_eq!(migrated.status, CodeProRunStatus::Paused);
        assert_eq!(
            migrated.pause_reason,
            Some(CodeProPauseReason::LegacyUnclassified)
        );
    }

    #[tokio::test]
    async fn saving_the_same_run_twice_replaces_the_previous_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let mut state = CodeProRunState {
            run_id: "run-update".to_string(),
            goal: "test".to_string(),
            source_repo: PathBuf::from("/src"),
            worktree_path: PathBuf::from("/work"),
            workspace: None,
            status: CodeProRunStatus::Planning,
            pause_reason: None,
            workflow: Some(CodeProWorkflow::Change),
            last_active_run_id: None,
            dag: TaskDAG::new("goal", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save(&state).await.unwrap();
        state.status = CodeProRunStatus::Running;
        state.updated_at = chrono::Utc::now();
        store.save(&state).await.unwrap();

        assert_eq!(
            store.load("run-update").await.unwrap().status,
            CodeProRunStatus::Running
        );
    }

    #[tokio::test]
    async fn listing_an_unused_store_returns_an_empty_list() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path().join("not-created"));

        assert!(store.list_incomplete().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn loading_legacy_state_derives_a_conservative_task_kind_and_budget_state() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        for (run_id, workflow, expected) in [
            (
                "legacy-change",
                CodeProWorkflow::Change,
                CodeProTaskKind::ComplexChange,
            ),
            (
                "legacy-test",
                CodeProWorkflow::Test,
                CodeProTaskKind::ProjectTest,
            ),
        ] {
            let state = CodeProRunState {
                run_id: run_id.to_string(),
                goal: "旧任务".to_string(),
                source_repo: PathBuf::from("/src"),
                worktree_path: PathBuf::from("/work"),
                workspace: None,
                status: CodeProRunStatus::Paused,
                pause_reason: Some(CodeProPauseReason::CheckpointPaused),
                workflow: Some(workflow),
                last_active_run_id: None,
                dag: TaskDAG::new("旧任务", vec![]),
                router_config: ModelRouterConfig::default(),
                reviewer_action_budget: None,
                review_result: None,
                final_report: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            };
            store.save(&state).await.unwrap();
            let path = store.state_path(run_id);
            let mut json: serde_json::Value =
                serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
            json["dag"].as_object_mut().unwrap().remove("task_kind");
            json["dag"]
                .as_object_mut()
                .unwrap()
                .remove("action_budget_states");
            tokio::fs::write(&path, serde_json::to_vec_pretty(&json).unwrap())
                .await
                .unwrap();

            let loaded = store.load(run_id).await.unwrap();

            assert_eq!(loaded.dag.task_kind, Some(expected));
            assert!(loaded.dag.action_budget_states.is_empty());
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cleanup_removes_only_old_terminal_runs_and_never_fails_the_current_run() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        for (run_id, status) in [
            ("current", CodeProRunStatus::Running),
            ("finished", CodeProRunStatus::Completed),
            ("paused", CodeProRunStatus::Paused),
        ] {
            let state = CodeProRunState {
                run_id: run_id.to_string(),
                goal: "test".to_string(),
                source_repo: PathBuf::from("/src"),
                worktree_path: PathBuf::from("/work"),
                workspace: None,
                status,
                pause_reason: (status == CodeProRunStatus::Paused)
                    .then_some(CodeProPauseReason::CheckpointPaused),
                workflow: Some(CodeProWorkflow::Test),
                last_active_run_id: None,
                dag: TaskDAG::new("goal", vec![]),
                router_config: ModelRouterConfig::default(),
                reviewer_action_budget: None,
                review_result: None,
                final_report: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            };
            store.save_without_cleanup(&state).await.unwrap();
            tokio::fs::write(store.run_dir(run_id).join("evidence.bin"), vec![0; 64])
                .await
                .unwrap();
        }

        let report = store
            .cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 1,
                    retention: std::time::Duration::ZERO,
                },
            )
            .await
            .unwrap();

        assert_eq!(report.removed_run_ids, vec!["finished"]);
        assert!(report.reclaimed_bytes > 0);
        assert!(report.over_capacity);
        assert!(store.run_dir("current").exists());
        assert!(store.run_dir("paused").exists());
        assert!(!store.run_dir("finished").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_cleanup_rejects_mutation_and_preserves_running_completed_and_paused_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        for (run_id, status) in [
            ("current", CodeProRunStatus::Running),
            ("finished", CodeProRunStatus::Completed),
            ("paused", CodeProRunStatus::Paused),
        ] {
            let state = CodeProRunState {
                run_id: run_id.to_string(),
                goal: "test".to_string(),
                source_repo: PathBuf::from("/src"),
                worktree_path: PathBuf::from("/work"),
                workspace: None,
                status,
                pause_reason: (status == CodeProRunStatus::Paused)
                    .then_some(CodeProPauseReason::CheckpointPaused),
                workflow: Some(CodeProWorkflow::Test),
                last_active_run_id: None,
                dag: TaskDAG::new("goal", vec![]),
                router_config: ModelRouterConfig::default(),
                reviewer_action_budget: None,
                review_result: None,
                final_report: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            };
            store.save_without_cleanup(&state).await.unwrap();
            tokio::fs::write(store.run_dir(run_id).join("evidence.bin"), vec![0; 64])
                .await
                .unwrap();
        }

        let error = store
            .cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 1,
                    retention: std::time::Duration::ZERO,
                },
            )
            .await
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("held-object CodePro cleanup is unavailable"));
        assert!(store.run_dir("current").exists());
        assert!(store.run_dir("paused").exists());
        assert!(store.run_dir("finished").exists());
        for run_id in ["current", "finished", "paused"] {
            assert_eq!(
                tokio::fs::read(store.run_dir(run_id).join("evidence.bin"))
                    .await
                    .unwrap(),
                vec![0; 64]
            );
            assert!(store.load(run_id).await.is_ok());
        }
    }

    #[tokio::test]
    async fn r4_core5_cleanup_rejects_same_fingerprint_directory_replacement_before_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join("runs");
        let store = CodeProStateStore::new(&runs);
        let state = CodeProRunState {
            run_id: "candidate".to_string(),
            goal: "cleanup candidate".to_string(),
            source_repo: PathBuf::from("/src"),
            worktree_path: PathBuf::from("/work"),
            workspace: None,
            status: CodeProRunStatus::Completed,
            pause_reason: None,
            workflow: Some(CodeProWorkflow::Test),
            last_active_run_id: None,
            dag: TaskDAG::new("cleanup candidate", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save_without_cleanup(&state).await.unwrap();
        let evidence = store.run_dir("candidate").join("evidence.bin");
        tokio::fs::write(&evidence, b"same-file-metadata")
            .await
            .unwrap();
        let expected = store
            .preview_cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 1,
                    retention: Duration::ZERO,
                },
            )
            .unwrap();
        assert_eq!(expected.len(), 1);

        let replacement = tmp.path().join("replacement");
        std::fs::create_dir_all(replacement.join("run")).unwrap();
        std::fs::hard_link(
            store.state_path("candidate"),
            replacement.join("run/state.json"),
        )
        .unwrap();
        std::fs::hard_link(&evidence, replacement.join("run/evidence.bin")).unwrap();
        assert_eq!(
            directory_metrics(&runs.join("candidate")).unwrap(),
            directory_metrics(&replacement).unwrap(),
            "the replacement must defeat content-only fingerprint checks"
        );
        let preserved = tmp.path().join("preserved-original");

        let error = store
            .cleanup_candidates_exact_with_hook(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 1,
                    retention: Duration::ZERO,
                },
                &expected,
                || {
                    std::fs::rename(runs.join("candidate"), &preserved).unwrap();
                    std::fs::rename(&replacement, runs.join("candidate")).unwrap();
                },
            )
            .await
            .unwrap_err();

        assert!(matches!(error, CodeProCleanupExactError::StalePreview));
        assert!(runs.join("candidate").is_dir());
        assert!(preserved.is_dir());
    }

    #[tokio::test]
    async fn r4_core5_cleanup_exact_binds_preview_to_the_original_directory_object() {
        let tmp = tempfile::tempdir().unwrap();
        let runs = tmp.path().join("runs");
        let store = CodeProStateStore::new(&runs);
        let state = CodeProRunState {
            run_id: "candidate".to_string(),
            goal: "cleanup candidate".to_string(),
            source_repo: PathBuf::from("/src"),
            worktree_path: PathBuf::from("/work"),
            workspace: None,
            status: CodeProRunStatus::Completed,
            pause_reason: None,
            workflow: Some(CodeProWorkflow::Test),
            last_active_run_id: None,
            dag: TaskDAG::new("cleanup candidate", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        store.save_without_cleanup(&state).await.unwrap();
        let evidence = store.run_dir("candidate").join("evidence.bin");
        tokio::fs::write(&evidence, b"same-file-metadata")
            .await
            .unwrap();
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();

        let replacement = tmp.path().join("replacement");
        std::fs::create_dir_all(replacement.join("run")).unwrap();
        std::fs::hard_link(
            store.state_path("candidate"),
            replacement.join("run/state.json"),
        )
        .unwrap();
        std::fs::hard_link(&evidence, replacement.join("run/evidence.bin")).unwrap();
        assert_eq!(
            directory_metrics(&runs.join("candidate")).unwrap(),
            directory_metrics(&replacement).unwrap()
        );
        let preserved = tmp.path().join("preserved-original");
        std::fs::rename(runs.join("candidate"), &preserved).unwrap();
        std::fs::rename(&replacement, runs.join("candidate")).unwrap();

        let error = store
            .cleanup_candidates_exact("current", policy, &expected)
            .await
            .unwrap_err();

        assert!(matches!(error, CodeProCleanupExactError::StalePreview));
        assert!(runs.join("candidate").is_dir());
        assert!(preserved.is_dir());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_later_open_failure_rolls_back_every_quarantined_candidate() {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        for run_id in ["a-terminal", "b-terminal"] {
            save_terminal_cleanup_candidate(&store, run_id).await;
        }
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();
        let blocked_candidate = std::cell::RefCell::new(None);

        let error = store
            .cleanup_candidates_exact_with_hooks(
                "current",
                policy,
                &expected,
                || {},
                |_| {},
                |index, _| {
                    if index == 0 {
                        let handle = OpenOptions::new()
                            .read(true)
                            .share_mode(FILE_SHARE_READ)
                            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                            .open(store.run_dir("b-terminal"))
                            .unwrap();
                        *blocked_candidate.borrow_mut() = Some(handle);
                    }
                },
                |_, _| {},
                |_, _| {},
            )
            .await
            .unwrap_err();

        drop(blocked_candidate);
        assert!(matches!(error, CodeProCleanupExactError::Persistence(_)));
        assert!(store.run_dir("a-terminal").is_dir());
        assert!(store.run_dir("b-terminal").is_dir());
        assert!(cleanup_transaction_entries(tmp.path()).is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_rollback_collision_preserves_candidate_in_visible_recovery_path() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        for run_id in ["a-terminal", "b-terminal"] {
            save_terminal_cleanup_candidate(&store, run_id).await;
        }
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();

        let error = store
            .cleanup_candidates_exact_with_hooks(
                "current",
                policy,
                &expected,
                || {},
                |_| {},
                |index, _| {
                    if index == 1 {
                        std::fs::create_dir(store.base_dir.join("a-terminal")).unwrap();
                        std::fs::write(store.base_dir.join("a-terminal/external.bin"), b"external")
                            .unwrap();
                        let state_path = store.state_path("b-terminal");
                        let mut state: serde_json::Value =
                            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
                        state["status"] = serde_json::json!("paused");
                        state["pause_reason"] = serde_json::json!("checkpoint_paused");
                        std::fs::write(state_path, serde_json::to_vec_pretty(&state).unwrap())
                            .unwrap();
                    }
                },
                |_, _| {},
                |_, _| {},
            )
            .await
            .unwrap_err();

        assert!(matches!(error, CodeProCleanupExactError::Persistence(_)));
        assert_eq!(
            std::fs::read(store.base_dir.join("a-terminal/external.bin")).unwrap(),
            b"external"
        );
        assert!(store.run_dir("b-terminal").is_dir());
        assert!(cleanup_transaction_entries(tmp.path()).is_empty());
        let recovered = std::fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("a-terminal.codepro-cleanup-recovery-")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            std::fs::read(recovered[0].join("run/evidence.bin")).unwrap(),
            b"evidence-a-terminal"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_final_revalidation_blocks_external_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path().join("runs"));
        save_terminal_cleanup_candidate(&store, "candidate").await;
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();
        let replacement = tmp.path().join("replacement");
        std::fs::create_dir_all(replacement.join("run")).unwrap();
        std::fs::hard_link(
            store.state_path("candidate"),
            replacement.join("run/state.json"),
        )
        .unwrap();
        std::fs::hard_link(
            store.run_dir("candidate").join("evidence.bin"),
            replacement.join("run/evidence.bin"),
        )
        .unwrap();
        let moved_original = tmp.path().join("moved-original");
        let replacement_attempt = std::cell::RefCell::new(None);

        let report = store
            .cleanup_candidates_exact_with_hooks(
                "current",
                policy,
                &expected,
                || {},
                |_| {},
                |_, _| {},
                |index, cleanup_path| {
                    if index == 0 {
                        let result = std::fs::rename(cleanup_path, &moved_original);
                        if result.is_ok() {
                            std::fs::rename(&replacement, cleanup_path).unwrap();
                        }
                        *replacement_attempt.borrow_mut() = Some(result);
                    }
                },
                |_, _| {},
            )
            .await
            .unwrap();

        assert_eq!(report.removed_run_ids, vec!["candidate"]);
        assert!(replacement_attempt.borrow().as_ref().unwrap().is_err());
        assert!(replacement.is_dir());
        assert!(!moved_original.exists());
        assert!(!store.run_dir("candidate").exists());
        assert!(cleanup_transaction_entries(&store.base_dir).is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_post_publish_replacement_is_not_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path().join("runs"));
        save_terminal_cleanup_candidate(&store, "candidate").await;
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();
        let replacement_marker = tmp.path().join("replacement-marker");
        let replacement_receipt = tmp.path().join("replacement-receipt");
        let preserved_marker = tmp.path().join("preserved-marker");
        let preserved_receipt = tmp.path().join("preserved-receipt");
        std::fs::write(&replacement_marker, b"replacement-marker").unwrap();
        std::fs::write(&replacement_receipt, b"replacement-receipt").unwrap();
        let attempts = std::cell::RefCell::new(None);

        let report = store
            .cleanup_candidates_exact_with_hooks(
                "current",
                policy,
                &expected,
                || {},
                |_| {},
                |_, _| {},
                |_, _| {},
                |marker_path, receipt_path| {
                    let marker_result = std::fs::rename(marker_path, &preserved_marker);
                    if marker_result.is_ok() {
                        std::fs::rename(&replacement_marker, marker_path).unwrap();
                    }
                    let receipt_result = std::fs::rename(receipt_path, &preserved_receipt);
                    if receipt_result.is_ok() {
                        std::fs::rename(&replacement_receipt, receipt_path).unwrap();
                    }
                    *attempts.borrow_mut() = Some((
                        marker_result,
                        receipt_result,
                        marker_path.to_path_buf(),
                        receipt_path.to_path_buf(),
                    ));
                },
            )
            .await
            .unwrap();

        assert_eq!(report.removed_run_ids, vec!["candidate"]);
        let attempts = attempts.into_inner().unwrap();
        if attempts.0.is_ok() {
            assert!(preserved_marker.is_file());
            assert!(attempts.2.is_file(), "replacement marker was deleted");
        } else {
            assert!(replacement_marker.is_file());
            assert!(!preserved_marker.exists());
        }
        if attempts.1.is_ok() {
            assert!(preserved_receipt.is_file());
            assert!(attempts.3.is_file(), "replacement receipt was deleted");
        } else {
            assert!(replacement_receipt.is_file());
            assert!(!preserved_receipt.exists());
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_second_physical_failure_is_deferred_after_atomic_logical_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        for run_id in ["a-terminal", "b-terminal"] {
            save_terminal_cleanup_candidate(&store, run_id).await;
        }
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();
        let selected_bytes = expected
            .iter()
            .map(|candidate| candidate.bytes)
            .sum::<u64>();

        let result = store
            .cleanup_candidates_exact_with_hooks(
                "current",
                policy,
                &expected,
                || {},
                |_| {},
                |index, original_path| {
                    if index == 1 {
                        let evidence = original_path.join("run/evidence.bin");
                        let mut permissions = std::fs::metadata(&evidence).unwrap().permissions();
                        permissions.set_readonly(true);
                        std::fs::set_permissions(evidence, permissions).unwrap();
                    }
                },
                |_, _| {},
                |_, _| {},
            )
            .await;
        let report = result.unwrap();

        assert_eq!(report.removed_run_ids, vec!["a-terminal", "b-terminal"]);
        assert_eq!(
            report.deferred_cleanup_run_ids,
            vec!["a-terminal", "b-terminal"]
        );
        assert!(report.reclaimed_bytes > 0);
        assert!(report.reclaimed_bytes < selected_bytes);
        assert!(report.bytes_remaining > 0);
        assert!(!store.run_dir("a-terminal").exists());
        assert!(!store.run_dir("b-terminal").exists());
        let deferred = cleanup_transaction_entries(tmp.path());
        assert_eq!(deferred.len(), 1);
        assert!(!deferred[0].join("a-terminal").exists());
        assert!(deferred[0].join("b-terminal").is_dir());

        clear_readonly_recursively(&deferred[0]);
        let second_cleanup = store.cleanup("current", policy).await.unwrap();
        assert_eq!(second_cleanup.reclaimed_bytes, 0);
        assert_eq!(
            second_cleanup.deferred_cleanup_run_ids,
            vec!["a-terminal", "b-terminal"]
        );
        assert!(deferred[0].join("b-terminal").is_dir());
        assert_eq!(cleanup_transaction_entries(tmp.path()), deferred);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_deferred_receipt_is_outside_delete_scope_and_reports_original_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());

        let (report, transaction) = create_single_deferred_cleanup(&store).await;
        let receipts = cleanup_receipt_entries(tmp.path());

        assert_eq!(report.removed_run_ids, vec!["candidate"]);
        assert_eq!(report.deferred_cleanup_run_ids, vec!["candidate"]);
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].parent(), Some(tmp.path()));
        assert!(!receipts[0].starts_with(&transaction));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_committed_tombstone_ignores_policy_without_auto_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let (_, transaction) = create_single_deferred_cleanup(&store).await;
        save_terminal_cleanup_candidate(&store, "current").await;
        let tombstone_bytes = directory_metrics(&transaction).unwrap().0;
        let current_bytes = directory_metrics(&store.run_dir("current")).unwrap().0;
        let expected_bytes = tombstone_bytes.saturating_add(current_bytes);
        assert!(tombstone_bytes > 0);
        assert!(expected_bytes > 1);

        let report = store
            .cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: expected_bytes - 1,
                    retention: Duration::from_secs(365 * 24 * 60 * 60),
                },
            )
            .await
            .unwrap();

        assert_eq!(report.reclaimed_bytes, 0);
        assert_eq!(report.deferred_cleanup_run_ids, vec!["candidate"]);
        assert_eq!(report.bytes_remaining, expected_bytes);
        assert!(report.over_capacity);
        assert!(transaction.is_dir());
        assert_eq!(cleanup_receipt_entries(tmp.path()).len(), 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_forged_receipt_never_reauthorizes_transaction_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let (_, transaction) = create_single_deferred_cleanup(&store).await;
        let preserved = tmp.path().join("preserved-transaction");
        std::fs::rename(&transaction, &preserved).unwrap();
        copy_tree_with_hard_links(&preserved, &transaction);
        rewrite_cleanup_receipt_for_current_objects(tmp.path(), &transaction);

        let report = store
            .cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 1,
                    retention: Duration::ZERO,
                },
            )
            .await
            .unwrap();

        assert_eq!(report.reclaimed_bytes, 0);
        assert_eq!(report.deferred_cleanup_run_ids, vec!["candidate"]);
        assert!(transaction.is_dir());
        assert!(transaction.join("candidate").is_dir());
        assert!(preserved.is_dir());
        assert_eq!(cleanup_receipt_entries(tmp.path()).len(), 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_forged_receipt_never_reauthorizes_child_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let (_, transaction) = create_single_deferred_cleanup(&store).await;
        let candidate = transaction.join("candidate");
        let preserved = tmp.path().join("preserved-candidate");
        std::fs::rename(&candidate, &preserved).unwrap();
        copy_tree_with_hard_links(&preserved, &candidate);
        rewrite_cleanup_receipt_for_current_objects(tmp.path(), &transaction);

        let report = store
            .cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: u64::MAX,
                    retention: Duration::from_secs(365 * 24 * 60 * 60),
                },
            )
            .await
            .unwrap();

        assert_eq!(report.reclaimed_bytes, 0);
        assert_eq!(report.deferred_cleanup_run_ids, vec!["candidate"]);
        assert!(candidate.is_dir());
        assert!(preserved.is_dir());
        assert_eq!(cleanup_receipt_entries(tmp.path()).len(), 1);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_missing_receipt_keeps_committed_tombstone_manual() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let (_, transaction) = create_single_deferred_cleanup(&store).await;
        for receipt in cleanup_receipt_entries(tmp.path()) {
            std::fs::remove_file(receipt).unwrap();
        }

        let report = store
            .cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 1,
                    retention: Duration::ZERO,
                },
            )
            .await
            .unwrap();

        assert_eq!(report.reclaimed_bytes, 0);
        assert_eq!(report.deferred_cleanup_run_ids, vec!["candidate"]);
        assert!(transaction.is_dir());
        assert!(transaction.join("candidate").is_dir());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_corrupt_receipt_keeps_committed_tombstone_manual() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let (_, transaction) = create_single_deferred_cleanup(&store).await;
        let receipt = cleanup_receipt_entries(tmp.path()).pop().unwrap();
        std::fs::write(&receipt, b"{truncated").unwrap();

        let report = store
            .cleanup(
                "current",
                CodeProCleanupPolicy {
                    max_total_bytes: 1,
                    retention: Duration::ZERO,
                },
            )
            .await
            .unwrap();

        assert_eq!(report.reclaimed_bytes, 0);
        assert_eq!(report.deferred_cleanup_run_ids, vec!["candidate"]);
        assert!(transaction.join("candidate").is_dir());
        assert_eq!(std::fs::read(receipt).unwrap(), b"{truncated");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_uncommitted_recovery_collision_stays_in_transaction() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let external = store.run_dir("z-collision");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join("external.bin"), b"external").unwrap();
        let pending = tmp
            .path()
            .join(format!("{CLEANUP_PENDING_PREFIX}{}", uuid::Uuid::new_v4()));
        for run_id in ["a-free", "z-collision"] {
            let held_candidate = pending.join(run_id);
            std::fs::create_dir_all(&held_candidate).unwrap();
            std::fs::write(held_candidate.join("original.bin"), run_id.as_bytes()).unwrap();
        }

        let result = store
            .cleanup("current", CodeProCleanupPolicy::default())
            .await;

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(external.join("external.bin")).unwrap(),
            b"external"
        );
        assert!(!store.run_dir("a-free").exists());
        let transactions = cleanup_transaction_entries(tmp.path());
        assert_eq!(transactions.len(), 1);
        assert_eq!(
            std::fs::read(transactions[0].join("a-free/original.bin")).unwrap(),
            b"a-free"
        );
        assert_eq!(
            std::fs::read(transactions[0].join("z-collision/original.bin")).unwrap(),
            b"z-collision"
        );
        assert!(std::fs::read_dir(tmp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(CLEANUP_RECOVERY_MARKER)
        }));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_pending_commit_race_has_zero_restores() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        let pending_name = format!("{CLEANUP_PENDING_PREFIX}{}", uuid::Uuid::new_v4());
        let pending = tmp.path().join(&pending_name);
        std::fs::create_dir_all(pending.join("candidate")).unwrap();
        std::fs::write(pending.join("candidate/original.bin"), b"original").unwrap();
        let receipt_path = cleanup_receipt_path(tmp.path(), &pending_name).unwrap();

        let result = recover_pending_cleanup_transactions_with_hook(
            tmp.path(),
            |transaction_path, transaction_name| {
                assert_eq!(transaction_name, pending_name);
                std::fs::write(transaction_path.join(CLEANUP_COMMIT_MARKER), b"committed").unwrap();
                std::fs::write(
                    cleanup_receipt_path(tmp.path(), transaction_name).unwrap(),
                    b"diagnostic",
                )
                .unwrap();
            },
        );

        assert!(result.is_err());
        assert!(!store.run_dir("candidate").exists());
        let transactions = cleanup_transaction_entries(tmp.path());
        assert_eq!(transactions.len(), 1);
        assert!(transactions[0].join("candidate/original.bin").is_file());
        assert!(transactions[0].join(CLEANUP_COMMIT_MARKER).is_file());
        assert!(receipt_path.is_file());
    }

    #[test]
    fn r4_core5_cleanup_test_hooks_are_cfg_test_only() {
        let source = include_str!("codepro_state_store.rs");
        for signature in [
            "async fn cleanup_candidates_exact_with_hook",
            "async fn cleanup_candidates_exact_with_hooks",
            "fn cleanup_candidates_exact_with_hooks_locked",
            "fn apply_cleanup_plan_with_hooks",
            "fn recover_pending_cleanup_transactions_with_hook",
        ] {
            let offset = source.find(signature).unwrap();
            let prefix = &source[offset.saturating_sub(80)..offset];
            assert!(
                prefix.contains("#[cfg(test)]"),
                "{signature} must not be compiled into production"
            );
        }
        let production_start = source
            .find("pub async fn cleanup_candidates_exact(")
            .unwrap();
        let production_signature = &source
            [production_start..production_start + source[production_start..].find('{').unwrap()];
        assert!(!production_signature.contains("FnMut"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn r4_core5_cleanup_paused_interleaving_has_zero_deletions_across_the_plan() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(tmp.path());
        for run_id in ["a-terminal", "z-becomes-paused"] {
            let state = CodeProRunState {
                run_id: run_id.to_string(),
                goal: "cleanup candidate".to_string(),
                source_repo: PathBuf::from("/src"),
                worktree_path: PathBuf::from("/work"),
                workspace: None,
                status: CodeProRunStatus::Completed,
                pause_reason: None,
                workflow: Some(CodeProWorkflow::Test),
                last_active_run_id: None,
                dag: TaskDAG::new("cleanup candidate", vec![]),
                router_config: ModelRouterConfig::default(),
                reviewer_action_budget: None,
                review_result: None,
                final_report: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            };
            store.save_without_cleanup(&state).await.unwrap();
            tokio::fs::write(store.run_dir(run_id).join("evidence.bin"), b"candidate")
                .await
                .unwrap();
        }
        let policy = CodeProCleanupPolicy {
            max_total_bytes: 1,
            retention: Duration::ZERO,
        };
        let expected = store.preview_cleanup("current", policy).unwrap();
        assert_eq!(
            expected
                .iter()
                .map(|candidate| candidate.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a-terminal", "z-becomes-paused"]
        );

        let error = store
            .cleanup_candidates_exact_with_hooks(
                "current",
                policy,
                &expected,
                || {},
                |_| {},
                |index, _| {
                    if index == 1 {
                        let state_path = store.state_path("z-becomes-paused");
                        let mut state: serde_json::Value =
                            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
                        state["status"] = serde_json::json!("paused");
                        state["pause_reason"] = serde_json::json!("checkpoint_paused");
                        std::fs::write(state_path, serde_json::to_vec_pretty(&state).unwrap())
                            .unwrap();
                    }
                },
                |_, _| {},
                |_, _| {},
            )
            .await
            .unwrap_err();

        assert!(matches!(error, CodeProCleanupExactError::StalePreview));
        assert!(store.run_dir("a-terminal").exists());
        assert!(store.run_dir("z-becomes-paused").exists());
    }
}
