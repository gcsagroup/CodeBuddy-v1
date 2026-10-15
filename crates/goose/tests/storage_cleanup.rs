use anyhow::Result;
use goose::agents::codepro_intent::CodeProWorkflow;
use goose::agents::codepro_state_store::{CodeProRunState, CodeProRunStatus, CodeProStateStore};
use goose::agents::model_router::ModelRouterConfig;
use goose::agents::task_dag::TaskDAG;
use goose::config::codebuddy_paths::CodeBuddyPaths;
use goose::storage::{
    StorageCleanupCategory, StorageCleanupError, StorageCleanupPolicy, StorageCleanupRequest,
    StorageCleanupService,
};
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

fn paths_for(temp: &tempfile::TempDir) -> Result<CodeBuddyPaths> {
    let home = temp.path().join(".CodeBuddy");
    CodeBuddyPaths::resolve(Some(OsStr::new(home.as_os_str())), None, temp.path())
}

fn test_policy() -> StorageCleanupPolicy {
    StorageCleanupPolicy {
        run_retention: Duration::ZERO,
        run_soft_budget_bytes: 1,
        log_retention: Duration::ZERO,
        completed_audit_retention: Duration::ZERO,
    }
}

async fn save_run(paths: &CodeBuddyPaths, run_id: &str, status: CodeProRunStatus) -> Result<()> {
    let store = CodeProStateStore::new(paths.runs_dir());
    store
        .save(&CodeProRunState {
            run_id: run_id.to_string(),
            goal: "storage cleanup fixture".to_string(),
            source_repo: temp_path("source"),
            worktree_path: temp_path("worktree"),
            workspace: None,
            status,
            pause_reason: (status == CodeProRunStatus::Paused).then_some(
                goose::agents::codepro_state_store::CodeProPauseReason::CheckpointPaused,
            ),
            workflow: Some(CodeProWorkflow::Test),
            last_active_run_id: None,
            dag: TaskDAG::new("storage cleanup fixture", vec![]),
            router_config: ModelRouterConfig::default(),
            reviewer_action_budget: None,
            review_result: None,
            final_report: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        })
        .await?;
    tokio::fs::write(
        paths.runs_dir().join(run_id).join("run/evidence.bin"),
        vec![b'e'; 128],
    )
    .await?;
    Ok(())
}

fn temp_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("codebuddy-storage-cleanup")
        .join(name)
}

async fn write_file(path: impl AsRef<Path>, bytes: usize) -> Result<()> {
    let path = path.as_ref();
    tokio::fs::create_dir_all(path.parent().expect("fixture path has a parent")).await?;
    tokio::fs::write(path, vec![b'x'; bytes]).await?;
    Ok(())
}

#[tokio::test]
async fn automatic_cleanup_removes_only_policy_safe_data() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    save_run(&paths, "terminal", CodeProRunStatus::Completed).await?;
    save_run(&paths, "paused", CodeProRunStatus::Paused).await?;
    write_file(paths.logs_dir().join("cli/old.log"), 64).await?;
    write_file(paths.profile_cache_dir().join("mcp/cache.bin"), 96).await?;
    write_file(paths.sessions_dir().join("sessions.db"), 128).await?;
    write_file(paths.memory_dir().join("project/memory.json"), 128).await?;
    write_file(paths.models_dir().join("whisper/model.bin"), 128).await?;
    write_file(paths.plugins_packages_dir().join("plugin/plugin.json"), 128).await?;

    let service = StorageCleanupService::with_policy(paths.clone(), test_policy());
    let preview = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    assert!(preview.reclaimable_bytes >= 128 + 64 + 96);
    assert!(preview
        .candidates
        .iter()
        .any(|candidate| candidate.category == StorageCleanupCategory::ExpiredTerminalRuns));
    assert!(preview
        .candidates
        .iter()
        .any(|candidate| candidate.category == StorageCleanupCategory::ExpiredLogs));
    assert!(preview.candidates.iter().any(|candidate| {
        candidate.category == StorageCleanupCategory::RebuildableBackendCache
    }));

    let report = service
        .execute(preview.request.clone(), &preview.digest)
        .await?;
    assert!(report.reclaimed_bytes > 0);
    assert!(!paths.runs_dir().join("terminal").exists());
    assert!(paths.runs_dir().join("paused").exists());
    assert!(!paths.logs_dir().join("cli/old.log").exists());
    assert!(!paths.profile_cache_dir().join("mcp/cache.bin").exists());
    assert!(paths.sessions_dir().join("sessions.db").exists());
    assert!(paths.memory_dir().join("project/memory.json").exists());
    assert!(paths.models_dir().join("whisper/model.bin").exists());
    assert!(paths
        .plugins_packages_dir()
        .join("plugin/plugin.json")
        .exists());
    Ok(())
}

#[tokio::test]
async fn execution_refuses_a_stale_preview_before_removing_anything() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    save_run(&paths, "terminal", CodeProRunStatus::Completed).await?;
    let service = StorageCleanupService::with_policy(paths.clone(), test_policy());
    let preview = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    write_file(paths.profile_cache_dir().join("mcp/late.bin"), 10).await?;

    let error = service
        .execute(preview.request, &preview.digest)
        .await
        .expect_err("candidate changes must invalidate the preview");
    assert_eq!(error, StorageCleanupError::StalePreview);
    assert!(paths.runs_dir().join("terminal").exists());
    assert!(paths.profile_cache_dir().join("mcp/late.bin").exists());
    Ok(())
}

#[tokio::test]
async fn a_terminal_run_added_after_preview_is_not_deleted() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    save_run(&paths, "previewed", CodeProRunStatus::Completed).await?;
    let service = StorageCleanupService::with_policy(paths.clone(), test_policy());
    let preview = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    save_run(&paths, "late-terminal", CodeProRunStatus::Completed).await?;

    assert_eq!(
        service.execute(preview.request, &preview.digest).await,
        Err(StorageCleanupError::StalePreview)
    );
    assert!(paths.runs_dir().join("previewed").exists());
    assert!(paths.runs_dir().join("late-terminal").exists());
    Ok(())
}

#[tokio::test]
async fn a_previewed_run_changed_to_paused_causes_zero_side_effects() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    save_run(&paths, "candidate", CodeProRunStatus::Completed).await?;
    write_file(paths.profile_cache_dir().join("mcp/cache.bin"), 32).await?;
    let service = StorageCleanupService::with_policy(paths.clone(), test_policy());
    let preview = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    let state_path = paths.runs_dir().join("candidate/run/state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&state_path).await?)?;
    state["status"] = serde_json::Value::String("paused".to_string());
    tokio::fs::write(&state_path, serde_json::to_vec_pretty(&state)?).await?;

    assert_eq!(
        service.execute(preview.request, &preview.digest).await,
        Err(StorageCleanupError::StalePreview)
    );
    assert!(paths.runs_dir().join("candidate").exists());
    assert!(paths.profile_cache_dir().join("mcp/cache.bin").exists());
    Ok(())
}

#[tokio::test]
async fn same_size_run_state_replacement_invalidates_the_preview() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    save_run(&paths, "candidate", CodeProRunStatus::Completed).await?;
    let service = StorageCleanupService::with_policy(paths.clone(), test_policy());
    let preview = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    let state_path = paths.runs_dir().join("candidate/run/state.json");
    let before = tokio::fs::read_to_string(&state_path).await?;
    let after = before.replace("storage cleanup fixture", "storage cleanup altered");
    assert_ne!(before, after);
    assert_eq!(before.len(), after.len());
    tokio::fs::write(&state_path, after).await?;

    assert_eq!(
        service.execute(preview.request, &preview.digest).await,
        Err(StorageCleanupError::StalePreview)
    );
    assert!(paths.runs_dir().join("candidate").exists());
    Ok(())
}

#[tokio::test]
async fn repeating_a_completed_cleanup_is_an_empty_success() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    write_file(paths.profile_cache_dir().join("mcp/cache.bin"), 32).await?;
    let service = StorageCleanupService::with_policy(paths, test_policy());
    let first = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    service.execute(first.request, &first.digest).await?;

    let second = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    let report = service.execute(second.request, &second.digest).await?;
    assert_eq!(report.reclaimed_bytes, 0);
    assert!(report.removed.is_empty());
    Ok(())
}

#[tokio::test]
async fn corrupt_or_nonterminal_run_state_is_never_a_cleanup_candidate() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    write_file(paths.runs_dir().join("corrupt/run/state.json"), 64).await?;
    save_run(&paths, "running", CodeProRunStatus::Running).await?;
    let service = StorageCleanupService::with_policy(paths.clone(), test_policy());

    let preview = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    assert!(preview.candidates.iter().all(|candidate| {
        !candidate
            .relative_path
            .starts_with("profiles/local/runs/corrupt")
            && !candidate
                .relative_path
                .starts_with("profiles/local/runs/running")
    }));
    let report = service.execute(preview.request, &preview.digest).await?;
    assert_eq!(report.reclaimed_bytes, 0);
    assert!(paths.runs_dir().join("corrupt").exists());
    assert!(paths.runs_dir().join("running").exists());
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn locked_cache_file_is_reported_as_partial_without_touching_protected_data() -> Result<()> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;

    let temp = tempfile::tempdir()?;
    let paths = paths_for(&temp)?;
    let cache = paths.profile_cache_dir().join("mcp/locked.bin");
    let memory = paths.memory_dir().join("project/memory.json");
    write_file(&cache, 32).await?;
    write_file(&memory, 32).await?;
    let service = StorageCleanupService::with_policy(paths.clone(), test_policy());
    let preview = service
        .preview(StorageCleanupRequest::automatic(None))
        .await?;
    let _lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&cache)?;

    let report = service.execute(preview.request, &preview.digest).await?;
    assert!(report
        .partial_failures
        .contains(&Path::new("profiles/local/cache/mcp/locked.bin").to_path_buf()));
    assert!(cache.exists());
    assert!(memory.exists());
    assert!(report.completed_at >= report.started_at);
    Ok(())
}
