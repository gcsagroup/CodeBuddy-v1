use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
use crate::agents::protocol::{RunId, TaskId};
use crate::agents::tool_idempotency::bounded_argument_digest;
use crate::agents::tool_security::ToolExtensionSource;
use crate::config::permission::CodeProTaskScope;
use crate::permission::failure_semantics::CodeProFailureKind;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use uuid::Uuid;

const AUDIT_SCHEMA_VERSION: u32 = 2;
const AUDIT_DIRECTORY: &str = "tool-audit-v2";
const AUDIT_LOCATION_INDEX: &str = "tool-audit-locations-v1.json";
const MAX_LOCATION_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_AUDIT_RECORD_BYTES: u64 = 16 * 1024;
const DEFAULT_MAX_RECORDS_PER_SESSION: usize = 4_096;
const DEFAULT_COMPLETED_RETENTION: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Copy)]
pub(crate) struct ToolAuditPolicy {
    pub max_records_per_session: usize,
    pub completed_retention: std::time::Duration,
}

impl Default for ToolAuditPolicy {
    fn default() -> Self {
        Self {
            max_records_per_session: DEFAULT_MAX_RECORDS_PER_SESSION,
            completed_retention: DEFAULT_COMPLETED_RETENTION,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolAuditCleanupCandidate {
    pub session_digest: String,
    pub audit_id: String,
    pub bytes: u64,
    pub fingerprint_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnfinishedToolAudit {
    pub audit_id: String,
    pub task_id: TaskId,
    pub request_digest: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ToolAuditCleanupReport {
    pub removed_records: usize,
    pub reclaimed_bytes: u64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ToolAuditCleanupError {
    #[error("audit cleanup preview is stale")]
    StalePreview,
    #[error("audit cleanup failed: {0}")]
    Store(#[from] ToolAuditError),
}

#[derive(Debug, Clone)]
pub(crate) struct ToolAuditInput {
    pub session_id: String,
    pub request_id: String,
    pub task_scope: Option<CodeProTaskScope>,
    pub tool_name: QualifiedToolName,
    pub arguments: Map<String, Value>,
    pub actor: ToolAuditActor,
    pub effective_model: EffectiveModel,
    pub extension_source: ToolAuditExtensionSource,
    pub permission_class: ToolAuditPermissionClass,
    pub authorization: ToolAuditAuthorization,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolAuditActor {
    Primary,
    CodeproPlanner,
    CodeproCoder,
    CodeproTester,
    CodeproReviewer,
    HostUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct EffectiveModel(String);

impl EffectiveModel {
    pub(crate) fn new(value: impl Into<String>) -> Result<Self, ToolAuditError> {
        let value = value.into();
        Self::is_valid_value(&value)
            .then_some(Self(value))
            .ok_or(ToolAuditError::InvalidInput)
    }

    fn is_valid(&self) -> bool {
        Self::is_valid_value(&self.0)
    }

    fn is_valid_value(value: &str) -> bool {
        if value == "unknown" {
            return true;
        }
        if value.len() > 512 {
            return false;
        }
        let Some((provider, model)) = value.split_once('/') else {
            return false;
        };
        is_safe_metadata_component(provider)
            && !model.is_empty()
            && model.split('/').all(is_safe_model_component)
    }
}

fn is_safe_model_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct QualifiedToolName(String);

impl QualifiedToolName {
    pub(crate) fn new(value: impl Into<String>) -> Result<Self, ToolAuditError> {
        let value = value.into();
        Self::is_valid_value(&value)
            .then_some(Self(value))
            .ok_or(ToolAuditError::InvalidInput)
    }

    fn is_valid(&self) -> bool {
        Self::is_valid_value(&self.0)
    }

    fn is_valid_value(value: &str) -> bool {
        let Some((owner, tool)) = value.split_once("::") else {
            return false;
        };
        !tool.contains("::")
            && is_safe_metadata_component(owner)
            && is_safe_metadata_component(tool)
    }
}

fn is_safe_metadata_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolAuditExtensionSource {
    Platform,
    Builtin,
    ExternalStdio,
    ExternalHttp,
    Frontend,
    InlinePython,
    Unknown,
}

impl From<ToolExtensionSource> for ToolAuditExtensionSource {
    fn from(source: ToolExtensionSource) -> Self {
        match source {
            ToolExtensionSource::Platform => Self::Platform,
            ToolExtensionSource::Builtin => Self::Builtin,
            ToolExtensionSource::ExternalStdio => Self::ExternalStdio,
            ToolExtensionSource::ExternalHttp => Self::ExternalHttp,
            ToolExtensionSource::Frontend => Self::Frontend,
            ToolExtensionSource::InlinePython => Self::InlinePython,
            ToolExtensionSource::Unknown => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolAuditPermissionClass {
    ReadOnly,
    WorkspaceWrite,
    ExternalWrite,
    HighRisk,
    Forbidden,
    Legacy,
}

impl From<CodeProPermissionClass> for ToolAuditPermissionClass {
    fn from(permission: CodeProPermissionClass) -> Self {
        match permission {
            CodeProPermissionClass::ReadOnly => Self::ReadOnly,
            CodeProPermissionClass::WorkspaceWrite => Self::WorkspaceWrite,
            CodeProPermissionClass::ExternalWrite => Self::ExternalWrite,
            CodeProPermissionClass::HighRisk => Self::HighRisk,
            CodeProPermissionClass::Forbidden => Self::Forbidden,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolAuditAuthorization {
    PolicyAllowed,
    UserConfirmed,
    PolicyDenied,
    UserDenied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolAuditOutcome {
    Success,
    ToolError,
    Cancelled,
    TimedOut,
    ReplaySuppressed,
    Ambiguous,
    PolicyDenied,
    UserDenied,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolAuditError {
    InvalidInput,
    CorruptJournal,
    Persistence,
    Capacity,
    IdentityConflict,
}

impl fmt::Display for ToolAuditError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "invalid host audit identity",
            Self::CorruptJournal => "tool audit journal is invalid",
            Self::Persistence => "tool audit journal could not be persisted",
            Self::Capacity => "tool audit journal capacity is exhausted",
            Self::IdentityConflict => "tool audit record identity conflict",
        })
    }
}

impl std::error::Error for ToolAuditError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct AuditRecordCore {
    schema_version: u32,
    audit_id: String,
    session_digest: String,
    request_digest: String,
    task_scope_digest: Option<String>,
    actor: ToolAuditActor,
    effective_model: EffectiveModel,
    extension_source: ToolAuditExtensionSource,
    tool_name: QualifiedToolName,
    permission_class: ToolAuditPermissionClass,
    argument_digest: String,
    authorization: ToolAuditAuthorization,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StartedAuditRecord {
    #[serde(flatten)]
    core: AuditRecordCore,
    started_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CompletedAuditRecord {
    #[serde(flatten)]
    core: AuditRecordCore,
    completed_at: chrono::DateTime<chrono::Utc>,
    duration_ms: u64,
    outcome: ToolAuditOutcome,
    failure_kind: Option<CodeProFailureKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolAuditReceipt {
    pub(crate) schema_version: u32,
    pub(crate) audit_id: String,
    pub(crate) actor: ToolAuditActor,
    pub(crate) effective_model: String,
    pub(crate) extension_source: ToolAuditExtensionSource,
    pub(crate) tool_name: String,
    pub(crate) permission_class: ToolAuditPermissionClass,
    pub(crate) authorization: ToolAuditAuthorization,
    pub(crate) outcome: ToolAuditOutcome,
    pub(crate) failure_kind: Option<CodeProFailureKind>,
    pub(crate) task_scoped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) task_scope_digest: Option<String>,
    pub(crate) started_at: chrono::DateTime<chrono::Utc>,
    pub(crate) completed_at: chrono::DateTime<chrono::Utc>,
    pub(crate) duration_ms: u64,
}

impl ToolAuditReceipt {
    fn from_completed(started: &StartedAuditRecord, completed: &CompletedAuditRecord) -> Self {
        Self {
            schema_version: completed.core.schema_version,
            audit_id: completed.core.audit_id.clone(),
            actor: completed.core.actor,
            effective_model: completed.core.effective_model.0.clone(),
            extension_source: completed.core.extension_source,
            tool_name: completed.core.tool_name.0.clone(),
            permission_class: completed.core.permission_class,
            authorization: completed.core.authorization,
            outcome: completed.outcome,
            failure_kind: completed.failure_kind,
            task_scoped: completed.core.task_scope_digest.is_some(),
            task_scope_digest: completed.core.task_scope_digest.clone(),
            started_at: started.started_at,
            completed_at: completed.completed_at,
            duration_ms: completed.duration_ms,
        }
    }
}

#[cfg(test)]
impl CompletedAuditRecord {
    fn orphan_for_test() -> Self {
        Self {
            core: AuditRecordCore {
                schema_version: AUDIT_SCHEMA_VERSION,
                audit_id: Uuid::now_v7().to_string(),
                session_digest: digest_parts(&[b"orphan-session"]),
                request_digest: digest_parts(&[b"orphan-request"]),
                task_scope_digest: None,
                actor: ToolAuditActor::HostUnknown,
                effective_model: EffectiveModel::new("unknown").unwrap(),
                extension_source: ToolAuditExtensionSource::Unknown,
                tool_name: QualifiedToolName::new("unknown::tool").unwrap(),
                permission_class: ToolAuditPermissionClass::Legacy,
                argument_digest: digest_parts(&[b"orphan-arguments"]),
                authorization: ToolAuditAuthorization::PolicyDenied,
            },
            completed_at: chrono::Utc::now(),
            duration_ms: 0,
            outcome: ToolAuditOutcome::PolicyDenied,
            failure_kind: Some(CodeProFailureKind::PolicyDenied),
        }
    }
}

pub(crate) struct ToolAuditClaim {
    started_path: PathBuf,
    completed_path: PathBuf,
    started: StartedAuditRecord,
}

pub(crate) struct ToolAuditStore {
    base_dir: PathBuf,
    io_lock: Mutex<()>,
    policy: ToolAuditPolicy,
}

impl ToolAuditStore {
    pub(crate) fn new(base_dir: PathBuf) -> Self {
        Self::with_policy(base_dir, ToolAuditPolicy::default())
    }

    pub(crate) fn with_policy(base_dir: PathBuf, policy: ToolAuditPolicy) -> Self {
        Self {
            base_dir,
            io_lock: Mutex::new(()),
            policy,
        }
    }

    /// Authenticate a reference to an existing receipt without creating a new
    /// action. File-version metadata remains owned by the original session.
    pub(crate) async fn verify_completed_receipt(
        &self,
        session_id: &str,
        request_id: &str,
        scope: &CodeProTaskScope,
        arguments: &Map<String, Value>,
        receipt: &ToolAuditReceipt,
    ) -> Result<(), ToolAuditError> {
        Uuid::parse_str(&receipt.audit_id).map_err(|_| ToolAuditError::InvalidInput)?;
        let session_digest = digest_parts(&[session_id.as_bytes()]);
        let session_dir = self.base_dir.join(AUDIT_DIRECTORY).join(&session_digest);
        let _guard = self.io_lock.lock().await;
        let _session_lock = acquire_session_lock(&session_dir).await?;
        let started =
            read_started_record(&session_dir.join(format!("{}.started.json", receipt.audit_id)))
                .await?;
        let completed = read_completed_record(
            &session_dir.join(format!("{}.completed.json", receipt.audit_id)),
        )
        .await?;
        validate_started_record(&started, &receipt.audit_id)?;
        validate_completed_record(&completed, &started, &receipt.audit_id)?;
        let argument_digest =
            bounded_argument_digest(arguments).map_err(|_| ToolAuditError::InvalidInput)?;
        if started.core.session_digest != session_digest
            || started.core.request_digest != digest_parts(&[request_id.as_bytes()])
            || started.core.task_scope_digest.as_deref() != Some(task_scope_digest(scope).as_str())
            || started.core.argument_digest != argument_digest
            || ToolAuditReceipt::from_completed(&started, &completed) != *receipt
        {
            return Err(ToolAuditError::IdentityConflict);
        }
        Ok(())
    }

    /// Read the existing started/completed audit pairs; this is not a second
    /// action store. A started record without its terminal pair is an unknown
    /// effect until the original request is reconciled.
    pub(crate) async fn unfinished_for_run(
        &self,
        run_id: &RunId,
        task_ids: &[TaskId],
    ) -> Result<Vec<UnfinishedToolAudit>, ToolAuditError> {
        let started_at = std::time::Instant::now();
        let tasks = task_ids
            .iter()
            .map(|task_id| {
                (
                    digest_parts(&[
                        run_id.as_str().as_bytes(),
                        b"\0",
                        task_id.as_str().as_bytes(),
                    ]),
                    task_id.clone(),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        let audit_root = self.base_dir.join(AUDIT_DIRECTORY);
        if tasks.is_empty() || !audit_root.exists() {
            return Ok(Vec::new());
        }
        // Batch filesystem operations on a bounded blocking pool. Per-record
        // tokio::fs calls previously required tens of thousands of scheduler hops.
        // Keep all sessions and validation: a child-session orphan must still block.
        ensure_directory_durable(&audit_root.join(".locks")).await?;
        let index_path = self.base_dir.join(AUDIT_LOCATION_INDEX);
        let (
            unfinished,
            session_count,
            pair_count,
            max_lock_ms,
            max_read_ms,
            discovered_pair_count,
            indexed_session_count,
        ) = tokio::task::spawn_blocking(move || {
            use rayon::prelude::*;
            let previous_index = load_location_index(&index_path);
            let scopes = tasks
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            // One bounded pool is shared across concurrent completion checks.
            // Records remain validated under the same per-session lock.
            static SCAN_POOL: std::sync::LazyLock<
                Result<rayon::ThreadPool, rayon::ThreadPoolBuildError>,
            > = std::sync::LazyLock::new(|| {
                rayon::ThreadPoolBuilder::new()
                    .num_threads(4)
                    .thread_name(|index| format!("codepro-audit-{index}"))
                    .build()
            });
            let pool = SCAN_POOL
                .as_ref()
                .map_err(|_| ToolAuditError::Persistence)?;
            let paths = std::fs::read_dir(&audit_root)
                .map_err(|_| ToolAuditError::Persistence)?
                .map(|entry| {
                    entry
                        .map(|entry| entry.path())
                        .map_err(|_| ToolAuditError::Persistence)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let scans = pool.install(|| {
                paths
                    .into_par_iter()
                    .map(|path| {
                        let metadata = std::fs::symlink_metadata(&path)
                            .map_err(|_| ToolAuditError::Persistence)?;
                        if is_link_or_reparse_point(&metadata) || !metadata.is_dir() {
                            return Ok(None);
                        }
                        let name = path
                            .file_name()
                            .ok_or(ToolAuditError::Persistence)?
                            .to_string_lossy();
                        if name == ".tmp" || name == ".locks" {
                            return Ok(None);
                        }
                        validate_digest(&name)?;
                        let lock_started = std::time::Instant::now();
                        let _session_lock = acquire_session_lock_blocking(&path)?;
                        let lock_ms = lock_started.elapsed().as_millis() as u64;
                        let read_started = std::time::Instant::now();
                        let indexed = read_indexed_session(
                            &path,
                            previous_index.get(name.as_ref()).cloned(),
                            &scopes,
                        )?;
                        let pairs = indexed.pairs;
                        let read_ms = read_started.elapsed().as_millis() as u64;
                        let pair_count = pairs.len();
                        let unfinished = pairs
                            .into_iter()
                            .filter_map(|pair| {
                                if pair.completed.is_some() {
                                    return None;
                                }
                                let started = pair.started;
                                let task_id = started
                                    .core
                                    .task_scope_digest
                                    .as_ref()
                                    .and_then(|digest| tasks.get(digest))?;
                                Some(UnfinishedToolAudit {
                                    audit_id: started.core.audit_id,
                                    task_id: task_id.clone(),
                                    request_digest: started.core.request_digest,
                                    tool_name: started.core.tool_name.0,
                                })
                            })
                            .collect::<Vec<_>>();
                        Ok::<_, ToolAuditError>(Some((
                            unfinished,
                            pair_count,
                            lock_ms,
                            read_ms,
                            name.into_owned(),
                            indexed.location_index,
                            indexed.discovered_pairs,
                            indexed.skipped_unrelated,
                        )))
                    })
                    .collect::<Result<Vec<_>, _>>()
            })?;
            let mut unfinished = Vec::new();
            let (mut session_count, mut pair_count, mut max_lock_ms, mut max_read_ms) =
                (0, 0, 0, 0);
            let mut next_index = std::collections::BTreeMap::new();
            let (mut discovered_pair_count, mut indexed_session_count) = (0, 0);
            for (pending, count, lock_ms, read_ms, name, index, discovered, skipped) in
                scans.into_iter().flatten()
            {
                if let Some(index) = index {
                    next_index.insert(name, index);
                }
                discovered_pair_count += discovered;
                indexed_session_count += usize::from(skipped);
                session_count += 1;
                pair_count += count;
                max_lock_ms = max_lock_ms.max(lock_ms);
                max_read_ms = max_read_ms.max(read_ms);
                unfinished.extend(pending);
            }
            if save_location_index(&index_path, next_index).is_err() {
                tracing::warn!(
                    "Tool audit location index could not be saved; future scans may rebuild it"
                );
            }
            unfinished.sort_unstable_by(|left, right| left.audit_id.cmp(&right.audit_id));
            Ok::<_, ToolAuditError>((
                unfinished,
                session_count,
                pair_count,
                max_lock_ms,
                max_read_ms,
                discovered_pair_count,
                indexed_session_count,
            ))
        })
        .await
        .map_err(|_| ToolAuditError::Persistence)??;
        tracing::info!(
            run_id = %run_id,
            session_count,
            pair_count,
            max_lock_ms,
            max_read_ms,
            discovered_pair_count,
            indexed_session_count,
            unfinished_count = unfinished.len(),
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "CodePro tool audit completion scan finished"
        );
        Ok(unfinished)
    }

    pub(crate) async fn begin(
        &self,
        input: ToolAuditInput,
    ) -> Result<ToolAuditClaim, ToolAuditError> {
        validate_input(&input)?;
        let argument_digest =
            bounded_argument_digest(&input.arguments).map_err(|_| ToolAuditError::InvalidInput)?;
        let session_digest = digest_parts(&[input.session_id.as_bytes()]);
        let request_digest = digest_parts(&[input.request_id.as_bytes()]);
        let task_scope_digest = input.task_scope.as_ref().map(task_scope_digest);
        let session_dir = self.base_dir.join(AUDIT_DIRECTORY).join(&session_digest);
        let audit_id = Uuid::now_v7().to_string();
        let started_path = session_dir.join(format!("{audit_id}.started.json"));
        let completed_path = session_dir.join(format!("{audit_id}.completed.json"));
        let _guard = self.io_lock.lock().await;
        ensure_directory_durable(&self.base_dir).await?;
        ensure_directory_durable(&self.base_dir.join(AUDIT_DIRECTORY)).await?;
        ensure_directory_durable(&session_dir).await?;
        let _session_lock = acquire_session_lock(&session_dir).await?;
        self.enforce_capacity(&session_dir).await?;

        let started = StartedAuditRecord {
            core: AuditRecordCore {
                schema_version: AUDIT_SCHEMA_VERSION,
                audit_id,
                session_digest,
                request_digest,
                task_scope_digest,
                actor: input.actor,
                effective_model: input.effective_model,
                extension_source: input.extension_source,
                tool_name: input.tool_name,
                permission_class: input.permission_class,
                argument_digest,
                authorization: input.authorization,
            },
            started_at: chrono::Utc::now(),
        };
        write_record_once(&started_path, &started).await?;

        Ok(ToolAuditClaim {
            started_path,
            completed_path,
            started,
        })
    }

    #[cfg(test)]
    pub(crate) async fn complete(
        &self,
        claim: &ToolAuditClaim,
        outcome: ToolAuditOutcome,
    ) -> Result<(), ToolAuditError> {
        self.complete_with_receipt(claim, outcome).await.map(|_| ())
    }

    pub(crate) async fn complete_with_receipt(
        &self,
        claim: &ToolAuditClaim,
        outcome: ToolAuditOutcome,
    ) -> Result<ToolAuditReceipt, ToolAuditError> {
        let failure_kind = default_failure_kind(
            claim.started.core.authorization,
            claim.started.core.permission_class,
            outcome,
        );
        self.complete_with_failure_receipt(claim, outcome, failure_kind)
            .await
    }

    pub(crate) async fn complete_with_failure_receipt(
        &self,
        claim: &ToolAuditClaim,
        outcome: ToolAuditOutcome,
        failure_kind: Option<CodeProFailureKind>,
    ) -> Result<ToolAuditReceipt, ToolAuditError> {
        validate_failure_contract(
            claim.started.core.authorization,
            claim.started.core.permission_class,
            outcome,
            failure_kind,
        )
        .map_err(|_| ToolAuditError::InvalidInput)?;
        let _guard = self.io_lock.lock().await;
        let session_dir = claim
            .started_path
            .parent()
            .ok_or(ToolAuditError::Persistence)?;
        let _session_lock = acquire_session_lock(session_dir).await?;
        let started = read_started_record(&claim.started_path).await?;
        validate_started_record(&started, &claim.started.core.audit_id)?;
        if started.core != claim.started.core || started.started_at != claim.started.started_at {
            return Err(ToolAuditError::IdentityConflict);
        }
        let completed_at = chrono::Utc::now();
        let duration_ms = u64::try_from(
            completed_at
                .signed_duration_since(started.started_at)
                .num_milliseconds(),
        )
        .unwrap_or(0);
        let completed = CompletedAuditRecord {
            core: started.core.clone(),
            completed_at,
            duration_ms,
            outcome,
            failure_kind,
        };
        if claim.completed_path.exists() {
            let existing = read_completed_record(&claim.completed_path).await?;
            validate_completed_record(&existing, &started, &claim.started.core.audit_id)?;
            return (existing.outcome == outcome && existing.failure_kind == failure_kind)
                .then(|| ToolAuditReceipt::from_completed(&started, &existing))
                .ok_or(ToolAuditError::IdentityConflict);
        }
        write_record_once(&claim.completed_path, &completed).await?;
        let persisted = read_completed_record(&claim.completed_path).await?;
        validate_completed_record(&persisted, &started, &claim.started.core.audit_id)?;
        Ok(ToolAuditReceipt::from_completed(&started, &persisted))
    }

    #[cfg(test)]
    pub(crate) async fn record_denied(&self, input: ToolAuditInput) -> Result<(), ToolAuditError> {
        self.record_denied_with_receipt(input).await.map(|_| ())
    }

    pub(crate) async fn record_denied_with_receipt(
        &self,
        input: ToolAuditInput,
    ) -> Result<ToolAuditReceipt, ToolAuditError> {
        let outcome = match input.authorization {
            ToolAuditAuthorization::PolicyDenied => ToolAuditOutcome::PolicyDenied,
            ToolAuditAuthorization::UserDenied => ToolAuditOutcome::UserDenied,
            _ => return Err(ToolAuditError::InvalidInput),
        };
        let failure_kind =
            default_failure_kind(input.authorization, input.permission_class, outcome);
        let claim = self.begin(input).await?;
        self.complete_with_failure_receipt(&claim, outcome, failure_kind)
            .await
    }

    pub(crate) async fn preview_completed_cleanup(
        &self,
    ) -> Result<Vec<ToolAuditCleanupCandidate>, ToolAuditError> {
        let _guard = self.io_lock.lock().await;
        self.completed_cleanup_candidates().await
    }

    pub(crate) async fn cleanup_completed_exact(
        &self,
        expected: &[ToolAuditCleanupCandidate],
    ) -> Result<ToolAuditCleanupReport, ToolAuditCleanupError> {
        let _guard = self.io_lock.lock().await;
        let current = self.completed_cleanup_candidates().await?;
        if current != expected {
            return Err(ToolAuditCleanupError::StalePreview);
        }
        let audit_root = self.base_dir.join(AUDIT_DIRECTORY);
        let mut report = ToolAuditCleanupReport::default();
        for candidate in current {
            let session_dir = audit_root.join(&candidate.session_digest);
            let _session_lock = acquire_session_lock(&session_dir).await?;
            let completed = session_dir.join(format!("{}.completed.json", candidate.audit_id));
            let started = session_dir.join(format!("{}.started.json", candidate.audit_id));
            tokio::fs::remove_file(&completed)
                .await
                .map_err(|_| ToolAuditError::Persistence)?;
            sync_directory(&session_dir).await?;
            tokio::fs::remove_file(&started)
                .await
                .map_err(|_| ToolAuditError::Persistence)?;
            sync_directory(&session_dir).await?;
            report.removed_records = report.removed_records.saturating_add(1);
            report.reclaimed_bytes = report.reclaimed_bytes.saturating_add(candidate.bytes);
        }
        Ok(report)
    }

    async fn completed_cleanup_candidates(
        &self,
    ) -> Result<Vec<ToolAuditCleanupCandidate>, ToolAuditError> {
        let audit_root = self.base_dir.join(AUDIT_DIRECTORY);
        if !audit_root.exists() {
            return Ok(Vec::new());
        }
        let mut sessions = tokio::fs::read_dir(&audit_root)
            .await
            .map_err(|_| ToolAuditError::Persistence)?;
        let now = chrono::Utc::now();
        let mut candidates = Vec::new();
        while let Some(entry) = sessions
            .next_entry()
            .await
            .map_err(|_| ToolAuditError::Persistence)?
        {
            let metadata = tokio::fs::symlink_metadata(entry.path())
                .await
                .map_err(|_| ToolAuditError::Persistence)?;
            if is_link_or_reparse_point(&metadata) || !metadata.is_dir() {
                continue;
            }
            let session_digest = entry.file_name().to_string_lossy().to_string();
            if session_digest == ".tmp" || session_digest == ".locks" {
                continue;
            }
            validate_digest(&session_digest)?;
            for pair in read_session_pairs(&entry.path()).await? {
                let Some(completed) = pair.completed else {
                    continue;
                };
                let expired = now
                    .signed_duration_since(completed.completed_at)
                    .to_std()
                    .is_ok_and(|age| age >= self.policy.completed_retention);
                if !expired {
                    continue;
                }
                let started_bytes = tokio::fs::read(&pair.started_path)
                    .await
                    .map_err(|_| ToolAuditError::Persistence)?;
                let completed_bytes = tokio::fs::read(&pair.completed_path)
                    .await
                    .map_err(|_| ToolAuditError::Persistence)?;
                let mut hasher = Sha256::new();
                hasher.update(&started_bytes);
                hasher.update([0]);
                hasher.update(&completed_bytes);
                let digest = hasher.finalize();
                candidates.push(ToolAuditCleanupCandidate {
                    session_digest: session_digest.clone(),
                    audit_id: completed.core.audit_id,
                    bytes: u64::try_from(started_bytes.len().saturating_add(completed_bytes.len()))
                        .unwrap_or(u64::MAX),
                    fingerprint_sha256: encode_sha256(&digest),
                });
            }
        }
        candidates.sort_by(|left, right| {
            (&left.session_digest, &left.audit_id).cmp(&(&right.session_digest, &right.audit_id))
        });
        Ok(candidates)
    }

    async fn enforce_capacity(&self, session_dir: &Path) -> Result<(), ToolAuditError> {
        let pairs = read_session_pairs(session_dir).await?;
        let now = chrono::Utc::now();
        let mut retained = 0usize;
        for pair in pairs {
            if let Some(completed) = pair.completed {
                let expired = now
                    .signed_duration_since(completed.completed_at)
                    .to_std()
                    .is_ok_and(|age| age >= self.policy.completed_retention);
                if expired {
                    tokio::fs::remove_file(pair.completed_path)
                        .await
                        .map_err(|_| ToolAuditError::Persistence)?;
                    sync_directory(session_dir).await?;
                    tokio::fs::remove_file(pair.started_path)
                        .await
                        .map_err(|_| ToolAuditError::Persistence)?;
                    sync_directory(session_dir).await?;
                    continue;
                }
            }
            retained = retained.saturating_add(1);
        }
        if self.policy.max_records_per_session == 0
            || retained >= self.policy.max_records_per_session
        {
            return Err(ToolAuditError::Capacity);
        }
        Ok(())
    }
}

fn encode_sha256(bytes: &[u8]) -> String {
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

struct AuditRecordPair {
    started_path: PathBuf,
    completed_path: PathBuf,
    started: StartedAuditRecord,
    completed: Option<CompletedAuditRecord>,
}

// Locations only, never outcomes. Membership is derived from validated records;
// a directory manifest change invalidates it even when an older binary wrote it.
#[derive(Clone, Serialize, Deserialize)]
struct SessionAuditLocations {
    manifest_digest: String,
    task_scopes: std::collections::BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
struct AuditLocationIndex {
    schema_version: u32,
    sessions: std::collections::BTreeMap<String, SessionAuditLocations>,
    checksum: String,
}

fn load_location_index(path: &Path) -> std::collections::BTreeMap<String, SessionAuditLocations> {
    let load = || -> Option<AuditLocationIndex> {
        let metadata = std::fs::symlink_metadata(path).ok()?;
        if is_link_or_reparse_point(&metadata)
            || !metadata.is_file()
            || metadata.len() > MAX_LOCATION_INDEX_BYTES
        {
            return None;
        }
        let index: AuditLocationIndex = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        if index.schema_version != 1
            || digest_parts(&[&serde_json::to_vec(&index.sessions).ok()?]) != index.checksum
            || index.sessions.iter().any(|(session, locations)| {
                validate_digest(session).is_err()
                    || validate_digest(&locations.manifest_digest).is_err()
                    || locations
                        .task_scopes
                        .iter()
                        .any(|scope| validate_digest(scope).is_err())
            })
        {
            return None;
        }
        Some(index)
    };
    load().map(|index| index.sessions).unwrap_or_default()
}

fn save_location_index(
    path: &Path,
    sessions: std::collections::BTreeMap<String, SessionAuditLocations>,
) -> Result<(), ToolAuditError> {
    use std::io::Write;
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if is_link_or_reparse_point(&metadata) || !metadata.is_file() {
            return Err(ToolAuditError::Persistence);
        }
    }
    let checksum =
        digest_parts(&[&serde_json::to_vec(&sessions).map_err(|_| ToolAuditError::Persistence)?]);
    let bytes = serde_json::to_vec(&AuditLocationIndex {
        schema_version: 1,
        sessions,
        checksum,
    })
    .map_err(|_| ToolAuditError::Persistence)?;
    if bytes.len() as u64 > MAX_LOCATION_INDEX_BYTES {
        return Err(ToolAuditError::Persistence);
    }
    let parent = path.parent().ok_or(ToolAuditError::Persistence)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".tool-audit-locations-")
        .tempfile_in(parent)
        .map_err(|_| ToolAuditError::Persistence)?;
    temporary
        .write_all(&bytes)
        .map_err(|_| ToolAuditError::Persistence)?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| ToolAuditError::Persistence)?;
    temporary
        .persist(path)
        .map_err(|_| ToolAuditError::Persistence)?;
    sync_directory_blocking(parent)
}

fn validate_input(input: &ToolAuditInput) -> Result<(), ToolAuditError> {
    for value in [&input.session_id, &input.request_id] {
        validate_bounded_text(value)?;
    }
    if !input.effective_model.is_valid() || !input.tool_name.is_valid() {
        return Err(ToolAuditError::InvalidInput);
    }
    Ok(())
}

fn validate_bounded_text(value: &str) -> Result<(), ToolAuditError> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(ToolAuditError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn task_scope_digest(scope: &CodeProTaskScope) -> String {
    digest_parts(&[scope.run_id().as_bytes(), b"\0", scope.task_id().as_bytes()])
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().to_hex().to_string()
}

fn validate_digest(value: &str) -> Result<(), ToolAuditError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(ToolAuditError::CorruptJournal)
    }
}

fn validate_started_record(
    record: &StartedAuditRecord,
    audit_id: &str,
) -> Result<(), ToolAuditError> {
    validate_record_core(&record.core, audit_id)
}

fn validate_completed_record(
    completed: &CompletedAuditRecord,
    started: &StartedAuditRecord,
    audit_id: &str,
) -> Result<(), ToolAuditError> {
    validate_record_core(&completed.core, audit_id)?;
    if completed.core != started.core
        || completed.completed_at < started.started_at
        || completed.duration_ms
            != u64::try_from(
                completed
                    .completed_at
                    .signed_duration_since(started.started_at)
                    .num_milliseconds(),
            )
            .unwrap_or(0)
    {
        return Err(ToolAuditError::CorruptJournal);
    }
    validate_failure_contract(
        completed.core.authorization,
        completed.core.permission_class,
        completed.outcome,
        completed.failure_kind,
    )?;
    Ok(())
}

fn default_failure_kind(
    authorization: ToolAuditAuthorization,
    permission_class: ToolAuditPermissionClass,
    outcome: ToolAuditOutcome,
) -> Option<CodeProFailureKind> {
    match outcome {
        ToolAuditOutcome::PolicyDenied
            if permission_class == ToolAuditPermissionClass::Forbidden =>
        {
            Some(CodeProFailureKind::Forbidden)
        }
        ToolAuditOutcome::PolicyDenied => Some(CodeProFailureKind::PolicyDenied),
        ToolAuditOutcome::UserDenied => Some(CodeProFailureKind::UserDenied),
        ToolAuditOutcome::Cancelled => Some(CodeProFailureKind::Cancelled),
        _ => {
            let _ = authorization;
            None
        }
    }
}

fn validate_failure_contract(
    authorization: ToolAuditAuthorization,
    permission_class: ToolAuditPermissionClass,
    outcome: ToolAuditOutcome,
    failure_kind: Option<CodeProFailureKind>,
) -> Result<(), ToolAuditError> {
    let valid = match outcome {
        ToolAuditOutcome::PolicyDenied => {
            authorization == ToolAuditAuthorization::PolicyDenied
                && match permission_class {
                    ToolAuditPermissionClass::Forbidden => {
                        failure_kind == Some(CodeProFailureKind::Forbidden)
                    }
                    _ => failure_kind == Some(CodeProFailureKind::PolicyDenied),
                }
        }
        ToolAuditOutcome::UserDenied => {
            authorization == ToolAuditAuthorization::UserDenied
                && failure_kind == Some(CodeProFailureKind::UserDenied)
        }
        ToolAuditOutcome::Cancelled => {
            matches!(
                authorization,
                ToolAuditAuthorization::PolicyAllowed | ToolAuditAuthorization::UserConfirmed
            ) && failure_kind == Some(CodeProFailureKind::Cancelled)
        }
        ToolAuditOutcome::ToolError => {
            matches!(
                authorization,
                ToolAuditAuthorization::PolicyAllowed | ToolAuditAuthorization::UserConfirmed
            ) && matches!(
                failure_kind,
                None | Some(CodeProFailureKind::OutsideWorkspace)
                    | Some(CodeProFailureKind::EnvironmentFailure)
            )
        }
        ToolAuditOutcome::Success
        | ToolAuditOutcome::TimedOut
        | ToolAuditOutcome::ReplaySuppressed
        | ToolAuditOutcome::Ambiguous => {
            matches!(
                authorization,
                ToolAuditAuthorization::PolicyAllowed | ToolAuditAuthorization::UserConfirmed
            ) && failure_kind.is_none()
        }
    };
    if valid {
        Ok(())
    } else {
        Err(ToolAuditError::CorruptJournal)
    }
}

fn validate_record_core(core: &AuditRecordCore, audit_id: &str) -> Result<(), ToolAuditError> {
    if core.schema_version != AUDIT_SCHEMA_VERSION
        || core.audit_id != audit_id
        || Uuid::parse_str(&core.audit_id).is_err()
    {
        return Err(ToolAuditError::CorruptJournal);
    }
    for digest in [
        &core.session_digest,
        &core.request_digest,
        &core.argument_digest,
    ] {
        validate_digest(digest)?;
    }
    if let Some(digest) = &core.task_scope_digest {
        validate_digest(digest)?;
    }
    if !core.effective_model.is_valid() || !core.tool_name.is_valid() {
        return Err(ToolAuditError::CorruptJournal);
    }
    Ok(())
}

async fn read_session_pairs(session_dir: &Path) -> Result<Vec<AuditRecordPair>, ToolAuditError> {
    let session_dir = session_dir.to_path_buf();
    // A session contains many small immutable receipts. Keep the existing
    // caller-held session lock and validation, but avoid a blocking-pool round
    // trip for every metadata lookup and file read.
    tokio::task::spawn_blocking(move || read_session_pairs_blocking(&session_dir))
        .await
        .map_err(|_| ToolAuditError::Persistence)?
}

fn read_session_pairs_blocking(session_dir: &Path) -> Result<Vec<AuditRecordPair>, ToolAuditError> {
    read_listed_session_pairs(session_dir, list_session_files(session_dir)?)
}

struct SessionAuditFiles {
    started: std::collections::BTreeMap<String, PathBuf>,
    completed: std::collections::BTreeMap<String, PathBuf>,
    manifest_digest: Option<String>,
}

struct IndexedSessionRead {
    pairs: Vec<AuditRecordPair>,
    location_index: Option<SessionAuditLocations>,
    discovered_pairs: usize,
    skipped_unrelated: bool,
}

fn read_indexed_session(
    session_dir: &Path,
    cached: Option<SessionAuditLocations>,
    scopes: &std::collections::BTreeSet<String>,
) -> Result<IndexedSessionRead, ToolAuditError> {
    let files = list_session_files(session_dir)?;
    let discovered_pairs = files.started.len();
    if let Some(cached) = cached.filter(|cached| {
        files.manifest_digest.as_ref() == Some(&cached.manifest_digest)
            && cached.task_scopes.is_disjoint(scopes)
    }) {
        return Ok(IndexedSessionRead {
            pairs: Vec::new(),
            location_index: Some(cached),
            discovered_pairs,
            skipped_unrelated: true,
        });
    }
    let manifest_digest = files.manifest_digest.clone();
    let pairs = read_listed_session_pairs(session_dir, files)?;
    let location_index = manifest_digest.map(|manifest_digest| SessionAuditLocations {
        manifest_digest,
        task_scopes: pairs
            .iter()
            .filter_map(|pair| pair.started.core.task_scope_digest.clone())
            .collect(),
    });
    Ok(IndexedSessionRead {
        pairs,
        location_index,
        discovered_pairs,
        skipped_unrelated: false,
    })
}

fn list_session_files(session_dir: &Path) -> Result<SessionAuditFiles, ToolAuditError> {
    let entries = std::fs::read_dir(session_dir).map_err(|_| ToolAuditError::Persistence)?;
    let mut started = std::collections::BTreeMap::new();
    let mut completed = std::collections::BTreeMap::new();
    let mut manifest = std::collections::BTreeMap::new();
    let mut can_index = true;
    for entry in entries {
        let entry = entry.map_err(|_| ToolAuditError::Persistence)?;
        let path = entry.path();
        // DirEntry metadata does not follow links. On Windows it also reuses
        // enumeration metadata instead of issuing a separate lookup per file.
        let metadata = entry.metadata().map_err(|_| ToolAuditError::Persistence)?;
        if is_link_or_reparse_point(&metadata) || !metadata.is_file() {
            return Err(ToolAuditError::CorruptJournal);
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(ToolAuditError::CorruptJournal);
        };
        match metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        {
            Some(modified) => {
                manifest.insert(name.to_owned(), (metadata.len(), modified.as_nanos()));
            }
            None => can_index = false,
        }
        if let Some(audit_id) = name.strip_suffix(".started.json") {
            if Uuid::parse_str(audit_id).is_err()
                || started.insert(audit_id.to_owned(), path).is_some()
            {
                return Err(ToolAuditError::CorruptJournal);
            }
        } else if let Some(audit_id) = name.strip_suffix(".completed.json") {
            if Uuid::parse_str(audit_id).is_err()
                || completed.insert(audit_id.to_owned(), path).is_some()
            {
                return Err(ToolAuditError::CorruptJournal);
            }
        } else {
            return Err(ToolAuditError::CorruptJournal);
        }
    }
    // Still reject orphan completions on cache hits; filenames alone never
    // establish that an action finished.
    if completed.keys().any(|id| !started.contains_key(id)) {
        return Err(ToolAuditError::CorruptJournal);
    }
    let manifest_digest = if can_index {
        Some(digest_parts(&[
            &serde_json::to_vec(&manifest).map_err(|_| ToolAuditError::Persistence)?
        ]))
    } else {
        None
    };
    Ok(SessionAuditFiles {
        started,
        completed,
        manifest_digest,
    })
}

fn read_listed_session_pairs(
    session_dir: &Path,
    files: SessionAuditFiles,
) -> Result<Vec<AuditRecordPair>, ToolAuditError> {
    let SessionAuditFiles {
        started,
        mut completed,
        ..
    } = files;
    let mut pairs = Vec::with_capacity(started.len());
    for (audit_id, started_path) in started {
        let record = read_record_blocking::<StartedAuditRecord>(&started_path)?;
        validate_started_record(&record, &audit_id)?;
        let completed = if let Some(completed_path) = completed.remove(&audit_id) {
            let completed = read_record_blocking::<CompletedAuditRecord>(&completed_path)?;
            validate_completed_record(&completed, &record, &audit_id)?;
            Some(completed)
        } else {
            None
        };
        pairs.push(AuditRecordPair {
            started_path,
            completed_path: session_dir.join(format!("{audit_id}.completed.json")),
            started: record,
            completed,
        });
    }
    if !completed.is_empty() {
        return Err(ToolAuditError::CorruptJournal);
    }
    Ok(pairs)
}

async fn read_started_record(path: &Path) -> Result<StartedAuditRecord, ToolAuditError> {
    read_record(path).await
}

async fn read_completed_record(path: &Path) -> Result<CompletedAuditRecord, ToolAuditError> {
    read_record(path).await
}

async fn read_record<T: for<'de> Deserialize<'de> + Send + 'static>(
    path: &Path,
) -> Result<T, ToolAuditError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || read_record_blocking(&path))
        .await
        .map_err(|_| ToolAuditError::Persistence)?
}

fn read_record_blocking<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, ToolAuditError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ToolAuditError::Persistence)?;
    if is_link_or_reparse_point(&metadata)
        || !metadata.is_file()
        || metadata.len() > MAX_AUDIT_RECORD_BYTES
    {
        return Err(ToolAuditError::CorruptJournal);
    }
    let bytes = std::fs::read(path).map_err(|_| ToolAuditError::Persistence)?;
    serde_json::from_slice(&bytes).map_err(|_| ToolAuditError::CorruptJournal)
}

async fn write_record_once<T: Serialize>(path: &Path, record: &T) -> Result<(), ToolAuditError> {
    let parent = path.parent().ok_or(ToolAuditError::Persistence)?;
    let bytes = serde_json::to_vec(record).map_err(|_| ToolAuditError::Persistence)?;
    if bytes.len() > MAX_AUDIT_RECORD_BYTES as usize {
        return Err(ToolAuditError::InvalidInput);
    }
    let audit_root = parent.parent().ok_or(ToolAuditError::Persistence)?;
    let temporary_dir = audit_root.join(".tmp");
    ensure_directory_durable(&temporary_dir).await?;
    let temporary = temporary_dir.join(format!("{}.tmp", Uuid::now_v7()));
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| ToolAuditError::Persistence)?;
        file.write_all(&bytes)
            .map_err(|_| ToolAuditError::Persistence)?;
        file.sync_all().map_err(|_| ToolAuditError::Persistence)?;
        drop(file);
        if std::fs::hard_link(&temporary, &path).is_err() {
            let _ = std::fs::remove_file(&temporary);
            return Err(ToolAuditError::Persistence);
        }
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .and_then(|file| file.sync_all())
            .map_err(|_| ToolAuditError::Persistence)?;
        let _ = std::fs::remove_file(&temporary);
        Ok(())
    })
    .await
    .map_err(|_| ToolAuditError::Persistence)??;
    sync_directory(parent).await
}

async fn acquire_session_lock(session_dir: &Path) -> Result<std::fs::File, ToolAuditError> {
    let audit_root = session_dir.parent().ok_or(ToolAuditError::Persistence)?;
    ensure_directory_durable(&audit_root.join(".locks")).await?;
    let session_dir = session_dir.to_path_buf();
    tokio::task::spawn_blocking(move || acquire_session_lock_blocking(&session_dir))
        .await
        .map_err(|_| ToolAuditError::Persistence)?
}

fn acquire_session_lock_blocking(session_dir: &Path) -> Result<std::fs::File, ToolAuditError> {
    let audit_root = session_dir.parent().ok_or(ToolAuditError::Persistence)?;
    let session_digest = session_dir
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .ok_or(ToolAuditError::Persistence)?;
    validate_digest(session_digest)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(
            audit_root
                .join(".locks")
                .join(format!("{session_digest}.lock")),
        )
        .map_err(|_| ToolAuditError::Persistence)?;
    fs2::FileExt::lock_exclusive(&file).map_err(|_| ToolAuditError::Persistence)?;
    Ok(file)
}

async fn ensure_directory_durable(path: &Path) -> Result<(), ToolAuditError> {
    if path.exists() {
        return Ok(());
    }
    let parent = path.parent().ok_or(ToolAuditError::Persistence)?;
    ensure_directory_durable_boxed(parent).await?;
    match tokio::fs::create_dir(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(ToolAuditError::Persistence),
    }
    sync_directory(path).await?;
    sync_directory(parent).await
}

fn ensure_directory_durable_boxed(
    path: &Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ToolAuditError>> + Send + '_>> {
    Box::pin(ensure_directory_durable(path))
}

async fn sync_directory(path: &Path) -> Result<(), ToolAuditError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || sync_directory_blocking(&path))
        .await
        .map_err(|_| ToolAuditError::Persistence)?
}

#[cfg(unix)]
fn sync_directory_blocking(path: &Path) -> Result<(), ToolAuditError> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ToolAuditError::Persistence)
}

#[cfg(windows)]
fn sync_directory_blocking(_path: &Path) -> Result<(), ToolAuditError> {
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_directory_blocking(_path: &Path) -> Result<(), ToolAuditError> {
    Err(ToolAuditError::Persistence)
}

#[cfg(test)]
struct AuditRecords {
    started: Vec<StartedAuditRecord>,
    completed: Vec<CompletedAuditRecord>,
}

#[cfg(test)]
fn read_records(root: &Path) -> Result<AuditRecords, ToolAuditError> {
    let audit_root = root.join(AUDIT_DIRECTORY);
    let mut started = Vec::new();
    let mut completed = Vec::new();
    if !audit_root.exists() {
        return Ok(AuditRecords { started, completed });
    }
    for session in std::fs::read_dir(audit_root).map_err(|_| ToolAuditError::Persistence)? {
        let session = session.map_err(|_| ToolAuditError::Persistence)?;
        if !session.path().is_dir() {
            return Err(ToolAuditError::CorruptJournal);
        }
        for entry in std::fs::read_dir(session.path()).map_err(|_| ToolAuditError::Persistence)? {
            let entry = entry.map_err(|_| ToolAuditError::Persistence)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(ToolAuditError::CorruptJournal);
            };
            if name.ends_with(".started.json") {
                started.push(
                    serde_json::from_slice(
                        &std::fs::read(entry.path()).map_err(|_| ToolAuditError::Persistence)?,
                    )
                    .map_err(|_| ToolAuditError::CorruptJournal)?,
                );
            } else if name.ends_with(".completed.json") {
                completed.push(
                    serde_json::from_slice(
                        &std::fs::read(entry.path()).map_err(|_| ToolAuditError::Persistence)?,
                    )
                    .map_err(|_| ToolAuditError::CorruptJournal)?,
                );
            }
        }
    }
    started.sort_by(|left, right| left.core.audit_id.cmp(&right.core.audit_id));
    completed.sort_by(|left, right| left.core.audit_id.cmp(&right.core.audit_id));
    Ok(AuditRecords { started, completed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::failure_semantics::CodeProFailureKind;
    use serde_json::{Map, Value};
    use std::path::Path;

    const MAX_ARGUMENT_BYTES: usize = 1024 * 1024;

    fn input() -> ToolAuditInput {
        ToolAuditInput {
            session_id: "session-raw-value".to_owned(),
            request_id: "request-raw-value".to_owned(),
            task_scope: None,
            tool_name: QualifiedToolName::new("platform::git_commit").unwrap(),
            arguments: serde_json::json!({
                "password": "secret-value",
                "nested": { "token": "another-secret" }
            })
            .as_object()
            .unwrap()
            .clone(),
            actor: ToolAuditActor::Primary,
            effective_model: EffectiveModel::new("provider/model").unwrap(),
            extension_source: ToolAuditExtensionSource::Platform,
            permission_class: ToolAuditPermissionClass::ExternalWrite,
            authorization: ToolAuditAuthorization::PolicyAllowed,
        }
    }

    #[tokio::test]
    async fn completion_feedback_original_receipt_identity_cannot_be_borrowed() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let scope = CodeProTaskScope::new("run", "child").unwrap();
        let mut original = input();
        original.task_scope = Some(scope.clone());
        let claim = store.begin(original.clone()).await.unwrap();
        let receipt = store
            .complete_with_receipt(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        store
            .verify_completed_receipt(
                &original.session_id,
                &original.request_id,
                &scope,
                &original.arguments,
                &receipt,
            )
            .await
            .unwrap();
        let other_scope = CodeProTaskScope::new("other-run", "child").unwrap();
        let other_task = CodeProTaskScope::new("run", "other-child").unwrap();
        let mut changed_args = original.arguments.clone();
        changed_args.insert("path".into(), serde_json::json!("another-file"));
        let mut changed_receipt = receipt.clone();
        changed_receipt.outcome = ToolAuditOutcome::ToolError;
        for (session, request, candidate_scope, args, candidate_receipt) in [
            (
                "other-session",
                original.request_id.as_str(),
                &scope,
                &original.arguments,
                &receipt,
            ),
            (
                original.session_id.as_str(),
                "other-request",
                &scope,
                &original.arguments,
                &receipt,
            ),
            (
                original.session_id.as_str(),
                original.request_id.as_str(),
                &other_scope,
                &original.arguments,
                &receipt,
            ),
            (
                original.session_id.as_str(),
                original.request_id.as_str(),
                &other_task,
                &original.arguments,
                &receipt,
            ),
            (
                original.session_id.as_str(),
                original.request_id.as_str(),
                &scope,
                &changed_args,
                &receipt,
            ),
            (
                original.session_id.as_str(),
                original.request_id.as_str(),
                &scope,
                &original.arguments,
                &changed_receipt,
            ),
        ] {
            assert!(store
                .verify_completed_receipt(
                    session,
                    request,
                    candidate_scope,
                    args,
                    candidate_receipt
                )
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn r3_started_without_terminal_receipt_remains_a_task_blocker() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let run_id = RunId::new("run-audit").unwrap();
        let task_id = TaskId::new("task-audit").unwrap();
        let mut audit_input = input();
        audit_input.task_scope =
            Some(CodeProTaskScope::new(run_id.as_str(), task_id.as_str()).unwrap());
        let claim = store.begin(audit_input).await.unwrap();
        let unfinished = store
            .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
            .await
            .unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].audit_id, claim.started.core.audit_id);
        assert_eq!(unfinished[0].task_id, task_id);
        assert!(store
            .unfinished_for_run(
                &RunId::new("other-run").unwrap(),
                std::slice::from_ref(&task_id)
            )
            .await
            .unwrap()
            .is_empty());
        store
            .complete_with_receipt(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        assert!(store
            .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn completion_scan_preserves_child_orphans_and_rejects_corrupt_completed_history() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let run = RunId::new("run-completion").unwrap();
        let task = TaskId::new("child-task").unwrap();
        let mut child = input();
        child.session_id = "separate-child-session".into();
        child.task_scope = Some(CodeProTaskScope::new(run.as_str(), task.as_str()).unwrap());
        let claim = store.begin(child).await.unwrap();
        // A reopened store must discover an unfinished child without an in-memory cache.
        let reopened = ToolAuditStore::new(temp.path().to_path_buf());
        let unfinished = reopened
            .unfinished_for_run(&run, std::slice::from_ref(&task))
            .await
            .unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].audit_id, claim.started.core.audit_id);
        store
            .complete_with_receipt(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        assert!(reopened
            .unfinished_for_run(&run, std::slice::from_ref(&task))
            .await
            .unwrap()
            .is_empty());
        let mut historical = input();
        historical.session_id = "unrelated-history".into();
        let historical = store.begin(historical).await.unwrap();
        store
            .complete_with_receipt(&historical, ToolAuditOutcome::Success)
            .await
            .unwrap();
        std::fs::write(&historical.completed_path, b"{corrupt").unwrap();
        assert_eq!(
            reopened
                .unfinished_for_run(&run, &[task])
                .await
                .unwrap_err(),
            ToolAuditError::CorruptJournal
        );
    }

    #[tokio::test]
    async fn completion_scan_collects_all_parallel_sessions_and_excludes_other_runs() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let run = RunId::new("parallel-run").unwrap();
        let task = TaskId::new("parallel-task").unwrap();
        let mut expected = Vec::new();
        for index in 0..16 {
            let mut item = input();
            item.session_id = format!("parallel-session-{index}");
            item.task_scope = Some(CodeProTaskScope::new(run.as_str(), task.as_str()).unwrap());
            expected.push(store.begin(item).await.unwrap().started.core.audit_id);
        }
        let mut foreign = input();
        foreign.session_id = "foreign-session".into();
        foreign.task_scope = Some(CodeProTaskScope::new("foreign-run", task.as_str()).unwrap());
        store.begin(foreign).await.unwrap();
        expected.sort_unstable();
        let actual = ToolAuditStore::new(temp.path().to_path_buf())
            .unfinished_for_run(&run, &[task])
            .await
            .unwrap();
        assert_eq!(
            actual
                .into_iter()
                .map(|item| item.audit_id)
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[tokio::test]
    #[ignore = "read-only benchmark; set CODEPRO_AUDIT_BENCH_ROOT to an existing audit root"]
    async fn completion_scan_existing_history_benchmark() {
        let root = std::env::var_os("CODEPRO_AUDIT_BENCH_ROOT").expect("explicit audit root");
        let store = ToolAuditStore::new(PathBuf::from(root));
        let start = std::time::Instant::now();
        let result = store
            .unfinished_for_run(
                &RunId::new("benchmark-no-matching-run").unwrap(),
                &[TaskId::new("benchmark-no-matching-task").unwrap()],
            )
            .await
            .unwrap();
        assert!(result.is_empty());
        println!(
            "AUDIT_FULL_HISTORY_ELAPSED_MS={}",
            start.elapsed().as_millis()
        );
    }

    #[tokio::test]
    async fn completion_scan_preserves_cross_session_unknowns_after_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let run_id = RunId::new("run-parent").unwrap();
        let tasks = [
            TaskId::new("parent").unwrap(),
            TaskId::new("child").unwrap(),
        ];
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut claims = Vec::new();
        for (session, run, task) in [
            ("parent-session", run_id.as_str(), "parent"),
            ("worker-session", run_id.as_str(), "child"),
            ("unrelated-session", "different-run", "child"),
        ] {
            let mut action = input();
            action.session_id = session.into();
            action.task_scope = Some(CodeProTaskScope::new(run, task).unwrap());
            claims.push(store.begin(action).await.unwrap());
        }
        drop(store);
        let reopened = ToolAuditStore::new(temp.path().to_path_buf());
        let unfinished = reopened.unfinished_for_run(&run_id, &tasks).await.unwrap();
        assert_eq!(unfinished.len(), 2);
        for claim in &claims[..2] {
            assert!(unfinished
                .iter()
                .any(|item| item.audit_id == claim.started.core.audit_id));
        }
        reopened
            .complete(&claims[0], ToolAuditOutcome::Success)
            .await
            .unwrap();
        let unfinished = reopened.unfinished_for_run(&run_id, &tasks).await.unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].audit_id, claims[1].started.core.audit_id);
        reopened
            .complete(&claims[1], ToolAuditOutcome::Success)
            .await
            .unwrap();
        assert!(reopened
            .unfinished_for_run(&run_id, &tasks)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn completion_scan_does_not_trust_a_completed_filename_or_cached_success() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let run_id = RunId::new("run-audit").unwrap();
        let task_id = TaskId::new("task-audit").unwrap();
        let mut action = input();
        action.task_scope = Some(CodeProTaskScope::new(run_id.as_str(), task_id.as_str()).unwrap());
        let claim = store.begin(action).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        assert!(store
            .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
            .await
            .unwrap()
            .is_empty());

        let mut completed = read_completed_record(&claim.completed_path).await.unwrap();
        completed.core.request_digest = digest_parts(&[b"a-different-request"]);
        std::fs::write(
            &claim.completed_path,
            serde_json::to_vec(&completed).unwrap(),
        )
        .unwrap();
        assert_eq!(
            store.unfinished_for_run(&run_id, &[task_id]).await.err(),
            Some(ToolAuditError::CorruptJournal),
        );
    }

    #[tokio::test]
    async fn completion_location_index_observes_unindexed_writes_and_rebuilds_after_damage() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let run_id = RunId::new("new-run").unwrap();
        let task_id = TaskId::new("task").unwrap();
        let mut old = input();
        old.task_scope = Some(CodeProTaskScope::new("old-run", "task").unwrap());
        let old_claim = store.begin(old).await.unwrap();
        assert!(store
            .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
            .await
            .unwrap()
            .is_empty());
        assert!(!load_location_index(&temp.path().join(AUDIT_LOCATION_INDEX)).is_empty());

        // begin writes only the original journal, as older binaries do. Neither
        // a cached membership nor reopening may hide the new unfinished action.
        let reopened = ToolAuditStore::new(temp.path().to_path_buf());
        let mut current = input();
        current.task_scope =
            Some(CodeProTaskScope::new(run_id.as_str(), task_id.as_str()).unwrap());
        let current_claim = reopened.begin(current).await.unwrap();
        let unfinished = reopened
            .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
            .await
            .unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].audit_id, current_claim.started.core.audit_id);

        // A syntactically valid but damaged index must not become evidence that
        // the run has no actions. Its checksum forces a rebuild from receipts.
        let index_path = temp.path().join(AUDIT_LOCATION_INDEX);
        let mut index: AuditLocationIndex =
            serde_json::from_slice(&std::fs::read(&index_path).unwrap()).unwrap();
        for locations in index.sessions.values_mut() {
            locations.task_scopes.clear();
        }
        std::fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
        assert_eq!(
            reopened
                .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
                .await
                .unwrap(),
            unfinished
        );
        std::fs::remove_file(index_path).unwrap();
        assert_eq!(
            reopened
                .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
                .await
                .unwrap(),
            unfinished
        );

        reopened
            .complete(&current_claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        assert!(reopened
            .unfinished_for_run(&run_id, &[task_id])
            .await
            .unwrap()
            .is_empty());
        assert!(old_claim.started_path.exists());
        assert!(!old_claim.completed_path.exists());
    }

    #[tokio::test]
    async fn completion_location_index_invalidates_changed_original_scope() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let run_id = RunId::new("current-run").unwrap();
        let task_id = TaskId::new("task").unwrap();
        let mut original = input();
        original.task_scope = Some(CodeProTaskScope::new("old-run", "task").unwrap());
        let claim = store.begin(original).await.unwrap();
        assert!(store
            .unfinished_for_run(&run_id, std::slice::from_ref(&task_id))
            .await
            .unwrap()
            .is_empty());
        // Same filename and length, different metadata: checking only directory
        // mtime or record count would incorrectly reuse the old membership.
        let mut started = claim.started.clone();
        started.core.task_scope_digest = Some(task_scope_digest(
            &CodeProTaskScope::new(run_id.as_str(), task_id.as_str()).unwrap(),
        ));
        std::fs::write(&claim.started_path, serde_json::to_vec(&started).unwrap()).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&claim.started_path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        let unfinished = store.unfinished_for_run(&run_id, &[task_id]).await.unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].audit_id, claim.started.core.audit_id);
    }

    #[tokio::test]
    async fn receipt_is_derived_from_the_persisted_completed_record() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut audit_input = input();
        audit_input.task_scope =
            Some(CodeProTaskScope::new("run-raw-value", "task-raw-value").unwrap());
        let claim = store.begin(audit_input).await.unwrap();

        let receipt = store
            .complete_with_receipt(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        let persisted = read_records(temp.path()).unwrap().completed.remove(0);

        assert_eq!(receipt.schema_version, AUDIT_SCHEMA_VERSION);
        assert_eq!(receipt.audit_id, persisted.core.audit_id);
        assert_eq!(receipt.actor, ToolAuditActor::Primary);
        assert_eq!(receipt.effective_model, "provider/model");
        assert_eq!(receipt.tool_name, "platform::git_commit");
        assert_eq!(receipt.extension_source, ToolAuditExtensionSource::Platform);
        assert_eq!(
            receipt.permission_class,
            ToolAuditPermissionClass::ExternalWrite
        );
        assert_eq!(receipt.authorization, ToolAuditAuthorization::PolicyAllowed);
        assert_eq!(receipt.outcome, ToolAuditOutcome::Success);
        assert!(receipt.task_scoped);
        assert_eq!(receipt.started_at, claim.started.started_at);
        assert_eq!(receipt.completed_at, persisted.completed_at);
        assert_eq!(receipt.duration_ms, persisted.duration_ms);
    }

    #[tokio::test]
    async fn receipt_serialization_excludes_identifiers_digests_arguments_and_results() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut audit_input = input();
        audit_input.task_scope =
            Some(CodeProTaskScope::new("run-raw-value", "task-raw-value").unwrap());
        let claim = store.begin(audit_input).await.unwrap();
        let receipt = store
            .complete_with_receipt(&claim, ToolAuditOutcome::ToolError)
            .await
            .unwrap();

        let serialized = serde_json::to_string(&receipt).unwrap();
        for expected in [
            "\"schemaVersion\":2",
            "\"effectiveModel\":\"provider/model\"",
            "\"toolName\":\"platform::git_commit\"",
            "\"outcome\":\"tool_error\"",
        ] {
            assert!(serialized.contains(expected), "missing {expected}");
        }
        for prohibited in [
            "session_digest",
            "request_digest",
            "task_scope_digest",
            "argument_digest",
            "session-raw-value",
            "request-raw-value",
            "run-raw-value",
            "task-raw-value",
            "password",
            "secret-value",
            "another-secret",
            "rawOutput",
            "errorBody",
        ] {
            assert!(
                !serialized.contains(prohibited),
                "receipt exposed {prohibited}"
            );
        }
    }

    #[tokio::test]
    async fn denied_receipts_cover_policy_and_user_denials() {
        for (authorization, expected_outcome, expected_failure) in [
            (
                ToolAuditAuthorization::PolicyDenied,
                ToolAuditOutcome::PolicyDenied,
                CodeProFailureKind::PolicyDenied,
            ),
            (
                ToolAuditAuthorization::UserDenied,
                ToolAuditOutcome::UserDenied,
                CodeProFailureKind::UserDenied,
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let store = ToolAuditStore::new(temp.path().to_path_buf());
            let mut denied = input();
            denied.authorization = authorization;

            let receipt = store.record_denied_with_receipt(denied).await.unwrap();

            assert_eq!(receipt.authorization, authorization);
            assert_eq!(receipt.outcome, expected_outcome);
            assert_eq!(receipt.failure_kind, Some(expected_failure));
        }
    }

    #[tokio::test]
    async fn forbidden_policy_denial_keeps_its_distinct_failure_reason() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut denied = input();
        denied.authorization = ToolAuditAuthorization::PolicyDenied;
        denied.permission_class = ToolAuditPermissionClass::Forbidden;

        let receipt = store.record_denied_with_receipt(denied).await.unwrap();

        assert_eq!(receipt.outcome, ToolAuditOutcome::PolicyDenied);
        assert_eq!(receipt.failure_kind, Some(CodeProFailureKind::Forbidden));
    }

    #[tokio::test]
    async fn failure_reason_must_match_the_terminal_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let claim = store.begin(input()).await.unwrap();

        assert_eq!(
            store
                .complete_with_failure_receipt(
                    &claim,
                    ToolAuditOutcome::Success,
                    Some(CodeProFailureKind::EnvironmentFailure),
                )
                .await
                .err(),
            Some(ToolAuditError::InvalidInput)
        );
    }

    #[tokio::test]
    async fn receipts_preserve_every_fixed_terminal_outcome() {
        for (authorization, outcome) in [
            (
                ToolAuditAuthorization::PolicyAllowed,
                ToolAuditOutcome::Success,
            ),
            (
                ToolAuditAuthorization::PolicyAllowed,
                ToolAuditOutcome::ToolError,
            ),
            (
                ToolAuditAuthorization::PolicyAllowed,
                ToolAuditOutcome::Cancelled,
            ),
            (
                ToolAuditAuthorization::PolicyAllowed,
                ToolAuditOutcome::TimedOut,
            ),
            (
                ToolAuditAuthorization::PolicyAllowed,
                ToolAuditOutcome::ReplaySuppressed,
            ),
            (
                ToolAuditAuthorization::PolicyAllowed,
                ToolAuditOutcome::Ambiguous,
            ),
            (
                ToolAuditAuthorization::PolicyDenied,
                ToolAuditOutcome::PolicyDenied,
            ),
            (
                ToolAuditAuthorization::UserDenied,
                ToolAuditOutcome::UserDenied,
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let store = ToolAuditStore::new(temp.path().to_path_buf());
            let mut audit_input = input();
            audit_input.authorization = authorization;
            let claim = store.begin(audit_input).await.unwrap();

            let receipt = store.complete_with_receipt(&claim, outcome).await.unwrap();

            assert_eq!(receipt.authorization, authorization);
            assert_eq!(receipt.outcome, outcome);
        }
    }

    #[tokio::test]
    async fn started_claim_completes_with_a_non_negative_duration() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());

        let claim = store.begin(input()).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();

        let records = read_records(temp.path()).unwrap();
        assert_eq!(records.started.len(), 1);
        assert_eq!(records.completed.len(), 1);
        assert_eq!(
            records.completed[0].duration_ms,
            u64::try_from(
                records.completed[0]
                    .completed_at
                    .signed_duration_since(records.started[0].started_at)
                    .num_milliseconds(),
            )
            .unwrap_or(0)
        );
    }

    #[tokio::test]
    async fn client_error_is_persisted_as_a_terminal_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let claim = store.begin(input()).await.unwrap();

        store
            .complete(&claim, ToolAuditOutcome::ToolError)
            .await
            .unwrap();

        let records = read_records(temp.path()).unwrap();
        assert_eq!(records.completed[0].outcome, ToolAuditOutcome::ToolError);
    }

    #[tokio::test]
    async fn denied_authorization_cannot_be_completed_as_success() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut denied = input();
        denied.authorization = ToolAuditAuthorization::PolicyDenied;
        let claim = store.begin(denied).await.unwrap();

        assert_eq!(
            store
                .complete(&claim, ToolAuditOutcome::Success)
                .await
                .err(),
            Some(ToolAuditError::InvalidInput)
        );
    }

    #[tokio::test]
    async fn denied_call_is_durably_recorded_without_execution_claim() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut denied = input();
        denied.authorization = ToolAuditAuthorization::UserDenied;

        store.record_denied(denied).await.unwrap();

        let records = read_records(temp.path()).unwrap();
        assert_eq!(records.started.len(), 1);
        assert_eq!(records.completed.len(), 1);
        assert_eq!(records.completed[0].outcome, ToolAuditOutcome::UserDenied);
    }

    #[tokio::test]
    async fn records_remain_valid_after_reopening_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let claim = store.begin(input()).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        drop(store);

        let reopened = ToolAuditStore::new(temp.path().to_path_buf());
        let claim = reopened.begin(input()).await.unwrap();
        drop(claim);
        let records = read_records(temp.path()).unwrap();
        assert_eq!(records.started.len(), 2);
    }

    #[tokio::test]
    async fn dropped_claim_remains_only_started() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let claim = store.begin(input()).await.unwrap();
        drop(claim);

        let records = read_records(temp.path()).unwrap();
        assert_eq!(records.started.len(), 1);
        assert!(records.completed.is_empty());
    }

    #[tokio::test]
    async fn persisted_records_exclude_raw_identifiers_arguments_and_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut audit_input = input();
        audit_input.task_scope =
            Some(CodeProTaskScope::new("run-raw-value", "task-raw-value").unwrap());
        let claim = store.begin(audit_input).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();

        let serialized = audit_files(temp.path())
            .into_iter()
            .map(std::fs::read_to_string)
            .collect::<Result<String, _>>()
            .unwrap();
        for expected in [
            "\"effective_model\":\"provider/model\"",
            "\"extension_source\":\"platform\"",
            "\"tool_name\":\"platform::git_commit\"",
            "\"permission_class\":\"external_write\"",
        ] {
            assert!(serialized.contains(expected), "missing {expected}");
        }
        for prohibited in [
            "session-raw-value",
            "request-raw-value",
            "run-raw-value",
            "task-raw-value",
            "password",
            "secret-value",
            "another-secret",
        ] {
            assert!(!serialized.contains(prohibited), "persisted {prohibited}");
        }
    }

    #[tokio::test]
    async fn arbitrary_metadata_that_looks_like_a_secret_path_or_header_is_rejected() {
        assert_eq!(
            QualifiedToolName::new("C:\\Users\\operator\\.ssh\\id_ed25519").err(),
            Some(ToolAuditError::InvalidInput)
        );
        assert_eq!(
            EffectiveModel::new("provider/model?api_key=secret-value").err(),
            Some(ToolAuditError::InvalidInput)
        );
        assert!(serde_json::from_str::<ToolAuditExtensionSource>(
            "\"Authorization: Bearer secret-value\""
        )
        .is_err());
        assert!(
            serde_json::from_str::<ToolAuditPermissionClass>("\"X-Api-Key: secret-value\"")
                .is_err()
        );
    }

    #[tokio::test]
    async fn safe_multi_segment_model_identifiers_are_persisted_without_accepting_unsafe_data() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut audit_input = input();
        audit_input.effective_model =
            EffectiveModel::new("openrouter/anthropic/claude-sonnet-4:latest").unwrap();

        let claim = store.begin(audit_input).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();

        let serialized = audit_files(temp.path())
            .into_iter()
            .map(std::fs::read_to_string)
            .collect::<Result<String, _>>()
            .unwrap();
        assert!(serialized.contains("openrouter/anthropic/claude-sonnet-4:latest"));
        for unsafe_model in [
            "openrouter/anthropic/claude?api_key=secret-value",
            "openrouter\\anthropic\\claude",
            "openrouter/anthropic/claude Authorization: Bearer secret-value",
            "openrouter/anthropic/claude\nX-Api-Key: secret-value",
        ] {
            assert_eq!(
                EffectiveModel::new(unsafe_model).err(),
                Some(ToolAuditError::InvalidInput),
                "accepted unsafe model {unsafe_model:?}"
            );
        }
    }

    #[tokio::test]
    async fn crash_leftover_temporary_file_outside_session_does_not_poison_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let first = store.begin(input()).await.unwrap();
        drop(first);
        let temporary_dir = temp.path().join(AUDIT_DIRECTORY).join(".tmp");
        std::fs::create_dir_all(&temporary_dir).unwrap();
        std::fs::write(temporary_dir.join("crash-leftover.tmp"), b"partial").unwrap();

        let reopened = ToolAuditStore::new(temp.path().to_path_buf());
        let mut second = input();
        second.request_id = "request-after-temp-crash".to_owned();
        assert!(reopened.begin(second).await.is_ok());
    }

    #[tokio::test]
    async fn completed_first_cleanup_interruption_leaves_conservative_started_record() {
        let temp = tempfile::tempdir().unwrap();
        let policy = ToolAuditPolicy {
            max_records_per_session: 2,
            completed_retention: std::time::Duration::ZERO,
        };
        let store = ToolAuditStore::with_policy(temp.path().to_path_buf(), policy);
        let claim = store.begin(input()).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();

        // Simulate a crash after the safe first deletion step.
        std::fs::remove_file(&claim.completed_path).unwrap();
        let reopened = ToolAuditStore::with_policy(temp.path().to_path_buf(), policy);
        let mut next = input();
        next.request_id = "request-after-cleanup-crash".to_owned();
        let next_claim = reopened.begin(next).await.unwrap();
        assert!(claim.started_path.exists());
        assert!(next_claim.started_path.exists());
    }

    #[tokio::test]
    async fn independent_stores_enforce_capacity_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let policy = ToolAuditPolicy {
            max_records_per_session: 1,
            completed_retention: DEFAULT_COMPLETED_RETENTION,
        };
        let first = ToolAuditStore::with_policy(temp.path().to_path_buf(), policy);
        let second = ToolAuditStore::with_policy(temp.path().to_path_buf(), policy);
        let mut first_input = input();
        first_input.request_id = "capacity-first".to_owned();
        let mut second_input = input();
        second_input.request_id = "capacity-second".to_owned();

        let (left, right) = tokio::join!(first.begin(first_input), second.begin(second_input));
        let results = [left.map(|_| ()), right.map(|_| ())];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(ToolAuditError::Capacity)))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn accepts_arguments_at_the_one_mib_boundary_and_rejects_larger_input() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let mut at_limit = input();
        at_limit.arguments = arguments_at_serialized_size(MAX_ARGUMENT_BYTES);
        let claim = store.begin(at_limit).await.unwrap();
        drop(claim);

        let mut too_large = input();
        too_large.arguments = arguments_at_serialized_size(MAX_ARGUMENT_BYTES + 1);
        assert_eq!(
            store.begin(too_large).await.err(),
            Some(ToolAuditError::InvalidInput)
        );
    }

    #[tokio::test]
    async fn records_larger_than_sixteen_kib_fail_closed_before_reading() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::new(temp.path().to_path_buf());
        let claim = store.begin(input()).await.unwrap();
        let started_path = claim.started_path.clone();
        drop(claim);
        std::fs::write(
            started_path,
            vec![b'x'; MAX_AUDIT_RECORD_BYTES as usize + 1],
        )
        .unwrap();

        assert_eq!(
            store.begin(input()).await.err(),
            Some(ToolAuditError::CorruptJournal)
        );
    }

    #[tokio::test]
    async fn capacity_is_limited_to_4096_records_per_session() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            ToolAuditPolicy::default().max_records_per_session,
            DEFAULT_MAX_RECORDS_PER_SESSION
        );
        let store = ToolAuditStore::with_policy(
            temp.path().to_path_buf(),
            ToolAuditPolicy {
                max_records_per_session: 1,
                completed_retention: std::time::Duration::from_secs(30 * 24 * 60 * 60),
            },
        );
        let claim = store.begin(input()).await.unwrap();
        drop(claim);

        assert_eq!(
            store.begin(input()).await.err(),
            Some(ToolAuditError::Capacity)
        );
    }

    #[tokio::test]
    async fn completed_records_expire_after_the_retention_window() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::with_policy(
            temp.path().to_path_buf(),
            ToolAuditPolicy {
                max_records_per_session: 1,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let claim = store.begin(input()).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();

        assert!(store.begin(input()).await.is_ok());
    }

    #[tokio::test]
    async fn unresolved_records_are_never_cleaned_during_retention_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::with_policy(
            temp.path().to_path_buf(),
            ToolAuditPolicy {
                max_records_per_session: 1,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let claim = store.begin(input()).await.unwrap();
        drop(claim);

        assert_eq!(
            store.begin(input()).await.err(),
            Some(ToolAuditError::Capacity)
        );
    }

    #[tokio::test]
    async fn explicit_completed_cleanup_preserves_unresolved_records() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::with_policy(
            temp.path().to_path_buf(),
            ToolAuditPolicy {
                max_records_per_session: 10,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let mut unresolved_input = input();
        unresolved_input.request_id = "unresolved-request".to_string();
        let unresolved = store.begin(unresolved_input).await.unwrap();
        let completed = store.begin(input()).await.unwrap();
        store
            .complete(&completed, ToolAuditOutcome::Success)
            .await
            .unwrap();

        let preview = store.preview_completed_cleanup().await.unwrap();
        assert_eq!(preview.len(), 1);
        let report = store.cleanup_completed_exact(&preview).await.unwrap();
        assert_eq!(report.removed_records, 1);
        assert!(!completed.started_path.exists());
        assert!(!completed.completed_path.exists());
        assert!(unresolved.started_path.exists());
        assert!(!unresolved.completed_path.exists());
    }

    #[tokio::test]
    async fn completed_cleanup_rejects_a_changed_record_before_deletion() {
        use std::io::Write;

        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::with_policy(
            temp.path().to_path_buf(),
            ToolAuditPolicy {
                max_records_per_session: 10,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let claim = store.begin(input()).await.unwrap();
        store
            .complete(&claim, ToolAuditOutcome::Success)
            .await
            .unwrap();
        let preview = store.preview_completed_cleanup().await.unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&claim.completed_path)
            .unwrap()
            .write_all(b" ")
            .unwrap();

        assert!(matches!(
            store.cleanup_completed_exact(&preview).await,
            Err(ToolAuditCleanupError::StalePreview)
        ));
        assert!(claim.started_path.exists());
        assert!(claim.completed_path.exists());
    }

    #[tokio::test]
    async fn corrupt_unknown_version_and_orphan_completed_records_fail_closed() {
        for mutation in ["corrupt", "unknown_version", "orphan_completed"] {
            let temp = tempfile::tempdir().unwrap();
            let store = ToolAuditStore::new(temp.path().to_path_buf());
            let claim = store.begin(input()).await.unwrap();
            let started_path = claim.started_path.clone();
            let completed_path = claim.completed_path.clone();
            drop(claim);
            match mutation {
                "corrupt" => std::fs::write(&started_path, b"not-json").unwrap(),
                "unknown_version" => {
                    let mut json: Value =
                        serde_json::from_slice(&std::fs::read(&started_path).unwrap()).unwrap();
                    json["schema_version"] = Value::from(99);
                    std::fs::write(&started_path, serde_json::to_vec(&json).unwrap()).unwrap();
                }
                "orphan_completed" => {
                    std::fs::remove_file(&started_path).unwrap();
                    std::fs::write(
                        &completed_path,
                        serde_json::to_vec(&CompletedAuditRecord::orphan_for_test()).unwrap(),
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }

            assert_eq!(
                store.begin(input()).await.err(),
                Some(ToolAuditError::CorruptJournal)
            );
        }
    }

    fn arguments_at_serialized_size(size: usize) -> Map<String, Value> {
        let empty = serde_json::json!({ "payload": "" })
            .as_object()
            .unwrap()
            .clone();
        let overhead = serde_json::to_vec(&empty).unwrap().len();
        serde_json::json!({ "payload": "x".repeat(size - overhead) })
            .as_object()
            .unwrap()
            .clone()
    }

    fn audit_files(root: &Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        for entry in walkdir(root) {
            if entry
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                files.push(entry);
            }
        }
        files.sort();
        files
    }

    fn walkdir(path: &Path) -> Vec<std::path::PathBuf> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap().path();
            if entry.is_dir() {
                entries.extend(walkdir(&entry));
            } else {
                entries.push(entry);
            }
        }
        entries
    }
}
