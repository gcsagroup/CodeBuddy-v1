use futures::StreamExt;
use goose_sdk_types::custom_requests::{
    GitHubCiArtifact, GitHubCiArtifactRun, GitHubCiArtifactsRequest, GitHubCiArtifactsResponse,
    GitHubCiRun,
};
use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE};
use serde::Deserialize;
use std::collections::HashSet;

use super::ci_status::{GitHubCiClient, LocalCiTarget};

pub(crate) const MAX_ARTIFACT_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_ARTIFACTS: usize = 100;
const MAX_ARTIFACT_NAME_CHARS: usize = 256;
const MAX_ARTIFACT_NODE_ID_CHARS: usize = 256;
const MAX_ARTIFACT_SIZE_BYTES: u64 = 10 * 1024 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubCiArtifactsError {
    #[error("The workflow run ID must be a positive integer")]
    InvalidRunId,
    #[error("GitHub returned invalid artifact metadata")]
    InvalidGitHubResponse,
    #[error("The GitHub artifact response exceeded the safety limit")]
    GitHubResponseTooLarge,
    #[error("The GitHub API is unavailable")]
    NetworkUnavailable,
    #[error("GitHub rejected the artifact metadata request")]
    GitHubRejected,
    #[error("The workflow run was not found for the current pushed HEAD")]
    RunNotFound,
    #[error("GitHub is not connected or the stored authorization has expired")]
    NotAuthenticated,
    #[error("The GitHub credential could not be read from secure storage")]
    CredentialUnavailable,
    #[error(transparent)]
    CiStatus(#[from] super::ci_status::GitHubCiError),
}

impl GitHubCiArtifactsError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidRunId => "invalid_run_id",
            Self::InvalidGitHubResponse => "invalid_github_response",
            Self::GitHubResponseTooLarge => "github_response_too_large",
            Self::NetworkUnavailable => "network_unavailable",
            Self::GitHubRejected => "github_rejected",
            Self::RunNotFound => "run_not_found",
            Self::NotAuthenticated => "not_authenticated",
            Self::CredentialUnavailable => "credential_unavailable",
            Self::CiStatus(error) => error.code(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactsApiResponse {
    total_count: u64,
    artifacts: Vec<ArtifactApiResponse>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactApiResponse {
    id: u64,
    node_id: String,
    name: String,
    size_in_bytes: u64,
    url: String,
    archive_download_url: String,
    expired: bool,
    created_at: String,
    updated_at: String,
    expires_at: String,
    digest: Option<String>,
    workflow_run: ArtifactWorkflowRunApiResponse,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactWorkflowRunApiResponse {
    id: u64,
    repository_id: u64,
    head_repository_id: u64,
    head_branch: String,
    head_sha: String,
}

impl GitHubCiClient {
    pub(crate) async fn artifacts(
        &self,
        access_token: &str,
        target: &LocalCiTarget,
        run: &GitHubCiRun,
    ) -> Result<GitHubCiArtifactsResponse, GitHubCiArtifactsError> {
        if run.id == 0 {
            return Err(GitHubCiArtifactsError::InvalidRunId);
        }
        let mut endpoint = self
            .api_base
            .join(&format!(
                "repos/{}/{}/actions/runs/{}/artifacts",
                target.repository.owner, target.repository.name, run.id
            ))
            .map_err(|_| GitHubCiArtifactsError::InvalidGitHubResponse)?;
        endpoint
            .query_pairs_mut()
            .append_pair("per_page", "100")
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
            .map_err(|_| GitHubCiArtifactsError::NetworkUnavailable)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(GitHubCiArtifactsError::GitHubRejected);
        }
        let body = read_artifacts_json(response).await?;
        let raw: ArtifactsApiResponse = serde_json::from_slice(&body)
            .map_err(|_| GitHubCiArtifactsError::InvalidGitHubResponse)?;
        if raw.artifacts.len() > MAX_ARTIFACTS || raw.total_count != raw.artifacts.len() as u64 {
            return Err(GitHubCiArtifactsError::InvalidGitHubResponse);
        }
        let mut ids = HashSet::with_capacity(raw.artifacts.len());
        let mut names = HashSet::with_capacity(raw.artifacts.len());
        let mut artifacts = Vec::with_capacity(raw.artifacts.len());
        for artifact in raw.artifacts {
            if !ids.insert(artifact.id) || !names.insert(artifact.name.clone()) {
                return Err(GitHubCiArtifactsError::InvalidGitHubResponse);
            }
            artifacts.push(validate_artifact(target, run, artifact)?);
        }
        Ok(GitHubCiArtifactsResponse {
            repository_owner: target.repository.owner.clone(),
            repository_name: target.repository.name.clone(),
            repository_url: format!(
                "https://github.com/{}/{}",
                target.repository.owner, target.repository.name
            ),
            branch: target.branch.clone(),
            head_sha: target.head_sha.clone(),
            working_tree_dirty: target.working_tree_dirty,
            run: GitHubCiArtifactRun {
                id: run.id,
                name: run.name.clone(),
                run_number: run.run_number,
                attempt: run.attempt,
                event: run.event.clone(),
                status: run.status,
                conclusion: run.conclusion,
            },
            total_count: raw.total_count,
            artifacts,
        })
    }
}

impl super::GitHubAuthService {
    pub(crate) async fn ci_artifacts(
        &self,
        request: GitHubCiArtifactsRequest,
    ) -> Result<GitHubCiArtifactsResponse, GitHubCiArtifactsError> {
        if request.run_id == 0 {
            return Err(GitHubCiArtifactsError::InvalidRunId);
        }
        let target =
            super::ci_status::inspect_local_ci_target(std::path::Path::new(&request.working_dir))
                .await?;
        let access_token = self
            .active_access_token()
            .await
            .map_err(|error| match error {
                super::pull_requests::GitHubPullRequestError::NotAuthenticated => {
                    GitHubCiArtifactsError::NotAuthenticated
                }
                _ => GitHubCiArtifactsError::CredentialUnavailable,
            })?;
        let status = self.ci_client.status(&access_token, &target).await?;
        let run = status
            .runs
            .iter()
            .find(|run| run.id == request.run_id)
            .ok_or(GitHubCiArtifactsError::RunNotFound)?;
        self.ci_client.artifacts(&access_token, &target, run).await
    }
}

async fn read_artifacts_json(
    response: reqwest::Response,
) -> Result<Vec<u8>, GitHubCiArtifactsError> {
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
        return Err(GitHubCiArtifactsError::InvalidGitHubResponse);
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_ARTIFACT_RESPONSE_BYTES)
    {
        return Err(GitHubCiArtifactsError::GitHubResponseTooLarge);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| GitHubCiArtifactsError::NetworkUnavailable)?;
        if body.len().saturating_add(chunk.len()) > MAX_ARTIFACT_RESPONSE_BYTES {
            return Err(GitHubCiArtifactsError::GitHubResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn validate_artifact(
    target: &LocalCiTarget,
    run: &GitHubCiRun,
    artifact: ArtifactApiResponse,
) -> Result<GitHubCiArtifact, GitHubCiArtifactsError> {
    let created_at = chrono::DateTime::parse_from_rfc3339(&artifact.created_at)
        .map_err(|_| GitHubCiArtifactsError::InvalidGitHubResponse)?;
    let updated_at = chrono::DateTime::parse_from_rfc3339(&artifact.updated_at)
        .map_err(|_| GitHubCiArtifactsError::InvalidGitHubResponse)?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&artifact.expires_at)
        .map_err(|_| GitHubCiArtifactsError::InvalidGitHubResponse)?;
    let expected_url = format!(
        "https://api.github.com/repos/{}/{}/actions/artifacts/{}",
        target.repository.owner, target.repository.name, artifact.id
    );
    if artifact.id == 0
        || !bounded_text(&artifact.node_id, MAX_ARTIFACT_NODE_ID_CHARS)
        || !bounded_text(&artifact.name, MAX_ARTIFACT_NAME_CHARS)
        || artifact.size_in_bytes > MAX_ARTIFACT_SIZE_BYTES
        || artifact.url != expected_url
        || artifact.archive_download_url != format!("{expected_url}/zip")
        || artifact.workflow_run.id != run.id
        || artifact.workflow_run.repository_id == 0
        || artifact.workflow_run.repository_id != artifact.workflow_run.head_repository_id
        || artifact.workflow_run.head_branch != target.branch
        || artifact.workflow_run.head_sha != target.head_sha
        || updated_at < created_at
        || expires_at < created_at
        || artifact
            .digest
            .as_deref()
            .is_some_and(|digest| !valid_digest(digest))
    {
        return Err(GitHubCiArtifactsError::InvalidGitHubResponse);
    }
    Ok(GitHubCiArtifact {
        id: artifact.id,
        name: artifact.name,
        size_bytes: artifact.size_in_bytes,
        expired: artifact.expired,
        created_at: artifact.created_at,
        expires_at: artifact.expires_at,
        digest: artifact.digest,
    })
}

fn bounded_text(value: &str, max_chars: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max_chars && !value.chars().any(char::is_control)
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
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
        GitHubCiArtifactsRequest, GitHubCiRun, GitHubCiRunConclusion, GitHubCiRunStatus,
    };
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;
    use std::time::Instant;
    use tempfile::TempDir;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    type ArtifactBodyMutation = Box<dyn Fn(&mut serde_json::Value)>;

    fn target() -> LocalCiTarget {
        LocalCiTarget {
            repository: GitHubRepository {
                owner: "octo".to_string(),
                name: "demo".to_string(),
            },
            repository_root: PathBuf::from("D:\\repo"),
            remote: "origin".to_string(),
            branch: "main".to_string(),
            head_sha: "1".repeat(40),
            working_tree_dirty: true,
        }
    }

    fn run() -> GitHubCiRun {
        GitHubCiRun {
            id: 42,
            name: "CI".to_string(),
            run_number: 9,
            attempt: 2,
            event: "push".to_string(),
            status: GitHubCiRunStatus::Completed,
            conclusion: Some(GitHubCiRunConclusion::Success),
            html_url: "https://github.com/octo/demo/actions/runs/42".to_string(),
            created_at: "2026-08-05T01:00:00Z".to_string(),
            updated_at: "2026-08-05T01:10:00Z".to_string(),
        }
    }

    fn artifacts_body_for_sha(head_sha: &str) -> serde_json::Value {
        serde_json::json!({
            "total_count": 1,
            "artifacts": [{
                "id": 7,
                "node_id": "artifact-node-7",
                "name": "test-results",
                "size_in_bytes": 12345,
                "url": "https://api.github.com/repos/octo/demo/actions/artifacts/7",
                "archive_download_url": "https://api.github.com/repos/octo/demo/actions/artifacts/7/zip",
                "expired": false,
                "created_at": "2026-08-05T01:05:00Z",
                "updated_at": "2026-08-05T01:06:00Z",
                "expires_at": "2026-09-05T01:05:00Z",
                "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "workflow_run": {
                    "id": 42,
                    "repository_id": 100,
                    "head_repository_id": 100,
                    "head_branch": "main",
                    "head_sha": head_sha
                }
            }]
        })
    }

    fn artifacts_body() -> serde_json::Value {
        artifacts_body_for_sha(&"1".repeat(40))
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
                "https://github.com/octo/demo.git",
            ],
        );
        git(&root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(&root, &["config", "branch.main.remote", "origin"]);
        git(&root, &["config", "branch.main.merge", "refs/heads/main"]);
        (temp, root, head_sha)
    }

    fn workflow_runs_body(head_sha: &str) -> serde_json::Value {
        serde_json::json!({
            "total_count": 1,
            "workflow_runs": [{
                "id": 42,
                "name": "CI",
                "run_number": 9,
                "run_attempt": 2,
                "event": "push",
                "status": "completed",
                "conclusion": "success",
                "html_url": "https://github.com/octo/demo/actions/runs/42",
                "head_branch": "main",
                "head_sha": head_sha,
                "created_at": "2026-08-05T01:00:00Z",
                "updated_at": "2026-08-05T01:10:00Z"
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
                access_token: "ghu_artifact-secret-must-not-leak".to_string(),
                refresh_token: None,
                access_token_expires_at: Some("2026-08-05T02:00:00Z".to_string()),
                refresh_token_expires_at: None,
            })
            .unwrap();
        store
    }

    fn service(server: &MockServer) -> GitHubAuthService {
        GitHubAuthService::for_test(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            credential_store(),
            Arc::new(FixedClock),
        )
    }

    async fn mount_status(server: &MockServer, head_sha: &str, expected: u64) {
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/runs"))
            .and(query_param("head_sha", head_sha))
            .and(query_param("per_page", "50"))
            .and(query_param("page", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(workflow_runs_body(head_sha)))
            .expect(expected)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn client_lists_exact_run_artifact_metadata_without_downloads() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/runs/42/artifacts"))
            .and(query_param("per_page", "100"))
            .and(query_param("page", "1"))
            .and(header("accept", "application/vnd.github+json"))
            .and(header("x-github-api-version", "2026-03-10"))
            .and(header("authorization", "Bearer artifact-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(artifacts_body()))
            .expect(1)
            .mount(&server)
            .await;

        let response = GitHubCiClient::for_test(&server.uri())
            .unwrap()
            .artifacts("artifact-token", &target(), &run())
            .await
            .unwrap();

        assert_eq!(response.total_count, 1);
        assert_eq!(response.artifacts.len(), 1);
        assert_eq!(response.artifacts[0].name, "test-results");
        let public = serde_json::to_string(&response).unwrap();
        assert!(!public.contains("archive_download_url"));
        assert!(!public.contains("artifact-token"));
    }

    #[tokio::test]
    async fn client_rejects_redirect_non_json_and_oversized_artifact_responses() {
        for (status, content_type, body, expected) in [
            (
                302,
                "application/json",
                Vec::new(),
                GitHubCiArtifactsError::GitHubRejected,
            ),
            (
                200,
                "text/html",
                serde_json::to_vec(&artifacts_body()).unwrap(),
                GitHubCiArtifactsError::InvalidGitHubResponse,
            ),
            (
                200,
                "application/json",
                vec![b'x'; MAX_ARTIFACT_RESPONSE_BYTES + 1],
                GitHubCiArtifactsError::GitHubResponseTooLarge,
            ),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(
                    ResponseTemplate::new(status)
                        .insert_header("content-type", content_type)
                        .set_body_bytes(body),
                )
                .expect(1)
                .mount(&server)
                .await;
            assert_eq!(
                GitHubCiClient::for_test(&server.uri())
                    .unwrap()
                    .artifacts("secret-token", &target(), &run())
                    .await
                    .unwrap_err(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn client_rejects_forged_duplicate_or_invalid_artifact_metadata() {
        let mutations: Vec<ArtifactBodyMutation> = vec![
            Box::new(|body| body["total_count"] = serde_json::json!(2)),
            Box::new(|body| {
                let duplicate = body["artifacts"][0].clone();
                body["artifacts"].as_array_mut().unwrap().push(duplicate);
            }),
            Box::new(|body| body["artifacts"][0]["name"] = serde_json::json!("bad\nname")),
            Box::new(|body| body["artifacts"][0]["digest"] = serde_json::json!("sha256:BAD")),
            Box::new(|body| {
                body["artifacts"][0]["url"] = serde_json::json!("https://attacker.invalid/7")
            }),
            Box::new(|body| {
                body["artifacts"][0]["workflow_run"]["head_sha"] = serde_json::json!("2".repeat(40))
            }),
            Box::new(|body| {
                body["artifacts"][0]["expires_at"] = serde_json::json!("2026-01-01T00:00:00Z")
            }),
        ];
        for mutate in mutations {
            let server = MockServer::start().await;
            let mut body = artifacts_body();
            mutate(&mut body);
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .expect(1)
                .mount(&server)
                .await;
            assert_eq!(
                GitHubCiClient::for_test(&server.uri())
                    .unwrap()
                    .artifacts("secret-token", &target(), &run())
                    .await
                    .unwrap_err(),
                GitHubCiArtifactsError::InvalidGitHubResponse
            );
        }
    }

    #[tokio::test]
    async fn service_lists_artifacts_only_for_a_run_in_the_exact_pushed_head() {
        let (_repository, root, head_sha) = pushed_repository();
        let server = MockServer::start().await;
        mount_status(&server, &head_sha, 1).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/runs/42/artifacts"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(artifacts_body_for_sha(&head_sha)),
            )
            .expect(1)
            .mount(&server)
            .await;

        let response = service(&server)
            .ci_artifacts(GitHubCiArtifactsRequest {
                working_dir: root.to_string_lossy().into_owned(),
                run_id: 42,
            })
            .await
            .unwrap();

        assert_eq!(response.run.id, 42);
        assert_eq!(response.head_sha, head_sha);
        assert_eq!(response.artifacts[0].name, "test-results");
        let public = serde_json::to_string(&response).unwrap();
        assert!(!public.contains("ghu_artifact-secret-must-not-leak"));
        assert!(!public.contains(root.to_string_lossy().as_ref()));
        assert!(!public.contains("archive_download_url"));
    }

    #[tokio::test]
    async fn service_rejects_unknown_run_before_requesting_artifacts() {
        let (_repository, root, head_sha) = pushed_repository();
        let server = MockServer::start().await;
        mount_status(&server, &head_sha, 1).await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/demo/actions/runs/99/artifacts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "total_count": 0,
                "artifacts": []
            })))
            .expect(0)
            .mount(&server)
            .await;

        assert_eq!(
            service(&server)
                .ci_artifacts(GitHubCiArtifactsRequest {
                    working_dir: root.to_string_lossy().into_owned(),
                    run_id: 99,
                })
                .await
                .unwrap_err(),
            GitHubCiArtifactsError::RunNotFound
        );
    }

    #[tokio::test]
    async fn service_rejects_zero_run_before_local_or_network_work() {
        let server = MockServer::start().await;
        assert_eq!(
            service(&server)
                .ci_artifacts(GitHubCiArtifactsRequest {
                    working_dir: "relative-and-invalid".to_string(),
                    run_id: 0,
                })
                .await
                .unwrap_err(),
            GitHubCiArtifactsError::InvalidRunId
        );
    }
}
