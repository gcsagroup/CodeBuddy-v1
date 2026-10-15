use anyhow::{Context, Result};
use chrono::{TimeDelta, Utc};
use goose::config::codebuddy_paths::CodeBuddyPaths;
use goose::storage::{reserve_bytes, StorageCategory, StorageInventory};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

fn paths_for(temp: &tempfile::TempDir) -> Result<CodeBuddyPaths> {
    let home = temp.path().join(".CodeBuddy");
    CodeBuddyPaths::resolve(Some(OsStr::new(home.as_os_str())), None, temp.path())
}

fn write_sized(path: impl AsRef<Path>, bytes: usize) -> Result<PathBuf> {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().context("fixture file needs a parent")?)?;
    fs::write(path, vec![b'x'; bytes])?;
    Ok(path.to_path_buf())
}

fn write_run(paths: &CodeBuddyPaths, id: &str, status: &str, age_days: i64) -> Result<u64> {
    let root = paths.runs_dir().join(id);
    let state = root.join("run/state.json");
    fs::create_dir_all(state.parent().context("run state needs a parent")?)?;
    fs::write(
        &state,
        serde_json::to_vec(&serde_json::json!({
            "status": status,
            "updated_at": Utc::now() - TimeDelta::days(age_days),
        }))?,
    )?;
    write_sized(root.join("run/evidence.bin"), 100)?;
    directory_file_bytes(&root)
}

fn directory_file_bytes(root: &Path) -> Result<u64> {
    let mut total = 0_u64;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            total = total.saturating_add(directory_file_bytes(&entry.path())?);
        } else if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

#[test]
fn inventory_separates_reclaimable_and_protected_bytes() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let old_terminal_bytes = write_run(&paths, "old-terminal", "completed", 31)?;
    let active_bytes = write_run(&paths, "active", "paused", 31)?;
    write_sized(paths.sessions_dir().join("sessions.db"), 300)?;
    write_sized(paths.memory_dir().join("project/memory.json"), 400)?;
    write_sized(paths.models_dir().join("whisper/model.bin"), 500)?;

    let report = StorageInventory::default().inspect(&paths)?;
    let runs = report
        .category(StorageCategory::Runs)
        .context("runs category must exist")?;
    assert_eq!(runs.bytes, old_terminal_bytes + active_bytes);
    assert_eq!(runs.reclaimable_bytes, old_terminal_bytes);
    assert_eq!(
        report
            .category(StorageCategory::Sessions)
            .context("sessions category")?
            .reclaimable_bytes,
        0
    );
    assert_eq!(
        report
            .category(StorageCategory::Memory)
            .context("memory category")?
            .reclaimable_bytes,
        0
    );
    assert_eq!(
        report
            .category(StorageCategory::DownloadedModels)
            .context("models category")?
            .reclaimable_bytes,
        0
    );
    assert_eq!(
        report.total_bytes,
        report.categories.iter().map(|item| item.bytes).sum::<u64>()
    );
    Ok(())
}

#[test]
fn malformed_run_state_is_counted_but_never_marked_reclaimable() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    write_sized(paths.runs_dir().join("broken/run/state.json"), 64)?;
    write_sized(paths.runs_dir().join("broken/run/evidence.bin"), 128)?;

    let report = StorageInventory::default().inspect(&paths)?;
    let runs = report
        .category(StorageCategory::Runs)
        .context("runs category")?;
    assert_eq!(runs.bytes, 192);
    assert_eq!(runs.reclaimable_bytes, 0);
    assert!(!runs.complete);
    assert!(runs
        .issues
        .iter()
        .any(|issue| issue.code == "invalid_run_state"));
    Ok(())
}

#[test]
fn missing_category_directories_are_reported_as_empty_not_as_errors() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let report = StorageInventory::default().inspect(&paths)?;
    assert_eq!(report.total_bytes, 0);
    assert!(report.categories.iter().all(|category| category.complete));
    Ok(())
}

#[test]
fn rebuildable_cache_is_reclaimable_but_installed_plugins_are_protected() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    write_sized(paths.profile_cache_dir().join("mcp/tool-cache.bin"), 256)?;
    write_sized(
        paths.plugins_packages_dir().join("plugin-a/plugin.json"),
        128,
    )?;

    let report = StorageInventory::default().inspect(&paths)?;
    let cache = report
        .category(StorageCategory::McpCache)
        .context("MCP cache category")?;
    let plugins = report
        .category(StorageCategory::Plugins)
        .context("plugins category")?;
    assert_eq!(cache.bytes, 256);
    assert_eq!(cache.reclaimable_bytes, 256);
    assert_eq!(plugins.bytes, 128);
    assert_eq!(plugins.reclaimable_bytes, 0);
    assert_eq!(
        plugins.protected_reason.as_deref(),
        Some("installed_plugins_are_protected")
    );
    Ok(())
}

#[test]
fn inventory_does_not_follow_a_directory_link_outside_the_storage_root() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let outside = temp.path().join("outside");
    write_sized(outside.join("secret.bin"), 4096)?;
    create_directory_link(&outside, &paths.sessions_dir().join("escaped"))?;

    let report = StorageInventory::default().inspect(&paths)?;
    let sessions = report
        .category(StorageCategory::Sessions)
        .context("sessions category")?;
    assert_eq!(sessions.bytes, 0);
    assert!(!sessions.complete);
    assert!(sessions
        .issues
        .iter()
        .any(|issue| issue.code == "link_skipped"));
    assert!(sessions
        .issues
        .iter()
        .all(|issue| !issue.relative_path.to_string_lossy().contains("outside")));
    Ok(())
}

#[cfg(windows)]
#[test]
fn permission_denial_marks_the_category_incomplete() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let restricted = paths.sessions_dir();
    write_sized(restricted.join("private.bin"), 1024)?;
    let account = String::from_utf8(std::process::Command::new("whoami").output()?.stdout)?
        .trim()
        .to_string();
    anyhow::ensure!(!account.is_empty(), "whoami returned an empty account");
    let status = std::process::Command::new("icacls")
        .arg(&restricted)
        .args(["/deny", &format!("{account}:(RD)")])
        .status()?;
    anyhow::ensure!(status.success(), "failed to install fixture deny ACL");
    let restore = WindowsAclRestore {
        path: restricted.clone(),
        account,
    };

    let report = StorageInventory::default().inspect(&paths)?;
    drop(restore);
    let sessions = report
        .category(StorageCategory::Sessions)
        .context("sessions category")?;
    assert!(!sessions.complete);
    assert!(sessions.issues.iter().any(|issue| {
        matches!(
            issue.code.as_str(),
            "directory_unreadable" | "metadata_unavailable"
        )
    }));
    Ok(())
}

#[test]
fn free_space_reserve_is_five_percent_clamped_to_one_and_five_gib() {
    const GIB: u64 = 1024 * 1024 * 1024;
    assert_eq!(reserve_bytes(10 * GIB), GIB);
    assert_eq!(reserve_bytes(40 * GIB), 2 * GIB);
    assert_eq!(reserve_bytes(500 * GIB), 5 * GIB);
    assert_eq!(reserve_bytes(u64::MAX), 5 * GIB);
}

#[cfg(windows)]
fn create_directory_link(target: &Path, link: &Path) -> Result<()> {
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent)?;
    }
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return Ok(());
    }
    let status = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "New-Item -ItemType Junction -Path $env:CODEPRO_TEST_LINK -Target $env:CODEPRO_TEST_TARGET | Out-Null",
        ])
        .env("CODEPRO_TEST_LINK", link)
        .env("CODEPRO_TEST_TARGET", target)
        .status()?;
    anyhow::ensure!(status.success(), "failed to create fixture junction");
    Ok(())
}

#[cfg(windows)]
struct WindowsAclRestore {
    path: PathBuf,
    account: String,
}

#[cfg(windows)]
impl Drop for WindowsAclRestore {
    fn drop(&mut self) {
        let _ = std::process::Command::new("icacls")
            .arg(&self.path)
            .args(["/remove:d", &self.account])
            .status();
    }
}

#[cfg(unix)]
fn create_directory_link(target: &Path, link: &Path) -> Result<()> {
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}
