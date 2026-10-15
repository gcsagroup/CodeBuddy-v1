use goose::agents::CodeProStateStore;
use goose::config::codebuddy_paths::{environment_override, CodeBuddyPaths};
use goose::config::paths::Paths;
#[cfg(feature = "local-inference")]
use goose::dictation::whisper::get_model;
use goose::logging::prepare_log_directory;

#[test]
fn rename_reuses_existing_data_and_prefers_new_or_explicit_roots() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join(".CodeAgentPro");
    std::fs::create_dir(&old).unwrap();
    let marker = old.join("user-data.txt");
    std::fs::write(&marker, "preserve existing data").unwrap();
    assert_eq!(
        CodeBuddyPaths::resolve(None, None, temp.path())
            .unwrap()
            .home_dir(),
        old
    );
    let new = temp.path().join(".CodeBuddy");
    std::fs::create_dir(&new).unwrap();
    assert_eq!(
        CodeBuddyPaths::resolve(None, None, temp.path())
            .unwrap()
            .home_dir(),
        new
    );
    let explicit = temp.path().join("isolated");
    assert_eq!(
        CodeBuddyPaths::resolve(Some(explicit.as_os_str()), None, temp.path())
            .unwrap()
            .home_dir(),
        explicit
    );
    assert_eq!(
        std::fs::read_to_string(marker).unwrap(),
        "preserve existing data"
    );
}

#[test]
fn rename_accepts_legacy_launch_environment_without_overriding_new_values() {
    let _guard = env_lock::lock_env([
        ("CODEBUDDY_HOME", None),
        ("CODEAGENTPRO_HOME", Some("legacy")),
    ]);
    assert_eq!(environment_override("CODEBUDDY_HOME").unwrap(), "legacy");
    std::env::set_var("CODEBUDDY_HOME", "current");
    assert_eq!(environment_override("CODEBUDDY_HOME").unwrap(), "current");
}

#[test]
fn rename_preserves_migration_manifest_serialization() {
    use goose::config::storage_migration::LegacyRootKind;
    let old: LegacyRootKind = serde_json::from_str("\"roaming_code_agent_pro\"").unwrap();
    assert_eq!(old, LegacyRootKind::RoamingCodeBuddy);
    assert_eq!(
        serde_json::to_string(&old).unwrap(),
        "\"roaming_code_agent_pro\""
    );
}

#[test]
fn backend_stores_use_the_local_profile() {
    let temp = tempfile::tempdir().expect("create isolated storage root");
    let home = temp.path().join(".CodeBuddy");
    let home_value = home.to_string_lossy().into_owned();
    let _guard = env_lock::lock_env([
        ("CODEBUDDY_HOME", Some(home_value.as_str())),
        ("GOOSE_PATH_ROOT", None),
    ]);
    let profile = home.join("profiles").join("local");

    assert_eq!(Paths::home_dir(), home);
    assert_eq!(Paths::profile_dir(), profile);
    assert_eq!(Paths::config_dir(), profile.join("config"));
    assert_eq!(Paths::data_dir(), profile);
    assert_eq!(Paths::state_dir(), profile.join("state"));
    assert_eq!(Paths::cache_dir(), profile.join("cache"));
    assert_eq!(Paths::sessions_dir(), profile.join("sessions"));
    assert_eq!(Paths::runs_dir(), profile.join("runs"));
    assert_eq!(Paths::memory_dir(), profile.join("memory"));
    assert_eq!(Paths::projects_dir(), profile.join("projects"));
    assert_eq!(Paths::audit_dir(), profile.join("audit"));
    assert_eq!(Paths::models_dir(), profile.join("models"));
    assert_eq!(Paths::agents_dir(), profile.join("agents"));
    assert_eq!(Paths::skills_dir(), profile.join("skills"));
    assert_eq!(Paths::prompts_dir(), profile.join("prompts"));
    assert_eq!(Paths::recipes_dir(), profile.join("recipes"));
    assert_eq!(Paths::plugins_dir(), home.join("plugins").join("packages"));
    assert_eq!(Paths::logs_dir(), home.join("logs"));
    assert_eq!(
        CodeProStateStore::default_location().unwrap(),
        profile.join("runs")
    );
    #[cfg(feature = "local-inference")]
    assert_eq!(
        get_model("tiny").expect("tiny model").local_path(),
        profile.join("models").join("model-tiny-q80.gguf")
    );

    let log_dir = prepare_log_directory("storage-contract", false).expect("create log directory");
    assert_eq!(log_dir, home.join("logs").join("storage-contract"));
}

#[test]
fn new_override_wins_without_writing_to_the_legacy_root() {
    let temp = tempfile::tempdir().expect("create isolated storage roots");
    let home = temp.path().join("new-home");
    let legacy = temp.path().join("legacy-home");
    let home_value = home.to_string_lossy().into_owned();
    let legacy_value = legacy.to_string_lossy().into_owned();
    let _guard = env_lock::lock_env([
        ("CODEBUDDY_HOME", Some(home_value.as_str())),
        ("GOOSE_PATH_ROOT", Some(legacy_value.as_str())),
    ]);

    assert_eq!(Paths::home_dir(), home);
    assert_eq!(Paths::runs_dir(), home.join("profiles/local/runs"));
    assert!(!legacy.exists());
}
