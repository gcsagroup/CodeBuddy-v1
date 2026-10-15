use super::inventory::StorageInventory;
use super::policy::{LOG_RETENTION, RUN_RETENTION, RUN_SOFT_BUDGET};
use crate::agents::codepro_state_store::{
    CodeProCleanupCandidate as RunCleanupCandidate, CodeProCleanupExactError, CodeProCleanupPolicy,
    CodeProStateStore,
};
use crate::agents::tool_audit::{
    ToolAuditCleanupCandidate, ToolAuditCleanupError, ToolAuditPolicy, ToolAuditStore,
};
use crate::agents::tool_idempotency::{
    ToolIdempotencyCleanupCandidate, ToolIdempotencyCleanupError, ToolIdempotencyPolicy,
    ToolIdempotencyStore,
};
use crate::config::codebuddy_paths::CodeBuddyPaths;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageCleanupCategory {
    ExpiredTerminalRuns,
    ExpiredCompletedAudit,
    ExpiredCompletedIdempotency,
    ExpiredLogs,
    RebuildableBackendCache,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageCleanupRequest {
    pub categories: BTreeSet<StorageCleanupCategory>,
    pub current_run_id: Option<String>,
}

impl StorageCleanupRequest {
    pub fn automatic(current_run_id: Option<String>) -> Self {
        Self {
            categories: [
                StorageCleanupCategory::ExpiredTerminalRuns,
                StorageCleanupCategory::ExpiredCompletedAudit,
                StorageCleanupCategory::ExpiredLogs,
                StorageCleanupCategory::RebuildableBackendCache,
            ]
            .into_iter()
            .collect(),
            current_run_id,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct StorageCleanupPolicy {
    pub run_retention: Duration,
    pub run_soft_budget_bytes: u64,
    pub log_retention: Duration,
    pub completed_audit_retention: Duration,
}

impl Default for StorageCleanupPolicy {
    fn default() -> Self {
        Self {
            run_retention: RUN_RETENTION,
            run_soft_budget_bytes: RUN_SOFT_BUDGET,
            log_retention: LOG_RETENTION,
            completed_audit_retention: Duration::from_secs(30 * 24 * 60 * 60),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageCleanupCandidate {
    pub category: StorageCleanupCategory,
    pub relative_path: PathBuf,
    pub bytes: u64,
    fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageCleanupPreview {
    pub request: StorageCleanupRequest,
    pub digest: String,
    pub candidates: Vec<StorageCleanupCandidate>,
    pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageCleanupReport {
    pub categories: BTreeSet<StorageCleanupCategory>,
    pub removed: Vec<PathBuf>,
    pub reclaimed_bytes: u64,
    pub skipped_protected: Vec<PathBuf>,
    pub partial_failures: Vec<PathBuf>,
    pub bytes_remaining: u64,
    pub over_capacity: bool,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StorageCleanupError {
    #[error("cleanup preview is stale")]
    StalePreview,
    #[error("storage cleanup failed: {0}")]
    Persistence(String),
}

#[derive(Debug, Clone)]
pub struct StorageCleanupService {
    paths: CodeBuddyPaths,
    policy: StorageCleanupPolicy,
}

impl StorageCleanupService {
    pub fn new(paths: CodeBuddyPaths) -> Self {
        Self::with_policy(paths, StorageCleanupPolicy::default())
    }

    pub fn with_policy(paths: CodeBuddyPaths, policy: StorageCleanupPolicy) -> Self {
        Self { paths, policy }
    }

    pub async fn preview(
        &self,
        request: StorageCleanupRequest,
    ) -> Result<StorageCleanupPreview, StorageCleanupError> {
        let mut candidates = Vec::new();
        if request
            .categories
            .contains(&StorageCleanupCategory::ExpiredTerminalRuns)
        {
            let store = CodeProStateStore::new(self.paths.runs_dir());
            let current = request.current_run_id.as_deref().unwrap_or("");
            let runs = store
                .preview_cleanup(
                    current,
                    CodeProCleanupPolicy {
                        max_total_bytes: self.policy.run_soft_budget_bytes,
                        retention: self.policy.run_retention,
                    },
                )
                .map_err(persistence)?;
            for run in runs {
                let relative_path = PathBuf::from("profiles/local/runs").join(&run.run_id);
                candidates.push(StorageCleanupCandidate {
                    category: StorageCleanupCategory::ExpiredTerminalRuns,
                    fingerprint: run.fingerprint_sha256,
                    relative_path,
                    bytes: run.bytes,
                });
            }
        }
        if request
            .categories
            .contains(&StorageCleanupCategory::ExpiredCompletedAudit)
        {
            let store = ToolAuditStore::with_policy(
                self.paths.audit_dir(),
                ToolAuditPolicy {
                    completed_retention: self.policy.completed_audit_retention,
                    ..ToolAuditPolicy::default()
                },
            );
            for record in store
                .preview_completed_cleanup()
                .await
                .map_err(persistence)?
            {
                candidates.push(StorageCleanupCandidate {
                    category: StorageCleanupCategory::ExpiredCompletedAudit,
                    relative_path: PathBuf::from("profiles/local/audit/tool-audit-v2")
                        .join(&record.session_digest)
                        .join(&record.audit_id),
                    bytes: record.bytes,
                    fingerprint: record.fingerprint_sha256,
                });
            }
        }
        if request
            .categories
            .contains(&StorageCleanupCategory::ExpiredCompletedIdempotency)
        {
            let store = ToolIdempotencyStore::with_policy(
                self.paths.audit_dir().join("tool-idempotency-v1"),
                ToolIdempotencyPolicy {
                    completed_retention: self.policy.completed_audit_retention,
                    ..ToolIdempotencyPolicy::default()
                },
            );
            for record in store
                .preview_completed_cleanup()
                .await
                .map_err(persistence)?
            {
                candidates.push(StorageCleanupCandidate {
                    category: StorageCleanupCategory::ExpiredCompletedIdempotency,
                    relative_path: PathBuf::from("profiles/local/audit/tool-idempotency-v1")
                        .join(&record.scope_digest)
                        .join(&record.request_key),
                    bytes: record.bytes,
                    fingerprint: record.fingerprint_sha256,
                });
            }
        }
        if request
            .categories
            .contains(&StorageCleanupCategory::ExpiredLogs)
        {
            candidates.extend(self.collect_files(
                &self.paths.logs_dir(),
                StorageCleanupCategory::ExpiredLogs,
                Some(self.policy.log_retention),
            )?);
        }
        if request
            .categories
            .contains(&StorageCleanupCategory::RebuildableBackendCache)
        {
            for root in [
                self.paths.profile_cache_dir().join("mcp"),
                self.paths.profile_cache_dir().join("models"),
            ] {
                candidates.extend(self.collect_files(
                    &root,
                    StorageCleanupCategory::RebuildableBackendCache,
                    None,
                )?);
            }
        }
        candidates.sort_by(|left, right| {
            (left.category, &left.relative_path).cmp(&(right.category, &right.relative_path))
        });
        let reclaimable_bytes = candidates
            .iter()
            .fold(0_u64, |total, item| total.saturating_add(item.bytes));
        let digest = preview_digest(&request, &candidates)?;
        Ok(StorageCleanupPreview {
            request,
            digest,
            candidates,
            reclaimable_bytes,
        })
    }

    pub async fn execute(
        &self,
        request: StorageCleanupRequest,
        expected_digest: &str,
    ) -> Result<StorageCleanupReport, StorageCleanupError> {
        let started_at = Utc::now();
        let preview = self.preview(request.clone()).await?;
        if preview.digest != expected_digest {
            return Err(StorageCleanupError::StalePreview);
        }
        let run_candidates = run_candidates(&preview.candidates)?;
        let audit_candidates = audit_candidates(&preview.candidates)?;
        let idempotency_candidates = idempotency_candidates(&preview.candidates)?;
        let run_policy = CodeProCleanupPolicy {
            max_total_bytes: self.policy.run_soft_budget_bytes,
            retention: self.policy.run_retention,
        };
        let current_run_id = request.current_run_id.as_deref().unwrap_or("");
        let run_store = CodeProStateStore::new(self.paths.runs_dir());
        let audit_store = ToolAuditStore::with_policy(
            self.paths.audit_dir(),
            ToolAuditPolicy {
                completed_retention: self.policy.completed_audit_retention,
                ..ToolAuditPolicy::default()
            },
        );
        let idempotency_store = ToolIdempotencyStore::with_policy(
            self.paths.audit_dir().join("tool-idempotency-v1"),
            ToolIdempotencyPolicy {
                completed_retention: self.policy.completed_audit_retention,
                ..ToolIdempotencyPolicy::default()
            },
        );
        if !run_store
            .validate_cleanup_candidates_exact(current_run_id, run_policy, &run_candidates)
            .map_err(persistence)?
        {
            return Err(StorageCleanupError::StalePreview);
        }
        if audit_store
            .preview_completed_cleanup()
            .await
            .map_err(persistence)?
            != audit_candidates
        {
            return Err(StorageCleanupError::StalePreview);
        }
        if idempotency_store
            .preview_completed_cleanup()
            .await
            .map_err(persistence)?
            != idempotency_candidates
        {
            return Err(StorageCleanupError::StalePreview);
        }
        for candidate in preview
            .candidates
            .iter()
            .filter(|candidate| is_generic_file_category(candidate.category))
        {
            let absolute = self.paths.home_dir().join(&candidate.relative_path);
            match verify_candidate(&absolute, candidate) {
                Ok(true) => {}
                Ok(false) | Err(_) => return Err(StorageCleanupError::StalePreview),
            }
        }
        let mut report = StorageCleanupReport {
            categories: request.categories.clone(),
            removed: Vec::new(),
            reclaimed_bytes: 0,
            skipped_protected: Vec::new(),
            partial_failures: Vec::new(),
            bytes_remaining: 0,
            over_capacity: false,
            started_at,
            completed_at: started_at,
        };

        if request
            .categories
            .contains(&StorageCleanupCategory::ExpiredTerminalRuns)
        {
            let run_report = run_store
                .cleanup_candidates_exact(current_run_id, run_policy, &run_candidates)
                .await
                .map_err(|error| match error {
                    CodeProCleanupExactError::StalePreview => StorageCleanupError::StalePreview,
                    CodeProCleanupExactError::Persistence(message) => {
                        StorageCleanupError::Persistence(message)
                    }
                })?;
            report.reclaimed_bytes = report
                .reclaimed_bytes
                .saturating_add(run_report.reclaimed_bytes);
            report.bytes_remaining = run_report.bytes_remaining;
            report.over_capacity = run_report.over_capacity;
            report.removed.extend(
                run_report
                    .removed_run_ids
                    .into_iter()
                    .map(|id| PathBuf::from("profiles/local/runs").join(id)),
            );
        }

        if request
            .categories
            .contains(&StorageCleanupCategory::ExpiredCompletedAudit)
        {
            let cleanup = audit_store
                .cleanup_completed_exact(&audit_candidates)
                .await
                .map_err(|error| match error {
                    ToolAuditCleanupError::StalePreview => StorageCleanupError::StalePreview,
                    ToolAuditCleanupError::Store(error) => persistence(error),
                })?;
            report.reclaimed_bytes = report
                .reclaimed_bytes
                .saturating_add(cleanup.reclaimed_bytes);
            report
                .removed
                .extend(audit_candidates.iter().map(|candidate| {
                    PathBuf::from("profiles/local/audit/tool-audit-v2")
                        .join(&candidate.session_digest)
                        .join(&candidate.audit_id)
                }));
        }

        if request
            .categories
            .contains(&StorageCleanupCategory::ExpiredCompletedIdempotency)
        {
            let cleanup = idempotency_store
                .cleanup_completed_exact(&idempotency_candidates)
                .await
                .map_err(|error| match error {
                    ToolIdempotencyCleanupError::StalePreview => StorageCleanupError::StalePreview,
                    ToolIdempotencyCleanupError::Store(error) => persistence(error),
                })?;
            report.reclaimed_bytes = report
                .reclaimed_bytes
                .saturating_add(cleanup.reclaimed_bytes);
            report
                .removed
                .extend(idempotency_candidates.iter().map(|candidate| {
                    PathBuf::from("profiles/local/audit/tool-idempotency-v1")
                        .join(&candidate.scope_digest)
                        .join(&candidate.request_key)
                }));
        }

        for candidate in preview
            .candidates
            .into_iter()
            .filter(|candidate| is_generic_file_category(candidate.category))
        {
            let absolute = self.paths.home_dir().join(&candidate.relative_path);
            match verify_candidate(&absolute, &candidate) {
                Ok(true) => match fs::remove_file(&absolute) {
                    Ok(()) => {
                        report.reclaimed_bytes =
                            report.reclaimed_bytes.saturating_add(candidate.bytes);
                        report.removed.push(candidate.relative_path);
                    }
                    Err(_) => report.partial_failures.push(candidate.relative_path),
                },
                Ok(false) => report.skipped_protected.push(candidate.relative_path),
                Err(_) => report.partial_failures.push(candidate.relative_path),
            }
        }
        report.bytes_remaining = StorageInventory::default()
            .inspect(&self.paths)
            .map_err(persistence)?
            .total_bytes;
        report.completed_at = Utc::now();
        Ok(report)
    }

    fn collect_files(
        &self,
        root: &Path,
        category: StorageCleanupCategory,
        retention: Option<Duration>,
    ) -> Result<Vec<StorageCleanupCandidate>, StorageCleanupError> {
        let mut candidates = Vec::new();
        let metadata = match fs::symlink_metadata(root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidates),
            Err(error) => return Err(persistence(error)),
        };
        if !metadata.is_dir() || is_link_or_reparse_point(&metadata) {
            return Ok(candidates);
        }
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            let entries = fs::read_dir(&directory).map_err(persistence)?;
            for entry in entries {
                let entry = entry.map_err(persistence)?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(persistence)?;
                if is_link_or_reparse_point(&metadata) {
                    continue;
                }
                if metadata.is_dir() {
                    pending.push(path);
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                if retention.is_some_and(|retention| !older_than(&metadata, retention)) {
                    continue;
                }
                let relative_path = path
                    .strip_prefix(self.paths.home_dir())
                    .map_err(|_| {
                        StorageCleanupError::Persistence("path escaped storage root".into())
                    })?
                    .to_path_buf();
                candidates.push(StorageCleanupCandidate {
                    category,
                    relative_path,
                    bytes: metadata.len(),
                    fingerprint: metadata_fingerprint(&metadata),
                });
            }
        }
        Ok(candidates)
    }
}

fn preview_digest(
    request: &StorageCleanupRequest,
    candidates: &[StorageCleanupCandidate],
) -> Result<String, StorageCleanupError> {
    let encoded = serde_json::to_vec(&(request, candidates)).map_err(persistence)?;
    Ok(hex_digest(&Sha256::digest(encoded)))
}

fn run_candidates(
    candidates: &[StorageCleanupCandidate],
) -> Result<Vec<RunCleanupCandidate>, StorageCleanupError> {
    let prefix = Path::new("profiles/local/runs");
    let mut runs = Vec::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.category == StorageCleanupCategory::ExpiredTerminalRuns)
    {
        let relative = candidate
            .relative_path
            .strip_prefix(prefix)
            .map_err(|_| StorageCleanupError::Persistence("invalid run candidate path".into()))?;
        if relative.components().count() != 1 {
            return Err(StorageCleanupError::Persistence(
                "invalid run candidate depth".into(),
            ));
        }
        runs.push(RunCleanupCandidate {
            run_id: relative.to_string_lossy().to_string(),
            bytes: candidate.bytes,
            fingerprint_sha256: candidate.fingerprint.clone(),
        });
    }
    runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
    Ok(runs)
}

fn audit_candidates(
    candidates: &[StorageCleanupCandidate],
) -> Result<Vec<ToolAuditCleanupCandidate>, StorageCleanupError> {
    let prefix = Path::new("profiles/local/audit/tool-audit-v2");
    let mut records = Vec::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.category == StorageCleanupCategory::ExpiredCompletedAudit)
    {
        let components = candidate
            .relative_path
            .strip_prefix(prefix)
            .map_err(|_| StorageCleanupError::Persistence("invalid audit candidate path".into()))?
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        if components.len() != 2 {
            return Err(StorageCleanupError::Persistence(
                "invalid audit candidate depth".into(),
            ));
        }
        records.push(ToolAuditCleanupCandidate {
            session_digest: components[0].clone(),
            audit_id: components[1].clone(),
            bytes: candidate.bytes,
            fingerprint_sha256: candidate.fingerprint.clone(),
        });
    }
    records.sort_by(|left, right| {
        (&left.session_digest, &left.audit_id).cmp(&(&right.session_digest, &right.audit_id))
    });
    Ok(records)
}

fn idempotency_candidates(
    candidates: &[StorageCleanupCandidate],
) -> Result<Vec<ToolIdempotencyCleanupCandidate>, StorageCleanupError> {
    let prefix = Path::new("profiles/local/audit/tool-idempotency-v1");
    let mut records = Vec::new();
    for candidate in candidates.iter().filter(|candidate| {
        candidate.category == StorageCleanupCategory::ExpiredCompletedIdempotency
    }) {
        let components = candidate
            .relative_path
            .strip_prefix(prefix)
            .map_err(|_| {
                StorageCleanupError::Persistence("invalid idempotency candidate path".into())
            })?
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        if components.len() != 2 {
            return Err(StorageCleanupError::Persistence(
                "invalid idempotency candidate depth".into(),
            ));
        }
        records.push(ToolIdempotencyCleanupCandidate {
            scope_digest: components[0].clone(),
            request_key: components[1].clone(),
            bytes: candidate.bytes,
            fingerprint_sha256: candidate.fingerprint.clone(),
        });
    }
    records.sort_by(|left, right| {
        (&left.scope_digest, &left.request_key).cmp(&(&right.scope_digest, &right.request_key))
    });
    Ok(records)
}

fn is_generic_file_category(category: StorageCleanupCategory) -> bool {
    matches!(
        category,
        StorageCleanupCategory::ExpiredLogs | StorageCleanupCategory::RebuildableBackendCache
    )
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

fn verify_candidate(
    path: &Path,
    candidate: &StorageCleanupCandidate,
) -> Result<bool, std::io::Error> {
    let metadata = fs::symlink_metadata(path)?;
    Ok(metadata.is_file()
        && !is_link_or_reparse_point(&metadata)
        && metadata.len() == candidate.bytes
        && metadata_fingerprint(&metadata) == candidate.fingerprint)
}

fn metadata_fingerprint(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}:{modified}", metadata.len())
}

fn older_than(metadata: &fs::Metadata, retention: Duration) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age >= retention)
}

fn persistence(error: impl std::fmt::Display) -> StorageCleanupError {
    StorageCleanupError::Persistence(error.to_string())
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}
