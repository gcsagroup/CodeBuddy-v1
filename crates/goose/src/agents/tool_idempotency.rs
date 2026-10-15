use crate::config::permission::CodeProTaskScope;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use uuid::Uuid;

const JOURNAL_SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_RECORDS_PER_SCOPE: usize = 4_096;
const DEFAULT_COMPLETED_RETENTION: std::time::Duration =
    std::time::Duration::from_secs(30 * 24 * 60 * 60);
const MAX_ARGUMENT_BYTES: usize = 1024 * 1024;
const MAX_JOURNAL_RECORD_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolArgumentDigestError {
    TooLarge,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ToolIdempotencyPolicy {
    pub max_records_per_scope: usize,
    pub completed_retention: std::time::Duration,
}

impl Default for ToolIdempotencyPolicy {
    fn default() -> Self {
        Self {
            max_records_per_scope: DEFAULT_MAX_RECORDS_PER_SCOPE,
            completed_retention: DEFAULT_COMPLETED_RETENTION,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ToolIdempotencyCleanupCandidate {
    pub scope_digest: String,
    pub request_key: String,
    pub bytes: u64,
    pub fingerprint_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ToolIdempotencyCleanupReport {
    pub removed_records: usize,
    pub reclaimed_bytes: u64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ToolIdempotencyCleanupError {
    #[error("idempotency cleanup preview is stale")]
    StalePreview,
    #[error("idempotency cleanup failed: {0}")]
    Store(#[from] ToolIdempotencyError),
}

#[derive(Debug, Clone)]
pub(crate) struct ToolIdempotencyInput {
    pub session_id: String,
    pub task_scope: Option<CodeProTaskScope>,
    pub request_id: String,
    pub tool_name: String,
    pub arguments: Map<String, Value>,
    pub explicit_user_confirmation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ToolIdempotencyOutcome {
    Success,
    Error,
    Uncertain,
}

pub(crate) enum BeginDecision {
    Execute(Box<ToolIdempotencyClaim>),
    ReplaySuppressed(ToolIdempotencyOutcome),
    InFlight,
    Ambiguous,
}

enum UnresolvedOperationDecision {
    Block(BeginDecision),
    Takeover(Vec<(PathBuf, JournalRecord)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolIdempotencyError {
    InvalidInput,
    IdentityConflict,
    CorruptJournal,
    Persistence,
    Capacity,
}

impl fmt::Display for ToolIdempotencyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "invalid host tool identity",
            Self::IdentityConflict => "tool request identity conflict",
            Self::CorruptJournal => "tool idempotency journal is invalid",
            Self::Persistence => "tool idempotency journal could not be persisted",
            Self::Capacity => "tool idempotency journal capacity is exhausted",
        })
    }
}

impl std::error::Error for ToolIdempotencyError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalRecord {
    schema_version: u32,
    tool_name: String,
    argument_digest: String,
    operation_digest: String,
    created_at: chrono::DateTime<chrono::Utc>,
    outcome: Option<ToolIdempotencyOutcome>,
}

pub(crate) struct ToolIdempotencyClaim {
    started_path: PathBuf,
    completed_path: PathBuf,
    request_key: String,
    record: JournalRecord,
    active: Arc<StdMutex<HashSet<String>>>,
    operation_lock: StdMutex<Option<std::fs::File>>,
    released: std::sync::atomic::AtomicBool,
}

impl ToolIdempotencyClaim {
    fn release(&self) {
        if self
            .released
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            return;
        }
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.request_key);
        if let Some(file) = self
            .operation_lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = fs2::FileExt::unlock(&file);
        }
    }
}

impl Drop for ToolIdempotencyClaim {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) struct ToolIdempotencyStore {
    base_dir: PathBuf,
    io_lock: Mutex<()>,
    active: Arc<StdMutex<HashSet<String>>>,
    policy: ToolIdempotencyPolicy,
    #[cfg(test)]
    fail_next_complete: std::sync::atomic::AtomicBool,
}

impl ToolIdempotencyStore {
    pub(crate) fn new(base_dir: PathBuf) -> Self {
        Self::with_policy(base_dir, ToolIdempotencyPolicy::default())
    }

    pub(crate) fn with_policy(base_dir: PathBuf, policy: ToolIdempotencyPolicy) -> Self {
        Self {
            base_dir,
            io_lock: Mutex::new(()),
            active: Arc::new(StdMutex::new(HashSet::new())),
            policy,
            #[cfg(test)]
            fail_next_complete: std::sync::atomic::AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_next_complete_for_test(&self) {
        self.fail_next_complete
            .store(true, std::sync::atomic::Ordering::Release);
    }

    pub(crate) async fn begin(
        &self,
        input: ToolIdempotencyInput,
    ) -> Result<BeginDecision, ToolIdempotencyError> {
        validate_input(&input)?;
        let scope_digest = scope_digest(&input);
        let request_key = digest_parts(&[input.request_id.as_bytes()]);
        let argument_digest = bounded_argument_digest(&input.arguments)
            .map_err(|_| ToolIdempotencyError::InvalidInput)?;
        let operation_digest = digest_parts(&[
            input.tool_name.as_bytes(),
            b"\0",
            argument_digest.as_bytes(),
        ]);
        let scope_dir = self.base_dir.join(scope_digest);
        let started_path = scope_dir.join(format!("{request_key}.started.json"));
        let completed_path = scope_dir.join(format!("{request_key}.completed.json"));
        let _guard = self.io_lock.lock().await;
        ensure_directory_durable(&self.base_dir).await?;
        ensure_directory_durable(&scope_dir).await?;
        let Some(operation_lock) =
            try_acquire_operation_lock(&scope_dir, &operation_digest).await?
        else {
            return Ok(BeginDecision::InFlight);
        };

        if completed_path.exists() {
            let record = read_record(&completed_path).await?;
            validate_record(
                &record,
                &input.tool_name,
                &argument_digest,
                &operation_digest,
            )?;
            return record
                .outcome
                .map(BeginDecision::ReplaySuppressed)
                .ok_or(ToolIdempotencyError::CorruptJournal);
        }
        if started_path.exists() {
            let record = read_record(&started_path).await?;
            validate_record(
                &record,
                &input.tool_name,
                &argument_digest,
                &operation_digest,
            )?;
            let is_active = self
                .active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(&request_key);
            return Ok(if is_active {
                BeginDecision::InFlight
            } else {
                BeginDecision::Ambiguous
            });
        }

        let stale_claims = match self
            .unresolved_operation_decision(
                &scope_dir,
                &request_key,
                &operation_digest,
                input.explicit_user_confirmation,
            )
            .await?
        {
            Some(UnresolvedOperationDecision::Block(decision)) => return Ok(decision),
            Some(UnresolvedOperationDecision::Takeover(claims)) => claims,
            None => Vec::new(),
        };
        self.enforce_capacity(&scope_dir).await?;

        let record = JournalRecord {
            schema_version: JOURNAL_SCHEMA_VERSION,
            tool_name: input.tool_name,
            argument_digest,
            operation_digest,
            created_at: chrono::Utc::now(),
            outcome: None,
        };
        write_record_once(&started_path, &record).await?;
        for (completed_path, mut stale_record) in stale_claims {
            stale_record.created_at = chrono::Utc::now();
            stale_record.outcome = Some(ToolIdempotencyOutcome::Uncertain);
            write_record_once(&completed_path, &stale_record).await?;
        }
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(request_key.clone());

        Ok(BeginDecision::Execute(Box::new(ToolIdempotencyClaim {
            started_path,
            completed_path,
            request_key,
            record,
            active: Arc::clone(&self.active),
            operation_lock: StdMutex::new(Some(operation_lock)),
            released: std::sync::atomic::AtomicBool::new(false),
        })))
    }

    async fn enforce_capacity(&self, scope_dir: &Path) -> Result<(), ToolIdempotencyError> {
        if self.policy.max_records_per_scope == 0 {
            return Err(ToolIdempotencyError::Capacity);
        }
        if !scope_dir.exists() {
            return Ok(());
        }
        let mut entries = tokio::fs::read_dir(scope_dir)
            .await
            .map_err(|_| ToolIdempotencyError::Persistence)?;
        let mut retained = 0usize;
        let now = chrono::Utc::now();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|_| ToolIdempotencyError::Persistence)?
        {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(ToolIdempotencyError::CorruptJournal);
            };
            if let Some(request_key) = name.strip_suffix(".completed.json") {
                if !scope_dir
                    .join(format!("{request_key}.started.json"))
                    .exists()
                {
                    return Err(ToolIdempotencyError::CorruptJournal);
                }
                continue;
            }
            let Some(request_key) = name.strip_suffix(".started.json") else {
                continue;
            };
            let started_path = entry.path();
            let started = read_record(&started_path).await?;
            if started.schema_version != JOURNAL_SCHEMA_VERSION || started.outcome.is_some() {
                return Err(ToolIdempotencyError::CorruptJournal);
            }
            let completed_path = scope_dir.join(format!("{request_key}.completed.json"));
            if completed_path.exists() {
                let completed = read_record(&completed_path).await?;
                validate_record(
                    &completed,
                    &started.tool_name,
                    &started.argument_digest,
                    &started.operation_digest,
                )?;
                if completed.outcome.is_none() {
                    return Err(ToolIdempotencyError::CorruptJournal);
                }
                let expired = now
                    .signed_duration_since(completed.created_at)
                    .to_std()
                    .is_ok_and(|age| age >= self.policy.completed_retention);
                if expired {
                    tokio::fs::remove_file(&completed_path)
                        .await
                        .map_err(|_| ToolIdempotencyError::Persistence)?;
                    tokio::fs::remove_file(&started_path)
                        .await
                        .map_err(|_| ToolIdempotencyError::Persistence)?;
                    sync_directory(scope_dir).await?;
                    continue;
                }
            }
            retained = retained.saturating_add(1);
        }
        if retained >= self.policy.max_records_per_scope {
            return Err(ToolIdempotencyError::Capacity);
        }
        Ok(())
    }

    async fn unresolved_operation_decision(
        &self,
        scope_dir: &Path,
        current_request_key: &str,
        operation_digest: &str,
        explicit_user_confirmation: bool,
    ) -> Result<Option<UnresolvedOperationDecision>, ToolIdempotencyError> {
        if !scope_dir.exists() {
            return Ok(None);
        }
        let mut stale_claims = Vec::new();
        let mut entries = tokio::fs::read_dir(scope_dir)
            .await
            .map_err(|_| ToolIdempotencyError::Persistence)?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|_| ToolIdempotencyError::Persistence)?
        {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(ToolIdempotencyError::CorruptJournal);
            };
            let Some(request_key) = name.strip_suffix(".started.json") else {
                continue;
            };
            if request_key == current_request_key {
                continue;
            }
            let completed_path = scope_dir.join(format!("{request_key}.completed.json"));
            if completed_path.exists() {
                continue;
            }
            let record = read_record(&entry.path()).await?;
            if record.schema_version != JOURNAL_SCHEMA_VERSION {
                return Err(ToolIdempotencyError::CorruptJournal);
            }
            if record.operation_digest != operation_digest {
                continue;
            }
            let is_active = self
                .active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(request_key);
            if is_active {
                return Ok(Some(UnresolvedOperationDecision::Block(
                    BeginDecision::InFlight,
                )));
            }
            if !explicit_user_confirmation {
                return Ok(Some(UnresolvedOperationDecision::Block(
                    BeginDecision::Ambiguous,
                )));
            }
            stale_claims.push((completed_path, record));
        }
        Ok((!stale_claims.is_empty())
            .then_some(UnresolvedOperationDecision::Takeover(stale_claims)))
    }

    pub(crate) async fn abandon_definite(
        &self,
        claim: &ToolIdempotencyClaim,
    ) -> Result<(), ToolIdempotencyError> {
        let _guard = self.io_lock.lock().await;
        let started = read_record(&claim.started_path).await?;
        validate_record(
            &started,
            &claim.record.tool_name,
            &claim.record.argument_digest,
            &claim.record.operation_digest,
        )?;
        if claim.completed_path.exists() {
            return Err(ToolIdempotencyError::IdentityConflict);
        }
        let scope_dir = claim
            .started_path
            .parent()
            .ok_or(ToolIdempotencyError::Persistence)?;
        tokio::fs::remove_file(&claim.started_path)
            .await
            .map_err(|_| ToolIdempotencyError::Persistence)?;
        sync_directory(scope_dir).await?;
        claim.release();
        Ok(())
    }

    pub(crate) async fn complete(
        &self,
        claim: &ToolIdempotencyClaim,
        outcome: ToolIdempotencyOutcome,
    ) -> Result<(), ToolIdempotencyError> {
        let _guard = self.io_lock.lock().await;
        #[cfg(test)]
        if self
            .fail_next_complete
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            return Err(ToolIdempotencyError::Persistence);
        }
        let started = read_record(&claim.started_path).await?;
        validate_record(
            &started,
            &claim.record.tool_name,
            &claim.record.argument_digest,
            &claim.record.operation_digest,
        )?;
        let mut completed = claim.record.clone();
        completed.created_at = chrono::Utc::now();
        completed.outcome = Some(outcome);
        if claim.completed_path.exists() {
            let existing = read_record(&claim.completed_path).await?;
            if existing.outcome != Some(outcome) {
                return Err(ToolIdempotencyError::IdentityConflict);
            }
        } else {
            write_record_once(&claim.completed_path, &completed).await?;
        }
        claim.release();
        Ok(())
    }

    pub(crate) async fn preview_completed_cleanup(
        &self,
    ) -> Result<Vec<ToolIdempotencyCleanupCandidate>, ToolIdempotencyError> {
        let _guard = self.io_lock.lock().await;
        self.completed_cleanup_candidates().await
    }

    pub(crate) async fn cleanup_completed_exact(
        &self,
        expected: &[ToolIdempotencyCleanupCandidate],
    ) -> Result<ToolIdempotencyCleanupReport, ToolIdempotencyCleanupError> {
        let _guard = self.io_lock.lock().await;
        let current = self.completed_cleanup_candidates().await?;
        if current != expected {
            return Err(ToolIdempotencyCleanupError::StalePreview);
        }

        let mut report = ToolIdempotencyCleanupReport::default();
        for candidate in current {
            let scope_dir = self.base_dir.join(&candidate.scope_digest);
            let completed = scope_dir.join(format!("{}.completed.json", candidate.request_key));
            let started = scope_dir.join(format!("{}.started.json", candidate.request_key));
            tokio::fs::remove_file(&completed)
                .await
                .map_err(|_| ToolIdempotencyError::Persistence)?;
            sync_directory(&scope_dir).await?;
            tokio::fs::remove_file(&started)
                .await
                .map_err(|_| ToolIdempotencyError::Persistence)?;
            sync_directory(&scope_dir).await?;
            report.removed_records = report.removed_records.saturating_add(1);
            report.reclaimed_bytes = report.reclaimed_bytes.saturating_add(candidate.bytes);
        }
        Ok(report)
    }

    async fn completed_cleanup_candidates(
        &self,
    ) -> Result<Vec<ToolIdempotencyCleanupCandidate>, ToolIdempotencyError> {
        if !self.base_dir.exists() {
            return Ok(Vec::new());
        }

        let mut scopes = tokio::fs::read_dir(&self.base_dir)
            .await
            .map_err(|_| ToolIdempotencyError::Persistence)?;
        let now = chrono::Utc::now();
        let mut candidates = Vec::new();
        while let Some(entry) = scopes
            .next_entry()
            .await
            .map_err(|_| ToolIdempotencyError::Persistence)?
        {
            let metadata = tokio::fs::symlink_metadata(entry.path())
                .await
                .map_err(|_| ToolIdempotencyError::Persistence)?;
            if is_link_or_reparse_point(&metadata) || !metadata.is_dir() {
                continue;
            }
            let scope_digest = entry
                .file_name()
                .to_str()
                .filter(|value| is_digest(value))
                .ok_or(ToolIdempotencyError::CorruptJournal)?
                .to_string();
            let scope_dir = entry.path();
            let mut entries = tokio::fs::read_dir(&scope_dir)
                .await
                .map_err(|_| ToolIdempotencyError::Persistence)?;
            let mut started_keys = HashSet::new();
            let mut completed_keys = HashSet::new();
            while let Some(record_entry) = entries
                .next_entry()
                .await
                .map_err(|_| ToolIdempotencyError::Persistence)?
            {
                let name = record_entry
                    .file_name()
                    .to_str()
                    .ok_or(ToolIdempotencyError::CorruptJournal)?
                    .to_string();
                if name == ".operation-locks" || name.ends_with(".tmp") {
                    continue;
                }
                let record_metadata = tokio::fs::symlink_metadata(record_entry.path())
                    .await
                    .map_err(|_| ToolIdempotencyError::Persistence)?;
                if is_link_or_reparse_point(&record_metadata) || !record_metadata.is_file() {
                    return Err(ToolIdempotencyError::CorruptJournal);
                }
                if let Some(request_key) = name.strip_suffix(".started.json") {
                    if !is_digest(request_key) {
                        return Err(ToolIdempotencyError::CorruptJournal);
                    }
                    started_keys.insert(request_key.to_string());
                } else if let Some(request_key) = name.strip_suffix(".completed.json") {
                    if !is_digest(request_key) {
                        return Err(ToolIdempotencyError::CorruptJournal);
                    }
                    completed_keys.insert(request_key.to_string());
                }
            }
            if !completed_keys.is_subset(&started_keys) {
                return Err(ToolIdempotencyError::CorruptJournal);
            }

            for request_key in started_keys {
                let started_path = scope_dir.join(format!("{request_key}.started.json"));
                let started = read_record(&started_path).await?;
                if started.schema_version != JOURNAL_SCHEMA_VERSION || started.outcome.is_some() {
                    return Err(ToolIdempotencyError::CorruptJournal);
                }
                if !completed_keys.contains(&request_key) {
                    continue;
                }
                let completed_path = scope_dir.join(format!("{request_key}.completed.json"));
                let completed = read_record(&completed_path).await?;
                validate_record(
                    &completed,
                    &started.tool_name,
                    &started.argument_digest,
                    &started.operation_digest,
                )?;
                if completed.outcome.is_none() {
                    return Err(ToolIdempotencyError::CorruptJournal);
                }
                let expired = now
                    .signed_duration_since(completed.created_at)
                    .to_std()
                    .is_ok_and(|age| age >= self.policy.completed_retention);
                if !expired {
                    continue;
                }
                let started_bytes = tokio::fs::read(&started_path)
                    .await
                    .map_err(|_| ToolIdempotencyError::Persistence)?;
                let completed_bytes = tokio::fs::read(&completed_path)
                    .await
                    .map_err(|_| ToolIdempotencyError::Persistence)?;
                let mut hasher = Sha256::new();
                hasher.update(&started_bytes);
                hasher.update([0]);
                hasher.update(&completed_bytes);
                let digest = hasher.finalize();
                candidates.push(ToolIdempotencyCleanupCandidate {
                    scope_digest: scope_digest.clone(),
                    request_key,
                    bytes: u64::try_from(started_bytes.len().saturating_add(completed_bytes.len()))
                        .unwrap_or(u64::MAX),
                    fingerprint_sha256: encode_sha256(&digest),
                });
            }
        }
        candidates.sort_by(|left, right| {
            (&left.scope_digest, &left.request_key).cmp(&(&right.scope_digest, &right.request_key))
        });
        Ok(candidates)
    }
}

fn validate_input(input: &ToolIdempotencyInput) -> Result<(), ToolIdempotencyError> {
    let identifiers = [&input.session_id, &input.request_id, &input.tool_name];
    if identifiers
        .iter()
        .any(|value| value.is_empty() || value.len() > 512 || value.chars().any(char::is_control))
    {
        return Err(ToolIdempotencyError::InvalidInput);
    }
    Ok(())
}

struct BoundedSizeCounter {
    bytes: usize,
    limit: usize,
}

impl BoundedSizeCounter {
    fn new(limit: usize) -> Self {
        Self { bytes: 0, limit }
    }
}

impl std::io::Write for BoundedSizeCounter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next = self.bytes.saturating_add(buffer.len());
        if next > self.limit {
            return Err(std::io::Error::other("serialized value exceeds host limit"));
        }
        self.bytes = next;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn scope_digest(input: &ToolIdempotencyInput) -> String {
    let mut parts = vec![input.session_id.as_bytes(), b"\0"];
    if let Some(scope) = &input.task_scope {
        parts.extend([scope.run_id().as_bytes(), b"\0", scope.task_id().as_bytes()]);
    }
    digest_parts(&parts)
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().to_hex().to_string()
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn bounded_argument_digest(
    arguments: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, ToolArgumentDigestError> {
    let mut counter = BoundedSizeCounter::new(MAX_ARGUMENT_BYTES);
    serde_json::to_writer(&mut counter, arguments)
        .map_err(|_| ToolArgumentDigestError::TooLarge)?;
    let canonical = canonical_json(&Value::Object(arguments.clone()));
    Ok(digest_parts(&[canonical.as_bytes()]))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let members = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON object key serializes"),
                        canonical_json(&object[key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{members}}}")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).expect("JSON value serializes"),
    }
}

fn validate_record(
    record: &JournalRecord,
    tool_name: &str,
    argument_digest: &str,
    operation_digest: &str,
) -> Result<(), ToolIdempotencyError> {
    if record.schema_version != JOURNAL_SCHEMA_VERSION {
        return Err(ToolIdempotencyError::CorruptJournal);
    }
    if record.tool_name != tool_name
        || record.argument_digest != argument_digest
        || record.operation_digest != operation_digest
    {
        return Err(ToolIdempotencyError::IdentityConflict);
    }
    Ok(())
}

async fn read_record(path: &Path) -> Result<JournalRecord, ToolIdempotencyError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?;
    if is_link_or_reparse_point(&metadata)
        || !metadata.is_file()
        || metadata.len() > MAX_JOURNAL_RECORD_BYTES
    {
        return Err(ToolIdempotencyError::CorruptJournal);
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?;
    serde_json::from_slice(&bytes).map_err(|_| ToolIdempotencyError::CorruptJournal)
}

fn encode_sha256(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
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

async fn write_record_once(
    path: &Path,
    record: &JournalRecord,
) -> Result<(), ToolIdempotencyError> {
    let parent = path.parent().ok_or(ToolIdempotencyError::Persistence)?;
    ensure_directory_durable(parent).await?;
    let bytes = serde_json::to_vec(record).map_err(|_| ToolIdempotencyError::Persistence)?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(&temporary)
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?;
    use tokio::io::AsyncWriteExt;
    file.write_all(&bytes)
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?;
    file.sync_all()
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?;
    drop(file);
    // Publish without replacement. Unlike rename, hard_link fails atomically when another
    // process has already claimed this request path on Unix as well as Windows.
    if tokio::fs::hard_link(&temporary, path).await.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(ToolIdempotencyError::Persistence);
    }
    let published = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?;
    published
        .sync_all()
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?;
    sync_directory(parent).await?;
    let _ = tokio::fs::remove_file(&temporary).await;
    Ok(())
}

async fn try_acquire_operation_lock(
    scope_dir: &Path,
    operation_digest: &str,
) -> Result<Option<std::fs::File>, ToolIdempotencyError> {
    let lock_dir = scope_dir.join(".operation-locks");
    ensure_directory_durable(&lock_dir).await?;
    if !is_digest(operation_digest) {
        return Err(ToolIdempotencyError::InvalidInput);
    }
    let lock_path = lock_dir.join(format!("{operation_digest}.lock"));
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| ToolIdempotencyError::Persistence)?;
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(file)),
            Err(error) if operation_lock_is_contended(&error) => Ok(None),
            Err(_) => Err(ToolIdempotencyError::Persistence),
        }
    })
    .await
    .map_err(|_| ToolIdempotencyError::Persistence)?
}

fn operation_lock_is_contended(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // LockFileEx reports ERROR_LOCK_VIOLATION when another process owns the range.
        error.raw_os_error() == Some(33)
    }
    #[cfg(not(windows))]
    false
}

async fn ensure_directory_durable(path: &Path) -> Result<(), ToolIdempotencyError> {
    if path.exists() {
        return Ok(());
    }
    let parent = path.parent().ok_or(ToolIdempotencyError::Persistence)?;
    ensure_directory_durable_boxed(parent).await?;
    match tokio::fs::create_dir(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(ToolIdempotencyError::Persistence),
    }
    sync_directory(path).await?;
    sync_directory(parent).await
}

fn ensure_directory_durable_boxed(
    path: &Path,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(), ToolIdempotencyError>> + Send + '_>,
> {
    Box::pin(ensure_directory_durable(path))
}

async fn sync_directory(path: &Path) -> Result<(), ToolIdempotencyError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || sync_directory_blocking(&path))
        .await
        .map_err(|_| ToolIdempotencyError::Persistence)?
}

#[cfg(unix)]
fn sync_directory_blocking(path: &Path) -> Result<(), ToolIdempotencyError> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ToolIdempotencyError::Persistence)
}

#[cfg(windows)]
fn sync_directory_blocking(_path: &Path) -> Result<(), ToolIdempotencyError> {
    // Windows does not support FlushFileBuffers for directory handles. The published journal
    // file itself is flushed after CreateHardLink completes, which covers process crashes. A
    // sudden-power-loss durability claim is intentionally limited to Unix directory fsync.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_directory_blocking(_path: &Path) -> Result<(), ToolIdempotencyError> {
    Err(ToolIdempotencyError::Persistence)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(request_id: &str) -> ToolIdempotencyInput {
        ToolIdempotencyInput {
            session_id: "session-a".to_string(),
            task_scope: None,
            request_id: request_id.to_string(),
            tool_name: "git_commit".to_string(),
            arguments: serde_json::json!({ "message": "first" })
                .as_object()
                .unwrap()
                .clone(),
            explicit_user_confirmation: false,
        }
    }

    #[tokio::test]
    async fn completed_request_is_suppressed_after_store_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());

        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        store
            .complete(&claim, ToolIdempotencyOutcome::Success)
            .await
            .unwrap();
        drop(store);

        let reopened = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let decision = reopened.begin(input("request-a")).await.unwrap();

        assert!(matches!(
            decision,
            BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Success)
        ));
    }

    #[tokio::test]
    async fn explicit_completed_cleanup_preserves_unresolved_claims() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::with_policy(
            temp.path().to_path_buf(),
            ToolIdempotencyPolicy {
                max_records_per_scope: 10,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let BeginDecision::Execute(unresolved) = store.begin(input("unresolved")).await.unwrap()
        else {
            panic!("unresolved fixture must execute");
        };
        let mut completed_input = input("completed");
        completed_input.arguments = serde_json::json!({ "message": "completed" })
            .as_object()
            .unwrap()
            .clone();
        let BeginDecision::Execute(completed) = store.begin(completed_input).await.unwrap() else {
            panic!("completed fixture must execute");
        };
        store
            .complete(&completed, ToolIdempotencyOutcome::Success)
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
        let store = ToolIdempotencyStore::with_policy(
            temp.path().to_path_buf(),
            ToolIdempotencyPolicy {
                max_records_per_scope: 10,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let BeginDecision::Execute(claim) = store.begin(input("completed")).await.unwrap() else {
            panic!("completed fixture must execute");
        };
        store
            .complete(&claim, ToolIdempotencyOutcome::Success)
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
            Err(ToolIdempotencyCleanupError::StalePreview)
        ));
        assert!(claim.started_path.exists());
        assert!(claim.completed_path.exists());
    }

    #[tokio::test]
    async fn definite_non_execution_claim_can_be_abandoned_and_retried_after_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };

        store.abandon_definite(&claim).await.unwrap();
        drop(store);

        let reopened = ToolIdempotencyStore::new(temp.path().to_path_buf());
        assert!(matches!(
            reopened.begin(input("request-a")).await.unwrap(),
            BeginDecision::Execute(_)
        ));
    }

    #[tokio::test]
    async fn definite_abandon_rejects_a_completed_claim() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        store
            .complete(&claim, ToolIdempotencyOutcome::Success)
            .await
            .unwrap();

        assert_eq!(
            store.abandon_definite(&claim).await,
            Err(ToolIdempotencyError::IdentityConflict)
        );
        assert!(matches!(
            store.begin(input("request-a")).await.unwrap(),
            BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Success)
        ));
    }

    #[tokio::test]
    async fn active_request_cannot_execute_concurrently() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());

        let BeginDecision::Execute(_claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };

        assert!(matches!(
            store.begin(input("request-a")).await.unwrap(),
            BeginDecision::InFlight
        ));
    }

    #[tokio::test]
    async fn independent_stores_cannot_both_claim_the_same_request() {
        let temp = tempfile::tempdir().unwrap();
        let first = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let second = ToolIdempotencyStore::new(temp.path().to_path_buf());

        let (first_result, second_result) = tokio::join!(
            first.begin(input("request-a")),
            second.begin(input("request-a"))
        );
        let execute_count = [&first_result, &second_result]
            .into_iter()
            .filter(|result| matches!(result, Ok(BeginDecision::Execute(_))))
            .count();

        assert_eq!(execute_count, 1);
        assert!([first_result, second_result].into_iter().any(|result| {
            matches!(
                result,
                Ok(BeginDecision::InFlight | BeginDecision::Ambiguous)
                    | Err(ToolIdempotencyError::Persistence)
            )
        }));
    }

    #[tokio::test]
    async fn independent_stores_cannot_claim_the_same_operation_under_different_requests() {
        let temp = tempfile::tempdir().unwrap();
        let first = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let second = ToolIdempotencyStore::new(temp.path().to_path_buf());

        let (first_result, second_result) = tokio::join!(
            first.begin(input("request-a")),
            second.begin(input("request-b"))
        );
        let execute_count = [&first_result, &second_result]
            .into_iter()
            .filter(|result| matches!(result, Ok(BeginDecision::Execute(_))))
            .count();

        assert_eq!(execute_count, 1);
    }

    #[tokio::test]
    async fn independent_stores_do_not_confuse_distinct_operations_with_the_same_digest_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let first_store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let second_store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let first = input("request-a");
        let first_digest = operation_digest_for_test(&first);
        let mut second = input("request-b");
        for index in 0..10_000 {
            second.arguments = serde_json::json!({ "message": format!("candidate-{index}") })
                .as_object()
                .unwrap()
                .clone();
            let digest = operation_digest_for_test(&second);
            if digest.get(..2) == first_digest.get(..2) && digest != first_digest {
                break;
            }
        }
        let second_digest = operation_digest_for_test(&second);
        assert_ne!(second_digest, first_digest);
        assert_eq!(second_digest.get(..2), first_digest.get(..2));

        let (first_result, second_result) =
            tokio::join!(first_store.begin(first), second_store.begin(second));
        let execute_count = [&first_result, &second_result]
            .into_iter()
            .filter(|result| matches!(result, Ok(BeginDecision::Execute(_))))
            .count();

        assert_eq!(execute_count, 2);
    }

    #[tokio::test]
    async fn request_id_reuse_with_different_arguments_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(_claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        let mut conflicting = input("request-a");
        conflicting.arguments = serde_json::json!({ "message": "different" })
            .as_object()
            .unwrap()
            .clone();

        assert_eq!(
            store.begin(conflicting).await.err(),
            Some(ToolIdempotencyError::IdentityConflict)
        );
    }

    #[tokio::test]
    async fn completed_error_is_suppressed_without_becoming_success() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        store
            .complete(&claim, ToolIdempotencyOutcome::Error)
            .await
            .unwrap();

        assert!(matches!(
            store.begin(input("request-a")).await.unwrap(),
            BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Error)
        ));
    }

    #[tokio::test]
    async fn stale_started_operation_blocks_a_new_automatic_request() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        drop(claim);
        drop(store);

        let reopened = ToolIdempotencyStore::new(temp.path().to_path_buf());

        assert!(matches!(
            reopened.begin(input("request-b")).await.unwrap(),
            BeginDecision::Ambiguous
        ));
    }

    #[tokio::test]
    async fn explicit_takeover_resolves_the_stale_claim_after_completion() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(stale_claim) = store.begin(input("request-a")).await.unwrap()
        else {
            panic!("first invocation must execute");
        };
        drop(stale_claim);
        drop(store);

        let reopened = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let mut confirmed = input("request-b");
        confirmed.explicit_user_confirmation = true;
        let BeginDecision::Execute(replacement_claim) = reopened.begin(confirmed).await.unwrap()
        else {
            panic!("explicit confirmation must create one replacement claim");
        };
        reopened
            .complete(&replacement_claim, ToolIdempotencyOutcome::Success)
            .await
            .unwrap();

        assert!(matches!(
            reopened.begin(input("request-c")).await.unwrap(),
            BeginDecision::Execute(_)
        ));
    }

    #[tokio::test]
    async fn explicit_takeover_rejects_a_started_record_that_already_has_an_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        let mut corrupt = claim.record.clone();
        corrupt.outcome = Some(ToolIdempotencyOutcome::Success);
        std::fs::write(&claim.started_path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        drop(claim);
        let mut takeover = input("request-b");
        takeover.explicit_user_confirmation = true;

        assert_eq!(
            store.begin(takeover).await.err(),
            Some(ToolIdempotencyError::CorruptJournal)
        );
    }

    #[tokio::test]
    async fn completed_retention_starts_when_the_outcome_is_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::with_policy(
            temp.path().to_path_buf(),
            ToolIdempotencyPolicy {
                max_records_per_scope: 1,
                completed_retention: std::time::Duration::from_secs(30 * 24 * 60 * 60),
            },
        );
        let BeginDecision::Execute(mut claim) = store.begin(input("request-a")).await.unwrap()
        else {
            panic!("first invocation must execute");
        };
        claim.record.created_at = chrono::Utc::now() - chrono::Duration::days(31);
        store
            .complete(&claim, ToolIdempotencyOutcome::Success)
            .await
            .unwrap();
        let mut different_operation = input("request-b");
        different_operation.arguments = serde_json::json!({ "message": "second" })
            .as_object()
            .unwrap()
            .clone();

        assert_eq!(
            store.begin(different_operation).await.err(),
            Some(ToolIdempotencyError::Capacity)
        );
    }

    #[tokio::test]
    async fn takeover_uncertain_retention_starts_when_the_takeover_is_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::with_policy(
            temp.path().to_path_buf(),
            ToolIdempotencyPolicy {
                max_records_per_scope: 3,
                completed_retention: std::time::Duration::from_secs(30 * 24 * 60 * 60),
            },
        );
        let BeginDecision::Execute(stale_claim) = store.begin(input("request-a")).await.unwrap()
        else {
            panic!("first invocation must execute");
        };
        let stale_path = stale_claim.started_path.clone();
        let mut stale_record = stale_claim.record.clone();
        stale_record.created_at = chrono::Utc::now() - chrono::Duration::days(31);
        drop(stale_claim);
        std::fs::write(stale_path, serde_json::to_vec(&stale_record).unwrap()).unwrap();

        let mut takeover = input("request-b");
        takeover.explicit_user_confirmation = true;
        let BeginDecision::Execute(takeover_claim) = store.begin(takeover).await.unwrap() else {
            panic!("explicit confirmation must take over the stale operation");
        };
        store
            .complete(&takeover_claim, ToolIdempotencyOutcome::Success)
            .await
            .unwrap();

        let mut third = input("request-c");
        third.arguments = serde_json::json!({ "message": "different-operation" })
            .as_object()
            .unwrap()
            .clone();
        let BeginDecision::Execute(third_claim) = store.begin(third).await.unwrap() else {
            panic!("a different operation should trigger cleanup and execute");
        };
        drop(third_claim);

        assert!(matches!(
            store.begin(input("request-a")).await.unwrap(),
            BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Uncertain)
        ));
    }

    fn operation_digest_for_test(input: &ToolIdempotencyInput) -> String {
        let arguments = canonical_json(&Value::Object(input.arguments.clone()));
        let argument_digest = digest_parts(&[arguments.as_bytes()]);
        digest_parts(&[
            input.tool_name.as_bytes(),
            b"\0",
            argument_digest.as_bytes(),
        ])
    }

    #[tokio::test]
    async fn explicit_confirmation_cannot_take_over_an_active_operation() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(_active_claim) = store.begin(input("request-a")).await.unwrap()
        else {
            panic!("first invocation must execute");
        };
        let mut confirmed = input("request-b");
        confirmed.explicit_user_confirmation = true;

        assert!(matches!(
            store.begin(confirmed).await.unwrap(),
            BeginDecision::InFlight
        ));
    }

    #[tokio::test]
    async fn completed_old_operation_does_not_block_a_legitimate_new_request() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        store
            .complete(&claim, ToolIdempotencyOutcome::Success)
            .await
            .unwrap();

        assert!(matches!(
            store.begin(input("request-b")).await.unwrap(),
            BeginDecision::Execute(_)
        ));
    }

    #[tokio::test]
    async fn unresolved_records_exhaust_capacity_before_a_new_claim_is_created() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::with_policy(
            temp.path().to_path_buf(),
            ToolIdempotencyPolicy {
                max_records_per_scope: 1,
                completed_retention: std::time::Duration::from_secs(30 * 24 * 60 * 60),
            },
        );
        let BeginDecision::Execute(_claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        let mut different_operation = input("request-b");
        different_operation.arguments = serde_json::json!({ "message": "second" })
            .as_object()
            .unwrap()
            .clone();

        assert_eq!(
            store.begin(different_operation).await.err(),
            Some(ToolIdempotencyError::Capacity)
        );
    }

    #[tokio::test]
    async fn oversized_arguments_are_rejected_before_any_journal_write() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let mut oversized = input("request-a");
        oversized.arguments = serde_json::json!({ "message": "x".repeat(1_048_577) })
            .as_object()
            .unwrap()
            .clone();

        assert_eq!(
            store.begin(oversized).await.err(),
            Some(ToolIdempotencyError::InvalidInput)
        );
        assert!(!temp.path().join("tool-idempotency-v1").exists());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn journal_never_contains_plaintext_scope_request_or_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(_claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        let journal = std::fs::read_to_string(journal_files(temp.path())[0].clone()).unwrap();

        assert!(!journal.contains("session-a"));
        assert!(!journal.contains("request-a"));
        assert!(!journal.contains("first"));
        assert!(journal.contains("git_commit"));
    }

    #[tokio::test]
    async fn corrupt_journal_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        drop(claim);
        std::fs::write(&journal_files(temp.path())[0], b"not-json").unwrap();
        drop(store);

        let reopened = ToolIdempotencyStore::new(temp.path().to_path_buf());
        assert_eq!(
            reopened.begin(input("request-a")).await.err(),
            Some(ToolIdempotencyError::CorruptJournal)
        );
    }

    #[tokio::test]
    async fn orphaned_completed_record_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        let scope_dir = claim.started_path.parent().unwrap().to_path_buf();
        std::fs::write(
            scope_dir.join("orphan.completed.json"),
            serde_json::to_vec(&JournalRecord {
                schema_version: JOURNAL_SCHEMA_VERSION,
                tool_name: "git_commit".to_string(),
                argument_digest: "orphan-argument".to_string(),
                operation_digest: "orphan-operation".to_string(),
                created_at: chrono::Utc::now(),
                outcome: Some(ToolIdempotencyOutcome::Success),
            })
            .unwrap(),
        )
        .unwrap();
        drop(claim);
        let mut different_operation = input("request-b");
        different_operation.arguments = serde_json::json!({ "message": "second" })
            .as_object()
            .unwrap()
            .clone();

        assert_eq!(
            store.begin(different_operation).await.err(),
            Some(ToolIdempotencyError::CorruptJournal)
        );
    }

    #[tokio::test]
    async fn oversized_journal_record_fails_closed_before_reading_it() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        drop(claim);
        std::fs::write(
            &journal_files(temp.path())[0],
            vec![b'x'; MAX_JOURNAL_RECORD_BYTES as usize + 1],
        )
        .unwrap();
        drop(store);

        let reopened = ToolIdempotencyStore::new(temp.path().to_path_buf());
        assert_eq!(
            reopened.begin(input("request-a")).await.err(),
            Some(ToolIdempotencyError::CorruptJournal)
        );
    }

    #[tokio::test]
    async fn expired_completed_record_is_cleaned_without_removing_unresolved_records() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::with_policy(
            temp.path().to_path_buf(),
            ToolIdempotencyPolicy {
                max_records_per_scope: 1,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let BeginDecision::Execute(claim) = store.begin(input("request-a")).await.unwrap() else {
            panic!("first invocation must execute");
        };
        store
            .complete(&claim, ToolIdempotencyOutcome::Success)
            .await
            .unwrap();
        let mut different_operation = input("request-b");
        different_operation.arguments = serde_json::json!({ "message": "second" })
            .as_object()
            .unwrap()
            .clone();

        assert!(matches!(
            store.begin(different_operation).await.unwrap(),
            BeginDecision::Execute(_)
        ));
        assert_eq!(
            journal_files(temp.path())
                .into_iter()
                .filter(|path| path.to_string_lossy().ends_with(".started.json"))
                .count(),
            1
        );
    }

    fn journal_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        for scope in std::fs::read_dir(root).unwrap() {
            let scope = scope.unwrap();
            if !scope.path().is_dir() {
                continue;
            }
            files.extend(
                std::fs::read_dir(scope.path())
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .filter(|path| path.is_file() && path.to_string_lossy().ends_with(".json")),
            );
        }
        files.sort();
        files
    }
}
