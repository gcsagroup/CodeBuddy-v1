use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::platform_extensions::tool_registry::codepro_tool_spec;
use crate::agents::tool_execution::ToolCallContext;
use anyhow::Result;
use async_trait::async_trait;
use once_cell::sync::Lazy;
use regex::Regex;
use rmcp::model::{
    CallToolResult, Content, Implementation, InitializeResult, JsonObject, ListToolsResult,
    RawContent, ServerCapabilities, Tool,
};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use url::Url;

pub static EXTENSION_NAME: &str = "git";
const MAX_GIT_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_GIT_PROCESS_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_LOG_COMMITS: usize = 100;
const MAX_PATHS: usize = 256;
const MAX_STATUS_ENTRIES: usize = 2000;
const MAX_CONFLICT_ENTRIES: usize = 500;
const MAX_BRANCHES: usize = 1000;
const MAX_PUSH_PREVIEW_COMMITS: usize = 20;
const MAX_SENSITIVE_PATHS: usize = 32;
const GIT_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const GITHUB_RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_REPOSITORY_REMOVED_ENVIRONMENT: &[&str] = &[
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_SHALLOW_FILE",
    "GIT_REPLACE_REF_BASE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];
const CLONE_REMOVED_ENVIRONMENT: &[&str] = &[
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_PROXY_COMMAND",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];
static GIT_URL_CREDENTIALS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+(?::[^\s/@]*)?@")
        .expect("Git credential redaction regex must compile")
});

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

#[derive(Debug, Serialize)]
struct GitRuntimeStatusResult {
    available: bool,
    version: Option<String>,
    install_url: &'static str,
}

#[derive(Debug, Serialize)]
struct GitHubRuntimeStatusResult {
    available: bool,
    authenticated: bool,
    version: Option<String>,
    hostname: &'static str,
    install_url: &'static str,
    login_command: &'static str,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum DiffScope {
    WorkingTree,
    Staged,
    Base,
}

impl DiffScope {
    fn as_str(&self) -> &'static str {
        match self {
            Self::WorkingTree => "working_tree",
            Self::Staged => "staged",
            Self::Base => "base",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DiffParams {
    scope: DiffScope,
    base: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LogParams {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct InitParams {
    initial_branch: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StageParams {
    paths: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RestorePreviewParams {
    paths: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RestoreParams {
    paths: Vec<String>,
    preflight_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum ConflictOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl ConflictOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry_pick",
            Self::Revert => "revert",
        }
    }

    fn git_subcommand(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ConflictContinueParams {
    operation: ConflictOperation,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ConflictAbortParams {
    operation: ConflictOperation,
    preflight_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BranchParams {
    name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CommitParams {
    message: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RemoteParams {
    remote: Option<String>,
    branch: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PushPreviewParams {
    remote: Option<String>,
    branch: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct PushParams {
    remote: Option<String>,
    branch: Option<String>,
    preflight_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ForcePushParams {
    remote: String,
    branch: String,
    head: String,
    expected_remote_oid: String,
    local_only_commit_count: usize,
    remote_only_commit_count: usize,
    preflight_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ClonePreviewParams {
    source: String,
    destination: String,
    branch: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CloneParams {
    source: String,
    destination: String,
    branch: Option<String>,
    preflight_id: String,
}

#[derive(Debug, Serialize)]
struct GitStatusResult {
    repository_root: String,
    branch: String,
    detached: bool,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    truncated: bool,
    entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Serialize)]
struct GitRepositorySnapshotResult {
    status: serde_json::Value,
    conflicts: serde_json::Value,
    branches: serde_json::Value,
    diff: serde_json::Value,
    staged_diff: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct GitStatusEntry {
    path: String,
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
}

#[derive(Debug, Serialize)]
struct GitConflictsResult {
    has_conflicts: bool,
    operation: String,
    total_conflicts: usize,
    truncated: bool,
    conflicts: Vec<GitConflictEntry>,
}

#[derive(Debug, Serialize)]
struct GitConflictAbortPreviewData {
    operation: String,
    head: String,
    changed_paths: Vec<String>,
    conflicted_paths: Vec<String>,
    working_diff: String,
    working_diff_truncated: bool,
    staged_diff: String,
    staged_diff_truncated: bool,
    blocked_reasons: Vec<String>,
    #[serde(skip_serializing)]
    workspace_binding: String,
    #[serde(skip_serializing)]
    state_digest: String,
}

#[derive(Debug, Serialize)]
struct GitConflictAbortPreviewResult {
    #[serde(flatten)]
    data: GitConflictAbortPreviewData,
    preflight_id: String,
}

#[derive(Debug, Serialize)]
struct GitConflictActionResult {
    operation: &'static str,
    status: &'static str,
    head: String,
}

#[derive(Debug, Serialize)]
struct GitConflictEntry {
    path: String,
    code: String,
    kind: String,
    stages: Vec<u8>,
}

struct ParsedConflicts {
    total_conflicts: usize,
    truncated: bool,
    conflicts: Vec<GitConflictEntry>,
}

#[derive(Debug, Serialize)]
struct GitDiffResult {
    scope: &'static str,
    text: String,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct GitLogResult {
    commits: Vec<GitCommit>,
}

#[derive(Debug, Serialize)]
struct GitCommit {
    id: String,
    author_name: String,
    author_email: String,
    authored_at: String,
    subject: String,
}

#[derive(Debug, Serialize)]
struct GitBranchesResult {
    truncated: bool,
    branches: Vec<GitBranch>,
}

#[derive(Debug, Serialize)]
struct GitInitResult {
    repository_root: String,
    branch: String,
}

#[derive(Debug, Serialize)]
struct GitStageResult {
    staged_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
struct GitUnstageResult {
    unstaged_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
struct GitRestorePreviewData {
    paths: Vec<String>,
    changed_paths: Vec<String>,
    diff: String,
    diff_truncated: bool,
    blocked_reasons: Vec<String>,
    #[serde(skip_serializing)]
    workspace_binding: String,
    #[serde(skip_serializing)]
    cwd_binding: String,
    #[serde(skip_serializing)]
    resolved_paths: Vec<String>,
    #[serde(skip_serializing)]
    state_digest: String,
}

#[derive(Debug, Serialize)]
struct GitRestorePreviewResult {
    #[serde(flatten)]
    data: GitRestorePreviewData,
    preflight_id: String,
}

#[derive(Debug, Serialize)]
struct GitRestoreResult {
    restored_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
struct GitBranchMutationResult {
    branch: String,
    created: bool,
}

#[derive(Debug, Serialize)]
struct GitCommitResult {
    commit: String,
    branch: String,
    subject: String,
    committed_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
struct GitRemoteResult {
    operation: &'static str,
    remote: String,
    branch: String,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct GitCloneResult {
    source: String,
    destination: String,
    branch: Option<String>,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct GitPushCommit {
    id: String,
    subject: String,
}

#[derive(Debug, Serialize)]
struct GitPushPreviewData {
    remote: String,
    remote_destination: String,
    branch: String,
    head: String,
    outgoing_commit_count: usize,
    outgoing_commits: Vec<GitPushCommit>,
    changed_paths: Vec<String>,
    paths_truncated: bool,
    sensitive_paths: Vec<String>,
    blocked_reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
struct GitPushPreviewResult {
    #[serde(flatten)]
    data: GitPushPreviewData,
    preflight_id: String,
}

#[derive(Debug, Serialize)]
struct GitForcePushPreviewData {
    remote: String,
    remote_destination: String,
    branch: String,
    head: String,
    expected_remote_oid: String,
    local_only_commit_count: usize,
    remote_only_commit_count: usize,
    local_only_commits: Vec<GitPushCommit>,
    remote_only_commits: Vec<GitPushCommit>,
    changed_paths: Vec<String>,
    paths_truncated: bool,
    sensitive_paths: Vec<String>,
    blocked_reasons: Vec<String>,
    #[serde(skip_serializing)]
    workspace_binding: String,
}

#[derive(Debug, Serialize)]
struct GitForcePushPreviewResult {
    #[serde(flatten)]
    data: GitForcePushPreviewData,
    preflight_id: String,
}

#[derive(Debug, Serialize)]
struct GitClonePreviewData {
    source: String,
    source_kind: &'static str,
    destination: String,
    branch: Option<String>,
    network_checked: bool,
    blocked_reasons: Vec<String>,
    #[serde(skip_serializing)]
    workspace_binding: String,
}

#[derive(Debug, Serialize)]
struct GitClonePreviewResult {
    #[serde(flatten)]
    data: GitClonePreviewData,
    preflight_id: String,
}

#[derive(Debug, Serialize)]
struct GitBranch {
    name: String,
    current: bool,
    remote: bool,
    upstream: Option<String>,
    commit: String,
}

pub struct GitClient {
    info: InitializeResult,
}

impl GitClient {
    pub fn new(_context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME, "1.0.0").with_title("CodePro Git"),
            )
            .with_instructions(
                "Use the structured Git tools instead of composing Git shell commands. Read the status and diff before changing the index or remote. Force push is restricted to an exact git_force_push_preview, force-with-lease, and fresh user confirmation; general history rewriting, arbitrary refspecs, remote URLs, and global configuration are not supported."
                    .to_string(),
            );
        Ok(Self { info })
    }

    fn tools() -> Vec<Tool> {
        vec![
            read_only_tool::<EmptyParams>(
                "git_runtime_status",
                "Detect whether the local Git executable is available and report its version and official installation page.",
            ),
            read_only_open_world_tool::<EmptyParams>(
                "github_runtime_status",
                "Detect whether GitHub CLI is available and authenticated for github.com without exposing credentials.",
            ),
            read_only_tool::<EmptyParams>(
                "git_repository_snapshot",
                "Read status, conflicts, branches, and working and staged diffs in one repository snapshot.",
            ),
            read_only_tool::<EmptyParams>("git_status", "Read structured repository status."),
            read_only_tool::<EmptyParams>(
                "git_conflicts",
                "Read structured unmerged paths and the current conflict operation without file contents.",
            ),
            read_only_tool::<DiffParams>(
                "git_diff",
                "Read a bounded working tree, staged, or base diff.",
            ),
            read_only_tool::<LogParams>("git_log", "Read a bounded commit history."),
            read_only_tool::<EmptyParams>("git_branches", "Read local and remote branches."),
            read_only_tool::<PushPreviewParams>(
                "git_push_preview",
                "Preview the exact current branch, remote target, commits, paths, and safety blocks before pushing.",
            ),
            read_only_tool::<PushPreviewParams>(
                "git_force_push_preview",
                "Preview a lease-bound overwrite of the current remote branch without writing to the remote.",
            ),
            read_only_tool::<ClonePreviewParams>(
                "git_clone_preview",
                "Preview a restricted clone target without accessing the network.",
            ),
            read_only_tool::<RestorePreviewParams>(
                "git_restore_preview",
                "Preview exact working-tree paths and bind their full diff to a hashed restore preflight.",
            ),
            read_only_tool::<EmptyParams>(
                "git_conflict_abort_preview",
                "Preview the current merge, rebase, cherry-pick, or revert state and bind its complete repository evidence to a hashed abort preflight.",
            ),
            write_tool::<InitParams>(
                "git_init",
                "Initialize the current directory as a Git repository.",
                false,
            ),
            write_tool::<StageParams>(
                "git_stage",
                "Stage only the explicit repository-relative paths.",
                false,
            ),
            write_tool::<StageParams>(
                "git_unstage",
                "Unstage only the explicit repository-relative paths without changing working tree content.",
                false,
            ),
            write_tool::<RestoreParams>(
                "git_restore",
                "Discard working-tree changes only for exact paths after a matching hashed preview.",
                false,
            ),
            write_tool::<BranchParams>(
                "git_branch_create",
                "Create and switch to a validated local branch from the current HEAD.",
                false,
            ),
            write_tool::<BranchParams>(
                "git_branch_switch",
                "Switch to an existing validated local branch without remote guessing.",
                false,
            ),
            write_tool::<CommitParams>(
                "git_commit",
                "Commit the current staged changes without changing Git identity.",
                false,
            ),
            write_tool::<ConflictContinueParams>(
                "git_conflict_continue",
                "Continue the exact merge, rebase, cherry-pick, or revert operation only after every conflict is resolved and staged.",
                false,
            ),
            write_tool::<ConflictAbortParams>(
                "git_conflict_abort",
                "Abort the exact merge, rebase, cherry-pick, or revert state bound by a fresh hashed preview.",
                false,
            ),
            write_tool::<RemoteParams>(
                "git_fetch",
                "Fetch one configured remote without accepting a URL.",
                true,
            ),
            write_tool::<RemoteParams>(
                "git_pull",
                "Fast-forward the current branch from one configured remote.",
                true,
            ),
            write_tool::<PushParams>(
                "git_push",
                "Push the current branch after a matching git_push_preview without force.",
                true,
            ),
            write_tool::<CloneParams>(
                "git_clone",
                "Clone an approved source into a new workspace child after a matching preview.",
                true,
            ),
            write_tool::<ForcePushParams>(
                "git_force_push",
                "Overwrite the current remote branch only with an exact force-with-lease preflight and fresh user confirmation.",
                true,
            ),
        ]
    }

    async fn repository_snapshot(
        &self,
        ctx: &ToolCallContext,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let (status, conflicts, branches, diff, staged_diff) = tokio::try_join!(
            self.status(ctx, cancel.clone()),
            self.conflicts(ctx, cancel.clone()),
            self.branches(ctx, cancel.clone()),
            self.diff(ctx, Some(diff_arguments("working_tree")), cancel.clone()),
            self.diff(ctx, Some(diff_arguments("staged")), cancel),
        )?;
        success_json(&GitRepositorySnapshotResult {
            status: result_json(&status)?,
            conflicts: result_json(&conflicts)?,
            branches: result_json(&branches)?,
            diff: result_json(&diff)?,
            staged_diff: result_json(&staged_diff)?,
        })
    }

    async fn status(
        &self,
        ctx: &ToolCallContext,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let cwd = working_directory(ctx)?;
        let root = repository_root(&cwd, cancel.clone()).await?;
        let branch_output = run_git(
            &cwd,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            cancel.clone(),
        )
        .await;
        let (branch, detached) = match branch_output {
            Ok(output) => (output.stdout.trim().to_string(), false),
            Err(_) => {
                let output =
                    run_git(&cwd, &["rev-parse", "--short", "HEAD"], cancel.clone()).await?;
                (output.stdout.trim().to_string(), true)
            }
        };
        let upstream = run_git(
            &cwd,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
            cancel.clone(),
        )
        .await
        .ok()
        .map(|output| output.stdout.trim().to_string())
        .filter(|value| !value.is_empty());
        let (ahead, behind) = if upstream.is_some() {
            let output = run_git(
                &cwd,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                cancel.clone(),
            )
            .await?;
            let mut counts = output.stdout.split_whitespace();
            (
                counts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
                counts
                    .next()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0),
            )
        } else {
            (0, 0)
        };
        let output = run_git(
            &cwd,
            &[
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
            cancel,
        )
        .await?;
        let mut entries = parse_status_entries(output.stdout.as_bytes());
        let truncated = entries.len() > MAX_STATUS_ENTRIES;
        entries.truncate(MAX_STATUS_ENTRIES);
        success_json(&GitStatusResult {
            repository_root: root,
            branch,
            detached,
            upstream,
            ahead,
            behind,
            truncated,
            entries,
        })
    }

    async fn conflicts(
        &self,
        ctx: &ToolCallContext,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let (parsed, operation) = read_conflict_state(&cwd, cancel).await?;
        let has_conflicts = parsed.total_conflicts > 0;
        success_json(&GitConflictsResult {
            has_conflicts,
            operation,
            total_conflicts: parsed.total_conflicts,
            truncated: parsed.truncated,
            conflicts: parsed.conflicts,
        })
    }

    async fn diff(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: DiffParams = parse_arguments(arguments)?;
        validate_paths(&params.paths)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let mut owned = vec![
            "-c".to_string(),
            "core.quotepath=false".to_string(),
            "diff".to_string(),
            "--no-ext-diff".to_string(),
        ];
        match params.scope {
            DiffScope::WorkingTree => {
                if params.base.is_some() {
                    return Err("working_tree 范围不允许 base".to_string());
                }
            }
            DiffScope::Staged => {
                if params.base.is_some() {
                    return Err("staged 范围不允许 base".to_string());
                }
                owned.push("--cached".to_string());
            }
            DiffScope::Base => {
                let base = params
                    .base
                    .as_deref()
                    .ok_or_else(|| "base 范围必须提供有效 base".to_string())?;
                validate_ref(base)?;
                owned.push(base.to_string());
            }
        }
        if !params.paths.is_empty() {
            owned.push("--".to_string());
            owned.extend(params.paths.iter().cloned());
        }
        let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
        let output = run_git(&cwd, &refs, cancel).await?;
        let (text, truncated) = truncate_utf8(&output.stdout, MAX_GIT_OUTPUT_BYTES);
        success_json(&GitDiffResult {
            scope: params.scope.as_str(),
            text,
            truncated,
        })
    }

    async fn log(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: LogParams = parse_arguments(arguments)?;
        let limit = params.limit.unwrap_or(20);
        if !(1..=MAX_LOG_COMMITS).contains(&limit) {
            return Err(format!("limit 必须在 1 到 {MAX_LOG_COMMITS} 之间"));
        }
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let limit = format!("--max-count={limit}");
        let output = run_git(
            &cwd,
            &[
                "log",
                &limit,
                "--date=iso-strict",
                "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
            ],
            cancel,
        )
        .await?;
        let commits = output
            .stdout
            .split('\u{1e}')
            .filter_map(|record| {
                let fields = record.trim().split('\u{1f}').collect::<Vec<_>>();
                (fields.len() == 5).then(|| GitCommit {
                    id: fields[0].to_string(),
                    author_name: fields[1].to_string(),
                    author_email: fields[2].to_string(),
                    authored_at: fields[3].to_string(),
                    subject: fields[4].to_string(),
                })
            })
            .collect();
        success_json(&GitLogResult { commits })
    }

    async fn branches(
        &self,
        ctx: &ToolCallContext,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let output = run_git(
            &cwd,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00",
                "refs/heads",
                "refs/remotes",
            ],
            cancel,
        )
        .await?;
        let fields = output.stdout.split('\0').collect::<Vec<_>>();
        let mut branches = Vec::new();
        for values in fields.chunks(4) {
            if values.len() != 4 || values[0].trim().is_empty() {
                continue;
            }
            let reference = values[0].trim();
            let remote = reference.starts_with("refs/remotes/");
            let name = reference
                .strip_prefix("refs/heads/")
                .or_else(|| reference.strip_prefix("refs/remotes/"))
                .unwrap_or(reference)
                .to_string();
            branches.push(GitBranch {
                name,
                current: values[1].trim() == "*",
                remote,
                upstream: (!values[2].trim().is_empty()).then(|| values[2].trim().to_string()),
                commit: values[3].trim().to_string(),
            });
        }
        let truncated = branches.len() > MAX_BRANCHES;
        branches.truncate(MAX_BRANCHES);
        success_json(&GitBranchesResult {
            truncated,
            branches,
        })
    }

    async fn init(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: InitParams = parse_arguments(arguments)?;
        let branch = params.initial_branch.unwrap_or_else(|| "main".to_string());
        validate_ref(&branch)?;
        let cwd = working_directory(ctx)?;
        let initial_branch = format!("--initial-branch={branch}");
        run_git(&cwd, &["init", &initial_branch], cancel.clone()).await?;
        let root = repository_root(&cwd, cancel).await?;
        success_json(&GitInitResult {
            repository_root: root,
            branch,
        })
    }

    async fn stage(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: StageParams = parse_arguments(arguments)?;
        if params.paths.is_empty() {
            return Err("git_stage 必须提供至少一个显式路径".to_string());
        }
        validate_paths(&params.paths)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let mut owned = vec!["add".to_string(), "--".to_string()];
        owned.extend(params.paths.iter().cloned());
        let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
        run_git(&cwd, &refs, cancel).await?;
        success_json(&GitStageResult {
            staged_paths: params.paths,
        })
    }

    async fn unstage(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: StageParams = parse_arguments(arguments)?;
        if params.paths.is_empty() {
            return Err("git_unstage 必须提供至少一个显式路径".to_string());
        }
        validate_paths(&params.paths)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        run_git(&cwd, &["rev-parse", "--verify", "HEAD"], cancel.clone())
            .await
            .map_err(|_| "当前仓库没有可用于取消暂存的提交".to_string())?;
        let mut owned = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--".to_string(),
        ];
        owned.extend(params.paths.iter().cloned());
        let refs = owned.iter().map(String::as_str).collect::<Vec<_>>();
        run_git(&cwd, &refs, cancel).await?;
        success_json(&GitUnstageResult {
            unstaged_paths: params.paths,
        })
    }

    async fn restore_preview(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: RestorePreviewParams = parse_arguments(arguments)?;
        let cwd = working_directory(ctx)?;
        let data = prepare_restore(&cwd, params.paths, cancel).await?;
        let preflight_id = restore_preflight_id(&data)?;
        success_json(&GitRestorePreviewResult { data, preflight_id })
    }

    async fn restore(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let has_preflight_id = arguments
            .as_ref()
            .and_then(|arguments| arguments.get("preflight_id"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        if !has_preflight_id {
            return Err(
                "还原工作区前必须先运行 git_restore_preview，并传入返回的 preflight_id".to_string(),
            );
        }
        let params: RestoreParams = parse_arguments(arguments)?;
        if !is_valid_preflight_id(&params.preflight_id) {
            return Err("无效的 Git 还原 preflight_id；请重新运行 git_restore_preview".to_string());
        }
        let cwd = working_directory(ctx)?;
        let data = prepare_restore(&cwd, params.paths, cancel.clone()).await?;
        if !data.blocked_reasons.is_empty() {
            return Err(format!(
                "Git 还原已阻止：{}",
                data.blocked_reasons.join("；")
            ));
        }
        let expected_preflight_id = restore_preflight_id(&data)?;
        if params.preflight_id != expected_preflight_id {
            return Err("Git 还原预检已过期；工作区内容已变化，请重新预览".to_string());
        }
        let mut arguments = vec![
            "--literal-pathspecs".to_string(),
            "restore".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        arguments.extend(data.resolved_paths.iter().cloned());
        let argument_refs = arguments.iter().map(String::as_str).collect::<Vec<_>>();
        run_git(Path::new(&data.workspace_binding), &argument_refs, cancel).await?;
        success_json(&GitRestoreResult {
            restored_paths: data.changed_paths,
        })
    }

    async fn conflict_abort_preview(
        &self,
        ctx: &ToolCallContext,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let cwd = working_directory(ctx)?;
        let data = prepare_conflict_abort(&cwd, cancel).await?;
        let preflight_id = conflict_abort_preflight_id(&data)?;
        success_json(&GitConflictAbortPreviewResult { data, preflight_id })
    }

    async fn conflict_continue(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: ConflictContinueParams = parse_arguments(arguments)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let (conflicts, active_operation) = read_conflict_state(&cwd, cancel.clone()).await?;
        let requested_operation = params.operation.as_str();
        if active_operation != requested_operation {
            return Err(format!(
                "当前没有可继续的 {requested_operation}；检测到的操作是 {active_operation}"
            ));
        }
        if conflicts.total_conflicts > 0 {
            return Err(format!(
                "仍有 {} 个未解决冲突；请先编辑并暂存所有冲突路径",
                conflicts.total_conflicts
            ));
        }
        run_git_with_env(
            &cwd,
            &[params.operation.git_subcommand(), "--continue"],
            &[
                ("GIT_EDITOR", "true"),
                ("GIT_SEQUENCE_EDITOR", "true"),
                ("GIT_MERGE_AUTOEDIT", "no"),
            ],
            &[],
            cancel.clone(),
        )
        .await?;
        let head = run_git(&cwd, &["rev-parse", "HEAD"], cancel)
            .await?
            .stdout
            .trim()
            .to_string();
        success_json(&GitConflictActionResult {
            operation: requested_operation,
            status: "completed",
            head,
        })
    }

    async fn conflict_abort(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: ConflictAbortParams = parse_arguments(arguments)?;
        if !is_valid_preflight_id(&params.preflight_id) {
            return Err(
                "无效的 Git 冲突中止 preflight_id；请重新运行 git_conflict_abort_preview"
                    .to_string(),
            );
        }
        let cwd = working_directory(ctx)?;
        let data = prepare_conflict_abort(&cwd, cancel.clone()).await?;
        let requested_operation = params.operation.as_str();
        if data.operation != requested_operation {
            return Err(format!(
                "当前冲突操作已变化；预期 {requested_operation}，实际 {}",
                data.operation
            ));
        }
        if !data.blocked_reasons.is_empty() {
            return Err(format!(
                "Git 冲突中止已阻止：{}",
                data.blocked_reasons.join("；")
            ));
        }
        let expected_preflight_id = conflict_abort_preflight_id(&data)?;
        if params.preflight_id != expected_preflight_id {
            return Err("Git 冲突中止预检已过期；仓库状态已变化，请重新预览".to_string());
        }
        run_git(
            &cwd,
            &[params.operation.git_subcommand(), "--abort"],
            cancel.clone(),
        )
        .await?;
        let head = run_git(&cwd, &["rev-parse", "HEAD"], cancel)
            .await?
            .stdout
            .trim()
            .to_string();
        success_json(&GitConflictActionResult {
            operation: requested_operation,
            status: "aborted",
            head,
        })
    }

    async fn mutate_branch(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
        create: bool,
    ) -> std::result::Result<CallToolResult, String> {
        let params: BranchParams = parse_arguments(arguments)?;
        validate_ref(&params.name)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        run_git(
            &cwd,
            &["check-ref-format", "--branch", &params.name],
            cancel.clone(),
        )
        .await
        .map_err(|_| "无效的 Git 分支名称".to_string())?;
        if !create {
            let local_ref = format!("refs/heads/{}", params.name);
            run_git(
                &cwd,
                &["show-ref", "--verify", "--quiet", &local_ref],
                cancel.clone(),
            )
            .await
            .map_err(|_| format!("本地分支 {} 不存在", params.name))?;
        }
        let arguments = if create {
            vec!["switch", "-c", params.name.as_str()]
        } else {
            vec!["switch", "--", params.name.as_str()]
        };
        run_git(&cwd, &arguments, cancel.clone()).await?;
        let branch = current_branch(&cwd, cancel).await?;
        success_json(&GitBranchMutationResult {
            branch,
            created: create,
        })
    }

    async fn commit(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: CommitParams = parse_arguments(arguments)?;
        let message = params.message.trim();
        if message.is_empty() || message.chars().count() > 4096 || message.contains('\0') {
            return Err("提交消息必须为 1 到 4096 个字符且不能包含 NUL".to_string());
        }
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let current_branch = current_branch(&cwd, cancel.clone()).await?;
        let staged = run_git(
            &cwd,
            &[
                "-c",
                "core.quotepath=false",
                "diff",
                "--cached",
                "--name-only",
                "-z",
            ],
            cancel.clone(),
        )
        .await?;
        let committed_paths = staged
            .stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if committed_paths.is_empty() {
            return Err("当前暂存区没有可提交的变更".to_string());
        }
        run_git(&cwd, &["commit", "-m", message], cancel.clone()).await?;
        let details = run_git(
            &cwd,
            &["show", "-s", "--format=%H%x1f%D%x1f%s", "HEAD"],
            cancel,
        )
        .await?;
        let fields = details.stdout.trim().split('\u{1f}').collect::<Vec<_>>();
        if fields.len() != 3 {
            return Err("无法读取新提交摘要".to_string());
        }
        success_json(&GitCommitResult {
            commit: fields[0].to_string(),
            branch: current_branch,
            subject: fields[2].to_string(),
            committed_paths,
        })
    }

    async fn remote_operation(
        &self,
        ctx: &ToolCallContext,
        name: &'static str,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: RemoteParams = parse_arguments(arguments)?;
        let remote = params.remote.unwrap_or_else(|| "origin".to_string());
        validate_remote(&remote)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        require_configured_remote(&cwd, &remote, cancel.clone()).await?;
        let checked_out_branch = if name == "pull" {
            Some(current_branch(&cwd, cancel.clone()).await?)
        } else {
            None
        };
        let branch = match params.branch {
            Some(branch) => {
                validate_ref(&branch)?;
                if let Some(current) = checked_out_branch.as_deref() {
                    if branch != current {
                        return Err(format!(
                            "git_pull 只能更新当前分支 {current}，不能拉取 {branch}"
                        ));
                    }
                }
                branch
            }
            None => match checked_out_branch {
                Some(branch) => branch,
                None => current_branch(&cwd, cancel.clone()).await?,
            },
        };
        let command = match name {
            "fetch" => vec!["fetch", remote.as_str(), branch.as_str()],
            "pull" => vec!["pull", "--ff-only", remote.as_str(), branch.as_str()],
            _ => return Err("无效的 Git 远程操作".to_string()),
        };
        run_git(&cwd, &command, cancel).await?;
        success_json(&GitRemoteResult {
            operation: name,
            remote,
            branch,
            status: "completed",
        })
    }

    async fn push_preview(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: PushPreviewParams = parse_arguments(arguments)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let data = prepare_push(&cwd, params, cancel).await?;
        let preflight_id = push_preflight_id(&data)?;
        success_json(&GitPushPreviewResult { data, preflight_id })
    }

    async fn force_push_preview(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: PushPreviewParams = parse_arguments(arguments)?;
        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let data = prepare_force_push(&cwd, params, cancel).await?;
        let preflight_id = force_push_preflight_id(&data)?;
        success_json(&GitForcePushPreviewResult { data, preflight_id })
    }

    async fn clone_preview(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        let params: ClonePreviewParams = parse_arguments(arguments)?;
        let cwd = working_directory(ctx)?;
        let data = prepare_clone(&cwd, params, cancel).await?;
        let preflight_id = clone_preflight_id(&data)?;
        success_json(&GitClonePreviewResult { data, preflight_id })
    }

    async fn push(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        if arguments
            .as_ref()
            .and_then(|arguments| arguments.get("preflight_id"))
            .is_none()
        {
            return Err(
                "Git 推送前必须先运行 git_push_preview，并传入返回的预检 preflight_id".to_string(),
            );
        }
        let params: PushParams = parse_arguments(arguments)?;
        if !is_valid_preflight_id(&params.preflight_id) {
            return Err("无效的 Git 推送 preflight_id；请重新运行 git_push_preview".to_string());
        }

        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let data = prepare_push(
            &cwd,
            PushPreviewParams {
                remote: params.remote,
                branch: params.branch,
            },
            cancel.clone(),
        )
        .await?;
        let expected_preflight_id = push_preflight_id(&data)?;
        if !data.blocked_reasons.is_empty() {
            return Err(format!(
                "Git 推送已阻止：{}",
                data.blocked_reasons.join("；")
            ));
        }
        if params.preflight_id != expected_preflight_id {
            return Err("Git 推送预检已过期或不匹配；请重新运行 git_push_preview".to_string());
        }
        run_git(
            &cwd,
            &[
                "push",
                "--set-upstream",
                data.remote.as_str(),
                data.branch.as_str(),
            ],
            cancel,
        )
        .await?;
        success_json(&GitRemoteResult {
            operation: "push",
            remote: data.remote,
            branch: data.branch,
            status: "completed",
        })
    }

    async fn force_push(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        if arguments
            .as_ref()
            .and_then(|arguments| arguments.get("preflight_id"))
            .is_none()
        {
            return Err(
                "Git force push 前必须先运行 git_force_push_preview，并传入返回的预检 preflight_id"
                    .to_string(),
            );
        }
        let params: ForcePushParams = parse_arguments(arguments)?;
        if !is_valid_preflight_id(&params.preflight_id) {
            return Err(
                "无效的 Git force push preflight_id；请重新运行 git_force_push_preview".to_string(),
            );
        }

        let cwd = working_directory(ctx)?;
        repository_root(&cwd, cancel.clone()).await?;
        let data = prepare_force_push(
            &cwd,
            PushPreviewParams {
                remote: Some(params.remote.clone()),
                branch: Some(params.branch.clone()),
            },
            cancel.clone(),
        )
        .await?;
        let expected_preflight_id = force_push_preflight_id(&data)?;
        if !data.blocked_reasons.is_empty() {
            return Err(format!(
                "Git force push 已阻止：{}",
                data.blocked_reasons.join("；")
            ));
        }
        if params.preflight_id != expected_preflight_id {
            return Err(
                "Git force push 预检已过期或不匹配；请重新运行 git_force_push_preview".to_string(),
            );
        }
        if !force_push_confirmation_matches(&params, &data) {
            return Err(
                "Git force push 确认摘要与最新预检不匹配；请重新运行 git_force_push_preview"
                    .to_string(),
            );
        }
        if !is_valid_git_oid(&data.head) || !is_valid_git_oid(&data.expected_remote_oid) {
            return Err("Git force push 预检包含无效对象 ID，已拒绝执行".to_string());
        }

        let target_ref = format!("refs/heads/{}", data.branch);
        let lease = format!(
            "--force-with-lease={target_ref}:{}",
            data.expected_remote_oid
        );
        let refspec = format!("HEAD:{target_ref}");
        run_git(
            &cwd,
            &["push", &lease, data.remote.as_str(), &refspec],
            cancel,
        )
        .await?;
        success_json(&GitRemoteResult {
            operation: "force_push_with_lease",
            remote: data.remote,
            branch: data.branch,
            status: "completed",
        })
    }

    async fn clone_repository(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
        cancel: CancellationToken,
    ) -> std::result::Result<CallToolResult, String> {
        if arguments
            .as_ref()
            .and_then(|arguments| arguments.get("preflight_id"))
            .is_none()
        {
            return Err(
                "Git clone 前必须先运行 git_clone_preview，并传入返回的预检 preflight_id"
                    .to_string(),
            );
        }
        let params: CloneParams = parse_arguments(arguments)?;
        if !is_valid_preflight_id(&params.preflight_id) {
            return Err("无效的 Git clone preflight_id；请重新运行 git_clone_preview".to_string());
        }

        let cwd = working_directory(ctx)?;
        let data = prepare_clone(
            &cwd,
            ClonePreviewParams {
                source: params.source,
                destination: params.destination,
                branch: params.branch,
            },
            cancel.clone(),
        )
        .await?;
        let expected_preflight_id = clone_preflight_id(&data)?;
        if !data.blocked_reasons.is_empty() {
            return Err(format!(
                "Git clone 已阻止：{}",
                data.blocked_reasons.join("；")
            ));
        }
        if params.preflight_id != expected_preflight_id {
            return Err("Git clone 预检已过期或不匹配；请重新运行 git_clone_preview".to_string());
        }

        let workspace_root = PathBuf::from(&data.workspace_binding);
        let operation_id = uuid::Uuid::now_v7().to_string();
        let temporary_name = format!(".codepro-clone-{operation_id}");
        let temporary_path = workspace_root.join(&temporary_name);
        let destination_path = workspace_root.join(&data.destination);
        let hooks_path = workspace_root.join(format!(".codepro-no-hooks-{operation_id}"));
        let hooks_config = format!("core.hooksPath={}", hooks_path.to_string_lossy());
        let mut owned_arguments = vec![
            "-c".to_string(),
            hooks_config,
            "-c".to_string(),
            "http.followRedirects=false".to_string(),
            "clone".to_string(),
            "--no-progress".to_string(),
            "--single-branch".to_string(),
            "--no-recurse-submodules".to_string(),
            "--no-tags".to_string(),
            "--no-local".to_string(),
            "--no-hardlinks".to_string(),
        ];
        if let Some(branch) = data.branch.as_deref() {
            owned_arguments.push("--branch".to_string());
            owned_arguments.push(branch.to_string());
        }
        owned_arguments.push("--".to_string());
        owned_arguments.push(data.source.clone());
        owned_arguments.push(temporary_name);
        let arguments = owned_arguments
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let environment = [
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", null_git_config_path()),
            ("GIT_ALLOW_PROTOCOL", "https:file"),
        ];
        if let Err(error) = run_git_with_env(
            &workspace_root,
            &arguments,
            &environment,
            CLONE_REMOVED_ENVIRONMENT,
            cancel,
        )
        .await
        {
            if let Err(cleanup_error) =
                cleanup_clone_temporary_directory(&workspace_root, &temporary_path).await
            {
                return Err(format!("{error}；{cleanup_error}"));
            }
            return Err(error);
        }
        if path_entry_exists(&destination_path).await? {
            cleanup_clone_temporary_directory(&workspace_root, &temporary_path).await?;
            return Err("Git clone 已阻止：clone 目标目录已存在".to_string());
        }
        let metadata = tokio::fs::symlink_metadata(&temporary_path)
            .await
            .map_err(|_| "Git clone 临时目录在完成前丢失".to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            cleanup_clone_temporary_directory(&workspace_root, &temporary_path).await?;
            return Err("Git clone 临时结果不是安全目录".to_string());
        }
        if tokio::fs::rename(&temporary_path, &destination_path)
            .await
            .is_err()
        {
            cleanup_clone_temporary_directory(&workspace_root, &temporary_path).await?;
            return Err("无法原子完成 Git clone 目标目录".to_string());
        }

        success_json(&GitCloneResult {
            source: data.source,
            destination: data.destination,
            branch: data.branch,
            status: "completed",
        })
    }
}

#[async_trait]
impl McpClientTrait for GitClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        Ok(ListToolsResult {
            tools: Self::tools(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        cancel_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        let result = match name {
            "git_runtime_status" => match parse_arguments::<EmptyParams>(arguments) {
                Ok(_) => git_runtime_status(cancel_token).await,
                Err(error) => Err(error),
            },
            "github_runtime_status" => match parse_arguments::<EmptyParams>(arguments) {
                Ok(_) => github_runtime_status(cancel_token).await,
                Err(error) => Err(error),
            },
            "git_repository_snapshot" => match parse_arguments::<EmptyParams>(arguments) {
                Ok(_) => self.repository_snapshot(ctx, cancel_token).await,
                Err(error) => Err(error),
            },
            "git_status" => match parse_arguments::<EmptyParams>(arguments) {
                Ok(_) => self.status(ctx, cancel_token).await,
                Err(error) => Err(error),
            },
            "git_conflicts" => match parse_arguments::<EmptyParams>(arguments) {
                Ok(_) => self.conflicts(ctx, cancel_token).await,
                Err(error) => Err(error),
            },
            "git_diff" => self.diff(ctx, arguments, cancel_token).await,
            "git_log" => self.log(ctx, arguments, cancel_token).await,
            "git_branches" => match parse_arguments::<EmptyParams>(arguments) {
                Ok(_) => self.branches(ctx, cancel_token).await,
                Err(error) => Err(error),
            },
            "git_push_preview" => self.push_preview(ctx, arguments, cancel_token).await,
            "git_force_push_preview" => self.force_push_preview(ctx, arguments, cancel_token).await,
            "git_clone_preview" => self.clone_preview(ctx, arguments, cancel_token).await,
            "git_restore_preview" => self.restore_preview(ctx, arguments, cancel_token).await,
            "git_conflict_abort_preview" => match parse_arguments::<EmptyParams>(arguments) {
                Ok(_) => self.conflict_abort_preview(ctx, cancel_token).await,
                Err(error) => Err(error),
            },
            "git_init" => self.init(ctx, arguments, cancel_token).await,
            "git_stage" => self.stage(ctx, arguments, cancel_token).await,
            "git_unstage" => self.unstage(ctx, arguments, cancel_token).await,
            "git_restore" => self.restore(ctx, arguments, cancel_token).await,
            "git_branch_create" => self.mutate_branch(ctx, arguments, cancel_token, true).await,
            "git_branch_switch" => {
                self.mutate_branch(ctx, arguments, cancel_token, false)
                    .await
            }
            "git_commit" => self.commit(ctx, arguments, cancel_token).await,
            "git_conflict_continue" => self.conflict_continue(ctx, arguments, cancel_token).await,
            "git_conflict_abort" => self.conflict_abort(ctx, arguments, cancel_token).await,
            "git_fetch" => {
                self.remote_operation(ctx, "fetch", arguments, cancel_token)
                    .await
            }
            "git_pull" => {
                self.remote_operation(ctx, "pull", arguments, cancel_token)
                    .await
            }
            "git_push" => self.push(ctx, arguments, cancel_token).await,
            "git_clone" => self.clone_repository(ctx, arguments, cancel_token).await,
            "git_force_push" => self.force_push(ctx, arguments, cancel_token).await,
            _ => Err(format!("未知 Git 工具: {name}")),
        };
        Ok(result.unwrap_or_else(|error| CallToolResult::error(vec![Content::text(error)])))
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }
}

async fn git_runtime_status(
    cancel: CancellationToken,
) -> std::result::Result<CallToolResult, String> {
    if cancel.is_cancelled() {
        return Err("Git 检测已停止".to_string());
    }
    let mut command = Command::new("git");
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return success_json(&GitRuntimeStatusResult {
                available: false,
                version: None,
                install_url: git_install_url(),
            });
        }
        Err(error) => return Err(format!("无法检测 Git: {error}")),
    };
    let output = tokio::select! {
        output = child.wait_with_output() => output.map_err(|error| format!("Git 检测失败: {error}"))?,
        _ = cancel.cancelled() => return Err("Git 检测已停止".to_string()),
        _ = tokio::time::sleep(GIT_RUNTIME_PROBE_TIMEOUT) => {
            return Err("Git 检测超过 5 秒上限".to_string());
        }
    };
    if !output.status.success() {
        return Err(format!(
            "Git 版本检测失败（退出码 {}）",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "未知".to_string())
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !version.starts_with("git version ") || version.len() > 256 {
        return Err("Git 返回了无效的版本信息".to_string());
    }
    success_json(&GitRuntimeStatusResult {
        available: true,
        version: Some(version),
        install_url: git_install_url(),
    })
}

fn git_install_url() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "https://git-scm.com/download/win"
    }
    #[cfg(target_os = "macos")]
    {
        "https://git-scm.com/download/mac"
    }
    #[cfg(target_os = "linux")]
    {
        "https://git-scm.com/download/linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "https://git-scm.com/downloads"
    }
}

async fn github_runtime_status(
    cancel: CancellationToken,
) -> std::result::Result<CallToolResult, String> {
    if cancel.is_cancelled() {
        return Err("GitHub CLI 检测已停止".to_string());
    }
    let mut version_command = Command::new("gh");
    version_command
        .arg("--version")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let child = match version_command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return success_json(&GitHubRuntimeStatusResult {
                available: false,
                authenticated: false,
                version: None,
                hostname: "github.com",
                install_url: "https://cli.github.com/",
                login_command: "gh auth login --hostname github.com --web",
            });
        }
        Err(error) => return Err(format!("无法检测 GitHub CLI: {error}")),
    };
    let output = tokio::select! {
        output = child.wait_with_output() => output.map_err(|error| format!("GitHub CLI 检测失败: {error}"))?,
        _ = cancel.cancelled() => return Err("GitHub CLI 检测已停止".to_string()),
        _ = tokio::time::sleep(GITHUB_RUNTIME_PROBE_TIMEOUT) => {
            return Err("GitHub CLI 检测超过 10 秒上限".to_string());
        }
    };
    if !output.status.success() {
        return Err(format!(
            "GitHub CLI 版本检测失败（退出码 {}）",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "未知".to_string())
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if !version.starts_with("gh version ") || version.len() > 256 {
        return Err("GitHub CLI 返回了无效的版本信息".to_string());
    }

    let mut auth_command = Command::new("gh");
    auth_command
        .args(["auth", "status", "--active", "--hostname", "github.com"])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = auth_command
        .spawn()
        .map_err(|error| format!("无法检测 GitHub 登录状态: {error}"))?;
    let status = tokio::select! {
        status = child.wait() => status.map_err(|error| format!("GitHub 登录状态检测失败: {error}"))?,
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            return Err("GitHub CLI 检测已停止".to_string());
        },
        _ = tokio::time::sleep(GITHUB_RUNTIME_PROBE_TIMEOUT) => {
            let _ = child.kill().await;
            return Err("GitHub 登录状态检测超过 10 秒上限".to_string());
        },
    };

    success_json(&GitHubRuntimeStatusResult {
        available: true,
        authenticated: status.success(),
        version: Some(version),
        hostname: "github.com",
        install_url: "https://cli.github.com/",
        login_command: "gh auth login --hostname github.com --web",
    })
}

struct GitOutput {
    stdout: String,
}

async fn run_git(
    cwd: &Path,
    arguments: &[&str],
    cancel: CancellationToken,
) -> std::result::Result<GitOutput, String> {
    run_git_with_env(cwd, arguments, &[], &[], cancel).await
}

async fn run_git_with_env(
    cwd: &Path,
    arguments: &[&str],
    environment: &[(&str, &str)],
    removed_environment: &[&str],
    cancel: CancellationToken,
) -> std::result::Result<GitOutput, String> {
    if cancel.is_cancelled() {
        return Err("Git 操作已停止".to_string());
    }
    let mut command = Command::new("git");
    for name in GIT_REPOSITORY_REMOVED_ENVIRONMENT {
        command.env_remove(name);
    }
    for name in removed_environment {
        command.env_remove(name);
    }
    let hooks_path = cwd.join(format!(".codepro-no-hooks-{}", uuid::Uuid::now_v7()));
    let hooks_config = format!("core.hooksPath={}", hooks_path.to_string_lossy());
    command
        .args(["-c", hooks_config.as_str(), "-c", "core.fsmonitor=false"])
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (name, value) in environment {
        command.env(name, value);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Git: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 Git 标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 Git 错误输出".to_string())?;
    let stdout_task = tokio::spawn(read_bounded_git_stream(stdout));
    let stderr_task = tokio::spawn(read_bounded_git_stream(stderr));
    let status = tokio::select! {
        status = child.wait() => status.map_err(|error| format!("Git 执行失败: {error}"))?,
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            return Err("Git 操作已停止".to_string());
        },
        _ = tokio::time::sleep(GIT_OPERATION_TIMEOUT) => {
            let _ = child.kill().await;
            return Err("Git 操作超过 120 秒上限".to_string());
        },
    };
    let stdout_bytes = stdout_task
        .await
        .map_err(|error| format!("Git 标准输出读取任务失败: {error}"))?
        .map_err(|error| format!("无法读取 Git 标准输出: {error}"))?;
    let stderr_bytes = stderr_task
        .await
        .map_err(|error| format!("Git 错误输出读取任务失败: {error}"))?
        .map_err(|error| format!("无法读取 Git 错误输出: {error}"))?;
    if stdout_bytes.len() > MAX_GIT_PROCESS_OUTPUT_BYTES
        || stderr_bytes.len() > MAX_GIT_PROCESS_OUTPUT_BYTES
    {
        return Err("Git 输出超过 8 MiB 安全上限".to_string());
    }
    let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    if status.success() {
        Ok(GitOutput { stdout })
    } else {
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        let detail = stderr.trim();
        if detail.contains("not a git repository") {
            Err("当前目录不是 Git 仓库".to_string())
        } else {
            let detail = redact_git_detail(detail);
            let (detail, _) = truncate_utf8(&detail, 4096);
            Err(format!(
                "Git 命令失败（退出码 {}）：{detail}",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "未知".to_string())
            ))
        }
    }
}

async fn read_bounded_git_stream(reader: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_GIT_PROCESS_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

async fn repository_root(
    cwd: &Path,
    cancel: CancellationToken,
) -> std::result::Result<String, String> {
    let output = run_git(cwd, &["rev-parse", "--show-toplevel"], cancel).await?;
    let root = output.stdout.trim();
    if root.is_empty() {
        Err("当前目录不是 Git 仓库".to_string())
    } else {
        Ok(root.to_string())
    }
}

async fn detect_conflict_operation(
    cwd: &Path,
    has_conflicts: bool,
    cancel: CancellationToken,
) -> std::result::Result<String, String> {
    let output = run_git(cwd, &["rev-parse", "--absolute-git-dir"], cancel).await?;
    let git_directory = PathBuf::from(output.stdout.trim());
    if git_directory.as_os_str().is_empty() || !git_directory.is_absolute() {
        return Err("无法解析 Git 状态目录".to_string());
    }
    for (operation, markers) in [
        ("rebase", &["rebase-merge", "rebase-apply"][..]),
        ("merge", &["MERGE_HEAD"][..]),
        ("cherry_pick", &["CHERRY_PICK_HEAD"][..]),
        ("revert", &["REVERT_HEAD"][..]),
    ] {
        for marker in markers {
            if path_entry_exists(&git_directory.join(marker)).await? {
                return Ok(operation.to_string());
            }
        }
    }
    Ok(if has_conflicts { "unknown" } else { "none" }.to_string())
}

async fn read_conflict_state(
    cwd: &Path,
    cancel: CancellationToken,
) -> std::result::Result<(ParsedConflicts, String), String> {
    let output = run_git(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--unmerged",
            "--stage",
            "-z",
        ],
        cancel.clone(),
    )
    .await?;
    let parsed = parse_unmerged_entries(output.stdout.as_bytes(), MAX_CONFLICT_ENTRIES);
    let operation = detect_conflict_operation(cwd, parsed.total_conflicts > 0, cancel).await?;
    Ok((parsed, operation))
}

async fn conflict_operation_state(
    cwd: &Path,
    operation: &str,
    cancel: CancellationToken,
) -> std::result::Result<String, String> {
    let output = run_git(cwd, &["rev-parse", "--absolute-git-dir"], cancel).await?;
    let git_directory = PathBuf::from(output.stdout.trim());
    let markers: &[&str] = match operation {
        "merge" => &["MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"],
        "rebase" => &["rebase-merge", "rebase-apply", "REBASE_HEAD", "ORIG_HEAD"],
        "cherry_pick" => &["CHERRY_PICK_HEAD", "MERGE_MSG", "sequencer", "ORIG_HEAD"],
        "revert" => &["REVERT_HEAD", "MERGE_MSG", "sequencer", "ORIG_HEAD"],
        _ => &[],
    };
    let mut pending = markers
        .iter()
        .rev()
        .map(|marker| git_directory.join(marker))
        .collect::<Vec<_>>();
    let mut total_bytes = 0usize;
    let mut hasher = Sha256::new();
    hasher.update(operation.as_bytes());
    hasher.update([0]);

    while let Some(path) = pending.pop() {
        let relative = path
            .strip_prefix(&git_directory)
            .map_err(|_| "Git 操作状态路径超出仓库状态目录".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        let metadata = match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                hasher.update(b"missing");
                hasher.update([0]);
                continue;
            }
            Err(error) => return Err(format!("无法读取 Git 操作状态: {error}")),
        };
        if metadata.file_type().is_symlink() {
            return Err("Git 操作状态包含不受支持的符号链接".to_string());
        }
        if metadata.is_dir() {
            hasher.update(b"directory");
            hasher.update([0]);
            let mut entries = tokio::fs::read_dir(&path)
                .await
                .map_err(|error| format!("无法读取 Git 操作状态目录: {error}"))?;
            let mut children = Vec::new();
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|error| format!("无法枚举 Git 操作状态目录: {error}"))?
            {
                children.push(entry.path());
            }
            children.sort();
            pending.extend(children.into_iter().rev());
            continue;
        }
        if !metadata.is_file() {
            return Err("Git 操作状态包含不受支持的文件类型".to_string());
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("无法读取 Git 操作状态文件: {error}"))?;
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "Git 操作状态超过 8 MiB 安全上限".to_string())?;
        if total_bytes > MAX_GIT_PROCESS_OUTPUT_BYTES {
            return Err("Git 操作状态超过 8 MiB 安全上限".to_string());
        }
        hasher.update(b"file");
        hasher.update([0]);
        hasher.update(bytes);
        hasher.update([0]);
    }

    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

async fn prepare_conflict_abort(
    cwd: &Path,
    cancel: CancellationToken,
) -> std::result::Result<GitConflictAbortPreviewData, String> {
    let repository = repository_root(cwd, cancel.clone()).await?;
    let workspace_root = tokio::fs::canonicalize(repository)
        .await
        .map_err(|_| "无法解析 Git 仓库根目录".to_string())?;
    let (conflicts, operation) = read_conflict_state(cwd, cancel.clone()).await?;
    let head = run_git(cwd, &["rev-parse", "HEAD"], cancel.clone())
        .await?
        .stdout
        .trim()
        .to_string();
    let status = run_git(
        cwd,
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        cancel.clone(),
    )
    .await?
    .stdout;
    let full_working_diff = run_git(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--no-ext-diff",
            "--binary",
            "--full-index",
        ],
        cancel.clone(),
    )
    .await?
    .stdout;
    let full_staged_diff = run_git(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--cached",
            "--no-ext-diff",
            "--binary",
            "--full-index",
        ],
        cancel.clone(),
    )
    .await?
    .stdout;
    let changed_paths = run_git(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-only",
            "-z",
            "HEAD",
        ],
        cancel.clone(),
    )
    .await?
    .stdout
    .split('\0')
    .filter(|path| !path.is_empty())
    .map(ToOwned::to_owned)
    .collect::<Vec<_>>();
    let conflicted_paths = conflicts
        .conflicts
        .iter()
        .map(|conflict| conflict.path.clone())
        .collect::<Vec<_>>();
    let marker_state = conflict_operation_state(cwd, &operation, cancel).await?;
    let mut state_hasher = Sha256::new();
    for value in [
        operation.as_bytes(),
        status.as_bytes(),
        full_working_diff.as_bytes(),
        full_staged_diff.as_bytes(),
        marker_state.as_bytes(),
    ] {
        state_hasher.update(value);
        state_hasher.update([0]);
    }
    let state_digest = state_hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let (working_diff, working_diff_truncated) =
        truncate_utf8(&full_working_diff, MAX_GIT_OUTPUT_BYTES);
    let (staged_diff, staged_diff_truncated) =
        truncate_utf8(&full_staged_diff, MAX_GIT_OUTPUT_BYTES);
    let blocked_reasons = match operation.as_str() {
        "merge" | "rebase" | "cherry_pick" | "revert" => Vec::new(),
        _ => vec![format!("当前操作 {operation} 不支持安全中止")],
    };
    Ok(GitConflictAbortPreviewData {
        operation,
        head,
        changed_paths,
        conflicted_paths,
        working_diff,
        working_diff_truncated,
        staged_diff,
        staged_diff_truncated,
        blocked_reasons,
        workspace_binding: workspace_root.to_string_lossy().into_owned(),
        state_digest,
    })
}

fn conflict_abort_preflight_id(
    data: &GitConflictAbortPreviewData,
) -> std::result::Result<String, String> {
    let encoded =
        serde_json::to_vec(data).map_err(|error| format!("无法编码 Git 冲突中止预检: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(data.workspace_binding.as_bytes());
    hasher.update([0]);
    hasher.update(data.state_digest.as_bytes());
    hasher.update([0]);
    hasher.update(encoded);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

async fn current_branch(
    cwd: &Path,
    cancel: CancellationToken,
) -> std::result::Result<String, String> {
    let output = run_git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"], cancel)
        .await
        .map_err(|_| "当前是 detached HEAD；请先创建或切换分支".to_string())?;
    let branch = output.stdout.trim().to_string();
    validate_ref(&branch)?;
    Ok(branch)
}

async fn require_configured_remote(
    cwd: &Path,
    expected: &str,
    cancel: CancellationToken,
) -> std::result::Result<(), String> {
    let output = run_git(cwd, &["remote"], cancel).await?;
    if output
        .stdout
        .lines()
        .any(|remote| remote.trim() == expected)
    {
        Ok(())
    } else {
        Err(format!("Git 远程 {expected} 未配置"))
    }
}

async fn prepare_restore(
    cwd: &Path,
    paths: Vec<String>,
    cancel: CancellationToken,
) -> std::result::Result<GitRestorePreviewData, String> {
    if paths.is_empty() {
        return Err("git_restore_preview 必须提供至少一个显式路径".to_string());
    }
    validate_paths(&paths)?;
    let repository = repository_root(cwd, cancel.clone()).await?;
    let workspace_root = tokio::fs::canonicalize(repository)
        .await
        .map_err(|_| "无法解析 Git 仓库根目录".to_string())?;
    let canonical_cwd = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|_| "无法解析当前 Git 工作目录".to_string())?;
    let cwd_relative = canonical_cwd
        .strip_prefix(&workspace_root)
        .map_err(|_| "当前工作目录不在 Git 仓库内".to_string())?;
    let requested_paths = paths;
    let resolved_paths = requested_paths
        .iter()
        .map(|path| repository_relative_path(cwd_relative, path))
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut diff_arguments = vec![
        "--literal-pathspecs".to_string(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--binary".to_string(),
        "--full-index".to_string(),
        "--".to_string(),
    ];
    diff_arguments.extend(resolved_paths.iter().cloned());
    let diff_refs = diff_arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let full_diff = run_git(&workspace_root, &diff_refs, cancel.clone())
        .await?
        .stdout;
    let state_digest = Sha256::digest(full_diff.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let (diff, diff_truncated) = truncate_utf8(&full_diff, MAX_GIT_OUTPUT_BYTES);

    let mut changed_arguments = vec![
        "--literal-pathspecs".to_string(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
        "diff".to_string(),
        "--name-only".to_string(),
        "-z".to_string(),
        "--".to_string(),
    ];
    changed_arguments.extend(resolved_paths.iter().cloned());
    let changed_refs = changed_arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let changed_paths = run_git(&workspace_root, &changed_refs, cancel.clone())
        .await?
        .stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    let mut conflict_arguments = vec![
        "--literal-pathspecs".to_string(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
        "diff".to_string(),
        "--name-only".to_string(),
        "--diff-filter=U".to_string(),
        "-z".to_string(),
        "--".to_string(),
    ];
    conflict_arguments.extend(resolved_paths.iter().cloned());
    let conflict_refs = conflict_arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let conflict_paths = run_git(&workspace_root, &conflict_refs, cancel.clone())
        .await?
        .stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    let mut unmatched_paths = Vec::new();
    for path in &resolved_paths {
        let tracked = run_git(
            &workspace_root,
            &[
                "--literal-pathspecs",
                "ls-files",
                "--error-unmatch",
                "--",
                path,
            ],
            cancel.clone(),
        )
        .await;
        match tracked {
            Ok(_) => {}
            Err(error) if cancel.is_cancelled() => return Err(error),
            Err(_) => unmatched_paths.push(path.clone()),
        }
    }

    let mut blocked_reasons = Vec::new();
    if changed_paths.is_empty() {
        blocked_reasons.push("所选路径没有可还原的已跟踪工作区变更".to_string());
    }
    if !conflict_paths.is_empty() {
        blocked_reasons.push(format!(
            "冲突路径必须通过冲突流程处理：{}",
            conflict_paths.join(", ")
        ));
    }
    if !unmatched_paths.is_empty() {
        blocked_reasons.push(format!(
            "未跟踪或不匹配索引的路径不会被还原：{}",
            unmatched_paths.join(", ")
        ));
    }

    Ok(GitRestorePreviewData {
        paths: requested_paths,
        changed_paths,
        diff,
        diff_truncated,
        blocked_reasons,
        workspace_binding: workspace_root.to_string_lossy().into_owned(),
        cwd_binding: canonical_cwd.to_string_lossy().into_owned(),
        resolved_paths,
        state_digest,
    })
}

fn restore_preflight_id(data: &GitRestorePreviewData) -> std::result::Result<String, String> {
    let encoded =
        serde_json::to_vec(data).map_err(|error| format!("无法编码 Git 还原预检: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(data.workspace_binding.as_bytes());
    hasher.update([0]);
    hasher.update(data.cwd_binding.as_bytes());
    hasher.update([0]);
    for path in &data.resolved_paths {
        hasher.update(path.as_bytes());
        hasher.update([0]);
    }
    hasher.update(data.state_digest.as_bytes());
    hasher.update([0]);
    hasher.update(encoded);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

async fn prepare_push(
    cwd: &Path,
    params: PushPreviewParams,
    cancel: CancellationToken,
) -> std::result::Result<GitPushPreviewData, String> {
    let remote = params.remote.unwrap_or_else(|| "origin".to_string());
    validate_remote(&remote)?;
    require_configured_remote(cwd, &remote, cancel.clone()).await?;
    let current = run_git(
        cwd,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        cancel.clone(),
    )
    .await
    .ok()
    .map(|output| output.stdout.trim().to_string())
    .filter(|branch| !branch.is_empty());
    let branch = params
        .branch
        .or_else(|| current.clone())
        .unwrap_or_else(|| "HEAD".to_string());
    validate_ref(&branch)?;

    let remote_output = run_git(
        cwd,
        &["remote", "get-url", "--push", &remote],
        cancel.clone(),
    )
    .await?;
    let remote_destination = sanitize_remote_destination(remote_output.stdout.trim());
    if remote_destination.is_empty() {
        return Err("Git 远程目标为空".to_string());
    }

    let head_output = run_git(cwd, &["rev-parse", "--verify", "HEAD"], cancel.clone()).await?;
    let head = head_output.stdout.trim().to_string();
    if head.is_empty() {
        return Err("无法读取当前 HEAD".to_string());
    }

    let target_ref = format!("refs/remotes/{remote}/{branch}");
    let revision = if run_git(
        cwd,
        &["show-ref", "--verify", "--quiet", &target_ref],
        cancel.clone(),
    )
    .await
    .is_ok()
    {
        format!("{target_ref}..HEAD")
    } else {
        "HEAD".to_string()
    };
    let count_output = run_git(cwd, &["rev-list", "--count", &revision], cancel.clone()).await?;
    let outgoing_commit_count = count_output
        .stdout
        .trim()
        .parse::<usize>()
        .map_err(|_| "无法读取待推送提交数量".to_string())?;

    let max_count = format!("--max-count={MAX_PUSH_PREVIEW_COMMITS}");
    let commits_output = run_git(
        cwd,
        &["log", &max_count, "--format=%H%x1f%s%x1e", &revision],
        cancel.clone(),
    )
    .await?;
    let outgoing_commits = commits_output
        .stdout
        .split('\u{1e}')
        .filter_map(|record| {
            let fields = record.trim().splitn(2, '\u{1f}').collect::<Vec<_>>();
            (fields.len() == 2).then(|| GitPushCommit {
                id: fields[0].to_string(),
                subject: fields[1].to_string(),
            })
        })
        .collect::<Vec<_>>();

    let paths_output = run_git(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "log",
            "--format=",
            "--name-only",
            "-z",
            &revision,
        ],
        cancel,
    )
    .await?;
    let all_paths = paths_output
        .stdout
        .split('\0')
        .filter_map(|path| {
            let path = path.trim_matches(['\r', '\n']);
            (!path.is_empty()).then(|| path.to_string())
        })
        .collect::<BTreeSet<_>>();
    let paths_truncated = all_paths.len() > MAX_PATHS;
    let changed_paths = all_paths
        .iter()
        .take(MAX_PATHS)
        .cloned()
        .collect::<Vec<_>>();
    let sensitive_paths = all_paths
        .iter()
        .filter(|path| is_sensitive_git_path(path))
        .take(MAX_SENSITIVE_PATHS)
        .cloned()
        .collect::<Vec<_>>();
    let mut blocked_reasons = Vec::new();
    match current {
        Some(current) if branch != current => {
            blocked_reasons.push(format!("目标分支 {branch} 不是当前分支 {current}"))
        }
        None => blocked_reasons.push("当前仓库处于 detached HEAD（游离 HEAD）状态".to_string()),
        _ => {}
    }
    if !sensitive_paths.is_empty() {
        blocked_reasons.push("待推送提交包含敏感路径".to_string());
    }

    Ok(GitPushPreviewData {
        remote,
        remote_destination,
        branch,
        head,
        outgoing_commit_count,
        outgoing_commits,
        changed_paths,
        paths_truncated,
        sensitive_paths,
        blocked_reasons,
    })
}

fn push_preflight_id(data: &GitPushPreviewData) -> std::result::Result<String, String> {
    let encoded =
        serde_json::to_vec(data).map_err(|error| format!("无法编码 Git 推送预检: {error}"))?;
    let digest = Sha256::digest(encoded);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

async fn prepare_force_push(
    cwd: &Path,
    params: PushPreviewParams,
    cancel: CancellationToken,
) -> std::result::Result<GitForcePushPreviewData, String> {
    let workspace_root = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|_| "无法规范化 force push 工作区".to_string())?;
    let normal = prepare_push(cwd, params, cancel.clone()).await?;
    let target_ref = format!("refs/remotes/{}/{}", normal.remote, normal.branch);
    let mut blocked_reasons = normal.blocked_reasons;
    let target_exists = match run_git(
        cwd,
        &["show-ref", "--verify", "--quiet", &target_ref],
        cancel.clone(),
    )
    .await
    {
        Ok(_) => true,
        Err(error) if is_git_lifecycle_error(&error) => return Err(error),
        Err(_) => false,
    };
    let (expected_remote_oid, remote_only_commit_count, remote_only_commits) = if target_exists {
        let expected = run_git(cwd, &["rev-parse", "--verify", &target_ref], cancel.clone())
            .await?
            .stdout
            .trim()
            .to_string();
        let revision = format!("HEAD..{target_ref}");
        let count = run_git(cwd, &["rev-list", "--count", &revision], cancel.clone())
            .await?
            .stdout
            .trim()
            .parse::<usize>()
            .map_err(|_| "无法读取待覆盖远端提交数量".to_string())?;
        let max_count = format!("--max-count={MAX_PUSH_PREVIEW_COMMITS}");
        let commits = run_git(
            cwd,
            &["log", &max_count, "--format=%H%x1f%s%x1e", &revision],
            cancel,
        )
        .await?
        .stdout
        .split('\u{1e}')
        .filter_map(|record| {
            let fields = record.trim().splitn(2, '\u{1f}').collect::<Vec<_>>();
            (fields.len() == 2).then(|| GitPushCommit {
                id: fields[0].to_string(),
                subject: fields[1].to_string(),
            })
        })
        .collect::<Vec<_>>();
        (expected, count, commits)
    } else {
        blocked_reasons.push("force push 需要已存在的远端跟踪分支".to_string());
        (String::new(), 0, Vec::new())
    };
    if target_exists && remote_only_commit_count == 0 {
        blocked_reasons.push("远端分支没有需要覆盖的提交；请使用普通 git_push".to_string());
    }

    Ok(GitForcePushPreviewData {
        remote: normal.remote,
        remote_destination: normal.remote_destination,
        branch: normal.branch,
        head: normal.head,
        expected_remote_oid,
        local_only_commit_count: normal.outgoing_commit_count,
        remote_only_commit_count,
        local_only_commits: normal.outgoing_commits,
        remote_only_commits,
        changed_paths: normal.changed_paths,
        paths_truncated: normal.paths_truncated,
        sensitive_paths: normal.sensitive_paths,
        blocked_reasons,
        workspace_binding: workspace_root.to_string_lossy().into_owned(),
    })
}

fn force_push_preflight_id(data: &GitForcePushPreviewData) -> std::result::Result<String, String> {
    let encoded = serde_json::to_vec(data)
        .map_err(|error| format!("无法编码 Git force push 预检: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(data.workspace_binding.as_bytes());
    hasher.update([0]);
    hasher.update(encoded);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn force_push_confirmation_matches(
    params: &ForcePushParams,
    data: &GitForcePushPreviewData,
) -> bool {
    params.remote == data.remote
        && params.branch == data.branch
        && params.head == data.head
        && params.expected_remote_oid == data.expected_remote_oid
        && params.local_only_commit_count == data.local_only_commit_count
        && params.remote_only_commit_count == data.remote_only_commit_count
}

async fn prepare_clone(
    cwd: &Path,
    params: ClonePreviewParams,
    cancel: CancellationToken,
) -> std::result::Result<GitClonePreviewData, String> {
    validate_clone_destination(&params.destination)?;
    if let Some(branch) = params.branch.as_deref() {
        validate_ref(branch)?;
    }
    let workspace_root = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|_| "无法规范化 clone 工作区".to_string())?;
    let (source, source_kind) =
        normalize_clone_source(&workspace_root, &params.source, cancel).await?;
    let destination_path = workspace_root.join(&params.destination);
    let mut blocked_reasons = Vec::new();
    if path_entry_exists(&destination_path).await? {
        blocked_reasons.push("clone 目标目录已存在".to_string());
    }

    Ok(GitClonePreviewData {
        source,
        source_kind,
        destination: params.destination,
        branch: params.branch,
        network_checked: false,
        blocked_reasons,
        workspace_binding: workspace_root.to_string_lossy().into_owned(),
    })
}

async fn normalize_clone_source(
    workspace_root: &Path,
    source: &str,
    cancel: CancellationToken,
) -> std::result::Result<(String, &'static str), String> {
    if source.to_ascii_lowercase().starts_with("https://") {
        return validate_github_clone_url(source).map(|source| (source, "github_https"));
    }
    if source.contains("://")
        || source.contains('@')
        || source.is_empty()
        || Path::new(source).is_absolute()
    {
        return Err("clone 源只允许无凭据 GitHub HTTPS 或工作区内相对 Git 路径".to_string());
    }

    let canonical_source = tokio::fs::canonicalize(workspace_root.join(source))
        .await
        .map_err(|_| "工作区内本地 clone 源不存在".to_string())?;
    if !canonical_source.starts_with(workspace_root) {
        return Err("本地 clone 源必须位于当前工作区".to_string());
    }
    let bare = run_git(
        &canonical_source,
        &["rev-parse", "--is-bare-repository"],
        cancel.clone(),
    )
    .await
    .map_err(sanitize_clone_source_probe_error)?;
    if bare.stdout.trim() != "true" {
        let top = run_git(&canonical_source, &["rev-parse", "--show-toplevel"], cancel)
            .await
            .map_err(sanitize_clone_source_probe_error)?;
        let canonical_top = tokio::fs::canonicalize(top.stdout.trim())
            .await
            .map_err(|_| "无法规范化本地 Git 仓库根目录".to_string())?;
        if canonical_top != canonical_source {
            return Err("本地 clone 源必须指向 Git 仓库根目录".to_string());
        }
    }

    let relative = canonical_source
        .strip_prefix(workspace_root)
        .map_err(|_| "本地 clone 源必须位于当前工作区".to_string())?;
    let display = if relative.as_os_str().is_empty() {
        ".".to_string()
    } else {
        relative.to_string_lossy().replace('\\', "/")
    };
    Ok((display, "workspace_local"))
}

fn validate_github_clone_url(value: &str) -> std::result::Result<String, String> {
    let invalid = || "clone URL 必须是无凭据的 https://github.com/owner/repository".to_string();
    let url = Url::parse(value).map_err(|_| invalid())?;
    let authority = value
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split('/').next())
        .ok_or_else(invalid)?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !authority.eq_ignore_ascii_case("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let segments = url.path_segments().ok_or_else(invalid)?.collect::<Vec<_>>();
    if segments.len() != 2
        || segments.iter().any(|segment| {
            segment.is_empty()
                || segment.len() > 100
                || matches!(*segment, "." | "..")
                || !segment.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                })
        })
        || segments[1].trim_end_matches(".git").is_empty()
    {
        return Err(invalid());
    }
    Ok(format!(
        "https://github.com/{}/{}",
        segments[0], segments[1]
    ))
}

fn sanitize_clone_source_probe_error(error: String) -> String {
    if is_git_lifecycle_error(&error) {
        error
    } else {
        "本地 clone 源不是可用 Git 仓库".to_string()
    }
}

fn is_git_lifecycle_error(error: &str) -> bool {
    matches!(error, "Git 操作已停止" | "Git 操作超过 120 秒上限")
}

fn validate_clone_destination(value: &str) -> std::result::Result<(), String> {
    let lower = value.to_ascii_lowercase();
    let device_stem = lower.split('.').next().unwrap_or(&lower);
    let windows_device = matches!(device_stem, "con" | "prn" | "aux" | "nul")
        || (device_stem.len() == 4
            && (device_stem.starts_with("com") || device_stem.starts_with("lpt"))
            && matches!(device_stem.as_bytes()[3], b'1'..=b'9'));
    if value.is_empty()
        || value.len() > 100
        || value.starts_with('.')
        || value.ends_with(['.', ' '])
        || windows_device
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("clone 目标必须是安全、可移植且尚不存在的直接子目录名".to_string());
    }
    Ok(())
}

async fn path_entry_exists(path: &Path) -> std::result::Result<bool, String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("无法检查路径状态".to_string()),
    }
}

fn clone_preflight_id(data: &GitClonePreviewData) -> std::result::Result<String, String> {
    let encoded =
        serde_json::to_vec(data).map_err(|error| format!("无法编码 Git clone 预检: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(data.workspace_binding.as_bytes());
    hasher.update([0]);
    hasher.update(encoded);
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn is_valid_preflight_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_valid_git_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(windows)]
fn null_git_config_path() -> &'static str {
    "NUL"
}

#[cfg(not(windows))]
fn null_git_config_path() -> &'static str {
    "/dev/null"
}

async fn cleanup_clone_temporary_directory(
    workspace_root: &Path,
    temporary_path: &Path,
) -> std::result::Result<(), String> {
    let Some(name) = temporary_path.file_name().and_then(|name| name.to_str()) else {
        return Err("拒绝清理无法验证的 Git clone 临时路径".to_string());
    };
    let Some(operation_id) = name.strip_prefix(".codepro-clone-") else {
        return Err("拒绝清理非 Git clone 临时路径".to_string());
    };
    if temporary_path.parent() != Some(workspace_root)
        || uuid::Uuid::parse_str(operation_id).is_err()
    {
        return Err("拒绝清理越界 Git clone 临时路径".to_string());
    }

    let metadata = match tokio::fs::symlink_metadata(temporary_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法检查 Git clone 临时目录".to_string()),
    };
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        tokio::fs::remove_dir_all(temporary_path).await
    } else {
        tokio::fs::remove_file(temporary_path).await
    };
    result.map_err(|_| "无法清理 Git clone 临时目录".to_string())
}

fn working_directory(ctx: &ToolCallContext) -> std::result::Result<PathBuf, String> {
    ctx.working_dir
        .clone()
        .ok_or_else(|| "Git 工具需要当前项目目录".to_string())
}

fn validate_ref(value: &str) -> std::result::Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || value.starts_with('-')
        || value.contains("..")
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '-' | '_' | '.')
        })
    {
        return Err("无效的 Git 引用".to_string());
    }
    Ok(())
}

fn validate_remote(value: &str) -> std::result::Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || value.starts_with('-')
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("无效的 Git 远程名称".to_string());
    }
    Ok(())
}

fn validate_paths(paths: &[String]) -> std::result::Result<(), String> {
    if paths.len() > MAX_PATHS {
        return Err(format!("一次最多处理 {MAX_PATHS} 个路径"));
    }
    for value in paths {
        let path = Path::new(value);
        if value.is_empty()
            || value.len() > 1024
            || path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(format!("无效的仓库相对路径: {value}"));
        }
    }
    Ok(())
}

fn repository_relative_path(
    cwd_relative: &Path,
    value: &str,
) -> std::result::Result<String, String> {
    let path = cwd_relative.join(value);
    let parts = path
        .components()
        .map(|component| match component {
            Component::Normal(part) => part
                .to_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("无效的仓库相对路径: {value}")),
            _ => Err(format!("无效的仓库相对路径: {value}")),
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(parts.join("/"))
}

fn parse_status_entries(bytes: &[u8]) -> Vec<GitStatusEntry> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let renamed = matches!(record[0], b'R' | b'C') || matches!(record[1], b'R' | b'C');
        let original_path = renamed
            .then(|| records.next())
            .flatten()
            .map(|path| String::from_utf8_lossy(path).into_owned());
        entries.push(GitStatusEntry {
            index_status: String::from_utf8_lossy(&record[0..1]).into_owned(),
            worktree_status: String::from_utf8_lossy(&record[1..2]).into_owned(),
            path: String::from_utf8_lossy(&record[3..]).into_owned(),
            original_path,
        });
    }
    entries
}

fn parse_unmerged_entries(bytes: &[u8], limit: usize) -> ParsedConflicts {
    let mut stages_by_path = BTreeMap::<String, BTreeSet<u8>>::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(separator) = record.iter().position(|byte| *byte == b'\t') else {
            continue;
        };
        let Some(stage) = std::str::from_utf8(&record[..separator])
            .ok()
            .and_then(|header| header.split_whitespace().next_back())
            .and_then(|stage| stage.parse::<u8>().ok())
            .filter(|stage| matches!(stage, 1..=3))
        else {
            continue;
        };
        let path = String::from_utf8_lossy(&record[separator + 1..]).into_owned();
        if path.is_empty() {
            continue;
        }
        stages_by_path.entry(path).or_default().insert(stage);
    }

    let total_conflicts = stages_by_path.len();
    let conflicts = stages_by_path
        .into_iter()
        .take(limit)
        .map(|(path, stages)| {
            let stages = stages.into_iter().collect::<Vec<_>>();
            let (code, kind) = classify_conflict(&stages);
            GitConflictEntry {
                path,
                code: code.to_string(),
                kind: kind.to_string(),
                stages,
            }
        })
        .collect();
    ParsedConflicts {
        total_conflicts,
        truncated: total_conflicts > limit,
        conflicts,
    }
}

fn classify_conflict(stages: &[u8]) -> (&'static str, &'static str) {
    match stages {
        [1] => ("DD", "both_deleted"),
        [2] => ("AU", "added_by_us"),
        [3] => ("UA", "added_by_them"),
        [1, 2] => ("UD", "deleted_by_them"),
        [1, 3] => ("DU", "deleted_by_us"),
        [2, 3] => ("AA", "both_added"),
        [1, 2, 3] => ("UU", "both_modified"),
        _ => ("unknown", "unknown"),
    }
}

fn parse_arguments<T: DeserializeOwned>(
    arguments: Option<JsonObject>,
) -> std::result::Result<T, String> {
    serde_json::from_value(
        arguments.map_or_else(|| serde_json::json!({}), serde_json::Value::Object),
    )
    .map_err(|error| format!("参数无效: {error}"))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let prefix = value
        .get(..end)
        .expect("end was moved to a UTF-8 character boundary");
    (format!("{prefix}\n…输出已截断…"), true)
}

pub(crate) fn is_sensitive_git_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let basename = normalized.rsplit('/').next().unwrap_or(&normalized);
    if matches!(basename, ".env.example" | ".env.sample" | ".env.template") {
        return false;
    }
    if basename == ".env" || basename.starts_with(".env.") {
        return true;
    }
    if matches!(
        basename,
        "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | ".npmrc"
            | ".pypirc"
            | ".netrc"
            | "credentials.json"
            | "service-account.json"
    ) {
        return true;
    }
    if [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]
        .iter()
        .any(|suffix| basename.ends_with(suffix))
    {
        return true;
    }
    normalized.starts_with(".ssh/")
        || normalized.contains("/.ssh/")
        || normalized == ".aws/credentials"
        || normalized.ends_with("/.aws/credentials")
}

fn sanitize_remote_destination(value: &str) -> String {
    let sanitized = GIT_URL_CREDENTIALS.replace_all(value.trim(), "$1");
    if !sanitized.contains("://") {
        if let Some((_, destination)) = sanitized.split_once('@') {
            if destination.contains(':') {
                return destination.to_string();
            }
        }
    }
    sanitized.into_owned()
}

fn redact_git_detail(value: &str) -> String {
    GIT_URL_CREDENTIALS
        .replace_all(value, "${1}<credentials>@")
        .into_owned()
}

fn success_json(value: &impl Serialize) -> std::result::Result<CallToolResult, String> {
    serde_json::to_string(value)
        .map(|json| CallToolResult::success(vec![Content::text(json)]))
        .map_err(|error| format!("无法序列化 Git 结果: {error}"))
}

fn result_json(result: &CallToolResult) -> std::result::Result<serde_json::Value, String> {
    match result.content.first().map(|content| &content.raw) {
        Some(RawContent::Text(text)) => serde_json::from_str(&text.text)
            .map_err(|error| format!("无法解析 Git 快照结果: {error}")),
        _ => Err("Git 快照结果缺少文本内容".to_string()),
    }
}

fn diff_arguments(scope: &str) -> JsonObject {
    let mut arguments = JsonObject::new();
    arguments.insert(
        "scope".to_string(),
        serde_json::Value::String(scope.to_string()),
    );
    arguments.insert("base".to_string(), serde_json::Value::Null);
    arguments.insert("paths".to_string(), serde_json::Value::Array(Vec::new()));
    arguments
}

fn read_only_tool<T: JsonSchema>(name: &'static str, description: &'static str) -> Tool {
    tool::<T>(name, description, true, false, true, false)
}

fn read_only_open_world_tool<T: JsonSchema>(name: &'static str, description: &'static str) -> Tool {
    tool::<T>(name, description, true, false, true, true)
}

fn write_tool<T: JsonSchema>(
    name: &'static str,
    description: &'static str,
    open_world: bool,
) -> Tool {
    tool::<T>(name, description, false, true, false, open_world)
}

fn tool<T: JsonSchema>(
    name: &'static str,
    description: &'static str,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
) -> Tool {
    let spec = codepro_tool_spec(name).expect("Git tool must have a registered CodePro ToolSpec");
    debug_assert_eq!(spec.description, description);
    debug_assert_eq!(spec.permission.is_read_only(), read_only);
    debug_assert_eq!(spec.destructive, destructive);
    debug_assert_eq!(spec.idempotent, idempotent);
    debug_assert_eq!(spec.open_world, open_world);
    spec.to_tool::<T>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_git_paths_are_fixed_and_allow_documented_templates() {
        for path in [
            ".env",
            "config/.ENV.local",
            "keys/server.PEM",
            "secrets\\ID_ED25519",
            "profile/.ssh/config",
            "profile/.aws/credentials",
            "config/credentials.json",
            "android/release.keystore",
            ".npmrc",
        ] {
            assert!(is_sensitive_git_path(path), "{path} must be blocked");
        }

        for path in [
            ".env.example",
            "config/.env.sample",
            "config/.env.template",
            "src/environment.ts",
            "keys/public.pem.example",
            "docs/credentials.json.example",
        ] {
            assert!(!is_sensitive_git_path(path), "{path} must be allowed");
        }
    }

    #[test]
    fn remote_destination_removes_url_and_scp_userinfo() {
        let https =
            sanitize_remote_destination("https://automation:secret-token@github.com/acme/repo.git");
        assert_eq!(https, "https://github.com/acme/repo.git");
        assert!(!https.contains("automation"));
        assert!(!https.contains("secret-token"));

        let scp = sanitize_remote_destination("git@github.com:acme/repo.git");
        assert_eq!(scp, "github.com:acme/repo.git");
        assert!(!scp.contains("git@"));
    }

    #[test]
    fn every_git_tool_is_backed_by_the_registry() {
        assert_eq!(GitClient::tools().len(), 27);
    }

    #[test]
    fn github_clone_sources_are_credential_free_and_host_restricted() {
        assert_eq!(
            validate_github_clone_url("https://github.com/acme/repo.git").unwrap(),
            "https://github.com/acme/repo.git"
        );
        assert_eq!(
            validate_github_clone_url("HTTPS://GITHUB.COM/acme/repo").unwrap(),
            "https://github.com/acme/repo"
        );

        for source in [
            "https://automation:secret-token@github.com/acme/repo.git",
            "https://gitlab.com/acme/repo.git",
            "https://127.0.0.1/acme/repo.git",
            "https://github.com:443/acme/repo.git",
            "https://github.com:8443/acme/repo.git",
            "https://github.com/acme/repo.git?token=secret-token",
            "https://github.com/acme/repo.git#main",
            "git@github.com:acme/repo.git",
            "file:///tmp/repo.git",
            "https://github.com/acme/team/repo.git",
            "https://github.com/acme/repo%2Fextra.git",
        ] {
            let error = validate_github_clone_url(source).unwrap_err();
            assert!(!error.contains("secret-token"));
        }
    }

    #[test]
    fn clone_destinations_are_single_portable_child_names() {
        for destination in ["repo", "repo.git", "CodeBuddy_1", "project-2"] {
            validate_clone_destination(destination).unwrap();
        }

        for destination in [
            "",
            "../repo",
            "nested/repo",
            "nested\\repo",
            ".hidden",
            ".git",
            ".codepro-clone-123",
            "CON",
            "nul.txt",
            "repo.",
            "repo ",
            "repo name",
        ] {
            assert!(
                validate_clone_destination(destination).is_err(),
                "{destination:?} must be rejected"
            );
        }
    }

    #[test]
    fn clone_environment_removes_git_injection_and_proxy_variables() {
        for name in [
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_PARAMETERS",
            "GIT_DIR",
            "GIT_WORK_TREE",
        ] {
            assert!(
                GIT_REPOSITORY_REMOVED_ENVIRONMENT.contains(&name),
                "{name} must not reach any structured git command"
            );
        }

        for name in ["GIT_SSH_COMMAND", "HTTPS_PROXY", "https_proxy"] {
            assert!(
                CLONE_REMOVED_ENVIRONMENT.contains(&name),
                "{name} must not reach git clone"
            );
        }
    }

    #[test]
    fn clone_source_probe_preserves_lifecycle_errors() {
        assert_eq!(
            sanitize_clone_source_probe_error("Git 操作已停止".to_string()),
            "Git 操作已停止"
        );
        assert_eq!(
            sanitize_clone_source_probe_error("Git 操作超过 120 秒上限".to_string()),
            "Git 操作超过 120 秒上限"
        );
        assert_eq!(
            sanitize_clone_source_probe_error("fatal: not a git repository".to_string()),
            "本地 clone 源不是可用 Git 仓库"
        );
    }

    #[test]
    fn conflict_stage_sets_have_stable_semantics() {
        for (stages, expected_code, expected_kind) in [
            (vec![1], "DD", "both_deleted"),
            (vec![2], "AU", "added_by_us"),
            (vec![3], "UA", "added_by_them"),
            (vec![1, 2], "UD", "deleted_by_them"),
            (vec![1, 3], "DU", "deleted_by_us"),
            (vec![2, 3], "AA", "both_added"),
            (vec![1, 2, 3], "UU", "both_modified"),
        ] {
            assert_eq!(classify_conflict(&stages), (expected_code, expected_kind));
        }
        assert_eq!(classify_conflict(&[]), ("unknown", "unknown"));
        assert_eq!(classify_conflict(&[1, 4]), ("unknown", "unknown"));
    }

    #[test]
    fn unmerged_index_records_are_nul_safe_bounded_and_stable() {
        let input = concat!(
            "100644 aaaa 3\tz.txt\0",
            "100644 bbbb 1\tz.txt\0",
            "100644 cccc 2\tz.txt\0",
            "100644 dddd 2\ta file.txt\0",
            "100644 eeee 3\ta file.txt\0",
            "100644 ffff 1\tline\nbreak.txt\0",
            "100644 gggg 2\tline\nbreak.txt\0",
            "malformed\0",
        );
        let parsed = parse_unmerged_entries(input.as_bytes(), 2);

        assert_eq!(parsed.total_conflicts, 3);
        assert!(parsed.truncated);
        assert_eq!(parsed.conflicts.len(), 2);
        assert_eq!(parsed.conflicts[0].path, "a file.txt");
        assert_eq!(parsed.conflicts[0].code, "AA");
        assert_eq!(parsed.conflicts[0].stages, vec![2, 3]);
        assert_eq!(parsed.conflicts[1].path, "line\nbreak.txt");
        assert_eq!(parsed.conflicts[1].code, "UD");
        assert_eq!(parsed.conflicts[1].stages, vec![1, 2]);
    }
}
