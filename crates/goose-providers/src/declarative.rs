#[macro_use]
mod macros;

use std::{collections::HashMap, path::Path, str::FromStr};

use anyhow::Result;
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Deserializer, Serialize};

pub static FIXED_PROVIDERS: Dir = include_dir!("$CARGO_MANIFEST_DIR/src/declarative/definitions");

pub(crate) mod declarative_providers {
    use super::*;

    expose_declarative_providers!(
        alibaba,
        atomic_chat,
        cerebras,
        deepseek,
        empiriolabs,
        fireworks,
        futurmix,
        groq,
        iflytek,
        iflytek_astron,
        inception,
        llama_swap,
        lmstudio,
        meta,
        minimax,
        mistral,
        moonshot,
        nearai,
        novita,
        nvidia,
        ollama_cloud,
        omlx,
        opencode_go,
        orcarouter,
        ovhcloud,
        perplexity,
        qwen_coding,
        routstr,
        sakana,
        saladcloud,
        scaleway,
        tanzu,
        tensorix,
        together,
        venice,
        vercel_ai_gateway,
        zai,
        zhipu,
    );
}

use crate::{
    anthropic,
    api_client::TlsConfig,
    base::{ModelInfo, Provider},
    ollama, openai,
};

pub fn fixed_provider_configs() -> anyhow::Result<Vec<DeclarativeProviderConfig>> {
    declarative_providers::fixed_provider_configs()
}

pub fn fixed_provider_config_entries() -> Vec<(&'static str, &'static str)> {
    declarative_providers::fixed_provider_config_entries()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarConfig {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub secret: bool,
    /// Defaults to the value of `required` if not specified.
    /// UIs may use this to feature this config value more prominently.
    pub primary: Option<bool>,
    pub description: Option<String>,
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderEngine {
    #[serde(alias = "openai_compatible")]
    OpenAI,
    #[serde(alias = "ollama_compatible")]
    Ollama,
    #[serde(alias = "anthropic_compatible")]
    Anthropic,
}

impl FromStr for ProviderEngine {
    type Err = anyhow::Error;

    fn from_str(engine: &str) -> Result<Self> {
        match engine.trim().to_lowercase().as_str() {
            "openai" | "openai_compatible" => Ok(Self::OpenAI),
            "anthropic" | "anthropic_compatible" => Ok(Self::Anthropic),
            "ollama" | "ollama_compatible" => Ok(Self::Ollama),
            _ => Err(anyhow::anyhow!("Invalid provider type: {}", engine)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeclarativeProviderConfig {
    pub name: String,
    pub engine: ProviderEngine,
    pub display_name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub api_key_env: String,
    pub base_url: String,
    pub models: Vec<ModelInfo>,
    pub headers: Option<HashMap<String, String>>,
    pub timeout_seconds: Option<u64>,
    pub supports_streaming: Option<bool>,
    #[serde(default = "default_requires_auth")]
    pub requires_auth: bool,
    #[serde(default)]
    pub catalog_provider_id: Option<String>,
    #[serde(default)]
    pub base_path: Option<String>,
    #[serde(default)]
    pub env_vars: Option<Vec<EnvVarConfig>>,
    /// Controls whether `fetch_supported_models` calls the provider's `/v1/models`
    /// endpoint or returns the static `models` list directly.
    ///
    /// - `Some(false)` + non-empty `models`: return the static list; no API call.
    ///   Construction fails if `models` is empty.
    /// - `Some(true)` or `None`: try the API; fall back to `models` on 404.
    #[serde(default)]
    pub dynamic_models: Option<bool>,
    #[serde(default)]
    pub skip_canonical_filtering: bool,
    #[serde(default, deserialize_with = "deserialize_non_empty_string")]
    pub model_doc_link: Option<String>,
    #[serde(default)]
    pub setup_steps: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_non_empty_string")]
    pub fast_model: Option<String>,
    #[serde(default)]
    pub preserves_thinking: bool,
}

fn default_requires_auth() -> bool {
    true
}

pub fn should_preserve_thinking_by_default(engine: &ProviderEngine) -> bool {
    matches!(engine, ProviderEngine::OpenAI)
}

/// Deserialize an optional string, treating empty/whitespace-only values as None.
fn deserialize_non_empty_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let opt: Option<String> = Option::deserialize(deserializer)?;
    Ok(opt.filter(|s| !s.trim().is_empty()))
}

impl DeclarativeProviderConfig {
    pub fn id(&self) -> &str {
        &self.name
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn models(&self) -> &[ModelInfo] {
        &self.models
    }
}

pub trait KeyResolver {
    type Error: std::error::Error + Send + Sync + 'static;

    fn resolve_key(&self, key: &str) -> std::result::Result<String, Self::Error>;
}

pub struct EnvKeyResolver;

impl EnvKeyResolver {
    pub fn new() -> Self {
        EnvKeyResolver {}
    }
}

impl Default for EnvKeyResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyResolver for EnvKeyResolver {
    type Error = std::env::VarError;

    fn resolve_key(&self, key: &str) -> std::result::Result<String, Self::Error> {
        std::env::var(key)
    }
}

fn expand_env_vars(template: &str, env_vars: &[EnvVarConfig]) -> Result<String> {
    let mut result = template.to_string();

    for var in env_vars {
        let placeholder = format!("${{{}}}", var.name);
        if !result.contains(&placeholder) {
            continue;
        }

        let value = match std::env::var(&var.name) {
            Ok(value) => value,
            Err(_) => match &var.default {
                Some(default) => default.clone(),
                None if var.required => {
                    anyhow::bail!("Required environment variable {} is not set", var.name)
                }
                None => continue,
            },
        };

        result = result.replace(&placeholder, &value);
    }

    Ok(result)
}

fn resolve_config(config: &mut DeclarativeProviderConfig) -> Result<()> {
    if let Some(env_vars) = &config.env_vars {
        config.base_url = expand_env_vars(&config.base_url, env_vars)?;

        for var in env_vars {
            if var.name.ends_with("_STREAMING") {
                let value = std::env::var(&var.name)
                    .ok()
                    .or_else(|| var.default.clone())
                    .map(|value| value.eq_ignore_ascii_case("true"));
                if let Some(value) = value {
                    config.supports_streaming = Some(value);
                }
            }
        }
    }

    Ok(())
}

pub fn deserialize_provider_config(json: &str) -> Result<DeclarativeProviderConfig> {
    let raw: serde_json::Value = serde_json::from_str(json)?;
    let preserves_thinking_was_set = raw.get("preserves_thinking").is_some();
    let mut config: DeclarativeProviderConfig = serde_json::from_value(raw)?;

    if !preserves_thinking_was_set {
        config.preserves_thinking = should_preserve_thinking_by_default(&config.engine);
    }

    Ok(config)
}

fn config_from_json(json: &str) -> Result<DeclarativeProviderConfig> {
    let mut config = deserialize_provider_config(json)?;
    resolve_config(&mut config)?;
    Ok(config)
}

pub fn load_custom_providers(dir: &Path) -> Result<Vec<DeclarativeProviderConfig>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    std::fs::read_dir(dir)?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            (path.extension()? == "json").then_some(path)
        })
        .map(|path| {
            let content = std::fs::read_to_string(&path)?;
            deserialize_provider_config(&content)
                .map_err(|e| anyhow::anyhow!("Failed to parse {}: {}", path.display(), e))
        })
        .collect()
}

fn disabled_external_identity(provider_id: &str) -> bool {
    crate::canonical::catalog::canonical_setup_provider_id(provider_id)
        .is_some_and(|canonical| matches!(canonical, "zai" | "nvidia"))
}

pub fn validate_untrusted_config(config: &DeclarativeProviderConfig) -> Result<()> {
    const UNSUPPORTED_AUTH: &str =
        "Unsupported: authenticated custom providers require a trusted credential validation contract.";
    const UNSUPPORTED_CHANNEL: &str =
        "Unsupported: unauthenticated custom providers cannot contain credential channels.";
    const DISABLED: &str = "Provider activation is disabled.";

    let parsed = crate::api_client::parse_provider_api_url(&config.base_url)
        .map_err(|_| anyhow::anyhow!("Invalid custom provider API URL."))?;
    if disabled_external_identity(&config.name)
        || config
            .catalog_provider_id
            .as_deref()
            .is_some_and(disabled_external_identity)
        || crate::api_client::has_trusted_https_origin(&config.base_url, "api.z.ai")
        || crate::api_client::has_trusted_https_origin(&config.base_url, "integrate.api.nvidia.com")
    {
        anyhow::bail!(DISABLED);
    }
    let scoped_api_key = scoped_custom_api_key_name(&config.name, &config.base_url)?;
    if config.requires_auth && config.api_key_env != scoped_api_key {
        anyhow::bail!(UNSUPPORTED_AUTH);
    }
    let headers_are_noncredential = config.headers.as_ref().is_none_or(|headers| {
        headers.keys().all(|name| {
            name.eq_ignore_ascii_case("accept") || name.eq_ignore_ascii_case("content-type")
        })
    });
    if (!config.requires_auth && !config.api_key_env.is_empty())
        || config.env_vars.is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || config
            .base_path
            .as_deref()
            .is_some_and(|path| path.contains('?') || path.contains('#'))
        || !headers_are_noncredential
    {
        anyhow::bail!(UNSUPPORTED_CHANNEL);
    }
    Ok(())
}

pub fn scoped_custom_api_key_name(provider_id: &str, api_url: &str) -> Result<String> {
    let url = crate::api_client::parse_provider_api_url(api_url)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Custom provider URL must include a host"))?;
    let mut origin = format!(
        "{}://{}",
        url.scheme().to_ascii_lowercase(),
        host.to_ascii_lowercase()
    );
    if let Some(port) = url.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    let encoded_origin = origin
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>();
    Ok(format!(
        "{}_{}_API_KEY",
        provider_id.to_ascii_uppercase(),
        encoded_origin
    ))
}

fn build_from_config(
    config: DeclarativeProviderConfig,
    tls_config: Option<TlsConfig>,
    key_resolver: impl KeyResolver,
    untrusted: bool,
) -> Result<Box<dyn Provider>> {
    if untrusted {
        validate_untrusted_config(&config)?;
    }

    match config.engine {
        ProviderEngine::OpenAI => {
            let builder = openai::from_declarative_config(config, tls_config, key_resolver)?;
            let builder = if untrusted {
                builder.try_map_api_client(|client| client.without_redirects())?
            } else {
                builder
            };
            Ok(Box::new(builder.build()))
        }
        ProviderEngine::Ollama => {
            let builder = ollama::from_declarative_config(config, tls_config, key_resolver)?;
            let builder = if untrusted {
                builder.try_map_api_client(|client| client.without_redirects())?
            } else {
                builder
            };
            Ok(Box::new(builder.build()))
        }
        ProviderEngine::Anthropic => {
            let builder = anthropic::from_declarative_config(config, tls_config, key_resolver)?;
            let builder = if untrusted {
                builder.try_map_api_client(|client| client.without_redirects())?
            } else {
                builder
            };
            Ok(Box::new(builder.build()))
        }
    }
}

/// Construct a provider from an external, untrusted declarative JSON document.
///
/// Authenticated custom configurations are accepted only when their secret name
/// is scoped to the configured origin. Accepted configurations never follow redirects.
pub fn from_untrusted_json(
    json: &str,
    tls_config: Option<TlsConfig>,
    key_resolver: impl KeyResolver,
) -> Result<Box<dyn Provider>> {
    let config = deserialize_provider_config(json)?;
    build_from_config(config, tls_config, key_resolver, true)
}

/// Backward-compatible external entry point. External callers are always
/// subject to the same untrusted declarative-provider contract.
pub fn from_json(
    json: &str,
    tls_config: Option<TlsConfig>,
    key_resolver: impl KeyResolver,
) -> Result<Box<dyn Provider>> {
    from_untrusted_json(json, tls_config, key_resolver)
}

pub(crate) fn from_trusted_json(
    json: &str,
    tls_config: Option<TlsConfig>,
    key_resolver: impl KeyResolver,
) -> Result<Box<dyn Provider>> {
    let config = config_from_json(json)?;
    build_from_config(config, tls_config, key_resolver, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;
    use std::convert::Infallible;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn model_json() -> serde_json::Value {
        json!({
            "name": "test-model",
            "context_limit": 4096,
            "input_token_cost": null,
            "output_token_cost": null,
            "currency": null,
            "supports_cache_control": null,
            "reasoning": false
        })
    }

    fn external_json(engine: &str, base_url: &str) -> serde_json::Value {
        json!({
            "name": "external-fixture",
            "engine": engine,
            "display_name": "External Fixture",
            "base_url": base_url,
            "models": [model_json()],
            "requires_auth": false,
            "dynamic_models": true
        })
    }

    #[derive(Clone)]
    struct CountingKeyResolver(Arc<AtomicUsize>);

    impl KeyResolver for CountingKeyResolver {
        type Error = Infallible;

        fn resolve_key(&self, _key: &str) -> std::result::Result<String, Self::Error> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok("local-fixture-key".to_string())
        }
    }

    #[tokio::test]
    async fn desktop102_custom_factory_does_not_retry_permanent_http_errors() {
        use crate::base::Provider;
        use crate::model::ModelConfig;
        for status in [400, 404, 422] {
            let server = wiremock::MockServer::start().await;
            wiremock::Mock::given(wiremock::matchers::method("POST"))
                .and(wiremock::matchers::path("/v1/chat/completions"))
                .respond_with(
                    wiremock::ResponseTemplate::new(status)
                        .set_body_json(json!({"error":{"message":"invalid model or request"}})),
                )
                .expect(1)
                .mount(&server)
                .await;
            let mut config = external_json("openai_compatible", &server.uri());
            config["base_path"] = json!("v1/chat/completions");
            config["supports_streaming"] = json!(false);
            let provider = from_untrusted_json(&config.to_string(), None, EnvKeyResolver).unwrap();
            let retry = Provider::retry_config(provider.as_ref());
            assert!(retry.transient_only);
            assert!(crate::retry::should_retry(
                &crate::errors::ProviderError::NetworkError("temporary".into()),
                &retry
            ));
            assert!(provider
                .stream(&ModelConfig::new("missing"), "", &[], &[])
                .await
                .is_err());
            assert_eq!(
                server.received_requests().await.unwrap().len(),
                1,
                "status {status}"
            );
        }
    }

    #[test]
    fn provider_engine_deserializes_compatible_aliases() {
        let openai: DeclarativeProviderConfig = serde_json::from_value(json!({
            "name": "test-openai",
            "engine": "openai_compatible",
            "display_name": "Test OpenAI",
            "base_url": "http://localhost:1234",
            "models": [model_json()]
        }))
        .unwrap();
        assert_eq!(openai.engine, ProviderEngine::OpenAI);

        let anthropic: DeclarativeProviderConfig = serde_json::from_value(json!({
            "name": "test-anthropic",
            "engine": "anthropic_compatible",
            "display_name": "Test Anthropic",
            "base_url": "http://localhost:1234",
            "models": [model_json()]
        }))
        .unwrap();
        assert_eq!(anthropic.engine, ProviderEngine::Anthropic);

        let ollama: DeclarativeProviderConfig = serde_json::from_value(json!({
            "name": "test-ollama",
            "engine": "ollama_compatible",
            "display_name": "Test Ollama",
            "base_url": "http://localhost:11434",
            "models": [model_json()]
        }))
        .unwrap();
        assert_eq!(ollama.engine, ProviderEngine::Ollama);
    }

    #[test]
    fn groq_json_disables_thinking_preservation() {
        let config =
            deserialize_provider_config(crate::groq::JSON).expect("groq.json should parse");

        assert!(!config.preserves_thinking);
    }

    fn placeholder_var_names(template: &str) -> Vec<String> {
        template
            .split("${")
            .skip(1)
            .filter_map(|chunk| chunk.split_once('}'))
            .map(|(name, _)| name.to_string())
            .collect()
    }

    fn validate_provider_id(id: &str) -> Result<()> {
        let mut chars = id.chars();
        let Some(first) = chars.next() else {
            anyhow::bail!("Invalid provider id: provider id cannot be empty");
        };

        if !(first.is_ascii_lowercase() || first.is_ascii_digit() || first == '_') {
            anyhow::bail!("Invalid provider id: {id}");
        }

        if chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
        {
            Ok(())
        } else {
            anyhow::bail!("Invalid provider id: {id}")
        }
    }

    #[test]
    fn expose_declarative_providers_enumerates_all_bundled_json_files() {
        let enumerated: HashSet<_> = fixed_provider_config_entries()
            .into_iter()
            .map(|(path, _)| path.to_string())
            .collect();
        let bundled: HashSet<_> = FIXED_PROVIDERS
            .files()
            .filter(|file| file.path().extension().and_then(|s| s.to_str()) == Some("json"))
            .map(|file| {
                file.path()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();

        assert_eq!(enumerated, bundled);
    }

    #[test]
    fn all_bundled_providers_are_valid() {
        let mut seen_ids = HashSet::new();

        for (path, json) in fixed_provider_config_entries() {
            let config = deserialize_provider_config(json)
                .unwrap_or_else(|e| panic!("{path} failed to parse: {e}"));

            validate_provider_id(config.id())
                .unwrap_or_else(|e| panic!("{path} has an invalid provider id: {e}"));
            assert!(
                seen_ids.insert(config.id().to_string()),
                "{path} has a duplicate provider id: {}",
                config.id()
            );
            assert!(!config.base_url.is_empty(), "{path} has an empty base_url");

            if config.dynamic_models == Some(false) {
                assert!(
                    !config.models.is_empty(),
                    "{path} disables dynamic_models but lists no static models"
                );
            }

            let declared: HashSet<&str> = config
                .env_vars
                .iter()
                .flatten()
                .map(|v| v.name.as_str())
                .collect();
            let templates = std::iter::once(config.base_url.as_str())
                .chain(config.base_path.as_deref())
                .chain(
                    config
                        .headers
                        .iter()
                        .flat_map(|h| h.values())
                        .map(String::as_str),
                );
            for template in templates {
                for var in placeholder_var_names(template) {
                    assert!(
                        declared.contains(var.as_str()),
                        "{path} references ${{{var}}} but declares no matching env_var"
                    );
                }
            }
        }

        assert!(!seen_ids.is_empty(), "no bundled providers were found");
    }

    #[test]
    fn deepseek_static_models_match_live_catalog() {
        let configs = fixed_provider_configs().expect("bundled providers should load");
        let deepseek = configs
            .iter()
            .find(|config| config.id() == "custom_deepseek")
            .expect("custom_deepseek should be bundled");

        let names: Vec<&str> = deepseek
            .models
            .iter()
            .map(|model| model.name.as_str())
            .collect();
        assert!(
            names.contains(&"deepseek-v4-flash"),
            "deepseek static models must include deepseek-v4-flash, got {names:?}"
        );
        assert!(
            !names
                .iter()
                .any(|name| *name == "deepseek-chat" || *name == "deepseek-reasoner"),
            "deepseek-chat/deepseek-reasoner were retired by DeepSeek on 2026-07-24 and must not be listed, got {names:?}"
        );
    }

    #[test]
    fn qwen_coding_bundled_definition_is_intact() {
        let configs = fixed_provider_configs().expect("bundled providers should load");
        let qwen = configs
            .iter()
            .find(|config| config.id() == "qwen_coding")
            .expect("qwen_coding should be bundled");

        assert_eq!(qwen.engine, ProviderEngine::OpenAI);
        assert_eq!(qwen.api_key_env, "QWEN_CODING_API_KEY");
        assert_eq!(qwen.base_url, "https://coding.dashscope.aliyuncs.com/v1");
        assert!(
            qwen.preserves_thinking,
            "qwen_coding must preserve thinking context"
        );

        let names: Vec<&str> = qwen.models.iter().map(|m| m.name.as_str()).collect();
        assert!(
            names.contains(&"qwen3-coder-plus"),
            "qwen_coding static models must include qwen3-coder-plus, got {names:?}"
        );
        assert!(
            !names.is_empty(),
            "qwen_coding must list at least one static model"
        );
    }

    #[test]
    fn fixed_provider_configs_are_unresolved() {
        let configs = fixed_provider_configs().expect("bundled providers should load");
        let config = configs
            .iter()
            .find(|config| config.env_vars.is_some())
            .expect("at least one bundled provider should declare env_vars");

        assert!(
            config.base_url.contains("${"),
            "{} should keep base_url placeholders unresolved",
            config.id()
        );
    }

    #[test]
    fn from_json_defaults_openai_preserves_thinking_to_true() {
        let json = json!({
            "name": "test-provider",
            "engine": "openai",
            "display_name": "Test Provider",
            "base_url": "http://localhost:1234/v1/chat/completions",
            "models": [model_json()],
            "requires_auth": false,
            "dynamic_models": false
        })
        .to_string();

        let config = config_from_json(&json).unwrap();

        assert!(config.preserves_thinking);
    }

    #[test]
    fn from_json_preserves_explicit_openai_preserves_thinking_false() {
        let json = json!({
            "name": "test-provider",
            "engine": "openai",
            "display_name": "Test Provider",
            "base_url": "http://localhost:1234/v1/chat/completions",
            "models": [model_json()],
            "requires_auth": false,
            "dynamic_models": false,
            "preserves_thinking": false
        })
        .to_string();

        let config = config_from_json(&json).unwrap();

        assert!(!config.preserves_thinking);
    }

    #[test]
    fn from_json_expands_base_url_from_env_var_default() {
        let _guard = env_lock::lock_env([("TEST_PROVIDER_HOST", None::<&str>)]);
        let json = json!({
            "name": "test-provider",
            "engine": "openai",
            "display_name": "Test Provider",
            "base_url": "${TEST_PROVIDER_HOST}/v1/chat/completions",
            "models": [model_json()],
            "requires_auth": false,
            "dynamic_models": false,
            "env_vars": [{
                "name": "TEST_PROVIDER_HOST",
                "default": "http://localhost:1234"
            }]
        })
        .to_string();

        let provider = from_trusted_json(&json, None, EnvKeyResolver).unwrap();

        assert_eq!(provider.get_name(), "test-provider");
    }

    #[tokio::test]
    async fn from_json_ollama_returns_static_models_when_dynamic_models_false() {
        let json = json!({
            "name": "test-ollama",
            "engine": "ollama",
            "display_name": "Test Ollama",
            "base_url": "http://localhost:11434",
            "models": [model_json()],
            "requires_auth": false,
            "dynamic_models": false
        })
        .to_string();

        let provider = from_trusted_json(&json, None, EnvKeyResolver).unwrap();

        assert_eq!(
            provider.fetch_supported_models().await.unwrap(),
            vec!["test-model".to_string()]
        );
    }

    #[test]
    fn from_json_errors_when_required_env_var_is_missing() {
        let _guard = env_lock::lock_env([("TEST_PROVIDER_REQUIRED_HOST", None::<&str>)]);
        let json = json!({
            "name": "test-provider",
            "engine": "openai",
            "display_name": "Test Provider",
            "base_url": "${TEST_PROVIDER_REQUIRED_HOST}/v1/chat/completions",
            "models": [model_json()],
            "requires_auth": false,
            "dynamic_models": false,
            "env_vars": [{
                "name": "TEST_PROVIDER_REQUIRED_HOST",
                "required": true
            }]
        })
        .to_string();

        let err = match from_trusted_json(&json, None, EnvKeyResolver) {
            Ok(_) => panic!("expected missing required env var error"),
            Err(err) => err,
        };

        assert!(err
            .to_string()
            .contains("Required environment variable TEST_PROVIDER_REQUIRED_HOST is not set"));
    }

    #[test]
    fn external_json_accepts_authenticated_engines_with_an_origin_scoped_key() {
        for engine in ["openai", "ollama", "anthropic"] {
            let mut config = external_json(engine, "https://example.invalid/v1");
            config["requires_auth"] = json!(true);
            config["dynamic_models"] = json!(false);
            config["api_key_env"] = json!(scoped_custom_api_key_name(
                "external-fixture",
                "https://example.invalid/v1"
            )
            .unwrap());
            let resolutions = Arc::new(AtomicUsize::new(0));

            from_untrusted_json(
                &config.to_string(),
                None,
                CountingKeyResolver(resolutions.clone()),
            )
            .unwrap_or_else(|error| panic!("scoped authenticated {engine} config failed: {error}"));

            assert_eq!(resolutions.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn external_json_rejects_an_authenticated_key_scoped_to_another_origin() {
        let mut config = external_json("openai", "https://example.invalid/v1");
        config["requires_auth"] = json!(true);
        config["dynamic_models"] = json!(false);
        config["api_key_env"] =
            json!(
                scoped_custom_api_key_name("external-fixture", "https://other.invalid/v1").unwrap()
            );
        let resolutions = Arc::new(AtomicUsize::new(0));

        let error = match from_untrusted_json(
            &config.to_string(),
            None,
            CountingKeyResolver(resolutions.clone()),
        ) {
            Ok(_) => panic!("a key scoped to another origin must fail closed"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("authenticated custom providers"));
        assert_eq!(resolutions.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn scoped_custom_key_changes_with_origin_but_not_path() {
        let first = scoped_custom_api_key_name("custom_demo", "https://Example.COM/v1").unwrap();
        let same_origin =
            scoped_custom_api_key_name("custom_demo", "https://example.com/v1/chat/completions")
                .unwrap();
        let other_origin =
            scoped_custom_api_key_name("custom_demo", "https://example.com:8443/v1").unwrap();

        assert_eq!(first, same_origin);
        assert_ne!(first, other_origin);
        assert!(first.starts_with("CUSTOM_DEMO_"));
        assert!(first.ends_with("_API_KEY"));
    }

    #[test]
    fn external_json_rejects_disabled_identity_alias_and_origin() {
        let mut cases = Vec::new();
        let mut name_alias = external_json("openai", "https://example.invalid/v1");
        name_alias["name"] = json!(" Z.AI ");
        cases.push(name_alias);
        let mut catalog_alias = external_json("ollama", "https://example.invalid/v1");
        catalog_alias["catalog_provider_id"] = json!(" nViDiA ");
        cases.push(catalog_alias);
        cases.push(external_json("anthropic", "https://api.z.ai/v1"));
        cases.push(external_json(
            "openai",
            "https://integrate.api.nvidia.com/v1",
        ));

        for config in cases {
            let error = match from_untrusted_json(&config.to_string(), None, EnvKeyResolver) {
                Ok(_) => panic!("disabled external identity or origin must fail closed"),
                Err(error) => error,
            };
            assert_eq!(error.to_string(), "Provider activation is disabled.");
        }
    }

    #[test]
    fn external_json_rejects_every_credential_and_dynamic_channel() {
        let mut cases = Vec::new();
        let mut api_key = external_json("openai", "https://example.invalid/v1");
        api_key["api_key_env"] = json!("EXTERNAL_FIXTURE_KEY");
        cases.push(api_key);
        let mut header = external_json("ollama", "https://example.invalid/v1");
        header["headers"] = json!({"Authorization": "Bearer local-fixture-key"});
        cases.push(header);
        cases.push(external_json(
            "anthropic",
            "https://example.invalid/v1?api_key=local-fixture-key",
        ));
        let mut base_path = external_json("openai", "https://example.invalid/v1");
        base_path["base_path"] = json!("v1/chat/completions?token=fixture");
        cases.push(base_path);
        let mut dynamic = external_json("openai", "https://example.invalid/v1");
        dynamic["env_vars"] = json!([{
            "name": "SUFFIX",
            "default": "?api_key=local-fixture-key"
        }]);
        cases.push(dynamic);

        for config in cases {
            let error = match from_untrusted_json(&config.to_string(), None, EnvKeyResolver) {
                Ok(_) => panic!("external credential channel must fail closed"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("credential channels"));
        }
    }

    #[test]
    fn external_json_rejects_whitespace_key_names_before_key_resolution() {
        for engine in ["openai", "ollama", "anthropic"] {
            let mut config = external_json(engine, "https://example.invalid/v1");
            config["api_key_env"] = json!("   \t");
            let resolutions = Arc::new(AtomicUsize::new(0));

            let error = match from_untrusted_json(
                &config.to_string(),
                None,
                CountingKeyResolver(resolutions.clone()),
            ) {
                Ok(_) => panic!("whitespace key names must fail closed"),
                Err(error) => error,
            };

            assert!(error.to_string().contains("credential channels"));
            assert_eq!(resolutions.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn external_json_disables_redirects_for_every_engine() {
        for (engine, source_path) in [
            ("openai", "/v1/models"),
            ("ollama", "/api/tags"),
            ("anthropic", "/v1/models"),
        ] {
            let target = wiremock::MockServer::start().await;
            wiremock::Mock::given(wiremock::matchers::method("GET"))
                .respond_with(wiremock::ResponseTemplate::new(200))
                .expect(0)
                .mount(&target)
                .await;
            let source = wiremock::MockServer::start().await;
            wiremock::Mock::given(wiremock::matchers::method("GET"))
                .and(wiremock::matchers::path(source_path))
                .respond_with(
                    wiremock::ResponseTemplate::new(302)
                        .insert_header("Location", format!("{}/target", target.uri())),
                )
                .expect(1)
                .mount(&source)
                .await;
            let provider = from_untrusted_json(
                &external_json(engine, &source.uri()).to_string(),
                None,
                EnvKeyResolver,
            )
            .unwrap();

            assert!(provider.fetch_supported_models().await.is_err());
            source.verify().await;
            target.verify().await;
        }
    }
}
