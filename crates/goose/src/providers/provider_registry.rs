use super::api_client::TlsConfig;
use super::base::{ConfigKey, ModelInfo, Provider, ProviderDef, ProviderMetadata, ProviderType};
use super::inventory::{InventoryIdentityInput, InventoryRegistration, InventoryResolvers};
use crate::config::{DeclarativeProviderConfig, ExtensionConfig};
use anyhow::Result;
use futures::future::BoxFuture;
use goose_providers::model::ModelConfig;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub type ProviderConstructor = Arc<
    dyn Fn(
            Vec<ExtensionConfig>,
            Option<PathBuf>,
            Option<TlsConfig>,
        ) -> BoxFuture<'static, Result<Arc<dyn Provider>>>
        + Send
        + Sync,
>;

pub type ProviderCleanup = Arc<dyn Fn() -> BoxFuture<'static, Result<()>> + Send + Sync>;

pub(crate) fn is_protected_provider_id(id: &str) -> bool {
    matches!(id, "ollama_cloud")
}

#[derive(Clone)]
pub struct ProviderEntry {
    metadata: ProviderMetadata,
    pub(crate) constructor: ProviderConstructor,
    pub(crate) inventory_identity: super::inventory::InventoryIdentityResolver,
    pub(crate) inventory_configured: super::inventory::InventoryConfiguredResolver,
    pub(crate) cleanup: Option<ProviderCleanup>,
    provider_type: ProviderType,
    supports_inventory_refresh: bool,
    tls_config: Option<TlsConfig>,
    activation_disabled_reason: Option<&'static str>,
}

impl ProviderEntry {
    fn ensure_activation_enabled(&self) -> Result<()> {
        if let Some(reason) = self.activation_disabled_reason {
            anyhow::bail!(reason);
        }
        Ok(())
    }

    pub fn metadata(&self) -> &ProviderMetadata {
        &self.metadata
    }

    pub fn provider_type(&self) -> ProviderType {
        self.provider_type
    }

    pub fn supports_inventory_refresh(&self) -> bool {
        self.supports_inventory_refresh
    }

    pub fn inventory_identity(&self) -> Result<InventoryIdentityInput> {
        (self.inventory_identity)()
    }

    pub fn inventory_configured(&self) -> bool {
        (self.inventory_configured)()
    }

    /// Apply provider-specific normalization to a model config: materialize
    /// global defaults and backfill `context_limit` from the provider's known
    /// models when the canonical registry didn't already resolve one. Used by
    /// the agent/session layer to resolve effective limits (e.g. for custom
    /// providers that declare explicit context limits in their config).
    pub fn normalize_model_config(&self, mut model: ModelConfig) -> Result<ModelConfig> {
        model = crate::model_config::materialize_model_config(&self.metadata.name, model)?;

        if model.context_limit.is_none() {
            if let Some(info) = self
                .metadata
                .known_models
                .iter()
                .find(|m| m.name.eq_ignore_ascii_case(&model.model_name) && m.context_limit > 0)
            {
                model.context_limit = Some(info.context_limit);
            }
        }

        Ok(model)
    }

    pub async fn create_with_default_model(
        &self,
        extensions: Vec<ExtensionConfig>,
    ) -> Result<Arc<dyn Provider>> {
        self.create(extensions).await
    }

    pub async fn create(&self, extensions: Vec<ExtensionConfig>) -> Result<Arc<dyn Provider>> {
        self.ensure_activation_enabled()?;
        (self.constructor)(extensions, None, self.tls_config.clone()).await
    }

    pub async fn create_with_working_dir(
        &self,
        extensions: Vec<ExtensionConfig>,
        working_dir: PathBuf,
    ) -> Result<Arc<dyn Provider>> {
        self.ensure_activation_enabled()?;
        (self.constructor)(extensions, Some(working_dir), self.tls_config.clone()).await
    }
}

#[derive(Default)]
pub struct ProviderRegistry {
    pub(crate) entries: HashMap<String, ProviderEntry>,
    tls_config: Option<TlsConfig>,
}

impl ProviderRegistry {
    pub fn new(tls_config: Option<TlsConfig>) -> Self {
        Self {
            entries: HashMap::new(),
            tls_config,
        }
    }

    pub fn register<F>(&mut self, preferred: bool)
    where
        F: ProviderDef + 'static,
    {
        self.register_with_inventory::<F>(preferred, None);
    }

    pub fn register_with_inventory<F>(
        &mut self,
        preferred: bool,
        inventory_registration: Option<InventoryRegistration>,
    ) where
        F: ProviderDef + 'static,
    {
        let metadata = F::metadata();
        let name = metadata.name.clone();
        let activation_disabled_reason = super::activation_disabled_reason(&metadata.name);

        let inventory = InventoryResolvers::for_metadata(&metadata, inventory_registration);

        self.entries.insert(
            name,
            ProviderEntry {
                metadata,
                constructor: Arc::new(|extensions, working_dir, tls_config| {
                    Box::pin(async move {
                        let provider = match working_dir {
                            Some(working_dir) => {
                                F::from_env_with_working_dir(extensions, working_dir, tls_config)
                                    .await?
                            }
                            None => F::from_env(extensions, tls_config).await?,
                        };
                        Ok(Arc::new(provider) as Arc<dyn Provider>)
                    })
                }),
                inventory_identity: inventory.identity,
                inventory_configured: inventory.configured,
                cleanup: None,
                provider_type: if preferred {
                    ProviderType::Preferred
                } else {
                    ProviderType::Builtin
                },
                supports_inventory_refresh: inventory.supports_refresh,
                tls_config: self.tls_config.clone(),
                activation_disabled_reason,
            },
        );
    }

    pub fn register_with_name<P, F, G>(
        &mut self,
        config: &DeclarativeProviderConfig,
        provider_type: ProviderType,
        supports_inventory_refresh: bool,
        constructor: F,
        inventory_identity: G,
    ) where
        P: ProviderDef + 'static,
        F: Fn(Option<TlsConfig>) -> Result<P::Provider> + Send + Sync + 'static,
        G: Fn() -> Result<InventoryIdentityInput> + Send + Sync + 'static,
    {
        self.register_with_name_impl::<P, F, G>(
            config,
            provider_type,
            supports_inventory_refresh,
            constructor,
            inventory_identity,
            None,
        );
    }

    pub fn register_with_name_and_inventory_configured<P, F, G, H>(
        &mut self,
        config: &DeclarativeProviderConfig,
        provider_type: ProviderType,
        supports_inventory_refresh: bool,
        constructor: F,
        inventory_identity: G,
        inventory_configured: H,
    ) where
        P: ProviderDef + 'static,
        F: Fn(Option<TlsConfig>) -> Result<P::Provider> + Send + Sync + 'static,
        G: Fn() -> Result<InventoryIdentityInput> + Send + Sync + 'static,
        H: Fn() -> bool + Send + Sync + 'static,
    {
        self.register_with_name_impl::<P, F, G>(
            config,
            provider_type,
            supports_inventory_refresh,
            constructor,
            inventory_identity,
            Some(Arc::new(inventory_configured)),
        );
    }

    fn register_with_name_impl<P, F, G>(
        &mut self,
        config: &DeclarativeProviderConfig,
        provider_type: ProviderType,
        supports_inventory_refresh: bool,
        constructor: F,
        inventory_identity: G,
        inventory_configured: Option<super::inventory::InventoryConfiguredResolver>,
    ) where
        P: ProviderDef + 'static,
        F: Fn(Option<TlsConfig>) -> Result<P::Provider> + Send + Sync + 'static,
        G: Fn() -> Result<InventoryIdentityInput> + Send + Sync + 'static,
    {
        let activation_disabled_reason = super::activation_disabled_reason(&config.name);
        if provider_type == ProviderType::Custom
            && (is_protected_provider_id(&config.name)
                || goose_providers::declarative::validate_untrusted_config(config).is_err())
        {
            return;
        }

        let base_metadata = P::metadata();
        let description = config
            .description
            .clone()
            .unwrap_or_else(|| format!("Custom {} provider", config.display_name));
        let default_model = config
            .models
            .first()
            .map(|m| m.name.clone())
            .unwrap_or_default();
        let known_models: Vec<ModelInfo> = config
            .models
            .iter()
            .map(|m| ModelInfo {
                name: m.name.clone(),
                resolved_model: None,
                context_limit: m.context_limit,
                input_token_cost: m.input_token_cost,
                output_token_cost: m.output_token_cost,
                currency: m.currency.clone(),
                supports_cache_control: Some(m.supports_cache_control.unwrap_or(false)),
                reasoning: m.reasoning,
            })
            .collect();

        let mut config_keys = if provider_type == ProviderType::Declarative {
            if !config.api_key_env.is_empty() {
                let key =
                    ConfigKey::new(&config.api_key_env, config.requires_auth, true, None, true);
                let key = match super::activation_disabled_reason(&config.name) {
                    Some(reason) => key.without_credential_validation(reason),
                    None => key,
                };
                vec![key]
            } else {
                Vec::new()
            }
        } else {
            let mut config_keys = base_metadata.config_keys.clone();

            if let Some(api_key_index) = config_keys.iter().position(|key| key.secret) {
                if !config.requires_auth {
                    config_keys.remove(api_key_index);
                } else if !config.api_key_env.is_empty() {
                    config_keys[api_key_index] =
                        ConfigKey::new(&config.api_key_env, false, true, None, true);
                }
            }

            config_keys
        };

        if let Some(ref env_vars) = config.env_vars {
            for ev in env_vars {
                // Default primary to `required` so required fields show prominently in the UI
                let primary = ev.primary.unwrap_or(ev.required);
                config_keys.push(ConfigKey::new(
                    &ev.name,
                    ev.required,
                    ev.secret,
                    ev.default.as_deref(),
                    primary,
                ));
            }
        }

        let custom_metadata = ProviderMetadata {
            name: config.name.clone(),
            display_name: config.display_name.clone(),
            description,
            default_model,
            known_models,
            model_doc_link: config
                .model_doc_link
                .clone()
                .unwrap_or(base_metadata.model_doc_link),
            config_keys,
            setup_steps: config.setup_steps.clone(),
            model_selection_hint: None,
            fast_model: config.fast_model.clone(),
        };
        let inventory_config_keys = custom_metadata.config_keys.clone();
        let default_inventory_configured = Arc::new(move || {
            super::inventory::default_inventory_configured(
                &inventory_config_keys,
                crate::config::Config::global(),
            )
        });

        self.entries.insert(
            config.name.clone(),
            ProviderEntry {
                metadata: custom_metadata,
                constructor: Arc::new(move |_extensions, _working_dir, tls_config| {
                    let result = constructor(tls_config);
                    Box::pin(async move {
                        let provider = result?;
                        Ok(Arc::new(provider) as Arc<dyn Provider>)
                    })
                }),
                inventory_identity: Arc::new(inventory_identity),
                inventory_configured: inventory_configured.unwrap_or(default_inventory_configured),
                cleanup: None,
                provider_type,
                supports_inventory_refresh,
                tls_config: self.tls_config.clone(),
                activation_disabled_reason,
            },
        );
    }

    pub fn set_cleanup(&mut self, name: &str, cleanup: ProviderCleanup) {
        if let Some(entry) = self.entries.get_mut(name) {
            entry.cleanup = Some(cleanup);
        }
    }

    pub fn with_providers<F>(mut self, setup: F) -> Self
    where
        F: FnOnce(&mut Self),
    {
        setup(&mut self);
        self
    }

    pub async fn create(
        &self,
        name: &str,
        extensions: Vec<ExtensionConfig>,
    ) -> Result<Arc<dyn Provider>> {
        let entry = self
            .entries
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("Unknown provider: {}", name))?;

        entry.create(extensions).await
    }

    pub fn all_metadata_with_types(&self) -> Vec<(ProviderMetadata, ProviderType)> {
        self.entries
            .values()
            .map(|e| (e.metadata.clone(), e.provider_type))
            .collect()
    }

    pub fn remove_custom_providers(&mut self) {
        self.entries.retain(|name, _| !name.starts_with("custom_"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::declarative_providers::ProviderEngine;
    use crate::providers::openai_def::OpenAiProviderDef;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_config() -> DeclarativeProviderConfig {
        DeclarativeProviderConfig {
            name: "custom_hf".to_string(),
            engine: ProviderEngine::OpenAI,
            display_name: "Custom HF".to_string(),
            description: None,
            api_key_env: String::new(),
            base_url: "https://router.huggingface.co/v1".to_string(),
            models: vec![ModelInfo::new("test-model", 128_000)],
            headers: None,
            timeout_seconds: None,
            supports_streaming: Some(true),
            requires_auth: true,
            catalog_provider_id: Some("huggingface".to_string()),
            base_path: None,
            env_vars: None,
            dynamic_models: None,
            skip_canonical_filtering: false,
            model_doc_link: None,
            setup_steps: vec![],
            fast_model: None,
            preserves_thinking: false,
        }
    }

    #[test]
    fn register_with_name_can_override_inventory_configured() {
        let mut registry = ProviderRegistry::new(None);
        registry.register_with_name_and_inventory_configured::<OpenAiProviderDef, _, _, _>(
            &test_config(),
            ProviderType::Declarative,
            false,
            |_| unreachable!("constructor is not used by this test"),
            || Ok(InventoryIdentityInput::new("custom_hf", "huggingface")),
            || false,
        );

        let entry = registry.entries.get("custom_hf").unwrap();

        assert!(!entry.inventory_configured());
    }

    #[tokio::test]
    async fn disabled_provider_is_rejected_before_any_constructor_runs() {
        let constructor_calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&constructor_calls);
        let mut config = test_config();
        config.name = "zai".to_string();
        config.catalog_provider_id = Some("zai".to_string());

        let mut registry = ProviderRegistry::new(None);
        registry.register_with_name::<OpenAiProviderDef, _, _>(
            &config,
            ProviderType::Declarative,
            false,
            move |_| {
                observed_calls.fetch_add(1, Ordering::SeqCst);
                Err(anyhow::anyhow!("constructor reached"))
            },
            || Ok(InventoryIdentityInput::new("zai", "zai")),
        );

        let registry_error = match registry.create("zai", Vec::new()).await {
            Ok(_) => panic!("disabled provider must fail closed"),
            Err(error) => error,
        };
        let entry_error = match registry
            .entries
            .get("zai")
            .expect("disabled provider metadata remains catalog-visible")
            .create(Vec::new())
            .await
        {
            Ok(_) => panic!("direct entry construction must also fail closed"),
            Err(error) => error,
        };

        for error in [registry_error, entry_error] {
            assert!(
                error
                    .to_string()
                    .contains(super::super::UNVERIFIED_CREDENTIAL_ACTIVATION_REASON),
                "unexpected disabled-provider error: {error:#}"
            );
        }
        assert_eq!(constructor_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn legacy_custom_provider_cannot_reintroduce_disabled_catalog_identity() {
        for catalog_provider_id in ["nvidia", " NVIDIA ", "z.ai", " ZHIPU ", " zai "] {
            let constructor_calls = Arc::new(AtomicUsize::new(0));
            let observed_calls = Arc::clone(&constructor_calls);
            let mut config = test_config();
            config.catalog_provider_id = Some(catalog_provider_id.to_string());

            let mut registry = ProviderRegistry::new(None);
            registry.register_with_name::<OpenAiProviderDef, _, _>(
                &config,
                ProviderType::Custom,
                false,
                move |_| {
                    observed_calls.fetch_add(1, Ordering::SeqCst);
                    Err(anyhow::anyhow!("constructor reached"))
                },
                || Ok(InventoryIdentityInput::new("custom_hf", "nvidia")),
            );

            assert!(!registry.entries.contains_key("custom_hf"));
            assert_eq!(constructor_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn legacy_custom_provider_cannot_reintroduce_disabled_vendor_endpoint() {
        let constructor_calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&constructor_calls);
        let mut config = test_config();
        config.catalog_provider_id = None;
        config.base_url = "https://api.z.ai/api/anthropic".to_string();

        let mut registry = ProviderRegistry::new(None);
        registry.register_with_name::<OpenAiProviderDef, _, _>(
            &config,
            ProviderType::Custom,
            false,
            move |_| {
                observed_calls.fetch_add(1, Ordering::SeqCst);
                Err(anyhow::anyhow!("constructor reached"))
            },
            || Ok(InventoryIdentityInput::new("custom_hf", "custom_hf")),
        );

        assert!(!registry.entries.contains_key("custom_hf"));
        assert_eq!(constructor_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn legacy_custom_whitespace_key_name_is_rejected_for_every_engine() {
        for engine in [
            ProviderEngine::OpenAI,
            ProviderEngine::Ollama,
            ProviderEngine::Anthropic,
        ] {
            let constructor_calls = Arc::new(AtomicUsize::new(0));
            let observed_calls = Arc::clone(&constructor_calls);
            let mut config = test_config();
            config.engine = engine.clone();
            config.requires_auth = false;
            config.api_key_env = "   \t".to_string();
            config.base_url = "https://example.invalid/v1".to_string();
            config.catalog_provider_id = None;

            let mut registry = ProviderRegistry::new(None);
            registry.register_with_name::<OpenAiProviderDef, _, _>(
                &config,
                ProviderType::Custom,
                false,
                move |_| {
                    observed_calls.fetch_add(1, Ordering::SeqCst);
                    Err(anyhow::anyhow!("constructor reached"))
                },
                || Ok(InventoryIdentityInput::new("custom_hf", "custom_hf")),
            );

            assert!(
                !registry.entries.contains_key("custom_hf"),
                "whitespace credential channel registered for {engine:?}"
            );
            assert_eq!(constructor_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn legacy_custom_contract_violations_are_hidden_from_defaults_sessions_and_create() {
        let cases = [
            (true, "https://example.invalid/v1", None),
            (false, "https://example.invalid/v1?api_key=legacy", None),
            (
                false,
                "https://example.invalid/v1",
                Some(("Authorization", "Bearer legacy")),
            ),
            (false, "https://api.z.ai./api/anthropic", None),
            (false, "https://integrate.api.nvidia.com.:8443/v1", None),
            (false, "https://user:pass@api.z.ai/v1", None),
            (false, "ftp://example.invalid/v1", None),
        ];

        for (requires_auth, base_url, header) in cases {
            let constructor_calls = Arc::new(AtomicUsize::new(0));
            let observed_calls = Arc::clone(&constructor_calls);
            let mut config = test_config();
            config.requires_auth = requires_auth;
            config.api_key_env = if requires_auth {
                "LEGACY_API_KEY".to_string()
            } else {
                String::new()
            };
            config.base_url = base_url.to_string();
            config.catalog_provider_id = None;
            config.headers =
                header.map(|(name, value)| HashMap::from([(name.to_string(), value.to_string())]));

            let mut registry = ProviderRegistry::new(None);
            registry.register_with_name::<OpenAiProviderDef, _, _>(
                &config,
                ProviderType::Custom,
                false,
                move |_| {
                    observed_calls.fetch_add(1, Ordering::SeqCst);
                    Err(anyhow::anyhow!("constructor reached"))
                },
                || Ok(InventoryIdentityInput::new("custom_hf", "custom_hf")),
            );

            assert!(
                !registry.entries.contains_key("custom_hf"),
                "legacy custom contract violation registered for {base_url}"
            );
            assert!(registry
                .all_metadata_with_types()
                .into_iter()
                .all(|(metadata, _)| metadata.name != "custom_hf"));
            assert!(registry.create("custom_hf", Vec::new()).await.is_err());
            assert_eq!(constructor_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn authenticated_custom_provider_with_scoped_key_is_registered() {
        let mut config = test_config();
        config.catalog_provider_id = None;
        config.api_key_env = goose_providers::declarative::scoped_custom_api_key_name(
            &config.name,
            &config.base_url,
        )
        .unwrap();

        let mut registry = ProviderRegistry::new(None);
        registry.register_with_name::<OpenAiProviderDef, _, _>(
            &config,
            ProviderType::Custom,
            false,
            |_| Err(anyhow::anyhow!("constructor is not used by this test")),
            || Ok(InventoryIdentityInput::new("custom_hf", "custom_hf")),
        );

        assert!(registry.entries.contains_key("custom_hf"));
    }

    #[tokio::test]
    async fn legacy_custom_env_vars_are_rejected_before_registration_and_construction() {
        let constructor_calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&constructor_calls);
        let mut config = test_config();
        config.requires_auth = false;
        config.api_key_env.clear();
        config.base_url = "https://example.invalid/v1${SUFFIX}".to_string();
        config.catalog_provider_id = None;
        config.env_vars = Some(vec![goose_providers::declarative::EnvVarConfig {
            name: "SUFFIX".to_string(),
            description: None,
            required: false,
            secret: true,
            default: Some("?api_key=legacy".to_string()),
            primary: None,
        }]);

        let mut registry = ProviderRegistry::new(None);
        registry.register_with_name::<OpenAiProviderDef, _, _>(
            &config,
            ProviderType::Custom,
            false,
            move |_| {
                observed_calls.fetch_add(1, Ordering::SeqCst);
                Err(anyhow::anyhow!("constructor reached"))
            },
            || Ok(InventoryIdentityInput::new("custom_hf", "custom_hf")),
        );

        assert!(!registry.entries.contains_key("custom_hf"));
        assert!(registry.create("custom_hf", Vec::new()).await.is_err());
        assert_eq!(constructor_calls.load(Ordering::SeqCst), 0);
    }
}
