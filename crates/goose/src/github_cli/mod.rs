mod models;

pub use models::{
    CreateIssueInput, CreatePullRequestInput, CreatedIssue, CreatedPullRequest, GhAuthStatus,
    GhCheckBucket, GhCommand, GhCommandOutput, GhIssue, GhIssueState, GhPullRequest,
    GhPullRequestState, GhRequiredCheck, GhRunError, GitHubCliError, GitHubCliErrorCode,
    GitRepositoryContext, IssueStateChange, PullRequestStateChange, RemoteWriteAuthorization,
    UpdateIssueContentInput, UpdatePullRequestContentInput,
};

use crate::github_auth::pull_requests::{valid_branch_component, valid_remote_name};
use async_trait::async_trait;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use url::Url;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;

#[async_trait]
pub trait GhRunner: Send + Sync {
    async fn run(&self, command: GhCommand) -> Result<GhCommandOutput, GhRunError>;
}

#[derive(Debug, Clone, Default)]
pub struct ProcessGhRunner;

#[async_trait]
impl GhRunner for ProcessGhRunner {
    async fn run(&self, command: GhCommand) -> Result<GhCommandOutput, GhRunError> {
        let valid_executable = matches!(command.executable.as_str(), "gh" | "git");
        let valid_stdin = match command.executable.as_str() {
            "gh" => command
                .stdin
                .as_ref()
                .is_none_or(|value| value.len() <= MAX_BODY_BYTES),
            "git" => command.stdin.is_none(),
            _ => false,
        };
        if !valid_executable || !valid_stdin {
            return Err(GhRunError::Io);
        }

        let mut child = Command::new(&command.executable)
            .args(&command.args)
            .current_dir(&command.cwd)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    GhRunError::Unavailable
                } else {
                    GhRunError::Io
                }
            })?;

        let stdin_task = if let Some(input) = command.stdin {
            let mut stdin = child.stdin.take().ok_or(GhRunError::Io)?;
            Some(tokio::spawn(async move {
                stdin.write_all(&input).await.map_err(|_| GhRunError::Io)?;
                stdin.shutdown().await.map_err(|_| GhRunError::Io)
            }))
        } else {
            None
        };

        let stdout = child.stdout.take().ok_or(GhRunError::Io)?;
        let stderr = child.stderr.take().ok_or(GhRunError::Io)?;
        let stdout_task = tokio::spawn(read_bounded(stdout));
        let stderr_task = tokio::spawn(read_bounded(stderr));

        let wait_result = tokio::select! {
            _ = command.cancellation.cancelled() => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                Err(GhRunError::Cancelled)
            }
            result = tokio::time::timeout(command.timeout, child.wait()) => match result {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(_)) => Err(GhRunError::Io),
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    Err(GhRunError::TimedOut)
                }
            }
        };

        let stdout = stdout_task.await.map_err(|_| GhRunError::Io)??;
        let stderr = stderr_task.await.map_err(|_| GhRunError::Io)??;
        let status = match wait_result {
            Ok(status) => {
                if let Some(task) = stdin_task {
                    task.await.map_err(|_| GhRunError::Io)??;
                }
                status
            }
            Err(error) => {
                if let Some(task) = stdin_task {
                    task.abort();
                }
                return Err(error);
            }
        };
        Ok(GhCommandOutput {
            exit_code: status.code().unwrap_or(1),
            stdout,
            stderr,
        })
    }
}

async fn read_bounded(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, GhRunError> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await.map_err(|_| GhRunError::Io)?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > MAX_OUTPUT_BYTES {
            return Err(GhRunError::OutputTooLarge);
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

#[derive(Debug, Clone)]
pub struct GitHubCli<Runner> {
    runner: Runner,
}

impl<Runner> GitHubCli<Runner>
where
    Runner: GhRunner,
{
    pub const fn new(runner: Runner) -> Self {
        Self { runner }
    }

    pub async fn inspect_repository(
        &self,
        cwd: &Path,
    ) -> Result<GitRepositoryContext, GitHubCliError> {
        let inside = self
            .runner
            .run(git_command(cwd, ["rev-parse", "--is-inside-work-tree"]))
            .await
            .map_err(run_error)?;
        if inside.exit_code != 0 || bounded_text(&inside.stdout, 16)? != "true" {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::NotGitRepository,
                "The selected workspace is not a Git repository",
            ));
        }

        let branch = self
            .runner
            .run(git_command(
                cwd,
                ["symbolic-ref", "--quiet", "--short", "HEAD"],
            ))
            .await
            .map_err(run_error)?;
        if branch.exit_code != 0 {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::DetachedHead,
                "The Git repository has no active branch",
            ));
        }
        let head_branch = bounded_text(&branch.stdout, 255)?;
        if !valid_component(head_branch) {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::DetachedHead,
                "The Git repository has no valid active branch",
            ));
        }

        let remote = self
            .runner
            .run(git_command(cwd, ["remote", "get-url", "origin"]))
            .await
            .map_err(run_error)?;
        if remote.exit_code != 0 {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::NoRemote,
                "The Git repository has no origin remote",
            ));
        }
        let remote = bounded_text(&remote.stdout, 2048)?;
        let (owner, name) = parse_github_remote(remote).ok_or_else(|| {
            GitHubCliError::new(
                GitHubCliErrorCode::UnsupportedRemote,
                "The origin remote is not a supported GitHub repository",
            )
        })?;
        Ok(GitRepositoryContext {
            url: format!("https://github.com/{owner}/{name}"),
            owner,
            name,
            head_branch: head_branch.to_string(),
        })
    }

    pub async fn auth_status(&self, cwd: &Path) -> Result<GhAuthStatus, GitHubCliError> {
        let output = self
            .runner
            .run(command(
                cwd,
                [
                    "auth",
                    "status",
                    "--active",
                    "--hostname",
                    "github.com",
                    "--json",
                    "hosts",
                ],
                None,
            ))
            .await
            .map_err(run_error)?;
        if output.exit_code != 0 {
            return Err(exit_error(output.exit_code));
        }
        let parsed: AuthStatus = parse_json(&output.stdout)?;
        let active = parsed
            .hosts
            .get("github.com")
            .and_then(|accounts| accounts.iter().find(|account| account.active));
        match active {
            Some(account) if account.state == "success" && !account.login.trim().is_empty() => {
                Ok(GhAuthStatus::Authenticated {
                    login: account.login.clone(),
                })
            }
            _ => Ok(GhAuthStatus::NotAuthenticated),
        }
    }

    pub async fn required_checks(
        &self,
        cwd: &Path,
        pull_request: &str,
    ) -> Result<Vec<GhRequiredCheck>, GitHubCliError> {
        if pull_request.trim().is_empty() || pull_request.len() > 256 {
            return Err(invalid_input());
        }
        let output = self
            .runner
            .run(command(
                cwd,
                [
                    "pr",
                    "checks",
                    pull_request,
                    "--required",
                    "--json",
                    "name,state,bucket,link,description",
                ],
                None,
            ))
            .await
            .map_err(run_error)?;
        if !matches!(output.exit_code, 0 | 8) {
            return Err(exit_error(output.exit_code));
        }
        let checks: Vec<GhRequiredCheck> = parse_json(&output.stdout)?;
        if checks.iter().any(|check| {
            check.name.trim().is_empty()
                || check.name.len() > 512
                || check.state.len() > 128
                || check.description.len() > 4096
                || !valid_github_url(&check.link)
        }) {
            return Err(invalid_response());
        }
        Ok(checks)
    }

    pub async fn current_pull_request(
        &self,
        cwd: &Path,
        head_branch: &str,
    ) -> Result<Option<GhPullRequest>, GitHubCliError> {
        if !valid_component(head_branch) {
            return Err(invalid_input());
        }
        let fields = "number,title,body,state,url,headRefName,baseRefName,isDraft";
        let listed = self
            .runner
            .run(command(
                cwd,
                [
                    "pr",
                    "list",
                    "--head",
                    head_branch,
                    "--state",
                    "all",
                    "--limit",
                    "1",
                    "--json",
                    fields,
                ],
                None,
            ))
            .await
            .map_err(run_error)?;
        if listed.exit_code != 0 {
            return Err(exit_error(listed.exit_code));
        }
        let candidates: Vec<GhPullRequest> = parse_json(&listed.stdout)?;
        let Some(candidate) = candidates.first() else {
            return Ok(None);
        };
        if candidates.len() != 1 || !valid_pull_request(candidate, Some(head_branch)) {
            return Err(invalid_response());
        }

        let viewed = self
            .runner
            .run(command_owned(
                cwd,
                vec![
                    "pr".to_string(),
                    "view".to_string(),
                    candidate.number.to_string(),
                    "--json".to_string(),
                    fields.to_string(),
                ],
                None,
            ))
            .await
            .map_err(run_error)?;
        if viewed.exit_code != 0 {
            return Err(exit_error(viewed.exit_code));
        }
        let pull_request: GhPullRequest = parse_json(&viewed.stdout)?;
        if pull_request.number != candidate.number
            || !valid_pull_request(&pull_request, Some(head_branch))
        {
            return Err(invalid_response());
        }
        Ok(Some(pull_request))
    }

    pub async fn list_issues(
        &self,
        cwd: &Path,
        repository_owner: &str,
        repository_name: &str,
    ) -> Result<Vec<GhIssue>, GitHubCliError> {
        let repository = repository_arg(repository_owner, repository_name)?;
        let output = self
            .runner
            .run(command_owned(
                cwd,
                vec![
                    "issue".to_string(),
                    "list".to_string(),
                    "--repo".to_string(),
                    repository,
                    "--state".to_string(),
                    "all".to_string(),
                    "--limit".to_string(),
                    "20".to_string(),
                    "--json".to_string(),
                    "number,title,body,state,url".to_string(),
                ],
                None,
            ))
            .await
            .map_err(run_error)?;
        if output.exit_code != 0 {
            return Err(exit_error(output.exit_code));
        }
        let issues: Vec<GhIssue> = parse_json(&output.stdout)?;
        if issues.len() > 20 || issues.iter().any(|issue| !valid_issue(issue)) {
            return Err(invalid_response());
        }
        Ok(issues)
    }

    pub async fn issue(
        &self,
        cwd: &Path,
        repository_owner: &str,
        repository_name: &str,
        number: u64,
    ) -> Result<GhIssue, GitHubCliError> {
        if number == 0 {
            return Err(invalid_input());
        }
        let repository = repository_arg(repository_owner, repository_name)?;
        let output = self
            .runner
            .run(command_owned(
                cwd,
                vec![
                    "issue".to_string(),
                    "view".to_string(),
                    number.to_string(),
                    "--repo".to_string(),
                    repository,
                    "--json".to_string(),
                    "number,title,body,state,url".to_string(),
                ],
                None,
            ))
            .await
            .map_err(run_error)?;
        if output.exit_code != 0 {
            return Err(exit_error(output.exit_code));
        }
        let issue: GhIssue = parse_json(&output.stdout)?;
        if issue.number != number || !valid_issue(&issue) {
            return Err(invalid_response());
        }
        Ok(issue)
    }

    pub async fn create_issue(
        &self,
        cwd: &Path,
        input: CreateIssueInput,
        authorization: RemoteWriteAuthorization,
    ) -> Result<CreatedIssue, GitHubCliError> {
        ensure_remote_write_authorized(authorization)?;
        if !valid_component(&input.repository_owner) || !valid_component(&input.repository_name) {
            return Err(invalid_input());
        }
        validate_issue_content(&input.title, &input.body)?;
        let repository = repository_arg(&input.repository_owner, &input.repository_name)?;
        let output = self
            .runner
            .run(GhCommand {
                executable: "gh".to_string(),
                args: vec![
                    "issue".to_string(),
                    "create".to_string(),
                    "--repo".to_string(),
                    repository,
                    "--title".to_string(),
                    input.title,
                    "--body-file".to_string(),
                    "-".to_string(),
                ],
                cwd: cwd.to_path_buf(),
                stdin: Some(input.body.into_bytes()),
                timeout: COMMAND_TIMEOUT,
                cancellation: CancellationToken::new(),
            })
            .await
            .map_err(remote_write_error)?;
        if output.exit_code != 0 {
            return Err(remote_write_exit_error());
        }
        parse_created_issue(
            &output.stdout,
            &input.repository_owner,
            &input.repository_name,
        )
        .map_err(|_| {
            GitHubCliError::new(
                GitHubCliErrorCode::UncertainEffect,
                "GitHub accepted the create command but returned an invalid issue receipt",
            )
        })
    }

    pub async fn update_issue_content(
        &self,
        cwd: &Path,
        input: UpdateIssueContentInput,
        authorization: RemoteWriteAuthorization,
    ) -> Result<(), GitHubCliError> {
        ensure_remote_write_authorized(authorization)?;
        if input.number == 0 {
            return Err(invalid_input());
        }
        let repository = repository_arg(&input.repository_owner, &input.repository_name)?;
        validate_issue_content(&input.title, &input.body)?;
        let output = self
            .runner
            .run(command_owned(
                cwd,
                vec![
                    "issue".to_string(),
                    "edit".to_string(),
                    input.number.to_string(),
                    "--repo".to_string(),
                    repository,
                    "--title".to_string(),
                    input.title,
                    "--body-file".to_string(),
                    "-".to_string(),
                ],
                Some(input.body.into_bytes()),
            ))
            .await
            .map_err(remote_write_error)?;
        if output.exit_code != 0 {
            return Err(remote_write_exit_error());
        }
        Ok(())
    }

    pub async fn change_issue_state(
        &self,
        cwd: &Path,
        repository_owner: &str,
        repository_name: &str,
        number: u64,
        change: IssueStateChange,
        authorization: RemoteWriteAuthorization,
    ) -> Result<(), GitHubCliError> {
        ensure_remote_write_authorized(authorization)?;
        if number == 0 {
            return Err(invalid_input());
        }
        let repository = repository_arg(repository_owner, repository_name)?;
        let action = match change {
            IssueStateChange::Close => "close",
            IssueStateChange::Reopen => "reopen",
        };
        let output = self
            .runner
            .run(command_owned(
                cwd,
                vec![
                    "issue".to_string(),
                    action.to_string(),
                    number.to_string(),
                    "--repo".to_string(),
                    repository,
                ],
                None,
            ))
            .await
            .map_err(remote_write_error)?;
        if output.exit_code != 0 {
            return Err(remote_write_exit_error());
        }
        Ok(())
    }

    pub async fn create_pull_request(
        &self,
        cwd: &Path,
        input: CreatePullRequestInput,
        authorization: RemoteWriteAuthorization,
    ) -> Result<CreatedPullRequest, GitHubCliError> {
        if authorization != RemoteWriteAuthorization::Approved {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::UserDenied,
                "GitHub remote write was not authorized",
            ));
        }
        validate_create_input(&input)?;
        let mut args = vec![
            "pr".to_string(),
            "create".to_string(),
            "--head".to_string(),
            input.head_branch.clone(),
            "--title".to_string(),
            input.title.clone(),
        ];
        if let Some(base) = &input.base_branch {
            args.extend(["--base".to_string(), base.clone()]);
        }
        if input.draft {
            args.push("--draft".to_string());
        }
        args.extend(["--body-file".to_string(), "-".to_string()]);
        let output = self
            .runner
            .run(GhCommand {
                executable: "gh".to_string(),
                args,
                cwd: cwd.to_path_buf(),
                stdin: Some(input.body.as_bytes().to_vec()),
                timeout: COMMAND_TIMEOUT,
                cancellation: CancellationToken::new(),
            })
            .await
            .map_err(remote_write_error)?;
        if output.exit_code != 0 {
            return Err(remote_write_exit_error());
        }
        parse_created_pull_request(&output.stdout, &input)
    }

    pub async fn push_branch(
        &self,
        cwd: &Path,
        remote: &str,
        head_branch: &str,
        authorization: RemoteWriteAuthorization,
    ) -> Result<(), GitHubCliError> {
        if authorization != RemoteWriteAuthorization::Approved {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::UserDenied,
                "GitHub remote write was not authorized",
            ));
        }
        if !valid_remote_name(remote) || !valid_branch_component(head_branch) {
            return Err(invalid_input());
        }
        let output = self
            .runner
            .run(GhCommand {
                executable: "git".to_string(),
                args: vec![
                    "push".to_string(),
                    "--porcelain".to_string(),
                    "--set-upstream".to_string(),
                    remote.to_string(),
                    format!("{head_branch}:{head_branch}"),
                ],
                cwd: cwd.to_path_buf(),
                stdin: None,
                timeout: COMMAND_TIMEOUT,
                cancellation: CancellationToken::new(),
            })
            .await
            .map_err(remote_write_error)?;
        if output.exit_code != 0 {
            return Err(remote_write_exit_error());
        }
        Ok(())
    }

    pub async fn change_pull_request_state(
        &self,
        cwd: &Path,
        pull_request_number: u64,
        change: PullRequestStateChange,
        authorization: RemoteWriteAuthorization,
    ) -> Result<(), GitHubCliError> {
        if authorization != RemoteWriteAuthorization::Approved {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::UserDenied,
                "GitHub remote write was not authorized",
            ));
        }
        if pull_request_number == 0 {
            return Err(invalid_input());
        }
        let action = match change {
            PullRequestStateChange::Close => "close",
            PullRequestStateChange::Reopen => "reopen",
        };
        let output = self
            .runner
            .run(command_owned(
                cwd,
                vec![
                    "pr".to_string(),
                    action.to_string(),
                    pull_request_number.to_string(),
                ],
                None,
            ))
            .await
            .map_err(remote_write_error)?;
        if output.exit_code != 0 {
            return Err(remote_write_exit_error());
        }
        Ok(())
    }

    pub async fn update_pull_request_content(
        &self,
        cwd: &Path,
        input: UpdatePullRequestContentInput,
        authorization: RemoteWriteAuthorization,
    ) -> Result<(), GitHubCliError> {
        if authorization != RemoteWriteAuthorization::Approved {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::UserDenied,
                "GitHub remote write was not authorized",
            ));
        }
        if input.number == 0
            || input.title.trim().is_empty()
            || input.title.len() > 256
            || input.title.chars().any(char::is_control)
            || input.body.len() > MAX_BODY_BYTES
        {
            return Err(invalid_input());
        }
        let output = self
            .runner
            .run(command_owned(
                cwd,
                vec![
                    "pr".to_string(),
                    "edit".to_string(),
                    input.number.to_string(),
                    "--title".to_string(),
                    input.title,
                    "--body-file".to_string(),
                    "-".to_string(),
                ],
                Some(input.body.into_bytes()),
            ))
            .await
            .map_err(remote_write_error)?;
        if output.exit_code != 0 {
            return Err(remote_write_exit_error());
        }
        Ok(())
    }
}

fn command<const N: usize>(cwd: &Path, args: [&str; N], stdin: Option<Vec<u8>>) -> GhCommand {
    command_owned(cwd, args.into_iter().map(str::to_string).collect(), stdin)
}

fn command_owned(cwd: &Path, args: Vec<String>, stdin: Option<Vec<u8>>) -> GhCommand {
    GhCommand {
        executable: "gh".to_string(),
        args,
        cwd: PathBuf::from(cwd),
        stdin,
        timeout: COMMAND_TIMEOUT,
        cancellation: CancellationToken::new(),
    }
}

fn git_command<const N: usize>(cwd: &Path, args: [&str; N]) -> GhCommand {
    GhCommand {
        executable: "git".to_string(),
        args: args.into_iter().map(str::to_string).collect(),
        cwd: cwd.to_path_buf(),
        stdin: None,
        timeout: COMMAND_TIMEOUT,
        cancellation: CancellationToken::new(),
    }
}

fn bounded_text(bytes: &[u8], max_len: usize) -> Result<&str, GitHubCliError> {
    if bytes.len() > max_len.saturating_add(2) {
        return Err(invalid_response());
    }
    let value = std::str::from_utf8(bytes)
        .map_err(|_| invalid_response())?
        .trim();
    if value.is_empty() || value.len() > max_len || value.chars().any(char::is_control) {
        return Err(invalid_response());
    }
    Ok(value)
}

fn parse_github_remote(value: &str) -> Option<(String, String)> {
    let path = if let Some(path) = value.strip_prefix("git@github.com:") {
        path.to_string()
    } else {
        let url = Url::parse(value).ok()?;
        let supported = matches!(url.scheme(), "https" | "ssh")
            && url.host_str() == Some("github.com")
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.username().is_empty() || url.username() == "git")
            && url.password().is_none();
        if !supported {
            return None;
        }
        url.path().trim_start_matches('/').to_string()
    };
    let path = path.strip_suffix(".git").unwrap_or(&path);
    let mut segments = path.split('/');
    let owner = segments.next()?;
    let name = segments.next()?;
    if segments.next().is_some()
        || !valid_repository_segment(owner)
        || !valid_repository_segment(name)
    {
        return None;
    }
    Some((owner.to_string(), name.to_string()))
}

fn valid_repository_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_create_input(input: &CreatePullRequestInput) -> Result<(), GitHubCliError> {
    if !valid_component(&input.repository_owner)
        || !valid_component(&input.repository_name)
        || !valid_component(&input.head_branch)
        || input
            .base_branch
            .as_deref()
            .is_some_and(|value| !valid_component(value))
        || input.title.trim().is_empty()
        || input.title.len() > 256
        || input.title.chars().any(char::is_control)
        || input.body.len() > MAX_BODY_BYTES
    {
        return Err(invalid_input());
    }
    Ok(())
}

fn ensure_remote_write_authorized(
    authorization: RemoteWriteAuthorization,
) -> Result<(), GitHubCliError> {
    if authorization != RemoteWriteAuthorization::Approved {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::UserDenied,
            "GitHub remote write was not authorized",
        ));
    }
    Ok(())
}

fn validate_issue_content(title: &str, body: &str) -> Result<(), GitHubCliError> {
    if title.trim().is_empty()
        || title.len() > 256
        || title.chars().any(char::is_control)
        || body.len() > MAX_BODY_BYTES
    {
        return Err(invalid_input());
    }
    Ok(())
}

fn valid_component(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 255
        && !value.chars().any(char::is_control)
        && !value.contains("..")
}

fn repository_arg(owner: &str, name: &str) -> Result<String, GitHubCliError> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 255
            && !value.starts_with('-')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    if !valid(owner) || !valid(name) {
        return Err(invalid_input());
    }
    Ok(format!("{owner}/{name}"))
}

fn valid_pull_request(pull_request: &GhPullRequest, expected_head: Option<&str>) -> bool {
    if pull_request.number == 0
        || pull_request.title.trim().is_empty()
        || pull_request.title.len() > 1024
        || pull_request.title.chars().any(char::is_control)
        || pull_request.body.len() > MAX_BODY_BYTES
        || !valid_component(&pull_request.head_ref_name)
        || !valid_component(&pull_request.base_ref_name)
        || expected_head.is_some_and(|head| pull_request.head_ref_name != head)
    {
        return false;
    }
    Url::parse(&pull_request.url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url
                .path()
                .ends_with(&format!("/pull/{}", pull_request.number))
    })
}

fn valid_issue(issue: &GhIssue) -> bool {
    if issue.number == 0
        || issue.title.trim().is_empty()
        || issue.title.len() > 256
        || issue.title.chars().any(char::is_control)
        || issue.body.len() > MAX_BODY_BYTES
    {
        return false;
    }
    Url::parse(&issue.url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path().ends_with(&format!("/issues/{}", issue.number))
    })
}

fn parse_created_pull_request(
    stdout: &[u8],
    input: &CreatePullRequestInput,
) -> Result<CreatedPullRequest, GitHubCliError> {
    let value = std::str::from_utf8(stdout)
        .map_err(|_| invalid_response())?
        .trim();
    let url = Url::parse(value).map_err(|_| invalid_response())?;
    let expected_prefix = format!(
        "/{}/{}/pull/",
        input.repository_owner, input.repository_name
    );
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with(&expected_prefix)
    {
        return Err(invalid_response());
    }
    let number = url
        .path()
        .strip_prefix(&expected_prefix)
        .ok_or_else(invalid_response)?
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(invalid_response)?;
    Ok(CreatedPullRequest {
        number,
        url: value.to_string(),
    })
}

fn parse_created_issue(
    stdout: &[u8],
    repository_owner: &str,
    repository_name: &str,
) -> Result<CreatedIssue, GitHubCliError> {
    let value = std::str::from_utf8(stdout)
        .map_err(|_| invalid_response())?
        .trim();
    let url = Url::parse(value).map_err(|_| invalid_response())?;
    let segments = url
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .ok_or_else(invalid_response)?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || segments.len() != 4
        || segments[2] != "issues"
        || !segments[0].eq_ignore_ascii_case(repository_owner)
        || !segments[1].eq_ignore_ascii_case(repository_name)
    {
        return Err(invalid_response());
    }
    let number = segments[3]
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(invalid_response)?;
    Ok(CreatedIssue {
        number,
        url: value.to_string(),
    })
}

fn valid_github_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
    })
}

fn parse_json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, GitHubCliError> {
    serde_json::from_slice(bytes).map_err(|_| invalid_response())
}

fn run_error(error: GhRunError) -> GitHubCliError {
    match error {
        GhRunError::Unavailable => GitHubCliError::new(
            GitHubCliErrorCode::Unavailable,
            "GitHub CLI is not installed or cannot be started",
        ),
        GhRunError::TimedOut => {
            GitHubCliError::new(GitHubCliErrorCode::TimedOut, "GitHub CLI command timed out")
        }
        GhRunError::Cancelled => GitHubCliError::new(
            GitHubCliErrorCode::Cancelled,
            "GitHub CLI command was cancelled",
        ),
        GhRunError::OutputTooLarge => GitHubCliError::new(
            GitHubCliErrorCode::OutputTooLarge,
            "GitHub CLI output exceeded the safety limit",
        ),
        GhRunError::Io => GitHubCliError::new(
            GitHubCliErrorCode::CommandFailed,
            "GitHub CLI command could not be completed",
        ),
    }
}

fn remote_write_error(error: GhRunError) -> GitHubCliError {
    match error {
        GhRunError::Unavailable => run_error(error),
        GhRunError::TimedOut
        | GhRunError::Cancelled
        | GhRunError::OutputTooLarge
        | GhRunError::Io => GitHubCliError::new(
            GitHubCliErrorCode::UncertainEffect,
            "The GitHub remote write result is uncertain; inspect GitHub before retrying",
        ),
    }
}

const fn remote_write_exit_error() -> GitHubCliError {
    GitHubCliError::new(
        GitHubCliErrorCode::UncertainEffect,
        "The GitHub remote write result is uncertain; inspect GitHub before retrying",
    )
}

fn exit_error(exit_code: i32) -> GitHubCliError {
    if exit_code == 4 {
        GitHubCliError::new(
            GitHubCliErrorCode::NotAuthenticated,
            "GitHub CLI authentication is required",
        )
    } else {
        GitHubCliError::new(
            GitHubCliErrorCode::CommandFailed,
            "GitHub CLI command failed",
        )
    }
}

const fn invalid_input() -> GitHubCliError {
    GitHubCliError::new(
        GitHubCliErrorCode::InvalidInput,
        "GitHub CLI request is invalid",
    )
}

const fn invalid_response() -> GitHubCliError {
    GitHubCliError::new(
        GitHubCliErrorCode::InvalidResponse,
        "GitHub CLI returned an invalid response",
    )
}

#[derive(Debug, Deserialize)]
struct AuthStatus {
    hosts: BTreeMap<String, Vec<AuthAccount>>,
}

#[derive(Debug, Deserialize)]
struct AuthAccount {
    active: bool,
    login: String,
    state: String,
}
