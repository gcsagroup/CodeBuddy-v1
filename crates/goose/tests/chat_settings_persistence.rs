use fs2::FileExt;
use goose::config::{Config, ConfigError, PREFERENCES_REVISION_KEY};
use serde_json::json;
use std::fs::OpenOptions;
use std::sync::{mpsc, Arc, Barrier};
use std::time::Duration;

fn config_at(path: &std::path::Path) -> Config {
    Config::new_with_file_secrets(path, path.with_extension("secrets.yaml")).unwrap()
}

#[test]
fn revisioned_preferences_update_is_atomic_and_rejects_stale_windows() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    let config = config_at(&config_path);
    config.set_param("legacy", "preserved").unwrap();

    let revision = config
        .set_param_values_if_revision(
            PREFERENCES_REVISION_KEY,
            0,
            &[("GOOSE_MAX_TURNS".to_string(), json!(25))],
            &["legacy".to_string()],
        )
        .unwrap();
    assert_eq!(revision, 1);

    let stale = config.set_param_values_if_revision(
        PREFERENCES_REVISION_KEY,
        0,
        &[("GOOSE_MAX_TURNS".to_string(), json!(30))],
        &[],
    );
    assert!(matches!(
        stale,
        Err(ConfigError::PreferenceRevisionConflict {
            expected: 0,
            actual: 1
        })
    ));
    assert_eq!(config.get_param::<u32>("GOOSE_MAX_TURNS").unwrap(), 25);
    assert!(matches!(
        config.get_param::<String>("legacy"),
        Err(ConfigError::NotFound(_))
    ));
}

#[test]
fn concurrent_preference_updates_preserve_both_values_and_increment_once_each() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();

    for (key, value) in [("first", 1), ("second", 2)] {
        let config = config_at(&config_path);
        let barrier = Arc::clone(&barrier);
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            config.set_preference(key, value).unwrap()
        }));
    }
    barrier.wait();

    let mut revisions = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    revisions.sort_unstable();
    assert_eq!(revisions, [1, 2]);

    let config = config_at(&config_path);
    assert_eq!(config.get_param::<u32>("first").unwrap(), 1);
    assert_eq!(config.get_param::<u32>("second").unwrap(), 2);
    assert_eq!(
        config.get_param::<u64>(PREFERENCES_REVISION_KEY).unwrap(),
        2
    );
}

#[test]
fn sidecar_lock_serializes_the_complete_read_modify_write_window() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    let config = config_at(&config_path);
    config.set_param("existing", 1).unwrap();

    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config_path.with_extension("lock"))
        .unwrap();
    lock_file.lock_exclusive().unwrap();

    let (tx, rx) = mpsc::channel();
    let writer = std::thread::spawn(move || tx.send(config.set_preference("writer", 2)).unwrap());
    assert!(matches!(
        rx.recv_timeout(Duration::from_millis(150)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    FileExt::unlock(&lock_file).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap(), 1);
    writer.join().unwrap();
}

#[test]
fn malformed_yaml_and_lock_failure_preserve_original_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    let malformed = b"valid: value\nbroken: [\n";
    std::fs::write(&config_path, malformed).unwrap();
    let config = config_at(&config_path);

    assert!(matches!(
        config.set_preference("new_key", "must-not-appear"),
        Err(ConfigError::DeserializeError(_))
    ));
    assert_eq!(std::fs::read(&config_path).unwrap(), malformed);

    let valid = b"existing: preserved\n";
    std::fs::write(&config_path, valid).unwrap();
    std::fs::remove_file(config_path.with_extension("lock")).unwrap();
    std::fs::create_dir(config_path.with_extension("lock")).unwrap();
    assert!(config.set_preference("new_key", "must-not-appear").is_err());
    assert_eq!(std::fs::read(&config_path).unwrap(), valid);
}

#[test]
fn rejected_batch_has_no_partial_delete_value_or_revision_write() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    let config = config_at(&config_path);
    config.set_param("preserved", "yes").unwrap();
    let before = std::fs::read(&config_path).unwrap();

    assert!(matches!(
        config.set_param_values_if_revision(
            PREFERENCES_REVISION_KEY,
            0,
            &[("GOOSE_MAX_TURNS".to_string(), json!(10_001))],
            &["preserved".to_string()],
        ),
        Err(ConfigError::DeserializeError(_))
    ));
    assert_eq!(std::fs::read(&config_path).unwrap(), before);
}

#[test]
fn unique_temporary_files_do_not_collide_with_legacy_fixed_tmp_path() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    std::fs::create_dir(config_path.with_extension("tmp")).unwrap();
    let config = config_at(&config_path);

    assert_eq!(config.set_preference("safe", true).unwrap(), 1);
    assert!(config.get_param::<bool>("safe").unwrap());
}

#[test]
fn set_preference_revision_overflow_preserves_exact_state() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    let config = config_at(&config_path);
    config.set_param("preference", "before").unwrap();
    config
        .set_param(PREFERENCES_REVISION_KEY, u64::MAX)
        .unwrap();
    let before = std::fs::read(&config_path).unwrap();

    assert!(matches!(
        config.set_preference("preference", "must-not-appear"),
        Err(ConfigError::DeserializeError(_))
    ));
    assert_eq!(std::fs::read(&config_path).unwrap(), before);
    assert_eq!(config.get_param::<String>("preference").unwrap(), "before");
    assert_eq!(
        config.get_param::<u64>(PREFERENCES_REVISION_KEY).unwrap(),
        u64::MAX
    );
}

#[test]
fn cas_revision_overflow_preserves_value_delete_and_exact_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("config.yaml");
    let config = config_at(&config_path);
    config.set_param("preference", "before").unwrap();
    config.set_param("preserved", "yes").unwrap();
    config
        .set_param(PREFERENCES_REVISION_KEY, u64::MAX)
        .unwrap();
    let before = std::fs::read(&config_path).unwrap();

    assert!(matches!(
        config.set_param_values_if_revision(
            PREFERENCES_REVISION_KEY,
            u64::MAX,
            &[("preference".to_string(), json!("must-not-appear"))],
            &["preserved".to_string()],
        ),
        Err(ConfigError::DeserializeError(_))
    ));
    assert_eq!(std::fs::read(&config_path).unwrap(), before);
    assert_eq!(config.get_param::<String>("preference").unwrap(), "before");
    assert_eq!(config.get_param::<String>("preserved").unwrap(), "yes");
    assert_eq!(
        config.get_param::<u64>(PREFERENCES_REVISION_KEY).unwrap(),
        u64::MAX
    );
}
