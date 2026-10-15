use crate::acp::custom_requests::GooseExtension;
use crate::acp::server::{meta_string, validate_absolute_cwd, ResultExt};
use crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding;
use crate::agents::external_http_attempt_budget::{
    ExternalHttpAttemptBudget, ExternalHttpAttemptHostPolicy,
};
use crate::agents::{CodeProStateStore, ExtensionLoadResult};
use crate::config::{Config, GooseMode};
use crate::recipe::{Recipe, Settings};
use crate::session::extension_data::ExtensionState;
use crate::session::{ExtensionData, Session, SessionType};

use super::GooseAcpAgent;
use agent_client_protocol::schema::v1::{Meta, NewSessionRequest, NewSessionResponse, SessionId};
use agent_client_protocol::{Client, ConnectionTo};
use goose_providers::model::ModelConfig;
use std::collections::HashMap;
use std::path::PathBuf;
use tracing::warn;

struct InitialSessionConfig {
    provider: String,
    model_config: ModelConfig,
    extension_data: ExtensionData,
    recipe: Option<Recipe>,
    user_recipe_values: Option<HashMap<String, String>>,
    project_id: Option<String>,
}

fn new_session_failure(
    primary: String,
    cleanup_errors: Vec<String>,
) -> agent_client_protocol::Error {
    let detail = if cleanup_errors.is_empty() {
        primary
    } else {
        format!(
            "{primary}; cleanup failures: {}",
            cleanup_errors.join(" | ")
        )
    };
    agent_client_protocol::Error::internal_error().data(detail)
}

impl GooseAcpAgent {
    pub(super) async fn handle_new_session(
        &self,
        cx: &ConnectionTo<Client>,
        args: NewSessionRequest,
    ) -> Result<NewSessionResponse, agent_client_protocol::Error> {
        let config = Config::global();
        let project_id = meta_string(args.meta.as_ref(), "projectId")?;
        let session_type = session_type_from_meta(args.meta.as_ref())?;
        let workspace_binding =
            codepro_workspace_binding_from_meta(&session_type, args.meta.as_ref(), &args.cwd)?;
        // Unbound CodePro sessions intentionally have no project directory. Fall back to the
        // process current directory so the session record still has a valid cwd.
        let cwd = if matches!(
            workspace_binding.as_ref(),
            Some(CodeProWorkspaceBinding::Unbound)
        ) && args.cwd.as_os_str().is_empty()
        {
            std::env::current_dir().map_err(|error| {
                agent_client_protocol::Error::internal_error().data(format!(
                    "failed to determine current directory for unbound session: {error}"
                ))
            })?
        } else {
            args.cwd.clone()
        };
        validate_absolute_cwd(&cwd)?;
        let recipe = self.resolve_recipe_from_meta(args.meta.as_ref()).await?;
        #[cfg(any(windows, target_os = "macos"))]
        let workspace_lease = consume_codepro_workspace_lease(
            &session_type,
            workspace_binding.as_ref(),
            args.meta.as_ref(),
            cwd.as_path(),
        )?;
        #[cfg(any(windows, target_os = "macos"))]
        let mut workspace_lease_bound = false;
        #[cfg(not(any(windows, target_os = "macos")))]
        let workspace_lease_bound = false;
        let current_mode: GooseMode = config.get_goose_mode().unwrap_or_default();
        let session_name = match recipe.as_ref() {
            Some((recipe, _)) if !recipe.title.trim().is_empty() => recipe.title.clone(),
            _ => "New Chat".to_string(),
        };

        let session = self
            .session_manager
            .create_session(cwd.clone(), session_name, session_type, current_mode)
            .await
            .internal_err_ctx("Failed to create session")?;
        #[cfg(any(windows, target_os = "macos"))]
        if let Err(error) = super::workspace_lease::reopen_session_access(&session.id) {
            let cleanup = self
                .cleanup_failed_new_session(&session.id, false, false)
                .await;
            return Err(new_session_failure(
                format!("Failed to initialize session access: {error}"),
                cleanup,
            ));
        }
        #[cfg(any(windows, target_os = "macos"))]
        if let Some(workspace_lease) = workspace_lease {
            if let Err(error) =
                super::workspace_lease::bind_workspace_lease(&session.id, workspace_lease)
            {
                let cleanup = self
                    .cleanup_failed_new_session(&session.id, false, false)
                    .await;
                return Err(new_session_failure(error.to_string(), cleanup));
            }
            workspace_lease_bound = true;
        }
        let mut codepro_authorization_issued = false;
        if session.session_type == SessionType::CodePro {
            let state_store = match CodeProStateStore::try_default() {
                Ok(state_store) => state_store,
                Err(error) => {
                    let cleanup = self
                        .cleanup_failed_new_session(
                            &session.id,
                            cfg!(any(windows, target_os = "macos")) && workspace_lease_bound,
                            false,
                        )
                        .await;
                    return Err(new_session_failure(error.to_string(), cleanup));
                }
            };
            if let Err(error) = issue_codepro_external_http_authorization(
                &session.session_type,
                &session.id,
                &state_store,
                ExternalHttpAttemptHostPolicy::default(),
            ) {
                let cleanup = self
                    .cleanup_failed_new_session(
                        &session.id,
                        cfg!(any(windows, target_os = "macos")) && workspace_lease_bound,
                        false,
                    )
                    .await;
                return Err(new_session_failure(error.to_string(), cleanup));
            }
            codepro_authorization_issued = true;
        }
        match self
            .finish_new_session_setup(
                cx,
                config,
                &session,
                args,
                recipe,
                project_id,
                workspace_binding,
            )
            .await
        {
            Ok(response) => Ok(response),
            Err(error) => {
                let cleanup = self
                    .cleanup_failed_new_session(
                        &session.id,
                        cfg!(any(windows, target_os = "macos")) && workspace_lease_bound,
                        codepro_authorization_issued,
                    )
                    .await;
                if cleanup.is_empty() {
                    Err(error)
                } else {
                    Err(new_session_failure(format!("{error:?}"), cleanup))
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn finish_new_session_setup(
        &self,
        cx: &ConnectionTo<Client>,
        config: &Config,
        session: &Session,
        args: NewSessionRequest,
        recipe: Option<(Recipe, PathBuf)>,
        project_id: Option<String>,
        workspace_binding: Option<CodeProWorkspaceBinding>,
    ) -> Result<NewSessionResponse, agent_client_protocol::Error> {
        let rendered_recipe = self
            .configure_new_session(
                cx,
                config,
                session,
                args,
                recipe,
                project_id,
                workspace_binding.as_ref(),
            )
            .await?;

        if let Some(workspace_binding) = workspace_binding {
            let mut extension_data = self.reload_session(&session.id).await?.extension_data;
            workspace_binding
                .to_extension_data(&mut extension_data)
                .map_err(|error| {
                    agent_client_protocol::Error::internal_error().data(error.to_string())
                })?;
            self.session_manager
                .update(&session.id)
                .extension_data(extension_data)
                .apply()
                .await
                .internal_err_ctx("Failed to persist CodePro workspace binding")?;
        }

        let reloaded_session = self.reload_session(&session.id).await?;
        let (agent, extension_results) = self
            .activate_acp_session(cx, &reloaded_session, HashMap::new())
            .await?;
        if let Some(recipe) = &rendered_recipe {
            self.apply_recipe(&agent, recipe).await;
        }

        let reloaded_session = self.reload_session(&session.id).await?;
        let response = self
            .build_new_session_response(&reloaded_session, &extension_results)
            .await?;
        self.notify_session_setup(cx, &reloaded_session).await?;
        Ok(response)
    }

    async fn cleanup_failed_new_session(
        &self,
        session_id: &str,
        release_workspace_lease: bool,
        delete_codepro_state: bool,
    ) -> Vec<String> {
        let mut cleanup_errors = Vec::new();
        if let Err(error) = self.session_manager.delete_session(session_id).await {
            warn!(
                session_id,
                %error,
                "Failed to delete session during new-session cleanup"
            );
            cleanup_errors.push(format!("session record: {error}"));
        }
        self.sessions.lock().await.remove(session_id);
        if let Err(error) = self
            .agent_manager
            .remove_session_if_loaded(session_id)
            .await
        {
            warn!(
                session_id,
                %error,
                "Failed to remove in-memory agent during new-session cleanup"
            );
            cleanup_errors.push(format!("in-memory agent: {error}"));
        }
        self.permission_manager()
            .invalidate_scoped_permissions(session_id);
        if delete_codepro_state {
            if let Ok(state_store) = CodeProStateStore::try_default() {
                if let Err(error) = state_store.delete(session_id).await {
                    warn!(
                        session_id,
                        %error,
                        "Failed to delete CodePro run state during new-session cleanup"
                    );
                    cleanup_errors.push(format!("CodePro state: {error}"));
                }
            }
        }
        #[cfg(any(windows, target_os = "macos"))]
        if release_workspace_lease {
            if let Err(error) =
                super::workspace_lease::rollback_failed_session_workspace_lease(session_id)
            {
                cleanup_errors.push(format!(
                    "workspace rollback failed; an orphan may remain: {error}"
                ));
            }
        }
        cleanup_errors
    }

    #[allow(clippy::too_many_arguments)]
    async fn configure_new_session(
        &self,
        cx: &ConnectionTo<Client>,
        config: &Config,
        session: &Session,
        args: NewSessionRequest,
        recipe: Option<(Recipe, PathBuf)>,
        project_id: Option<String>,
        workspace_binding: Option<&CodeProWorkspaceBinding>,
    ) -> Result<Option<Recipe>, agent_client_protocol::Error> {
        let (rendered, user_recipe_values) = self
            .render_recipe_for_session(cx, &session.id, recipe.as_ref())
            .await?;

        let recipe_settings = rendered.as_ref().and_then(|r| r.settings.as_ref());
        let (provider, model_config) = self
            .resolve_provider_and_model(config, args.meta.as_ref(), recipe_settings)
            .await?;

        let goose_extensions = meta_goose_extensions(args.meta.as_ref())?;
        let recipe_extensions = rendered.as_ref().and_then(|r| r.extensions.as_deref());
        let extension_data = self.build_enabled_extensions_data(
            config,
            session,
            args.mcp_servers,
            goose_extensions,
            recipe_extensions,
            session.session_type != SessionType::CodePro
                || matches!(
                    workspace_binding,
                    Some(CodeProWorkspaceBinding::WritableProject { .. })
                ),
        )?;

        self.apply_initial_session_config(
            &session.id,
            InitialSessionConfig {
                provider,
                model_config,
                extension_data,
                recipe: recipe.map(|(recipe, _)| recipe),
                user_recipe_values,
                project_id,
            },
        )
        .await?;

        Ok(rendered)
    }

    async fn reload_session(
        &self,
        session_id: &str,
    ) -> Result<Session, agent_client_protocol::Error> {
        self.session_manager
            .get_session(session_id, false)
            .await
            .internal_err_ctx("Failed to reload session")
    }

    async fn resolve_provider_and_model(
        &self,
        config: &Config,
        meta: Option<&Meta>,
        recipe_settings: Option<&Settings>,
    ) -> Result<(String, ModelConfig), agent_client_protocol::Error> {
        let recipe_provider = recipe_settings.and_then(|s| s.goose_provider.clone());
        let recipe_model = recipe_settings.and_then(|s| s.goose_model.clone());

        let provider = match recipe_provider {
            Some(provider) => provider,
            None => match meta_string(meta, "provider")? {
                Some(provider) => provider,
                None => {
                    if let Some(model) = recipe_model.as_deref() {
                        let provider = config.get_goose_provider().map_err(|error| {
                            agent_client_protocol::Error::internal_error()
                                .data(format!("Failed to resolve provider: {}", error))
                        })?;
                        super::ensure_provider_activation_supported(&provider)?;
                        let model_config = model_config_from_recipe_settings(&provider, model)?;
                        return Ok((provider, model_config));
                    }

                    return super::resolve_default_provider_model_config(config);
                }
            },
        };

        super::ensure_provider_activation_supported(&provider)?;

        let model_config = match recipe_model {
            Some(model) => model_config_from_recipe_settings(&provider, &model)?,
            None => super::resolve_provider_default_model_config(&provider).await?,
        };

        Ok((provider, model_config))
    }

    async fn apply_initial_session_config(
        &self,
        session_id: &str,
        config: InitialSessionConfig,
    ) -> Result<(), agent_client_protocol::Error> {
        let mut builder = self
            .session_manager
            .update(session_id)
            .provider_name(config.provider)
            .model_config(config.model_config)
            .extension_data(config.extension_data);
        if let Some(recipe) = config.recipe {
            builder = builder.recipe(Some(recipe));
        }
        if config.user_recipe_values.is_some() {
            builder = builder.user_recipe_values(config.user_recipe_values);
        }
        if let Some(project_id) = config.project_id {
            builder = builder.project_id(Some(project_id));
        }
        builder
            .apply()
            .await
            .internal_err_ctx("Failed to update session")?;
        Ok(())
    }

    async fn build_new_session_response(
        &self,
        session: &Session,
        extension_results: &[ExtensionLoadResult],
    ) -> Result<NewSessionResponse, agent_client_protocol::Error> {
        let (mode_state, config_options) =
            super::build_session_setup_config(&self.provider_inventory, session).await?;

        let mut response =
            NewSessionResponse::new(SessionId::new(session.id.clone())).modes(mode_state);
        if let Some(co) = config_options {
            response = response.config_options(co);
        }
        response = response.meta(super::session_response_meta(session, extension_results));
        Ok(response)
    }
}

fn issue_codepro_external_http_authorization(
    session_type: &SessionType,
    logical_run_id: &str,
    state_store: &CodeProStateStore,
    policy: ExternalHttpAttemptHostPolicy,
) -> Result<(), goose_providers::errors::ProviderError> {
    if *session_type != SessionType::CodePro {
        return Ok(());
    }
    ExternalHttpAttemptBudget::issue_for_new_logical_run(
        state_store.external_http_attempt_budget_path(logical_run_id),
        logical_run_id.to_string(),
        policy,
    )?;
    Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
fn consume_codepro_workspace_lease(
    session_type: &SessionType,
    workspace_binding: Option<&CodeProWorkspaceBinding>,
    meta: Option<&Meta>,
    cwd: &std::path::Path,
) -> Result<Option<super::workspace_lease::ConsumedWorkspaceLease>, agent_client_protocol::Error> {
    if *session_type != SessionType::CodePro {
        return Ok(None);
    }
    if matches!(
        workspace_binding,
        Some(CodeProWorkspaceBinding::Unbound | CodeProWorkspaceBinding::RootContainer { .. })
    ) {
        return Ok(None);
    }
    let lease_id = meta_string(meta, "workspaceLeaseId")?.ok_or_else(|| {
        agent_client_protocol::Error::invalid_params()
            .data("CodePro new_session requires workspaceLeaseId")
    })?;
    super::workspace_lease::consume_workspace_lease(&lease_id, cwd)
        .map(Some)
        .map_err(|error| agent_client_protocol::Error::invalid_params().data(error.to_string()))
}

fn codepro_workspace_binding_from_meta(
    session_type: &SessionType,
    meta: Option<&Meta>,
    cwd: &std::path::Path,
) -> Result<Option<CodeProWorkspaceBinding>, agent_client_protocol::Error> {
    if *session_type != SessionType::CodePro {
        return Ok(None);
    }
    match meta_string(meta, "workspaceBinding")?.as_deref() {
        None | Some("writable_project") => {
            let lease_id = meta_string(meta, "workspaceLeaseId")?.unwrap_or_default();
            Ok(Some(CodeProWorkspaceBinding::WritableProject {
                path: cwd.to_string_lossy().into_owned(),
                lease_id,
            }))
        }
        Some("unbound") => Ok(Some(CodeProWorkspaceBinding::Unbound)),
        Some("root_container") => {
            let root = meta_string(meta, "rootContainerPath")?.ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data("root_container requires rootContainerPath")
            })?;
            #[cfg(any(windows, target_os = "macos"))]
            let valid_root = std::path::Path::new(&root) == cwd
                && super::workspace_lease::validate_root_container_path(cwd).is_ok();
            #[cfg(not(any(windows, target_os = "macos")))]
            let valid_root = std::path::Path::new(&root) == cwd && cwd.parent().is_none();
            if !valid_root {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("rootContainerPath must match the filesystem-root cwd"));
            }
            Ok(Some(CodeProWorkspaceBinding::RootContainer { path: root }))
        }
        Some(_) => Err(agent_client_protocol::Error::invalid_params()
            .data("workspaceBinding must be unbound, root_container, or writable_project")),
    }
}

fn model_config_from_recipe_settings(
    provider: &str,
    model: &str,
) -> Result<ModelConfig, agent_client_protocol::Error> {
    crate::model_config::model_config_from_user_config(provider, model)
        .internal_err_ctx("Failed to build model config from recipe settings")
}

fn session_type_from_meta(
    meta: Option<&Meta>,
) -> Result<SessionType, agent_client_protocol::Error> {
    match meta_string(meta, "workspaceMode")?.as_deref() {
        Some("codepro") => Ok(SessionType::CodePro),
        Some("code") | None => match meta_string(meta, "client")? {
            Some(_) => Ok(SessionType::User),
            None => Ok(SessionType::Acp),
        },
        Some(_) => Err(agent_client_protocol::Error::invalid_params()
            .data("workspaceMode must be either code or codepro")),
    }
}

fn meta_goose_extensions(
    meta: Option<&Meta>,
) -> Result<Option<Vec<GooseExtension>>, agent_client_protocol::Error> {
    let Some(value) = meta.and_then(|m| m.get("enabledExtensions")) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|e| {
            agent_client_protocol::Error::invalid_params().data(format!("enabledExtensions: {e}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::external_http_attempt_budget::ExternalHttpAttemptHostPolicy;
    use crate::agents::CodeProStateStore;

    #[test]
    fn codepro_workspace_creates_a_distinct_session_type() {
        let meta: Meta =
            serde_json::from_value(serde_json::json!({"workspaceMode": "codepro"})).unwrap();

        assert_eq!(
            session_type_from_meta(Some(&meta)).unwrap(),
            SessionType::CodePro
        );
    }

    #[test]
    fn desktop_workspace_remains_a_user_session() {
        let meta: Meta =
            serde_json::from_value(serde_json::json!({"client": "goose-desktop"})).unwrap();

        assert_eq!(
            session_type_from_meta(Some(&meta)).unwrap(),
            SessionType::User
        );
    }

    #[test]
    fn codepro_new_session_issues_a_durable_gate_without_environment_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(directory.path());

        issue_codepro_external_http_authorization(
            &SessionType::CodePro,
            "logical-run-a",
            &store,
            ExternalHttpAttemptHostPolicy::try_new(5).unwrap(),
        )
        .unwrap();

        let state: crate::agents::external_http_attempt_budget::ExternalHttpAttemptBudgetState =
            serde_json::from_slice(
                &std::fs::read(store.external_http_attempt_budget_path("logical-run-a")).unwrap(),
            )
            .unwrap();
        assert_eq!(state.logical_run_id, "logical-run-a");
        assert_eq!(state.cap, 5);
        assert_eq!(state.used, 0);
        assert_ne!(state.authorization_id, "logical-run-a");
    }

    #[test]
    fn ordinary_new_session_does_not_issue_a_codepro_gate() {
        let directory = tempfile::tempdir().unwrap();
        let store = CodeProStateStore::new(directory.path());

        issue_codepro_external_http_authorization(
            &SessionType::User,
            "ordinary-session",
            &store,
            ExternalHttpAttemptHostPolicy::default(),
        )
        .unwrap();

        assert!(!store
            .external_http_attempt_budget_path("ordinary-session")
            .exists());
    }

    #[cfg(windows)]
    #[test]
    fn codepro_workspace_lease_is_required_before_session_creation() {
        let meta: Meta =
            serde_json::from_value(serde_json::json!({"workspaceMode": "codepro"})).unwrap();

        assert!(consume_codepro_workspace_lease(
            &SessionType::CodePro,
            Some(&CodeProWorkspaceBinding::WritableProject {
                path: "D:\\workspace".to_string(),
                lease_id: String::new(),
            }),
            Some(&meta),
            std::path::Path::new("D:\\workspace"),
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn codepro_workspace_lease_rejects_cwd_mismatch_and_token_reuse() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let acquired = super::super::workspace_lease::acquire_workspace_lease(
            super::super::workspace_lease::AcquireWorkspaceLeaseRequest {
                requested_path: workspace.to_string_lossy().into_owned(),
                expected_state: super::super::workspace_lease::WorkspaceState::EmptyDirectory,
                expected_identity: workspace
                    .to_string_lossy()
                    .replace('/', "\\")
                    .to_lowercase(),
            },
        )
        .unwrap();
        let meta: Meta = serde_json::from_value(serde_json::json!({
            "workspaceMode": "codepro",
            "workspaceLeaseId": acquired.lease_id.clone(),
        }))
        .unwrap();
        let wrong_cwd = temp.path().join("wrong");
        let binding = CodeProWorkspaceBinding::WritableProject {
            path: workspace.to_string_lossy().into_owned(),
            lease_id: acquired.lease_id.clone(),
        };

        assert!(consume_codepro_workspace_lease(
            &SessionType::CodePro,
            Some(&binding),
            Some(&meta),
            &wrong_cwd,
        )
        .is_err());
        let _consumed = consume_codepro_workspace_lease(
            &SessionType::CodePro,
            Some(&binding),
            Some(&meta),
            &workspace,
        )
        .expect("the matching workspace must consume the pending lease exactly once");
        assert!(consume_codepro_workspace_lease(
            &SessionType::CodePro,
            Some(&binding),
            Some(&meta),
            &workspace,
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn unbound_and_root_container_sessions_do_not_consume_a_writable_lease() {
        let unbound_meta: Meta = serde_json::from_value(serde_json::json!({
            "workspaceMode": "codepro",
            "workspaceBinding": "unbound",
        }))
        .unwrap();
        let unbound = codepro_workspace_binding_from_meta(
            &SessionType::CodePro,
            Some(&unbound_meta),
            std::path::Path::new("C:\\host-cwd"),
        )
        .unwrap()
        .unwrap();
        assert!(consume_codepro_workspace_lease(
            &SessionType::CodePro,
            Some(&unbound),
            Some(&unbound_meta),
            std::path::Path::new("C:\\host-cwd"),
        )
        .unwrap()
        .is_none());

        let root_meta: Meta = serde_json::from_value(serde_json::json!({
            "workspaceMode": "codepro",
            "workspaceBinding": "root_container",
            "rootContainerPath": "D:\\",
        }))
        .unwrap();
        let root = codepro_workspace_binding_from_meta(
            &SessionType::CodePro,
            Some(&root_meta),
            std::path::Path::new("D:\\"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            root,
            CodeProWorkspaceBinding::RootContainer {
                path: "D:\\".to_string()
            }
        );
        assert!(consume_codepro_workspace_lease(
            &SessionType::CodePro,
            Some(&root),
            Some(&root_meta),
            std::path::Path::new("D:\\"),
        )
        .unwrap()
        .is_none());
    }
}
