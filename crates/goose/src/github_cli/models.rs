use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct GhCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Duration,
    pub cancellation: CancellationToken,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhCommandOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhRunError {
    Unavailable,
    TimedOut,
    Cancelled,
    OutputTooLarge,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhAuthStatus {
    Authenticated { login: String },
    NotAuthenticated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GhCheckBucket {
    Pass,
    Fail,
    Pending,
    Skipping,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GhRequiredCheck {
    pub name: String,
    pub state: String,
    pub bucket: GhCheckBucket,
    pub link: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GhPullRequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GhPullRequest {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub state: GhPullRequestState,
    pub url: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepositoryContext {
    pub owner: String,
    pub name: String,
    pub url: String,
    pub head_branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatePullRequestInput {
    pub repository_owner: String,
    pub repository_name: String,
    pub head_branch: String,
    pub base_branch: Option<String>,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedPullRequest {
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePullRequestContentInput {
    pub number: u64,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GhIssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GhIssue {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub state: GhIssueState,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateIssueInput {
    pub repository_owner: String,
    pub repository_name: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedIssue {
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateIssueContentInput {
    pub repository_owner: String,
    pub repository_name: String,
    pub number: u64,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueStateChange {
    Close,
    Reopen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestStateChange {
    Close,
    Reopen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteWriteAuthorization {
    Denied,
    Approved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitHubCliErrorCode {
    Unavailable,
    NotAuthenticated,
    TimedOut,
    Cancelled,
    OutputTooLarge,
    InvalidInput,
    InvalidResponse,
    CommandFailed,
    UncertainEffect,
    UserDenied,
    NotGitRepository,
    DetachedHead,
    NoRemote,
    UnsupportedRemote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GitHubCliError {
    code: GitHubCliErrorCode,
    message: &'static str,
}

impl GitHubCliError {
    pub const fn new(code: GitHubCliErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const fn code(&self) -> GitHubCliErrorCode {
        self.code
    }
}
