use super::base::{ConfigKey, MessageStream, Provider, ProviderDef, ProviderMetadata};
use crate::config::declarative_providers::DeclarativeProviderConfig;
use crate::config::Config;
use crate::conversation::message::Message;
use anyhow::Result;
use futures::{future::BoxFuture, StreamExt};
use goose_providers::api_client::{ApiClient, AuthMethod, TlsConfig};
use goose_providers::base::ProviderDescriptor;
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use goose_providers::ollama::fetch_ollama_model_names;
use goose_providers::openai::OpenAiProvider;
use rmcp::model::Tool;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::sync::OnceCell;

const OLLAMA_CLOUD_PROVIDER_NAME: &str = "ollama_cloud";
const OLLAMA_CLOUD_DEFAULT_STREAM_TIMEOUT_SECS: u64 = 120;

static SHOW_INFO_CACHE: LazyLock<Mutex<HashMap<String, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub struct OllamaCloudProvider {
    inner: OpenAiProvider,
    ollama_api_client: ApiClient,
    stream_timeout: Duration,
    model_names: OnceCell<Vec<String>>,
    custom_models: Option<Vec<String>>,
    dynamic_models: Option<bool>,
}

impl OllamaCloudProvider {
    pub fn matches_declarative_config(config: &DeclarativeProviderConfig) -> bool {
        config.name == OLLAMA_CLOUD_PROVIDER_NAME
            || config.catalog_provider_id.as_deref() == Some(OLLAMA_CLOUD_PROVIDER_NAME)
    }

    pub fn from_custom_config(
        config: DeclarativeProviderConfig,
        tls_config: Option<TlsConfig>,
    ) -> Result<Self> {
        Self::from_custom_config_with_trust(config, tls_config, true)
    }

    pub fn from_untrusted_custom_config(
        config: DeclarativeProviderConfig,
        tls_config: Option<TlsConfig>,
    ) -> Result<Self> {
        Self::from_custom_config_with_trust(config, tls_config, false)
    }

    fn from_custom_config_with_trust(
        config: DeclarativeProviderConfig,
        tls_config: Option<TlsConfig>,
        trusted: bool,
    ) -> Result<Self> {
        let stream_timeout = resolve_ollama_cloud_stream_timeout(&config);
        let inner = if trusted {
            crate::providers::openai_def::from_custom_config(config.clone(), tls_config.clone())?
        } else {
            crate::providers::openai_def::from_untrusted_custom_config(
                config.clone(),
                tls_config.clone(),
            )?
        };

        let custom_models = if !config.models.is_empty() {
            Some(
                config
                    .models
                    .iter()
                    .map(|m| m.name.clone())
                    .collect::<Vec<String>>(),
            )
        } else {
            None
        };

        if config.dynamic_models == Some(false) && custom_models.is_none() {
            return Err(anyhow::anyhow!(
                "Provider '{}' has dynamic_models: false but no static models listed; \
                 at least one entry in `models` is required.",
                config.name
            ));
        }

        let ollama_api_client = build_ollama_api_client(&config, tls_config, trusted)?;

        Ok(Self {
            inner,
            ollama_api_client,
            stream_timeout,
            model_names: OnceCell::new(),
            custom_models,
            dynamic_models: config.dynamic_models,
        })
    }

    async fn get_or_fetch_model_names(&self) -> Result<Vec<String>, ProviderError> {
        self.model_names
            .get_or_try_init(|| {
                Box::pin(async {
                    Ok(fetch_ollama_model_names(&self.ollama_api_client)
                        .await?
                        .unwrap_or_default())
                })
            })
            .await
            .map(|v| v.to_vec())
    }

    async fn fetch_context_limit_from_show(&self, model_name: &str) -> Option<usize> {
        let payload = serde_json::json!({ "model": model_name });
        let response = self
            .ollama_api_client
            .request("api/show")
            .response_post(&payload)
            .await
            .ok()?;

        if !response.status().is_success() {
            return None;
        }

        let json: Value = response.json().await.ok()?;
        json.get("model_info")
            .and_then(|info| info.as_object())
            .and_then(|obj| {
                obj.iter().find_map(|(key, value)| {
                    key.ends_with(".context_length")
                        .then(|| value.as_u64().map(|n| n as usize))
                        .flatten()
                })
            })
    }
}

fn resolve_ollama_cloud_stream_timeout(config: &DeclarativeProviderConfig) -> Duration {
    let global = Config::global();
    for key in ["OLLAMA_CLOUD_STREAM_TIMEOUT", "GOOSE_STREAM_TIMEOUT"] {
        if let Ok(seconds) = global.get_param::<u64>(key) {
            if seconds > 0 {
                return Duration::from_secs(seconds);
            }
        }
    }

    if let Some(seconds) = config.timeout_seconds.filter(|seconds| *seconds > 0) {
        return Duration::from_secs(seconds);
    }

    Duration::from_secs(OLLAMA_CLOUD_DEFAULT_STREAM_TIMEOUT_SECS)
}

fn build_ollama_api_client(
    config: &DeclarativeProviderConfig,
    tls_config: Option<TlsConfig>,
    follow_redirects: bool,
) -> Result<ApiClient> {
    let normalized_base_url = goose_providers::openai::ensure_url_scheme(&config.base_url);
    let url = url::Url::parse(&normalized_base_url)
        .map_err(|e| anyhow::anyhow!("Invalid base URL '{}': {}", config.base_url, e))?;
    let host = url[..url::Position::BeforePath].to_string();

    let api_key = crate::providers::openai_def::resolve_api_key(config, &|key| {
        Config::global().get_secret(key)
    })?;

    let timeout_secs = config
        .timeout_seconds
        .unwrap_or(crate::providers::base::DEFAULT_PROVIDER_TIMEOUT_SECS);

    let auth = match api_key {
        Some(key) if !key.is_empty() => AuthMethod::BearerToken(key),
        _ => AuthMethod::NoAuth,
    };

    let mut api_client = ApiClient::with_timeout_and_tls(
        host,
        auth,
        std::time::Duration::from_secs(timeout_secs),
        tls_config,
    )?;

    if let Some(query) = url.query() {
        let query_params = url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        api_client = api_client.with_query(query_params);
    }

    if let Some(headers) = &config.headers {
        let mut header_map = reqwest::header::HeaderMap::new();
        for (key, value) in headers {
            let header_name = reqwest::header::HeaderName::from_bytes(key.as_bytes())?;
            let header_value = reqwest::header::HeaderValue::from_str(value)?;
            header_map.insert(header_name, header_value);
        }
        api_client = api_client.with_headers(header_map)?;
    }

    if !follow_redirects {
        api_client = api_client.without_redirects()?;
    }

    Ok(api_client.with_request_builder(crate::session_context::session_id_request_builder()))
}

type OllamaCloudStreamItem = Result<
    (
        Option<Message>,
        Option<crate::conversation::token_usage::ProviderUsage>,
    ),
    ProviderError,
>;

async fn prime_ollama_cloud_stream<F, Fut>(
    mut stream_factory: F,
    timeout: Duration,
    retry_config: goose_providers::retry::RetryConfig,
) -> Result<(Option<OllamaCloudStreamItem>, MessageStream), ProviderError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<MessageStream, ProviderError>>,
{
    let mut retries = 0;

    loop {
        let mut stream = stream_factory().await?;
        match tokio::time::timeout(timeout, stream.next()).await {
            Ok(first) => return Ok((first, stream)),
            Err(_) if retries < retry_config.max_retries => {
                retries += 1;
                tracing::warn!(
                    "Ollama Cloud stream produced no data for {}s; retrying ({}/{})",
                    timeout.as_secs_f64(),
                    retries,
                    retry_config.max_retries
                );
                tokio::time::sleep(retry_config.delay_for_attempt(retries)).await;
            }
            Err(_) => {
                return Err(ProviderError::NetworkError(format!(
                    "Ollama Cloud stream timed out after receiving no data for {}s \
                     ({} retries exhausted). Configure OLLAMA_CLOUD_STREAM_TIMEOUT \
                     or GOOSE_STREAM_TIMEOUT to adjust this limit.",
                    timeout.as_secs_f64(),
                    retry_config.max_retries
                )));
            }
        }
    }
}

#[async_trait::async_trait]
impl Provider for OllamaCloudProvider {
    fn get_name(&self) -> &str {
        self.inner.get_name()
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let retry_config = self.inner.retry_config();
        let (first, mut stream) = prime_ollama_cloud_stream(
            || self.inner.stream(model_config, system, messages, tools),
            self.stream_timeout,
            retry_config,
        )
        .await?;

        let Some(first) = first else {
            return Ok(stream);
        };
        let stream_timeout = self.stream_timeout;

        Ok(Box::pin(async_stream::stream! {
            yield first;
            loop {
                match tokio::time::timeout(stream_timeout, stream.next()).await {
                    Ok(Some(item)) => yield item,
                    Ok(None) => break,
                    Err(_) => {
                        yield Err(ProviderError::NetworkError(format!(
                            "Ollama Cloud stream stalled after producing content: no data \
                             received for {}s. The partial response was not retried to avoid \
                             duplicating text or tool calls. Configure \
                             OLLAMA_CLOUD_STREAM_TIMEOUT or GOOSE_STREAM_TIMEOUT to adjust \
                             this limit.",
                            stream_timeout.as_secs_f64()
                        )));
                        break;
                    }
                }
            }
        }))
    }

    fn skip_canonical_filtering(&self) -> bool {
        self.inner.skip_canonical_filtering()
    }

    fn retry_config(&self) -> goose_providers::retry::RetryConfig {
        self.inner.retry_config()
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        if let Some(custom_models) = &self.custom_models {
            if self.dynamic_models == Some(false) {
                return Ok(custom_models.clone());
            }

            match self.get_or_fetch_model_names().await {
                Ok(models) => return Ok(models),
                Err(e) if e.is_endpoint_not_found() => {
                    tracing::debug!(
                        "Ollama api/tags not available for provider '{}', using static model list",
                        self.inner.get_name(),
                    );
                    return Ok(custom_models.clone());
                }
                Err(e) => return Err(e),
            }
        }

        self.get_or_fetch_model_names().await
    }

    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        async {
            let model = self
                .get_or_fetch_model_names()
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    ProviderError::RequestFailed(
                        "Ollama Cloud returned no models for credential validation".to_string(),
                    )
                })?;
            let payload = serde_json::json!({
                "model": model,
                "stream": false,
                "keep_alive": 0,
            });
            let response = self
                .ollama_api_client
                .request("api/generate")
                .response_post(&payload)
                .await?;
            goose_providers::http_status::handle_status(response).await?;
            Ok(())
        }
        .await
        .map_err(ProviderError::for_credential_probe)
    }

    async fn get_context_limit(&self, model_config: &ModelConfig) -> Result<usize, ProviderError> {
        if let Some(limit) = model_config.context_limit {
            return Ok(limit);
        }

        if let Some(cached) = SHOW_INFO_CACHE
            .lock()
            .ok()
            .and_then(|cache| cache.get(&model_config.model_name).copied())
        {
            return Ok(cached);
        }

        if let Some(limit) = self
            .fetch_context_limit_from_show(&model_config.model_name)
            .await
        {
            if let Ok(mut cache) = SHOW_INFO_CACHE.lock() {
                cache.insert(model_config.model_name.clone(), limit);
            }

            return Ok(limit);
        }

        Ok(model_config.context_limit())
    }
}

impl ProviderDescriptor for OllamaCloudProvider {
    fn metadata() -> ProviderMetadata {
        ProviderMetadata::new(
            OLLAMA_CLOUD_PROVIDER_NAME,
            "Ollama Cloud",
            "Access hosted models on ollama.com via OpenAI-compatible API",
            "glm-5.2",
            vec![],
            "https://ollama.com/library",
            vec![ConfigKey::new(
                "OLLAMA_CLOUD_API_KEY",
                true,
                true,
                None,
                true,
            )],
        )
    }
}

impl ProviderDef for OllamaCloudProvider {
    type Provider = Self;

    fn from_env(
        _extensions: Vec<crate::config::ExtensionConfig>,
        _tls_config: Option<TlsConfig>,
    ) -> BoxFuture<'static, Result<Self::Provider>> {
        Box::pin(async {
            anyhow::bail!(
                "Ollama Cloud must be configured as a declarative provider. \
                 Run `goose configure` to set it up."
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::declarative_providers::ProviderEngine;
    use crate::providers::base::ModelInfo;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn declarative_matching_accepts_name_or_catalog_provider_id() {
        let mut config = test_config();
        config.name = "custom_ollama".to_string();
        assert!(!OllamaCloudProvider::matches_declarative_config(&config));

        config.name = OLLAMA_CLOUD_PROVIDER_NAME.to_string();
        assert!(OllamaCloudProvider::matches_declarative_config(&config));

        config.name = "custom_ollama".to_string();
        config.catalog_provider_id = Some(OLLAMA_CLOUD_PROVIDER_NAME.to_string());
        assert!(OllamaCloudProvider::matches_declarative_config(&config));
    }

    #[test]
    fn provider_metadata_uses_the_user_authorized_mvp_model() {
        let metadata = OllamaCloudProvider::metadata();
        assert_eq!(metadata.default_model, "glm-5.2");
        assert_eq!(metadata.config_keys.len(), 1);
        assert_eq!(metadata.config_keys[0].name, "OLLAMA_CLOUD_API_KEY");
        assert!(metadata.config_keys[0].required);
        assert!(metadata.config_keys[0].secret);
    }

    #[tokio::test]
    async fn fetch_supported_models_uses_static_models_when_dynamic_models_false() {
        let server = mock_api_server(vec![], None).await;
        let provider = build_provider(
            server.uri(),
            Some(false),
            vec![ModelInfo::new("static-model", 4096)],
        );

        assert_eq!(
            provider.fetch_supported_models().await.unwrap(),
            vec!["static-model".to_string()]
        );
    }

    #[tokio::test]
    async fn fetch_supported_models_falls_back_to_static_on_404() {
        let server = mock_api_server(vec![], Some(404)).await;
        let provider = build_provider(
            server.uri(),
            None,
            vec![ModelInfo::new("static-model", 4096)],
        );

        assert_eq!(
            provider.fetch_supported_models().await.unwrap(),
            vec!["static-model".to_string()]
        );
    }

    #[tokio::test]
    async fn fetch_supported_models_uses_api_when_dynamic_models_true() {
        let server = mock_api_server(vec!["api-model-1", "api-model-2"], None).await;
        let provider = build_provider(
            server.uri(),
            Some(true),
            vec![ModelInfo::new("static-model", 4096)],
        );

        let models = provider.fetch_supported_models().await.unwrap();
        assert_eq!(models, vec!["api-model-1", "api-model-2"]);
    }

    #[tokio::test]
    async fn fetch_supported_models_uses_api_when_no_static_models() {
        let server = mock_api_server(vec!["api-model"], None).await;
        let provider = build_provider(server.uri(), None, vec![]);

        let models = provider.fetch_supported_models().await.unwrap();
        assert_eq!(models, vec!["api-model"]);
    }

    #[tokio::test]
    async fn untrusted_custom_secondary_client_does_not_follow_redirects() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let redirect_target = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&redirect_target)
            .await;

        let initial = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{}/protected", redirect_target.uri())),
            )
            .mount(&initial)
            .await;

        let config = test_config_with(
            initial.uri(),
            Some(false),
            vec![ModelInfo::new("static-model", 4096)],
        );
        let provider = OllamaCloudProvider::from_untrusted_custom_config(config, None).unwrap();

        let response = provider
            .ollama_api_client
            .request("api/tags")
            .response_get()
            .await
            .unwrap();

        assert!(response.status().is_redirection());
        assert_eq!(initial.received_requests().await.unwrap().len(), 1);
        assert!(redirect_target
            .received_requests()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn untrusted_custom_show_client_does_not_follow_redirects() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let redirect_target = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&redirect_target)
            .await;
        let initial = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/show"))
            .respond_with(
                ResponseTemplate::new(307)
                    .insert_header("location", format!("{}/protected", redirect_target.uri())),
            )
            .mount(&initial)
            .await;
        let config = test_config_with(
            initial.uri(),
            Some(false),
            vec![ModelInfo::new("static-model", 4096)],
        );
        let provider = OllamaCloudProvider::from_untrusted_custom_config(config, None).unwrap();

        assert!(provider
            .fetch_context_limit_from_show("static-model")
            .await
            .is_none());
        assert_eq!(initial.received_requests().await.unwrap().len(), 1);
        assert!(redirect_target
            .received_requests()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn public_model_catalog_does_not_authenticate_an_invalid_key() {
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let _guard =
            env_lock::lock_env([("TEST_OLLAMA_CLOUD_API_KEY", Some("wrong-provider-key"))]);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": [{"name": "public-model", "model": "public-model"}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/generate"))
            .and(header("authorization", "Bearer wrong-provider-key"))
            .and(body_json(serde_json::json!({
                "model": "public-model",
                "stream": false,
                "keep_alive": 0
            })))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": "invalid API key"
            })))
            .mount(&server)
            .await;
        let provider = build_provider_with_key(server.uri());

        assert_eq!(
            provider.fetch_supported_models().await.unwrap(),
            vec!["public-model"]
        );
        let error = provider
            .validate_credentials()
            .await
            .expect_err("a public catalog response must not prove authentication");

        assert!(matches!(error, ProviderError::Authentication(_)));
    }

    #[tokio::test]
    async fn authenticated_generate_probe_accepts_the_matching_key() {
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let _guard = env_lock::lock_env([("TEST_OLLAMA_CLOUD_API_KEY", Some("valid-ollama-key"))]);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": [{"name": "current-model", "model": "current-model"}]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/generate"))
            .and(header("authorization", "Bearer valid-ollama-key"))
            .and(body_json(serde_json::json!({
                "model": "current-model",
                "stream": false,
                "keep_alive": 0
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "model": "current-model",
                "done": true,
                "response": ""
            })))
            .mount(&server)
            .await;
        let provider = build_provider_with_key(server.uri());

        provider.validate_credentials().await.unwrap();
    }

    #[tokio::test]
    async fn authenticated_generate_probe_fails_closed_on_network_error() {
        let _guard = env_lock::lock_env([("TEST_OLLAMA_CLOUD_API_KEY", Some("valid-ollama-key"))]);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let provider = build_provider_with_key(format!("http://{address}"));

        let error = provider
            .validate_credentials()
            .await
            .expect_err("an unreachable credential probe must fail validation");

        assert!(matches!(error, ProviderError::NetworkError(_)));
    }

    #[tokio::test]
    async fn get_context_limit_extracts_from_flat_model_info() {
        let server = mock_show_server("gemma3", 131072).await;
        let provider = build_provider(server.uri(), Some(true), vec![]);

        let model_config = ModelConfig::new("gemma3:4b");
        let limit = provider.get_context_limit(&model_config).await.unwrap();
        assert_eq!(limit, 131072);
    }

    #[tokio::test]
    async fn get_context_limit_extracts_from_arch_prefixed_key() {
        let server = mock_show_server("qwen3moe", 262144).await;
        let provider = build_provider(server.uri(), Some(true), vec![]);

        let model_config = ModelConfig::new("qwen3-coder:480b");
        let limit = provider.get_context_limit(&model_config).await.unwrap();
        assert_eq!(limit, 262144);
    }

    #[tokio::test]
    async fn get_context_limit_falls_back_on_missing_model_info() {
        let server = mock_show_server_no_model_info().await;
        let provider = build_provider(server.uri(), Some(true), vec![]);

        let model_config = ModelConfig::new("unknown-model").with_context_limit(Some(8000));
        let limit = provider.get_context_limit(&model_config).await.unwrap();
        assert_eq!(limit, 8000);
    }

    #[tokio::test]
    async fn stalled_first_stream_item_is_retried_before_returning() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempt_counter = Arc::clone(&attempts);
        let retry_config = goose_providers::retry::RetryConfig::new(1, 0, 1.0, 0);

        let primed = tokio::time::timeout(
            Duration::from_millis(100),
            prime_ollama_cloud_stream(
                move || {
                    let attempt = attempt_counter.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if attempt == 0 {
                            Ok(Box::pin(futures::stream::pending()) as MessageStream)
                        } else {
                            let item =
                                Ok((Some(Message::assistant().with_text("recovered")), None));
                            Ok(Box::pin(futures::stream::once(async move { item }))
                                as MessageStream)
                        }
                    }
                },
                Duration::from_millis(10),
                retry_config,
            ),
        )
        .await;

        assert!(
            primed.is_ok(),
            "a stalled first stream item must time out and retry"
        );
        let (first, _) = primed.unwrap().unwrap();
        assert!(first.unwrap().unwrap().0.is_some());
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn stalled_first_stream_item_returns_network_error_after_retries() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempt_counter = Arc::clone(&attempts);
        let retry_config = goose_providers::retry::RetryConfig::new(2, 0, 1.0, 0);

        let result = prime_ollama_cloud_stream(
            move || {
                attempt_counter.fetch_add(1, Ordering::SeqCst);
                async { Ok(Box::pin(futures::stream::pending()) as MessageStream) }
            },
            Duration::from_millis(5),
            retry_config,
        )
        .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("a permanently stalled stream must return an error"),
        };

        assert!(matches!(error, ProviderError::NetworkError(_)));
        assert!(error.to_string().contains("2 retries exhausted"));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn request_timeout_is_actionable_and_does_not_expose_url_secrets() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(100)))
            .mount(&server)
            .await;
        let error = reqwest::Client::builder()
            .timeout(Duration::from_millis(5))
            .build()
            .unwrap()
            .get(format!("{}?api_key=cp05-timeout-secret", server.uri()))
            .send()
            .await
            .expect_err("the delayed response must exceed the client timeout");
        let error = ProviderError::from(error);
        let rendered = error.to_string();

        assert_eq!(error.telemetry_type(), "network");
        assert!(rendered.contains("timed out"));
        assert!(rendered.contains("check your network connection and try again"));
        assert!(!rendered.contains("cp05-timeout-secret"));
    }

    #[tokio::test]
    async fn offline_connection_is_actionable_and_classified_as_network() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        let error = reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap()
            .get(format!("http://{address}/api/tags"))
            .send()
            .await
            .expect_err("the released loopback port must refuse the connection");
        let error = ProviderError::from(error);
        let rendered = error.to_string();

        assert_eq!(error.telemetry_type(), "network");
        assert!(rendered.contains("check your network connection and try again"));
    }

    #[test]
    fn stream_timeout_defaults_to_bounded_ollama_cloud_limit() {
        let _guard = env_lock::lock_env([
            ("OLLAMA_CLOUD_STREAM_TIMEOUT", None::<&str>),
            ("GOOSE_STREAM_TIMEOUT", None::<&str>),
        ]);

        assert_eq!(
            resolve_ollama_cloud_stream_timeout(&test_config()),
            Duration::from_secs(OLLAMA_CLOUD_DEFAULT_STREAM_TIMEOUT_SECS)
        );
    }

    #[test]
    fn stream_timeout_prefers_ollama_cloud_override() {
        let _guard = env_lock::lock_env([
            ("OLLAMA_CLOUD_STREAM_TIMEOUT", Some("45")),
            ("GOOSE_STREAM_TIMEOUT", Some("90")),
        ]);

        assert_eq!(
            resolve_ollama_cloud_stream_timeout(&test_config()),
            Duration::from_secs(45)
        );
    }

    fn build_provider(
        base_url: String,
        dynamic_models: Option<bool>,
        models: Vec<ModelInfo>,
    ) -> OllamaCloudProvider {
        let config = test_config_with(base_url, dynamic_models, models);
        OllamaCloudProvider::from_custom_config(config, None).unwrap()
    }

    fn build_provider_with_key(base_url: String) -> OllamaCloudProvider {
        let mut config = test_config_with(base_url, Some(true), vec![]);
        config.api_key_env = "TEST_OLLAMA_CLOUD_API_KEY".to_string();
        config.requires_auth = true;
        OllamaCloudProvider::from_custom_config(config, None).unwrap()
    }

    async fn mock_api_server(
        model_names: Vec<&str>,
        status_override: Option<u16>,
    ) -> wiremock::MockServer {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let response = match status_override {
            Some(404) => ResponseTemplate::new(404),
            Some(status) => ResponseTemplate::new(status),
            None => {
                let models_json: Vec<serde_json::Value> = model_names
                    .iter()
                    .map(|n| serde_json::json!({"name": n, "model": n}))
                    .collect();
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"models": models_json}))
            }
        };
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(response)
            .mount(&server)
            .await;
        server
    }

    async fn mock_show_server(architecture: &str, context_length: u64) -> wiremock::MockServer {
        use wiremock::matchers::{body_partial_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let key = format!("{}.context_length", architecture);
        let model_info = serde_json::json!({
            "general.architecture": architecture,
            key: context_length,
        });
        Mock::given(method("POST"))
            .and(path("/api/show"))
            .and(body_partial_json(serde_json::json!({})))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"model_info": model_info})),
            )
            .mount(&server)
            .await;
        server
    }

    async fn mock_show_server_no_model_info() -> wiremock::MockServer {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/show"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        server
    }

    fn test_config_with(
        base_url: String,
        dynamic_models: Option<bool>,
        models: Vec<ModelInfo>,
    ) -> DeclarativeProviderConfig {
        DeclarativeProviderConfig {
            name: OLLAMA_CLOUD_PROVIDER_NAME.to_string(),
            engine: ProviderEngine::OpenAI,
            display_name: "Ollama Cloud".to_string(),
            description: None,
            api_key_env: String::new(),
            base_url,
            models,
            headers: None,
            timeout_seconds: None,
            supports_streaming: Some(true),
            requires_auth: false,
            catalog_provider_id: None,
            base_path: None,
            env_vars: None,
            dynamic_models,
            skip_canonical_filtering: false,
            model_doc_link: None,
            setup_steps: vec![],
            fast_model: None,
            preserves_thinking: true,
        }
    }

    fn test_config() -> DeclarativeProviderConfig {
        test_config_with(
            "https://ollama.com/v1/chat/completions".to_string(),
            Some(true),
            vec![],
        )
    }
}
