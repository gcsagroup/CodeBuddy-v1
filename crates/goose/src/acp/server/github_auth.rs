use super::*;
use crate::github_auth::GitHubAuthServiceError;

fn service_error(error: GitHubAuthServiceError) -> agent_client_protocol::Error {
    let data = serde_json::json!({
        "code": error.code(),
        "message": error.to_string(),
    });
    match error {
        GitHubAuthServiceError::ClientNotConfigured
        | GitHubAuthServiceError::FlowNotFound
        | GitHubAuthServiceError::FlowExpired
        | GitHubAuthServiceError::AccessDenied => {
            agent_client_protocol::Error::invalid_params().data(data)
        }
        GitHubAuthServiceError::Credential(_) | GitHubAuthServiceError::DeviceFlow(_) => {
            agent_client_protocol::Error::internal_error().data(data)
        }
    }
}

async fn github_auth_status(
    service: &crate::github_auth::GitHubAuthService,
    _req: GitHubAuthStatusRequest,
) -> Result<GitHubAuthStatusResponse, agent_client_protocol::Error> {
    Ok(service.status().await)
}

async fn github_auth_start(
    service: &crate::github_auth::GitHubAuthService,
    _req: GitHubAuthStartRequest,
) -> Result<GitHubAuthStartResponse, agent_client_protocol::Error> {
    service.start().await.map_err(service_error)
}

async fn github_auth_poll(
    service: &crate::github_auth::GitHubAuthService,
    req: GitHubAuthPollRequest,
) -> Result<GitHubAuthPollResponse, agent_client_protocol::Error> {
    service.poll(&req.flow_id).await.map_err(service_error)
}

async fn github_auth_cancel(
    service: &crate::github_auth::GitHubAuthService,
    req: GitHubAuthCancelRequest,
) -> Result<EmptyResponse, agent_client_protocol::Error> {
    service.cancel(&req.flow_id).await.map_err(service_error)?;
    Ok(EmptyResponse {})
}

async fn github_auth_disconnect(
    service: &crate::github_auth::GitHubAuthService,
    _req: GitHubAuthDisconnectRequest,
) -> Result<EmptyResponse, agent_client_protocol::Error> {
    service.disconnect().await.map_err(service_error)?;
    Ok(EmptyResponse {})
}

impl GooseAcpAgent {
    pub(super) async fn on_github_auth_status(
        &self,
        _req: GitHubAuthStatusRequest,
    ) -> Result<GitHubAuthStatusResponse, agent_client_protocol::Error> {
        github_auth_status(&self.github_auth, _req).await
    }

    pub(super) async fn on_github_auth_start(
        &self,
        _req: GitHubAuthStartRequest,
    ) -> Result<GitHubAuthStartResponse, agent_client_protocol::Error> {
        github_auth_start(&self.github_auth, _req).await
    }

    pub(super) async fn on_github_auth_poll(
        &self,
        req: GitHubAuthPollRequest,
    ) -> Result<GitHubAuthPollResponse, agent_client_protocol::Error> {
        github_auth_poll(&self.github_auth, req).await
    }

    pub(super) async fn on_github_auth_cancel(
        &self,
        req: GitHubAuthCancelRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        github_auth_cancel(&self.github_auth, req).await
    }

    pub(super) async fn on_github_auth_disconnect(
        &self,
        _req: GitHubAuthDisconnectRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        github_auth_disconnect(&self.github_auth, _req).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github_auth::credential_store::MemoryGitHubCredentialStore;
    use crate::github_auth::device_flow::GitHubDeviceFlowClient;
    use crate::github_auth::{GitHubAuthClock, GitHubAuthService};
    use chrono::{DateTime, Utc};
    use std::sync::Arc;
    use std::time::Instant;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct FixedClock;

    impl GitHubAuthClock for FixedClock {
        fn monotonic_now(&self) -> Instant {
            Instant::now()
        }

        fn utc_now(&self) -> DateTime<Utc> {
            DateTime::parse_from_rfc3339("2026-08-05T00:00:00Z")
                .unwrap()
                .to_utc()
        }
    }

    #[test]
    fn service_errors_have_stable_codes_and_no_secret_text() {
        for error in [
            GitHubAuthServiceError::ClientNotConfigured,
            GitHubAuthServiceError::FlowNotFound,
            GitHubAuthServiceError::FlowExpired,
            GitHubAuthServiceError::AccessDenied,
        ] {
            let rendered = format!("{:?}", service_error(error));
            assert!(rendered.contains(error.code()));
            assert!(!rendered.contains("access_token"));
            assert!(!rendered.contains("device_code"));
            assert!(!rendered.contains("secrets.yaml"));
        }
    }

    #[tokio::test]
    async fn all_five_host_handlers_delegate_to_the_injected_service() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/device/code"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "device_code": "device-secret-not-public",
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 5
            })))
            .expect(1)
            .mount(&server)
            .await;
        let service = GitHubAuthService::for_test(
            Some("Iv1.codebuddy-test".to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            Arc::new(MemoryGitHubCredentialStore::default()),
            Arc::new(FixedClock),
        );

        let status = github_auth_status(&service, GitHubAuthStatusRequest::default())
            .await
            .unwrap();
        assert!(status.client_configured);
        assert!(status.secure_storage_available);

        let started = github_auth_start(&service, GitHubAuthStartRequest::default())
            .await
            .unwrap();
        let pending = github_auth_poll(
            &service,
            GitHubAuthPollRequest {
                flow_id: started.flow_id.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(pending.state, GitHubAuthPollState::Pending);

        github_auth_cancel(
            &service,
            GitHubAuthCancelRequest {
                flow_id: started.flow_id.clone(),
            },
        )
        .await
        .unwrap();
        let stale = github_auth_poll(
            &service,
            GitHubAuthPollRequest {
                flow_id: started.flow_id,
            },
        )
        .await
        .unwrap_err();
        assert!(format!("{stale:?}").contains("flow_not_found"));

        github_auth_disconnect(&service, GitHubAuthDisconnectRequest::default())
            .await
            .unwrap();
    }
}
