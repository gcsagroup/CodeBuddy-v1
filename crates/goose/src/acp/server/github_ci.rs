use super::*;
use crate::github_auth::artifacts::GitHubCiArtifactsError;
use crate::github_auth::ci_cancel::GitHubCiCancelError;
use crate::github_auth::ci_rerun::GitHubCiRerunError;
use crate::github_auth::ci_status::GitHubCiError;
use crate::github_auth::workflow_dispatch::GitHubWorkflowDispatchError;

fn artifacts_error_data(error: GitHubCiArtifactsError) -> serde_json::Value {
    serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    })
}

fn artifacts_error(error: GitHubCiArtifactsError) -> agent_client_protocol::Error {
    let data = artifacts_error_data(error);
    match error {
        GitHubCiArtifactsError::InvalidRunId
        | GitHubCiArtifactsError::RunNotFound
        | GitHubCiArtifactsError::NotAuthenticated => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        GitHubCiArtifactsError::CiStatus(
            GitHubCiError::InvalidDirectory
            | GitHubCiError::NotGitRepository
            | GitHubCiError::DetachedHead
            | GitHubCiError::MissingUpstream
            | GitHubCiError::UpstreamMismatch
            | GitHubCiError::UnsupportedRemote
            | GitHubCiError::HeadNotPushed
            | GitHubCiError::NotAuthenticated,
        ) => agent_client_protocol::Error::invalid_params().data(data),
        GitHubCiArtifactsError::InvalidGitHubResponse
        | GitHubCiArtifactsError::GitHubResponseTooLarge
        | GitHubCiArtifactsError::NetworkUnavailable
        | GitHubCiArtifactsError::GitHubRejected
        | GitHubCiArtifactsError::CredentialUnavailable
        | GitHubCiArtifactsError::CiStatus(_) => {
            agent_client_protocol::Error::internal_error().data(data)
        }
    }
}

fn ci_error_data(error: GitHubCiError) -> serde_json::Value {
    serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    })
}

fn ci_error(error: GitHubCiError) -> agent_client_protocol::Error {
    let data = ci_error_data(error);
    match error {
        GitHubCiError::InvalidDirectory
        | GitHubCiError::NotGitRepository
        | GitHubCiError::DetachedHead
        | GitHubCiError::MissingUpstream
        | GitHubCiError::UpstreamMismatch
        | GitHubCiError::UnsupportedRemote
        | GitHubCiError::HeadNotPushed
        | GitHubCiError::NotAuthenticated => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        _ => agent_client_protocol::Error::internal_error().data(data),
    }
}

fn rerun_error_data(error: GitHubCiRerunError) -> serde_json::Value {
    serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    })
}

fn rerun_error(error: GitHubCiRerunError) -> agent_client_protocol::Error {
    let data = rerun_error_data(error);
    match error {
        GitHubCiRerunError::InvalidRunId
        | GitHubCiRerunError::RunNotFound
        | GitHubCiRerunError::RunNotEligible
        | GitHubCiRerunError::StatusTargetMismatch
        | GitHubCiRerunError::InvalidPreflightId
        | GitHubCiRerunError::PreflightStale
        | GitHubCiRerunError::AlreadySubmitted
        | GitHubCiRerunError::AlreadyInProgress
        | GitHubCiRerunError::NotAuthenticated => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        GitHubCiRerunError::CiStatus(
            GitHubCiError::InvalidDirectory
            | GitHubCiError::NotGitRepository
            | GitHubCiError::DetachedHead
            | GitHubCiError::MissingUpstream
            | GitHubCiError::UpstreamMismatch
            | GitHubCiError::UnsupportedRemote
            | GitHubCiError::HeadNotPushed
            | GitHubCiError::NotAuthenticated,
        ) => agent_client_protocol::Error::invalid_params().data(data),
        GitHubCiRerunError::InvalidApiBase
        | GitHubCiRerunError::GitHubRejected
        | GitHubCiRerunError::OutcomeUncertain
        | GitHubCiRerunError::IdempotencyUnavailable
        | GitHubCiRerunError::AuditUnavailable
        | GitHubCiRerunError::CredentialUnavailable
        | GitHubCiRerunError::CiStatus(_) => {
            agent_client_protocol::Error::internal_error().data(data)
        }
    }
}

fn cancel_error_data(error: GitHubCiCancelError) -> serde_json::Value {
    serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    })
}

fn cancel_error(error: GitHubCiCancelError) -> agent_client_protocol::Error {
    let data = cancel_error_data(error);
    match error {
        GitHubCiCancelError::InvalidRunId
        | GitHubCiCancelError::RunNotFound
        | GitHubCiCancelError::RunNotEligible
        | GitHubCiCancelError::StatusTargetMismatch
        | GitHubCiCancelError::InvalidPreflightId
        | GitHubCiCancelError::PreflightStale
        | GitHubCiCancelError::AlreadySubmitted
        | GitHubCiCancelError::AlreadyInProgress
        | GitHubCiCancelError::NotAuthenticated => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        GitHubCiCancelError::CiStatus(
            GitHubCiError::InvalidDirectory
            | GitHubCiError::NotGitRepository
            | GitHubCiError::DetachedHead
            | GitHubCiError::MissingUpstream
            | GitHubCiError::UpstreamMismatch
            | GitHubCiError::UnsupportedRemote
            | GitHubCiError::HeadNotPushed
            | GitHubCiError::NotAuthenticated,
        ) => agent_client_protocol::Error::invalid_params().data(data),
        GitHubCiCancelError::InvalidApiBase
        | GitHubCiCancelError::GitHubRejected
        | GitHubCiCancelError::OutcomeUncertain
        | GitHubCiCancelError::IdempotencyUnavailable
        | GitHubCiCancelError::AuditUnavailable
        | GitHubCiCancelError::CredentialUnavailable
        | GitHubCiCancelError::CiStatus(_) => {
            agent_client_protocol::Error::internal_error().data(data)
        }
    }
}

fn dispatch_error_data(error: GitHubWorkflowDispatchError) -> serde_json::Value {
    serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    })
}

fn dispatch_error(error: GitHubWorkflowDispatchError) -> agent_client_protocol::Error {
    let data = dispatch_error_data(error);
    match error {
        GitHubWorkflowDispatchError::InvalidWorkflowId
        | GitHubWorkflowDispatchError::WorkflowNotFound
        | GitHubWorkflowDispatchError::MissingDefaultBranch
        | GitHubWorkflowDispatchError::NotDefaultBranch
        | GitHubWorkflowDispatchError::TooManyWorkflows
        | GitHubWorkflowDispatchError::WorkflowTooLarge
        | GitHubWorkflowDispatchError::InvalidWorkflowSchema
        | GitHubWorkflowDispatchError::InvalidInputs
        | GitHubWorkflowDispatchError::InvalidPreflightId
        | GitHubWorkflowDispatchError::PreflightStale
        | GitHubWorkflowDispatchError::AlreadySubmitted
        | GitHubWorkflowDispatchError::AlreadyInProgress
        | GitHubWorkflowDispatchError::NotAuthenticated => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        GitHubWorkflowDispatchError::CiStatus(
            GitHubCiError::InvalidDirectory
            | GitHubCiError::NotGitRepository
            | GitHubCiError::DetachedHead
            | GitHubCiError::MissingUpstream
            | GitHubCiError::UpstreamMismatch
            | GitHubCiError::UnsupportedRemote
            | GitHubCiError::HeadNotPushed
            | GitHubCiError::NotAuthenticated,
        ) => agent_client_protocol::Error::invalid_params().data(data),
        GitHubWorkflowDispatchError::GitFailed
        | GitHubWorkflowDispatchError::GitOutputTooLarge
        | GitHubWorkflowDispatchError::InvalidWorkflowCatalog
        | GitHubWorkflowDispatchError::NetworkUnavailable
        | GitHubWorkflowDispatchError::GitHubRejected
        | GitHubWorkflowDispatchError::OutcomeUncertain
        | GitHubWorkflowDispatchError::IdempotencyUnavailable
        | GitHubWorkflowDispatchError::AuditUnavailable
        | GitHubWorkflowDispatchError::CredentialUnavailable
        | GitHubWorkflowDispatchError::GitHubResponseTooLarge
        | GitHubWorkflowDispatchError::CiStatus(_) => {
            agent_client_protocol::Error::internal_error().data(data)
        }
    }
}

impl GooseAcpAgent {
    pub(super) async fn on_github_ci_status(
        &self,
        request: GitHubCiStatusRequest,
    ) -> Result<GitHubCiStatusResponse, agent_client_protocol::Error> {
        self.github_auth.ci_status(request).await.map_err(ci_error)
    }

    pub(super) async fn on_github_ci_artifacts(
        &self,
        request: GitHubCiArtifactsRequest,
    ) -> Result<GitHubCiArtifactsResponse, agent_client_protocol::Error> {
        self.github_auth
            .ci_artifacts(request)
            .await
            .map_err(artifacts_error)
    }

    pub(super) async fn on_github_ci_rerun_preview(
        &self,
        request: GitHubCiRerunPreviewRequest,
    ) -> Result<GitHubCiRerunPreviewResponse, agent_client_protocol::Error> {
        self.github_auth
            .preview_ci_rerun(request)
            .await
            .map_err(rerun_error)
    }

    pub(super) async fn on_github_ci_rerun(
        &self,
        request: GitHubCiRerunRequest,
    ) -> Result<GitHubCiRerunResponse, agent_client_protocol::Error> {
        self.github_auth
            .rerun_failed_ci_jobs(request)
            .await
            .map_err(rerun_error)
    }

    pub(super) async fn on_github_ci_cancel_preview(
        &self,
        request: GitHubCiCancelPreviewRequest,
    ) -> Result<GitHubCiCancelPreviewResponse, agent_client_protocol::Error> {
        self.github_auth
            .preview_ci_cancel(request)
            .await
            .map_err(cancel_error)
    }

    pub(super) async fn on_github_ci_cancel(
        &self,
        request: GitHubCiCancelRequest,
    ) -> Result<GitHubCiCancelResponse, agent_client_protocol::Error> {
        self.github_auth
            .cancel_ci_run(request)
            .await
            .map_err(cancel_error)
    }

    pub(super) async fn on_github_workflow_dispatch_catalog(
        &self,
        request: GitHubWorkflowDispatchCatalogRequest,
    ) -> Result<GitHubWorkflowDispatchCatalogResponse, agent_client_protocol::Error> {
        self.github_auth
            .workflow_dispatch_catalog(request)
            .await
            .map_err(dispatch_error)
    }

    pub(super) async fn on_github_workflow_dispatch_preview(
        &self,
        request: GitHubWorkflowDispatchPreviewRequest,
    ) -> Result<GitHubWorkflowDispatchPreviewResponse, agent_client_protocol::Error> {
        self.github_auth
            .preview_workflow_dispatch(request)
            .await
            .map_err(dispatch_error)
    }

    pub(super) async fn on_github_workflow_dispatch(
        &self,
        request: GitHubWorkflowDispatchRequest,
    ) -> Result<GitHubWorkflowDispatchResponse, agent_client_protocol::Error> {
        self.github_auth
            .dispatch_workflow_run(request)
            .await
            .map_err(dispatch_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci_errors_are_mapped_to_stable_secret_safe_data() {
        let secret = "ghu_ci-secret-must-not-leak";
        for error in [
            GitHubCiError::InvalidDirectory,
            GitHubCiError::DetachedHead,
            GitHubCiError::UnsupportedRemote,
            GitHubCiError::HeadNotPushed,
            GitHubCiError::NotAuthenticated,
            GitHubCiError::CredentialUnavailable,
            GitHubCiError::NetworkUnavailable,
            GitHubCiError::InvalidGitHubResponse,
            GitHubCiError::GitHubResponseTooLarge,
        ] {
            let data = ci_error_data(error);
            assert_eq!(data["code"], error.code());
            assert!(data["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()));
            assert!(!data.to_string().contains(secret));
        }
    }

    #[test]
    fn artifact_errors_are_mapped_to_stable_secret_safe_data() {
        let secret = "ghu_artifact-secret-must-not-leak";
        for error in [
            GitHubCiArtifactsError::InvalidRunId,
            GitHubCiArtifactsError::RunNotFound,
            GitHubCiArtifactsError::NotAuthenticated,
            GitHubCiArtifactsError::CredentialUnavailable,
            GitHubCiArtifactsError::NetworkUnavailable,
            GitHubCiArtifactsError::InvalidGitHubResponse,
            GitHubCiArtifactsError::GitHubResponseTooLarge,
            GitHubCiArtifactsError::CiStatus(GitHubCiError::HeadNotPushed),
        ] {
            let data = artifacts_error_data(error);
            assert_eq!(data["code"], error.code());
            assert!(data["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()));
            assert!(!data.to_string().contains(secret));
        }
    }

    #[test]
    fn rerun_errors_are_mapped_to_stable_secret_safe_data() {
        let secret = "ghu_rerun-secret-must-not-leak";
        for error in [
            GitHubCiRerunError::InvalidRunId,
            GitHubCiRerunError::RunNotEligible,
            GitHubCiRerunError::PreflightStale,
            GitHubCiRerunError::AlreadySubmitted,
            GitHubCiRerunError::OutcomeUncertain,
            GitHubCiRerunError::AuditUnavailable,
            GitHubCiRerunError::CredentialUnavailable,
            GitHubCiRerunError::CiStatus(GitHubCiError::NetworkUnavailable),
        ] {
            let data = rerun_error_data(error);
            assert_eq!(data["code"], error.code());
            assert!(data["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()));
            assert!(!data.to_string().contains(secret));
        }
    }

    #[test]
    fn cancel_errors_are_mapped_to_stable_secret_safe_data() {
        let secret = "ghu_cancel-secret-must-not-leak";
        for error in [
            GitHubCiCancelError::InvalidRunId,
            GitHubCiCancelError::RunNotEligible,
            GitHubCiCancelError::PreflightStale,
            GitHubCiCancelError::AlreadySubmitted,
            GitHubCiCancelError::OutcomeUncertain,
            GitHubCiCancelError::AuditUnavailable,
            GitHubCiCancelError::CredentialUnavailable,
            GitHubCiCancelError::CiStatus(GitHubCiError::NetworkUnavailable),
        ] {
            let data = cancel_error_data(error);
            assert_eq!(data["code"], error.code());
            assert!(data["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()));
            assert!(!data.to_string().contains(secret));
        }
    }

    #[test]
    fn workflow_dispatch_errors_are_mapped_to_stable_secret_safe_data() {
        let secret = "ghu_dispatch-secret-must-not-leak";
        for error in [
            GitHubWorkflowDispatchError::InvalidWorkflowId,
            GitHubWorkflowDispatchError::WorkflowNotFound,
            GitHubWorkflowDispatchError::InvalidInputs,
            GitHubWorkflowDispatchError::PreflightStale,
            GitHubWorkflowDispatchError::AlreadySubmitted,
            GitHubWorkflowDispatchError::OutcomeUncertain,
            GitHubWorkflowDispatchError::AuditUnavailable,
            GitHubWorkflowDispatchError::CredentialUnavailable,
            GitHubWorkflowDispatchError::CiStatus(GitHubCiError::NetworkUnavailable),
        ] {
            let data = dispatch_error_data(error);
            assert_eq!(data["code"], error.code());
            assert!(data["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty()));
            assert!(!data.to_string().contains(secret));
        }
    }
}
