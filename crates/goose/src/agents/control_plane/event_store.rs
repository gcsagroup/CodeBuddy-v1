use crate::agents::protocol::{EventId, ProtocolError, RunEvent, RunEventPayload, RunId};
use async_trait::async_trait;
use fs2::FileExt;
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const RUN_EVENT_LOG_FILE_NAME: &str = "events.v1.jsonl";
pub const MAX_RUN_EVENT_LOG_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_RUN_EVENT_RECORDS: usize = 32_768;
pub const RUN_EVENT_TERMINAL_BYTE_RESERVE: u64 = 1024 * 1024;
pub const RUN_EVENT_TERMINAL_RECORD_RESERVE: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppendReceipt {
    pub previous_sequence: u64,
    pub last_sequence: u64,
    pub appended: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryReport {
    pub truncated_bytes: u64,
    pub last_sequence: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum EventStoreError {
    #[error("event batch must not be empty")]
    EmptyBatch,
    #[error("event sequence conflict: expected {expected}, actual {actual}")]
    SequenceConflict { expected: u64, actual: u64 },
    #[error("invalid event sequence: expected {expected}, actual {actual}")]
    InvalidSequence { expected: u64, actual: u64 },
    #[error("event belongs to run {actual}, expected {expected}")]
    RunMismatch { expected: String, actual: String },
    #[error("duplicate event id: {0}")]
    DuplicateEventId(String),
    #[error("event log has an incomplete final record")]
    IncompleteTail,
    #[error("event log line {line} is corrupt: {reason}")]
    CorruptLog { line: usize, reason: String },
    #[error("event log record capacity exceeded (limit {limit})")]
    RecordCapacity { limit: usize },
    #[error("event log byte capacity exceeded (limit {limit})")]
    ByteCapacity { limit: u64 },
    #[error("CodePro protocol validation failed: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("event store I/O failed at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("event serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("event store blocking task failed: {0}")]
    BlockingTask(String),
}

#[async_trait]
pub trait RunEventStore: Send + Sync {
    async fn append(
        &self,
        run_id: &RunId,
        expected_sequence: u64,
        events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError>;

    async fn load(&self, run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError>;
}

#[derive(Debug, Clone)]
pub struct FileRunEventStore {
    root: PathBuf,
    max_bytes: u64,
    max_records: usize,
    terminal_byte_reserve: u64,
    terminal_record_reserve: usize,
}

impl FileRunEventStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::with_limits_and_terminal_reserve(
            root,
            MAX_RUN_EVENT_LOG_BYTES,
            MAX_RUN_EVENT_RECORDS,
            RUN_EVENT_TERMINAL_BYTE_RESERVE,
            RUN_EVENT_TERMINAL_RECORD_RESERVE,
        )
    }

    pub fn with_limits(root: impl Into<PathBuf>, max_bytes: u64, max_records: usize) -> Self {
        Self::with_limits_and_terminal_reserve(root, max_bytes, max_records, 0, 0)
    }

    pub fn with_limits_and_terminal_reserve(
        root: impl Into<PathBuf>,
        max_bytes: u64,
        max_records: usize,
        terminal_byte_reserve: u64,
        terminal_record_reserve: usize,
    ) -> Self {
        Self {
            root: root.into(),
            max_bytes,
            max_records,
            terminal_byte_reserve: terminal_byte_reserve.min(max_bytes),
            terminal_record_reserve: terminal_record_reserve.min(max_records),
        }
    }

    pub fn event_log_path(&self, run_id: &RunId) -> PathBuf {
        self.root
            .join(run_id.as_str())
            .join(RUN_EVENT_LOG_FILE_NAME)
    }

    fn append_blocking(
        &self,
        run_id: &RunId,
        expected_sequence: u64,
        events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError> {
        if events.is_empty() {
            return Err(EventStoreError::EmptyBatch);
        }

        let path = self.event_log_path(run_id);
        let parent = path
            .parent()
            .expect("a run event log always has a parent directory");
        std::fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)
            .map_err(|source| io_error(&path, source))?;
        file.lock_exclusive()
            .map_err(|source| io_error(&path, source))?;

        self.ensure_byte_capacity(&file, &path)?;

        let committed = read_locked(&mut file, &path)?;
        self.ensure_record_capacity(committed.len())?;
        ensure_run_matches(run_id, &committed)?;
        let actual_sequence = committed.last().map_or(0, |event| event.sequence);
        if expected_sequence != actual_sequence {
            return Err(EventStoreError::SequenceConflict {
                expected: expected_sequence,
                actual: actual_sequence,
            });
        }
        let uses_terminal_reserve = events.last().is_some_and(|event| {
            matches!(
                &event.payload,
                RunEventPayload::RunCompleted { .. }
                    | RunEventPayload::RunFailed { .. }
                    | RunEventPayload::RunCancelled { .. }
            )
        });
        let record_count =
            committed
                .len()
                .checked_add(events.len())
                .ok_or(EventStoreError::RecordCapacity {
                    limit: self.max_records,
                })?;
        self.ensure_append_record_capacity(record_count, uses_terminal_reserve)?;

        let mut known_ids = committed
            .iter()
            .map(|event| event.event_id.clone())
            .collect::<HashSet<_>>();
        let mut next_sequence =
            expected_sequence
                .checked_add(1)
                .ok_or(EventStoreError::InvalidSequence {
                    expected: expected_sequence,
                    actual: expected_sequence,
                })?;
        let mut encoded = Vec::new();

        for event in events {
            validate_event(run_id, event, next_sequence, &mut known_ids)?;
            serde_json::to_writer(&mut encoded, event)?;
            encoded.push(b'\n');
            next_sequence =
                next_sequence
                    .checked_add(1)
                    .ok_or(EventStoreError::InvalidSequence {
                        expected: u64::MAX,
                        actual: event.sequence,
                    })?;
        }

        let committed_bytes = file
            .metadata()
            .map_err(|source| io_error(&path, source))?
            .len();
        let appended_bytes = u64::try_from(encoded.len()).unwrap_or(u64::MAX);
        let byte_limit = if uses_terminal_reserve {
            self.max_bytes
        } else {
            self.max_bytes.saturating_sub(self.terminal_byte_reserve)
        };
        if committed_bytes.saturating_add(appended_bytes) > byte_limit {
            return Err(EventStoreError::ByteCapacity { limit: byte_limit });
        }

        file.write_all(&encoded)
            .map_err(|source| io_error(&path, source))?;
        file.flush().map_err(|source| io_error(&path, source))?;
        file.sync_data().map_err(|source| io_error(&path, source))?;
        FileExt::unlock(&file).map_err(|source| io_error(&path, source))?;

        Ok(AppendReceipt {
            previous_sequence: expected_sequence,
            last_sequence: next_sequence - 1,
            appended: events.len(),
        })
    }

    fn load_blocking(&self, run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError> {
        let path = self.event_log_path(run_id);
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(io_error(&path, source)),
        };
        file.lock_shared()
            .map_err(|source| io_error(&path, source))?;
        self.ensure_byte_capacity(&file, &path)?;
        let events = read_locked(&mut file, &path)?;
        self.ensure_record_capacity(events.len())?;
        ensure_run_matches(run_id, &events)?;
        FileExt::unlock(&file).map_err(|source| io_error(&path, source))?;
        Ok(events)
    }

    fn recover_incomplete_tail_blocking(
        &self,
        run_id: &RunId,
    ) -> Result<RecoveryReport, EventStoreError> {
        let path = self.event_log_path(run_id);
        let parent = path
            .parent()
            .expect("a run event log always has a parent directory");
        std::fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        let mut file = open_recovery_file(&path)?;
        file.lock_exclusive()
            .map_err(|source| io_error(&path, source))?;
        self.ensure_byte_capacity(&file, &path)?;
        file.seek(SeekFrom::Start(0))
            .map_err(|source| io_error(&path, source))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|source| io_error(&path, source))?;

        if bytes.is_empty() || bytes.last() == Some(&b'\n') {
            let events = parse_committed_bytes(&bytes)?;
            self.ensure_record_capacity(events.len())?;
            ensure_run_matches(run_id, &events)?;
            FileExt::unlock(&file).map_err(|source| io_error(&path, source))?;
            return Ok(RecoveryReport {
                truncated_bytes: 0,
                last_sequence: events.last().map_or(0, |event| event.sequence),
            });
        }

        let committed_len = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let events = parse_committed_bytes(&bytes[..committed_len])?;
        self.ensure_record_capacity(events.len())?;
        ensure_run_matches(run_id, &events)?;
        let truncated_bytes = (bytes.len() - committed_len) as u64;
        file.set_len(committed_len as u64)
            .map_err(|source| io_error(&path, source))?;
        file.sync_data().map_err(|source| io_error(&path, source))?;
        FileExt::unlock(&file).map_err(|source| io_error(&path, source))?;

        Ok(RecoveryReport {
            truncated_bytes,
            last_sequence: events.last().map_or(0, |event| event.sequence),
        })
    }

    fn ensure_byte_capacity(&self, file: &File, path: &Path) -> Result<(), EventStoreError> {
        let bytes = file
            .metadata()
            .map_err(|source| io_error(path, source))?
            .len();
        if bytes > self.max_bytes {
            return Err(EventStoreError::ByteCapacity {
                limit: self.max_bytes,
            });
        }
        Ok(())
    }

    fn ensure_record_capacity(&self, records: usize) -> Result<(), EventStoreError> {
        if records > self.max_records {
            return Err(EventStoreError::RecordCapacity {
                limit: self.max_records,
            });
        }
        Ok(())
    }

    fn ensure_append_record_capacity(
        &self,
        records: usize,
        uses_terminal_reserve: bool,
    ) -> Result<(), EventStoreError> {
        let limit = if uses_terminal_reserve {
            self.max_records
        } else {
            self.max_records
                .saturating_sub(self.terminal_record_reserve)
        };
        if records > limit {
            return Err(EventStoreError::RecordCapacity { limit });
        }
        Ok(())
    }

    pub async fn recover_incomplete_tail(
        &self,
        run_id: &RunId,
    ) -> Result<RecoveryReport, EventStoreError> {
        self.recover_incomplete_tail_blocking(run_id)
    }
}

#[async_trait]
impl RunEventStore for FileRunEventStore {
    async fn append(
        &self,
        run_id: &RunId,
        expected_sequence: u64,
        events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError> {
        self.append_blocking(run_id, expected_sequence, events)
    }

    async fn load(&self, run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError> {
        // Runtime mutations already serialize each run, and the event log has strict byte and
        // record limits. Reading it inline avoids a Windows ACP deadlock where a second
        // spawn_blocking load never starts after prompt registration, leaving plan installation
        // permanently pending even though no process holds the file lock.
        self.load_blocking(run_id)
    }
}

fn validate_event(
    run_id: &RunId,
    event: &RunEvent,
    expected_sequence: u64,
    known_ids: &mut HashSet<EventId>,
) -> Result<(), EventStoreError> {
    event.validate()?;
    if &event.run_id != run_id {
        return Err(EventStoreError::RunMismatch {
            expected: run_id.to_string(),
            actual: event.run_id.to_string(),
        });
    }
    if event.sequence != expected_sequence {
        return Err(EventStoreError::InvalidSequence {
            expected: expected_sequence,
            actual: event.sequence,
        });
    }
    if !known_ids.insert(event.event_id.clone()) {
        return Err(EventStoreError::DuplicateEventId(
            event.event_id.to_string(),
        ));
    }
    Ok(())
}

fn read_locked(file: &mut File, path: &Path) -> Result<Vec<RunEvent>, EventStoreError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|source| io_error(path, source))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|source| io_error(path, source))?;
    parse_committed_bytes(&bytes)
}

fn parse_committed_bytes(bytes: &[u8]) -> Result<Vec<RunEvent>, EventStoreError> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.last() != Some(&b'\n') {
        return Err(EventStoreError::IncompleteTail);
    }

    let mut events = Vec::new();
    let mut known_ids = HashSet::new();
    for (index, line) in bytes[..bytes.len() - 1]
        .split(|byte| *byte == b'\n')
        .enumerate()
    {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            return Err(EventStoreError::CorruptLog {
                line: index + 1,
                reason: "empty record".to_string(),
            });
        }
        let event: RunEvent =
            serde_json::from_slice(line).map_err(|error| EventStoreError::CorruptLog {
                line: index + 1,
                reason: error.to_string(),
            })?;
        validate_event(
            &event.run_id.clone(),
            &event,
            (index + 1) as u64,
            &mut known_ids,
        )
        .map_err(|error| EventStoreError::CorruptLog {
            line: index + 1,
            reason: error.to_string(),
        })?;
        events.push(event);
    }
    Ok(events)
}

fn ensure_run_matches(run_id: &RunId, events: &[RunEvent]) -> Result<(), EventStoreError> {
    if let Some(event) = events.iter().find(|event| &event.run_id != run_id) {
        Err(EventStoreError::RunMismatch {
            expected: run_id.to_string(),
            actual: event.run_id.to_string(),
        })
    } else {
        Ok(())
    }
}

fn open_recovery_file(path: &Path) -> Result<File, EventStoreError> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|source| io_error(path, source))
}

fn io_error(path: impl AsRef<Path>, source: std::io::Error) -> EventStoreError {
    EventStoreError::Io {
        path: path.as_ref().to_path_buf(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::open_recovery_file;

    #[test]
    fn recovery_open_preserves_existing_event_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.jsonl");
        let existing = b"committed event\nincomplete tail";
        std::fs::write(&path, existing).unwrap();

        drop(open_recovery_file(&path).unwrap());

        assert_eq!(std::fs::read(path).unwrap(), existing);
    }
}
