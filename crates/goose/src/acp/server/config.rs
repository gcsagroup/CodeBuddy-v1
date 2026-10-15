use super::*;
use goose_providers::thinking::ThinkingEffort;

const SECRET_MASK_SHOW_LEN: usize = 8;
const LOCAL_WHISPER_MODEL_CONFIG_KEY: &str = "LOCAL_WHISPER_MODEL";

fn is_codepro_model_routing_key(key: &str) -> bool {
    key.eq_ignore_ascii_case(CODEPRO_MODEL_ROUTING_CONFIG_KEY)
}

fn is_local_whisper_model_key(key: &str) -> bool {
    key.eq_ignore_ascii_case(LOCAL_WHISPER_MODEL_CONFIG_KEY)
}

fn is_generic_config_read_hidden(key: &str) -> bool {
    is_codepro_model_routing_key(key)
        || is_preference_owned_key(key)
        || is_local_whisper_model_key(key)
}

fn ensure_generic_config_key_is_mutable(key: &str) -> Result<(), agent_client_protocol::Error> {
    ensure_generic_config_key_is_not_preference_owned(key)?;
    if is_local_whisper_model_key(key) {
        return Err(
            agent_client_protocol::Error::invalid_params().data(serde_json::json!({
                "code": "dictation_model_owned_key",
                "message": "Use the typed dictation model API for this setting.",
            })),
        );
    }
    Ok(())
}

fn generic_config_blocked_mutation_keys() -> Vec<String> {
    vec![LOCAL_WHISPER_MODEL_CONFIG_KEY.to_string()]
}

fn mask_secret(secret: serde_json::Value) -> String {
    let as_string = match secret {
        serde_json::Value::String(s) => s,
        _ => serde_json::to_string(&secret).unwrap_or_else(|_| secret.to_string()),
    };

    let chars: Vec<_> = as_string.chars().collect();
    let show_len = std::cmp::min(chars.len() / 2, SECRET_MASK_SHOW_LEN);
    let visible: String = chars.iter().take(show_len).collect();
    let mask = "*".repeat(chars.len() - show_len);

    format!("{}{}", visible, mask)
}

impl GooseAcpAgent {
    pub(super) async fn on_preferences_read(
        &self,
        req: PreferencesReadRequest,
    ) -> Result<PreferencesReadResponse, agent_client_protocol::Error> {
        let keys = if req.keys.is_empty() {
            PREFERENCE_DEFS.iter().map(|def| def.key).collect()
        } else {
            req.keys
        };
        ensure_unique_preference_keys(keys.iter().copied())?;
        let config = self.config()?;
        let defs = keys
            .iter()
            .map(|key| preference_def(*key))
            .collect::<Result<Vec<_>, _>>()?;
        let snapshot_keys = defs
            .iter()
            .flat_map(|def| {
                std::iter::once(def.config_key.to_string())
                    .chain(def.legacy_config_keys.iter().map(|key| (*key).to_string()))
            })
            .collect::<Vec<_>>();
        let (revision, snapshot) = config
            .get_merged_param_values_with_revision(
                crate::config::PREFERENCES_REVISION_KEY,
                &snapshot_keys,
            )
            .map_err(|error| preference_store_error(&error))?;
        let mut values = Vec::with_capacity(keys.len());

        for def in defs {
            let managed_value = preference_value_from_environment(def)?;
            let is_mutable = managed_value.is_none();
            values.push(PreferenceValue {
                key: def.key,
                value: managed_value
                    .unwrap_or_else(|| preference_value_from_snapshot(def, &snapshot)),
                is_mutable,
            });
        }

        Ok(PreferencesReadResponse { revision, values })
    }

    pub(super) async fn on_preferences_save(
        &self,
        req: PreferencesSaveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        ensure_unique_preference_keys(req.values.iter().map(|value| value.key))?;
        let mut updates = Vec::with_capacity(req.values.len());
        let mut deletes = Vec::new();
        let mut managed_env_keys = Vec::with_capacity(req.values.len());

        for preference in &req.values {
            let def = preference_def(preference.key)?;
            managed_env_keys.push(def.config_key.to_string());
            if preference.key == PreferenceKey::VoiceDictationPreferredMic
                && preference.value.is_null()
            {
                deletes.push(def.config_key.to_string());
            } else {
                let value = (def.prepare)(&preference.value)?;
                updates.push((def.config_key.to_string(), value));
            }
            deletes.extend(def.legacy_config_keys.iter().map(|key| (*key).to_string()));
        }

        let config = self.config()?;
        match config.set_param_values_if_revision_unless_env_managed(
            crate::config::PREFERENCES_REVISION_KEY,
            req.expected_revision,
            &updates,
            &deletes,
            &managed_env_keys,
        ) {
            Ok(_) => {}
            Err(crate::config::ConfigError::PreferenceRevisionConflict { expected, actual }) => {
                return Err(preference_revision_conflict(expected, actual));
            }
            Err(crate::config::ConfigError::PreferenceManagedKey { key }) => {
                return Err(preference_managed_key(&key));
            }
            Err(error) => return Err(preference_store_error(&error)),
        }
        if req
            .values
            .iter()
            .any(|value| value.key == PreferenceKey::AutoCompactThreshold)
        {
            let ids: Vec<_> = self.sessions.lock().await.keys().cloned().collect();
            for session_id in ids {
                self.schedule_idle_compaction(&session_id).await;
            }
        }
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_preferences_remove(
        &self,
        req: PreferencesRemoveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        ensure_unique_preference_keys(req.keys.iter().copied())?;
        let mut deletes = Vec::new();
        let mut managed_env_keys = Vec::with_capacity(req.keys.len());
        for key in req.keys {
            let def = preference_def(key)?;
            managed_env_keys.push(def.config_key.to_string());
            deletes.push(def.config_key.to_string());
            deletes.extend(def.legacy_config_keys.iter().map(|key| (*key).to_string()));
        }
        let config = self.config()?;
        match config.set_param_values_if_revision_unless_env_managed(
            crate::config::PREFERENCES_REVISION_KEY,
            req.expected_revision,
            &[],
            &deletes,
            &managed_env_keys,
        ) {
            Ok(_) => {}
            Err(crate::config::ConfigError::PreferenceRevisionConflict { expected, actual }) => {
                return Err(preference_revision_conflict(expected, actual));
            }
            Err(crate::config::ConfigError::PreferenceManagedKey { key }) => {
                return Err(preference_managed_key(&key));
            }
            Err(error) => return Err(preference_store_error(&error)),
        }
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_config_read(
        &self,
        req: ConfigReadRequest,
    ) -> Result<ConfigReadResponse, agent_client_protocol::Error> {
        let config = self.config()?;

        if is_generic_config_read_hidden(&req.key) {
            return Ok(ConfigReadResponse {
                value: serde_json::Value::Null,
            });
        }

        if req.key == "GOOSE_PROVIDER" || req.key == "active_provider" {
            let value = config
                .get_goose_provider()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            return Ok(ConfigReadResponse { value });
        }
        if req.key == "GOOSE_MODEL" {
            let value = config
                .get_goose_model()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            return Ok(ConfigReadResponse { value });
        }

        let value = match config.get(&req.key, req.is_secret) {
            Ok(value) if req.is_secret => serde_json::Value::String(mask_secret(value)),
            Ok(value) => value,
            Err(crate::config::ConfigError::NotFound(_)) => serde_json::Value::Null,
            Err(e) => {
                return Err(agent_client_protocol::Error::internal_error().data(e.to_string()));
            }
        };
        Ok(ConfigReadResponse { value })
    }

    pub(super) async fn on_config_upsert(
        &self,
        req: ConfigUpsertRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        ensure_generic_config_key_is_mutable(&req.key)?;
        super::providers::ensure_generic_config_key_is_not_provider_owned(&req.key).await?;
        let config = self.config()?;

        if req.key == "GOOSE_PROVIDER" {
            if let Some(name) = req.value.as_str() {
                let model = crate::config::get_provider_entry(config, name)
                    .map(|e| e.model)
                    .or_else(|| config.get_goose_model().ok())
                    .unwrap_or_default();
                crate::config::set_active_provider(config, name, &model).internal_err()?;
                return Ok(EmptyResponse {});
            }
        }
        if req.key == crate::agents::platform_extensions::common_queries::CONFIG_KEY {
            let settings: crate::agents::platform_extensions::common_queries::QuerySettings =
                serde_json::from_value(req.value.clone()).map_err(|e| {
                    agent_client_protocol::Error::invalid_params().data(e.to_string())
                })?;
            settings
                .validate()
                .map_err(|e| agent_client_protocol::Error::invalid_params().data(e))?;
        }
        if req.key == "GOOSE_MODEL" {
            if let Some(model) = req.value.as_str() {
                if let Ok(provider) = config.get_goose_provider() {
                    crate::config::set_active_provider(config, &provider, model).internal_err()?;
                    return Ok(EmptyResponse {});
                }
            }
        }

        config
            .set(&req.key, &req.value, req.is_secret)
            .internal_err()?;
        Ok(EmptyResponse {})
    }

    pub(super) async fn on_config_remove(
        &self,
        req: ConfigRemoveRequest,
    ) -> Result<EmptyResponse, agent_client_protocol::Error> {
        ensure_generic_config_key_is_mutable(&req.key)?;
        super::providers::ensure_generic_config_key_is_not_provider_owned(&req.key).await?;
        let config = self.config()?;

        if req.is_secret {
            config.delete_secret(&req.key).internal_err()?;
        } else if req.key == "GOOSE_PROVIDER" || req.key == "active_provider" {
            config.delete("active_provider").internal_err()?;
            config.delete("GOOSE_PROVIDER").internal_err()?;
        } else if req.key == "GOOSE_MODEL" {
            if let Ok(provider) = config.get_goose_provider() {
                crate::config::set_active_provider(config, &provider, "").internal_err()?;
            }
            config.delete("GOOSE_MODEL").internal_err()?;
        } else {
            config.delete(&req.key).internal_err()?;
        }

        Ok(EmptyResponse {})
    }

    pub(super) async fn on_config_read_all(
        &self,
        _req: ConfigReadAllRequest,
    ) -> Result<ConfigReadAllResponse, agent_client_protocol::Error> {
        let config = self.config()?;
        let mut values = config.all_values().internal_err()?;
        values.retain(|key, _| !is_generic_config_read_hidden(key));
        let mut blocked_mutation_keys = super::providers::provider_owned_config_keys().await;
        blocked_mutation_keys.extend(preference_owned_config_keys());
        blocked_mutation_keys.extend(generic_config_blocked_mutation_keys());
        Ok(ConfigReadAllResponse {
            config: values,
            blocked_mutation_keys,
        })
    }

    pub(super) async fn on_codepro_model_routing_read(
        &self,
        _req: CodeProModelRoutingReadRequest,
    ) -> Result<CodeProModelRoutingReadResponse, agent_client_protocol::Error> {
        let config = self.config()?;
        let routing =
            match config.get_param::<CodeProModelRoutingConfig>(CODEPRO_MODEL_ROUTING_CONFIG_KEY) {
                Ok(routing) => Some(routing),
                Err(crate::config::ConfigError::NotFound(_)) => None,
                Err(error) => {
                    return Err(agent_client_protocol::Error::internal_error()
                        .data(format!("Invalid persisted CodePro model routing: {error}")));
                }
            };
        Ok(CodeProModelRoutingReadResponse { config: routing })
    }

    pub(super) async fn on_model_capability_overrides_read(
        &self,
        _req: ModelCapabilityOverridesReadRequest,
    ) -> Result<ModelCapabilityOverridesReadResponse, agent_client_protocol::Error> {
        let config = self.config()?;
        let config = match config
            .get_param::<ModelCapabilityOverridesConfig>(MODEL_CAPABILITY_OVERRIDES_CONFIG_KEY)
        {
            Ok(config) => config,
            Err(crate::config::ConfigError::NotFound(_)) => {
                ModelCapabilityOverridesConfig::default()
            }
            Err(error) => {
                return Err(agent_client_protocol::Error::internal_error().data(format!(
                    "Invalid persisted model capability overrides: {error}"
                )));
            }
        };
        Ok(ModelCapabilityOverridesReadResponse { config })
    }

    pub(super) async fn on_model_capability_overrides_save(
        &self,
        req: ModelCapabilityOverridesSaveRequest,
    ) -> Result<ModelCapabilityOverridesConfig, agent_client_protocol::Error> {
        let canonical = serde_json::to_value(req.config)
            .and_then(serde_json::from_value::<ModelCapabilityOverridesConfig>)
            .map_err(|error| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("Invalid model capability overrides: {error}"))
            })?;
        self.config()?
            .set_param(MODEL_CAPABILITY_OVERRIDES_CONFIG_KEY, &canonical)
            .internal_err_ctx("Failed to save model capability overrides")?;
        Ok(canonical)
    }

    pub(super) async fn on_model_capability_resolve(
        &self,
        req: ModelCapabilityResolveRequest,
    ) -> Result<ModelCapabilityResolveResponse, agent_client_protocol::Error> {
        let provider_id = req.provider_id.trim().to_string();
        let model_id = req.model_id.trim().to_string();
        if provider_id.is_empty() || model_id.is_empty() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("providerId and modelId cannot be blank"));
        }
        let resolved = crate::providers::model_capabilities::resolve_image_input_with_config(
            self.config()?,
            &provider_id,
            &model_id,
        );
        Ok(ModelCapabilityResolveResponse {
            provider_id,
            model_id,
            image_input: resolved.state,
            source: resolved.source,
        })
    }

    async fn validate_live_provider_models(
        &self,
        provider_id: &str,
        requested_models: &[String],
    ) -> Result<(), agent_client_protocol::Error> {
        if provider_id == "local" {
            for model_id in requested_models {
                if !local_inference_model_exists(model_id)? {
                    return Err(agent_client_protocol::Error::invalid_params().data(format!(
                        "Model '{model_id}' is not available for provider '{provider_id}'"
                    )));
                }
            }
            return Ok(());
        }

        if super::providers::validate_saved_custom_provider_models(provider_id, requested_models)
            .await?
        {
            return Ok(());
        }

        let requires_credential_validation = match crate::providers::get_from_registry(provider_id)
            .await
        {
            Ok(entry) => entry.metadata().config_keys.iter().any(|key| {
                key.primary && key.secret && !key.oauth_flow && key.credential_validation_supported
            }),
            Err(_) => crate::config::declarative_providers::load_provider(provider_id)
                .map(|loaded| loaded.config.requires_auth)
                .unwrap_or(true),
        };

        let provider = self
            .create_provider(provider_id, Vec::new(), None)
            .await
            .map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(format!(
                    "Failed to initialize provider '{provider_id}': {error}"
                ))
            })?;
        if requires_credential_validation {
            provider.validate_credentials().await.map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(format!(
                    "Provider credential validation failed for '{provider_id}': {error}"
                ))
            })?;
        }
        let supported_models = provider.fetch_supported_models().await.map_err(|error| {
            agent_client_protocol::Error::invalid_params().data(format!(
                "Failed to fetch supported models for provider '{provider_id}': {error}"
            ))
        })?;
        for model_id in requested_models {
            if !supported_models.iter().any(|model| model == model_id) {
                return Err(agent_client_protocol::Error::invalid_params().data(format!(
                    "Model '{model_id}' is not available for provider '{provider_id}'"
                )));
            }
        }
        Ok(())
    }

    pub(super) async fn on_codepro_model_routing_save(
        &self,
        req: CodeProModelRoutingSaveRequest,
    ) -> Result<CodeProModelRoutingConfig, agent_client_protocol::Error> {
        let canonical = serde_json::to_value(req.config)
            .and_then(serde_json::from_value::<CodeProModelRoutingConfig>)
            .map_err(|error| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("Invalid CodePro model routing: {error}"))
            })?;

        let mut provider_models = Vec::<(String, Vec<String>)>::new();
        // Inactive preferences may reference an offline or removed provider. Validate
        // availability only when enabling them; disabling must not require network access.
        for route in canonical
            .routes
            .iter()
            .filter(|_| canonical.advanced_routing_enabled)
        {
            match provider_models
                .iter_mut()
                .find(|(provider_id, _)| provider_id == &route.provider_id)
            {
                Some((_, models)) if !models.contains(&route.model_id) => {
                    models.push(route.model_id.clone());
                }
                Some(_) => {}
                None => {
                    provider_models.push((route.provider_id.clone(), vec![route.model_id.clone()]))
                }
            }
        }
        if let (Some(provider_id), Some(model_id)) = (
            canonical.vision_route.provider_id.as_ref(),
            canonical.vision_route.model_id.as_ref(),
        ) {
            match provider_models
                .iter_mut()
                .find(|(candidate, _)| candidate == provider_id)
            {
                Some((_, models)) if !models.contains(model_id) => models.push(model_id.clone()),
                Some(_) => {}
                None => provider_models.push((provider_id.clone(), vec![model_id.clone()])),
            }
        }

        for (provider_id, requested_models) in provider_models {
            self.validate_live_provider_models(&provider_id, &requested_models)
                .await?;
        }

        self.config()?
            .set_param(CODEPRO_MODEL_ROUTING_CONFIG_KEY, &canonical)
            .internal_err_ctx("Failed to save CodePro model routing")?;
        Ok(canonical)
    }

    pub(super) async fn on_defaults_read(
        &self,
        _req: DefaultsReadRequest,
    ) -> Result<DefaultsReadResponse, agent_client_protocol::Error> {
        let config = self.config()?;
        let pair = config
            .get_goose_provider()
            .ok()
            .zip(config.get_goose_model().ok())
            .map(|(provider, model)| (provider.trim().to_string(), model.trim().to_string()))
            .filter(|(provider, model)| !provider.is_empty() && !model.is_empty());
        let enabled = if let Some((provider_id, _)) = pair.as_ref() {
            match crate::providers::get_from_registry(provider_id).await {
                Ok(entry) => super::providers::ensure_provider_credential_activation_supported(
                    entry.metadata(),
                )
                .is_ok(),
                Err(_) => false,
            }
        } else {
            false
        };
        let (provider_id, model_id) = enabled
            .then_some(pair)
            .flatten()
            .map(|(provider, model)| (Some(provider), Some(model)))
            .unwrap_or((None, None));
        Ok(DefaultsReadResponse {
            provider_id,
            model_id,
        })
    }

    pub(super) async fn on_defaults_save(
        &self,
        req: DefaultsSaveRequest,
    ) -> Result<DefaultsReadResponse, agent_client_protocol::Error> {
        let provider_id = req.provider_id.trim().to_string();
        if provider_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("providerId cannot be empty")
            );
        }

        let model_id = req.model_id.trim().to_string();
        if model_id.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("modelId cannot be empty")
            );
        }

        let model = model_id;
        self.validate_live_provider_models(&provider_id, std::slice::from_ref(&model))
            .await?;

        let config = self.config()?;
        crate::config::set_active_provider(config, &provider_id, &model)
            .internal_err_ctx("Failed to save default provider")?;

        Ok(DefaultsReadResponse {
            provider_id: Some(provider_id),
            model_id: Some(model),
        })
    }

    pub(super) async fn on_defaults_clear(
        &self,
        _req: DefaultsClearRequest,
    ) -> Result<DefaultsReadResponse, agent_client_protocol::Error> {
        let config = self.config()?;
        crate::config::clear_active_provider(config)
            .internal_err_ctx("Failed to clear default provider")?;

        Ok(DefaultsReadResponse {
            provider_id: None,
            model_id: None,
        })
    }
}

pub(super) fn validate_provider_model<'a>(
    provider_id: &str,
    model_id: &str,
    default_model: &str,
    models: impl Iterator<Item = &'a str>,
) -> Result<(), agent_client_protocol::Error> {
    if model_id == default_model || models.into_iter().any(|available| available == model_id) {
        return Ok(());
    }

    Err(agent_client_protocol::Error::invalid_params().data(format!(
        "Model '{model_id}' is not available for provider '{provider_id}'"
    )))
}

fn local_inference_model_exists(model_id: &str) -> Result<bool, agent_client_protocol::Error> {
    #[cfg(feature = "local-inference")]
    {
        crate::providers::local_inference::management::model_exists(model_id)
            .internal_err_ctx("Failed to read local inference models")
    }

    #[cfg(not(feature = "local-inference"))]
    {
        let _ = model_id;
        Ok(false)
    }
}

struct PreferenceDef {
    key: PreferenceKey,
    config_key: &'static str,
    legacy_config_keys: &'static [&'static str],
    prepare: fn(&serde_json::Value) -> Result<serde_json::Value, agent_client_protocol::Error>,
}

const PREFERENCE_DEFS: &[PreferenceDef] = &[
    PreferenceDef {
        key: PreferenceKey::AutoCompactThreshold,
        config_key: "GOOSE_AUTO_COMPACT_THRESHOLD",
        legacy_config_keys: &[],
        prepare: prepare_auto_compact_threshold,
    },
    PreferenceDef {
        key: PreferenceKey::GooseMode,
        config_key: "GOOSE_MODE",
        legacy_config_keys: &[],
        prepare: prepare_goose_mode,
    },
    PreferenceDef {
        key: PreferenceKey::GooseThinkingEffort,
        config_key: "GOOSE_THINKING_EFFORT",
        legacy_config_keys: &[],
        prepare: prepare_thinking_effort,
    },
    PreferenceDef {
        key: PreferenceKey::GooseMaxTurns,
        config_key: "GOOSE_MAX_TURNS",
        legacy_config_keys: &[],
        prepare: prepare_max_turns,
    },
    PreferenceDef {
        key: PreferenceKey::PersonalizedMemoryEnabled,
        config_key: "CODEPRO_PERSONALIZED_MEMORY_ENABLED",
        legacy_config_keys: &[],
        prepare: prepare_boolean,
    },
    PreferenceDef {
        key: PreferenceKey::VoiceAutoSubmitPhrases,
        config_key: "VOICE_AUTO_SUBMIT_PHRASES",
        legacy_config_keys: &[],
        prepare: prepare_voice_auto_submit_phrases,
    },
    PreferenceDef {
        key: PreferenceKey::VoiceDictationProvider,
        config_key: "VOICE_DICTATION_PROVIDER",
        legacy_config_keys: &["voice_dictation_provider"],
        prepare: prepare_voice_dictation_provider,
    },
    PreferenceDef {
        key: PreferenceKey::VoiceDictationPreferredMic,
        config_key: "VOICE_DICTATION_PREFERRED_MIC",
        legacy_config_keys: &["voice_dictation_preferred_mic"],
        prepare: prepare_voice_dictation_preferred_mic,
    },
];

fn preference_def(
    key: PreferenceKey,
) -> Result<&'static PreferenceDef, agent_client_protocol::Error> {
    PREFERENCE_DEFS
        .iter()
        .find(|def| def.key == key)
        .ok_or_else(|| {
            agent_client_protocol::Error::internal_error()
                .data(format!("Missing preference definition for {key:?}"))
        })
}

fn ensure_unique_preference_keys(
    keys: impl IntoIterator<Item = PreferenceKey>,
) -> Result<(), agent_client_protocol::Error> {
    let mut seen = Vec::new();
    for key in keys {
        if seen.contains(&key) {
            return Err(
                agent_client_protocol::Error::invalid_params().data(serde_json::json!({
                    "code": "duplicate_preference_key",
                    "message": "Each preference key may appear only once per request.",
                    "key": serde_json::to_value(key).unwrap_or(serde_json::Value::Null),
                })),
            );
        }
        seen.push(key);
    }
    Ok(())
}

fn preference_value_from_environment(
    def: &PreferenceDef,
) -> Result<Option<serde_json::Value>, agent_client_protocol::Error> {
    let Some(raw) = std::env::var_os(def.config_key) else {
        return Ok(None);
    };
    let raw = raw
        .into_string()
        .map_err(|_| preference_managed_value_invalid(def.key))?;
    if raw.trim().is_empty() {
        return Err(preference_managed_value_invalid(def.key));
    }
    let parsed = crate::config::Config::parse_env_value(&raw)
        .map_err(|_| preference_managed_value_invalid(def.key))?;
    let value = (def.prepare)(&parsed).map_err(|_| preference_managed_value_invalid(def.key))?;
    Ok(Some(value))
}

fn preference_value_from_snapshot(
    def: &PreferenceDef,
    snapshot: &std::collections::HashMap<String, serde_json::Value>,
) -> serde_json::Value {
    if let Some(canonical) = snapshot.get(def.config_key) {
        let canonical_is_empty =
            canonical.is_null() || canonical.as_str().is_some_and(|value| value.is_empty());
        if !canonical_is_empty {
            return (def.prepare)(canonical).unwrap_or(serde_json::Value::Null);
        }
    }

    def.legacy_config_keys
        .iter()
        .filter_map(|key| snapshot.get(*key))
        .find_map(|legacy| (def.prepare)(legacy).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn preference_revision_conflict(expected: u64, actual: u64) -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_params().data(serde_json::json!({
        "code": "preference_revision_conflict",
        "message": "Preferences changed in another window. Reload and try again.",
        "expectedRevision": expected,
        "actualRevision": actual,
    }))
}

fn preference_managed_value_invalid(key: PreferenceKey) -> agent_client_protocol::Error {
    agent_client_protocol::Error::invalid_params().data(serde_json::json!({
        "code": "preference_managed_value_invalid",
        "message": "A managed preference value is invalid. Update the environment and retry.",
        "key": serde_json::to_value(key).unwrap_or(serde_json::Value::Null),
    }))
}

fn preference_managed_key(config_key: &str) -> agent_client_protocol::Error {
    let key = PREFERENCE_DEFS
        .iter()
        .find(|def| def.config_key == config_key)
        .map(|def| serde_json::to_value(def.key).unwrap_or(serde_json::Value::Null))
        .unwrap_or(serde_json::Value::Null);
    agent_client_protocol::Error::invalid_params().data(serde_json::json!({
        "code": "preference_managed_key",
        "message": "This preference is managed by the environment and cannot be changed here.",
        "key": key,
    }))
}

fn preference_store_error(_error: &crate::config::ConfigError) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(serde_json::json!({
        "code": "preference_store_unavailable",
        "message": "Preferences could not be read or saved. Try again.",
    }))
}

fn is_preference_owned_key(key: &str) -> bool {
    key.eq_ignore_ascii_case(crate::config::PREFERENCES_REVISION_KEY)
        || PREFERENCE_DEFS.iter().any(|def| {
            def.config_key.eq_ignore_ascii_case(key)
                || def
                    .legacy_config_keys
                    .iter()
                    .any(|legacy| legacy.eq_ignore_ascii_case(key))
        })
}

fn preference_owned_config_keys() -> Vec<String> {
    PREFERENCE_DEFS
        .iter()
        .flat_map(|def| {
            std::iter::once(def.config_key.to_string())
                .chain(def.legacy_config_keys.iter().map(|key| (*key).to_string()))
        })
        .chain(std::iter::once(
            crate::config::PREFERENCES_REVISION_KEY.to_string(),
        ))
        .collect()
}

fn ensure_generic_config_key_is_not_preference_owned(
    key: &str,
) -> Result<(), agent_client_protocol::Error> {
    if is_preference_owned_key(key) {
        return Err(
            agent_client_protocol::Error::invalid_params().data(serde_json::json!({
                "code": "preference_owned_key",
                "message": "Use the versioned preferences API for this setting.",
            })),
        );
    }
    Ok(())
}

fn prepare_max_turns(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    let max_turns = value
        .as_u64()
        .and_then(|value| crate::config::MaxTurns::try_from(value).ok())
        .ok_or_else(|| {
            agent_client_protocol::Error::invalid_params().data(serde_json::json!({
                "code": "invalid_max_turns",
                "message": "Maximum turns must be an integer between 1 and 10000.",
            }))
        })?;

    Ok(serde_json::json!(max_turns.get()))
}

fn prepare_boolean(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    value.as_bool().map(serde_json::Value::Bool).ok_or_else(|| {
        agent_client_protocol::Error::invalid_params().data("Preference value must be a boolean")
    })
}

fn prepare_goose_mode(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    let mode = value
        .as_str()
        .and_then(|value| value.parse::<crate::config::GooseMode>().ok())
        .ok_or_else(|| {
            agent_client_protocol::Error::invalid_params().data(serde_json::json!({
                "code": "invalid_goose_mode",
                "message": "Mode must be one of auto, approve, smart_approve, or chat.",
            }))
        })?;
    Ok(serde_json::Value::String(mode.to_string()))
}

fn prepare_auto_compact_threshold(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    let Some(threshold) = value.as_f64() else {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("autoCompactThreshold must be a number"));
    };
    if !threshold.is_finite() || threshold <= 0.0 || threshold > 1.0 {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("autoCompactThreshold must be greater than 0 and at most 1"));
    }

    Ok(value.clone())
}

fn prepare_thinking_effort(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    let Some(value) = value.as_str() else {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("gooseThinkingEffort must be a string"));
    };
    let effort = value.parse::<ThinkingEffort>().map_err(|err| {
        agent_client_protocol::Error::invalid_params()
            .data(format!("Invalid gooseThinkingEffort: {err}"))
    })?;

    Ok(serde_json::Value::String(effort.to_string()))
}

fn prepare_voice_auto_submit_phrases(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    if !value.is_string() {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("voiceAutoSubmitPhrases must be a string"));
    }

    Ok(value.clone())
}

fn prepare_voice_dictation_provider(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    let Some(value) = value.as_str() else {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("voiceDictationProvider must be a string"));
    };
    if !is_supported_voice_dictation_provider(value) {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("voiceDictationProvider is not supported"));
    }

    Ok(serde_json::Value::String(value.to_string()))
}

fn prepare_voice_dictation_preferred_mic(
    value: &serde_json::Value,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    let Some(value) = value.as_str() else {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("voiceDictationPreferredMic must be a string"));
    };
    if value.is_empty() {
        return Err(agent_client_protocol::Error::invalid_params()
            .data("voiceDictationPreferredMic must be non-empty"));
    }

    Ok(serde_json::Value::String(value.to_string()))
}

fn is_supported_voice_dictation_provider(value: &str) -> bool {
    matches!(value, "openai" | "groq" | "elevenlabs" | "__disabled__") || {
        #[cfg(feature = "local-inference")]
        {
            value == "local"
        }
        #[cfg(not(feature = "local-inference"))]
        {
            false
        }
    }
}

#[cfg(test)]
mod model_selection_tests {
    use super::*;

    #[test]
    fn rejects_a_model_from_a_different_provider() {
        let models = ["claude-sonnet-4-5", "claude-opus-4-1"];

        let error = validate_provider_model(
            "anthropic",
            "gpt-5",
            "claude-sonnet-4-5",
            models.iter().copied(),
        )
        .expect_err("a cross-provider stale model must be rejected");

        assert!(error.to_string().contains("is not available for provider"));
    }

    #[test]
    fn accepts_the_selected_providers_default_or_listed_model() {
        let models = ["claude-sonnet-4-5", "claude-opus-4-1"];

        validate_provider_model(
            "anthropic",
            "claude-sonnet-4-5",
            "claude-sonnet-4-5",
            models.iter().copied(),
        )
        .unwrap();
        validate_provider_model(
            "anthropic",
            "claude-opus-4-1",
            "claude-sonnet-4-5",
            models.iter().copied(),
        )
        .unwrap();
    }

    #[test]
    fn local_whisper_selection_is_hidden_and_blocked_case_insensitively() {
        for key in [
            "LOCAL_WHISPER_MODEL",
            "local_whisper_model",
            "LoCaL_WhIsPeR_MoDeL",
        ] {
            assert!(is_generic_config_read_hidden(key));
            assert!(ensure_generic_config_key_is_mutable(key).is_err());
        }

        assert!(generic_config_blocked_mutation_keys()
            .iter()
            .any(|key| key == "LOCAL_WHISPER_MODEL"));
    }
}
