use super::policy::{
    LOG_RETENTION, REBUILDABLE_BACKEND_CACHE_SOFT_BUDGET, RUN_RETENTION, RUN_SOFT_BUDGET,
};
use crate::config::codebuddy_paths::CodeBuddyPaths;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::cmp::{max, min};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const DEFAULT_MAX_ENTRIES: u64 = 1_000_000;
const DEFAULT_MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum StorageCategory {
    Sessions,
    Runs,
    Memory,
    Audit,
    Logs,
    McpCache,
    ModelMetadataCache,
    DownloadedModels,
    Plugins,
    ProfileConfig,
    DeviceConfig,
    LegacyMigrationSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageInventoryIssue {
    pub code: String,
    pub relative_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageCategoryUsage {
    pub category: StorageCategory,
    pub bytes: u64,
    pub files: u64,
    pub reclaimable_bytes: u64,
    pub oldest_at: Option<DateTime<Utc>>,
    pub newest_at: Option<DateTime<Utc>>,
    pub automatic_policy: Option<String>,
    pub protected_reason: Option<String>,
    pub complete: bool,
    pub issues: Vec<StorageInventoryIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageUsageReport {
    pub root: PathBuf,
    pub inspected_at: DateTime<Utc>,
    pub total_bytes: u64,
    pub total_files: u64,
    pub reclaimable_bytes: u64,
    pub complete: bool,
    pub categories: Vec<StorageCategoryUsage>,
}

impl StorageUsageReport {
    pub fn category(&self, category: StorageCategory) -> Option<&StorageCategoryUsage> {
        self.categories
            .iter()
            .find(|usage| usage.category == category)
    }
}

#[derive(Debug, Clone)]
pub struct StorageInventory {
    max_entries: u64,
    max_depth: usize,
}

impl Default for StorageInventory {
    fn default() -> Self {
        Self {
            max_entries: DEFAULT_MAX_ENTRIES,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

impl StorageInventory {
    pub fn inspect(&self, paths: &CodeBuddyPaths) -> Result<StorageUsageReport> {
        let root = paths.home_dir();
        let mut categories = vec![
            self.protected(
                root,
                StorageCategory::Sessions,
                paths.sessions_dir(),
                "explicit_user_deletion_required",
            ),
            self.inspect_runs(root, &paths.runs_dir()),
            self.protected(
                root,
                StorageCategory::Memory,
                paths.memory_dir(),
                "project_memory_is_protected",
            ),
            self.protected_with_policy(
                root,
                StorageCategory::Audit,
                paths.audit_dir(),
                "completed_records_only_after_state_aware_cleanup",
                "unresolved_audit_records_are_protected",
            ),
            self.inspect_logs(root, &paths.logs_dir()),
            self.rebuildable_cache(
                root,
                StorageCategory::McpCache,
                paths.profile_cache_dir().join("mcp"),
            ),
            self.rebuildable_cache(
                root,
                StorageCategory::ModelMetadataCache,
                paths.profile_cache_dir().join("models"),
            ),
            self.protected(
                root,
                StorageCategory::DownloadedModels,
                paths.models_dir(),
                "explicit_per_model_deletion_required",
            ),
            self.protected(
                root,
                StorageCategory::Plugins,
                paths.plugins_packages_dir(),
                "installed_plugins_are_protected",
            ),
            self.protected(
                root,
                StorageCategory::ProfileConfig,
                paths.profile_config_dir(),
                "profile_configuration_is_protected",
            ),
            self.protected(
                root,
                StorageCategory::DeviceConfig,
                paths.app_config_dir(),
                "device_configuration_is_protected",
            ),
            self.protected(
                root,
                StorageCategory::LegacyMigrationSource,
                paths.migrations_dir().join("legacy-unclassified"),
                "manual_review_and_confirmation_required",
            ),
        ];
        categories.sort_by_key(|usage| category_order(usage.category));

        let mut total_bytes = 0_u64;
        let mut total_files = 0_u64;
        let mut reclaimable_bytes = 0_u64;
        for usage in &categories {
            total_bytes = total_bytes.saturating_add(usage.bytes);
            total_files = total_files.saturating_add(usage.files);
            reclaimable_bytes = reclaimable_bytes.saturating_add(usage.reclaimable_bytes);
        }
        Ok(StorageUsageReport {
            root: root.to_path_buf(),
            inspected_at: Utc::now(),
            total_bytes,
            total_files,
            reclaimable_bytes,
            complete: categories.iter().all(|usage| usage.complete),
            categories,
        })
    }

    fn protected(
        &self,
        home: &Path,
        category: StorageCategory,
        root: PathBuf,
        reason: &str,
    ) -> StorageCategoryUsage {
        self.usage_from_scan(
            category,
            self.scan_tree(home, &root),
            0,
            None,
            Some(reason.to_string()),
        )
    }

    fn protected_with_policy(
        &self,
        home: &Path,
        category: StorageCategory,
        root: PathBuf,
        policy: &str,
        reason: &str,
    ) -> StorageCategoryUsage {
        self.usage_from_scan(
            category,
            self.scan_tree(home, &root),
            0,
            Some(policy.to_string()),
            Some(reason.to_string()),
        )
    }

    fn rebuildable_cache(
        &self,
        home: &Path,
        category: StorageCategory,
        root: PathBuf,
    ) -> StorageCategoryUsage {
        let scan = self.scan_tree(home, &root);
        let reclaimable = scan.bytes;
        self.usage_from_scan(
            category,
            scan,
            reclaimable,
            Some(format!(
                "rebuildable_cache_soft_budget_{}_bytes",
                REBUILDABLE_BACKEND_CACHE_SOFT_BUDGET
            )),
            None,
        )
    }

    fn inspect_logs(&self, home: &Path, root: &Path) -> StorageCategoryUsage {
        let scan = self.scan_tree(home, root);
        let reclaimable = scan
            .files_seen
            .iter()
            .filter(|file| older_than(file.modified, LOG_RETENTION))
            .fold(0_u64, |total, file| total.saturating_add(file.bytes));
        self.usage_from_scan(
            StorageCategory::Logs,
            scan,
            reclaimable,
            Some("files_older_than_14_days".to_string()),
            None,
        )
    }

    fn inspect_runs(&self, home: &Path, root: &Path) -> StorageCategoryUsage {
        let mut aggregate = ScanResult::default();
        let mut terminal_candidates = Vec::new();
        match fs::symlink_metadata(root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return self.usage_from_scan(
                    StorageCategory::Runs,
                    aggregate,
                    0,
                    Some("terminal_runs_older_than_30_days_or_over_2_gib".to_string()),
                    Some("nonterminal_runs_are_protected".to_string()),
                );
            }
            Ok(metadata) if is_link_or_reparse_point(&metadata) => {
                aggregate.issue(home, root, "link_skipped");
                return self.usage_from_scan(
                    StorageCategory::Runs,
                    aggregate,
                    0,
                    Some("terminal_runs_older_than_30_days_or_over_2_gib".to_string()),
                    Some("nonterminal_runs_are_protected".to_string()),
                );
            }
            Ok(metadata) if !metadata.is_dir() => {
                aggregate.issue(home, root, "unsupported_file_type");
                return self.usage_from_scan(
                    StorageCategory::Runs,
                    aggregate,
                    0,
                    Some("terminal_runs_older_than_30_days_or_over_2_gib".to_string()),
                    Some("nonterminal_runs_are_protected".to_string()),
                );
            }
            Ok(_) => {}
            Err(_) => {
                aggregate.issue(home, root, "metadata_unavailable");
                return self.usage_from_scan(
                    StorageCategory::Runs,
                    aggregate,
                    0,
                    Some("terminal_runs_older_than_30_days_or_over_2_gib".to_string()),
                    Some("nonterminal_runs_are_protected".to_string()),
                );
            }
        }

        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(_) => {
                aggregate.issue(home, root, "directory_unreadable");
                return self.usage_from_scan(
                    StorageCategory::Runs,
                    aggregate,
                    0,
                    Some("terminal_runs_older_than_30_days_or_over_2_gib".to_string()),
                    Some("nonterminal_runs_are_protected".to_string()),
                );
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    aggregate.issue(home, root, "directory_entry_unreadable");
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    aggregate.issue(home, &path, "metadata_unavailable");
                    continue;
                }
            };
            if is_link_or_reparse_point(&metadata) {
                aggregate.issue(home, &path, "link_skipped");
                continue;
            }
            if !metadata.is_dir() {
                let single = self.scan_tree(home, &path);
                aggregate.merge(single);
                continue;
            }
            let run_scan = self.scan_tree(home, &path);
            let run_bytes = run_scan.bytes;
            let run_id = entry.file_name();
            let is_control_plane = run_id
                .to_string_lossy()
                .eq_ignore_ascii_case("control-plane");
            if !is_control_plane {
                let state_path = path.join("run").join("state.json");
                match read_run_retention(&state_path) {
                    Some(retention) if retention.terminal => terminal_candidates.push((
                        retention.updated_at,
                        run_bytes,
                        older_than_datetime(retention.updated_at, RUN_RETENTION),
                    )),
                    Some(_) => {}
                    None => aggregate.issue(home, &state_path, "invalid_run_state"),
                }
            }
            aggregate.merge(run_scan);
        }

        terminal_candidates.sort_by_key(|(updated_at, _, _)| *updated_at);
        let mut reclaimable = terminal_candidates
            .iter()
            .filter(|(_, _, expired)| *expired)
            .fold(0_u64, |total, (_, bytes, _)| total.saturating_add(*bytes));
        let mut remaining = aggregate.bytes.saturating_sub(reclaimable);
        if remaining > RUN_SOFT_BUDGET {
            for (_, bytes, expired) in terminal_candidates {
                if expired || remaining <= RUN_SOFT_BUDGET {
                    continue;
                }
                reclaimable = reclaimable.saturating_add(bytes);
                remaining = remaining.saturating_sub(bytes);
            }
        }
        self.usage_from_scan(
            StorageCategory::Runs,
            aggregate,
            reclaimable,
            Some("terminal_runs_older_than_30_days_or_over_2_gib".to_string()),
            Some("nonterminal_runs_are_protected".to_string()),
        )
    }

    fn usage_from_scan(
        &self,
        category: StorageCategory,
        scan: ScanResult,
        reclaimable_bytes: u64,
        automatic_policy: Option<String>,
        protected_reason: Option<String>,
    ) -> StorageCategoryUsage {
        StorageCategoryUsage {
            category,
            bytes: scan.bytes,
            files: scan.files,
            reclaimable_bytes: reclaimable_bytes.min(scan.bytes),
            oldest_at: scan.oldest_at,
            newest_at: scan.newest_at,
            automatic_policy,
            protected_reason,
            complete: scan.complete,
            issues: scan.issues,
        }
    }

    fn scan_tree(&self, home: &Path, root: &Path) -> ScanResult {
        let mut result = ScanResult::default();
        let root_metadata = match fs::symlink_metadata(root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return result,
            Err(_) => {
                result.issue(home, root, "metadata_unavailable");
                return result;
            }
        };
        if is_link_or_reparse_point(&root_metadata) {
            result.issue(home, root, "link_skipped");
            return result;
        }
        if root_metadata.is_file() {
            result.add_file(home, root, &root_metadata, self.max_entries);
            return result;
        }
        if !root_metadata.is_dir() {
            result.issue(home, root, "unsupported_file_type");
            return result;
        }

        let mut pending = vec![(root.to_path_buf(), 0_usize)];
        while let Some((directory, depth)) = pending.pop() {
            if depth > self.max_depth {
                result.issue(home, &directory, "depth_limit_exceeded");
                continue;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => {
                    result.issue(home, &directory, "directory_unreadable");
                    continue;
                }
            };
            for entry in entries {
                if result.entries_seen >= self.max_entries {
                    result.issue(home, &directory, "entry_limit_exceeded");
                    return result;
                }
                result.entries_seen = result.entries_seen.saturating_add(1);
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        result.issue(home, &directory, "directory_entry_unreadable");
                        continue;
                    }
                };
                let path = entry.path();
                let first = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        result.issue(home, &path, "metadata_unavailable");
                        continue;
                    }
                };
                if is_link_or_reparse_point(&first) {
                    result.issue(home, &path, "link_skipped");
                    continue;
                }
                if first.is_dir() {
                    pending.push((path, depth.saturating_add(1)));
                } else if first.is_file() {
                    let second = match fs::symlink_metadata(&path) {
                        Ok(metadata) => metadata,
                        Err(_) => {
                            result.issue(home, &path, "entry_changed_during_scan");
                            continue;
                        }
                    };
                    if !same_snapshot(&first, &second) {
                        result.issue(home, &path, "entry_changed_during_scan");
                        continue;
                    }
                    result.add_file(home, &path, &second, self.max_entries);
                } else {
                    result.issue(home, &path, "unsupported_file_type");
                }
            }
        }
        result
    }
}

#[derive(Debug, Clone)]
struct RunRetention {
    terminal: bool,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct StoredRunRetention {
    status: String,
    updated_at: DateTime<Utc>,
}

fn read_run_retention(path: &Path) -> Option<RunRetention> {
    let bytes = fs::read(path).ok()?;
    let stored: StoredRunRetention = serde_json::from_slice(&bytes).ok()?;
    let terminal = matches!(stored.status.as_str(), "completed" | "failed" | "discarded");
    Some(RunRetention {
        terminal,
        updated_at: stored.updated_at,
    })
}

#[derive(Debug, Clone)]
struct ScanResult {
    bytes: u64,
    files: u64,
    entries_seen: u64,
    oldest_at: Option<DateTime<Utc>>,
    newest_at: Option<DateTime<Utc>>,
    complete: bool,
    issues: Vec<StorageInventoryIssue>,
    files_seen: Vec<ScannedFile>,
}

impl ScanResult {
    fn add_file(&mut self, home: &Path, path: &Path, metadata: &fs::Metadata, max_entries: u64) {
        if self.files >= max_entries {
            self.issue(home, path, "entry_limit_exceeded");
            return;
        }
        let bytes = metadata.len();
        if self.bytes.checked_add(bytes).is_none() || self.files.checked_add(1).is_none() {
            self.issue(home, path, "counter_saturated");
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.files = self.files.saturating_add(1);
        let modified = metadata.modified().ok().map(DateTime::<Utc>::from);
        if let Some(modified) = modified {
            self.oldest_at = Some(
                self.oldest_at
                    .map_or(modified, |current| min(current, modified)),
            );
            self.newest_at = Some(
                self.newest_at
                    .map_or(modified, |current| max(current, modified)),
            );
        }
        self.files_seen.push(ScannedFile { bytes, modified });
    }

    fn issue(&mut self, home: &Path, path: &Path, code: &str) {
        self.complete = false;
        self.issues.push(StorageInventoryIssue {
            code: code.to_string(),
            relative_path: path
                .strip_prefix(home)
                .map(Path::to_path_buf)
                .unwrap_or_else(|_| PathBuf::from("<outside-storage-root>")),
        });
    }

    fn merge(&mut self, other: ScanResult) {
        if self.bytes.checked_add(other.bytes).is_none()
            || self.files.checked_add(other.files).is_none()
            || self.entries_seen.checked_add(other.entries_seen).is_none()
        {
            self.complete = false;
            self.issues.push(StorageInventoryIssue {
                code: "counter_saturated".to_string(),
                relative_path: PathBuf::new(),
            });
        }
        self.bytes = self.bytes.saturating_add(other.bytes);
        self.files = self.files.saturating_add(other.files);
        self.entries_seen = self.entries_seen.saturating_add(other.entries_seen);
        if let Some(oldest) = other.oldest_at {
            self.oldest_at = Some(
                self.oldest_at
                    .map_or(oldest, |current| min(current, oldest)),
            );
        }
        if let Some(newest) = other.newest_at {
            self.newest_at = Some(
                self.newest_at
                    .map_or(newest, |current| max(current, newest)),
            );
        }
        self.complete &= other.complete;
        self.issues.extend(other.issues);
        self.files_seen.extend(other.files_seen);
    }
}

#[derive(Debug, Clone)]
struct ScannedFile {
    bytes: u64,
    modified: Option<DateTime<Utc>>,
}

fn older_than(modified: Option<DateTime<Utc>>, retention: Duration) -> bool {
    modified.is_some_and(|modified| older_than_datetime(modified, retention))
}

fn older_than_datetime(modified: DateTime<Utc>, retention: Duration) -> bool {
    SystemTime::now()
        .duration_since(SystemTime::from(modified))
        .is_ok_and(|age| age >= retention)
}

fn same_snapshot(first: &fs::Metadata, second: &fs::Metadata) -> bool {
    first.is_file() == second.is_file()
        && first.is_dir() == second.is_dir()
        && first.len() == second.len()
        && first.modified().ok() == second.modified().ok()
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

fn category_order(category: StorageCategory) -> u8 {
    match category {
        StorageCategory::Sessions => 0,
        StorageCategory::Runs => 1,
        StorageCategory::Memory => 2,
        StorageCategory::Audit => 3,
        StorageCategory::Logs => 4,
        StorageCategory::McpCache => 5,
        StorageCategory::ModelMetadataCache => 6,
        StorageCategory::DownloadedModels => 7,
        StorageCategory::Plugins => 8,
        StorageCategory::ProfileConfig => 9,
        StorageCategory::DeviceConfig => 10,
        StorageCategory::LegacyMigrationSource => 11,
    }
}

impl Default for StorageCategoryUsage {
    fn default() -> Self {
        Self {
            category: StorageCategory::Sessions,
            bytes: 0,
            files: 0,
            reclaimable_bytes: 0,
            oldest_at: None,
            newest_at: None,
            automatic_policy: None,
            protected_reason: None,
            complete: true,
            issues: Vec::new(),
        }
    }
}

// `derive(Default)` cannot express that a successful empty scan is complete.
impl Default for ScanResult {
    fn default() -> Self {
        Self {
            bytes: 0,
            files: 0,
            entries_seen: 0,
            oldest_at: None,
            newest_at: None,
            complete: true,
            issues: Vec::new(),
            files_seen: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_near_maximum_counters_saturates_and_marks_incomplete() {
        let mut left = ScanResult {
            bytes: u64::MAX - 2,
            files: u64::MAX,
            ..ScanResult::default()
        };
        left.merge(ScanResult {
            bytes: 10,
            files: 1,
            ..ScanResult::default()
        });
        assert_eq!(left.bytes, u64::MAX);
        assert_eq!(left.files, u64::MAX);
        assert!(!left.complete);
        assert!(left
            .issues
            .iter()
            .any(|issue| issue.code == "counter_saturated"));
    }

    #[test]
    fn a_changed_file_snapshot_is_not_treated_as_stable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("changing.bin");
        fs::write(&path, b"a").unwrap();
        let first = fs::symlink_metadata(&path).unwrap();
        fs::write(&path, b"a different length").unwrap();
        let second = fs::symlink_metadata(&path).unwrap();
        assert!(!same_snapshot(&first, &second));
    }
}
