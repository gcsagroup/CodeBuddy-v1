use goose::agents::extension::PlatformExtensionContext;
use goose::agents::mcp_client::McpClientTrait;
use goose::agents::platform_extensions::PLATFORM_EXTENSIONS;
use goose::agents::{GitClient, ToolCallContext};
use goose::session::SessionManager;
use rmcp::model::{CallToolResult, RawContent};
use rmcp::object;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

fn context(data_dir: &Path) -> PlatformExtensionContext {
    PlatformExtensionContext {
        extension_manager: None,
        session_manager: Arc::new(SessionManager::new(data_dir.to_path_buf())),
        session: None,
        use_login_shell_path: false,
    }
}

fn text(result: &CallToolResult) -> &str {
    match &result.content[0].raw {
        RawContent::Text(text) => &text.text,
        _ => panic!("expected text content"),
    }
}

fn json(result: &CallToolResult) -> Value {
    serde_json::from_str(text(result)).unwrap()
}

fn force_push_arguments(preview: &Value, preflight_id: &str) -> rmcp::model::JsonObject {
    object!({
        "remote": preview["remote"].as_str().unwrap(),
        "branch": preview["branch"].as_str().unwrap(),
        "head": preview["head"].as_str().unwrap(),
        "expected_remote_oid": preview["expected_remote_oid"].as_str().unwrap(),
        "local_only_commit_count": preview["local_only_commit_count"].as_u64().unwrap(),
        "remote_only_commit_count": preview["remote_only_commit_count"].as_u64().unwrap(),
        "preflight_id": preflight_id
    })
}

fn git(directory: &Path, arguments: &[&str]) {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        arguments,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        arguments,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn git_succeeds(directory: &Path, arguments: &[&str]) -> bool {
    Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .output()
        .unwrap()
        .status
        .success()
}

fn initialized_repository(directory: &Path) {
    git(directory, &["init", "--initial-branch=main"]);
    git(directory, &["config", "core.autocrlf", "false"]);
    git(directory, &["config", "user.name", "CodePro Test"]);
    git(
        directory,
        &["config", "user.email", "codepro@example.invalid"],
    );
    std::fs::write(directory.join("tracked.txt"), "first\n").unwrap();
    git(directory, &["add", "tracked.txt"]);
    git(directory, &["commit", "-m", "initial"]);
}

fn write_executable_script(path: &Path, contents: &str) {
    std::fs::write(path, contents).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }
}

fn start_conflict(directory: &Path, operation: &str) -> String {
    initialized_repository(directory);
    match operation {
        "rebase" => {
            git(directory, &["checkout", "-b", "topic"]);
            std::fs::write(directory.join("tracked.txt"), "topic\n").unwrap();
            git(directory, &["add", "tracked.txt"]);
            git(directory, &["commit", "-m", "topic change"]);
            let original_head = git_stdout(directory, &["rev-parse", "HEAD"]);
            git(directory, &["checkout", "main"]);
            std::fs::write(directory.join("tracked.txt"), "main\n").unwrap();
            git(directory, &["add", "tracked.txt"]);
            git(directory, &["commit", "-m", "main change"]);
            git(directory, &["checkout", "topic"]);
            assert!(!git_succeeds(directory, &["rebase", "main"]));
            original_head
        }
        "cherry_pick" => {
            git(directory, &["checkout", "-b", "source"]);
            std::fs::write(directory.join("tracked.txt"), "source\n").unwrap();
            git(directory, &["add", "tracked.txt"]);
            git(directory, &["commit", "-m", "source change"]);
            let source = git_stdout(directory, &["rev-parse", "HEAD"]);
            git(directory, &["checkout", "main"]);
            std::fs::write(directory.join("tracked.txt"), "main\n").unwrap();
            git(directory, &["add", "tracked.txt"]);
            git(directory, &["commit", "-m", "main change"]);
            let original_head = git_stdout(directory, &["rev-parse", "HEAD"]);
            assert!(!git_succeeds(directory, &["cherry-pick", source.trim()]));
            original_head
        }
        "revert" => {
            std::fs::write(directory.join("tracked.txt"), "target\n").unwrap();
            git(directory, &["add", "tracked.txt"]);
            git(directory, &["commit", "-m", "target change"]);
            let target = git_stdout(directory, &["rev-parse", "HEAD"]);
            std::fs::write(directory.join("tracked.txt"), "current\n").unwrap();
            git(directory, &["add", "tracked.txt"]);
            git(directory, &["commit", "-m", "current change"]);
            let original_head = git_stdout(directory, &["rev-parse", "HEAD"]);
            assert!(!git_succeeds(directory, &["revert", target.trim()]));
            original_head
        }
        _ => panic!("unsupported conflict operation {operation}"),
    }
}

fn conflict_marker_exists(directory: &Path, operation: &str) -> bool {
    let git_directory =
        Path::new(git_stdout(directory, &["rev-parse", "--absolute-git-dir"]).trim()).to_path_buf();
    match operation {
        "rebase" => {
            git_directory.join("rebase-merge").exists()
                || git_directory.join("rebase-apply").exists()
        }
        "cherry_pick" => git_directory.join("CHERRY_PICK_HEAD").exists(),
        "revert" => git_directory.join("REVERT_HEAD").exists(),
        _ => false,
    }
}

#[tokio::test]
async fn registers_structured_git_tools_with_safe_annotations() {
    let directory = tempdir().unwrap();
    let client = GitClient::new(context(directory.path())).unwrap();
    let extension = PLATFORM_EXTENSIONS.get("git").unwrap();
    assert!(extension.default_enabled);
    assert!(extension.unprefixed_tools);
    assert!(!extension.hidden);

    let result = client
        .list_tools("session-1", None, CancellationToken::new())
        .await
        .unwrap();
    let names = result
        .tools
        .iter()
        .map(|tool| tool.name.as_ref())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "git_runtime_status",
            "github_runtime_status",
            "git_repository_snapshot",
            "git_status",
            "git_conflicts",
            "git_diff",
            "git_log",
            "git_branches",
            "git_push_preview",
            "git_force_push_preview",
            "git_clone_preview",
            "git_restore_preview",
            "git_conflict_abort_preview",
            "git_init",
            "git_stage",
            "git_unstage",
            "git_restore",
            "git_branch_create",
            "git_branch_switch",
            "git_commit",
            "git_conflict_continue",
            "git_conflict_abort",
            "git_fetch",
            "git_pull",
            "git_push",
            "git_clone",
            "git_force_push"
        ]
    );

    for tool in &result.tools[..13] {
        let annotations = tool.annotations.as_ref().unwrap();
        assert_eq!(annotations.read_only_hint, Some(true));
        assert_eq!(annotations.destructive_hint, Some(false));
    }
    assert_eq!(
        result.tools[1]
            .annotations
            .as_ref()
            .unwrap()
            .open_world_hint,
        Some(true)
    );
    for (index, tool) in result.tools[..13].iter().enumerate() {
        if index != 1 {
            assert_eq!(
                tool.annotations.as_ref().unwrap().open_world_hint,
                Some(false)
            );
        }
    }
    for tool in &result.tools[13..22] {
        let annotations = tool.annotations.as_ref().unwrap();
        assert_eq!(annotations.read_only_hint, Some(false));
        assert_eq!(annotations.destructive_hint, Some(true));
        assert_eq!(annotations.open_world_hint, Some(false));
    }
    for tool in &result.tools[22..26] {
        let annotations = tool.annotations.as_ref().unwrap();
        assert_eq!(annotations.read_only_hint, Some(false));
        assert_eq!(annotations.destructive_hint, Some(true));
        assert_eq!(annotations.open_world_hint, Some(true));
    }
    let force_push = &result.tools[26];
    let annotations = force_push.annotations.as_ref().unwrap();
    assert_eq!(annotations.read_only_hint, Some(false));
    assert_eq!(annotations.destructive_hint, Some(true));
    assert_eq!(annotations.open_world_hint, Some(true));
    assert_eq!(force_push.name, "git_force_push");

    let clone_preview = result
        .tools
        .iter()
        .find(|tool| tool.name == "git_clone_preview")
        .unwrap();
    let clone = result
        .tools
        .iter()
        .find(|tool| tool.name == "git_clone")
        .unwrap();
    for tool in [clone_preview, clone] {
        let required = tool.input_schema["required"].as_array().unwrap();
        assert!(required.iter().any(|value| value == "source"));
        assert!(required.iter().any(|value| value == "destination"));
    }
    assert!(clone.input_schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "preflight_id"));
    let restore_preview = result
        .tools
        .iter()
        .find(|tool| tool.name == "git_restore_preview")
        .unwrap();
    let restore = result
        .tools
        .iter()
        .find(|tool| tool.name == "git_restore")
        .unwrap();
    for tool in [restore_preview, restore] {
        assert!(tool.input_schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "paths"));
    }
    assert!(restore.input_schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "preflight_id"));
    let conflict_abort = result
        .tools
        .iter()
        .find(|tool| tool.name == "git_conflict_abort")
        .unwrap();
    assert!(conflict_abort.input_schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "preflight_id"));
    let force_push = result
        .tools
        .iter()
        .find(|tool| tool.name == "git_force_push")
        .unwrap();
    let force_push_required = force_push.input_schema["required"].as_array().unwrap();
    for field in [
        "remote",
        "branch",
        "head",
        "expected_remote_oid",
        "local_only_commit_count",
        "remote_only_commit_count",
        "preflight_id",
    ] {
        assert!(
            force_push_required.iter().any(|value| value == field),
            "missing force-push confirmation field {field}"
        );
    }

    let conflicts = result
        .tools
        .iter()
        .find(|tool| tool.name == "git_conflicts")
        .unwrap();
    assert_eq!(conflicts.input_schema["additionalProperties"], false);
}

#[tokio::test]
async fn reports_the_local_git_runtime_before_repository_operations() {
    let directory = tempdir().unwrap();
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "git-runtime-status".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let result = client
        .call_tool(
            &ctx,
            "git_runtime_status",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let value = json(&result);

    assert_eq!(value["available"], true);
    assert!(value["version"]
        .as_str()
        .unwrap()
        .starts_with("git version "));
    assert!(value["install_url"]
        .as_str()
        .unwrap()
        .starts_with("https://git-scm.com/download/"));
}

#[tokio::test]
async fn reports_github_cli_installation_and_authentication_without_exposing_credentials() {
    let directory = tempdir().unwrap();
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "github-runtime-status".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let result = client
        .call_tool(
            &ctx,
            "github_runtime_status",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let value = json(&result);

    assert!(value["available"].is_boolean());
    assert!(value["authenticated"].is_boolean());
    assert_eq!(value["hostname"], "github.com");
    assert_eq!(value["install_url"], "https://cli.github.com/");
    assert_eq!(
        value["login_command"],
        "gh auth login --hostname github.com --web"
    );
    assert!(value.get("token").is_none());
    if value["available"] == false {
        assert_eq!(value["authenticated"], false);
        assert!(value["version"].is_null());
    }
}

#[tokio::test]
async fn creates_a_branch_from_detached_head_and_switches_existing_local_branches() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    git(directory.path(), &["switch", "--detach"]);

    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "branch-recovery".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let created = client
        .call_tool(
            &ctx,
            "git_branch_create",
            Some(object!({"name": "recovery/work"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(created.is_error, Some(false));
    assert_eq!(json(&created)["branch"], "recovery/work");
    assert_eq!(json(&created)["created"], true);
    assert_eq!(
        git_stdout(directory.path(), &["branch", "--show-current"]).trim(),
        "recovery/work"
    );

    let switched = client
        .call_tool(
            &ctx,
            "git_branch_switch",
            Some(object!({"name": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(switched.is_error, Some(false));
    assert_eq!(json(&switched)["branch"], "main");
    assert_eq!(json(&switched)["created"], false);
    assert_eq!(
        git_stdout(directory.path(), &["branch", "--show-current"]).trim(),
        "main"
    );
}

#[tokio::test]
async fn unstages_only_explicit_paths_without_changing_worktree_content() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    std::fs::write(directory.path().join("tracked.txt"), "staged change\n").unwrap();
    std::fs::write(directory.path().join("other.txt"), "other staged\n").unwrap();
    git(directory.path(), &["add", "tracked.txt", "other.txt"]);

    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "unstage-explicit".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let result = client
        .call_tool(
            &ctx,
            "git_unstage",
            Some(object!({"paths": ["tracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(false));
    assert_eq!(json(&result)["unstaged_paths"], json!(["tracked.txt"]));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
        "staged change\n"
    );
    assert_eq!(
        git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).trim(),
        "other.txt"
    );
}

#[tokio::test]
async fn restores_only_explicit_paths_after_a_matching_hashed_preview() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    std::fs::write(directory.path().join("tracked.txt"), "restore me\n").unwrap();
    std::fs::write(directory.path().join("other.txt"), "keep me\n").unwrap();
    git(directory.path(), &["add", "other.txt"]);
    git(directory.path(), &["commit", "-m", "add other"]);
    std::fs::write(directory.path().join("other.txt"), "do not restore\n").unwrap();

    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "restore-explicit".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let preview = client
        .call_tool(
            &ctx,
            "git_restore_preview",
            Some(object!({"paths": ["tracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(preview.is_error, Some(false), "{}", text(&preview));
    let preview = json(&preview);
    assert_eq!(preview["paths"], json!(["tracked.txt"]));
    assert_eq!(preview["changed_paths"], json!(["tracked.txt"]));
    assert!(preview["diff"].as_str().unwrap().contains("restore me"));
    assert_eq!(preview["blocked_reasons"], json!([]));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
        "restore me\n"
    );

    let restored = client
        .call_tool(
            &ctx,
            "git_restore",
            Some(object!({
                "paths": ["tracked.txt"],
                "preflight_id": preview["preflight_id"].as_str().unwrap()
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(restored.is_error, Some(false), "{}", text(&restored));
    assert_eq!(json(&restored)["restored_paths"], json!(["tracked.txt"]));
    assert!(git_succeeds(
        directory.path(),
        &["diff", "--quiet", "--", "tracked.txt"]
    ));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("other.txt")).unwrap(),
        "do not restore\n"
    );
}

#[tokio::test]
async fn restore_rejects_stale_previews_and_untracked_paths_without_mutation() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    std::fs::write(directory.path().join("tracked.txt"), "previewed\n").unwrap();
    std::fs::write(directory.path().join("untracked.txt"), "keep\n").unwrap();
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "restore-rejections".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let preview = client
        .call_tool(
            &ctx,
            "git_restore_preview",
            Some(object!({"paths": ["tracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();
    std::fs::write(directory.path().join("tracked.txt"), "changed later\n").unwrap();
    let stale = client
        .call_tool(
            &ctx,
            "git_restore",
            Some(object!({"paths": ["tracked.txt"], "preflight_id": preflight_id})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stale.is_error, Some(true));
    assert!(text(&stale).contains("预检已过期"));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
        "changed later\n"
    );

    let mixed = client
        .call_tool(
            &ctx,
            "git_restore_preview",
            Some(object!({"paths": ["tracked.txt", "untracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mixed = json(&mixed);
    assert!(mixed["blocked_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("untracked.txt")));
    let blocked = client
        .call_tool(
            &ctx,
            "git_restore",
            Some(object!({
                "paths": ["tracked.txt", "untracked.txt"],
                "preflight_id": mixed["preflight_id"].as_str().unwrap()
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(blocked.is_error, Some(true));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
        "changed later\n"
    );

    let untracked = client
        .call_tool(
            &ctx,
            "git_restore_preview",
            Some(object!({"paths": ["untracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(untracked.is_error, Some(false));
    assert!(!json(&untracked)["blocked_reasons"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        std::fs::read_to_string(directory.path().join("untracked.txt")).unwrap(),
        "keep\n"
    );
}

#[tokio::test]
async fn restore_treats_pathspec_magic_as_a_literal_filename() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    std::fs::write(directory.path().join("[t]racked.txt"), "literal initial\n").unwrap();
    std::fs::write(directory.path().join("other.txt"), "other initial\n").unwrap();
    git(
        directory.path(),
        &["--literal-pathspecs", "add", "[t]racked.txt", "other.txt"],
    );
    git(directory.path(), &["commit", "-m", "add literal pathspec"]);
    std::fs::write(directory.path().join("[t]racked.txt"), "literal changed\n").unwrap();
    std::fs::write(directory.path().join("other.txt"), "other changed\n").unwrap();

    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "restore-literal-pathspec".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let preview = client
        .call_tool(
            &ctx,
            "git_restore_preview",
            Some(object!({"paths": ["[t]racked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preview = json(&preview);
    assert_eq!(preview["changed_paths"], json!(["[t]racked.txt"]));

    let restored = client
        .call_tool(
            &ctx,
            "git_restore",
            Some(object!({
                "paths": ["[t]racked.txt"],
                "preflight_id": preview["preflight_id"].as_str().unwrap()
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(restored.is_error, Some(false), "{}", text(&restored));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("[t]racked.txt")).unwrap(),
        "literal initial\n"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("other.txt")).unwrap(),
        "other changed\n"
    );
}

#[tokio::test]
async fn restore_preflight_cannot_be_replayed_from_another_repository_subdirectory() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    std::fs::create_dir_all(directory.path().join("nested")).unwrap();
    std::fs::write(
        directory.path().join("nested/tracked.txt"),
        "nested initial\n",
    )
    .unwrap();
    git(directory.path(), &["add", "nested/tracked.txt"]);
    git(directory.path(), &["commit", "-m", "add nested"]);
    std::fs::write(directory.path().join("tracked.txt"), "root changed\n").unwrap();
    std::fs::write(
        directory.path().join("nested/tracked.txt"),
        "nested changed\n",
    )
    .unwrap();

    let client = GitClient::new(context(directory.path())).unwrap();
    let root_ctx = ToolCallContext::new(
        "restore-root-binding".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let preview = client
        .call_tool(
            &root_ctx,
            "git_restore_preview",
            Some(object!({"paths": ["tracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();

    let nested_ctx = ToolCallContext::new(
        "restore-nested-binding".to_string(),
        Some(directory.path().join("nested")),
        None,
    );
    let replay = client
        .call_tool(
            &nested_ctx,
            "git_restore",
            Some(object!({"paths": ["tracked.txt"], "preflight_id": preflight_id})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(replay.is_error, Some(true));
    assert!(text(&replay).contains("预检已过期"));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
        "root changed\n"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("nested/tracked.txt")).unwrap(),
        "nested changed\n"
    );

    let nested_preview = client
        .call_tool(
            &nested_ctx,
            "git_restore_preview",
            Some(object!({"paths": ["tracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let nested_preview = json(&nested_preview);
    assert_eq!(nested_preview["paths"], json!(["tracked.txt"]));
    assert_eq!(
        nested_preview["changed_paths"],
        json!(["nested/tracked.txt"])
    );
    let nested_restore = client
        .call_tool(
            &nested_ctx,
            "git_restore",
            Some(object!({
                "paths": nested_preview["paths"].clone(),
                "preflight_id": nested_preview["preflight_id"].as_str().unwrap()
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        nested_restore.is_error,
        Some(false),
        "{}",
        text(&nested_restore)
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("nested/tracked.txt")).unwrap(),
        "nested initial\n"
    );
}

#[tokio::test]
async fn branch_and_unstage_tools_reject_unsafe_or_missing_inputs_without_mutation() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    let head = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "git-invalid-inputs".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    for (tool, arguments) in [
        ("git_branch_create", object!({"name": "--orphan"})),
        ("git_branch_switch", object!({"name": "missing"})),
        ("git_unstage", object!({"paths": ["../outside.txt"]})),
    ] {
        let result = client
            .call_tool(&ctx, tool, Some(arguments), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true), "{tool} must reject input");
    }
    assert_eq!(git_stdout(directory.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git_stdout(directory.path(), &["branch", "--show-current"]).trim(),
        "main"
    );
}

#[tokio::test]
async fn reports_status_diff_log_and_branches_as_bounded_json() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    std::fs::write(directory.path().join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(directory.path().join("untracked.txt"), "new\n").unwrap();

    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "session-1".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let snapshot = client
        .call_tool(
            &ctx,
            "git_repository_snapshot",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.is_error, Some(false), "{}", text(&snapshot));
    let snapshot = json(&snapshot);
    assert_eq!(snapshot["status"]["branch"], "main");
    assert_eq!(snapshot["conflicts"]["operation"], "none");
    assert!(snapshot["branches"]["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| { branch["name"] == "main" && branch["current"] == true }));
    assert!(snapshot["diff"]["text"]
        .as_str()
        .unwrap()
        .contains("+changed"));
    assert_eq!(snapshot["staged_diff"]["scope"], "staged");

    let status = client
        .call_tool(
            &ctx,
            "git_status",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(status.is_error, Some(false));
    let status = json(&status);
    assert_eq!(status["branch"], "main");
    assert_eq!(status["detached"], false);
    assert!(status["repository_root"]
        .as_str()
        .unwrap()
        .ends_with(directory.path().file_name().unwrap().to_str().unwrap()));
    assert!(status["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| { entry["path"] == "tracked.txt" && entry["worktree_status"] == "M" }));
    assert!(status["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| { entry["path"] == "untracked.txt" && entry["index_status"] == "?" }));

    let diff = client
        .call_tool(
            &ctx,
            "git_diff",
            Some(object!({"scope": "working_tree", "paths": ["tracked.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(diff.is_error, Some(false));
    let diff = json(&diff);
    assert_eq!(diff["scope"], "working_tree");
    assert_eq!(diff["truncated"], false);
    assert!(diff["text"].as_str().unwrap().contains("+changed"));

    let log = client
        .call_tool(
            &ctx,
            "git_log",
            Some(object!({"limit": 5})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(log.is_error, Some(false));
    let log = json(&log);
    assert_eq!(log["commits"][0]["subject"], "initial");
    assert_eq!(log["commits"][0]["author_name"], "CodePro Test");

    let branches = client
        .call_tool(
            &ctx,
            "git_branches",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(branches.is_error, Some(false));
    let branches = json(&branches);
    assert!(branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| { branch["name"] == "main" && branch["current"] == true }));
}

#[tokio::test]
async fn reports_a_rename_as_one_entry_with_the_original_path() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    git(directory.path(), &["mv", "tracked.txt", "renamed.txt"]);
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "session-rename".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let status = client
        .call_tool(
            &ctx,
            "git_status",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(status.is_error, Some(false), "{}", text(&status));
    let status = json(&status);
    assert_eq!(status["entries"].as_array().unwrap().len(), 1);
    assert_eq!(status["entries"][0]["path"], "renamed.txt");
    assert_eq!(status["entries"][0]["original_path"], "tracked.txt");
    assert_eq!(status["truncated"], false);
}

#[tokio::test]
async fn reports_a_clean_repository_without_conflicts() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "conflicts-clean".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let result = client
        .call_tool(
            &ctx,
            "git_conflicts",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let result = json(&result);
    assert_eq!(result["has_conflicts"], false);
    assert_eq!(result["operation"], "none");
    assert_eq!(result["total_conflicts"], 0);
    assert_eq!(result["truncated"], false);
    assert_eq!(result["conflicts"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn reports_real_merge_conflicts_without_reading_file_contents_or_mutating_the_index() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    git(directory.path(), &["checkout", "-b", "feature"]);
    std::fs::write(
        directory.path().join("tracked.txt"),
        "FEATURE_PRIVATE_BODY\n",
    )
    .unwrap();
    git(directory.path(), &["add", "tracked.txt"]);
    git(directory.path(), &["commit", "-m", "feature change"]);
    git(directory.path(), &["checkout", "main"]);
    std::fs::write(directory.path().join("tracked.txt"), "MAIN_PRIVATE_BODY\n").unwrap();
    git(directory.path(), &["add", "tracked.txt"]);
    git(directory.path(), &["commit", "-m", "main change"]);
    assert!(!git_succeeds(directory.path(), &["merge", "feature"]));
    let index_before = git_stdout(directory.path(), &["ls-files", "--unmerged", "--stage"]);

    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "conflicts-merge".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let result = client
        .call_tool(
            &ctx,
            "git_conflicts",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let serialized = text(&result);
    assert!(!serialized.contains("FEATURE_PRIVATE_BODY"));
    assert!(!serialized.contains("MAIN_PRIVATE_BODY"));
    assert!(!serialized.contains(&directory.path().to_string_lossy().to_string()));
    let result = json(&result);
    assert_eq!(result["has_conflicts"], true);
    assert_eq!(result["operation"], "merge");
    assert_eq!(result["total_conflicts"], 1);
    assert_eq!(result["truncated"], false);
    assert_eq!(result["conflicts"][0]["path"], "tracked.txt");
    assert_eq!(result["conflicts"][0]["code"], "UU");
    assert_eq!(result["conflicts"][0]["kind"], "both_modified");
    assert_eq!(result["conflicts"][0]["stages"], json!([1, 2, 3]));
    assert_eq!(
        git_stdout(directory.path(), &["ls-files", "--unmerged", "--stage"]),
        index_before
    );
}

#[tokio::test]
async fn continues_resolved_merges_and_aborts_only_with_a_fresh_hashed_preview() {
    let continued_directory = tempdir().unwrap();
    initialized_repository(continued_directory.path());
    git(continued_directory.path(), &["checkout", "-b", "feature"]);
    std::fs::write(continued_directory.path().join("tracked.txt"), "feature\n").unwrap();
    git(continued_directory.path(), &["add", "tracked.txt"]);
    git(
        continued_directory.path(),
        &["commit", "-m", "feature change"],
    );
    git(continued_directory.path(), &["checkout", "main"]);
    std::fs::write(continued_directory.path().join("tracked.txt"), "main\n").unwrap();
    git(continued_directory.path(), &["add", "tracked.txt"]);
    git(continued_directory.path(), &["commit", "-m", "main change"]);
    let continued_head = git_stdout(continued_directory.path(), &["rev-parse", "HEAD"]);
    assert!(!git_succeeds(
        continued_directory.path(),
        &["merge", "feature"]
    ));

    let continued_client = GitClient::new(context(continued_directory.path())).unwrap();
    let continued_ctx = ToolCallContext::new(
        "conflict-continue".to_string(),
        Some(continued_directory.path().to_path_buf()),
        None,
    );
    let unresolved = continued_client
        .call_tool(
            &continued_ctx,
            "git_conflict_continue",
            Some(object!({"operation": "merge"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(unresolved.is_error, Some(true));
    assert!(text(&unresolved).contains("未解决"));
    assert_eq!(
        git_stdout(continued_directory.path(), &["rev-parse", "HEAD"]),
        continued_head
    );

    std::fs::write(continued_directory.path().join("tracked.txt"), "resolved\n").unwrap();
    git(continued_directory.path(), &["add", "tracked.txt"]);
    let continued = continued_client
        .call_tool(
            &continued_ctx,
            "git_conflict_continue",
            Some(object!({"operation": "merge"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(continued.is_error, Some(false), "{}", text(&continued));
    assert_eq!(json(&continued)["operation"], "merge");
    assert_eq!(json(&continued)["status"], "completed");
    assert_ne!(
        git_stdout(continued_directory.path(), &["rev-parse", "HEAD"]),
        continued_head
    );
    assert!(!git_succeeds(
        continued_directory.path(),
        &["rev-parse", "--verify", "MERGE_HEAD"]
    ));

    let aborted_directory = tempdir().unwrap();
    initialized_repository(aborted_directory.path());
    git(aborted_directory.path(), &["checkout", "-b", "feature"]);
    std::fs::write(aborted_directory.path().join("tracked.txt"), "feature\n").unwrap();
    git(aborted_directory.path(), &["add", "tracked.txt"]);
    git(
        aborted_directory.path(),
        &["commit", "-m", "feature change"],
    );
    git(aborted_directory.path(), &["checkout", "main"]);
    std::fs::write(aborted_directory.path().join("tracked.txt"), "main\n").unwrap();
    git(aborted_directory.path(), &["add", "tracked.txt"]);
    git(aborted_directory.path(), &["commit", "-m", "main change"]);
    let aborted_head = git_stdout(aborted_directory.path(), &["rev-parse", "HEAD"]);
    assert!(!git_succeeds(
        aborted_directory.path(),
        &["merge", "feature"]
    ));
    std::fs::write(aborted_directory.path().join("untracked.txt"), "keep\n").unwrap();

    let aborted_client = GitClient::new(context(aborted_directory.path())).unwrap();
    let aborted_ctx = ToolCallContext::new(
        "conflict-abort".to_string(),
        Some(aborted_directory.path().to_path_buf()),
        None,
    );
    let preview = aborted_client
        .call_tool(
            &aborted_ctx,
            "git_conflict_abort_preview",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(preview.is_error, Some(false), "{}", text(&preview));
    let preview = json(&preview);
    assert_eq!(preview["operation"], "merge");
    assert_eq!(preview["head"].as_str().unwrap(), aborted_head.trim());
    assert_eq!(preview["conflicted_paths"], json!(["tracked.txt"]));
    assert_eq!(preview["blocked_reasons"], json!([]));

    std::fs::write(
        aborted_directory.path().join("tracked.txt"),
        "changed later\n",
    )
    .unwrap();
    let stale = aborted_client
        .call_tool(
            &aborted_ctx,
            "git_conflict_abort",
            Some(object!({
                "operation": "merge",
                "preflight_id": preview["preflight_id"].as_str().unwrap()
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stale.is_error, Some(true));
    assert!(text(&stale).contains("预检已过期"));
    assert!(git_succeeds(
        aborted_directory.path(),
        &["rev-parse", "--verify", "MERGE_HEAD"]
    ));

    let fresh_preview = aborted_client
        .call_tool(
            &aborted_ctx,
            "git_conflict_abort_preview",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let aborted = aborted_client
        .call_tool(
            &aborted_ctx,
            "git_conflict_abort",
            Some(object!({
                "operation": "merge",
                "preflight_id": json(&fresh_preview)["preflight_id"].as_str().unwrap()
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(aborted.is_error, Some(false), "{}", text(&aborted));
    assert_eq!(json(&aborted)["operation"], "merge");
    assert_eq!(json(&aborted)["status"], "aborted");
    assert_eq!(
        git_stdout(aborted_directory.path(), &["rev-parse", "HEAD"]),
        aborted_head
    );
    assert!(!git_succeeds(
        aborted_directory.path(),
        &["rev-parse", "--verify", "MERGE_HEAD"]
    ));
    assert_eq!(
        std::fs::read_to_string(aborted_directory.path().join("untracked.txt")).unwrap(),
        "keep\n"
    );
}

#[tokio::test]
async fn continues_resolved_rebase_cherry_pick_and_revert_operations() {
    for operation in ["rebase", "cherry_pick", "revert"] {
        let directory = tempdir().unwrap();
        let original_head = start_conflict(directory.path(), operation);
        assert!(conflict_marker_exists(directory.path(), operation));

        let client = GitClient::new(context(directory.path())).unwrap();
        let ctx = ToolCallContext::new(
            format!("continue-{operation}"),
            Some(directory.path().to_path_buf()),
            None,
        );
        let unresolved = client
            .call_tool(
                &ctx,
                "git_conflict_continue",
                Some(object!({"operation": operation})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(unresolved.is_error, Some(true), "{operation}");
        assert!(text(&unresolved).contains("未解决"), "{operation}");

        std::fs::write(directory.path().join("tracked.txt"), "resolved\n").unwrap();
        git(directory.path(), &["add", "tracked.txt"]);
        let continued = client
            .call_tool(
                &ctx,
                "git_conflict_continue",
                Some(object!({"operation": operation})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            continued.is_error,
            Some(false),
            "{operation}: {}",
            text(&continued)
        );
        assert_eq!(json(&continued)["operation"], operation);
        assert_eq!(json(&continued)["status"], "completed");
        assert_ne!(
            git_stdout(directory.path(), &["rev-parse", "HEAD"]),
            original_head,
            "{operation} must advance or rewrite HEAD"
        );
        assert!(!conflict_marker_exists(directory.path(), operation));
    }
}

#[tokio::test]
async fn aborts_rebase_cherry_pick_and_revert_only_with_fresh_operation_state() {
    for operation in ["rebase", "cherry_pick", "revert"] {
        let directory = tempdir().unwrap();
        let original_head = start_conflict(directory.path(), operation);
        std::fs::write(directory.path().join("untracked.txt"), "keep\n").unwrap();

        let client = GitClient::new(context(directory.path())).unwrap();
        let ctx = ToolCallContext::new(
            format!("abort-{operation}"),
            Some(directory.path().to_path_buf()),
            None,
        );
        let preview = client
            .call_tool(
                &ctx,
                "git_conflict_abort_preview",
                Some(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            preview.is_error,
            Some(false),
            "{operation}: {}",
            text(&preview)
        );
        let preview = json(&preview);
        assert_eq!(preview["operation"], operation);
        assert_eq!(preview["blocked_reasons"], json!([]));

        let aborted = client
            .call_tool(
                &ctx,
                "git_conflict_abort",
                Some(object!({
                    "operation": operation,
                    "preflight_id": preview["preflight_id"].as_str().unwrap()
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            aborted.is_error,
            Some(false),
            "{operation}: {}",
            text(&aborted)
        );
        assert_eq!(json(&aborted)["operation"], operation);
        assert_eq!(json(&aborted)["status"], "aborted");
        assert_eq!(
            git_stdout(directory.path(), &["rev-parse", "HEAD"]),
            original_head,
            "{operation} abort must restore the pre-operation HEAD"
        );
        assert!(!conflict_marker_exists(directory.path(), operation));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("untracked.txt")).unwrap(),
            "keep\n"
        );
    }
}

#[tokio::test]
async fn conflict_abort_rejects_a_stale_rebase_plan_without_worktree_changes() {
    let directory = tempdir().unwrap();
    start_conflict(directory.path(), "rebase");
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "stale-rebase-plan".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let preview = client
        .call_tool(
            &ctx,
            "git_conflict_abort_preview",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();

    let git_directory = PathBuf::from(
        git_stdout(directory.path(), &["rev-parse", "--absolute-git-dir"])
            .trim()
            .to_string(),
    );
    let rebase_directory = ["rebase-merge", "rebase-apply"]
        .iter()
        .map(|name| git_directory.join(name))
        .find(|path| path.exists())
        .unwrap();
    let todo_path = rebase_directory.join("git-rebase-todo");
    let mut todo = std::fs::read_to_string(&todo_path).unwrap();
    todo.push_str("# changed after preview\n");
    std::fs::write(todo_path, todo).unwrap();

    let stale = client
        .call_tool(
            &ctx,
            "git_conflict_abort",
            Some(object!({
                "operation": "rebase",
                "preflight_id": preflight_id
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stale.is_error, Some(true));
    assert!(text(&stale).contains("预检已过期"));
    assert!(conflict_marker_exists(directory.path(), "rebase"));

    git(directory.path(), &["rebase", "--abort"]);
}

#[tokio::test]
async fn rejects_non_repository_and_unsafe_diff_inputs() {
    let directory = tempdir().unwrap();
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "session-1".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let status = client
        .call_tool(
            &ctx,
            "git_status",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(status.is_error, Some(true));
    assert!(text(&status).contains("不是 Git 仓库"));

    initialized_repository(directory.path());
    let unsafe_diff = client
        .call_tool(
            &ctx,
            "git_diff",
            Some(object!({
                "scope": "base",
                "base": "HEAD; Remove-Item -Recurse .git",
                "paths": ["../outside.txt"]
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(unsafe_diff.is_error, Some(true));
    assert!(text(&unsafe_diff).contains("无效"));
}

#[tokio::test]
async fn initializes_stages_explicit_paths_and_commits_without_touching_unrelated_changes() {
    let directory = tempdir().unwrap();
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "session-1".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let init = client
        .call_tool(
            &ctx,
            "git_init",
            Some(object!({"initial_branch": "develop"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(init.is_error, Some(false));
    assert_eq!(json(&init)["branch"], "develop");

    git(directory.path(), &["config", "user.name", "CodePro Test"]);
    git(
        directory.path(),
        &["config", "user.email", "codepro@example.invalid"],
    );
    std::fs::write(directory.path().join("selected.txt"), "selected\n").unwrap();
    std::fs::write(directory.path().join("unrelated.txt"), "unrelated\n").unwrap();

    let stage = client
        .call_tool(
            &ctx,
            "git_stage",
            Some(object!({"paths": ["selected.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stage.is_error, Some(false));
    let stage = json(&stage);
    assert_eq!(stage["staged_paths"], serde_json::json!(["selected.txt"]));
    let staged = Command::new("git")
        .args(["diff", "--cached", "--name-only"])
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&staged.stdout).trim(),
        "selected.txt"
    );

    let commit = client
        .call_tool(
            &ctx,
            "git_commit",
            Some(object!({"message": "add selected file"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(commit.is_error, Some(false));
    let commit = json(&commit);
    assert_eq!(commit["subject"], "add selected file");
    assert_eq!(commit["branch"], "develop");
    assert_eq!(
        commit["committed_paths"],
        serde_json::json!(["selected.txt"])
    );
    assert!(directory.path().join("unrelated.txt").exists());
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&status.stdout).contains("?? unrelated.txt"));
}

#[tokio::test]
async fn repository_hooks_and_fsmonitor_are_disabled_for_structured_git_commands() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    std::fs::write(directory.path().join("tracked.txt"), "second\n").unwrap();
    git(directory.path(), &["add", "tracked.txt"]);

    let hooks = directory.path().join(".test-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    write_executable_script(
        &hooks.join("pre-commit"),
        "#!/bin/sh\nprintf invoked > hook-invoked.txt\nexit 1\n",
    );
    write_executable_script(
        &hooks.join("fsmonitor"),
        "#!/bin/sh\nprintf invoked > fsmonitor-invoked.txt\nprintf '\\n'\nexit 0\n",
    );
    git(
        directory.path(),
        &["config", "core.hooksPath", ".test-hooks"],
    );
    git(
        directory.path(),
        &["config", "core.fsmonitor", ".test-hooks/fsmonitor"],
    );

    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "isolated-git-config".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let status = client
        .call_tool(
            &ctx,
            "git_status",
            Some(object!({})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(status.is_error, Some(false));
    assert!(!directory.path().join("fsmonitor-invoked.txt").exists());

    let commit = client
        .call_tool(
            &ctx,
            "git_commit",
            Some(object!({"message": "isolated commit"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(commit.is_error, Some(false));
    assert!(!directory.path().join("hook-invoked.txt").exists());
    assert_eq!(
        git_stdout(directory.path(), &["log", "-1", "--format=%s"]).trim(),
        "isolated commit"
    );
}

#[tokio::test]
async fn inherited_repository_routing_environment_is_ignored() {
    const CHILD_REPOSITORY: &str = "CODEPRO_GIT_ENV_TEST_REPOSITORY";
    if let Some(repository) = std::env::var_os(CHILD_REPOSITORY) {
        let repository = PathBuf::from(repository);
        let client = GitClient::new(context(&repository)).unwrap();
        let ctx = ToolCallContext::new(
            "isolated-git-environment-child".to_string(),
            Some(repository.clone()),
            None,
        );
        let status = client
            .call_tool(
                &ctx,
                "git_status",
                Some(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(status.is_error, Some(false), "{}", text(&status));
        let reported_root = PathBuf::from(
            json(&status)["repository_root"]
                .as_str()
                .expect("repository root"),
        );
        assert_eq!(
            std::fs::canonicalize(reported_root).unwrap(),
            std::fs::canonicalize(repository).unwrap()
        );
        return;
    }

    let root = tempdir().unwrap();
    let repository = root.path().join("expected");
    let decoy = root.path().join("decoy");
    std::fs::create_dir_all(&repository).unwrap();
    std::fs::create_dir_all(&decoy).unwrap();
    initialized_repository(&repository);
    initialized_repository(&decoy);
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "inherited_repository_routing_environment_is_ignored",
            "--nocapture",
        ])
        .env(CHILD_REPOSITORY, &repository)
        .env("GIT_DIR", decoy.join(".git"))
        .env("GIT_WORK_TREE", &decoy)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child test failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn rejects_unsafe_init_stage_and_commit_inputs() {
    let directory = tempdir().unwrap();
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "session-1".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    let init = client
        .call_tool(
            &ctx,
            "git_init",
            Some(object!({"initial_branch": "--bare"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(init.is_error, Some(true));
    assert!(text(&init).contains("无效"));

    initialized_repository(directory.path());
    let stage = client
        .call_tool(
            &ctx,
            "git_stage",
            Some(object!({"paths": ["../outside.txt"]})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stage.is_error, Some(true));
    assert!(text(&stage).contains("无效"));

    let commit = client
        .call_tool(
            &ctx,
            "git_commit",
            Some(object!({"message": ""})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(commit.is_error, Some(true));
    assert!(text(&commit).contains("提交消息"));
}

#[tokio::test]
async fn commit_and_pull_reject_detached_head_before_mutation() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&local, &["push", "-u", "origin", "main"]);
    std::fs::write(local.join("detached.txt"), "detached\n").unwrap();
    git(&local, &["add", "detached.txt"]);
    git(&local, &["checkout", "--detach"]);

    let head_before = git_stdout(&local, &["rev-parse", "HEAD"]);
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("detached-write".to_string(), Some(local.clone()), None);

    let commit = client
        .call_tool(
            &ctx,
            "git_commit",
            Some(object!({"message": "must not commit detached"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(commit.is_error, Some(true));
    assert!(text(&commit).contains("detached HEAD"));
    assert_eq!(git_stdout(&local, &["rev-parse", "HEAD"]), head_before);

    let pull = client
        .call_tool(
            &ctx,
            "git_pull",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(pull.is_error, Some(true));
    assert!(text(&pull).contains("detached HEAD"));
    assert_eq!(git_stdout(&local, &["rev-parse", "HEAD"]), head_before);
}

#[tokio::test]
async fn pull_rejects_a_branch_other_than_the_current_branch() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&local, &["push", "-u", "origin", "main"]);
    git(&local, &["checkout", "-b", "develop"]);
    git(&local, &["push", "-u", "origin", "develop"]);

    let head_before = git_stdout(&local, &["rev-parse", "HEAD"]);
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("wrong-pull-branch".to_string(), Some(local.clone()), None);
    let pull = client
        .call_tool(
            &ctx,
            "git_pull",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(pull.is_error, Some(true));
    assert!(text(&pull).contains("当前分支 develop"));
    assert_eq!(git_stdout(&local, &["rev-parse", "HEAD"]), head_before);
}

#[tokio::test]
async fn pushes_fetches_and_fast_forward_pulls_against_a_real_bare_remote() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    let peer = root.path().join("peer");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );

    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("session-1".to_string(), Some(local.clone()), None);
    let preview = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(preview.is_error, Some(false), "{}", text(&preview));
    let preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();
    let push = client
        .call_tool(
            &ctx,
            "git_push",
            Some(object!({
                "remote": "origin",
                "branch": "main",
                "preflight_id": preflight_id
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(push.is_error, Some(false));
    assert_eq!(json(&push)["operation"], "push");
    assert_eq!(json(&push)["remote"], "origin");
    assert_eq!(json(&push)["branch"], "main");

    git(
        root.path(),
        &[
            "clone",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            peer.to_str().unwrap(),
        ],
    );
    git(&peer, &["config", "user.name", "Peer"]);
    git(&peer, &["config", "user.email", "peer@example.invalid"]);
    std::fs::write(peer.join("peer.txt"), "from peer\n").unwrap();
    git(&peer, &["add", "peer.txt"]);
    git(&peer, &["commit", "-m", "peer update"]);
    git(&peer, &["push", "origin", "main"]);

    let fetch = client
        .call_tool(
            &ctx,
            "git_fetch",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(fetch.is_error, Some(false));
    assert_eq!(json(&fetch)["operation"], "fetch");

    let pull = client
        .call_tool(
            &ctx,
            "git_pull",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(pull.is_error, Some(false));
    assert_eq!(json(&pull)["operation"], "pull");
    assert_eq!(
        std::fs::read_to_string(local.join("peer.txt"))
            .unwrap()
            .trim_end(),
        "from peer"
    );
}

#[tokio::test]
async fn remote_tools_reject_urls_force_refspecs_and_unknown_remotes() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "session-1".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );

    for arguments in [
        object!({
            "remote": "https://token@example.invalid/repo.git",
            "branch": "main",
            "preflight_id": "0000000000000000000000000000000000000000000000000000000000000000"
        }),
        object!({
            "remote": "origin",
            "branch": "+main:main",
            "preflight_id": "0000000000000000000000000000000000000000000000000000000000000000"
        }),
        object!({
            "remote": "missing",
            "branch": "main",
            "preflight_id": "0000000000000000000000000000000000000000000000000000000000000000"
        }),
    ] {
        let result = client
            .call_tool(&ctx, "git_push", Some(arguments), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true));
        assert!(!text(&result).contains("token@example"));
    }
}

#[tokio::test]
async fn previews_push_without_touching_the_user_index() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    std::fs::write(local.join("unstaged.txt"), "leave me alone\n").unwrap();
    let index_before = git_stdout(&local, &["diff", "--cached", "--binary"]);

    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("preview-session".to_string(), Some(local.clone()), None);
    let result = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let preview = json(&result);
    assert_eq!(preview["remote"], "origin");
    assert_eq!(preview["branch"], "main");
    assert_eq!(preview["head"].as_str().unwrap().len(), 40);
    assert_eq!(preview["outgoing_commit_count"], 1);
    assert_eq!(preview["outgoing_commits"][0]["subject"], "initial");
    assert!(preview["changed_paths"]
        .as_array()
        .unwrap()
        .iter()
        .any(|path| path == "tracked.txt"));
    assert_eq!(preview["paths_truncated"], false);
    assert_eq!(preview["sensitive_paths"], serde_json::json!([]));
    assert_eq!(preview["blocked_reasons"], serde_json::json!([]));
    let preflight_id = preview["preflight_id"].as_str().unwrap();
    assert_eq!(preflight_id.len(), 64);
    assert!(preflight_id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert_eq!(
        git_stdout(&local, &["diff", "--cached", "--binary"]),
        index_before
    );
    assert!(local.join("unstaged.txt").exists());
}

#[tokio::test]
async fn push_preview_redacts_credentials_from_the_remote_destination() {
    let directory = tempdir().unwrap();
    initialized_repository(directory.path());
    git(
        directory.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://automation:secret-token@github.com/acme/repo.git",
        ],
    );
    let client = GitClient::new(context(directory.path())).unwrap();
    let ctx = ToolCallContext::new(
        "redacted-preview-session".to_string(),
        Some(directory.path().to_path_buf()),
        None,
    );
    let result = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let body = text(&result);
    assert!(body.contains("https://github.com/acme/repo.git"));
    assert!(!body.contains("automation"));
    assert!(!body.contains("secret-token"));
}

#[tokio::test]
async fn push_requires_a_preflight_id_before_touching_the_remote() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("missing-preflight".to_string(), Some(local), None);

    let result = client
        .call_tool(
            &ctx,
            "git_push",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(true), "{}", text(&result));
    assert!(text(&result).contains("预检"));
    assert!(!git_succeeds(
        &remote,
        &["show-ref", "--verify", "--quiet", "refs/heads/main"]
    ));
}

#[tokio::test]
async fn push_rejects_an_incorrect_or_stale_preflight_id() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("stale-preflight".to_string(), Some(local.clone()), None);

    let preview = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let old_preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();
    std::fs::write(local.join("later.txt"), "later\n").unwrap();
    git(&local, &["add", "later.txt"]);
    git(&local, &["commit", "-m", "later commit"]);

    for preflight_id in ["0".repeat(64), old_preflight_id] {
        let result = client
            .call_tool(
                &ctx,
                "git_push",
                Some(object!({
                    "remote": "origin",
                    "branch": "main",
                    "preflight_id": preflight_id
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true), "{}", text(&result));
        assert!(text(&result).contains("预检已过期"));
    }
    assert!(!git_succeeds(
        &remote,
        &["show-ref", "--verify", "--quiet", "refs/heads/main"]
    ));
}

#[tokio::test]
async fn push_blocks_sensitive_paths_and_non_current_branches() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    std::fs::write(local.join(".env"), "TOP_SECRET=not-for-remote\n").unwrap();
    git(&local, &["add", ".env"]);
    git(&local, &["commit", "-m", "accidental secret"]);
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("blocked-preflight".to_string(), Some(local.clone()), None);

    let sensitive_preview = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let sensitive_preview_json = json(&sensitive_preview);
    assert_eq!(
        sensitive_preview_json["sensitive_paths"],
        serde_json::json!([".env"])
    );
    let sensitive_id = sensitive_preview_json["preflight_id"]
        .as_str()
        .unwrap()
        .to_string();
    let sensitive_push = client
        .call_tool(
            &ctx,
            "git_push",
            Some(object!({
                "remote": "origin",
                "branch": "main",
                "preflight_id": sensitive_id
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(sensitive_push.is_error, Some(true));
    assert!(text(&sensitive_push).contains("敏感路径"));

    let branch_preview = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "develop"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let branch_preview_json = json(&branch_preview);
    assert!(branch_preview_json["blocked_reasons"][0]
        .as_str()
        .unwrap()
        .contains("不是当前分支"));
    let branch_id = branch_preview_json["preflight_id"]
        .as_str()
        .unwrap()
        .to_string();
    let branch_push = client
        .call_tool(
            &ctx,
            "git_push",
            Some(object!({
                "remote": "origin",
                "branch": "develop",
                "preflight_id": branch_id
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(branch_push.is_error, Some(true));
    assert!(text(&branch_push).contains("目标分支"));
    assert!(!git_succeeds(
        &remote,
        &["show-ref", "--verify", "--quiet", "refs/heads/main"]
    ));
}

#[tokio::test]
async fn push_preview_compares_against_the_exact_target_branch() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&local, &["push", "origin", "main"]);
    git(&local, &["checkout", "-b", "develop"]);
    std::fs::write(local.join(".env"), "TOP_SECRET=not-for-main\n").unwrap();
    git(&local, &["add", ".env"]);
    git(&local, &["commit", "-m", "secret on develop"]);
    git(&local, &["push", "origin", "develop"]);
    git(&local, &["checkout", "main"]);
    git(&local, &["merge", "--ff-only", "develop"]);

    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("target-branch-preview".to_string(), Some(local), None);
    let preview = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(preview.is_error, Some(false), "{}", text(&preview));
    let preview = json(&preview);
    assert_eq!(preview["outgoing_commit_count"], 1);
    assert_eq!(preview["sensitive_paths"], serde_json::json!([".env"]));
}

#[tokio::test]
async fn push_preview_reports_detached_head_as_a_blocked_state() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir_all(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&local, &["checkout", "--detach"]);
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new("detached-preflight".to_string(), Some(local), None);

    let preview = client
        .call_tool(
            &ctx,
            "git_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(preview.is_error, Some(false), "{}", text(&preview));
    let preview = json(&preview);
    assert!(preview["blocked_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("detached HEAD")));
}

#[tokio::test]
async fn force_push_preview_binds_the_exact_remote_tip_and_divergent_history() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    let other = root.path().join("other");
    std::fs::create_dir(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&local, &["push", "-u", "origin", "main"]);
    git(
        root.path(),
        &[
            "clone",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["config", "user.name", "CodePro Other"]);
    git(&other, &["config", "user.email", "other@example.invalid"]);

    std::fs::write(local.join("local-only.txt"), "local\n").unwrap();
    git(&local, &["add", "local-only.txt"]);
    git(&local, &["commit", "-m", "local only"]);
    std::fs::write(other.join("remote-only.txt"), "remote\n").unwrap();
    git(&other, &["add", "remote-only.txt"]);
    git(&other, &["commit", "-m", "remote only"]);
    git(&other, &["push", "origin", "main"]);
    git(&local, &["fetch", "origin"]);
    let expected_remote_oid = git_stdout(&remote, &["rev-parse", "refs/heads/main"])
        .trim()
        .to_string();
    let local_head = git_stdout(&local, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    let index_before = git_stdout(&local, &["diff", "--cached", "--binary"]);

    let client = GitClient::new(context(&local)).unwrap();
    let ctx = ToolCallContext::new("force-preview".to_string(), Some(local.clone()), None);
    let result = client
        .call_tool(
            &ctx,
            "git_force_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false), "{}", text(&result));
    let result = json(&result);
    assert_eq!(result["branch"], "main");
    assert_eq!(result["head"], local_head);
    assert_eq!(result["expected_remote_oid"], expected_remote_oid);
    assert_eq!(result["local_only_commit_count"], 1);
    assert_eq!(result["remote_only_commit_count"], 1);
    assert_eq!(result["blocked_reasons"].as_array().unwrap().len(), 0);
    let preflight_id = result["preflight_id"].as_str().unwrap().to_string();
    assert_eq!(preflight_id.len(), 64);
    assert_eq!(
        git_stdout(&local, &["diff", "--cached", "--binary"]),
        index_before
    );

    let incorrect = client
        .call_tool(
            &ctx,
            "git_force_push",
            Some(force_push_arguments(
                &result,
                "0000000000000000000000000000000000000000000000000000000000000000",
            )),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(incorrect.is_error, Some(true));
    assert!(text(&incorrect).contains("预检"));
    assert_eq!(
        git_stdout(&remote, &["rev-parse", "refs/heads/main"])
            .trim()
            .to_string(),
        expected_remote_oid
    );

    let mut tampered_summary = force_push_arguments(&result, &preflight_id);
    tampered_summary.insert("remote_only_commit_count".to_string(), json!(999));
    let tampered = client
        .call_tool(
            &ctx,
            "git_force_push",
            Some(tampered_summary),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(tampered.is_error, Some(true));
    assert!(text(&tampered).contains("确认摘要"));
    assert_eq!(
        git_stdout(&remote, &["rev-parse", "refs/heads/main"])
            .trim()
            .to_string(),
        expected_remote_oid
    );

    let pushed = client
        .call_tool(
            &ctx,
            "git_force_push",
            Some(force_push_arguments(&result, &preflight_id)),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(pushed.is_error, Some(false), "{}", text(&pushed));
    assert_eq!(json(&pushed)["operation"], "force_push_with_lease");
    assert_eq!(
        git_stdout(&remote, &["rev-parse", "refs/heads/main"])
            .trim()
            .to_string(),
        local_head
    );
    assert_eq!(
        git_stdout(&local, &["diff", "--cached", "--binary"]),
        index_before
    );
}

#[tokio::test]
async fn force_push_rejects_a_remote_tip_that_changed_after_preview() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    let other = root.path().join("other");
    std::fs::create_dir(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&local, &["push", "-u", "origin", "main"]);
    git(
        root.path(),
        &[
            "clone",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["config", "user.name", "CodePro Other"]);
    git(&other, &["config", "user.email", "other@example.invalid"]);

    std::fs::write(local.join("local-only.txt"), "local\n").unwrap();
    git(&local, &["add", "local-only.txt"]);
    git(&local, &["commit", "-m", "local only"]);
    std::fs::write(other.join("remote-first.txt"), "first\n").unwrap();
    git(&other, &["add", "remote-first.txt"]);
    git(&other, &["commit", "-m", "remote first"]);
    git(&other, &["push", "origin", "main"]);
    git(&local, &["fetch", "origin"]);

    let client = GitClient::new(context(&local)).unwrap();
    let ctx = ToolCallContext::new("force-stale-lease".to_string(), Some(local.clone()), None);
    let preview = client
        .call_tool(
            &ctx,
            "git_force_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(preview.is_error, Some(false), "{}", text(&preview));
    let preview = json(&preview);
    let preflight_id = preview["preflight_id"].as_str().unwrap().to_string();
    let index_before = git_stdout(&local, &["diff", "--cached", "--binary"]);

    std::fs::write(other.join("remote-second.txt"), "second\n").unwrap();
    git(&other, &["add", "remote-second.txt"]);
    git(&other, &["commit", "-m", "remote second"]);
    git(&other, &["push", "origin", "main"]);
    let advanced_remote_oid = git_stdout(&remote, &["rev-parse", "refs/heads/main"])
        .trim()
        .to_string();

    let rejected = client
        .call_tool(
            &ctx,
            "git_force_push",
            Some(force_push_arguments(&preview, &preflight_id)),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(rejected.is_error, Some(true));
    assert_eq!(
        git_stdout(&remote, &["rev-parse", "refs/heads/main"])
            .trim()
            .to_string(),
        advanced_remote_oid
    );
    assert_eq!(
        git_stdout(&local, &["diff", "--cached", "--binary"]),
        index_before
    );
}

#[tokio::test]
async fn force_push_blocks_missing_tracking_and_sensitive_paths_before_remote_write() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    std::fs::write(local.join(".env"), "SECRET=test-only\n").unwrap();
    git(&local, &["add", ".env"]);
    git(&local, &["commit", "-m", "sensitive fixture"]);

    let client = GitClient::new(context(&local)).unwrap();
    let ctx = ToolCallContext::new(
        "force-blocked-preflight".to_string(),
        Some(local.clone()),
        None,
    );
    let preview = client
        .call_tool(
            &ctx,
            "git_force_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(preview.is_error, Some(false), "{}", text(&preview));
    let preview = json(&preview);
    assert_eq!(preview["expected_remote_oid"], "");
    assert_eq!(preview["sensitive_paths"], json!([".env"]));
    let blocked_reasons = preview["blocked_reasons"].as_array().unwrap();
    assert!(blocked_reasons
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("敏感路径")));
    assert!(blocked_reasons
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("远端跟踪分支")));

    let rejected = client
        .call_tool(
            &ctx,
            "git_force_push",
            Some(force_push_arguments(
                &preview,
                preview["preflight_id"].as_str().unwrap(),
            )),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(rejected.is_error, Some(true));
    assert!(text(&rejected).contains("已阻止"));
    assert!(!git_succeeds(
        &remote,
        &["show-ref", "--verify", "refs/heads/main"]
    ));
}

#[tokio::test]
async fn force_push_preview_blocks_non_divergent_mismatched_and_detached_states() {
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let local = root.path().join("local");
    std::fs::create_dir(&local).unwrap();
    git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
    initialized_repository(&local);
    git(
        &local,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&local, &["push", "-u", "origin", "main"]);

    let client = GitClient::new(context(&local)).unwrap();
    let ctx = ToolCallContext::new(
        "force-blocked-states".to_string(),
        Some(local.clone()),
        None,
    );
    let non_divergent = client
        .call_tool(
            &ctx,
            "git_force_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        non_divergent.is_error,
        Some(false),
        "{}",
        text(&non_divergent)
    );
    assert!(json(&non_divergent)["blocked_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("普通 git_push")));

    let mismatched = client
        .call_tool(
            &ctx,
            "git_force_push_preview",
            Some(object!({"remote": "origin", "branch": "release"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(mismatched.is_error, Some(false), "{}", text(&mismatched));
    assert!(json(&mismatched)["blocked_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("不是当前分支")));

    git(&local, &["checkout", "--detach"]);
    let detached = client
        .call_tool(
            &ctx,
            "git_force_push_preview",
            Some(object!({"remote": "origin", "branch": "main"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(detached.is_error, Some(false), "{}", text(&detached));
    assert!(json(&detached)["blocked_reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("detached HEAD")));
}

#[tokio::test]
async fn clone_preview_is_local_only_and_reports_existing_targets() {
    let root = tempdir().unwrap();
    let local_source = root.path().join("source.git");
    git(
        root.path(),
        &["init", "--bare", local_source.to_str().unwrap()],
    );
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new(
        "clone-preview".to_string(),
        Some(root.path().to_path_buf()),
        None,
    );

    let local = client
        .call_tool(
            &ctx,
            "git_clone_preview",
            Some(object!({
                "source": "source.git",
                "destination": "local-clone",
                "branch": "main"
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(local.is_error, Some(false), "{}", text(&local));
    let local = json(&local);
    assert_eq!(local["source"], "source.git");
    assert_eq!(local["source_kind"], "workspace_local");
    assert_eq!(local["destination"], "local-clone");
    assert_eq!(local["branch"], "main");
    assert_eq!(local["network_checked"], false);
    assert_eq!(local["preflight_id"].as_str().unwrap().len(), 64);

    let github = client
        .call_tool(
            &ctx,
            "git_clone_preview",
            Some(object!({
                "source": "https://github.com/codepro/nonexistent-preview-repo.git",
                "destination": "public-clone"
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(github.is_error, Some(false), "{}", text(&github));
    let github = json(&github);
    assert_eq!(github["source_kind"], "github_https");
    assert_eq!(github["network_checked"], false);

    std::fs::create_dir(root.path().join("existing")).unwrap();
    let existing = client
        .call_tool(
            &ctx,
            "git_clone_preview",
            Some(object!({
                "source": "source.git",
                "destination": "existing"
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(existing.is_error, Some(false), "{}", text(&existing));
    assert!(json(&existing)["blocked_reasons"][0]
        .as_str()
        .unwrap()
        .contains("已存在"));
}

#[tokio::test]
async fn clone_preview_rejects_outside_local_sources_without_leaking_credentials() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    initialized_repository(outside.path());
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new(
        "clone-rejections".to_string(),
        Some(root.path().to_path_buf()),
        None,
    );

    for source in [
        outside.path().to_string_lossy().to_string(),
        "https://automation:secret-token@github.com/acme/repo.git".to_string(),
        "https://gitlab.com/acme/repo.git".to_string(),
    ] {
        let result = client
            .call_tool(
                &ctx,
                "git_clone_preview",
                Some(object!({"source": source, "destination": "clone"})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true), "{}", text(&result));
        assert!(!text(&result).contains("secret-token"));
        assert!(!text(&result).contains("未知 Git 工具"));
    }
}

#[tokio::test]
async fn clone_requires_a_matching_fresh_preflight() {
    let root = tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    initialized_repository(&source);
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new(
        "clone-preflight".to_string(),
        Some(root.path().to_path_buf()),
        None,
    );

    let missing = client
        .call_tool(
            &ctx,
            "git_clone",
            Some(object!({"source": "source", "destination": "missing-id"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(missing.is_error, Some(true));
    assert!(text(&missing).contains("预检"));
    assert!(!root.path().join("missing-id").exists());

    let preview = client
        .call_tool(
            &ctx,
            "git_clone_preview",
            Some(object!({"source": "source", "destination": "stale-target"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();
    let incorrect = client
        .call_tool(
            &ctx,
            "git_clone",
            Some(object!({
                "source": "source",
                "destination": "stale-target",
                "preflight_id": "0000000000000000000000000000000000000000000000000000000000000000"
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(incorrect.is_error, Some(true));
    assert!(text(&incorrect).contains("预检已过期"));

    std::fs::create_dir(root.path().join("stale-target")).unwrap();
    std::fs::write(root.path().join("stale-target/keep.txt"), "keep\n").unwrap();
    let stale = client
        .call_tool(
            &ctx,
            "git_clone",
            Some(object!({
                "source": "source",
                "destination": "stale-target",
                "preflight_id": preflight_id
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stale.is_error, Some(true));
    assert!(text(&stale).contains("目标目录已存在"));
    assert_eq!(
        std::fs::read_to_string(root.path().join("stale-target/keep.txt")).unwrap(),
        "keep\n"
    );
}

#[tokio::test]
async fn clones_a_local_repository_atomically_without_touching_the_source_index() {
    let root = tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    initialized_repository(&source);
    std::fs::write(source.join("unstaged.txt"), "source-only\n").unwrap();
    let index_before = git_stdout(&source, &["diff", "--cached", "--binary"]);
    let source_head = git_stdout(&source, &["rev-parse", "HEAD"]);
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new(
        "clone-success".to_string(),
        Some(root.path().to_path_buf()),
        None,
    );

    let preview = client
        .call_tool(
            &ctx,
            "git_clone_preview",
            Some(object!({
                "source": "source",
                "destination": "cloned",
                "branch": "main"
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();
    let cloned = client
        .call_tool(
            &ctx,
            "git_clone",
            Some(object!({
                "source": "source",
                "destination": "cloned",
                "branch": "main",
                "preflight_id": preflight_id
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(cloned.is_error, Some(false), "{}", text(&cloned));
    assert_eq!(json(&cloned)["status"], "completed");
    assert_eq!(json(&cloned)["destination"], "cloned");
    assert_eq!(
        git_stdout(&root.path().join("cloned"), &["rev-parse", "HEAD"]),
        source_head
    );
    assert_eq!(
        git_stdout(&source, &["diff", "--cached", "--binary"]),
        index_before
    );
    assert!(!git_succeeds(
        &root.path().join("cloned"),
        &["config", "--local", "--get", "core.hooksPath"]
    ));
    assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".codepro-clone-")
    }));
}

#[tokio::test]
async fn clone_failure_removes_the_unique_temporary_directory() {
    let root = tempdir().unwrap();
    let source = root.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    initialized_repository(&source);
    let client = GitClient::new(context(root.path())).unwrap();
    let ctx = ToolCallContext::new(
        "clone-cleanup".to_string(),
        Some(root.path().to_path_buf()),
        None,
    );

    let preview = client
        .call_tool(
            &ctx,
            "git_clone_preview",
            Some(object!({
                "source": "source",
                "destination": "failed-clone",
                "branch": "missing-branch"
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let preflight_id = json(&preview)["preflight_id"].as_str().unwrap().to_string();
    let failed = client
        .call_tool(
            &ctx,
            "git_clone",
            Some(object!({
                "source": "source",
                "destination": "failed-clone",
                "branch": "missing-branch",
                "preflight_id": preflight_id
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(failed.is_error, Some(true));
    assert!(!text(&failed).contains("未知 Git 工具"));
    assert!(!root.path().join("failed-clone").exists());
    assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".codepro-clone-")
    }));
}
