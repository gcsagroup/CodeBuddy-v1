use super::pull_requests::{
    output_text, parse_github_remote, run_git, valid_branch_component, valid_remote_name,
    verified_sha, GitHubPullRequestError, GitHubRepository,
};
use futures::StreamExt;
use goose_sdk_types::custom_requests::{
    GitHubCiAggregateStatus, GitHubCiRun, GitHubCiRunConclusion, GitHubCiRunStatus,
    GitHubCiStatusRequest, GitHubCiStatusResponse,
};
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

const MAX_CI_RESPONSE_BYTES: usize = 128 * 1024;
const MAX_CI_RUNS: usize = 50;

#[derive(Debug, Clone)]
pub(crate) struct LocalCiTarget {
    pub(crate) repository: GitHubRepository,
    pub(crate) repository_root: PathBuf,
    pub(crate) remote: String,
    pub(crate) branch: String,
    pub(crate) head_sha: String,
    pub(crate) working_tree_dirty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubCiError {
    #[error("The project directory must be an existing absolute directory")]
    InvalidDirectory,
    #[error("The project directory is not a Git repository")]
    NotGitRepository,
    #[error("The Git repository is in detached HEAD state")]
    DetachedHead,
    #[error("The current branch does not have a supported upstream")]
    MissingUpstream,
    #[error("The upstream branch must match the current branch")]
    UpstreamMismatch,
    #[error("Only canonical github.com repository remotes are supported")]
    UnsupportedRemote,
    #[error("The current HEAD has not been pushed to its upstream branch")]
    HeadNotPushed,
    #[error("Git is unavailable or a bounded Git command failed")]
    GitFailed,
    #[error("Git output exceeded the safety limit")]
    GitOutputTooLarge,
    #[error("The GitHub API endpoint is invalid")]
    InvalidApiBase,
    #[error("The GitHub API is unavailable")]
    NetworkUnavailable,
    #[error("GitHub rejected the CI status request")]
    GitHubRejected,
    #[error("GitHub returned an invalid CI status response")]
    InvalidGitHubResponse,
    #[error("The GitHub response exceeded the safety limit")]
    GitHubResponseTooLarge,
    #[error("GitHub is not connected or the stored authorization has expired")]
    NotAuthenticated,
    #[error("The GitHub credential could not be read from secure storage")]
    CredentialUnavailable,
}

impl GitHubCiError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidDirectory => "invalid_directory",
            Self::NotGitRepository => "not_git_repository",
            Self::DetachedHead => "detached_head",
            Self::MissingUpstream => "missing_upstream",
            Self::UpstreamMismatch => "upstream_mismatch",
            Self::UnsupportedRemote => "unsupported_remote",
            Self::HeadNotPushed => "head_not_pushed",
            Self::GitFailed => "git_failed",
            Self::GitOutputTooLarge => "git_output_too_large",
            Self::InvalidApiBase => "invalid_api_base",
            Self::NetworkUnavailable => "network_unavailable",
            Self::GitHubRejected => "github_rejected",
            Self::InvalidGitHubResponse => "invalid_github_response",
            Self::GitHubResponseTooLarge => "github_response_too_large",
            Self::NotAuthenticated => "not_authenticated",
            Self::CredentialUnavailable => "credential_unavailable",
        }
    }
}

fn git_error(error: GitHubPullRequestError) -> GitHubCiError {
    match error {
        GitHubPullRequestError::GitOutputTooLarge => GitHubCiError::GitOutputTooLarge,
        _ => GitHubCiError::GitFailed,
    }
}

impl super::GitHubAuthService {
    pub(crate) async fn ci_status(
        &self,
        request: GitHubCiStatusRequest,
    ) -> Result<GitHubCiStatusResponse, GitHubCiError> {
        let target = inspect_local_ci_target(Path::new(&request.working_dir)).await?;
        let access_token = self
            .active_access_token()
            .await
            .map_err(|error| match error {
                GitHubPullRequestError::NotAuthenticated => GitHubCiError::NotAuthenticated,
                _ => GitHubCiError::CredentialUnavailable,
            })?;
        self.ci_client.status(&access_token, &target).await
    }
}

pub(crate) async fn inspect_local_ci_target(
    working_dir: &Path,
) -> Result<LocalCiTarget, GitHubCiError> {
    if !working_dir.is_absolute() || !working_dir.is_dir() {
        return Err(GitHubCiError::InvalidDirectory);
    }
    let working_dir = tokio::fs::canonicalize(working_dir)
        .await
        .map_err(|_| GitHubCiError::InvalidDirectory)?;
    let root = run_git(&working_dir, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| GitHubCiError::NotGitRepository)?;
    let root = output_text(&root).map_err(|_| GitHubCiError::NotGitRepository)?;
    let repository_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| GitHubCiError::NotGitRepository)?;
    let working_tree_dirty = !run_git(
        &repository_root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await
    .map_err(git_error)?
    .is_empty();

    let branch = output_text(
        &run_git(
            &repository_root,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )
        .await
        .map_err(|_| GitHubCiError::DetachedHead)?,
    )
    .map_err(|_| GitHubCiError::DetachedHead)?;
    if !valid_branch_component(&branch) {
        return Err(GitHubCiError::DetachedHead);
    }

    let remote_key = format!("branch.{branch}.remote");
    let remote = output_text(
        &run_git(&repository_root, &["config", "--get", &remote_key])
            .await
            .map_err(|_| GitHubCiError::MissingUpstream)?,
    )
    .map_err(|_| GitHubCiError::MissingUpstream)?;
    if !valid_remote_name(&remote) {
        return Err(GitHubCiError::MissingUpstream);
    }
    let merge_key = format!("branch.{branch}.merge");
    let merge_ref = output_text(
        &run_git(&repository_root, &["config", "--get", &merge_key])
            .await
            .map_err(|_| GitHubCiError::MissingUpstream)?,
    )
    .map_err(|_| GitHubCiError::MissingUpstream)?;
    if merge_ref != format!("refs/heads/{branch}") {
        return Err(GitHubCiError::UpstreamMismatch);
    }

    let remote_url = output_text(
        &run_git(&repository_root, &["remote", "get-url", &remote])
            .await
            .map_err(|_| GitHubCiError::UnsupportedRemote)?,
    )
    .map_err(|_| GitHubCiError::UnsupportedRemote)?;
    let repository =
        parse_github_remote(&remote_url).map_err(|_| GitHubCiError::UnsupportedRemote)?;
    let head_sha = verified_sha(&repository_root, "HEAD")
        .await
        .map_err(git_error)?;
    let remote_ref = format!("refs/remotes/{remote}/{branch}");
    let remote_sha = verified_sha(&repository_root, &remote_ref)
        .await
        .map_err(|_| GitHubCiError::HeadNotPushed)?;
    if remote_sha != head_sha {
        return Err(GitHubCiError::HeadNotPushed);
    }

    Ok(LocalCiTarget {
        repository,
        repository_root,
        remote,
        branch,
        head_sha,
        working_tree_dirty,
    })
}

#[derive(Clone)]
pub(crate) struct GitHubCiClient {
    pub(super) client: reqwest::Client,
    pub(super) api_base: Url,
}

#[derive(Deserialize)]
struct WorkflowRunsResponse {
    total_count: u64,
    workflow_runs: Vec<WorkflowRunResponse>,
}

#[derive(Deserialize)]
struct WorkflowRunResponse {
    id: u64,
    name: String,
    run_number: u64,
    run_attempt: u64,
    event: String,
    status: String,
    conclusion: Option<String>,
    html_url: String,
    head_branch: Option<String>,
    head_sha: String,
    created_at: String,
    updated_at: String,
}

impl GitHubCiClient {
    pub(crate) fn production() -> Result<Self, GitHubCiError> {
        Self::new("https://api.github.com/", false)
    }

    #[cfg(test)]
    pub(crate) fn for_test(api_base: &str) -> Result<Self, GitHubCiError> {
        Self::new(api_base, true)
    }

    fn new(api_base: &str, allow_loopback: bool) -> Result<Self, GitHubCiError> {
        let mut api_base = Url::parse(api_base).map_err(|_| GitHubCiError::InvalidApiBase)?;
        let production = api_base.scheme() == "https"
            && api_base.host_str() == Some("api.github.com")
            && api_base.port().is_none();
        let loopback = allow_loopback
            && matches!(api_base.scheme(), "http" | "https")
            && api_base.host().is_some_and(|host| match host {
                url::Host::Ipv4(address) => address.is_loopback(),
                url::Host::Ipv6(address) => address.is_loopback(),
                url::Host::Domain(domain) => domain == "localhost",
            });
        if (!production && !loopback)
            || !api_base.username().is_empty()
            || api_base.password().is_some()
            || api_base.query().is_some()
            || api_base.fragment().is_some()
        {
            return Err(GitHubCiError::InvalidApiBase);
        }
        api_base.set_path("/");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .user_agent("CodeBuddy/1.43")
            .build()
            .map_err(|_| GitHubCiError::InvalidApiBase)?;
        Ok(Self { client, api_base })
    }

    pub(crate) async fn status(
        &self,
        access_token: &str,
        target: &LocalCiTarget,
    ) -> Result<GitHubCiStatusResponse, GitHubCiError> {
        let mut endpoint = self
            .api_base
            .join(&format!(
                "repos/{}/{}/actions/runs",
                target.repository.owner, target.repository.name
            ))
            .map_err(|_| GitHubCiError::InvalidApiBase)?;
        endpoint
            .query_pairs_mut()
            .append_pair("head_sha", &target.head_sha)
            .append_pair("per_page", "50")
            .append_pair("page", "1");
        let response = self
            .client
            .get(endpoint)
            .header(ACCEPT, "application/vnd.github+json")
            .header(
                "X-GitHub-Api-Version",
                super::pull_requests::GITHUB_API_VERSION,
            )
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| GitHubCiError::NetworkUnavailable)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(GitHubCiError::GitHubRejected);
        }
        let body = read_ci_json(response).await?;
        let raw = serde_json::from_slice::<WorkflowRunsResponse>(&body)
            .map_err(|_| GitHubCiError::InvalidGitHubResponse)?;
        if raw.workflow_runs.len() > MAX_CI_RUNS || raw.total_count < raw.workflow_runs.len() as u64
        {
            return Err(GitHubCiError::InvalidGitHubResponse);
        }
        let mut runs = Vec::with_capacity(raw.workflow_runs.len());
        for run in raw.workflow_runs {
            runs.push(validate_run(target, run)?);
        }
        Ok(GitHubCiStatusResponse {
            repository_owner: target.repository.owner.clone(),
            repository_name: target.repository.name.clone(),
            repository_url: format!(
                "https://github.com/{}/{}",
                target.repository.owner, target.repository.name
            ),
            branch: target.branch.clone(),
            head_sha: target.head_sha.clone(),
            working_tree_dirty: target.working_tree_dirty,
            aggregate_status: aggregate_status(&runs),
            total_count: raw.total_count,
            truncated: raw.total_count > runs.len() as u64,
            runs,
        })
    }
}

async fn read_ci_json(response: reqwest::Response) -> Result<Vec<u8>, GitHubCiError> {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let media_type = content_type
        .split_once(';')
        .map_or(content_type.as_str(), |(media_type, _)| media_type)
        .trim();
    if !matches!(
        media_type,
        "application/json" | "application/vnd.github+json"
    ) {
        return Err(GitHubCiError::InvalidGitHubResponse);
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_CI_RESPONSE_BYTES)
    {
        return Err(GitHubCiError::GitHubResponseTooLarge);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| GitHubCiError::NetworkUnavailable)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_CI_RESPONSE_BYTES {
            return Err(GitHubCiError::GitHubResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn validate_run(
    target: &LocalCiTarget,
    run: WorkflowRunResponse,
) -> Result<GitHubCiRun, GitHubCiError> {
    if run.id == 0
        || run.run_number == 0
        || run.run_attempt == 0
        || run.head_branch.as_deref() != Some(&target.branch)
        || run.head_sha != target.head_sha
        || !bounded_text(&run.name, 256)
        || !bounded_text(&run.event, 64)
        || chrono::DateTime::parse_from_rfc3339(&run.created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&run.updated_at).is_err()
        || run.html_url
            != format!(
                "https://github.com/{}/{}/actions/runs/{}",
                target.repository.owner, target.repository.name, run.id
            )
    {
        return Err(GitHubCiError::InvalidGitHubResponse);
    }
    Ok(GitHubCiRun {
        id: run.id,
        name: run.name,
        run_number: run.run_number,
        attempt: run.run_attempt,
        event: run.event,
        status: map_status(&run.status),
        conclusion: run.conclusion.as_deref().map(map_conclusion),
        html_url: run.html_url,
        created_at: run.created_at,
        updated_at: run.updated_at,
    })
}

fn bounded_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn map_status(value: &str) -> GitHubCiRunStatus {
    match value {
        "queued" => GitHubCiRunStatus::Queued,
        "in_progress" => GitHubCiRunStatus::InProgress,
        "completed" => GitHubCiRunStatus::Completed,
        "waiting" => GitHubCiRunStatus::Waiting,
        "requested" => GitHubCiRunStatus::Requested,
        "pending" => GitHubCiRunStatus::Pending,
        _ => GitHubCiRunStatus::Unknown,
    }
}

fn map_conclusion(value: &str) -> GitHubCiRunConclusion {
    match value {
        "success" => GitHubCiRunConclusion::Success,
        "failure" => GitHubCiRunConclusion::Failure,
        "neutral" => GitHubCiRunConclusion::Neutral,
        "cancelled" => GitHubCiRunConclusion::Cancelled,
        "skipped" => GitHubCiRunConclusion::Skipped,
        "timed_out" => GitHubCiRunConclusion::TimedOut,
        "action_required" => GitHubCiRunConclusion::ActionRequired,
        "stale" => GitHubCiRunConclusion::Stale,
        "startup_failure" => GitHubCiRunConclusion::StartupFailure,
        _ => GitHubCiRunConclusion::Unknown,
    }
}

fn aggregate_status(runs: &[GitHubCiRun]) -> GitHubCiAggregateStatus {
    if runs.is_empty() {
        return GitHubCiAggregateStatus::NoRuns;
    }
    if runs.iter().any(|run| {
        matches!(
            run.status,
            GitHubCiRunStatus::Queued
                | GitHubCiRunStatus::InProgress
                | GitHubCiRunStatus::Waiting
                | GitHubCiRunStatus::Requested
                | GitHubCiRunStatus::Pending
        )
    }) {
        return GitHubCiAggregateStatus::InProgress;
    }
    if runs
        .iter()
        .any(|run| run.status == GitHubCiRunStatus::Unknown)
    {
        return GitHubCiAggregateStatus::Unknown;
    }
    if runs.iter().any(|run| {
        matches!(
            run.conclusion,
            Some(
                GitHubCiRunConclusion::Failure
                    | GitHubCiRunConclusion::TimedOut
                    | GitHubCiRunConclusion::ActionRequired
                    | GitHubCiRunConclusion::Stale
                    | GitHubCiRunConclusion::StartupFailure
            )
        )
    }) {
        return GitHubCiAggregateStatus::Failure;
    }
    if runs
        .iter()
        .any(|run| run.conclusion == Some(GitHubCiRunConclusion::Cancelled))
    {
        return GitHubCiAggregateStatus::Cancelled;
    }
    if runs
        .iter()
        .all(|run| run.conclusion == Some(GitHubCiRunConclusion::Success))
    {
        return GitHubCiAggregateStatus::Success;
    }
    if runs.iter().all(|run| {
        matches!(
            run.conclusion,
            Some(GitHubCiRunConclusion::Neutral | GitHubCiRunConclusion::Skipped)
        )
    }) {
        return GitHubCiAggregateStatus::Neutral;
    }
    GitHubCiAggregateStatus::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;
    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn git(cwd: &Path, arguments: &[&str]) {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(cwd)
            .output()
            .expect("git must start");
        assert!(
            output.status.success(),
            "git {arguments:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn ci_target() -> LocalCiTarget {
        LocalCiTarget {
            repository: GitHubRepository {
                owner: "octo".to_string(),
                name: "demo".to_string(),
            },
            repository_root: PathBuf::from("D:\\demo"),
            remote: "origin".to_string(),
            branch: "main".to_string(),
            head_sha: "1".repeat(40),
            working_tree_dirty: false,
        }
    }

    fn workflow_runs_body(overrides: serde_json::Value) -> serde_json::Value {
        let mut body = serde_json::json!({
            "total_count": 1,
            "workflow_runs": [{
                "id": 42,
                "name": "CI",
                "run_number": 9,
                "run_attempt": 1,
                "event": "push",
                "status": "completed",
                "conclusion": "success",
                "html_url": "https://github.com/octo/demo/actions/runs/42",
                "head_branch": "main",
                "head_sha": "1111111111111111111111111111111111111111",
                "created_at": "2026-08-05T01:00:00Z",
                "updated_at": "2026-08-05T01:01:00Z"
            }]
        });
        if let (Some(body), Some(overrides)) = (body.as_object_mut(), overrides.as_object()) {
            body.extend(overrides.clone());
        }
        body
    }

    fn pushed_repository() -> TempDir {
        let repository = TempDir::new().unwrap();
        git(repository.path(), &["init", "-b", "main"]);
        git(repository.path(), &["config", "user.name", "CodePro Test"]);
        git(
            repository.path(),
            &["config", "user.email", "codepro@example.invalid"],
        );
        std::fs::write(repository.path().join("README.md"), "initial\n").unwrap();
        git(repository.path(), &["add", "README.md"]);
        git(repository.path(), &["commit", "-m", "initial"]);
        git(
            repository.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/octo/demo.git",
            ],
        );
        git(
            repository.path(),
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        git(
            repository.path(),
            &["config", "branch.main.remote", "origin"],
        );
        git(
            repository.path(),
            &["config", "branch.main.merge", "refs/heads/main"],
        );
        repository
    }

    #[tokio::test]
    async fn local_ci_target_allows_dirty_tree_for_the_exact_pushed_head() {
        let repository = pushed_repository();
        std::fs::write(repository.path().join("local.txt"), "not pushed\n").unwrap();

        let target = inspect_local_ci_target(repository.path()).await.unwrap();

        assert_eq!(target.repository.owner, "octo");
        assert_eq!(target.repository.name, "demo");
        assert_eq!(target.branch, "main");
        assert!(target.working_tree_dirty);
        assert!(matches!(target.head_sha.len(), 40 | 64));
    }

    #[tokio::test]
    async fn local_ci_target_rejects_detached_or_unpushed_head() {
        let repository = pushed_repository();
        std::fs::write(repository.path().join("next.txt"), "next\n").unwrap();
        git(repository.path(), &["add", "next.txt"]);
        git(repository.path(), &["commit", "-m", "next"]);
        assert_eq!(
            inspect_local_ci_target(repository.path())
                .await
                .unwrap_err(),
            GitHubCiError::HeadNotPushed
        );

        git(repository.path(), &["checkout", "--detach"]);
        assert_eq!(
            inspect_local_ci_target(repository.path())
                .await
                .unwrap_err(),
            GitHubCiError::DetachedHead
        );
    }

    #[tokio::test]
    async fn github_actions_client_filters_exact_head_and_returns_stable_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/runs"))
            .and(query_param(
                "head_sha",
                "1111111111111111111111111111111111111111",
            ))
            .and(query_param("per_page", "50"))
            .and(query_param("page", "1"))
            .and(header("accept", "application/vnd.github+json"))
            .and(header("x-github-api-version", "2026-03-10"))
            .and(header("authorization", "Bearer test-ci-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 2,
                "workflow_runs": [
                    {
                        "id": 42,
                        "name": "CI",
                        "run_number": 9,
                        "run_attempt": 1,
                        "event": "push",
                        "status": "in_progress",
                        "conclusion": null,
                        "html_url": "https://github.com/octo/demo/actions/runs/42",
                        "head_branch": "main",
                        "head_sha": "1111111111111111111111111111111111111111",
                        "created_at": "2026-08-05T01:00:00Z",
                        "updated_at": "2026-08-05T01:01:00Z"
                    },
                    {
                        "id": 41,
                        "name": "Security",
                        "run_number": 8,
                        "run_attempt": 2,
                        "event": "pull_request",
                        "status": "completed",
                        "conclusion": "success",
                        "html_url": "https://github.com/octo/demo/actions/runs/41",
                        "head_branch": "main",
                        "head_sha": "1111111111111111111111111111111111111111",
                        "created_at": "2026-08-05T00:00:00Z",
                        "updated_at": "2026-08-05T00:10:00Z"
                    }
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = GitHubCiClient::for_test(&server.uri()).unwrap();
        let target = ci_target();

        let response = client.status("test-ci-token", &target).await.unwrap();

        assert_eq!(
            response.aggregate_status,
            GitHubCiAggregateStatus::InProgress
        );
        assert_eq!(response.total_count, 2);
        assert_eq!(response.runs.len(), 2);
        assert_eq!(
            response.runs[1].conclusion,
            Some(GitHubCiRunConclusion::Success)
        );
    }

    #[tokio::test]
    async fn github_actions_client_rejects_redirects_and_non_json_content_types() {
        let redirect_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/runs"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", "https://attacker.invalid/steal"),
            )
            .expect(1)
            .mount(&redirect_server)
            .await;
        let redirect_client = GitHubCiClient::for_test(&redirect_server.uri()).unwrap();
        assert_eq!(
            redirect_client
                .status("secret-ci-token", &ci_target())
                .await
                .unwrap_err(),
            GitHubCiError::GitHubRejected
        );

        let content_type_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/runs"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(
                        serde_json::to_vec(&workflow_runs_body(serde_json::json!({}))).unwrap(),
                    )
                    .insert_header("content-type", "application/jsonevil"),
            )
            .expect(1)
            .mount(&content_type_server)
            .await;
        let content_type_client = GitHubCiClient::for_test(&content_type_server.uri()).unwrap();
        assert_eq!(
            content_type_client
                .status("secret-ci-token", &ci_target())
                .await
                .unwrap_err(),
            GitHubCiError::InvalidGitHubResponse
        );
    }

    #[tokio::test]
    async fn github_actions_client_rejects_oversized_or_forged_responses() {
        let oversized_server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_bytes(vec![b'x'; MAX_CI_RESPONSE_BYTES + 1]),
            )
            .expect(1)
            .mount(&oversized_server)
            .await;
        let oversized_client = GitHubCiClient::for_test(&oversized_server.uri()).unwrap();
        assert_eq!(
            oversized_client
                .status("secret-ci-token", &ci_target())
                .await
                .unwrap_err(),
            GitHubCiError::GitHubResponseTooLarge
        );

        let forged_server = MockServer::start().await;
        let mut forged_run = workflow_runs_body(serde_json::json!({}));
        forged_run["workflow_runs"][0]["html_url"] =
            serde_json::json!("https://attacker.invalid/actions/runs/42");
        forged_run["workflow_runs"][0]["head_sha"] = serde_json::json!("2".repeat(40));
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(forged_run))
            .expect(1)
            .mount(&forged_server)
            .await;
        let forged_client = GitHubCiClient::for_test(&forged_server.uri()).unwrap();
        assert_eq!(
            forged_client
                .status("secret-ci-token", &ci_target())
                .await
                .unwrap_err(),
            GitHubCiError::InvalidGitHubResponse
        );
    }

    #[tokio::test]
    async fn github_actions_client_reports_truncation_and_stable_unknown_values() {
        let server = MockServer::start().await;
        let mut body = workflow_runs_body(serde_json::json!({ "total_count": 8 }));
        body["workflow_runs"][0]["status"] = serde_json::json!("future_status");
        body["workflow_runs"][0]["conclusion"] = serde_json::json!("future_conclusion");
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .expect(1)
            .mount(&server)
            .await;
        let client = GitHubCiClient::for_test(&server.uri()).unwrap();

        let response = client
            .status("secret-ci-token", &ci_target())
            .await
            .unwrap();

        assert!(response.truncated);
        assert_eq!(response.total_count, 8);
        assert_eq!(response.aggregate_status, GitHubCiAggregateStatus::Unknown);
        assert_eq!(response.runs[0].status, GitHubCiRunStatus::Unknown);
        assert_eq!(
            response.runs[0].conclusion,
            Some(GitHubCiRunConclusion::Unknown)
        );
    }

    #[test]
    fn aggregate_does_not_misreport_unknown_remote_states_as_running() {
        let run = GitHubCiRun {
            id: 1,
            name: "Future state".to_string(),
            run_number: 1,
            attempt: 1,
            event: "push".to_string(),
            status: GitHubCiRunStatus::Unknown,
            conclusion: None,
            html_url: "https://github.com/octo/demo/actions/runs/1".to_string(),
            created_at: "2026-08-05T01:00:00Z".to_string(),
            updated_at: "2026-08-05T01:00:00Z".to_string(),
        };

        assert_eq!(aggregate_status(&[run]), GitHubCiAggregateStatus::Unknown);
    }
}
