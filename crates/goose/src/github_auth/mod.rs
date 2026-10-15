pub(crate) mod artifacts;
pub(crate) mod ci_cancel;
pub(crate) mod ci_rerun;
pub(crate) mod ci_status;
pub(crate) mod credential_store;
pub(crate) mod device_flow;
pub(crate) mod pull_requests;
pub(crate) mod workflow_dispatch;

use self::ci_status::GitHubCiClient;
use self::credential_store::{
    GitHubAuthError, GitHubCredentialStore, StoredGitHubCredentialV1, SystemGitHubCredentialStore,
};
use self::device_flow::{
    GitHubDeviceFlowClient, GitHubDeviceFlowError, TokenPollOutcome, VERIFICATION_URI,
};
use self::pull_requests::GitHubPullRequestClient;
use crate::agents::tool_audit::ToolAuditStore;
use crate::agents::tool_idempotency::ToolIdempotencyStore;
use crate::config::paths::Paths;
use chrono::{DateTime, SecondsFormat, Utc};
use goose_sdk_types::custom_requests::{
    GitHubAuthConnectionState, GitHubAuthPollResponse, GitHubAuthPollState,
    GitHubAuthStartResponse, GitHubAuthStatusResponse,
};
#[cfg(test)]
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use uuid::Uuid;

const SLOW_DOWN_SECONDS: u64 = 5;
const MAX_POLL_INTERVAL_SECONDS: u64 = 60;

pub(crate) trait GitHubAuthClock: Send + Sync {
    fn monotonic_now(&self) -> Instant;
    fn utc_now(&self) -> DateTime<Utc>;
}

struct SystemGitHubAuthClock;

impl GitHubAuthClock for SystemGitHubAuthClock {
    fn monotonic_now(&self) -> Instant {
        Instant::now()
    }

    fn utc_now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubAuthServiceError {
    #[error("GitHub App client ID is not configured")]
    ClientNotConfigured,
    #[error("GitHub login flow was not found")]
    FlowNotFound,
    #[error("GitHub login flow expired")]
    FlowExpired,
    #[error("GitHub authorization was denied")]
    AccessDenied,
    #[error("GitHub credential operation failed")]
    Credential(#[from] GitHubAuthError),
    #[error("GitHub authentication request failed")]
    DeviceFlow(#[from] GitHubDeviceFlowError),
}

impl GitHubAuthServiceError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::ClientNotConfigured => "client_not_configured",
            Self::FlowNotFound => "flow_not_found",
            Self::FlowExpired => "flow_expired",
            Self::AccessDenied => "access_denied",
            Self::Credential(error) => error.code(),
            Self::DeviceFlow(error) => error.code(),
        }
    }
}

#[derive(Clone)]
struct ActiveFlow {
    id: String,
    device_code: String,
    expires_at: Instant,
    interval_seconds: u64,
    next_poll_at: Instant,
}

pub(crate) struct GitHubAuthService {
    client_id: Option<String>,
    client: GitHubDeviceFlowClient,
    credential_store: Arc<dyn GitHubCredentialStore>,
    clock: Arc<dyn GitHubAuthClock>,
    active_flow: Mutex<Option<ActiveFlow>>,
    lifecycle: Mutex<()>,
    pull_request_client: GitHubPullRequestClient,
    pull_request_lifecycle: Mutex<()>,
    ci_client: GitHubCiClient,
    ci_rerun_lifecycle: Mutex<()>,
    ci_rerun_idempotency: Arc<ToolIdempotencyStore>,
    ci_rerun_audit: Arc<ToolAuditStore>,
    #[cfg(test)]
    _ci_test_data: Option<tempfile::TempDir>,
}

impl GitHubAuthService {
    pub(crate) fn production() -> Result<Self, GitHubDeviceFlowError> {
        let client_id =
            crate::config::codebuddy_paths::environment_override("CODEBUDDY_GITHUB_CLIENT_ID")
                .and_then(|value| value.into_string().ok())
                .or_else(|| option_env!("CODEBUDDY_GITHUB_CLIENT_ID").map(str::to_string))
                .or_else(|| option_env!("CODEAGENTPRO_GITHUB_CLIENT_ID").map(str::to_string))
                .and_then(normalize_client_id);
        let pull_request_client = GitHubPullRequestClient::production()
            .map_err(|_| GitHubDeviceFlowError::InvalidResponse)?;
        let ci_client =
            GitHubCiClient::production().map_err(|_| GitHubDeviceFlowError::InvalidResponse)?;
        let data_dir = Paths::data_dir();
        Ok(Self {
            client_id,
            client: GitHubDeviceFlowClient::production()?,
            credential_store: Arc::new(SystemGitHubCredentialStore),
            clock: Arc::new(SystemGitHubAuthClock),
            active_flow: Mutex::new(None),
            lifecycle: Mutex::new(()),
            pull_request_client,
            pull_request_lifecycle: Mutex::new(()),
            ci_client,
            ci_rerun_lifecycle: Mutex::new(()),
            ci_rerun_idempotency: Arc::new(ToolIdempotencyStore::new(
                data_dir.join("github-ci-rerun-idempotency-v1"),
            )),
            ci_rerun_audit: Arc::new(ToolAuditStore::new(data_dir)),
            #[cfg(test)]
            _ci_test_data: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        client_id: Option<String>,
        client: GitHubDeviceFlowClient,
        credential_store: Arc<dyn GitHubCredentialStore>,
        clock: Arc<dyn GitHubAuthClock>,
    ) -> Self {
        let ci_test_data = tempfile::tempdir().expect("CI test data directory must be created");
        let ci_data_dir = ci_test_data.path().to_path_buf();
        Self::for_test_with_ci_storage(
            client_id,
            client,
            credential_store,
            clock,
            ci_data_dir,
            Some(ci_test_data),
        )
    }

    #[cfg(test)]
    pub(crate) fn for_test_with_ci_data_dir(
        client_id: Option<String>,
        client: GitHubDeviceFlowClient,
        credential_store: Arc<dyn GitHubCredentialStore>,
        clock: Arc<dyn GitHubAuthClock>,
        ci_data_dir: PathBuf,
    ) -> Self {
        Self::for_test_with_ci_storage(
            client_id,
            client,
            credential_store,
            clock,
            ci_data_dir,
            None,
        )
    }

    #[cfg(test)]
    fn for_test_with_ci_storage(
        client_id: Option<String>,
        client: GitHubDeviceFlowClient,
        credential_store: Arc<dyn GitHubCredentialStore>,
        clock: Arc<dyn GitHubAuthClock>,
        ci_data_dir: PathBuf,
        ci_test_data: Option<tempfile::TempDir>,
    ) -> Self {
        let pull_request_client = GitHubPullRequestClient::for_test(client.test_base_url())
            .expect("device-flow test base is a valid loopback URL");
        let ci_client = GitHubCiClient::for_test(client.test_base_url())
            .expect("device-flow test base is a valid loopback URL");
        let ci_rerun_idempotency = Arc::new(ToolIdempotencyStore::new(
            ci_data_dir.join("github-ci-rerun-idempotency-v1"),
        ));
        let ci_rerun_audit = Arc::new(ToolAuditStore::new(ci_data_dir));
        Self {
            client_id: client_id.and_then(normalize_client_id),
            client,
            credential_store,
            clock,
            active_flow: Mutex::new(None),
            lifecycle: Mutex::new(()),
            pull_request_client,
            pull_request_lifecycle: Mutex::new(()),
            ci_client,
            ci_rerun_lifecycle: Mutex::new(()),
            ci_rerun_idempotency,
            ci_rerun_audit,
            _ci_test_data: ci_test_data,
        }
    }

    pub(crate) async fn status(&self) -> GitHubAuthStatusResponse {
        let client_configured = self.client_id.is_some();
        match self.load_credential().await {
            Ok(Some(credential)) => {
                let expired = credential
                    .access_token_expires_at
                    .as_deref()
                    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                    .is_some_and(|expires_at| expires_at <= self.clock.utc_now());
                GitHubAuthStatusResponse {
                    client_configured,
                    secure_storage_available: true,
                    state: if expired {
                        GitHubAuthConnectionState::Expired
                    } else {
                        GitHubAuthConnectionState::Connected
                    },
                    account_login: Some(credential.account_login),
                    account_id: Some(credential.account_id),
                    access_token_expires_at: credential.access_token_expires_at,
                }
            }
            Ok(None) => disconnected_status(client_configured, true),
            Err(GitHubAuthError::SecureStorageUnavailable) => {
                disconnected_status(client_configured, false)
            }
            Err(_) => disconnected_status(client_configured, true),
        }
    }

    pub(crate) async fn start(&self) -> Result<GitHubAuthStartResponse, GitHubAuthServiceError> {
        let _lifecycle = self.lifecycle.lock().await;
        let client_id = self
            .client_id
            .as_deref()
            .ok_or(GitHubAuthServiceError::ClientNotConfigured)?;

        self.load_credential().await?;
        let challenge = self.client.request_device_code(client_id).await?;
        let now = self.clock.monotonic_now();
        let utc_now = self.clock.utc_now();
        let flow_id = Uuid::new_v4().to_string();
        let expires_at = now + Duration::from_secs(challenge.expires_in_seconds);
        let next_poll_at = now + Duration::from_secs(challenge.interval_seconds);
        let response = GitHubAuthStartResponse {
            flow_id: flow_id.clone(),
            user_code: challenge.user_code.clone(),
            verification_uri: VERIFICATION_URI.to_string(),
            expires_at: format_utc(
                utc_now + chrono::Duration::seconds(challenge.expires_in_seconds as i64),
            ),
            retry_after_seconds: challenge.interval_seconds,
        };
        *self.active_flow.lock().await = Some(ActiveFlow {
            id: flow_id,
            device_code: challenge.device_code().to_string(),
            expires_at,
            interval_seconds: challenge.interval_seconds,
            next_poll_at,
        });
        Ok(response)
    }

    pub(crate) async fn poll(
        &self,
        flow_id: &str,
    ) -> Result<GitHubAuthPollResponse, GitHubAuthServiceError> {
        let _lifecycle = self.lifecycle.lock().await;
        let now = self.clock.monotonic_now();
        let flow = self
            .active_flow
            .lock()
            .await
            .as_ref()
            .filter(|flow| flow.id == flow_id)
            .cloned()
            .ok_or(GitHubAuthServiceError::FlowNotFound)?;

        if now >= flow.expires_at {
            self.clear_flow().await;
            return Err(GitHubAuthServiceError::FlowExpired);
        }
        if now < flow.next_poll_at {
            return Ok(pending_response(seconds_until(now, flow.next_poll_at)));
        }

        let client_id = self
            .client_id
            .as_deref()
            .ok_or(GitHubAuthServiceError::ClientNotConfigured)?;
        let outcome = match self.client.poll_token(client_id, &flow.device_code).await {
            Ok(outcome) => outcome,
            Err(error @ GitHubDeviceFlowError::NetworkUnavailable) => {
                self.defer_flow(&flow.id, flow.interval_seconds).await;
                return Err(error.into());
            }
            Err(error) => {
                self.clear_flow().await;
                return Err(error.into());
            }
        };

        match outcome {
            TokenPollOutcome::Pending => {
                self.defer_flow(&flow.id, flow.interval_seconds).await;
                Ok(pending_response(flow.interval_seconds))
            }
            TokenPollOutcome::SlowDown(server_interval) => {
                let minimum_interval = flow
                    .interval_seconds
                    .saturating_add(SLOW_DOWN_SECONDS)
                    .min(MAX_POLL_INTERVAL_SECONDS);
                let interval = server_interval
                    .unwrap_or(minimum_interval)
                    .max(minimum_interval)
                    .min(MAX_POLL_INTERVAL_SECONDS);
                self.defer_flow_with_interval(&flow.id, interval).await;
                Ok(pending_response(interval))
            }
            TokenPollOutcome::Denied => {
                self.clear_flow().await;
                Err(GitHubAuthServiceError::AccessDenied)
            }
            TokenPollOutcome::Expired => {
                self.clear_flow().await;
                Err(GitHubAuthServiceError::FlowExpired)
            }
            TokenPollOutcome::Issued(tokens) => {
                self.clear_flow().await;
                let user = self.client.verify_user(tokens.access_token()).await?;
                let (access_token, refresh_token, access_lifetime, refresh_lifetime) =
                    tokens.into_parts();
                let utc_now = self.clock.utc_now();
                let access_token_expires_at =
                    access_lifetime.map(|seconds| format_utc(utc_now + duration(seconds)));
                let refresh_token_expires_at =
                    refresh_lifetime.map(|seconds| format_utc(utc_now + duration(seconds)));
                let credential = StoredGitHubCredentialV1 {
                    schema_version: 1,
                    account_login: user.login.clone(),
                    account_id: user.id,
                    access_token,
                    refresh_token,
                    access_token_expires_at: access_token_expires_at.clone(),
                    refresh_token_expires_at,
                };
                self.save_credential(credential).await?;
                Ok(GitHubAuthPollResponse {
                    state: GitHubAuthPollState::Connected,
                    retry_after_seconds: None,
                    account_login: Some(user.login),
                    account_id: Some(user.id),
                    access_token_expires_at,
                })
            }
        }
    }

    pub(crate) async fn cancel(&self, flow_id: &str) -> Result<(), GitHubAuthServiceError> {
        let _lifecycle = self.lifecycle.lock().await;
        let mut active = self.active_flow.lock().await;
        if active.as_ref().is_none_or(|flow| flow.id != flow_id) {
            return Err(GitHubAuthServiceError::FlowNotFound);
        }
        *active = None;
        Ok(())
    }

    pub(crate) async fn disconnect(&self) -> Result<(), GitHubAuthServiceError> {
        let _lifecycle = self.lifecycle.lock().await;
        self.clear_flow().await;
        let store = Arc::clone(&self.credential_store);
        tokio::task::spawn_blocking(move || store.delete())
            .await
            .map_err(|_| GitHubAuthError::SecureStorageUnavailable)??;
        Ok(())
    }

    async fn load_credential(&self) -> Result<Option<StoredGitHubCredentialV1>, GitHubAuthError> {
        let store = Arc::clone(&self.credential_store);
        tokio::task::spawn_blocking(move || store.load())
            .await
            .map_err(|_| GitHubAuthError::SecureStorageUnavailable)?
    }

    async fn save_credential(
        &self,
        credential: StoredGitHubCredentialV1,
    ) -> Result<(), GitHubAuthError> {
        let store = Arc::clone(&self.credential_store);
        tokio::task::spawn_blocking(move || store.save(&credential))
            .await
            .map_err(|_| GitHubAuthError::SecureStorageUnavailable)?
    }

    async fn clear_flow(&self) {
        *self.active_flow.lock().await = None;
    }

    async fn defer_flow(&self, flow_id: &str, seconds: u64) {
        let mut active = self.active_flow.lock().await;
        if let Some(flow) = active.as_mut().filter(|flow| flow.id == flow_id) {
            flow.next_poll_at = self.clock.monotonic_now() + Duration::from_secs(seconds);
        }
    }

    async fn defer_flow_with_interval(&self, flow_id: &str, seconds: u64) {
        let mut active = self.active_flow.lock().await;
        if let Some(flow) = active.as_mut().filter(|flow| flow.id == flow_id) {
            flow.interval_seconds = seconds;
            flow.next_poll_at = self.clock.monotonic_now() + Duration::from_secs(seconds);
        }
    }
}

fn normalize_client_id(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 256
        && value.is_ascii()
        && !value.chars().any(char::is_whitespace))
    .then(|| value.to_string())
}

fn disconnected_status(
    client_configured: bool,
    secure_storage_available: bool,
) -> GitHubAuthStatusResponse {
    GitHubAuthStatusResponse {
        client_configured,
        secure_storage_available,
        state: GitHubAuthConnectionState::Disconnected,
        account_login: None,
        account_id: None,
        access_token_expires_at: None,
    }
}

fn pending_response(retry_after_seconds: u64) -> GitHubAuthPollResponse {
    GitHubAuthPollResponse {
        state: GitHubAuthPollState::Pending,
        retry_after_seconds: Some(retry_after_seconds),
        account_login: None,
        account_id: None,
        access_token_expires_at: None,
    }
}

fn seconds_until(now: Instant, deadline: Instant) -> u64 {
    let remaining = deadline.duration_since(now);
    remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0)
}

fn duration(seconds: u64) -> chrono::Duration {
    chrono::Duration::seconds(seconds as i64)
}

fn format_utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github_auth::credential_store::{
        GitHubAuthError, GitHubCredentialStore, StoredGitHubCredentialV1,
    };
    use crate::github_auth::device_flow::GitHubDeviceFlowClient;
    use chrono::{DateTime, Utc};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const CLIENT_ID: &str = "Iv1.codebuddy-test";
    const DEVICE_CODE: &str = "device-secret-must-not-leak";
    const ACCESS_TOKEN: &str = "ghu_access-secret-must-not-leak";
    const REFRESH_TOKEN: &str = "ghr_refresh-secret-must-not-leak";

    #[derive(Default)]
    struct TestStore {
        credential: Mutex<Option<StoredGitHubCredentialV1>>,
        fail_save: std::sync::atomic::AtomicBool,
    }

    impl GitHubCredentialStore for TestStore {
        fn load(&self) -> Result<Option<StoredGitHubCredentialV1>, GitHubAuthError> {
            Ok(self.credential.lock().unwrap().clone())
        }

        fn save(&self, credential: &StoredGitHubCredentialV1) -> Result<(), GitHubAuthError> {
            if self.fail_save.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(GitHubAuthError::SecureStorageUnavailable);
            }
            *self.credential.lock().unwrap() = Some(credential.clone());
            Ok(())
        }

        fn delete(&self) -> Result<(), GitHubAuthError> {
            *self.credential.lock().unwrap() = None;
            Ok(())
        }
    }

    struct TestClock {
        instant: Mutex<Instant>,
        utc: Mutex<DateTime<Utc>>,
    }

    impl TestClock {
        fn new() -> Self {
            Self {
                instant: Mutex::new(Instant::now()),
                utc: Mutex::new(
                    DateTime::parse_from_rfc3339("2026-08-04T16:00:00Z")
                        .unwrap()
                        .to_utc(),
                ),
            }
        }

        fn advance(&self, seconds: u64) {
            *self.instant.lock().unwrap() += Duration::from_secs(seconds);
            *self.utc.lock().unwrap() += chrono::Duration::seconds(seconds as i64);
        }
    }

    impl GitHubAuthClock for TestClock {
        fn monotonic_now(&self) -> Instant {
            *self.instant.lock().unwrap()
        }

        fn utc_now(&self) -> DateTime<Utc> {
            *self.utc.lock().unwrap()
        }
    }

    async fn setup() -> (
        MockServer,
        Arc<TestStore>,
        Arc<TestClock>,
        GitHubAuthService,
    ) {
        let server = MockServer::start().await;
        let store = Arc::new(TestStore::default());
        let clock = Arc::new(TestClock::new());
        let client = GitHubDeviceFlowClient::for_test(&server.uri()).unwrap();
        let service = GitHubAuthService::for_test(
            Some(CLIENT_ID.to_string()),
            client,
            store.clone(),
            clock.clone(),
        );
        (server, store, clock, service)
    }

    async fn mount_challenge(server: &MockServer, expires_in: u64, interval: u64) {
        mount_challenges(server, expires_in, interval, 1).await;
    }

    async fn mount_challenges(
        server: &MockServer,
        expires_in: u64,
        interval: u64,
        expected_requests: u64,
    ) {
        Mock::given(method("POST"))
            .and(path("/login/device/code"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "device_code": DEVICE_CODE,
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device",
                "expires_in": expires_in,
                "interval": interval
            })))
            .expect(expected_requests)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn missing_client_id_and_early_poll_never_contact_token_endpoint() {
        let (server, store, clock, _) = setup().await;
        let missing = GitHubAuthService::for_test(
            None,
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            store,
            clock,
        );
        assert_eq!(
            missing.start().await.unwrap_err().code(),
            "client_not_configured"
        );
        assert!(server.received_requests().await.unwrap().is_empty());

        let server = MockServer::start().await;
        let service = GitHubAuthService::for_test(
            Some(CLIENT_ID.to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            Arc::new(TestStore::default()),
            Arc::new(TestClock::new()),
        );
        mount_challenge(&server, 900, 5).await;
        let started = service.start().await.unwrap();
        let pending = service.poll(&started.flow_id).await.unwrap();
        assert_eq!(pending.retry_after_seconds, Some(5));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn slow_down_adds_five_seconds_and_local_expiry_never_polls() {
        let (server, _, clock, service) = setup().await;
        mount_challenge(&server, 900, 5).await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "slow_down",
                "interval": 12
            })))
            .expect(1)
            .mount(&server)
            .await;
        let started = service.start().await.unwrap();
        clock.advance(5);
        let pending = service.poll(&started.flow_id).await.unwrap();
        assert_eq!(pending.retry_after_seconds, Some(12));
        let pending = service.poll(&started.flow_id).await.unwrap();
        assert_eq!(pending.retry_after_seconds, Some(12));
        assert_eq!(server.received_requests().await.unwrap().len(), 2);

        let (server, _, clock, service) = setup().await;
        mount_challenge(&server, 1, 1).await;
        let started = service.start().await.unwrap();
        clock.advance(2);
        assert_eq!(
            service.poll(&started.flow_id).await.unwrap_err().code(),
            "flow_expired"
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn issued_token_verifies_identity_then_saves_and_public_response_is_secret_free() {
        let (server, store, clock, service) = setup().await;
        mount_challenge(&server, 900, 1).await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": ACCESS_TOKEN,
                "refresh_token": REFRESH_TOKEN,
                "token_type": "bearer",
                "expires_in": 28800,
                "refresh_token_expires_in": 15811200
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "login": "octocat",
                "id": 1
            })))
            .expect(1)
            .mount(&server)
            .await;

        let started = service.start().await.unwrap();
        clock.advance(1);
        let connected = service.poll(&started.flow_id).await.unwrap();
        assert_eq!(connected.account_login.as_deref(), Some("octocat"));
        let serialized = serde_json::to_string(&connected).unwrap();
        assert!(!serialized.contains(ACCESS_TOKEN));
        assert!(!serialized.contains(REFRESH_TOKEN));
        assert!(!serialized.contains(DEVICE_CODE));
        assert_eq!(
            store
                .credential
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .account_id,
            1
        );
        assert_eq!(
            service.poll(&started.flow_id).await.unwrap_err().code(),
            "flow_not_found"
        );
    }

    #[tokio::test]
    async fn storage_failure_and_denial_are_terminal_and_never_report_connected() {
        let (server, store, clock, service) = setup().await;
        store
            .fail_save
            .store(true, std::sync::atomic::Ordering::SeqCst);
        mount_challenge(&server, 900, 1).await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": ACCESS_TOKEN,
                "token_type": "bearer"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "login": "octocat",
                "id": 1
            })))
            .mount(&server)
            .await;
        let started = service.start().await.unwrap();
        clock.advance(1);
        assert_eq!(
            service.poll(&started.flow_id).await.unwrap_err().code(),
            "secure_storage_unavailable"
        );
        assert_eq!(
            service.poll(&started.flow_id).await.unwrap_err().code(),
            "flow_not_found"
        );

        let (server, _, clock, service) = setup().await;
        mount_challenge(&server, 900, 1).await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({ "error": "access_denied" })),
            )
            .mount(&server)
            .await;
        let started = service.start().await.unwrap();
        clock.advance(1);
        assert_eq!(
            service.poll(&started.flow_id).await.unwrap_err().code(),
            "access_denied"
        );
        assert_eq!(
            service.poll(&started.flow_id).await.unwrap_err().code(),
            "flow_not_found"
        );
    }

    #[tokio::test]
    async fn status_cancel_and_disconnect_expose_only_safe_lifecycle_state() {
        let (server, store, _, service) = setup().await;
        let status = service.status().await;
        assert!(status.client_configured);
        assert!(status.secure_storage_available);
        assert_eq!(status.state, GitHubAuthConnectionState::Disconnected);

        *store.credential.lock().unwrap() = Some(StoredGitHubCredentialV1 {
            schema_version: 1,
            account_login: "octocat".to_string(),
            account_id: 1,
            access_token: ACCESS_TOKEN.to_string(),
            refresh_token: Some(REFRESH_TOKEN.to_string()),
            access_token_expires_at: Some("2026-08-04T15:59:59Z".to_string()),
            refresh_token_expires_at: None,
        });
        let status = service.status().await;
        assert_eq!(status.state, GitHubAuthConnectionState::Expired);
        assert_eq!(status.account_login.as_deref(), Some("octocat"));
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(ACCESS_TOKEN));
        assert!(!serialized.contains(REFRESH_TOKEN));

        mount_challenges(&server, 900, 5, 3).await;
        let first = service.start().await.unwrap();
        let second = service.start().await.unwrap();
        assert_eq!(
            service.cancel(&first.flow_id).await.unwrap_err().code(),
            "flow_not_found"
        );
        service.cancel(&second.flow_id).await.unwrap();
        assert_eq!(
            service.cancel(&second.flow_id).await.unwrap_err().code(),
            "flow_not_found"
        );

        let active = service.start().await.unwrap();
        service.disconnect().await.unwrap();
        service.disconnect().await.unwrap();
        assert!(store.credential.lock().unwrap().is_none());
        assert_eq!(
            service.poll(&active.flow_id).await.unwrap_err().code(),
            "flow_not_found"
        );
        assert_eq!(
            service.status().await.state,
            GitHubAuthConnectionState::Disconnected
        );

        let unavailable = GitHubAuthService::for_test(
            Some(CLIENT_ID.to_string()),
            GitHubDeviceFlowClient::for_test(&server.uri()).unwrap(),
            Arc::new(credential_store::UnavailableGitHubCredentialStore),
            Arc::new(TestClock::new()),
        );
        let status = unavailable.status().await;
        assert!(!status.secure_storage_available);
        assert_eq!(status.state, GitHubAuthConnectionState::Disconnected);
    }
}
