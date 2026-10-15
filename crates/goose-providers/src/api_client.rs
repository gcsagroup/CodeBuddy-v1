use crate::errors::ProviderError;
use anyhow::Result;
use async_trait::async_trait;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Response, StatusCode,
};
#[cfg(any(feature = "rustls-tls", feature = "native-tls"))]
use reqwest::{Certificate, Identity};
use serde_json::Value;
use std::fmt;
#[cfg(any(feature = "rustls-tls", feature = "native-tls"))]
use std::fs::read_to_string;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_PROVIDER_TIMEOUT_SECS: u64 = 600;

pub type RequestBuilderDecorator =
    Arc<dyn Fn(reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder> + Send + Sync>;

pub struct ApiClient {
    client: Client,
    host: String,
    auth: AuthMethod,
    default_headers: HeaderMap,
    default_query: Vec<(String, String)>,
    timeout: Duration,
    tls_config: Option<TlsConfig>,
    request_builder: Option<RequestBuilderDecorator>,
    follow_redirects: bool,
}

pub enum AuthMethod {
    NoAuth,
    BearerToken(String),
    ApiKey { header_name: String, key: String },
    Custom(Box<dyn AuthProvider>),
}

const INVALID_PROVIDER_API_URL: &str = "Invalid provider API URL";
const INVALID_PROVIDER_API_ORIGIN: &str = "Invalid provider API origin";

fn normalize_dns_hostname(hostname: &str) -> Option<String> {
    let hostname = hostname.to_ascii_lowercase();
    let hostname = hostname.strip_suffix('.').unwrap_or(&hostname);
    if hostname.is_empty() || hostname.ends_with('.') {
        return None;
    }
    if hostname.split('.').any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return None;
    }
    Some(hostname.to_string())
}

fn is_canonical_vendor_hostname(hostname: &str) -> bool {
    hostname == "api.openai.com"
        || hostname == "api.anthropic.com"
        || hostname == "generativelanguage.googleapis.com"
        || hostname == "api.x.ai"
        || hostname == "router.huggingface.co"
        || hostname == "huggingface.co"
        || hostname == "openrouter.ai"
        || hostname == "api.mistral.ai"
        || hostname == "api.deepseek.com"
        || hostname == "api.groq.com"
        || hostname == "api.cerebras.ai"
        || hostname == "api.z.ai"
        || hostname == "integrate.api.nvidia.com"
}

pub fn parse_provider_api_url(raw_url: &str) -> Result<url::Url> {
    let has_userinfo = raw_url
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split(['/', '?', '#']).next())
        .is_some_and(|authority| authority.contains('@'));
    if has_userinfo {
        anyhow::bail!(INVALID_PROVIDER_API_URL);
    }

    let parsed = url::Url::parse(raw_url).map_err(|_| anyhow::anyhow!(INVALID_PROVIDER_API_URL))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!(INVALID_PROVIDER_API_URL);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        anyhow::bail!(INVALID_PROVIDER_API_URL);
    }

    let hostname = match parsed.host() {
        Some(url::Host::Domain(hostname)) => Some(
            normalize_dns_hostname(hostname)
                .ok_or_else(|| anyhow::anyhow!(INVALID_PROVIDER_API_URL))?,
        ),
        Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)) => None,
        None => anyhow::bail!(INVALID_PROVIDER_API_URL),
    };
    if hostname
        .as_deref()
        .is_some_and(is_canonical_vendor_hostname)
        && (parsed.scheme() != "https" || parsed.port_or_known_default() != Some(443))
    {
        anyhow::bail!(INVALID_PROVIDER_API_ORIGIN);
    }

    Ok(parsed)
}

pub fn has_trusted_https_origin(url: &str, expected_hostname: &str) -> bool {
    let Some(expected_hostname) = normalize_dns_hostname(expected_hostname) else {
        return false;
    };
    parse_provider_api_url(url).ok().is_some_and(|parsed| {
        parsed.scheme() == "https"
            && parsed.port_or_known_default() == Some(443)
            && parsed
                .host_str()
                .and_then(normalize_dns_hostname)
                .as_deref()
                == Some(expected_hostname.as_str())
    })
}

pub fn has_trusted_https_origin_matching(
    url: &str,
    hostname_matches: impl FnOnce(&str) -> bool,
) -> bool {
    parse_provider_api_url(url).ok().is_some_and(|parsed| {
        parsed.scheme() == "https"
            && parsed.port_or_known_default() == Some(443)
            && parsed
                .host_str()
                .and_then(normalize_dns_hostname)
                .as_deref()
                .is_some_and(hostname_matches)
    })
}

pub async fn validate_credential_probe_get(
    client: &ApiClient,
    path: &str,
    valid_response: impl FnOnce(&Value) -> bool,
) -> std::result::Result<(), ProviderError> {
    let response = client
        .response_get(path)
        .await
        .map_err(ProviderError::from)
        .map_err(ProviderError::for_credential_probe)?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(ProviderError::Authentication(
            "The provider rejected the credentials.".to_string(),
        ));
    }
    if status.is_server_error() {
        return Err(ProviderError::ServerError(
            "The provider credential validation service is unavailable.".to_string(),
        ));
    }
    if !status.is_success() {
        return Err(ProviderError::RequestFailed(
            "Provider credential validation failed.".to_string(),
        ));
    }
    let body = response.json::<Value>().await.map_err(|_| {
        ProviderError::RequestFailed("Provider credential validation failed.".to_string())
    })?;
    if body.get("error").is_some() || !valid_response(&body) {
        return Err(ProviderError::Authentication(
            "The provider rejected the credentials.".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct TlsCertKeyPair {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct TlsConfig {
    pub client_identity: Option<TlsCertKeyPair>,
    pub ca_cert_path: Option<PathBuf>,
}

impl TlsConfig {
    pub fn new() -> Self {
        Self {
            client_identity: None,
            ca_cert_path: None,
        }
    }

    pub fn with_client_cert_and_key(mut self, cert_path: PathBuf, key_path: PathBuf) -> Self {
        self.client_identity = Some(TlsCertKeyPair {
            cert_path,
            key_path,
        });
        self
    }

    pub fn with_ca_cert(mut self, path: PathBuf) -> Self {
        self.ca_cert_path = Some(path);
        self
    }

    pub fn is_configured(&self) -> bool {
        self.client_identity.is_some() || self.ca_cert_path.is_some()
    }

    #[cfg(any(feature = "rustls-tls", feature = "native-tls"))]
    fn load_identity(&self) -> Result<Option<Identity>> {
        if let Some(cert_key_pair) = &self.client_identity {
            let cert_pem = read_to_string(&cert_key_pair.cert_path)
                .map_err(|e| anyhow::anyhow!("Failed to read client certificate: {}", e))?;
            let key_pem = read_to_string(&cert_key_pair.key_path)
                .map_err(|e| anyhow::anyhow!("Failed to read client private key: {}", e))?;

            #[cfg(not(feature = "native-tls"))]
            let identity = {
                let combined_pem = format!("{}\n{}", cert_pem, key_pem);
                Identity::from_pem(combined_pem.as_bytes()).map_err(|e| {
                    anyhow::anyhow!("Failed to create identity from cert and key: {}", e)
                })?
            };

            #[cfg(feature = "native-tls")]
            let identity = {
                let pkcs8_key_pem = convert_key_to_pkcs8_pem(&key_pem)?;
                Identity::from_pkcs8_pem(cert_pem.as_bytes(), pkcs8_key_pem.as_bytes()).map_err(
                    |e| anyhow::anyhow!("Failed to create identity from cert and key: {}", e),
                )?
            };

            Ok(Some(identity))
        } else {
            Ok(None)
        }
    }

    #[cfg(any(feature = "rustls-tls", feature = "native-tls"))]
    fn load_ca_certificates(&self) -> Result<Vec<Certificate>> {
        match &self.ca_cert_path {
            Some(ca_path) => {
                let ca_pem = read_to_string(ca_path)
                    .map_err(|e| anyhow::anyhow!("Failed to read CA certificate: {}", e))?;

                let certs = Certificate::from_pem_bundle(ca_pem.as_bytes())
                    .map_err(|e| anyhow::anyhow!("Failed to parse CA certificate bundle: {}", e))?;

                Ok(certs)
            }
            None => Ok(Vec::new()),
        }
    }
}

impl Default for TlsConfig {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert a PEM private key from any format (PKCS#1, SEC1, PKCS#8) to PKCS#8 PEM.
///
/// `reqwest::Identity::from_pkcs8_pem` (native-tls) only accepts PKCS#8
/// (`-----BEGIN PRIVATE KEY-----`), but private keys in the wild come in three formats:
///
/// - **PKCS#1** (`-----BEGIN RSA PRIVATE KEY-----`): Legacy RSA-specific format.
///   Generated by default with `openssl genrsa`. Very common in older setups, tutorials,
///   and CA-issued key files.
/// - **SEC1** (`-----BEGIN EC PRIVATE KEY-----`): Legacy EC-specific format.
///   Generated by default with `openssl ecparam -genkey`. Common with EC certificates.
/// - **PKCS#8** (`-----BEGIN PRIVATE KEY-----`): Generic, algorithm-agnostic wrapper.
///   This is the only format native-tls accepts.
///
/// Without this conversion, users with legacy-format keys (Kubernetes secrets, corporate
/// PKI, etc.) would get a cryptic "Failed to create identity" error and need to manually
/// run `openssl pkey -in key.pem -out key-pkcs8.pem`.
///
/// Note: the rustls code path (`Identity::from_pem`) accepts all formats natively,
/// so this conversion is only needed for native-tls.
#[cfg(feature = "native-tls")]
fn convert_key_to_pkcs8_pem(key_pem_str: &str) -> Result<String> {
    use pkcs8::der::{Decode, Encode};

    let parsed =
        pem::parse(key_pem_str).map_err(|e| anyhow::anyhow!("Failed to parse PEM key: {}", e))?;

    match parsed.tag() {
        "PRIVATE KEY" => Ok(key_pem_str.to_string()),
        "RSA PRIVATE KEY" => {
            let info = pkcs8::PrivateKeyInfo::new(pkcs1::ALGORITHM_ID, parsed.contents());
            let der_bytes = info
                .to_der()
                .map_err(|e| anyhow::anyhow!("Failed to encode PKCS#8: {}", e))?;
            Ok(pem::encode(&pem::Pem::new("PRIVATE KEY", der_bytes)))
        }
        "EC PRIVATE KEY" => {
            let ec_key = sec1::EcPrivateKey::from_der(parsed.contents())
                .map_err(|e| anyhow::anyhow!("Failed to parse EC key: {}", e))?;
            let curve_oid = ec_key
                .parameters
                .and_then(|p| p.named_curve())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "EC key missing curve parameters. Convert to PKCS#8: \
                         openssl pkey -in key.pem -out key-pkcs8.pem"
                    )
                })?;
            let algorithm = pkcs8::AlgorithmIdentifierRef {
                oid: sec1::ALGORITHM_OID,
                parameters: Some((&curve_oid).into()),
            };
            let info = pkcs8::PrivateKeyInfo::new(algorithm, parsed.contents());
            let der_bytes = info
                .to_der()
                .map_err(|e| anyhow::anyhow!("Failed to encode PKCS#8: {}", e))?;
            Ok(pem::encode(&pem::Pem::new("PRIVATE KEY", der_bytes)))
        }
        tag => Err(anyhow::anyhow!(
            "Unsupported key format '{}'. Expected PKCS#8, PKCS#1, or SEC1. \
             Convert with: openssl pkey -in key.pem -out key-pkcs8.pem",
            tag
        )),
    }
}

#[async_trait]
pub trait AuthProvider: Send + Sync {
    async fn get_auth_header(&self) -> Result<(String, String)>;
}

pub struct ApiResponse {
    pub status: StatusCode,
    pub payload: Option<Value>,
}

impl fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthMethod::NoAuth => f.debug_tuple("NoAuth").finish(),
            AuthMethod::BearerToken(_) => f.debug_tuple("BearerToken").field(&"[hidden]").finish(),
            AuthMethod::ApiKey { header_name, .. } => f
                .debug_struct("ApiKey")
                .field("header_name", header_name)
                .field("key", &"[hidden]")
                .finish(),
            AuthMethod::Custom(_) => f.debug_tuple("Custom").field(&"[provider]").finish(),
        }
    }
}

impl ApiResponse {
    pub async fn from_response(response: Response) -> Result<Self> {
        let status = response.status();
        let payload = response.json().await.ok();
        Ok(Self { status, payload })
    }
}

pub struct ApiRequestBuilder<'a> {
    client: &'a ApiClient,
    path: &'a str,
    headers: HeaderMap,
}

impl ApiClient {
    pub fn new_with_tls(
        host: String,
        auth: AuthMethod,
        tls_config: Option<TlsConfig>,
    ) -> Result<Self> {
        Self::with_timeout_and_tls(
            host,
            auth,
            Duration::from_secs(DEFAULT_PROVIDER_TIMEOUT_SECS),
            tls_config,
        )
    }

    pub fn with_timeout_and_tls(
        host: String,
        auth: AuthMethod,
        timeout: Duration,
        tls_config: Option<TlsConfig>,
    ) -> Result<Self> {
        parse_provider_api_url(&host)?;
        let mut client_builder = Client::builder().timeout(timeout);

        if let Some(ref config) = tls_config {
            client_builder = Self::configure_tls(client_builder, config)?;
        }

        let client = client_builder.build()?;

        Ok(Self {
            client,
            host,
            auth,
            default_headers: HeaderMap::new(),
            default_query: Vec::new(),
            timeout,
            tls_config,
            request_builder: None,
            follow_redirects: true,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    fn rebuild_client(&mut self) -> Result<()> {
        let mut client_builder = Client::builder()
            .timeout(self.timeout)
            .default_headers(self.default_headers.clone());

        if !self.follow_redirects {
            client_builder = client_builder.redirect(reqwest::redirect::Policy::none());
        }

        // Configure TLS if needed
        if let Some(ref tls_config) = self.tls_config {
            client_builder = Self::configure_tls(client_builder, tls_config)?;
        }

        self.client = client_builder.build()?;
        Ok(())
    }

    /// Disable redirects for untrusted custom-provider origins.
    ///
    /// This ensures a response cannot redirect an otherwise-valid custom
    /// endpoint to a protected vendor origin before the second request is sent.
    pub fn without_redirects(mut self) -> Result<Self> {
        self.follow_redirects = false;
        self.rebuild_client()?;
        Ok(self)
    }

    /// Configure TLS settings on a reqwest ClientBuilder
    #[cfg(any(feature = "rustls-tls", feature = "native-tls"))]
    fn configure_tls(
        mut client_builder: reqwest::ClientBuilder,
        tls_config: &TlsConfig,
    ) -> Result<reqwest::ClientBuilder> {
        if tls_config.is_configured() {
            // Load client identity (certificate + private key)
            if let Some(identity) = tls_config.load_identity()? {
                client_builder = client_builder.identity(identity);
            }

            // Load CA certificates
            let ca_certs = tls_config.load_ca_certificates()?;
            for ca_cert in ca_certs {
                client_builder = client_builder.add_root_certificate(ca_cert);
            }
        }
        Ok(client_builder)
    }

    /// Reject custom TLS settings when goose is compiled without a TLS backend.
    #[cfg(not(any(feature = "rustls-tls", feature = "native-tls")))]
    fn configure_tls(
        client_builder: reqwest::ClientBuilder,
        tls_config: &TlsConfig,
    ) -> Result<reqwest::ClientBuilder> {
        if tls_config.is_configured() {
            return Err(anyhow::anyhow!(
                "Custom TLS configuration requires the `rustls-tls` or `native-tls` feature"
            ));
        }
        Ok(client_builder)
    }

    pub fn with_headers(mut self, headers: HeaderMap) -> Result<Self> {
        self.default_headers = headers;
        self.rebuild_client()?;
        Ok(self)
    }

    pub fn with_query(mut self, params: Vec<(String, String)>) -> Self {
        self.default_query = params;
        self
    }

    pub fn with_header(mut self, key: &str, value: &str) -> Result<Self> {
        let header_name = HeaderName::from_bytes(key.as_bytes())?;
        let header_value = HeaderValue::from_str(value)?;
        self.default_headers.insert(header_name, header_value);
        self.rebuild_client()?;
        Ok(self)
    }

    pub fn with_request_builder(mut self, request_builder: RequestBuilderDecorator) -> Self {
        self.request_builder = Some(request_builder);
        self
    }

    pub fn request<'a>(&'a self, path: &'a str) -> ApiRequestBuilder<'a> {
        ApiRequestBuilder {
            client: self,
            path,
            headers: HeaderMap::new(),
        }
    }

    pub async fn api_post(&self, path: &str, payload: &Value) -> Result<ApiResponse> {
        self.request(path).api_post(payload).await
    }

    pub async fn response_post(&self, path: &str, payload: &Value) -> Result<Response> {
        self.request(path).response_post(payload).await
    }

    pub async fn api_get(&self, path: &str) -> Result<ApiResponse> {
        self.request(path).api_get().await
    }

    pub async fn response_get(&self, path: &str) -> Result<Response> {
        self.request(path).response_get().await
    }

    /// Send one leg of a differential credential probe without following redirects.
    ///
    /// Both legs use the same transport, URL query, default headers, TLS and
    /// request decorator. The only difference is whether this client's
    /// configured authentication method is applied.
    pub async fn response_get_for_credential_probe(
        &self,
        path: &str,
        with_auth: bool,
    ) -> Result<Response> {
        let mut client_builder = Client::builder()
            .timeout(self.timeout)
            .default_headers(self.default_headers.clone())
            .redirect(reqwest::redirect::Policy::none());
        if let Some(ref tls_config) = self.tls_config {
            client_builder = Self::configure_tls(client_builder, tls_config)?;
        }
        let client = client_builder.build()?;
        let url = self.build_url(path)?;
        let mut request = client.get(url);
        if let Some(decorator) = &self.request_builder {
            request = decorator(request)?;
        }
        if with_auth {
            request = match &self.auth {
                AuthMethod::NoAuth => request,
                AuthMethod::BearerToken(token) => {
                    request.header("Authorization", format!("Bearer {token}"))
                }
                AuthMethod::ApiKey { header_name, key } => {
                    request.header(header_name.as_str(), key)
                }
                AuthMethod::Custom(provider) => {
                    let (header_name, header_value) = provider.get_auth_header().await?;
                    request.header(header_name, header_value)
                }
            };
        }
        crate::retry::reserve_http_attempt().await?;
        Ok(request.send().await?)
    }

    fn build_url(&self, path: &str) -> Result<url::Url> {
        use url::Url;
        let mut base_url =
            Url::parse(&self.host).map_err(|e| anyhow::anyhow!("Invalid base URL: {}", e))?;

        let base_path = base_url.path();
        if !base_path.is_empty() && base_path != "/" && !base_path.ends_with('/') {
            base_url.set_path(&format!("{}/", base_path));
        }

        let mut url = base_url
            .join(path)
            .map_err(|e| anyhow::anyhow!("Failed to construct URL: {}", e))?;

        for (key, value) in &self.default_query {
            url.query_pairs_mut().append_pair(key, value);
        }

        Ok(url)
    }
}

impl<'a> ApiRequestBuilder<'a> {
    pub fn header(mut self, key: &str, value: &str) -> Result<Self> {
        let header_name = HeaderName::from_bytes(key.as_bytes())?;
        let header_value = HeaderValue::from_str(value)?;
        self.headers.insert(header_name, header_value);
        Ok(self)
    }

    #[allow(dead_code)]
    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers.extend(headers);
        self
    }

    pub async fn api_post(self, payload: &Value) -> Result<ApiResponse> {
        let response = self.response_post(payload).await?;
        ApiResponse::from_response(response).await
    }

    pub async fn response_post(self, payload: &Value) -> Result<Response> {
        let request = self.send_request(|url, client| client.post(url)).await?;
        crate::retry::reserve_http_attempt().await?;
        Ok(request.json(payload).send().await?)
    }

    pub async fn multipart_post(self, form: reqwest::multipart::Form) -> Result<Response> {
        let request = self.send_request(|url, client| client.post(url)).await?;
        crate::retry::reserve_http_attempt().await?;
        Ok(request.multipart(form).send().await?)
    }

    pub async fn api_get(self) -> Result<ApiResponse> {
        let response = self.response_get().await?;
        ApiResponse::from_response(response).await
    }

    pub async fn response_get(self) -> Result<Response> {
        let request = self.send_request(|url, client| client.get(url)).await?;
        crate::retry::reserve_http_attempt().await?;
        Ok(request.send().await?)
    }

    async fn send_request<F>(&self, request_builder: F) -> Result<reqwest::RequestBuilder>
    where
        F: FnOnce(url::Url, &Client) -> reqwest::RequestBuilder,
    {
        let url = self.client.build_url(self.path)?;
        let headers = self.headers.clone();
        let mut request = request_builder(url, &self.client.client);
        request = request.headers(headers);

        if let Some(decorator) = &self.client.request_builder {
            request = decorator(request)?;
        }

        request = match &self.client.auth {
            AuthMethod::NoAuth => request,
            AuthMethod::BearerToken(token) => {
                request.header("Authorization", format!("Bearer {}", token))
            }
            AuthMethod::ApiKey { header_name, key } => request.header(header_name.as_str(), key),
            AuthMethod::Custom(provider) => {
                let (header_name, header_value) = provider.get_auth_header().await?;
                request.header(header_name, header_value)
            }
        };

        Ok(request)
    }
}

impl fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiClient")
            .field("host", &self.host)
            .field("auth", &"[auth method]")
            .field("timeout", &self.timeout)
            .field("default_headers", &self.default_headers)
            .finish_non_exhaustive()
    }
}

#[cfg(all(test, feature = "native-tls"))]
mod native_tls_tests {
    use super::convert_key_to_pkcs8_pem;

    const PKCS8_RSA_KEY: &str = "\
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCzmc7SPaB07+gK
p/VETtmayzNASEaaGIEKO5eOrlrKfIMdmSyB38Ia4dCyxb8WKAROeBtaev8AXfKh
5sPRPi42SNF77d171QWKU4WKXRWWpO2UWwzrXc/BaCNr0Ey9S4ej3v0DmdPkW+pY
PZ5lzHUT6wTutGwJsceCN+/lgPmazaZvfnTdLlRChLyPFjwGkGFwmu7YZACdbIqd
CW5oIs+weAK2L9+HZaLi0TWcnJrnONs00GHTm2DwLkl8ulKRn6+XygWZLpY4owE6
/x4v4CrTKStvfJlPiErcR/t13vZ+kZq3XxcgIY5V0HEz+AT57/MvvGomQXyMmQnN
bQrmdbvRAgMBAAECggEABd6knqSmuDeogeOmHYzFqhxSwRqzmwDqw7i5ne9HFpfN
6bNaO+biF0KS0Wrq0Tiu1lkwzKrZJ2wKnF24P+AMPtgvp4EZRF0sjI4o/sIGzPj4
LklxAUa8Pd4PTUxeG7Aqn1GP+5SFEzEpVieyY/GUEHn1e+8v2jvCEViOabXmwndA
tGHScHwMA0qW1smCOLj12mfFJJjJjlj7QveJFSJ94wo8XjdZvzLDonQoAf4vN99f
rf40zgAx8VQk1UmOPYgc7mqN3JerjWX3rG820UWilLnAA35rrVxjzeV9yfAbgpVC
qHPaOaN4tBVTb3z9w94wK/uDjd4Px26Qq0Yipi4xGQKBgQD7RXE6hNlx1hW7pdWw
hrxdH9ofptBzJfQwYnO0cq6KFF6+QQYzJcMAZAKEytDzfjkH1iHURtBFA1ndKBSI
B1G8iR7Jie4szDghJ+zS9QHHhXLRprSqyamRefnLe/614YlaP7i9wq/sHg8KKm5b
g+S49EfuKctAenMx8sDPDG7Y2QKBgQC2+xOZTE5uPPitOyR8eMUF1ye9zeONzyJ2
l2rjEZuIOWd12wsrgGVTRXoecpqFNIxcmK2mnBtrWCJ/A5xFXjQjIZ1huJ/oNm+t
bI/GtlM5BknfEP6m8NVtMx5ubzqDIlsgRpXCWco3ytaKZJtdnJhZAOmBogAKUiPr
NL2afWbfuQKBgA722MJybPzBkjPFsY88xvUI05W0+o8RAJTtGBT0C37/rZDJEJR1
OELKsfe0mHMX3k+gKg2ZVgf2JiDspSRgwzZmOCYqh7u1QdZ/qTP7EWsPgIIJ2pKd
RfL6/6xlqwqr7uEoEFmEwbNfKughFMdweGunaK0/YfJqGHguC9uI0wUpAoGBAKDM
U5TLscC+Y+oXpyCbIMjZIltxqx7bf/Wnao7Q0lUL3Rd8vnwkAOcEjyRiodedLhvR
MAjR9maGtQnZKmLrPfYBfER78komTE2isVZ2svvRwuj8Dky2J1gnK/7wUAMdFedv
H/wC2+nbnl1PvBivnFHas1jv/AkV1erEFjrFKLpBAoGABQ29M3xsVv7++/ivl0JM
lNzUZwWbG4GI9Yx/zBMJpjiPi9Bkbe2Iu7EgLuiaTnktLSzm9hwVEIxd6a6X/wRA
cGr4L/FDExxjHQPzYpeGQ5fA9HlDWZzQ7Ou+nZ/O+OwXuvnmjXTXyB0djVJHOmLU
gOfZqLKYsL5zn6pefvXu0dU=
-----END PRIVATE KEY-----";

    const PKCS1_RSA_KEY: &str = "\
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAs5nO0j2gdO/oCqf1RE7ZmsszQEhGmhiBCjuXjq5aynyDHZks
gd/CGuHQssW/FigETngbWnr/AF3yoebD0T4uNkjRe+3de9UFilOFil0VlqTtlFsM
613PwWgja9BMvUuHo979A5nT5FvqWD2eZcx1E+sE7rRsCbHHgjfv5YD5ms2mb350
3S5UQoS8jxY8BpBhcJru2GQAnWyKnQluaCLPsHgCti/fh2Wi4tE1nJya5zjbNNBh
05tg8C5JfLpSkZ+vl8oFmS6WOKMBOv8eL+Aq0ykrb3yZT4hK3Ef7dd72fpGat18X
ICGOVdBxM/gE+e/zL7xqJkF8jJkJzW0K5nW70QIDAQABAoIBAAXepJ6kprg3qIHj
ph2MxaocUsEas5sA6sO4uZ3vRxaXzemzWjvm4hdCktFq6tE4rtZZMMyq2SdsCpxd
uD/gDD7YL6eBGURdLIyOKP7CBsz4+C5JcQFGvD3eD01MXhuwKp9Rj/uUhRMxKVYn
smPxlBB59XvvL9o7whFYjmm15sJ3QLRh0nB8DANKltbJgji49dpnxSSYyY5Y+0L3
iRUifeMKPF43Wb8yw6J0KAH+LzffX63+NM4AMfFUJNVJjj2IHO5qjdyXq41l96xv
NtFFopS5wAN+a61cY83lfcnwG4KVQqhz2jmjeLQVU298/cPeMCv7g43eD8dukKtG
IqYuMRkCgYEA+0VxOoTZcdYVu6XVsIa8XR/aH6bQcyX0MGJztHKuihRevkEGMyXD
AGQChMrQ8345B9Yh1EbQRQNZ3SgUiAdRvIkeyYnuLMw4ISfs0vUBx4Vy0aa0qsmp
kXn5y3v+teGJWj+4vcKv7B4PCipuW4PkuPRH7inLQHpzMfLAzwxu2NkCgYEAtvsT
mUxObjz4rTskfHjFBdcnvc3jjc8idpdq4xGbiDlnddsLK4BlU0V6HnKahTSMXJit
ppwba1gifwOcRV40IyGdYbif6DZvrWyPxrZTOQZJ3xD+pvDVbTMebm86gyJbIEaV
wlnKN8rWimSbXZyYWQDpgaIAClIj6zS9mn1m37kCgYAO9tjCcmz8wZIzxbGPPMb1
CNOVtPqPEQCU7RgU9At+/62QyRCUdThCyrH3tJhzF95PoCoNmVYH9iYg7KUkYMM2
ZjgmKoe7tUHWf6kz+xFrD4CCCdqSnUXy+v+sZasKq+7hKBBZhMGzXyroIRTHcHhr
p2itP2Hyahh4LgvbiNMFKQKBgQCgzFOUy7HAvmPqF6cgmyDI2SJbcase23/1p2qO
0NJVC90XfL58JADnBI8kYqHXnS4b0TAI0fZmhrUJ2Spi6z32AXxEe/JKJkxNorFW
drL70cLo/A5MtidYJyv+8FADHRXnbx/8Atvp255dT7wYr5xR2rNY7/wJFdXqxBY6
xSi6QQKBgAUNvTN8bFb+/vv4r5dCTJTc1GcFmxuBiPWMf8wTCaY4j4vQZG3tiLux
IC7omk55LS0s5vYcFRCMXemul/8EQHBq+C/xQxMcYx0D82KXhkOXwPR5Q1mc0Ozr
vp2fzvjsF7r55o1018gdHY1SRzpi1IDn2aiymLC+c5+qXn717tHV
-----END RSA PRIVATE KEY-----";

    const SEC1_EC_KEY: &str = "\
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIIQyP9q8dmPTyzxgCAF22fS5w6GJP7lVrkq3gdG216TtoAoGCCqGSM49
AwEHoUQDQgAEAxC2ZMkrbwEImb3S2BD8qA9rquFbozW6d7VrhVk1tOqnIuM+vXkz
ShGoCNbfNS+COlPMRAujyDlATZcLs9p4tA==
-----END EC PRIVATE KEY-----";

    #[test]
    fn test_pkcs8_key_passthrough() {
        let result = convert_key_to_pkcs8_pem(PKCS8_RSA_KEY).unwrap();
        assert_eq!(result, PKCS8_RSA_KEY.to_string());
    }

    #[test]
    fn test_pkcs1_rsa_key_conversion() {
        let result = convert_key_to_pkcs8_pem(PKCS1_RSA_KEY).unwrap();
        assert!(result.contains("-----BEGIN PRIVATE KEY-----"));
        assert!(result.contains("-----END PRIVATE KEY-----"));
        assert!(!result.contains("RSA PRIVATE KEY"));
        // Verify the result is valid PKCS#8 by re-parsing
        let re_parsed = pem::parse(&result).unwrap();
        assert_eq!(re_parsed.tag(), "PRIVATE KEY");
        use pkcs8::der::Decode;
        pkcs8::PrivateKeyInfo::from_der(re_parsed.contents()).unwrap();
    }

    #[test]
    fn test_sec1_ec_key_conversion() {
        let result = convert_key_to_pkcs8_pem(SEC1_EC_KEY).unwrap();
        assert!(result.contains("-----BEGIN PRIVATE KEY-----"));
        assert!(result.contains("-----END PRIVATE KEY-----"));
        assert!(!result.contains("EC PRIVATE KEY"));
        // Verify the result is valid PKCS#8 by re-parsing
        let re_parsed = pem::parse(&result).unwrap();
        assert_eq!(re_parsed.tag(), "PRIVATE KEY");
        use pkcs8::der::Decode;
        pkcs8::PrivateKeyInfo::from_der(re_parsed.contents()).unwrap();
    }

    #[test]
    fn test_unsupported_key_format() {
        let bad_pem =
            "-----BEGIN DSA PRIVATE KEY-----\nMIIBuwIBAAKB\n-----END DSA PRIVATE KEY-----";
        let result = convert_key_to_pkcs8_pem(bad_pem);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Unsupported key format"),);
    }

    #[test]
    fn test_invalid_pem() {
        let result = convert_key_to_pkcs8_pem("not a pem");
        assert!(result.is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ProviderError;
    use crate::retry::{retry_operation, with_http_attempt_gate, HttpAttemptGate, RetryConfig};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::any;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn credential_probe_get_is_fail_closed_and_redacted() {
        const CANARY: &str = "credential-probe-body-canary";
        for status in [401, 403, 404, 500, 200] {
            let server = MockServer::start().await;
            Mock::given(any())
                .respond_with(
                    ResponseTemplate::new(status).set_body_json(serde_json::json!({
                        "error": {"message": format!("Authorization: Bearer {CANARY}")}
                    })),
                )
                .expect(1)
                .mount(&server)
                .await;
            let client = ApiClient::new_with_tls(
                server.uri(),
                AuthMethod::BearerToken(CANARY.to_string()),
                None,
            )
            .unwrap();

            let error = validate_credential_probe_get(&client, "probe", |_| true)
                .await
                .unwrap_err();
            assert!(!error.to_string().contains(CANARY));
            match status {
                401 | 403 | 200 => assert!(matches!(error, ProviderError::Authentication(_))),
                500 => assert!(matches!(error, ProviderError::ServerError(_))),
                _ => assert!(matches!(error, ProviderError::RequestFailed(_))),
            }
        }
    }

    #[test]
    fn canonical_vendor_origin_requires_https_without_userinfo_or_nondefault_port() {
        for hostname in [
            "api.openai.com",
            "api.anthropic.com",
            "generativelanguage.googleapis.com",
            "api.x.ai",
            "router.huggingface.co",
            "huggingface.co",
            "openrouter.ai",
            "api.mistral.ai",
            "api.deepseek.com",
            "api.groq.com",
            "api.cerebras.ai",
            "api.z.ai",
            "integrate.api.nvidia.com",
        ] {
            assert!(has_trusted_https_origin(
                &format!("https://{hostname}"),
                hostname
            ));
            assert!(has_trusted_https_origin(
                &format!("https://{hostname}:443/v1"),
                hostname
            ));
            assert!(!has_trusted_https_origin(
                &format!("http://{hostname}"),
                hostname
            ));
            assert!(!has_trusted_https_origin(
                &format!("https://{hostname}:8443"),
                hostname
            ));
            assert!(!has_trusted_https_origin(
                &format!("https://user:pass@{hostname}"),
                hostname
            ));
            assert!(!has_trusted_https_origin(
                &format!("https://@{hostname}"),
                hostname
            ));
        }

        assert!(parse_provider_api_url("http://eu.api.openai.com/v1").is_ok());
    }

    #[test]
    fn canonical_vendor_origin_normalizes_one_dns_absolute_name_trailing_dot() {
        for hostname in ["api.z.ai", "integrate.api.nvidia.com"] {
            assert!(has_trusted_https_origin(
                &format!("https://{hostname}./v1"),
                hostname
            ));
            assert!(parse_provider_api_url(&format!("http://{hostname}./v1")).is_err());
            assert!(parse_provider_api_url(&format!("https://{hostname}.:8443/v1")).is_err());
        }
    }

    #[test]
    fn provider_api_url_rejects_non_http_schemes() {
        for raw_url in [
            "ftp://example.invalid/v1",
            "file:///tmp/provider",
            "data:text/plain,provider",
        ] {
            assert!(
                parse_provider_api_url(raw_url).is_err(),
                "accepted {raw_url}"
            );
        }
        assert!(parse_provider_api_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(parse_provider_api_url("https://example.invalid/v1").is_ok());
    }

    #[derive(Debug)]
    struct FixedAttemptGate {
        authorization_id: String,
        used: AtomicUsize,
        cap: usize,
    }

    #[derive(Debug)]
    struct RejectingAttemptGate;

    #[async_trait]
    impl HttpAttemptGate for RejectingAttemptGate {
        async fn reserve_attempt(&self) -> std::result::Result<(), ProviderError> {
            Err(ProviderError::ExecutionError(
                "durable reservation failed".to_string(),
            ))
        }
    }

    #[async_trait]
    impl HttpAttemptGate for FixedAttemptGate {
        async fn reserve_attempt(&self) -> std::result::Result<(), ProviderError> {
            let used = self.used.fetch_add(1, Ordering::SeqCst);
            if used >= self.cap {
                self.used.fetch_sub(1, Ordering::SeqCst);
                return Err(ProviderError::ExternalHttpAttemptBudgetExceeded {
                    authorization_id: self.authorization_id.clone(),
                    used,
                    cap: self.cap,
                });
            }
            Ok(())
        }
    }

    fn fixed_gate(cap: usize) -> Arc<FixedAttemptGate> {
        Arc::new(FixedAttemptGate {
            authorization_id: "authorization-test".to_string(),
            used: AtomicUsize::new(0),
            cap,
        })
    }

    #[tokio::test]
    async fn every_api_client_transport_reserves_immediately_before_send() {
        let server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let client =
            Arc::new(ApiClient::new_with_tls(server.uri(), AuthMethod::NoAuth, None).unwrap());
        let gate = fixed_gate(4);

        let error = with_http_attempt_gate(gate.clone(), async {
            client
                .request("v1/chat/completions")
                .response_post(&serde_json::json!({"safe": true}))
                .await?;
            client.request("api/tags").response_get().await?;
            client
                .request("upload")
                .multipart_post(reqwest::multipart::Form::new().text("safe", "fixture"))
                .await?;
            client
                .request("api/show")
                .response_post(&serde_json::json!({"model": "fixture"}))
                .await?;
            client.request("must-not-send").response_get().await
        })
        .await
        .expect_err("the fifth send must be rejected by the transport gate");

        let error = ProviderError::from(error);
        assert!(matches!(
            error,
            ProviderError::ExternalHttpAttemptBudgetExceeded {
                used: 4,
                cap: 4,
                ..
            }
        ));
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests
                .iter()
                .map(|request| request.url.path())
                .collect::<Vec<_>>(),
            vec!["/v1/chat/completions", "/api/tags", "/upload", "/api/show"]
        );
    }

    #[tokio::test]
    async fn provider_retry_cannot_send_more_requests_than_the_transport_cap() {
        let server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let client =
            Arc::new(ApiClient::new_with_tls(server.uri(), AuthMethod::NoAuth, None).unwrap());
        let gate = fixed_gate(2);
        let config = RetryConfig::new(3, 0, 1.0, 0);

        let error = with_http_attempt_gate(gate, async {
            retry_operation(&config, || {
                let client = client.clone();
                async move {
                    let _ = client
                        .request("v1/chat/completions")
                        .response_post(&serde_json::json!({"safe": true}))
                        .await
                        .map_err(ProviderError::from)?;
                    Err::<(), _>(ProviderError::ServerError("fixture 500".to_string()))
                }
            })
            .await
        })
        .await
        .expect_err("the retry loop must stop at the physical transport cap");

        assert!(matches!(
            error,
            ProviderError::ExternalHttpAttemptBudgetExceeded {
                used: 2,
                cap: 2,
                ..
            }
        ));
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn reservation_failure_prevents_the_transport_send() {
        let server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let client = ApiClient::new_with_tls(server.uri(), AuthMethod::NoAuth, None).unwrap();

        let error = with_http_attempt_gate(Arc::new(RejectingAttemptGate), async {
            client.request("must-not-send").response_get().await
        })
        .await
        .expect_err("a failed durable reservation must fail closed");

        assert!(error.to_string().contains("durable reservation failed"));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn custom_redirect_policy_never_sends_the_second_hop() {
        let source = MockServer::start().await;
        let target = MockServer::start().await;
        Mock::given(any())
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("Location", format!("{}/protected", target.uri())),
            )
            .expect(1)
            .mount(&source)
            .await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&target)
            .await;

        let client = ApiClient::new_with_tls(source.uri(), AuthMethod::NoAuth, None)
            .unwrap()
            .without_redirects()
            .unwrap();
        let response = client.response_get("redirect").await.unwrap();

        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(target.received_requests().await.unwrap().is_empty());
    }

    #[test]
    fn test_request_builder_decorator() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let client = ApiClient::new_with_tls(
                "http://localhost:8080".to_string(),
                AuthMethod::BearerToken("test-token".to_string()),
                None,
            )
            .unwrap()
            .with_request_builder(Arc::new(|request| {
                Ok(request.header("test-my-session-id", "test-session_id-456"))
            }));

            let request = client
                .request("/test")
                .send_request(|url, client| client.get(url))
                .await
                .unwrap();

            let headers = request.build().unwrap().headers().clone();
            let actual = headers
                .get("test-my-session-id")
                .and_then(|value| value.to_str().ok());
            assert_eq!(actual, Some("test-session_id-456"));
        });
    }
}
