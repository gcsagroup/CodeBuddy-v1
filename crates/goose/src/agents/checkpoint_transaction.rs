use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const CHECKPOINT_SCHEMA_VERSION: u16 = 1;
const COMMIT_MARKER: &str = "COMMITTED";
const PUBLISH_MARKER: &str = "PUBLISHED";
const RESTORE_MARKER: &str = "RESTORED";
const RESTORE_COMMIT_MARKER: &str = "RESTORE_COMMITTED";
const RESTORE_JOURNAL_DIR: &str = ".restore-prepare";
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointApproval {
    pub scope: String,
    pub granted_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointFileSnapshot {
    pub relative_path: String,
    pub before: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct CheckpointPrepareRequest {
    pub run_id: String,
    pub checkpoint_id: String,
    pub workspace: PathBuf,
    pub state_json: Vec<u8>,
    pub budget_json: Vec<u8>,
    pub plan_revision: u32,
    pub event_sequence: u64,
    pub approvals: Vec<CheckpointApproval>,
    pub required_approval_scope: Option<String>,
    pub files: Vec<CheckpointFileSnapshot>,
}

#[derive(Debug, Clone)]
pub struct CheckpointRestoreRequest {
    pub run_id: String,
    pub checkpoint_id: String,
    pub workspace: PathBuf,
    pub required_scope: String,
    pub plan_revision: u32,
    pub event_sequence: u64,
    pub now: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointWriteStage {
    StateWritten,
    UndoWritten,
    ApprovalsWritten,
    ManifestWritten,
    CommitMarkerWritten,
    Published,
    RestoreJournalWritten,
    RestoreFileWritten(usize),
    RestoreStateWritten,
    RestoreCommitMarkerWritten,
    RestorePublished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointRestoreOutcome {
    Restored {
        checkpoint_id: String,
    },
    AlreadyRestored {
        checkpoint_id: String,
    },
    NeedsReview {
        checkpoint_id: String,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRecoveryReport {
    pub published: usize,
    pub discarded_uncommitted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointManifest {
    schema_version: u16,
    run_id: String,
    checkpoint_id: String,
    workspace_identity: String,
    plan_revision: u32,
    event_sequence: u64,
    state_blake3: String,
    budget_blake3: String,
    approvals_blake3: String,
    #[serde(default)]
    required_approval_scope: Option<String>,
    files: Vec<CheckpointFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointFileEntry {
    relative_path: String,
    before_blob: Option<String>,
    before_blake3: Option<String>,
    expected_current_blake3: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RestoreJournal {
    files: Vec<RestoreJournalFile>,
    previous_state_blob: Option<String>,
    previous_budget_blob: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RestoreJournalFile {
    relative_path: String,
    current_blob: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CheckpointTransactionStore {
    root: PathBuf,
}

impl CheckpointTransactionStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn prepare_and_publish(
        &self,
        request: CheckpointPrepareRequest,
    ) -> Result<PathBuf, String> {
        self.prepare_and_publish_with_hook(request, |_| Ok::<_, &'static str>(()))
    }

    pub fn prepare_and_publish_with_hook<F, E>(
        &self,
        request: CheckpointPrepareRequest,
        mut hook: F,
    ) -> Result<PathBuf, String>
    where
        F: FnMut(CheckpointWriteStage) -> Result<(), E>,
        E: std::fmt::Display,
    {
        validate_identifier("run_id", &request.run_id)?;
        validate_identifier("checkpoint_id", &request.checkpoint_id)?;
        if request.plan_revision == 0 || request.event_sequence == 0 {
            return Err("checkpoint plan revision and event sequence must be non-zero".to_string());
        }
        let workspace = canonical_workspace(&request.workspace)?;
        let workspace_identity = workspace_identity(&workspace);
        let run_root = self.run_root(&request.run_id);
        let checkpoints = run_root.join("checkpoints");
        std::fs::create_dir_all(&checkpoints).map_err(display_error)?;
        let prepare = checkpoints.join(format!(".prepare-{}", request.checkpoint_id));
        let published = checkpoints.join(&request.checkpoint_id);
        if published.join(PUBLISH_MARKER).is_file() {
            return Ok(published);
        }
        if prepare.exists() {
            return Err(format!(
                "checkpoint prepare directory already exists: {}",
                prepare.display()
            ));
        }
        std::fs::create_dir(&prepare).map_err(display_error)?;

        write_synced(&prepare.join("state.json"), &request.state_json)?;
        write_synced(&prepare.join("budget.json"), &request.budget_json)?;
        hook(CheckpointWriteStage::StateWritten).map_err(|error| error.to_string())?;

        let undo_files = prepare.join("undo").join("files");
        std::fs::create_dir_all(&undo_files).map_err(display_error)?;
        let mut entries = Vec::with_capacity(request.files.len());
        for (index, snapshot) in request.files.iter().enumerate() {
            let target = safe_workspace_target(&workspace, &snapshot.relative_path)?;
            let current = read_optional_file(&target)?;
            let (before_blob, before_blake3) = match snapshot.before.as_deref() {
                Some(bytes) => {
                    let name = format!("{index}.bin");
                    write_synced(&undo_files.join(&name), bytes)?;
                    (Some(name), Some(digest(bytes)))
                }
                None => (None, None),
            };
            entries.push(CheckpointFileEntry {
                relative_path: snapshot.relative_path.clone(),
                before_blob,
                before_blake3,
                expected_current_blake3: current.as_deref().map(digest),
            });
        }
        hook(CheckpointWriteStage::UndoWritten).map_err(|error| error.to_string())?;

        let approvals_json =
            serde_json::to_vec_pretty(&request.approvals).map_err(display_error)?;
        write_synced(&prepare.join("approvals.json"), &approvals_json)?;
        hook(CheckpointWriteStage::ApprovalsWritten).map_err(|error| error.to_string())?;

        let manifest = CheckpointManifest {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            run_id: request.run_id.clone(),
            checkpoint_id: request.checkpoint_id.clone(),
            workspace_identity,
            plan_revision: request.plan_revision,
            event_sequence: request.event_sequence,
            state_blake3: digest(&request.state_json),
            budget_blake3: digest(&request.budget_json),
            approvals_blake3: digest(&approvals_json),
            required_approval_scope: request.required_approval_scope,
            files: entries,
        };
        let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(display_error)?;
        write_synced(&prepare.join(MANIFEST_FILE), &manifest_json)?;
        hook(CheckpointWriteStage::ManifestWritten).map_err(|error| error.to_string())?;

        create_marker(&prepare.join(COMMIT_MARKER))?;
        hook(CheckpointWriteStage::CommitMarkerWritten).map_err(|error| error.to_string())?;
        std::fs::rename(&prepare, &published).map_err(display_error)?;
        create_marker(&published.join(PUBLISH_MARKER))?;
        self.publish_latest(&request.run_id, &request.checkpoint_id)?;
        hook(CheckpointWriteStage::Published).map_err(|error| error.to_string())?;
        Ok(published)
    }

    pub fn published_checkpoint(&self, run_id: &str, checkpoint_id: &str) -> Option<PathBuf> {
        if validate_identifier("run_id", run_id).is_err()
            || validate_identifier("checkpoint_id", checkpoint_id).is_err()
        {
            return None;
        }
        let path = self
            .run_root(run_id)
            .join("checkpoints")
            .join(checkpoint_id);
        path.join(PUBLISH_MARKER).is_file().then_some(path)
    }

    pub fn latest_checkpoint_id(&self, run_id: &str) -> Result<Option<String>, String> {
        validate_identifier("run_id", run_id)?;
        let path = self.run_root(run_id).join("LATEST");
        let value = match std::fs::read_to_string(path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(display_error(error)),
        };
        let checkpoint_id = value.trim();
        validate_identifier("checkpoint_id", checkpoint_id)?;
        if self.published_checkpoint(run_id, checkpoint_id).is_none() {
            return Err("latest checkpoint is not published".to_string());
        }
        Ok(Some(checkpoint_id.to_string()))
    }

    pub(crate) fn verified_published_state(
        &self,
        run_id: &str,
        checkpoint_id: &str,
        workspace: &Path,
    ) -> Result<(Vec<u8>, u32, u64), String> {
        validate_identifier("run_id", run_id)?;
        validate_identifier("checkpoint_id", checkpoint_id)?;
        let path = self
            .run_root(run_id)
            .join("checkpoints")
            .join(checkpoint_id);
        for marker in [COMMIT_MARKER, PUBLISH_MARKER] {
            if !std::fs::metadata(path.join(marker))
                .map_err(display_error)?
                .is_file()
            {
                return Err("checkpoint is not committed and published".to_string());
            }
        }
        let workspace = canonical_workspace(workspace)?;
        let manifest = read_manifest(&path)?;
        if manifest.run_id != run_id
            || manifest.checkpoint_id != checkpoint_id
            || manifest.workspace_identity != workspace_identity(&workspace)
            || manifest.plan_revision == 0
            || manifest.event_sequence == 0
        {
            return Err(
                "checkpoint run/checkpoint/workspace/plan/event identity mismatch".to_string(),
            );
        }
        validate_checkpoint_files(&path, &manifest)?;
        let state = std::fs::read(path.join("state.json")).map_err(display_error)?;
        if digest(&state) != manifest.state_blake3 {
            return Err("checkpoint state digest validation failed".to_string());
        }
        Ok((state, manifest.plan_revision, manifest.event_sequence))
    }

    pub fn restored_state_json(&self, run_id: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(checkpoint_id) = self.latest_checkpoint_id(run_id)? else {
            return Ok(None);
        };
        let checkpoint = self
            .published_checkpoint(run_id, &checkpoint_id)
            .ok_or_else(|| "restored checkpoint is not published".to_string())?;
        if !checkpoint.join(RESTORE_MARKER).is_file() {
            return Ok(None);
        }
        let state_path = self.run_root(run_id).join("restored-state.json");
        std::fs::read(state_path).map(Some).map_err(display_error)
    }

    pub fn recover(&self, run_id: &str) -> Result<CheckpointRecoveryReport, String> {
        validate_identifier("run_id", run_id)?;
        let checkpoints = self.run_root(run_id).join("checkpoints");
        if !checkpoints.exists() {
            return Ok(CheckpointRecoveryReport {
                published: 0,
                discarded_uncommitted: 0,
            });
        }
        let mut report = CheckpointRecoveryReport {
            published: 0,
            discarded_uncommitted: 0,
        };
        for entry in std::fs::read_dir(&checkpoints).map_err(display_error)? {
            let path = entry.map_err(display_error)?.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(checkpoint_id) = name.strip_prefix(".prepare-") else {
                continue;
            };
            if !path.join(COMMIT_MARKER).is_file() {
                report.discarded_uncommitted += 1;
                continue;
            }
            let manifest = read_manifest(&path)?;
            if manifest.run_id != run_id || manifest.checkpoint_id != checkpoint_id {
                return Err("committed checkpoint prepare identity mismatch".to_string());
            }
            validate_checkpoint_files(&path, &manifest)?;
            let published = checkpoints.join(checkpoint_id);
            if published.exists() {
                return Err("committed checkpoint destination already exists".to_string());
            }
            std::fs::rename(&path, &published).map_err(display_error)?;
            create_marker(&published.join(PUBLISH_MARKER))?;
            self.publish_latest(run_id, checkpoint_id)?;
            report.published += 1;
        }
        Ok(report)
    }

    pub fn restore(
        &self,
        request: CheckpointRestoreRequest,
    ) -> Result<CheckpointRestoreOutcome, String> {
        self.restore_with_hook(request, |_| Ok::<_, &'static str>(()))
    }

    pub fn restore_with_hook<F, E>(
        &self,
        request: CheckpointRestoreRequest,
        mut hook: F,
    ) -> Result<CheckpointRestoreOutcome, String>
    where
        F: FnMut(CheckpointWriteStage) -> Result<(), E>,
        E: std::fmt::Display,
    {
        let needs_review = |reason: String| CheckpointRestoreOutcome::NeedsReview {
            checkpoint_id: request.checkpoint_id.clone(),
            reason,
        };
        if validate_identifier("run_id", &request.run_id).is_err()
            || validate_identifier("checkpoint_id", &request.checkpoint_id).is_err()
        {
            return Ok(needs_review(
                "invalid run or checkpoint identity".to_string(),
            ));
        }
        let Some(path) = self.published_checkpoint(&request.run_id, &request.checkpoint_id) else {
            return Ok(needs_review(
                "checkpoint is not committed and published".to_string(),
            ));
        };
        let workspace = match canonical_workspace(&request.workspace) {
            Ok(workspace) => workspace,
            Err(error) => return Ok(needs_review(error)),
        };
        let manifest = match read_manifest(&path) {
            Ok(manifest) => manifest,
            Err(error) => return Ok(needs_review(error)),
        };
        if manifest.run_id != request.run_id
            || manifest.checkpoint_id != request.checkpoint_id
            || manifest.workspace_identity != workspace_identity(&workspace)
            || manifest.plan_revision != request.plan_revision
            || manifest.event_sequence != request.event_sequence
        {
            return Ok(needs_review(
                "run/checkpoint/workspace/plan/event identity validation failed".to_string(),
            ));
        }
        if path.join(RESTORE_COMMIT_MARKER).is_file() {
            if !path.join(RESTORE_MARKER).is_file() {
                create_marker(&path.join(RESTORE_MARKER))?;
            }
            remove_restore_journal(&path)?;
            return Ok(CheckpointRestoreOutcome::AlreadyRestored {
                checkpoint_id: request.checkpoint_id,
            });
        }
        if path.join(RESTORE_MARKER).is_file() {
            return Ok(CheckpointRestoreOutcome::AlreadyRestored {
                checkpoint_id: request.checkpoint_id,
            });
        }
        if path.join(RESTORE_JOURNAL_DIR).exists() {
            if let Err(error) =
                rollback_restore_journal(&path, &workspace, &self.run_root(&request.run_id))
            {
                return Ok(needs_review(format!(
                    "incomplete restore rollback requires review: {error}"
                )));
            }
        }
        if let Err(error) = validate_checkpoint_files(&path, &manifest) {
            return Ok(needs_review(error));
        }
        let approvals: Vec<CheckpointApproval> =
            match read_hashed_json(&path.join("approvals.json"), &manifest.approvals_blake3) {
                Ok(approvals) => approvals,
                Err(error) => return Ok(needs_review(error)),
            };
        let required_scope = manifest
            .required_approval_scope
            .as_deref()
            .unwrap_or(request.required_scope.as_str());
        if !request.required_scope.is_empty() && request.required_scope != required_scope {
            return Ok(needs_review(
                "requested approval scope does not match checkpoint manifest".to_string(),
            ));
        }
        if !required_scope.is_empty()
            && !approvals.iter().any(|approval| {
                approval.scope == required_scope
                    && approval.granted_at <= request.now
                    && approval.expires_at > request.now
            })
        {
            return Ok(needs_review(
                "approval scope is missing, not yet valid, or expired".to_string(),
            ));
        }
        for entry in &manifest.files {
            let target = match safe_workspace_target(&workspace, &entry.relative_path) {
                Ok(target) => target,
                Err(error) => return Ok(needs_review(error)),
            };
            let current = match read_optional_file(&target) {
                Ok(current) => current,
                Err(error) => return Ok(needs_review(error)),
            };
            if current.as_deref().map(digest) != entry.expected_current_blake3 {
                return Ok(needs_review(format!(
                    "workspace file drifted after checkpoint: {}",
                    entry.relative_path
                )));
            }
        }

        let state = std::fs::read(path.join("state.json")).map_err(display_error)?;
        let budget = std::fs::read(path.join("budget.json")).map_err(display_error)?;
        if digest(&state) != manifest.state_blake3 || digest(&budget) != manifest.budget_blake3 {
            return Ok(needs_review(
                "checkpoint state or budget digest mismatch".to_string(),
            ));
        }
        let restored_state = self.run_root(&request.run_id).join("restored-state.json");
        let restored_budget = self.run_root(&request.run_id).join("restored-budget.json");
        if let Err(error) = prepare_restore_journal(
            &path,
            &workspace,
            &manifest,
            &restored_state,
            &restored_budget,
        ) {
            return Ok(needs_review(format!(
                "restore journal preparation failed: {error}"
            )));
        }
        hook(CheckpointWriteStage::RestoreJournalWritten).map_err(|error| error.to_string())?;

        for (index, entry) in manifest.files.iter().enumerate() {
            let target = safe_workspace_target(&workspace, &entry.relative_path)?;
            let before = match entry.before_blob.as_deref() {
                Some(blob) => {
                    Some(std::fs::read(path.join("undo/files").join(blob)).map_err(display_error)?)
                }
                None => None,
            };
            if let Err(error) = write_optional_file_atomic(&target, before.as_deref()) {
                let _ =
                    rollback_restore_journal(&path, &workspace, &self.run_root(&request.run_id));
                return Ok(needs_review(format!(
                    "checkpoint restore failed and was rolled back: {error}"
                )));
            }
            hook(CheckpointWriteStage::RestoreFileWritten(index))
                .map_err(|error| error.to_string())?;
        }
        if let Err(error) = write_synced(&restored_state, &state)
            .and_then(|_| write_synced(&restored_budget, &budget))
        {
            let _ = rollback_restore_journal(&path, &workspace, &self.run_root(&request.run_id));
            return Ok(needs_review(format!(
                "checkpoint state publish failed and file restore was rolled back: {error}"
            )));
        }
        hook(CheckpointWriteStage::RestoreStateWritten).map_err(|error| error.to_string())?;
        create_marker(&path.join(RESTORE_COMMIT_MARKER))?;
        hook(CheckpointWriteStage::RestoreCommitMarkerWritten)
            .map_err(|error| error.to_string())?;
        create_marker(&path.join(RESTORE_MARKER))?;
        hook(CheckpointWriteStage::RestorePublished).map_err(|error| error.to_string())?;
        remove_restore_journal(&path)?;
        Ok(CheckpointRestoreOutcome::Restored {
            checkpoint_id: request.checkpoint_id,
        })
    }

    fn run_root(&self, run_id: &str) -> PathBuf {
        self.root.join(run_id)
    }

    fn publish_latest(&self, run_id: &str, checkpoint_id: &str) -> Result<(), String> {
        let path = self.run_root(run_id).join("LATEST");
        let temporary = path.with_extension("tmp");
        write_synced(&temporary, checkpoint_id.as_bytes())?;
        std::fs::rename(temporary, path).map_err(display_error)
    }
}

fn validate_identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("invalid {name}"));
    }
    Ok(())
}

fn canonical_workspace(path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(display_error)?;
    if !canonical.is_dir() {
        return Err("checkpoint workspace is not a directory".to_string());
    }
    Ok(canonical)
}

fn workspace_identity(path: &Path) -> String {
    digest(path.to_string_lossy().as_bytes())
}

fn safe_workspace_target(workspace: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe checkpoint file path: {relative}"));
    }
    Ok(workspace.join(path))
}

fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(display_error(error)),
    }
}

fn write_optional_file_atomic(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    match bytes {
        Some(bytes) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(display_error)?;
            }
            write_synced(path, bytes)
        }
        None if path.exists() => std::fs::remove_file(path).map_err(display_error),
        None => Ok(()),
    }
}

fn prepare_restore_journal(
    checkpoint: &Path,
    workspace: &Path,
    manifest: &CheckpointManifest,
    restored_state: &Path,
    restored_budget: &Path,
) -> Result<(), String> {
    let journal_dir = checkpoint.join(RESTORE_JOURNAL_DIR);
    if journal_dir.exists() {
        return Err("restore journal already exists".to_string());
    }
    let files_dir = journal_dir.join("files");
    std::fs::create_dir_all(&files_dir).map_err(display_error)?;
    let mut files = Vec::with_capacity(manifest.files.len());
    for (index, entry) in manifest.files.iter().enumerate() {
        let target = safe_workspace_target(workspace, &entry.relative_path)?;
        let current = read_optional_file(&target)?;
        let current_blob = match current.as_deref() {
            Some(bytes) => {
                let name = format!("{index}.bin");
                write_synced(&files_dir.join(&name), bytes)?;
                Some(name)
            }
            None => None,
        };
        files.push(RestoreJournalFile {
            relative_path: entry.relative_path.clone(),
            current_blob,
        });
    }
    let previous_state_blob =
        snapshot_restore_output(&journal_dir, "state-before.bin", restored_state)?;
    let previous_budget_blob =
        snapshot_restore_output(&journal_dir, "budget-before.bin", restored_budget)?;
    let journal = RestoreJournal {
        files,
        previous_state_blob,
        previous_budget_blob,
    };
    write_synced(
        &journal_dir.join("journal.json"),
        &serde_json::to_vec_pretty(&journal).map_err(display_error)?,
    )?;
    create_marker(&journal_dir.join("PREPARED"))
}

fn snapshot_restore_output(
    journal_dir: &Path,
    blob_name: &str,
    source: &Path,
) -> Result<Option<String>, String> {
    match read_optional_file(source)? {
        Some(bytes) => {
            write_synced(&journal_dir.join(blob_name), &bytes)?;
            Ok(Some(blob_name.to_string()))
        }
        None => Ok(None),
    }
}

fn rollback_restore_journal(
    checkpoint: &Path,
    workspace: &Path,
    run_root: &Path,
) -> Result<(), String> {
    let journal_dir = checkpoint.join(RESTORE_JOURNAL_DIR);
    let journal: RestoreJournal = serde_json::from_slice(
        &std::fs::read(journal_dir.join("journal.json")).map_err(display_error)?,
    )
    .map_err(display_error)?;
    for entry in &journal.files {
        let target = safe_workspace_target(workspace, &entry.relative_path)?;
        let bytes = match entry.current_blob.as_deref() {
            Some(blob) => {
                Some(std::fs::read(journal_dir.join("files").join(blob)).map_err(display_error)?)
            }
            None => None,
        };
        write_optional_file_atomic(&target, bytes.as_deref())?;
    }
    restore_output_from_journal(
        &journal_dir,
        journal.previous_state_blob.as_deref(),
        &run_root.join("restored-state.json"),
    )?;
    restore_output_from_journal(
        &journal_dir,
        journal.previous_budget_blob.as_deref(),
        &run_root.join("restored-budget.json"),
    )?;
    remove_restore_journal(checkpoint)
}

fn restore_output_from_journal(
    journal_dir: &Path,
    blob: Option<&str>,
    target: &Path,
) -> Result<(), String> {
    let bytes = match blob {
        Some(blob) => Some(std::fs::read(journal_dir.join(blob)).map_err(display_error)?),
        None => None,
    };
    write_optional_file_atomic(target, bytes.as_deref())
}

fn remove_restore_journal(checkpoint: &Path) -> Result<(), String> {
    let journal = checkpoint.join(RESTORE_JOURNAL_DIR);
    if journal.exists() {
        std::fs::remove_dir_all(journal).map_err(display_error)?;
    }
    Ok(())
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(display_error)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(display_error)?;
    file.write_all(bytes).map_err(display_error)?;
    file.flush().map_err(display_error)?;
    file.sync_all().map_err(display_error)
}

fn create_marker(path: &Path) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(display_error)?;
    file.write_all(b"durable\n").map_err(display_error)?;
    file.flush().map_err(display_error)?;
    file.sync_all().map_err(display_error)
}

fn read_manifest(path: &Path) -> Result<CheckpointManifest, String> {
    let bytes = std::fs::read(path.join(MANIFEST_FILE)).map_err(display_error)?;
    let manifest: CheckpointManifest = serde_json::from_slice(&bytes).map_err(display_error)?;
    if manifest.schema_version != CHECKPOINT_SCHEMA_VERSION {
        return Err("unsupported checkpoint manifest version".to_string());
    }
    Ok(manifest)
}

fn validate_checkpoint_files(path: &Path, manifest: &CheckpointManifest) -> Result<(), String> {
    let state = std::fs::read(path.join("state.json")).map_err(display_error)?;
    let budget = std::fs::read(path.join("budget.json")).map_err(display_error)?;
    let approvals = std::fs::read(path.join("approvals.json")).map_err(display_error)?;
    if digest(&state) != manifest.state_blake3
        || digest(&budget) != manifest.budget_blake3
        || digest(&approvals) != manifest.approvals_blake3
    {
        return Err("checkpoint transaction digest validation failed".to_string());
    }
    for entry in &manifest.files {
        if let Some(blob) = entry.before_blob.as_deref() {
            let bytes = std::fs::read(path.join("undo/files").join(blob)).map_err(display_error)?;
            if Some(digest(&bytes)) != entry.before_blake3 {
                return Err(format!(
                    "checkpoint undo digest mismatch: {}",
                    entry.relative_path
                ));
            }
        } else if entry.before_blake3.is_some() {
            return Err("checkpoint undo manifest is inconsistent".to_string());
        }
    }
    Ok(())
}

fn read_hashed_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    expected: &str,
) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(display_error)?;
    if digest(&bytes) != expected {
        return Err("checkpoint JSON digest mismatch".to_string());
    }
    serde_json::from_slice(&bytes).map_err(display_error)
}

fn digest(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};

    fn request(workspace: &std::path::Path, checkpoint_id: &str) -> CheckpointPrepareRequest {
        CheckpointPrepareRequest {
            run_id: "run-checkpoint".to_string(),
            checkpoint_id: checkpoint_id.to_string(),
            workspace: workspace.to_path_buf(),
            state_json: br#"{"status":"waiting_for_user"}"#.to_vec(),
            budget_json: br#"{"turns":3}"#.to_vec(),
            plan_revision: 3,
            event_sequence: 42,
            approvals: vec![CheckpointApproval {
                scope: "src/**".to_string(),
                granted_at: Utc::now() - Duration::minutes(1),
                expires_at: Utc::now() + Duration::minutes(30),
            }],
            required_approval_scope: Some("src/**".to_string()),
            files: vec![CheckpointFileSnapshot {
                relative_path: "src/value.txt".to_string(),
                before: Some(b"before\n".to_vec()),
            }],
        }
    }

    fn restore_request(
        workspace: &std::path::Path,
        checkpoint_id: &str,
    ) -> CheckpointRestoreRequest {
        CheckpointRestoreRequest {
            run_id: "run-checkpoint".to_string(),
            checkpoint_id: checkpoint_id.to_string(),
            workspace: workspace.to_path_buf(),
            required_scope: "src/**".to_string(),
            plan_revision: 3,
            event_sequence: 42,
            now: Utc::now(),
        }
    }

    #[test]
    fn checkpoint_input_verified_published_state_reads_exact_checkpoint_without_restoring() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other_workspace = tempfile::tempdir().unwrap();
        let target = workspace.path().join("src/value.txt");
        std::fs::create_dir(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"current\n").unwrap();
        let store = CheckpointTransactionStore::new(root.path());
        let prepared = request(workspace.path(), "checkpoint-first");
        let expected = prepared.state_json.clone();
        let published = store.prepare_and_publish(prepared).unwrap();
        store
            .prepare_and_publish(request(workspace.path(), "checkpoint-latest"))
            .unwrap();
        std::fs::write(&target, b"newer workspace content\n").unwrap();

        assert_eq!(
            store
                .verified_published_state("run-checkpoint", "checkpoint-first", workspace.path())
                .unwrap(),
            (expected, 3, 42)
        );
        for (run, checkpoint, path) in [
            ("wrong-run", "checkpoint-first", workspace.path()),
            ("run-checkpoint", "wrong-checkpoint", workspace.path()),
            ("run-checkpoint", "checkpoint-first", other_workspace.path()),
        ] {
            assert!(store
                .verified_published_state(run, checkpoint, path)
                .is_err());
        }
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"newer workspace content\n"
        );
        assert!(!published.join(RESTORE_MARKER).exists());
        assert!(!store
            .run_root("run-checkpoint")
            .join("restored-state.json")
            .exists());
        assert_eq!(
            store
                .latest_checkpoint_id("run-checkpoint")
                .unwrap()
                .as_deref(),
            Some("checkpoint-latest")
        );
    }

    #[test]
    fn checkpoint_input_verified_published_state_rejects_incomplete_or_corrupt_artifacts() {
        for corruption in [
            "commit",
            "publish",
            "state",
            "budget",
            "approvals",
            "undo",
            "schema",
            "run",
            "checkpoint",
            "workspace",
            "plan",
            "sequence",
        ] {
            let root = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            let target = workspace.path().join("src/value.txt");
            std::fs::create_dir(target.parent().unwrap()).unwrap();
            std::fs::write(&target, b"current\n").unwrap();
            let store = CheckpointTransactionStore::new(root.path());
            let published = store
                .prepare_and_publish(request(workspace.path(), "checkpoint-input"))
                .unwrap();
            match corruption {
                "commit" => std::fs::remove_file(published.join(COMMIT_MARKER)).unwrap(),
                "publish" => std::fs::remove_file(published.join(PUBLISH_MARKER)).unwrap(),
                "state" | "budget" | "approvals" => {
                    std::fs::write(published.join(format!("{corruption}.json")), b"{}").unwrap();
                }
                "undo" => std::fs::write(published.join("undo/files/0.bin"), b"changed").unwrap(),
                _ => {
                    let mut manifest = read_manifest(&published).unwrap();
                    match corruption {
                        "schema" => manifest.schema_version += 1,
                        "run" => manifest.run_id = "other-run".to_string(),
                        "checkpoint" => manifest.checkpoint_id = "other-checkpoint".to_string(),
                        "workspace" => manifest.workspace_identity = "other-workspace".to_string(),
                        "plan" => manifest.plan_revision = 0,
                        "sequence" => manifest.event_sequence = 0,
                        _ => unreachable!(),
                    }
                    std::fs::write(
                        published.join(MANIFEST_FILE),
                        serde_json::to_vec(&manifest).unwrap(),
                    )
                    .unwrap();
                }
            }
            assert!(
                store
                    .verified_published_state(
                        "run-checkpoint",
                        "checkpoint-input",
                        workspace.path()
                    )
                    .is_err(),
                "accepted {corruption}"
            );
            assert_eq!(std::fs::read(&target).unwrap(), b"current\n");
            assert!(!published.join(RESTORE_MARKER).exists());
        }
    }

    #[test]
    fn checkpoint_faults_before_commit_never_publish_and_committed_prepare_recovers() {
        for stage in [
            CheckpointWriteStage::StateWritten,
            CheckpointWriteStage::UndoWritten,
            CheckpointWriteStage::ApprovalsWritten,
            CheckpointWriteStage::ManifestWritten,
        ] {
            let root = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(workspace.path().join("src")).unwrap();
            std::fs::write(workspace.path().join("src/value.txt"), b"after\n").unwrap();
            let store = CheckpointTransactionStore::new(root.path());
            let result = store
                .prepare_and_publish_with_hook(request(workspace.path(), "cp-fault"), |current| {
                    (current != stage).then_some(()).ok_or("injected crash")
                });
            assert!(result.is_err(), "stage {stage:?} must fail");
            assert!(store
                .published_checkpoint("run-checkpoint", "cp-fault")
                .is_none());
            assert_eq!(store.recover("run-checkpoint").unwrap().published, 0);
        }

        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src/value.txt"), b"after\n").unwrap();
        let store = CheckpointTransactionStore::new(root.path());
        assert!(store
            .prepare_and_publish_with_hook(request(workspace.path(), "cp-committed"), |stage| {
                (stage != CheckpointWriteStage::CommitMarkerWritten)
                    .then_some(())
                    .ok_or("crash after commit marker")
            },)
            .is_err());
        assert!(store
            .published_checkpoint("run-checkpoint", "cp-committed")
            .is_none());
        assert_eq!(store.recover("run-checkpoint").unwrap().published, 1);
        assert!(store
            .published_checkpoint("run-checkpoint", "cp-committed")
            .is_some());

        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("src/value.txt"), b"after\n").unwrap();
        let store = CheckpointTransactionStore::new(root.path());
        assert!(store
            .prepare_and_publish_with_hook(request(workspace.path(), "cp-published"), |stage| {
                (stage != CheckpointWriteStage::Published)
                    .then_some(())
                    .ok_or("crash after publish")
            },)
            .is_err());
        assert!(store
            .published_checkpoint("run-checkpoint", "cp-published")
            .is_some());
        assert_eq!(store.recover("run-checkpoint").unwrap().published, 0);
    }

    #[test]
    fn restore_rejects_drift_expired_approval_wrong_identity_and_preserves_checkpoint() {
        let cases = [
            "drift",
            "expired",
            "wrong-run",
            "wrong-checkpoint",
            "wrong-workspace",
            "wrong-plan",
            "wrong-sequence",
        ];
        for case in cases {
            let root = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(workspace.path().join("src")).unwrap();
            let target = workspace.path().join("src/value.txt");
            std::fs::write(&target, b"after\n").unwrap();
            let store = CheckpointTransactionStore::new(root.path());
            let mut prepare = request(workspace.path(), "cp-validated");
            if case == "expired" {
                prepare.approvals[0].expires_at = Utc::now() - Duration::seconds(1);
            }
            store.prepare_and_publish(prepare).unwrap();
            let mut restore = restore_request(workspace.path(), "cp-validated");
            let wrong_workspace = tempfile::tempdir().unwrap();
            match case {
                "drift" => std::fs::write(&target, b"user drift\n").unwrap(),
                "wrong-run" => restore.run_id = "run-other".to_string(),
                "wrong-checkpoint" => restore.checkpoint_id = "cp-other".to_string(),
                "wrong-workspace" => restore.workspace = wrong_workspace.path().to_path_buf(),
                "wrong-plan" => restore.plan_revision = 4,
                "wrong-sequence" => restore.event_sequence = 43,
                _ => {}
            }

            let outcome = store.restore(restore).unwrap();
            assert!(matches!(
                outcome,
                CheckpointRestoreOutcome::NeedsReview { .. }
            ));
            assert_ne!(std::fs::read(&target).unwrap(), b"before\n");
            assert!(store
                .published_checkpoint("run-checkpoint", "cp-validated")
                .is_some());
        }
    }

    #[test]
    fn committed_restore_is_idempotent_and_restores_state_file_and_workspace_together() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("src")).unwrap();
        let target = workspace.path().join("src/value.txt");
        std::fs::write(&target, b"after\n").unwrap();
        let store = CheckpointTransactionStore::new(root.path());
        store
            .prepare_and_publish(request(workspace.path(), "cp-idempotent"))
            .unwrap();

        let first = store
            .restore(restore_request(workspace.path(), "cp-idempotent"))
            .unwrap();
        assert!(matches!(first, CheckpointRestoreOutcome::Restored { .. }));
        assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
        let second = store
            .restore(restore_request(workspace.path(), "cp-idempotent"))
            .unwrap();
        assert!(matches!(
            second,
            CheckpointRestoreOutcome::AlreadyRestored { .. }
        ));
        assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
    }

    #[test]
    fn restore_write_stage_crashes_recover_without_partial_workspace_or_state() {
        for crash_stage in [
            CheckpointWriteStage::RestoreJournalWritten,
            CheckpointWriteStage::RestoreFileWritten(0),
            CheckpointWriteStage::RestoreStateWritten,
            CheckpointWriteStage::RestoreCommitMarkerWritten,
            CheckpointWriteStage::RestorePublished,
        ] {
            let root = tempfile::tempdir().unwrap();
            let workspace = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(workspace.path().join("src")).unwrap();
            let target = workspace.path().join("src/value.txt");
            std::fs::write(&target, b"after\n").unwrap();
            let store = CheckpointTransactionStore::new(root.path());
            store
                .prepare_and_publish(request(workspace.path(), "cp-restore-crash"))
                .unwrap();

            let crashed = store.restore_with_hook(
                restore_request(workspace.path(), "cp-restore-crash"),
                |stage| {
                    (stage != crash_stage)
                        .then_some(())
                        .ok_or("injected restore crash")
                },
            );
            assert!(crashed.is_err(), "stage {crash_stage:?} must crash");

            let recovered = store
                .restore(restore_request(workspace.path(), "cp-restore-crash"))
                .unwrap();
            assert!(matches!(
                recovered,
                CheckpointRestoreOutcome::Restored { .. }
                    | CheckpointRestoreOutcome::AlreadyRestored { .. }
            ));
            assert_eq!(std::fs::read(&target).unwrap(), b"before\n");
            let checkpoint = store
                .published_checkpoint("run-checkpoint", "cp-restore-crash")
                .unwrap();
            assert!(!checkpoint.join(RESTORE_JOURNAL_DIR).exists());
            assert!(checkpoint.join(RESTORE_MARKER).is_file());
            assert!(store
                .restored_state_json("run-checkpoint")
                .unwrap()
                .is_some());
        }
    }
}
