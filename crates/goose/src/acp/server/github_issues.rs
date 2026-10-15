use super::*;
use crate::agents::tool_idempotency::{
    BeginDecision, ToolIdempotencyError, ToolIdempotencyInput, ToolIdempotencyOutcome,
    ToolIdempotencyStore,
};
use crate::github_cli::{
    CreateIssueInput, GhAuthStatus, GhIssue, GhIssueState, GhRunner, GitHubCli, GitHubCliError,
    GitHubCliErrorCode, IssueStateChange, ProcessGhRunner, RemoteWriteAuthorization,
    UpdateIssueContentInput,
};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

const ISSUE_CREATE_IDEMPOTENCY_TOOL: &str = "github_issue_create";
const ISSUE_OPERATION_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
const ISSUE_OPERATION_FUTURE_SKEW: std::time::Duration = std::time::Duration::from_secs(60);

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

fn invalid_input(message: &'static str) -> GitHubCliError {
    GitHubCliError::new(GitHubCliErrorCode::InvalidInput, message)
}

fn validate_content(title: &str, body: &str) -> Result<(), GitHubCliError> {
    if title.trim().is_empty()
        || title.len() > 256
        || title.chars().any(char::is_control)
        || body.len() > 65_536
    {
        return Err(invalid_input("Issue content is invalid"));
    }
    Ok(())
}

fn validate_preflight(value: &str) -> Result<(), GitHubCliError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid_input("Issue preflight is invalid"));
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<String, GitHubCliError> {
    let operation_id =
        uuid::Uuid::parse_str(value).map_err(|_| invalid_input("Issue operation ID is invalid"))?;
    if operation_id.get_version() != Some(uuid::Version::SortRand)
        || operation_id.to_string() != value
    {
        return Err(invalid_input("Issue operation ID is invalid"));
    }
    let timestamp = operation_id
        .get_timestamp()
        .ok_or_else(|| invalid_input("Issue operation ID is invalid"))?;
    let (seconds, nanos) = timestamp.to_unix();
    let operation_time = std::time::Duration::new(seconds, nanos);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| invalid_input("Issue operation ID is invalid"))?;
    if operation_time > now.saturating_add(ISSUE_OPERATION_FUTURE_SKEW)
        || now.saturating_sub(operation_time) > ISSUE_OPERATION_MAX_AGE
    {
        return Err(invalid_input("Issue operation ID is expired"));
    }
    Ok(operation_id.to_string())
}

fn public_issue(issue: GhIssue) -> GitHubIssue {
    GitHubIssue {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: match issue.state {
            GhIssueState::Open => GitHubIssueState::Open,
            GhIssueState::Closed => GitHubIssueState::Closed,
        },
        url: issue.url,
    }
}

fn preflight_id(values: &[(&str, String)]) -> String {
    let mut hasher = Sha256::new();
    for (key, value) in values {
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

async fn authenticated_repository<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    working_dir: &str,
) -> Result<crate::github_cli::GitRepositoryContext, GitHubCliError> {
    let cwd = Path::new(working_dir);
    let mut repository = cli.inspect_repository(cwd).await?;
    if !matches!(
        cli.auth_status(cwd).await?,
        GhAuthStatus::Authenticated { .. }
    ) {
        return Err(GitHubCliError::new(
            GitHubCliErrorCode::NotAuthenticated,
            "GitHub CLI authentication is required",
        ));
    }
    repository.owner.make_ascii_lowercase();
    repository.name.make_ascii_lowercase();
    repository.url = format!(
        "https://github.com/{}/{}",
        repository.owner, repository.name
    );
    Ok(repository)
}

fn issue_create_idempotency_input(
    repository_owner: &str,
    repository_name: &str,
    operation_id: String,
    title: &str,
    body: &str,
) -> ToolIdempotencyInput {
    let repository = format!("github.com/{repository_owner}/{repository_name}");
    let content_digest = preflight_id(&[("title", title.to_string()), ("body", body.to_string())]);
    ToolIdempotencyInput {
        session_id: repository.clone(),
        task_scope: None,
        request_id: operation_id,
        tool_name: ISSUE_CREATE_IDEMPOTENCY_TOOL.to_string(),
        arguments: serde_json::json!({
            "repository": repository,
            "contentSha256": content_digest,
        })
        .as_object()
        .expect("issue idempotency input is an object")
        .clone(),
        explicit_user_confirmation: false,
    }
}

fn idempotency_error(error: ToolIdempotencyError) -> GitHubCliError {
    match error {
        ToolIdempotencyError::InvalidInput | ToolIdempotencyError::IdentityConflict => {
            invalid_input("Issue operation identity conflicts with an existing request")
        }
        ToolIdempotencyError::Capacity => GitHubCliError::new(
            GitHubCliErrorCode::CommandFailed,
            "Issue operation journal capacity is exhausted",
        ),
        ToolIdempotencyError::CorruptJournal | ToolIdempotencyError::Persistence => {
            GitHubCliError::new(
                GitHubCliErrorCode::UncertainEffect,
                "Issue operation state is uncertain; inspect GitHub before retrying",
            )
        }
    }
}

async fn list_issues<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubIssueListRequest,
) -> Result<GitHubIssueListResponse, GitHubCliError> {
    let repository = authenticated_repository(cli, &request.working_dir).await?;
    let issues = cli
        .list_issues(
            Path::new(&request.working_dir),
            &repository.owner,
            &repository.name,
        )
        .await?
        .into_iter()
        .map(public_issue)
        .collect();
    Ok(GitHubIssueListResponse {
        repository_url: repository.url,
        issues,
    })
}

async fn preview_create<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubIssueCreatePreviewRequest,
) -> Result<GitHubIssueCreatePreviewResponse, GitHubCliError> {
    validate_content(&request.title, &request.body)?;
    let operation_id = validate_operation_id(&request.operation_id)?;
    let repository = authenticated_repository(cli, &request.working_dir).await?;
    let id = preflight_id(&[
        ("version", "2".to_string()),
        ("operation", "create".to_string()),
        ("operation_id", operation_id.clone()),
        ("working_dir", request.working_dir.clone()),
        ("repository", repository.url.clone()),
        ("head_branch", repository.head_branch.clone()),
        ("title", request.title.clone()),
        ("body", request.body.clone()),
    ]);
    Ok(GitHubIssueCreatePreviewResponse {
        preflight_id: id,
        operation_id,
        repository_owner: repository.owner,
        repository_name: repository.name,
        repository_url: repository.url,
        head_branch: repository.head_branch,
        title: request.title.clone(),
        body: request.body.clone(),
    })
}

async fn create_issue<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    idempotency: &ToolIdempotencyStore,
    request: &GitHubIssueCreateRequest,
) -> Result<GitHubIssueCreateResponse, GitHubCliError> {
    validate_preflight(&request.preflight_id)?;
    let operation_id = validate_operation_id(&request.operation_id)?;
    let preview = preview_create(
        cli,
        &GitHubIssueCreatePreviewRequest {
            working_dir: request.working_dir.clone(),
            operation_id: operation_id.clone(),
            title: request.title.clone(),
            body: request.body.clone(),
        },
    )
    .await?;
    if preview.preflight_id != request.preflight_id {
        return Err(invalid_input("Issue create preflight is stale"));
    }
    let claim = match idempotency
        .begin(issue_create_idempotency_input(
            &preview.repository_owner,
            &preview.repository_name,
            operation_id,
            &request.title,
            &request.body,
        ))
        .await
        .map_err(idempotency_error)?
    {
        BeginDecision::Execute(claim) => claim,
        BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Success) => {
            return Err(invalid_input(
                "Issue create operation already completed; refresh Issues",
            ));
        }
        BeginDecision::ReplaySuppressed(
            ToolIdempotencyOutcome::Error | ToolIdempotencyOutcome::Uncertain,
        )
        | BeginDecision::Ambiguous => {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::UncertainEffect,
                "Issue create result is uncertain; inspect GitHub before retrying",
            ));
        }
        BeginDecision::InFlight => {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::CommandFailed,
                "Issue create operation is already in progress",
            ));
        }
    };
    let created = match cli
        .create_issue(
            Path::new(&request.working_dir),
            CreateIssueInput {
                repository_owner: preview.repository_owner,
                repository_name: preview.repository_name,
                title: request.title.clone(),
                body: request.body.clone(),
            },
            RemoteWriteAuthorization::Approved,
        )
        .await
    {
        Ok(created) => created,
        Err(error)
            if matches!(
                error.code(),
                GitHubCliErrorCode::InvalidInput
                    | GitHubCliErrorCode::UserDenied
                    | GitHubCliErrorCode::Unavailable
            ) =>
        {
            idempotency
                .abandon_definite(&claim)
                .await
                .map_err(idempotency_error)?;
            return Err(error);
        }
        Err(_) => {
            return Err(GitHubCliError::new(
                GitHubCliErrorCode::UncertainEffect,
                "Issue create result is uncertain; inspect GitHub before retrying",
            ));
        }
    };
    idempotency
        .complete(&claim, ToolIdempotencyOutcome::Success)
        .await
        .map_err(idempotency_error)?;
    Ok(GitHubIssueCreateResponse {
        issue: GitHubIssue {
            number: created.number,
            title: request.title.clone(),
            body: request.body.clone(),
            state: GitHubIssueState::Open,
            url: created.url,
        },
    })
}

async fn preview_content<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubIssueContentPreviewRequest,
) -> Result<GitHubIssueContentPreviewResponse, GitHubCliError> {
    validate_content(&request.title, &request.body)?;
    if request.number == 0 {
        return Err(invalid_input("Issue number is invalid"));
    }
    let repository = authenticated_repository(cli, &request.working_dir).await?;
    let issue = cli
        .issue(
            Path::new(&request.working_dir),
            &repository.owner,
            &repository.name,
            request.number,
        )
        .await?;
    if issue.title == request.title && issue.body == request.body {
        return Err(invalid_input("Issue content is unchanged"));
    }
    let state = match issue.state {
        GhIssueState::Open => "open",
        GhIssueState::Closed => "closed",
    };
    let id = preflight_id(&[
        ("version", "1".to_string()),
        ("operation", "content".to_string()),
        ("working_dir", request.working_dir.clone()),
        ("repository", repository.url),
        ("head_branch", repository.head_branch),
        ("number", issue.number.to_string()),
        ("current_title", issue.title.clone()),
        ("current_body", issue.body.clone()),
        ("current_state", state.to_string()),
        ("url", issue.url.clone()),
        ("target_title", request.title.clone()),
        ("target_body", request.body.clone()),
    ]);
    Ok(GitHubIssueContentPreviewResponse {
        preflight_id: id,
        current_issue: public_issue(issue),
        target_title: request.title.clone(),
        target_body: request.body.clone(),
    })
}

async fn update_content<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubIssueContentUpdateRequest,
) -> Result<GitHubIssueContentUpdateResponse, GitHubCliError> {
    validate_preflight(&request.preflight_id)?;
    let preview = preview_content(
        cli,
        &GitHubIssueContentPreviewRequest {
            working_dir: request.working_dir.clone(),
            number: request.number,
            title: request.title.clone(),
            body: request.body.clone(),
        },
    )
    .await?;
    if preview.preflight_id != request.preflight_id {
        return Err(invalid_input("Issue content preflight is stale"));
    }
    let repository = authenticated_repository(cli, &request.working_dir).await?;
    let expected_issue_url = format!("{}/issues/{}", repository.url, request.number);
    if !preview
        .current_issue
        .url
        .eq_ignore_ascii_case(&expected_issue_url)
    {
        return Err(invalid_input("Issue content preflight is stale"));
    }
    cli.update_issue_content(
        Path::new(&request.working_dir),
        UpdateIssueContentInput {
            repository_owner: repository.owner,
            repository_name: repository.name,
            number: request.number,
            title: request.title.clone(),
            body: request.body.clone(),
        },
        RemoteWriteAuthorization::Approved,
    )
    .await?;
    Ok(GitHubIssueContentUpdateResponse {
        issue: GitHubIssue {
            number: request.number,
            title: request.title.clone(),
            body: request.body.clone(),
            state: preview.current_issue.state,
            url: preview.current_issue.url,
        },
    })
}

async fn preview_state<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubIssueStatePreviewRequest,
) -> Result<GitHubIssueStatePreviewResponse, GitHubCliError> {
    if request.number == 0 {
        return Err(invalid_input("Issue number is invalid"));
    }
    let repository = authenticated_repository(cli, &request.working_dir).await?;
    let issue = cli
        .issue(
            Path::new(&request.working_dir),
            &repository.owner,
            &repository.name,
            request.number,
        )
        .await?;
    let valid = matches!(
        (issue.state, request.target_state),
        (GhIssueState::Open, GitHubIssueTargetState::Closed)
            | (GhIssueState::Closed, GitHubIssueTargetState::Open)
    );
    if !valid {
        return Err(invalid_input("Issue state transition is invalid"));
    }
    let current = match issue.state {
        GhIssueState::Open => "open",
        GhIssueState::Closed => "closed",
    };
    let target = match request.target_state {
        GitHubIssueTargetState::Open => "open",
        GitHubIssueTargetState::Closed => "closed",
    };
    let id = preflight_id(&[
        ("version", "1".to_string()),
        ("operation", "state".to_string()),
        ("working_dir", request.working_dir.clone()),
        ("repository", repository.url),
        ("head_branch", repository.head_branch),
        ("number", issue.number.to_string()),
        ("title", issue.title.clone()),
        ("body", issue.body.clone()),
        ("current_state", current.to_string()),
        ("target_state", target.to_string()),
        ("url", issue.url.clone()),
    ]);
    Ok(GitHubIssueStatePreviewResponse {
        preflight_id: id,
        issue: public_issue(issue),
        target_state: request.target_state,
    })
}

async fn change_state<Runner: GhRunner>(
    cli: &GitHubCli<Runner>,
    request: &GitHubIssueStateChangeRequest,
) -> Result<GitHubIssueStateChangeResponse, GitHubCliError> {
    validate_preflight(&request.preflight_id)?;
    let preview = preview_state(
        cli,
        &GitHubIssueStatePreviewRequest {
            working_dir: request.working_dir.clone(),
            number: request.number,
            target_state: request.target_state,
        },
    )
    .await?;
    if preview.preflight_id != request.preflight_id {
        return Err(invalid_input("Issue state preflight is stale"));
    }
    let repository = authenticated_repository(cli, &request.working_dir).await?;
    let expected_issue_url = format!("{}/issues/{}", repository.url, request.number);
    if !preview.issue.url.eq_ignore_ascii_case(&expected_issue_url) {
        return Err(invalid_input("Issue state preflight is stale"));
    }
    cli.change_issue_state(
        Path::new(&request.working_dir),
        &repository.owner,
        &repository.name,
        request.number,
        match request.target_state {
            GitHubIssueTargetState::Open => IssueStateChange::Reopen,
            GitHubIssueTargetState::Closed => IssueStateChange::Close,
        },
        RemoteWriteAuthorization::Approved,
    )
    .await?;
    Ok(GitHubIssueStateChangeResponse {
        issue: GitHubIssue {
            state: match request.target_state {
                GitHubIssueTargetState::Open => GitHubIssueState::Open,
                GitHubIssueTargetState::Closed => GitHubIssueState::Closed,
            },
            ..preview.issue
        },
    })
}

impl GooseAcpAgent {
    pub(super) async fn on_github_issue_list(
        &self,
        req: GitHubIssueListRequest,
    ) -> Result<GitHubIssueListResponse, agent_client_protocol::Error> {
        list_issues(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(cli_error)
    }

    pub(super) async fn on_github_issue_create_preview(
        &self,
        req: GitHubIssueCreatePreviewRequest,
    ) -> Result<GitHubIssueCreatePreviewResponse, agent_client_protocol::Error> {
        preview_create(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(cli_error)
    }

    pub(super) async fn on_github_issue_create(
        &self,
        req: GitHubIssueCreateRequest,
    ) -> Result<GitHubIssueCreateResponse, agent_client_protocol::Error> {
        let _lifecycle = super::github_pull_requests::DELIVERY_WRITE_LIFECYCLE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        create_issue(
            &GitHubCli::new(ProcessGhRunner),
            &self.github_issue_create_idempotency,
            &req,
        )
        .await
        .map_err(cli_error)
    }

    pub(super) async fn on_github_issue_content_preview(
        &self,
        req: GitHubIssueContentPreviewRequest,
    ) -> Result<GitHubIssueContentPreviewResponse, agent_client_protocol::Error> {
        preview_content(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(cli_error)
    }

    pub(super) async fn on_github_issue_content_update(
        &self,
        req: GitHubIssueContentUpdateRequest,
    ) -> Result<GitHubIssueContentUpdateResponse, agent_client_protocol::Error> {
        let _lifecycle = super::github_pull_requests::DELIVERY_WRITE_LIFECYCLE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        update_content(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(cli_error)
    }

    pub(super) async fn on_github_issue_state_preview(
        &self,
        req: GitHubIssueStatePreviewRequest,
    ) -> Result<GitHubIssueStatePreviewResponse, agent_client_protocol::Error> {
        preview_state(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(cli_error)
    }

    pub(super) async fn on_github_issue_state_change(
        &self,
        req: GitHubIssueStateChangeRequest,
    ) -> Result<GitHubIssueStateChangeResponse, agent_client_protocol::Error> {
        let _lifecycle = super::github_pull_requests::DELIVERY_WRITE_LIFECYCLE
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        change_state(&GitHubCli::new(ProcessGhRunner), &req)
            .await
            .map_err(cli_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::tool_idempotency::ToolIdempotencyPolicy;
    use crate::github_cli::{GhCommand, GhCommandOutput, GhRunError};
    use async_trait::async_trait;
    use std::collections::VecDeque;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[derive(Clone, Default)]
    struct FakeRunner {
        responses: Arc<Mutex<VecDeque<Result<GhCommandOutput, GhRunError>>>>,
        commands: Arc<Mutex<Vec<GhCommand>>>,
    }

    #[async_trait]
    impl GhRunner for FakeRunner {
        async fn run(&self, command: GhCommand) -> Result<GhCommandOutput, GhRunError> {
            self.commands.lock().await.push(command);
            self.responses
                .lock()
                .await
                .pop_front()
                .expect("a fake command response")
        }
    }

    impl FakeRunner {
        async fn push(&self, stdout: &str) {
            self.responses.lock().await.push_back(Ok(GhCommandOutput {
                exit_code: 0,
                stdout: stdout.as_bytes().to_vec(),
                stderr: Vec::new(),
            }));
        }
    }

    async fn push_repository_and_auth_with_remote(runner: &FakeRunner, remote: &str) {
        runner.push("true\n").await;
        runner.push("feature/issues\n").await;
        runner.push(remote).await;
        runner
            .push(
                r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
            )
            .await;
    }

    async fn push_repository_and_auth(runner: &FakeRunner) {
        push_repository_and_auth_with_remote(runner, "https://github.com/octo/demo.git\n").await;
    }

    fn create_request(
        working_dir: &str,
        preview: GitHubIssueCreatePreviewResponse,
    ) -> GitHubIssueCreateRequest {
        GitHubIssueCreateRequest {
            working_dir: working_dir.to_string(),
            operation_id: preview.operation_id,
            title: preview.title,
            body: preview.body,
            preflight_id: preview.preflight_id,
        }
    }

    async fn create_preview(
        cli: &GitHubCli<FakeRunner>,
        runner: &FakeRunner,
        working_dir: &str,
        operation_id: String,
        title: &str,
        body: &str,
        remote: &str,
    ) -> GitHubIssueCreatePreviewResponse {
        push_repository_and_auth_with_remote(runner, remote).await;
        preview_create(
            cli,
            &GitHubIssueCreatePreviewRequest {
                working_dir: working_dir.to_string(),
                operation_id,
                title: title.to_string(),
                body: body.to_string(),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn create_rechecks_preflight_and_sends_body_only_on_stdin() {
        let temp = tempfile::tempdir().unwrap();
        let idempotency = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let runner = FakeRunner::default();
        push_repository_and_auth(&runner).await;
        let cli = GitHubCli::new(runner.clone());
        let preview = preview_create(
            &cli,
            &GitHubIssueCreatePreviewRequest {
                working_dir: r"D:\fixture".to_string(),
                operation_id: uuid::Uuid::now_v7().to_string(),
                title: "Bounded issue".to_string(),
                body: "Untrusted $(Write-Output secret)".to_string(),
            },
        )
        .await
        .unwrap();

        push_repository_and_auth(&runner).await;
        runner.push("https://github.com/octo/demo/issues/7\n").await;
        let response = create_issue(
            &cli,
            &idempotency,
            &GitHubIssueCreateRequest {
                working_dir: r"D:\fixture".to_string(),
                operation_id: preview.operation_id.clone(),
                title: "Bounded issue".to_string(),
                body: "Untrusted $(Write-Output secret)".to_string(),
                preflight_id: preview.preflight_id,
            },
        )
        .await
        .unwrap();

        assert_eq!(response.issue.number, 7);
        let commands = runner.commands.lock().await;
        let write = commands.last().unwrap();
        assert_eq!(
            write.args,
            [
                "issue",
                "create",
                "--repo",
                "octo/demo",
                "--title",
                "Bounded issue",
                "--body-file",
                "-"
            ]
        );
        assert_eq!(
            write.stdin.as_deref(),
            Some("Untrusted $(Write-Output secret)".as_bytes())
        );
        assert!(write
            .args
            .iter()
            .all(|argument| !argument.contains("Write-Output")));
    }

    #[tokio::test]
    async fn stale_issue_content_preflight_stops_before_remote_write() {
        let runner = FakeRunner::default();
        push_repository_and_auth(&runner).await;
        runner
            .push(
                r#"{"number":7,"title":"Changed remotely","body":"Current","state":"OPEN","url":"https://github.com/octo/demo/issues/7"}"#,
            )
            .await;
        let cli = GitHubCli::new(runner.clone());

        let error = update_content(
            &cli,
            &GitHubIssueContentUpdateRequest {
                working_dir: r"D:\fixture".to_string(),
                number: 7,
                title: "Target".to_string(),
                body: "Body".to_string(),
                preflight_id: "a".repeat(64),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.code(), GitHubCliErrorCode::InvalidInput);
        assert!(runner
            .commands
            .lock()
            .await
            .iter()
            .all(|command| command.args.get(1).is_none_or(|action| action != "edit")));
    }

    #[tokio::test]
    async fn invalid_create_receipt_blocks_old_and_new_operation_ids_after_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        let cli = GitHubCli::new(runner.clone());
        let first_preview = create_preview(
            &cli,
            &runner,
            r"D:\first",
            uuid::Uuid::now_v7().to_string(),
            "Same issue",
            "Same body",
            "https://github.com/octo/demo.git\n",
        )
        .await;
        push_repository_and_auth(&runner).await;
        runner.push("not-an-issue-url\n").await;

        let first_store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let first_request = create_request(r"D:\first", first_preview);
        let first_error = create_issue(&cli, &first_store, &first_request)
            .await
            .unwrap_err();
        assert_eq!(first_error.code(), GitHubCliErrorCode::UncertainEffect);
        drop(first_store);

        push_repository_and_auth(&runner).await;
        let reopened = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let old_error = create_issue(&cli, &reopened, &first_request)
            .await
            .unwrap_err();
        assert_eq!(old_error.code(), GitHubCliErrorCode::UncertainEffect);

        let second_preview = create_preview(
            &cli,
            &runner,
            r"D:\second",
            uuid::Uuid::now_v7().to_string(),
            "Same issue",
            "Same body",
            "https://github.com/OCTO/DEMO.git\n",
        )
        .await;
        push_repository_and_auth_with_remote(&runner, "https://github.com/OCTO/DEMO.git\n").await;
        let new_error = create_issue(
            &cli,
            &reopened,
            &create_request(r"D:\second", second_preview),
        )
        .await
        .unwrap_err();
        assert_eq!(new_error.code(), GitHubCliErrorCode::UncertainEffect);

        let create_calls = runner
            .commands
            .lock()
            .await
            .iter()
            .filter(|command| command.args.get(1).is_some_and(|value| value == "create"))
            .count();
        assert_eq!(create_calls, 1);
    }

    #[tokio::test]
    async fn every_exit_zero_receipt_validation_failure_remains_ambiguous() {
        for receipt in [
            "",
            "not-an-issue-url\n",
            "https://github.com/other/repository/issues/7\n",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
            let runner = FakeRunner::default();
            let cli = GitHubCli::new(runner.clone());
            let preview = create_preview(
                &cli,
                &runner,
                r"D:\fixture",
                uuid::Uuid::now_v7().to_string(),
                "Receipt validation",
                "Must fail closed",
                "https://github.com/octo/demo.git\n",
            )
            .await;
            push_repository_and_auth(&runner).await;
            runner.push(receipt).await;
            let request = create_request(r"D:\fixture", preview);

            let first_error = create_issue(&cli, &store, &request).await.unwrap_err();
            assert_eq!(first_error.code(), GitHubCliErrorCode::UncertainEffect);
            push_repository_and_auth(&runner).await;
            let retry_error = create_issue(&cli, &store, &request).await.unwrap_err();
            assert_eq!(retry_error.code(), GitHubCliErrorCode::UncertainEffect);
            assert_eq!(
                runner
                    .commands
                    .lock()
                    .await
                    .iter()
                    .filter(|command| command.args.get(1).is_some_and(|value| value == "create"))
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn completion_failure_keeps_the_effect_ambiguous() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let runner = FakeRunner::default();
        let cli = GitHubCli::new(runner.clone());
        let preview = create_preview(
            &cli,
            &runner,
            r"D:\fixture",
            uuid::Uuid::now_v7().to_string(),
            "Completed remotely",
            "Receipt persistence fails",
            "https://github.com/octo/demo.git\n",
        )
        .await;
        push_repository_and_auth(&runner).await;
        runner.push("https://github.com/octo/demo/issues/9\n").await;
        store.fail_next_complete_for_test();

        let error = create_issue(&cli, &store, &create_request(r"D:\fixture", preview))
            .await
            .unwrap_err();
        assert_eq!(error.code(), GitHubCliErrorCode::UncertainEffect);

        let retry_preview = create_preview(
            &cli,
            &runner,
            r"D:\fixture",
            uuid::Uuid::now_v7().to_string(),
            "Completed remotely",
            "Receipt persistence fails",
            "https://github.com/octo/demo.git\n",
        )
        .await;
        push_repository_and_auth(&runner).await;
        let retry_error = create_issue(&cli, &store, &create_request(r"D:\fixture", retry_preview))
            .await
            .unwrap_err();
        assert_eq!(retry_error.code(), GitHubCliErrorCode::UncertainEffect);
        assert_eq!(
            runner
                .commands
                .lock()
                .await
                .iter()
                .filter(|command| command.args.get(1).is_some_and(|value| value == "create"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn expired_operation_id_stops_before_repository_inspection() {
        let runner = FakeRunner::default();
        let cli = GitHubCli::new(runner.clone());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        let expired = uuid::Uuid::new_v7(uuid::Timestamp::from_unix_time(
            now.as_secs() - ISSUE_OPERATION_MAX_AGE.as_secs() - 1,
            0,
            0,
            0,
        ))
        .to_string();

        let error = preview_create(
            &cli,
            &GitHubIssueCreatePreviewRequest {
                working_dir: r"D:\fixture".to_string(),
                operation_id: expired,
                title: "Expired".to_string(),
                body: String::new(),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.code(), GitHubCliErrorCode::InvalidInput);
        assert!(runner.commands.lock().await.is_empty());
    }

    #[tokio::test]
    async fn capacity_rejection_keeps_unresolved_records_and_skips_the_runner() {
        let temp = tempfile::tempdir().unwrap();
        let store = ToolIdempotencyStore::with_policy(
            temp.path().to_path_buf(),
            ToolIdempotencyPolicy {
                max_records_per_scope: 1,
                completed_retention: std::time::Duration::from_secs(30 * 24 * 60 * 60),
            },
        );
        let BeginDecision::Execute(unresolved) = store
            .begin(issue_create_idempotency_input(
                "octo",
                "demo",
                uuid::Uuid::now_v7().to_string(),
                "Unresolved",
                "First effect",
            ))
            .await
            .unwrap()
        else {
            panic!("fixture must create an unresolved record");
        };
        drop(unresolved);

        let runner = FakeRunner::default();
        let cli = GitHubCli::new(runner.clone());
        let preview = create_preview(
            &cli,
            &runner,
            r"D:\fixture",
            uuid::Uuid::now_v7().to_string(),
            "Different",
            "Second effect",
            "https://github.com/octo/demo.git\n",
        )
        .await;
        push_repository_and_auth(&runner).await;
        let error = create_issue(&cli, &store, &create_request(r"D:\fixture", preview))
            .await
            .unwrap_err();

        assert_eq!(error.code(), GitHubCliErrorCode::CommandFailed);
        assert_eq!(
            runner
                .commands
                .lock()
                .await
                .iter()
                .filter(|command| command.args.get(1).is_some_and(|value| value == "create"))
                .count(),
            0
        );
        let started_records = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .flat_map(|entry| std::fs::read_dir(entry.path()).unwrap())
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().to_string_lossy().ends_with(".started.json"))
            .count();
        assert_eq!(started_records, 1);
    }

    #[tokio::test]
    async fn concurrent_operation_ids_for_the_same_effect_have_one_claim() {
        let temp = tempfile::tempdir().unwrap();
        let first = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let second = ToolIdempotencyStore::new(temp.path().to_path_buf());
        let first_input = issue_create_idempotency_input(
            "octo",
            "demo",
            uuid::Uuid::now_v7().to_string(),
            "Same",
            "Effect",
        );
        let second_input = issue_create_idempotency_input(
            "octo",
            "demo",
            uuid::Uuid::now_v7().to_string(),
            "Same",
            "Effect",
        );

        let (first_result, second_result) =
            tokio::join!(first.begin(first_input), second.begin(second_input));
        let execute_count = [&first_result, &second_result]
            .into_iter()
            .filter(|result| matches!(result, Ok(BeginDecision::Execute(_))))
            .count();

        assert_eq!(execute_count, 1);
    }
}
