use super::{
    append_manifest_entry, hash_file, validate_plan_sources, write_migration_record,
    CodeBuddyPaths, MigrationDisposition, MigrationState, StorageDataClass, StorageMigrationItem,
    StorageMigrationPlan, StorageMigrationRecord,
};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationFailpoint {
    AfterStagedFiles(usize),
    BeforeManifestAppend(usize),
    BeforePublish,
    AfterPublishedFiles(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationReportStatus {
    NoRecord,
    NotRequired,
    MigrationRequired,
    Conflict,
    InsufficientSpace,
    Failed,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigrationConflictCandidate {
    pub source_id: String,
    pub size: u64,
    pub digest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigrationConflictItem {
    pub target_path: PathBuf,
    pub candidates: Vec<StorageMigrationConflictCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigrationReport {
    pub status: MigrationReportStatus,
    pub migration_id: uuid::Uuid,
    pub target_root: PathBuf,
    pub copied_files: u64,
    pub copied_bytes: u64,
    pub conflicts: u64,
    pub conflict_items: Vec<StorageMigrationConflictItem>,
    pub legacy_roots: Vec<PathBuf>,
    pub report_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SqliteArtifactReceipt {
    migration_id: uuid::Uuid,
    item_key: String,
    target_relative_path: PathBuf,
    size: u64,
    digest_sha256: String,
}

#[derive(Debug, Clone)]
pub struct StorageMigrator {
    paths: CodeBuddyPaths,
    failpoint: Option<MigrationFailpoint>,
    available_space_override: Option<u64>,
}

impl StorageMigrator {
    pub fn new(paths: CodeBuddyPaths) -> Self {
        Self {
            paths,
            failpoint: None,
            available_space_override: None,
        }
    }

    pub fn with_failpoint(mut self, failpoint: MigrationFailpoint) -> Self {
        self.failpoint = Some(failpoint);
        self
    }

    pub fn with_available_space_override(mut self, bytes: u64) -> Self {
        self.available_space_override = Some(bytes);
        self
    }

    pub fn not_required_report(&self) -> StorageMigrationReport {
        StorageMigrationReport {
            status: MigrationReportStatus::NotRequired,
            migration_id: uuid::Uuid::nil(),
            target_root: self.paths.home_dir().to_path_buf(),
            copied_files: 0,
            copied_bytes: 0,
            conflicts: 0,
            conflict_items: Vec::new(),
            legacy_roots: Vec::new(),
            report_path: None,
        }
    }

    pub fn preflight(&self, plan: &StorageMigrationPlan) -> Result<StorageMigrationReport> {
        if plan.target_root != self.paths.home_dir() {
            bail!("migration plan target does not match the configured CodeBuddy root");
        }
        let conflicts = plan
            .items
            .iter()
            .filter(|item| {
                matches!(
                    item.disposition,
                    MigrationDisposition::Conflict | MigrationDisposition::RejectBoundaryEscape
                )
            })
            .count() as u64
            + self.count_late_conflicts(plan)?;
        if conflicts > 0 {
            let mut report = self.report(plan, MigrationReportStatus::Conflict, 0, 0, conflicts);
            report.report_path = None;
            return Ok(report);
        }
        if plan.items.is_empty()
            || plan
                .items
                .iter()
                .all(|item| item.disposition == MigrationDisposition::SkipRebuildable)
        {
            return Ok(self.not_required_report());
        }
        if self.available_space()? < self.required_copy_bytes(plan)? {
            let mut report = self.report(plan, MigrationReportStatus::InsufficientSpace, 0, 0, 0);
            report.report_path = None;
            return Ok(report);
        }
        let mut report = self.report(plan, MigrationReportStatus::MigrationRequired, 0, 0, 0);
        report.report_path = None;
        Ok(report)
    }

    pub fn status_report(&self) -> Result<StorageMigrationReport> {
        let Some(record) = self.load_record()? else {
            let mut report = self.not_required_report();
            report.status = MigrationReportStatus::NoRecord;
            return Ok(report);
        };
        let status = match record.state {
            MigrationState::Committed => MigrationReportStatus::Committed,
            MigrationState::Failed => match record.redacted_error.as_deref() {
                Some("preflight_conflict" | "target_conflict") => MigrationReportStatus::Conflict,
                Some("insufficient_space") => MigrationReportStatus::InsufficientSpace,
                _ => MigrationReportStatus::Failed,
            },
            _ => MigrationReportStatus::MigrationRequired,
        };
        let (copied_files, copied_bytes) = manifest_totals(&record.manifest_path)?;
        Ok(StorageMigrationReport {
            status,
            migration_id: record.migration_id,
            target_root: record.target_root,
            copied_files,
            copied_bytes,
            conflicts: u64::from(status == MigrationReportStatus::Conflict),
            conflict_items: Vec::new(),
            legacy_roots: record
                .sources
                .into_iter()
                .map(|source| source.root)
                .collect(),
            report_path: Some(if status == MigrationReportStatus::Committed {
                record.manifest_path
            } else {
                self.paths.migrations_dir().join("migration.json")
            }),
        })
    }

    pub fn pending_plan(&self) -> Result<Option<StorageMigrationPlan>> {
        let Some(record) = self.load_record()? else {
            return Ok(None);
        };
        if record.state == MigrationState::Committed {
            return Ok(None);
        }
        let path = self
            .paths
            .migrations_dir()
            .join("plans")
            .join(format!("{}.json", record.migration_id));
        match fs::read(path) {
            Ok(bytes) => {
                let plan: StorageMigrationPlan = serde_json::from_slice(&bytes)?;
                if plan.migration_id != record.migration_id
                    || plan.target_root != record.target_root
                    || plan.source_fingerprints != record.sources
                {
                    bail!("persisted migration plan does not match its migration record");
                }
                validate_plan_sources(&plan)?;
                Ok(Some(plan))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn execute(&self, plan: &StorageMigrationPlan) -> Result<StorageMigrationReport> {
        if plan.target_root != self.paths.home_dir() {
            bail!("migration plan target does not match the configured CodeBuddy root");
        }
        validate_plan_sources(plan)?;

        let mut record = StorageMigrationRecord::planned(plan, plan.target_root.clone());
        if let Some(persisted) = self.load_record()? {
            if persisted.migration_id == plan.migration_id
                && persisted.state == MigrationState::Committed
            {
                validate_plan_sources(plan)?;
                return Ok(self.report(plan, MigrationReportStatus::Committed, 0, 0, 0));
            }
        }
        self.write_plan(plan)?;
        write_migration_record(&self.paths, &record)?;

        match self.execute_inner(plan, &mut record).await {
            Ok(report) => Ok(report),
            Err(error) => {
                record.state = MigrationState::Failed;
                record.updated_at = Utc::now();
                record.redacted_error = Some(redacted_error_code(&error));
                let _ = write_migration_record(&self.paths, &record);
                Err(error)
            }
        }
    }

    async fn execute_inner(
        &self,
        plan: &StorageMigrationPlan,
        record: &mut StorageMigrationRecord,
    ) -> Result<StorageMigrationReport> {
        validate_plan_sources(plan)?;

        let planned_conflicts = plan
            .items
            .iter()
            .filter(|item| {
                matches!(
                    item.disposition,
                    MigrationDisposition::Conflict | MigrationDisposition::RejectBoundaryEscape
                )
            })
            .count() as u64;
        if planned_conflicts > 0 {
            self.mark_failed(record, "preflight_conflict")?;
            return Ok(self.report(
                plan,
                MigrationReportStatus::Conflict,
                0,
                0,
                planned_conflicts,
            ));
        }

        let late_conflicts = self.count_late_conflicts(plan)?;
        if late_conflicts > 0 {
            self.mark_failed(record, "target_conflict")?;
            return Ok(self.report(plan, MigrationReportStatus::Conflict, 0, 0, late_conflicts));
        }

        let required_bytes = self.required_copy_bytes(plan)?;
        if self.available_space()? < required_bytes {
            self.mark_failed(record, "insufficient_space")?;
            return Ok(self.report(plan, MigrationReportStatus::InsufficientSpace, 0, 0, 0));
        }

        self.persist_state(record, MigrationState::Copying, None)?;
        let staging_root = self.staging_root(plan);
        fs::create_dir_all(&staging_root)?;
        let mut manifest_entries = self.read_manifest_keys(plan)?;
        let mut staged_files = 0_usize;

        for item in &plan.items {
            if !matches!(
                item.disposition,
                MigrationDisposition::Copy | MigrationDisposition::LegacyUnclassified
            ) {
                continue;
            }
            let Some(target_relative) = &item.target_relative_path else {
                continue;
            };
            let target = plan.target_root.join(target_relative);
            if self.published_matches_item(plan, item, &target)? {
                continue;
            }

            let source = source_path(plan, item)?;
            let staged = staging_root.join(target_relative);
            if is_sqlite_snapshot_item(plan, item) {
                stage_sqlite_snapshot(&source, &staged).await?;
            } else {
                stage_file(&source, &staged, item)?;
            }
            staged_files += 1;

            let manifest_key = manifest_key(item);
            if !manifest_entries.contains(&manifest_key) {
                if self.failpoint == Some(MigrationFailpoint::BeforeManifestAppend(staged_files)) {
                    bail!("injected migration failure before manifest append");
                }
                append_manifest_entry(&self.paths, plan.migration_id, item)?;
                manifest_entries.insert(manifest_key);
            }

            if self.failpoint == Some(MigrationFailpoint::AfterStagedFiles(staged_files)) {
                bail!("injected migration failure after staged file");
            }
        }

        self.persist_state(record, MigrationState::Verifying, None)?;
        self.verify_staging(plan, &staging_root).await?;
        self.persist_state(record, MigrationState::ReadyToCommit, None)?;
        self.persist_sqlite_artifact_receipts(plan, &staging_root)?;

        if self.failpoint == Some(MigrationFailpoint::BeforePublish) {
            bail!("injected migration failure before publish");
        }

        let (copied_files, copied_bytes) = self.publish_staging(plan, &staging_root)?;
        self.persist_state(record, MigrationState::Committed, None)?;
        Ok(self.report(
            plan,
            MigrationReportStatus::Committed,
            copied_files,
            copied_bytes,
            0,
        ))
    }

    fn load_record(&self) -> Result<Option<StorageMigrationRecord>> {
        let path = self.paths.migrations_dir().join("migration.json");
        match fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write_plan(&self, plan: &StorageMigrationPlan) -> Result<()> {
        let directory = self.paths.migrations_dir().join("plans");
        fs::create_dir_all(&directory)?;
        let destination = directory.join(format!("{}.json", plan.migration_id));
        if destination.is_file() {
            let persisted: StorageMigrationPlan = serde_json::from_slice(&fs::read(&destination)?)?;
            if persisted != *plan {
                bail!("persisted migration plan does not match the requested migration");
            }
            return Ok(());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        serde_json::to_writer_pretty(&mut temporary, plan)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .map_err(|error| error.error)?;
        Ok(())
    }

    fn persist_state(
        &self,
        record: &mut StorageMigrationRecord,
        state: MigrationState,
        error_code: Option<&str>,
    ) -> Result<()> {
        record.state = state;
        record.updated_at = Utc::now();
        record.redacted_error = error_code.map(str::to_owned);
        write_migration_record(&self.paths, record)?;
        Ok(())
    }

    fn mark_failed(&self, record: &mut StorageMigrationRecord, code: &str) -> Result<()> {
        self.persist_state(record, MigrationState::Failed, Some(code))
    }

    fn staging_root(&self, plan: &StorageMigrationPlan) -> PathBuf {
        self.paths
            .migrations_dir()
            .join("staging")
            .join(plan.migration_id.to_string())
    }

    fn available_space(&self) -> Result<u64> {
        if let Some(bytes) = self.available_space_override {
            return Ok(bytes);
        }
        let mut probe = self.paths.home_dir();
        while !probe.exists() {
            probe = probe
                .parent()
                .context("CodeBuddy target has no existing filesystem ancestor")?;
        }
        fs2::available_space(probe).map_err(Into::into)
    }

    fn required_copy_bytes(&self, plan: &StorageMigrationPlan) -> Result<u64> {
        let mut total = 0_u64;
        for item in &plan.items {
            if !matches!(
                item.disposition,
                MigrationDisposition::Copy | MigrationDisposition::LegacyUnclassified
            ) {
                continue;
            }
            let Some(target) = &item.target_relative_path else {
                continue;
            };
            let destination = plan.target_root.join(target);
            if self.published_matches_item(plan, item, &destination)? {
                continue;
            }
            total = total
                .checked_add(item.size)
                .context("migration byte count overflow")?;
        }
        Ok(total)
    }

    fn count_late_conflicts(&self, plan: &StorageMigrationPlan) -> Result<u64> {
        let mut conflicts = 0_u64;
        for item in &plan.items {
            if !matches!(
                item.disposition,
                MigrationDisposition::Copy | MigrationDisposition::LegacyUnclassified
            ) {
                continue;
            }
            let Some(target) = &item.target_relative_path else {
                continue;
            };
            let destination = plan.target_root.join(target);
            match fs::symlink_metadata(&destination) {
                Ok(metadata)
                    if !metadata.is_file()
                        || !self.published_matches_item(plan, item, &destination)? =>
                {
                    conflicts += 1;
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(conflicts)
    }

    fn read_manifest_keys(&self, plan: &StorageMigrationPlan) -> Result<BTreeSet<String>> {
        let path = self
            .paths
            .migrations_dir()
            .join("manifests")
            .join(format!("{}.jsonl", plan.migration_id));
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeSet::new())
            }
            Err(error) => return Err(error.into()),
        };
        let mut keys = BTreeSet::new();
        for line in BufReader::new(file).lines() {
            let item: StorageMigrationItem = serde_json::from_str(&line?)?;
            keys.insert(manifest_key(&item));
        }
        Ok(keys)
    }

    async fn verify_staging(&self, plan: &StorageMigrationPlan, staging: &Path) -> Result<()> {
        for item in &plan.items {
            if !matches!(
                item.disposition,
                MigrationDisposition::Copy | MigrationDisposition::LegacyUnclassified
            ) {
                continue;
            }
            let Some(target_relative) = &item.target_relative_path else {
                continue;
            };
            let published = plan.target_root.join(target_relative);
            let sqlite_snapshot = is_sqlite_snapshot_item(plan, item);
            let candidate = if self.published_matches_item(plan, item, &published)? {
                published
            } else {
                staging.join(target_relative)
            };
            if !sqlite_snapshot && !file_matches_item(&candidate, item)? {
                bail!("staged migration file failed SHA-256 verification");
            }
            verify_structured_file(&candidate, item.data_class).await?;
        }
        Ok(())
    }

    fn publish_staging(&self, plan: &StorageMigrationPlan, staging: &Path) -> Result<(u64, u64)> {
        let mut copied_files = 0_u64;
        let mut copied_bytes = 0_u64;
        for item in &plan.items {
            if !matches!(
                item.disposition,
                MigrationDisposition::Copy | MigrationDisposition::LegacyUnclassified
            ) {
                continue;
            }
            let Some(target_relative) = &item.target_relative_path else {
                continue;
            };
            let target = plan.target_root.join(target_relative);
            if self.published_matches_item(plan, item, &target)? {
                continue;
            }
            if fs::symlink_metadata(&target).is_ok() {
                bail!("target changed during migration publish");
            }
            let staged = staging.join(target_relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&staged, &target).with_context(|| {
                format!(
                    "failed to atomically publish {} within the target volume",
                    target.display()
                )
            })?;
            copied_files += 1;
            copied_bytes = copied_bytes
                .checked_add(item.size)
                .context("published byte count overflow")?;
            if self.failpoint
                == Some(MigrationFailpoint::AfterPublishedFiles(
                    copied_files as usize,
                ))
            {
                bail!("injected migration failure after published file");
            }
        }
        Ok((copied_files, copied_bytes))
    }

    fn sqlite_receipt_path(&self, plan: &StorageMigrationPlan) -> PathBuf {
        self.paths
            .migrations_dir()
            .join("receipts")
            .join(format!("{}.json", plan.migration_id))
    }

    fn persist_sqlite_artifact_receipts(
        &self,
        plan: &StorageMigrationPlan,
        staging: &Path,
    ) -> Result<()> {
        let receipt_path = self.sqlite_receipt_path(plan);
        let existing: Vec<SqliteArtifactReceipt> = match fs::read(&receipt_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        let mut receipts = BTreeMap::new();
        for item in &plan.items {
            if !is_sqlite_snapshot_item(plan, item) {
                continue;
            }
            let Some(target_relative_path) = &item.target_relative_path else {
                continue;
            };
            let key = (
                plan.migration_id,
                manifest_key(item),
                target_relative_path.clone(),
            );
            let published = plan.target_root.join(target_relative_path);
            if let Some(receipt) = existing.iter().find(|receipt| {
                receipt.migration_id == key.0
                    && receipt.item_key == key.1
                    && receipt.target_relative_path == key.2
            }) {
                if published.is_file()
                    && fs::metadata(&published)?.len() == receipt.size
                    && hash_file(&published)? == receipt.digest_sha256
                {
                    receipts.insert(key.clone(), receipt.clone());
                }
            }
            let artifact = staging.join(target_relative_path);
            if !artifact.is_file() {
                continue;
            }
            let file = OpenOptions::new().read(true).write(true).open(&artifact)?;
            file.sync_all()?;
            receipts.insert(
                key,
                SqliteArtifactReceipt {
                    migration_id: plan.migration_id,
                    item_key: manifest_key(item),
                    target_relative_path: target_relative_path.clone(),
                    size: file.metadata()?.len(),
                    digest_sha256: hash_file(&artifact)?,
                },
            );
        }
        if receipts.is_empty() {
            return Ok(());
        }
        let path = receipt_path;
        let directory = path.parent().context("SQLite receipt path has no parent")?;
        fs::create_dir_all(directory)?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut temporary, &receipts.into_values().collect::<Vec<_>>())?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path).map_err(|error| error.error)?;
        Ok(())
    }

    fn published_matches_item(
        &self,
        plan: &StorageMigrationPlan,
        item: &StorageMigrationItem,
        target: &Path,
    ) -> Result<bool> {
        if file_matches_item(target, item)? {
            return Ok(true);
        }
        if !is_sqlite_snapshot_item(plan, item) || !target.is_file() {
            return Ok(false);
        }
        let bytes = match fs::read(self.sqlite_receipt_path(plan)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let receipts: Vec<SqliteArtifactReceipt> = serde_json::from_slice(&bytes)?;
        let Some(relative) = &item.target_relative_path else {
            return Ok(false);
        };
        let Some(receipt) = receipts.iter().find(|receipt| {
            receipt.migration_id == plan.migration_id
                && receipt.item_key == manifest_key(item)
                && receipt.target_relative_path == *relative
        }) else {
            return Ok(false);
        };
        Ok(fs::metadata(target)?.len() == receipt.size
            && hash_file(target)? == receipt.digest_sha256)
    }

    fn report(
        &self,
        plan: &StorageMigrationPlan,
        status: MigrationReportStatus,
        copied_files: u64,
        copied_bytes: u64,
        conflicts: u64,
    ) -> StorageMigrationReport {
        StorageMigrationReport {
            status,
            migration_id: plan.migration_id,
            target_root: plan.target_root.clone(),
            copied_files,
            copied_bytes,
            conflicts,
            conflict_items: if status == MigrationReportStatus::Conflict {
                self.conflict_items(plan)
            } else {
                Vec::new()
            },
            legacy_roots: plan
                .sources
                .iter()
                .map(|source| source.root.clone())
                .collect(),
            report_path: Some(if status == MigrationReportStatus::Committed {
                self.paths
                    .migrations_dir()
                    .join("manifests")
                    .join(format!("{}.jsonl", plan.migration_id))
            } else {
                self.paths.migrations_dir().join("migration.json")
            }),
        }
    }

    fn conflict_items(&self, plan: &StorageMigrationPlan) -> Vec<StorageMigrationConflictItem> {
        const MAX_CONFLICT_ITEMS: usize = 100;
        let mut grouped =
            std::collections::BTreeMap::<PathBuf, Vec<StorageMigrationConflictCandidate>>::new();
        for item in &plan.items {
            let Some(target_path) = item.target_relative_path.as_ref() else {
                continue;
            };
            if item.disposition == MigrationDisposition::Conflict {
                if let Some(digest_sha256) = item.digest_sha256.as_ref() {
                    grouped.entry(target_path.clone()).or_default().push(
                        StorageMigrationConflictCandidate {
                            source_id: item.source_id.clone(),
                            size: item.size,
                            digest_sha256: digest_sha256.clone(),
                        },
                    );
                }
            }
            let destination = plan.target_root.join(target_path);
            if matches!(
                item.disposition,
                MigrationDisposition::Copy
                    | MigrationDisposition::LegacyUnclassified
                    | MigrationDisposition::Conflict
            ) && destination.is_file()
                && !file_matches_item(&destination, item).unwrap_or(false)
            {
                if let (Ok(metadata), Ok(digest_sha256)) =
                    (fs::metadata(&destination), hash_file(&destination))
                {
                    let candidates = grouped.entry(target_path.clone()).or_default();
                    candidates.push(StorageMigrationConflictCandidate {
                        source_id: item.source_id.clone(),
                        size: item.size,
                        digest_sha256: item.digest_sha256.clone().unwrap_or_default(),
                    });
                    candidates.push(StorageMigrationConflictCandidate {
                        source_id: "unified-target".to_owned(),
                        size: metadata.len(),
                        digest_sha256,
                    });
                }
            }
        }
        grouped
            .into_iter()
            .take(MAX_CONFLICT_ITEMS)
            .map(|(target_path, mut candidates)| {
                candidates.sort_by(|left, right| left.source_id.cmp(&right.source_id));
                candidates.dedup();
                candidates.truncate(16);
                StorageMigrationConflictItem {
                    target_path,
                    candidates,
                }
            })
            .collect()
    }
}

fn source_path(plan: &StorageMigrationPlan, item: &StorageMigrationItem) -> Result<PathBuf> {
    let source = plan
        .sources
        .iter()
        .find(|source| source.id == item.source_id)
        .context("manifest item references an unknown legacy source")?;
    let path = source.root.join(&item.source_relative_path);
    let canonical_parent = fs::canonicalize(
        path.parent()
            .context("legacy source item has no parent directory")?,
    )?;
    let canonical_root = fs::canonicalize(&source.root)?;
    if !canonical_parent.starts_with(&canonical_root) {
        bail!("legacy source item escaped its source root");
    }
    Ok(path)
}

fn stage_file(source: &Path, destination: &Path, item: &StorageMigrationItem) -> Result<()> {
    if destination.is_file() && file_matches_item(destination, item)? {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = destination
        .parent()
        .context("staging destination has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut input = File::open(source)?;
    std::io::copy(&mut input, &mut temporary)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(destination)
        .map_err(|error| error.error)?;
    if !file_matches_item(destination, item)? {
        bail!("staged migration file does not match the planned digest");
    }
    Ok(())
}

async fn stage_sqlite_snapshot(source: &Path, destination: &Path) -> Result<()> {
    if destination.is_file() && verify_sqlite(destination).await.is_ok() {
        return Ok(());
    }
    if fs::symlink_metadata(destination).is_ok() {
        fs::remove_file(destination)?;
    }
    let parent = destination
        .parent()
        .context("SQLite staging destination has no parent")?;
    fs::create_dir_all(parent)?;

    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    let (file, temporary_path) = temporary.keep()?;
    drop(file);

    let options = SqliteConnectOptions::new()
        .filename(source)
        .read_only(true)
        .create_if_missing(false);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .with_context(|| format!("SQLite snapshot failed for {}", source.display()))?;
    let snapshot_result = sqlx::query("VACUUM INTO ?1")
        .bind(temporary_path.to_string_lossy().as_ref())
        .execute(&mut connection)
        .await;
    connection.close().await?;
    if let Err(error) = snapshot_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error)
            .with_context(|| format!("SQLite snapshot failed for {}", source.display()));
    }

    verify_sqlite(&temporary_path).await?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temporary_path)
        .with_context(|| {
            format!(
                "failed to reopen SQLite snapshot {} for durable sync",
                temporary_path.display()
            )
        })?
        .sync_all()?;
    fs::rename(&temporary_path, destination).with_context(|| {
        format!(
            "failed to publish SQLite snapshot into staging at {}",
            destination.display()
        )
    })?;
    Ok(())
}

fn is_sqlite_snapshot_item(plan: &StorageMigrationPlan, item: &StorageMigrationItem) -> bool {
    if item.data_class != StorageDataClass::Session
        || !matches!(
            item.source_relative_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("db" | "sqlite" | "sqlite3")
        )
    {
        return false;
    }

    let mut wal = item.source_relative_path.as_os_str().to_os_string();
    wal.push("-wal");
    let mut shm = item.source_relative_path.as_os_str().to_os_string();
    shm.push("-shm");
    let wal = PathBuf::from(wal);
    let shm = PathBuf::from(shm);
    plan.items.iter().any(|candidate| {
        candidate.source_id == item.source_id
            && (candidate.source_relative_path == wal || candidate.source_relative_path == shm)
    })
}

fn file_matches_item(path: &Path, item: &StorageMigrationItem) -> Result<bool> {
    let Some(expected) = item.digest_sha256.as_deref() else {
        return Ok(false);
    };
    if !path.is_file() || fs::metadata(path)?.len() != item.size {
        return Ok(false);
    }
    Ok(hash_file(path)? == expected)
}

fn manifest_key(item: &StorageMigrationItem) -> String {
    format!(
        "{}\0{}",
        item.source_id,
        item.source_relative_path.to_string_lossy()
    )
}

fn manifest_totals(path: &Path) -> Result<(u64, u64)> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => return Err(error.into()),
    };
    let mut files = 0_u64;
    let mut bytes = 0_u64;
    for line in BufReader::new(file).lines() {
        let item: StorageMigrationItem = serde_json::from_str(&line?)?;
        files = files
            .checked_add(1)
            .context("manifest file count overflow")?;
        bytes = bytes
            .checked_add(item.size)
            .context("manifest byte count overflow")?;
    }
    Ok((files, bytes))
}

async fn verify_structured_file(path: &Path, data_class: StorageDataClass) -> Result<()> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("json") => {
            serde_json::from_slice::<serde_json::Value>(&fs::read(path)?)
                .with_context(|| format!("JSON verification failed for {}", path.display()))?;
        }
        Some("yaml" | "yml") => {
            serde_yaml::from_slice::<serde_yaml::Value>(&fs::read(path)?)
                .with_context(|| format!("YAML verification failed for {}", path.display()))?;
        }
        Some("toml") => {
            toml::from_str::<toml::Value>(&fs::read_to_string(path)?)
                .with_context(|| format!("TOML verification failed for {}", path.display()))?;
        }
        Some("db" | "sqlite" | "sqlite3") if data_class == StorageDataClass::Session => {
            verify_sqlite(path).await?;
        }
        _ => {}
    }
    Ok(())
}

async fn verify_sqlite(path: &Path) -> Result<()> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .with_context(|| format!("SQLite verification failed for {}", path.display()))?;
    let rows = sqlx::query("PRAGMA integrity_check")
        .fetch_all(&mut connection)
        .await
        .with_context(|| format!("SQLite integrity check failed for {}", path.display()))?;
    let valid = rows
        .iter()
        .all(|row| matches!(row.try_get::<String, _>(0), Ok(value) if value == "ok"));
    connection.close().await?;
    if !valid {
        bail!("SQLite integrity check failed for {}", path.display());
    }
    Ok(())
}

fn redacted_error_code(error: &anyhow::Error) -> String {
    let message = error.to_string();
    if message.contains("JSON") {
        "invalid_json"
    } else if message.contains("YAML") {
        "invalid_yaml"
    } else if message.contains("TOML") {
        "invalid_toml"
    } else if message.contains("SQLite") {
        "invalid_sqlite"
    } else if message.contains("source changed") {
        "source_changed"
    } else if message.contains("injected migration failure") {
        "injected_failure"
    } else {
        "migration_failed"
    }
    .to_string()
}
