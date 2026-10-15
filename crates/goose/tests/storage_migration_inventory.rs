use anyhow::{Context, Result};
use goose::config::codebuddy_paths::CodeBuddyPaths;
use goose::config::storage_migration::{
    append_manifest_entry, discover_legacy_sources, plan_migration, validate_plan_sources,
    write_migration_record, LegacyDiscoveryEnv, LegacyRootKind, LegacySource, MigrationDisposition,
    MigrationState, StorageDataClass, StorageMigrationRecord,
};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

fn write_file(root: &Path, relative: &str, bytes: &[u8]) -> Result<PathBuf> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, bytes)?;
    Ok(path)
}

fn paths_for(temp: &tempfile::TempDir) -> Result<CodeBuddyPaths> {
    let target = temp.path().join("target").join(".CodeBuddy");
    CodeBuddyPaths::resolve(Some(OsStr::new(target.as_os_str())), None, temp.path())
}

fn source(id: &str, kind: LegacyRootKind, root: PathBuf) -> LegacySource {
    LegacySource::new(id, kind, root)
}

#[test]
fn discovers_only_approved_legacy_roots() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let app_data = temp.path().join("roaming");
    let local_app_data = temp.path().join("local");
    let user_profile = temp.path().join("user");
    let explicit_goose_root = temp.path().join("portable-goose");

    for root in [
        app_data.join("CodeBuddy"),
        local_app_data.join("CodeBuddy"),
        local_app_data.join("Block/goose"),
        user_profile.join(".agents"),
        explicit_goose_root.clone(),
    ] {
        fs::create_dir_all(root)?;
    }
    fs::create_dir_all(temp.path().join("source-repository/CodeBuddy"))?;

    let discovered = discover_legacy_sources(
        &paths,
        &LegacyDiscoveryEnv {
            app_data,
            local_app_data,
            user_profile,
            goose_path_root: Some(explicit_goose_root),
        },
    )?;

    assert_eq!(discovered.len(), 5);
    assert!(discovered.iter().all(|legacy| !legacy
        .root()
        .starts_with(temp.path().join("source-repository"))));
    assert!(discovered
        .iter()
        .all(|legacy| legacy.root() != paths.home_dir()));
    Ok(())
}

#[test]
fn maps_known_legacy_paths_without_copying_cache_or_binaries() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let roaming = temp.path().join("roaming/CodeBuddy");
    let local = temp.path().join("local/CodeBuddy");
    let agents = temp.path().join("user/.agents");
    let block = temp.path().join("local/Block/goose");

    let cases = [
        ("settings.json", b"{}".as_slice()),
        ("backend/config/config.yaml", b"provider: test".as_slice()),
        ("backend/config/permissions/default.json", b"{}".as_slice()),
        ("backend/config/agents/reviewer.md", b"review".as_slice()),
        ("backend/config/tls/server.key", b"private".as_slice()),
        ("backend/data/sessions/sessions.db", b"sqlite".as_slice()),
        (
            "backend/data/sessions/sessions.db-wal",
            b"mutable-wal".as_slice(),
        ),
        (
            "backend/data/sessions/sessions.db-shm",
            b"mutable-shm".as_slice(),
        ),
        ("backend/data/projects/projects.json", b"[]".as_slice()),
        ("backend/data/codepro-control/run.json", b"{}".as_slice()),
        ("backend/data/tool-audit-v2/audit.jsonl", b"{}\n".as_slice()),
        ("backend/data/models/whisper.bin", b"model".as_slice()),
        ("Partitions/goose/Cookies", b"cookie-db".as_slice()),
        ("Partitions/goose/Cache/cache.bin", b"discard".as_slice()),
        ("Cache/cache.bin", b"discard".as_slice()),
    ];
    for (relative, bytes) in cases {
        write_file(&roaming, relative, bytes)?;
    }
    write_file(&local, "codepro-runs/run-1/run/state.json", b"{}")?;
    write_file(&local, "project-memory/demo/memory.json", b"[]")?;
    write_file(&local, "Update.exe", b"discard")?;
    write_file(&agents, "plugins/example/plugin.json", b"{}")?;
    write_file(&agents, "agents/coder.md", b"coder")?;
    write_file(&agents, "skills/test/SKILL.md", b"skill")?;
    write_file(&block, "config/config.yaml", b"provider: test")?;

    let plan = plan_migration(
        &paths,
        &[
            source("roaming", LegacyRootKind::RoamingCodeBuddy, roaming),
            source("local", LegacyRootKind::LocalCodeBuddy, local),
            source("agents", LegacyRootKind::AgentsHome, agents),
            source("block", LegacyRootKind::BlockGoose, block),
        ],
    )?;

    let expected = [
        (
            "settings.json",
            "config/app.json",
            StorageDataClass::DeviceConfig,
        ),
        (
            "backend/data/sessions/sessions.db",
            "profiles/local/sessions/sessions.db",
            StorageDataClass::Session,
        ),
        (
            "backend/data/models/whisper.bin",
            "profiles/local/models/whisper.bin",
            StorageDataClass::Model,
        ),
        (
            "Partitions/goose/Cookies",
            "profiles/local/state/electron/Cookies",
            StorageDataClass::ElectronPersistentState,
        ),
        (
            "codepro-runs/run-1/run/state.json",
            "profiles/local/runs/run-1/run/state.json",
            StorageDataClass::Run,
        ),
        (
            "project-memory/demo/memory.json",
            "profiles/local/memory/demo/memory.json",
            StorageDataClass::Memory,
        ),
        (
            "plugins/example/plugin.json",
            "plugins/packages/example/plugin.json",
            StorageDataClass::PluginPackage,
        ),
    ];
    for (source_suffix, target, data_class) in expected {
        let item = plan
            .item_with_source_suffix(source_suffix)
            .with_context(|| format!("missing mapping for {source_suffix}"))?;
        assert_eq!(item.target_relative_path(), Some(Path::new(target)));
        assert_eq!(item.data_class(), data_class);
        assert!(matches!(
            item.disposition(),
            MigrationDisposition::Copy | MigrationDisposition::Deduplicate
        ));
    }

    for skipped in [
        "Partitions/goose/Cache/cache.bin",
        "Cache/cache.bin",
        "Update.exe",
        "backend/data/sessions/sessions.db-wal",
        "backend/data/sessions/sessions.db-shm",
    ] {
        assert_eq!(
            plan.item_with_source_suffix(skipped)
                .with_context(|| format!("missing skipped entry {skipped}"))?
                .disposition(),
            MigrationDisposition::SkipRebuildable
        );
        assert_eq!(
            plan.item_with_source_suffix(skipped)
                .with_context(|| format!("missing skipped entry {skipped}"))?
                .digest_sha256(),
            None,
            "rebuildable data must not be read and hashed"
        );
    }
    assert!(plan
        .item_with_source_suffix("backend/data/models/whisper.bin")
        .unwrap()
        .digest_sha256()
        .is_some());
    validate_plan_sources(&plan)?;
    Ok(())
}

#[test]
fn classifies_identical_duplicates_conflicts_and_unknown_files() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let first = temp.path().join("first");
    let second = temp.path().join("second");

    write_file(&first, "backend/config/config.yaml", b"same")?;
    write_file(&second, "config/config.yaml", b"same")?;
    write_file(&first, "mystery.dat", b"preserve")?;
    let identical = plan_migration(
        &paths,
        &[
            source("first", LegacyRootKind::RoamingCodeBuddy, first.clone()),
            source("second", LegacyRootKind::BlockGoose, second.clone()),
        ],
    )?;
    assert_eq!(
        identical.items_for_target("profiles/local/config/config.yaml")[1].disposition(),
        MigrationDisposition::Deduplicate
    );
    let unknown = identical.item_with_source_suffix("mystery.dat").unwrap();
    assert_eq!(
        unknown.disposition(),
        MigrationDisposition::LegacyUnclassified
    );
    assert_eq!(
        unknown.target_relative_path(),
        Some(Path::new(
            "migrations/legacy-unclassified/first/mystery.dat"
        ))
    );

    fs::write(second.join("config/config.yaml"), b"different")?;
    let conflicting = plan_migration(
        &paths,
        &[
            source("first", LegacyRootKind::RoamingCodeBuddy, first),
            source("second", LegacyRootKind::BlockGoose, second),
        ],
    )?;
    assert!(conflicting
        .items_for_target("profiles/local/config/config.yaml")
        .iter()
        .all(|item| item.disposition() == MigrationDisposition::Conflict));
    Ok(())
}

#[test]
fn rejects_a_link_that_can_escape_the_legacy_source_boundary() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let root = temp.path().join("legacy");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&root)?;
    write_file(&outside, "secret.txt", b"outside")?;
    create_directory_link(&outside, &root.join("backend/data/sessions/escaped"))?;

    let plan = plan_migration(
        &paths,
        &[source("legacy", LegacyRootKind::RoamingCodeBuddy, root)],
    )?;
    assert_eq!(
        plan.item_with_source_suffix("backend/data/sessions/escaped")
            .context("the boundary escape must be present in the manifest")?
            .disposition(),
        MigrationDisposition::RejectBoundaryEscape
    );
    Ok(())
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

#[cfg(unix)]
fn create_directory_link(target: &Path, link: &Path) -> Result<()> {
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}

#[test]
fn detects_when_a_source_changes_after_planning() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let root = temp.path().join("legacy");
    let config = write_file(&root, "backend/config/config.yaml", b"before")?;
    let plan = plan_migration(
        &paths,
        &[source("legacy", LegacyRootKind::RoamingCodeBuddy, root)],
    )?;

    fs::write(config, b"after")?;
    let error = validate_plan_sources(&plan).expect_err("changed sources must invalidate the plan");
    assert!(error.to_string().contains("source changed"));
    Ok(())
}

#[test]
fn rejects_overlapping_source_and_target_roots() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let nested_source = paths.home_dir().join("legacy-inside-target");
    fs::create_dir_all(&nested_source)?;

    let error = plan_migration(
        &paths,
        &[source(
            "overlap",
            LegacyRootKind::RoamingCodeBuddy,
            nested_source,
        )],
    )
    .expect_err("a source nested under the target must be rejected");
    assert!(error.to_string().contains("must not overlap"));
    Ok(())
}

#[test]
fn writes_an_atomic_record_and_append_only_jsonl_manifest() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let root = temp.path().join("legacy");
    write_file(&root, "backend/config/config.yaml", b"provider: test")?;
    let plan = plan_migration(
        &paths,
        &[source("legacy", LegacyRootKind::RoamingCodeBuddy, root)],
    )?;
    let mut record = StorageMigrationRecord::planned(&plan, paths.home_dir().to_path_buf());

    let record_path = write_migration_record(&paths, &record)?;
    record.state = MigrationState::Copying;
    record.updated_at = chrono::Utc::now();
    write_migration_record(&paths, &record)?;
    let persisted: StorageMigrationRecord = serde_json::from_slice(&fs::read(&record_path)?)?;
    assert_eq!(persisted.state, MigrationState::Copying);
    assert_eq!(persisted.migration_id, plan.migration_id());
    assert!(!record_path.with_extension("tmp").exists());

    let first = plan
        .items()
        .first()
        .context("fixture should create an item")?;
    let manifest_path = append_manifest_entry(&paths, plan.migration_id(), first)?;
    append_manifest_entry(&paths, plan.migration_id(), first)?;
    let lines = fs::read_to_string(manifest_path)?.lines().count();
    assert_eq!(lines, 2);
    Ok(())
}
