use anyhow::Result;
use goose::config::codebuddy_paths::CodeBuddyPaths;
use goose::config::storage_migration::{
    plan_migration, LegacyRootKind, LegacySource, MigrationFailpoint, MigrationReportStatus,
    MigrationState, StorageMigrationRecord, StorageMigrator,
};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Executor, SqliteConnection};
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

fn source(root: PathBuf) -> LegacySource {
    LegacySource::new("legacy", LegacyRootKind::RoamingCodeBuddy, root)
}

fn load_record(paths: &CodeBuddyPaths) -> Result<StorageMigrationRecord> {
    Ok(serde_json::from_slice(&fs::read(
        paths.migrations_dir().join("migration.json"),
    )?)?)
}

#[test]
fn preflight_reports_not_required_for_an_empty_legacy_root() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    fs::create_dir_all(&legacy)?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let report = StorageMigrator::new(paths).preflight(&plan)?;

    assert_eq!(report.status, MigrationReportStatus::NotRequired);
    assert!(report.conflict_items.is_empty());
    Ok(())
}

#[test]
fn preflight_reports_not_required_when_every_item_is_rebuildable() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "Partitions/goose/Cache/cache.bin", b"rebuildable")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let report = StorageMigrator::new(paths).preflight(&plan)?;

    assert_eq!(report.status, MigrationReportStatus::NotRequired);
    assert!(report.conflict_items.is_empty());
    Ok(())
}

#[test]
fn status_without_a_record_is_not_a_live_preflight_result() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;

    let report = StorageMigrator::new(paths).status_report()?;

    assert_eq!(report.status, MigrationReportStatus::NoRecord);
    assert!(report.conflict_items.is_empty());
    Ok(())
}

#[test]
fn preflight_returns_a_bounded_redacted_conflict_inventory() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    write_file(&first, "backend/config/config.yaml", b"first-secret-value")?;
    write_file(&second, "config/config.yaml", b"second-secret-value")?;
    let plan = plan_migration(
        &paths,
        &[
            LegacySource::new("first", LegacyRootKind::RoamingCodeBuddy, first.clone()),
            LegacySource::new("second", LegacyRootKind::BlockGoose, second.clone()),
        ],
    )?;

    let report = StorageMigrator::new(paths).preflight(&plan)?;

    assert_eq!(report.status, MigrationReportStatus::Conflict);
    assert_eq!(report.conflict_items.len(), 1);
    let conflict = &report.conflict_items[0];
    assert_eq!(
        conflict.target_path,
        Path::new("profiles/local/config/config.yaml")
    );
    assert_eq!(
        conflict
            .candidates
            .iter()
            .map(|candidate| candidate.source_id.as_str())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert!(conflict
        .candidates
        .iter()
        .all(|candidate| candidate.size > 0 && candidate.digest_sha256.len() == 64));
    let json = serde_json::to_string(conflict)?;
    assert!(!json.contains(&first.display().to_string()));
    assert!(!json.contains(&second.display().to_string()));
    assert!(!json.contains("secret-value"));
    Ok(())
}

#[test]
fn preflight_includes_the_existing_unified_target_as_a_redacted_candidate() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/config/config.yaml", b"legacy")?;
    write_file(
        paths.home_dir(),
        "profiles/local/config/config.yaml",
        b"unified",
    )?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let report = StorageMigrator::new(paths).preflight(&plan)?;

    assert_eq!(report.status, MigrationReportStatus::Conflict);
    assert_eq!(report.conflict_items.len(), 1);
    assert_eq!(
        report.conflict_items[0]
            .candidates
            .iter()
            .map(|candidate| candidate.source_id.as_str())
            .collect::<Vec<_>>(),
        ["legacy", "unified-target"]
    );
    Ok(())
}

#[test]
fn preflight_caps_conflict_details_without_hiding_the_total() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    for index in 0..105 {
        write_file(
            &first,
            &format!("backend/config/permissions/item-{index}.yaml"),
            b"first",
        )?;
        write_file(
            &second,
            &format!("config/permissions/item-{index}.yaml"),
            b"second",
        )?;
    }
    let plan = plan_migration(
        &paths,
        &[
            LegacySource::new("first", LegacyRootKind::RoamingCodeBuddy, first),
            LegacySource::new("second", LegacyRootKind::BlockGoose, second),
        ],
    )?;

    let report = StorageMigrator::new(paths).preflight(&plan)?;

    assert_eq!(report.conflicts, 210);
    assert_eq!(report.conflict_items.len(), 100);
    Ok(())
}

#[tokio::test]
async fn rejects_a_tampered_persisted_plan_before_writing_outside_the_target() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/config/config.yaml", b"provider: test")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;
    let mut encoded = serde_json::to_value(&plan)?;
    encoded["items"][0]["target_relative_path"] = serde_json::json!("../escaped.txt");
    let tampered = serde_json::from_value(encoded)?;

    let result = StorageMigrator::new(paths.clone()).execute(&tampered).await;

    assert!(result.is_err());
    assert!(!temp.path().join("target/escaped.txt").exists());
    assert!(!paths.migrations_dir().join("migration.json").exists());
    Ok(())
}

#[tokio::test]
async fn rejects_a_tampered_disposition_before_writing_migration_state() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/config/config.yaml", b"provider: test")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;
    let mut encoded = serde_json::to_value(&plan)?;
    encoded["items"][0]["disposition"] = serde_json::json!("deduplicate");
    let tampered = serde_json::from_value(encoded)?;

    let result = StorageMigrator::new(paths.clone()).execute(&tampered).await;

    assert!(result.is_err());
    assert!(!paths.migrations_dir().join("migration.json").exists());
    Ok(())
}

#[tokio::test]
async fn resumes_after_copy_interruption_without_modifying_the_source() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    let first = write_file(&legacy, "backend/config/config.yaml", b"provider: test")?;
    let second = write_file(&legacy, "backend/data/models/model.bin", b"model")?;
    let before = [fs::read(&first)?, fs::read(&second)?];
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let interrupted = StorageMigrator::new(paths.clone())
        .with_failpoint(MigrationFailpoint::AfterStagedFiles(1))
        .execute(&plan)
        .await;
    assert!(interrupted.is_err());
    assert_eq!(load_record(&paths)?.state, MigrationState::Failed);
    assert!(!paths.profile_config_dir().join("config.yaml").exists());

    let restarted = StorageMigrator::new(paths.clone());
    let persisted_plan = restarted
        .pending_plan()?
        .expect("an interrupted migration must retain its exact plan");
    assert_eq!(persisted_plan, plan);
    let report = restarted.execute(&persisted_plan).await?;
    assert_eq!(report.status, MigrationReportStatus::Committed);
    assert_eq!(fs::read(first)?, before[0]);
    assert_eq!(fs::read(second)?, before[1]);
    assert!(paths.profile_config_dir().join("config.yaml").exists());
    assert!(paths.models_dir().join("model.bin").exists());
    Ok(())
}

#[tokio::test]
async fn resumes_when_interrupted_before_manifest_append() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/config/config.yaml", b"provider: test")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let interrupted = StorageMigrator::new(paths.clone())
        .with_failpoint(MigrationFailpoint::BeforeManifestAppend(1))
        .execute(&plan)
        .await;
    assert!(interrupted.is_err());

    let report = StorageMigrator::new(paths.clone()).execute(&plan).await?;
    assert_eq!(report.status, MigrationReportStatus::Committed);
    let manifest = fs::read_to_string(
        report
            .report_path
            .as_ref()
            .expect("a committed migration must have a manifest"),
    )?;
    assert_eq!(manifest.lines().count(), 1);
    Ok(())
}

#[tokio::test]
async fn resumes_after_a_partial_atomic_publish() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/config/config.yaml", b"provider: test")?;
    write_file(&legacy, "backend/data/models/model.bin", b"model")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let interrupted = StorageMigrator::new(paths.clone())
        .with_failpoint(MigrationFailpoint::AfterPublishedFiles(1))
        .execute(&plan)
        .await;
    assert!(interrupted.is_err());
    assert_eq!(load_record(&paths)?.state, MigrationState::Failed);
    assert_eq!(
        [
            paths.profile_config_dir().join("config.yaml").exists(),
            paths.models_dir().join("model.bin").exists(),
        ]
        .into_iter()
        .filter(|exists| *exists)
        .count(),
        1
    );

    let report = StorageMigrator::new(paths.clone()).execute(&plan).await?;
    assert_eq!(report.status, MigrationReportStatus::Committed);
    assert!(paths.profile_config_dir().join("config.yaml").exists());
    assert!(paths.models_dir().join("model.bin").exists());
    Ok(())
}

#[tokio::test]
async fn refuses_a_source_that_changed_after_planning() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    let config = write_file(&legacy, "backend/config/config.yaml", b"before")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;
    fs::write(config, b"after")?;

    let error = StorageMigrator::new(paths)
        .execute(&plan)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("source changed"));
    Ok(())
}

#[tokio::test]
async fn stops_on_a_target_conflict_created_after_preflight() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/config/config.yaml", b"legacy")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;
    write_file(
        paths.home_dir(),
        "profiles/local/config/config.yaml",
        b"new",
    )?;

    let report = StorageMigrator::new(paths.clone()).execute(&plan).await?;
    assert_eq!(report.status, MigrationReportStatus::Conflict);
    assert_eq!(report.conflicts, 1);
    assert_eq!(report.conflict_items.len(), 1);
    assert_eq!(
        report.conflict_items[0].target_path,
        Path::new("profiles/local/config/config.yaml")
    );
    assert_eq!(
        fs::read(paths.profile_config_dir().join("config.yaml"))?,
        b"new"
    );
    Ok(())
}

#[tokio::test]
async fn refuses_to_start_when_available_space_is_too_small() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/data/models/model.bin", b"large-enough")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let report = StorageMigrator::new(paths.clone())
        .with_available_space_override(0)
        .execute(&plan)
        .await?;
    assert_eq!(report.status, MigrationReportStatus::InsufficientSpace);
    assert!(!paths.models_dir().join("model.bin").exists());
    Ok(())
}

#[tokio::test]
async fn malformed_json_fails_verification_before_publish() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "settings.json", b"{broken")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let error = StorageMigrator::new(paths.clone())
        .execute(&plan)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("JSON"));
    assert_eq!(load_record(&paths)?.state, MigrationState::Failed);
    assert!(!paths.app_config_dir().join("app.json").exists());
    Ok(())
}

#[tokio::test]
async fn migrates_a_valid_sqlite_database_with_live_wal_and_shm_as_one_unit() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    let database = legacy.join("backend/data/sessions/sessions.db");
    fs::create_dir_all(database.parent().unwrap())?;
    let options = SqliteConnectOptions::new()
        .filename(&database)
        .create_if_missing(true);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    connection.execute("PRAGMA journal_mode=WAL").await?;
    connection
        .execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
        .await?;
    connection
        .execute("INSERT INTO messages (body) VALUES ('kept')")
        .await?;
    assert!(database.with_extension("db-wal").exists());
    assert!(database.with_extension("db-shm").exists());

    let plan = plan_migration(&paths, &[source(legacy)])?;
    let report = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        StorageMigrator::new(paths.clone()).execute(&plan),
    )
    .await??;
    assert_eq!(report.status, MigrationReportStatus::Committed);
    assert!(paths.sessions_dir().join("sessions.db").exists());
    assert!(!paths.sessions_dir().join("sessions.db-wal").exists());
    assert!(!paths.sessions_dir().join("sessions.db-shm").exists());
    let target_options = SqliteConnectOptions::new()
        .filename(paths.sessions_dir().join("sessions.db"))
        .read_only(true);
    let mut target = SqliteConnection::connect_with(&target_options).await?;
    let body: String = sqlx::query_scalar("SELECT body FROM messages WHERE id = 1")
        .fetch_one(&mut target)
        .await?;
    assert_eq!(body, "kept");
    target.close().await?;
    connection.close().await?;
    Ok(())
}

#[tokio::test]
async fn resumes_a_live_wal_sqlite_snapshot_after_partial_publish() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    let database = legacy.join("backend/data/sessions/sessions.db");
    fs::create_dir_all(database.parent().unwrap())?;
    let options = SqliteConnectOptions::new()
        .filename(&database)
        .create_if_missing(true);
    let mut connection = SqliteConnection::connect_with(&options).await?;
    connection.execute("PRAGMA journal_mode=WAL").await?;
    connection
        .execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
        .await?;
    connection
        .execute("INSERT INTO messages (body) VALUES ('kept')")
        .await?;
    assert!(database.with_extension("db-wal").exists());
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let interrupted = StorageMigrator::new(paths.clone())
        .with_failpoint(MigrationFailpoint::AfterPublishedFiles(1))
        .execute(&plan)
        .await;
    assert!(interrupted.is_err());
    assert!(paths.sessions_dir().join("sessions.db").is_file());

    let report = StorageMigrator::new(paths.clone()).execute(&plan).await?;

    assert_eq!(report.status, MigrationReportStatus::Committed);
    let target_options = SqliteConnectOptions::new()
        .filename(paths.sessions_dir().join("sessions.db"))
        .read_only(true);
    let mut target = SqliteConnection::connect_with(&target_options).await?;
    let body: String = sqlx::query_scalar("SELECT body FROM messages WHERE id = 1")
        .fetch_one(&mut target)
        .await?;
    assert_eq!(body, "kept");
    target.close().await?;
    connection.close().await?;
    Ok(())
}

#[tokio::test]
async fn resumes_two_live_wal_sqlite_snapshots_after_partial_publish() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    let mut source_connections = Vec::new();
    for (name, body) in [("sessions.db", "first"), ("archive.db", "second")] {
        let database = legacy.join("backend/data/sessions").join(name);
        fs::create_dir_all(database.parent().unwrap())?;
        let options = SqliteConnectOptions::new()
            .filename(&database)
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options).await?;
        connection.execute("PRAGMA journal_mode=WAL").await?;
        connection
            .execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
            .await?;
        sqlx::query("INSERT INTO messages (body) VALUES (?1)")
            .bind(body)
            .execute(&mut connection)
            .await?;
        assert!(database.with_extension("db-wal").exists());
        source_connections.push(connection);
    }
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let interrupted = StorageMigrator::new(paths.clone())
        .with_failpoint(MigrationFailpoint::AfterPublishedFiles(1))
        .execute(&plan)
        .await;
    assert!(interrupted.is_err());

    let report = StorageMigrator::new(paths.clone()).execute(&plan).await?;

    assert_eq!(report.status, MigrationReportStatus::Committed);
    for (name, expected) in [("sessions.db", "first"), ("archive.db", "second")] {
        let options = SqliteConnectOptions::new()
            .filename(paths.sessions_dir().join(name))
            .read_only(true);
        let mut target = SqliteConnection::connect_with(&options).await?;
        let body: String = sqlx::query_scalar("SELECT body FROM messages WHERE id = 1")
            .fetch_one(&mut target)
            .await?;
        assert_eq!(body, expected);
        target.close().await?;
    }
    for connection in source_connections {
        connection.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn corrupt_sqlite_fails_integrity_check_before_publish() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(
        &legacy,
        "backend/data/sessions/sessions.db",
        b"not-a-sqlite-database",
    )?;
    let plan = plan_migration(&paths, &[source(legacy)])?;

    let error = StorageMigrator::new(paths.clone())
        .execute(&plan)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("SQLite"));
    assert!(!paths.sessions_dir().join("sessions.db").exists());
    Ok(())
}

#[tokio::test]
async fn a_second_identical_invocation_is_idempotent() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let legacy = temp.path().join("legacy");
    write_file(&legacy, "backend/config/config.yaml", b"provider: test")?;
    let plan = plan_migration(&paths, &[source(legacy)])?;
    let migrator = StorageMigrator::new(paths.clone());

    let first = migrator.execute(&plan).await?;
    let second = StorageMigrator::new(paths).execute(&plan).await?;
    assert_eq!(first.status, MigrationReportStatus::Committed);
    assert_eq!(second.status, MigrationReportStatus::Committed);
    assert_eq!(second.copied_files, 0);
    Ok(())
}
