use crate::config::paths::Paths;
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use fs2::FileExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::SystemTime;

const SCHEMA_VERSION: u32 = 1;
const MAX_EVENT_IDS: usize = 4096;
const MAX_IDENTIFIER_LENGTH: usize = 256;
const MAX_RESULT_LENGTH: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityUsageKind {
    Skill,
    External,
    App,
    CommonTask,
    AutomaticTask,
}

impl CapabilityUsageKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::External => "external",
            Self::App => "app",
            Self::CommonTask => "common_task",
            Self::AutomaticTask => "automatic_task",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityUsageEvent {
    pub event_id: String,
    pub kind: CapabilityUsageKind,
    pub capability_id: String,
    pub recent_result: String,
    pub reference: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityUsageRecord {
    pub kind: CapabilityUsageKind,
    pub capability_id: String,
    pub last_success_at: String,
    pub success_count: u64,
    pub recent_result: String,
    pub reference: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityUsageData {
    version: u32,
    records: BTreeMap<String, CapabilityUsageRecord>,
    seen_event_ids: VecDeque<String>,
}

pub struct CapabilityUsageStore {
    path: PathBuf,
}

impl CapabilityUsageStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn default_path() -> PathBuf {
        Paths::in_state_dir("capability-usage-v1.json")
    }

    pub fn record_success(&self, event: CapabilityUsageEvent) -> Result<bool> {
        validate_event(&event)?;
        let lock = self.lock()?;
        let mut data = self.read()?;
        if data.seen_event_ids.iter().any(|id| id == &event.event_id) {
            drop(lock);
            return Ok(false);
        }

        let key = format!("{}:{}", event.kind.as_str(), event.capability_id);
        let timestamp =
            DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Secs, true);
        let entry = data.records.entry(key).or_insert(CapabilityUsageRecord {
            kind: event.kind,
            capability_id: event.capability_id,
            last_success_at: timestamp.clone(),
            success_count: 0,
            recent_result: String::new(),
            reference: None,
        });
        entry.success_count = entry.success_count.saturating_add(1);
        entry.last_success_at = timestamp;
        entry.recent_result = event.recent_result;
        entry.reference = event.reference;
        data.seen_event_ids.push_back(event.event_id);
        while data.seen_event_ids.len() > MAX_EVENT_IDS {
            data.seen_event_ids.pop_front();
        }
        self.persist(&data)?;
        drop(lock);
        Ok(true)
    }

    pub fn list(&self) -> Result<Vec<CapabilityUsageRecord>> {
        let lock = self.lock()?;
        let mut records = self.read()?.records.into_values().collect::<Vec<_>>();
        records.sort_by(|left, right| {
            right
                .last_success_at
                .cmp(&left.last_success_at)
                .then_with(|| left.capability_id.cmp(&right.capability_id))
        });
        drop(lock);
        Ok(records)
    }

    fn lock(&self) -> Result<File> {
        let parent = self
            .path
            .parent()
            .context("capability usage path has no parent directory")?;
        fs::create_dir_all(parent).context("failed to create capability usage directory")?;
        let mut lock_path = self.path.as_os_str().to_os_string();
        lock_path.push(".lock");
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(PathBuf::from(lock_path))
            .context("failed to open capability usage lock")?;
        lock.lock_exclusive()
            .context("failed to lock capability usage data")?;
        Ok(lock)
    }

    fn read(&self) -> Result<CapabilityUsageData> {
        if !self.path.exists() {
            return Ok(CapabilityUsageData {
                version: SCHEMA_VERSION,
                ..Default::default()
            });
        }
        let bytes = fs::read(&self.path).context("failed to read capability usage data")?;
        let data: CapabilityUsageData =
            serde_json::from_slice(&bytes).context("failed to parse capability usage data")?;
        anyhow::ensure!(
            data.version == SCHEMA_VERSION,
            "unsupported capability usage data version {}",
            data.version
        );
        Ok(data)
    }

    fn persist(&self, data: &CapabilityUsageData) -> Result<()> {
        let parent = self
            .path
            .parent()
            .context("capability usage path has no parent directory")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .context("failed to create capability usage temporary file")?;
        serde_json::to_writer_pretty(&mut temporary, data)
            .context("failed to encode capability usage data")?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&self.path)
            .map_err(|error| error.error)
            .context("failed to atomically replace capability usage data")?;
        Ok(())
    }
}

fn validate_event(event: &CapabilityUsageEvent) -> Result<()> {
    for (name, value, maximum) in [
        ("event ID", event.event_id.as_str(), MAX_IDENTIFIER_LENGTH),
        (
            "capability ID",
            event.capability_id.as_str(),
            MAX_IDENTIFIER_LENGTH,
        ),
        (
            "recent result",
            event.recent_result.as_str(),
            MAX_RESULT_LENGTH,
        ),
    ] {
        anyhow::ensure!(!value.trim().is_empty(), "{name} must not be empty");
        anyhow::ensure!(value.len() <= maximum, "{name} is too long");
    }
    if let Some(reference) = &event.reference {
        anyhow::ensure!(
            reference.len() <= MAX_IDENTIFIER_LENGTH,
            "reference is too long"
        );
    }
    Ok(())
}

pub static CAPABILITY_USAGE: Lazy<CapabilityUsageStore> =
    Lazy::new(|| CapabilityUsageStore::new(CapabilityUsageStore::default_path()));

#[cfg(not(test))]
pub fn record_capability_success(event: CapabilityUsageEvent) {
    if let Err(error) = CAPABILITY_USAGE.record_success(event) {
        tracing::warn!(%error, "failed to record capability usage");
    }
}

#[cfg(test)]
pub fn record_capability_success(_event: CapabilityUsageEvent) {}
