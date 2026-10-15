use async_trait::async_trait;
use goose::github_cli::{
    CreateIssueInput, CreatePullRequestInput, GhAuthStatus, GhCheckBucket, GhCommand,
    GhCommandOutput, GhIssueState, GhPullRequestState, GhRunError, GhRunner, GitHubCli,
    GitHubCliErrorCode, IssueStateChange, PullRequestStateChange, RemoteWriteAuthorization,
    UpdateIssueContentInput, UpdatePullRequestContentInput,
};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Default)]
struct FakeRunner {
    responses: Arc<Mutex<VecDeque<Result<GhCommandOutput, GhRunError>>>>,
    commands: Arc<Mutex<Vec<GhCommand>>>,
}

impl FakeRunner {
    async fn push(&self, response: Result<GhCommandOutput, GhRunError>) {
        self.responses.lock().await.push_back(response);
    }

    async fn commands(&self) -> Vec<GhCommand> {
        self.commands.lock().await.clone()
    }
}

#[async_trait]
impl GhRunner for FakeRunner {
    async fn run(&self, command: GhCommand) -> Result<GhCommandOutput, GhRunError> {
        self.commands.lock().await.push(command);
        self.responses
            .lock()
            .await
            .pop_front()
            .expect("a fake gh response")
    }
}

fn completed(exit_code: i32, stdout: &str, stderr: &str) -> GhCommandOutput {
    GhCommandOutput {
        exit_code,
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.as_bytes().to_vec(),
    }
}

#[tokio::test]
async fn auth_json_is_validated_instead_of_trusting_exit_zero() {
    let runner = FakeRunner::default();
    runner
        .push(Ok(completed(
            0,
            r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
            "",
        )))
        .await;
    runner
        .push(Ok(completed(
            1,
            r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"success"}]}}"#,
            "fatal ghp_secret-must-not-leak",
        )))
        .await;
    runner
        .push(Ok(completed(
            0,
            r#"{"hosts":{"github.com":[{"active":true,"login":"octocat","state":"failure"}]}}"#,
            "authentication failed for token ghp_secret-must-not-leak",
        )))
        .await;
    let cli = GitHubCli::new(runner.clone());
    let cwd = PathBuf::from(r"D:\fixture");

    assert_eq!(
        cli.auth_status(&cwd).await.unwrap(),
        GhAuthStatus::Authenticated {
            login: "octocat".to_string()
        }
    );
    let fatal = cli.auth_status(&cwd).await.unwrap_err();
    assert_eq!(fatal.code(), GitHubCliErrorCode::CommandFailed);
    assert!(!fatal.to_string().contains("ghp_secret-must-not-leak"));
    assert_eq!(
        cli.auth_status(&cwd).await.unwrap(),
        GhAuthStatus::NotAuthenticated
    );

    let commands = runner.commands().await;
    assert_eq!(
        commands[0].args,
        [
            "auth",
            "status",
            "--active",
            "--hostname",
            "github.com",
            "--json",
            "hosts"
        ]
    );
    assert!(commands[0].stdin.is_none());
}

#[tokio::test]
async fn unavailable_timeout_and_invalid_json_have_distinct_secret_safe_errors() {
    let runner = FakeRunner::default();
    runner.push(Err(GhRunError::Unavailable)).await;
    runner.push(Err(GhRunError::TimedOut)).await;
    runner
        .push(Ok(completed(0, "not-json ghp_secret-must-not-leak", "")))
        .await;
    let cli = GitHubCli::new(runner);
    let cwd = PathBuf::from(r"D:\fixture");

    for expected in [
        GitHubCliErrorCode::Unavailable,
        GitHubCliErrorCode::TimedOut,
        GitHubCliErrorCode::InvalidResponse,
    ] {
        let error = cli.auth_status(&cwd).await.unwrap_err();
        assert_eq!(error.code(), expected);
        assert!(!error.to_string().contains("ghp_secret-must-not-leak"));
    }
}

#[tokio::test]
async fn required_checks_accept_pending_exit_eight_and_validate_buckets() {
    let runner = FakeRunner::default();
    runner
        .push(Ok(completed(
            8,
            r#"[
              {"name":"build","state":"IN_PROGRESS","bucket":"pending","link":"https://github.com/octo/demo/actions/runs/1","description":"Build"},
              {"name":"lint","state":"SUCCESS","bucket":"pass","link":"https://github.com/octo/demo/actions/runs/2","description":"Lint"}
            ]"#,
            "",
        )))
        .await;
    let cli = GitHubCli::new(runner.clone());

    let checks = cli
        .required_checks(&PathBuf::from(r"D:\fixture"), "42")
        .await
        .unwrap();
    assert_eq!(checks.len(), 2);
    assert_eq!(checks[0].bucket, GhCheckBucket::Pending);
    assert_eq!(checks[1].bucket, GhCheckBucket::Pass);
    assert_eq!(
        runner.commands().await[0].args,
        [
            "pr",
            "checks",
            "42",
            "--required",
            "--json",
            "name,state,bucket,link,description"
        ]
    );
}

#[tokio::test]
async fn current_branch_pr_distinguishes_absence_from_a_valid_existing_pr() {
    let runner = FakeRunner::default();
    runner.push(Ok(completed(0, "[]", ""))).await;
    runner
        .push(Ok(completed(
            0,
            r#"[{"number":42,"title":"Delivery","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}]"#,
            "",
        )))
        .await;
    runner
        .push(Ok(completed(
            0,
            r#"{"number":42,"title":"Delivery","state":"OPEN","url":"https://github.com/octo/demo/pull/42","headRefName":"feature/bounded","baseRefName":"main","isDraft":false}"#,
            "",
        )))
        .await;
    let cli = GitHubCli::new(runner.clone());
    let cwd = PathBuf::from(r"D:\fixture");

    assert!(cli
        .current_pull_request(&cwd, "feature/bounded")
        .await
        .unwrap()
        .is_none());
    let pull_request = cli
        .current_pull_request(&cwd, "feature/bounded")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pull_request.number, 42);
    assert_eq!(pull_request.state, GhPullRequestState::Open);

    let commands = runner.commands().await;
    assert_eq!(
        commands[0].args,
        [
            "pr",
            "list",
            "--head",
            "feature/bounded",
            "--state",
            "all",
            "--limit",
            "1",
            "--json",
            "number,title,body,state,url,headRefName,baseRefName,isDraft"
        ]
    );
    assert_eq!(
        commands[2].args,
        [
            "pr",
            "view",
            "42",
            "--json",
            "number,title,body,state,url,headRefName,baseRefName,isDraft"
        ]
    );
}

#[tokio::test]
async fn pr_list_command_failure_is_not_misreported_as_no_pull_request() {
    let runner = FakeRunner::default();
    runner
        .push(Ok(completed(
            1,
            "",
            "network failure ghp_secret-must-not-leak",
        )))
        .await;
    let cli = GitHubCli::new(runner);

    let error = cli
        .current_pull_request(&PathBuf::from(r"D:\fixture"), "feature/bounded")
        .await
        .unwrap_err();
    assert_eq!(error.code(), GitHubCliErrorCode::CommandFailed);
    assert!(!error.to_string().contains("ghp_secret-must-not-leak"));
}

#[tokio::test]
async fn repository_context_classifies_non_git_detached_and_missing_remote() {
    let cwd = PathBuf::from(r"D:\fixture");

    let non_git = FakeRunner::default();
    non_git
        .push(Ok(completed(128, "", "not a git repository")))
        .await;
    assert_eq!(
        GitHubCli::new(non_git)
            .inspect_repository(&cwd)
            .await
            .unwrap_err()
            .code(),
        GitHubCliErrorCode::NotGitRepository
    );

    let detached = FakeRunner::default();
    detached.push(Ok(completed(0, "true\n", ""))).await;
    detached
        .push(Ok(completed(1, "", "not a symbolic ref")))
        .await;
    assert_eq!(
        GitHubCli::new(detached)
            .inspect_repository(&cwd)
            .await
            .unwrap_err()
            .code(),
        GitHubCliErrorCode::DetachedHead
    );

    let no_remote = FakeRunner::default();
    no_remote.push(Ok(completed(0, "true\n", ""))).await;
    no_remote
        .push(Ok(completed(0, "feature/bounded\n", "")))
        .await;
    no_remote
        .push(Ok(completed(2, "", "No such remote 'origin'")))
        .await;
    assert_eq!(
        GitHubCli::new(no_remote)
            .inspect_repository(&cwd)
            .await
            .unwrap_err()
            .code(),
        GitHubCliErrorCode::NoRemote
    );
}

#[tokio::test]
async fn repository_context_accepts_a_bounded_github_origin_without_shell() {
    let runner = FakeRunner::default();
    runner.push(Ok(completed(0, "true\n", ""))).await;
    runner.push(Ok(completed(0, "feature/bounded\n", ""))).await;
    runner
        .push(Ok(completed(0, "git@github.com:octo/demo.git\n", "")))
        .await;
    let cwd = PathBuf::from(r"D:\fixture");

    let repository = GitHubCli::new(runner.clone())
        .inspect_repository(&cwd)
        .await
        .unwrap();
    assert_eq!(repository.owner, "octo");
    assert_eq!(repository.name, "demo");
    assert_eq!(repository.head_branch, "feature/bounded");
    assert_eq!(repository.url, "https://github.com/octo/demo");

    let commands = runner.commands().await;
    assert_eq!(commands.len(), 3);
    assert!(commands.iter().all(|command| command.executable == "git"));
    assert_eq!(commands[0].args, ["rev-parse", "--is-inside-work-tree"]);
    assert_eq!(
        commands[1].args,
        ["symbolic-ref", "--quiet", "--short", "HEAD"]
    );
    assert_eq!(commands[2].args, ["remote", "get-url", "origin"]);
}

#[tokio::test]
async fn pull_request_body_uses_stdin_and_denial_has_zero_runner_side_effects() {
    let runner = FakeRunner::default();
    let cli = GitHubCli::new(runner.clone());
    let cwd = PathBuf::from(r"D:\fixture");
    let input = CreatePullRequestInput {
        repository_owner: "octo".to_string(),
        repository_name: "demo".to_string(),
        head_branch: "feature/bounded".to_string(),
        base_branch: Some("main".to_string()),
        title: "Add bounded delivery".to_string(),
        body: "Untrusted $(Write-Output secret) `whoami`".to_string(),
        draft: false,
    };

    let denied = cli
        .create_pull_request(&cwd, input.clone(), RemoteWriteAuthorization::Denied)
        .await
        .unwrap_err();
    assert_eq!(denied.code(), GitHubCliErrorCode::UserDenied);
    assert!(runner.commands().await.is_empty());

    runner
        .push(Ok(completed(
            0,
            "https://github.com/octo/demo/pull/42\n",
            "",
        )))
        .await;
    let created = cli
        .create_pull_request(&cwd, input.clone(), RemoteWriteAuthorization::Approved)
        .await
        .unwrap();
    assert_eq!(created.number, 42);

    let command = &runner.commands().await[0];
    assert_eq!(command.executable, "gh");
    assert_eq!(command.cwd, cwd);
    assert_eq!(command.stdin.as_deref(), Some(input.body.as_bytes()));
    assert_eq!(
        command.args,
        [
            "pr",
            "create",
            "--head",
            "feature/bounded",
            "--title",
            "Add bounded delivery",
            "--base",
            "main",
            "--body-file",
            "-"
        ]
    );
    assert!(!command.args.iter().any(|arg| arg == "--dry-run"));
    assert!(!command.args.iter().any(|arg| arg.contains("whoami")));
}

#[tokio::test]
async fn branch_push_requires_authorization_and_uses_fixed_git_arguments() {
    let runner = FakeRunner::default();
    let cli = GitHubCli::new(runner.clone());
    let cwd = PathBuf::from(r"D:\fixture");

    let denied = cli
        .push_branch(
            &cwd,
            "origin",
            "feature/bounded",
            RemoteWriteAuthorization::Denied,
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code(), GitHubCliErrorCode::UserDenied);
    assert!(runner.commands().await.is_empty());

    runner.push(Ok(completed(0, "", ""))).await;
    cli.push_branch(
        &cwd,
        "origin",
        "feature/bounded",
        RemoteWriteAuthorization::Approved,
    )
    .await
    .unwrap();

    let commands = runner.commands().await;
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].executable, "git");
    assert_eq!(
        commands[0].args,
        [
            "push",
            "--porcelain",
            "--set-upstream",
            "origin",
            "feature/bounded:feature/bounded"
        ]
    );
    assert!(commands[0].stdin.is_none());
}

#[tokio::test]
async fn remote_write_timeout_is_reported_as_an_uncertain_effect() {
    let runner = FakeRunner::default();
    runner.push(Err(GhRunError::TimedOut)).await;
    let cli = GitHubCli::new(runner);

    let error = cli
        .push_branch(
            &PathBuf::from(r"D:\fixture"),
            "origin",
            "feature/bounded",
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), GitHubCliErrorCode::UncertainEffect);
    assert!(!error.to_string().contains("ghp_"));
}

#[tokio::test]
async fn pull_request_state_change_requires_authorization_and_uses_fixed_arguments() {
    let runner = FakeRunner::default();
    let cli = GitHubCli::new(runner.clone());
    let cwd = PathBuf::from(r"D:\fixture");

    let denied = cli
        .change_pull_request_state(
            &cwd,
            42,
            PullRequestStateChange::Close,
            RemoteWriteAuthorization::Denied,
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code(), GitHubCliErrorCode::UserDenied);
    assert!(runner.commands().await.is_empty());

    runner.push(Ok(completed(0, "", ""))).await;
    cli.change_pull_request_state(
        &cwd,
        42,
        PullRequestStateChange::Close,
        RemoteWriteAuthorization::Approved,
    )
    .await
    .unwrap();
    runner.push(Ok(completed(0, "", ""))).await;
    cli.change_pull_request_state(
        &cwd,
        42,
        PullRequestStateChange::Reopen,
        RemoteWriteAuthorization::Approved,
    )
    .await
    .unwrap();

    let commands = runner.commands().await;
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].args, ["pr", "close", "42"]);
    assert_eq!(commands[1].args, ["pr", "reopen", "42"]);
    assert!(commands.iter().all(|command| command.executable == "gh"));
    assert!(commands.iter().all(|command| command.stdin.is_none()));
    assert!(commands[0]
        .args
        .iter()
        .all(|argument| argument != "--delete-branch"));
}

#[tokio::test]
async fn pull_request_state_change_rejects_invalid_numbers_without_running_gh() {
    let runner = FakeRunner::default();
    let error = GitHubCli::new(runner.clone())
        .change_pull_request_state(
            &PathBuf::from(r"D:\fixture"),
            0,
            PullRequestStateChange::Close,
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), GitHubCliErrorCode::InvalidInput);
    assert!(runner.commands().await.is_empty());
}

#[tokio::test]
async fn pull_request_content_update_requires_authorization_and_uses_stdin() {
    let runner = FakeRunner::default();
    let cli = GitHubCli::new(runner.clone());
    let cwd = PathBuf::from(r"D:\fixture");
    let input = UpdatePullRequestContentInput {
        number: 42,
        title: "Clarify bounded delivery".to_string(),
        body: "Untrusted $(Write-Output secret) `whoami`".to_string(),
    };

    let denied = cli
        .update_pull_request_content(&cwd, input.clone(), RemoteWriteAuthorization::Denied)
        .await
        .unwrap_err();
    assert_eq!(denied.code(), GitHubCliErrorCode::UserDenied);
    assert!(runner.commands().await.is_empty());

    runner.push(Ok(completed(0, "", ""))).await;
    cli.update_pull_request_content(&cwd, input.clone(), RemoteWriteAuthorization::Approved)
        .await
        .unwrap();

    let commands = runner.commands().await;
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].executable, "gh");
    assert_eq!(commands[0].cwd, cwd);
    assert_eq!(commands[0].stdin.as_deref(), Some(input.body.as_bytes()));
    assert_eq!(
        commands[0].args,
        [
            "pr",
            "edit",
            "42",
            "--title",
            "Clarify bounded delivery",
            "--body-file",
            "-"
        ]
    );
    assert!(commands[0]
        .args
        .iter()
        .all(|argument| !argument.contains("whoami")));
}

#[tokio::test]
async fn issue_list_is_bounded_and_validated() {
    let runner = FakeRunner::default();
    runner
        .push(Ok(completed(
            0,
            r#"[{"number":7,"title":"Bounded issue","body":"Details","state":"OPEN","url":"https://github.com/octo/demo/issues/7"}]"#,
            "",
        )))
        .await;
    let cli = GitHubCli::new(runner.clone());

    let issues = cli
        .list_issues(&PathBuf::from(r"D:\fixture"), "octo", "demo")
        .await
        .unwrap();

    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].state, GhIssueState::Open);
    assert_eq!(
        runner.commands().await[0].args,
        [
            "issue",
            "list",
            "--repo",
            "octo/demo",
            "--state",
            "all",
            "--limit",
            "20",
            "--json",
            "number,title,body,state,url"
        ]
    );
}

#[tokio::test]
async fn issue_writes_require_authorization_and_keep_bodies_on_stdin() {
    let runner = FakeRunner::default();
    let cli = GitHubCli::new(runner.clone());
    let cwd = PathBuf::from(r"D:\fixture");
    let create = CreateIssueInput {
        repository_owner: "octo".to_string(),
        repository_name: "demo".to_string(),
        title: "Report a bounded issue".to_string(),
        body: "Untrusted $(Write-Output secret)".to_string(),
    };

    let denied = cli
        .create_issue(&cwd, create.clone(), RemoteWriteAuthorization::Denied)
        .await
        .unwrap_err();
    assert_eq!(denied.code(), GitHubCliErrorCode::UserDenied);
    assert!(runner.commands().await.is_empty());

    runner
        .push(Ok(completed(
            0,
            "https://github.com/Octo/Demo/issues/7\n",
            "",
        )))
        .await;
    let created = cli
        .create_issue(&cwd, create.clone(), RemoteWriteAuthorization::Approved)
        .await
        .unwrap();
    assert_eq!(created.number, 7);
    assert_eq!(created.url, "https://github.com/Octo/Demo/issues/7");

    runner.push(Ok(completed(0, "", ""))).await;
    cli.update_issue_content(
        &cwd,
        UpdateIssueContentInput {
            repository_owner: "octo".to_string(),
            repository_name: "demo".to_string(),
            number: 7,
            title: "Clarify the issue".to_string(),
            body: create.body.clone(),
        },
        RemoteWriteAuthorization::Approved,
    )
    .await
    .unwrap();

    runner.push(Ok(completed(0, "", ""))).await;
    cli.change_issue_state(
        &cwd,
        "octo",
        "demo",
        7,
        IssueStateChange::Close,
        RemoteWriteAuthorization::Approved,
    )
    .await
    .unwrap();

    runner.push(Ok(completed(0, "", ""))).await;
    cli.change_issue_state(
        &cwd,
        "octo",
        "demo",
        7,
        IssueStateChange::Reopen,
        RemoteWriteAuthorization::Approved,
    )
    .await
    .unwrap();

    let commands = runner.commands().await;
    assert_eq!(
        commands[0].args,
        [
            "issue",
            "create",
            "--repo",
            "octo/demo",
            "--title",
            "Report a bounded issue",
            "--body-file",
            "-"
        ]
    );
    assert_eq!(commands[0].stdin.as_deref(), Some(create.body.as_bytes()));
    assert_eq!(
        commands[1].args,
        [
            "issue",
            "edit",
            "7",
            "--repo",
            "octo/demo",
            "--title",
            "Clarify the issue",
            "--body-file",
            "-"
        ]
    );
    assert_eq!(commands[1].stdin.as_deref(), Some(create.body.as_bytes()));
    assert_eq!(
        commands[2].args,
        ["issue", "close", "7", "--repo", "octo/demo"]
    );
    assert_eq!(
        commands[3].args,
        ["issue", "reopen", "7", "--repo", "octo/demo"]
    );
    assert!(commands[0..2]
        .iter()
        .flat_map(|command| command.args.iter())
        .all(|argument| !argument.contains("Write-Output")));
}

#[tokio::test]
async fn issue_create_with_an_invalid_success_receipt_is_uncertain() {
    let runner = FakeRunner::default();
    runner
        .push(Ok(completed(0, "not-an-issue-url\n", "")))
        .await;
    let cli = GitHubCli::new(runner.clone());
    let error = cli
        .create_issue(
            &PathBuf::from(r"D:\fixture"),
            CreateIssueInput {
                repository_owner: "octo".to_string(),
                repository_name: "demo".to_string(),
                title: "Potentially created".to_string(),
                body: "The command completed without a verifiable receipt".to_string(),
            },
            RemoteWriteAuthorization::Approved,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), GitHubCliErrorCode::UncertainEffect);
    assert_eq!(runner.commands().await.len(), 1);
}
