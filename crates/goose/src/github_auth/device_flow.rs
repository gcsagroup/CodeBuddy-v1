use futures::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;
#[cfg(test)]
use url::Url;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
pub(crate) const VERIFICATION_URI: &str = "https://github.com/login/device";
pub(crate) const MAX_RESPONSE_BYTES: usize = 32 * 1024;
const MAX_DEVICE_LIFETIME_SECONDS: u64 = 15 * 60;
const MAX_POLL_INTERVAL_SECONDS: u64 = 60;
const MAX_TOKEN_LIFETIME_SECONDS: u64 = 366 * 24 * 60 * 60;
const USER_AGENT: &str = "CodeBuddy-GitHub-Auth/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GitHubDeviceFlowError {
    #[error("GitHub authentication network request failed")]
    NetworkUnavailable,
    #[error("GitHub returned an invalid authentication response")]
    InvalidResponse,
    #[error("GitHub authentication response exceeded the size limit")]
    ResponseTooLarge,
    #[cfg(test)]
    #[error("GitHub authentication test endpoint must be loopback")]
    InvalidTestEndpoint,
}

impl GitHubDeviceFlowError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::NetworkUnavailable => "network_unavailable",
            Self::InvalidResponse => "invalid_response",
            Self::ResponseTooLarge => "response_too_large",
            #[cfg(test)]
            Self::InvalidTestEndpoint => "invalid_test_endpoint",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DeviceChallenge {
    device_code: String,
    pub(crate) user_code: String,
    pub(crate) verification_uri: String,
    pub(crate) expires_in_seconds: u64,
    pub(crate) interval_seconds: u64,
}

impl DeviceChallenge {
    pub(crate) fn device_code(&self) -> &str {
        &self.device_code
    }
}

impl fmt::Debug for DeviceChallenge {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceChallenge")
            .field("device_code", &"<redacted>")
            .field("user_code", &self.user_code)
            .field("verification_uri", &self.verification_uri)
            .field("expires_in_seconds", &self.expires_in_seconds)
            .field("interval_seconds", &self.interval_seconds)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct GitHubDeviceTokens {
    access_token: String,
    pub(crate) refresh_token: Option<String>,
    pub(crate) access_token_expires_in_seconds: Option<u64>,
    pub(crate) refresh_token_expires_in_seconds: Option<u64>,
}

impl GitHubDeviceTokens {
    pub(crate) fn access_token(&self) -> &str {
        &self.access_token
    }

    pub(crate) fn into_parts(self) -> (String, Option<String>, Option<u64>, Option<u64>) {
        (
            self.access_token,
            self.refresh_token,
            self.access_token_expires_in_seconds,
            self.refresh_token_expires_in_seconds,
        )
    }
}

impl fmt::Debug for GitHubDeviceTokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitHubDeviceTokens")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "access_token_expires_in_seconds",
                &self.access_token_expires_in_seconds,
            )
            .field(
                "refresh_token_expires_in_seconds",
                &self.refresh_token_expires_in_seconds,
            )
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TokenPollOutcome {
    Pending,
    SlowDown(Option<u64>),
    Denied,
    Expired,
    Issued(GitHubDeviceTokens),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedGitHubUser {
    pub(crate) login: String,
    pub(crate) id: u64,
}

#[derive(Clone)]
pub(crate) struct GitHubDeviceFlowClient {
    client: reqwest::Client,
    device_code_url: String,
    access_token_url: String,
    user_url: String,
}

impl fmt::Debug for GitHubDeviceFlowClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitHubDeviceFlowClient")
            .field("device_code_url", &self.device_code_url)
            .field("access_token_url", &self.access_token_url)
            .field("user_url", &self.user_url)
            .finish_non_exhaustive()
    }
}

impl GitHubDeviceFlowClient {
    pub(crate) fn production() -> Result<Self, GitHubDeviceFlowError> {
        let client = Self::client_builder()
            .https_only(true)
            .build()
            .map_err(|_| GitHubDeviceFlowError::NetworkUnavailable)?;
        Ok(Self {
            client,
            device_code_url: DEVICE_CODE_URL.to_string(),
            access_token_url: ACCESS_TOKEN_URL.to_string(),
            user_url: USER_URL.to_string(),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(base_url: &str) -> Result<Self, GitHubDeviceFlowError> {
        let base = Url::parse(base_url).map_err(|_| GitHubDeviceFlowError::InvalidTestEndpoint)?;
        let loopback = base.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
        if !loopback || !matches!(base.scheme(), "http" | "https") {
            return Err(GitHubDeviceFlowError::InvalidTestEndpoint);
        }
        let root = base_url.trim_end_matches('/');
        let client = Self::client_builder()
            .build()
            .map_err(|_| GitHubDeviceFlowError::NetworkUnavailable)?;
        Ok(Self {
            client,
            device_code_url: format!("{root}/login/device/code"),
            access_token_url: format!("{root}/login/oauth/access_token"),
            user_url: format!("{root}/user"),
        })
    }

    fn client_builder() -> reqwest::ClientBuilder {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
    }

    #[cfg(test)]
    pub(crate) fn device_code_url(&self) -> &str {
        &self.device_code_url
    }

    #[cfg(test)]
    pub(crate) fn test_base_url(&self) -> &str {
        self.device_code_url
            .strip_suffix("/login/device/code")
            .expect("test device-code URL has the fixed suffix")
    }

    #[cfg(test)]
    pub(crate) fn access_token_url(&self) -> &str {
        &self.access_token_url
    }

    #[cfg(test)]
    pub(crate) fn user_url(&self) -> &str {
        &self.user_url
    }

    pub(crate) async fn request_device_code(
        &self,
        client_id: &str,
    ) -> Result<DeviceChallenge, GitHubDeviceFlowError> {
        validate_client_id(client_id)?;
        #[derive(Serialize)]
        struct Request<'a> {
            client_id: &'a str,
        }
        let response = self
            .client
            .post(&self.device_code_url)
            .header(ACCEPT, "application/json")
            .form(&Request { client_id })
            .send()
            .await
            .map_err(|_| GitHubDeviceFlowError::NetworkUnavailable)?;
        if !response.status().is_success() {
            return Err(GitHubDeviceFlowError::InvalidResponse);
        }
        let body: DeviceCodeResponse = read_json(response).await?;
        if !valid_secret(&body.device_code)
            || !valid_user_code(&body.user_code)
            || body.verification_uri != VERIFICATION_URI
            || !(1..=MAX_DEVICE_LIFETIME_SECONDS).contains(&body.expires_in)
            || !(1..=MAX_POLL_INTERVAL_SECONDS).contains(&body.interval)
        {
            return Err(GitHubDeviceFlowError::InvalidResponse);
        }
        Ok(DeviceChallenge {
            device_code: body.device_code,
            user_code: body.user_code,
            verification_uri: body.verification_uri,
            expires_in_seconds: body.expires_in,
            interval_seconds: body.interval,
        })
    }

    pub(crate) async fn poll_token(
        &self,
        client_id: &str,
        device_code: &str,
    ) -> Result<TokenPollOutcome, GitHubDeviceFlowError> {
        validate_client_id(client_id)?;
        if !valid_secret(device_code) {
            return Err(GitHubDeviceFlowError::InvalidResponse);
        }
        #[derive(Serialize)]
        struct Request<'a> {
            client_id: &'a str,
            device_code: &'a str,
            grant_type: &'static str,
        }
        let response = self
            .client
            .post(&self.access_token_url)
            .header(ACCEPT, "application/json")
            .form(&Request {
                client_id,
                device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            })
            .send()
            .await
            .map_err(|_| GitHubDeviceFlowError::NetworkUnavailable)?;
        let status = response.status();
        let body: TokenResponse = read_json(response).await?;

        if let Some(error) = body.error.as_deref() {
            return match error {
                "authorization_pending" => Ok(TokenPollOutcome::Pending),
                "slow_down" => {
                    if body.interval.is_some_and(|interval| {
                        !(1..=MAX_POLL_INTERVAL_SECONDS).contains(&interval)
                    }) {
                        return Err(GitHubDeviceFlowError::InvalidResponse);
                    }
                    Ok(TokenPollOutcome::SlowDown(body.interval))
                }
                "access_denied" => Ok(TokenPollOutcome::Denied),
                "expired_token" => Ok(TokenPollOutcome::Expired),
                _ => Err(GitHubDeviceFlowError::InvalidResponse),
            };
        }
        if !status.is_success()
            || body.token_type.as_deref() != Some("bearer")
            || body
                .access_token
                .as_deref()
                .is_none_or(|token| !valid_secret(token))
            || body
                .refresh_token
                .as_deref()
                .is_some_and(|token| !valid_secret(token))
            || !valid_lifetime(body.expires_in)
            || !valid_lifetime(body.refresh_token_expires_in)
        {
            return Err(GitHubDeviceFlowError::InvalidResponse);
        }
        Ok(TokenPollOutcome::Issued(GitHubDeviceTokens {
            access_token: body.access_token.expect("validated access token"),
            refresh_token: body.refresh_token,
            access_token_expires_in_seconds: body.expires_in,
            refresh_token_expires_in_seconds: body.refresh_token_expires_in,
        }))
    }

    pub(crate) async fn verify_user(
        &self,
        access_token: &str,
    ) -> Result<VerifiedGitHubUser, GitHubDeviceFlowError> {
        if !valid_secret(access_token) {
            return Err(GitHubDeviceFlowError::InvalidResponse);
        }
        let response = self
            .client
            .get(&self.user_url)
            .header(ACCEPT, "application/vnd.github+json")
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .header("X-GitHub-Api-Version", "2026-03-10")
            .send()
            .await
            .map_err(|_| GitHubDeviceFlowError::NetworkUnavailable)?;
        if !response.status().is_success() {
            return Err(GitHubDeviceFlowError::InvalidResponse);
        }
        let user: UserResponse = read_json(response).await?;
        if user.id == 0
            || user.login.is_empty()
            || user.login.len() > 128
            || user.login.chars().any(char::is_control)
        {
            return Err(GitHubDeviceFlowError::InvalidResponse);
        }
        Ok(VerifiedGitHubUser {
            login: user.login,
            id: user.id,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token_expires_in: Option<u64>,
    #[serde(default)]
    #[serde(rename = "scope")]
    _scope: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    #[serde(rename = "error_description")]
    _error_description: Option<String>,
    #[serde(default)]
    #[serde(rename = "error_uri")]
    _error_uri: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserResponse {
    login: String,
    id: u64,
}

fn validate_client_id(client_id: &str) -> Result<(), GitHubDeviceFlowError> {
    if client_id.is_empty()
        || client_id.len() > 256
        || !client_id.is_ascii()
        || client_id.chars().any(char::is_whitespace)
    {
        return Err(GitHubDeviceFlowError::InvalidResponse);
    }
    Ok(())
}

fn valid_secret(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control)
}

fn valid_user_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn valid_lifetime(value: Option<u64>) -> bool {
    value.is_none_or(|seconds| (1..=MAX_TOKEN_LIFETIME_SECONDS).contains(&seconds))
}

async fn read_json<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, GitHubDeviceFlowError> {
    if response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|value| !value.to_ascii_lowercase().starts_with("application/json"))
    {
        return Err(GitHubDeviceFlowError::InvalidResponse);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(GitHubDeviceFlowError::ResponseTooLarge);
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| GitHubDeviceFlowError::NetworkUnavailable)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(GitHubDeviceFlowError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| GitHubDeviceFlowError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const CLIENT_ID: &str = "Iv1.codebuddy-test";
    const DEVICE_CODE: &str = "device-secret-must-not-leak";
    const ACCESS_TOKEN: &str = "ghu_access-secret-must-not-leak";
    const REFRESH_TOKEN: &str = "ghr_refresh-secret-must-not-leak";

    async fn test_client() -> (MockServer, GitHubDeviceFlowClient) {
        let server = MockServer::start().await;
        let client = GitHubDeviceFlowClient::for_test(&server.uri()).unwrap();
        (server, client)
    }

    #[test]
    fn production_endpoints_are_fixed_and_test_endpoints_require_loopback() {
        let client = GitHubDeviceFlowClient::production().unwrap();
        assert_eq!(
            client.device_code_url(),
            "https://github.com/login/device/code"
        );
        assert_eq!(
            client.access_token_url(),
            "https://github.com/login/oauth/access_token"
        );
        assert_eq!(client.user_url(), "https://api.github.com/user");

        let error = GitHubDeviceFlowClient::for_test("https://example.com").unwrap_err();
        assert_eq!(error.code(), "invalid_test_endpoint");
    }

    #[tokio::test]
    async fn requests_device_code_with_bounded_strict_response() {
        let (server, client) = test_client().await;
        Mock::given(method("POST"))
            .and(path("/login/device/code"))
            .and(header("accept", "application/json"))
            .and(body_string_contains("client_id=Iv1.codebuddy-test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "device_code": DEVICE_CODE,
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 5
            })))
            .expect(1)
            .mount(&server)
            .await;

        let challenge = client.request_device_code(CLIENT_ID).await.unwrap();
        assert_eq!(challenge.user_code, "ABCD-EFGH");
        assert_eq!(
            challenge.verification_uri,
            "https://github.com/login/device"
        );
        assert_eq!(challenge.expires_in_seconds, 900);
        assert_eq!(challenge.interval_seconds, 5);
        assert!(!format!("{challenge:?}").contains(DEVICE_CODE));
    }

    #[tokio::test]
    async fn token_poll_distinguishes_pending_slow_down_and_denial() {
        for (body, expected) in [
            ("authorization_pending", TokenPollOutcome::Pending),
            ("slow_down", TokenPollOutcome::SlowDown(None)),
            ("access_denied", TokenPollOutcome::Denied),
            ("expired_token", TokenPollOutcome::Expired),
        ] {
            let (server, client) = test_client().await;
            Mock::given(method("POST"))
                .and(path("/login/oauth/access_token"))
                .and(body_string_contains("client_id=Iv1.codebuddy-test"))
                .and(body_string_contains(
                    "device_code=device-secret-must-not-leak",
                ))
                .respond_with(
                    ResponseTemplate::new(400).set_body_json(serde_json::json!({ "error": body })),
                )
                .expect(1)
                .mount(&server)
                .await;

            assert_eq!(
                client.poll_token(CLIENT_ID, DEVICE_CODE).await.unwrap(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn token_poll_accepts_documented_error_metadata() {
        let (server, client) = test_client().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "authorization_pending",
                "error_description": "The authorization request is still pending.",
                "error_uri": "https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps"
            })))
            .expect(1)
            .mount(&server)
            .await;

        assert_eq!(
            client.poll_token(CLIENT_ID, DEVICE_CODE).await.unwrap(),
            TokenPollOutcome::Pending
        );
    }

    #[tokio::test]
    async fn issued_token_is_redacted_and_identity_is_verified_before_storage() {
        let (server, client) = test_client().await;
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
            .and(header("authorization", format!("Bearer {ACCESS_TOKEN}")))
            .and(header("x-github-api-version", "2026-03-10"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "login": "octocat",
                "id": 1
            })))
            .expect(1)
            .mount(&server)
            .await;

        let TokenPollOutcome::Issued(tokens) =
            client.poll_token(CLIENT_ID, DEVICE_CODE).await.unwrap()
        else {
            panic!("expected issued token");
        };
        let token_debug = format!("{tokens:?}");
        assert!(!token_debug.contains(ACCESS_TOKEN));
        assert!(!token_debug.contains(REFRESH_TOKEN));

        let user = client.verify_user(tokens.access_token()).await.unwrap();
        assert_eq!(user.login, "octocat");
        assert_eq!(user.id, 1);
    }

    #[tokio::test]
    async fn malformed_wrong_uri_and_oversized_responses_fail_without_body_echo() {
        for body in [
            serde_json::json!({
                "device_code": DEVICE_CODE,
                "user_code": "ABCD-EFGH",
                "verification_uri": "https://evil.example/device",
                "expires_in": 900,
                "interval": 5
            })
            .to_string(),
            "not-json-secret-body".to_string(),
            "x".repeat(MAX_RESPONSE_BYTES + 1),
        ] {
            let (server, client) = test_client().await;
            Mock::given(method("POST"))
                .and(path("/login/device/code"))
                .respond_with(ResponseTemplate::new(200).set_body_string(body.clone()))
                .expect(1)
                .mount(&server)
                .await;

            let error = client.request_device_code(CLIENT_ID).await.unwrap_err();
            assert!(matches!(
                error.code(),
                "invalid_response" | "response_too_large"
            ));
            assert!(!error.to_string().contains(&body));
            assert!(!error.to_string().contains(DEVICE_CODE));
        }
    }
}
