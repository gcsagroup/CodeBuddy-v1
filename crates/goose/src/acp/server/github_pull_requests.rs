use super::*;
use crate::github_auth::pull_requests::{
    inspect_local_repository_for_delivery, GitHubPullRequestError, LocalPullRequestPreview,
    PullRequestInput,
};
use crate::github_cli::{
    CreatePullRequestInput, GhAuthStatus, GhCheckBucket, GhPullRequestState, GhRunner, GitHubCli,
    GitHubCliError, GitHubCliErrorCode, ProcessGhRunner, PullRequestStateChange,
    RemoteWriteAuthorization, UpdatePullRequestContentInput,
};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

pub(super) static DELIVERY_WRITE_LIFECYCLE: std::sync::OnceLock<tokio::sync::Mutex<()>> =
    std::sync::OnceLock::new();

fn legacy_pull_request_path_enabled() -> bool {
    crate::config::codebuddy_paths::environment_override("CODEBUDDY_GITHUB_PR_LEGACY")
        .is_some_and(|value| value == "1")
}

fn service_error_data(error: GitHubPullRequestError) -> serde_json::Value {
    serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    })
}

fn service_error(error: GitHubPullRequestError) -> agent_client_protocol::Error {
    let data = service_error_data(error);
    match error {
        GitHubPullRequestError::InvalidDirectory
        | GitHubPullRequestError::NotGitRepository
        | GitHubPullRequestError::DirtyWorktree
        | GitHubPullRequestError::DetachedHead
        | GitHubPullRequestError::MissingUpstream
        | GitHubPullRequestError::UpstreamMismatch
        | GitHubPullRequestError::UnsupportedRemote
        | GitHubPullRequestError::HeadNotPushed
        | GitHubPullRequestError::MissingDefaultBranch
        | GitHubPullRequestError::InvalidBaseBranch
        | GitHubPullRequestError::BaseBranchNotFound
        | GitHubPullRequestError::SameBranch
        | GitHubPullRequestError::NoCommits
        | GitHubPullRequestError::InvalidTitle
        | GitHubPullRequestError::BodyTooLong
        | GitHubPullRequestError::NotAuthenticated
        | GitHubPullRequestError::ExistingPullRequest
        | GitHubPullRequestError::InvalidPreflightId
        | GitHubPullRequestError::PreflightStale => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        GitHubPullRequestError::GitFailed
        | GitHubPullRequestError::GitOutputTooLarge
        | GitHubPullRequestError::InvalidApiBase
        | GitHubPullRequestError::NetworkUnavailable
        | GitHubPullRequestError::GitHubRejected
        | GitHubPullRequestError::InvalidGitHubResponse
        | GitHubPullRequestError::GitHubResponseTooLarge
        | GitHubPullRequestError::CredentialUnavailable => {
            agent_client_protocol::Error::internal_error().data(data)
        }
    }
}

fn cli_error_code(code: GitHubCliErrorCode) -> &'static str {
    match code {
        GitHubCliErrorCode::Unavailable => "cli_unavailable",
        GitHubCliErrorCode::NotAuthenticated => "not_authenticated",
        GitHubCliErrorCode::TimedOut => "command_timed_out",
        GitHubCliErrorCode::Cancelled => "command_cancelled",
        GitHubCliErrorCode::OutputTooLarge => "output_too_large",
        GitHubCliErrorCode::InvalidInput => "invalid_input",
        GitHubCliErrorCode::InvalidResponse => "invalid_response",
        GitHubCliErrorCode::CommandFailed => "command_failed",
        GitHubCliErrorCode::UncertainEffect => "uncertain_effect",
        GitHubCliErrorCode::UserDenied => "user_denied",
        GitHubCliErrorCode::NotGitRepository => "not_git_repository",
        GitHubCliErrorCode::DetachedHead => "detached_head",
        GitHubCliErrorCode::NoRemote => "no_remote",
        GitHubCliErrorCode::UnsupportedRemote => "unsupported_remote",
    }
}

fn cli_error(error: GitHubCliError) -> agent_client_protocol::Error {
    let data = serde_json::json!({
        "code": cli_error_code(error.code()),
        "message": error.to_string(),
    });
    match error.code() {
        GitHubCliErrorCode::InvalidInput
        | GitHubCliErrorCode::NotGitRepository
        | GitHubCliErrorCode::DetachedHead
        | GitHubCliErrorCode::NoRemote
        | GitHubCliErrorCode::UnsupportedRemote
        | GitHubCliErrorCode::NotAuthenticated
        | GitHubCliErrorCode::UserDenied => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        _ => agent_client_protocol::Error::internal_error().data(data),
    }
}

async fn delivery_status<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubDeliveryStatusRequest,
) -> Result<GitHubDeliveryStatusResponse, GitHubCliError> {
    let cwd = Path::new(&request.working_dir);
    let repository = cli.inspect_repository(cwd).await?;
    let public_repository = GitHubDeliveryRepository {
        owner: repository.owner,
        name: repository.name,
        url: repository.url,
        head_branch: repository.head_branch.clone(),
    };
    let auth = match cli.auth_status(cwd).await {
        Ok(auth) => auth,
        Err(error) if error.code() == GitHubCliErrorCode::Unavailable => {
            return Ok(GitHubDeliveryStatusResponse {
                cli_status: GitHubDeliveryCliStatus::Unavailable,
                repository: Some(public_repository),
                ..Default::default()
            });
        }
        Err(error) => return Err(error),
    };
    let GhAuthStatus::Authenticated { login } = auth else {
        return Ok(GitHubDeliveryStatusResponse {
            cli_status: GitHubDeliveryCliStatus::NotAuthenticated,
            repository: Some(public_repository),
            ..Default::default()
        });
    };
    let pull_request = cli
        .current_pull_request(cwd, &repository.head_branch)
        .await?;
    let required_checks = if let Some(pull_request) = &pull_request {
        cli.required_checks(cwd, &pull_request.number.to_string())
            .await?
            .into_iter()
            .map(|check| GitHubDeliveryCheck {
                name: check.name,
                state: check.state,
                bucket: match check.bucket {
                    GhCheckBucket::Pass => GitHubDeliveryCheckBucket::Pass,
                    GhCheckBucket::Fail => GitHubDeliveryCheckBucket::Fail,
                    GhCheckBucket::Pending => GitHubDeliveryCheckBucket::Pending,
                    GhCheckBucket::Skipping => GitHubDeliveryCheckBucket::Skipping,
                    GhCheckBucket::Cancel => GitHubDeliveryCheckBucket::Cancel,
                },
                url: check.link,
                description: check.description,
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(GitHubDeliveryStatusResponse {
        cli_status: GitHubDeliveryCliStatus::Ready,
        account_login: Some(login),
        repository: Some(public_repository),
        pull_request: pull_request.map(|pull_request| GitHubDeliveryPullRequest {
            number: pull_request.number,
            title: pull_request.title,
            body: pull_request.body,
            state: match pull_request.state {
                GhPullRequestState::Open => GitHubDeliveryPullRequestState::Open,
                GhPullRequestState::Closed => GitHubDeliveryPullRequestState::Closed,
                GhPullRequestState::Merged => GitHubDeliveryPullRequestState::Merged,
            },
            url: pull_request.url,
            head_branch: pull_request.head_ref_name,
            base_branch: pull_request.base_ref_name,
            draft: pull_request.is_draft,
        }),
        required_checks,
    })
}

#[derive(Debug)]
enum DeliveryPullRequestError {
    Local(GitHubPullRequestError),
    Cli(GitHubCliError),
}

impl From<GitHubPullRequestError> for DeliveryPullRequestError {
    fn from(error: GitHubPullRequestError) -> Self {
        Self::Local(error)
    }
}

impl From<GitHubCliError> for DeliveryPullRequestError {
    fn from(error: GitHubCliError) -> Self {
        Self::Cli(error)
    }
}

fn delivery_error(error: DeliveryPullRequestError) -> agent_client_protocol::Error {
    match error {
        DeliveryPullRequestError::Local(error) => service_error(error),
        DeliveryPullRequestError::Cli(error) => cli_error(error),
    }
}

fn pull_request_input(
    working_dir: &str,
    title: &str,
    body: &str,
    base_branch: &Option<String>,
    draft: bool,
    maintainer_can_modify: bool,
) -> PullRequestInput {
    PullRequestInput {
        working_dir: PathBuf::from(working_dir),
        title: title.to_string(),
        body: body.to_string(),
        base_branch: base_branch.clone(),
        draft,
        maintainer_can_modify,
    }
}

fn public_delivery_preview(preview: &LocalPullRequestPreview) -> GitHubPullRequestPreviewResponse {
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

async fn preview_delivery_pull_request<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubPullRequestPreviewRequest,
) -> Result<GitHubPullRequestPreviewResponse, DeliveryPullRequestError> {
    let preview = inspect_local_repository_for_delivery(&pull_request_input(
        &request.working_dir,
        &request.title,
        &request.body,
        &request.base_branch,
        request.draft,
        request.maintainer_can_modify,
    ))
    .await?;
    if !matches!(
        cli.auth_status(&preview.repository_root).await?,
        GhAuthStatus::Authenticated { .. }
    ) {
        return Err(GitHubPullRequestError::NotAuthenticated.into());
    }
    if cli
        .current_pull_request(&preview.repository_root, &preview.head_branch)
        .await?
        .is_some()
    {
        return Err(GitHubPullRequestError::ExistingPullRequest.into());
    }
    Ok(public_delivery_preview(&preview))
}

async fn create_delivery_pull_request<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    preview: &LocalPullRequestPreview,
    request: &GitHubPullRequestCreateRequest,
    authorization: RemoteWriteAuthorization,
) -> Result<GitHubPullRequestCreateResponse, DeliveryPullRequestError> {
    if request.preflight_id.len() != 64
        || !request
            .preflight_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(GitHubPullRequestError::InvalidPreflightId.into());
    }
    if request.preflight_id != preview.preflight_id {
        return Err(GitHubPullRequestError::PreflightStale.into());
    }
    if !matches!(
        cli.auth_status(&preview.repository_root).await?,
        GhAuthStatus::Authenticated { .. }
    ) {
        return Err(GitHubPullRequestError::NotAuthenticated.into());
    }
    if cli
        .current_pull_request(&preview.repository_root, &preview.head_branch)
        .await?
        .is_some()
    {
        return Err(GitHubPullRequestError::ExistingPullRequest.into());
    }
    cli.push_branch(
        &preview.repository_root,
        &preview.remote,
        &preview.head_branch,
        authorization,
    )
    .await?;
    let created = cli
        .create_pull_request(
            &preview.repository_root,
            CreatePullRequestInput {
                repository_owner: preview.repository.owner.clone(),
                repository_name: preview.repository.name.clone(),
                head_branch: preview.head_branch.clone(),
                base_branch: Some(preview.base_branch.clone()),
                title: preview.title.clone(),
                body: preview.body.clone(),
                draft: preview.draft,
            },
            authorization,
        )
        .await?;
    Ok(GitHubPullRequestCreateResponse {
        number: created.number,
        title: preview.title.clone(),
        state: "open".to_string(),
        html_url: created.url,
        head_branch: preview.head_branch.clone(),
        base_branch: preview.base_branch.clone(),
        draft: preview.draft,
    })
}

#[derive(Debug)]
struct DeliveryStatePreview {
    preflight_id: String,
    pull_request: crate::github_cli::GhPullRequest,
    target_state: GitHubPullRequestTargetState,
}

fn public_pull_request_state(state: GhPullRequestState) -> GitHubDeliveryPullRequestState {
    match state {
        GhPullRequestState::Open => GitHubDeliveryPullRequestState::Open,
        GhPullRequestState::Closed => GitHubDeliveryPullRequestState::Closed,
        GhPullRequestState::Merged => GitHubDeliveryPullRequestState::Merged,
    }
}

fn state_preflight_id(
    working_dir: &str,
    repository: &crate::github_cli::GitRepositoryContext,
    pull_request: &crate::github_cli::GhPullRequest,
    target_state: GitHubPullRequestTargetState,
) -> String {
    let current_state = match pull_request.state {
        GhPullRequestState::Open => "open",
        GhPullRequestState::Closed => "closed",
        GhPullRequestState::Merged => "merged",
    };
    let target_state = match target_state {
        GitHubPullRequestTargetState::Open => "open",
        GitHubPullRequestTargetState::Closed => "closed",
    };
    let mut hasher = Sha256::new();
    for (key, value) in [
        ("version", "1".to_string()),
        ("working_dir", working_dir.to_string()),
        ("repository", repository.url.clone()),
        ("head_branch", repository.head_branch.clone()),
        ("number", pull_request.number.to_string()),
        ("title", pull_request.title.clone()),
        ("current_state", current_state.to_string()),
        ("target_state", target_state.to_string()),
        ("url", pull_request.url.clone()),
        ("base_branch", pull_request.base_ref_name.clone()),
    ] {
        hasher.update((key.len() as u64).to_be_bytes());
        hasher.update(key.as_bytes());
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

async fn inspect_delivery_state_change<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    working_dir: &str,
    number: u64,
    target_state: GitHubPullRequestTargetState,
) -> Result<DeliveryStatePreview, GitHubCliError> {
    if number == 0 {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request number is invalid",
        ));
    }
    let cwd = Path::new(working_dir);
    let repository = cli.inspect_repository(cwd).await?;
    if !matches!(
        cli.auth_status(cwd).await?,
        GhAuthStatus::Authenticated { .. }
    ) {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::NotAuthenticated,
            "GitHub CLI authentication is required",
        ));
    }
    let pull_request = cli
        .current_pull_request(cwd, &repository.head_branch)
        .await?
        .filter(|pull_request| pull_request.number == number)
        .ok_or_else(|| {
            GitHubCliError::new(
                GitHubCliErrorCode::InvalidInput,
                "Pull Request does not match the current branch",
            )
        })?;
    let valid_transition = matches!(
        (pull_request.state, target_state),
        (
            GhPullRequestState::Open,
            GitHubPullRequestTargetState::Closed
        ) | (
            GhPullRequestState::Closed,
            GitHubPullRequestTargetState::Open
        )
    );
    if !valid_transition {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request state transition is invalid",
        ));
    }
    Ok(DeliveryStatePreview {
        preflight_id: state_preflight_id(working_dir, &repository, &pull_request, target_state),
        pull_request,
        target_state,
    })
}

fn public_state_preview(preview: DeliveryStatePreview) -> GitHubPullRequestStatePreviewResponse {
    GitHubPullRequestStatePreviewResponse {
        preflight_id: preview.preflight_id,
        number: preview.pull_request.number,
        title: preview.pull_request.title,
        current_state: public_pull_request_state(preview.pull_request.state),
        target_state: preview.target_state,
        url: preview.pull_request.url,
        head_branch: preview.pull_request.head_ref_name,
        base_branch: preview.pull_request.base_ref_name,
    }
}

async fn change_delivery_pull_request_state<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubPullRequestStateChangeRequest,
    authorization: RemoteWriteAuthorization,
) -> Result<GitHubPullRequestStateChangeResponse, GitHubCliError> {
    if request.preflight_id.len() != 64
        || !request
            .preflight_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request state preflight is invalid",
        ));
    }
    let preview = inspect_delivery_state_change(
        cli,
        &request.working_dir,
        request.number,
        request.target_state,
    )
    .await?;
    if preview.preflight_id != request.preflight_id {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request state preflight is stale",
        ));
    }
    let change = match request.target_state {
        GitHubPullRequestTargetState::Closed => PullRequestStateChange::Close,
        GitHubPullRequestTargetState::Open => PullRequestStateChange::Reopen,
    };
    cli.change_pull_request_state(
        Path::new(&request.working_dir),
        request.number,
        change,
        authorization,
    )
    .await?;
    Ok(GitHubPullRequestStateChangeResponse {
        number: preview.pull_request.number,
        state: match request.target_state {
            GitHubPullRequestTargetState::Closed => GitHubDeliveryPullRequestState::Closed,
            GitHubPullRequestTargetState::Open => GitHubDeliveryPullRequestState::Open,
        },
        url: preview.pull_request.url,
    })
}

#[derive(Debug)]
struct DeliveryContentPreview {
    preflight_id: String,
    pull_request: crate::github_cli::GhPullRequest,
    target_title: String,
    target_body: String,
}

fn content_preflight_id(
    working_dir: &str,
    repository: &crate::github_cli::GitRepositoryContext,
    pull_request: &crate::github_cli::GhPullRequest,
    target_title: &str,
    target_body: &str,
) -> String {
    let current_state = match pull_request.state {
        GhPullRequestState::Open => "open",
        GhPullRequestState::Closed => "closed",
        GhPullRequestState::Merged => "merged",
    };
    let mut hasher = Sha256::new();
    for (key, value) in [
        ("version", "1".to_string()),
        ("working_dir", working_dir.to_string()),
        ("repository", repository.url.clone()),
        ("head_branch", repository.head_branch.clone()),
        ("number", pull_request.number.to_string()),
        ("current_title", pull_request.title.clone()),
        ("current_body", pull_request.body.clone()),
        ("current_state", current_state.to_string()),
        ("target_title", target_title.to_string()),
        ("target_body", target_body.to_string()),
        ("url", pull_request.url.clone()),
        ("base_branch", pull_request.base_ref_name.clone()),
    ] {
        hasher.update((key.len() as u64).to_be_bytes());
        hasher.update(key.as_bytes());
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

async fn inspect_delivery_content_change<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    working_dir: &str,
    number: u64,
    title: &str,
    body: &str,
) -> Result<DeliveryContentPreview, GitHubCliError> {
    if number == 0
        || title.trim().is_empty()
        || title.len() > 256
        || title.chars().any(char::is_control)
        || body.len() > 65_536
    {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request content is invalid",
        ));
    }
    let cwd = Path::new(working_dir);
    let repository = cli.inspect_repository(cwd).await?;
    if !matches!(
        cli.auth_status(cwd).await?,
        GhAuthStatus::Authenticated { .. }
    ) {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::NotAuthenticated,
            "GitHub CLI authentication is required",
        ));
    }
    let pull_request = cli
        .current_pull_request(cwd, &repository.head_branch)
        .await?
        .filter(|pull_request| pull_request.number == number)
        .ok_or_else(|| {
            GitHubCliError::new(
                GitHubCliErrorCode::InvalidInput,
                "Pull Request does not match the current branch",
            )
        })?;
    if pull_request.state == GhPullRequestState::Merged {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Merged Pull Requests are read-only",
        ));
    }
    if pull_request.title == title && pull_request.body == body {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request content is unchanged",
        ));
    }
    Ok(DeliveryContentPreview {
        preflight_id: content_preflight_id(working_dir, &repository, &pull_request, title, body),
        pull_request,
        target_title: title.to_string(),
        target_body: body.to_string(),
    })
}

fn public_content_preview(
    preview: DeliveryContentPreview,
) -> GitHubPullRequestContentPreviewResponse {
    GitHubPullRequestContentPreviewResponse {
        preflight_id: preview.preflight_id,
        number: preview.pull_request.number,
        current_title: preview.pull_request.title,
        current_body: preview.pull_request.body,
        target_title: preview.target_title,
        target_body: preview.target_body,
        state: public_pull_request_state(preview.pull_request.state),
        url: preview.pull_request.url,
        head_branch: preview.pull_request.head_ref_name,
        base_branch: preview.pull_request.base_ref_name,
    }
}

async fn update_delivery_pull_request_content<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubPullRequestContentUpdateRequest,
    authorization: RemoteWriteAuthorization,
) -> Result<GitHubPullRequestContentUpdateResponse, GitHubCliError> {
    if request.preflight_id.len() != 64
        || !request
            .preflight_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request content preflight is invalid",
        ));
    }
    let preview = inspect_delivery_content_change(
        cli,
        &request.working_dir,
        request.number,
        &request.title,
        &request.body,
    )
    .await?;
    if preview.preflight_id != request.preflight_id {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::InvalidInput,
            "Pull Request content preflight is stale",
        ));
    }
    cli.update_pull_request_content(
        Path::new(&request.working_dir),
        UpdatePullRequestContentInput {
            number: request.number,
            title: request.title.clone(),
            body: request.body.clone(),
        },
        authorization,
    )
    .await?;
    Ok(GitHubPullRequestContentUpdateResponse {
        number: preview.pull_request.number,
        title: preview.target_title,
        body: preview.target_body,
        state: public_pull_request_state(preview.pull_request.state),
        url: preview.pull_request.url,
    })
}

impl GooseAcpAgent {
    pub(super) async fn on_github_delivery_status(
        &self,
        req: GitHubDeliveryStatusRequest,
    ) -> Result<GitHubDeliveryStatusResponse, agent_client_protocol::Error> {
        delivery_status(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(cli_error)
    }

    pub(super) async fn on_github_pull_request_preview(
        &self,
        req: GitHubPullRequestPreviewRequest,
    ) -> Result<GitHubPullRequestPreviewResponse, agent_client_protocol::Error> {
        if legacy_pull_request_path_enabled() {
            warn!("CodePro GitHub PR preview is using the legacy REST rollback path");
            return self
                .github_auth
                .preview_pull_request(req)
                .await
                .map_err(service_error);
        }
        preview_delivery_pull_request(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(delivery_error)
    }

    pub(super) async fn on_github_pull_request_create(
        &self,
        req: GitHubPullRequestCreateRequest,
    ) -> Result<GitHubPullRequestCreateResponse, agent_client_protocol::Error> {
        if legacy_pull_request_path_enabled() {
            warn!("CodePro GitHub PR create is using the legacy REST rollback path");
            return self
                .github_auth
                .create_pull_request(req)
                .await
                .map_err(service_error);
        }
        let _lifecycle = DELIVERY_WRITE_LIFECYCLE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let preview = inspect_local_repository_for_delivery(&pull_request_input(
            &req.working_dir,
            &req.title,
            &req.body,
            &req.base_branch,
            req.draft,
            req.maintainer_can_modify,
        ))
        .await
        .map_err(service_error)?;
        create_delivery_pull_request(
            &GitHubCli::new(ProcessGhRunner),
            &preview,
            &req,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .map_err(delivery_error)
    }

    pub(super) async fn on_github_pull_request_state_preview(
        &self,
        req: GitHubPullRequestStatePreviewRequest,
    ) -> Result<GitHubPullRequestStatePreviewResponse, agent_client_protocol::Error> {
        inspect_delivery_state_change(
            &GitHubCli::new(ProcessGhRunner),
            &req.working_dir,
            req.number,
            req.target_state,
        )
        .await
        .map(public_state_preview)
        .map_err(cli_error)
    }

    pub(super) async fn on_github_pull_request_state_change(
        &self,
        req: GitHubPullRequestStateChangeRequest,
    ) -> Result<GitHubPullRequestStateChangeResponse, agent_client_protocol::Error> {
        let _lifecycle = DELIVERY_WRITE_LIFECYCLE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        change_delivery_pull_request_state(
            &GitHubCli::new(ProcessGhRunner),
            &req,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .map_err(cli_error)
    }

    pub(super) async fn on_github_pull_request_content_preview(
        &self,
        req: GitHubPullRequestContentPreviewRequest,
    ) -> Result<GitHubPullRequestContentPreviewResponse, agent_client_protocol::Error> {
        inspect_delivery_content_change(
            &GitHubCli::new(ProcessGhRunner),
            &req.working_dir,
            req.number,
            &req.title,
            &req.body,
        )
        .await
        .map(public_content_preview)
        .map_err(cli_error)
    }

    pub(super) async fn on_github_pull_request_content_update(
        &self,
        req: GitHubPullRequestContentUpdateRequest,
    ) -> Result<GitHubPullRequestContentUpdateResponse, agent_client_protocol::Error> {
        let _lifecycle = DELIVERY_WRITE_LIFECYCLE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        update_delivery_pull_request_content(
            &GitHubCli::new(ProcessGhRunner),
            &req,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .map_err(cli_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github_cli::{GhCommand, GhCommandOutput, GhRunError, GhRunner, GitHubCli};
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[derive(Clone, Default)]
    struct DeliveryRunner {
        outputs: Arc<Mutex<VecDeque<Result<GhCommandOutput, GhRunError>>>>,
        commands: Arc<Mutex<Vec<GhCommand>>>,
    }

    #[async_trait]
    impl GhRunner for DeliveryRunner {
        async fn run(&self, command: GhCommand) -> Result<GhCommandOutput, GhRunError> {
            self.commands.lock().await.push(command);
            self.outputs
                .lock()
                .await
                .pop_front()
                .expect("missing delivery fixture output")
        }
    }

    impl DeliveryRunner {
        async fn push(&self, exit_code: i32, stdout: &str) {
            self.outputs.lock().await.push_back(Ok(GhCommandOutput {
                exit_code,
                stdout: stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
            }));
        }
    }

    #[tokio::test]
    async fn github_delivery_status_reports_current_pr_and_required_checks() {
        let runner = DeliveryRunner::default();
        for (exit_code, stdout) in [
            (0, "true\n"),
            (0, "feature/bounded\n"),
            (0, "git@github.com:octo/demo.git\n"),
            (
                0,
                r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
            ),
            (
                0,
                r#"[{"number":42,"title":"Ship","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}]"#,
            ),
            (
                0,
                r#"{"number":42,"title":"Ship","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}"#,
            ),
            (
                8,
                r#"[{"name":"build","state":"QUEUED","bucket":"pending","link":"https://github.com/octo/demo/actions/runs/1","description":"Required build"}]"#,
            ),
        ] {
            runner.push(exit_code, stdout).await;
        }

        let response = delivery_status(
            &GitHubCli::new(runner.clone()),
            &GitHubDeliveryStatusRequest {
                working_dir: r"D:\fixture".to_string(),
            },
        )
        .await
        .unwrap();

        assert_eq!(response.cli_status, GitHubDeliveryCliStatus::Ready);
        assert_eq!(response.account_login.as_deref(), Some("octocat"));
        assert_eq!(response.repository.unwrap().head_branch, "feature/bounded");
        assert_eq!(response.pull_request.unwrap().number, 42);
        assert_eq!(response.required_checks.len(), 1);
        assert_eq!(
            response.required_checks[0].bucket,
            GitHubDeliveryCheckBucket::Pending
        );
    }

    #[tokio::test]
    async fn github_delivery_status_turns_missing_gh_into_install_recovery_state() {
        let runner = DeliveryRunner::default();
        for (exit_code, stdout) in [
            (0, "true\n"),
            (0, "feature/bounded\n"),
            (0, "git@github.com:octo/demo.git\n"),
        ] {
            runner.push(exit_code, stdout).await;
        }
        runner
            .outputs
            .lock()
            .await
            .push_back(Err(GhRunError::Unavailable));

        let response = delivery_status(
            &GitHubCli::new(runner),
            &GitHubDeliveryStatusRequest {
                working_dir: r"D:\fixture".to_string(),
            },
        )
        .await
        .unwrap();

        assert_eq!(response.cli_status, GitHubDeliveryCliStatus::Unavailable);
        assert!(response.repository.is_some());
        assert!(response.pull_request.is_none());
        assert!(response.required_checks.is_empty());
    }

    #[tokio::test]
    async fn confirmed_delivery_preview_creates_through_gh_without_shell() {
        use crate::github_auth::pull_requests::{GitHubRepository, LocalPullRequestPreview};
        use crate::github_cli::RemoteWriteAuthorization;

        let runner = DeliveryRunner::default();
        for (exit_code, stdout) in [
            (
                0,
                r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
            ),
            (0, "[]"),
            (0, ""),
            (0, "https://github.com/octo/demo/pull/42\n"),
        ] {
            runner.push(exit_code, stdout).await;
        }
        let preview = LocalPullRequestPreview {
            preflight_id: "a".repeat(64),
            repository: GitHubRepository {
                owner: "octo".to_string(),
                name: "demo".to_string(),
            },
            repository_root: PathBuf::from(r"D:\fixture"),
            remote: "origin".to_string(),
            head_branch: "feature/bounded".to_string(),
            head_sha: "1".repeat(40),
            base_branch: "main".to_string(),
            base_sha: "2".repeat(40),
            commit_count: 1,
            changed_file_count: 2,
            title: "Ship bounded delivery".to_string(),
            body: "Verified locally".to_string(),
            draft: false,
            maintainer_can_modify: false,
        };
        let request = GitHubPullRequestCreateRequest {
            working_dir: r"D:\fixture".to_string(),
            title: preview.title.clone(),
            body: preview.body.clone(),
            base_branch: Some(preview.base_branch.clone()),
            draft: false,
            maintainer_can_modify: false,
            preflight_id: preview.preflight_id.clone(),
        };

        let created = create_delivery_pull_request(
            &GitHubCli::new(runner.clone()),
            &preview,
            &request,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap();

        assert_eq!(created.number, 42);
        assert_eq!(created.html_url, "https://github.com/octo/demo/pull/42");
        assert_eq!(created.head_branch, "feature/bounded");
        assert_eq!(created.base_branch, "main");
        let commands = runner.commands.lock().await;
        assert_eq!(commands[2].executable, "git");
        assert_eq!(commands[2].args[0], "push");
        assert_eq!(commands[3].executable, "gh");
        assert_eq!(&commands[3].args[..2], ["pr", "create"]);
    }

    #[tokio::test]
    async fn state_change_preview_binds_current_branch_pr_and_transition() {
        let runner = DeliveryRunner::default();
        for (exit_code, stdout) in [
            (0, "true\n"),
            (0, "feature/bounded\n"),
            (0, "git@github.com:octo/demo.git\n"),
            (
                0,
                r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
            ),
            (
                0,
                r#"[{"number":42,"title":"Ship","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}]"#,
            ),
            (
                0,
                r#"{"number":42,"title":"Ship","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}"#,
            ),
        ] {
            runner.push(exit_code, stdout).await;
        }

        let preview = inspect_delivery_state_change(
            &GitHubCli::new(runner),
            r"D:\fixture",
            42,
            GitHubPullRequestTargetState::Closed,
        )
        .await
        .unwrap();

        assert_eq!(preview.preflight_id.len(), 64);
        assert!(preview
            .preflight_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert_eq!(preview.pull_request.number, 42);
        assert_eq!(preview.pull_request.state, GhPullRequestState::Open);
        assert_eq!(preview.target_state, GitHubPullRequestTargetState::Closed);
    }

    #[tokio::test]
    async fn state_change_preview_rejects_merged_pull_requests() {
        let runner = DeliveryRunner::default();
        for (exit_code, stdout) in [
            (0, "true\n"),
            (0, "feature/bounded\n"),
            (0, "git@github.com:octo/demo.git\n"),
            (
                0,
                r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
            ),
            (
                0,
                r#"[{"number":42,"title":"Ship","state":"MERGED","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}]"#,
            ),
            (
                0,
                r#"{"number":42,"title":"Ship","state":"MERGED","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}"#,
            ),
        ] {
            runner.push(exit_code, stdout).await;
        }

        let error = inspect_delivery_state_change(
            &GitHubCli::new(runner),
            r"D:\fixture",
            42,
            GitHubPullRequestTargetState::Open,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code(), GitHubCliErrorCode::InvalidInput);
    }

    #[tokio::test]
    async fn state_change_rechecks_preflight_before_fixed_remote_write() {
        async fn configured_runner(include_write: bool) -> DeliveryRunner {
            let runner = DeliveryRunner::default();
            for (exit_code, stdout) in [
                (0, "true\n"),
                (0, "feature/bounded\n"),
                (0, "git@github.com:octo/demo.git\n"),
                (
                    0,
                    r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
                ),
                (
                    0,
                    r#"[{"number":42,"title":"Ship","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}]"#,
                ),
                (
                    0,
                    r#"{"number":42,"title":"Ship","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}"#,
                ),
            ] {
                runner.push(exit_code, stdout).await;
            }
            if include_write {
                runner.push(0, "").await;
            }
            runner
        }

        let preview_runner = configured_runner(false).await;
        let preview = inspect_delivery_state_change(
            &GitHubCli::new(preview_runner),
            r"D:\fixture",
            42,
            GitHubPullRequestTargetState::Closed,
        )
        .await
        .unwrap();
        let request = GitHubPullRequestStateChangeRequest {
            working_dir: r"D:\fixture".to_string(),
            number: 42,
            target_state: GitHubPullRequestTargetState::Closed,
            preflight_id: preview.preflight_id,
        };

        let stale_runner = configured_runner(false).await;
        let mut stale_request = request.clone();
        stale_request.preflight_id = "0".repeat(64);
        let stale = change_delivery_pull_request_state(
            &GitHubCli::new(stale_runner.clone()),
            &stale_request,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code(), GitHubCliErrorCode::InvalidInput);
        assert_eq!(stale_runner.commands.lock().await.len(), 6);

        let runner = configured_runner(true).await;
        let response = change_delivery_pull_request_state(
            &GitHubCli::new(runner.clone()),
            &request,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap();
        assert_eq!(response.number, 42);
        assert_eq!(response.state, GitHubDeliveryPullRequestState::Closed);
        let commands = runner.commands.lock().await;
        assert_eq!(commands.len(), 7);
        assert_eq!(commands[6].args, ["pr", "close", "42"]);
    }

    #[tokio::test]
    async fn content_update_rechecks_preflight_and_sends_body_only_on_stdin() {
        async fn configured_runner(include_write: bool) -> DeliveryRunner {
            let runner = DeliveryRunner::default();
            for (exit_code, stdout) in [
                (0, "true\n"),
                (0, "feature/bounded\n"),
                (0, "git@github.com:octo/demo.git\n"),
                (
                    0,
                    r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
                ),
                (
                    0,
                    r#"[{"number":42,"title":"Ship","body":"Old body","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}]"#,
                ),
                (
                    0,
                    r#"{"number":42,"title":"Ship","body":"Old body","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}"#,
                ),
            ] {
                runner.push(exit_code, stdout).await;
            }
            if include_write {
                runner.push(0, "").await;
            }
            runner
        }

        let preview_runner = configured_runner(false).await;
        let preview = inspect_delivery_content_change(
            &GitHubCli::new(preview_runner),
            r"D:\fixture",
            42,
            "Clarify delivery",
            "New body $(not a shell)",
        )
        .await
        .unwrap();
        assert_eq!(preview.preflight_id.len(), 64);
        assert_eq!(preview.pull_request.body, "Old body");

        let request = GitHubPullRequestContentUpdateRequest {
            working_dir: r"D:\fixture".to_string(),
            number: 42,
            title: "Clarify delivery".to_string(),
            body: "New body $(not a shell)".to_string(),
            preflight_id: preview.preflight_id,
        };
        let stale_runner = configured_runner(false).await;
        let mut stale_request = request.clone();
        stale_request.preflight_id = "0".repeat(64);
        let stale = update_delivery_pull_request_content(
            &GitHubCli::new(stale_runner.clone()),
            &stale_request,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code(), GitHubCliErrorCode::InvalidInput);
        assert_eq!(stale_runner.commands.lock().await.len(), 6);

        let runner = configured_runner(true).await;
        let response = update_delivery_pull_request_content(
            &GitHubCli::new(runner.clone()),
            &request,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap();
        assert_eq!(response.number, 42);
        assert_eq!(response.title, "Clarify delivery");
        assert_eq!(response.body, "New body $(not a shell)");
        let commands = runner.commands.lock().await;
        assert_eq!(commands.len(), 7);
        assert_eq!(
            commands[6].args,
            [
                "pr",
                "edit",
                "42",
                "--title",
                "Clarify delivery",
                "--body-file",
                "-"
            ]
        );
        assert_eq!(
            commands[6].stdin.as_deref(),
            Some("New body $(not a shell)".as_bytes())
        );
    }

    #[test]
    fn pull_request_errors_are_mapped_to_stable_secret_safe_data() {
        let secret = "ghu_acp-secret-must-not-leak";
        for error in [
            GitHubPullRequestError::InvalidDirectory,
            GitHubPullRequestError::DirtyWorktree,
            GitHubPullRequestError::UnsupportedRemote,
            GitHubPullRequestError::HeadNotPushed,
            GitHubPullRequestError::ExistingPullRequest,
            GitHubPullRequestError::PreflightStale,
            GitHubPullRequestError::CredentialUnavailable,
            GitHubPullRequestError::NetworkUnavailable,
            GitHubPullRequestError::InvalidGitHubResponse,
        ] {
            let data = service_error_data(error);
            assert_eq!(data["code"], error.code());
            assert!(data["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()));
            assert!(!data.to_string().contains(secret));
        }
    }
}
