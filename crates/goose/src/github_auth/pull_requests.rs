use futures::StreamExt;
use goose_sdk_types::custom_requests::{
    GitHubPullRequestCreateRequest, GitHubPullRequestCreateResponse,
    GitHubPullRequestPreviewRequest, GitHubPullRequestPreviewResponse,
};
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use url::Url;

pub(crate) const MAX_BODY_BYTES: usize = 65_536;
const MAX_TITLE_BYTES: usize = 256;
const MAX_BRANCH_BYTES: usize = 255;
const MAX_GIT_OUTPUT_BYTES: usize = 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const PREFLIGHT_VERSION: &str = "codebuddy.github-pr-preflight.v1";
pub(crate) const GITHUB_API_VERSION: &str = "2026-03-10";
const MAX_GITHUB_RESPONSE_BYTES: usize = 64 * 1024;
const GITHUB_USER_AGENT: &str = "CodeBuddy/1.43";

#[derive(Debug, Clone)]
pub(crate) struct PullRequestInput {
    pub(crate) working_dir: PathBuf,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) base_branch: Option<String>,
    pub(crate) draft: bool,
    pub(crate) maintainer_can_modify: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GitHubRepository {
    pub(crate) owner: String,
    pub(crate) name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalPullRequestPreview {
    pub(crate) preflight_id: String,
    pub(crate) repository: GitHubRepository,
    pub(crate) repository_root: PathBuf,
    pub(crate) remote: String,
    pub(crate) head_branch: String,
    pub(crate) head_sha: String,
    pub(crate) base_branch: String,
    pub(crate) base_sha: String,
    pub(crate) commit_count: u64,
    pub(crate) changed_file_count: u64,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) draft: bool,
    pub(crate) maintainer_can_modify: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubPullRequestError {
    #[error("The project directory must be an existing absolute directory")]
    InvalidDirectory,
    #[error("The project directory is not a Git repository")]
    NotGitRepository,
    #[error("The Git working tree has uncommitted changes")]
    DirtyWorktree,
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
    #[error("The remote default branch could not be determined")]
    MissingDefaultBranch,
    #[error("The target branch name is invalid")]
    InvalidBaseBranch,
    #[error("The target branch does not exist on the upstream remote")]
    BaseBranchNotFound,
    #[error("The source and target branches must be different")]
    SameBranch,
    #[error("The source branch has no commits to include")]
    NoCommits,
    #[error("The Pull Request title must contain 1 to 256 UTF-8 bytes")]
    InvalidTitle,
    #[error("The Pull Request body exceeds 65536 UTF-8 bytes")]
    BodyTooLong,
    #[error("Git is unavailable or a bounded Git command failed")]
    GitFailed,
    #[error("Git output exceeded the safety limit")]
    GitOutputTooLarge,
    #[error("The GitHub API endpoint is invalid")]
    InvalidApiBase,
    #[error("The GitHub API is unavailable")]
    NetworkUnavailable,
    #[error("GitHub rejected the Pull Request request")]
    GitHubRejected,
    #[error("GitHub returned an invalid Pull Request response")]
    InvalidGitHubResponse,
    #[error("The GitHub response exceeded the safety limit")]
    GitHubResponseTooLarge,
    #[error("GitHub is not connected or the stored authorization has expired")]
    NotAuthenticated,
    #[error("The GitHub credential could not be read from secure storage")]
    CredentialUnavailable,
    #[error("An open Pull Request already exists for this branch")]
    ExistingPullRequest,
    #[error("The Pull Request preflight ID is invalid")]
    InvalidPreflightId,
    #[error("The Pull Request preflight is stale; run preview again")]
    PreflightStale,
}

impl GitHubPullRequestError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidDirectory => "invalid_directory",
            Self::NotGitRepository => "not_git_repository",
            Self::DirtyWorktree => "dirty_worktree",
            Self::DetachedHead => "detached_head",
            Self::MissingUpstream => "missing_upstream",
            Self::UpstreamMismatch => "upstream_mismatch",
            Self::UnsupportedRemote => "unsupported_remote",
            Self::HeadNotPushed => "head_not_pushed",
            Self::MissingDefaultBranch => "missing_default_branch",
            Self::InvalidBaseBranch => "invalid_base_branch",
            Self::BaseBranchNotFound => "base_branch_not_found",
            Self::SameBranch => "same_branch",
            Self::NoCommits => "no_commits",
            Self::InvalidTitle => "invalid_title",
            Self::BodyTooLong => "body_too_long",
            Self::GitFailed => "git_failed",
            Self::GitOutputTooLarge => "git_output_too_large",
            Self::InvalidApiBase => "invalid_api_base",
            Self::NetworkUnavailable => "network_unavailable",
            Self::GitHubRejected => "github_rejected",
            Self::InvalidGitHubResponse => "invalid_github_response",
            Self::GitHubResponseTooLarge => "github_response_too_large",
            Self::NotAuthenticated => "not_authenticated",
            Self::CredentialUnavailable => "credential_unavailable",
            Self::ExistingPullRequest => "existing_pull_request",
            Self::InvalidPreflightId => "invalid_preflight_id",
            Self::PreflightStale => "preflight_stale",
        }
    }
}

impl super::GitHubAuthService {
    pub(crate) async fn preview_pull_request(
        &self,
        request: GitHubPullRequestPreviewRequest,
    ) -> Result<GitHubPullRequestPreviewResponse, GitHubPullRequestError> {
        let access_token = self.active_access_token().await?;
        let preview = inspect_local_repository(&preview_input(&request)).await?;
        self.ensure_no_existing_pull_request(&access_token, &preview)
            .await?;
        Ok(public_preview(&preview))
    }

    pub(crate) async fn create_pull_request(
        &self,
        request: GitHubPullRequestCreateRequest,
    ) -> Result<GitHubPullRequestCreateResponse, GitHubPullRequestError> {
        if request.preflight_id.len() != 64
            || !request
                .preflight_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(GitHubPullRequestError::InvalidPreflightId);
        }
        let _lifecycle = self.pull_request_lifecycle.lock().await;
        let access_token = self.active_access_token().await?;
        let preview = inspect_local_repository(&create_input(&request)).await?;
        if request.preflight_id != preview.preflight_id {
            return Err(GitHubPullRequestError::PreflightStale);
        }
        self.ensure_no_existing_pull_request(&access_token, &preview)
            .await?;
        self.pull_request_client
            .create(&access_token, &preview)
            .await
    }

    pub(crate) async fn active_access_token(&self) -> Result<String, GitHubPullRequestError> {
        let credential = self
            .load_credential()
            .await
            .map_err(|_| GitHubPullRequestError::CredentialUnavailable)?
            .ok_or(GitHubPullRequestError::NotAuthenticated)?;
        let expired = credential
            .access_token_expires_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|expires_at| expires_at <= self.clock.utc_now());
        if expired {
            return Err(GitHubPullRequestError::NotAuthenticated);
        }
        Ok(credential.access_token)
    }

    async fn ensure_no_existing_pull_request(
        &self,
        access_token: &str,
        preview: &LocalPullRequestPreview,
    ) -> Result<(), GitHubPullRequestError> {
        if self
            .pull_request_client
            .find_existing_open(
                access_token,
                &preview.repository,
                &preview.head_branch,
                &preview.base_branch,
            )
            .await?
        {
            return Err(GitHubPullRequestError::ExistingPullRequest);
        }
        Ok(())
    }
}

fn preview_input(request: &GitHubPullRequestPreviewRequest) -> PullRequestInput {
    PullRequestInput {
        working_dir: PathBuf::from(&request.working_dir),
        title: request.title.clone(),
        body: request.body.clone(),
        base_branch: request.base_branch.clone(),
        draft: request.draft,
        maintainer_can_modify: request.maintainer_can_modify,
    }
}

fn create_input(request: &GitHubPullRequestCreateRequest) -> PullRequestInput {
    PullRequestInput {
        working_dir: PathBuf::from(&request.working_dir),
        title: request.title.clone(),
        body: request.body.clone(),
        base_branch: request.base_branch.clone(),
        draft: request.draft,
        maintainer_can_modify: request.maintainer_can_modify,
    }
}

fn public_preview(preview: &LocalPullRequestPreview) -> GitHubPullRequestPreviewResponse {
    GitHubPullRequestPreviewResponse {
        preflight_id: preview.preflight_id.clone(),
        repository_owner: preview.repository.owner.clone(),
        repository_name: preview.repository.name.clone(),
        repository_url: format!(
            "https://github.com/{}/{}",
            preview.repository.owner, preview.repository.name
        ),
        head_branch: preview.head_branch.clone(),
        head_sha: preview.head_sha.clone(),
        base_branch: preview.base_branch.clone(),
        base_sha: preview.base_sha.clone(),
        commit_count: preview.commit_count,
        changed_file_count: preview.changed_file_count,
        draft: preview.draft,
        maintainer_can_modify: preview.maintainer_can_modify,
    }
}

#[derive(Clone)]
pub(crate) struct GitHubPullRequestClient {
    client: reqwest::Client,
    api_base: Url,
}

#[derive(Deserialize)]
struct ExistingPullRequestResponse {
    number: u64,
    html_url: String,
}

#[derive(Serialize)]
struct CreatePullRequestBody<'a> {
    title: &'a str,
    body: &'a str,
    head: &'a str,
    base: &'a str,
    draft: bool,
    maintainer_can_modify: bool,
}

#[derive(Deserialize)]
struct CreatedPullRequestResponse {
    number: u64,
    title: String,
    state: String,
    html_url: String,
    draft: bool,
    head: PullRequestRefResponse,
    base: PullRequestRefResponse,
}

#[derive(Deserialize)]
struct PullRequestRefResponse {
    #[serde(rename = "ref")]
    branch: String,
}

impl GitHubPullRequestClient {
    pub(crate) fn production() -> Result<Self, GitHubPullRequestError> {
        Self::new("https://api.github.com/", false)
    }

    #[cfg(test)]
    pub(crate) fn for_test(api_base: &str) -> Result<Self, GitHubPullRequestError> {
        Self::new(api_base, true)
    }

    fn new(api_base: &str, allow_loopback: bool) -> Result<Self, GitHubPullRequestError> {
        let mut api_base =
            Url::parse(api_base).map_err(|_| GitHubPullRequestError::InvalidApiBase)?;
        let is_production = api_base.scheme() == "https"
            && api_base.host_str() == Some("api.github.com")
            && api_base.port().is_none()
            && api_base.username().is_empty()
            && api_base.password().is_none();
        let is_loopback = allow_loopback
            && matches!(api_base.scheme(), "http" | "https")
            && api_base.host().is_some_and(|host| match host {
                url::Host::Ipv4(address) => address.is_loopback(),
                url::Host::Ipv6(address) => address.is_loopback(),
                url::Host::Domain(domain) => domain == "localhost",
            });
        if (!is_production && !is_loopback)
            || !api_base.username().is_empty()
            || api_base.password().is_some()
            || api_base.query().is_some()
            || api_base.fragment().is_some()
        {
            return Err(GitHubPullRequestError::InvalidApiBase);
        }
        api_base.set_path("/");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .user_agent(GITHUB_USER_AGENT)
            .build()
            .map_err(|_| GitHubPullRequestError::InvalidApiBase)?;
        Ok(Self { client, api_base })
    }

    pub(crate) async fn find_existing_open(
        &self,
        access_token: &str,
        repository: &GitHubRepository,
        head_branch: &str,
        base_branch: &str,
    ) -> Result<bool, GitHubPullRequestError> {
        let mut endpoint = self.endpoint(repository)?;
        let head = format!("{}:{head_branch}", repository.owner);
        endpoint
            .query_pairs_mut()
            .append_pair("state", "open")
            .append_pair("head", &head)
            .append_pair("base", base_branch)
            .append_pair("per_page", "2");
        let response = self
            .client
            .get(endpoint)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| GitHubPullRequestError::NetworkUnavailable)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(GitHubPullRequestError::GitHubRejected);
        }
        let body = read_github_json(response).await?;
        let existing = serde_json::from_slice::<Vec<ExistingPullRequestResponse>>(&body)
            .map_err(|_| GitHubPullRequestError::InvalidGitHubResponse)?;
        if existing.len() > 2 {
            return Err(GitHubPullRequestError::InvalidGitHubResponse);
        }
        for pull_request in &existing {
            validate_pull_request_url(repository, pull_request.number, &pull_request.html_url)?;
        }
        Ok(!existing.is_empty())
    }

    pub(crate) async fn create(
        &self,
        access_token: &str,
        preview: &LocalPullRequestPreview,
    ) -> Result<GitHubPullRequestCreateResponse, GitHubPullRequestError> {
        let response = self
            .client
            .post(self.endpoint(&preview.repository)?)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .json(&CreatePullRequestBody {
                title: &preview.title,
                body: &preview.body,
                head: &preview.head_branch,
                base: &preview.base_branch,
                draft: preview.draft,
                maintainer_can_modify: preview.maintainer_can_modify,
            })
            .send()
            .await
            .map_err(|_| GitHubPullRequestError::NetworkUnavailable)?;
        if response.status() != reqwest::StatusCode::CREATED {
            return Err(GitHubPullRequestError::GitHubRejected);
        }
        let body = read_github_json(response).await?;
        let created = serde_json::from_slice::<CreatedPullRequestResponse>(&body)
            .map_err(|_| GitHubPullRequestError::InvalidGitHubResponse)?;
        validate_pull_request_url(&preview.repository, created.number, &created.html_url)?;
        if created.number == 0
            || created.title != preview.title
            || created.state != "open"
            || created.draft != preview.draft
            || created.head.branch != preview.head_branch
            || created.base.branch != preview.base_branch
        {
            return Err(GitHubPullRequestError::InvalidGitHubResponse);
        }
        Ok(GitHubPullRequestCreateResponse {
            number: created.number,
            title: created.title,
            state: created.state,
            html_url: created.html_url,
            head_branch: created.head.branch,
            base_branch: created.base.branch,
            draft: created.draft,
        })
    }

    fn endpoint(&self, repository: &GitHubRepository) -> Result<Url, GitHubPullRequestError> {
        self.api_base
            .join(&format!(
                "repos/{}/{}/pulls",
                repository.owner, repository.name
            ))
            .map_err(|_| GitHubPullRequestError::InvalidApiBase)
    }
}

async fn read_github_json(response: reqwest::Response) -> Result<Vec<u8>, GitHubPullRequestError> {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json")
        && !content_type.starts_with("application/vnd.github+json")
    {
        return Err(GitHubPullRequestError::InvalidGitHubResponse);
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_GITHUB_RESPONSE_BYTES)
    {
        return Err(GitHubPullRequestError::GitHubResponseTooLarge);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| GitHubPullRequestError::NetworkUnavailable)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_GITHUB_RESPONSE_BYTES {
            return Err(GitHubPullRequestError::GitHubResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn validate_pull_request_url(
    repository: &GitHubRepository,
    number: u64,
    html_url: &str,
) -> Result<(), GitHubPullRequestError> {
    let expected = format!(
        "https://github.com/{}/{}/pull/{number}",
        repository.owner, repository.name
    );
    if number == 0 || html_url != expected {
        return Err(GitHubPullRequestError::InvalidGitHubResponse);
    }
    Ok(())
}

pub(crate) fn parse_github_remote(
    remote: &str,
) -> Result<GitHubRepository, GitHubPullRequestError> {
    let parts = if let Some(path) = remote.strip_prefix("git@github.com:") {
        if path.contains(['?', '#', ':']) {
            return Err(GitHubPullRequestError::UnsupportedRemote);
        }
        parse_repository_path(path)?
    } else if let Some(rest) = remote.strip_prefix("https://") {
        let (authority, _) = rest
            .split_once('/')
            .ok_or(GitHubPullRequestError::UnsupportedRemote)?;
        if authority != "github.com" {
            return Err(GitHubPullRequestError::UnsupportedRemote);
        }
        let url = Url::parse(remote).map_err(|_| GitHubPullRequestError::UnsupportedRemote)?;
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(GitHubPullRequestError::UnsupportedRemote);
        }
        parse_repository_path(url.path().trim_start_matches('/'))?
    } else {
        return Err(GitHubPullRequestError::UnsupportedRemote);
    };
    Ok(GitHubRepository {
        owner: parts.0,
        name: parts.1,
    })
}

fn parse_repository_path(path: &str) -> Result<(String, String), GitHubPullRequestError> {
    let segments = path.split('/').collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(GitHubPullRequestError::UnsupportedRemote);
    }
    let owner = segments[0];
    let name = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if !valid_repository_component(owner) || !valid_repository_component(name) {
        return Err(GitHubPullRequestError::UnsupportedRemote);
    }
    Ok((owner.to_string(), name.to_string()))
}

fn valid_repository_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(crate) async fn inspect_local_repository(
    input: &PullRequestInput,
) -> Result<LocalPullRequestPreview, GitHubPullRequestError> {
    inspect_local_repository_with_policy(input, true).await
}

pub(crate) async fn inspect_local_repository_for_delivery(
    input: &PullRequestInput,
) -> Result<LocalPullRequestPreview, GitHubPullRequestError> {
    inspect_local_repository_with_policy(input, false).await
}

async fn inspect_local_repository_with_policy(
    input: &PullRequestInput,
    require_pushed_head: bool,
) -> Result<LocalPullRequestPreview, GitHubPullRequestError> {
    validate_content(input)?;
    if !input.working_dir.is_absolute() || !input.working_dir.is_dir() {
        return Err(GitHubPullRequestError::InvalidDirectory);
    }
    let working_dir = tokio::fs::canonicalize(&input.working_dir)
        .await
        .map_err(|_| GitHubPullRequestError::InvalidDirectory)?;
    let root_output = run_git(&working_dir, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| GitHubPullRequestError::NotGitRepository)?;
    let root_text = output_text(&root_output)?;
    let repository_root = tokio::fs::canonicalize(root_text)
        .await
        .map_err(|_| GitHubPullRequestError::NotGitRepository)?;

    let status = run_git(
        &repository_root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    if !status.is_empty() {
        return Err(GitHubPullRequestError::DirtyWorktree);
    }

    let head_branch = output_text(
        &run_git(
            &repository_root,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        )
        .await
        .map_err(|_| GitHubPullRequestError::DetachedHead)?,
    )?;
    if !valid_branch_component(&head_branch) {
        return Err(GitHubPullRequestError::DetachedHead);
    }

    let remote_key = format!("branch.{head_branch}.remote");
    let remote = match run_git(&repository_root, &["config", "--get", &remote_key]).await {
        Ok(output) => output_text(&output)?,
        Err(_) if !require_pushed_head => "origin".to_string(),
        Err(_) => return Err(GitHubPullRequestError::MissingUpstream),
    };
    if !valid_remote_name(&remote) {
        return Err(GitHubPullRequestError::MissingUpstream);
    }
    let merge_key = format!("branch.{head_branch}.merge");
    match run_git(&repository_root, &["config", "--get", &merge_key]).await {
        Ok(output) => {
            if output_text(&output)? != format!("refs/heads/{head_branch}") {
                return Err(GitHubPullRequestError::UpstreamMismatch);
            }
        }
        Err(_) if !require_pushed_head => {}
        Err(_) => return Err(GitHubPullRequestError::MissingUpstream),
    }

    let remote_url = output_text(
        &run_git(&repository_root, &["remote", "get-url", &remote])
            .await
            .map_err(|_| GitHubPullRequestError::UnsupportedRemote)?,
    )?;
    let repository = parse_github_remote(&remote_url)?;
    let head_sha = verified_sha(&repository_root, "HEAD").await?;
    if require_pushed_head {
        let remote_head_ref = format!("refs/remotes/{remote}/{head_branch}");
        let remote_head_sha = verified_sha(&repository_root, &remote_head_ref)
            .await
            .map_err(|_| GitHubPullRequestError::HeadNotPushed)?;
        if remote_head_sha != head_sha {
            return Err(GitHubPullRequestError::HeadNotPushed);
        }
    }

    let base_branch = match input.base_branch.as_deref().map(str::trim) {
        Some(base) if !base.is_empty() => {
            validate_branch(&repository_root, base).await?;
            base.to_string()
        }
        _ => {
            let remote_default_ref = format!("refs/remotes/{remote}/HEAD");
            let symbolic = output_text(
                &run_git(
                    &repository_root,
                    &["symbolic-ref", "--quiet", "--short", &remote_default_ref],
                )
                .await
                .map_err(|_| GitHubPullRequestError::MissingDefaultBranch)?,
            )?;
            symbolic
                .strip_prefix(&format!("{remote}/"))
                .filter(|branch| valid_branch_component(branch))
                .ok_or(GitHubPullRequestError::MissingDefaultBranch)?
                .to_string()
        }
    };
    if base_branch == head_branch {
        return Err(GitHubPullRequestError::SameBranch);
    }
    let base_ref = format!("refs/remotes/{remote}/{base_branch}");
    let base_sha = verified_sha(&repository_root, &base_ref)
        .await
        .map_err(|_| GitHubPullRequestError::BaseBranchNotFound)?;
    let revision = format!("{base_ref}..HEAD");
    let commit_count =
        output_text(&run_git(&repository_root, &["rev-list", "--count", &revision]).await?)?
            .parse::<u64>()
            .map_err(|_| GitHubPullRequestError::GitFailed)?;
    if commit_count == 0 {
        return Err(GitHubPullRequestError::NoCommits);
    }
    let merge_revision = format!("{base_ref}...HEAD");
    let changed_files = run_git(
        &repository_root,
        &["diff", "--name-only", "-z", &merge_revision],
    )
    .await?;
    let changed_file_count = changed_files
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .count() as u64;
    let title = input.title.trim().to_string();
    let mut preview = LocalPullRequestPreview {
        preflight_id: String::new(),
        repository,
        repository_root,
        remote,
        head_branch,
        head_sha,
        base_branch,
        base_sha,
        commit_count,
        changed_file_count,
        title,
        body: input.body.clone(),
        draft: input.draft,
        maintainer_can_modify: input.maintainer_can_modify,
    };
    preview.preflight_id = preflight_id(&preview);
    Ok(preview)
}

fn validate_content(input: &PullRequestInput) -> Result<(), GitHubPullRequestError> {
    let title = input.title.trim();
    if title.is_empty() || title.len() > MAX_TITLE_BYTES || title.chars().any(char::is_control) {
        return Err(GitHubPullRequestError::InvalidTitle);
    }
    if input.body.len() > MAX_BODY_BYTES {
        return Err(GitHubPullRequestError::BodyTooLong);
    }
    Ok(())
}

pub(crate) fn valid_remote_name(remote: &str) -> bool {
    !remote.is_empty()
        && remote.len() <= 100
        && remote.is_ascii()
        && remote
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(crate) fn valid_branch_component(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= MAX_BRANCH_BYTES
        && branch.is_ascii()
        && !branch.starts_with(['-', '/', '.'])
        && !branch.ends_with(['/', '.'])
        && !branch.contains("..")
        && !branch.contains("@{")
        && !branch.contains("//")
        && !branch.contains(['\\', '~', '^', ':', '?', '*', '['])
        && !branch.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
}

async fn validate_branch(cwd: &Path, branch: &str) -> Result<(), GitHubPullRequestError> {
    if !valid_branch_component(branch) {
        return Err(GitHubPullRequestError::InvalidBaseBranch);
    }
    run_git(cwd, &["check-ref-format", "--branch", branch])
        .await
        .map(|_| ())
        .map_err(|_| GitHubPullRequestError::InvalidBaseBranch)
}

pub(crate) async fn verified_sha(
    cwd: &Path,
    revision: &str,
) -> Result<String, GitHubPullRequestError> {
    let sha = output_text(&run_git(cwd, &["rev-parse", "--verify", revision]).await?)?;
    if matches!(sha.len(), 40 | 64)
        && sha.is_ascii()
        && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(sha.to_ascii_lowercase())
    } else {
        Err(GitHubPullRequestError::GitFailed)
    }
}

pub(crate) fn output_text(bytes: &[u8]) -> Result<String, GitHubPullRequestError> {
    let value = std::str::from_utf8(bytes).map_err(|_| GitHubPullRequestError::GitFailed)?;
    let value = value.trim();
    if value.is_empty() || value.contains('\0') {
        return Err(GitHubPullRequestError::GitFailed);
    }
    Ok(value.to_string())
}

fn preflight_id(preview: &LocalPullRequestPreview) -> String {
    let mut hasher = Sha256::new();
    for (key, value) in [
        ("version", PREFLIGHT_VERSION.to_string()),
        (
            "repository_root",
            preview.repository_root.to_string_lossy().into_owned(),
        ),
        ("owner", preview.repository.owner.clone()),
        ("repository", preview.repository.name.clone()),
        ("remote", preview.remote.clone()),
        ("head_branch", preview.head_branch.clone()),
        ("head_sha", preview.head_sha.clone()),
        ("base_branch", preview.base_branch.clone()),
        ("base_sha", preview.base_sha.clone()),
        ("title", preview.title.clone()),
        ("body", preview.body.clone()),
        ("draft", preview.draft.to_string()),
        (
            "maintainer_can_modify",
            preview.maintainer_can_modify.to_string(),
        ),
        ("commit_count", preview.commit_count.to_string()),
        ("changed_file_count", preview.changed_file_count.to_string()),
    ] {
        let key = key.as_bytes();
        let value = value.as_bytes();
        hasher.update((key.len() as u64).to_be_bytes());
        hasher.update(key);
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

pub(crate) async fn run_git(
    cwd: &Path,
    arguments: &[&str],
) -> Result<Vec<u8>, GitHubPullRequestError> {
    let mut child = Command::new("git")
        .args(arguments)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| GitHubPullRequestError::GitFailed)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(GitHubPullRequestError::GitFailed)?;
    let stderr = child
        .stderr
        .take()
        .ok_or(GitHubPullRequestError::GitFailed)?;
    let stdout_task = tokio::spawn(read_bounded(stdout));
    let stderr_task = tokio::spawn(read_bounded(stderr));
    let status = match tokio::time::timeout(GIT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        _ => {
            let _ = child.kill().await;
            return Err(GitHubPullRequestError::GitFailed);
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|_| GitHubPullRequestError::GitFailed)?
        .map_err(|_| GitHubPullRequestError::GitFailed)?;
    let stderr = stderr_task
        .await
        .map_err(|_| GitHubPullRequestError::GitFailed)?
        .map_err(|_| GitHubPullRequestError::GitFailed)?;
    if stdout.len() > MAX_GIT_OUTPUT_BYTES || stderr.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(GitHubPullRequestError::GitOutputTooLarge);
    }
    if !status.success() {
        return Err(GitHubPullRequestError::GitFailed);
    }
    Ok(stdout)
}

async fn read_bounded(reader: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_GIT_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github_auth::credential_store::{
        GitHubCredentialStore, MemoryGitHubCredentialStore, StoredGitHubCredentialV1,
    };
    use crate::github_auth::device_flow::GitHubDeviceFlowClient;
    use crate::github_auth::{GitHubAuthClock, GitHubAuthService};
    use chrono::{DateTime, Utc};
    use std::path::Path;
    use std::process::Command;
    use std::sync::Arc;
    use std::time::Instant;
    use tempfile::TempDir;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const ACCESS_TOKEN: &str = "ghu_pull-request-secret-must-not-leak";

    struct FixedClock;

    impl GitHubAuthClock for FixedClock {
        fn monotonic_now(&self) -> Instant {
            Instant::now()
        }

        fn utc_now(&self) -> DateTime<Utc> {
            DateTime::parse_from_rfc3339("2026-08-05T01:00:00Z")
                .unwrap()
                .to_utc()
        }
    }

    struct TestRepository {
        _temp: TempDir,
        root: std::path::PathBuf,
        base_sha: String,
        head_sha: String,
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn setup_repository() -> TestRepository {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "--initial-branch", "main"]);
        git(&root, &["config", "user.name", "CodePro Test"]);
        git(&root, &["config", "user.email", "codepro@example.invalid"]);
        std::fs::write(root.join("README.md"), "base\n").unwrap();
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-m", "base"]);
        let base_sha = git(&root, &["rev-parse", "HEAD"]);
        git(
            &root,
            &["remote", "add", "origin", "git@github.com:octo/demo.git"],
        );
        git(
            &root,
            &["update-ref", "refs/remotes/origin/main", &base_sha],
        );
        git(
            &root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        git(&root, &["switch", "-c", "feature/pr-flow"]);
        std::fs::write(root.join("feature.txt"), "feature\n").unwrap();
        git(&root, &["add", "feature.txt"]);
        git(&root, &["commit", "-m", "feature"]);
        let head_sha = git(&root, &["rev-parse", "HEAD"]);
        git(
            &root,
            &[
                "update-ref",
                "refs/remotes/origin/feature/pr-flow",
                &head_sha,
            ],
        );
        git(
            &root,
            &["config", "branch.feature/pr-flow.remote", "origin"],
        );
        git(
            &root,
            &[
                "config",
                "branch.feature/pr-flow.merge",
                "refs/heads/feature/pr-flow",
            ],
        );
        TestRepository {
            _temp: temp,
            root,
            base_sha,
            head_sha,
        }
    }

    fn input(root: &Path) -> PullRequestInput {
        PullRequestInput {
            working_dir: root.to_path_buf(),
            title: "Add bounded PR flow".to_string(),
            body: "Local verification passed.".to_string(),
            base_branch: None,
            draft: false,
            maintainer_can_modify: true,
        }
    }

    #[test]
    fn remote_parser_accepts_only_canonical_github_repository_urls() {
        let https = parse_github_remote("https://github.com/octo/demo.git").unwrap();
        assert_eq!(
            (https.owner.as_str(), https.name.as_str()),
            ("octo", "demo")
        );
        let ssh = parse_github_remote("git@github.com:octo/demo.git").unwrap();
        assert_eq!(ssh, https);

        for rejected in [
            "http://github.com/octo/demo.git",
            "https://token@github.com/octo/demo.git",
            "https://github.com:443/octo/demo.git",
            "https://github.com/octo/demo/extra",
            "https://github.example/octo/demo.git",
            "git@example.com:octo/demo.git",
            "git@github.com:octo/../demo.git",
        ] {
            assert_eq!(
                parse_github_remote(rejected).unwrap_err().code(),
                "unsupported_remote",
                "accepted {rejected}"
            );
        }
    }

    #[tokio::test]
    async fn local_preview_reports_a_clean_pushed_branch_and_binds_all_inputs() {
        let repository = setup_repository();
        let preview = inspect_local_repository(&input(&repository.root))
            .await
            .unwrap();
        assert_eq!(preview.repository.owner, "octo");
        assert_eq!(preview.repository.name, "demo");
        assert_eq!(preview.head_branch, "feature/pr-flow");
        assert_eq!(preview.head_sha, repository.head_sha);
        assert_eq!(preview.base_branch, "main");
        assert_eq!(preview.base_sha, repository.base_sha);
        assert_eq!(preview.commit_count, 1);
        assert_eq!(preview.changed_file_count, 1);
        assert_eq!(preview.preflight_id.len(), 64);

        let mut changed = input(&repository.root);
        changed.title.push('!');
        assert_ne!(
            inspect_local_repository(&changed)
                .await
                .unwrap()
                .preflight_id,
            preview.preflight_id
        );
        changed = input(&repository.root);
        changed.body.push_str("\nMore detail.");
        assert_ne!(
            inspect_local_repository(&changed)
                .await
                .unwrap()
                .preflight_id,
            preview.preflight_id
        );
        changed = input(&repository.root);
        changed.draft = true;
        assert_ne!(
            inspect_local_repository(&changed)
                .await
                .unwrap()
                .preflight_id,
            preview.preflight_id
        );
    }

    #[tokio::test]
    async fn local_preview_rejects_dirty_unpushed_and_invalid_content() {
        let repository = setup_repository();
        std::fs::write(repository.root.join("untracked.txt"), "not included\n").unwrap();
        assert_eq!(
            inspect_local_repository(&input(&repository.root))
                .await
                .unwrap_err()
                .code(),
            "dirty_worktree"
        );
        std::fs::remove_file(repository.root.join("untracked.txt")).unwrap();

        std::fs::write(repository.root.join("feature.txt"), "second commit\n").unwrap();
        git(&repository.root, &["add", "feature.txt"]);
        git(&repository.root, &["commit", "-m", "not pushed"]);
        assert_eq!(
            inspect_local_repository(&input(&repository.root))
                .await
                .unwrap_err()
                .code(),
            "head_not_pushed"
        );

        let mut invalid = input(&repository.root);
        invalid.title = "  ".to_string();
        assert_eq!(
            inspect_local_repository(&invalid).await.unwrap_err().code(),
            "invalid_title"
        );
        invalid = input(&repository.root);
        invalid.body = "x".repeat(MAX_BODY_BYTES + 1);
        assert_eq!(
            inspect_local_repository(&invalid).await.unwrap_err().code(),
            "body_too_long"
        );
    }

    #[tokio::test]
    async fn delivery_preview_accepts_a_clean_committed_branch_before_its_first_push() {
        let repository = setup_repository();
        git(
            &repository.root,
            &["update-ref", "-d", "refs/remotes/origin/feature/pr-flow"],
        );
        git(
            &repository.root,
            &["config", "--unset", "branch.feature/pr-flow.remote"],
        );
        git(
            &repository.root,
            &["config", "--unset", "branch.feature/pr-flow.merge"],
        );

        let preview = inspect_local_repository_for_delivery(&input(&repository.root))
            .await
            .unwrap();

        assert_eq!(preview.remote, "origin");
        assert_eq!(preview.head_branch, "feature/pr-flow");
        assert_eq!(preview.head_sha, repository.head_sha);
        assert_eq!(preview.base_branch, "main");
        assert_eq!(preview.commit_count, 1);
        assert_eq!(preview.changed_file_count, 1);
        assert_eq!(
            inspect_local_repository(&input(&repository.root))
                .await
                .unwrap_err(),
            GitHubPullRequestError::MissingUpstream
        );
    }

    #[tokio::test]
    async fn local_preview_rejects_ambiguous_branch_and_base_states() {
        let detached = setup_repository();
        git(&detached.root, &["checkout", "--detach"]);
        assert_eq!(
            inspect_local_repository(&input(&detached.root))
                .await
                .unwrap_err()
                .code(),
            "detached_head"
        );

        let missing_upstream = setup_repository();
        git(
            &missing_upstream.root,
            &["config", "--unset", "branch.feature/pr-flow.remote"],
        );
        assert_eq!(
            inspect_local_repository(&input(&missing_upstream.root))
                .await
                .unwrap_err()
                .code(),
            "missing_upstream"
        );

        let repository = setup_repository();
        let mut invalid_base = input(&repository.root);
        invalid_base.base_branch = Some("../main".to_string());
        assert_eq!(
            inspect_local_repository(&invalid_base)
                .await
                .unwrap_err()
                .code(),
            "invalid_base_branch"
        );
        invalid_base.base_branch = Some("missing".to_string());
        assert_eq!(
            inspect_local_repository(&invalid_base)
                .await
                .unwrap_err()
                .code(),
            "base_branch_not_found"
        );
        invalid_base.base_branch = Some("feature/pr-flow".to_string());
        assert_eq!(
            inspect_local_repository(&invalid_base)
                .await
                .unwrap_err()
                .code(),
            "same_branch"
        );

        git(
            &repository.root,
            &[
                "update-ref",
                "refs/remotes/origin/already-in-base",
                &repository.head_sha,
            ],
        );
        invalid_base.base_branch = Some("already-in-base".to_string());
        assert_eq!(
            inspect_local_repository(&invalid_base)
                .await
                .unwrap_err()
                .code(),
            "no_commits"
        );
    }

    #[tokio::test]
    async fn local_preview_rejects_missing_or_relative_directories_without_running_git() {
        let relative = PullRequestInput {
            working_dir: PathBuf::from("relative-project"),
            ..input(Path::new("."))
        };
        assert_eq!(
            inspect_local_repository(&relative)
                .await
                .unwrap_err()
                .code(),
            "invalid_directory"
        );
        let missing = PullRequestInput {
            working_dir: std::env::temp_dir().join("codepro-u68-directory-does-not-exist"),
            ..input(Path::new("."))
        };
        assert_eq!(
            inspect_local_repository(&missing).await.unwrap_err().code(),
            "invalid_directory"
        );
    }

    #[tokio::test]
    async fn github_client_queries_only_the_bounded_open_pull_request_shape() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/pulls"))
            .and(query_param("state", "open"))
            .and(query_param("head", "octo:feature/pr-flow"))
            .and(query_param("base", "main"))
            .and(query_param("per_page", "2"))
            .and(header("accept", "application/vnd.github+json"))
            .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
            .and(header("x-github-api-version", GITHUB_API_VERSION))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(1)
            .mount(&server)
            .await;
        let client = GitHubPullRequestClient::for_test(&server.uri()).unwrap();
        let existing = client
            .find_existing_open(
                ACCESS_TOKEN,
                &GitHubRepository {
                    owner: "octo".to_string(),
                    name: "demo".to_string(),
                },
                "feature/pr-flow",
                "main",
            )
            .await
            .unwrap();
        assert!(!existing);
    }

    #[tokio::test]
    async fn github_client_blocks_existing_and_oversized_pull_request_responses() {
        let existing_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/pulls"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!([{
                    "number": 7,
                    "html_url": "https://github.com/octo/demo/pull/7"
                }])),
            )
            .expect(1)
            .mount(&existing_server)
            .await;
        let repository = GitHubRepository {
            owner: "octo".to_string(),
            name: "demo".to_string(),
        };
        assert!(GitHubPullRequestClient::for_test(&existing_server.uri())
            .unwrap()
            .find_existing_open(ACCESS_TOKEN, &repository, "feature/pr-flow", "main")
            .await
            .unwrap());

        let oversized_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/pulls"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_bytes(vec![b' '; MAX_GITHUB_RESPONSE_BYTES + 1]),
            )
            .expect(1)
            .mount(&oversized_server)
            .await;
        assert_eq!(
            GitHubPullRequestClient::for_test(&oversized_server.uri())
                .unwrap()
                .find_existing_open(ACCESS_TOKEN, &repository, "feature/pr-flow", "main")
                .await
                .unwrap_err()
                .code(),
            "github_response_too_large"
        );
        assert_eq!(
            GitHubPullRequestClient::for_test("https://attacker.invalid")
                .err()
                .expect("non-loopback test endpoint must be rejected")
                .code(),
            "invalid_api_base"
        );
    }

    #[tokio::test]
    async fn github_client_creates_once_and_returns_only_validated_fields() {
        let repository = setup_repository();
        let preview = inspect_local_repository(&input(&repository.root))
            .await
            .unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/pulls"))
            .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
            .and(body_json(serde_json::json!({
                "title": "Add bounded PR flow",
                "body": "Local verification passed.",
                "head": "feature/pr-flow",
                "base": "main",
                "draft": false,
                "maintainer_can_modify": true
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "number": 42,
                "title": "Add bounded PR flow",
                "state": "open",
                "html_url": "https://github.com/octo/demo/pull/42",
                "draft": false,
                "head": { "ref": "feature/pr-flow" },
                "base": { "ref": "main" },
                "ignored_secret": ACCESS_TOKEN
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = GitHubPullRequestClient::for_test(&server.uri()).unwrap();
        let created = client.create(ACCESS_TOKEN, &preview).await.unwrap();
        assert_eq!(created.number, 42);
        assert_eq!(created.html_url, "https://github.com/octo/demo/pull/42");
        assert_eq!(created.head_branch, "feature/pr-flow");
        assert_eq!(created.base_branch, "main");
        assert!(!serde_json::to_string(&created)
            .unwrap()
            .contains(ACCESS_TOKEN));
    }

    #[tokio::test]
    async fn github_client_rejects_redirects_invalid_urls_and_never_retries_post() {
        let repository = setup_repository();
        let preview = inspect_local_repository(&input(&repository.root))
            .await
            .unwrap();

        let redirect_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/pulls"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", "https://attacker.invalid/steal"),
            )
            .expect(1)
            .mount(&redirect_server)
            .await;
        let redirect_error = GitHubPullRequestClient::for_test(&redirect_server.uri())
            .unwrap()
            .create(ACCESS_TOKEN, &preview)
            .await
            .unwrap_err();
        assert_eq!(redirect_error.code(), "github_rejected");
        assert!(!redirect_error.to_string().contains(ACCESS_TOKEN));

        let invalid_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/pulls"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "number": 42,
                "title": "Add bounded PR flow",
                "state": "open",
                "html_url": "https://attacker.invalid/octo/demo/pull/42",
                "draft": false,
                "head": { "ref": "feature/pr-flow" },
                "base": { "ref": "main" }
            })))
            .expect(1)
            .mount(&invalid_server)
            .await;
        assert_eq!(
            GitHubPullRequestClient::for_test(&invalid_server.uri())
                .unwrap()
                .create(ACCESS_TOKEN, &preview)
                .await
                .unwrap_err()
                .code(),
            "invalid_github_response"
        );

        let failure_server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/pulls"))
            .respond_with(ResponseTemplate::new(500).set_body_string(ACCESS_TOKEN.repeat(100)))
            .expect(1)
            .mount(&failure_server)
            .await;
        let error = GitHubPullRequestClient::for_test(&failure_server.uri())
            .unwrap()
            .create(ACCESS_TOKEN, &preview)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "github_rejected");
        assert!(!error.to_string().contains(ACCESS_TOKEN));
    }

    #[tokio::test]
    async fn auth_service_rechecks_preflight_and_creates_with_backend_only_credentials() {
        let repository = setup_repository();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/pulls"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/demo/pulls"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "number": 42,
                "title": "Add bounded PR flow",
                "state": "open",
                "html_url": "https://github.com/octo/demo/pull/42",
                "draft": false,
                "head": { "ref": "feature/pr-flow" },
                "base": { "ref": "main" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let store = Arc::new(MemoryGitHubCredentialStore::default());
        store
            .save(&StoredGitHubCredentialV1 {
                schema_version: 1,
                account_login: "octocat".to_string(),
                account_id: 1,
                access_token: ACCESS_TOKEN.to_string(),
                refresh_token: None,
                access_token_expires_at: Some("2026-08-05T02:00:00Z".to_string()),
                refresh_token_expires_at: None,
            })
            .unwrap();
        let service = GitHubAuthService::for_test(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            store,
            Arc::new(FixedClock),
        );
        let request = goose_sdk_types::custom_requests::GitHubPullRequestPreviewRequest {
            working_dir: repository.root.to_string_lossy().into_owned(),
            title: "Add bounded PR flow".to_string(),
            body: "Local verification passed.".to_string(),
            base_branch: None,
            draft: false,
            maintainer_can_modify: true,
        };
        let preview = service.preview_pull_request(request.clone()).await.unwrap();
        let mut stale = goose_sdk_types::custom_requests::GitHubPullRequestCreateRequest {
            working_dir: request.working_dir.clone(),
            title: "Changed after preview".to_string(),
            body: request.body.clone(),
            base_branch: None,
            draft: false,
            maintainer_can_modify: true,
            preflight_id: preview.preflight_id.clone(),
        };
        assert_eq!(
            service
                .create_pull_request(stale.clone())
                .await
                .unwrap_err()
                .code(),
            "preflight_stale"
        );
        stale.title = request.title;
        let created = service.create_pull_request(stale).await.unwrap();
        assert_eq!(created.number, 42);
        assert!(!serde_json::to_string(&created)
            .unwrap()
            .contains(ACCESS_TOKEN));
    }

    #[tokio::test]
    async fn auth_service_rejects_expired_credentials_and_malformed_preflight_without_network() {
        let server = MockServer::start().await;
        let store = Arc::new(MemoryGitHubCredentialStore::default());
        store
            .save(&StoredGitHubCredentialV1 {
                schema_version: 1,
                account_login: "octocat".to_string(),
                account_id: 1,
                access_token: ACCESS_TOKEN.to_string(),
                refresh_token: None,
                access_token_expires_at: Some("2026-08-05T00:59:59Z".to_string()),
                refresh_token_expires_at: None,
            })
            .unwrap();
        let service = GitHubAuthService::for_test(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            store,
            Arc::new(FixedClock),
        );
        let repository = setup_repository();
        let request = goose_sdk_types::custom_requests::GitHubPullRequestPreviewRequest {
            working_dir: repository.root.to_string_lossy().into_owned(),
            title: "Add bounded PR flow".to_string(),
            body: String::new(),
            base_branch: None,
            draft: false,
            maintainer_can_modify: true,
        };
        assert_eq!(
            service
                .preview_pull_request(request.clone())
                .await
                .unwrap_err()
                .code(),
            "not_authenticated"
        );
        assert_eq!(
            service
                .create_pull_request(
                    goose_sdk_types::custom_requests::GitHubPullRequestCreateRequest {
                        working_dir: request.working_dir,
                        title: request.title,
                        body: request.body,
                        base_branch: request.base_branch,
                        draft: request.draft,
                        maintainer_can_modify: request.maintainer_can_modify,
                        preflight_id: "NOT-A-PREFLIGHT".to_string(),
                    }
                )
                .await
                .unwrap_err()
                .code(),
            "invalid_preflight_id"
        );
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
