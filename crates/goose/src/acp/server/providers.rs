use super::*;
use crate::config::declarative_providers;
use crate::providers::inventory::ensure_refresh_identity_current;
use crate::providers::provider_secrets;
use std::str::FromStr;
use std::time::Duration;

const CUSTOM_PROVIDER_DISCOVERY_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

fn routing_after_provider_change(
    routing: &CodeProModelRoutingConfig,
    provider_id: &str,
    available_models: Option<&[String]>,
) -> Option<CodeProModelRoutingConfig> {
    if !routing.advanced_routing_enabled {
        return None;
    }
    let has_stale_route = routing.routes.iter().any(|route| {
        route.provider_id == provider_id
            && available_models
                .map(|models| !models.contains(&route.model_id))
                .unwrap_or(true)
    });
    has_stale_route.then(|| CodeProModelRoutingConfig {
        advanced_routing_enabled: false,
        ..routing.clone()
    })
}

pub(super) fn ensure_provider_credential_activation_supported(
    metadata: &goose_providers::base::ProviderMetadata,
) -> Result<(), agent_client_protocol::Error> {
    if let Some(key) = metadata.config_keys.iter().find(|key| {
        key.primary && key.secret && !key.oauth_flow && !key.credential_validation_supported
    }) {
        return Err(agent_client_protocol::Error::invalid_params().data(
            key.credential_validation_unavailable_reason
                .as_deref()
                .unwrap_or("Credential pre-validation is not supported for this provider."),
        ));
    }
    Ok(())
}

pub(super) async fn ensure_generic_config_key_is_not_provider_owned(
    key: &str,
) -> Result<(), agent_client_protocol::Error> {
    if provider_owned_config_keys()
        .await
        .iter()
        .any(|owned| owned.eq_ignore_ascii_case(key))
    {
        return Err(agent_client_protocol::Error::invalid_params().data(
            "Provider configuration must be changed through the dedicated provider configuration APIs",
        ));
    }
    Ok(())
}

pub(super) async fn provider_owned_config_keys() -> Vec<String> {
    const PROVIDER_STATE_KEYS: &[&str] = &[
        "GOOSE_PROVIDER",
        "GOOSE_MODEL",
        "active_provider",
        "providers",
        CODEPRO_MODEL_ROUTING_CONFIG_KEY,
        MODEL_CAPABILITY_OVERRIDES_CONFIG_KEY,
    ];
    let mut keys = PROVIDER_STATE_KEYS
        .iter()
        .map(|key| (*key).to_string())
        .collect::<Vec<_>>();
    for (metadata, _) in crate::providers::providers().await {
        keys.extend(metadata.config_keys.into_iter().map(|entry| entry.name));
    }
    keys.sort();
    keys.dedup();
    keys
}

fn provider_secret_to_dto(secret: provider_secrets::ProviderSecret) -> ProviderSecretDto {
    let storage = match secret.storage {
        provider_secrets::ProviderSecretStorage::SecretStore => {
            ProviderSecretStorageDto::SecretStore
        }
        provider_secrets::ProviderSecretStorage::ProviderCache => {
            ProviderSecretStorageDto::ProviderCache
        }
    };
    let status = match secret.status {
        provider_secrets::ProviderSecretStatus::Valid => ProviderSecretStatusDto::Valid,
        provider_secrets::ProviderSecretStatus::Expired => ProviderSecretStatusDto::Expired,
        provider_secrets::ProviderSecretStatus::Unknown => ProviderSecretStatusDto::Unknown,
    };
    ProviderSecretDto {
        id: secret.id,
        provider: secret.provider,
        provider_display_name: secret.provider_display_name,
        name: secret.name,
        storage,
        expires_at: secret.expires_at.map(|value| value.to_rfc3339()),
        status,
        configured: secret.configured,
        has_secret: secret.has_secret,
        can_delete: secret.can_delete,
        can_configure: secret.can_configure,
        configure_provider: secret.configure_provider,
    }
}

fn inventory_entry_to_dto(entry: ProviderInventoryEntry) -> ProviderInventoryEntryDto {
    let stale = ProviderInventoryService::is_stale(&entry);
    ProviderInventoryEntryDto {
        provider_id: entry.provider_id,
        provider_name: entry.provider_name,
        description: entry.description,
        default_model: entry.default_model,
        configured: entry.configured,
        provider_type: format!("{:?}", entry.provider_type),
        category: provider_setup_category_to_dto(entry.category),
        config_keys: entry
            .config_keys
            .into_iter()
            .map(provider_config_key_to_dto)
            .collect(),
        setup_steps: entry.setup_steps,
        supports_refresh: entry.supports_refresh,
        refreshing: entry.refreshing,
        models: entry
            .models
            .into_iter()
            .map(|m| ProviderInventoryModelDto {
                id: m.id,
                name: m.name,
                family: m.family,
                context_limit: m.context_limit,
                reasoning: m.reasoning,
                recommended: m.recommended,
            })
            .collect(),
        last_updated_at: entry.last_updated_at.map(|t| t.to_rfc3339()),
        last_refresh_attempt_at: entry.last_refresh_attempt_at.map(|t| t.to_rfc3339()),
        last_refresh_error: entry.last_refresh_error,
        stale,
        model_selection_hint: entry.model_selection_hint,
    }
}

fn provider_config_key_to_dto(key: crate::providers::base::ConfigKey) -> ProviderConfigKey {
    ProviderConfigKey {
        name: key.name,
        required: key.required,
        secret: key.secret,
        default: key.default,
        oauth_flow: key.oauth_flow,
        device_code_flow: key.device_code_flow,
        primary: key.primary,
        credential_validation_supported: key.credential_validation_supported,
        credential_validation_unavailable_reason: key
            .credential_validation_unavailable_reason
            .unwrap_or_default(),
    }
}

const SECRET_MASK_PREFIX_LEN: usize = 4;
const SECRET_MASK_SUFFIX_LEN: usize = 3;
const SECRET_MASK_FALLBACK: &str = "***";

fn mask_secret_value(value: &str) -> String {
    let prefix: String = value.chars().take(SECRET_MASK_PREFIX_LEN).collect();
    let suffix_chars: Vec<char> = value.chars().rev().take(SECRET_MASK_SUFFIX_LEN).collect();
    let suffix: String = suffix_chars.into_iter().rev().collect();

    if prefix.is_empty()
        || suffix.is_empty()
        || value.chars().count() <= SECRET_MASK_PREFIX_LEN + SECRET_MASK_SUFFIX_LEN
    {
        return SECRET_MASK_FALLBACK.to_string();
    }

    format!("{prefix}...{suffix}")
}

fn config_value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(value) if value.is_empty() => None,
        serde_json::Value::String(value) => Some(value.clone()),
        other => serde_json::to_string(other).ok(),
    }
}

fn provider_config_field_value(
    config: &Config,
    key: &crate::providers::base::ConfigKey,
    secrets: Option<&HashMap<String, serde_json::Value>>,
) -> ProviderConfigFieldValueDto {
    let value = if key.secret {
        std::env::var(key.name.to_uppercase()).ok().or_else(|| {
            secrets
                .and_then(|values| values.get(&key.name))
                .and_then(config_value_to_string)
        })
    } else {
        config
            .get_param::<serde_json::Value>(&key.name)
            .ok()
            .and_then(|value| config_value_to_string(&value))
    };

    ProviderConfigFieldValueDto {
        key: key.name.clone(),
        value: value.as_deref().map(|value| {
            if key.secret {
                mask_secret_value(value)
            } else {
                value.to_string()
            }
        }),
        is_set: value.is_some(),
        is_secret: key.secret,
        required: key.required,
    }
}

fn provider_catalog_entry_to_dto(
    entry: crate::providers::catalog::ProviderCatalogEntry,
) -> ProviderTemplateCatalogEntryDto {
    let disabled_reason = crate::providers::activation_disabled_reason(&entry.id)
        .unwrap_or(crate::providers::UNSUPPORTED_CUSTOM_CREDENTIAL_REASON);
    ProviderTemplateCatalogEntryDto {
        provider_id: entry.id,
        name: entry.name,
        format: entry.format,
        api_url: entry.api_url,
        model_count: entry.model_count,
        doc_url: entry.doc_url,
        env_var: entry.env_var,
        enabled: false,
        disabled_reason: Some(disabled_reason.to_string()),
    }
}

fn provider_setup_category_to_dto(
    category: crate::providers::catalog::ProviderSetupCategory,
) -> ProviderSetupCategoryDto {
    match category {
        crate::providers::catalog::ProviderSetupCategory::Agent => ProviderSetupCategoryDto::Agent,
        crate::providers::catalog::ProviderSetupCategory::Model => ProviderSetupCategoryDto::Model,
    }
}

fn provider_setup_method_to_dto(
    method: crate::providers::catalog::ProviderSetupMethod,
) -> ProviderSetupMethodDto {
    match method {
        crate::providers::catalog::ProviderSetupMethod::None => ProviderSetupMethodDto::None,
        crate::providers::catalog::ProviderSetupMethod::Disabled => {
            ProviderSetupMethodDto::Disabled
        }
        crate::providers::catalog::ProviderSetupMethod::SingleApiKey => {
            ProviderSetupMethodDto::SingleApiKey
        }
        crate::providers::catalog::ProviderSetupMethod::ConfigFields => {
            ProviderSetupMethodDto::ConfigFields
        }
        crate::providers::catalog::ProviderSetupMethod::HostWithOauthFallback => {
            ProviderSetupMethodDto::HostWithOauthFallback
        }
        crate::providers::catalog::ProviderSetupMethod::OauthBrowser => {
            ProviderSetupMethodDto::OauthBrowser
        }
        crate::providers::catalog::ProviderSetupMethod::OauthDeviceCode => {
            ProviderSetupMethodDto::OauthDeviceCode
        }
        crate::providers::catalog::ProviderSetupMethod::CloudCredentials => {
            ProviderSetupMethodDto::CloudCredentials
        }
        crate::providers::catalog::ProviderSetupMethod::Local => ProviderSetupMethodDto::Local,
        crate::providers::catalog::ProviderSetupMethod::CliAuth => ProviderSetupMethodDto::CliAuth,
    }
}

fn provider_setup_group_to_dto(
    group: crate::providers::catalog::ProviderSetupGroup,
) -> ProviderSetupGroupDto {
    match group {
        crate::providers::catalog::ProviderSetupGroup::Default => ProviderSetupGroupDto::Default,
        crate::providers::catalog::ProviderSetupGroup::Additional => {
            ProviderSetupGroupDto::Additional
        }
    }
}

fn provider_setup_entry_to_dto(
    entry: crate::providers::catalog::ProviderSetupCatalogEntry,
) -> ProviderSetupCatalogEntryDto {
    ProviderSetupCatalogEntryDto {
        provider_id: entry.provider_id,
        name: entry.display_name,
        category: provider_setup_category_to_dto(entry.category),
        description: entry.description,
        setup_method: provider_setup_method_to_dto(entry.setup_method),
        enabled: entry.enabled,
        disabled_reason: entry.disabled_reason,
        native_connect_query: entry.native_connect_query,
        fields: entry
            .fields
            .into_iter()
            .map(|field| ProviderSetupFieldDto {
                key: field.key,
                label: field.label,
                secret: field.secret,
                required: field.required,
                placeholder: field.placeholder,
                default_value: field.default_value,
            })
            .collect(),
        binary_name: entry.binary_name,
        doc_url: entry.docs_url,
        group: provider_setup_group_to_dto(entry.group),
        show_only_when_installed: entry.show_only_when_installed,
        aliases: entry.aliases,
        supports_install: entry.setup_capabilities.install,
        supports_auth: entry.setup_capabilities.auth,
        supports_auth_status: entry.setup_capabilities.auth_status,
    }
}

fn provider_template_to_dto(
    template: crate::providers::catalog::ProviderTemplate,
) -> ProviderTemplateDto {
    ProviderTemplateDto {
        provider_id: template.id,
        name: template.name,
        format: template.format,
        api_url: template.api_url,
        models: template
            .models
            .into_iter()
            .map(|model| ProviderTemplateModelDto {
                id: model.id,
                name: model.name,
                context_limit: model.context_limit,
                capabilities: ProviderTemplateCapabilitiesDto {
                    tool_call: model.capabilities.tool_call,
                    reasoning: model.capabilities.reasoning,
                    attachment: model.capabilities.attachment,
                    temperature: model.capabilities.temperature,
                },
                deprecated: model.deprecated,
            })
            .collect(),
        supports_streaming: template.supports_streaming,
        env_var: template.env_var,
        doc_url: template.doc_url,
    }
}

fn provider_catalog_template_for_client(
    provider_id: &str,
) -> Result<crate::providers::catalog::ProviderTemplate, agent_client_protocol::Error> {
    let _template =
        crate::providers::catalog::get_provider_template(provider_id).ok_or_else(|| {
            agent_client_protocol::Error::invalid_params()
                .data(format!("Unknown catalog provider: {provider_id}"))
        })?;
    let reason = crate::providers::activation_disabled_reason(provider_id)
        .unwrap_or(crate::providers::UNSUPPORTED_CUSTOM_CREDENTIAL_REASON);
    Err(agent_client_protocol::Error::invalid_params().data(reason))
}

fn custom_provider_engine_to_dto(engine: &declarative_providers::ProviderEngine) -> &'static str {
    match engine {
        declarative_providers::ProviderEngine::OpenAI => "openai_compatible",
        declarative_providers::ProviderEngine::Anthropic => "anthropic_compatible",
        declarative_providers::ProviderEngine::Ollama => "ollama_compatible",
    }
}

fn normalize_custom_provider_engine(engine: &str) -> Result<String, agent_client_protocol::Error> {
    let engine = engine.trim().to_lowercase();
    if declarative_providers::ProviderEngine::from_str(&engine).is_err() {
        return Err(agent_client_protocol::Error::invalid_params()
            .data(format!("Unsupported custom provider engine: {engine}")));
    }

    match engine.as_str() {
        "openai" | "openai_compatible" => Ok("openai_compatible".to_string()),
        "anthropic" | "anthropic_compatible" => Ok("anthropic_compatible".to_string()),
        "ollama" | "ollama_compatible" => Ok("ollama_compatible".to_string()),
        _ => unreachable!("provider engine was validated above"),
    }
}

fn non_empty_trimmed(value: String, field: &str) -> Result<String, agent_client_protocol::Error> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(
            agent_client_protocol::Error::invalid_params().data(format!("{field} cannot be empty"))
        );
    }
    Ok(value)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn normalize_custom_provider_upsert(
    mut provider: CustomProviderUpsertDto,
) -> Result<CustomProviderUpsertDto, agent_client_protocol::Error> {
    provider.engine = normalize_custom_provider_engine(&provider.engine)?;
    provider.display_name = non_empty_trimmed(provider.display_name, "displayName")?;
    provider.api_url = non_empty_trimmed(provider.api_url, "apiUrl")?;
    let url =
        goose_providers::api_client::parse_provider_api_url(&provider.api_url).map_err(|_| {
            agent_client_protocol::Error::invalid_params()
                .data(crate::providers::INVALID_CUSTOM_PROVIDER_URL_REASON)
        })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(
            agent_client_protocol::Error::invalid_params().data("apiUrl must use HTTP or HTTPS")
        );
    }

    provider.api_key = provider.api_key.and_then(|api_key| {
        let api_key = api_key.trim().to_string();
        (!api_key.is_empty()).then_some(api_key)
    });
    provider.models = provider
        .models
        .into_iter()
        .filter_map(|model| {
            let model = model.trim().to_string();
            (!model.is_empty()).then_some(model)
        })
        .collect();
    if provider.models.is_empty() {
        return Err(agent_client_protocol::Error::invalid_params().data("models cannot be empty"));
    }

    provider.headers = provider
        .headers
        .into_iter()
        .map(|(key, value)| {
            let key = key.trim().to_string();
            let value = value.trim().to_string();
            if key.is_empty() {
                return Ok(None);
            }
            reqwest::header::HeaderName::from_bytes(key.as_bytes()).map_err(|_| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("Invalid header name: {key}"))
            })?;
            reqwest::header::HeaderValue::from_str(&value).map_err(|_| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("Invalid header value for: {key}"))
            })?;
            Ok(Some((key, value)))
        })
        .collect::<Result<Vec<_>, agent_client_protocol::Error>>()?
        .into_iter()
        .flatten()
        .collect();
    provider.base_path = normalize_optional_string(provider.base_path);
    provider.catalog_provider_id = normalize_optional_string(provider.catalog_provider_id);
    crate::providers::validate_custom_provider_contract(
        provider.catalog_provider_id.as_deref(),
        &provider.api_url,
        Some(&provider.headers),
        provider.requires_auth,
        provider.api_key.is_some(),
        provider.base_path.as_deref(),
    )
    .map_err(|reason| agent_client_protocol::Error::invalid_params().data(reason))?;
    Ok(provider)
}

fn custom_provider_discovery_url(
    engine: &str,
    api_url: &str,
    base_path: Option<&str>,
) -> Result<url::Url, agent_client_protocol::Error> {
    let engine = normalize_custom_provider_engine(engine)?;
    let mut url = goose_providers::api_client::parse_provider_api_url(api_url).map_err(|_| {
        agent_client_protocol::Error::invalid_params()
            .data(crate::providers::INVALID_CUSTOM_PROVIDER_URL_REASON)
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(
            agent_client_protocol::Error::invalid_params().data("apiUrl must use HTTP or HTTPS")
        );
    }

    let configured_path = base_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| url.path());
    let path = configured_path.trim_matches('/');
    let append_path = |suffix: &str| {
        if path.is_empty() {
            format!("/{suffix}")
        } else {
            format!("/{path}/{suffix}")
        }
    };
    let discovery_path = if engine == "ollama_compatible" {
        if path.ends_with("api") {
            format!("/{path}/tags")
        } else {
            "/api/tags".to_string()
        }
    } else if path.ends_with("chat/completions") {
        format!("/{}", path.replacen("chat/completions", "models", 1))
    } else if path.ends_with("responses") {
        format!("/{}", path.replacen("responses", "models", 1))
    } else if path.ends_with("v1") {
        append_path("models")
    } else {
        append_path("v1/models")
    };
    url.set_path(&discovery_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn custom_provider_completion_url(
    api_url: &str,
    base_path: Option<&str>,
) -> Result<url::Url, agent_client_protocol::Error> {
    let mut url = goose_providers::api_client::parse_provider_api_url(api_url).map_err(|_| {
        agent_client_protocol::Error::invalid_params()
            .data(crate::providers::INVALID_CUSTOM_PROVIDER_URL_REASON)
    })?;
    let configured_path = base_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| url.path());
    let path = configured_path.trim_matches('/');
    let append_path = |suffix: &str| {
        if path.is_empty() {
            format!("/{suffix}")
        } else {
            format!("/{path}/{suffix}")
        }
    };
    let completion_path = if path.ends_with("chat/completions") || path.ends_with("responses") {
        format!("/{path}")
    } else if path.ends_with("v1") {
        append_path("chat/completions")
    } else {
        append_path("v1/chat/completions")
    };
    url.set_path(&completion_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn custom_provider_error(code: &str, message: &str) -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_params().data(serde_json::json!({
        "code": code,
        "message": message,
    }))
}

fn custom_provider_request(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: url::Url,
    api_key: Option<&str>,
    headers: &HashMap<String, String>,
) -> Result<reqwest::RequestBuilder, agent_client_protocol::Error> {
    let mut request = client.request(method, url);
    if let Some(api_key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    for (name, value) in headers {
        let name =
            reqwest::header::HeaderName::from_bytes(name.trim().as_bytes()).map_err(|_| {
                custom_provider_error(
                    "custom_provider_invalid_header",
                    "A custom header name is invalid.",
                )
            })?;
        let value = reqwest::header::HeaderValue::from_str(value.trim()).map_err(|_| {
            custom_provider_error(
                "custom_provider_invalid_header",
                "A custom header value is invalid.",
            )
        })?;
        request = request.header(name, value);
    }
    Ok(request)
}

async fn validate_custom_provider_credentials(
    client: &reqwest::Client,
    completion_url: url::Url,
    model: &str,
    api_key: Option<&str>,
    headers: &HashMap<String, String>,
) -> Result<(), agent_client_protocol::Error> {
    let api_key = api_key.map(str::trim).filter(|key| !key.is_empty());
    let uses_responses_api = completion_url.path().ends_with("/responses");
    let payload = if uses_responses_api {
        serde_json::json!({
            "model": model,
            "input": "Reply OK.",
            "max_output_tokens": 1,
            "stream": false,
        })
    } else {
        serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": "Reply OK." }],
            "max_tokens": 1,
            "stream": false,
        })
    };
    let authenticated = custom_provider_request(
        client,
        reqwest::Method::POST,
        completion_url,
        api_key,
        headers,
    )?
    .json(&payload)
    .send()
    .await
    .map_err(|error| {
        tracing::warn!(
            error = ?error.without_url(),
            "Custom provider completion validation request failed"
        );
        custom_provider_error(
            "custom_provider_endpoint_unreachable",
            "Could not reach the model endpoint.",
        )
    })?;
    if matches!(authenticated.status().as_u16(), 401 | 403) {
        return Err(custom_provider_error(
            "custom_provider_invalid_credentials",
            "The API key was rejected.",
        ));
    }
    if !authenticated.status().is_success() {
        return Err(custom_provider_error(
            "custom_provider_model_unavailable",
            "The selected model could not complete a test request.",
        ));
    }
    if authenticated.content_length().unwrap_or(0) > CUSTOM_PROVIDER_DISCOVERY_RESPONSE_LIMIT as u64
    {
        return Err(custom_provider_error(
            "custom_provider_response_too_large",
            "The model endpoint returned too much data.",
        ));
    }
    let body = authenticated.bytes().await.map_err(|_| {
        custom_provider_error(
            "custom_provider_invalid_response",
            "The model endpoint returned an unreadable response.",
        )
    })?;
    if body.len() > CUSTOM_PROVIDER_DISCOVERY_RESPONSE_LIMIT {
        return Err(custom_provider_error(
            "custom_provider_response_too_large",
            "The model endpoint returned too much data.",
        ));
    }
    let response: serde_json::Value = serde_json::from_slice(&body).map_err(|_| {
        custom_provider_error(
            "custom_provider_invalid_response",
            "The model endpoint did not return a valid response.",
        )
    })?;
    let completed = if uses_responses_api {
        response
            .get("output")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|output| !output.is_empty())
            || response
                .get("output_text")
                .and_then(serde_json::Value::as_str)
                .is_some()
    } else {
        response
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|choices| !choices.is_empty())
    };
    if !completed {
        return Err(custom_provider_error(
            "custom_provider_model_unavailable",
            "The selected model did not return a usable response.",
        ));
    }

    Ok(())
}

fn custom_provider_validation_client() -> reqwest::ClientBuilder {
    // DNS/TLS can exceed three seconds on a working cloud connection. Keep the
    // complete request bounded instead of rejecting it before that budget elapses.
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
}

async fn discover_and_validate_custom_provider(
    engine: &str,
    api_url: &str,
    base_path: Option<&str>,
    api_key: Option<&str>,
    headers: &HashMap<String, String>,
    preferred_model: Option<&str>,
) -> Result<Vec<String>, agent_client_protocol::Error> {
    let discovery_url = custom_provider_discovery_url(engine, api_url, base_path)?;
    let client = custom_provider_validation_client()
        .build()
        .map_err(|_| agent_client_protocol::Error::internal_error())?;
    let response = custom_provider_request(
        &client,
        reqwest::Method::GET,
        discovery_url,
        api_key,
        headers,
    )?
    .send()
    .await
    .map_err(|error| {
        tracing::warn!(
            error = ?error.without_url(),
            "Custom provider model discovery request failed"
        );
        custom_provider_error(
            "custom_provider_endpoint_unreachable",
            "Could not reach the model endpoint.",
        )
    })?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(custom_provider_error(
            "custom_provider_invalid_credentials",
            "The API key was rejected.",
        ));
    }
    if !response.status().is_success() {
        return Err(custom_provider_error(
            "custom_provider_model_list_unavailable",
            "The model list could not be loaded from this address.",
        ));
    }
    if response.content_length().unwrap_or(0) > CUSTOM_PROVIDER_DISCOVERY_RESPONSE_LIMIT as u64 {
        return Err(custom_provider_error(
            "custom_provider_response_too_large",
            "The model endpoint returned too much data.",
        ));
    }
    let body = response.bytes().await.map_err(|_| {
        custom_provider_error(
            "custom_provider_invalid_response",
            "The model endpoint returned an unreadable response.",
        )
    })?;
    if body.len() > CUSTOM_PROVIDER_DISCOVERY_RESPONSE_LIMIT {
        return Err(custom_provider_error(
            "custom_provider_response_too_large",
            "The model endpoint returned too much data.",
        ));
    }
    let value = serde_json::from_slice(&body).map_err(|_| {
        custom_provider_error(
            "custom_provider_invalid_response",
            "The model endpoint did not return valid JSON.",
        )
    })?;
    let models = parse_discovered_model_ids(engine, value)?;
    if let Some(model) = preferred_model {
        if !models.iter().any(|candidate| candidate == model) {
            return Err(custom_provider_error(
                "custom_provider_model_unavailable",
                "The selected model is not available from this connection.",
            ));
        }
        validate_custom_provider_credentials(
            &client,
            custom_provider_completion_url(api_url, base_path)?,
            model,
            api_key,
            headers,
        )
        .await?;
    }
    Ok(models)
}

pub(super) async fn validate_saved_custom_provider_models(
    provider_id: &str,
    requested_models: &[String],
) -> Result<bool, agent_client_protocol::Error> {
    let loaded = match declarative_providers::load_provider(provider_id) {
        Ok(loaded) if loaded.is_editable => loaded,
        Ok(_) | Err(_) => return Ok(false),
    };
    let config = loaded.config;
    let api_key = if config.requires_auth {
        let api_key = stored_custom_provider_api_key(provider_id, &config.base_url)?;
        if api_key.is_none() {
            return Err(custom_provider_error(
                "custom_provider_api_key_required",
                "An API key is required for this connection.",
            ));
        }
        api_key
    } else {
        None
    };
    let headers = config.headers.unwrap_or_default();
    let discovered_models = discover_and_validate_custom_provider(
        custom_provider_engine_to_dto(&config.engine),
        &config.base_url,
        config.base_path.as_deref(),
        api_key.as_deref(),
        &headers,
        requested_models.first().map(String::as_str),
    )
    .await?;
    if !requested_models
        .iter()
        .all(|model| discovered_models.contains(model))
    {
        return Err(custom_provider_error(
            "custom_provider_model_unavailable",
            "One or more selected models are no longer available.",
        ));
    }
    Ok(true)
}

fn parse_discovered_model_ids(
    engine: &str,
    value: serde_json::Value,
) -> Result<Vec<String>, agent_client_protocol::Error> {
    let candidates = if normalize_custom_provider_engine(engine)? == "ollama_compatible" {
        value
            .get("models")
            .and_then(serde_json::Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model.get("name").or_else(|| model.get("model")))
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
            })
    } else {
        value
            .get("data")
            .and_then(serde_json::Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| model.get("id"))
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
            })
    }
    .ok_or_else(|| {
        custom_provider_error(
            "custom_provider_invalid_response",
            "The endpoint returned an unsupported model list.",
        )
    })?;

    let mut models = candidates
        .into_iter()
        .map(str::trim)
        .filter(|model| !model.is_empty() && model.len() <= 512)
        .map(str::to_string)
        .take(1_000)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err(custom_provider_error(
            "custom_provider_no_models",
            "The service is reachable, but it has no models available.",
        ));
    }
    Ok(models)
}

fn custom_provider_headers(headers: HashMap<String, String>) -> Option<HashMap<String, String>> {
    (!headers.is_empty()).then_some(headers)
}

fn stored_custom_provider_api_key(
    provider_id: &str,
    api_url: &str,
) -> Result<Option<String>, agent_client_protocol::Error> {
    let loaded = load_declarative_provider_for_client(provider_id)?;
    if !loaded.is_editable || !loaded.config.requires_auth {
        return Ok(None);
    }
    let expected_key_name =
        declarative_providers::generate_scoped_api_key_name(provider_id, api_url).map_err(
            |_| {
                custom_provider_error(
                    "custom_provider_invalid_url",
                    "Enter a valid HTTP or HTTPS model address.",
                )
            },
        )?;
    if loaded.config.api_key_env != expected_key_name {
        return Err(custom_provider_error(
            "custom_provider_api_key_required",
            "Enter the API key again after changing the model address.",
        ));
    }
    Ok(Config::global()
        .get_secret::<String>(&expected_key_name)
        .ok())
}

fn load_declarative_provider_for_client(
    provider_id: &str,
) -> Result<declarative_providers::LoadedProvider, agent_client_protocol::Error> {
    declarative_providers::load_provider(provider_id).map_err(|error| {
        if error.to_string().contains("Provider not found") {
            agent_client_protocol::Error::invalid_params()
                .data(format!("Unknown provider: {provider_id}"))
        } else if error.to_string().contains("Invalid provider id") {
            agent_client_protocol::Error::invalid_params().data(error.to_string())
        } else {
            agent_client_protocol::Error::internal_error().data(error.to_string())
        }
    })
}

fn custom_provider_config_to_dto(
    config: &declarative_providers::DeclarativeProviderConfig,
) -> CustomProviderConfigDto {
    let api_key_env = normalize_optional_string(Some(config.api_key_env.clone()));
    let api_key_set = api_key_env
        .as_ref()
        .map(|key| {
            Config::global()
                .get_secret::<serde_json::Value>(key)
                .is_ok()
        })
        .unwrap_or(false);

    CustomProviderConfigDto {
        provider_id: config.name.clone(),
        engine: custom_provider_engine_to_dto(&config.engine).to_string(),
        display_name: config.display_name.clone(),
        api_url: config.base_url.clone(),
        models: config
            .models
            .iter()
            .map(|model| model.name.clone())
            .collect(),
        supports_streaming: config.supports_streaming,
        headers: config.headers.clone().unwrap_or_default(),
        requires_auth: config.requires_auth,
        catalog_provider_id: config.catalog_provider_id.clone(),
        base_path: config.base_path.clone(),
        api_key_env,
        api_key_set,
        preserves_thinking: config.preserves_thinking,
    }
}

fn refresh_skip_reason_to_dto(reason: RefreshSkipReason) -> RefreshProviderInventorySkipReasonDto {
    match reason {
        RefreshSkipReason::UnknownProvider => {
            RefreshProviderInventorySkipReasonDto::UnknownProvider
        }
        RefreshSkipReason::NotConfigured => RefreshProviderInventorySkipReasonDto::NotConfigured,
        RefreshSkipReason::DoesNotSupportRefresh => {
            RefreshProviderInventorySkipReasonDto::DoesNotSupportRefresh
        }
        RefreshSkipReason::AlreadyRefreshing => {
            RefreshProviderInventorySkipReasonDto::AlreadyRefreshing
        }
    }
}

fn refresh_plan_to_response(refresh_plan: RefreshPlan) -> RefreshProviderInventoryResponse {
    RefreshProviderInventoryResponse {
        started: refresh_plan.started,
        skipped: refresh_plan
            .skipped
            .into_iter()
            .map(|entry| RefreshProviderInventorySkipDto {
                provider_id: entry.provider_id,
                reason: refresh_skip_reason_to_dto(entry.reason),
            })
            .collect(),
    }
}

fn refresh_after_provider_persistence(
    provider_id: &str,
    result: Result<RefreshProviderInventoryResponse, agent_client_protocol::Error>,
) -> RefreshProviderInventoryResponse {
    match result {
        Ok(refresh) => refresh,
        Err(error) => {
            warn!(
                provider = %provider_id,
                error = %error,
                "provider configuration was saved but inventory refresh planning failed"
            );
            RefreshProviderInventoryResponse::default()
        }
    }
}

impl GooseAcpAgent {
    pub(super) async fn on_list_providers(
        &self,
        req: ListProvidersRequest,
    ) -> Result<ListProvidersResponse, agent_client_protocol::Error> {
        let entries = self
            .provider_inventory
            .entries(&req.provider_ids)
            .await
            .internal_err()?;
        Ok(ListProvidersResponse {
            entries: entries.into_iter().map(inventory_entry_to_dto).collect(),
        })
    }

    pub(super) async fn on_list_provider_supported_models(
        &self,
        req: ProviderSupportedModelsListRequest,
    ) -> Result<ProviderSupportedModelsListResponse, agent_client_protocol::Error> {
        let provider = self
            .create_provider(&req.provider_id, Vec::new(), None)
            .await
            .internal_err_ctx("Failed to initialize provider")?;
        let models = provider
            .fetch_supported_models()
            .await
            .internal_err_ctx("Failed to fetch provider supported models")?;

        Ok(ProviderSupportedModelsListResponse {
            provider_id: req.provider_id,
            models,
        })
    }

    pub(super) async fn on_list_provider_catalog(
        &self,
        req: ProviderCatalogListRequest,
    ) -> Result<ProviderCatalogListResponse, agent_client_protocol::Error> {
        let formats = match req.format {
            Some(format) => vec![format
                .parse::<crate::providers::catalog::ProviderFormat>()
                .map_err(|error| agent_client_protocol::Error::invalid_params().data(error))?],
            None => vec![
                crate::providers::catalog::ProviderFormat::OpenAI,
                crate::providers::catalog::ProviderFormat::Anthropic,
                crate::providers::catalog::ProviderFormat::Ollama,
            ],
        };

        let mut providers = Vec::new();
        for format in formats {
            providers.extend(
                crate::providers::catalog::get_providers_by_format(format)
                    .await
                    .into_iter()
                    .map(provider_catalog_entry_to_dto),
            );
        }
        providers.sort_by(|a, b| {
            a.name
                .cmp(&b.name)
                .then_with(|| a.provider_id.cmp(&b.provider_id))
        });

        Ok(ProviderCatalogListResponse { providers })
    }

    pub(super) async fn on_list_provider_setup_catalog(
        &self,
        _req: ProviderSetupCatalogListRequest,
    ) -> Result<ProviderSetupCatalogListResponse, agent_client_protocol::Error> {
        let providers = crate::providers::catalog::get_setup_catalog_entries()
            .await
            .into_iter()
            .map(provider_setup_entry_to_dto)
            .collect();
        Ok(ProviderSetupCatalogListResponse { providers })
    }

    pub(super) async fn on_get_provider_catalog_template(
        &self,
        req: ProviderCatalogTemplateRequest,
    ) -> Result<ProviderCatalogTemplateResponse, agent_client_protocol::Error> {
        let template = provider_catalog_template_for_client(&req.provider_id)?;
        Ok(ProviderCatalogTemplateResponse {
            template: provider_template_to_dto(template),
        })
    }

    pub(super) async fn on_create_custom_provider(
        &self,
        req: CustomProviderCreateRequest,
    ) -> Result<CustomProviderCreateResponse, agent_client_protocol::Error> {
        let provider = normalize_custom_provider_upsert(req.provider)?;
        if provider.requires_auth && provider.api_key.is_none() {
            return Err(custom_provider_error(
                "custom_provider_api_key_required",
                "An API key is required for this connection.",
            ));
        }
        let discovered_models = discover_and_validate_custom_provider(
            &provider.engine,
            &provider.api_url,
            provider.base_path.as_deref(),
            provider.api_key.as_deref(),
            &provider.headers,
            provider.models.first().map(String::as_str),
        )
        .await?;
        if !provider
            .models
            .iter()
            .all(|model| discovered_models.contains(model))
        {
            return Err(custom_provider_error(
                "custom_provider_model_unavailable",
                "One or more selected models are no longer available.",
            ));
        }
        let config = declarative_providers::create_custom_provider(
            declarative_providers::CreateCustomProviderParams {
                engine: provider.engine,
                display_name: provider.display_name,
                api_url: provider.api_url,
                api_key: provider.api_key,
                models: provider.models,
                supports_streaming: provider.supports_streaming,
                headers: custom_provider_headers(provider.headers),
                requires_auth: provider.requires_auth,
                catalog_provider_id: provider.catalog_provider_id,
                base_path: provider.base_path,
                preserves_thinking: provider.preserves_thinking,
            },
        )
        .internal_err_ctx("Failed to create custom provider")?;

        Config::global().invalidate_secrets_cache();
        crate::providers::refresh_custom_providers()
            .await
            .internal_err_ctx("Failed to refresh custom providers")?;

        let provider_id = config.name;
        let provider_ids = [provider_id.clone()];
        let status = Self::provider_config_status(provider_id.clone()).await;
        let refresh = self.start_provider_inventory_refresh(&provider_ids).await?;
        Ok(CustomProviderCreateResponse {
            provider_id,
            status,
            refresh,
        })
    }

    pub(super) async fn on_discover_custom_provider_models(
        &self,
        req: CustomProviderDiscoverModelsRequest,
    ) -> Result<CustomProviderDiscoverModelsResponse, agent_client_protocol::Error> {
        let submitted_api_key = req
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string);
        let api_key = if req.requires_auth {
            Some(
                match (submitted_api_key, req.provider_id.as_deref()) {
                    (Some(api_key), _) => Some(api_key),
                    (None, Some(provider_id)) => {
                        stored_custom_provider_api_key(provider_id, req.api_url.trim())?
                    }
                    (None, None) => None,
                }
                .ok_or_else(|| {
                    custom_provider_error(
                        "custom_provider_api_key_required",
                        "Enter an API key, then test the connection.",
                    )
                })?,
            )
        } else {
            None
        };
        Ok(CustomProviderDiscoverModelsResponse {
            models: discover_and_validate_custom_provider(
                &req.engine,
                req.api_url.trim(),
                req.base_path.as_deref(),
                api_key.as_deref(),
                &req.headers,
                None,
            )
            .await?,
        })
    }

    pub(super) async fn on_read_custom_provider(
        &self,
        req: CustomProviderReadRequest,
    ) -> Result<CustomProviderReadResponse, agent_client_protocol::Error> {
        let loaded = load_declarative_provider_for_client(&req.provider_id)?;
        let status = Self::provider_config_status(req.provider_id).await;
        Ok(CustomProviderReadResponse {
            provider: custom_provider_config_to_dto(&loaded.config),
            editable: loaded.is_editable,
            status,
        })
    }

    pub(super) async fn on_update_custom_provider(
        &self,
        req: CustomProviderUpdateRequest,
    ) -> Result<CustomProviderUpdateResponse, agent_client_protocol::Error> {
        let loaded = load_declarative_provider_for_client(&req.provider_id)?;
        if !loaded.is_editable {
            return Err(agent_client_protocol::Error::invalid_params()
                .data(format!("Provider is not editable: {}", req.provider_id)));
        }

        let provider = normalize_custom_provider_upsert(req.provider)?;
        let validation_api_key = if provider.requires_auth {
            match provider.api_key.as_deref() {
                Some(api_key) => Some(api_key.to_string()),
                None => stored_custom_provider_api_key(&req.provider_id, &provider.api_url)?,
            }
        } else {
            None
        };
        if provider.requires_auth && validation_api_key.is_none() {
            return Err(custom_provider_error(
                "custom_provider_api_key_required",
                "An API key is required for this connection.",
            ));
        }
        let discovered_models = discover_and_validate_custom_provider(
            &provider.engine,
            &provider.api_url,
            provider.base_path.as_deref(),
            validation_api_key.as_deref(),
            &provider.headers,
            provider.models.first().map(String::as_str),
        )
        .await?;
        if !provider
            .models
            .iter()
            .all(|model| discovered_models.contains(model))
        {
            return Err(custom_provider_error(
                "custom_provider_model_unavailable",
                "One or more selected models are no longer available.",
            ));
        }
        let available_models = provider.models.clone();
        declarative_providers::update_custom_provider(
            declarative_providers::UpdateCustomProviderParams {
                id: req.provider_id.clone(),
                engine: provider.engine,
                display_name: provider.display_name,
                api_url: provider.api_url,
                api_key: provider.api_key,
                models: provider.models,
                supports_streaming: provider.supports_streaming,
                headers: Some(provider.headers),
                requires_auth: provider.requires_auth,
                catalog_provider_id: provider.catalog_provider_id,
                base_path: provider.base_path,
                preserves_thinking: provider.preserves_thinking,
            },
        )
        .internal_err_ctx("Failed to update custom provider")?;

        Config::global().invalidate_secrets_cache();
        crate::providers::refresh_custom_providers()
            .await
            .internal_err_ctx("Failed to refresh custom providers")?;
        self.disable_stale_codepro_routes(&req.provider_id, Some(&available_models))?;

        let provider_ids = [req.provider_id.clone()];
        let status = Self::provider_config_status(req.provider_id.clone()).await;
        let refresh = self.start_provider_inventory_refresh(&provider_ids).await?;
        Ok(CustomProviderUpdateResponse {
            provider_id: req.provider_id,
            status,
            refresh,
        })
    }

    pub(super) async fn on_delete_custom_provider(
        &self,
        req: CustomProviderDeleteRequest,
    ) -> Result<CustomProviderDeleteResponse, agent_client_protocol::Error> {
        let loaded = load_declarative_provider_for_client(&req.provider_id)?;
        if !loaded.is_editable {
            return Err(agent_client_protocol::Error::invalid_params()
                .data(format!("Provider is not editable: {}", req.provider_id)));
        }

        if Config::global().get_goose_provider().ok().as_deref() == Some(req.provider_id.as_str()) {
            return Err(agent_client_protocol::Error::invalid_params().data(format!(
                "Cannot delete active provider: {}",
                req.provider_id
            )));
        }

        declarative_providers::remove_custom_provider(&req.provider_id)
            .internal_err_ctx("Failed to delete custom provider")?;

        Config::global().invalidate_secrets_cache();
        crate::providers::refresh_custom_providers()
            .await
            .internal_err_ctx("Failed to refresh custom providers")?;
        self.disable_stale_codepro_routes(&req.provider_id, None)?;

        Ok(CustomProviderDeleteResponse {
            provider_id: req.provider_id,
            refresh: RefreshProviderInventoryResponse {
                started: Vec::new(),
                skipped: Vec::new(),
            },
        })
    }

    fn disable_stale_codepro_routes(
        &self,
        provider_id: &str,
        available_models: Option<&[String]>,
    ) -> Result<(), agent_client_protocol::Error> {
        let config = self.config()?;
        let routing =
            match config.get_param::<CodeProModelRoutingConfig>(CODEPRO_MODEL_ROUTING_CONFIG_KEY) {
                Ok(routing) => routing,
                Err(crate::config::ConfigError::NotFound(_)) => return Ok(()),
                Err(error) => {
                    return Err(agent_client_protocol::Error::internal_error()
                        .data(format!("Invalid persisted CodePro model routing: {error}")));
                }
            };
        if let Some(fallback) =
            routing_after_provider_change(&routing, provider_id, available_models)
        {
            config
                .set_param(CODEPRO_MODEL_ROUTING_CONFIG_KEY, &fallback)
                .internal_err_ctx("Failed to disable stale CodePro model routing")?;
        }
        Ok(())
    }

    pub(super) async fn provider_config_status(provider_id: String) -> ProviderConfigStatusDto {
        let is_configured = match crate::providers::get_from_registry(&provider_id).await {
            Ok(entry) => {
                match tokio::task::spawn_blocking(move || entry.inventory_configured()).await {
                    Ok(is_configured) => is_configured,
                    Err(error) => {
                        warn!(
                            provider = %provider_id,
                            error = %error,
                            "provider config status check failed"
                        );
                        false
                    }
                }
            }
            Err(_) => false,
        };

        ProviderConfigStatusDto {
            provider_id,
            is_configured,
        }
    }

    pub(super) async fn provider_config_statuses(
        provider_ids: &[String],
    ) -> Vec<ProviderConfigStatusDto> {
        let mut ids = if provider_ids.is_empty() {
            crate::providers::providers()
                .await
                .into_iter()
                .map(|(metadata, _)| metadata.name)
                .collect::<Vec<_>>()
        } else {
            provider_ids.to_vec()
        };
        ids.sort();
        ids.dedup();

        let mut statuses = stream::iter(ids)
            .map(Self::provider_config_status)
            .buffer_unordered(PROVIDER_CONFIG_STATUS_CHECK_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        statuses.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
        statuses
    }

    pub(super) fn spawn_provider_inventory_refresh_jobs(&self, refresh_plan: &RefreshJobPlan) {
        for refresh_job in refresh_plan.started.iter().cloned() {
            let provider_inventory = self.provider_inventory.clone();
            let provider_factory = Arc::clone(&self.provider_factory);
            let provider_id = refresh_job.provider_id.clone();
            if let Some(reason) = crate::providers::activation_disabled_reason(&provider_id) {
                warn!(provider = %provider_id, reason, "skipping disabled provider inventory refresh");
                continue;
            }
            let identity = refresh_job.identity.clone();
            tokio::spawn(async move {
                let mut refresh_guard = provider_inventory.refresh_guard(&identity);
                let provider_result = AssertUnwindSafe(async {
                    provider_factory(provider_id.clone(), Vec::new(), None).await
                })
                .catch_unwind()
                .await;

                let fetch_result: Result<Vec<String>> =
                    match provider_result {
                        Ok(Ok(provider)) => {
                            match ensure_refresh_identity_current(&provider_id, &identity).await {
                                Ok(()) => match AssertUnwindSafe(provider.fetch_recommended_models(
                                    crate::model_config::global_toolshim(),
                                ))
                                .catch_unwind()
                                .await
                                {
                                    Ok(Ok(models)) => Ok(models),
                                    Ok(Err(error)) => Err(anyhow::anyhow!(error.to_string())),
                                    Err(_) => Err(anyhow::anyhow!(
                                        "provider inventory refresh task panicked"
                                    )),
                                },
                                Err(error) => Err(error),
                            }
                        }
                        Ok(Err(error)) => Err(error),
                        Err(_) => Err(anyhow::anyhow!("provider inventory refresh task panicked")),
                    };

                match fetch_result {
                    Ok(models) => match provider_inventory
                        .store_refreshed_models_for_identity(&identity, &models)
                        .await
                    {
                        Ok(()) => refresh_guard.complete(),
                        Err(error) => warn!(
                            provider = %provider_id,
                            error = %error,
                            "failed to store refreshed provider inventory"
                        ),
                    },
                    Err(error) => {
                        let error_message = error.to_string();
                        match provider_inventory
                            .store_refresh_error_for_identity(&identity, error_message.clone())
                            .await
                        {
                            Ok(()) => refresh_guard.complete(),
                            Err(store_error) => warn!(
                                provider = %provider_id,
                                error = %store_error,
                                refresh_error = %error_message,
                                "failed to store provider inventory refresh error"
                            ),
                        }
                        warn!(provider = %provider_id, error = %error_message, "provider inventory refresh failed");
                    }
                }
            });
        }
    }

    pub(super) async fn start_provider_inventory_refresh(
        &self,
        provider_ids: &[String],
    ) -> Result<RefreshProviderInventoryResponse, agent_client_protocol::Error> {
        let refresh_job_plan = self
            .provider_inventory
            .plan_refresh_jobs(provider_ids)
            .await
            .internal_err()?;
        self.spawn_provider_inventory_refresh_jobs(&refresh_job_plan);
        Ok(refresh_plan_to_response(
            refresh_job_plan.into_public_plan(),
        ))
    }

    pub(super) async fn on_refresh_provider_inventory(
        &self,
        req: RefreshProviderInventoryRequest,
    ) -> Result<RefreshProviderInventoryResponse, agent_client_protocol::Error> {
        Config::global().invalidate_secrets_cache();
        self.start_provider_inventory_refresh(&req.provider_ids)
            .await
    }

    pub(super) async fn on_read_provider_config(
        &self,
        req: ProviderConfigReadRequest,
    ) -> Result<ProviderConfigReadResponse, agent_client_protocol::Error> {
        let entry = crate::providers::get_from_registry(&req.provider_id)
            .await
            .invalid_params_err_ctx("Unknown provider")?;
        let config = Config::global();
        let config_keys = &entry.metadata().config_keys;
        let secrets = if config_keys.iter().any(|key| key.secret) {
            Some(config.all_secrets().internal_err()?)
        } else {
            None
        };

        Ok(ProviderConfigReadResponse {
            fields: config_keys
                .iter()
                .map(|key| provider_config_field_value(config, key, secrets.as_ref()))
                .collect(),
        })
    }

    pub(super) async fn on_provider_config_status(
        &self,
        req: ProviderConfigStatusRequest,
    ) -> Result<ProviderConfigStatusResponse, agent_client_protocol::Error> {
        Ok(ProviderConfigStatusResponse {
            statuses: Self::provider_config_statuses(&req.provider_ids).await,
        })
    }

    pub(super) async fn on_save_provider_config(
        &self,
        req: ProviderConfigSaveRequest,
    ) -> Result<ProviderConfigChangeResponse, agent_client_protocol::Error> {
        let entry = crate::providers::get_from_registry(&req.provider_id)
            .await
            .invalid_params_err_ctx("Unknown provider")?;
        let metadata = entry.metadata().clone();
        let config = Config::global();
        let mut config_updates = Vec::new();
        let mut config_deletes = Vec::new();
        let mut secret_updates = Vec::new();

        ensure_provider_credential_activation_supported(&metadata)?;

        if req.provider_id == "openai" {
            let selector_is_present = |key: &str| {
                req.fields.iter().any(|field| field.key == key)
                    || (!req.clear_fields.iter().any(|field| field == key)
                        && config
                            .get_param::<String>(key)
                            .ok()
                            .is_some_and(|value| !value.trim().is_empty()))
            };
            if selector_is_present("OPENAI_HOST") && selector_is_present("OPENAI_BASE_URL") {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("OPENAI_HOST and OPENAI_BASE_URL are mutually exclusive"));
            }
        }

        for key in &req.clear_fields {
            if req.fields.iter().any(|field| field.key == *key) {
                return Err(agent_client_protocol::Error::invalid_params().data(format!(
                    "Provider config field cannot be set and cleared: {key}"
                )));
            }
            let Some(config_key) = metadata
                .config_keys
                .iter()
                .find(|config_key| config_key.name == *key)
            else {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("Unsupported provider config field: {key}")));
            };
            if config_key.secret {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("Secret provider fields cannot be cleared through config save"));
            } else {
                config_deletes.push(key.clone());
            }
        }

        for field in &req.fields {
            let Some(config_key) = metadata
                .config_keys
                .iter()
                .find(|config_key| config_key.name == field.key)
            else {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("Unsupported provider config field: {}", field.key)));
            };

            let value = field.value.trim();
            if value.is_empty() {
                return Err(agent_client_protocol::Error::invalid_params().data(format!(
                    "Provider config field cannot be empty: {}",
                    field.key
                )));
            }

            if config_key.secret {
                secret_updates.push((
                    config_key.name.clone(),
                    serde_json::Value::String(value.to_string()),
                ));
            } else {
                config_updates.push((
                    config_key.name.clone(),
                    serde_json::Value::String(value.to_string()),
                ));
            }
        }

        let mut candidate_values: std::collections::HashMap<String, serde_json::Value> = req
            .fields
            .iter()
            .map(|field| {
                (
                    field.key.clone(),
                    serde_json::Value::String(field.value.trim().to_string()),
                )
            })
            .collect();
        for key in &req.clear_fields {
            candidate_values.insert(key.clone(), serde_json::Value::String(String::new()));
        }
        let uses_official_openai_host = if req.provider_id == "openai" {
            let host = crate::config::base::with_candidate_provider_values(
                candidate_values.clone(),
                async { crate::providers::openai_def::effective_host(config) },
            )
            .await
            .internal_err_ctx("Failed to resolve the effective OpenAI host")?;
            goose_providers::openai::is_official_openai_host(&host)
        } else {
            false
        };
        let has_primary_credential = metadata.config_keys.iter().any(|key| {
            key.primary
                && key.secret
                && !key.oauth_flow
                && (req.fields.iter().any(|field| field.key == key.name)
                    || config.get_secret::<serde_json::Value>(&key.name).is_ok())
        });
        let submitted_primary_credential = metadata.config_keys.iter().any(|key| {
            key.primary
                && key.secret
                && !key.oauth_flow
                && req.fields.iter().any(|field| field.key == key.name)
        });
        if uses_official_openai_host && !has_primary_credential {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("OpenAI API key is required for the official OpenAI host"));
        }
        let requires_credential_validation = uses_official_openai_host
            || submitted_primary_credential
            || metadata
                .config_keys
                .iter()
                .any(|key| key.primary && key.secret && !key.oauth_flow && key.required);
        if requires_credential_validation {
            let provider = crate::config::base::with_candidate_provider_values(
                candidate_values,
                entry.create_with_default_model(Vec::new()),
            )
            .await
            .internal_err_ctx("Failed to initialize provider with candidate credentials")?;
            provider
                .validate_credentials()
                .await
                .internal_err_ctx("Provider credential validation failed")?;
        }

        config
            .set_provider_values_transactional_changes(
                &config_updates,
                &config_deletes,
                &secret_updates,
                &[],
            )
            .internal_err_ctx("Failed to save provider configuration transaction")?;

        let provider_ids = [req.provider_id.clone()];
        let status = Self::provider_config_status(req.provider_id.clone()).await;
        let refresh = refresh_after_provider_persistence(
            &req.provider_id,
            self.start_provider_inventory_refresh(&provider_ids).await,
        );
        Ok(ProviderConfigChangeResponse { status, refresh })
    }

    pub(super) async fn on_delete_provider_config(
        &self,
        req: ProviderConfigDeleteRequest,
    ) -> Result<ProviderConfigChangeResponse, agent_client_protocol::Error> {
        let entry = crate::providers::get_from_registry(&req.provider_id)
            .await
            .invalid_params_err_ctx("Unknown provider")?;
        let metadata = entry.metadata().clone();
        let config = Config::global();
        let mut secret_keys = Vec::new();

        for config_key in &metadata.config_keys {
            if config_key.secret {
                secret_keys.push(config_key.name.clone());
            } else {
                config
                    .delete(&config_key.name)
                    .internal_err_ctx("Failed to delete provider config field")?;
            }
        }

        config
            .delete_secret_values(&secret_keys)
            .internal_err_ctx("Failed to delete provider secret fields")?;
        crate::providers::cleanup_provider(&req.provider_id)
            .await
            .internal_err_ctx("Failed to clean up provider state")?;

        let provider_ids = [req.provider_id.clone()];
        let status = Self::provider_config_status(req.provider_id.clone()).await;
        let refresh = self.start_provider_inventory_refresh(&provider_ids).await?;
        Ok(ProviderConfigChangeResponse { status, refresh })
    }

    pub(super) async fn on_authenticate_provider_config(
        &self,
        req: ProviderConfigAuthenticateRequest,
    ) -> Result<ProviderConfigChangeResponse, agent_client_protocol::Error> {
        let entry = crate::providers::get_from_registry(&req.provider_id)
            .await
            .invalid_params_err_ctx("Unknown provider")?;

        if req.provider_id == crate::providers::huggingface_auth::HUGGINGFACE_PROVIDER_NAME {
            crate::providers::huggingface_auth::configure_oauth()
                .await
                .internal_err_ctx("Failed to authenticate provider")?;
        } else {
            let metadata = entry.metadata().clone();
            if !metadata.config_keys.iter().any(|key| key.oauth_flow) {
                return Err(agent_client_protocol::Error::invalid_params().data(format!(
                    "Provider does not support native authentication: {}",
                    req.provider_id
                )));
            }

            let provider = entry
                .create_with_default_model(Vec::new())
                .await
                .internal_err_ctx("Failed to initialize provider")?;
            provider
                .configure_oauth()
                .await
                .internal_err_ctx("Failed to authenticate provider")?;
        }
        Config::global().invalidate_secrets_cache();

        let provider_ids = [req.provider_id.clone()];
        let status = Self::provider_config_status(req.provider_id.clone()).await;
        let refresh = self.start_provider_inventory_refresh(&provider_ids).await?;
        Ok(ProviderConfigChangeResponse { status, refresh })
    }

    pub(super) async fn on_list_provider_secrets(
        &self,
        _req: ProviderSecretsListRequest,
    ) -> Result<ProviderSecretsListResponse, agent_client_protocol::Error> {
        let secrets = provider_secrets::list_provider_secrets()
            .await
            .internal_err_ctx("Failed to list provider secrets")?
            .into_iter()
            .map(provider_secret_to_dto)
            .collect();
        Ok(ProviderSecretsListResponse { secrets })
    }

    pub(super) async fn on_delete_provider_secret(
        &self,
        req: ProviderSecretDeleteRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        match provider_secrets::delete_provider_secret(&req.id).await {
            Ok(()) => Ok(EmptyResponse {}),
            Err(provider_secrets::DeleteProviderSecretError::InvalidId(id)) => {
                Err(agent_client_protocol::Error::invalid_params()
                    .data(format!("Invalid provider secret id: '{}'", id)))
            }
            Err(e) => Err(agent_client_protocol::Error::internal_error().data(e.to_string())),
        }
    }

    pub(super) async fn on_canonical_model_info(
        &self,
        req: CanonicalModelInfoRequest,
    ) -> Result<CanonicalModelInfoResponse, agent_client_protocol::Error> {
        use goose_providers::model::ModelConfig;

        let model_info =
            crate::providers::canonical::maybe_get_canonical_model(&req.provider, &req.model).map(
                |canonical_model| CanonicalModelInfoDto {
                    provider: req.provider.clone(),
                    model: req.model.clone(),
                    context_limit: canonical_model.limit.context,
                    max_output_tokens: canonical_model.limit.output,
                    reasoning: canonical_model
                        .reasoning
                        .unwrap_or_else(|| ModelConfig::new(&req.model).is_reasoning_model()),
                    input_token_cost: canonical_model.cost.input,
                    output_token_cost: canonical_model.cost.output,
                    cache_read_token_cost: canonical_model.cost.cache_read,
                    cache_write_token_cost: canonical_model.cost.cache_write,
                    currency: "$".to_string(),
                },
            );

        Ok(CanonicalModelInfoResponse { model_info })
    }
}

#[cfg(test)]
mod provider_persistence_tests {
    use super::*;

    #[tokio::test]
    async fn custom_provider_validation_accepts_slow_connection_setup() {
        use reqwest::dns::{Addrs, Name, Resolve, Resolving};
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        struct SlowResolver(std::net::SocketAddr);
        impl Resolve for SlowResolver {
            fn resolve(&self, _: Name) -> Resolving {
                let address = self.0;
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(3_200)).await;
                    Ok(Box::new(std::iter::once(address)) as Addrs)
                })
            }
        }

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"id": "fixture-model"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{"message": {"role": "assistant", "content": "OK"}}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let client = custom_provider_validation_client()
            .no_proxy()
            .dns_resolver(std::sync::Arc::new(SlowResolver(*server.address())))
            .build()
            .unwrap();
        let base = format!("http://slow-provider.test:{}", server.address().port());
        let response = client
            .get(format!("{base}/v1/models"))
            .send()
            .await
            .expect("working connections must not fail at the old three-second deadline");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        validate_custom_provider_credentials(
            &client,
            format!("{base}/v1/chat/completions").parse().unwrap(),
            "fixture-model",
            None,
            &HashMap::new(),
        )
        .await
        .unwrap();
    }

    #[test]
    fn provider_catalog_dto_exposes_activation_disabled_state() {
        fn entry(id: &str) -> crate::providers::catalog::ProviderCatalogEntry {
            crate::providers::catalog::ProviderCatalogEntry {
                id: id.to_string(),
                name: id.to_string(),
                format: "openai".to_string(),
                api_url: "https://example.invalid/v1".to_string(),
                model_count: 1,
                doc_url: "https://example.invalid/docs".to_string(),
                env_var: "EXAMPLE_API_KEY".to_string(),
            }
        }

        let disabled = provider_catalog_entry_to_dto(entry("zai"));
        assert!(!disabled.enabled);
        assert_eq!(
            disabled.disabled_reason.as_deref(),
            Some(crate::providers::UNVERIFIED_CREDENTIAL_ACTIVATION_REASON)
        );

        let untrusted_template = provider_catalog_entry_to_dto(entry("openai"));
        assert!(!untrusted_template.enabled);
        assert_eq!(
            untrusted_template.disabled_reason.as_deref(),
            Some(crate::providers::UNSUPPORTED_CUSTOM_CREDENTIAL_REASON)
        );
    }

    fn valid_custom_provider(catalog_provider_id: Option<&str>) -> CustomProviderUpsertDto {
        CustomProviderUpsertDto {
            engine: "openai_compatible".to_string(),
            display_name: "Local fixture".to_string(),
            api_url: "http://127.0.0.1:1/v1".to_string(),
            api_key: Some("local-fixture-key".to_string()),
            models: vec!["fixture-model".to_string()],
            supports_streaming: Some(true),
            headers: HashMap::new(),
            requires_auth: true,
            catalog_provider_id: catalog_provider_id.map(str::to_string),
            base_path: None,
            preserves_thinking: None,
        }
    }

    #[test]
    fn provider_lifecycle_change_disables_stale_codepro_routes() {
        let routing = CodeProModelRoutingConfig {
            advanced_routing_enabled: true,
            vision_route: goose_sdk_types::custom_requests::CodeProVisionRoute {
                provider_id: Some("custom_ollama".to_string()),
                model_id: Some("kimi-k3".to_string()),
                ..Default::default()
            },
            routes: vec![
                CodeProModelRoute {
                    role: CodeProModelRoutingRole::Planner,
                    provider_id: "retained".to_string(),
                    model_id: "planner-model".to_string(),
                },
                CodeProModelRoute {
                    role: CodeProModelRoutingRole::Coder,
                    provider_id: "changed".to_string(),
                    model_id: "removed-model".to_string(),
                },
                CodeProModelRoute {
                    role: CodeProModelRoutingRole::Tester,
                    provider_id: "retained".to_string(),
                    model_id: "tester-model".to_string(),
                },
                CodeProModelRoute {
                    role: CodeProModelRoutingRole::Reviewer,
                    provider_id: "retained".to_string(),
                    model_id: "reviewer-model".to_string(),
                },
            ],
            max_parallel_coders: 1,
            ..CodeProModelRoutingConfig::default()
        };

        let inactive = CodeProModelRoutingConfig {
            advanced_routing_enabled: false,
            ..routing.clone()
        };
        assert_eq!(
            routing_after_provider_change(&inactive, "changed", None),
            None
        );
        assert_eq!(
            routing_after_provider_change(&routing, "changed", None),
            Some(inactive.clone())
        );
        assert_eq!(
            routing_after_provider_change(
                &routing,
                "changed",
                Some(&["replacement-model".to_string()])
            ),
            Some(inactive)
        );
        assert_eq!(
            routing_after_provider_change(
                &routing,
                "changed",
                Some(&["removed-model".to_string()])
            ),
            None
        );
        assert_eq!(
            routing_after_provider_change(&routing, "unrelated", None),
            None
        );
    }

    #[test]
    fn refresh_planning_failure_does_not_downgrade_persisted_save() {
        let refresh = refresh_after_provider_persistence(
            "openai",
            Err(agent_client_protocol::Error::internal_error()),
        );

        assert!(refresh.started.is_empty());
        assert!(refresh.skipped.is_empty());
    }

    #[test]
    fn custom_provider_upsert_rejects_activation_disabled_catalog_ids() {
        for provider_id in ["zai", "nvidia"] {
            let error = normalize_custom_provider_upsert(valid_custom_provider(Some(provider_id)))
                .expect_err("disabled catalog identity must fail before persistence");
            assert!(error
                .to_string()
                .contains(crate::providers::UNVERIFIED_CREDENTIAL_ACTIVATION_REASON));
        }
    }

    #[test]
    fn custom_provider_upsert_rejects_disabled_vendor_endpoints_without_catalog_identity() {
        for api_url in [
            "https://api.z.ai/api/anthropic",
            "https://api.z.ai/api/anthropic/",
            "https://api.z.ai./api/anthropic",
            "https://integrate.api.nvidia.com/v1",
            "https://integrate.api.nvidia.com/v1/",
            "https://integrate.api.nvidia.com./v1",
        ] {
            let mut provider = valid_custom_provider(None);
            provider.requires_auth = false;
            provider.api_key = None;
            provider.api_url = api_url.to_string();

            let error = normalize_custom_provider_upsert(provider)
                .expect_err("disabled vendor endpoint must fail without catalog identity");
            assert!(error
                .to_string()
                .contains(crate::providers::UNVERIFIED_CREDENTIAL_ACTIVATION_REASON));
        }
    }

    #[test]
    fn authenticated_custom_provider_is_normalized_for_verified_persistence() {
        let provider = normalize_custom_provider_upsert(valid_custom_provider(None))
            .expect("authenticated custom providers are verified before persistence");
        assert_eq!(provider.engine, "openai_compatible");
        assert_eq!(provider.api_key.as_deref(), Some("local-fixture-key"));
        assert!(provider.requires_auth);
    }

    #[test]
    fn custom_provider_urls_do_not_create_double_slashes_and_respect_base_paths() {
        assert_eq!(
            custom_provider_discovery_url("openai_compatible", "https://example.test", None)
                .unwrap()
                .as_str(),
            "https://example.test/v1/models"
        );
        assert_eq!(
            custom_provider_completion_url("https://example.test", None)
                .unwrap()
                .as_str(),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            custom_provider_discovery_url(
                "openai_compatible",
                "https://example.test/root",
                Some("gateway/v1"),
            )
            .unwrap()
            .as_str(),
            "https://example.test/gateway/v1/models"
        );
        assert_eq!(
            custom_provider_completion_url(
                "https://example.test/root",
                Some("gateway/v1/responses"),
            )
            .unwrap()
            .as_str(),
            "https://example.test/gateway/v1/responses"
        );
    }

    #[test]
    fn unauthenticated_custom_provider_rejects_credential_channels() {
        let cases = [
            ("https://example.invalid/v1?api_key=fixture", None),
            ("https://example.invalid/v1#token", None),
            (
                "https://example.invalid/v1",
                Some(("Authorization", "Bearer fixture")),
            ),
            ("https://example.invalid/v1", Some(("x-API-key", "fixture"))),
        ];

        for (api_url, header) in cases {
            let mut provider = valid_custom_provider(None);
            provider.requires_auth = false;
            provider.api_key = None;
            provider.api_url = api_url.to_string();
            provider.headers = header
                .map(|(name, value)| HashMap::from([(name.to_string(), value.to_string())]))
                .unwrap_or_default();

            normalize_custom_provider_upsert(provider)
                .expect_err("unauthenticated custom provider must reject credential channels");
        }

        let mut api_key_provider = valid_custom_provider(None);
        api_key_provider.requires_auth = false;
        normalize_custom_provider_upsert(api_key_provider)
            .expect_err("requiresAuth=false cannot carry apiKey");

        let mut base_path_provider = valid_custom_provider(None);
        base_path_provider.requires_auth = false;
        base_path_provider.api_key = None;
        base_path_provider.base_path = Some("/v1?api_key=fixture".to_string());
        normalize_custom_provider_upsert(base_path_provider)
            .expect_err("basePath cannot contain a credential query");
    }

    #[test]
    fn custom_provider_rejects_invalid_vendor_origin_before_persistence() {
        for api_url in [
            "http://api.z.ai/api/anthropic",
            "https://api.z.ai:8443/api/anthropic",
            "https://user:pass@api.z.ai/api/anthropic",
            "https://integrate.api.nvidia.com.:8443/v1",
        ] {
            let mut provider = valid_custom_provider(None);
            provider.requires_auth = false;
            provider.api_key = None;
            provider.api_url = api_url.to_string();
            normalize_custom_provider_upsert(provider)
                .expect_err("invalid vendor origin must fail before persistence");
        }
    }

    #[test]
    fn catalog_template_rejects_activation_disabled_provider_before_use() {
        for provider_id in ["zai", "nvidia", "deepseek"] {
            let error = provider_catalog_template_for_client(provider_id)
                .expect_err("disabled provider template must fail closed");
            assert!(
                error.to_string().contains("disabled") || error.to_string().contains("Unsupported")
            );
        }
    }
}
