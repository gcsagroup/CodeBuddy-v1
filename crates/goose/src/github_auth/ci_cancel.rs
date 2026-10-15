use super::ci_status::{inspect_local_ci_target, GitHubCiClient, GitHubCiError, LocalCiTarget};
use super::pull_requests::{GitHubRepository, GITHUB_API_VERSION};
use crate::agents::tool_audit::{
    EffectiveModel, QualifiedToolName, ToolAuditActor, ToolAuditAuthorization,
    ToolAuditExtensionSource, ToolAuditInput, ToolAuditOutcome, ToolAuditPermissionClass,
};
use crate::agents::tool_idempotency::{
    BeginDecision, ToolIdempotencyInput, ToolIdempotencyOutcome,
};
use goose_sdk_types::custom_requests::{
    GitHubCiCancelPreviewRequest, GitHubCiCancelPreviewResponse, GitHubCiCancelRequest,
    GitHubCiCancelResponse, GitHubCiRun, GitHubCiRunConclusion, GitHubCiRunStatus,
    GitHubCiStatusResponse,
};
use reqwest::header::ACCEPT;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

const PREFLIGHT_VERSION: &str = "codebuddy.github-ci-cancel-preflight.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubCiCancelError {
    #[error("The workflow run ID must be a positive integer")]
    InvalidRunId,
    #[error("The workflow run was not found for the current pushed HEAD")]
    RunNotFound,
    #[error("Only queued or in-progress workflow runs can be cancelled")]
    RunNotEligible,
    #[error("The CI status no longer matches the current pushed HEAD")]
    StatusTargetMismatch,
    #[error("The GitHub API endpoint is invalid")]
    InvalidApiBase,
    #[error("GitHub rejected the workflow cancellation request")]
    GitHubRejected,
    #[error("The workflow cancellation outcome is uncertain; inspect GitHub before retrying")]
    OutcomeUncertain,
    #[error("The workflow cancellation preflight ID is invalid")]
    InvalidPreflightId,
    #[error("The workflow cancellation preflight is stale; run preview again")]
    PreflightStale,
    #[error("The workflow cancellation was already submitted")]
    AlreadySubmitted,
    #[error("The workflow cancellation is already in progress")]
    AlreadyInProgress,
    #[error("The durable workflow cancellation identity is unavailable")]
    IdempotencyUnavailable,
    #[error("The workflow cancellation audit record is unavailable")]
    AuditUnavailable,
    #[error("GitHub is not connected or the stored authorization has expired")]
    NotAuthenticated,
    #[error("The GitHub credential could not be read from secure storage")]
    CredentialUnavailable,
    #[error(transparent)]
    CiStatus(#[from] GitHubCiError),
}

impl GitHubCiCancelError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidRunId => "invalid_run_id",
            Self::RunNotFound => "run_not_found",
            Self::RunNotEligible => "run_not_eligible",
            Self::StatusTargetMismatch => "status_target_mismatch",
            Self::InvalidApiBase => "invalid_api_base",
            Self::GitHubRejected => "github_rejected",
            Self::OutcomeUncertain => "outcome_uncertain",
            Self::InvalidPreflightId => "invalid_preflight_id",
            Self::PreflightStale => "preflight_stale",
            Self::AlreadySubmitted => "already_submitted",
            Self::AlreadyInProgress => "already_in_progress",
            Self::IdempotencyUnavailable => "idempotency_unavailable",
            Self::AuditUnavailable => "audit_unavailable",
            Self::NotAuthenticated => "not_authenticated",
            Self::CredentialUnavailable => "credential_unavailable",
            Self::CiStatus(error) => error.code(),
        }
    }
}

fn eligible_run(
    status: &GitHubCiStatusResponse,
    run_id: u64,
) -> Result<&GitHubCiRun, GitHubCiCancelError> {
    if run_id == 0 {
        return Err(GitHubCiCancelError::InvalidRunId);
    }
    let run = status
        .runs
        .iter()
        .find(|run| run.id == run_id)
        .ok_or(GitHubCiCancelError::RunNotFound)?;
    if !matches!(
        run.status,
        GitHubCiRunStatus::Queued | GitHubCiRunStatus::InProgress
    ) {
        return Err(GitHubCiCancelError::RunNotEligible);
    }
    Ok(run)
}

fn build_preview(
    target: &LocalCiTarget,
    status: &GitHubCiStatusResponse,
    run_id: u64,
) -> Result<GitHubCiCancelPreviewResponse, GitHubCiCancelError> {
    if status.repository_owner != target.repository.owner
        || status.repository_name != target.repository.name
        || status.branch != target.branch
        || status.head_sha != target.head_sha
    {
        return Err(GitHubCiCancelError::StatusTargetMismatch);
    }
    let run = eligible_run(status, run_id)?.clone();
    Ok(GitHubCiCancelPreviewResponse {
        preflight_id: cancel_preflight_id(target, &run),
        repository_owner: target.repository.owner.clone(),
        repository_name: target.repository.name.clone(),
        repository_url: format!(
            "https://github.com/{}/{}",
            target.repository.owner, target.repository.name
        ),
        branch: target.branch.clone(),
        head_sha: target.head_sha.clone(),
        working_tree_dirty: target.working_tree_dirty,
        run,
    })
}

fn cancel_preflight_id(target: &LocalCiTarget, run: &GitHubCiRun) -> String {
    let status = match run.status {
        GitHubCiRunStatus::Queued => "queued",
        GitHubCiRunStatus::InProgress => "in_progress",
        GitHubCiRunStatus::Waiting => "waiting",
        GitHubCiRunStatus::Requested => "requested",
        GitHubCiRunStatus::Pending => "pending",
        GitHubCiRunStatus::Completed => "completed",
        GitHubCiRunStatus::Unknown => "unknown",
    };
    let conclusion = match run.conclusion {
        None => "none",
        Some(GitHubCiRunConclusion::Success) => "success",
        Some(GitHubCiRunConclusion::Failure) => "failure",
        Some(GitHubCiRunConclusion::Cancelled) => "cancelled",
        Some(GitHubCiRunConclusion::TimedOut) => "timed_out",
        Some(GitHubCiRunConclusion::Neutral) => "neutral",
        Some(GitHubCiRunConclusion::Skipped) => "skipped",
        Some(GitHubCiRunConclusion::ActionRequired) => "action_required",
        Some(GitHubCiRunConclusion::Stale) => "stale",
        Some(GitHubCiRunConclusion::StartupFailure) => "startup_failure",
        Some(GitHubCiRunConclusion::Unknown) => "unknown",
    };
    let mut hasher = Sha256::new();
    for (key, value) in [
        ("version", PREFLIGHT_VERSION.to_string()),
        (
            "repository_root",
            target.repository_root.to_string_lossy().into_owned(),
        ),
        ("owner", target.repository.owner.clone()),
        ("repository", target.repository.name.clone()),
        ("branch", target.branch.clone()),
        ("head_sha", target.head_sha.clone()),
        ("run_id", run.id.to_string()),
        ("run_name", run.name.clone()),
        ("run_number", run.run_number.to_string()),
        ("attempt", run.attempt.to_string()),
        ("status", status.to_string()),
        ("conclusion", conclusion.to_string()),
        ("updated_at", run.updated_at.clone()),
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

impl GitHubCiClient {
    async fn cancel_run(
        &self,
        access_token: &str,
        repository: &GitHubRepository,
        run_id: u64,
    ) -> Result<(), GitHubCiCancelError> {
        if run_id == 0 {
            return Err(GitHubCiCancelError::InvalidRunId);
        }
        let endpoint = self
            .api_base
            .join(&format!(
                "repos/{}/{}/actions/runs/{run_id}/cancel",
                repository.owner, repository.name
            ))
            .map_err(|_| GitHubCiCancelError::InvalidApiBase)?;
        let response = self
            .client
            .post(endpoint)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| GitHubCiCancelError::OutcomeUncertain)?;
        if response.status() == reqwest::StatusCode::ACCEPTED {
            return Ok(());
        }
        if response.status().is_redirection() || response.status().is_client_error() {
            return Err(GitHubCiCancelError::GitHubRejected);
        }
        Err(GitHubCiCancelError::OutcomeUncertain)
    }
}

impl super::GitHubAuthService {
    pub(crate) async fn preview_ci_cancel(
        &self,
        request: GitHubCiCancelPreviewRequest,
    ) -> Result<GitHubCiCancelPreviewResponse, GitHubCiCancelError> {
        if request.run_id == 0 {
            return Err(GitHubCiCancelError::InvalidRunId);
        }
        let target = inspect_local_ci_target(std::path::Path::new(&request.working_dir)).await?;
        let access_token = self.ci_cancel_access_token().await?;
        let status = self.ci_client.status(&access_token, &target).await?;
        build_preview(&target, &status, request.run_id)
    }

    pub(crate) async fn cancel_ci_run(
        &self,
        request: GitHubCiCancelRequest,
    ) -> Result<GitHubCiCancelResponse, GitHubCiCancelError> {
        if request.run_id == 0 {
            return Err(GitHubCiCancelError::InvalidRunId);
        }
        if !valid_preflight_id(&request.preflight_id) {
            return Err(GitHubCiCancelError::InvalidPreflightId);
        }
        let _lifecycle = self.ci_rerun_lifecycle.lock().await;
        let target = inspect_local_ci_target(std::path::Path::new(&request.working_dir)).await?;
        let access_token = self.ci_cancel_access_token().await?;
        let status = self.ci_client.status(&access_token, &target).await?;
        let preview = build_preview(&target, &status, request.run_id)?;
        if request.preflight_id != preview.preflight_id {
            return Err(GitHubCiCancelError::PreflightStale);
        }
        let arguments = protected_arguments(&preview);
        let audit_claim = self
            .ci_rerun_audit
            .begin(audit_input(&preview, arguments.clone())?)
            .await
            .map_err(|_| GitHubCiCancelError::AuditUnavailable)?;
        let idempotency_claim = match self
            .ci_rerun_idempotency
            .begin(ToolIdempotencyInput {
                session_id: "github-ci-cancel".to_string(),
                task_scope: None,
                request_id: preview.preflight_id.clone(),
                tool_name: "github_ci_cancel_workflow_run".to_string(),
                arguments,
                explicit_user_confirmation: true,
            })
            .await
        {
            Ok(BeginDecision::Execute(claim)) => claim,
            Ok(BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Success)) => {
                self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::ReplaySuppressed)
                    .await?;
                return Err(GitHubCiCancelError::AlreadySubmitted);
            }
            Ok(BeginDecision::ReplaySuppressed(
                ToolIdempotencyOutcome::Error | ToolIdempotencyOutcome::Uncertain,
            ))
            | Ok(BeginDecision::Ambiguous) => {
                self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                    .await?;
                return Err(GitHubCiCancelError::OutcomeUncertain);
            }
            Ok(BeginDecision::InFlight) => {
                self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::ReplaySuppressed)
                    .await?;
                return Err(GitHubCiCancelError::AlreadyInProgress);
            }
            Err(_) => {
                self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                    .await?;
                return Err(GitHubCiCancelError::IdempotencyUnavailable);
            }
        };

        match self
            .ci_client
            .cancel_run(&access_token, &target.repository, preview.run.id)
            .await
        {
            Ok(()) => {
                if self
                    .ci_rerun_idempotency
                    .complete(&idempotency_claim, ToolIdempotencyOutcome::Success)
                    .await
                    .is_err()
                {
                    self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                        .await?;
                    return Err(GitHubCiCancelError::OutcomeUncertain);
                }
                let receipt = self
                    .ci_rerun_audit
                    .complete_with_receipt(&audit_claim, ToolAuditOutcome::Success)
                    .await
                    .map_err(|_| GitHubCiCancelError::OutcomeUncertain)?;
                Ok(GitHubCiCancelResponse {
                    repository_owner: preview.repository_owner,
                    repository_name: preview.repository_name,
                    repository_url: preview.repository_url,
                    branch: preview.branch,
                    head_sha: preview.head_sha,
                    run_id: preview.run.id,
                    run_url: preview.run.html_url,
                    attempt: preview.run.attempt,
                    audit_id: receipt.audit_id,
                    accepted_at: receipt
                        .completed_at
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                })
            }
            Err(
                error @ (GitHubCiCancelError::GitHubRejected
                | GitHubCiCancelError::InvalidApiBase
                | GitHubCiCancelError::InvalidRunId),
            ) => {
                if self
                    .ci_rerun_idempotency
                    .abandon_definite(&idempotency_claim)
                    .await
                    .is_err()
                {
                    self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                        .await?;
                    return Err(GitHubCiCancelError::OutcomeUncertain);
                }
                self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::ToolError)
                    .await?;
                Err(error)
            }
            Err(_) => {
                let _ = self
                    .ci_rerun_idempotency
                    .complete(&idempotency_claim, ToolIdempotencyOutcome::Uncertain)
                    .await;
                self.finish_ci_cancel_audit(&audit_claim, ToolAuditOutcome::Ambiguous)
                    .await?;
                Err(GitHubCiCancelError::OutcomeUncertain)
            }
        }
    }

    async fn ci_cancel_access_token(&self) -> Result<String, GitHubCiCancelError> {
        self.active_access_token()
            .await
            .map_err(|error| match error {
                super::pull_requests::GitHubPullRequestError::NotAuthenticated => {
                    GitHubCiCancelError::NotAuthenticated
                }
                _ => GitHubCiCancelError::CredentialUnavailable,
            })
    }

    async fn finish_ci_cancel_audit(
        &self,
        claim: &crate::agents::tool_audit::ToolAuditClaim,
        outcome: ToolAuditOutcome,
    ) -> Result<(), GitHubCiCancelError> {
        self.ci_rerun_audit
            .complete_with_receipt(claim, outcome)
            .await
            .map(|_| ())
            .map_err(|_| GitHubCiCancelError::AuditUnavailable)
    }
}

fn valid_preflight_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn protected_arguments(
    preview: &GitHubCiCancelPreviewResponse,
) -> serde_json::Map<String, serde_json::Value> {
    serde_json::json!({
        "repositoryOwner": preview.repository_owner,
        "repositoryName": preview.repository_name,
        "branch": preview.branch,
        "headSha": preview.head_sha,
        "runId": preview.run.id,
        "attempt": preview.run.attempt,
        "preflightId": preview.preflight_id,
    })
    .as_object()
    .expect("fixed CI cancel arguments are an object")
    .clone()
}

fn audit_input(
    preview: &GitHubCiCancelPreviewResponse,
    arguments: serde_json::Map<String, serde_json::Value>,
) -> Result<ToolAuditInput, GitHubCiCancelError> {
    Ok(ToolAuditInput {
        session_id: "github-ci-cancel".to_string(),
        request_id: preview.preflight_id.clone(),
        task_scope: None,
        tool_name: QualifiedToolName::new("github::cancel_workflow_run")
            .map_err(|_| GitHubCiCancelError::AuditUnavailable)?,
        arguments,
        actor: ToolAuditActor::HostUnknown,
        effective_model: EffectiveModel::new("unknown")
            .map_err(|_| GitHubCiCancelError::AuditUnavailable)?,
        extension_source: ToolAuditExtensionSource::Frontend,
        permission_class: ToolAuditPermissionClass::ExternalWrite,
        authorization: ToolAuditAuthorization::UserConfirmed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github_auth::ci_status::{GitHubCiClient, LocalCiTarget};
    use crate::github_auth::credential_store::{
        GitHubCredentialStore, MemoryGitHubCredentialStore, StoredGitHubCredentialV1,
    };
    use crate::github_auth::device_flow::GitHubDeviceFlowClient;
    use crate::github_auth::pull_requests::GitHubRepository;
    use crate::github_auth::{GitHubAuthClock, GitHubAuthService};
    use chrono::{DateTime, Utc};
    use goose_sdk_types::custom_requests::{
        GitHubCiAggregateStatus, GitHubCiCancelPreviewRequest, GitHubCiCancelRequest, GitHubCiRun,
        GitHubCiRunStatus, GitHubCiStatusResponse,
    };
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;
    use std::time::Instant;
    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn run(status: GitHubCiRunStatus) -> GitHubCiRun {
        GitHubCiRun {
            id: 42,
            name: "tests".to_string(),
            run_number: 7,
            attempt: 2,
            event: "push".to_string(),
            status,
            conclusion: None,
            html_url: "https://github.com/owner/repository/actions/runs/42".to_string(),
            created_at: "2026-08-05T00:00:00Z".to_string(),
            updated_at: "2026-08-05T00:10:00Z".to_string(),
        }
    }

    fn status(run: GitHubCiRun) -> GitHubCiStatusResponse {
        GitHubCiStatusResponse {
            repository_owner: "owner".to_string(),
            repository_name: "repository".to_string(),
            repository_url: "https://github.com/owner/repository".to_string(),
            branch: "main".to_string(),
            head_sha: "a".repeat(40),
            working_tree_dirty: false,
            aggregate_status: GitHubCiAggregateStatus::InProgress,
            total_count: 1,
            truncated: false,
            runs: vec![run],
        }
    }

    fn target() -> LocalCiTarget {
        LocalCiTarget {
            repository: GitHubRepository {
                owner: "owner".to_string(),
                name: "repository".to_string(),
            },
            repository_root: PathBuf::from("D:\\canonical-repository"),
            remote: "origin".to_string(),
            branch: "main".to_string(),
            head_sha: "a".repeat(40),
            working_tree_dirty: true,
        }
    }

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

    fn git(cwd: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git must start");
        assert!(
            output.status.success(),
            "git {arguments:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn pushed_repository() -> (TempDir, PathBuf, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "--initial-branch", "main"]);
        git(&root, &["config", "user.name", "CodePro Test"]);
        git(&root, &["config", "user.email", "codepro@example.invalid"]);
        std::fs::write(root.join("README.md"), "initial\n").unwrap();
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-m", "initial"]);
        let head_sha = git(&root, &["rev-parse", "HEAD"]);
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repository.git",
            ],
        );
        git(&root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(&root, &["config", "branch.main.remote", "origin"]);
        git(&root, &["config", "branch.main.merge", "refs/heads/main"]);
        (temp, root, head_sha)
    }

    fn running_runs_body(head_sha: &str) -> serde_json::Value {
        serde_json::json!({
            "total_count": 1,
            "workflow_runs": [{
                "id": 42,
                "name": "tests",
                "run_number": 7,
                "run_attempt": 2,
                "event": "push",
                "status": "in_progress",
                "conclusion": null,
                "html_url": "https://github.com/owner/repository/actions/runs/42",
                "head_branch": "main",
                "head_sha": head_sha,
                "created_at": "2026-08-05T00:00:00Z",
                "updated_at": "2026-08-05T00:10:00Z"
            }]
        })
    }

    fn credential_store() -> Arc<MemoryGitHubCredentialStore> {
        let store = Arc::new(MemoryGitHubCredentialStore::default());
        store
            .save(&StoredGitHubCredentialV1 {
                schema_version: 1,
                account_login: "octocat".to_string(),
                account_id: 1,
                access_token: "ghu_cancel-secret-must-not-leak".to_string(),
                refresh_token: None,
                access_token_expires_at: Some("2026-08-05T02:00:00Z".to_string()),
                refresh_token_expires_at: None,
            })
            .unwrap();
        store
    }

    fn service_with_data_dir(server: &MockServer, data_dir: PathBuf) -> GitHubAuthService {
        GitHubAuthService::for_test_with_ci_data_dir(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            credential_store(),
            Arc::new(FixedClock),
            data_dir,
        )
    }

    async fn mount_running_runs(server: &MockServer, head_sha: &str, expected: u64) {
        Mock::given(method("GET"))
            .and(path("/repos/owner/repository/actions/runs"))
            .and(query_param("head_sha", head_sha))
            .and(query_param("per_page", "50"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(running_runs_body(head_sha)))
            .expect(expected)
            .mount(server)
            .await;
    }

    #[test]
    fn eligibility_accepts_only_positive_existing_queued_or_in_progress_runs() {
        let in_progress = status(run(GitHubCiRunStatus::InProgress));
        assert_eq!(
            eligible_run(&in_progress, 0).unwrap_err(),
            GitHubCiCancelError::InvalidRunId
        );
        assert_eq!(
            eligible_run(&in_progress, 99).unwrap_err(),
            GitHubCiCancelError::RunNotFound
        );
        assert_eq!(eligible_run(&in_progress, 42).unwrap().id, 42);
        assert_eq!(
            eligible_run(&status(run(GitHubCiRunStatus::Queued)), 42)
                .unwrap()
                .id,
            42
        );
        for ineligible in [
            GitHubCiRunStatus::Waiting,
            GitHubCiRunStatus::Requested,
            GitHubCiRunStatus::Pending,
            GitHubCiRunStatus::Completed,
            GitHubCiRunStatus::Unknown,
        ] {
            assert_eq!(
                eligible_run(&status(run(ineligible)), 42).unwrap_err(),
                GitHubCiCancelError::RunNotEligible
            );
        }
    }

    #[test]
    fn preview_binds_attempt_status_timestamp_and_head() {
        let target = target();
        let current = status(run(GitHubCiRunStatus::InProgress));
        let preview = build_preview(&target, &current, 42).unwrap();
        assert_eq!(preview.preflight_id.len(), 64);
        assert_eq!(preview.run.id, 42);

        let mut changed_attempt = current.clone();
        changed_attempt.runs[0].attempt += 1;
        assert_ne!(
            preview.preflight_id,
            build_preview(&target, &changed_attempt, 42)
                .unwrap()
                .preflight_id
        );
        let mut changed_status = current.clone();
        changed_status.runs[0].status = GitHubCiRunStatus::Queued;
        assert_ne!(
            preview.preflight_id,
            build_preview(&target, &changed_status, 42)
                .unwrap()
                .preflight_id
        );
        let mut changed_timestamp = current.clone();
        changed_timestamp.runs[0].updated_at = "2026-08-05T00:11:00Z".to_string();
        assert_ne!(
            preview.preflight_id,
            build_preview(&target, &changed_timestamp, 42)
                .unwrap()
                .preflight_id
        );
    }

    #[tokio::test]
    async fn client_posts_exactly_one_empty_cancel_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/repos/owner/repository/actions/runs/42/cancel"))
            .and(header("accept", "application/vnd.github+json"))
            .and(header("x-github-api-version", "2026-03-10"))
            .and(header("authorization", "Bearer test-cancel-token"))
            .respond_with(ResponseTemplate::new(202))
            .expect(1)
            .mount(&server)
            .await;
        GitHubCiClient::for_test(&server.uri())
            .unwrap()
            .cancel_run("test-cancel-token", &target().repository, 42)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn client_classifies_redirect_conflict_and_server_failure_without_retry() {
        for (status, expected) in [
            (302, GitHubCiCancelError::GitHubRejected),
            (409, GitHubCiCancelError::GitHubRejected),
            (500, GitHubCiCancelError::OutcomeUncertain),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/repos/owner/repository/actions/runs/42/cancel"))
                .respond_with(ResponseTemplate::new(status))
                .expect(1)
                .mount(&server)
                .await;
            let error = GitHubCiClient::for_test(&server.uri())
                .unwrap()
                .cancel_run("secret-cancel-token", &target().repository, 42)
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            assert!(!error.to_string().contains("secret-cancel-token"));
        }
    }

    #[tokio::test]
    async fn service_rechecks_preflight_audits_and_suppresses_duplicate_success() {
        let (_repository, root, head_sha) = pushed_repository();
        let server = MockServer::start().await;
        mount_running_runs(&server, &head_sha, 4).await;
        Mock::given(method("POST"))
            .and(path("/repos/owner/repository/actions/runs/42/cancel"))
            .respond_with(ResponseTemplate::new(202))
            .expect(1)
            .mount(&server)
            .await;
        let service = GitHubAuthService::for_test(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            credential_store(),
            Arc::new(FixedClock),
        );
        let preview = service
            .preview_ci_cancel(GitHubCiCancelPreviewRequest {
                working_dir: root.to_string_lossy().into_owned(),
                run_id: 42,
            })
            .await
            .unwrap();

        let mut execute = GitHubCiCancelRequest {
            working_dir: root.to_string_lossy().into_owned(),
            run_id: 42,
            preflight_id: "b".repeat(64),
        };
        assert_eq!(
            service.cancel_ci_run(execute.clone()).await.unwrap_err(),
            GitHubCiCancelError::PreflightStale
        );

        execute.preflight_id = preview.preflight_id;
        let accepted = service.cancel_ci_run(execute.clone()).await.unwrap();
        assert_eq!(accepted.run_id, 42);
        assert_eq!(accepted.attempt, 2);
        assert!(!accepted.audit_id.is_empty());
        assert!(DateTime::parse_from_rfc3339(&accepted.accepted_at).is_ok());
        let serialized = serde_json::to_string(&accepted).unwrap();
        assert!(!serialized.contains("ghu_cancel-secret-must-not-leak"));
        assert!(!serialized.contains(root.to_string_lossy().as_ref()));

        assert_eq!(
            service.cancel_ci_run(execute).await.unwrap_err(),
            GitHubCiCancelError::AlreadySubmitted
        );
    }

    #[tokio::test]
    async fn definite_rejection_can_retry_after_reopen_but_uncertain_outcome_cannot() {
        let (_repository, root, head_sha) = pushed_repository();
        let data = tempfile::tempdir().unwrap();

        let rejected_server = MockServer::start().await;
        mount_running_runs(&rejected_server, &head_sha, 2).await;
        Mock::given(method("POST"))
            .and(path("/repos/owner/repository/actions/runs/42/cancel"))
            .respond_with(ResponseTemplate::new(409))
            .expect(1)
            .mount(&rejected_server)
            .await;
        let rejected_service = service_with_data_dir(&rejected_server, data.path().to_path_buf());
        let preview = rejected_service
            .preview_ci_cancel(GitHubCiCancelPreviewRequest {
                working_dir: root.to_string_lossy().into_owned(),
                run_id: 42,
            })
            .await
            .unwrap();
        let execute = GitHubCiCancelRequest {
            working_dir: root.to_string_lossy().into_owned(),
            run_id: 42,
            preflight_id: preview.preflight_id,
        };
        assert_eq!(
            rejected_service
                .cancel_ci_run(execute.clone())
                .await
                .unwrap_err(),
            GitHubCiCancelError::GitHubRejected
        );
        drop(rejected_service);

        let accepted_server = MockServer::start().await;
        mount_running_runs(&accepted_server, &head_sha, 1).await;
        Mock::given(method("POST"))
            .and(path("/repos/owner/repository/actions/runs/42/cancel"))
            .respond_with(ResponseTemplate::new(202))
            .expect(1)
            .mount(&accepted_server)
            .await;
        service_with_data_dir(&accepted_server, data.path().to_path_buf())
            .cancel_ci_run(execute)
            .await
            .unwrap();

        let uncertain_data = tempfile::tempdir().unwrap();
        let uncertain_server = MockServer::start().await;
        mount_running_runs(&uncertain_server, &head_sha, 2).await;
        Mock::given(method("POST"))
            .and(path("/repos/owner/repository/actions/runs/42/cancel"))
            .respond_with(ResponseTemplate::new(500))
            .expect(1)
            .mount(&uncertain_server)
            .await;
        let uncertain_service =
            service_with_data_dir(&uncertain_server, uncertain_data.path().to_path_buf());
        let uncertain_preview = uncertain_service
            .preview_ci_cancel(GitHubCiCancelPreviewRequest {
                working_dir: root.to_string_lossy().into_owned(),
                run_id: 42,
            })
            .await
            .unwrap();
        let uncertain_execute = GitHubCiCancelRequest {
            working_dir: root.to_string_lossy().into_owned(),
            run_id: 42,
            preflight_id: uncertain_preview.preflight_id,
        };
        assert_eq!(
            uncertain_service
                .cancel_ci_run(uncertain_execute.clone())
                .await
                .unwrap_err(),
            GitHubCiCancelError::OutcomeUncertain
        );
        drop(uncertain_service);

        let suppressed_server = MockServer::start().await;
        mount_running_runs(&suppressed_server, &head_sha, 1).await;
        Mock::given(method("POST"))
            .and(path("/repos/owner/repository/actions/runs/42/cancel"))
            .respond_with(ResponseTemplate::new(202))
            .expect(0)
            .mount(&suppressed_server)
            .await;
        assert_eq!(
            service_with_data_dir(&suppressed_server, uncertain_data.path().to_path_buf())
                .cancel_ci_run(uncertain_execute)
                .await
                .unwrap_err(),
            GitHubCiCancelError::OutcomeUncertain
        );
    }

    #[tokio::test]
    async fn audit_start_failure_never_posts_to_github() {
        let (_repository, root, head_sha) = pushed_repository();
        let data = tempfile::tempdir().unwrap();
        let blocked_data_dir = data.path().join("not-a-directory");
        std::fs::write(&blocked_data_dir, "blocked").unwrap();
        let server = MockServer::start().await;
        mount_running_runs(&server, &head_sha, 2).await;
        Mock::given(method("POST"))
            .and(path("/repos/owner/repository/actions/runs/42/cancel"))
            .respond_with(ResponseTemplate::new(202))
            .expect(0)
            .mount(&server)
            .await;
        let service = service_with_data_dir(&server, blocked_data_dir);
        let preview = service
            .preview_ci_cancel(GitHubCiCancelPreviewRequest {
                working_dir: root.to_string_lossy().into_owned(),
                run_id: 42,
            })
            .await
            .unwrap();

        assert_eq!(
            service
                .cancel_ci_run(GitHubCiCancelRequest {
                    working_dir: root.to_string_lossy().into_owned(),
                    run_id: 42,
                    preflight_id: preview.preflight_id,
                })
                .await
                .unwrap_err(),
            GitHubCiCancelError::AuditUnavailable
        );
    }
}
