use super::{CommittedControlEffect, EffectClaimStatus, EffectLedger, EffectLedgerError};
use crate::agents::protocol::{RunEvent, RunId};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const EFFECT_LEDGER_FILE_NAME: &str = "effects.v1.jsonl";
const EFFECT_LEDGER_SCHEMA_VERSION: u32 = 1;
const MAX_LEDGER_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LEDGER_RECORDS: usize = 32_768;
const MAX_LEDGER_RECORD_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableEffectState {
    Prepared,
    Pending,
    Claimed,
    Completed,
    Uncertain,
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UncertainEffectResolution {
    ConfirmedApplied,
    ConfirmedNotApplied,
}

impl DurableEffectState {
    fn name(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Completed => "completed",
            Self::Uncertain => "uncertain",
            Self::Abandoned => "abandoned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableEffectEntry {
    pub effect: CommittedControlEffect,
    pub trigger_event: RunEvent,
    pub state: DurableEffectState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectLedgerRecoveryReport {
    pub truncated_bytes: u64,
    pub last_sequence: u64,
}

pub trait EffectOutbox: Send + Sync {
    fn prepare(
        &self,
        events: &[RunEvent],
        effects: &[CommittedControlEffect],
    ) -> Result<(), EffectLedgerError>;
    fn commit_prepared(&self, effects: &[CommittedControlEffect]) -> Result<(), EffectLedgerError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NoopEffectOutbox;

impl EffectOutbox for NoopEffectOutbox {
    fn prepare(
        &self,
        _events: &[RunEvent],
        _effects: &[CommittedControlEffect],
    ) -> Result<(), EffectLedgerError> {
        Ok(())
    }

    fn commit_prepared(
        &self,
        _effects: &[CommittedControlEffect],
    ) -> Result<(), EffectLedgerError> {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalRecord {
    schema_version: u32,
    sequence: u64,
    run_id: RunId,
    ledger_key: String,
    transition: JournalTransition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum JournalTransition {
    Prepared {
        effect: CommittedControlEffect,
        trigger_event: Box<RunEvent>,
    },
    Pending,
    Claimed,
    Completed,
    Uncertain,
    Abandoned,
}

#[derive(Debug, Clone)]
struct ReplayEntry {
    entry: DurableEffectEntry,
}

#[derive(Debug, Default)]
struct ReplayedLedger {
    last_sequence: u64,
    entries: BTreeMap<String, ReplayEntry>,
}

#[derive(Debug, Clone)]
pub struct FileEffectLedger {
    root: PathBuf,
}

impl FileEffectLedger {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn journal_path(&self, run_id: &RunId) -> PathBuf {
        self.root
            .join(run_id.as_str())
            .join(EFFECT_LEDGER_FILE_NAME)
    }

    pub fn prepare(
        &self,
        events: &[RunEvent],
        effects: &[CommittedControlEffect],
    ) -> Result<(), EffectLedgerError> {
        if effects.is_empty() {
            return Ok(());
        }
        let run_id = effects[0].effect.run_id();
        let events_by_id = events
            .iter()
            .map(|event| (event.event_id.clone(), event))
            .collect::<HashMap<_, _>>();
        let mut seen = HashSet::new();
        let mut preparations = Vec::with_capacity(effects.len());
        for effect in effects {
            if effect.effect.run_id() != run_id {
                return Err(EffectLedgerError::IdentityConflict(effect.ledger_key()));
            }
            let key = effect.ledger_key();
            if !seen.insert(key.clone()) {
                return Err(EffectLedgerError::IdentityConflict(key));
            }
            let trigger_event = events_by_id
                .get(&effect.trigger_event_id)
                .ok_or_else(|| EffectLedgerError::IdentityConflict(key.clone()))?;
            if trigger_event.validate().is_err() || &trigger_event.run_id != run_id {
                return Err(EffectLedgerError::IdentityConflict(key));
            }
            preparations.push((effect.clone(), (*trigger_event).clone()));
        }

        self.mutate(run_id, |ledger, records| {
            for (effect, trigger_event) in preparations {
                let key = effect.ledger_key();
                if let Some(existing) = ledger.entries.get(&key) {
                    ensure_identity(&key, existing, &effect)?;
                    if existing.entry.trigger_event != trigger_event
                        || existing.entry.state == DurableEffectState::Abandoned
                    {
                        return Err(EffectLedgerError::IdentityConflict(key));
                    }
                    continue;
                }
                records.push(new_record(
                    run_id,
                    key,
                    JournalTransition::Prepared {
                        effect,
                        trigger_event: Box::new(trigger_event),
                    },
                ));
            }
            Ok(())
        })
    }

    pub fn commit_prepared(
        &self,
        effects: &[CommittedControlEffect],
    ) -> Result<(), EffectLedgerError> {
        if effects.is_empty() {
            return Ok(());
        }
        let run_id = effects[0].effect.run_id();
        self.mutate(run_id, |ledger, records| {
            for effect in effects {
                let key = effect.ledger_key();
                let existing = ledger
                    .entries
                    .get(&key)
                    .ok_or_else(|| EffectLedgerError::MissingPrepared(key.clone()))?;
                ensure_identity(&key, existing, effect)?;
                match existing.entry.state {
                    DurableEffectState::Prepared => {
                        records.push(new_record(run_id, key, JournalTransition::Pending))
                    }
                    DurableEffectState::Pending
                    | DurableEffectState::Claimed
                    | DurableEffectState::Completed
                    | DurableEffectState::Uncertain => {}
                    DurableEffectState::Abandoned => {
                        return Err(invalid_transition(&key, DurableEffectState::Abandoned));
                    }
                }
            }
            Ok(())
        })
    }

    pub fn snapshot(&self, run_id: &RunId) -> Result<Vec<DurableEffectEntry>, EffectLedgerError> {
        self.inspect(run_id).map(|(_, entries)| entries)
    }

    pub(crate) fn inspect(
        &self,
        run_id: &RunId,
    ) -> Result<(EffectLedgerRecoveryReport, Vec<DurableEffectEntry>), EffectLedgerError> {
        let path = self.journal_path(run_id);
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((
                    EffectLedgerRecoveryReport {
                        truncated_bytes: 0,
                        last_sequence: 0,
                    },
                    Vec::new(),
                ));
            }
            Err(error) => return Err(io_error(&path, error)),
        };
        file.lock_shared().map_err(|error| io_error(&path, error))?;
        let ledger = read_locked(&mut file, &path, run_id)?;
        FileExt::unlock(&file).map_err(|error| io_error(&path, error))?;
        let report = EffectLedgerRecoveryReport {
            truncated_bytes: 0,
            last_sequence: ledger.last_sequence,
        };
        let entries = ledger
            .entries
            .into_values()
            .map(|entry| entry.entry)
            .collect();
        Ok((report, entries))
    }

    pub fn recover_incomplete_tail(
        &self,
        run_id: &RunId,
    ) -> Result<EffectLedgerRecoveryReport, EffectLedgerError> {
        let path = self.journal_path(run_id);
        ensure_parent(&path)?;
        let mut file = open_recovery_file(&path)?;
        file.lock_exclusive()
            .map_err(|error| io_error(&path, error))?;
        let bytes = read_bytes(&mut file, &path)?;
        let committed_len = if bytes.is_empty() || bytes.last() == Some(&b'\n') {
            bytes.len()
        } else {
            bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |index| index + 1)
        };
        let replayed = parse_bytes(&bytes[..committed_len], run_id)?;
        let truncated_bytes = (bytes.len() - committed_len) as u64;
        if truncated_bytes > 0 {
            file.set_len(committed_len as u64)
                .map_err(|error| io_error(&path, error))?;
            file.sync_data().map_err(|error| io_error(&path, error))?;
        }
        FileExt::unlock(&file).map_err(|error| io_error(&path, error))?;
        Ok(EffectLedgerRecoveryReport {
            truncated_bytes,
            last_sequence: replayed.last_sequence,
        })
    }

    pub fn reconcile_committed_events(
        &self,
        run_id: &RunId,
        events: &[RunEvent],
    ) -> Result<Vec<DurableEffectEntry>, EffectLedgerError> {
        let mut committed = HashMap::new();
        for event in events {
            if event.validate().is_err()
                || &event.run_id != run_id
                || committed
                    .insert(event.event_id.clone(), event.clone())
                    .is_some()
            {
                return Err(EffectLedgerError::IdentityConflict(
                    "committed event stream".to_string(),
                ));
            }
        }
        self.mutate(run_id, |ledger, records| {
            for (key, existing) in &ledger.entries {
                match existing.entry.state {
                    DurableEffectState::Prepared => {
                        match committed.get(&existing.entry.effect.trigger_event_id) {
                            Some(event) if event == &existing.entry.trigger_event => {
                                records.push(new_record(
                                    run_id,
                                    key.clone(),
                                    JournalTransition::Pending,
                                ));
                            }
                            Some(_) => {
                                return Err(EffectLedgerError::IdentityConflict(key.clone()));
                            }
                            None => records.push(new_record(
                                run_id,
                                key.clone(),
                                JournalTransition::Abandoned,
                            )),
                        }
                    }
                    DurableEffectState::Claimed => records.push(new_record(
                        run_id,
                        key.clone(),
                        JournalTransition::Uncertain,
                    )),
                    DurableEffectState::Pending
                    | DurableEffectState::Completed
                    | DurableEffectState::Uncertain
                    | DurableEffectState::Abandoned => {}
                }
            }
            Ok(())
        })?;
        self.snapshot(run_id)
    }

    pub fn resolve_uncertain(
        &self,
        effect: &CommittedControlEffect,
        resolution: UncertainEffectResolution,
    ) -> Result<(), EffectLedgerError> {
        let transition = match resolution {
            UncertainEffectResolution::ConfirmedApplied => JournalTransition::Completed,
            UncertainEffectResolution::ConfirmedNotApplied => JournalTransition::Pending,
        };
        self.transition(effect, DurableEffectState::Uncertain, transition)
    }

    fn transition(
        &self,
        effect: &CommittedControlEffect,
        expected: DurableEffectState,
        transition: JournalTransition,
    ) -> Result<(), EffectLedgerError> {
        let run_id = effect.effect.run_id();
        let key = effect.ledger_key();
        self.mutate(run_id, |ledger, records| {
            let existing = ledger
                .entries
                .get(&key)
                .ok_or_else(|| EffectLedgerError::MissingPrepared(key.clone()))?;
            ensure_identity(&key, existing, effect)?;
            if existing.entry.state != expected {
                return Err(invalid_transition(&key, existing.entry.state));
            }
            records.push(new_record(run_id, key.clone(), transition));
            Ok(())
        })
    }

    fn mutate(
        &self,
        run_id: &RunId,
        build: impl FnOnce(&ReplayedLedger, &mut Vec<JournalRecord>) -> Result<(), EffectLedgerError>,
    ) -> Result<(), EffectLedgerError> {
        let path = self.journal_path(run_id);
        ensure_parent(&path)?;
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)
            .map_err(|error| io_error(&path, error))?;
        file.lock_exclusive()
            .map_err(|error| io_error(&path, error))?;
        let ledger = read_locked(&mut file, &path, run_id)?;
        let mut records = Vec::new();
        build(&ledger, &mut records)?;
        if records.is_empty() {
            FileExt::unlock(&file).map_err(|error| io_error(&path, error))?;
            return Ok(());
        }
        if ledger.last_sequence as usize + records.len() > MAX_LEDGER_RECORDS {
            return Err(EffectLedgerError::Capacity);
        }
        let mut sequence = ledger.last_sequence;
        let mut encoded = Vec::new();
        for record in &mut records {
            sequence = sequence.checked_add(1).ok_or(EffectLedgerError::Capacity)?;
            record.sequence = sequence;
            let start = encoded.len();
            serde_json::to_writer(&mut encoded, record).map_err(|error| {
                EffectLedgerError::Corrupt {
                    line: sequence as usize,
                    reason: error.to_string(),
                }
            })?;
            if encoded.len() - start > MAX_LEDGER_RECORD_BYTES {
                return Err(EffectLedgerError::Capacity);
            }
            encoded.push(b'\n');
        }
        let current_len = file
            .metadata()
            .map_err(|error| io_error(&path, error))?
            .len();
        if current_len.saturating_add(encoded.len() as u64) > MAX_LEDGER_BYTES {
            return Err(EffectLedgerError::Capacity);
        }
        file.write_all(&encoded)
            .map_err(|error| io_error(&path, error))?;
        file.flush().map_err(|error| io_error(&path, error))?;
        file.sync_data().map_err(|error| io_error(&path, error))?;
        FileExt::unlock(&file).map_err(|error| io_error(&path, error))?;
        Ok(())
    }
}

impl EffectOutbox for FileEffectLedger {
    fn prepare(
        &self,
        events: &[RunEvent],
        effects: &[CommittedControlEffect],
    ) -> Result<(), EffectLedgerError> {
        FileEffectLedger::prepare(self, events, effects)
    }

    fn commit_prepared(&self, effects: &[CommittedControlEffect]) -> Result<(), EffectLedgerError> {
        FileEffectLedger::commit_prepared(self, effects)
    }
}

impl EffectLedger for FileEffectLedger {
    fn claim(
        &self,
        effect: &CommittedControlEffect,
    ) -> Result<EffectClaimStatus, EffectLedgerError> {
        let run_id = effect.effect.run_id();
        let key = effect.ledger_key();
        let mut result = None;
        self.mutate(run_id, |ledger, records| {
            let existing = ledger
                .entries
                .get(&key)
                .ok_or_else(|| EffectLedgerError::MissingPrepared(key.clone()))?;
            ensure_identity(&key, existing, effect)?;
            result = Some(match existing.entry.state {
                DurableEffectState::Pending => {
                    records.push(new_record(run_id, key.clone(), JournalTransition::Claimed));
                    EffectClaimStatus::Claimed
                }
                DurableEffectState::Claimed => EffectClaimStatus::InFlight,
                DurableEffectState::Completed => EffectClaimStatus::Completed,
                DurableEffectState::Uncertain => EffectClaimStatus::Uncertain,
                state @ (DurableEffectState::Prepared | DurableEffectState::Abandoned) => {
                    return Err(invalid_transition(&key, state));
                }
            });
            Ok(())
        })?;
        result.ok_or(EffectLedgerError::MissingPrepared(key))
    }

    fn complete(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError> {
        self.transition(
            effect,
            DurableEffectState::Claimed,
            JournalTransition::Completed,
        )
    }

    fn retry(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError> {
        self.transition(
            effect,
            DurableEffectState::Claimed,
            JournalTransition::Pending,
        )
    }

    fn mark_uncertain(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError> {
        let run_id = effect.effect.run_id();
        let key = effect.ledger_key();
        self.mutate(run_id, |ledger, records| {
            let existing = ledger
                .entries
                .get(&key)
                .ok_or_else(|| EffectLedgerError::MissingPrepared(key.clone()))?;
            ensure_identity(&key, existing, effect)?;
            match existing.entry.state {
                DurableEffectState::Claimed => records.push(new_record(
                    run_id,
                    key.clone(),
                    JournalTransition::Uncertain,
                )),
                DurableEffectState::Uncertain => {}
                state => return Err(invalid_transition(&key, state)),
            }
            Ok(())
        })
    }
}

fn new_record(run_id: &RunId, ledger_key: String, transition: JournalTransition) -> JournalRecord {
    JournalRecord {
        schema_version: EFFECT_LEDGER_SCHEMA_VERSION,
        sequence: 0,
        run_id: run_id.clone(),
        ledger_key,
        transition,
    }
}

fn read_locked(
    file: &mut File,
    path: &Path,
    run_id: &RunId,
) -> Result<ReplayedLedger, EffectLedgerError> {
    let bytes = read_bytes(file, path)?;
    parse_bytes(&bytes, run_id)
}

fn read_bytes(file: &mut File, path: &Path) -> Result<Vec<u8>, EffectLedgerError> {
    let length = file
        .metadata()
        .map_err(|error| io_error(path, error))?
        .len();
    if length > MAX_LEDGER_BYTES {
        return Err(EffectLedgerError::Capacity);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| io_error(path, error))?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    Ok(bytes)
}

fn parse_bytes(bytes: &[u8], run_id: &RunId) -> Result<ReplayedLedger, EffectLedgerError> {
    if bytes.is_empty() {
        return Ok(ReplayedLedger::default());
    }
    if bytes.last() != Some(&b'\n') {
        return Err(EffectLedgerError::IncompleteTail);
    }
    let mut ledger = ReplayedLedger::default();
    for (index, line) in bytes[..bytes.len() - 1]
        .split(|byte| *byte == b'\n')
        .enumerate()
    {
        let line_number = index + 1;
        if line.is_empty() || line.len() > MAX_LEDGER_RECORD_BYTES {
            return Err(corrupt(line_number, "empty or oversized record"));
        }
        let record: JournalRecord = serde_json::from_slice(line)
            .map_err(|error| corrupt(line_number, error.to_string()))?;
        apply_record(&mut ledger, record, run_id, line_number)?;
    }
    Ok(ledger)
}

fn apply_record(
    ledger: &mut ReplayedLedger,
    record: JournalRecord,
    run_id: &RunId,
    line: usize,
) -> Result<(), EffectLedgerError> {
    let expected_sequence = ledger.last_sequence + 1;
    if record.schema_version != EFFECT_LEDGER_SCHEMA_VERSION
        || record.sequence != expected_sequence
        || &record.run_id != run_id
    {
        return Err(corrupt(line, "schema, sequence, or run mismatch"));
    }
    match record.transition {
        JournalTransition::Prepared {
            effect,
            trigger_event,
        } => {
            if ledger.entries.contains_key(&record.ledger_key)
                || effect.ledger_key() != record.ledger_key
                || effect.effect.run_id() != run_id
                || &trigger_event.run_id != run_id
                || trigger_event.event_id != effect.trigger_event_id
            {
                return Err(corrupt(line, "invalid prepared effect identity"));
            }
            ledger.entries.insert(
                record.ledger_key,
                ReplayEntry {
                    entry: DurableEffectEntry {
                        effect,
                        trigger_event: *trigger_event,
                        state: DurableEffectState::Prepared,
                    },
                },
            );
        }
        transition => {
            let existing = ledger
                .entries
                .get_mut(&record.ledger_key)
                .ok_or_else(|| corrupt(line, "transition precedes preparation"))?;
            let next = transition_state(existing.entry.state, &transition)
                .ok_or_else(|| corrupt(line, "invalid state transition"))?;
            existing.entry.state = next;
        }
    }
    ledger.last_sequence = record.sequence;
    Ok(())
}

fn transition_state(
    state: DurableEffectState,
    transition: &JournalTransition,
) -> Option<DurableEffectState> {
    match (state, transition) {
        (DurableEffectState::Prepared, JournalTransition::Pending) => {
            Some(DurableEffectState::Pending)
        }
        (DurableEffectState::Prepared, JournalTransition::Abandoned) => {
            Some(DurableEffectState::Abandoned)
        }
        (DurableEffectState::Pending, JournalTransition::Claimed) => {
            Some(DurableEffectState::Claimed)
        }
        (DurableEffectState::Claimed, JournalTransition::Pending) => {
            Some(DurableEffectState::Pending)
        }
        (DurableEffectState::Claimed, JournalTransition::Completed) => {
            Some(DurableEffectState::Completed)
        }
        (DurableEffectState::Claimed, JournalTransition::Uncertain) => {
            Some(DurableEffectState::Uncertain)
        }
        (DurableEffectState::Uncertain, JournalTransition::Pending) => {
            Some(DurableEffectState::Pending)
        }
        (DurableEffectState::Uncertain, JournalTransition::Completed) => {
            Some(DurableEffectState::Completed)
        }
        _ => None,
    }
}

fn ensure_identity(
    key: &str,
    existing: &ReplayEntry,
    effect: &CommittedControlEffect,
) -> Result<(), EffectLedgerError> {
    if &existing.entry.effect == effect {
        Ok(())
    } else {
        Err(EffectLedgerError::IdentityConflict(key.to_string()))
    }
}

fn invalid_transition(key: &str, state: DurableEffectState) -> EffectLedgerError {
    EffectLedgerError::InvalidTransition {
        effect_id: key.to_string(),
        actual: state.name(),
    }
}

fn corrupt(line: usize, reason: impl Into<String>) -> EffectLedgerError {
    EffectLedgerError::Corrupt {
        line,
        reason: reason.into(),
    }
}

fn ensure_parent(path: &Path) -> Result<(), EffectLedgerError> {
    let parent = path
        .parent()
        .expect("an effect ledger always has a parent directory");
    std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))
}

fn open_recovery_file(path: &Path) -> Result<File, EffectLedgerError> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| io_error(path, error))
}

fn io_error(path: &Path, error: std::io::Error) -> EffectLedgerError {
    EffectLedgerError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::open_recovery_file;

    #[test]
    fn recovery_open_preserves_existing_journal_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("effects.jsonl");
        let existing = b"committed record\nincomplete tail";
        std::fs::write(&path, existing).unwrap();

        drop(open_recovery_file(&path).unwrap());

        assert_eq!(std::fs::read(path).unwrap(), existing);
    }
}
