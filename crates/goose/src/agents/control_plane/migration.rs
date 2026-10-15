use crate::agents::protocol::{EventId, RunEvent, RunId};
use crate::agents::{
    ActivityEventKind, CodeProEventRecord, CodeProRunState, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const LEGACY_ARCHIVE_DIRECTORY_NAME: &str = "legacy-imports";
pub const LEGACY_ARCHIVE_MANIFEST_FILE_NAME: &str = "manifest.v1.json";
const LEGACY_ARCHIVE_SCHEMA_VERSION: u16 = 1;
const MAX_LEGACY_RUNS: usize = 10_000;
const MAX_LEGACY_STATE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LEGACY_EVENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LEGACY_EVENT_RECORDS: usize = 32_768;
const MAX_LEGACY_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyMigrationResult {
    pub events: Vec<RunEvent>,
    pub mappings: Vec<LegacyEventMapping>,
    pub warnings: Vec<MigrationWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyEventMapping {
    pub legacy_sequence: u64,
    pub legacy_event_id: String,
    pub event_id: EventId,
    pub correlation_id: EventId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MigrationWarning {
    DuplicateEventIdRewritten {
        legacy_sequence: u64,
        legacy_event_id: String,
        event_id: EventId,
    },
    LegacyTaskEvidenceDemoted {
        legacy_sequence: u64,
        legacy_event_id: String,
    },
}

fn is_legacy_task_evidence_record(record: &CodeProEventRecord) -> bool {
    if record.event_type != ActivityEventKind::TaskCompleted {
        return false;
    }
    record
        .artifact_ref
        .as_deref()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.ends_with(".task-evidence.txt") || name.ends_with(".main-agent-task-evidence.txt")
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyArchiveDisposition {
    Imported,
    ReadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LegacyArchiveWarning {
    MissingState,
    InvalidState {
        reason: String,
    },
    MissingEventLog,
    EmptyEventLog,
    IncompleteEventLog,
    InvalidEventLog {
        reason: String,
    },
    RunIdentityMismatch {
        state_run_id: String,
        event_run_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyArchiveManifest {
    pub schema_version: u16,
    pub source_key: String,
    pub legacy_run_id: Option<String>,
    pub linked_durable_run_id: Option<String>,
    pub disposition: LegacyArchiveDisposition,
    pub source_state_sha256: Option<String>,
    pub source_events_sha256: Option<String>,
    pub archived_events_file: Option<String>,
    pub archived_events_sha256: Option<String>,
    pub event_count: usize,
    pub mappings: Vec<LegacyEventMapping>,
    pub mapping_warnings: Vec<MigrationWarning>,
    pub warnings: Vec<LegacyArchiveWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyArchiveImport {
    pub manifest: LegacyArchiveManifest,
    pub already_imported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LegacyArchiveReport {
    pub imports: Vec<LegacyArchiveImport>,
}

#[derive(Debug, thiserror::Error)]
pub enum LegacyArchiveError {
    #[error("legacy archive I/O failed at {path}: {message}")]
    Io { path: PathBuf, message: String },
    #[error("legacy archive manifest is invalid at {path}: {reason}")]
    InvalidManifest { path: PathBuf, reason: String },
    #[error("legacy archive contains more than {limit} run directories")]
    TooManyRuns { limit: usize },
    #[error("multiple legacy run directories resolve to archive key {0}")]
    DuplicateSourceKey(String),
}

#[derive(Debug, Deserialize)]
struct LegacyStateIdentity {
    run_id: String,
    #[serde(default)]
    last_active_run_id: Option<String>,
}

pub fn archive_legacy_runs(
    legacy_root: impl AsRef<Path>,
    control_root: impl AsRef<Path>,
) -> Result<LegacyArchiveReport, LegacyArchiveError> {
    let legacy_root = legacy_root.as_ref();
    let control_root = control_root.as_ref();
    if !legacy_root.exists() {
        return Ok(LegacyArchiveReport::default());
    }

    let mut sources = Vec::new();
    for entry in std::fs::read_dir(legacy_root).map_err(|error| archive_io(legacy_root, error))? {
        let entry = entry.map_err(|error| archive_io(legacy_root, error))?;
        if !entry
            .file_type()
            .map_err(|error| archive_io(entry.path(), error))?
            .is_dir()
        {
            continue;
        }
        if sources.len() == MAX_LEGACY_RUNS {
            return Err(LegacyArchiveError::TooManyRuns {
                limit: MAX_LEGACY_RUNS,
            });
        }
        sources.push((
            archive_key(&entry.file_name().to_string_lossy()),
            entry.path(),
        ));
    }
    sources.sort_by(|left, right| left.0.cmp(&right.0));
    if let Some(duplicate) = sources
        .windows(2)
        .find(|pair| pair[0].0 == pair[1].0)
        .map(|pair| pair[0].0.clone())
    {
        return Err(LegacyArchiveError::DuplicateSourceKey(duplicate));
    }

    let mut report = LegacyArchiveReport::default();
    for (source_key, source_dir) in sources {
        let run_dir = source_dir.join("run");
        let state_path = run_dir.join("state.json");
        let event_path = run_dir.join("events.jsonl");
        if !state_path.exists() && !event_path.exists() {
            continue;
        }

        let archive_dir = control_root
            .join(LEGACY_ARCHIVE_DIRECTORY_NAME)
            .join(&source_key);
        let manifest_path = archive_dir.join(LEGACY_ARCHIVE_MANIFEST_FILE_NAME);
        if manifest_path.exists() {
            report.imports.push(LegacyArchiveImport {
                manifest: load_manifest(&manifest_path, &archive_dir, &source_key)?,
                already_imported: true,
            });
            continue;
        }

        let manifest = build_manifest(&source_key, &state_path, &event_path, &archive_dir)?;
        std::fs::create_dir_all(&archive_dir).map_err(|error| archive_io(&archive_dir, error))?;
        let mut encoded = serde_json::to_vec_pretty(&manifest).map_err(|error| {
            LegacyArchiveError::InvalidManifest {
                path: manifest_path.clone(),
                reason: error.to_string(),
            }
        })?;
        encoded.push(b'\n');
        if encoded.len() as u64 > MAX_LEGACY_MANIFEST_BYTES {
            return Err(LegacyArchiveError::InvalidManifest {
                path: manifest_path,
                reason: "manifest exceeds its safety limit".to_string(),
            });
        }
        write_immutable(&manifest_path, &encoded)?;
        report.imports.push(LegacyArchiveImport {
            manifest,
            already_imported: false,
        });
    }
    Ok(report)
}

fn build_manifest(
    source_key: &str,
    state_path: &Path,
    event_path: &Path,
    archive_dir: &Path,
) -> Result<LegacyArchiveManifest, LegacyArchiveError> {
    let mut warnings = Vec::new();
    let (state, state_sha256) = match read_bounded_regular(state_path, MAX_LEGACY_STATE_BYTES) {
        Err(error) => {
            warnings.push(LegacyArchiveWarning::InvalidState {
                reason: source_error_reason(error),
            });
            (None, None)
        }
        Ok(None) => {
            warnings.push(LegacyArchiveWarning::MissingState);
            (None, None)
        }
        Ok(Some(bytes)) => {
            let hash = sha256(&bytes);
            match serde_json::from_slice::<CodeProRunState>(&bytes) {
                Ok(state)
                    if RunId::new(state.run_id.clone()).is_ok()
                        && state
                            .last_active_run_id
                            .as_ref()
                            .is_none_or(|run_id| RunId::new(run_id.clone()).is_ok()) =>
                {
                    (
                        Some(LegacyStateIdentity {
                            run_id: state.run_id,
                            last_active_run_id: state.last_active_run_id,
                        }),
                        Some(hash),
                    )
                }
                Ok(_) => {
                    warnings.push(LegacyArchiveWarning::InvalidState {
                        reason: "state run identity is invalid".to_string(),
                    });
                    (None, Some(hash))
                }
                Err(error) => {
                    warnings.push(LegacyArchiveWarning::InvalidState {
                        reason: error.to_string(),
                    });
                    (None, Some(hash))
                }
            }
        }
    };

    let mut source_events_sha256 = None;
    let mut archived_events_file = None;
    let mut archived_events_sha256 = None;
    let mut event_count = 0;
    let mut mappings = Vec::new();
    let mut mapping_warnings = Vec::new();
    let mut event_run_id = None;

    match read_bounded_regular(event_path, MAX_LEGACY_EVENT_BYTES) {
        Err(error) => warnings.push(LegacyArchiveWarning::InvalidEventLog {
            reason: source_error_reason(error),
        }),
        Ok(None) => warnings.push(LegacyArchiveWarning::MissingEventLog),
        Ok(Some(bytes)) if bytes.is_empty() => {
            source_events_sha256 = Some(sha256(&bytes));
            warnings.push(LegacyArchiveWarning::EmptyEventLog);
        }
        Ok(Some(bytes)) => {
            source_events_sha256 = Some(sha256(&bytes));
            if bytes.last() != Some(&b'\n') {
                warnings.push(LegacyArchiveWarning::IncompleteEventLog);
            } else {
                match parse_legacy_records(&bytes) {
                    Ok(records) => match migrate_legacy_records(&records) {
                        Ok(migrated) => {
                            event_run_id = migrated
                                .events
                                .first()
                                .map(|event| event.run_id.to_string());
                            let archive_bytes = encode_archived_events(&migrated.events);
                            if archive_bytes.len() as u64 > MAX_LEGACY_EVENT_BYTES {
                                warnings.push(LegacyArchiveWarning::InvalidEventLog {
                                    reason: "converted event archive exceeds its safety limit"
                                        .to_string(),
                                });
                            } else {
                                let archive_hash = sha256(&archive_bytes);
                                let file_name = format!("events.{archive_hash}.v1.jsonl");
                                std::fs::create_dir_all(archive_dir)
                                    .map_err(|error| archive_io(archive_dir, error))?;
                                write_immutable(&archive_dir.join(&file_name), &archive_bytes)?;
                                archived_events_file = Some(file_name);
                                archived_events_sha256 = Some(archive_hash);
                                event_count = migrated.events.len();
                                mappings = migrated.mappings;
                                mapping_warnings = migrated.warnings;
                            }
                        }
                        Err(error) => warnings.push(LegacyArchiveWarning::InvalidEventLog {
                            reason: error.to_string(),
                        }),
                    },
                    Err(reason) => warnings.push(LegacyArchiveWarning::InvalidEventLog { reason }),
                }
            }
        }
    }

    if let (Some(state), Some(event_run_id)) = (&state, &event_run_id) {
        if state.run_id != *event_run_id {
            warnings.push(LegacyArchiveWarning::RunIdentityMismatch {
                state_run_id: state.run_id.clone(),
                event_run_id: event_run_id.clone(),
            });
        }
    }
    let disposition = if warnings.is_empty() {
        LegacyArchiveDisposition::Imported
    } else {
        LegacyArchiveDisposition::ReadOnly
    };

    Ok(LegacyArchiveManifest {
        schema_version: LEGACY_ARCHIVE_SCHEMA_VERSION,
        source_key: source_key.to_string(),
        legacy_run_id: state
            .as_ref()
            .map(|state| state.run_id.clone())
            .or(event_run_id),
        linked_durable_run_id: state.and_then(|state| state.last_active_run_id),
        disposition,
        source_state_sha256: state_sha256,
        source_events_sha256,
        archived_events_file,
        archived_events_sha256,
        event_count,
        mappings,
        mapping_warnings,
        warnings,
    })
}

fn parse_legacy_records(bytes: &[u8]) -> Result<Vec<CodeProEventRecord>, String> {
    let mut records = Vec::new();
    let committed = bytes
        .strip_suffix(b"\n")
        .expect("legacy records are parsed only after the commit newline is checked");
    for (index, line) in committed.split(|byte| *byte == b'\n').enumerate() {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            return Err(format!("legacy event log line {} is empty", index + 1));
        }
        if records.len() == MAX_LEGACY_EVENT_RECORDS {
            return Err(format!(
                "legacy event log exceeds {MAX_LEGACY_EVENT_RECORDS} records"
            ));
        }
        records.push(
            serde_json::from_slice(line)
                .map_err(|error| format!("legacy event log line {}: {error}", index + 1))?,
        );
    }
    Ok(records)
}

fn encode_archived_events(events: &[RunEvent]) -> Vec<u8> {
    let mut encoded = Vec::new();
    for event in events {
        serde_json::to_writer(&mut encoded, event)
            .expect("validated CodePro run events must remain serializable");
        encoded.push(b'\n');
    }
    encoded
}

fn read_bounded_regular(
    path: &Path,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, LegacyArchiveError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(archive_io(path, error)),
    };
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Err(LegacyArchiveError::Io {
            path: path.to_path_buf(),
            message: "source is not a regular bounded file".to_string(),
        });
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map_err(|error| archive_io(path, error))?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| archive_io(path, error))?;
    if bytes.len() as u64 > max_bytes {
        return Err(LegacyArchiveError::Io {
            path: path.to_path_buf(),
            message: "source grew beyond its safety limit while being read".to_string(),
        });
    }
    Ok(Some(bytes))
}

fn load_manifest(
    path: &Path,
    archive_dir: &Path,
    source_key: &str,
) -> Result<LegacyArchiveManifest, LegacyArchiveError> {
    let bytes = read_bounded_regular(path, MAX_LEGACY_MANIFEST_BYTES)?.ok_or_else(|| {
        LegacyArchiveError::InvalidManifest {
            path: path.to_path_buf(),
            reason: "manifest disappeared during import".to_string(),
        }
    })?;
    let manifest: LegacyArchiveManifest =
        serde_json::from_slice(&bytes).map_err(|error| LegacyArchiveError::InvalidManifest {
            path: path.to_path_buf(),
            reason: error.to_string(),
        })?;
    if manifest.schema_version != LEGACY_ARCHIVE_SCHEMA_VERSION || manifest.source_key != source_key
    {
        return Err(LegacyArchiveError::InvalidManifest {
            path: path.to_path_buf(),
            reason: "manifest schema or source identity does not match".to_string(),
        });
    }
    if let Some(file_name) = &manifest.archived_events_file {
        if Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name)
        {
            return Err(LegacyArchiveError::InvalidManifest {
                path: path.to_path_buf(),
                reason: "archived event file name is unsafe".to_string(),
            });
        }
        let archive_path = archive_dir.join(file_name);
        let archived =
            read_bounded_regular(&archive_path, MAX_LEGACY_EVENT_BYTES)?.ok_or_else(|| {
                LegacyArchiveError::InvalidManifest {
                    path: path.to_path_buf(),
                    reason: "archived event file is missing".to_string(),
                }
            })?;
        if manifest.archived_events_sha256.as_deref() != Some(sha256(&archived).as_str()) {
            return Err(LegacyArchiveError::InvalidManifest {
                path: path.to_path_buf(),
                reason: "archived event hash does not match".to_string(),
            });
        }
    }
    Ok(manifest)
}

fn write_immutable(path: &Path, bytes: &[u8]) -> Result<(), LegacyArchiveError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| archive_io(parent, error))?;
    }
    if path.exists() {
        let existing = read_bounded_regular(path, bytes.len() as u64)?.ok_or_else(|| {
            LegacyArchiveError::Io {
                path: path.to_path_buf(),
                message: "immutable destination disappeared".to_string(),
            }
        })?;
        if existing == bytes {
            return Ok(());
        }
        return Err(LegacyArchiveError::Io {
            path: path.to_path_buf(),
            message: "immutable destination already contains different data".to_string(),
        });
    }

    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| archive_io(&temporary, error))?;
        file.write_all(bytes)
            .map_err(|error| archive_io(&temporary, error))?;
        file.sync_all()
            .map_err(|error| archive_io(&temporary, error))?;
        drop(file);
        match std::fs::hard_link(&temporary, path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = std::fs::read(path).map_err(|error| archive_io(path, error))?;
                if existing == bytes {
                    Ok(())
                } else {
                    Err(LegacyArchiveError::Io {
                        path: path.to_path_buf(),
                        message: "immutable destination won a conflicting publish race".to_string(),
                    })
                }
            }
            Err(error) => Err(archive_io(path, error)),
        }
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn archive_key(source: &str) -> String {
    if !source.is_empty()
        && source.len() <= 128
        && source.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        source.to_string()
    } else {
        format!("legacy-{}", sha256(source.as_bytes()))
    }
}

fn archive_io(path: impl AsRef<Path>, error: std::io::Error) -> LegacyArchiveError {
    LegacyArchiveError::Io {
        path: path.as_ref().to_path_buf(),
        message: error.to_string(),
    }
}

fn source_error_reason(error: LegacyArchiveError) -> String {
    match error {
        LegacyArchiveError::Io { message, .. } => message,
        other => other.to_string(),
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MigrationError {
    #[error(
        "legacy event at sequence {sequence} uses unsupported schema version {version}; expected {supported}"
    )]
    UnsupportedLegacyVersion {
        sequence: u64,
        version: u8,
        supported: u8,
    },
    #[error("legacy event sequence gap: expected {expected}, actual {actual}")]
    SequenceGap { expected: u64, actual: u64 },
    #[error("legacy event at sequence {sequence} belongs to run {actual}, expected {expected}")]
    MixedRuns {
        sequence: u64,
        expected: String,
        actual: String,
    },
    #[error("legacy event at sequence {sequence} is invalid: {reason}")]
    InvalidRecord { sequence: u64, reason: String },
}

pub fn migrate_legacy_records(
    records: &[CodeProEventRecord],
) -> Result<LegacyMigrationResult, MigrationError> {
    if records.is_empty() {
        return Ok(LegacyMigrationResult {
            events: vec![],
            mappings: vec![],
            warnings: vec![],
        });
    }

    let expected_run = records[0].run_id.clone();
    let mut reserved_legacy_ids = BTreeSet::new();
    for (index, record) in records.iter().enumerate() {
        validate_record(record, index as u64 + 1, &expected_run)?;
        reserved_legacy_ids.insert(record.event_id.clone());
    }

    let mut events = Vec::with_capacity(records.len());
    let mut mappings = Vec::with_capacity(records.len());
    let mut warnings = Vec::new();
    let mut used_event_ids = BTreeSet::new();

    for record in records {
        let mut activity = record.to_activity_event();
        if is_legacy_task_evidence_record(record) {
            activity.event_type = ActivityEventKind::EvidenceCommitted;
            warnings.push(MigrationWarning::LegacyTaskEvidenceDemoted {
                legacy_sequence: record.sequence,
                legacy_event_id: record.event_id.clone(),
            });
        }
        let mut event =
            RunEvent::from_activity_event(record.sequence, &activity).map_err(|error| {
                MigrationError::InvalidRecord {
                    sequence: record.sequence,
                    reason: error.to_string(),
                }
            })?;
        let legacy_event_id = event.event_id.clone();

        if used_event_ids.contains(&event.event_id) {
            let rewritten =
                unique_migrated_event_id(record.sequence, &reserved_legacy_ids, &used_event_ids);
            warnings.push(MigrationWarning::DuplicateEventIdRewritten {
                legacy_sequence: record.sequence,
                legacy_event_id: record.event_id.clone(),
                event_id: rewritten.clone(),
            });
            event.event_id = rewritten;
        }
        event.correlation_id = legacy_event_id;
        event
            .validate()
            .map_err(|error| MigrationError::InvalidRecord {
                sequence: record.sequence,
                reason: error.to_string(),
            })?;

        used_event_ids.insert(event.event_id.clone());
        mappings.push(LegacyEventMapping {
            legacy_sequence: record.sequence,
            legacy_event_id: record.event_id.clone(),
            event_id: event.event_id.clone(),
            correlation_id: event.correlation_id.clone(),
        });
        events.push(event);
    }

    Ok(LegacyMigrationResult {
        events,
        mappings,
        warnings,
    })
}

fn validate_record(
    record: &CodeProEventRecord,
    expected_sequence: u64,
    expected_run: &str,
) -> Result<(), MigrationError> {
    if record.schema_version != ACTIVITY_EVENT_SCHEMA_VERSION {
        return Err(MigrationError::UnsupportedLegacyVersion {
            sequence: record.sequence,
            version: record.schema_version,
            supported: ACTIVITY_EVENT_SCHEMA_VERSION,
        });
    }
    if record.sequence != expected_sequence {
        return Err(MigrationError::SequenceGap {
            expected: expected_sequence,
            actual: record.sequence,
        });
    }
    if record.run_id != expected_run {
        return Err(MigrationError::MixedRuns {
            sequence: record.sequence,
            expected: expected_run.to_string(),
            actual: record.run_id.clone(),
        });
    }

    RunId::new(record.run_id.clone()).map_err(|error| MigrationError::InvalidRecord {
        sequence: record.sequence,
        reason: error.to_string(),
    })?;
    EventId::new(record.event_id.clone()).map_err(|error| MigrationError::InvalidRecord {
        sequence: record.sequence,
        reason: error.to_string(),
    })?;
    Ok(())
}

fn unique_migrated_event_id(
    sequence: u64,
    reserved_legacy_ids: &BTreeSet<String>,
    used_event_ids: &BTreeSet<EventId>,
) -> EventId {
    for attempt in 0_u64.. {
        let candidate = if attempt == 0 {
            format!("legacy:{sequence}")
        } else {
            format!("legacy:{sequence}:{attempt}")
        };
        let candidate_id = EventId::new(candidate.clone())
            .expect("short deterministic migration ids satisfy the protocol identifier contract");
        if !reserved_legacy_ids.contains(&candidate) && !used_event_ids.contains(&candidate_id) {
            return candidate_id;
        }
    }
    unreachable!("an unbounded deterministic suffix always yields a unique migration id")
}
