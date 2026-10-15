use crate::acp::custom_notifications::*;
use crate::acp::custom_requests::*;
use crate::acp::fs::AcpTools;
pub(super) use crate::acp::response_builder::{
    build_config_options, build_mode_state, build_model_state, build_provider_options,
    build_session_info, build_session_setup_config, send_session_setup_notifications, session_meta,
    session_provider_selection, session_response_meta, should_refresh_inventory_for_session_init,
};
use crate::acp::tool_call_notifier::ToolCallNotifier;
use crate::acp::{PermissionDecision, ACP_CURRENT_MODEL};
use crate::agents::codepro_workspace_binding::CodeProWorkspaceBinding;
use crate::agents::extension::{Envs, PLATFORM_EXTENSIONS};
use crate::agents::mcp_client::{GooseMcpHostInfo, McpClientTrait};
use crate::agents::platform_extensions::developer::DeveloperClient;
use crate::agents::tool_idempotency::ToolIdempotencyStore;
use crate::agents::{
    ActivityEvent, Agent, AgentConfig, CodeProResumeRequest, ExtensionConfig, ExtensionLoadResult,
    ExtensionManager, GoosePlatform, SessionConfig, ToolConfirmationOutcome,
};
#[cfg(test)]
use crate::agents::{ActivityEventKind, ActivityEventStatus};
use crate::config::base::CONFIG_YAML_NAME;
use crate::config::extensions::get_enabled_extensions_with_config;
use crate::config::paths::Paths;
use crate::config::permission::PermissionManager;
use crate::config::{Config, GooseMode};
use crate::conversation::message::{
    ActionRequiredData, Message, MessageContent, SystemNotificationContent, SystemNotificationType,
    ToolAuthorizationScope, ToolExtensionSource, ToolPermissionClass, ToolRequest, ToolResponse,
};
use crate::execution::manager::{AgentManager, AgentManagerGetResult, RuntimeContext};
use crate::github_auth::GitHubAuthService;
use crate::permission::permission_confirmation::PrincipalType;
use crate::permission::{Permission, PermissionConfirmation};
use crate::providers::base::Provider;
use crate::providers::inventory::{
    ProviderInventoryEntry, ProviderInventoryService, RefreshJobPlan, RefreshPlan,
    RefreshSkipReason,
};
use crate::scheduler_trait::SchedulerTrait;
use crate::session::session_manager::SessionUsageTotals;
use crate::session::{
    EnabledExtensionsState, ExtensionData, ExtensionState, Session, SessionManager, SessionType,
};
use crate::source_roots::SourceRoot;
use crate::utils::sanitize_unicode_tags;
use agent_client_protocol::schema::v1::{
    AgentCapabilities, Annotations, AuthMethod, AuthMethodAgent, AuthenticateRequest,
    AuthenticateResponse, CancelNotification, CloseSessionRequest, CloseSessionResponse,
    ConfigOptionUpdate, Content, ContentBlock, ContentChunk, Cost, CurrentModeUpdate,
    EmbeddedResourceResource, FileSystemCapabilities, ForkSessionRequest, ForkSessionResponse,
    ImageContent, Implementation, InitializeRequest, InitializeResponse, ListSessionsRequest,
    ListSessionsResponse, LoadSessionRequest, LoadSessionResponse, McpCapabilities, McpServer,
    Meta, NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionKind,
    PromptCapabilities, PromptRequest, PromptResponse, RequestPermissionOutcome,
    RequestPermissionRequest, ResourceLink, SessionCapabilities, SessionCloseCapabilities,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption, SessionId,
    SessionInfoUpdate, SessionListCapabilities, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest,
    SetSessionModeResponse, StopReason, TextContent, ToolCallContent, ToolCallId, ToolCallStatus,
    ToolCallUpdate, ToolCallUpdateFields, ToolKind, Usage, UsageUpdate,
};
use agent_client_protocol::util::MatchDispatchFrom;
use agent_client_protocol::{
    Agent as SacpAgent, ByteStreams, Client, ConnectionTo, Dispatch, HandleDispatchFrom, Handled,
    Responder,
};
use anyhow::Result;
use fs_err as fs;
use futures::future::{BoxFuture, FutureExt};
use futures::stream::{self, StreamExt};
use rmcp::model::{AnnotateAble, RawTextContent, Role};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::{Mutex, OnceCell};
use tokio_util::compat::{TokioAsyncReadCompatExt as _, TokioAsyncWriteCompatExt as _};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};
use url::Url;
use uuid::Uuid;

use self::tool_calls::chain::{extend_chain_membership, ToolChain};
use self::tool_calls::conversion::{
    extract_tool_call_update_meta, format_tool_name, pending_tool_call_from_request,
    tool_call_identity_meta, tool_call_identity_meta_from_name,
    tool_call_update_fields_from_response,
};
use self::tool_calls::enrichment::{ChainSummaryEnrichmentContext, ToolTitleEnrichmentContext};

mod agent_requests;
pub use agent_requests::agent_request_schemas;
mod agent_mentions;
mod apps;
mod capability_usage;
mod codepro_control;
mod codepro_control_projection;
mod config;
mod context_maintenance;
mod custom_dispatch;
mod diagnostics;
mod dictation;
mod dispatch;
mod elicitation;
mod extensions;
mod fork_session;
mod github_auth;
mod github_ci;
mod github_issues;
mod github_pull_requests;
mod list_sessions;
mod load_session;
mod local_inference;
mod manage_sessions;
mod memory;
mod new_session;
mod onboarding;
mod prompt_goal;
mod prompts;
mod providers;
mod recipe;
mod resources;
mod review;
mod schedule;
mod skill_management;
mod slash_commands;
mod sources;
mod tool_calls;
mod tool_notifications;
mod tools;
#[cfg(any(windows, target_os = "macos"))]
mod workspace_confirmation;
#[cfg(windows)]
pub(crate) mod workspace_lease;
#[cfg(target_os = "macos")]
#[path = "server/workspace_lease_macos.rs"]
pub(crate) mod workspace_lease;

pub type AcpProviderFactory = Arc<
    dyn Fn(
            String,
            Vec<ExtensionConfig>,
            Option<PathBuf>,
        ) -> BoxFuture<'static, Result<Arc<dyn Provider>>>
        + Send
        + Sync,
>;

/// Convenience conversions from any `Display` error into an `agent_client_protocol::Error`.
///
/// Replaces the repetitive `.internal_err()`
/// pattern. Use `.internal_err()?` for server-side failures and `.invalid_params_err()?`
/// for bad client input. For custom messages use `.internal_err_ctx("context")?`.
#[allow(dead_code)]
trait ResultExt<T> {
    fn internal_err(self) -> Result<T, agent_client_protocol::Error>;
    fn invalid_params_err(self) -> Result<T, agent_client_protocol::Error>;
    fn internal_err_ctx(self, context: &str) -> Result<T, agent_client_protocol::Error>;
    fn invalid_params_err_ctx(self, context: &str) -> Result<T, agent_client_protocol::Error>;
}

pub(super) struct SessionDispatchPermit {
    #[cfg(any(windows, target_os = "macos"))]
    _workspace: Option<workspace_lease::SessionAccessPermit>,
}

fn codepro_runtime_update_targets_prompt(
    update: &crate::agents::control_plane::RuntimeUpdate,
    session_id: &str,
    run_id: &str,
) -> bool {
    update.session_id == session_id && update.run_id.as_str() == run_id
}

fn coalesce_codepro_runtime_update_burst(
    first: crate::agents::control_plane::RuntimeUpdate,
    updates: &mut tokio::sync::broadcast::Receiver<crate::agents::control_plane::RuntimeUpdate>,
    session_id: &str,
    run_id: &str,
) -> Option<u64> {
    let mut latest_sequence = codepro_runtime_update_targets_prompt(&first, session_id, run_id)
        .then_some(first.last_sequence);

    loop {
        match updates.try_recv() {
            Ok(update) if codepro_runtime_update_targets_prompt(&update, session_id, run_id) => {
                latest_sequence = Some(
                    latest_sequence
                        .unwrap_or_default()
                        .max(update.last_sequence),
                );
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            | Err(tokio::sync::broadcast::error::TryRecvError::Closed) => break,
        }
    }

    latest_sequence
}

impl<T, E: std::fmt::Display> ResultExt<T> for Result<T, E> {
    fn internal_err(self) -> Result<T, agent_client_protocol::Error> {
        self.map_err(|e| agent_client_protocol::Error::internal_error().data(e.to_string()))
    }
    fn invalid_params_err(self) -> Result<T, agent_client_protocol::Error> {
        self.map_err(|e| agent_client_protocol::Error::invalid_params().data(e.to_string()))
    }
    fn internal_err_ctx(self, context: &str) -> Result<T, agent_client_protocol::Error> {
        self.map_err(|e| {
            agent_client_protocol::Error::internal_error().data(format!("{context}: {e}"))
        })
    }
    fn invalid_params_err_ctx(self, context: &str) -> Result<T, agent_client_protocol::Error> {
        self.map_err(|e| {
            agent_client_protocol::Error::invalid_params().data(format!("{context}: {e}"))
        })
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn finish_session_workspace_cleanup(
    agent_cleanup: anyhow::Result<()>,
    lease_cleanup: anyhow::Result<()>,
    agent_context: &str,
) -> Result<(), agent_client_protocol::Error> {
    agent_cleanup.internal_err_ctx(agent_context)?;
    lease_cleanup.internal_err_ctx("Failed to release CodePro workspace lease")?;
    Ok(())
}

pub(super) const DEFAULT_PROVIDER_ID: &str = "goose";
pub(super) const DEFAULT_PROVIDER_LABEL: &str = "Goose (Default)";
const PROVIDER_CONFIG_STATUS_CHECK_CONCURRENCY: usize = 16;
const CODEPRO_TURN_RETRY_META_KEY: &str = "codeagentpro/turn-retry";
const CODEPRO_SOURCE_MESSAGE_ID_META_KEY: &str = "codeagentpro/source-message-id";
const CODEPRO_CHECKPOINT_CONTEXT_META_KEY: &str = "codeagentpro/checkpoint-context";

fn product_metadata<'a>(meta: &'a Meta, key: &str) -> Option<&'a serde_json::Value> {
    meta.get(key).or_else(|| {
        key.strip_prefix("codeagentpro/")
            .and_then(|suffix| meta.get(&format!("codebuddy/{suffix}")))
    })
}

fn parse_codepro_checkpoint_context(
    meta: Option<&Meta>,
) -> Result<Option<crate::agents::CodeProCheckpointContext>> {
    let Some(value) =
        meta.and_then(|meta| product_metadata(meta, CODEPRO_CHECKPOINT_CONTEXT_META_KEY))
    else {
        return Ok(None);
    };
    let context: crate::agents::CodeProCheckpointContext = serde_json::from_value(value.clone())?;
    anyhow::ensure!(
        context.schema_version == 1
            && !context.checkpoint_id.trim().is_empty()
            && !context.source_run_id.trim().is_empty()
            && !context.source_user_message_id.trim().is_empty()
            && context
                .source_terminal_message_id
                .as_ref()
                .is_some_and(|id| !id.trim().is_empty()),
        "invalid CodePro checkpoint context"
    );
    Ok(Some(context))
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodeProTurnRetryMetadata {
    schema_version: u8,
    strategy: CodeProTurnRetryStrategy,
    checkpoint_id: Option<String>,
    source_run_id: String,
    source_user_message_id: String,
    source_terminal_message_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CodeProTurnRetryStrategy {
    ContinueCheckpoint,
    ResumeAfterWorkspace,
    ReplayUserRequest,
    RetryFailedValidation,
}

fn parse_codepro_turn_retry_metadata(
    meta: Option<&Meta>,
) -> Result<Option<CodeProTurnRetryMetadata>> {
    let Some(value) = meta.and_then(|meta| product_metadata(meta, CODEPRO_TURN_RETRY_META_KEY))
    else {
        return Ok(None);
    };
    let retry: CodeProTurnRetryMetadata = serde_json::from_value(value.clone())?;
    let valid_checkpoint = match retry.strategy {
        CodeProTurnRetryStrategy::ContinueCheckpoint => {
            retry
                .checkpoint_id
                .as_deref()
                .is_some_and(|checkpoint| !checkpoint.trim().is_empty())
                && retry.source_terminal_message_id.is_none()
        }
        CodeProTurnRetryStrategy::ResumeAfterWorkspace
        | CodeProTurnRetryStrategy::ReplayUserRequest => {
            retry.checkpoint_id.is_none() && retry.source_terminal_message_id.is_none()
        }
        CodeProTurnRetryStrategy::RetryFailedValidation => {
            retry.checkpoint_id.is_none()
                && retry
                    .source_terminal_message_id
                    .as_deref()
                    .is_some_and(|terminal_id| !terminal_id.trim().is_empty())
        }
    };
    if retry.schema_version != 1
        || !valid_checkpoint
        || retry.source_run_id.trim().is_empty()
        || retry.source_user_message_id.trim().is_empty()
    {
        anyhow::bail!("invalid CodePro retry metadata");
    }

    Ok(Some(retry))
}

fn codepro_resume_request_from_metadata(retry: CodeProTurnRetryMetadata) -> CodeProResumeRequest {
    CodeProResumeRequest {
        normalized_user_input: None,
        strategy: match retry.strategy {
            CodeProTurnRetryStrategy::ContinueCheckpoint => {
                crate::agents::CodeProRetryStrategy::ContinueCheckpoint
            }
            CodeProTurnRetryStrategy::ReplayUserRequest => {
                crate::agents::CodeProRetryStrategy::ReplayUserRequest
            }
            CodeProTurnRetryStrategy::ResumeAfterWorkspace => {
                crate::agents::CodeProRetryStrategy::ResumeAfterWorkspace
            }
            CodeProTurnRetryStrategy::RetryFailedValidation => {
                crate::agents::CodeProRetryStrategy::RetryFailedValidation
            }
        },
        checkpoint_id: retry.checkpoint_id,
        source_run_id: retry.source_run_id,
        source_user_message_id: retry.source_user_message_id,
        source_terminal_message_id: retry.source_terminal_message_id,
        approval: None,
    }
}

struct CodeProPromptRunIdentity {
    run_id: String,
    resume_existing: bool,
}

fn codepro_prompt_run_identity(
    retry: Option<&CodeProTurnRetryMetadata>,
) -> CodeProPromptRunIdentity {
    match retry {
        Some(CodeProTurnRetryMetadata {
            strategy:
                CodeProTurnRetryStrategy::ContinueCheckpoint
                | CodeProTurnRetryStrategy::ResumeAfterWorkspace,
            source_run_id,
            ..
        }) => CodeProPromptRunIdentity {
            run_id: source_run_id.clone(),
            resume_existing: true,
        },
        _ => CodeProPromptRunIdentity {
            run_id: format!("run_{}", Uuid::new_v4()),
            resume_existing: false,
        },
    }
}

fn parse_codepro_source_message_id(meta: Option<&Meta>) -> Result<Option<String>> {
    let Some(value) =
        meta.and_then(|meta| product_metadata(meta, CODEPRO_SOURCE_MESSAGE_ID_META_KEY))
    else {
        return Ok(None);
    };
    let source_message_id = value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("invalid CodePro source message id metadata"))?;
    Ok(Some(source_message_id.to_string()))
}

fn should_stream_message_to_acp_client(message: &Message) -> bool {
    message.is_user_visible()
        && (message.role != Role::User
            || message.metadata.steer
            || message
                .content
                .iter()
                .any(|content| matches!(content, MessageContent::ToolResponse(_))))
}

/// In-memory state for an active ACP session.
///
/// ## Terminology (temporary, until all clients migrate to ACP)
///
/// The ACP protocol uses "session" to mean the conversation as the human sees it —
/// a durable, append-only exchange of messages. Internally, goose also has a concept
/// called "Session" (the `sessions` DB table) which represents the agent's working
/// state: the message list the LLM sees, compaction state, provider binding, etc.
///
/// The ACP session ID maps directly to a `sessions` row. The `sessions` HashMap
/// below is keyed by session ID.
struct GooseAcpSession {
    agent: Arc<Agent>,
    session_type: SessionType,
    tool_requests: HashMap<String, crate::conversation::message::ToolRequest>,
    /// For each tool_call_id that belongs to a multi-tool chain (run of
    /// consecutive ToolRequest blocks within one assistant message), the chain
    /// it belongs to. Populated when the assistant message is processed.
    /// Used by `handle_tool_response` to detect when a chain has fully
    /// completed and fire a single LLM summary covering the run.
    chain_membership: HashMap<String, Arc<ToolChain>>,
    /// Set of tool_call_ids whose ToolResponse has already been processed.
    /// Drives the "all responses present" check for chain completion.
    responded_tool_ids: HashSet<String>,
    /// Tool_call_ids of chains that have already had a summary task fired.
    /// Idempotence guard so we summarize each chain at most once.
    summarized_chains: HashSet<String>,
}

struct ActivePromptRun {
    run_id: String,
    cancel_token: CancellationToken,
    stop_reason: ActivePromptStopReason,
    // A prompt may merely reference an old run while answering a question or
    // showing a checkpoint notice. Only successful execution admission sets this.
    durable_execution_bound: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ActivePromptStopReason {
    #[default]
    None,
    UserCancel,
    ControlPause,
    ControlEmergencyStop,
}

fn stop_active_run(
    active_runs: &mut HashMap<String, ActivePromptRun>,
    session_id: &str,
    expected_run_id: Option<&str>,
    reason: ActivePromptStopReason,
) -> bool {
    let Some(active_run) = active_runs.get_mut(session_id) else {
        return false;
    };
    if expected_run_id.is_some_and(|expected| active_run.run_id != expected) {
        return false;
    }
    active_run.stop_reason = reason;
    active_run.cancel_token.cancel();
    true
}

fn cancel_active_run(active_runs: &mut HashMap<String, ActivePromptRun>, session_id: &str) -> bool {
    stop_active_run(
        active_runs,
        session_id,
        None,
        ActivePromptStopReason::UserCancel,
    )
}

fn active_prompt_stop_reason(
    active_runs: &HashMap<String, ActivePromptRun>,
    session_id: &str,
    run_id: &str,
) -> ActivePromptStopReason {
    active_runs
        .get(session_id)
        .filter(|active_run| active_run.run_id == run_id)
        .map(|active_run| active_run.stop_reason)
        .unwrap_or_default()
}

fn take_active_run_stop_reason(
    active_runs: &mut HashMap<String, ActivePromptRun>,
    session_id: &str,
    run_id: &str,
) -> Option<ActivePromptStopReason> {
    if active_runs.get(session_id)?.run_id != run_id {
        return None;
    }
    active_runs
        .remove(session_id)
        .map(|active_run| active_run.stop_reason)
}

fn retarget_checkpoint_prompt(
    active_runs: &mut HashMap<String, ActivePromptRun>,
    session_id: &str,
    expected_run_id: &str,
    run_id: &str,
    finishing_cancellation: bool,
) -> bool {
    let Some(active) = active_runs.get_mut(session_id).filter(|active| {
        active.run_id == expected_run_id
            && (finishing_cancellation || !active.cancel_token.is_cancelled())
    }) else {
        return false;
    };
    active.run_id = run_id.to_string();
    true
}

pub struct GooseAcpAgentOptions {
    pub provider_factory: AcpProviderFactory,
    pub builtins: Vec<String>,
    pub data_dir: std::path::PathBuf,
    pub config_dir: std::path::PathBuf,
    pub disable_session_naming: bool,
    pub goose_platform: GoosePlatform,
    pub additional_source_roots: Vec<SourceRoot>,
    pub scheduler: Arc<dyn SchedulerTrait>,
}

pub struct GooseAcpAgent {
    sessions: Arc<Mutex<HashMap<String, GooseAcpSession>>>,
    computer_extension_transition: Arc<Mutex<()>>,
    active_prompt_runs: Arc<Mutex<HashMap<String, ActivePromptRun>>>,
    context_maintenance_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    checkpoint_cancellation_fences: Arc<Mutex<HashMap<String, String>>>,
    closed_session_ids: Arc<Mutex<HashSet<String>>>,
    agent_manager: Arc<AgentManager>,
    provider_factory: AcpProviderFactory,
    builtins: Vec<String>,
    client_fs_capabilities: OnceCell<FileSystemCapabilities>,
    client_terminal: OnceCell<bool>,
    client_mcp_host_info: OnceCell<GooseMcpHostInfo>,
    client_supports_acp_elicitation: OnceCell<bool>,
    client_supports_goose_custom_notifications: OnceCell<bool>,
    client_project_containers: OnceCell<bool>,
    client_workspace_confirmation_refresh: OnceCell<bool>,
    client_supports_recipe_param_requests: OnceCell<bool>,
    use_login_shell_path: OnceCell<bool>,
    client_cx: OnceCell<ConnectionTo<Client>>,
    config_dir: std::path::PathBuf,
    session_manager: Arc<SessionManager>,
    permission_manager: Arc<PermissionManager>,
    disable_session_naming: bool,
    provider_inventory: ProviderInventoryService,
    additional_source_roots: Vec<SourceRoot>,
    recipe_path_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
    onboarding_import_scans: Arc<Mutex<HashMap<String, onboarding::AuthorizedImportScan>>>,
    github_auth: Arc<GitHubAuthService>,
    github_issue_create_idempotency: Arc<ToolIdempotencyStore>,
    codepro_control: codepro_control::CodeProControlService,
    skill_management: crate::skills::management::SkillManagementService,
    memory_root: PathBuf,
    review_data_root: PathBuf,
    review_snapshots:
        Arc<Mutex<lru::LruCache<String, crate::agents::codepro_review::ReviewSnapshot>>>,
    review_runners: Arc<Mutex<HashMap<String, review::ReviewRuntime>>>,
}

/// Shorten a session/thread id for perf log correlation.
/// All `perf:` logs use `sid=<8-char-prefix>` so a single session's activity
/// can be extracted with `grep 'perf:' <log> | grep 'sid=abc12345'`.
pub(super) fn sid_short(id: &str) -> String {
    id.chars().take(8).collect()
}

fn meta_string(
    meta: Option<&Meta>,
    key: &str,
) -> Result<Option<String>, agent_client_protocol::Error> {
    let Some(value) = meta.and_then(|m| m.get(key)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(value) = value.as_str() else {
        return Err(
            agent_client_protocol::Error::invalid_params().data(format!("{key} must be a string"))
        );
    };
    Ok(Some(value.to_string()))
}

fn agent_capabilities_meta() -> Option<Meta> {
    let mut goose = serde_json::Map::new();
    if cfg!(feature = "local-inference") {
        goose.insert("localInference".to_string(), serde_json::json!({}));
    }

    #[cfg(target_os = "macos")]
    goose.insert("projectContainers".to_string(), serde_json::json!(1));
    #[cfg(any(windows, target_os = "macos"))]
    goose.insert(
        "workspaceConfirmationRefresh".to_string(),
        serde_json::json!(1),
    );
    if goose.is_empty() {
        return None;
    }

    let mut meta = serde_json::Map::new();
    meta.insert("goose".to_string(), serde_json::Value::Object(goose));
    Some(meta)
}

fn spawn_session_name_update_notifier(
    cx: ConnectionTo<Client>,
) -> tokio::sync::mpsc::UnboundedSender<crate::session::SessionNameUpdate> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<crate::session::SessionNameUpdate>();
    tokio::spawn(async move {
        while let Some(update) = rx.recv().await {
            let mut meta = serde_json::Map::new();
            meta.insert(
                "messageCount".to_string(),
                serde_json::Value::Number(update.message_count.into()),
            );
            meta.insert(
                "userSetName".to_string(),
                serde_json::Value::Bool(update.user_set_name),
            );
            let notification = SessionNotification::new(
                SessionId::new(update.session_id.clone()),
                SessionUpdate::SessionInfoUpdate(
                    SessionInfoUpdate::new()
                        .title(update.name)
                        .updated_at(update.updated_at.to_rfc3339())
                        .meta(meta),
                ),
            );
            if let Err(error) = cx.send_notification(notification) {
                warn!(
                    session_id = %update.session_id,
                    error = %error,
                    "Failed to send generated session name update"
                );
            }
        }
    });
    tx
}

fn extract_timeout_from_meta(meta: &Option<Meta>) -> Option<u64> {
    meta.as_ref()
        .and_then(|m| m.get("timeout"))
        .and_then(|v| v.as_u64())
}

#[derive(Debug, Default, Deserialize)]
struct ClientCapabilitiesMeta {
    #[serde(default)]
    goose: Option<GooseClientCapabilities>,
}

#[derive(Debug, Default, Deserialize)]
struct GooseClientCapabilities {
    #[serde(rename = "mcpHostCapabilities", default)]
    mcp_host_capabilities: Option<GooseMcpHostCapabilities>,
    #[serde(rename = "customNotifications", default)]
    custom_notifications: Option<bool>,
    #[serde(rename = "projectContainers", default)]
    project_containers: Option<u32>,
    #[serde(rename = "workspaceConfirmationRefresh", default)]
    workspace_confirmation_refresh: Option<u32>,
    #[serde(rename = "recipeParameterRequests", default)]
    recipe_parameter_requests: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct GooseMcpHostCapabilities {
    #[serde(default)]
    extensions: Option<rmcp::model::ExtensionCapabilities>,
}

fn extract_client_capabilities_meta(args: &InitializeRequest) -> Option<ClientCapabilitiesMeta> {
    args.client_capabilities
        .meta
        .as_ref()
        .and_then(|meta| serde_json::from_value(serde_json::Value::Object(meta.clone())).ok())
}

fn extract_client_mcp_host_info(
    args: &InitializeRequest,
    goose_client_capabilities: Option<&GooseClientCapabilities>,
) -> GooseMcpHostInfo {
    let host_capabilities =
        goose_client_capabilities.and_then(|goose| goose.mcp_host_capabilities.as_ref());
    let explicit_extensions = host_capabilities
        .as_ref()
        .and_then(|capabilities| capabilities.extensions.as_ref())
        .is_some();
    let extensions = host_capabilities
        .and_then(|capabilities| capabilities.extensions.clone())
        .unwrap_or_default();

    GooseMcpHostInfo {
        explicit_extensions,
        extensions,
        client_name: args.client_info.as_ref().map(|info| info.name.clone()),
        client_version: args.client_info.as_ref().map(|info| info.version.clone()),
    }
}

fn extract_use_login_shell_path(args: &InitializeRequest) -> bool {
    args.meta
        .as_ref()
        .and_then(|meta| meta.get("goose/useLoginShellPath"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn mcp_server_to_extension_config(mcp_server: McpServer) -> Result<ExtensionConfig, String> {
    match mcp_server {
        McpServer::Stdio(stdio) => {
            let timeout = extract_timeout_from_meta(&stdio.meta);
            Ok(ExtensionConfig::Stdio {
                name: stdio.name,
                description: String::new(),
                cmd: stdio.command.to_string_lossy().to_string(),
                args: stdio.args,
                envs: Envs::new(stdio.env.into_iter().map(|e| (e.name, e.value)).collect()),
                env_keys: vec![],
                timeout,
                cwd: None,
                bundled: Some(false),
                available_tools: vec![],
                read_only_tools: vec![],
            })
        }
        McpServer::Http(http) => {
            let timeout = extract_timeout_from_meta(&http.meta);
            Ok(ExtensionConfig::StreamableHttp {
                name: http.name,
                description: String::new(),
                uri: http.url,
                envs: Envs::default(),
                env_keys: vec![],
                headers: http
                    .headers
                    .into_iter()
                    .map(|h| (h.name, h.value))
                    .collect(),
                timeout,
                socket: None,
                bundled: Some(false),
                available_tools: vec![],
                read_only_tools: vec![],
            })
        }
        McpServer::Sse(_) => Err("SSE is unsupported, migrate to streamable_http".to_string()),
        _ => Err("Unknown MCP server type".to_string()),
    }
}

fn push_or_replace_extension(extensions: &mut Vec<ExtensionConfig>, extension: ExtensionConfig) {
    let name = extension.name().to_string();
    if let Some(index) = extensions
        .iter()
        .position(|existing| existing.name() == name)
    {
        extensions.remove(index);
    }
    extensions.push(extension);
}

fn ensure_provider_activation_supported(
    provider_id: &str,
) -> Result<(), agent_client_protocol::Error> {
    if let Some(reason) = crate::providers::activation_disabled_reason(provider_id) {
        return Err(agent_client_protocol::Error::invalid_params().data(reason));
    }
    Ok(())
}

fn resolve_default_provider_model_config(
    config: &Config,
) -> Result<(String, goose_providers::model::ModelConfig), agent_client_protocol::Error> {
    let resolved_provider = config.get_goose_provider().map_err(|error| {
        agent_client_protocol::Error::internal_error()
            .data(format!("Failed to resolve provider: {}", error))
    })?;
    ensure_provider_activation_supported(&resolved_provider)?;
    let resolved_model = config.get_goose_model().map_err(|error| {
        agent_client_protocol::Error::internal_error()
            .data(format!("Failed to resolve model: {}", error))
    })?;
    let resolved_model_config =
        crate::model_config::model_config_from_user_config(&resolved_provider, &resolved_model)
            .map_err(|error| {
                agent_client_protocol::Error::internal_error()
                    .data(format!("Failed to resolve model: {}", error))
            })?;
    Ok((resolved_provider, resolved_model_config))
}

async fn resolve_provider_default_model_config(
    provider_name: &str,
) -> Result<goose_providers::model::ModelConfig, agent_client_protocol::Error> {
    ensure_provider_activation_supported(provider_name)?;
    let entry = crate::providers::get_from_registry(provider_name)
        .await
        .map_err(|error| {
            agent_client_protocol::Error::invalid_params()
                .data(format!("Unknown provider '{}': {}", provider_name, error))
        })?;
    crate::model_config::model_config_from_user_config(
        provider_name,
        &entry.metadata().default_model,
    )
    .map_err(|error| {
        agent_client_protocol::Error::internal_error()
            .data(format!("Failed to resolve model: {}", error))
    })
}

fn read_resource_link(
    link: ResourceLink,
    authoritative_workspace: Option<&Path>,
) -> Result<Option<String>, agent_client_protocol::Error> {
    let url = Url::parse(&link.uri).ok();
    let Some(url) = url else {
        return Ok(None);
    };
    if url.scheme() == "file" {
        let workspace = authoritative_workspace.ok_or_else(|| {
            agent_client_protocol::Error::invalid_params()
                .data("file resource links require an authoritative writable workspace")
        })?;
        let path = url.to_file_path().map_err(|_| {
            agent_client_protocol::Error::invalid_params().data("invalid file resource link")
        })?;
        #[cfg(any(windows, target_os = "macos"))]
        let (canonical_path, contents) =
            workspace_lease::read_workspace_file_by_handle(workspace, &path).map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(error.to_string())
            })?;
        #[cfg(not(any(windows, target_os = "macos")))]
        let (canonical_path, contents) = {
            let canonical_workspace = workspace.canonicalize().map_err(|error| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("invalid authoritative workspace: {error}"))
            })?;
            let canonical_path = path.canonicalize().map_err(|_| {
                agent_client_protocol::Error::invalid_params()
                    .data("file resource link is unavailable")
            })?;
            if canonical_path == canonical_workspace
                || !canonical_path.starts_with(&canonical_workspace)
                || !canonical_path.is_file()
            {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("file resource link is outside the authoritative workspace"));
            }
            let contents = fs::read_to_string(&canonical_path).map_err(|error| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("failed to read file resource link: {error}"))
            })?;
            (canonical_path, contents)
        };

        Ok(Some(format!(
            "\n\n# {}\n```\n{}\n```",
            canonical_path.to_string_lossy(),
            contents
        )))
    } else {
        Ok(None)
    }
}

fn authoritative_resource_workspace(
    session: &Session,
) -> Result<Option<PathBuf>, agent_client_protocol::Error> {
    if session.session_type != SessionType::CodePro {
        return Ok(Some(session.working_dir.clone()));
    }
    let binding = CodeProWorkspaceBinding::from_extension_data_strict(&session.extension_data)
        .invalid_params_err_ctx("Invalid CodePro workspace binding")?;
    match binding {
        Some(CodeProWorkspaceBinding::WritableProject { path, .. })
            if Path::new(&path) == session.working_dir =>
        {
            Ok(Some(session.working_dir.clone()))
        }
        Some(CodeProWorkspaceBinding::WritableProject { .. }) => {
            Err(agent_client_protocol::Error::invalid_params()
                .data("CodePro workspace binding path does not match the persisted session cwd"))
        }
        _ => Ok(None),
    }
}

fn builtin_to_extension_config(name: &str) -> ExtensionConfig {
    if let Some(def) = PLATFORM_EXTENSIONS.get(name) {
        ExtensionConfig::Platform {
            name: def.name.into(),
            description: def.description.into(),
            display_name: Some(def.display_name.into()),
            bundled: Some(true),
            available_tools: vec![],
        }
    } else {
        ExtensionConfig::Builtin {
            name: name.into(),
            display_name: None,
            timeout: None,
            bundled: Some(true),
            description: name.into(),
            available_tools: vec![],
        }
    }
}

fn to_nonnegative_u64(value: Option<i32>) -> Option<u64> {
    value.and_then(|v| u64::try_from(v).ok())
}

fn build_prompt_usage(session: &Session) -> Option<Usage> {
    let total = to_nonnegative_u64(session.usage.total_tokens)?;
    let input = to_nonnegative_u64(session.usage.input_tokens).unwrap_or(0);
    let output = to_nonnegative_u64(session.usage.output_tokens).unwrap_or(0);
    Some(Usage::new(total, input, output))
}

pub(super) struct UsageUpdates {
    pub(super) custom: GooseSessionNotification,
    pub(super) standard: UsageUpdate,
}

pub(super) fn build_usage_updates(
    session: &Session,
    totals: &SessionUsageTotals,
) -> Option<UsageUpdates> {
    let used = to_nonnegative_u64(session.usage.total_tokens)?;
    let ctx_limit = session.model_config.as_ref()?.context_limit() as u64;
    let accumulated_input_tokens =
        to_nonnegative_u64(totals.accumulated_usage.input_tokens).unwrap_or(0);
    let accumulated_output_tokens =
        to_nonnegative_u64(totals.accumulated_usage.output_tokens).unwrap_or(0);
    Some(UsageUpdates {
        custom: GooseSessionNotification {
            session_id: session.id.clone(),
            update: GooseSessionUpdate::UsageUpdate(SessionUsageUpdate {
                used,
                context_limit: ctx_limit,
                accumulated_input_tokens,
                accumulated_output_tokens,
                accumulated_cost: totals.accumulated_cost,
            }),
        },
        standard: {
            let mut standard = UsageUpdate::new(used, ctx_limit);
            if let Some(amount) = totals.accumulated_cost {
                standard = standard.cost(Cost::new(amount, "USD"));
            }
            standard
        },
    })
}

pub(super) fn validate_absolute_cwd(cwd: &Path) -> Result<(), agent_client_protocol::Error> {
    if !cwd.is_absolute() {
        return Err(
            agent_client_protocol::Error::invalid_params().data("cwd must be an absolute path")
        );
    }

    if !cwd.exists() || !cwd.is_dir() {
        return Err(agent_client_protocol::Error::invalid_params().data("invalid directory path"));
    }

    Ok(())
}

fn ensure_required_session_extensions(
    session_type: &SessionType,
    extensions: &mut Vec<ExtensionConfig>,
) {
    ensure_required_session_extensions_with_project_memory(
        session_type,
        extensions,
        crate::agents::platform_extensions::project_memory::project_memory_enabled(),
    );
}

fn ensure_required_session_extensions_with_project_memory(
    session_type: &SessionType,
    extensions: &mut Vec<ExtensionConfig>,
    project_memory_enabled: bool,
) {
    if *session_type == SessionType::CodePro {
        if !extensions
            .iter()
            .any(|extension| extension.name() == "developer")
        {
            extensions.push(builtin_to_extension_config("developer"));
        }
        if !extensions
            .iter()
            .any(|extension| extension.name() == "codepromemory")
        {
            extensions.push(crate::agents::platform_extensions::codepro_memory::extension_config());
        }
    }
    if project_memory_enabled
        && !extensions
            .iter()
            .any(|extension| extension.name() == "projectmemory")
    {
        extensions.push(crate::agents::platform_extensions::project_memory::extension_config());
    }
}

fn session_allows_extension_activation(
    session_type: &SessionType,
    extension_data: &ExtensionData,
) -> bool {
    *session_type != SessionType::CodePro
        || matches!(
            CodeProWorkspaceBinding::from_extension_data_strict(extension_data),
            Ok(Some(CodeProWorkspaceBinding::WritableProject { .. }))
        )
}

fn retain_workspace_independent_codepro_extensions(
    extensions: Vec<ExtensionConfig>,
) -> Vec<ExtensionConfig> {
    extensions
        .into_iter()
        .filter(|extension| {
            matches!(
                extension,
                ExtensionConfig::Builtin { name, .. }
                    if name == "qwen_computer"
            )
        })
        .collect()
}

fn is_codepro_workspace_rebind(
    session_type: &SessionType,
    current_working_dir: &Path,
    requested_working_dir: &Path,
) -> bool {
    *session_type == SessionType::CodePro && current_working_dir != requested_working_dir
}

fn scope_standard_filesystem_extension_to_project(
    mut extension: ExtensionConfig,
    project_root: &Path,
) -> ExtensionConfig {
    let ExtensionConfig::Stdio { cmd, args, cwd, .. } = &mut extension else {
        return extension;
    };
    let identifies_filesystem_server = |value: &str| {
        value
            .replace('\\', "/")
            .to_ascii_lowercase()
            .contains("server-filesystem")
    };
    let project_root = project_root.to_string_lossy().into_owned();
    if identifies_filesystem_server(cmd) {
        args.clear();
        args.push(project_root.clone());
        *cwd = Some(project_root);
        return extension;
    }
    let Some(marker_index) = args
        .iter()
        .position(|argument| identifies_filesystem_server(argument))
    else {
        return extension;
    };
    args.truncate(marker_index + 1);
    args.push(project_root.clone());
    *cwd = Some(project_root);
    extension
}

fn required_session_extension_data(
    session_type: &SessionType,
    extension_data: &ExtensionData,
) -> Result<Option<ExtensionData>> {
    required_session_extension_data_with_project_memory(
        session_type,
        extension_data,
        crate::agents::platform_extensions::project_memory::project_memory_enabled(),
    )
}

fn required_session_extension_data_with_project_memory(
    session_type: &SessionType,
    extension_data: &ExtensionData,
    project_memory_enabled: bool,
) -> Result<Option<ExtensionData>> {
    if !session_allows_extension_activation(session_type, extension_data) {
        return Ok(None);
    }
    let Some(state) = EnabledExtensionsState::from_extension_data(extension_data) else {
        return Ok(None);
    };
    let mut extensions = state.extensions;
    let original_count = extensions.len();
    ensure_required_session_extensions_with_project_memory(
        session_type,
        &mut extensions,
        project_memory_enabled,
    );
    if extensions.len() == original_count {
        return Ok(None);
    }

    let mut upgraded = extension_data.clone();
    EnabledExtensionsState::new(extensions).to_extension_data(&mut upgraded)?;
    Ok(Some(upgraded))
}

impl GooseAcpAgent {
    pub fn permission_manager(&self) -> Arc<PermissionManager> {
        Arc::clone(&self.permission_manager)
    }

    pub(super) async fn acquire_session_dispatch_access(
        &self,
        session_id: &str,
        require_writable_workspace: bool,
    ) -> Result<SessionDispatchPermit, agent_client_protocol::Error> {
        self.session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {session_id}"))
            })?;
        #[cfg(any(windows, target_os = "macos"))]
        let _lifecycle_guard = workspace_lease::lock_session_lifecycle(session_id)
            .await
            .invalid_params_err_ctx("Session lifecycle access denied")?;
        #[cfg(any(windows, target_os = "macos"))]
        let lifecycle_permit = workspace_lease::acquire_session_access(session_id)
            .invalid_params_err_ctx("Session access denied")?;
        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {session_id}"))
            })?;
        if session.session_type != SessionType::CodePro {
            return Ok(SessionDispatchPermit {
                #[cfg(any(windows, target_os = "macos"))]
                _workspace: Some(lifecycle_permit),
            });
        }

        let binding = CodeProWorkspaceBinding::from_extension_data_strict(&session.extension_data)
            .invalid_params_err_ctx("Invalid CodePro workspace binding")?
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data("CodePro session has no authoritative workspace binding")
            })?;
        match binding {
            CodeProWorkspaceBinding::WritableProject { path, lease_id } => {
                if std::path::Path::new(&path) != session.working_dir {
                    return Err(agent_client_protocol::Error::invalid_params().data(
                        "CodePro workspace binding path does not match the persisted session cwd",
                    ));
                }
                #[cfg(any(windows, target_os = "macos"))]
                {
                    let acquired_here =
                        !workspace_lease::session_has_workspace_lease(session_id)
                            .invalid_params_err_ctx("Invalid CodePro workspace lease")?;
                    let authoritative_lease_id = if acquired_here {
                        workspace_lease::reacquire_existing_session_workspace_lease(
                            session_id,
                            &session.working_dir,
                        )
                    } else {
                        workspace_lease::validated_session_workspace_lease_id(
                            session_id,
                            &session.working_dir,
                        )
                    }
                    .invalid_params_err_ctx("Invalid CodePro workspace lease")?;
                    if lease_id != authoritative_lease_id {
                        if let Err(error) = self
                            .session_manager
                            .refresh_workspace_binding_lease(
                                session_id,
                                &path,
                                &lease_id,
                                &authoritative_lease_id,
                            )
                            .await
                        {
                            if acquired_here {
                                let _ =
                                    workspace_lease::release_session_workspace_lease(session_id);
                            }
                            return Err(agent_client_protocol::Error::internal_error().data(
                                format!(
                                "Failed to persist refreshed CodePro workspace binding: {error}"
                            ),
                            ));
                        }
                    }
                    workspace_lease::validate_session_workspace_binding(
                        session_id,
                        &session.working_dir,
                        &authoritative_lease_id,
                    )
                    .invalid_params_err_ctx("Invalid CodePro workspace lease")?;
                }
                #[cfg(not(any(windows, target_os = "macos")))]
                {
                    let _ = lease_id;
                    return Err(agent_client_protocol::Error::invalid_params().data(
                        "CodePro writable access requires an authoritative workspace lease",
                    ));
                }
            }
            _ if require_writable_workspace => {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("CodePro extension access requires a writable project binding"));
            }
            _ => {}
        }
        Ok(SessionDispatchPermit {
            #[cfg(any(windows, target_os = "macos"))]
            _workspace: Some(lifecycle_permit),
        })
    }

    pub(super) fn supports_goose_custom_notifications(&self) -> bool {
        self.client_supports_goose_custom_notifications
            .get()
            .copied()
            .unwrap_or(false)
    }

    pub(super) async fn notify_session_setup(
        &self,
        cx: &ConnectionTo<Client>,
        session: &Session,
    ) -> Result<(), agent_client_protocol::Error> {
        let totals = self
            .session_manager
            .get_session_usage_totals(&session.id)
            .await
            .unwrap_or_default();
        send_session_setup_notifications(
            cx,
            session,
            &totals,
            self.supports_goose_custom_notifications(),
        )
    }

    pub(super) fn supports_recipe_param_requests(&self) -> bool {
        self.client_supports_recipe_param_requests
            .get()
            .copied()
            .unwrap_or(false)
    }

    fn supports_acp_elicitation(&self) -> bool {
        self.client_supports_acp_elicitation
            .get()
            .copied()
            .unwrap_or(false)
    }

    pub async fn new(options: GooseAcpAgentOptions) -> Result<Self> {
        #[cfg(windows)]
        if let Err(error) = workspace_lease::reconcile_cleanup_quarantine_journal_once() {
            error!(%error, "cleanup recovery is pending explicit user attention");
        }
        let memory_root = options.data_dir.join("memory");
        let review_data_root = options.data_dir.clone();
        let codepro_control = codepro_control::CodeProControlService::new(
            options.data_dir.join("runs").join("control-plane"),
            options.data_dir.join("audit"),
        )
        .await?;
        let codepro_runtime = codepro_control.runtime();
        let session_manager = Arc::new(SessionManager::new(options.data_dir));

        // Eagerly initialize session storage so it's ready when providers/sessions need it.
        let storage_clone = session_manager.storage().clone();
        tokio::spawn(async move {
            let _ = storage_clone.initialize().await;
        });

        let permission_manager = Arc::new(PermissionManager::new(options.config_dir.clone()));
        let provider_inventory = ProviderInventoryService::new(session_manager.storage().clone());
        let agent_config = AgentConfig::new(
            Arc::clone(&session_manager),
            Arc::clone(&permission_manager),
            Some(options.scheduler),
            Config::global().get_goose_mode().unwrap_or_default(),
            options.disable_session_naming,
            options.goose_platform.clone(),
        )
        .with_codepro_runtime(codepro_runtime)
        .with_continuation_workspace_verifier({
            let owner = codepro_control.clone();
            Arc::new(move |session, current, source, workspace| {
                owner.verify_continuation_workspaces(session, current, source, workspace)?;
                Ok(())
            })
        })
        .with_model_router_provider_factory(Arc::clone(&options.provider_factory));
        let agent_manager = Arc::new(AgentManager::new(agent_config, None).await?);
        let github_auth = Arc::new(GitHubAuthService::production()?);
        let github_issue_create_idempotency = Arc::new(ToolIdempotencyStore::new(
            session_manager
                .data_dir()
                .join("github-issue-create-idempotency-v1"),
        ));

        Ok(Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            computer_extension_transition: Arc::new(Mutex::new(())),
            active_prompt_runs: Arc::new(Mutex::new(HashMap::new())),
            context_maintenance_locks: Arc::new(Mutex::new(HashMap::new())),
            checkpoint_cancellation_fences: Arc::new(Mutex::new(HashMap::new())),
            closed_session_ids: Arc::new(Mutex::new(HashSet::new())),
            agent_manager,
            provider_factory: options.provider_factory,
            builtins: options.builtins,
            client_fs_capabilities: OnceCell::new(),
            client_terminal: OnceCell::new(),
            client_mcp_host_info: OnceCell::new(),
            client_supports_acp_elicitation: OnceCell::new(),
            client_supports_goose_custom_notifications: OnceCell::new(),
            client_project_containers: OnceCell::new(),
            client_workspace_confirmation_refresh: OnceCell::new(),
            client_supports_recipe_param_requests: OnceCell::new(),
            use_login_shell_path: OnceCell::new(),
            client_cx: OnceCell::new(),
            config_dir: options.config_dir,
            session_manager,
            permission_manager,
            disable_session_naming: options.disable_session_naming,
            provider_inventory,
            additional_source_roots: options.additional_source_roots,
            recipe_path_cache: Arc::new(Mutex::new(HashMap::new())),
            onboarding_import_scans: Arc::new(Mutex::new(HashMap::new())),
            github_auth,
            github_issue_create_idempotency,
            codepro_control,
            skill_management: crate::skills::management::SkillManagementService::default(),
            memory_root,
            review_data_root,
            review_snapshots: Arc::new(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(64).expect("review snapshot cache capacity"),
            ))),
            review_runners: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn config(&self) -> Result<&'static Config, agent_client_protocol::Error> {
        Ok(Config::global())
    }

    async fn create_provider(
        &self,
        provider_name: &str,
        extensions: Vec<ExtensionConfig>,
        working_dir: Option<PathBuf>,
    ) -> Result<Arc<dyn Provider>> {
        if let Some(reason) = crate::providers::activation_disabled_reason(provider_name) {
            anyhow::bail!(reason);
        }
        (self.provider_factory)(provider_name.to_string(), extensions, working_dir).await
    }

    async fn maybe_refresh_provider_inventory_with_agent(
        &self,
        goose_session: &Session,
        agent: &Arc<Agent>,
    ) {
        let Some(provider_name) = goose_session.provider_name.as_deref() else {
            return;
        };
        let Some(mut inventory) = self
            .provider_inventory
            .find_entry_for_provider(provider_name)
            .await
        else {
            return;
        };
        if !should_refresh_inventory_for_session_init(&inventory) {
            return;
        }
        let provider = match agent.provider().await {
            Ok(provider) => provider,
            Err(error) => {
                warn!(
                    provider = %provider_name,
                    session = %goose_session.id,
                    error = %error,
                    "agent has no provider available for inventory refresh"
                );
                return;
            }
        };
        self.provider_inventory
            .refresh_with_provider(provider_name, &provider, &mut inventory, "session init")
            .await;
    }

    async fn get_or_create_session_agent_with_results(
        &self,
        cx: &ConnectionTo<Client>,
        session_id: String,
    ) -> Result<AgentManagerGetResult, agent_client_protocol::Error> {
        self.agent_manager
            .get_or_create_agent_with_runtime_context(
                session_id,
                RuntimeContext {
                    mcp_host_info: self.client_mcp_host_info.get().cloned(),
                    use_login_shell_path: self.use_login_shell_path.get().copied(),
                    session_name_update_tx: (!self.disable_session_naming)
                        .then(|| spawn_session_name_update_notifier(cx.clone())),
                },
            )
            .await
            .internal_err_ctx("Failed to create agent")
    }

    fn initial_session_extensions(
        &self,
        config: &Config,
        project_root: &Path,
        mcp_servers: Vec<McpServer>,
        goose_extensions: Option<Vec<GooseExtension>>,
        recipe_extensions: Option<&[ExtensionConfig]>,
    ) -> Result<Vec<ExtensionConfig>, agent_client_protocol::Error> {
        let mut extensions = Vec::new();
        for builtin in &self.builtins {
            push_or_replace_extension(&mut extensions, builtin_to_extension_config(builtin));
        }

        if let Some(recipe_extensions) = recipe_extensions {
            for extension in recipe_extensions {
                push_or_replace_extension(&mut extensions, extension.clone());
            }
        } else if let Some(goose_extensions) = goose_extensions {
            for extension in extensions::goose_extensions_to_configs(goose_extensions)? {
                push_or_replace_extension(&mut extensions, extension);
            }
        } else if mcp_servers.is_empty() {
            for extension in get_enabled_extensions_with_config(config) {
                push_or_replace_extension(&mut extensions, extension);
            }
            for extension in
                crate::plugins::mcp_servers::enabled_plugin_mcp_servers(Some(project_root))
            {
                push_or_replace_extension(&mut extensions, extension);
            }
        } else {
            for mcp_server in mcp_servers {
                let extension = mcp_server_to_extension_config(mcp_server).map_err(|message| {
                    agent_client_protocol::Error::invalid_params().data(message)
                })?;
                push_or_replace_extension(&mut extensions, extension);
            }
        }

        Ok(extensions)
    }

    async fn apply_acp_extension_overrides(
        &self,
        cx: &ConnectionTo<Client>,
        agent: &Arc<Agent>,
        session: &Session,
    ) {
        let client_fs_capabilities = self
            .client_fs_capabilities
            .get()
            .cloned()
            .unwrap_or_default();
        let client_terminal = self.client_terminal.get().copied().unwrap_or(false);
        if !client_fs_capabilities.read_text_file
            && !client_fs_capabilities.write_text_file
            && !client_terminal
        {
            return;
        }

        if !agent
            .extension_manager
            .is_extension_enabled("developer")
            .await
        {
            return;
        }

        let context = agent.extension_manager.get_context().clone();
        let dev_client = match DeveloperClient::new(context) {
            Ok(dev_client) => dev_client,
            Err(error) => {
                warn!(error = %error, "Failed to create ACP developer client");
                return;
            }
        };

        let session_id = SessionId::new(session.id.clone());
        let client: Arc<dyn McpClientTrait> = Arc::new(AcpTools {
            inner: Arc::new(dev_client),
            cx: cx.clone(),
            session_id: session_id.clone(),
            tool_call_notifier: ToolCallNotifier::new(cx, &session_id),
            fs_read: client_fs_capabilities.read_text_file,
            fs_write: client_fs_capabilities.write_text_file,
            terminal: client_terminal,
        });
        let info = client.get_info().cloned();

        let developer_config = agent
            .extension_manager
            .get_extension_configs()
            .await
            .into_iter()
            .find(|extension| extension.name() == "developer")
            .unwrap_or_else(|| builtin_to_extension_config("developer"));

        agent
            .extension_manager
            .add_client("developer".into(), developer_config, client, info, None)
            .await;
    }

    async fn prepare_acp_session_agent(
        &self,
        cx: &ConnectionTo<Client>,
        session: &Session,
    ) -> Result<(Arc<Agent>, Vec<ExtensionLoadResult>), agent_client_protocol::Error> {
        let agent_result = self
            .get_or_create_session_agent_with_results(cx, session.id.clone())
            .await?;
        let agent = agent_result.agent.clone();
        self.apply_acp_extension_overrides(cx, &agent, session)
            .await;
        self.maybe_refresh_provider_inventory_with_agent(session, &agent)
            .await;

        Ok((agent, agent_result.extension_results))
    }

    async fn prepare_session_for_activation(
        &self,
        mut session: Session,
        cwd: std::path::PathBuf,
        mcp_servers: Vec<McpServer>,
        include_messages_on_reload: bool,
    ) -> Result<Session, agent_client_protocol::Error> {
        let config = Config::global();
        if let Some(provider_name) = session.provider_name.as_deref() {
            ensure_provider_activation_supported(provider_name)?;
        }
        let allows_extension_activation =
            session_allows_extension_activation(&session.session_type, &session.extension_data);
        let codepro_workspace_rebind =
            is_codepro_workspace_rebind(&session.session_type, &session.working_dir, &cwd);
        if session.session_type == SessionType::CodePro && cwd != session.working_dir {
            let binding =
                CodeProWorkspaceBinding::from_extension_data_strict(&session.extension_data)
                    .invalid_params_err_ctx("Invalid CodePro workspace binding")?;
            let authorized_rebind = matches!(
                binding,
                Some(CodeProWorkspaceBinding::WritableProject { path, .. })
                    if Path::new(&path) == cwd
            );
            if !authorized_rebind {
                return Err(agent_client_protocol::Error::invalid_params()
                    .data("cwd cannot override the persisted CodePro workspace"));
            }
        }
        let mut builder = self.session_manager.update(&session.id);
        let mut session_needs_update = false;

        if cwd != session.working_dir {
            builder = builder.working_dir(cwd.clone());
            session_needs_update = true;
        }

        if session.provider_name.is_none() || session.model_config.is_none() {
            let (resolved_provider, resolved_model_config) =
                resolve_default_provider_model_config(config)?;
            builder = builder
                .provider_name(resolved_provider)
                .model_config(resolved_model_config);
            session_needs_update = true;
        }

        if !allows_extension_activation {
            let extension_data = self.build_enabled_extensions_data(
                config,
                &session,
                Vec::new(),
                None,
                None,
                false,
            )?;
            builder = builder.extension_data(extension_data);
            session_needs_update = true;
        } else if codepro_workspace_rebind
            || !mcp_servers.is_empty()
            || EnabledExtensionsState::from_extension_data(&session.extension_data).is_none()
        {
            let mut activation_session = session.clone();
            activation_session.working_dir = cwd.clone();
            let extension_data = self.build_enabled_extensions_data(
                config,
                &activation_session,
                mcp_servers,
                None,
                None,
                true,
            )?;
            builder = builder.extension_data(extension_data);
            session_needs_update = true;
        } else if let Some(extension_data) =
            required_session_extension_data(&session.session_type, &session.extension_data)
                .internal_err_ctx("Failed to add required session extensions")?
        {
            builder = builder.extension_data(extension_data);
            session_needs_update = true;
        }

        if session_needs_update {
            let session_id = session.id.clone();
            builder
                .apply()
                .await
                .internal_err_ctx("Failed to update session")?;

            self.agent_manager
                .remove_session_if_loaded(&session_id)
                .await
                .internal_err_ctx("Failed to remove in-memory agent")?;

            session = self
                .session_manager
                .get_session(&session_id, include_messages_on_reload)
                .await
                .internal_err_ctx("Failed to reload session")?;
        }

        Ok(session)
    }

    fn build_enabled_extensions_data(
        &self,
        config: &Config,
        session: &Session,
        mcp_servers: Vec<McpServer>,
        goose_extensions: Option<Vec<GooseExtension>>,
        recipe_extensions: Option<&[ExtensionConfig]>,
        allow_extensions: bool,
    ) -> Result<ExtensionData, agent_client_protocol::Error> {
        if !allow_extensions {
            let extensions = self.initial_session_extensions(
                config,
                &session.working_dir,
                Vec::new(),
                goose_extensions,
                None,
            )?;
            let extensions = retain_workspace_independent_codepro_extensions(extensions);
            let mut extension_data = session.extension_data.clone();
            EnabledExtensionsState::new(extensions)
                .to_extension_data(&mut extension_data)
                .internal_err_ctx(
                    "Failed to initialize workspace-independent session extensions",
                )?;
            return Ok(extension_data);
        }
        let mut extensions = self.initial_session_extensions(
            config,
            &session.working_dir,
            mcp_servers,
            goose_extensions,
            recipe_extensions,
        )?;
        if session.session_type == SessionType::CodePro {
            extensions = extensions
                .into_iter()
                .map(|extension| {
                    scope_standard_filesystem_extension_to_project(extension, &session.working_dir)
                })
                .collect();
        }
        ensure_required_session_extensions(&session.session_type, &mut extensions);
        let mut extension_data = session.extension_data.clone();
        EnabledExtensionsState::new(extensions)
            .to_extension_data(&mut extension_data)
            .internal_err_ctx("Failed to initialize session extensions")?;
        Ok(extension_data)
    }

    async fn register_acp_session(
        &self,
        session_id: String,
        session_type: SessionType,
        agent: Arc<Agent>,
        tool_requests: HashMap<String, ToolRequest>,
    ) {
        let acp_session = GooseAcpSession {
            agent,
            session_type,
            tool_requests,
            chain_membership: HashMap::new(),
            responded_tool_ids: HashSet::new(),
            summarized_chains: HashSet::new(),
        };
        self.sessions.lock().await.insert(session_id, acp_session);
    }

    async fn activate_acp_session(
        &self,
        cx: &ConnectionTo<Client>,
        session: &Session,
        tool_requests: HashMap<String, ToolRequest>,
    ) -> Result<(Arc<Agent>, Vec<ExtensionLoadResult>), agent_client_protocol::Error> {
        let (agent, extension_results) = self.prepare_acp_session_agent(cx, session).await?;
        self.register_acp_session(
            session.id.clone(),
            session.session_type,
            agent.clone(),
            tool_requests,
        )
        .await;

        Ok((agent, extension_results))
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }

    /// Convert ACP prompt content blocks into a user message.
    fn convert_acp_turn_prompt_to_message(
        prompt: &[ContentBlock],
        authoritative_workspace: Option<&Path>,
        session_type: SessionType,
        turn_retry: Option<&CodeProTurnRetryMetadata>,
    ) -> Result<Message, agent_client_protocol::Error> {
        if prompt.is_empty()
            && session_type == SessionType::CodePro
            && turn_retry.is_some_and(|retry| {
                retry.strategy == CodeProTurnRetryStrategy::ResumeAfterWorkspace
            })
        {
            // The agent validates the resume context and restores the persisted
            // source message. Do not invent or persist a second user request.
            return Ok(Message::user());
        }
        Self::convert_acp_prompt_to_message(prompt, authoritative_workspace)
    }

    fn convert_acp_prompt_to_message(
        prompt: &[ContentBlock],
        authoritative_workspace: Option<&Path>,
    ) -> Result<Message, agent_client_protocol::Error> {
        for block in prompt {
            if let ContentBlock::Image(image) = block {
                crate::prompt_attachments::validate_image_attachment(&image.data, &image.mime_type)
                    .map_err(|error| {
                        agent_client_protocol::Error::invalid_params().data(error.to_string())
                    })?;
            }
        }
        let mut message = Message::user();
        for block in prompt {
            match block {
                ContentBlock::Text(text) => {
                    let annotated = if let Some(ref ann) = text.annotations {
                        let audience: Vec<Role> = ann
                            .audience
                            .as_ref()
                            .map(|roles| {
                                roles
                                    .iter()
                                    .filter_map(|r| match r {
                                        agent_client_protocol::schema::v1::Role::Assistant => {
                                            Some(Role::Assistant)
                                        }
                                        agent_client_protocol::schema::v1::Role::User => {
                                            Some(Role::User)
                                        }
                                        _ => None,
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let raw = RawTextContent {
                            text: sanitize_unicode_tags(&text.text),
                            meta: None,
                        };
                        if audience.is_empty() {
                            raw.no_annotation()
                        } else {
                            raw.no_annotation().with_audience(audience)
                        }
                    } else {
                        // No annotations — regular user text.
                        let sanitized = sanitize_unicode_tags(&text.text);
                        RawTextContent {
                            text: sanitized,
                            meta: None,
                        }
                        .no_annotation()
                    };
                    message = message.with_content(MessageContent::Text(annotated));
                }
                ContentBlock::Image(image) => {
                    message = message.with_image(&image.data, &image.mime_type);
                }
                ContentBlock::Resource(resource) => {
                    if let EmbeddedResourceResource::TextResourceContents(text_resource) =
                        &resource.resource
                    {
                        let header = format!("--- Resource: {} ---\n", text_resource.uri);
                        let content = format!("{}{}\n---\n", header, text_resource.text);
                        message = message.with_text(&content);
                    }
                }
                ContentBlock::ResourceLink(link) => {
                    if let Some(text) = read_resource_link(link.clone(), authoritative_workspace)? {
                        message = message.with_text(text);
                    }
                }
                ContentBlock::Audio(..) | _ => (),
            }
        }
        let visible = message.agent_visible_content();
        if visible.as_concat_text().trim().is_empty()
            && crate::prompt_attachments::validated_image_count(&visible).map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(error.to_string())
            })? == 0
        {
            return Err(
                agent_client_protocol::Error::invalid_params().data("prompt must not be empty")
            );
        }
        Ok(message)
    }

    #[allow(clippy::too_many_arguments)]
    async fn handle_message_content(
        &self,
        content_item: &MessageContent,
        session_id: &SessionId,
        session_id_str: &str,
        message_id: Option<&str>,
        message_created: i64,
        role: &Role,
        steer: bool,
        stream_timing: Option<&goose_providers::request_log::StreamTiming>,
        agent: &Arc<Agent>,
        session: &mut GooseAcpSession,
        cx: &ConnectionTo<Client>,
    ) -> Result<(), agent_client_protocol::Error> {
        match content_item {
            MessageContent::Text(text) => {
                let chunk =
                    ContentChunk::new(ContentBlock::Text(TextContent::new(text.text.clone())))
                        .meta(with_stream_timing(
                            message_update_meta(message_id, message_created, steer),
                            stream_timing,
                        ));
                let update = match role {
                    Role::User => SessionUpdate::UserMessageChunk(chunk),
                    Role::Assistant => SessionUpdate::AgentMessageChunk(chunk),
                };
                cx.send_notification(SessionNotification::new(session_id.clone(), update))?;
            }
            MessageContent::ToolRequest(tool_request) => {
                self.handle_tool_request(
                    tool_request,
                    session_id,
                    session_id_str,
                    message_id,
                    stream_timing,
                    session,
                    cx,
                )
                .await?;
            }
            MessageContent::ToolResponse(tool_response) => {
                self.handle_tool_response(
                    tool_response,
                    session_id,
                    session_id_str,
                    message_id,
                    session,
                    cx,
                )
                .await?;
            }
            MessageContent::Thinking(thinking) => {
                cx.send_notification(SessionNotification::new(
                    session_id.clone(),
                    SessionUpdate::AgentThoughtChunk(
                        ContentChunk::new(ContentBlock::Text(TextContent::new(
                            thinking.thinking.clone(),
                        )))
                        .meta(with_stream_timing(
                            message_update_meta(message_id, message_created, steer),
                            stream_timing,
                        )),
                    ),
                ))?;
            }
            MessageContent::ActionRequired(action_required) => match &action_required.data {
                ActionRequiredData::ToolConfirmation {
                    id,
                    tool_name,
                    arguments,
                    prompt,
                    permission_class,
                    extension_source,
                    authorization_scope,
                    task_workspace_root,
                } => {
                    self.handle_tool_permission_request(
                        cx,
                        agent,
                        session_id,
                        id.clone(),
                        tool_name.clone(),
                        arguments.clone(),
                        prompt.clone(),
                        *permission_class,
                        *extension_source,
                        *authorization_scope,
                        task_workspace_root.clone(),
                    )?;
                }
                ActionRequiredData::Elicitation {
                    id,
                    message,
                    requested_schema,
                } => {
                    self.handle_form_elicitation(
                        cx,
                        session_id,
                        id,
                        message,
                        requested_schema,
                        message_update_meta(message_id, message_created, false),
                    )
                    .await?;
                }
                ActionRequiredData::ElicitationResponse { .. } => {}
            },
            MessageContent::Image(image) => {
                let mut image_content =
                    ImageContent::new(image.data.clone(), image.mime_type.clone());
                if let Some(audience) = image.audience() {
                    image_content = image_content.annotations(
                        Annotations::new().audience(
                            audience
                                .iter()
                                .map(|r| match r {
                                    Role::Assistant => {
                                        agent_client_protocol::schema::v1::Role::Assistant
                                    }
                                    Role::User => agent_client_protocol::schema::v1::Role::User,
                                })
                                .collect::<Vec<_>>(),
                        ),
                    );
                }
                let chunk = ContentChunk::new(ContentBlock::Image(image_content))
                    .meta(message_update_meta(message_id, message_created, steer));
                let update = match role {
                    Role::User => SessionUpdate::UserMessageChunk(chunk),
                    Role::Assistant => SessionUpdate::AgentMessageChunk(chunk),
                };
                cx.send_notification(SessionNotification::new(session_id.clone(), update))?;
            }
            MessageContent::SystemNotification(notification) => {
                send_status_message_update(
                    cx,
                    self.supports_goose_custom_notifications(),
                    session_id.0.as_ref(),
                    notification,
                    stream_timing,
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // ACP identity and timing belong to this dispatch boundary.
    async fn handle_tool_request(
        &self,
        tool_request: &crate::conversation::message::ToolRequest,
        session_id: &SessionId,
        session_id_for_persist: &str,
        message_id: Option<&str>,
        stream_timing: Option<&goose_providers::request_log::StreamTiming>,
        session: &mut GooseAcpSession,
        cx: &ConnectionTo<Client>,
    ) -> Result<(), agent_client_protocol::Error> {
        session
            .tool_requests
            .insert(tool_request.id.clone(), tool_request.clone());

        let pending_tool_call = pending_tool_call_from_request(tool_request);
        let initial_tool_call = pending_tool_call.tool_call.meta(with_stream_timing(
            pending_tool_call.identity_meta.clone(),
            stream_timing,
        ));
        let tool_call_notifier = ToolCallNotifier::new(cx, session_id);
        tool_call_notifier.send_initial(initial_tool_call)?;

        // CodePro renders deterministic action names and the Main Agent writes
        // public explanations. Cosmetic model calls must not compete with it.
        if session.session_type == SessionType::CodePro
            || Config::global()
                .get_goose_disable_tool_call_summary()
                .unwrap_or(false)
        {
            return Ok(());
        }

        if let Ok(tool_call) = &tool_request.tool_call {
            ToolTitleEnrichmentContext::new(
                &session.agent,
                session_id,
                &tool_call_notifier,
                &self.session_manager,
                session_id_for_persist,
                message_id,
            )
            .spawn_title_enrichment(
                tool_request.id.clone(),
                tool_call,
                pending_tool_call.identity_meta.clone(),
                pending_tool_call.fallback_title.clone(),
            );
        }

        Ok(())
    }

    async fn handle_tool_response(
        &self,
        tool_response: &ToolResponse,
        session_id: &SessionId,
        session_id_str: &str,
        message_id: Option<&str>,
        session: &mut GooseAcpSession,
        cx: &ConnectionTo<Client>,
    ) -> Result<(), agent_client_protocol::Error> {
        let fields = tool_call_update_fields_from_response(
            tool_response,
            session.tool_requests.get(&tool_response.id),
        );

        let update = ToolCallUpdate::new(ToolCallId::new(tool_response.id.clone()), fields)
            .meta(extract_tool_call_update_meta(tool_response));
        let tool_call_notifier = ToolCallNotifier::new(cx, session_id);
        tool_call_notifier.send_update(update)?;

        // Chain summarization: when this response completes a multi-tool
        // chain, fire one LLM summary covering the run.
        session.responded_tool_ids.insert(tool_response.id.clone());
        self.maybe_summarize_chain(
            &tool_response.id,
            session_id,
            session_id_str,
            session,
            &tool_call_notifier,
        );
        let _ = message_id;

        Ok(())
    }

    /// If `tool_call_id` belongs to a multi-tool chain and every step in that
    /// chain has now had its response processed, spawn a single LLM
    /// summarization task that persists the chain summary on the first tool
    /// request and notifies the client. Idempotent — fires at most once per
    /// chain.
    fn maybe_summarize_chain(
        &self,
        tool_call_id: &str,
        session_id: &SessionId,
        _session_id_str: &str,
        session: &mut GooseAcpSession,
        tool_call_notifier: &ToolCallNotifier,
    ) {
        if session.session_type == SessionType::CodePro {
            return;
        }
        let Some(chain) = session.chain_membership.get(tool_call_id).cloned() else {
            warn!(
                "tool chain summary: skipped — no chain registered for tool_call_id {tool_call_id}",
            );
            return;
        };
        if !chain
            .ids
            .iter()
            .all(|id| session.responded_tool_ids.contains(id))
        {
            let total = chain.ids.len();
            let responded = chain
                .ids
                .iter()
                .filter(|id| session.responded_tool_ids.contains(*id))
                .count();
            let missing: Vec<&String> = chain
                .ids
                .iter()
                .filter(|id| !session.responded_tool_ids.contains(*id))
                .collect();
            warn!(
                "tool chain summary: waiting on {pending}/{total} responses for chain anchored at {anchor:?} (missing: {missing:?})",
                pending = total - responded,
                anchor = chain.ids.first(),
            );
            return;
        }
        let Some(first_id) = chain.ids.first() else {
            warn!("tool chain summary: skipped — empty chain.ids for tool_call_id {tool_call_id}");
            return;
        };
        if !session.summarized_chains.insert(first_id.clone()) {
            debug!("tool chain summary: chain anchored at {first_id} already summarized; skipping");
            return;
        }

        // Snapshot (name, args_json) for each step in document order.
        let steps: Vec<(String, String)> = chain
            .ids
            .iter()
            .filter_map(|id| {
                let req = session.tool_requests.get(id)?;
                let tool_call = req.tool_call.as_ref().ok()?;
                let name = tool_call.name.to_string();
                let args = tool_call
                    .arguments
                    .as_ref()
                    .map(|a| serde_json::to_string(a).unwrap_or_default())
                    .unwrap_or_default();
                let args = if args.len() > 200 {
                    format!("{}…", crate::utils::safe_truncate(&args, 200))
                } else {
                    args
                };
                Some((name, args))
            })
            .collect();
        if steps.len() < 2 {
            return;
        }

        let identity_meta = session
            .tool_requests
            .get(first_id)
            .and_then(tool_call_identity_meta);

        ChainSummaryEnrichmentContext::new(
            &session.agent,
            session_id,
            tool_call_notifier,
            &self.session_manager,
        )
        .spawn_chain_summary(
            first_id.clone(),
            chain.message_id.clone(),
            steps,
            identity_meta,
            chain.ids.len(),
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_tool_permission_request(
        &self,
        cx: &ConnectionTo<Client>,
        agent: &Arc<Agent>,
        session_id: &SessionId,
        request_id: String,
        tool_name: String,
        arguments: serde_json::Map<String, serde_json::Value>,
        prompt: Option<String>,
        permission_class: Option<ToolPermissionClass>,
        extension_source: Option<ToolExtensionSource>,
        authorization_scope: Option<ToolAuthorizationScope>,
        task_workspace_root: Option<String>,
    ) -> Result<(), agent_client_protocol::Error> {
        let cx = cx.clone();
        let agent = agent.clone();
        let session_id = session_id.clone();

        let tool_call_update =
            permission_tool_call_update(request_id.clone(), tool_name.clone(), arguments, prompt);

        let options = permission_options_for_context(permission_class, authorization_scope);

        let permission_request =
            RequestPermissionRequest::new(session_id.clone(), tool_call_update, options).meta(
                codepro_permission_request_meta(
                    permission_class,
                    extension_source,
                    authorization_scope,
                    task_workspace_root.as_deref(),
                ),
            );

        cx.send_request(permission_request)
            .on_receiving_result(move |result| async move {
                match result {
                    Ok(response) => {
                        match &response.outcome {
                            RequestPermissionOutcome::Selected(selected) => {
                                tracing::info!(
                                    session_id = %session_id,
                                    request_id = %request_id,
                                    tool_name = %tool_name,
                                    option_id = %selected.option_id.0,
                                    ?permission_class,
                                    ?authorization_scope,
                                    "tool permission decision received"
                                );
                            }
                            RequestPermissionOutcome::Cancelled => {
                                tracing::info!(
                                    session_id = %session_id,
                                    request_id = %request_id,
                                    tool_name = %tool_name,
                                    "tool permission request cancelled"
                                );
                            }
                            _ => {}
                        }
                        agent
                            .handle_confirmation_outcome(
                                request_id,
                                outcome_to_tool_confirmation_outcome_with_workspace_grant(
                                    &response.outcome,
                                    permission_class,
                                    authorization_scope,
                                    task_workspace_root.as_deref(),
                                ),
                            )
                            .await;
                        Ok(())
                    }
                    Err(e) => {
                        error!(error = ?e, "permission request failed");
                        agent
                            .handle_confirmation_outcome(
                                request_id,
                                ToolConfirmationOutcome::EnvironmentFailure,
                            )
                            .await;
                        Ok(())
                    }
                }
            })?;

        Ok(())
    }

    fn is_builtin_agent_command(command: &str) -> bool {
        let normalized = command.trim_start_matches('/');

        crate::agents::execute_commands::list_commands()
            .iter()
            .any(|cmd| cmd.name == normalized)
            || crate::agents::execute_commands::COMPACT_TRIGGERS
                .iter()
                .filter_map(|trigger| trigger.strip_prefix('/'))
                .any(|trigger| trigger == normalized)
    }
}

fn codepro_permission_request_meta(
    permission_class: Option<ToolPermissionClass>,
    extension_source: Option<ToolExtensionSource>,
    authorization_scope: Option<ToolAuthorizationScope>,
    task_workspace_root: Option<&str>,
) -> Meta {
    fn fixed_value<T: serde::Serialize>(value: Option<T>, fallback: &str) -> serde_json::Value {
        value
            .and_then(|value| serde_json::to_value(value).ok())
            .unwrap_or_else(|| serde_json::Value::String(fallback.to_string()))
    }

    let mut meta = Meta::new();
    let mut context = serde_json::json!({
        "permissionClass": fixed_value(permission_class, "legacy"),
        "extensionSource": fixed_value(extension_source, "unknown"),
        "authorizationScope": fixed_value(authorization_scope, "unknown"),
    });
    if let Some(root) = task_workspace_root {
        context["taskWorkspaceRoot"] = serde_json::Value::String(root.to_string());
    }
    meta.insert("codepro".to_string(), context);
    meta
}

fn outcome_to_tool_confirmation_outcome_with_workspace_grant(
    outcome: &RequestPermissionOutcome,
    permission_class: Option<ToolPermissionClass>,
    authorization_scope: Option<ToolAuthorizationScope>,
    task_workspace_root: Option<&str>,
) -> ToolConfirmationOutcome {
    let base = outcome_to_tool_confirmation_outcome_for_context(
        outcome,
        permission_class,
        authorization_scope,
    );
    if task_workspace_root.is_some()
        && permission_class == Some(ToolPermissionClass::WorkspaceWrite)
        && authorization_scope == Some(ToolAuthorizationScope::Task)
    {
        if let (
            RequestPermissionOutcome::Selected(selected),
            ToolConfirmationOutcome::Selected(confirmation),
        ) = (outcome, &base)
        {
            if confirmation.permission == Permission::AlwaysAllow {
                return ToolConfirmationOutcome::TaskWorkspaceGrant {
                    confirmation: confirmation.clone(),
                    option_id: selected.option_id.0.to_string(),
                };
            }
        }
    }
    base
}

fn permission_tool_call_update(
    request_id: String,
    tool_name: String,
    arguments: serde_json::Map<String, serde_json::Value>,
    prompt: Option<String>,
) -> ToolCallUpdate {
    let mut fields = ToolCallUpdateFields::new()
        .title(format_tool_name(&tool_name))
        .kind(ToolKind::default())
        .status(ToolCallStatus::Pending)
        .raw_input(serde_json::Value::Object(arguments));
    if let Some(prompt) = prompt {
        fields = fields.content(vec![ToolCallContent::Content(Content::new(
            ContentBlock::Text(TextContent::new(prompt)),
        ))]);
    }
    ToolCallUpdate::new(ToolCallId::new(request_id), fields)
        .meta(tool_call_identity_meta_from_name(&tool_name, None))
}

fn permission_option(kind: PermissionOptionKind) -> PermissionOption {
    let id = serde_json::to_value(kind)
        .expect("permission option kind must serialize")
        .as_str()
        .expect("permission option kind must serialize as a string")
        .to_string();
    PermissionOption::new(id.clone(), id, kind)
}

fn long_term_allow_is_safe(
    permission_class: Option<ToolPermissionClass>,
    authorization_scope: Option<ToolAuthorizationScope>,
) -> bool {
    let permission_class = permission_class.unwrap_or(ToolPermissionClass::Legacy);
    let authorization_scope = authorization_scope.unwrap_or(ToolAuthorizationScope::Unknown);

    match authorization_scope {
        ToolAuthorizationScope::Task | ToolAuthorizationScope::Session => {
            permission_class != ToolPermissionClass::Forbidden
        }
        ToolAuthorizationScope::Global => matches!(
            permission_class,
            ToolPermissionClass::ReadOnly | ToolPermissionClass::WorkspaceWrite
        ),
        ToolAuthorizationScope::Unknown => false,
    }
}

fn permission_options_for_context(
    permission_class: Option<ToolPermissionClass>,
    authorization_scope: Option<ToolAuthorizationScope>,
) -> Vec<PermissionOption> {
    let forbidden = permission_class == Some(ToolPermissionClass::Forbidden);
    let mut options = Vec::with_capacity(4);
    if !forbidden {
        if long_term_allow_is_safe(permission_class, authorization_scope) {
            options.push(permission_option(PermissionOptionKind::AllowAlways));
        }
        options.push(permission_option(PermissionOptionKind::AllowOnce));
    }
    options.push(permission_option(PermissionOptionKind::RejectOnce));
    options.push(permission_option(PermissionOptionKind::RejectAlways));
    options
}

fn outcome_to_tool_confirmation_outcome_for_context(
    outcome: &RequestPermissionOutcome,
    permission_class: Option<ToolPermissionClass>,
    authorization_scope: Option<ToolAuthorizationScope>,
) -> ToolConfirmationOutcome {
    let decision = match outcome {
        RequestPermissionOutcome::Cancelled => return ToolConfirmationOutcome::Cancelled,
        RequestPermissionOutcome::Selected(selected) => {
            let Ok(decision) = PermissionDecision::from_str(&selected.option_id.0) else {
                return ToolConfirmationOutcome::EnvironmentFailure;
            };
            decision
        }
        _ => return ToolConfirmationOutcome::EnvironmentFailure,
    };
    let confirmation = PermissionConfirmation {
        principal_type: PrincipalType::Tool,
        permission: Permission::from(decision),
    };
    let allowed = match confirmation.permission {
        Permission::AllowOnce => permission_class != Some(ToolPermissionClass::Forbidden),
        Permission::AlwaysAllow => long_term_allow_is_safe(permission_class, authorization_scope),
        Permission::DenyOnce | Permission::AlwaysDeny | Permission::Cancel => true,
    };

    if allowed {
        ToolConfirmationOutcome::Selected(confirmation)
    } else if permission_class == Some(ToolPermissionClass::Forbidden) {
        ToolConfirmationOutcome::Forbidden
    } else {
        ToolConfirmationOutcome::PolicyDenied
    }
}

fn extract_client_supports_goose_custom_notifications(
    goose_client_capabilities: Option<&GooseClientCapabilities>,
) -> bool {
    goose_client_capabilities
        .and_then(|goose| goose.custom_notifications)
        .unwrap_or(false)
}

fn extract_client_supports_recipe_param_requests(
    goose_client_capabilities: Option<&GooseClientCapabilities>,
) -> bool {
    goose_client_capabilities
        .and_then(|goose| goose.recipe_parameter_requests)
        .unwrap_or(false)
}

#[cfg(test)]
fn outcome_to_confirmation(outcome: &RequestPermissionOutcome) -> PermissionConfirmation {
    PermissionConfirmation {
        principal_type: PrincipalType::Tool,
        permission: Permission::from(PermissionDecision::from(outcome)),
    }
}

fn prompt_error_from_message_content(
    content_item: &MessageContent,
) -> Option<agent_client_protocol::Error> {
    match content_item {
        MessageContent::SystemNotification(notification)
            if notification.notification_type == SystemNotificationType::CreditsExhausted =>
        {
            Some(credits_exhausted_prompt_error(notification))
        }
        _ => None,
    }
}

fn credits_exhausted_prompt_error(
    notification: &SystemNotificationContent,
) -> agent_client_protocol::Error {
    let mut data = serde_json::Map::new();
    data.insert(
        "reason".to_string(),
        serde_json::Value::String("credits_exhausted".to_string()),
    );

    if let Some(url) = notification
        .data
        .as_ref()
        .and_then(|data| data.get("top_up_url"))
        .and_then(|url| url.as_str())
    {
        data.insert(
            "url".to_string(),
            serde_json::Value::String(url.to_string()),
        );
    }

    agent_client_protocol::Error::new(-32603, notification.msg.clone())
        .data(serde_json::Value::Object(data))
}

fn send_status_message_update(
    cx: &ConnectionTo<Client>,
    supports_goose_custom_notifications: bool,
    session_id: &str,
    notification: &SystemNotificationContent,
    stream_timing: Option<&goose_providers::request_log::StreamTiming>,
) -> Result<(), agent_client_protocol::Error> {
    if let Some(data) = notification
        .data
        .as_ref()
        .filter(|data| data["type"] == "tool_input_preview")
    {
        if let (Some(id), Some(name)) = (data["id"].as_str(), data["name"].as_str()) {
            let mut arguments = data["arguments"].as_object().cloned().unwrap_or_default();
            arguments.insert("__inputPreview".into(), serde_json::Value::Bool(true));
            let call = agent_client_protocol::schema::v1::ToolCall::new(
                ToolCallId::new(id),
                format_tool_name(name),
            )
            .status(ToolCallStatus::Pending)
            .raw_input(serde_json::Value::Object(arguments))
            .meta(with_stream_timing(
                tool_call_identity_meta_from_name(name, None),
                stream_timing,
            ));
            ToolCallNotifier::new(cx, &SessionId::new(session_id)).send_initial(call)?;
        }
        return Ok(());
    }
    if let Some(status) = status_message_from_system_notification(notification) {
        if supports_goose_custom_notifications {
            if let Some(progress) = notification
                .data
                .clone()
                .and_then(|data| serde_json::from_value::<TestExecutionProgress>(data).ok())
            {
                cx.send_notification(GooseSessionNotification {
                    session_id: session_id.to_string(),
                    update: GooseSessionUpdate::TestExecutionProgress(Box::new(
                        TestExecutionProgressUpdate { progress },
                    )),
                })?;
                return Ok(());
            }
            if let Some(event) = notification
                .data
                .clone()
                .and_then(|data| serde_json::from_value::<ActivityEvent>(data).ok())
            {
                cx.send_notification(GooseSessionNotification {
                    session_id: session_id.to_string(),
                    update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate {
                        status: public_activity_status(&event),
                    }),
                })?;
                return Ok(());
            }
            cx.send_notification(GooseSessionNotification {
                session_id: session_id.to_string(),
                update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate { status }),
            })?;
        }
    }
    Ok(())
}

fn public_activity_status(event: &ActivityEvent) -> StatusMessage {
    // Keep the event's real identity and kind. A presentation phase is not an
    // action attempt and cannot replace an ActivityEvent on the wire.
    let mut public = event.clone();
    public.title = sanitize_public_progress_text(&event.title, 500).unwrap_or_default();
    public.command_summary = event
        .command_summary
        .as_deref()
        .and_then(|value| sanitize_public_progress_text(value, 1_000));
    public.technical_details = event
        .technical_details
        .as_deref()
        .and_then(|value| sanitize_public_progress_text(value, 2_000));
    public.diff_summary = event
        .diff_summary
        .as_deref()
        .and_then(|value| sanitize_public_progress_text(value, 2_000));
    // Routing evidence was not part of the previous public projection.
    public.routing_evidence = None;
    StatusMessage::Progress {
        message: public.title.clone(),
        data: Some(serde_json::json!(public)),
    }
}

fn sanitize_public_progress_text(value: &str, max_chars: usize) -> Option<String> {
    let redacted = crate::agents::codepro_event_log::redact_persisted_text(value.to_string());
    let safe_lines = redacted.lines().filter(|line| {
        let normalized = line.to_ascii_lowercase().replace(['_', '-'], " ");
        ![
            "system prompt",
            "system message",
            "chain of thought",
            "private draft",
            "hidden reasoning",
        ]
        .iter()
        .any(|marker| normalized.contains(marker))
    });
    let value = safe_lines.collect::<Vec<_>>().join("\n");
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut chars = value.chars();
    let mut bounded = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        bounded.push('…');
    }
    Some(bounded)
}

fn send_progress_message_update(
    cx: &ConnectionTo<Client>,
    supports_goose_custom_notifications: bool,
    session_id: &str,
    message: String,
) -> Result<(), agent_client_protocol::Error> {
    if supports_goose_custom_notifications {
        cx.send_notification(GooseSessionNotification {
            session_id: session_id.to_string(),
            update: GooseSessionUpdate::StatusMessage(StatusMessageUpdate {
                status: StatusMessage::Progress {
                    message,
                    data: None,
                },
            }),
        })?;
    }
    Ok(())
}

fn status_message_from_system_notification(
    notification: &SystemNotificationContent,
) -> Option<StatusMessage> {
    match notification.notification_type {
        SystemNotificationType::InlineMessage => Some(StatusMessage::Notice {
            message: notification.msg.clone(),
            data: notification.data.clone(),
        }),
        SystemNotificationType::ThinkingMessage
        | SystemNotificationType::ProgressMessage
        | SystemNotificationType::TurnTerminal => Some(StatusMessage::Progress {
            message: notification.msg.clone(),
            data: notification.data.clone(),
        }),
        SystemNotificationType::CreditsExhausted => None,
    }
}

fn send_persisted_terminal_message(
    cx: &ConnectionTo<Client>,
    supports_goose_custom_notifications: bool,
    session_id: &str,
    message: &Message,
) -> Result<(), agent_client_protocol::Error> {
    // Deliver the explanation before the terminal seals the turn in the client.
    for content in &message.content {
        if let MessageContent::Text(text) = content {
            cx.send_notification(SessionNotification::new(
                SessionId::new(session_id),
                SessionUpdate::AgentMessageChunk(
                    ContentChunk::new(ContentBlock::Text(TextContent::new(text.text.clone())))
                        .meta(message_update_meta(
                            message.id.as_deref(),
                            message.created,
                            false,
                        )),
                ),
            ))?;
        }
    }
    for notification in message
        .content
        .iter()
        .filter_map(MessageContent::as_system_notification)
    {
        send_status_message_update(
            cx,
            supports_goose_custom_notifications,
            session_id,
            notification,
            None,
        )?;
    }
    Ok(())
}

fn build_cancelled_codepro_terminal_message(
    session_id: &str,
    run_id: &str,
    source_user_message_id: &str,
    messages: &[Message],
) -> Option<Message> {
    let source_index = messages
        .iter()
        .rposition(|message| message.id.as_deref() == Some(source_user_message_id))?;
    let current_turn = &messages[source_index + 1..];

    let already_persisted = current_turn.iter().any(|message| {
        message.content.iter().any(|content| {
            let MessageContent::SystemNotification(notification) = content else {
                return false;
            };
            notification.notification_type == SystemNotificationType::TurnTerminal
                && notification
                    .data
                    .as_ref()
                    .and_then(|data| data.get("run_id"))
                    .and_then(serde_json::Value::as_str)
                    == Some(run_id)
        })
    });
    if already_persisted {
        return None;
    }

    let tool_action_count = current_turn
        .iter()
        .flat_map(|message| message.content.iter())
        .filter(|content| matches!(content, MessageContent::ToolRequest(_)))
        .count();

    let explanation = if std::env::var("GOOSE_LOCALE")
        .map_or(true, |locale| locale.starts_with("zh"))
    {
        "已按你的要求停止。已经执行的操作不会自动撤销；尚未确认的结果仍需核对。"
    } else {
        "Stopped at your request. Actions already taken are not undone; any unconfirmed results still need checking."
    };
    let terminal = Message::assistant()
        .with_generated_id()
        .with_text(explanation);
    let terminal_message_id = terminal
        .id
        .as_deref()
        .expect("generated terminal message id");
    let failure = crate::permission::failure_semantics::CodeProFailureKind::Cancelled.contract();
    let data = serde_json::json!({
        "schema_version": 1,
        "session_id": session_id,
        "run_id": run_id,
        "terminal_message_id": terminal_message_id,
        "source_user_message_id": source_user_message_id,
        "status": "cancelled",
        "failure_kind": failure.status_code,
        "retryable": failure.retryable,
        "user_action": failure.user_action_code(),
        "checkpoint_id": serde_json::Value::Null,
        "retry_strategy": "replay_user_request",
        "visible_text_available": true,
        "tool_action_count": tool_action_count,
        "copy_artifact_ref": serde_json::Value::Null,
        "finished_at": chrono::Utc::now().to_rfc3339(),
    });

    Some(terminal.with_system_notification_with_data(
        SystemNotificationType::TurnTerminal,
        "CodePro turn stopped",
        data,
    ))
}

async fn load_persisted_codepro_terminal_message(
    session_manager: &SessionManager,
    session_id: &str,
    run_id: &str,
    source_user_message_id: &str,
) -> Result<Option<Message>, agent_client_protocol::Error> {
    let persisted = session_manager
        .get_session(session_id, true)
        .await
        .internal_err_ctx("Failed to load persisted CodePro terminal report")?;
    Ok(persisted.conversation.as_ref().and_then(|conversation| {
        conversation.messages().iter().rev().find_map(|message| {
            message
                .content
                .iter()
                .find_map(MessageContent::as_system_notification)
                .filter(|notification| {
                    turn_terminal_matches_prompt(notification, run_id, source_user_message_id)
                })
                .map(|_| message.clone())
        })
    }))
}

fn turn_terminal_matches_prompt(
    notification: &SystemNotificationContent,
    run_id: &str,
    source_user_message_id: &str,
) -> bool {
    notification.notification_type == SystemNotificationType::TurnTerminal
        && notification.data.as_ref().is_some_and(|data| {
            data.get("run_id").and_then(serde_json::Value::as_str) == Some(run_id)
                && data
                    .get("source_user_message_id")
                    .and_then(serde_json::Value::as_str)
                    == Some(source_user_message_id)
        })
}

/// Conversion to the sdk-types wire mirror carried by `message_usage`.
fn message_usage_update(
    message_id: Option<String>,
    usage: &crate::conversation::message::MessageUsage,
) -> MessageUsageUpdate {
    use crate::conversation::token_usage::CostSource;

    MessageUsageUpdate {
        message_id,
        usage: MessageUsageData {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_write_tokens: usage.cache_write_tokens,
            cost: usage.cost,
            cost_source: usage.cost_source.map(|source| match source {
                CostSource::ProviderReported => CostSourceData::ProviderReported,
                CostSource::Estimated => CostSourceData::Estimated,
            }),
            elapsed_ms: usage.elapsed_ms,
            time_to_first_token_ms: usage.time_to_first_token_ms,
            is_compaction: usage.is_compaction,
        },
    }
}

fn message_update_meta(message_id: Option<&str>, created: i64, steer: bool) -> Meta {
    let mut goose = serde_json::Map::new();
    goose.insert("created".to_string(), serde_json::json!(created));
    if let Some(id) = message_id {
        goose.insert("messageId".to_string(), serde_json::json!(id));
    }
    if steer {
        goose.insert("steer".to_string(), serde_json::json!(true));
    }

    let mut meta = serde_json::Map::new();
    meta.insert("goose".to_string(), serde_json::Value::Object(goose));
    meta
}

// Optional live transport diagnostics. No completion or permission semantics,
// and no metadata is restored on historical replay.
fn with_stream_timing(
    meta: impl Into<Option<Meta>>,
    timing: Option<&goose_providers::request_log::StreamTiming>,
) -> Option<Meta> {
    let Some(timing) = timing else {
        return meta.into();
    };
    let mut meta = meta.into().unwrap_or_default();
    timing.record("acp_enqueue", timing.parsed_sequence, 0);
    meta.insert(
        "streamTiming".into(),
        serde_json::json!({
            "requestId": timing.request_id,
            "parsedSequence": timing.parsed_sequence,
            "sentAtMs": chrono::Utc::now().timestamp_millis(),
        }),
    );
    Some(meta)
}

fn replay_message_meta(message: &Message) -> Meta {
    let mut meta = serde_json::Map::new();
    meta.insert(
        "goose".to_string(),
        serde_json::Value::Object(replay_message_goose_meta(message)),
    );
    meta
}

fn replay_message_goose_meta(message: &Message) -> serde_json::Map<String, serde_json::Value> {
    let mut goose = serde_json::Map::new();
    goose.insert("created".to_string(), serde_json::json!(message.created));
    if let Some(id) = &message.id {
        goose.insert("messageId".to_string(), serde_json::json!(id));
    }
    if message.metadata.steer {
        goose.insert("steer".to_string(), serde_json::json!(true));
    }
    goose
}

fn merge_replay_message_meta(meta: Option<Meta>, message: &Message) -> Meta {
    let replay_goose = replay_message_goose_meta(message);
    let mut meta = meta.unwrap_or_default();
    let goose_value = meta
        .entry("goose".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));

    if let serde_json::Value::Object(goose) = goose_value {
        for (key, value) in replay_goose {
            goose.insert(key, value);
        }
    } else {
        *goose_value = serde_json::Value::Object(replay_goose);
    }

    meta
}

impl GooseAcpAgent {
    async fn on_initialize(
        &self,
        args: InitializeRequest,
    ) -> Result<InitializeResponse, agent_client_protocol::Error> {
        debug!(?args, "initialize request");

        let _ = self
            .client_fs_capabilities
            .set(args.client_capabilities.fs.clone());
        let _ = self.client_terminal.set(args.client_capabilities.terminal);
        let goose_client_capabilities =
            extract_client_capabilities_meta(&args).and_then(|meta| meta.goose);
        let _ = self.client_mcp_host_info.set(extract_client_mcp_host_info(
            &args,
            goose_client_capabilities.as_ref(),
        ));
        let _ = self.client_supports_goose_custom_notifications.set(
            extract_client_supports_goose_custom_notifications(goose_client_capabilities.as_ref()),
        );
        let _ = self.client_project_containers.set(
            goose_client_capabilities
                .as_ref()
                .and_then(|c| c.project_containers)
                == Some(1),
        );
        let _ = self.client_workspace_confirmation_refresh.set(
            goose_client_capabilities
                .as_ref()
                .and_then(|c| c.workspace_confirmation_refresh)
                == Some(1),
        );
        let _ = self.client_supports_recipe_param_requests.set(
            extract_client_supports_recipe_param_requests(goose_client_capabilities.as_ref()),
        );
        let _ = self
            .client_supports_acp_elicitation
            .set(elicitation::client_supports_form_elicitation(&args));
        let _ = self
            .use_login_shell_path
            .set(extract_use_login_shell_path(&args));

        let capabilities = AgentCapabilities::new()
            .load_session(true)
            .session_capabilities(
                SessionCapabilities::new()
                    .list(SessionListCapabilities::new())
                    .close(SessionCloseCapabilities::new()),
            )
            .prompt_capabilities(
                PromptCapabilities::new()
                    .image(true)
                    .audio(false)
                    .embedded_context(true),
            )
            .mcp_capabilities(McpCapabilities::new().http(true))
            .meta(agent_capabilities_meta());
        Ok(InitializeResponse::new(args.protocol_version)
            .agent_info(Implementation::new("goose", env!("CARGO_PKG_VERSION")))
            .agent_capabilities(capabilities)
            .auth_methods(vec![AuthMethod::Agent(
                AuthMethodAgent::new("goose-provider", "Configure Provider")
                    .description("Run `goose configure` to set up your AI provider and API key"),
            )]))
    }

    async fn on_new_session(
        &self,
        cx: &ConnectionTo<Client>,
        args: NewSessionRequest,
    ) -> Result<NewSessionResponse, agent_client_protocol::Error> {
        self.handle_new_session(cx, args).await
    }

    /// Look up the session's agent.
    async fn get_session_agent(
        &self,
        session_id: &str,
    ) -> Result<Arc<Agent>, agent_client_protocol::Error> {
        if self.closed_session_ids.lock().await.contains(session_id) {
            return Err(agent_client_protocol::Error::resource_not_found(Some(
                session_id.to_string(),
            ))
            .data(format!("Session not found: {}", session_id)));
        }

        {
            let sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get(session_id) {
                return Ok(session.agent.clone());
            }
        }

        let cx = self.client_cx.get().ok_or_else(|| {
            agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                .data(format!("Session not found: {}", session_id))
        })?;
        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .map_err(|_| {
                agent_client_protocol::Error::resource_not_found(Some(session_id.to_string()))
                    .data(format!("Session not found: {}", session_id))
            })?;
        let (agent, _) = self
            .activate_acp_session(cx, &session, HashMap::new())
            .await?;
        Ok(agent)
    }

    async fn start_active_run(
        &self,
        session_id: &str,
        run_id: String,
        cancel_token: CancellationToken,
    ) -> Result<(), agent_client_protocol::Error> {
        if self.closed_session_ids.lock().await.contains(session_id) {
            return Err(agent_client_protocol::Error::resource_not_found(Some(
                session_id.to_string(),
            ))
            .data(format!("Session not found: {}", session_id)));
        }

        // Maintenance owns the history until its commit finishes. A newly submitted
        // prompt waits here and then reads the compacted history, never an old copy.
        let maintenance = self.context_maintenance_lock(session_id).await;
        let _maintenance = maintenance.lock().await;
        let mut active_prompt_runs = self.active_prompt_runs.lock().await;
        if let Some(active_run) = active_prompt_runs.get(session_id) {
            return Err(agent_client_protocol::Error::invalid_params().data(format!(
                "session already has active run `{}`; use _goose/unstable/session/steer",
                active_run.run_id.as_str()
            )));
        }

        active_prompt_runs.insert(
            session_id.to_string(),
            ActivePromptRun {
                run_id,
                cancel_token,
                stop_reason: ActivePromptStopReason::None,
                durable_execution_bound: false,
            },
        );
        Ok(())
    }

    async fn clear_active_run(&self, session_id: &str, run_id: &str) -> ActivePromptStopReason {
        let stop_reason = {
            let mut active_prompt_runs = self.active_prompt_runs.lock().await;
            let Some(stop_reason) =
                take_active_run_stop_reason(&mut active_prompt_runs, session_id, run_id)
            else {
                return ActivePromptStopReason::None;
            };
            stop_reason
        };

        let agent = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(session_id)
                .map(|session| session.agent.clone())
        };
        if let Some(agent) = agent {
            agent.discard_pending_steers(session_id).await;
        }

        if self.closed_session_ids.lock().await.contains(session_id) {
            self.sessions.lock().await.remove(session_id);
            if let Err(error) = self
                .agent_manager
                .remove_session_if_loaded(session_id)
                .await
            {
                tracing::warn!(
                    session_id,
                    %error,
                    "Failed to remove in-memory agent for closed session"
                );
            }
        }
        stop_reason
    }

    async fn require_active_run(
        &self,
        session_id: &str,
        expected_run_id: &str,
    ) -> Result<String, agent_client_protocol::Error> {
        if expected_run_id.is_empty() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("expectedRunId must not be empty"));
        }

        let active_prompt_runs = self.active_prompt_runs.lock().await;
        let active_run = active_prompt_runs.get(session_id).ok_or_else(|| {
            agent_client_protocol::Error::invalid_params().data("no active run to steer")
        })?;
        if active_run.run_id != expected_run_id {
            return Err(
                agent_client_protocol::Error::invalid_params().data(serde_json::json!({
                    "message": format!(
                        "expected active run id `{expected_run_id}` but found `{}`",
                        active_run.run_id.as_str()
                    ),
                    "expectedRunId": expected_run_id,
                    "actualRunId": active_run.run_id.as_str(),
                })),
            );
        }
        Ok(active_run.run_id.clone())
    }

    fn active_run_meta(active_run_id: Option<&str>) -> Meta {
        let mut goose = serde_json::Map::new();
        goose.insert(
            "activeRunId".to_string(),
            active_run_id
                .map(|run_id| serde_json::Value::String(run_id.to_string()))
                .unwrap_or(serde_json::Value::Null),
        );

        let mut meta = serde_json::Map::new();
        meta.insert("goose".to_string(), serde_json::Value::Object(goose));
        meta
    }

    fn send_active_run_update(
        cx: &ConnectionTo<Client>,
        session_id: &SessionId,
        active_run_id: Option<&str>,
    ) -> Result<(), agent_client_protocol::Error> {
        cx.send_notification(SessionNotification::new(
            session_id.clone(),
            SessionUpdate::SessionInfoUpdate(
                SessionInfoUpdate::new().meta(Self::active_run_meta(active_run_id)),
            ),
        ))
    }

    fn send_queued_steer_update(
        cx: &ConnectionTo<Client>,
        session_id: &SessionId,
        message_id: &str,
        run_id: &str,
    ) -> Result<(), agent_client_protocol::Error> {
        let mut goose = serde_json::Map::new();
        goose.insert(
            "queuedSteer".to_string(),
            serde_json::json!({
                "messageId": message_id,
                "runId": run_id,
            }),
        );
        let mut meta = serde_json::Map::new();
        meta.insert("goose".to_string(), serde_json::Value::Object(goose));

        cx.send_notification(SessionNotification::new(
            session_id.clone(),
            SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().meta(meta)),
        ))
    }

    async fn send_local_inference_progress_update(
        &self,
        cx: &ConnectionTo<Client>,
        acp_session_id: &SessionId,
        session_id: &str,
        agent: &Arc<Agent>,
    ) -> Result<(), agent_client_protocol::Error> {
        let Ok(provider) = agent.provider().await else {
            return Ok(());
        };
        if provider.get_name() != "local" {
            return Ok(());
        }

        let model_config = agent.model_config_for_session(session_id).await.ok();
        let model_name = model_config
            .as_ref()
            .map(|config| config.model_name.clone())
            .unwrap_or_else(|| "local model".to_string());

        #[cfg(feature = "local-inference")]
        if let Some(model_config) = model_config.as_ref() {
            if crate::providers::local_inference::is_model_loaded(&model_config.model_name)
                .await
                .unwrap_or(false)
            {
                return Ok(());
            }
        }

        send_progress_message_update(
            cx,
            self.supports_goose_custom_notifications(),
            acp_session_id.0.as_ref(),
            format!("Loading local model {model_name}..."),
        )
    }

    async fn on_load_session(
        &self,
        cx: &ConnectionTo<Client>,
        args: LoadSessionRequest,
    ) -> Result<LoadSessionResponse, agent_client_protocol::Error> {
        self.handle_load_session(cx, args).await
    }

    async fn on_prompt(
        &self,
        cx: &ConnectionTo<Client>,
        args: PromptRequest,
    ) -> Result<PromptResponse, agent_client_protocol::Error> {
        // The ACP session_id IS the thread ID.
        let session_id = args.session_id.0.to_string();
        let _session_access = self
            .acquire_session_dispatch_access(&session_id, false)
            .await?;
        let mut turn_retry =
            parse_codepro_turn_retry_metadata(args.meta.as_ref()).map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(error.to_string())
            })?;
        let checkpoint_context = parse_codepro_checkpoint_context(args.meta.as_ref())
            .invalid_params_err_ctx("Invalid checkpoint context")?;
        if checkpoint_context.is_some() && turn_retry.is_some() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("checkpoint context and turn retry cannot be combined"));
        }
        let source_message_id =
            parse_codepro_source_message_id(args.meta.as_ref()).map_err(|error| {
                agent_client_protocol::Error::invalid_params().data(error.to_string())
            })?;
        let persisted_session = self
            .session_manager
            .get_session(&session_id, false)
            .await
            .internal_err_ctx("Failed to load session workspace")?;
        let session_type = persisted_session.session_type;
        let resource_workspace = authoritative_resource_workspace(&persisted_session)?;
        let mut user_message = Self::convert_acp_turn_prompt_to_message(
            &args.prompt,
            resource_workspace.as_deref(),
            session_type,
            turn_retry.as_ref(),
        )?;
        if let Some(source_message_id) = source_message_id {
            user_message = user_message.with_id(source_message_id);
        } else if user_message.id.is_none() {
            user_message = user_message.with_generated_id();
        }
        let source_user_message_id = user_message.id.clone().expect("ACP prompt user message id");
        let message_text = user_message.as_concat_text();
        let is_builtin_command =
            crate::agents::execute_commands::parse_slash_command(&message_text)
                .is_some_and(|parsed| Self::is_builtin_agent_command(parsed.command));
        let mut is_codepro_agent_run = session_type == SessionType::CodePro && !is_builtin_command;
        let mut codepro_goal =
            prompt_goal::prompt_goal(&user_message, std::env::var("GOOSE_LOCALE").ok().as_deref())
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })?;
        let sid = sid_short(&session_id);
        let t_start = std::time::Instant::now();

        let provisional_run_id = format!("run_{}", Uuid::new_v4());
        let cancel_token = CancellationToken::new();
        self.start_active_run(
            &session_id,
            provisional_run_id.clone(),
            cancel_token.clone(),
        )
        .await?;
        let agent = match self.get_session_agent(&session_id).await {
            Ok(agent) => agent,
            Err(error) => {
                self.clear_active_run(&session_id, &provisional_run_id)
                    .await;
                return Err(error);
            }
        };
        let legacy_checkpoint_context = turn_retry
            .as_ref()
            .filter(|retry| retry.strategy == CodeProTurnRetryStrategy::ContinueCheckpoint)
            .map(|retry| crate::agents::CodeProCheckpointContext {
                schema_version: 1,
                checkpoint_id: retry.checkpoint_id.clone().unwrap_or_default(),
                source_run_id: retry.source_run_id.clone(),
                source_user_message_id: retry.source_user_message_id.clone(),
                source_terminal_message_id: None,
            });
        let checkpoint_resolution = if is_codepro_agent_run
            && turn_retry
                .as_ref()
                .is_none_or(|retry| retry.strategy == CodeProTurnRetryStrategy::ContinueCheckpoint)
        {
            agent
                .resolve_codepro_checkpoint_input(
                    &session_id,
                    &user_message,
                    checkpoint_context
                        .as_ref()
                        .or(legacy_checkpoint_context.as_ref()),
                    Some(&cancel_token),
                )
                .await
                .internal_err_ctx("Failed to interpret checkpoint input")
        } else {
            Ok(None)
        };
        let mut checkpoint_decision = match checkpoint_resolution {
            Ok(decision) => decision,
            Err(error) => {
                self.clear_active_run(&session_id, &provisional_run_id)
                    .await;
                return Err(error);
            }
        };
        let mut clarification_run_id = None;
        let mut has_clarification_goal = false;
        if is_codepro_agent_run && turn_retry.is_none() && checkpoint_decision.is_none() {
            let prepared = async {
                let input = agent
                    .prepare_codepro_clarification_input(
                        &session_id,
                        &user_message,
                        Some(&cancel_token),
                    )
                    .await?;
                let goal = agent
                    .codepro_clarification_goal(&session_id, &user_message)
                    .await?;
                let run_id = agent
                    .codepro_clarification_run_id(&session_id, &user_message)
                    .await?;
                Ok::<_, anyhow::Error>((goal, run_id, input))
            }
            .await;
            match prepared {
                Ok((_, _, Some(crate::agents::ClarificationInput::Notice(text)))) => {
                    let notice = Message::assistant()
                        .with_generated_id()
                        .with_text(text.clone());
                    self.session_manager
                        .add_message(&session_id, &notice)
                        .await
                        .internal_err_ctx("Failed to retain clarification notice")?;
                    cx.send_notification(SessionNotification::new(
                        args.session_id.clone(),
                        SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                            TextContent::new(text),
                        ))),
                    ))?;
                    self.clear_active_run(&session_id, &provisional_run_id)
                        .await;
                    Self::send_active_run_update(cx, &args.session_id, None)?;
                    return Ok(PromptResponse::new(StopReason::EndTurn));
                }
                Ok((Some(goal), bound, _)) => {
                    codepro_goal = goal;
                    clarification_run_id = bound;
                    has_clarification_goal = true;
                }
                Ok((None, _, _)) => {}
                Err(error) => {
                    self.clear_active_run(&session_id, &provisional_run_id)
                        .await;
                    return Err(
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    );
                }
            }
        }
        let run_input_binding = if is_codepro_agent_run
            && turn_retry.is_none()
            && checkpoint_decision.is_none()
            && !has_clarification_goal
        {
            let durable_candidate = if self.codepro_control.tracks_prompt_runs() {
                let candidate = async {
                    let prompt_session = self
                        .session_manager
                        .get_session(&session_id, true)
                        .await
                        .map_err(|error| {
                            codepro_control::CodeProControlError::InvalidData(format!(
                                "Failed to read the CodePro prompt workspace: {error}"
                            ))
                        })?;
                    let explicit_run = prompt_session
                        .conversation
                        .as_ref()
                        .and_then(|history| {
                            history
                                .messages()
                                .iter()
                                .rev()
                                .filter(|message| message.role == Role::User)
                                .find_map(|message| message.metadata.task_run_id.as_deref())
                        })
                        .or_else(|| {
                            prompt_session
                                .extension_data
                                .get_extension_state("codepro_unified_turn", "v1")
                                .and_then(|state| state.get("run_id"))
                                .and_then(serde_json::Value::as_str)
                        });
                    if let Some(run_id) = explicit_run {
                        if let Some(candidate) = self
                            .codepro_control
                            .bound_prompt_run_for_input(
                                &session_id,
                                &prompt_session.working_dir,
                                run_id,
                            )
                            .await?
                        {
                            return Ok(Some(candidate));
                        }
                    }
                    self.codepro_control
                        .prior_prompt_run_for_input(&session_id, &prompt_session.working_dir)
                        .await
                }
                .await;
                match candidate {
                    Ok(candidate) => candidate,
                    Err(error) => {
                        self.clear_active_run(&session_id, &provisional_run_id)
                            .await;
                        return Err(codepro_control::acp_error(error));
                    }
                }
            } else {
                None
            };
            match agent
                .resolve_codepro_run_input(
                    &session_id,
                    &user_message,
                    Some(&cancel_token),
                    durable_candidate,
                )
                .await
            {
                Ok(binding) => binding,
                Err(error) => {
                    self.clear_active_run(&session_id, &provisional_run_id)
                        .await;
                    return Err(
                        agent_client_protocol::Error::internal_error().data(error.to_string())
                    );
                }
            }
        } else {
            None
        };
        let question_only = run_input_binding
            .as_ref()
            .is_some_and(|binding| binding.question_only);
        let question_run_id = run_input_binding
            .as_ref()
            .filter(|binding| binding.question_only)
            .map(|binding| binding.run_id.clone());
        // An answer has its own transient prompt identity, not the old run's
        // lifecycle. Cancellation or provider failure must not terminalize it.
        is_codepro_agent_run &= !question_only;
        let run_input_binding = run_input_binding.filter(|binding| !binding.question_only);
        if let Some(binding) = &run_input_binding {
            codepro_goal = binding.goal.clone();
        }
        let bound_run_completed = run_input_binding
            .as_ref()
            .is_some_and(|binding| binding.completed);
        let bound_run_cancelled = run_input_binding
            .as_ref()
            .is_some_and(|binding| binding.cancels_run);
        if cancel_token.is_cancelled() {
            self.clear_active_run(&session_id, &provisional_run_id)
                .await;
            self.session_manager
                .add_message(&session_id, &user_message)
                .await
                .internal_err_ctx("Failed to retain cancelled checkpoint input")?;
            Self::send_active_run_update(cx, &args.session_id, None)?;
            return Ok(PromptResponse::new(StopReason::Cancelled));
        }
        if let Some(crate::agents::CodeProCheckpointInputDecision::Resume(retry)) =
            &checkpoint_decision
        {
            if self
                .checkpoint_cancellation_fences
                .lock()
                .await
                .get(&session_id)
                == retry.checkpoint_id.as_ref()
            {
                checkpoint_decision = Some(crate::agents::CodeProCheckpointInputDecision::Notice {
                    context: None,
                    text: "此检查点已收到取消请求，不能继续。请查看取消结果；原始记录仍保留。"
                        .to_string(),
                    cancelled: false,
                });
            }
        }
        let mut resume_request = turn_retry.clone().map(codepro_resume_request_from_metadata);
        if let Some(decision) = &checkpoint_decision {
            if let crate::agents::CodeProCheckpointInputDecision::Resume(retry) = decision {
                resume_request = Some(retry.clone());
                turn_retry = Some(CodeProTurnRetryMetadata {
                    schema_version: 1,
                    strategy: CodeProTurnRetryStrategy::ContinueCheckpoint,
                    checkpoint_id: retry.checkpoint_id.clone(),
                    source_run_id: retry.source_run_id.clone(),
                    source_user_message_id: retry.source_user_message_id.clone(),
                    source_terminal_message_id: None,
                });
            } else {
                resume_request = None;
                turn_retry = None;
            }
        }
        let nonexecuting_checkpoint = match &checkpoint_decision {
            Some(crate::agents::CodeProCheckpointInputDecision::Notice {
                context: Some(context),
                cancelled,
                ..
            }) => {
                if *cancelled {
                    self.checkpoint_cancellation_fences
                        .lock()
                        .await
                        .insert(session_id.clone(), context.checkpoint_id.clone());
                    cancel_token.cancel();
                }
                Some(context)
            }
            _ => None,
        };
        let cancelling_checkpoint = matches!(
            &checkpoint_decision,
            Some(crate::agents::CodeProCheckpointInputDecision::Notice {
                cancelled: true,
                ..
            })
        );

        let run_identity = if let Some(context) = nonexecuting_checkpoint {
            CodeProPromptRunIdentity {
                run_id: context.source_run_id.clone(),
                resume_existing: false,
            }
        } else if let Some(binding) = &run_input_binding {
            CodeProPromptRunIdentity {
                run_id: if binding.starts_new_run {
                    provisional_run_id.clone()
                } else {
                    binding.run_id.clone()
                },
                resume_existing: !binding.completed && !binding.starts_new_run,
            }
        } else if let Some(run_id) = clarification_run_id {
            CodeProPromptRunIdentity {
                run_id,
                resume_existing: false,
            }
        } else {
            codepro_prompt_run_identity(turn_retry.as_ref())
        };
        let run_id = run_identity.run_id;
        if has_clarification_goal {
            if let Err(error) = agent
                .bind_codepro_clarification_run(&session_id, &user_message, &run_id)
                .await
            {
                self.clear_active_run(&session_id, &provisional_run_id)
                    .await;
                return Err(agent_client_protocol::Error::internal_error().data(error.to_string()));
            }
        }
        let retargeted = {
            let mut active_runs = self.active_prompt_runs.lock().await;
            retarget_checkpoint_prompt(
                &mut active_runs,
                &session_id,
                &provisional_run_id,
                &run_id,
                cancelling_checkpoint,
            )
        };
        if !retargeted {
            self.clear_active_run(&session_id, &provisional_run_id)
                .await;
            return Ok(PromptResponse::new(StopReason::Cancelled));
        }

        if cancel_token.is_cancelled() && !cancelling_checkpoint {
            self.clear_active_run(&session_id, &run_id).await;
            Self::send_active_run_update(cx, &args.session_id, None)?;
            return Ok(PromptResponse::new(StopReason::Cancelled));
        }

        let prepared_notice =
            if let Some(decision @ crate::agents::CodeProCheckpointInputDecision::Notice { .. }) =
                checkpoint_decision.as_ref()
            {
                Some(
                    agent
                        .reply_codepro_checkpoint_input(
                            user_message.clone(),
                            SessionConfig {
                                id: session_id.clone(),
                                schedule_id: None,
                                max_turns: None,
                                retry_config: None,
                            },
                            Some(cancel_token.clone()),
                            run_id.clone(),
                            decision.clone(),
                        )
                        .await,
                )
            } else {
                None
            };
        if cancelling_checkpoint {
            if let Err(error) = self
                .codepro_control
                .cancel_prompt_run(&session_id, &run_id)
                .await
            {
                self.clear_active_run(&session_id, &run_id).await;
                return Err(codepro_control::acp_error(error));
            }
        }
        if bound_run_cancelled {
            if let Err(error) = self
                .codepro_control
                .cancel_prompt_run(&session_id, &run_id)
                .await
            {
                self.clear_active_run(&session_id, &run_id).await;
                return Err(codepro_control::acp_error(error));
            }
        }

        let mut durable_execution_bound = false;
        if is_codepro_agent_run
            && self.codepro_control.tracks_prompt_runs()
            && nonexecuting_checkpoint.is_none()
            && !bound_run_completed
            && !bound_run_cancelled
        {
            // Stop and admission share this short local commit boundary. Never
            // allow an already stopped provisional prompt to bind a business run.
            let mut active_runs = self.active_prompt_runs.lock().await;
            let Some(active) = active_runs
                .get_mut(&session_id)
                .filter(|active| active.run_id == run_id && !active.cancel_token.is_cancelled())
            else {
                drop(active_runs);
                self.clear_active_run(&session_id, &run_id).await;
                Self::send_active_run_update(cx, &args.session_id, None)?;
                return Ok(PromptResponse::new(StopReason::Cancelled));
            };
            let registration = if run_identity.resume_existing {
                self.codepro_control
                    .resume_prompt_run(&session_id, &run_id)
                    .await
            } else {
                let prompt_session = self
                    .session_manager
                    .get_session(&session_id, false)
                    .await
                    .internal_err_ctx("Failed to load CodePro prompt workspace")?;
                self.codepro_control
                    .register_prompt_run_with_origin(
                        &session_id,
                        &run_id,
                        &codepro_goal,
                        user_message.id.as_deref(),
                        Some(&prompt_session.working_dir),
                        run_input_binding
                            .as_ref()
                            .and_then(|binding| binding.continuation_source.clone()),
                    )
                    .await
            };
            if registration.is_ok() {
                active.durable_execution_bound = true;
                durable_execution_bound = true;
            }
            if let Err(error) = registration {
                drop(active_runs);
                self.clear_active_run(&session_id, &run_id).await;
                let _ = Self::send_active_run_update(cx, &args.session_id, None);
                return Err(codepro_control::acp_error(error));
            }
            if run_input_binding
                .as_ref()
                .is_some_and(|binding| binding.amends_requirements)
            {
                if let Err(error) = agent
                    .bind_codepro_followup_requirement(&session_id, &run_id, &user_message)
                    .await
                {
                    drop(active_runs);
                    self.clear_active_run(&session_id, &run_id).await;
                    let _ = Self::send_active_run_update(cx, &args.session_id, None);
                    return Err(agent_client_protocol::Error::internal_error().data(format!(
                        "Failed to bind the current user amendment: {error}"
                    )));
                }
            }
            drop(active_runs);
        }

        if is_codepro_agent_run {
            user_message.metadata.task_run_id = Some(run_id.clone());
        }
        if let Err(error) = Self::send_active_run_update(cx, &args.session_id, Some(&run_id)) {
            self.clear_active_run(&session_id, &run_id).await;
            return Err(error);
        }

        if prepared_notice.is_none() {
            if let Err(error) = self
                .send_local_inference_progress_update(cx, &args.session_id, &session_id, &agent)
                .await
            {
                self.clear_active_run(&session_id, &run_id).await;
                let _ = Self::send_active_run_update(cx, &args.session_id, None);
                return Err(error);
            }
        }

        if let Some(parsed) = crate::agents::execute_commands::parse_slash_command(&message_text) {
            let full_command = format!("/{}", parsed.command);

            if !Self::is_builtin_agent_command(parsed.command) {
                if let Some(recipe_path) =
                    crate::slash_commands::recipe_slash_command::get_recipe_for_command(
                        &full_command,
                    )
                {
                    if recipe_path.exists() {
                        if let Err(error) = cx.send_notification(SessionNotification::new(
                            args.session_id.clone(),
                            SessionUpdate::AgentMessageChunk(ContentChunk::new(
                                ContentBlock::Text(TextContent::new(format!(
                                    "Running recipe: {}",
                                    full_command
                                ))),
                            )),
                        )) {
                            self.clear_active_run(&session_id, &run_id).await;
                            let _ = Self::send_active_run_update(cx, &args.session_id, None);
                            return Err(error);
                        }
                    }
                }
            }
        }

        let session_config = SessionConfig {
            id: session_id.clone(),
            schedule_id: None,
            max_turns: None,
            retry_config: None,
        };

        let checkpoint_reply = checkpoint_decision.filter(|decision| {
            !matches!(
                decision,
                crate::agents::CodeProCheckpointInputDecision::Resume(_)
            )
        });
        let reply_result = if question_only {
            agent
                .reply_codepro_question(
                    user_message,
                    session_config,
                    Some(cancel_token.clone()),
                    question_run_id.as_deref(),
                )
                .await
        } else if bound_run_cancelled {
            agent
                .reply_codepro_cancelled_run(&session_id, &run_id, user_message)
                .await
        } else if bound_run_completed {
            agent
                .reply_codepro_completed_continuation(&session_id, &run_id, user_message)
                .await
        } else if let Some(result) = prepared_notice {
            result
        } else if let Some(decision) = checkpoint_reply {
            agent
                .reply_codepro_checkpoint_input(
                    user_message,
                    session_config,
                    Some(cancel_token.clone()),
                    run_id.clone(),
                    decision,
                )
                .await
        } else if is_codepro_agent_run {
            agent
                .reply_codepro_with_resume(
                    user_message,
                    session_config,
                    Some(cancel_token.clone()),
                    Some(run_id.clone()),
                    resume_request,
                )
                .await
        } else {
            agent
                .reply(user_message, session_config, Some(cancel_token.clone()))
                .await
        };
        let mut stream = match reply_result {
            Ok(stream) => stream,
            Err(error) => {
                let stop_reason = self.clear_active_run(&session_id, &run_id).await;
                let _ = Self::send_active_run_update(cx, &args.session_id, None);
                if stop_reason == ActivePromptStopReason::ControlPause {
                    return Ok(PromptResponse::new(StopReason::Cancelled));
                }
                return Err(agent_client_protocol::Error::internal_error()
                    .data(format!("Error getting agent reply: {error}")));
            }
        };
        let mut codepro_updates = if is_codepro_agent_run
            && self.codepro_control.runtime().mode_policy().effective()
                != crate::agents::control_plane::CodeProRuntimeMode::Legacy
        {
            Some(self.codepro_control.runtime().subscribe_updates())
        } else {
            None
        };

        let mut was_cancelled = cancel_token.is_cancelled();
        let mut first_event_logged = false;
        let mut event_count: u32 = 0;
        let mut terminal_message_seen = false;
        let mut turn_terminal_notification_seen = None;
        // Streaming chain buffer: tracks consecutive tool requests across
        // `AgentEvent::Message` events so chains that span multiple rows are
        // still registered. Sequential tool use (Bedrock/Anthropic) yields
        // request → response → request → response across separate
        // assistant/user messages, so tool responses are chain-neutral; only
        // non-tool content (text, thinking, image, etc.) breaks the run.
        // Holds `(tool_call_id, message_id_of_owning_row)` in arrival order;
        // re-registered eagerly each time a request arrives so
        // `handle_tool_response` finds the chain when subsequent responses
        // are processed.
        let mut chain_buffer: Vec<(String, String)> = Vec::new();
        let mut stream_error = None;

        'streaming: loop {
            let event = loop {
                let Some(updates) = codepro_updates.as_mut() else {
                    match tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
                        .await
                    {
                        Ok(event) => break event,
                        Err(_) => {
                            match load_persisted_codepro_terminal_message(
                                &self.session_manager,
                                &session_id,
                                &run_id,
                                &source_user_message_id,
                            )
                            .await
                            {
                                Ok(Some(message)) => {
                                    break Some(Ok(crate::agents::AgentEvent::Message(message)));
                                }
                                Ok(None) => continue,
                                Err(error) => {
                                    stream_error = Some(error);
                                    break 'streaming;
                                }
                            }
                        }
                    }
                };
                tokio::select! {
                    // A continuously-ready model stream must not starve live control-plane
                    // snapshots. Drain each ready burst so one refresh represents its newest
                    // sequence instead of starving user-visible AgentEvents in the other direction.
                    biased;
                    update = updates.recv() => {
                        match update {
                            Ok(update) => {
                                if let Some(sequence) = coalesce_codepro_runtime_update_burst(
                                    update,
                                    updates,
                                    &session_id,
                                    &run_id,
                                ) {
                                    match self
                                        .send_latest_codepro_update(&session_id, &run_id)
                                        .await
                                    {
                                        Ok(sent) => tracing::trace!(
                                            session_id,
                                            run_id,
                                            sequence,
                                            sent,
                                            "published coalesced CodePro snapshot refresh while the message stream remained active"
                                        ),
                                        Err(error) => tracing::warn!(
                                            session_id,
                                            run_id,
                                            sequence,
                                            %error,
                                            "failed to publish a live CodePro snapshot; preserving the message stream"
                                        ),
                                    }
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                tracing::debug!(
                                    session_id,
                                    run_id,
                                    "CodePro update receiver lagged; the next available update will refresh the latest snapshot"
                                );
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                break stream.next().await;
                            }
                        }
                    }
                    event = stream.next() => break event,
                    persisted_terminal = async {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        load_persisted_codepro_terminal_message(
                            &self.session_manager,
                            &session_id,
                            &run_id,
                            &source_user_message_id,
                        ).await
                    } => {
                        match persisted_terminal {
                            Ok(Some(message)) => {
                                break Some(Ok(crate::agents::AgentEvent::Message(message)));
                            }
                            Ok(None) => {}
                            Err(error) => {
                                stream_error = Some(error);
                                break 'streaming;
                            }
                        }
                    }
                }
            };
            let Some(event) = event else {
                break;
            };
            if cancel_token.is_cancelled() {
                was_cancelled = true;
                if is_codepro_agent_run {
                    let cleanup_started = std::time::Instant::now();
                    tracing::info!(session_id, run_id,
                        "Consuming cancelled Agent stream for bounded cleanup without publishing prose");
                    // The Agent stream owns pending message persistence. Dropping it
                    // at an intermediate usage/tool event can discard text already
                    // delivered to the desktop. Let cancellation cleanup run, but
                    // do not forward more prose or wait indefinitely for cleanup.
                    let cleanup = async {
                        while let Some(event) = stream.next().await {
                            if event.is_err() {
                                tracing::warn!(
                                    session_id,
                                    run_id,
                                    "Cancelled Agent stream ended with a cleanup error"
                                );
                                break;
                            }
                        }
                    };
                    if tokio::time::timeout(std::time::Duration::from_secs(5), cleanup)
                        .await
                        .is_err()
                    {
                        tracing::warn!(session_id, run_id,
                            "Cancelled Agent stream cleanup timed out; pending history may be incomplete");
                    }
                    tracing::info!(
                        session_id,
                        run_id,
                        elapsed_ms = cleanup_started.elapsed().as_millis() as u64,
                        "Cancelled Agent stream cleanup consumption ended"
                    );
                }
                break;
            }
            event_count += 1;
            if !first_event_logged {
                debug!(
                    target: "perf",
                    sid = %sid,
                    ttft_ms = t_start.elapsed().as_millis() as u64,
                    "perf: prompt first stream event (time-to-first-token from prompt start)"
                );
                first_event_logged = true;
            }

            match event {
                Ok(crate::agents::AgentEvent::Message(message)) => {
                    // Agent persists messages via session_manager.add_message() internally.
                    let stored_message_id = message.id.clone();
                    let turn_terminal_notification = message.content.iter().find_map(|content| {
                        content
                            .as_system_notification()
                            .filter(|notification| {
                                turn_terminal_matches_prompt(
                                    notification,
                                    &run_id,
                                    &source_user_message_id,
                                )
                            })
                            .cloned()
                    });

                    if !should_stream_message_to_acp_client(&message) {
                        continue;
                    }

                    let mut sessions = self.sessions.lock().await;
                    let Some(session) = sessions.get_mut(&session_id) else {
                        stream_error = Some(
                            agent_client_protocol::Error::invalid_params()
                                .data(format!("Session not found: {}", session_id)),
                        );
                        break;
                    };

                    for content_item in &message.content {
                        if let Some(error) = prompt_error_from_message_content(content_item) {
                            stream_error = Some(error);
                            break;
                        }

                        match content_item {
                            MessageContent::ToolRequest(tr) => {
                                if let Some(msg_id) = stored_message_id.as_deref() {
                                    chain_buffer.push((tr.id.clone(), msg_id.to_string()));
                                    // Re-register eagerly so the chain is in
                                    // place by the time the matching
                                    // `tool_response` triggers
                                    // `maybe_summarize_chain` (sequential
                                    // tool use interleaves request/response
                                    // events).
                                    extend_chain_membership(
                                        &chain_buffer,
                                        &mut session.chain_membership,
                                    );
                                }
                            }
                            MessageContent::ToolResponse(_) => {
                                // Chain-neutral: a response between two
                                // requests doesn't break the run, matching
                                // the frontend's `groupContentSections`.
                            }
                            _ => {
                                // Text, thinking, image, etc. end the run.
                                chain_buffer.clear();
                            }
                        }

                        if let Err(error) = self
                            .handle_message_content(
                                content_item,
                                &args.session_id,
                                &session_id,
                                stored_message_id.as_deref(),
                                message.created,
                                &message.role,
                                message.metadata.steer,
                                message.metadata.stream_timing.as_ref(),
                                &agent,
                                session,
                                cx,
                            )
                            .await
                        {
                            stream_error = Some(error);
                            break;
                        }
                    }
                    if stream_error.is_some() {
                        break;
                    }
                    if let Some(notification) = turn_terminal_notification {
                        terminal_message_seen = true;
                        turn_terminal_notification_seen = Some(notification);
                        break 'streaming;
                    }
                }
                Ok(crate::agents::AgentEvent::McpNotification((request_id, notification))) => {
                    if let Some(update) =
                        tool_notifications::tool_notification_update(request_id, notification)
                    {
                        let tool_call_notifier = ToolCallNotifier::new(cx, &args.session_id);
                        tool_call_notifier.send_update(update)?;
                    }
                }
                Ok(crate::agents::AgentEvent::Usage(_))
                | Ok(crate::agents::AgentEvent::HistoryReplaced(_)) => {
                    self.publish_context_usage(cx, &session_id).await?;
                }
                Ok(crate::agents::AgentEvent::MessageUsage { message_id, usage }) => {
                    if self.supports_goose_custom_notifications() {
                        cx.send_notification(GooseSessionNotification {
                            session_id: session_id.clone(),
                            update: GooseSessionUpdate::MessageUsage(message_usage_update(
                                message_id, &usage,
                            )),
                        })?;
                    }
                }
                Err(e) => {
                    stream_error = Some(
                        agent_client_protocol::Error::internal_error()
                            .data(format!("Error in agent response stream: {}", e)),
                    );
                    break;
                }
            }
        }
        was_cancelled |= cancel_token.is_cancelled();

        if is_codepro_agent_run {
            if let Some(notification) = turn_terminal_notification_seen.as_ref() {
                match self
                    .codepro_control
                    .observe_prompt_turn_terminal(&session_id, &run_id, notification)
                    .await
                {
                    Ok(Some(snapshot)) => {
                        let _ = self.send_codepro_update(snapshot);
                    }
                    Ok(None) => {}
                    Err(error) => tracing::error!(
                        session_id,
                        run_id,
                        %error,
                        "Failed to reconcile the CodePro control plane with the committed turn terminal"
                    ),
                }
            }
        }

        {
            let mut sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&session_id) {
                // Final safety net: in case the stream ended without any
                // chain-breaking content, make sure a multi-tool buffer is
                // registered. (Eager registration during the loop usually
                // covers this.)
                extend_chain_membership(&chain_buffer, &mut session.chain_membership);
            }
        }
        let stop_reason_before_clear = {
            let active_prompt_runs = self.active_prompt_runs.lock().await;
            active_prompt_stop_reason(&active_prompt_runs, &session_id, &run_id)
        };
        let paused_before_clear = stop_reason_before_clear == ActivePromptStopReason::ControlPause;
        let cancelled_before_clear = was_cancelled && !paused_before_clear;
        let stream_failed = stream_error.is_some();
        if cancelled_before_clear && durable_execution_bound {
            if let Some(snapshot) = self
                .codepro_control
                .cancel_prompt_run(&session_id, &run_id)
                .await
                .map_err(codepro_control::acp_error)?
            {
                self.send_codepro_update(snapshot)?;
            }
        } else if stream_failed && durable_execution_bound && !paused_before_clear {
            match self
                .codepro_control
                .fail_prompt_run(&session_id, &run_id, "CodePro agent response stream failed")
                .await
            {
                Ok(Some(snapshot)) => {
                    let _ = self.send_codepro_update(snapshot);
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(
                        session_id,
                        run_id,
                        %error,
                        "Failed to terminalize CodePro run after agent stream failure"
                    );
                }
            }
        }
        let cleared_stop_reason = self.clear_active_run(&session_id, &run_id).await;
        let effective_stop_reason = if cleared_stop_reason == ActivePromptStopReason::None {
            stop_reason_before_clear
        } else {
            cleared_stop_reason
        };
        let control_paused = effective_stop_reason == ActivePromptStopReason::ControlPause;
        let prompt_cancelled = was_cancelled && !control_paused;
        if prompt_cancelled && !cancelled_before_clear && durable_execution_bound {
            if let Some(snapshot) = self
                .codepro_control
                .cancel_prompt_run(&session_id, &run_id)
                .await
                .map_err(codepro_control::acp_error)?
            {
                self.send_codepro_update(snapshot)?;
            }
        } else if !prompt_cancelled && !stream_failed && is_codepro_agent_run {
            // A CodePro run can reach durable completion immediately before its result
            // stream closes. Recover and publish that committed terminal here instead
            // of leaving the desktop on a stale "running" snapshot. The agent commits
            // the terminal before returning its result stream, so absence here remains
            // a genuine non-terminal run and falls back to the latest snapshot.
            if !terminal_message_seen {
                if let Some(terminal) = load_persisted_codepro_terminal_message(
                    &self.session_manager,
                    &session_id,
                    &run_id,
                    &source_user_message_id,
                )
                .await?
                {
                    send_persisted_terminal_message(
                        cx,
                        self.supports_goose_custom_notifications(),
                        &session_id,
                        &terminal,
                    )?;
                }
            }
            // The terminal report and the control-plane projection are separate wire
            // contracts. Always publish both: a client that receives the report must not
            // retain the last running projection, and a client that rejects/misses the
            // report can still observe the authoritative durable terminal and replay it.
            self.send_latest_codepro_update(&session_id, &run_id)
                .await?;
        }
        if prompt_cancelled && durable_execution_bound {
            let persisted_session = self
                .session_manager
                .get_session(&session_id, true)
                .await
                .internal_err_ctx("Failed to load cancelled CodePro turn")?;
            if let Some(terminal) =
                persisted_session
                    .conversation
                    .as_ref()
                    .and_then(|conversation| {
                        build_cancelled_codepro_terminal_message(
                            &session_id,
                            &run_id,
                            &source_user_message_id,
                            conversation.messages(),
                        )
                    })
            {
                self.session_manager
                    .add_message(&session_id, &terminal)
                    .await
                    .internal_err_ctx("Failed to persist cancelled CodePro terminal")?;
                send_persisted_terminal_message(
                    cx,
                    self.supports_goose_custom_notifications(),
                    &session_id,
                    &terminal,
                )?;
            }
        }
        Self::send_active_run_update(cx, &args.session_id, None)?;
        if let Some(error) = stream_error.filter(|_| !control_paused) {
            return Err(error);
        }

        let session = self
            .session_manager
            .get_session(&session_id, false)
            .await
            .internal_err_ctx("Failed to load session")?;
        let totals = self
            .session_manager
            .get_session_usage_totals(&session_id)
            .await
            .unwrap_or_default();
        if let Some(updates) = build_usage_updates(&session, &totals) {
            if self.supports_goose_custom_notifications() {
                cx.send_notification(updates.custom)?;
            }
            // Standard ACP notification — emitted alongside the custom one for
            // backwards compatibility. Remove once all known clients have
            // migrated to `_goose/unstable/session/update`.
            cx.send_notification(SessionNotification::new(
                args.session_id.clone(),
                SessionUpdate::UsageUpdate(updates.standard),
            ))?;
        }

        debug!(
            target: "perf",
            sid = %sid,
            ms = t_start.elapsed().as_millis() as u64,
            events = event_count,
            cancelled = prompt_cancelled,
            control_paused,
            "perf: prompt done"
        );
        let stop_reason = if prompt_cancelled || control_paused {
            StopReason::Cancelled
        } else {
            StopReason::EndTurn
        };

        let mut response = PromptResponse::new(stop_reason);
        if let Some(usage) = build_prompt_usage(&session) {
            response = response.usage(usage);
        }
        if !prompt_cancelled && !control_paused {
            self.schedule_idle_compaction(&session_id).await;
        }
        Ok(response)
    }

    async fn on_steer_session(
        &self,
        req: SteerSessionRequest,
    ) -> Result<SteerSessionResponse, agent_client_protocol::Error> {
        if req.prompt.is_empty() {
            return Err(
                agent_client_protocol::Error::invalid_params().data("prompt must not be empty")
            );
        }

        let _session_access = self
            .acquire_session_dispatch_access(&req.session_id, false)
            .await?;
        let persisted_session = self
            .session_manager
            .get_session(&req.session_id, false)
            .await
            .internal_err_ctx("Failed to load session workspace")?;
        let resource_workspace = authoritative_resource_workspace(&persisted_session)?;

        self.require_active_run(&req.session_id, &req.expected_run_id)
            .await?;
        let agent = self.get_session_agent(&req.session_id).await?;
        let active_run_id = self
            .require_active_run(&req.session_id, &req.expected_run_id)
            .await?;

        let message =
            Self::convert_acp_prompt_to_message(&req.prompt, resource_workspace.as_deref())?;
        if message.content.is_empty() {
            return Err(agent_client_protocol::Error::invalid_params()
                .data("prompt must contain steerable content"));
        }

        let message_id = format!("steer_{}", Uuid::new_v4());
        let message = message.with_id(message_id.clone());
        if persisted_session.session_type == SessionType::CodePro
            && self.codepro_control.tracks_prompt_runs()
        {
            agent
                .steer_codepro_run(&req.session_id, &active_run_id, message)
                .await
                .map_err(|error| {
                    agent_client_protocol::Error::invalid_params().data(error.to_string())
                })?;
        } else {
            agent.steer(&req.session_id, message).await;
        }

        if let Some(cx) = self.client_cx.get() {
            let _ = Self::send_queued_steer_update(
                cx,
                &SessionId::new(req.session_id.clone()),
                &message_id,
                &active_run_id,
            );
        }

        Ok(SteerSessionResponse {
            run_id: active_run_id,
            message_id,
        })
    }

    async fn on_cancel(
        &self,
        args: CancelNotification,
    ) -> Result<(), agent_client_protocol::Error> {
        debug!(?args, "cancel request");

        let session_id = args.session_id.0.to_string();
        let snapshot = {
            let mut active_prompt_runs = self.active_prompt_runs.lock().await;
            let Some(active) = active_prompt_runs.get_mut(&session_id) else {
                return Ok(());
            };
            let snapshot = if active.durable_execution_bound {
                let snapshot = self
                    .codepro_control
                    .pause_prompt_run(&session_id, &active.run_id)
                    .await
                    .map_err(codepro_control::acp_error)?;
                active.stop_reason = ActivePromptStopReason::ControlPause;
                Some(snapshot)
            } else {
                active.stop_reason = ActivePromptStopReason::UserCancel;
                None
            };
            // A committed pause is not a cancellation of the business goal.
            // Explicit task cancellation retains its separate control path.
            active.cancel_token.cancel();
            snapshot
        };
        if let Some(snapshot) = snapshot {
            self.send_codepro_update(snapshot)?;
        }
        info!(session_id = %session_id, "prompt execution stopped");
        Ok(())
    }

    async fn on_set_model(
        &self,
        session_id: &str,
        model_id: &str,
    ) -> Result<(), agent_client_protocol::Error> {
        let agent = self.get_session_agent(session_id).await?;
        let current_provider = agent
            .provider()
            .await
            .internal_err_ctx("Failed to get provider")?;
        let provider_name = current_provider.get_name().to_string();
        self.validate_provider_model_selection(&provider_name, model_id)
            .await?;
        let current_model_config = agent
            .model_config_for_session(session_id)
            .await
            .internal_err_ctx("Failed to resolve model config")?;
        let model_config =
            crate::model_config::model_config_from_user_config_with_session_settings(
                &provider_name,
                model_id,
                Some(&current_model_config),
                None,
                None,
            )
            .invalid_params_err_ctx("Invalid model config")?;
        agent
            .recreate_provider_for_session(session_id, &provider_name, model_config)
            .await
            .internal_err_ctx("Failed to recreate provider")?;
        // model_config is already updated on the session by the agent's update_provider call.
        Ok(())
    }

    async fn validate_provider_model_selection(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Result<(), agent_client_protocol::Error> {
        ensure_provider_activation_supported(provider_id)?;
        // Custom endpoints can change their served models independently of the saved
        // setup snapshot. Use the same live validation as default/role selection;
        // a cached inventory must neither reject a new model nor allow a removed one.
        if providers::validate_saved_custom_provider_models(provider_id, &[model_id.to_string()])
            .await?
        {
            return Ok(());
        }
        let entries = self
            .provider_inventory
            .entries(&[provider_id.to_string()])
            .await
            .internal_err_ctx("Failed to read provider inventory")?;
        let entry = entries
            .into_iter()
            .find(|entry| entry.provider_id == provider_id)
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("Unknown provider: {provider_id}"))
            })?;
        crate::acp::server::config::validate_provider_model(
            provider_id,
            model_id,
            &entry.default_model,
            entry.models.iter().map(|model| model.id.as_str()),
        )
    }

    async fn build_config_update(
        &self,
        session_id: &SessionId,
    ) -> Result<(SessionNotification, Vec<SessionConfigOption>), agent_client_protocol::Error> {
        let session = self
            .session_manager
            .get_session(&session_id.0, false)
            .await
            .internal_err()?;
        let agent = self.get_session_agent(&session_id.0).await?;
        let provider = agent
            .provider()
            .await
            .internal_err_ctx("Failed to get provider")?;
        let provider_name = provider.get_name().to_string();
        let current_model_config = agent
            .model_config_for_session(&session_id.0)
            .await
            .internal_err_ctx("Failed to resolve model config")?;
        let current_model = current_model_config.model_name.clone();
        let goose_mode = agent.goose_mode().await;
        let inventory = self
            .provider_inventory
            .entry_for_provider(&provider_name)
            .await
            .internal_err()?;
        let Some(inventory) = inventory else {
            return Err(agent_client_protocol::Error::internal_error()
                .data(format!("Unknown provider inventory: {}", provider_name)));
        };
        let model_state = build_model_state(current_model.as_str(), &inventory);
        let mode_state = build_mode_state(goose_mode)?;
        let provider_options = build_provider_options(Some(&provider_name)).await;
        let config_options = build_config_options(
            &mode_state,
            &model_state,
            &current_model_config,
            session_provider_selection(&session),
            provider_options,
        );
        let notification = SessionNotification::new(
            session_id.clone(),
            SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(config_options.clone())),
        );
        Ok((notification, config_options))
    }

    async fn on_set_mode(
        &self,
        session_id: &str,
        mode_id: &str,
    ) -> Result<SetSessionModeResponse, agent_client_protocol::Error> {
        let mode = mode_id.parse::<GooseMode>().map_err(|_| {
            agent_client_protocol::Error::invalid_params()
                .data(format!("Invalid mode: {}", mode_id))
        })?;

        let agent = self.get_session_agent(session_id).await?;
        agent
            .update_goose_mode(mode, session_id)
            .await
            .internal_err_ctx("Failed to update mode")?;

        // goose_mode is already updated on the session above.

        Ok(SetSessionModeResponse::new())
    }

    async fn on_set_thinking_effort(
        &self,
        session_id: &str,
        effort_id: &str,
    ) -> Result<(), agent_client_protocol::Error> {
        let effort = effort_id
            .parse::<goose_providers::thinking::ThinkingEffort>()
            .map_err(|_| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("Invalid thinking effort: {}", effort_id))
            })?;
        let agent = self.get_session_agent(session_id).await?;
        agent
            .update_thinking_effort(session_id, effort)
            .await
            .internal_err_ctx("Failed to update thinking effort")?;

        Ok(())
    }

    async fn update_provider(
        &self,
        session_id: &str,
        provider_name: &str,
        model_name: Option<&str>,
        context_limit: Option<usize>,
        request_params: Option<std::collections::HashMap<String, serde_json::Value>>,
    ) -> Result<(), agent_client_protocol::Error> {
        let config = self.config()?;
        let agent = self.get_session_agent(session_id).await?;
        let current_provider = agent
            .provider()
            .await
            .internal_err_ctx("Failed to get provider")?;
        let current_provider_name = current_provider.get_name();
        let current_model_config = agent
            .model_config_for_session(session_id)
            .await
            .internal_err_ctx("Failed to resolve model config")?;
        let current_model = current_model_config.model_name.clone();
        let use_default_provider = provider_name == DEFAULT_PROVIDER_ID;
        let resolved_provider_name = if use_default_provider {
            config
                .get_goose_provider()
                .internal_err_ctx("Failed to resolve default provider from config")?
        } else {
            provider_name.to_string()
        };
        ensure_provider_activation_supported(&resolved_provider_name)?;
        let is_changing_provider = resolved_provider_name != current_provider_name;
        let default_model = if let Some(model_name) = model_name {
            model_name.to_string()
        } else if use_default_provider {
            config
                .get_goose_model()
                .internal_err_ctx("Failed to resolve default model from config")?
        } else if is_changing_provider {
            crate::providers::get_from_registry(&resolved_provider_name)
                .await
                .ok()
                .map(|entry| entry.metadata().default_model.clone())
                .unwrap_or(ACP_CURRENT_MODEL.to_string())
        } else {
            current_model
        };
        let model = model_name.unwrap_or(&default_model);
        self.validate_provider_model_selection(&resolved_provider_name, model)
            .await?;
        let model_config =
            crate::model_config::model_config_from_user_config_with_session_settings(
                &resolved_provider_name,
                model,
                Some(&current_model_config),
                request_params,
                context_limit,
            )
            .invalid_params_err_ctx("Invalid model config")?;

        let session = self
            .session_manager
            .get_session(session_id, false)
            .await
            .internal_err_ctx("Failed to get session")?;
        let extensions = EnabledExtensionsState::extensions_or_default(
            Some(&session.extension_data),
            Config::global(),
        );
        let provider = self
            .create_provider(
                &resolved_provider_name,
                extensions,
                Some(session.working_dir.clone()),
            )
            .await
            .internal_err_ctx("Failed to recreate provider")?;
        provider
            .update_mode(session_id, agent.goose_mode().await)
            .await
            .map_err(|error| {
                agent_client_protocol::Error::internal_error()
                    .data(format!("Provider rejected mode update: {error}"))
            })?;
        agent
            .update_provider(provider, model_config, session_id)
            .await
            .internal_err_ctx("Failed to persist provider")?;

        // provider_name is already updated on the session by the agent's update_provider call.
        Ok(())
    }

    async fn on_fork_session(
        &self,
        cx: &ConnectionTo<Client>,
        args: ForkSessionRequest,
    ) -> Result<ForkSessionResponse, agent_client_protocol::Error> {
        self.handle_fork_session(cx, args).await
    }

    async fn on_close_session(
        &self,
        session_id: &str,
    ) -> Result<CloseSessionResponse, agent_client_protocol::Error> {
        #[cfg(any(windows, target_os = "macos"))]
        let _lifecycle = workspace_lease::lock_session_lifecycle(session_id)
            .await
            .internal_err_ctx("Failed to lock CodePro session lifecycle")?;
        #[cfg(any(windows, target_os = "macos"))]
        let close_transaction = workspace_lease::begin_session_lifecycle_transaction(session_id)
            .internal_err_ctx("Failed to close CodePro session access")?;

        {
            let mut active_prompt_runs = self.active_prompt_runs.lock().await;
            cancel_active_run(&mut active_prompt_runs, session_id);
        }

        #[cfg(any(windows, target_os = "macos"))]
        close_transaction
            .wait_for_idle()
            .await
            .internal_err_ctx("Failed to wait for active CodePro session access")?;
        #[cfg(any(windows, target_os = "macos"))]
        workspace_lease::revoke_session_workspace_authority(session_id)
            .internal_err_ctx("Failed to revoke CodePro session workspace authority")?;
        #[cfg(any(windows, target_os = "macos"))]
        close_transaction.commit_closed();
        self.closed_session_ids
            .lock()
            .await
            .insert(session_id.to_string());

        let mut sessions = self.sessions.lock().await;
        sessions.remove(session_id);
        drop(sessions);

        let remove_result = self
            .agent_manager
            .remove_session_if_loaded(session_id)
            .await;
        self.permission_manager()
            .invalidate_scoped_permissions(session_id);
        #[cfg(any(windows, target_os = "macos"))]
        {
            let lease_result = workspace_lease::release_session_workspace_lease(session_id);
            finish_session_workspace_cleanup(
                remove_result,
                lease_result,
                "Failed to remove in-memory agent",
            )?;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        remove_result.internal_err_ctx("Failed to remove in-memory agent")?;

        info!(session_id = %session_id, "ACP session closed");
        Ok(CloseSessionResponse::new())
    }
}

pub struct GooseAcpHandler {
    pub agent: Arc<GooseAcpAgent>,
}

pub fn serve<R, W>(
    agent: Arc<GooseAcpAgent>,
    read: R,
    write: W,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>>
where
    R: futures::AsyncRead + Unpin + Send + 'static,
    W: futures::AsyncWrite + Unpin + Send + 'static,
{
    Box::pin(async move {
        let handler = GooseAcpHandler { agent };

        SacpAgent
            .builder()
            .name("goose-acp")
            .with_handler(handler)
            .connect_to(ByteStreams::new(write, read))
            .await?;

        Ok(())
    })
}

/// A lazily-initialized agent connection used by the HTTP/WebSocket transport.
///
/// The `agent-client-protocol-http` server takes a synchronous factory that
/// yields a [`ConnectTo<Client>`] per connection, but creating a goose agent is
/// async. Agent creation is therefore deferred into [`ConnectTo::connect_to`],
/// which runs as the connection's serving future.
pub struct GooseAgentConnection {
    server: Arc<crate::acp::server_factory::AcpServer>,
}

impl GooseAgentConnection {
    pub fn new(server: Arc<crate::acp::server_factory::AcpServer>) -> Self {
        Self { server }
    }
}

impl agent_client_protocol::ConnectTo<Client> for GooseAgentConnection {
    async fn connect_to(
        self,
        client: impl agent_client_protocol::ConnectTo<SacpAgent>,
    ) -> std::result::Result<(), agent_client_protocol::Error> {
        let agent = self.server.create_agent().await.internal_err()?;
        let handler = GooseAcpHandler { agent };
        SacpAgent
            .builder()
            .name("goose-acp")
            .with_handler(handler)
            .connect_to(client)
            .await
    }
}

pub async fn run(builtins: Vec<String>) -> Result<()> {
    info!("listening on stdio");

    let outgoing = tokio::io::stdout().compat_write();
    let incoming = tokio::io::stdin().compat();

    let server = crate::acp::server_factory::AcpServer::new(
        crate::acp::server_factory::AcpServerFactoryConfig {
            builtins,
            data_dir: Paths::data_dir(),
            config_dir: Paths::config_dir(),
            goose_platform: GoosePlatform::GooseCli,
            additional_source_roots: Vec::new(),
        },
    );
    let agent = server.create_agent().await?;
    serve(agent, incoming, outgoing).await
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("../../tests/fixtures/acp_clarification_continuity.rs");
    use crate::acp::server::tool_calls::enrichment::with_tool_chain_summary_meta;
    use crate::conversation::message::ToolRequest;
    use crate::session::session_manager::SessionType;
    use agent_client_protocol::schema::v1::{
        EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerSse, McpServerStdio,
        PermissionOptionId, ResourceLink, SelectedPermissionOutcome,
    };
    use goose_providers::conversation::token_usage::Usage as TokenUsage;
    use rmcp::model::CallToolRequestParams;
    use std::path::PathBuf;
    use tempfile::TempDir;
    use test_case::test_case;

    #[test]
    fn workspace_resume_accepts_empty_control_prompt_without_relaxing_user_input() {
        let mut meta = Meta::new();
        meta.insert(
            CODEPRO_TURN_RETRY_META_KEY.into(),
            serde_json::json!({
                "schemaVersion": 1,
                "strategy": "resume_after_workspace",
                "checkpointId": null,
                "sourceRunId": "original-run",
                "sourceUserMessageId": "original-message"
            }),
        );
        let mut retry = parse_codepro_turn_retry_metadata(Some(&meta))
            .unwrap()
            .unwrap();
        let converted = GooseAcpAgent::convert_acp_turn_prompt_to_message(
            &[],
            None,
            SessionType::CodePro,
            Some(&retry),
        )
        .unwrap();
        assert!(
            converted.content.is_empty(),
            "only the agent restores the stored source"
        );
        assert!(GooseAcpAgent::convert_acp_turn_prompt_to_message(
            &[],
            None,
            SessionType::User,
            Some(&retry),
        )
        .is_err());
        assert!(GooseAcpAgent::convert_acp_turn_prompt_to_message(
            &[],
            None,
            SessionType::CodePro,
            None,
        )
        .is_err());
        for strategy in [
            CodeProTurnRetryStrategy::ReplayUserRequest,
            CodeProTurnRetryStrategy::ContinueCheckpoint,
            CodeProTurnRetryStrategy::RetryFailedValidation,
        ] {
            retry.strategy = strategy;
            assert!(GooseAcpAgent::convert_acp_turn_prompt_to_message(
                &[],
                None,
                SessionType::CodePro,
                Some(&retry),
            )
            .is_err());
        }
        retry.strategy = CodeProTurnRetryStrategy::ResumeAfterWorkspace;
        assert!(GooseAcpAgent::convert_acp_turn_prompt_to_message(
            &[ContentBlock::Image(ImageContent::new(
                "invalid!",
                "image/png"
            ))],
            None,
            SessionType::CodePro,
            Some(&retry),
        )
        .is_err());
    }

    #[test]
    fn image_only_acp_conversion_rejects_invalid_and_mixed_attachments() {
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
        for (data, mime) in [
            ("invalid!base64", "image/png"),
            (PNG, "text/plain"),
            ("", "image/png"),
            (" ", "image/png"),
            ("AA", "image/png"),
            ("AB==", "image/png"),
            (PNG, ""),
        ] {
            for mut blocks in [
                Vec::new(),
                vec![ContentBlock::Image(ImageContent::new(PNG, "image/png"))],
                vec![ContentBlock::Text(TextContent::new("caption"))],
            ] {
                blocks.push(ContentBlock::Image(ImageContent::new(data, mime)));
                assert!(
                    GooseAcpAgent::convert_acp_prompt_to_message(&blocks, None).is_err(),
                    "invalid image {mime:?}/{data:?} must reject the entire prompt"
                );
            }
        }
        assert!(GooseAcpAgent::convert_acp_prompt_to_message(&[], None).is_err());
        assert!(GooseAcpAgent::convert_acp_prompt_to_message(
            &[ContentBlock::Text(TextContent::new(" \n "))],
            None
        )
        .is_err());
        for blocks in [
            vec![ContentBlock::Image(ImageContent::new(PNG, "image/png"))],
            vec![
                ContentBlock::Text(TextContent::new("继续")),
                ContentBlock::Image(ImageContent::new(PNG, "image/png")),
            ],
            vec![ContentBlock::Text(TextContent::new("继续"))],
        ] {
            assert!(GooseAcpAgent::convert_acp_prompt_to_message(&blocks, None).is_ok());
        }
    }

    #[test]
    fn live_acp_stream_hides_user_message_echoes() {
        let hidden_resume_source = Message::user()
            .with_id("source-user-1")
            .with_text("create the project")
            .with_visibility(false, true);
        let visible_request = Message::user()
            .with_id("source-user-2")
            .with_text("create the project");
        let visible_steer = Message::user()
            .with_id("source-user-3")
            .with_text("adjust the project")
            .with_steer();
        let visible_tool_response = Message::user().with_tool_response(
            "tool-1",
            Ok(rmcp::model::CallToolResult::success(Vec::new())),
        );
        let visible_response = Message::assistant().with_text("project created");

        assert!(!should_stream_message_to_acp_client(&hidden_resume_source));
        assert!(!should_stream_message_to_acp_client(&visible_request));
        assert!(should_stream_message_to_acp_client(&visible_steer));
        assert!(should_stream_message_to_acp_client(&visible_tool_response));
        assert!(should_stream_message_to_acp_client(&visible_response));
    }

    #[test]
    fn e2e_repair_activity_preserves_identity_and_kind_on_public_wire() {
        let started_at = chrono::DateTime::parse_from_rfc3339("2026-08-29T01:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let finished_at = chrono::DateTime::parse_from_rfc3339("2026-08-29T01:00:03Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut event = ActivityEvent {
            schema_version: crate::agents::ACTIVITY_EVENT_SCHEMA_VERSION,
            event_id: "event-1".to_string(),
            event_type: ActivityEventKind::CommandCompleted,
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            task_id: Some("task-1".to_string()),
            parent_task_id: None,
            agent_role: Some(crate::agents::AgentRole::Coder),
            effective_model: None,
            status: ActivityEventStatus::Completed,
            started_at,
            finished_at: Some(finished_at),
            title: "Updated implementation".to_string(),
            technical_details: Some(
                "compiled output token=do-not-publish\nsystemPrompt=private draft".to_string(),
            ),
            path: Some(PathBuf::from("src/main.rs")),
            command_summary: Some("cargo test -p goose".to_string()),
            exit_code: Some(0),
            diff_summary: None,
            failure_kind: None,
            risk_tier: None,
            previous_risk_tier: None,
            risk_reasons: Vec::new(),
            selected_roles: Vec::new(),
            review_required: None,
            routing_evidence: None,
            include_in_model_context: false,
            retryable: false,
            retry_from_event_id: None,
        };

        let StatusMessage::Progress {
            data: Some(data), ..
        } = public_activity_status(&event)
        else {
            panic!("expected structured public activity");
        };
        let public: ActivityEvent = serde_json::from_value(data).unwrap();
        assert_eq!(public.event_id, event.event_id);
        assert_eq!(public.event_type, event.event_type);
        assert_eq!(public.status, event.status);
        assert_eq!(public.run_id, event.run_id);
        assert_eq!(public.task_id, event.task_id);
        assert_eq!(public.path, event.path);
        assert_eq!(public.command_summary, event.command_summary);
        let output = public.technical_details.unwrap();
        assert!(output.contains("token=[REDACTED]"));
        assert!(!output.contains("do-not-publish"));
        assert!(!output.contains("private draft"));

        event.event_type = ActivityEventKind::StrategySelected;
        event.agent_role = None;
        let StatusMessage::Progress {
            data: Some(data), ..
        } = public_activity_status(&event)
        else {
            panic!("expected structured strategy event");
        };
        assert_eq!(data["event_type"], "strategy_selected");
        assert_eq!(data["event_id"], event.event_id);
    }

    #[test]
    fn unverified_provider_activation_fails_closed() {
        for provider_id in ["zai", "nvidia"] {
            assert!(ensure_provider_activation_supported(provider_id).is_err());
        }
        assert!(ensure_provider_activation_supported("openai").is_ok());
    }

    #[test]
    fn permission_request_meta_carries_only_fixed_codepro_context() {
        let meta = codepro_permission_request_meta(
            Some(crate::conversation::message::ToolPermissionClass::HighRisk),
            Some(crate::conversation::message::ToolExtensionSource::ExternalHttp),
            Some(crate::conversation::message::ToolAuthorizationScope::Task),
            None,
        );

        assert_eq!(
            meta.get("codepro"),
            Some(&serde_json::json!({
                "permissionClass": "high_risk",
                "extensionSource": "external_http",
                "authorizationScope": "task"
            }))
        );
    }

    #[test]
    fn permission_tool_call_update_carries_raw_tool_identity() {
        let update = permission_tool_call_update(
            "memory-card".to_string(),
            "project_memory_remember".to_string(),
            serde_json::Map::from_iter([(
                "scope".to_string(),
                serde_json::Value::String("user".to_string()),
            )]),
            None,
        );
        let value = serde_json::to_value(update).expect("permission update must serialize");

        assert_eq!(
            value.pointer("/_meta/goose/toolCall/toolName"),
            Some(&serde_json::json!("project_memory_remember")),
            "permission updates must preserve raw tool identity instead of relying on title",
        );
        assert_eq!(
            value.pointer("/title"),
            Some(&serde_json::json!("project memory remember")),
        );
    }

    #[test]
    fn permission_options_are_constrained_by_host_risk_and_scope() {
        fn kinds(
            permission_class: Option<ToolPermissionClass>,
            authorization_scope: Option<ToolAuthorizationScope>,
        ) -> Vec<String> {
            permission_options_for_context(permission_class, authorization_scope)
                .into_iter()
                .map(|option| {
                    serde_json::to_value(option.kind)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .into()
                })
                .collect()
        }

        assert_eq!(
            kinds(
                Some(ToolPermissionClass::Forbidden),
                Some(ToolAuthorizationScope::Session),
            ),
            vec!["reject_once", "reject_always"]
        );
        for class in [
            ToolPermissionClass::ExternalWrite,
            ToolPermissionClass::HighRisk,
        ] {
            assert_eq!(
                kinds(Some(class), Some(ToolAuthorizationScope::Global)),
                vec!["allow_once", "reject_once", "reject_always"]
            );
            assert_eq!(
                kinds(Some(class), Some(ToolAuthorizationScope::Session)),
                vec!["allow_always", "allow_once", "reject_once", "reject_always"]
            );
        }
        assert_eq!(
            kinds(None, None),
            vec!["allow_once", "reject_once", "reject_always"]
        );
    }

    #[test]
    fn permission_outcomes_are_revalidated_against_host_context() {
        let allow_always = RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            PermissionOptionId::from("allow_always".to_string()),
        ));
        let allow_once = RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
            PermissionOptionId::from("allow_once".to_string()),
        ));

        assert_eq!(
            outcome_to_tool_confirmation_outcome_for_context(
                &allow_always,
                Some(ToolPermissionClass::HighRisk),
                Some(ToolAuthorizationScope::Global),
            ),
            ToolConfirmationOutcome::PolicyDenied
        );
        assert_eq!(
            outcome_to_tool_confirmation_outcome_for_context(
                &allow_always,
                Some(ToolPermissionClass::HighRisk),
                Some(ToolAuthorizationScope::Session),
            ),
            ToolConfirmationOutcome::Selected(PermissionConfirmation {
                principal_type: PrincipalType::Tool,
                permission: Permission::AlwaysAllow,
            })
        );
        assert_eq!(
            outcome_to_tool_confirmation_outcome_for_context(
                &allow_once,
                Some(ToolPermissionClass::Forbidden),
                Some(ToolAuthorizationScope::Session),
            ),
            ToolConfirmationOutcome::Forbidden
        );
        assert_eq!(
            outcome_to_tool_confirmation_outcome_for_context(
                &RequestPermissionOutcome::Cancelled,
                Some(ToolPermissionClass::HighRisk),
                Some(ToolAuthorizationScope::Session),
            ),
            ToolConfirmationOutcome::Cancelled
        );
        assert_eq!(
            outcome_to_tool_confirmation_outcome_for_context(
                &RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    PermissionOptionId::from("unknown".to_string()),
                )),
                Some(ToolPermissionClass::HighRisk),
                Some(ToolAuthorizationScope::Session),
            ),
            ToolConfirmationOutcome::EnvironmentFailure
        );
    }

    #[test]
    fn active_run_finalization_atomically_observes_cancel() {
        let token = CancellationToken::new();
        let mut active_runs = HashMap::from([(
            "session-a".to_string(),
            ActivePromptRun {
                run_id: "run-a".to_string(),
                cancel_token: token,
                stop_reason: ActivePromptStopReason::None,
                durable_execution_bound: false,
            },
        )]);

        assert!(cancel_active_run(&mut active_runs, "session-a"));
        assert_eq!(
            take_active_run_stop_reason(&mut active_runs, "session-a", "run-a"),
            Some(ActivePromptStopReason::UserCancel)
        );
        assert!(!cancel_active_run(&mut active_runs, "session-a"));
    }

    #[test]
    fn third_repair_batch_control_only_interrupts_the_matching_run() {
        let token = CancellationToken::new();
        let mut active_runs = HashMap::from([(
            "session-a".to_string(),
            ActivePromptRun {
                run_id: "run-current".to_string(),
                cancel_token: token.clone(),
                stop_reason: ActivePromptStopReason::None,
                durable_execution_bound: false,
            },
        )]);

        assert!(!stop_active_run(
            &mut active_runs,
            "session-a",
            Some("run-stale"),
            ActivePromptStopReason::ControlPause,
        ));
        assert!(!token.is_cancelled());
        assert!(stop_active_run(
            &mut active_runs,
            "session-a",
            Some("run-current"),
            ActivePromptStopReason::ControlPause,
        ));
        assert!(token.is_cancelled());
        assert_eq!(
            active_prompt_stop_reason(&active_runs, "session-a", "run-current"),
            ActivePromptStopReason::ControlPause
        );
    }

    #[test]
    fn matching_runtime_update_targets_the_active_prompt_for_immediate_refresh() {
        let update = crate::agents::control_plane::RuntimeUpdate {
            session_id: "session-a".to_string(),
            run_id: crate::agents::protocol::RunId::new("run-a").unwrap(),
            last_sequence: 14,
        };

        assert!(codepro_runtime_update_targets_prompt(
            &update,
            "session-a",
            "run-a"
        ));
        assert!(!codepro_runtime_update_targets_prompt(
            &update,
            "session-b",
            "run-a"
        ));
        assert!(!codepro_runtime_update_targets_prompt(
            &update,
            "session-a",
            "run-b"
        ));
    }

    #[test]
    fn coalesces_runtime_update_burst_for_active_prompt() {
        let (updates_tx, mut updates_rx) = tokio::sync::broadcast::channel(8);
        let first = crate::agents::control_plane::RuntimeUpdate {
            session_id: "session-b".to_string(),
            run_id: crate::agents::protocol::RunId::new("run-b").unwrap(),
            last_sequence: 20,
        };
        updates_tx
            .send(crate::agents::control_plane::RuntimeUpdate {
                session_id: "session-a".to_string(),
                run_id: crate::agents::protocol::RunId::new("run-a").unwrap(),
                last_sequence: 10,
            })
            .unwrap();
        updates_tx
            .send(crate::agents::control_plane::RuntimeUpdate {
                session_id: "session-b".to_string(),
                run_id: crate::agents::protocol::RunId::new("run-b").unwrap(),
                last_sequence: 30,
            })
            .unwrap();
        updates_tx
            .send(crate::agents::control_plane::RuntimeUpdate {
                session_id: "session-a".to_string(),
                run_id: crate::agents::protocol::RunId::new("run-a").unwrap(),
                last_sequence: 14,
            })
            .unwrap();

        assert_eq!(
            coalesce_codepro_runtime_update_burst(first, &mut updates_rx, "session-a", "run-a"),
            Some(14)
        );
        assert!(matches!(
            updates_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn codepro_sessions_always_include_the_memory_extension() {
        let mut extensions = vec![builtin_to_extension_config("developer")];

        ensure_required_session_extensions(&SessionType::CodePro, &mut extensions);

        assert!(extensions
            .iter()
            .any(|extension| extension.name() == "codepromemory"));
    }

    #[test]
    fn user_sessions_do_not_receive_codepro_memory() {
        let mut extensions = vec![builtin_to_extension_config("developer")];

        ensure_required_session_extensions(&SessionType::User, &mut extensions);

        assert!(!extensions
            .iter()
            .any(|extension| extension.name() == "codepromemory"));
    }

    #[test]
    fn project_memory_restore_respects_explicit_disable() {
        let mut extensions = vec![builtin_to_extension_config("developer")];

        ensure_required_session_extensions_with_project_memory(
            &SessionType::User,
            &mut extensions,
            false,
        );

        assert!(!extensions
            .iter()
            .any(|extension| extension.name() == "projectmemory"));
    }

    #[test]
    fn writable_codepro_binding_composes_both_memory_extensions() {
        let mut extension_data = ExtensionData::new();
        CodeProWorkspaceBinding::WritableProject {
            path: "D:\\project".to_string(),
            lease_id: "lease-memory-regression".to_string(),
        }
        .to_extension_data(&mut extension_data)
        .unwrap();
        EnabledExtensionsState::new(vec![builtin_to_extension_config("developer")])
            .to_extension_data(&mut extension_data)
            .unwrap();

        let upgraded = required_session_extension_data_with_project_memory(
            &SessionType::CodePro,
            &extension_data,
            true,
        )
        .unwrap()
        .expect("writable CodePro sessions should restore required memory extensions");
        let names = EnabledExtensionsState::from_extension_data(&upgraded)
            .unwrap()
            .extensions
            .into_iter()
            .map(|extension| extension.name().to_string())
            .collect::<Vec<_>>();

        assert!(names.contains(&"codepromemory".to_string()));
        assert!(names.contains(&"projectmemory".to_string()));
    }

    #[test]
    fn writable_codepro_upgrade_restores_developer_tools_after_root_binding() {
        let mut extension_data = ExtensionData::new();
        CodeProWorkspaceBinding::WritableProject {
            path: "D:\\project".to_string(),
            lease_id: "lease-read-only-analysis".to_string(),
        }
        .to_extension_data(&mut extension_data)
        .unwrap();
        EnabledExtensionsState::new(Vec::new())
            .to_extension_data(&mut extension_data)
            .unwrap();

        let upgraded = required_session_extension_data_with_project_memory(
            &SessionType::CodePro,
            &extension_data,
            false,
        )
        .unwrap()
        .expect("binding a root-container session must restore project tools");
        let names = EnabledExtensionsState::from_extension_data(&upgraded)
            .unwrap()
            .extensions
            .into_iter()
            .map(|extension| extension.name().to_string())
            .collect::<Vec<_>>();

        assert!(names.contains(&"developer".to_string()));
        assert!(names.contains(&"codepromemory".to_string()));
    }

    #[test]
    fn unbound_codepro_session_never_restores_project_memory() {
        let mut extension_data = ExtensionData::new();
        CodeProWorkspaceBinding::Unbound
            .to_extension_data(&mut extension_data)
            .unwrap();
        EnabledExtensionsState::new(vec![builtin_to_extension_config("developer")])
            .to_extension_data(&mut extension_data)
            .unwrap();

        assert!(required_session_extension_data_with_project_memory(
            &SessionType::CodePro,
            &extension_data,
            true,
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn existing_codepro_extension_data_is_upgraded_once() {
        let mut original = ExtensionData::new();
        CodeProWorkspaceBinding::WritableProject {
            path: "D:\\project".to_string(),
            lease_id: "lease-1".to_string(),
        }
        .to_extension_data(&mut original)
        .unwrap();
        EnabledExtensionsState::new(vec![builtin_to_extension_config("developer")])
            .to_extension_data(&mut original)
            .unwrap();

        let upgraded = required_session_extension_data(&SessionType::CodePro, &original)
            .unwrap()
            .expect("missing memory extension should trigger an upgrade");
        let names = EnabledExtensionsState::from_extension_data(&upgraded)
            .unwrap()
            .extensions
            .into_iter()
            .map(|extension| extension.name().to_string())
            .collect::<Vec<_>>();

        assert!(names.contains(&"developer".to_string()));
        assert!(names.contains(&"codepromemory".to_string()));
        assert!(
            required_session_extension_data(&SessionType::CodePro, &upgraded)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn codepro_sessions_without_a_writable_binding_do_not_activate_project_extensions() {
        for binding in [
            None,
            Some(CodeProWorkspaceBinding::Unbound),
            Some(CodeProWorkspaceBinding::ProjectContainer {
                path: "/Users/test/Projects".into(),
            }),
            Some(CodeProWorkspaceBinding::RootContainer {
                path: "D:\\".to_string(),
            }),
        ] {
            let mut extension_data = ExtensionData::new();
            if let Some(binding) = binding {
                binding.to_extension_data(&mut extension_data).unwrap();
            }
            EnabledExtensionsState::new(vec![builtin_to_extension_config("developer")])
                .to_extension_data(&mut extension_data)
                .unwrap();

            assert!(!session_allows_extension_activation(
                &SessionType::CodePro,
                &extension_data
            ));
            assert!(
                required_session_extension_data(&SessionType::CodePro, &extension_data)
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn unbound_codepro_sessions_keep_only_the_shared_computer_tool() {
        let candidates = vec![
            builtin_to_extension_config("developer"),
            crate::agents::platform_extensions::project_memory::extension_config(),
            crate::config::extensions::computer_mcp_config(Vec::new()),
        ];

        let retained = retain_workspace_independent_codepro_extensions(candidates);

        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].name(), "qwen_computer");
        assert!(matches!(retained[0], ExtensionConfig::Builtin { .. }));

        let disabled_candidates = vec![
            builtin_to_extension_config("developer"),
            crate::agents::platform_extensions::project_memory::extension_config(),
        ];
        assert!(retain_workspace_independent_codepro_extensions(disabled_candidates).is_empty());
    }

    #[test]
    fn codepro_workspace_change_requires_fresh_workspace_scoped_extensions() {
        assert!(is_codepro_workspace_rebind(
            &SessionType::CodePro,
            Path::new(r"D:\CodeBuddyAcceptance\skill-mcp-20260905"),
            Path::new(r"D:\codepro-project-4"),
        ));
        assert!(!is_codepro_workspace_rebind(
            &SessionType::CodePro,
            Path::new(r"D:\codepro-project-4"),
            Path::new(r"D:\codepro-project-4"),
        ));
        assert!(!is_codepro_workspace_rebind(
            &SessionType::User,
            Path::new(r"D:\old-project"),
            Path::new(r"D:\new-project"),
        ));
    }

    #[test]
    fn standard_filesystem_extension_is_rescoped_to_the_confirmed_project() {
        let extension = ExtensionConfig::Stdio {
            name: "filesystem".to_string(),
            description: "Filesystem MCP".to_string(),
            cmd: "npx.cmd".to_string(),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
                r"D:\CodeBuddyAcceptance\skill-mcp-20260905".to_string(),
            ],
            envs: Default::default(),
            env_keys: Vec::new(),
            timeout: None,
            cwd: None,
            bundled: Some(false),
            available_tools: Vec::new(),
            read_only_tools: vec![],
        };

        let rebound = scope_standard_filesystem_extension_to_project(
            extension,
            Path::new(r"D:\codepro-project-4"),
        );
        let ExtensionConfig::Stdio { args, cwd, .. } = rebound else {
            panic!("filesystem extension must remain a stdio extension");
        };
        assert_eq!(
            args,
            vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
                r"D:\codepro-project-4".to_string(),
            ]
        );
        assert_eq!(cwd.as_deref(), Some(r"D:\codepro-project-4"));
    }

    #[test_case(
        McpServer::Stdio(
            McpServerStdio::new("github", "/path/to/github-mcp-server")
                .args(vec!["stdio".into()])
                .env(vec![EnvVariable::new("GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_xxxxxxxxxxxx")])
        ),
        Ok(ExtensionConfig::Stdio {
            name: "github".into(),
            description: String::new(),
            cmd: "/path/to/github-mcp-server".into(),
            args: vec!["stdio".into()],
            envs: Envs::new(
                [(
                    "GITHUB_PERSONAL_ACCESS_TOKEN".into(),
                    "ghp_xxxxxxxxxxxx".into()
                )]
                .into()
            ),
            env_keys: vec![],
            timeout: None,
            cwd: None,
            bundled: Some(false),
            available_tools: vec![],
            read_only_tools: vec![],
        })
    )]
    #[test_case(
        McpServer::Http(
            McpServerHttp::new("github", "https://api.githubcopilot.com/mcp/")
                .headers(vec![HttpHeader::new("Authorization", "Bearer ghp_xxxxxxxxxxxx")])
        ),
        Ok(ExtensionConfig::StreamableHttp {
            name: "github".into(),
            description: String::new(),
            uri: "https://api.githubcopilot.com/mcp/".into(),
            envs: Envs::default(),
            env_keys: vec![],
            headers: HashMap::from([(
                "Authorization".into(),
                "Bearer ghp_xxxxxxxxxxxx".into()
            )]),
            timeout: None,
            socket: None,
            bundled: Some(false),
            available_tools: vec![],
            read_only_tools: vec![],
        })
    )]
    #[test_case(
        McpServer::Sse(McpServerSse::new("test-sse", "https://agent-fin.biodnd.com/sse")),
        Err("SSE is unsupported, migrate to streamable_http".to_string())
    )]
    fn test_mcp_server_to_extension_config(
        input: McpServer,
        expected: Result<ExtensionConfig, String>,
    ) {
        assert_eq!(mcp_server_to_extension_config(input), expected);
    }

    fn new_resource_link(content: &str) -> anyhow::Result<(ResourceLink, TempDir, PathBuf)> {
        let directory = tempfile::tempdir()?;
        let file = directory.path().join("resource.txt");
        fs::write(&file, content)?;

        let name = file.file_name().unwrap().to_string_lossy().to_string();
        let uri = Url::from_file_path(&file).unwrap().to_string();
        let link = ResourceLink::new(name, uri);
        Ok((link, directory, file))
    }

    #[test]
    fn file_resource_links_require_and_stay_inside_the_authoritative_workspace() {
        let (link, directory, file) = new_resource_link("print(\"hello, world\")").unwrap();
        assert!(read_resource_link(link.clone(), None).is_err());

        // Keep the ordinary drive-letter path here. `canonicalize` produces a `\\?\`
        // verbatim path on Windows, while the authoritative workspace API deliberately
        // accepts only local drive-letter roots.
        let workspace = directory.path().to_path_buf();
        let canonical_file = file;
        let result = read_resource_link(link, Some(&workspace)).unwrap().unwrap();
        let expected = format!(
            "

# {}
```
print(\"hello, world\")
```",
            canonical_file.to_string_lossy(),
        );

        assert_eq!(result, expected,)
    }

    #[cfg(windows)]
    #[test]
    fn file_resource_links_reject_workspace_hardlinks_to_outside_bytes() {
        let outside = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("outside.txt");
        let linked_file = workspace.path().join("linked.txt");
        std::fs::write(&outside_file, "outside bytes").unwrap();
        std::fs::hard_link(&outside_file, &linked_file).unwrap();
        let uri = format!(
            "file:///{}",
            linked_file.to_string_lossy().replace('\\', "/")
        );

        let result =
            read_resource_link(ResourceLink::new("linked.txt", uri), Some(workspace.path()));

        assert!(result.is_err());
    }

    #[test]
    fn replay_attaches_chain_summary_meta_for_first_tool_request_with_persisted_summary() {
        let tool_request = ToolRequest {
            id: "req_first".to_string(),
            tool_call: Ok(CallToolRequestParams::new("developer__shell")),
            metadata: None,
            tool_meta: Some(serde_json::json!({
                crate::conversation::message::TOOL_META_CHAIN_SUMMARY_KEY: {
                    "summary": "applied dark mode polish",
                    "count": 3,
                },
            })),
        };

        let pending_tool_call = pending_tool_call_from_request(&tool_request);
        let mut meta = pending_tool_call.identity_meta;
        let chain_summary = tool_request
            .persisted_chain_summary()
            .expect("chain summary should be present");
        meta = with_tool_chain_summary_meta(meta, &chain_summary.summary, chain_summary.count);

        let goose = meta
            .as_ref()
            .and_then(|m| m.get("goose"))
            .expect("replay meta must include a goose namespace");
        assert_eq!(
            goose.get("toolCall"),
            Some(
                &serde_json::json!({ "toolName": "developer__shell", "extensionName": "developer" })
            ),
            "replay must preserve identity meta alongside the chain summary",
        );
        assert_eq!(
            goose.get("toolChainSummary"),
            Some(&serde_json::json!({ "summary": "applied dark mode polish", "count": 3 })),
            "replay must attach toolChainSummary so the chain header renders on first paint",
        );
    }

    #[test]
    fn replay_does_not_attach_chain_summary_for_tool_requests_without_persisted_summary() {
        let tool_request = ToolRequest {
            id: "req_second".to_string(),
            tool_call: Ok(CallToolRequestParams::new("developer__shell")),
            metadata: None,
            tool_meta: None,
        };

        let chain_summary = tool_request.persisted_chain_summary();
        assert!(
            chain_summary.is_none(),
            "non-first tool requests must not carry chain summaries",
        );
    }

    #[test_case(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(PermissionOptionId::from("allow_once".to_string()))),
        PermissionConfirmation { principal_type: PrincipalType::Tool, permission: Permission::AllowOnce };
        "allow_once_maps_to_allow_once"
    )]
    #[test_case(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(PermissionOptionId::from("allow_always".to_string()))),
        PermissionConfirmation { principal_type: PrincipalType::Tool, permission: Permission::AlwaysAllow };
        "allow_always_maps_to_always_allow"
    )]
    #[test_case(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(PermissionOptionId::from("reject_once".to_string()))),
        PermissionConfirmation { principal_type: PrincipalType::Tool, permission: Permission::DenyOnce };
        "reject_once_maps_to_deny_once"
    )]
    #[test_case(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(PermissionOptionId::from("reject_always".to_string()))),
        PermissionConfirmation { principal_type: PrincipalType::Tool, permission: Permission::AlwaysDeny };
        "reject_always_maps_to_always_deny"
    )]
    #[test_case(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(PermissionOptionId::from("unknown".to_string()))),
        PermissionConfirmation { principal_type: PrincipalType::Tool, permission: Permission::Cancel };
        "unknown_option_maps_to_cancel"
    )]
    #[test_case(
        RequestPermissionOutcome::Cancelled,
        PermissionConfirmation { principal_type: PrincipalType::Tool, permission: Permission::Cancel };
        "cancelled_maps_to_cancel"
    )]
    fn test_outcome_to_confirmation(
        input: RequestPermissionOutcome,
        expected: PermissionConfirmation,
    ) {
        assert_eq!(outcome_to_confirmation(&input), expected);
    }

    #[test]
    fn test_merge_replay_message_meta_preserves_existing_goose_meta() {
        let message = Message::new(Role::Assistant, 1_700_000_000, vec![]).with_id("msg_1");
        let existing = serde_json::from_value(serde_json::json!({
            "goose": {
                "mcpApp": {
                    "resourceUri": "ui://trusted/app",
                    "extensionName": "weather",
                    "toolName": "weather__render",
                },
            },
        }))
        .unwrap();

        let merged = merge_replay_message_meta(Some(existing), &message);

        assert_eq!(
            merged.get("goose"),
            Some(&serde_json::json!({
                "created": 1_700_000_000,
                "messageId": "msg_1",
                "mcpApp": {
                    "resourceUri": "ui://trusted/app",
                    "extensionName": "weather",
                    "toolName": "weather__render",
                },
            })),
        );
    }

    #[test]
    fn test_merge_replay_message_meta_creates_fresh_when_none() {
        let message = Message::new(Role::Assistant, 1_700_000_000, vec![]).with_id("msg_2");

        let merged = merge_replay_message_meta(None, &message);

        assert_eq!(
            merged.get("goose"),
            Some(&serde_json::json!({
                "created": 1_700_000_000,
                "messageId": "msg_2",
            })),
        );
    }

    #[test]
    fn test_merge_replay_message_meta_includes_steer_marker() {
        let message = Message::new(Role::User, 1_700_000_000, vec![])
            .with_id("msg_steer")
            .with_steer();

        let merged = merge_replay_message_meta(None, &message);

        assert_eq!(
            merged.get("goose"),
            Some(&serde_json::json!({
                "created": 1_700_000_000,
                "messageId": "msg_steer",
                "steer": true,
            })),
            "replay must carry the steer marker so the boundary survives reload"
        );
    }

    #[test]
    fn test_merge_replay_message_meta_omits_steer_when_not_set() {
        let message = Message::new(Role::Assistant, 1_700_000_000, vec![]).with_id("msg_plain");

        let merged = merge_replay_message_meta(None, &message);

        assert_eq!(merged.get("goose").and_then(|g| g.get("steer")), None);
    }

    #[test]
    fn test_message_update_meta_includes_created_and_message_id() {
        let meta = message_update_meta(Some("msg_live"), 1_700_000_000, false);

        assert_eq!(
            meta.get("goose"),
            Some(&serde_json::json!({
                "created": 1_700_000_000,
                "messageId": "msg_live",
            })),
        );
    }

    #[test]
    fn test_credits_exhausted_system_notification_maps_to_prompt_error() {
        let content = MessageContent::SystemNotification(SystemNotificationContent {
            notification_type: SystemNotificationType::CreditsExhausted,
            msg: "Please add credits to your account, then resend your message to continue."
                .to_string(),
            data: Some(serde_json::json!({
                "top_up_url": "https://router.tetrate.ai/billing"
            })),
        });

        let error = prompt_error_from_message_content(&content).expect("expected prompt error");
        let value = serde_json::to_value(error).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "code": -32603,
                "message": "Please add credits to your account, then resend your message to continue.",
                "data": {
                    "reason": "credits_exhausted",
                    "url": "https://router.tetrate.ai/billing"
                }
            })
        );
    }

    #[test]
    fn test_non_credit_system_notification_does_not_map_to_prompt_error() {
        let content = MessageContent::SystemNotification(SystemNotificationContent {
            notification_type: SystemNotificationType::InlineMessage,
            msg: "Compaction complete".to_string(),
            data: None,
        });

        assert!(prompt_error_from_message_content(&content).is_none());
    }

    #[test]
    fn status_message_preserves_structured_notification_data() {
        let notification = SystemNotificationContent {
            notification_type: SystemNotificationType::ProgressMessage,
            msg: "CodePro activity".to_string(),
            data: Some(serde_json::json!({
                "schema_version": 1,
                "event_id": "tool-1"
            })),
        };

        let status = status_message_from_system_notification(&notification).unwrap();
        match status {
            StatusMessage::Progress { message, data } => {
                assert_eq!(message, "CodePro activity");
                assert_eq!(data.unwrap()["event_id"], "tool-1");
            }
            StatusMessage::Notice { .. } => panic!("expected progress status"),
        }
    }

    #[test]
    fn turn_terminal_notification_uses_the_structured_progress_channel() {
        let notification = SystemNotificationContent {
            notification_type: SystemNotificationType::TurnTerminal,
            msg: "CodePro checkpoint available".to_string(),
            data: Some(serde_json::json!({
                "schema_version": 1,
                "terminal_message_id": "terminal-1"
            })),
        };

        let status = status_message_from_system_notification(&notification).unwrap();
        match status {
            StatusMessage::Progress { message, data } => {
                assert_eq!(message, "CodePro checkpoint available");
                assert_eq!(data.unwrap()["terminal_message_id"], "terminal-1");
            }
            StatusMessage::Notice { .. } => panic!("expected progress status"),
        }
    }

    #[tokio::test]
    async fn persisted_codepro_terminal_is_available_for_post_stream_delivery() {
        let data = TempDir::new().expect("temporary session store");
        let manager = SessionManager::new(data.path().join("sessions"));
        let session = manager
            .create_session(
                data.path().to_path_buf(),
                "terminal recovery".to_string(),
                SessionType::CodePro,
                GooseMode::Auto,
            )
            .await
            .expect("create CodePro session");
        let terminal = Message::assistant()
            .with_generated_id()
            .with_system_notification_with_data(
                SystemNotificationType::TurnTerminal,
                "CodePro completed",
                serde_json::json!({
                    "schema_version": 1,
                    "session_id": session.id,
                    "run_id": "run-terminal-recovery",
                    "terminal_message_id": "terminal-recovery",
                    "source_user_message_id": "source-user-recovery",
                    "status": "completed",
                    "checkpoint_id": null,
                    "retry_strategy": "not_available",
                    "visible_text_available": true,
                    "tool_action_count": 0,
                    "copy_artifact_ref": null,
                    "finished_at": "2026-08-28T00:00:00Z"
                }),
            );
        manager
            .add_message(&session.id, &terminal)
            .await
            .expect("persist terminal before publishing stream completion");

        let recovered = load_persisted_codepro_terminal_message(
            &manager,
            &session.id,
            "run-terminal-recovery",
            "source-user-recovery",
        )
        .await
        .expect("load committed terminal")
        .expect("terminal must be immediately recoverable");

        assert_eq!(recovered.id, terminal.id);
        assert!(recovered.content.iter().any(|content| {
            content
                .as_system_notification()
                .is_some_and(|notification| {
                    notification.notification_type == SystemNotificationType::TurnTerminal
                })
        }));
    }

    #[tokio::test]
    async fn persisted_codepro_terminal_from_an_earlier_prompt_on_the_same_run_is_ignored() {
        let data = TempDir::new().expect("temporary session store");
        let manager = SessionManager::new(data.path().join("sessions"));
        let session = manager
            .create_session(
                data.path().to_path_buf(),
                "same run terminal isolation".to_string(),
                SessionType::CodePro,
                GooseMode::Auto,
            )
            .await
            .expect("create CodePro session");
        let earlier_terminal = Message::assistant()
            .with_generated_id()
            .with_system_notification_with_data(
                SystemNotificationType::TurnTerminal,
                "Earlier prompt completed",
                serde_json::json!({
                    "schema_version": 1,
                    "session_id": session.id,
                    "run_id": "run-resumed",
                    "terminal_message_id": "terminal-earlier-prompt",
                    "source_user_message_id": "source-user-earlier",
                    "status": "completed",
                    "checkpoint_id": null,
                    "retry_strategy": "not_available",
                    "visible_text_available": true,
                    "tool_action_count": 0,
                    "copy_artifact_ref": null,
                    "finished_at": "2026-09-01T00:00:00Z"
                }),
            );
        manager
            .add_message(&session.id, &earlier_terminal)
            .await
            .expect("persist earlier terminal");

        let recovered = load_persisted_codepro_terminal_message(
            &manager,
            &session.id,
            "run-resumed",
            "source-user-current",
        )
        .await
        .expect("search current prompt terminal");

        assert!(recovered.is_none());
    }

    #[test]
    fn cancelled_codepro_turn_builds_a_durable_terminal_after_tool_activity() {
        let messages = vec![
            Message::user()
                .with_id("source-user-1")
                .with_text("inspect the project"),
            Message::assistant()
                .with_tool_request("tool-1", Ok(CallToolRequestParams::new("read_file"))),
        ];

        let terminal = build_cancelled_codepro_terminal_message(
            "session-1",
            "run-1",
            "source-user-1",
            &messages,
        )
        .expect("tool activity should produce a durable cancellation terminal");

        assert!(!terminal.as_concat_text().trim().is_empty());
        let notification = terminal
            .content
            .iter()
            .find_map(MessageContent::as_system_notification)
            .expect("expected a system notification");
        assert_eq!(
            notification.notification_type,
            SystemNotificationType::TurnTerminal
        );
        let data = notification
            .data
            .as_ref()
            .expect("structured terminal data");
        assert_eq!(data["session_id"], "session-1");
        assert_eq!(data["run_id"], "run-1");
        assert_eq!(data["source_user_message_id"], "source-user-1");
        assert_eq!(data["status"], "cancelled");
        assert_eq!(data["failure_kind"], "cancelled");
        assert_eq!(data["retryable"], true);
        assert_eq!(data["user_action"], "restart_task");
        assert_eq!(data["retry_strategy"], "replay_user_request");
        assert_eq!(data["tool_action_count"], 1);
        assert_eq!(data["terminal_message_id"], terminal.id.as_deref().unwrap());
    }

    #[test]
    fn cancelled_codepro_turn_without_parent_tool_activity_still_has_a_terminal() {
        let messages = vec![Message::user()
            .with_id("source-user-1")
            .with_text("start a CodePro worker")];

        let terminal = build_cancelled_codepro_terminal_message(
            "session-1",
            "run-1",
            "source-user-1",
            &messages,
        )
        .expect(
            "worker activity lives in child sessions, so parent cancellation must still persist",
        );
        let notification = terminal
            .content
            .iter()
            .find_map(MessageContent::as_system_notification)
            .expect("expected a system notification");
        let data = notification
            .data
            .as_ref()
            .expect("structured terminal data");
        assert_eq!(data["status"], "cancelled");
        assert_eq!(data["retry_strategy"], "replay_user_request");
        assert_eq!(data["tool_action_count"], 0);
    }

    #[test]
    fn cancelled_codepro_turn_does_not_duplicate_an_existing_terminal() {
        let existing = Message::assistant()
            .with_generated_id()
            .with_system_notification_with_data(
                SystemNotificationType::TurnTerminal,
                "CodePro turn stopped",
                serde_json::json!({
                    "schema_version": 1,
                    "session_id": "session-1",
                    "run_id": "run-1",
                    "terminal_message_id": "terminal-existing",
                    "source_user_message_id": "source-user-1",
                    "status": "cancelled",
                    "checkpoint_id": null,
                    "retry_strategy": "replay_user_request",
                    "visible_text_available": false,
                    "tool_action_count": 1,
                    "copy_artifact_ref": null,
                    "finished_at": "2026-08-01T00:00:00Z"
                }),
            );
        let messages = vec![
            Message::user()
                .with_id("source-user-1")
                .with_text("inspect"),
            Message::assistant()
                .with_tool_request("tool-1", Ok(CallToolRequestParams::new("read_file"))),
            existing,
        ];

        assert!(build_cancelled_codepro_terminal_message(
            "session-1",
            "run-1",
            "source-user-1",
            &messages,
        )
        .is_none());
    }

    #[test]
    fn parses_namespaced_codepro_checkpoint_retry_metadata() {
        let request: PromptRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "prompt": [{ "type": "text", "text": "继续执行" }],
            "_meta": {
                "codeagentpro/turn-retry": {
                    "schemaVersion": 1,
                    "strategy": "continue_checkpoint",
                    "checkpointId": "checkpoint-1",
                    "sourceRunId": "run-1",
                    "sourceUserMessageId": "source-user-1"
                }
            }
        }))
        .unwrap();

        let retry = parse_codepro_turn_retry_metadata(request.meta.as_ref())
            .expect("valid retry metadata")
            .expect("checkpoint retry");

        assert_eq!(retry.checkpoint_id.as_deref(), Some("checkpoint-1"));
        assert_eq!(retry.source_run_id, "run-1");
        assert_eq!(retry.source_user_message_id, "source-user-1");
        let resume = codepro_resume_request_from_metadata(retry);
        assert!(
            resume.approval.is_none(),
            "raw metadata is not authorization"
        );
    }

    #[test]
    fn checkpoint_input_cancelled_provisional_prompt_cannot_select_an_old_run() {
        let token = CancellationToken::new();
        let mut runs = HashMap::from([(
            "session".to_string(),
            ActivePromptRun {
                run_id: "provisional".to_string(),
                cancel_token: token.clone(),
                stop_reason: ActivePromptStopReason::None,
                durable_execution_bound: false,
            },
        )]);
        token.cancel();
        assert!(!retarget_checkpoint_prompt(
            &mut runs,
            "session",
            "provisional",
            "old-run",
            false
        ));
        assert_eq!(runs["session"].run_id, "provisional");
        assert_eq!(
            take_active_run_stop_reason(&mut runs, "session", "provisional"),
            Some(ActivePromptStopReason::None)
        );
        assert!(
            runs.is_empty(),
            "cancelled provisional prompt must release busy state"
        );
    }

    #[test]
    fn checkpoint_input_unvalidated_retry_metadata_never_creates_approval() {
        let retry = CodeProTurnRetryMetadata {
            schema_version: 1,
            strategy: CodeProTurnRetryStrategy::ContinueCheckpoint,
            checkpoint_id: Some("checkpoint-1".to_string()),
            source_run_id: "run-original".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            source_terminal_message_id: None,
        };
        assert!(codepro_resume_request_from_metadata(retry)
            .approval
            .is_none());
    }

    #[test]
    fn checkpoint_retry_reuses_the_source_run_instead_of_creating_a_second_run() {
        let retry = CodeProTurnRetryMetadata {
            schema_version: 1,
            strategy: CodeProTurnRetryStrategy::ContinueCheckpoint,
            checkpoint_id: Some("checkpoint-1".to_string()),
            source_run_id: "run-original".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            source_terminal_message_id: None,
        };

        let identity = codepro_prompt_run_identity(Some(&retry));

        assert_eq!(identity.run_id, "run-original");
        assert!(identity.resume_existing);
        let fresh = codepro_prompt_run_identity(None);
        assert_ne!(fresh.run_id, "run-original");
        assert!(!fresh.resume_existing);
    }

    #[test]
    fn third_repair_batch_plain_text_run_ids_never_select_resume_identity() {
        let run_id = "run_482682bd-146d-4ed8-afe7-97d12df8d915";
        let pasted_data =
            format!(r#"继续分析这段日志：{{"run_id":"{run_id}","note":"从检查点继续"}}"#);

        assert!(pasted_data.contains(run_id));
        let identity = codepro_prompt_run_identity(None);
        assert_ne!(identity.run_id, run_id);
        assert!(!identity.resume_existing);
    }

    #[test]
    fn workspace_resume_reuses_the_source_run_without_checkpoint_approval() {
        let retry = CodeProTurnRetryMetadata {
            schema_version: 1,
            strategy: CodeProTurnRetryStrategy::ResumeAfterWorkspace,
            checkpoint_id: None,
            source_run_id: "run-original".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            source_terminal_message_id: None,
        };

        let identity = codepro_prompt_run_identity(Some(&retry));
        assert_eq!(identity.run_id, "run-original");
        assert!(identity.resume_existing);

        let resume = codepro_resume_request_from_metadata(retry);
        assert_eq!(
            resume.strategy,
            crate::agents::CodeProRetryStrategy::ResumeAfterWorkspace
        );
        assert!(resume.approval.is_none());
    }

    #[test]
    fn parses_namespaced_codepro_linked_replay_metadata() {
        let request: PromptRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "prompt": [{ "type": "text", "text": "original request" }],
            "_meta": {
                "codeagentpro/turn-retry": {
                    "schemaVersion": 1,
                    "strategy": "replay_user_request",
                    "checkpointId": null,
                    "sourceRunId": "run-1",
                    "sourceUserMessageId": "source-user-1"
                }
            }
        }))
        .unwrap();

        let retry = parse_codepro_turn_retry_metadata(request.meta.as_ref())
            .expect("valid retry metadata")
            .expect("linked replay");

        assert_eq!(retry.strategy, CodeProTurnRetryStrategy::ReplayUserRequest);
        assert_eq!(retry.checkpoint_id, None);
        assert_eq!(retry.source_run_id, "run-1");
    }

    #[test]
    fn parses_namespaced_codepro_failed_validation_retry_metadata() {
        let request: PromptRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "prompt": [{ "type": "text", "text": "重新运行失败的验证" }],
            "_meta": {
                "codeagentpro/turn-retry": {
                    "schemaVersion": 1,
                    "strategy": "retry_failed_validation",
                    "checkpointId": null,
                    "sourceRunId": "run-1",
                    "sourceUserMessageId": "source-user-1",
                    "sourceTerminalMessageId": "terminal-1"
                }
            }
        }))
        .unwrap();

        let retry = parse_codepro_turn_retry_metadata(request.meta.as_ref())
            .expect("valid failed validation retry metadata")
            .expect("failed validation retry");

        assert_eq!(
            retry.strategy,
            CodeProTurnRetryStrategy::RetryFailedValidation
        );
        assert_eq!(retry.checkpoint_id, None);
        assert_eq!(retry.source_run_id, "run-1");
        assert_eq!(retry.source_user_message_id, "source-user-1");
        assert_eq!(
            retry.source_terminal_message_id.as_deref(),
            Some("terminal-1")
        );
    }

    #[test]
    fn rejects_unsafe_codepro_failed_validation_retry_metadata() {
        for retry in [
            serde_json::json!({
                "schemaVersion": 1,
                "strategy": "retry_failed_validation",
                "checkpointId": null,
                "sourceRunId": "run-1",
                "sourceUserMessageId": "source-user-1"
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "strategy": "retry_failed_validation",
                "checkpointId": null,
                "sourceRunId": "run-1",
                "sourceUserMessageId": "source-user-1",
                "sourceTerminalMessageId": "   "
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "strategy": "retry_failed_validation",
                "checkpointId": "checkpoint-1",
                "sourceRunId": "run-1",
                "sourceUserMessageId": "source-user-1",
                "sourceTerminalMessageId": "terminal-1"
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "strategy": "retry_failed_validation",
                "checkpointId": null,
                "sourceRunId": "run-1",
                "sourceUserMessageId": "source-user-1",
                "sourceTerminalMessageId": "terminal-1",
                "command": "cargo test"
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "strategy": "retry_failed_validation",
                "checkpointId": null,
                "sourceRunId": "run-1",
                "sourceUserMessageId": "source-user-1",
                "sourceTerminalMessageId": "terminal-1",
                "targetPath": "app.rs"
            }),
        ] {
            let meta = serde_json::from_value(serde_json::json!({
                "codeagentpro/turn-retry": retry
            }))
            .unwrap();
            assert!(parse_codepro_turn_retry_metadata(Some(&meta)).is_err());
        }
    }

    #[test]
    fn parses_namespaced_codepro_source_message_id() {
        let request: PromptRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "prompt": [{ "type": "text", "text": "test project" }],
            "_meta": {
                "codeagentpro/source-message-id": "source-user-1"
            }
        }))
        .unwrap();

        assert_eq!(
            parse_codepro_source_message_id(request.meta.as_ref())
                .unwrap()
                .as_deref(),
            Some("source-user-1")
        );
    }

    #[test]
    fn rejects_empty_codepro_source_message_id() {
        let mut meta = Meta::new();
        meta.insert(
            CODEPRO_SOURCE_MESSAGE_ID_META_KEY.to_string(),
            serde_json::Value::String("   ".to_string()),
        );

        assert!(parse_codepro_source_message_id(Some(&meta)).is_err());
    }

    #[test]
    fn rejects_incomplete_codepro_checkpoint_retry_metadata() {
        let meta = serde_json::from_value(serde_json::json!({
            "codeagentpro/turn-retry": {
                "schemaVersion": 1,
                "strategy": "continue_checkpoint",
                "checkpointId": "",
                "sourceRunId": "run-1",
                "sourceUserMessageId": "source-user-1"
            }
        }))
        .unwrap();

        assert!(parse_codepro_turn_retry_metadata(Some(&meta)).is_err());
    }

    #[test]
    fn test_merge_replay_message_meta_omits_message_id_when_none() {
        let message = Message::new(Role::Assistant, 1_700_000_000, vec![]);

        let merged = merge_replay_message_meta(None, &message);

        assert_eq!(
            merged.get("goose"),
            Some(&serde_json::json!({
                "created": 1_700_000_000,
            })),
        );
    }

    fn make_session_with_usage(usage: TokenUsage, accumulated_usage: TokenUsage) -> Session {
        Session {
            id: "session-1".to_string(),
            working_dir: PathBuf::from("/tmp"),
            name: "ACP Session".to_string(),
            session_type: SessionType::Acp,
            usage,
            accumulated_usage,
            ..Default::default()
        }
    }

    #[test]
    fn test_build_prompt_usage_uses_current_turn_tokens() {
        let session = make_session_with_usage(
            TokenUsage::new(Some(80), Some(40), Some(120)),
            TokenUsage::new(Some(210), Some(150), Some(360)),
        );
        let usage = build_prompt_usage(&session).expect("usage should be present");
        assert_eq!(usage.total_tokens, 120);
        assert_eq!(usage.input_tokens, 80);
        assert_eq!(usage.output_tokens, 40);
    }

    #[test]
    fn test_build_prompt_usage_falls_back_to_current_tokens() {
        let session = make_session_with_usage(
            TokenUsage::new(Some(80), Some(40), Some(120)),
            TokenUsage::default(),
        );
        let usage = build_prompt_usage(&session).expect("usage should be present");
        assert_eq!(usage.total_tokens, 120);
        assert_eq!(usage.input_tokens, 80);
        assert_eq!(usage.output_tokens, 40);
    }

    #[test]
    fn test_build_prompt_usage_requires_total_tokens() {
        let session = make_session_with_usage(
            TokenUsage {
                input_tokens: Some(80),
                output_tokens: Some(40),
                total_tokens: None,
                ..Default::default()
            },
            TokenUsage::default(),
        );
        assert!(build_prompt_usage(&session).is_none());
    }

    #[test]
    fn test_build_usage_update_rejects_negative_usage_instead_of_showing_zero() {
        let mut session = make_session_with_usage(
            TokenUsage::new(Some(0), Some(0), Some(-7)),
            TokenUsage::default(),
        );
        session.model_config = Some(
            goose_providers::model::ModelConfig::new("test-model")
                .with_context_limit(Some(258_000)),
        );
        let totals = SessionUsageTotals {
            accumulated_usage: session.accumulated_usage,
            accumulated_cost: session.accumulated_cost,
        };
        assert!(
            build_usage_updates(&session, &totals).is_none(),
            "invalid usage is unknown and must not be presented as zero consumption"
        );
    }

    #[test]
    fn test_build_usage_update_requires_model_config() {
        let session = make_session_with_usage(
            TokenUsage::new(Some(80), Some(40), Some(120)),
            TokenUsage::default(),
        );
        assert!(build_usage_updates(&session, &SessionUsageTotals::default()).is_none());
    }

    #[test]
    fn test_goose_custom_notifications_capability_defaults_to_false() {
        let request =
            InitializeRequest::new(agent_client_protocol::schema::ProtocolVersion::LATEST);
        let goose_client_capabilities =
            extract_client_capabilities_meta(&request).and_then(|meta| meta.goose);

        assert!(!extract_client_supports_goose_custom_notifications(
            goose_client_capabilities.as_ref()
        ));
    }

    #[test]
    fn test_goose_custom_notifications_capability_reads_client_meta() {
        let mut goose_meta = serde_json::Map::new();
        goose_meta.insert(
            "customNotifications".to_string(),
            serde_json::Value::Bool(true),
        );
        let mut meta = serde_json::Map::new();
        meta.insert("goose".to_string(), serde_json::Value::Object(goose_meta));

        let request =
            InitializeRequest::new(agent_client_protocol::schema::ProtocolVersion::LATEST)
                .client_capabilities(
                    agent_client_protocol::schema::v1::ClientCapabilities::new().meta(meta),
                );
        let goose_client_capabilities =
            extract_client_capabilities_meta(&request).and_then(|meta| meta.goose);

        assert!(extract_client_supports_goose_custom_notifications(
            goose_client_capabilities.as_ref()
        ));
    }

    #[cfg(windows)]
    #[test]
    fn session_workspace_cleanup_preserves_agent_error_priority() {
        let error = finish_session_workspace_cleanup(
            Err(anyhow::anyhow!("agent cleanup failed")),
            Err(anyhow::anyhow!("lease cleanup failed")),
            "agent cleanup context",
        )
        .expect_err("agent cleanup must remain the primary error");

        let rendered = format!("{error:?}");
        assert!(rendered.contains("agent cleanup failed"));
        assert!(!rendered.contains("lease cleanup failed"));
    }

    #[cfg(windows)]
    #[test]
    fn session_workspace_cleanup_surfaces_lease_error_after_agent_success() {
        let error = finish_session_workspace_cleanup(
            Ok(()),
            Err(anyhow::anyhow!("lease cleanup failed")),
            "agent cleanup context",
        )
        .expect_err("lease cleanup failure must be surfaced");

        assert!(format!("{error:?}").contains("lease cleanup failed"));
    }
}
