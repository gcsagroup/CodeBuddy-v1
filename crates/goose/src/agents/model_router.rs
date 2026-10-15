use crate::agents::agent_role::AgentRole;
use crate::agents::extension::ExtensionConfig;
use crate::model_config::model_config_from_user_config;
use anyhow::{anyhow, bail, Context, Result};
use futures::future::BoxFuture;
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use goose_sdk_types::custom_requests::{
    CodeProModelRoute, CodeProModelRoutingConfig, CodeProModelRoutingRole,
    CODEPRO_MODEL_ROUTING_CONFIG_KEY,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub type ModelRouterProviderFactory = Arc<
    dyn Fn(
            String,
            Vec<ExtensionConfig>,
            Option<PathBuf>,
        ) -> BoxFuture<'static, Result<Arc<dyn crate::providers::base::Provider>>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRouterConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_route: Option<CodeProModelRoute>,
    pub planner_provider: String,
    pub planner_model: String,
    pub planner_fallback_model: String,

    pub coder_provider: String,
    pub coder_model: String,
    pub coder_fallback_model: String,

    pub tester_provider: String,
    pub tester_model: String,
    pub tester_fallback_model: String,

    pub reviewer_provider: String,
    pub reviewer_model: String,
    pub reviewer_fallback_model: String,

    pub max_parallel_coders: u8,
}

impl Default for ModelRouterConfig {
    fn default() -> Self {
        Self {
            main_route: None,
            planner_provider: String::new(),
            planner_model: String::new(),
            planner_fallback_model: String::new(),
            coder_provider: String::new(),
            coder_model: String::new(),
            coder_fallback_model: String::new(),
            tester_provider: String::new(),
            tester_model: String::new(),
            tester_fallback_model: String::new(),
            reviewer_provider: String::new(),
            reviewer_model: String::new(),
            reviewer_fallback_model: String::new(),
            max_parallel_coders: 1,
        }
    }
}

impl ModelRouterConfig {
    pub fn from_config() -> Result<Self> {
        use crate::config::Config;
        Self::from_config_source(Config::global())
    }

    fn from_config_source(config: &crate::config::Config) -> Result<Self> {
        let environment_routing = match std::env::var(CODEPRO_MODEL_ROUTING_CONFIG_KEY) {
            Ok(value) => Some(
                serde_json::from_str::<CodeProModelRoutingConfig>(&value).map_err(|error| {
                    anyhow!("Invalid CodePro model routing environment value: {error}")
                })?,
            ),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(anyhow!(
                    "Invalid CodePro model routing environment value: expected valid Unicode"
                ));
            }
        };
        if environment_routing
            .as_ref()
            .is_some_and(|routing| routing.advanced_routing_enabled)
        {
            return Self::from_config_values(environment_routing, None);
        }
        if environment_routing.is_some() {
            if let Some(global_default) =
                crate::config::providers::environment_provider_model_pair()?
            {
                return Self::from_config_values(environment_routing, Some(global_default));
            }
        }

        let values = config.merged_values_snapshot()?;
        let typed_routing = match environment_routing {
            Some(routing) => Some(routing),
            None => values
                .get(CODEPRO_MODEL_ROUTING_CONFIG_KEY)
                .cloned()
                .map(serde_yaml::from_value::<CodeProModelRoutingConfig>)
                .transpose()
                .map_err(|error| anyhow!("Invalid persisted CodePro model routing: {error}"))?,
        };
        if typed_routing
            .as_ref()
            .is_some_and(|routing| routing.advanced_routing_enabled)
        {
            return Self::from_config_values(typed_routing, None);
        }

        let global_default =
            crate::config::providers::get_active_provider_model_pair_from_snapshot(&values)?
                .map(|(provider, model)| (provider.trim().to_string(), model.trim().to_string()))
                .filter(|(provider, model)| !provider.is_empty() && !model.is_empty());

        Self::from_config_values(typed_routing, global_default)
    }

    fn from_config_values(
        typed_routing: Option<CodeProModelRoutingConfig>,
        global_default: Option<(String, String)>,
    ) -> Result<Self> {
        let Some(typed_routing) = typed_routing else {
            return Ok(Self::from_global_default(global_default));
        };
        if !typed_routing.advanced_routing_enabled {
            return Ok(Self::from_global_default(global_default));
        }

        let route = |role| {
            typed_routing
                .routes
                .iter()
                .find(|route| route.role == role)
                .with_context(|| format!("Missing typed CodePro route for {role:?}"))
        };
        let planner = route(CodeProModelRoutingRole::Planner)?;
        let coder = route(CodeProModelRoutingRole::Coder)?;
        let tester = route(CodeProModelRoutingRole::Tester)?;
        let reviewer = route(CodeProModelRoutingRole::Reviewer)?;

        Ok(Self {
            main_route: typed_routing
                .routes
                .iter()
                .find(|route| route.role == CodeProModelRoutingRole::Main)
                .cloned(),
            planner_provider: planner.provider_id.clone(),
            planner_model: planner.model_id.clone(),
            planner_fallback_model: planner.model_id.clone(),
            coder_provider: coder.provider_id.clone(),
            coder_model: coder.model_id.clone(),
            coder_fallback_model: coder.model_id.clone(),
            tester_provider: tester.provider_id.clone(),
            tester_model: tester.model_id.clone(),
            tester_fallback_model: tester.model_id.clone(),
            reviewer_provider: reviewer.provider_id.clone(),
            reviewer_model: reviewer.model_id.clone(),
            reviewer_fallback_model: reviewer.model_id.clone(),
            max_parallel_coders: typed_routing.max_parallel_coders,
        })
    }

    fn from_global_default(global_default: Option<(String, String)>) -> Self {
        let Some((provider, model)) = global_default else {
            return Self::default();
        };
        let provider = provider.trim().to_string();
        let model = model.trim().to_string();
        if provider.is_empty() || model.is_empty() {
            return Self::default();
        }
        Self {
            planner_provider: provider.clone(),
            main_route: None,
            planner_model: model.clone(),
            planner_fallback_model: model.clone(),
            coder_provider: provider.clone(),
            coder_model: model.clone(),
            coder_fallback_model: model.clone(),
            tester_provider: provider.clone(),
            tester_model: model.clone(),
            tester_fallback_model: model.clone(),
            reviewer_provider: provider,
            reviewer_model: model.clone(),
            reviewer_fallback_model: model,
            max_parallel_coders: 1,
        }
    }
}

#[derive(Clone)]
struct ActivatedProvider {
    provider: Arc<dyn crate::providers::base::Provider>,
    supported_models: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum ProviderActivationFailureStage {
    Initialization,
    Credentials,
    Models,
}

impl std::fmt::Display for ProviderActivationFailureStage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Initialization => formatter.write_str("initialization"),
            Self::Credentials => formatter.write_str("credential validation"),
            Self::Models => formatter.write_str("model discovery"),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderActivationFailure {
    provider_name: String,
    stage: ProviderActivationFailureStage,
}

impl std::fmt::Display for ProviderActivationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Provider '{}' failed during {}",
            self.provider_name, self.stage
        )
    }
}

impl std::error::Error for ProviderActivationFailure {}

impl ProviderActivationFailure {
    pub(crate) fn user_message(&self) -> String {
        let stage = match self.stage {
            ProviderActivationFailureStage::Initialization => "初始化模型连接失败",
            ProviderActivationFailureStage::Credentials => "模型凭据验证失败",
            ProviderActivationFailureStage::Models => "加载模型列表失败",
        };
        format!("{}：{stage}", self.provider_name)
    }
}

type ProviderActivation = Result<ActivatedProvider, ProviderActivationFailure>;
type ProviderActivationCell = Arc<tokio::sync::OnceCell<ProviderActivation>>;

fn default_provider_factory() -> ModelRouterProviderFactory {
    Arc::new(|provider_name, extensions, working_dir| {
        Box::pin(async move {
            match working_dir {
                Some(working_dir) => {
                    crate::providers::create_with_working_dir(
                        &provider_name,
                        extensions,
                        working_dir,
                    )
                    .await
                }
                None => crate::providers::create(&provider_name, extensions).await,
            }
        })
    })
}

#[derive(Clone)]
pub struct ModelRouter {
    config: ModelRouterConfig,
    extensions: Vec<ExtensionConfig>,
    provider_factory: ModelRouterProviderFactory,
    working_dir: Option<PathBuf>,
    activated_providers: Arc<tokio::sync::Mutex<HashMap<String, ProviderActivationCell>>>,
}

impl ModelRouter {
    pub fn new(config: ModelRouterConfig, extensions: Vec<ExtensionConfig>) -> Self {
        Self::new_with_factory(config, extensions, default_provider_factory(), None)
    }

    pub(crate) fn new_with_factory(
        config: ModelRouterConfig,
        extensions: Vec<ExtensionConfig>,
        provider_factory: ModelRouterProviderFactory,
        working_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            config,
            extensions,
            provider_factory,
            working_dir,
            activated_providers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn with_default_extensions(extensions: Vec<ExtensionConfig>) -> Result<Self> {
        Self::with_runtime(extensions, None, None)
    }

    pub(crate) fn with_runtime(
        extensions: Vec<ExtensionConfig>,
        provider_factory: Option<ModelRouterProviderFactory>,
        working_dir: Option<PathBuf>,
    ) -> Result<Self> {
        Ok(Self::new_with_factory(
            ModelRouterConfig::from_config()?,
            extensions,
            provider_factory.unwrap_or_else(default_provider_factory),
            working_dir,
        ))
    }

    pub fn extensions(&self) -> Vec<ExtensionConfig> {
        self.extensions.clone()
    }

    pub fn max_parallel_coders(&self) -> u8 {
        self.config.max_parallel_coders
    }

    pub fn config(&self) -> &ModelRouterConfig {
        &self.config
    }

    pub fn role_to_model(&self, role: AgentRole) -> (&str, &str) {
        match role {
            AgentRole::Planner => (&self.config.planner_provider, &self.config.planner_model),
            AgentRole::Coder => (&self.config.coder_provider, &self.config.coder_model),
            AgentRole::Tester => (&self.config.tester_provider, &self.config.tester_model),
            AgentRole::Reviewer => (&self.config.reviewer_provider, &self.config.reviewer_model),
        }
    }

    pub fn role_to_fallback_model(&self, role: AgentRole) -> (&str, &str) {
        match role {
            AgentRole::Planner => (
                &self.config.planner_provider,
                &self.config.planner_fallback_model,
            ),
            AgentRole::Coder => (
                &self.config.coder_provider,
                &self.config.coder_fallback_model,
            ),
            AgentRole::Tester => (
                &self.config.tester_provider,
                &self.config.tester_fallback_model,
            ),
            AgentRole::Reviewer => (
                &self.config.reviewer_provider,
                &self.config.reviewer_fallback_model,
            ),
        }
    }

    pub async fn resolve(
        &self,
        role: AgentRole,
    ) -> Result<(Arc<dyn crate::providers::base::Provider>, ModelConfig)> {
        let (provider_name, model_name) = self.role_to_model(role);
        self.try_resolve(provider_name, model_name).await
    }

    /// Reuse an already selected session connection only for the exact configured
    /// route. Model discovery is a setup operation, not a prerequisite for every
    /// follow-up on an active connection. A different role route still activates
    /// normally; this is not a fallback to the session model.
    pub(crate) async fn resolve_with_active_provider(
        &self,
        role: AgentRole,
        provider: Arc<dyn crate::providers::base::Provider>,
        model: ModelConfig,
    ) -> Result<(Arc<dyn crate::providers::base::Provider>, ModelConfig)> {
        let (provider_name, model_name) = self.role_to_model(role);
        if let Some(reason) = crate::providers::activation_disabled_reason(provider_name) {
            bail!(reason);
        }
        if provider.get_name() == provider_name && model.model_name == model_name {
            tracing::info!(
                provider = provider_name,
                model = model_name,
                "CodePro input relation reused active session route"
            );
            return Ok((provider, model));
        }
        tracing::info!(
            provider = provider_name,
            model = model_name,
            "CodePro input relation requires configured role activation"
        );
        self.resolve(role).await
    }

    pub async fn resolve_fallback(
        &self,
        role: AgentRole,
    ) -> Result<(Arc<dyn crate::providers::base::Provider>, ModelConfig)> {
        bail!("No validated fallback route is configured for {role}")
    }

    pub async fn resolve_main(
        &self,
    ) -> Result<Option<(Arc<dyn crate::providers::base::Provider>, ModelConfig)>> {
        match &self.config.main_route {
            Some(route) => self
                .try_resolve(&route.provider_id, &route.model_id)
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    async fn try_resolve(
        &self,
        provider_name: &str,
        model_name: &str,
    ) -> Result<(Arc<dyn crate::providers::base::Provider>, ModelConfig)> {
        if provider_name.trim().is_empty() || model_name.trim().is_empty() {
            bail!("CodePro model routing is not configured for this role");
        }
        if let Some(reason) = crate::providers::activation_disabled_reason(provider_name) {
            bail!(reason);
        }

        let activation = {
            let mut providers = self.activated_providers.lock().await;
            Arc::clone(
                providers
                    .entry(provider_name.to_string())
                    .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new())),
            )
        };
        let provider_name = provider_name.to_string();
        let extensions = self.extensions.clone();
        let working_dir = self.working_dir.clone();
        let provider_factory = Arc::clone(&self.provider_factory);
        let activation_provider_name = provider_name.clone();
        let activated = activation
            .get_or_init(|| async move {
                let activation_failure = |stage| ProviderActivationFailure {
                    provider_name: activation_provider_name.clone(),
                    stage,
                };
                let provider = match provider_factory(
                    activation_provider_name.clone(),
                    extensions,
                    working_dir,
                )
                .await
                {
                    Ok(provider) => provider,
                    Err(error) => {
                        tracing::warn!(
                            provider = %activation_provider_name,
                            stage = %ProviderActivationFailureStage::Initialization,
                            error_kind = error.downcast_ref::<ProviderError>().map(ProviderError::telemetry_type).unwrap_or("initialization"),
                            "CodePro provider activation failed"
                        );
                        return Err(activation_failure(
                            ProviderActivationFailureStage::Initialization,
                        ));
                    }
                };
                match provider.validate_credentials().await {
                    Ok(()) | Err(ProviderError::NotImplemented(_)) => {}
                    Err(error) => {
                        tracing::warn!(
                            provider = %activation_provider_name,
                            stage = %ProviderActivationFailureStage::Credentials,
                            error_kind = error.telemetry_type(),
                            "CodePro provider activation failed"
                        );
                        return Err(activation_failure(
                            ProviderActivationFailureStage::Credentials,
                        ));
                    }
                }
                let discovery_started = std::time::Instant::now();
                tracing::info!(provider = %activation_provider_name, "CodePro model discovery started");
                let supported_models = match provider.fetch_supported_models().await {
                    Ok(models) => models,
                    Err(error) => {
                        tracing::warn!(
                            provider = %activation_provider_name,
                            stage = %ProviderActivationFailureStage::Models,
                            error_kind = error.telemetry_type(),
                            elapsed_ms = discovery_started.elapsed().as_millis() as u64,
                            "CodePro provider activation failed"
                        );
                        return Err(activation_failure(ProviderActivationFailureStage::Models));
                    }
                };
                tracing::info!(provider = %activation_provider_name,
                    elapsed_ms = discovery_started.elapsed().as_millis() as u64,
                    model_count = supported_models.len(), "CodePro model discovery finished");
                Ok(ActivatedProvider {
                    provider,
                    supported_models,
                })
            })
            .await
            .clone()
            .map_err(anyhow::Error::new)?;
        if !activated
            .supported_models
            .iter()
            .any(|supported| supported == model_name)
        {
            bail!("Model '{model_name}' is not available for provider '{provider_name}'");
        }
        let model_config = model_config_from_user_config(&provider_name, model_name)?;
        Ok((activated.provider, model_config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::base::{MessageStream, Provider};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct RuntimeObservedProvider {
        validation_count: AtomicUsize,
        model_fetch_count: AtomicUsize,
        stream_count: AtomicUsize,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ActivationFailureStage {
        Factory,
        Credentials,
        Models,
    }

    struct FailingActivationProvider {
        stage: ActivationFailureStage,
        validation_count: Arc<AtomicUsize>,
        model_fetch_count: Arc<AtomicUsize>,
    }

    struct BarrierActivationProvider {
        name: String,
        barrier: Arc<tokio::sync::Barrier>,
    }

    #[async_trait::async_trait]
    impl Provider for BarrierActivationProvider {
        fn get_name(&self) -> &str {
            &self.name
        }

        async fn stream(
            &self,
            _model_config: &ModelConfig,
            _system: &str,
            _messages: &[crate::conversation::message::Message],
            _tools: &[rmcp::model::Tool],
        ) -> Result<MessageStream, ProviderError> {
            panic!("the concurrency probe must not reach stream")
        }

        async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
            Ok(vec!["private-dynamic-model".to_string()])
        }

        async fn validate_credentials(&self) -> Result<(), ProviderError> {
            self.barrier.wait().await;
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl Provider for FailingActivationProvider {
        fn get_name(&self) -> &str {
            "openai"
        }

        async fn stream(
            &self,
            _model_config: &ModelConfig,
            _system: &str,
            _messages: &[crate::conversation::message::Message],
            _tools: &[rmcp::model::Tool],
        ) -> Result<MessageStream, ProviderError> {
            panic!("a failed activation must never reach stream")
        }

        async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
            self.model_fetch_count.fetch_add(1, Ordering::SeqCst);
            if self.stage == ActivationFailureStage::Models {
                Err(ProviderError::NetworkError(
                    "sensitive-model-discovery-detail".to_string(),
                ))
            } else {
                Ok(vec!["private-dynamic-model".to_string()])
            }
        }

        async fn validate_credentials(&self) -> Result<(), ProviderError> {
            self.validation_count.fetch_add(1, Ordering::SeqCst);
            if self.stage == ActivationFailureStage::Credentials {
                Err(ProviderError::Authentication(
                    "sensitive-credential-detail".to_string(),
                ))
            } else {
                Ok(())
            }
        }
    }

    #[async_trait::async_trait]
    impl Provider for RuntimeObservedProvider {
        fn get_name(&self) -> &str {
            "openai"
        }

        async fn stream(
            &self,
            _model_config: &ModelConfig,
            _system: &str,
            _messages: &[crate::conversation::message::Message],
            _tools: &[rmcp::model::Tool],
        ) -> Result<MessageStream, ProviderError> {
            self.stream_count.fetch_add(1, Ordering::SeqCst);
            Ok(Box::pin(futures::stream::empty()))
        }

        async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
            self.model_fetch_count.fetch_add(1, Ordering::SeqCst);
            Ok(vec!["private-dynamic-model".to_string()])
        }

        async fn validate_credentials(&self) -> Result<(), ProviderError> {
            self.validation_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn input_relation_reuses_exact_active_route_without_discovery_or_fallback() {
        let provider = Arc::new(FailingActivationProvider {
            stage: ActivationFailureStage::Models,
            validation_count: Arc::new(AtomicUsize::new(0)),
            model_fetch_count: Arc::new(AtomicUsize::new(0)),
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let factory_provider = Arc::clone(&provider);
        let factory: ModelRouterProviderFactory = Arc::new(move |_, _, _| {
            observed.fetch_add(1, Ordering::SeqCst);
            let provider = Arc::clone(&factory_provider);
            Box::pin(async move { Ok(provider as Arc<dyn Provider>) })
        });
        let config =
            ModelRouterConfig::from_global_default(Some(("openai".into(), "selected".into())));
        let router = ModelRouter::new_with_factory(config, vec![], factory, None);
        let active: Arc<dyn Provider> = provider.clone();
        let (resolved, model) = router
            .resolve_with_active_provider(
                AgentRole::Planner,
                Arc::clone(&active),
                ModelConfig::new("selected"),
            )
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&active, &resolved));
        assert_eq!(model.model_name, "selected");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(provider.model_fetch_count.load(Ordering::SeqCst), 0);

        // A different configured model must not silently inherit the active one.
        assert!(router
            .resolve_with_active_provider(
                AgentRole::Planner,
                active,
                ModelConfig::new("other-model"),
            )
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(provider.model_fetch_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn runtime_route_uses_session_working_dir_and_reuses_validated_provider() {
        let session_working_dir = PathBuf::from(r"D:\private-project\runtime-session");
        let observed_working_dirs = Arc::new(Mutex::new(Vec::<Option<PathBuf>>::new()));
        let factory_calls = Arc::new(AtomicUsize::new(0));
        let provider = Arc::new(RuntimeObservedProvider {
            validation_count: AtomicUsize::new(0),
            model_fetch_count: AtomicUsize::new(0),
            stream_count: AtomicUsize::new(0),
        });
        let factory_provider = Arc::clone(&provider);
        let factory_working_dirs = Arc::clone(&observed_working_dirs);
        let observed_factory_calls = Arc::clone(&factory_calls);
        let provider_factory: ModelRouterProviderFactory =
            Arc::new(move |provider_name, _extensions, working_dir| {
                observed_factory_calls.fetch_add(1, Ordering::SeqCst);
                factory_working_dirs.lock().unwrap().push(working_dir);
                let provider = Arc::clone(&factory_provider);
                Box::pin(async move {
                    assert_eq!(provider_name, "openai");
                    Ok(provider as Arc<dyn Provider>)
                })
            });
        let route = "private-dynamic-model".to_string();
        let config = ModelRouterConfig {
            planner_provider: "openai".to_string(),
            main_route: Some(CodeProModelRoute {
                role: CodeProModelRoutingRole::Main,
                provider_id: "openai".into(),
                model_id: route.clone(),
            }),
            planner_model: route.clone(),
            planner_fallback_model: route.clone(),
            coder_provider: "openai".to_string(),
            coder_model: route.clone(),
            coder_fallback_model: route.clone(),
            tester_provider: "openai".to_string(),
            tester_model: route.clone(),
            tester_fallback_model: route.clone(),
            reviewer_provider: "openai".to_string(),
            reviewer_model: route.clone(),
            reviewer_fallback_model: route,
            max_parallel_coders: 1,
        };
        let router = ModelRouter::new_with_factory(
            config,
            Vec::new(),
            provider_factory,
            Some(session_working_dir.clone()),
        );

        let (planner, coder, tester, reviewer) = tokio::join!(
            router.resolve(AgentRole::Planner),
            router.resolve(AgentRole::Coder),
            router.resolve(AgentRole::Tester),
            router.resolve(AgentRole::Reviewer),
        );
        let (resolved, model_config) = coder.unwrap();
        let (main_provider, main_model) = router.resolve_main().await.unwrap().unwrap();
        assert!(Arc::ptr_eq(&main_provider, &resolved));
        assert_eq!(main_model.model_name, "private-dynamic-model");
        let provider_as_trait: Arc<dyn Provider> = provider.clone();
        assert!(Arc::ptr_eq(&resolved, &provider_as_trait));
        for result in [planner, tester, reviewer] {
            let (role_provider, role_model) = result.unwrap();
            assert!(Arc::ptr_eq(&role_provider, &provider_as_trait));
            assert_eq!(role_model.model_name, "private-dynamic-model");
        }
        for role in [
            AgentRole::Planner,
            AgentRole::Coder,
            AgentRole::Tester,
            AgentRole::Reviewer,
        ] {
            let (role_provider, _) = router.resolve(role).await.unwrap();
            assert!(Arc::ptr_eq(&role_provider, &provider_as_trait));
        }
        let _stream = resolved
            .stream(&model_config, "runtime", &[], &[])
            .await
            .unwrap();

        assert_eq!(factory_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            *observed_working_dirs.lock().unwrap(),
            vec![Some(session_working_dir)]
        );
        assert_eq!(provider.validation_count.load(Ordering::SeqCst), 1);
        assert_eq!(provider.model_fetch_count.load(Ordering::SeqCst), 1);
        assert_eq!(provider.stream_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_activation_is_singleflight_and_stable_per_router_but_new_router_can_retry() {
        for stage in [
            ActivationFailureStage::Factory,
            ActivationFailureStage::Credentials,
            ActivationFailureStage::Models,
        ] {
            let factory_count = Arc::new(AtomicUsize::new(0));
            let validation_count = Arc::new(AtomicUsize::new(0));
            let model_fetch_count = Arc::new(AtomicUsize::new(0));
            let observed_factory_count = Arc::clone(&factory_count);
            let provider = Arc::new(FailingActivationProvider {
                stage,
                validation_count: Arc::clone(&validation_count),
                model_fetch_count: Arc::clone(&model_fetch_count),
            });
            let factory_provider = Arc::clone(&provider);
            let provider_factory: ModelRouterProviderFactory =
                Arc::new(move |_provider_name, _extensions, _working_dir| {
                    observed_factory_count.fetch_add(1, Ordering::SeqCst);
                    let provider = Arc::clone(&factory_provider);
                    Box::pin(async move {
                        if stage == ActivationFailureStage::Factory {
                            anyhow::bail!("sensitive-factory-detail");
                        }
                        Ok(provider as Arc<dyn Provider>)
                    })
                });
            let route = "private-dynamic-model".to_string();
            let config = ModelRouterConfig {
                planner_provider: "openai".to_string(),
                main_route: None,
                planner_model: route.clone(),
                planner_fallback_model: route.clone(),
                coder_provider: "openai".to_string(),
                coder_model: route.clone(),
                coder_fallback_model: route.clone(),
                tester_provider: "openai".to_string(),
                tester_model: route.clone(),
                tester_fallback_model: route.clone(),
                reviewer_provider: "openai".to_string(),
                reviewer_model: route.clone(),
                reviewer_fallback_model: route,
                max_parallel_coders: 2,
            };
            let router = ModelRouter::new_with_factory(
                config.clone(),
                Vec::new(),
                Arc::clone(&provider_factory),
                Some(PathBuf::from(r"D:\private-project\singleflight")),
            );

            let (planner, coder, tester, reviewer) = tokio::join!(
                router.resolve(AgentRole::Planner),
                router.resolve(AgentRole::Coder),
                router.resolve(AgentRole::Tester),
                router.resolve(AgentRole::Reviewer),
            );
            let errors = [planner, coder, tester, reviewer]
                .into_iter()
                .map(|result| match result {
                    Ok(_) => panic!("{stage:?} activation unexpectedly succeeded"),
                    Err(error) => error.to_string(),
                })
                .collect::<Vec<_>>();
            assert!(errors.iter().all(|error| error == &errors[0]));
            assert!(errors.iter().all(|error| !error.contains("sensitive-")));

            for role in [
                AgentRole::Planner,
                AgentRole::Coder,
                AgentRole::Tester,
                AgentRole::Reviewer,
            ] {
                let repeated = match router.resolve(role).await {
                    Ok(_) => panic!("{stage:?} repeated activation unexpectedly succeeded"),
                    Err(error) => error.to_string(),
                };
                assert_eq!(repeated, errors[0]);
            }
            assert_eq!(factory_count.load(Ordering::SeqCst), 1, "{stage:?}");
            assert_eq!(
                validation_count.load(Ordering::SeqCst),
                usize::from(stage != ActivationFailureStage::Factory),
                "{stage:?}"
            );
            assert_eq!(
                model_fetch_count.load(Ordering::SeqCst),
                usize::from(stage == ActivationFailureStage::Models),
                "{stage:?}"
            );

            let next_router = ModelRouter::new_with_factory(
                config,
                Vec::new(),
                Arc::clone(&provider_factory),
                Some(PathBuf::from(r"D:\private-project\singleflight")),
            );
            let retried = match next_router.resolve(AgentRole::Planner).await {
                Ok(_) => panic!("{stage:?} new-router activation unexpectedly succeeded"),
                Err(error) => error.to_string(),
            };
            assert_eq!(retried, errors[0]);
            assert_eq!(factory_count.load(Ordering::SeqCst), 2, "{stage:?}");
        }
    }

    #[tokio::test]
    async fn different_provider_activations_reach_a_barrier_without_global_serialization() {
        let production = include_str!("model_router.rs")
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .unwrap();
        assert!(
            production.contains("OnceCell"),
            "provider activation needs a per-provider OnceCell before running the barrier probe"
        );

        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let factory_barrier = Arc::clone(&barrier);
        let provider_factory: ModelRouterProviderFactory =
            Arc::new(move |provider_name, _extensions, _working_dir| {
                let provider = Arc::new(BarrierActivationProvider {
                    name: provider_name,
                    barrier: Arc::clone(&factory_barrier),
                });
                Box::pin(async move { Ok(provider as Arc<dyn Provider>) })
            });
        let config = ModelRouterConfig {
            planner_provider: "provider-a".to_string(),
            main_route: None,
            planner_model: "private-dynamic-model".to_string(),
            planner_fallback_model: "private-dynamic-model".to_string(),
            coder_provider: "provider-b".to_string(),
            coder_model: "private-dynamic-model".to_string(),
            coder_fallback_model: "private-dynamic-model".to_string(),
            tester_provider: "provider-a".to_string(),
            tester_model: "private-dynamic-model".to_string(),
            tester_fallback_model: "private-dynamic-model".to_string(),
            reviewer_provider: "provider-b".to_string(),
            reviewer_model: "private-dynamic-model".to_string(),
            reviewer_fallback_model: "private-dynamic-model".to_string(),
            max_parallel_coders: 2,
        };
        let router = ModelRouter::new_with_factory(config, Vec::new(), provider_factory, None);

        let (planner, coder) = tokio::join!(
            router.resolve(AgentRole::Planner),
            router.resolve(AgentRole::Coder),
        );
        assert!(planner.is_ok());
        assert!(coder.is_ok());
    }

    #[tokio::test]
    async fn legacy_advanced_route_cannot_activate_disabled_provider() {
        let disabled = "zai".to_string();
        let model = "glm-4.5".to_string();
        let router = ModelRouter::new(
            ModelRouterConfig {
                planner_provider: disabled.clone(),
                main_route: None,
                planner_model: model.clone(),
                planner_fallback_model: model.clone(),
                coder_provider: disabled.clone(),
                coder_model: model.clone(),
                coder_fallback_model: model.clone(),
                tester_provider: disabled.clone(),
                tester_model: model.clone(),
                tester_fallback_model: model.clone(),
                reviewer_provider: disabled,
                reviewer_model: model.clone(),
                reviewer_fallback_model: model,
                max_parallel_coders: 1,
            },
            Vec::new(),
        );

        let error = match router.resolve(AgentRole::Coder).await {
            Ok(_) => panic!("legacy advanced routing must reject disabled providers"),
            Err(error) => error,
        };

        assert!(error
            .to_string()
            .contains(crate::providers::UNVERIFIED_CREDENTIAL_ACTIVATION_REASON));
    }

    #[test]
    fn default_route_is_unconfigured_instead_of_silently_selecting_a_provider() {
        let router = ModelRouter::new(ModelRouterConfig::default(), vec![]);

        for role in [
            AgentRole::Planner,
            AgentRole::Coder,
            AgentRole::Tester,
            AgentRole::Reviewer,
        ] {
            assert_eq!(
                router.role_to_model(role),
                ("", ""),
                "{role} must remain unconfigured until the user saves a validated route"
            );
            assert_eq!(
                router.role_to_fallback_model(role),
                ("", ""),
                "{role} must not switch to an unqualified fallback"
            );
        }
        assert_eq!(router.max_parallel_coders(), 1);
    }

    #[test]
    fn legacy_role_overrides_are_never_a_routing_authority() {
        for typed_routing in [None, Some(CodeProModelRoutingConfig::default())] {
            let safe = ModelRouterConfig::from_config_values(
                typed_routing,
                Some(("ollama_cloud".to_string(), "kimi-k2.7-code".to_string())),
            )
            .unwrap();
            assert_eq!(safe.planner_provider, "ollama_cloud");
            assert_eq!(safe.planner_model, "kimi-k2.7-code");
            assert_eq!(safe.coder_provider, "ollama_cloud");
            assert_eq!(safe.coder_model, "kimi-k2.7-code");
            assert_eq!(safe.tester_provider, "ollama_cloud");
            assert_eq!(safe.tester_model, "kimi-k2.7-code");
            assert_eq!(safe.reviewer_provider, "ollama_cloud");
            assert_eq!(safe.reviewer_model, "kimi-k2.7-code");
            assert_eq!(safe.max_parallel_coders, 1);
        }

        let production = include_str!("model_router.rs")
            .split_once("#[cfg(test)]")
            .map(|(production, _)| production)
            .unwrap();
        for legacy_key in [
            "GOOSE_CODEPRO_ADVANCED_MODEL_ROUTING",
            "GOOSE_PLANNER_PROVIDER",
            "GOOSE_CODER_PROVIDER",
            "GOOSE_TESTER_PROVIDER",
            "GOOSE_REVIEWER_PROVIDER",
        ] {
            assert!(!production.contains(legacy_key));
        }
    }

    #[test]
    fn missing_global_default_stays_unconfigured() {
        let config = ModelRouterConfig::from_config_values(None, None).unwrap();

        assert!(config.planner_provider.is_empty());
        assert!(config.planner_model.is_empty());
        assert!(config.coder_model.is_empty());
        assert!(config.tester_model.is_empty());
        assert!(config.reviewer_model.is_empty());
        assert_eq!(config.max_parallel_coders, 1);
    }

    #[test]
    fn disabled_preferences_never_become_effective_routes_or_parallelism() {
        let mut remembered = enabled_typed_routing_config();
        remembered.advanced_routing_enabled = false;
        remembered.routes.push(CodeProModelRoute {
            role: CodeProModelRoutingRole::Main,
            provider_id: "offline-main".into(),
            model_id: "remembered-main".into(),
        });
        for default in [
            None,
            Some(("current-provider".into(), "current-model".into())),
        ] {
            let effective =
                ModelRouterConfig::from_config_values(Some(remembered.clone()), default.clone())
                    .unwrap();
            assert!(effective.main_route.is_none());
            let router = ModelRouter::new(effective, vec![]);
            for role in [
                AgentRole::Planner,
                AgentRole::Coder,
                AgentRole::Tester,
                AgentRole::Reviewer,
            ] {
                let expected = default
                    .as_ref()
                    .map(|(p, m)| (p.as_str(), m.as_str()))
                    .unwrap_or(("", ""));
                assert_eq!(router.role_to_model(role), expected);
                assert_eq!(router.role_to_fallback_model(role), expected);
            }
            assert_eq!(router.max_parallel_coders(), 1);
        }
    }

    #[test]
    fn typed_routes_are_the_only_per_role_authority_and_incomplete_typed_state_fails() {
        let typed = serde_json::from_value::<CodeProModelRoutingConfig>(serde_json::json!({
            "version": 1,
            "advancedRoutingEnabled": true,
            "routes": [
                { "role": "planner", "providerId": "anthropic", "modelId": "planner-private" },
                { "role": "coder", "providerId": "openai", "modelId": "coder-private" },
                { "role": "tester", "providerId": "openai", "modelId": "tester-private" },
                { "role": "reviewer", "providerId": "anthropic", "modelId": "reviewer-private" }
            ],
            "maxParallelCoders": 3
        }))
        .unwrap();
        let config = ModelRouterConfig::from_config_values(
            Some(typed),
            Some(("global-provider".to_string(), "global-model".to_string())),
        )
        .unwrap();

        assert_eq!(config.planner_provider, "anthropic");
        assert_eq!(config.planner_model, "planner-private");
        assert_eq!(config.coder_provider, "openai");
        assert_eq!(config.coder_model, "coder-private");
        assert_eq!(config.tester_model, "tester-private");
        assert_eq!(config.reviewer_model, "reviewer-private");
        assert_eq!(config.max_parallel_coders, 3);

        let incomplete = CodeProModelRoutingConfig {
            advanced_routing_enabled: true,
            routes: Vec::new(),
            ..CodeProModelRoutingConfig::default()
        };
        assert!(ModelRouterConfig::from_config_values(Some(incomplete), None).is_err());
    }

    fn enabled_typed_routing_config() -> CodeProModelRoutingConfig {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "advancedRoutingEnabled": true,
            "routes": [
                { "role": "planner", "providerId": "anthropic", "modelId": "planner-private" },
                { "role": "coder", "providerId": "openai", "modelId": "coder-private" },
                { "role": "tester", "providerId": "openai", "modelId": "tester-private" },
                { "role": "reviewer", "providerId": "anthropic", "modelId": "reviewer-private" }
            ],
            "maxParallelCoders": 3
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn main_route_is_independent_and_legacy_configs_leave_session_selection_intact() {
        let mut typed = enabled_typed_routing_config();
        let legacy = ModelRouterConfig::from_config_values(Some(typed.clone()), None).unwrap();
        assert!(ModelRouter::new(legacy, vec![])
            .resolve_main()
            .await
            .unwrap()
            .is_none());
        typed.routes.push(CodeProModelRoute {
            role: CodeProModelRoutingRole::Main,
            provider_id: "main-provider".into(),
            model_id: "main-model".into(),
        });
        let config = ModelRouterConfig::from_config_values(Some(typed), None).unwrap();
        assert_eq!(config.main_route.as_ref().unwrap().model_id, "main-model");
        assert_eq!(config.planner_model, "planner-private");
    }

    fn assert_enabled_typed_routes(config: &ModelRouterConfig) {
        assert_eq!(config.planner_model, "planner-private");
        assert_eq!(config.coder_model, "coder-private");
        assert_eq!(config.tester_model, "tester-private");
        assert_eq!(config.reviewer_model, "reviewer-private");
        assert_eq!(config.max_parallel_coders, 3);
    }

    #[test]
    fn enabled_typed_routing_ignores_malformed_structured_global_default() {
        let _env = env_lock::lock_env([
            (CODEPRO_MODEL_ROUTING_CONFIG_KEY, None::<&str>),
            ("GOOSE_PROVIDER", None::<&str>),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let config = crate::config::Config::new_with_file_secrets(
            dir.path().join("config.yaml"),
            dir.path().join("secrets.yaml"),
        )
        .unwrap();
        config
            .set_param(
                CODEPRO_MODEL_ROUTING_CONFIG_KEY,
                enabled_typed_routing_config(),
            )
            .unwrap();
        config
            .set_param("active_provider", "missing-provider-entry")
            .unwrap();

        let resolved = ModelRouterConfig::from_config_source(&config).unwrap();
        assert_enabled_typed_routes(&resolved);
    }

    #[test]
    fn enabled_typed_routing_ignores_incomplete_or_blank_global_environment_pair() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::config::Config::new_with_file_secrets(
            dir.path().join("config.yaml"),
            dir.path().join("secrets.yaml"),
        )
        .unwrap();
        config
            .set_param(
                CODEPRO_MODEL_ROUTING_CONFIG_KEY,
                enabled_typed_routing_config(),
            )
            .unwrap();

        for (provider, model) in [(Some("unrelated-provider"), None), (Some(""), Some(""))] {
            let _env = env_lock::lock_env([
                (CODEPRO_MODEL_ROUTING_CONFIG_KEY, None::<&str>),
                ("GOOSE_PROVIDER", provider),
                ("GOOSE_MODEL", model),
            ]);
            let resolved = ModelRouterConfig::from_config_source(&config).unwrap();
            assert_enabled_typed_routes(&resolved);
        }
    }

    fn layered_typed_routing_config(
        higher_path: std::path::PathBuf,
        dir: &std::path::Path,
    ) -> crate::config::Config {
        let lower_path = dir.join("lower-routing.yaml");
        let mut lower = serde_yaml::Mapping::new();
        lower.insert(
            serde_yaml::Value::String(CODEPRO_MODEL_ROUTING_CONFIG_KEY.to_string()),
            serde_yaml::to_value(enabled_typed_routing_config()).unwrap(),
        );
        std::fs::write(&lower_path, serde_yaml::to_string(&lower).unwrap()).unwrap();
        crate::config::Config::new_with_config_paths(
            vec![lower_path, higher_path],
            dir.join("secrets.yaml"),
        )
        .unwrap()
    }

    #[test]
    fn typed_routing_uses_one_strict_layered_snapshot() {
        let _env = env_lock::lock_env([
            (CODEPRO_MODEL_ROUTING_CONFIG_KEY, None::<&str>),
            ("GOOSE_PROVIDER", None::<&str>),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        let dir = tempfile::tempdir().unwrap();

        let malformed_path = dir.path().join("malformed-routing.yaml");
        std::fs::write(&malformed_path, "GOOSE_CODEPRO_MODEL_ROUTING: [malformed\n").unwrap();
        let malformed = layered_typed_routing_config(malformed_path, dir.path());
        assert!(ModelRouterConfig::from_config_source(&malformed).is_err());

        let directory_path = dir.path().join("routing-directory");
        std::fs::create_dir(&directory_path).unwrap();
        let unreadable = layered_typed_routing_config(directory_path, dir.path());
        assert!(ModelRouterConfig::from_config_source(&unreadable).is_err());

        let missing =
            layered_typed_routing_config(dir.path().join("missing-routing.yaml"), dir.path());
        let resolved = ModelRouterConfig::from_config_source(&missing).unwrap();
        assert_enabled_typed_routes(&resolved);

        let source = include_str!("model_router.rs").replace("\r\n", "\n");
        let loader = source
            .split_once("fn from_config_source(")
            .and_then(|(_, tail)| tail.split_once("fn from_config_values("))
            .map(|(loader, _)| loader)
            .expect("model routing config source loader");
        assert_eq!(loader.matches("merged_values_snapshot").count(), 1);
        assert!(!loader.contains("get_active_provider_model_pair()"));
    }

    #[test]
    fn typed_routing_environment_is_strict_and_enabled_skips_file_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("malformed-config.yaml");
        std::fs::write(&config_path, "active_provider: [malformed\n").unwrap();
        let config = crate::config::Config::new_with_file_secrets(
            config_path,
            dir.path().join("secrets.yaml"),
        )
        .unwrap();
        let routing_json = serde_json::to_string(&enabled_typed_routing_config()).unwrap();

        let environment = env_lock::lock_env([
            (
                CODEPRO_MODEL_ROUTING_CONFIG_KEY,
                Some(routing_json.as_str()),
            ),
            ("GOOSE_PROVIDER", Some("unrelated-provider")),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        let resolved = ModelRouterConfig::from_config_source(&config).unwrap();
        assert_enabled_typed_routes(&resolved);
        drop(environment);

        let _environment = env_lock::lock_env([
            (CODEPRO_MODEL_ROUTING_CONFIG_KEY, Some("not-json")),
            ("GOOSE_PROVIDER", None::<&str>),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        let error = ModelRouterConfig::from_config_source(&config).unwrap_err();
        assert!(error.to_string().contains("environment value"));
    }

    fn assert_global_route(config: &ModelRouterConfig, provider: &str, model: &str) {
        for (configured_provider, configured_model) in [
            (&config.planner_provider, &config.planner_model),
            (&config.coder_provider, &config.coder_model),
            (&config.tester_provider, &config.tester_model),
            (&config.reviewer_provider, &config.reviewer_model),
        ] {
            assert_eq!(
                (configured_provider.as_str(), configured_model.as_str()),
                (provider, model)
            );
        }
    }

    #[test]
    fn disabled_routing_and_complete_global_environment_pair_skip_file_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let malformed_path = dir.path().join("malformed-environment-fallback.yaml");
        std::fs::write(&malformed_path, "active_provider: [malformed\n").unwrap();
        let malformed = crate::config::Config::new_with_file_secrets(
            malformed_path,
            dir.path().join("secrets.yaml"),
        )
        .unwrap();
        let directory_path = dir.path().join("environment-fallback-directory");
        std::fs::create_dir(&directory_path).unwrap();
        let unreadable = crate::config::Config::new_with_file_secrets(
            directory_path,
            dir.path().join("other-secrets.yaml"),
        )
        .unwrap();
        let disabled_routing =
            serde_json::to_string(&CodeProModelRoutingConfig::default()).unwrap();

        let environment = env_lock::lock_env([
            (
                CODEPRO_MODEL_ROUTING_CONFIG_KEY,
                Some(disabled_routing.as_str()),
            ),
            ("GOOSE_PROVIDER", Some("environment-provider")),
            ("GOOSE_MODEL", Some("environment-model")),
        ]);
        for config in [&malformed, &unreadable] {
            let resolved = ModelRouterConfig::from_config_source(config).unwrap();
            assert_global_route(&resolved, "environment-provider", "environment-model");
        }
        drop(environment);

        let valid_file_path = dir.path().join("valid-file-fallback.yaml");
        std::fs::write(
            &valid_file_path,
            "GOOSE_PROVIDER: file-provider\nGOOSE_MODEL: file-model\n",
        )
        .unwrap();
        let valid_file = crate::config::Config::new_with_file_secrets(
            valid_file_path,
            dir.path().join("valid-secrets.yaml"),
        )
        .unwrap();
        for (provider, model) in [(Some("environment-provider"), None), (Some(""), Some(""))] {
            let _environment = env_lock::lock_env([
                (
                    CODEPRO_MODEL_ROUTING_CONFIG_KEY,
                    Some(disabled_routing.as_str()),
                ),
                ("GOOSE_PROVIDER", provider),
                ("GOOSE_MODEL", model),
            ]);
            assert!(ModelRouterConfig::from_config_source(&valid_file).is_err());
        }
    }

    #[test]
    fn resolve_never_retries_an_implicit_fallback_route() {
        let source = include_str!("model_router.rs").replace("\r\n", "\n");
        let production = source
            .split_once("\n#[cfg(test)]\nmod tests {")
            .map(|(production, _)| production)
            .expect("model router test module boundary");
        let resolve = production
            .split_once("pub async fn resolve(")
            .and_then(|(_, tail)| tail.split_once("pub async fn resolve_fallback"))
            .map(|(resolve, _)| resolve)
            .expect("model route resolution body");

        assert!(!resolve.contains("trying fallback"));
        assert!(!resolve.contains("role_to_fallback_model"));
        assert_eq!(resolve.matches("self.try_resolve(").count(), 1);
    }

    #[test]
    fn role_to_model_returns_values_from_explicit_typed_config() {
        let config = ModelRouterConfig {
            planner_provider: "anthropic".to_string(),
            main_route: None,
            planner_model: "planner-private".to_string(),
            planner_fallback_model: "planner-private".to_string(),
            coder_provider: "openai".to_string(),
            coder_model: "coder-private".to_string(),
            coder_fallback_model: "coder-private".to_string(),
            tester_provider: "openai".to_string(),
            tester_model: "tester-private".to_string(),
            tester_fallback_model: "tester-private".to_string(),
            reviewer_provider: "anthropic".to_string(),
            reviewer_model: "reviewer-private".to_string(),
            reviewer_fallback_model: "reviewer-private".to_string(),
            max_parallel_coders: 3,
        };
        let router = ModelRouter::new(config, vec![]);

        assert_eq!(
            router.role_to_model(AgentRole::Planner),
            ("anthropic", "planner-private")
        );
        assert_eq!(
            router.role_to_model(AgentRole::Coder),
            ("openai", "coder-private")
        );
        assert_eq!(
            router.role_to_model(AgentRole::Tester),
            ("openai", "tester-private")
        );
        assert_eq!(
            router.role_to_model(AgentRole::Reviewer),
            ("anthropic", "reviewer-private")
        );
        assert_eq!(
            router.role_to_fallback_model(AgentRole::Coder),
            ("openai", "coder-private")
        );
        assert_eq!(
            router.max_parallel_coders(),
            3,
            "the typed router ceiling is distinct from the host concurrency cap"
        );
    }
}
