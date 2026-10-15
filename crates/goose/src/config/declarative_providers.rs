use crate::config::paths::Paths;
use crate::config::Config;
use crate::providers::anthropic_def::AnthropicProviderDef;
use crate::providers::base::{ModelInfo, ProviderType};
use crate::providers::huggingface::HuggingFaceProvider;
use crate::providers::huggingface_auth;
use crate::providers::inventory::declarative_inventory_identity;
use crate::providers::ollama_def::OllamaProviderDef;
use crate::providers::openai_def::OpenAiProviderDef;
use anyhow::Result;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub use goose_providers::declarative::*;

pub fn custom_providers_dir() -> std::path::PathBuf {
    Paths::config_dir().join("custom_providers")
}

/// Expand `${VAR_NAME}` placeholders in a template string using the given env var configs.
/// Resolves values via Config (secret if `secret`, param otherwise), falls back to `default`.
/// Returns an error if a `required` var is missing.
pub fn expand_env_vars(template: &str, env_vars: &[EnvVarConfig]) -> Result<String> {
    let config = Config::global();
    let mut result = template.to_string();
    for var in env_vars {
        let placeholder = format!("${{{}}}", var.name);
        if !result.contains(&placeholder) {
            continue;
        }
        let value = if var.secret {
            config.get_secret::<String>(&var.name).ok()
        } else {
            config.get_param::<String>(&var.name).ok()
        };
        let value = match value {
            Some(v) => v,
            None => match &var.default {
                Some(d) => d.clone(),
                None if var.required => {
                    return Err(anyhow::anyhow!(
                        "Required environment variable {} is not set",
                        var.name
                    ));
                }
                None => continue,
            },
        };
        result = result.replace(&placeholder, &value);
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedProvider {
    pub config: DeclarativeProviderConfig,
    pub is_editable: bool,
}

static ID_GENERATION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub fn generate_id(display_name: &str) -> String {
    let _guard = ID_GENERATION_LOCK.lock().unwrap();

    generate_id_locked(display_name)
}

fn generate_id_locked(display_name: &str) -> String {
    let normalized = display_name
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    let base_id = format!("custom_{}", normalized);

    let custom_dir = custom_providers_dir();
    let mut candidate_id = base_id.clone();
    let mut counter = 1;

    while custom_dir.join(format!("{}.json", candidate_id)).exists() {
        candidate_id = format!("{}_{}", base_id, counter);
        counter += 1;
    }

    candidate_id
}

fn custom_provider_name_identity(display_name: &str) -> String {
    display_name
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn same_custom_provider_configuration(
    existing: &DeclarativeProviderConfig,
    desired: &DeclarativeProviderConfig,
) -> bool {
    existing.engine == desired.engine
        && existing.base_url.trim() == desired.base_url.trim()
        && existing.models == desired.models
        && existing.headers == desired.headers
        && existing.supports_streaming == desired.supports_streaming
        && existing.requires_auth == desired.requires_auth
        && existing.catalog_provider_id == desired.catalog_provider_id
        && existing.base_path == desired.base_path
        && existing.preserves_thinking == desired.preserves_thinking
}

fn backup_exact_provider_duplicates(
    exact_matches: &[&(PathBuf, DeclarativeProviderConfig)],
) -> Result<()> {
    for (ordinal, (duplicate_path, _)) in exact_matches.iter().skip(1).enumerate() {
        let mut backup_path =
            duplicate_path.with_extension(format!("json.duplicate-backup-{}", ordinal + 1));
        let mut collision = ordinal + 1;
        while backup_path.exists() {
            collision += 1;
            backup_path =
                duplicate_path.with_extension(format!("json.duplicate-backup-{collision}"));
        }
        std::fs::rename(duplicate_path, backup_path)?;
    }
    Ok(())
}

fn consolidate_exact_custom_provider_duplicates_locked(dir: &Path) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let mut providers = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .filter_map(|entry| {
            let contents = std::fs::read_to_string(entry.path()).ok()?;
            let config = deserialize_provider_config(&contents).ok()?;
            Some((entry.path(), config))
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| left.1.name.cmp(&right.1.name));
    let mut backed_up = vec![false; providers.len()];
    for canonical_index in 0..providers.len() {
        if backed_up[canonical_index] {
            continue;
        }
        let canonical = &providers[canonical_index].1;
        let exact_matches = providers
            .iter()
            .enumerate()
            .skip(canonical_index)
            .filter(|(index, (_, candidate))| {
                !backed_up[*index]
                    && custom_provider_name_identity(&candidate.display_name)
                        == custom_provider_name_identity(&canonical.display_name)
                    && same_custom_provider_configuration(candidate, canonical)
            })
            .map(|(_, provider)| provider)
            .collect::<Vec<_>>();
        backup_exact_provider_duplicates(&exact_matches)?;
        for duplicate in exact_matches.iter().skip(1) {
            if let Some(index) = providers
                .iter()
                .position(|provider| std::ptr::eq(provider, *duplicate))
            {
                backed_up[index] = true;
            }
        }
    }
    Ok(())
}

pub fn validate_provider_id(id: &str) -> Result<()> {
    if crate::providers::provider_registry::is_protected_provider_id(id) {
        return Err(anyhow::anyhow!("Protected provider id: {}", id));
    }

    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return Err(anyhow::anyhow!(
            "Invalid provider id: provider id cannot be empty"
        ));
    };

    if !(first.is_ascii_lowercase() || first.is_ascii_digit() || first == '_') {
        return Err(anyhow::anyhow!("Invalid provider id: {}", id));
    }

    if chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-') {
        Ok(())
    } else {
        Err(anyhow::anyhow!("Invalid provider id: {}", id))
    }
}

fn custom_provider_file_path(id: &str) -> Result<PathBuf> {
    if id.is_empty()
        || id
            .chars()
            .any(|ch| ch == '/' || ch == '\\' || ch.is_control())
    {
        return Err(anyhow::anyhow!(
            "Invalid provider id: {}",
            if id.is_empty() { "<empty>" } else { id }
        ));
    }

    Ok(custom_providers_dir().join(format!("{}.json", id)))
}

pub fn generate_api_key_name(id: &str) -> String {
    format!("{}_API_KEY", id.to_uppercase())
}

pub fn generate_scoped_api_key_name(id: &str, api_url: &str) -> Result<String> {
    goose_providers::declarative::scoped_custom_api_key_name(id, api_url)
}

fn provider_owns_api_key_name(id: &str, api_url: &str, api_key_name: &str) -> bool {
    api_key_name == generate_api_key_name(id)
        || generate_scoped_api_key_name(id, api_url).is_ok_and(|name| name == api_key_name)
}

#[derive(Debug, Clone)]
pub struct CreateCustomProviderParams {
    pub engine: String,
    pub display_name: String,
    pub api_url: String,
    pub api_key: Option<String>,
    pub models: Vec<String>,
    pub supports_streaming: Option<bool>,
    pub headers: Option<HashMap<String, String>>,
    pub requires_auth: bool,
    pub catalog_provider_id: Option<String>,
    pub base_path: Option<String>,
    pub preserves_thinking: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct UpdateCustomProviderParams {
    pub id: String,
    pub engine: String,
    pub display_name: String,
    pub api_url: String,
    pub api_key: Option<String>,
    pub models: Vec<String>,
    pub supports_streaming: Option<bool>,
    pub headers: Option<HashMap<String, String>>,
    pub requires_auth: bool,
    pub catalog_provider_id: Option<String>,
    pub base_path: Option<String>,
    pub preserves_thinking: Option<bool>,
}

pub fn create_custom_provider(
    params: CreateCustomProviderParams,
) -> Result<DeclarativeProviderConfig> {
    crate::providers::validate_custom_provider_contract(
        params.catalog_provider_id.as_deref(),
        &params.api_url,
        params.headers.as_ref(),
        params.requires_auth,
        params
            .api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty()),
        params.base_path.as_deref(),
    )
    .map_err(anyhow::Error::msg)?;
    let display_name = params.display_name.trim().to_string();

    let model_infos: Vec<ModelInfo> = params
        .models
        .into_iter()
        .map(|name| ModelInfo::new(name, 128000))
        .collect();

    let engine = ProviderEngine::from_str(&params.engine)?;
    let api_key = params
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string);
    if params.requires_auth && api_key.is_none() {
        anyhow::bail!("apiKey is required when authentication is enabled");
    }
    let preserves_thinking = params
        .preserves_thinking
        .unwrap_or_else(|| should_preserve_thinking_by_default(&engine));

    let mut provider_config = DeclarativeProviderConfig {
        name: String::new(),
        engine,
        display_name: display_name.clone(),
        description: Some(format!("Custom {display_name} provider")),
        api_key_env: String::new(),
        base_url: params.api_url,
        models: model_infos,
        headers: params.headers,
        timeout_seconds: None,
        supports_streaming: params.supports_streaming,
        requires_auth: params.requires_auth,
        catalog_provider_id: params.catalog_provider_id,
        base_path: params.base_path,
        env_vars: None,
        dynamic_models: None,
        skip_canonical_filtering: false,
        model_doc_link: None,
        setup_steps: vec![],
        fast_model: None,
        preserves_thinking,
    };

    let custom_providers_dir = custom_providers_dir();
    std::fs::create_dir_all(&custom_providers_dir)?;
    let _guard = ID_GENERATION_LOCK.lock().unwrap();
    let desired_identity = custom_provider_name_identity(&display_name);
    let mut matching = std::fs::read_dir(&custom_providers_dir)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .filter_map(|entry| {
            let contents = std::fs::read_to_string(entry.path()).ok()?;
            let config = deserialize_provider_config(&contents).ok()?;
            (custom_provider_name_identity(&config.display_name) == desired_identity)
                .then_some((entry.path(), config))
        })
        .collect::<Vec<_>>();
    matching.sort_by(|left, right| left.1.name.cmp(&right.1.name));
    let exact_matches = matching
        .iter()
        .filter(|(_, existing)| same_custom_provider_configuration(existing, &provider_config))
        .collect::<Vec<_>>();
    if let Some((_, existing)) = exact_matches.first() {
        backup_exact_provider_duplicates(&exact_matches)?;
        return Ok((*existing).clone());
    }
    if let Some((_, existing)) = matching.first() {
        if existing.base_url.trim() != provider_config.base_url.trim() {
            anyhow::bail!(
                "A custom provider with the same name already exists at a different address"
            );
        }
        anyhow::bail!("A custom provider with the same name already exists; edit it instead");
    }

    let id = generate_id_locked(&display_name);
    validate_provider_id(&id)?;
    provider_config.name = id.clone();
    provider_config.api_key_env = if params.requires_auth {
        generate_scoped_api_key_name(&id, &provider_config.base_url)?
    } else {
        String::new()
    };

    let json_content = serde_json::to_string_pretty(&provider_config)?;
    let file_path = custom_providers_dir.join(format!("{}.json", id));
    if let Some(api_key) = api_key.as_ref() {
        Config::global().set_secret(&provider_config.api_key_env, api_key)?;
    }
    if let Err(error) = std::fs::write(file_path, json_content) {
        if !provider_config.api_key_env.is_empty() {
            let _ = Config::global().delete_secret(&provider_config.api_key_env);
        }
        return Err(error.into());
    }

    Ok(provider_config)
}

pub fn update_custom_provider(params: UpdateCustomProviderParams) -> Result<()> {
    let loaded_provider = load_provider(&params.id)?;
    let existing_config = loaded_provider.config;
    let editable = loaded_provider.is_editable;
    let effective_headers = params.headers.as_ref().or(existing_config.headers.as_ref());
    crate::providers::validate_custom_provider_contract(
        params.catalog_provider_id.as_deref(),
        &params.api_url,
        effective_headers,
        params.requires_auth,
        params
            .api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty()),
        params.base_path.as_deref(),
    )
    .map_err(anyhow::Error::msg)?;

    let config = Config::global();
    let previous_api_key_env = existing_config.api_key_env.clone();
    let previous_api_key = (!previous_api_key_env.is_empty())
        .then(|| config.get_secret::<String>(&previous_api_key_env).ok())
        .flatten();
    let api_key_env = if params.requires_auth {
        let api_key_env = generate_scoped_api_key_name(&params.id, &params.api_url)?;
        let api_key = params
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_string)
            .or_else(|| previous_api_key.clone())
            .ok_or_else(|| anyhow::anyhow!("apiKey is required when authentication is enabled"))?;
        config.set_secret(&api_key_env, &api_key)?;
        api_key_env
    } else {
        String::new()
    };

    if editable {
        let model_infos: Vec<ModelInfo> = params
            .models
            .into_iter()
            .map(|name| ModelInfo::new(name, 128000))
            .collect();

        let engine = ProviderEngine::from_str(&params.engine)?;
        let preserves_thinking = match params.preserves_thinking {
            Some(value) => value,
            None if existing_config.engine != engine => {
                should_preserve_thinking_by_default(&engine)
            }
            None => existing_config.preserves_thinking,
        };

        let updated_config = DeclarativeProviderConfig {
            name: params.id.clone(),
            engine,
            display_name: params.display_name,
            description: existing_config.description,
            api_key_env: api_key_env.clone(),
            base_url: params.api_url,
            models: model_infos,
            headers: match params.headers {
                Some(h) if h.is_empty() => None,
                Some(h) => Some(h),
                None => existing_config.headers,
            },
            timeout_seconds: existing_config.timeout_seconds,
            supports_streaming: params.supports_streaming,
            requires_auth: params.requires_auth,
            catalog_provider_id: params.catalog_provider_id,
            base_path: params.base_path,
            env_vars: existing_config.env_vars,
            dynamic_models: existing_config.dynamic_models,
            skip_canonical_filtering: existing_config.skip_canonical_filtering,
            model_doc_link: existing_config.model_doc_link,
            setup_steps: existing_config.setup_steps,
            fast_model: existing_config.fast_model.clone(),
            preserves_thinking,
        };

        let file_path = custom_provider_file_path(&updated_config.name)?;
        let json_content = serde_json::to_string_pretty(&updated_config)?;
        if let Err(error) = std::fs::write(file_path, json_content) {
            if !api_key_env.is_empty() {
                if api_key_env == previous_api_key_env {
                    if let Some(previous_api_key) = previous_api_key.as_ref() {
                        let _ = config.set_secret(&api_key_env, previous_api_key);
                    } else {
                        let _ = config.delete_secret(&api_key_env);
                    }
                } else {
                    let _ = config.delete_secret(&api_key_env);
                }
            }
            return Err(error.into());
        }
        if !previous_api_key_env.is_empty()
            && previous_api_key_env != api_key_env
            && provider_owns_api_key_name(
                &params.id,
                &existing_config.base_url,
                &previous_api_key_env,
            )
        {
            let _ = config.delete_secret(&previous_api_key_env);
        }
    }
    Ok(())
}

pub fn remove_custom_provider(id: &str) -> Result<()> {
    let config = Config::global();
    let loaded_provider = load_provider(id)?;
    let api_key_env = loaded_provider.config.api_key_env;
    if provider_owns_api_key_name(id, &loaded_provider.config.base_url, &api_key_env) {
        let _ = config.delete_secret(&api_key_env);
    }

    let file_path = custom_provider_file_path(id)?;

    if file_path.exists() {
        std::fs::remove_file(file_path)?;
    }

    Ok(())
}

pub fn load_provider(id: &str) -> Result<LoadedProvider> {
    let custom_file_path = custom_provider_file_path(id)?;

    if !crate::providers::provider_registry::is_protected_provider_id(id)
        && custom_file_path.exists()
    {
        let content = std::fs::read_to_string(&custom_file_path)?;
        let config = deserialize_provider_config(&content)?;
        return Ok(LoadedProvider {
            config,
            is_editable: true,
        });
    }

    if let Some(config) = fixed_provider_configs()?
        .into_iter()
        .find(|config| config.name == id)
    {
        return Ok(LoadedProvider {
            config,
            is_editable: false,
        });
    }

    Err(anyhow::anyhow!("Provider not found: {}", id))
}

pub fn register_declarative_providers(
    registry: &mut crate::providers::provider_registry::ProviderRegistry,
) -> Result<()> {
    let dir = custom_providers_dir();
    {
        let _guard = ID_GENERATION_LOCK.lock().unwrap();
        consolidate_exact_custom_provider_duplicates_locked(&dir)?;
    }
    let custom_providers = load_custom_providers(&dir)?;
    let fixed_providers = fixed_provider_configs()?;
    for config in fixed_providers {
        register_declarative_provider(registry, config, ProviderType::Declarative);
    }

    for config in custom_providers {
        if goose_providers::declarative::validate_untrusted_config(&config).is_ok() {
            register_declarative_provider(registry, config, ProviderType::Custom);
        }
    }

    Ok(())
}

/// Resolve `${VAR}` placeholders in the config's `base_url` and apply
/// runtime overrides from env_vars. Called lazily (at provider instantiation)
/// so values configured through the UI after startup are picked up.
fn resolve_config(config: &mut DeclarativeProviderConfig) -> Result<()> {
    if let Some(ref env_vars) = config.env_vars {
        config.base_url = expand_env_vars(&config.base_url, env_vars)?;

        // Check for streaming override via env_vars.
        // Config/env may store the value as a string ("true") or a native bool,
        // so try String first, then fall back to bool.
        let global_config = Config::global();
        for var in env_vars {
            if var.name.ends_with("_STREAMING") {
                let val: Option<bool> = global_config
                    .get_param::<String>(&var.name)
                    .ok()
                    .map(|s| s.to_lowercase() == "true")
                    .or_else(|| global_config.get_param::<bool>(&var.name).ok())
                    .or_else(|| var.default.as_deref().map(|d| d.to_lowercase() == "true"));
                if let Some(v) = val {
                    config.supports_streaming = Some(v);
                }
            }
        }
    }
    Ok(())
}

pub fn register_declarative_provider(
    registry: &mut crate::providers::provider_registry::ProviderRegistry,
    config: DeclarativeProviderConfig,
    provider_type: ProviderType,
) {
    let untrusted_custom = provider_type == ProviderType::Custom;
    // Each closure needs its own owned copy of config because closures are
    // moved into the registry and may be invoked much later than registration.
    // Env var expansion happens lazily inside resolve_base_url so that values
    // configured through the UI after startup are picked up.
    match config.engine {
        ProviderEngine::OpenAI => {
            let captured = config.clone();
            let identity_config = config.clone();
            if HuggingFaceProvider::matches_declarative_config(&config) {
                let inventory_configured_config = config.clone();
                registry
                    .register_with_name_and_inventory_configured::<HuggingFaceProvider, _, _, _>(
                        &config,
                        provider_type,
                        config.dynamic_models.unwrap_or(false),
                        move |tls_config| {
                            let mut cfg = captured.clone();
                            resolve_config(&mut cfg)?;
                            if untrusted_custom {
                                HuggingFaceProvider::from_untrusted_custom_config(cfg, tls_config)
                            } else {
                                HuggingFaceProvider::from_custom_config(cfg, tls_config)
                            }
                        },
                        move || {
                            let mut cfg = identity_config.clone();
                            resolve_config(&mut cfg)?;
                            declarative_inventory_identity(&cfg)
                        },
                        move || {
                            let mut cfg = inventory_configured_config.clone();
                            if resolve_config(&mut cfg).is_err() {
                                return false;
                            }
                            huggingface_declarative_inventory_configured(&cfg)
                        },
                    );
            } else if crate::providers::ollama_cloud::OllamaCloudProvider::matches_declarative_config(&config) {
                registry.register_with_name::<crate::providers::ollama_cloud::OllamaCloudProvider, _, _>(
                    &config,
                    provider_type,
                    config.dynamic_models.unwrap_or(false),
                    move |tls_config| {
                        let mut cfg = captured.clone();
                        resolve_config(&mut cfg)?;
                        if untrusted_custom {
                            crate::providers::ollama_cloud::OllamaCloudProvider::from_untrusted_custom_config(cfg, tls_config)
                        } else {
                            crate::providers::ollama_cloud::OllamaCloudProvider::from_custom_config(cfg, tls_config)
                        }
                    },
                    move || {
                        let mut cfg = identity_config.clone();
                        resolve_config(&mut cfg)?;
                        declarative_inventory_identity(&cfg)
                    },
                );
            } else {
                registry.register_with_name::<OpenAiProviderDef, _, _>(
                    &config,
                    provider_type,
                    config.dynamic_models.unwrap_or(false),
                    move |tls_config| {
                        let mut cfg = captured.clone();
                        resolve_config(&mut cfg)?;
                        if untrusted_custom {
                            crate::providers::openai_def::from_untrusted_custom_config(cfg, tls_config)
                        } else {
                            crate::providers::openai_def::from_custom_config(cfg, tls_config)
                        }
                    },
                    move || {
                        let mut cfg = identity_config.clone();
                        resolve_config(&mut cfg)?;
                        declarative_inventory_identity(&cfg)
                    },
                );
            }
        }
        ProviderEngine::Ollama => {
            let captured = config.clone();
            let identity_config = config.clone();
            registry.register_with_name::<OllamaProviderDef, _, _>(
                &config,
                provider_type,
                config.dynamic_models.unwrap_or(false),
                move |tls_config| {
                    let mut cfg = captured.clone();
                    resolve_config(&mut cfg)?;
                    if untrusted_custom {
                        crate::providers::ollama_def::from_untrusted_custom_config(cfg, tls_config)
                    } else {
                        crate::providers::ollama_def::from_custom_config(cfg, tls_config)
                    }
                },
                move || {
                    let mut cfg = identity_config.clone();
                    resolve_config(&mut cfg)?;
                    declarative_inventory_identity(&cfg)
                },
            );
        }
        ProviderEngine::Anthropic => {
            let captured = config.clone();
            let identity_config = config.clone();
            registry.register_with_name::<AnthropicProviderDef, _, _>(
                &config,
                provider_type,
                config.dynamic_models.unwrap_or(false),
                move |tls_config| {
                    let mut cfg = captured.clone();
                    resolve_config(&mut cfg)?;
                    if untrusted_custom {
                        crate::providers::anthropic_def::from_untrusted_custom_config(
                            cfg, tls_config,
                        )
                    } else {
                        crate::providers::anthropic_def::from_custom_config(cfg, tls_config)
                    }
                },
                move || {
                    let mut cfg = identity_config.clone();
                    resolve_config(&mut cfg)?;
                    declarative_inventory_identity(&cfg)
                },
            );
        }
    }
}

fn huggingface_declarative_inventory_configured(config: &DeclarativeProviderConfig) -> bool {
    huggingface_declarative_inventory_configured_from_sources(
        config,
        |key| Config::global().get_secret::<String>(key).is_ok(),
        || huggingface_auth::has_configured_token().unwrap_or(false),
    )
}

fn huggingface_declarative_inventory_configured_from_sources(
    config: &DeclarativeProviderConfig,
    provider_secret_configured: impl FnOnce(&str) -> bool,
    global_huggingface_configured: impl FnOnce() -> bool,
) -> bool {
    if !config.requires_auth {
        return true;
    }

    if !config.api_key_env.is_empty() {
        return provider_secret_configured(&config.api_key_env);
    }

    global_huggingface_configured()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_huggingface_config() -> DeclarativeProviderConfig {
        DeclarativeProviderConfig {
            name: "custom_hf".to_string(),
            engine: ProviderEngine::OpenAI,
            display_name: "Custom HF".to_string(),
            description: None,
            api_key_env: String::new(),
            base_url: "https://router.huggingface.co/v1".to_string(),
            models: vec![ModelInfo {
                name: "test/model".to_string(),
                resolved_model: None,
                context_limit: 128_000,
                input_token_cost: None,
                output_token_cost: None,
                currency: None,
                supports_cache_control: None,
                reasoning: false,
            }],
            headers: None,
            timeout_seconds: None,
            supports_streaming: Some(true),
            requires_auth: true,
            catalog_provider_id: Some("huggingface".to_string()),
            base_path: None,
            env_vars: None,
            dynamic_models: Some(false),
            skip_canonical_filtering: false,
            model_doc_link: None,
            setup_steps: Vec::new(),
            fast_model: None,
            preserves_thinking: true,
        }
    }

    #[test]
    fn huggingface_inventory_allows_unauthenticated_custom_provider() {
        let mut config = test_huggingface_config();
        config.requires_auth = false;

        assert!(huggingface_declarative_inventory_configured_from_sources(
            &config,
            |_| false,
            || false,
        ));
    }

    #[test]
    fn huggingface_inventory_accepts_provider_specific_key() {
        let mut config = test_huggingface_config();
        config.api_key_env = "CUSTOM_HF_TOKEN".to_string();

        assert!(huggingface_declarative_inventory_configured_from_sources(
            &config,
            |key| key == "CUSTOM_HF_TOKEN",
            || false,
        ));
    }

    #[test]
    fn huggingface_inventory_does_not_fallback_when_explicit_key_is_missing() {
        let mut config = test_huggingface_config();
        config.api_key_env = "CUSTOM_HF_TOKEN".to_string();

        assert!(!huggingface_declarative_inventory_configured_from_sources(
            &config,
            |_| false,
            || true,
        ));
    }

    #[test]
    fn huggingface_inventory_uses_global_token_without_provider_key() {
        let config = test_huggingface_config();

        assert!(huggingface_declarative_inventory_configured_from_sources(
            &config,
            |_| false,
            || true,
        ));
        assert!(!huggingface_declarative_inventory_configured_from_sources(
            &config,
            |_| true,
            || false,
        ));
    }

    #[test]
    fn test_bundled_providers_wire_into_registry_metadata() {
        let configs = fixed_provider_configs().expect("bundled providers should load");
        assert!(!configs.is_empty(), "no bundled providers were found");

        for config in configs {
            let id = config.id().to_string();
            let api_key_env = config.api_key_env.clone();
            let requires_auth = config.requires_auth;
            let env_vars = config.env_vars.clone().unwrap_or_default();

            let mut registry = crate::providers::provider_registry::ProviderRegistry::new(None);
            register_declarative_provider(&mut registry, config, ProviderType::Declarative);

            let (meta, provider_type) = registry
                .all_metadata_with_types()
                .into_iter()
                .find(|(m, _)| m.name == id)
                .unwrap_or_else(|| panic!("{id} should register"));

            assert_eq!(provider_type, ProviderType::Declarative, "{id}");
            assert!(!meta.display_name.is_empty(), "{id} has empty display_name");

            assert!(
                !meta
                    .config_keys
                    .iter()
                    .any(|k| k.name == "OPENAI_HOST" || k.name == "OPENAI_BASE_PATH"),
                "{id} leaks OpenAI engine config keys"
            );

            if !api_key_env.is_empty() {
                let key = meta
                    .config_keys
                    .iter()
                    .find(|k| k.name == api_key_env)
                    .unwrap_or_else(|| panic!("{id} should expose {api_key_env} config key"));
                assert!(key.secret, "{id}: {api_key_env} should be secret");
                assert_eq!(key.required, requires_auth, "{id}: {api_key_env} required");
            }

            for ev in &env_vars {
                let key = meta
                    .config_keys
                    .iter()
                    .find(|k| k.name == ev.name)
                    .unwrap_or_else(|| panic!("{id} should expose {} config key", ev.name));
                assert_eq!(key.required, ev.required, "{id}: {} required", ev.name);
                assert_eq!(key.secret, ev.secret, "{id}: {} secret", ev.name);
            }
        }
    }

    #[test]
    fn test_custom_openai_provider_missing_preserves_thinking_defaults_true() {
        let json = r#"{
            "name": "custom_reasoning",
            "engine": "openai",
            "display_name": "Custom Reasoning",
            "description": null,
            "api_key_env": "",
            "base_url": "https://example.com/v1",
            "models": [{"name": "reasoning-model", "context_limit": 128000}],
            "headers": null,
            "timeout_seconds": null,
            "supports_streaming": true,
            "requires_auth": false
        }"#;

        let config = deserialize_provider_config(json).expect("custom provider json should parse");

        assert!(matches!(config.engine, ProviderEngine::OpenAI));
        assert!(config.preserves_thinking);
    }

    #[test]
    fn test_custom_provider_explicit_preserves_thinking_false_is_kept() {
        let json = r#"{
            "name": "custom_strict",
            "engine": "openai",
            "display_name": "Custom Strict",
            "description": null,
            "api_key_env": "",
            "base_url": "https://example.com/v1",
            "models": [{"name": "strict-model", "context_limit": 128000}],
            "headers": null,
            "timeout_seconds": null,
            "supports_streaming": true,
            "requires_auth": false,
            "preserves_thinking": false
        }"#;

        let config = deserialize_provider_config(json).expect("custom provider json should parse");

        assert!(matches!(config.engine, ProviderEngine::OpenAI));
        assert!(!config.preserves_thinking);
    }

    #[test]
    fn test_validate_provider_id_rejects_legacy_punctuation_for_new_ids() {
        assert!(validate_provider_id("custom_z.ai").is_err());
    }

    #[test]
    fn test_validate_provider_id_rejects_protected_provider_ids() {
        assert!(validate_provider_id("ollama_cloud").is_err());
    }

    #[test]
    fn test_load_provider_ignores_same_named_custom_file_for_protected_id() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);

        write_legacy_provider_config("ollama_cloud", "Imposter Ollama Cloud");

        let loaded = load_provider("ollama_cloud").unwrap();

        assert!(!loaded.is_editable);
        assert_eq!(loaded.config.display_name, "Ollama Cloud");
        assert_eq!(
            loaded.config.base_url,
            "https://ollama.com/v1/chat/completions"
        );

        let mut registry = crate::providers::provider_registry::ProviderRegistry::new(None);
        register_declarative_providers(&mut registry).unwrap();
        let entry = registry
            .entries
            .get("ollama_cloud")
            .expect("fixed ollama_cloud provider should remain registered");

        assert_eq!(entry.provider_type(), ProviderType::Declarative);
        assert_eq!(entry.metadata().display_name, "Ollama Cloud");
        assert_eq!(
            entry.inventory_identity().unwrap().public_inputs["base_url"],
            "https://ollama.com/v1/chat/completions"
        );
    }

    #[tokio::test]
    async fn test_custom_config_cannot_override_protected_provider_or_reach_its_endpoint() {
        let builtin_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": [{"name": "builtin-model", "model": "builtin-model"}]
            })))
            .mount(&builtin_server)
            .await;

        let custom_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": [{"name": "custom-model", "model": "custom-model"}]
            })))
            .mount(&custom_server)
            .await;

        let mut builtin = fixed_provider_configs()
            .unwrap()
            .into_iter()
            .find(|config| config.name == "ollama_cloud")
            .unwrap();
        builtin.base_url = format!("{}/v1/chat/completions", builtin_server.uri());
        builtin.requires_auth = false;
        builtin.api_key_env.clear();

        let mut custom = builtin.clone();
        custom.display_name = "Imposter Ollama Cloud".to_string();
        custom.base_url = format!("{}/v1/chat/completions", custom_server.uri());

        let mut registry = crate::providers::provider_registry::ProviderRegistry::new(None);
        register_declarative_provider(&mut registry, builtin, ProviderType::Declarative);
        register_declarative_provider(&mut registry, custom, ProviderType::Custom);

        let (metadata, provider_type) = registry
            .all_metadata_with_types()
            .into_iter()
            .find(|(metadata, _)| metadata.name == "ollama_cloud")
            .unwrap();
        assert_eq!(provider_type, ProviderType::Declarative);
        assert_eq!(metadata.display_name, "Ollama Cloud");

        let provider = registry.create("ollama_cloud", vec![]).await.unwrap();
        assert_eq!(
            provider.fetch_supported_models().await.unwrap(),
            vec!["builtin-model".to_string()]
        );
        assert!(custom_server.received_requests().await.unwrap().is_empty());
    }

    fn write_legacy_provider_config(id: &str, display_name: &str) {
        let custom_dir = custom_providers_dir();
        std::fs::create_dir_all(&custom_dir).unwrap();
        let content = format!(
            r#"{{
  "name": "{id}",
  "engine": "openai",
  "display_name": "{display_name}",
  "description": "legacy provider",
  "api_key_env": "",
  "base_url": "https://example.invalid/v1/chat/completions",
  "models": [],
  "requires_auth": false
}}"#
        );
        std::fs::write(custom_dir.join(format!("{id}.json")), content).unwrap();
    }

    fn unauthenticated_custom_provider(
        display_name: &str,
        api_url: &str,
    ) -> CreateCustomProviderParams {
        CreateCustomProviderParams {
            engine: "openai_compatible".to_string(),
            display_name: display_name.to_string(),
            api_url: api_url.to_string(),
            api_key: None,
            models: vec!["fixture-model".to_string()],
            supports_streaming: Some(true),
            headers: None,
            requires_auth: false,
            catalog_provider_id: None,
            base_path: None,
            preserves_thinking: None,
        }
    }

    #[test]
    fn identical_custom_provider_creation_is_idempotent_across_name_case_and_spaces() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);

        let first = create_custom_provider(unauthenticated_custom_provider(
            " Local Fixture ",
            "https://example.invalid/v1",
        ))
        .unwrap();
        let second = create_custom_provider(unauthenticated_custom_provider(
            "local fixture",
            "https://example.invalid/v1",
        ))
        .unwrap();

        assert_eq!(first.name, second.name);
        assert_eq!(
            std::fs::read_dir(custom_providers_dir()).unwrap().count(),
            1
        );
    }

    #[test]
    fn same_custom_provider_name_with_a_different_address_is_rejected() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);

        create_custom_provider(unauthenticated_custom_provider(
            "Local Fixture",
            "https://one.example.invalid/v1",
        ))
        .unwrap();
        let error = create_custom_provider(unauthenticated_custom_provider(
            " local fixture ",
            "https://two.example.invalid/v1",
        ))
        .unwrap_err();

        assert!(error.to_string().contains("different address"));
        assert_eq!(
            std::fs::read_dir(custom_providers_dir()).unwrap().count(),
            1
        );
    }

    #[test]
    fn exact_legacy_duplicates_are_moved_to_recoverable_backups() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);
        let first = create_custom_provider(unauthenticated_custom_provider(
            "Local Fixture",
            "https://example.invalid/v1",
        ))
        .unwrap();
        let mut duplicate = first.clone();
        duplicate.name = "custom_local_fixture_1".to_string();
        std::fs::write(
            custom_providers_dir().join("custom_local_fixture_1.json"),
            serde_json::to_vec_pretty(&duplicate).unwrap(),
        )
        .unwrap();

        {
            let _guard = ID_GENERATION_LOCK.lock().unwrap();
            consolidate_exact_custom_provider_duplicates_locked(&custom_providers_dir()).unwrap();
        }

        let resolved = create_custom_provider(unauthenticated_custom_provider(
            " local fixture ",
            "https://example.invalid/v1",
        ))
        .unwrap();
        let entries = std::fs::read_dir(custom_providers_dir())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();

        assert_eq!(resolved.name, first.name);
        assert_eq!(
            entries
                .iter()
                .filter(|path| path
                    .extension()
                    .is_some_and(|extension| extension == "json"))
                .count(),
            1
        );
        assert!(entries.iter().any(|path| path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().contains("duplicate-backup"))));
    }

    #[test]
    fn concurrent_identical_creation_persists_one_provider() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));

        let created = std::thread::scope(|scope| {
            let first_barrier = barrier.clone();
            let first = scope.spawn(move || {
                first_barrier.wait();
                create_custom_provider(unauthenticated_custom_provider(
                    "Concurrent Fixture",
                    "https://example.invalid/v1",
                ))
                .unwrap()
            });
            let second_barrier = barrier.clone();
            let second = scope.spawn(move || {
                second_barrier.wait();
                create_custom_provider(unauthenticated_custom_provider(
                    " concurrent fixture ",
                    "https://example.invalid/v1",
                ))
                .unwrap()
            });
            barrier.wait();
            [first.join().unwrap(), second.join().unwrap()]
        });

        assert_eq!(created[0].name, created[1].name);
        assert_eq!(
            std::fs::read_dir(custom_providers_dir())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "json")
                })
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn legacy_authenticated_custom_json_is_preserved_but_never_registered_or_requested() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;

        let custom_dir = custom_providers_dir();
        std::fs::create_dir_all(&custom_dir).unwrap();
        let config_path = custom_dir.join("custom_legacy_auth.json");
        let content = format!(
            r#"{{
  "name": "custom_legacy_auth",
  "engine": "openai",
  "display_name": "Legacy Auth",
  "description": "legacy authenticated provider",
  "api_key_env": "LEGACY_API_KEY",
  "base_url": "{}/v1",
  "models": [{{"name": "fixture-model", "context_limit": 128000}}],
  "headers": null,
  "requires_auth": true
}}"#,
            server.uri()
        );
        std::fs::write(&config_path, content.as_bytes()).unwrap();
        let original = std::fs::read(&config_path).unwrap();

        let mut registry = crate::providers::provider_registry::ProviderRegistry::new(None);
        register_declarative_providers(&mut registry).unwrap();

        assert!(!registry.entries.contains_key("custom_legacy_auth"));
        assert!(registry
            .create("custom_legacy_auth", Vec::new())
            .await
            .is_err());
        assert_eq!(std::fs::read(&config_path).unwrap(), original);
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[test]
    fn authenticated_custom_create_persists_a_scoped_secret_without_plaintext() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);
        let api_url = "https://example.invalid/v1";
        let config = create_custom_provider(CreateCustomProviderParams {
            engine: "openai_compatible".to_string(),
            display_name: "Local Fixture".to_string(),
            api_url: api_url.to_string(),
            api_key: Some("fixture-secret".to_string()),
            models: vec!["fixture-model".to_string()],
            supports_streaming: Some(true),
            headers: None,
            requires_auth: true,
            catalog_provider_id: None,
            base_path: None,
            preserves_thinking: None,
        })
        .expect("authenticated custom provider should be stored after network validation");

        let expected_key_name = generate_scoped_api_key_name(&config.name, api_url).unwrap();
        assert_eq!(config.api_key_env, expected_key_name);
        assert_eq!(
            Config::global()
                .get_secret::<String>(&config.api_key_env)
                .unwrap(),
            "fixture-secret"
        );
        let stored_json =
            std::fs::read_to_string(custom_providers_dir().join(format!("{}.json", config.name)))
                .unwrap();
        assert!(!stored_json.contains("fixture-secret"));
        assert!(stored_json.contains(&config.api_key_env));
    }

    #[test]
    fn authenticated_custom_update_stores_the_new_scoped_secret() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);
        write_legacy_provider_config("custom_local", "Local");
        let config_path = custom_providers_dir().join("custom_local.json");
        let api_url = "https://example.invalid/v1";
        update_custom_provider(UpdateCustomProviderParams {
            id: "custom_local".to_string(),
            engine: "openai_compatible".to_string(),
            display_name: "Local".to_string(),
            api_url: api_url.to_string(),
            api_key: Some("updated-fixture-secret".to_string()),
            models: vec!["fixture-model".to_string()],
            supports_streaming: Some(true),
            headers: None,
            requires_auth: true,
            catalog_provider_id: None,
            base_path: None,
            preserves_thinking: None,
        })
        .expect("authenticated update should persist after network validation");

        let expected_key_name = generate_scoped_api_key_name("custom_local", api_url).unwrap();
        let updated = load_provider("custom_local").unwrap().config;
        assert_eq!(updated.api_key_env, expected_key_name);
        assert_eq!(
            Config::global()
                .get_secret::<String>(&updated.api_key_env)
                .unwrap(),
            "updated-fixture-secret"
        );
        let stored_json = std::fs::read_to_string(config_path).unwrap();
        assert!(!stored_json.contains("updated-fixture-secret"));
    }

    #[tokio::test]
    async fn unauthenticated_custom_create_rejects_credential_channels_before_persistence() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&server)
            .await;

        let cases = [
            (format!("{}/v1?api_key=fixture", server.uri()), None, None),
            (
                format!("{}/v1", server.uri()),
                Some(HashMap::from([(
                    "Authorization".to_string(),
                    "Bearer fixture".to_string(),
                )])),
                None,
            ),
            ("http://api.z.ai/api/anthropic".to_string(), None, None),
            ("ftp://example.invalid/v1".to_string(), None, None),
            (
                format!("{}/v1", server.uri()),
                None,
                Some("fixture-key".to_string()),
            ),
        ];

        for (api_url, headers, api_key) in cases {
            create_custom_provider(CreateCustomProviderParams {
                engine: "openai_compatible".to_string(),
                display_name: "Rejected Fixture".to_string(),
                api_url,
                api_key,
                models: vec!["fixture-model".to_string()],
                supports_streaming: Some(true),
                headers,
                requires_auth: false,
                catalog_provider_id: None,
                base_path: None,
                preserves_thinking: None,
            })
            .expect_err("credential channel must fail before custom persistence");
        }

        assert!(!custom_providers_dir().exists());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[test]
    fn disabled_catalog_aliases_and_non_http_updates_fail_before_persistence() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);
        write_legacy_provider_config("custom_local", "Local");
        let config_path = custom_providers_dir().join("custom_local.json");
        let original = std::fs::read(&config_path).unwrap();

        for (api_url, catalog_provider_id) in [
            ("https://example.invalid/v1", Some(" z.ai ")),
            ("https://example.invalid/v1", Some("ZHIPU")),
            ("ftp://example.invalid/v1", None),
        ] {
            update_custom_provider(UpdateCustomProviderParams {
                id: "custom_local".to_string(),
                engine: "openai_compatible".to_string(),
                display_name: "Local".to_string(),
                api_url: api_url.to_string(),
                api_key: None,
                models: vec!["fixture-model".to_string()],
                supports_streaming: Some(true),
                headers: None,
                requires_auth: false,
                catalog_provider_id: catalog_provider_id.map(str::to_string),
                base_path: None,
                preserves_thinking: None,
            })
            .expect_err("disabled aliases and non-HTTP URLs must fail before persistence");
            assert_eq!(std::fs::read(&config_path).unwrap(), original);
        }
    }

    #[test]
    fn disabled_catalog_aliases_fail_before_create_persistence() {
        for catalog_provider_id in [" z.ai ", "ZHIPU", " zai ", " NVIDIA "] {
            let temp_dir = tempfile::tempdir().unwrap();
            let temp_root = temp_dir.path().display().to_string();
            let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);

            create_custom_provider(CreateCustomProviderParams {
                engine: "openai_compatible".to_string(),
                display_name: "Rejected Alias".to_string(),
                api_url: "https://example.invalid/v1".to_string(),
                api_key: None,
                models: vec!["fixture-model".to_string()],
                supports_streaming: Some(true),
                headers: None,
                requires_auth: false,
                catalog_provider_id: Some(catalog_provider_id.to_string()),
                base_path: None,
                preserves_thinking: None,
            })
            .expect_err("disabled catalog aliases must fail before persistence");
            assert!(!custom_providers_dir().exists());
        }
    }

    #[test]
    fn test_load_provider_allows_legacy_custom_id_with_punctuation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);

        write_legacy_provider_config("custom_z.ai", "Z.AI");

        let loaded = load_provider("custom_z.ai").unwrap();
        assert!(loaded.is_editable);
        assert_eq!(loaded.config.name, "custom_z.ai");
    }

    #[test]
    fn test_update_and_remove_provider_allow_legacy_custom_id_with_punctuation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let temp_root = temp_dir.path().display().to_string();
        let _guard = env_lock::lock_env([("GOOSE_PATH_ROOT", Some(temp_root.as_str()))]);

        write_legacy_provider_config("custom_z.ai", "Z.AI");

        update_custom_provider(UpdateCustomProviderParams {
            id: "custom_z.ai".to_string(),
            engine: "openai".to_string(),
            display_name: "Z.AI Updated".to_string(),
            api_url: "https://updated.example.invalid/v1/chat/completions".to_string(),
            api_key: None,
            models: vec!["z-model".to_string()],
            supports_streaming: Some(true),
            headers: None,
            requires_auth: false,
            catalog_provider_id: None,
            base_path: None,
            preserves_thinking: None,
        })
        .unwrap();

        let updated = load_provider("custom_z.ai").unwrap();
        assert_eq!(updated.config.display_name, "Z.AI Updated");
        assert_eq!(updated.config.models[0].name, "z-model");

        remove_custom_provider("custom_z.ai").unwrap();
        assert!(!custom_providers_dir().join("custom_z.ai.json").exists());
    }

    #[test]
    fn test_load_provider_rejects_path_segments() {
        assert!(load_provider("custom_../secret").is_err());
        assert!(load_provider("custom_..\\secret").is_err());
    }

    #[test]
    fn test_expand_env_vars_replaces_placeholder() {
        let _guard = env_lock::lock_env([("TEST_EXPAND_HOST", Some("https://example.com/api"))]);

        let env_vars = vec![EnvVarConfig {
            name: "TEST_EXPAND_HOST".to_string(),
            required: true,
            secret: false,
            primary: None,
            description: None,
            default: None,
        }];

        let result = expand_env_vars("${TEST_EXPAND_HOST}/v1/chat/completions", &env_vars).unwrap();
        assert_eq!(result, "https://example.com/api/v1/chat/completions");
    }

    #[test]
    fn test_expand_env_vars_required_missing_errors() {
        let _guard = env_lock::lock_env([("TEST_EXPAND_MISSING", None::<&str>)]);

        let env_vars = vec![EnvVarConfig {
            name: "TEST_EXPAND_MISSING".to_string(),
            required: true,
            secret: false,
            primary: None,
            description: None,
            default: None,
        }];

        let result = expand_env_vars("${TEST_EXPAND_MISSING}/path", &env_vars);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("TEST_EXPAND_MISSING"));
    }

    #[test]
    fn test_expand_env_vars_uses_default_when_missing() {
        let _guard = env_lock::lock_env([("TEST_EXPAND_DEFAULT", None::<&str>)]);

        let env_vars = vec![EnvVarConfig {
            name: "TEST_EXPAND_DEFAULT".to_string(),
            required: false,
            secret: false,
            primary: None,
            description: None,
            default: Some("https://fallback.example.com".to_string()),
        }];

        let result =
            expand_env_vars("${TEST_EXPAND_DEFAULT}/v1/chat/completions", &env_vars).unwrap();
        assert_eq!(result, "https://fallback.example.com/v1/chat/completions");
    }

    #[test]
    fn test_expand_env_vars_no_placeholders_passthrough() {
        let env_vars = vec![EnvVarConfig {
            name: "UNUSED_VAR".to_string(),
            required: true,
            secret: false,
            primary: None,
            description: None,
            default: None,
        }];

        let result =
            expand_env_vars("https://static.example.com/v1/chat/completions", &env_vars).unwrap();
        assert_eq!(result, "https://static.example.com/v1/chat/completions");
    }

    #[test]
    fn test_expand_env_vars_empty_slice_passthrough() {
        let result = expand_env_vars("${WHATEVER}/path", &[]).unwrap();
        assert_eq!(result, "${WHATEVER}/path");
    }

    #[test]
    fn test_expand_env_vars_env_value_overrides_default() {
        let _guard = env_lock::lock_env([("TEST_EXPAND_OVERRIDE", Some("https://from-env.com"))]);

        let env_vars = vec![EnvVarConfig {
            name: "TEST_EXPAND_OVERRIDE".to_string(),
            required: false,
            secret: false,
            primary: None,
            description: None,
            default: Some("https://from-default.com".to_string()),
        }];

        let result = expand_env_vars("${TEST_EXPAND_OVERRIDE}/path", &env_vars).unwrap();
        assert_eq!(result, "https://from-env.com/path");
    }
}
