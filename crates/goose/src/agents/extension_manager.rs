use anyhow::Result;
#[cfg(unix)]
use axum::http::HeaderValue;
use axum::http::{HeaderMap, HeaderName};
use chrono::{DateTime, Utc};
use futures::stream::{FuturesUnordered, StreamExt};
use futures::Stream;
use futures::{future, FutureExt};
use once_cell::sync::Lazy;
use rmcp::service::{ClientInitializeError, ServiceError};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransportConfig, StreamableHttpError,
};
use rmcp::transport::{
    ConfigureCommandExt, DynamicTransportError, StreamableHttpClientTransport, TokioChildProcess,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tempfile::{tempdir, TempDir};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex, Semaphore};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

use super::container::Container;
use super::extension::{
    ExtensionConfig, ExtensionError, ExtensionInfo, ExtensionResult, PlatformExtensionContext,
    ToolInfo, PLATFORM_EXTENSIONS,
};
use super::tool_audit::{
    QualifiedToolName, ToolAuditAuthorization, ToolAuditClaim, ToolAuditExtensionSource,
    ToolAuditInput, ToolAuditOutcome, ToolAuditPermissionClass, ToolAuditReceipt, ToolAuditStore,
};
#[cfg(test)]
use super::tool_execution::ToolCallContext;
use super::tool_execution::{
    CodeProWorkspaceWriteGuard, ToolCallResult, WorkspaceScopeViolation, WorkspaceSnapshot,
};
use super::tool_idempotency::{
    BeginDecision, ToolIdempotencyInput, ToolIdempotencyOutcome, ToolIdempotencyStore,
};
use super::tool_security::{ToolExtensionSource, ToolSecurityProfile};
use super::types::SharedProvider;
use crate::action_required_manager::ActionRequiredManager;
use crate::agents::extension::{Envs, ProcessExit};
use crate::agents::extension_malware_check;
use crate::agents::mcp_client::{
    GooseMcpClientCapabilities, GooseMcpHostInfo, McpClient, McpClientTrait,
};
use crate::agents::platform_extensions::tool_registry::{
    codepro_tool_spec, CodeProPermissionClass,
};
use crate::builtin_extension::get_builtin_extension;
use crate::capability_usage::{
    record_capability_success, CapabilityUsageEvent, CapabilityUsageKind,
};
use crate::config::extensions::name_to_key;
use crate::config::search_path::SearchPaths;
use crate::config::{get_all_extensions, Config};
use crate::oauth::{oauth_flow, GooseCredentialStore};
use crate::permission::failure_semantics::CodeProFailureKind;
use crate::prompt_template;
use crate::subprocess::configure_subprocess;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, ErrorCode, ErrorData, GetPromptResult,
    JsonObject, Meta, Prompt, Resource, ResourceContents, ServerInfo, Tool,
};
use rmcp::transport::auth::{AuthClient, CredentialStore};
use schemars::_private::NoSerialize;
use serde_json::Value;

type McpClientBox = Arc<dyn McpClientTrait>;

struct ActionRequiredStream {
    inner: ReceiverStream<crate::conversation::message::Message>,
    session_id: String,
    tool_call_request_id: String,
}

impl ActionRequiredStream {
    fn new(
        receiver: tokio::sync::mpsc::Receiver<crate::conversation::message::Message>,
        session_id: String,
        tool_call_request_id: String,
    ) -> Self {
        Self {
            inner: ReceiverStream::new(receiver),
            session_id,
            tool_call_request_id,
        }
    }
}

impl Stream for ActionRequiredStream {
    type Item = crate::conversation::message::Message;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}

impl Drop for ActionRequiredStream {
    fn drop(&mut self) {
        let session_id = self.session_id.clone();
        let tool_call_request_id = self.tool_call_request_id.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            ActionRequiredManager::global()
                .unregister_action_required_stream(&session_id, &tool_call_request_id)
                .await;
        });
    }
}

static RE_ENV_BRACES: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}").expect("valid regex"));

static RE_ENV_SIMPLE: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(r"\$([A-Za-z_][A-Za-z0-9_]*)").expect("valid regex"));

fn resolve_timeout(timeout: Option<u64>) -> u64 {
    timeout.unwrap_or_else(|| {
        Config::global()
            .get_goose_default_extension_timeout()
            .unwrap_or(crate::config::DEFAULT_EXTENSION_TIMEOUT)
    })
}

const DEFAULT_MAX_CONCURRENT_TOOL_CALLS: usize = 8;
const MAX_CONCURRENT_TOOL_CALLS: usize = 64;
const MIN_TOOL_TIMEOUT_SECS: u64 = 1;
const MAX_TOOL_TIMEOUT_SECS: u64 = 60 * 60;

fn bounded_tool_timeout(timeout: Option<u64>) -> Duration {
    Duration::from_secs(
        resolve_timeout(timeout).clamp(MIN_TOOL_TIMEOUT_SECS, MAX_TOOL_TIMEOUT_SECS),
    )
}

fn host_audit_error() -> ErrorData {
    ErrorData::new(
        ErrorCode::INTERNAL_ERROR,
        "The host could not persist a durable tool audit record.".to_string(),
        None,
    )
}

async fn complete_tool_audit(
    store: &ToolAuditStore,
    claim: &ToolAuditClaim,
    outcome: ToolAuditOutcome,
) -> Result<ToolAuditReceipt, ErrorData> {
    store
        .complete_with_receipt(claim, outcome)
        .await
        .map_err(|_| host_audit_error())
}

fn configured_tool_concurrency() -> usize {
    Config::global()
        .get_param::<usize>("GOOSE_MAX_CONCURRENT_TOOL_CALLS")
        .unwrap_or(DEFAULT_MAX_CONCURRENT_TOOL_CALLS)
        .clamp(1, MAX_CONCURRENT_TOOL_CALLS)
}

static GLOBAL_TOOL_EXECUTION_SEMAPHORE: Lazy<Arc<Semaphore>> =
    Lazy::new(|| Arc::new(Semaphore::new(configured_tool_concurrency())));

#[derive(Clone)]
struct ToolExecutionLimits {
    semaphore: Arc<Semaphore>,
    timeout: Duration,
    drain_timeout: Duration,
}

impl ToolExecutionLimits {
    fn configured() -> Self {
        Self {
            semaphore: Arc::clone(&GLOBAL_TOOL_EXECUTION_SEMAPHORE),
            timeout: bounded_tool_timeout(None),
            // Shell cleanup can wait 3s for taskkill, 3s for the parent and 0.5s
            // for output pipes. Allow that bounded cleanup to return its receipt.
            // If cleanup still exceeds this window, retain an unknown result.
            drain_timeout: Duration::from_secs(8),
        }
    }

    #[cfg(test)]
    fn for_test(concurrency: usize, timeout: Duration, drain_timeout: Duration) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(
                concurrency.clamp(1, MAX_CONCURRENT_TOOL_CALLS),
            )),
            timeout,
            drain_timeout,
        }
    }

    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Debug)]
enum BoundedToolError {
    Operation(ErrorData),
    Cancelled(ErrorData),
    TimedOut(ErrorData),
}

async fn run_bounded_tool_operation<T, Factory, Operation>(
    limits: ToolExecutionLimits,
    cancellation_token: CancellationToken,
    tool_name: String,
    operation: Factory,
) -> Result<T, BoundedToolError>
where
    T: serde::Serialize,
    Factory: FnOnce(CancellationToken) -> Operation,
    Operation: std::future::Future<Output = Result<T, ErrorData>>,
{
    let permit = tokio::select! {
        biased;
        _ = cancellation_token.cancelled() => {
            return Err(BoundedToolError::Cancelled(ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("Tool '{tool_name}' was cancelled while waiting to run"),
                None,
            )));
        }
        permit = Arc::clone(&limits.semaphore).acquire_owned() => permit.map_err(|_| {
            BoundedToolError::Operation(ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("Tool '{tool_name}' could not enter the execution queue"),
                None,
            ))
        })?,
    };
    let _permit = permit;
    let operation_token = cancellation_token.child_token();
    let mut operation = Box::pin(operation(operation_token.clone()));
    let mut terminal_error = tokio::select! {
        biased;
        _ = cancellation_token.cancelled() => {
            BoundedToolError::Cancelled(ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("Tool '{tool_name}' was cancelled during execution"),
                None,
            ))
        }
        _ = tokio::time::sleep(limits.timeout) => {
            operation_token.cancel();
            BoundedToolError::TimedOut(ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("Tool '{tool_name}' exceeded its host execution timeout and was cancelled"),
                None,
            ))
        }
        result = &mut operation => return result.map_err(BoundedToolError::Operation),
    };
    operation_token.cancel();
    if let Ok(cleanup_result) = tokio::time::timeout(limits.drain_timeout, &mut operation).await {
        // Keep the deadline/cancellation outcome. A result returned during cleanup
        // is evidence about this same attempt, not a late successful execution.
        let error = match &mut terminal_error {
            BoundedToolError::Cancelled(error) | BoundedToolError::TimedOut(error) => error,
            BoundedToolError::Operation(error) => error,
        };
        error.data = Some(serde_json::json!({
            "codepro_bounded_execution": {
                "schema_version": 1,
                "cleanup_result": cleanup_result,
            }
        }));
    }
    Err(terminal_error)
}

pub(crate) fn bounded_execution_result(error: &ErrorData) -> Option<CallToolResult> {
    let data = error.data.as_ref()?.get("codepro_bounded_execution")?;
    if data["schema_version"] != 1 {
        return None;
    }
    serde_json::from_value(data.get("cleanup_result")?.get("Ok")?.clone()).ok()
}

struct Extension {
    pub config: ExtensionConfig,
    /// Resolved config snapshot (with secrets from keyring substituted)
    /// captured at client-creation time. Used to detect secret rotation
    /// without re-reading the keyring on every comparison. Only held in
    /// memory — never serialized to disk.
    resolved_config: ExtensionConfig,

    client: McpClientBox,
    server_info: Option<ServerInfo>,
    _temp_dir: Option<tempfile::TempDir>,
}

impl Extension {
    fn new(
        config: ExtensionConfig,
        resolved_config: ExtensionConfig,
        client: McpClientBox,
        server_info: Option<ServerInfo>,
        temp_dir: Option<tempfile::TempDir>,
    ) -> Self {
        Self {
            client,
            config,
            resolved_config,
            server_info,
            _temp_dir: temp_dir,
        }
    }

    fn supports_resources(&self) -> bool {
        self.server_info
            .as_ref()
            .and_then(|info| info.capabilities.resources.as_ref())
            .is_some()
    }

    fn get_instructions(&self) -> Option<String> {
        self.client.get_instructions()
    }

    fn get_client(&self) -> McpClientBox {
        self.client.clone()
    }
}

pub struct ExtensionManagerCapabilities {
    pub mcpui: bool,
    pub host_info: Option<GooseMcpHostInfo>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GooseMcpAppToolAttachment {
    pub tool_name: String,
    pub extension_name: String,
    pub resource_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_meta: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_error: Option<String>,
}

pub(crate) const TRUSTED_TOOL_UPDATE_META_KEY: &str = "__goose_tool_update_meta";
const REPORTED_CODEPRO_FAILURE_META_KEY: &str = "codepro_failure";

/// Manages goose extensions / MCP clients and their interactions
pub struct ExtensionManager {
    extensions: Mutex<HashMap<String, Extension>>,
    context: PlatformExtensionContext,
    provider: SharedProvider,
    tools_cache: Mutex<Option<Arc<Vec<Tool>>>>,
    tools_cache_version: AtomicU64,
    client_name: String,
    capabilities: ExtensionManagerCapabilities,
    tool_execution_limits: ToolExecutionLimits,
    tool_idempotency_store: Arc<ToolIdempotencyStore>,
    tool_audit_store: Arc<ToolAuditStore>,
}

/// A flattened representation of a resource used by the agent to prepare inference
#[derive(Debug, Clone)]
pub struct ResourceItem {
    pub extension_name: String, // The name of the extension that owns the resource
    pub uri: String,            // The URI of the resource
    pub name: String,           // The name of the resource
    pub content: String,        // The content of the resource
    pub timestamp: DateTime<Utc>, // The timestamp of the resource
    pub priority: f32,          // The priority of the resource
    pub token_count: Option<u32>, // The token count of the resource (filled in by the agent)
}

impl ResourceItem {
    pub fn new(
        extension_name: String,
        uri: String,
        name: String,
        content: String,
        timestamp: DateTime<Utc>,
        priority: f32,
    ) -> Self {
        Self {
            extension_name,
            uri,
            name,
            content,
            timestamp,
            priority,
            token_count: None,
        }
    }
}

fn resolve_command(cmd: &str) -> PathBuf {
    SearchPaths::builder()
        .with_npm()
        .resolve(cmd)
        .unwrap_or_else(|_| {
            // let the OS raise the error
            PathBuf::from(cmd)
        })
}

fn require_str_parameter<'a>(v: &'a serde_json::Value, name: &str) -> Result<&'a str, ErrorData> {
    let v = v.get(name).ok_or_else(|| {
        ErrorData::new(
            ErrorCode::INVALID_PARAMS,
            format!("The parameter {name} is required"),
            None,
        )
    })?;
    match v.as_str() {
        Some(r) => Ok(r),
        None => Err(ErrorData::new(
            ErrorCode::INVALID_PARAMS,
            format!("The parameter {name} must be a string"),
            None,
        )),
    }
}

pub fn get_parameter_names(tool: &Tool) -> Vec<String> {
    let mut names: Vec<String> = tool
        .input_schema
        .get("properties")
        .and_then(|props| props.as_object())
        .map(|props| props.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

fn validate_tool_arguments(
    tool_name: &str,
    input_schema: &Value,
    arguments: Option<&JsonObject>,
) -> Result<(), ErrorData> {
    let validator = jsonschema::validator_for(input_schema).map_err(|error| {
        tracing::error!(tool.name = tool_name, %error, "tool supplied an invalid input schema");
        ErrorData::new(
            ErrorCode::INTERNAL_ERROR,
            format!("Tool '{tool_name}' has an invalid input schema"),
            None,
        )
    })?;
    let empty = JsonObject::new();
    let input = Value::Object(arguments.unwrap_or(&empty).clone());
    let errors = validator
        .iter_errors(&input)
        .take(3)
        .map(|error| {
            let path = error.instance_path().to_string();
            let path = if path.is_empty() {
                "/".to_string()
            } else {
                path
            };
            let detail = match error.kind() {
                jsonschema::error::ValidationErrorKind::Required { property } => {
                    format!("missing required property {property}")
                }
                jsonschema::error::ValidationErrorKind::Type { kind } => {
                    format!("expected type {kind:?}")
                }
                jsonschema::error::ValidationErrorKind::AdditionalProperties { unexpected } => {
                    let fields = unexpected.iter().take(5)
                        .map(|field| format!("{:?}", field.chars().take(80).collect::<String>()))
                        .collect::<Vec<_>>().join(", ");
                    format!("unsupported properties {fields}; remove them and use the published input schema")
                }
                kind => format!("failed {} constraint", kind.keyword()),
            };
            format!("{path}: {detail}")
        })
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ErrorData::new(
            ErrorCode::INVALID_PARAMS,
            format!(
                "Arguments for tool '{tool_name}' do not match its input schema at {}",
                errors.join("; ")
            ),
            None,
        ))
    }
}

const TOOL_EXTENSION_META_KEY: &str = "goose_extension";

pub fn get_tool_owner(tool: &Tool) -> Option<String> {
    tool.meta
        .as_ref()
        .and_then(|m| m.0.get(TOOL_EXTENSION_META_KEY))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn recover_mangled_tool_name<'a>(
    emitted: &str,
    tool_names: impl Iterator<Item = &'a str>,
) -> Option<String> {
    let trimmed = emitted.trim();
    let stripped = trimmed
        .strip_prefix("functions.")
        .or_else(|| trimmed.strip_prefix("functions:"))
        .unwrap_or(trimmed);

    let mut matched: Option<&str> = None;
    for name in tool_names {
        let separator_mangled = name
            .split_once("__")
            .map(|(extension, tool)| format!("{extension}.{tool}"));

        let matches = stripped == name || separator_mangled.as_deref() == Some(stripped);
        if name == emitted || !matches {
            continue;
        }

        match matched {
            None => matched = Some(name),
            Some(prev) if prev == name => {}
            Some(_) => return None,
        }
    }
    matched.map(|s| s.to_string())
}

fn get_tool_meta_value(tool: &Tool) -> Option<Value> {
    tool.meta.as_ref().map(|meta| Value::Object(meta.0.clone()))
}

pub(crate) fn get_tool_resource_uri(tool: &Tool) -> Option<String> {
    tool.meta
        .as_ref()
        .and_then(|meta| meta.0.get("ui"))
        .and_then(Value::as_object)
        .and_then(|ui| ui.get("resourceUri"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn remove_untrusted_mcp_app_meta(result: &mut CallToolResult) {
    let Some(meta) = result.meta.as_mut() else {
        return;
    };

    meta.0.remove(TRUSTED_TOOL_UPDATE_META_KEY);
    meta.0.remove(REPORTED_CODEPRO_FAILURE_META_KEY);

    let remove_goose = meta
        .0
        .get_mut("goose")
        .and_then(Value::as_object_mut)
        .map(|goose_meta| {
            goose_meta.remove("mcpApp");
            goose_meta.remove("toolAudit");
            goose_meta.is_empty()
        })
        .unwrap_or(false);

    if remove_goose {
        meta.0.remove("goose");
    }

    if meta.0.is_empty() {
        result.meta = None;
    }
}

async fn complete_tool_audit_with_failure(
    store: &ToolAuditStore,
    claim: &ToolAuditClaim,
    outcome: ToolAuditOutcome,
    failure_kind: Option<CodeProFailureKind>,
) -> Result<ToolAuditReceipt, ErrorData> {
    store
        .complete_with_failure_receipt(claim, outcome, failure_kind)
        .await
        .map_err(|_| host_audit_error())
}

fn take_reported_codepro_failure(result: &mut CallToolResult) -> Option<CodeProFailureKind> {
    result
        .meta
        .as_mut()
        .and_then(|meta| meta.0.remove(REPORTED_CODEPRO_FAILURE_META_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
}

fn workspace_scope_violation_result(violation: WorkspaceScopeViolation) -> CallToolResult {
    let mut result = CallToolResult::error(vec![Content::text(violation.message())]);
    result.meta = Some(Meta(
        serde_json::json!({
            REPORTED_CODEPRO_FAILURE_META_KEY: CodeProFailureKind::OutsideWorkspace
        })
        .as_object()
        .expect("fixed policy metadata is an object")
        .clone(),
    ));
    result
}

pub(crate) fn insert_trusted_codepro_failure_meta(
    result: &mut CallToolResult,
    failure_kind: CodeProFailureKind,
) {
    let mut meta_map = result
        .meta
        .as_ref()
        .map(|meta| meta.0.clone())
        .unwrap_or_default();
    let mut trusted_meta = meta_map
        .remove(TRUSTED_TOOL_UPDATE_META_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    trusted_meta.insert(
        "codeProFailure".to_string(),
        serde_json::to_value(failure_kind).expect("closed failure enum serializes"),
    );
    meta_map.insert(
        TRUSTED_TOOL_UPDATE_META_KEY.to_string(),
        Value::Object(trusted_meta),
    );
    result.meta = Some(Meta(meta_map));
}

fn trusted_codepro_failure_from_value(value: &Value) -> Option<CodeProFailureKind> {
    value
        .as_object()
        .and_then(|trusted| {
            trusted.get("codeProFailure").or_else(|| {
                trusted
                    .get("toolAudit")
                    .and_then(Value::as_object)
                    .and_then(|audit| audit.get("failureKind"))
            })
        })
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(crate) fn trusted_codepro_failure_from_result(
    result: &CallToolResult,
) -> Option<CodeProFailureKind> {
    result
        .meta
        .as_ref()
        .and_then(|meta| meta.0.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(trusted_codepro_failure_from_value)
}

pub(crate) fn trusted_codepro_failure_from_error(error: &ErrorData) -> Option<CodeProFailureKind> {
    error
        .data
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|data| data.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(trusted_codepro_failure_from_value)
}

pub(crate) fn insert_trusted_tool_audit_meta(
    result: &mut CallToolResult,
    receipt: &ToolAuditReceipt,
) {
    let Ok(receipt_value) = serde_json::to_value(receipt) else {
        return;
    };
    let mut meta_map = result
        .meta
        .as_ref()
        .map(|meta| meta.0.clone())
        .unwrap_or_default();
    let mut trusted_meta = meta_map
        .remove(TRUSTED_TOOL_UPDATE_META_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    trusted_meta.insert("toolAudit".to_string(), receipt_value);
    meta_map.insert(
        TRUSTED_TOOL_UPDATE_META_KEY.to_string(),
        Value::Object(trusted_meta),
    );
    result.meta = Some(Meta(meta_map));
}

pub(crate) fn insert_trusted_workspace_delta_meta(
    result: &mut CallToolResult,
    changed_paths: &[String],
) {
    if changed_paths.is_empty() {
        return;
    }
    let mut meta_map = result
        .meta
        .as_ref()
        .map(|meta| meta.0.clone())
        .unwrap_or_default();
    let mut trusted_meta = meta_map
        .remove(TRUSTED_TOOL_UPDATE_META_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let delta = trusted_meta
        .entry("workspaceDelta")
        .or_insert_with(|| serde_json::json!({}));
    let mut paths: Vec<String> = delta
        .get("changedPaths")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    paths.extend_from_slice(changed_paths);
    paths.sort();
    paths.dedup();
    delta["changedPaths"] = serde_json::json!(paths);
    meta_map.insert(
        TRUSTED_TOOL_UPDATE_META_KEY.to_string(),
        Value::Object(trusted_meta),
    );
    result.meta = Some(Meta(meta_map));
}

pub(crate) fn trusted_workspace_delta_from_result(result: &CallToolResult) -> Option<Vec<String>> {
    result
        .meta
        .as_ref()
        .and_then(|meta| meta.0.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(|trusted| trusted.get("workspaceDelta"))
        .and_then(|delta| delta.get("changedPaths"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(crate) fn trusted_workspace_delta_from_error(error: &ErrorData) -> Option<Vec<String>> {
    error
        .data
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|data| data.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(|trusted| trusted.get("workspaceDelta"))
        .and_then(|delta| delta.get("changedPaths"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(crate) fn trusted_workspace_versions_from_result(
    result: &CallToolResult,
) -> Option<std::collections::BTreeMap<String, String>> {
    result
        .meta
        .as_ref()
        .and_then(|meta| meta.0.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(|trusted| trusted.get("workspaceDelta"))
        .and_then(|delta| delta.get("resourceVersions"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(crate) fn trusted_workspace_versions_from_error(
    error: &ErrorData,
) -> Option<std::collections::BTreeMap<String, String>> {
    error
        .data
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|data| data.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(|trusted| trusted.get("workspaceDelta"))
        .and_then(|delta| delta.get("resourceVersions"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn attach_workspace_versions(
    trusted: Option<&mut Value>,
    delta: &super::tool_execution::WorkspaceDelta,
) {
    if let Some(fields) = trusted
        .and_then(|trusted| trusted.get_mut("workspaceDelta"))
        .and_then(Value::as_object_mut)
    {
        if let Some(versions) = &delta.resource_versions {
            let value = fields
                .entry("resourceVersions")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(existing) = value.as_object_mut() {
                existing.extend(
                    versions
                        .iter()
                        .map(|(path, version)| (path.clone(), serde_json::json!(version))),
                );
            }
        }
        if !delta.resource_version_limitations.is_empty() {
            fields.insert(
                "resourceVersionLimitations".to_string(),
                serde_json::json!(delta.resource_version_limitations),
            );
        }
    }
}

fn insert_trusted_workspace_delta_error(error: &mut ErrorData, changed_paths: &[String]) {
    if changed_paths.is_empty() {
        return;
    }
    let mut data = match error.data.take() {
        Some(Value::Object(data)) => data,
        Some(original) => {
            let mut data = serde_json::Map::new();
            data.insert("originalErrorData".to_string(), original);
            data
        }
        None => serde_json::Map::new(),
    };
    let mut trusted_meta = data
        .remove(TRUSTED_TOOL_UPDATE_META_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    trusted_meta.insert(
        "workspaceDelta".to_string(),
        serde_json::json!({ "changedPaths": changed_paths }),
    );
    data.insert(
        TRUSTED_TOOL_UPDATE_META_KEY.to_string(),
        Value::Object(trusted_meta),
    );
    error.data = Some(Value::Object(data));
}

pub(crate) fn trusted_tool_audit_from_result(result: &CallToolResult) -> Option<ToolAuditReceipt> {
    result
        .meta
        .as_ref()
        .and_then(|meta| meta.0.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(|trusted| trusted.get("toolAudit"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(crate) fn trusted_tool_audit_from_error(error: &ErrorData) -> Option<ToolAuditReceipt> {
    error
        .data
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|data| data.get(TRUSTED_TOOL_UPDATE_META_KEY))
        .and_then(|trusted| trusted.get("toolAudit"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(crate) fn insert_trusted_tool_audit_error(
    mut error: ErrorData,
    receipt: &ToolAuditReceipt,
) -> ErrorData {
    let Ok(receipt_value) = serde_json::to_value(receipt) else {
        return error;
    };
    let mut data = match error.data.take() {
        Some(Value::Object(data)) => data,
        Some(original) => {
            let mut data = serde_json::Map::new();
            data.insert("originalErrorData".to_string(), original);
            data
        }
        None => serde_json::Map::new(),
    };
    let mut trusted_meta = data
        .remove(TRUSTED_TOOL_UPDATE_META_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    trusted_meta.insert("toolAudit".to_string(), receipt_value);
    data.insert(
        TRUSTED_TOOL_UPDATE_META_KEY.to_string(),
        Value::Object(trusted_meta),
    );
    error.data = Some(Value::Object(data));
    error
}

fn insert_trusted_tool_update_meta(
    result: &mut CallToolResult,
    attachment: &GooseMcpAppToolAttachment,
) {
    let Ok(attachment_value) = serde_json::to_value(attachment) else {
        return;
    };

    let mut meta_map = result
        .meta
        .as_ref()
        .map(|meta| meta.0.clone())
        .unwrap_or_default();
    let mut trusted_meta = meta_map
        .remove(TRUSTED_TOOL_UPDATE_META_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    trusted_meta.insert("mcpApp".to_string(), attachment_value);
    meta_map.insert(
        TRUSTED_TOOL_UPDATE_META_KEY.to_string(),
        Value::Object(trusted_meta),
    );
    result.meta = Some(Meta(meta_map));
}

fn is_unprefixed_extension(config: &ExtensionConfig) -> bool {
    match config {
        ExtensionConfig::Platform { name, .. } | ExtensionConfig::Builtin { name, .. } => {
            PLATFORM_EXTENSIONS
                .get(name_to_key(name).as_str())
                .is_some_and(|def| def.unprefixed_tools)
        }
        _ => false,
    }
}

fn code_execution_permission_class(tool_name: &str) -> Option<CodeProPermissionClass> {
    match tool_name {
        "list_functions" | "get_function_details" => Some(CodeProPermissionClass::ReadOnly),
        "execute_bash" | "execute_typescript" => Some(CodeProPermissionClass::HighRisk),
        _ => Some(CodeProPermissionClass::Forbidden),
    }
}

fn developer_permission_class(tool_name: &str) -> Option<CodeProPermissionClass> {
    match tool_name {
        "tree" | "search" | "read_document" | "ask_user" => Some(CodeProPermissionClass::ReadOnly),
        "write" | "edit" => Some(CodeProPermissionClass::WorkspaceWrite),
        _ => None,
    }
}

fn platform_permission_class(name: &str, tool_name: &str) -> Option<CodeProPermissionClass> {
    if is_codepro_platform_extension(name) {
        codepro_tool_spec(tool_name).map(|spec| spec.permission)
    } else if name_to_key(name) == "developer" {
        developer_permission_class(tool_name)
    } else if name_to_key(name) == "code_execution" {
        code_execution_permission_class(tool_name)
    } else if name_to_key(name) == "apps" && tool_name == "list_apps" {
        Some(CodeProPermissionClass::ReadOnly)
    } else {
        None
    }
}

fn add_computer_vision_assistance(tool: &mut Tool) {
    let schema = Arc::make_mut(&mut tool.input_schema);
    let properties = schema
        .entry("properties".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(properties) = properties.as_object_mut() {
        properties.insert("vision_assistance".into(), serde_json::json!({
            "type": "string", "minLength": 1, "maxLength": 2000,
            "description": "Optional question for the configured auxiliary vision agent. First interpret the screenshot yourself. Use this only when you cannot confidently read or locate the target; explain the uncertainty and ask a specific visual question."
        }));
    }
    tool.description = Some(format!("{} First read the returned screenshot yourself. If uncertain, call this again with vision_assistance containing a precise question; the host will ask the configured auxiliary vision agent about the fresh screenshot. Do not guess coordinates or repeat unchanged failed actions.", tool.description.as_deref().unwrap_or_default()).into());
}

pub(crate) fn standalone_computer_permission(tool_name: &str) -> CodeProPermissionClass {
    // Dispatch receives local names; inspection receives namespaced MCP definitions.
    let tool_name = tool_name
        .strip_prefix("qwen_computer__")
        .unwrap_or(tool_name);
    match tool_name {
        "list_apps" | "get_app_state" => CodeProPermissionClass::ReadOnly,
        "click"
        | "drag"
        | "scroll"
        | "type_text"
        | "press_key"
        | "set_value"
        | "perform_secondary_action" => CodeProPermissionClass::HighRisk,
        _ => CodeProPermissionClass::Forbidden,
    }
}

fn builtin_permission_class(name: &str, tool_name: &str) -> Option<CodeProPermissionClass> {
    if name_to_key(name) == "qwen_computer" {
        return Some(standalone_computer_permission(tool_name));
    }
    if name_to_key(name) == "computercontroller"
        && matches!(
            tool_name,
            "docx_tool" | "xlsx_tool" | "pdf_tool" | "web_scrape" | "cache"
        )
    {
        return Some(CodeProPermissionClass::HighRisk);
    }
    if name_to_key(name) == "autovisualiser"
        && matches!(
            tool_name,
            "show_chart"
                | "render_sankey"
                | "render_radar"
                | "render_donut"
                | "render_treemap"
                | "render_chord"
                | "render_map"
                | "render_mermaid"
        )
    {
        return Some(CodeProPermissionClass::ReadOnly);
    }
    if name_to_key(name) == "memory" && tool_name == "retrieve_memories" {
        return Some(CodeProPermissionClass::ReadOnly);
    }
    (name_to_key(name) == "developer")
        .then(|| developer_permission_class(tool_name))
        .flatten()
}

fn tool_security_profile(config: &ExtensionConfig, tool_name: &str) -> ToolSecurityProfile {
    match config {
        ExtensionConfig::Platform { name, .. } => ToolSecurityProfile {
            source: ToolExtensionSource::Platform,
            permission_class: platform_permission_class(name, tool_name),
        },
        ExtensionConfig::Builtin { name, .. } => ToolSecurityProfile {
            source: ToolExtensionSource::Builtin,
            permission_class: builtin_permission_class(name, tool_name),
        },
        ExtensionConfig::Stdio {
            name,
            read_only_tools,
            ..
        } => ToolSecurityProfile {
            source: ToolExtensionSource::ExternalStdio,
            permission_class: Some(
                if read_only_tools
                    .iter()
                    .any(|declared| external_tool_name_matches(name, declared, tool_name))
                {
                    CodeProPermissionClass::ReadOnly
                } else {
                    CodeProPermissionClass::ExternalWrite
                },
            ),
        },
        ExtensionConfig::StreamableHttp {
            name,
            read_only_tools,
            ..
        } => ToolSecurityProfile {
            source: ToolExtensionSource::ExternalHttp,
            permission_class: Some(
                if read_only_tools
                    .iter()
                    .any(|declared| external_tool_name_matches(name, declared, tool_name))
                {
                    CodeProPermissionClass::ReadOnly
                } else {
                    CodeProPermissionClass::ExternalWrite
                },
            ),
        },
        ExtensionConfig::Frontend { .. } => ToolSecurityProfile {
            source: ToolExtensionSource::Frontend,
            permission_class: None,
        },
        ExtensionConfig::InlinePython { .. } => ToolSecurityProfile {
            source: ToolExtensionSource::InlinePython,
            permission_class: None,
        },
        ExtensionConfig::Sse { .. } => ToolSecurityProfile {
            source: ToolExtensionSource::Unknown,
            permission_class: None,
        },
    }
}

fn external_tool_name_matches(extension_name: &str, declared: &str, actual: &str) -> bool {
    actual == declared
        || actual.strip_prefix(&format!("{}__", name_to_key(extension_name))) == Some(declared)
}

fn codepro_platform_owner(tool_name: &str) -> Option<&'static str> {
    codepro_tool_spec(tool_name)?;
    if tool_name.starts_with("git_") {
        Some("git")
    } else if tool_name.starts_with("computer_") {
        Some("computer")
    } else if tool_name.starts_with("project_memory_") {
        Some("projectmemory")
    } else {
        None
    }
}

fn registered_codepro_permission_profile(
    extensions: &HashMap<String, Extension>,
    tool_name: &str,
) -> Option<ToolSecurityProfile> {
    let owner = codepro_platform_owner(tool_name)?;
    let extension = extensions.get(owner)?;
    match &extension.config {
        ExtensionConfig::Platform { name, .. } if name_to_key(name) == owner => {
            Some(tool_security_profile(&extension.config, tool_name))
        }
        _ => None,
    }
}

fn is_codepro_platform_extension(name: &str) -> bool {
    matches!(
        name_to_key(name).as_str(),
        "git" | "computer" | "projectmemory"
    )
}

/// Returns true if the named extension is a first-class platform extension
/// whose tools are exposed unprefixed and remain visible during code execution mode.
pub fn is_first_class_extension(name: &str) -> bool {
    // Desktop images must reach the model as MCP content, not text-only script values.
    if name_to_key(name) == "qwen_computer" {
        return true;
    }
    PLATFORM_EXTENSIONS
        .get(name_to_key(name).as_str())
        .is_some_and(|def| def.unprefixed_tools)
}

pub fn is_hidden_extension(name: &str) -> bool {
    PLATFORM_EXTENSIONS
        .get(name_to_key(name).as_str())
        .is_some_and(|def| def.hidden)
}

/// Result of resolving a tool call to its owning extension
struct ResolvedTool {
    tool_name: String,
    extension_name: String,
    actual_tool_name: String,
    input_schema: Value,
    client: McpClientBox,
    tool_meta: Option<Value>,
    resource_uri: Option<String>,
    execution_timeout: Duration,
}

async fn child_process_client(
    mut command: Command,
    timeout: &Option<u64>,
    provider: SharedProvider,
    working_dir: &PathBuf,
    docker_container: Option<String>,
    client_name: String,
    capabilities: GooseMcpClientCapabilities,
) -> ExtensionResult<McpClient> {
    configure_subprocess(&mut command);

    if let Ok(path) = SearchPaths::builder().path() {
        command.env("PATH", path);
    }

    if working_dir.exists() && working_dir.is_dir() {
        tracing::info!("Setting MCP process working directory: {:?}", working_dir);
        command.current_dir(working_dir);
    } else {
        tracing::warn!(
            "Working directory doesn't exist or isn't a directory: {:?}",
            working_dir
        );
    }

    let (transport, mut stderr) = TokioChildProcess::builder(command)
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stderr = stderr.take().ok_or_else(|| {
        ExtensionError::SetupError("failed to attach child process stderr".to_owned())
    })?;

    let stderr_task = tokio::spawn(async move {
        let mut all_stderr = Vec::new();
        stderr.read_to_end(&mut all_stderr).await?;
        Ok::<String, std::io::Error>(String::from_utf8_lossy(&all_stderr).into())
    });

    let client_result = McpClient::connect_with_container(
        transport,
        Duration::from_secs(resolve_timeout(*timeout)),
        provider,
        docker_container,
        client_name,
        capabilities,
        working_dir.clone(),
    )
    .await;

    match client_result {
        Ok(client) => Ok(client),
        Err(error) => {
            let error_task_out = stderr_task.await?;
            Err::<McpClient, ExtensionError>(match error_task_out {
                Ok(stderr_content) => ProcessExit::new(stderr_content, error).into(),
                Err(e) => e.into(),
            })
        }
    }
}

/// Retry with OAuth for typed auth challenges and wrapped bare HTTP 401 responses.
fn is_oauth_auth_failure(err: &ClientInitializeError) -> bool {
    let ClientInitializeError::TransportError {
        error: DynamicTransportError { error, .. },
        ..
    } = err
    else {
        return false;
    };

    if let Some(http_err) = error.downcast_ref::<StreamableHttpError<reqwest::Error>>() {
        return match http_err {
            StreamableHttpError::AuthRequired(_) => true,
            StreamableHttpError::UnexpectedServerResponse(body) => body.starts_with("HTTP 401"),
            _ => false,
        };
    }

    #[cfg(unix)]
    if let Some(http_err) = error
        .downcast_ref::<StreamableHttpError<rmcp::transport::common::unix_socket::UnixSocketError>>(
        )
    {
        return match http_err {
            StreamableHttpError::AuthRequired(_) => true,
            StreamableHttpError::UnexpectedServerResponse(body) => body.starts_with("HTTP 401"),
            _ => false,
        };
    }

    error
        .to_string()
        .contains("unexpected server response: HTTP 401")
}

fn should_attempt_oauth_fallback(res: &Result<McpClient, ClientInitializeError>) -> bool {
    res.as_ref().err().is_some_and(is_oauth_auth_failure)
}

async fn clear_credentials_on_post_refresh_auth_failure(
    credential_store: &dyn CredentialStore,
    name: &str,
    error: &ExtensionError,
) -> bool {
    let ExtensionError::InitializeError(err) = error else {
        return false;
    };

    if !is_oauth_auth_failure(err) {
        return false;
    }

    if let Err(e) = credential_store.clear().await {
        warn!(
            "[OAuth:{}] error clearing rejected credentials: {}",
            name, e
        );
    }
    true
}

/// Merge environment variables from direct envs and keychain-stored env_keys
pub(crate) async fn merge_environments(
    envs: &Envs,
    env_keys: &[String],
    ext_name: &str,
    config: &Config,
) -> Result<HashMap<String, String>, ExtensionError> {
    let mut all_envs = envs.get_env();

    for key in env_keys {
        if all_envs.contains_key(key) {
            continue;
        }

        match config.get(key, true) {
            Ok(value) => {
                if value.is_null() {
                    warn!(
                        key = %key,
                        ext_name = %ext_name,
                        "Secret key not found in config (returned null)."
                    );
                    continue;
                }

                if let Some(str_val) = value.as_str() {
                    all_envs.insert(key.clone(), str_val.to_string());
                } else {
                    warn!(
                        key = %key,
                        ext_name = %ext_name,
                        value_type = %value.get("type").and_then(|t| t.as_str()).unwrap_or("unknown"),
                        "Secret value is not a string; skipping."
                    );
                }
            }
            Err(e) => {
                error!(
                    key = %key,
                    ext_name = %ext_name,
                    error = %e,
                    "Failed to fetch secret from config."
                );
                return Err(ExtensionError::ConfigError(format!(
                    "Failed to fetch secret '{}' from config: {}",
                    key, e
                )));
            }
        }
    }

    Ok(Envs::new(all_envs).get_env())
}

/// Substitute environment variables in a string. Supports both ${VAR} and $VAR syntax.
pub(crate) fn substitute_env_vars(value: &str, env_map: &HashMap<String, String>) -> String {
    let mut result = value.to_string();

    for cap in RE_ENV_BRACES.captures_iter(value) {
        if let Some(var_name) = cap.get(1) {
            if let Some(env_value) = env_map.get(var_name.as_str()) {
                result = result.replace(&cap[0], env_value);
            }
        }
    }

    // Scan the original input for $VAR patterns (not the post-substitution result)
    // to avoid recursive expansion when a substituted value contains $OTHER_VAR.
    for cap in RE_ENV_SIMPLE.captures_iter(value) {
        if let Some(var_name) = cap.get(1) {
            if !value.contains(&format!("${{{}}}", var_name.as_str())) {
                if let Some(env_value) = env_map.get(var_name.as_str()) {
                    result = result.replace(&cap[0], env_value);
                }
            }
        }
    }

    result
}

const GOOSE_USER_AGENT: reqwest::header::HeaderValue =
    reqwest::header::HeaderValue::from_static(concat!("goose/", env!("CARGO_PKG_VERSION")));

#[allow(clippy::too_many_arguments)]
async fn connect_with_auth(
    auth_manager: rmcp::transport::AuthorizationManager,
    uri: &str,
    timeout: Duration,
    headers: &HashMap<String, String>,
    provider: SharedProvider,
    client_name: String,
    capabilities: GooseMcpClientCapabilities,
    roots_dir: &std::path::Path,
) -> ExtensionResult<Box<dyn McpClientTrait>> {
    let mut auth_headers = HeaderMap::new();
    auth_headers.insert(reqwest::header::USER_AGENT, GOOSE_USER_AGENT);
    for (key, value) in headers {
        auth_headers.insert(
            HeaderName::try_from(key)
                .map_err(|_| ExtensionError::ConfigError(format!("invalid header: {}", key)))?,
            value.parse().map_err(|_| {
                ExtensionError::ConfigError(format!("invalid header value: {}", key))
            })?,
        );
    }
    #[allow(unused_mut)]
    let mut auth_client_builder = reqwest::Client::builder().default_headers(auth_headers);
    #[cfg(target_os = "linux")]
    {
        auth_client_builder = auth_client_builder.tcp_user_timeout(Some(timeout));
    }
    let auth_http_client = auth_client_builder
        .build()
        .map_err(|_| ExtensionError::ConfigError("could not construct http client".to_string()))?;
    let auth_client = AuthClient::new(auth_http_client, auth_manager);
    let transport = StreamableHttpClientTransport::with_client(
        auth_client,
        StreamableHttpClientTransportConfig::with_uri(uri),
    );
    Ok(Box::new(
        McpClient::connect(
            transport,
            timeout,
            provider,
            client_name,
            capabilities,
            roots_dir.to_path_buf(),
        )
        .await?,
    ))
}

#[allow(clippy::too_many_arguments)]
async fn create_streamable_http_client(
    uri: &str,
    timeout: Option<u64>,
    headers: &HashMap<String, String>,
    name: &str,
    socket: Option<&str>,
    credential_store: Box<dyn CredentialStore>,
    provider: SharedProvider,
    client_name: String,
    capabilities: GooseMcpClientCapabilities,
    roots_dir: &std::path::Path,
) -> ExtensionResult<Box<dyn McpClientTrait>> {
    #[cfg(unix)]
    if let Some(socket_path) = socket {
        return create_unix_socket_http_client(
            uri,
            timeout,
            headers,
            name,
            socket_path,
            provider,
            client_name,
            capabilities,
            roots_dir,
        )
        .await;
    }
    #[cfg(not(unix))]
    if socket.is_some() {
        return Err(ExtensionError::ConfigError(
            "Unix domain socket transport is not supported on this platform".to_string(),
        ));
    }

    let mut default_headers = HeaderMap::new();

    default_headers.insert(reqwest::header::USER_AGENT, GOOSE_USER_AGENT);

    for (key, value) in headers {
        default_headers.insert(
            HeaderName::try_from(key)
                .map_err(|_| ExtensionError::ConfigError(format!("invalid header: {}", key)))?,
            value.parse().map_err(|_| {
                ExtensionError::ConfigError(format!("invalid header value: {}", key))
            })?,
        );
    }

    let timeout_duration = Duration::from_secs(resolve_timeout(timeout));

    #[allow(unused_mut)]
    let mut http_client_builder = reqwest::Client::builder().default_headers(default_headers);
    #[cfg(target_os = "linux")]
    {
        http_client_builder = http_client_builder.tcp_user_timeout(Some(timeout_duration));
    }
    let http_client = http_client_builder
        .build()
        .map_err(|_| ExtensionError::ConfigError("could not construct http client".to_string()))?;

    let transport = StreamableHttpClientTransport::with_client(
        http_client,
        StreamableHttpClientTransportConfig::with_uri(uri),
    );

    // If we have stored OAuth credentials, try refreshing and connecting directly.
    // This avoids the unnecessary 401 → browser re-auth cycle on every new session.
    if credential_store.load().await.is_ok_and(|c| c.is_some()) {
        match oauth_flow(&uri.to_string(), &name.to_string()).await {
            Ok(auth_manager) => {
                let auth_result = connect_with_auth(
                    auth_manager,
                    uri,
                    timeout_duration,
                    headers,
                    provider.clone(),
                    client_name.clone(),
                    capabilities.clone(),
                    roots_dir,
                )
                .await;

                if let Err(error) = &auth_result {
                    if clear_credentials_on_post_refresh_auth_failure(
                        credential_store.as_ref(),
                        name,
                        error,
                    )
                    .await
                    {
                        warn!(
                            "[OAuth:{}] Refreshed token was rejected, falling back to browser auth",
                            name
                        );
                    } else {
                        return auth_result;
                    }
                } else {
                    return auth_result;
                }
            }
            Err(e) => {
                warn!(
                    "[OAuth:{}] Proactive refresh failed: {}, falling back to unauthenticated attempt",
                    name, e
                );
            }
        }
    }

    let client_res = McpClient::connect(
        transport,
        timeout_duration,
        provider.clone(),
        client_name.clone(),
        capabilities.clone(),
        roots_dir.to_path_buf(),
    )
    .await;

    if should_attempt_oauth_fallback(&client_res) {
        match oauth_flow(&uri.to_string(), &name.to_string()).await {
            Ok(auth_manager) => {
                connect_with_auth(
                    auth_manager,
                    uri,
                    timeout_duration,
                    headers,
                    provider,
                    client_name,
                    capabilities,
                    roots_dir,
                )
                .await
            }
            Err(_) => Ok(Box::new(client_res?)),
        }
    } else {
        Ok(Box::new(client_res?))
    }
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
async fn create_unix_socket_http_client(
    uri: &str,
    timeout: Option<u64>,
    headers: &HashMap<String, String>,
    name: &str,
    socket_path: &str,
    provider: SharedProvider,
    client_name: String,
    capabilities: GooseMcpClientCapabilities,
    roots_dir: &std::path::Path,
) -> ExtensionResult<Box<dyn McpClientTrait>> {
    use rmcp::transport::UnixSocketHttpClient;

    let unix_client = UnixSocketHttpClient::new(socket_path, uri);

    let mut custom_headers = std::collections::HashMap::<HeaderName, HeaderValue>::new();

    custom_headers.insert(
        HeaderName::from_static("user-agent"),
        GOOSE_USER_AGENT
            .to_str()
            .unwrap_or("goose")
            .parse()
            .unwrap_or_else(|_| HeaderValue::from_static("goose")),
    );

    for (key, value) in headers {
        let header_name = HeaderName::try_from(key)
            .map_err(|_| ExtensionError::ConfigError(format!("invalid header: {}", key)))?;
        let header_value = value
            .parse::<HeaderValue>()
            .map_err(|_| ExtensionError::ConfigError(format!("invalid header value: {}", key)))?;
        custom_headers.insert(header_name, header_value);
    }

    let config = StreamableHttpClientTransportConfig::with_uri(uri).custom_headers(custom_headers);
    let transport = StreamableHttpClientTransport::with_client(unix_client, config);

    let timeout_duration = Duration::from_secs(resolve_timeout(timeout));

    let client_res = McpClient::connect(
        transport,
        timeout_duration,
        provider.clone(),
        client_name.clone(),
        capabilities.clone(),
        roots_dir.to_path_buf(),
    )
    .await;

    if should_attempt_oauth_fallback(&client_res) {
        tracing::warn!(
            "Extension '{}' returned 401 over Unix domain socket transport; \
             OAuth is not supported for UDS connections",
            name,
        );
    }
    Ok(Box::new(client_res?))
}

impl ExtensionManager {
    fn mcp_client_capabilities(&self) -> GooseMcpClientCapabilities {
        GooseMcpClientCapabilities {
            mcpui: self.capabilities.mcpui,
            host_info: self.capabilities.host_info.clone(),
            roots: true,
        }
    }

    fn stdio_client_capabilities(&self, cmd: &str, args: &[String]) -> GooseMcpClientCapabilities {
        let mut capabilities = self.mcp_client_capabilities();
        if !stdio_should_advertise_roots(cmd, args) {
            // This server requests roots immediately after initialization and replaces its
            // command-line allowlist with the reply. Keeping roots disabled preserves the
            // directory scope the user explicitly configured and avoids the early-request race.
            capabilities.roots = false;
        }
        capabilities
    }

    pub fn new(
        provider: SharedProvider,
        session_manager: Arc<crate::session::SessionManager>,
        client_name: String,
        capabilities: ExtensionManagerCapabilities,
        use_login_shell_path: bool,
    ) -> Self {
        let tool_idempotency_store = Arc::new(ToolIdempotencyStore::new(
            session_manager
                .data_dir()
                .join("audit")
                .join("tool-idempotency-v1"),
        ));
        let tool_audit_store = Arc::new(ToolAuditStore::new(
            session_manager.data_dir().join("audit"),
        ));
        Self {
            extensions: Mutex::new(HashMap::new()),
            context: PlatformExtensionContext {
                extension_manager: None,
                session_manager,
                session: None,
                use_login_shell_path,
            },
            provider,
            tools_cache: Mutex::new(None),
            tools_cache_version: AtomicU64::new(0),
            client_name,
            capabilities,
            tool_execution_limits: ToolExecutionLimits::configured(),
            tool_idempotency_store,
            tool_audit_store,
        }
    }

    pub fn new_without_provider(data_dir: std::path::PathBuf) -> Self {
        let session_manager = Arc::new(crate::session::SessionManager::new(data_dir));
        Self::new(
            Arc::new(Mutex::new(None)),
            session_manager,
            "goose-cli".to_string(),
            ExtensionManagerCapabilities {
                mcpui: false,
                host_info: None,
            },
            false,
        )
    }

    pub fn get_context(&self) -> &PlatformExtensionContext {
        &self.context
    }

    pub fn get_provider(&self) -> &SharedProvider {
        &self.provider
    }

    pub async fn supports_resources(&self) -> bool {
        self.extensions
            .lock()
            .await
            .values()
            .any(|ext| ext.supports_resources())
    }

    /// Add an extension with an optional working directory.
    /// If working_dir is None, falls back to current_dir.
    #[allow(clippy::too_many_lines)]
    pub async fn add_extension(
        self: &Arc<Self>,
        config: ExtensionConfig,
        working_dir: Option<PathBuf>,
        container: Option<&Container>,
        session_id: Option<&str>,
    ) -> ExtensionResult<()> {
        let sanitized_name = config.key();

        // Compare both the unresolved config (to detect structural changes like
        // migrating from plaintext envs to env_keys) and the resolved config (to
        // detect secret rotation where only keyring values changed). Only skip
        // restart if both match.
        let resolved_config = config.clone().resolve(Config::global()).await?;

        if let Some(existing) = self.extensions.lock().await.get(&sanitized_name) {
            if existing.config == config && existing.resolved_config == resolved_config {
                return Ok(());
            }
            tracing::debug!(
                name = sanitized_name,
                "extension config changed, restarting with updated config"
            );
        }

        let mut temp_dir = None;

        let effective_working_dir = working_dir
            .clone()
            .or_else(|| std::env::var("GOOSE_WORKING_DIR").ok().map(PathBuf::from))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

        let client: Box<dyn McpClientTrait> = match &config {
            ExtensionConfig::Sse { .. } => {
                return Err(ExtensionError::ConfigError(
                    "SSE is unsupported, migrate to streamable_http".to_string(),
                ));
            }
            ExtensionConfig::StreamableHttp {
                uri,
                timeout,
                headers,
                name,
                envs,
                env_keys,
                socket,
                ..
            } => {
                let config = Config::global();
                let all_envs = merge_environments(envs, env_keys, &sanitized_name, config).await?;
                let resolved_uri = substitute_env_vars(uri, &all_envs);
                let resolved_headers = headers
                    .iter()
                    .map(|(k, v)| (k.clone(), substitute_env_vars(v, &all_envs)))
                    .collect();
                let resolved_socket = socket.as_ref().map(|s| substitute_env_vars(s, &all_envs));
                create_streamable_http_client(
                    &resolved_uri,
                    *timeout,
                    &resolved_headers,
                    name,
                    resolved_socket.as_deref(),
                    Box::new(GooseCredentialStore::new(name.to_string())),
                    self.provider.clone(),
                    self.client_name.clone(),
                    self.mcp_client_capabilities(),
                    &effective_working_dir,
                )
                .await?
            }
            ExtensionConfig::Builtin { ref name, .. }
            | ExtensionConfig::Platform { ref name, .. } => {
                let timeout = if let ExtensionConfig::Builtin { timeout, .. } = &config {
                    *timeout
                } else {
                    None
                };
                let normalized_name = name_to_key(name);

                if normalized_name == "qwen_computer"
                    && matches!(config, ExtensionConfig::Builtin { .. })
                {
                    if !(cfg!(windows) || cfg!(target_os = "macos")) || container.is_some() {
                        return Err(ExtensionError::ConfigError(
                            "The bundled computer MCP requires a local Windows or macOS desktop"
                                .into(),
                        ));
                    }
                    let executable = std::env::current_exe()?.with_file_name(if cfg!(windows) {
                        "qwen-computer-use.exe"
                    } else {
                        "qwen-computer-use"
                    });
                    if !executable.is_file() {
                        return Err(ExtensionError::ConfigError(format!(
                            "Missing bundled computer MCP: {}",
                            executable.display()
                        )));
                    }
                    let command = Command::new(executable).configure(|command| {
                        command
                            .args(["--foreground-input", "mcp"])
                            .env_remove("OPEN_COMPUTER_USE_HOST_CONTROLLED");
                    });
                    Box::new(
                        child_process_client(
                            command,
                            &Some(resolve_timeout(timeout)),
                            self.provider.clone(),
                            &effective_working_dir,
                            None,
                            self.client_name.clone(),
                            self.mcp_client_capabilities(),
                        )
                        .await?,
                    )
                } else if let Some(def) = PLATFORM_EXTENSIONS.get(normalized_name.as_str()) {
                    // Platform extension: create via in-process client factory
                    let mut context = self.context.clone();
                    context.extension_manager = Some(Arc::downgrade(self));
                    if let Some(id) = session_id {
                        if let Ok(session) =
                            self.context.session_manager.get_session(id, false).await
                        {
                            context.session = Some(Arc::new(session));
                        }
                    }
                    (def.client_factory)(context)
                } else {
                    // Builtin MCP server extension
                    let timeout_secs = resolve_timeout(timeout);
                    let extension_fn =
                        get_builtin_extension(normalized_name.as_str()).ok_or_else(|| {
                            ExtensionError::ConfigError(format!("Unknown extension: {}", name))
                        })?;

                    if let Some(container) = container {
                        let container_id = container.id();
                        tracing::info!(
                            container = %container_id,
                            builtin = %name,
                            "Starting builtin extension inside Docker container"
                        );
                        let command = Command::new("docker").configure(|command| {
                            command
                                .arg("exec")
                                .arg("-i")
                                .arg(container_id)
                                .arg("goose")
                                .arg("mcp")
                                .arg(&normalized_name);
                        });

                        let client = child_process_client(
                            command,
                            &Some(timeout_secs),
                            self.provider.clone(),
                            &effective_working_dir,
                            Some(container_id.to_string()),
                            self.client_name.clone(),
                            self.mcp_client_capabilities(),
                        )
                        .await?;
                        Box::new(client)
                    } else {
                        let (server_read, client_write) = tokio::io::duplex(65536);
                        let (client_read, server_write) = tokio::io::duplex(65536);
                        extension_fn(server_read, server_write);

                        Box::new(
                            McpClient::connect(
                                (client_read, client_write),
                                Duration::from_secs(timeout_secs),
                                self.provider.clone(),
                                self.client_name.clone(),
                                self.mcp_client_capabilities(),
                                effective_working_dir.clone(),
                            )
                            .await?,
                        )
                    }
                }
            }
            ExtensionConfig::Stdio {
                cmd,
                args,
                envs,
                env_keys,
                timeout,
                cwd,
                ..
            } => {
                let config = Config::global();
                let mut all_envs =
                    merge_environments(envs, env_keys, &sanitized_name, config).await?;
                let process_working_dir = cwd
                    .as_deref()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| effective_working_dir.clone());

                if let Some(sid) = session_id {
                    all_envs.insert("AGENT_SESSION_ID".to_string(), sid.to_string());
                }

                // Check for malicious packages before launching the process
                extension_malware_check::deny_if_malicious_cmd_args(cmd, args).await?;

                let command = if let Some(container) = container {
                    let container_id = container.id();
                    tracing::info!(
                        container = %container_id,
                        cmd = %cmd,
                        "Starting stdio extension inside Docker container"
                    );
                    Command::new("docker").configure(|command| {
                        command.arg("exec").arg("-i");
                        for (key, value) in &all_envs {
                            command.arg("-e").arg(format!("{}={}", key, value));
                        }
                        command.arg(container_id);
                        command.arg(cmd);
                        command.args(args);
                    })
                } else {
                    let cmd = resolve_command(cmd);
                    Command::new(cmd).configure(|command| {
                        command.args(args).envs(all_envs);
                    })
                };

                let client = child_process_client(
                    command,
                    timeout,
                    self.provider.clone(),
                    &process_working_dir,
                    container.map(|c| c.id().to_string()),
                    self.client_name.clone(),
                    self.stdio_client_capabilities(cmd, args),
                )
                .await?;
                Box::new(client)
            }
            ExtensionConfig::InlinePython {
                name,
                code,
                timeout,
                dependencies,
                ..
            } => {
                let dir = tempdir()?;
                let file_path = dir.path().join(format!("{}.py", name));
                temp_dir = Some(dir);
                std::fs::write(&file_path, code)?;

                let command = Command::new("uvx").configure(|command| {
                    command.arg("--with").arg("mcp");
                    dependencies.iter().flatten().for_each(|dep| {
                        command.arg("--with").arg(dep);
                    });
                    command.arg("python").arg(file_path.to_str().unwrap());
                });

                let client = child_process_client(
                    command,
                    timeout,
                    self.provider.clone(),
                    &effective_working_dir,
                    container.map(|c| c.id().to_string()),
                    self.client_name.clone(),
                    self.mcp_client_capabilities(),
                )
                .await?;

                Box::new(client)
            }
            ExtensionConfig::Frontend { .. } => {
                return Err(ExtensionError::ConfigError(
                    "Invalid extension type: Frontend extensions cannot be added as server extensions".to_string()
                ));
            }
        };

        let server_info = client.get_info().cloned();

        let mut extensions = self.extensions.lock().await;
        extensions.insert(
            sanitized_name,
            Extension::new(
                config,
                resolved_config,
                Arc::from(client),
                server_info,
                temp_dir,
            ),
        );
        drop(extensions);
        self.invalidate_tools_cache_and_bump_version().await;

        Ok(())
    }

    pub async fn add_client(
        &self,
        name: String,
        config: ExtensionConfig,
        client: McpClientBox,
        info: Option<ServerInfo>,
        temp_dir: Option<TempDir>,
    ) {
        let normalized = name_to_key(&name);
        self.extensions.lock().await.insert(
            normalized,
            Extension::new(config.clone(), config.clone(), client, info, temp_dir),
        );
        self.invalidate_tools_cache_and_bump_version().await;
    }

    /// Get extensions info for building the system prompt
    pub async fn get_extensions_info(&self, working_dir: &std::path::Path) -> Vec<ExtensionInfo> {
        let working_dir_str = working_dir.to_string_lossy();
        self.extensions
            .lock()
            .await
            .iter()
            .map(|(name, ext)| {
                let instructions = ext.get_instructions().unwrap_or_default();
                let instructions = instructions.replace("{{WORKING_DIR}}", &working_dir_str);
                ExtensionInfo::new(name, &instructions, ext.supports_resources())
            })
            .collect()
    }

    /// Get aggregated usage statistics
    pub async fn remove_extension(&self, name: &str) -> ExtensionResult<()> {
        let sanitized_name = name_to_key(name);
        self.extensions.lock().await.remove(&sanitized_name);
        self.invalidate_tools_cache_and_bump_version().await;
        Ok(())
    }

    pub async fn update_working_dir(&self, new_dir: &std::path::Path) {
        let extensions = self.extensions.lock().await;
        for (name, ext) in extensions.iter() {
            if let Err(e) = ext.client.update_working_dir(new_dir.to_path_buf()).await {
                tracing::warn!(extension = %name, error = %e, "failed to update roots");
            }
        }
    }

    pub async fn get_extension_and_tool_counts(&self, session_id: &str) -> (usize, usize) {
        let enabled_extensions_count = self.extensions.lock().await.len();

        let total_tools = self
            .get_prefixed_tools(session_id, None)
            .await
            .map(|tools| tools.len())
            .unwrap_or(0);

        (enabled_extensions_count, total_tools)
    }

    pub async fn list_extensions(&self) -> ExtensionResult<Vec<String>> {
        Ok(self.extensions.lock().await.keys().cloned().collect())
    }

    pub async fn is_extension_enabled(&self, name: &str) -> bool {
        let normalized = name_to_key(name);
        self.extensions.lock().await.contains_key(&normalized)
    }

    pub async fn get_extension_configs(&self) -> Vec<ExtensionConfig> {
        self.extensions
            .lock()
            .await
            .values()
            .map(|ext| ext.config.clone())
            .collect()
    }

    pub(crate) async fn registered_codepro_tool_security_profile(
        &self,
        tool_name: &str,
    ) -> Option<ToolSecurityProfile> {
        let extensions = self.extensions.lock().await;
        registered_codepro_permission_profile(&extensions, tool_name)
    }

    pub(crate) async fn tool_security_profiles(
        &self,
        tools: &[Tool],
    ) -> HashMap<String, ToolSecurityProfile> {
        let extensions = self.extensions.lock().await;
        tools
            .iter()
            .map(|tool| {
                let profile = get_tool_owner(tool)
                    .and_then(|owner| extensions.get(&name_to_key(&owner)))
                    .map(|extension| tool_security_profile(&extension.config, &tool.name))
                    .or_else(|| registered_codepro_permission_profile(&extensions, &tool.name))
                    .unwrap_or(ToolSecurityProfile {
                        source: ToolExtensionSource::Unknown,
                        permission_class: None,
                    });
                (tool.name.to_string(), profile)
            })
            .collect()
    }

    /// Get all tools from all clients with proper prefixing
    pub async fn get_prefixed_tools(
        &self,
        session_id: &str,
        extension_name: Option<String>,
    ) -> ExtensionResult<Vec<Tool>> {
        let all_tools = self.get_all_tools_cached(session_id).await?;
        Ok(self.filter_tools(&all_tools, extension_name.as_deref(), None))
    }

    pub async fn get_prefixed_tools_excluding(
        &self,
        session_id: &str,
        exclude: &str,
    ) -> ExtensionResult<Vec<Tool>> {
        let all_tools = self.get_all_tools_cached(session_id).await?;
        Ok(self.filter_tools(&all_tools, None, Some(exclude)))
    }

    fn filter_tools(
        &self,
        tools: &[Tool],
        extension_name: Option<&str>,
        exclude: Option<&str>,
    ) -> Vec<Tool> {
        let extension_name_normalized = extension_name.map(name_to_key);
        let exclude_normalized = exclude.map(name_to_key);

        tools
            .iter()
            .filter(|tool| {
                let tool_owner = get_tool_owner(tool)
                    .map(|s| name_to_key(&s))
                    .unwrap_or_else(|| tool.name.split("__").next().unwrap_or("").to_string());

                if let Some(ref excluded) = exclude_normalized {
                    if tool_owner == *excluded {
                        return false;
                    }
                }

                if let Some(ref name_filter) = extension_name_normalized {
                    tool_owner == *name_filter
                } else {
                    true
                }
            })
            .cloned()
            .collect()
    }

    async fn get_all_tools_cached(&self, session_id: &str) -> ExtensionResult<Arc<Vec<Tool>>> {
        {
            let cache = self.tools_cache.lock().await;
            if let Some(ref tools) = *cache {
                return Ok(Arc::clone(tools));
            }
        }

        let version_before = self.tools_cache_version.load(Ordering::SeqCst);
        let tools = Arc::new(self.fetch_all_tools(session_id).await?);

        {
            let mut cache = self.tools_cache.lock().await;
            let version_after = self.tools_cache_version.load(Ordering::SeqCst);
            if version_after == version_before && cache.is_none() {
                *cache = Some(Arc::clone(&tools));
            }
        }

        Ok(tools)
    }

    fn host_supports_mcp_apps(&self) -> bool {
        if let Some(host_info) = &self.capabilities.host_info {
            if host_info.explicit_extensions {
                return host_info.mcpui_enabled();
            }
        }

        self.capabilities.mcpui
    }

    async fn hydrate_mcp_app_attachment(
        client: &McpClientBox,
        session_id: &str,
        resolved_tool: &ResolvedTool,
        cancellation_token: CancellationToken,
    ) -> Option<GooseMcpAppToolAttachment> {
        let resource_uri = resolved_tool.resource_uri.clone()?;

        let mut attachment = GooseMcpAppToolAttachment {
            tool_name: resolved_tool.tool_name.clone(),
            extension_name: resolved_tool.extension_name.clone(),
            resource_uri: resource_uri.clone(),
            tool_meta: resolved_tool.tool_meta.clone(),
            resource_result: None,
            read_error: None,
        };

        match client
            .read_resource(session_id, &resource_uri, cancellation_token)
            .await
        {
            Ok(resource_result) => {
                attachment.resource_result = serde_json::to_value(&resource_result).ok();
            }
            Err(error) => {
                attachment.read_error = Some(error.to_string());
            }
        }

        Some(attachment)
    }

    async fn invalidate_tools_cache_and_bump_version(&self) {
        self.tools_cache_version.fetch_add(1, Ordering::SeqCst);
        *self.tools_cache.lock().await = None;
    }

    async fn fetch_all_tools(&self, session_id: &str) -> ExtensionResult<Vec<Tool>> {
        let clients: Vec<_> = self
            .extensions
            .lock()
            .await
            .iter()
            .map(|(name, ext)| (name.clone(), ext.config.clone(), ext.get_client()))
            .collect();

        let cancel_token = CancellationToken::default();
        let client_futures = clients.into_iter().map(|(name, config, client)| {
            let cancel_token = cancel_token.clone();
            let ext_name = name.clone();
            async move {
                let mut tools = Vec::new();
                let mut client_tools = match client
                    .list_tools(session_id, None, cancel_token.clone())
                    .await
                {
                    Ok(t) => t,
                    Err(e) => {
                        warn!(extension = %ext_name, error = %e, "Failed to list tools");
                        return (name, vec![]);
                    }
                };

                let expose_unprefixed = is_unprefixed_extension(&config);

                loop {
                    for mut tool in client_tools.tools {
                        if config.is_tool_available(&tool.name) {
                            if matches!(&config, ExtensionConfig::Builtin { name, .. } if name == "qwen_computer") && tool.name == "get_app_state" {
                                add_computer_vision_assistance(&mut tool);
                            }
                            // Analysis disclosure also consumes MCP annotations. Project the
                            // host's explicit external read-only declaration into that same
                            // catalog instead of exposing it only to callback authorization.
                            if matches!(
                                config,
                                ExtensionConfig::Stdio { .. }
                                    | ExtensionConfig::StreamableHttp { .. }
                            ) && tool_security_profile(&config, &tool.name).permission_class
                                == Some(CodeProPermissionClass::ReadOnly)
                                && !tool.annotations.as_ref().is_some_and(|annotations| {
                                    annotations.destructive_hint == Some(true)
                                })
                            {
                                tool.annotations.get_or_insert_with(Default::default).read_only_hint =
                                    Some(true);
                            }
                            let public_name = if expose_unprefixed {
                                tool.name.to_string()
                            } else {
                                format!("{}__{}", name, tool.name)
                            };

                            let mut meta_map = tool
                                .meta
                                .as_ref()
                                .map(|m| m.0.clone())
                                .unwrap_or_default();
                            meta_map.insert(
                                TOOL_EXTENSION_META_KEY.to_string(),
                                serde_json::Value::String(name.clone()),
                            );

                            tool.name = public_name.into();
                            tool.meta = Some(rmcp::model::Meta(meta_map));

                            tools.push(tool);
                        }
                    }

                    if client_tools.next_cursor.is_none() {
                        break;
                    }

                    client_tools = match client
                        .list_tools(session_id, client_tools.next_cursor, cancel_token.clone())
                        .await
                    {
                        Ok(t) => t,
                        Err(e) => {
                            warn!(extension = %ext_name, error = %e, "Failed to list tools (pagination)");
                            break;
                        }
                    };
                }

                (name, tools)
            }
        });

        let results = future::join_all(client_futures).await;

        let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut tools = Vec::new();
        for (ext_name, client_tools) in results {
            for tool in client_tools {
                let tool_name = tool.name.to_string();
                if seen_names.contains(&tool_name) {
                    warn!(
                        tool = %tool_name,
                        extension = %ext_name,
                        "Duplicate tool name - skipping"
                    );
                    continue;
                }
                seen_names.insert(tool_name);
                tools.push(tool);
            }
        }

        Ok(tools)
    }

    /// Get the extension prompt including client instructions
    pub async fn get_planning_prompt(&self, tools_info: Vec<ToolInfo>) -> String {
        let mut context: HashMap<&str, Value> = HashMap::new();
        context.insert("tools", serde_json::to_value(tools_info).unwrap());

        prompt_template::render_template("plan.md", &context).expect("Prompt should render")
    }

    // Function that gets executed for read_resource tool
    pub async fn read_resource_tool(
        &self,
        session_id: &str,
        params: Value,
        cancellation_token: CancellationToken,
    ) -> Result<Vec<Content>, ErrorData> {
        let uri = require_str_parameter(&params, "uri")?;
        let extension_name = require_str_parameter(&params, "extension_name")?;

        let read_result = self
            .read_resource(session_id, uri, extension_name, cancellation_token)
            .await?;

        let mut result = Vec::new();
        for content in read_result.contents {
            if let ResourceContents::TextResourceContents { text, .. } = content {
                result.push(Content::text(format!("{}\n\n{}", uri, text)));
            }
        }
        Ok(result)
    }

    pub async fn read_resource(
        &self,
        session_id: &str,
        uri: &str,
        extension_name: &str,
        cancellation_token: CancellationToken,
    ) -> Result<rmcp::model::ReadResourceResult, ErrorData> {
        let available_extensions = self
            .extensions
            .lock()
            .await
            .keys()
            .map(|s| s.as_str())
            .collect::<Vec<&str>>()
            .join(", ");
        let error_msg = format!(
            "Extension '{}' not found. Here are the available extensions: {}",
            extension_name, available_extensions
        );

        let client = self
            .get_server_client(extension_name)
            .await
            .ok_or(ErrorData::new(ErrorCode::INVALID_PARAMS, error_msg, None))?;

        client
            .read_resource(session_id, uri, cancellation_token)
            .await
            .map_err(|_| {
                ErrorData::new(
                    ErrorCode::INTERNAL_ERROR,
                    format!("Could not read resource with uri: {}", uri),
                    None,
                )
            })
    }

    pub async fn get_ui_resources(
        &self,
        session_id: &str,
    ) -> Result<Vec<(String, Resource)>, ErrorData> {
        let mut ui_resources = Vec::new();

        let extensions_to_check: Vec<(String, McpClientBox)> = {
            let extensions = self.extensions.lock().await;
            extensions
                .iter()
                .map(|(name, ext)| (name.clone(), ext.get_client()))
                .collect()
        };

        for (extension_name, client) in extensions_to_check {
            match client
                .list_resources(session_id, None, CancellationToken::default())
                .await
            {
                Ok(list_response) => {
                    for resource in list_response.resources {
                        if resource.uri.starts_with("ui://") {
                            ui_resources.push((extension_name.clone(), resource));
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to list resources for {}: {:?}", extension_name, e);
                }
            }
        }

        Ok(ui_resources)
    }

    async fn list_resources_from_extension(
        &self,
        session_id: &str,
        extension_name: &str,
        cancellation_token: CancellationToken,
    ) -> Result<Vec<Content>, ErrorData> {
        let client = self
            .get_server_client(extension_name)
            .await
            .ok_or_else(|| {
                ErrorData::new(
                    ErrorCode::INVALID_PARAMS,
                    format!("Extension {} is not valid", extension_name),
                    None,
                )
            })?;

        client
            .list_resources(session_id, None, cancellation_token)
            .await
            .map_err(|e| {
                ErrorData::new(
                    ErrorCode::INTERNAL_ERROR,
                    format!("Unable to list resources for {}, {:?}", extension_name, e),
                    None,
                )
            })
            .map(|lr| {
                let resource_list = lr
                    .resources
                    .into_iter()
                    .map(|r| format!("{} - {}, uri: ({})", extension_name, r.name, r.uri))
                    .collect::<Vec<String>>()
                    .join("\n");

                vec![Content::text(resource_list)]
            })
    }

    pub async fn list_resources(
        &self,
        session_id: &str,
        params: Value,
        cancellation_token: CancellationToken,
    ) -> Result<Vec<Content>, ErrorData> {
        let extension = params.get("extension_name").and_then(|v| v.as_str());

        match extension {
            Some(extension_name) => {
                // Handle single extension case
                self.list_resources_from_extension(session_id, extension_name, cancellation_token)
                    .await
            }
            None => {
                // Handle all extensions case using FuturesUnordered
                let mut futures = FuturesUnordered::new();

                // Create futures for each resource_capable_extension
                self.extensions
                    .lock()
                    .await
                    .iter()
                    .filter(|(_name, ext)| ext.supports_resources())
                    .map(|(name, _ext)| name.clone())
                    .for_each(|name| {
                        let token = cancellation_token.clone();
                        futures.push(async move {
                            self.list_resources_from_extension(session_id, name.as_str(), token)
                                .await
                        });
                    });

                let mut all_resources = Vec::new();
                let mut errors = Vec::new();

                // Process results as they complete
                while let Some(result) = futures.next().await {
                    match result {
                        Ok(content) => {
                            all_resources.extend(content);
                        }
                        Err(tool_error) => {
                            errors.push(tool_error);
                        }
                    }
                }

                if !errors.is_empty() {
                    tracing::error!(
                        errors = ?errors
                            .into_iter()
                            .map(|e| format!("{:?}", e))
                            .collect::<Vec<_>>(),
                        "errors from listing resources"
                    );
                }

                Ok(all_resources)
            }
        }
    }

    async fn resolve_tool(
        &self,
        session_id: &str,
        tool_name: &str,
    ) -> Result<ResolvedTool, ErrorData> {
        let tools = self.get_all_tools_cached(session_id).await.map_err(|e| {
            ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("Failed to get tools: {}", e),
                None,
            )
        })?;
        self.resolve_tool_from_known_tools(&tools, tool_name).await
    }

    async fn resolve_tool_from_known_tools(
        &self,
        tools: &[Tool],
        tool_name: &str,
    ) -> Result<ResolvedTool, ErrorData> {
        let mut name = tool_name.to_string();
        let mut recovery_attempted = false;
        loop {
            if let Some(tool) = tools.iter().find(|t| *t.name == *name) {
                let owner = get_tool_owner(tool)
                    .or_else(|| name.split_once("__").map(|(prefix, _)| name_to_key(prefix)))
                    .ok_or_else(|| {
                        ErrorData::new(
                            ErrorCode::RESOURCE_NOT_FOUND,
                            format!("Tool '{}' has no owner", name),
                            None,
                        )
                    })?;

                let actual_tool_name = name
                    .strip_prefix(&format!("{owner}__"))
                    .unwrap_or(&name)
                    .to_string();

                let client = self.get_server_client(&owner).await.ok_or_else(|| {
                    ErrorData::new(
                        ErrorCode::RESOURCE_NOT_FOUND,
                        format!("Extension '{}' not found for tool '{}'", owner, name),
                        None,
                    )
                })?;
                let execution_timeout = self
                    .extensions
                    .lock()
                    .await
                    .get(&owner)
                    .map(|extension| bounded_tool_timeout(extension.config.timeout_seconds()))
                    .ok_or_else(|| {
                        ErrorData::new(
                            ErrorCode::RESOURCE_NOT_FOUND,
                            format!("Extension '{}' not found for tool '{}'", owner, name),
                            None,
                        )
                    })?;

                return Ok(ResolvedTool {
                    tool_name: tool.name.to_string(),
                    extension_name: owner,
                    actual_tool_name,
                    input_schema: Value::Object(tool.input_schema.as_ref().clone()),
                    client,
                    tool_meta: get_tool_meta_value(tool),
                    resource_uri: get_tool_resource_uri(tool),
                    execution_timeout,
                });
            }

            if !recovery_attempted {
                recovery_attempted = true;
                if let Some(recovered) =
                    recover_mangled_tool_name(&name, tools.iter().map(|t| t.name.as_ref()))
                {
                    name = recovered;
                    continue;
                }
            }

            break;
        }

        let available = tools
            .iter()
            .map(|t| t.name.as_ref())
            .collect::<Vec<&str>>()
            .join(", ");

        Err(ErrorData::new(
            ErrorCode::RESOURCE_NOT_FOUND,
            format!(
                "Tool '{}' not found. Available tools: [{}]",
                tool_name, available
            ),
            None,
        ))
    }

    pub(crate) async fn computer_method_allows_tool(
        &self,
        session_id: &str,
        tool_name: &str,
        method: super::tool_task::ComputerOperationMethod,
    ) -> bool {
        use super::tool_task::ComputerOperationMethod;
        if method == ComputerOperationMethod::Unrestricted {
            return true;
        }
        if method == ComputerOperationMethod::StateUnavailable {
            return false;
        }
        let Ok(resolved) = self.resolve_tool(session_id, tool_name).await else {
            return false;
        };
        let extensions = self.extensions.lock().await;
        let Some(extension) = extensions.get(&resolved.extension_name) else {
            return false;
        };
        let profile = tool_security_profile(&extension.config, &resolved.actual_tool_name);
        if matches!(&extension.config, ExtensionConfig::Builtin { name, .. } | ExtensionConfig::Platform { name, .. } if name_to_key(name) == "developer")
            && (resolved.actual_tool_name == "ask_user"
                || builtin_permission_class("developer", &resolved.actual_tool_name)
                    == Some(CodeProPermissionClass::ReadOnly))
        {
            return true;
        }
        if profile.permission_class == Some(CodeProPermissionClass::ReadOnly) {
            return true;
        }
        if matches!(&extension.config, ExtensionConfig::Builtin { name, .. } if name_to_key(name) == "qwen_computer")
            && resolved.extension_name == "qwen_computer"
        {
            return profile.permission_class == Some(CodeProPermissionClass::HighRisk)
                && (method == ComputerOperationMethod::DesktopControl
                    || matches!(
                        resolved.actual_tool_name.as_str(),
                        "click" | "drag" | "scroll"
                    ));
        }
        let trusted_computer = matches!(&extension.config, ExtensionConfig::Platform { name, .. } if name_to_key(name) == "computer")
            && resolved.extension_name == "computer"
            && codepro_platform_owner(&resolved.actual_tool_name) == Some("computer");
        trusted_computer
            && (method == ComputerOperationMethod::DesktopControl
                || matches!(
                    resolved.actual_tool_name.as_str(),
                    "computer_move"
                        | "computer_click"
                        | "computer_drag"
                        | "computer_scroll"
                        | "computer_focus"
                        | "computer_stop"
                ))
    }

    pub(crate) async fn check_computer_method(
        &self,
        ctx: &super::tool_execution::ToolCallContext,
        tool_call: &CallToolRequestParams,
    ) -> Result<()> {
        if self
            .computer_method_allows_tool(
                &ctx.session_id,
                &tool_call.name,
                ctx.computer_operation_method,
            )
            .await
        {
            return Ok(());
        }
        let denied = ctx
            .clone()
            .with_audit_authorization(ToolAuditAuthorization::PolicyDenied);
        let receipt = self.record_denied_tool_call(&denied, tool_call).await?;
        Err(insert_trusted_tool_audit_error(
            ErrorData::new(
                ErrorCode::INVALID_REQUEST,
                format!(
                    "Tool is unavailable under the user's computer operation method: {:?}. {}",
                    ctx.computer_operation_method,
                    ctx.computer_operation_method.instruction()
                ),
                Some(
                    serde_json::json!({"computer_operation_method": ctx.computer_operation_method}),
                ),
            ),
            &receipt,
        )
        .into())
    }

    pub async fn dispatch_tool_call(
        &self,
        ctx: &super::tool_execution::ToolCallContext,
        tool_call: CallToolRequestParams,
        cancellation_token: CancellationToken,
    ) -> Result<ToolCallResult> {
        let tool_name_str = tool_call.name.to_string();
        self.check_computer_method(ctx, &tool_call).await?;
        let resolved = self.resolve_tool(&ctx.session_id, &tool_name_str).await?;

        if let Some(extension) = self.extensions.lock().await.get(&resolved.extension_name) {
            if !extension
                .config
                .is_tool_available(&resolved.actual_tool_name)
            {
                return Err(ErrorData::new(
                    ErrorCode::RESOURCE_NOT_FOUND,
                    format!(
                        "Tool '{}' is not available for extension '{}'",
                        resolved.actual_tool_name, resolved.extension_name
                    ),
                    None,
                )
                .into());
            }
        }

        validate_tool_arguments(
            &resolved.tool_name,
            &resolved.input_schema,
            tool_call.arguments.as_ref(),
        )?;

        let mut arguments = tool_call.arguments.clone();
        if resolved.extension_name == "local_git"
            && resolved.input_schema["properties"].get("path").is_some()
        {
            if let Some(root) = ctx
                .codepro_task_scope
                .as_ref()
                .and_then(|scope| scope.workspace_root())
            {
                super::git_mcp::bind_workspace_path(&mut arguments, std::path::Path::new(root));
            }
        }
        let observe_local_git = resolved.extension_name == "local_git"
            && ctx.codepro_auto_full_access
            && ctx
                .codepro_task_scope
                .as_ref()
                .is_some_and(|scope| scope.is_durable_main_agent());
        let trusted_computer_mcp = self.extensions.lock().await.get(&resolved.extension_name)
            .is_some_and(|extension| matches!(&extension.config, ExtensionConfig::Builtin { name, .. } if name == "qwen_computer"));
        let vision_assistance =
            if trusted_computer_mcp && resolved.actual_tool_name == "get_app_state" {
                arguments
                    .as_mut()
                    .and_then(|args| args.remove("vision_assistance"))
                    .and_then(|value| value.as_str().map(str::to_owned))
            } else {
                None
            };
        let workspace_guard = CodeProWorkspaceWriteGuard::prepare_with_tester_runtime(
            ctx.codepro_task_scope.as_ref(),
            ctx.working_dir.as_deref(),
            ctx.explicit_user_confirmation,
            ctx.codepro_auto_full_access,
            &resolved.extension_name,
            &resolved.actual_tool_name,
            arguments.as_ref(),
            ctx.codepro_tester_runtime.as_ref(),
        );
        let audit_input = self
            .audit_input_for_resolved_tool(ctx, &tool_call, &resolved)
            .await?;
        // The run mutation lock orders admission against PauseRun/CancelRun.
        // Persist the existing ToolAudit started receipt before releasing it,
        // so an admitted-but-not-yet-finished call remains visible after a
        // crash or cancellation. No tool effect starts before this point.
        let admitted_audit_claim = match ctx.admit_business_action().await {
            Ok(Some(admission_guard)) => {
                let claim = self
                    .tool_audit_store
                    .begin(audit_input.clone())
                    .await
                    .map_err(|_| host_audit_error())?;
                drop(admission_guard);
                Some(claim)
            }
            Ok(None) => None,
            Err(error) => {
                let denied = ctx
                    .clone()
                    .with_audit_authorization(ToolAuditAuthorization::PolicyDenied);
                let receipt = self.record_denied_tool_call(&denied, &tool_call).await?;
                return Err(insert_trusted_tool_audit_error(
                    ErrorData::new(
                        ErrorCode::INVALID_REQUEST,
                        format!("CodePro action was not admitted by the current run: {error}"),
                        None,
                    ),
                    &receipt,
                )
                .into());
            }
        };
        let trusted_platform_owner = self
            .extensions
            .lock()
            .await
            .get(&resolved.extension_name)
            .is_some_and(|extension| match &extension.config {
                ExtensionConfig::Platform { name, .. } => {
                    name_to_key(name) == resolved.extension_name
                }
                ExtensionConfig::Builtin { name, .. } => {
                    name_to_key(name) == resolved.extension_name
                        && PLATFORM_EXTENSIONS.contains_key(resolved.extension_name.as_str())
                }
                _ => false,
            });
        let trusted_codepro_owner = trusted_platform_owner
            && matches!(resolved.extension_name.as_str(), "git" | "computer");
        let record_external_usage = self
            .extensions
            .lock()
            .await
            .get(&resolved.extension_name)
            .is_some_and(|extension| {
                matches!(
                    &extension.config,
                    ExtensionConfig::Stdio { .. } | ExtensionConfig::StreamableHttp { .. }
                )
            });
        let usage_extension_name = resolved.extension_name.clone();
        let usage_tool_name = resolved.actual_tool_name.clone();
        let usage_event_id = format!(
            "external:{}:{}",
            ctx.session_id,
            ctx.tool_call_request_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
        );
        let idempotency_input = trusted_codepro_owner
            .then(|| codepro_tool_spec(&resolved.actual_tool_name))
            .flatten()
            .filter(|spec| !spec.idempotent)
            .map(|_| {
                ctx.tool_call_request_id
                    .clone()
                    .ok_or_else(|| {
                        ErrorData::new(
                            ErrorCode::INTERNAL_ERROR,
                            format!(
                                "Protected tool '{}' requires a host request identity.",
                                resolved.tool_name
                            ),
                            None,
                        )
                    })
                    .map(|request_id| ToolIdempotencyInput {
                        session_id: ctx.session_id.clone(),
                        task_scope: ctx.codepro_task_scope.clone(),
                        request_id,
                        tool_name: format!(
                            "{}::{}",
                            resolved.extension_name, resolved.actual_tool_name
                        ),
                        arguments: tool_call.arguments.clone().unwrap_or_default(),
                        explicit_user_confirmation: ctx.explicit_user_confirmation,
                    })
            });
        let client = resolved.client.clone();
        let hydration_client = client.clone();
        let notifications_receiver = client.subscribe().await;
        let session_id = ctx.session_id.clone();
        let action_required_tool_call_request_id = ctx.tool_call_request_id.clone();
        let action_required_receiver =
            if let Some(tool_call_request_id) = action_required_tool_call_request_id.clone() {
                if ActionRequiredManager::global()
                    .has_action_required_stream(&session_id, &tool_call_request_id)
                    .await
                {
                    None
                } else {
                    let registered_tool_call_request_id = tool_call_request_id.clone();
                    let receiver = ActionRequiredManager::global()
                        .register_action_required_stream(session_id.clone(), tool_call_request_id)
                        .await;
                    Some((
                        receiver,
                        session_id.clone(),
                        registered_tool_call_request_id,
                    ))
                }
            } else {
                None
            };
        let actual_tool_name = resolved.actual_tool_name.clone();
        let resolved_tool = resolved;
        let should_hydrate_mcp_app = self.host_supports_mcp_apps();
        let tool_execution_limits = self
            .tool_execution_limits
            .clone()
            .with_timeout(resolved_tool.execution_timeout);
        let bounded_tool_name = resolved_tool.tool_name.clone();
        let idempotency_tool_name = bounded_tool_name.clone();
        let tool_idempotency_store = Arc::clone(&self.tool_idempotency_store);
        let tool_audit_store = Arc::clone(&self.tool_audit_store);
        let owned_ctx = ctx.clone();
        let workspace_audit_ctx = ctx.clone();
        let workspace_observation = Arc::new(Mutex::new(
            None::<(CodeProWorkspaceWriteGuard, Option<WorkspaceSnapshot>)>,
        ));
        let operation_workspace_observation = Arc::clone(&workspace_observation);

        let operation = run_bounded_tool_operation(
            tool_execution_limits,
            cancellation_token,
            bounded_tool_name,
            move |operation_token| async move {
                tracing::debug!(
                    "dispatch_tool_call: calling client.call_tool tool={} session_id={} working_dir={:?}",
                    actual_tool_name,
                    owned_ctx.session_id,
                    owned_ctx.working_dir,
                );
                let preflight_violation = match workspace_guard {
                    Err(violation) => Some(violation),
                    Ok(Some(guard)) => match guard.before_execution() {
                        Ok(snapshot) => {
                            *operation_workspace_observation.lock().await = Some((guard, snapshot));
                            None
                        }
                        Err(violation) => Some(violation),
                    },
                    Ok(None) => None,
                };
                let git_observation = if observe_local_git && preflight_violation.is_none() {
                    if let Some(root) = owned_ctx
                        .codepro_task_scope
                        .as_ref()
                        .and_then(|scope| scope.workspace_root())
                    {
                        match super::git_mcp::GitObservation::prepare(
                            &actual_tool_name,
                            arguments.as_ref(),
                            std::path::Path::new(root),
                        )
                        .await
                        {
                            Ok(observation) => observation,
                            Err(_) => {
                                tracing::debug!("Git host observation unavailable before MCP call");
                                None
                            }
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                let call_result = if let Some(violation) = preflight_violation {
                    Ok(workspace_scope_violation_result(violation))
                } else {
                    client
                        .call_tool(
                            &owned_ctx,
                            &actual_tool_name,
                            arguments,
                            operation_token.clone(),
                        )
                        .await
                        .map_err(|e| match e {
                            ServiceError::McpError(error_data) => error_data,
                            _ => ErrorData::new(
                                ErrorCode::INTERNAL_ERROR,
                                e.to_string(),
                                e.maybe_to_value(),
                            ),
                        })
                };

                let mut result = call_result?;
                let reported_failure = take_reported_codepro_failure(&mut result);

                remove_untrusted_mcp_app_meta(&mut result);
                if let Some(observation) = git_observation {
                    if let Err(error) = observation.finish(&mut result).await {
                        result.content.push(Content::text(format!("Host Git evidence unavailable: {error}. Do not repeat a write just to obtain evidence; inspect current state first.")));
                    }
                }
                if trusted_computer_mcp && result.is_error != Some(true) {
                    let meta = result.meta.get_or_insert_with(|| Meta(Default::default()));
                    meta.0.insert(
                        TRUSTED_TOOL_UPDATE_META_KEY.into(),
                        serde_json::json!({
                            "computerMcp": true,
                            "visionAssistance": vision_assistance,
                        }),
                    );
                }

                if trusted_platform_owner {
                    if let Some(failure_kind) = reported_failure {
                        insert_trusted_codepro_failure_meta(&mut result, failure_kind);
                    }
                }

                if should_hydrate_mcp_app && result.is_error != Some(true) {
                    if let Some(attachment) = Self::hydrate_mcp_app_attachment(
                        &hydration_client,
                        &session_id,
                        &resolved_tool,
                        operation_token,
                    )
                    .await
                    {
                        insert_trusted_tool_update_meta(&mut result, &attachment);
                    }
                }

                Ok(result)
            },
        );
        let fut = async move {
            let audit_claim = match admitted_audit_claim {
                Some(claim) => claim,
                None => tool_audit_store
                    .begin(audit_input)
                    .await
                    .map_err(|_| host_audit_error())?,
            };
            let claim = if let Some(input) = idempotency_input {
                let input = match input {
                    Ok(input) => input,
                    Err(error) => {
                        let receipt = complete_tool_audit(
                            &tool_audit_store,
                            &audit_claim,
                            ToolAuditOutcome::ToolError,
                        )
                        .await?;
                        return Err(insert_trusted_tool_audit_error(error, &receipt));
                    }
                };
                match tool_idempotency_store.begin(input).await {
                    Ok(BeginDecision::Execute(claim)) => Some(claim),
                    Ok(BeginDecision::ReplaySuppressed(ToolIdempotencyOutcome::Success)) => {
                        let receipt = complete_tool_audit(
                            &tool_audit_store,
                            &audit_claim,
                            ToolAuditOutcome::ReplaySuppressed,
                        )
                        .await?;
                        let mut result = CallToolResult::success(vec![Content::text(format!(
                            "Duplicate protected tool call '{}' was suppressed because the original call already completed successfully.",
                            idempotency_tool_name
                        ))]);
                        insert_trusted_tool_audit_meta(&mut result, &receipt);
                        return Ok(result);
                    }
                    Ok(BeginDecision::ReplaySuppressed(
                        ToolIdempotencyOutcome::Error | ToolIdempotencyOutcome::Uncertain,
                    )) => {
                        let receipt = complete_tool_audit(
                            &tool_audit_store,
                            &audit_claim,
                            ToolAuditOutcome::ReplaySuppressed,
                        )
                        .await?;
                        return Err(insert_trusted_tool_audit_error(
                            ErrorData::new(
                                ErrorCode::INTERNAL_ERROR,
                                format!(
                                    "Duplicate protected tool call '{}' was suppressed because the prior outcome was not safely replayable.",
                                    idempotency_tool_name
                                ),
                                None,
                            ),
                            &receipt,
                        ));
                    }
                    Ok(BeginDecision::InFlight) => {
                        let receipt = complete_tool_audit(
                            &tool_audit_store,
                            &audit_claim,
                            ToolAuditOutcome::Ambiguous,
                        )
                        .await?;
                        return Err(insert_trusted_tool_audit_error(
                            ErrorData::new(
                                ErrorCode::INTERNAL_ERROR,
                                format!(
                                    "Protected tool call '{}' is already running.",
                                    idempotency_tool_name
                                ),
                                None,
                            ),
                            &receipt,
                        ));
                    }
                    Ok(BeginDecision::Ambiguous) => {
                        let receipt = complete_tool_audit(
                            &tool_audit_store,
                            &audit_claim,
                            ToolAuditOutcome::Ambiguous,
                        )
                        .await?;
                        return Err(insert_trusted_tool_audit_error(
                            ErrorData::new(
                                ErrorCode::INTERNAL_ERROR,
                                format!(
                                    "Protected tool call '{}' has an unresolved prior attempt and requires explicit user confirmation before retrying.",
                                    idempotency_tool_name
                                ),
                                None,
                            ),
                            &receipt,
                        ));
                    }
                    Err(_) => {
                        let receipt = complete_tool_audit(
                            &tool_audit_store,
                            &audit_claim,
                            ToolAuditOutcome::Ambiguous,
                        )
                        .await?;
                        return Err(insert_trusted_tool_audit_error(
                            ErrorData::new(
                                ErrorCode::INTERNAL_ERROR,
                                format!(
                                    "Protected tool call '{}' could not establish a durable host identity.",
                                    idempotency_tool_name
                                ),
                                None,
                            ),
                            &receipt,
                        ));
                    }
                }
            } else {
                None
            };

            let mut result = operation.await;
            if let Some((guard, before)) = workspace_observation.lock().await.take() {
                match guard.after_execution(before) {
                    Ok(delta) => {
                        if !delta.changed_paths.is_empty() {
                            match &mut result {
                                Ok(response) => {
                                    insert_trusted_workspace_delta_meta(
                                        response,
                                        &delta.changed_paths,
                                    );
                                    attach_workspace_versions(
                                        response.meta.as_mut().and_then(|meta| {
                                            meta.0.get_mut(TRUSTED_TOOL_UPDATE_META_KEY)
                                        }),
                                        &delta,
                                    );
                                }
                                Err(
                                    BoundedToolError::Operation(error)
                                    | BoundedToolError::Cancelled(error)
                                    | BoundedToolError::TimedOut(error),
                                ) => {
                                    insert_trusted_workspace_delta_error(
                                        error,
                                        &delta.changed_paths,
                                    );
                                    attach_workspace_versions(
                                        error.data.as_mut().and_then(|data| {
                                            data.get_mut(TRUSTED_TOOL_UPDATE_META_KEY)
                                        }),
                                        &delta,
                                    );
                                }
                            }
                            tracing::info!(
                                session_id = %workspace_audit_ctx.session_id,
                                run_id = workspace_audit_ctx
                                    .codepro_task_scope
                                    .as_ref()
                                    .map(|scope| scope.run_id()),
                                task_id = workspace_audit_ctx
                                    .codepro_task_scope
                                    .as_ref()
                                    .map(|scope| scope.task_id()),
                                action_id = workspace_audit_ctx.tool_call_request_id.as_deref(),
                                changed_path_count = delta.changed_paths.len(),
                                tool_succeeded = result
                                    .as_ref()
                                    .is_ok_and(|response| response.is_error != Some(true)),
                                "trusted workspace delta observed"
                            );
                        }
                    }
                    Err(violation) => {
                        result = Err(BoundedToolError::Operation(ErrorData::new(
                            ErrorCode::INVALID_PARAMS,
                            violation.message().to_string(),
                            None,
                        )));
                    }
                }
            }
            let audit_outcome = match &result {
                Ok(response) if response.is_error != Some(true) => ToolAuditOutcome::Success,
                Ok(_) | Err(BoundedToolError::Operation(_)) => ToolAuditOutcome::ToolError,
                Err(BoundedToolError::Cancelled(_)) => ToolAuditOutcome::Cancelled,
                Err(BoundedToolError::TimedOut(_)) => ToolAuditOutcome::TimedOut,
            };
            let failure_kind = match &result {
                Ok(response) => trusted_codepro_failure_from_result(response),
                Err(BoundedToolError::Operation(_)) => Some(CodeProFailureKind::EnvironmentFailure),
                Err(BoundedToolError::Cancelled(_)) => Some(CodeProFailureKind::Cancelled),
                Err(BoundedToolError::TimedOut(_)) => None,
            };
            if let Some(claim) = claim.as_ref() {
                let outcome = if result
                    .as_ref()
                    .is_ok_and(|response| response.is_error != Some(true))
                {
                    ToolIdempotencyOutcome::Success
                } else {
                    ToolIdempotencyOutcome::Error
                };
                if tool_idempotency_store
                    .complete(claim, outcome)
                    .await
                    .is_err()
                {
                    let receipt = complete_tool_audit(
                        &tool_audit_store,
                        &audit_claim,
                        ToolAuditOutcome::Ambiguous,
                    )
                    .await?;
                    return Err(insert_trusted_tool_audit_error(
                        ErrorData::new(
                            ErrorCode::INTERNAL_ERROR,
                            format!(
                                "Protected tool call '{}' finished but its durable outcome could not be recorded.",
                                idempotency_tool_name
                            ),
                            None,
                        ),
                        &receipt,
                    ));
                }
            }
            let receipt = complete_tool_audit_with_failure(
                &tool_audit_store,
                &audit_claim,
                audit_outcome,
                failure_kind,
            )
            .await?;
            match result {
                Ok(mut result) => {
                    if record_external_usage && result.is_error != Some(true) {
                        record_capability_success(CapabilityUsageEvent {
                            event_id: usage_event_id,
                            kind: CapabilityUsageKind::External,
                            capability_id: usage_extension_name.clone(),
                            recent_result: format!("{} succeeded", usage_tool_name),
                            reference: Some(format!("external:{usage_extension_name}")),
                        });
                    }
                    insert_trusted_tool_audit_meta(&mut result, &receipt);
                    Ok(result)
                }
                Err(
                    BoundedToolError::Operation(error)
                    | BoundedToolError::Cancelled(error)
                    | BoundedToolError::TimedOut(error),
                ) => Err(insert_trusted_tool_audit_error(error, &receipt)),
            }
        };

        Ok(ToolCallResult {
            result: Box::new(fut.boxed()),
            notification_stream: Some(Box::new(ReceiverStream::new(notifications_receiver))),
            action_required_stream: action_required_receiver.map(
                |(rx, session_id, tool_call_request_id)| {
                    Box::new(ActionRequiredStream::new(
                        rx,
                        session_id,
                        tool_call_request_id,
                    )) as _
                },
            ),
        })
    }

    pub(crate) async fn begin_frontend_tool_audit(
        &self,
        ctx: &super::tool_execution::ToolCallContext,
        tool_call: &CallToolRequestParams,
    ) -> Result<ToolAuditClaim> {
        let input = ToolAuditInput {
            session_id: ctx.session_id.clone(),
            request_id: ctx
                .tool_call_request_id
                .clone()
                .ok_or_else(host_audit_error)?,
            task_scope: ctx.codepro_task_scope.clone(),
            tool_name: QualifiedToolName::new(format!("frontend::{}", tool_call.name))
                .map_err(|_| host_audit_error())?,
            arguments: tool_call.arguments.clone().unwrap_or_default(),
            actor: ctx.actor,
            effective_model: ctx.effective_model.clone(),
            extension_source: ToolAuditExtensionSource::Frontend,
            permission_class: ToolAuditPermissionClass::Legacy,
            authorization: ctx.audit_authorization,
        };
        Ok(self
            .tool_audit_store
            .begin(input)
            .await
            .map_err(|_| host_audit_error())?)
    }

    pub(crate) async fn complete_frontend_tool_audit(
        &self,
        claim: &ToolAuditClaim,
        outcome: ToolAuditOutcome,
    ) -> Result<ToolAuditReceipt> {
        Ok(self
            .tool_audit_store
            .complete_with_receipt(claim, outcome)
            .await
            .map_err(|_| host_audit_error())?)
    }

    async fn audit_input_for_resolved_tool(
        &self,
        ctx: &super::tool_execution::ToolCallContext,
        tool_call: &CallToolRequestParams,
        resolved: &ResolvedTool,
    ) -> Result<ToolAuditInput> {
        let audit_profile = self
            .extensions
            .lock()
            .await
            .get(&resolved.extension_name)
            .map(|extension| tool_security_profile(&extension.config, &resolved.actual_tool_name))
            .unwrap_or(ToolSecurityProfile {
                source: ToolExtensionSource::Unknown,
                permission_class: None,
            });
        Ok(ToolAuditInput {
            session_id: ctx.session_id.clone(),
            request_id: ctx
                .tool_call_request_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
            task_scope: ctx.codepro_task_scope.clone(),
            tool_name: QualifiedToolName::new(format!(
                "{}::{}",
                resolved.extension_name, resolved.actual_tool_name
            ))
            .map_err(|_| host_audit_error())?,
            arguments: tool_call.arguments.clone().unwrap_or_default(),
            actor: ctx.actor,
            effective_model: ctx.effective_model.clone(),
            extension_source: audit_profile.source.into(),
            permission_class: audit_profile
                .permission_class
                .map(ToolAuditPermissionClass::from)
                .unwrap_or(ToolAuditPermissionClass::Legacy),
            authorization: ctx.audit_authorization,
        })
    }

    async fn audit_input_for_denied_tool_call(
        &self,
        ctx: &super::tool_execution::ToolCallContext,
        tool_call: &CallToolRequestParams,
    ) -> ToolAuditInput {
        let fallback = || {
            (
                QualifiedToolName::new("unknown::tool").expect("fixed sentinel is valid"),
                ToolSecurityProfile {
                    source: ToolExtensionSource::Unknown,
                    permission_class: None,
                },
            )
        };
        let (tool_name, audit_profile) = match tool_call.name.split_once("__") {
            Some((owner, actual_tool_name))
                if owner == name_to_key(owner)
                    && QualifiedToolName::new(format!("{owner}::{actual_tool_name}")).is_ok() =>
            {
                let qualified_tool_name =
                    QualifiedToolName::new(format!("{owner}::{actual_tool_name}"))
                        .expect("validated qualified tool name");
                let extensions = self.extensions.lock().await;
                match extensions.get(owner) {
                    Some(extension) => (
                        qualified_tool_name,
                        tool_security_profile(&extension.config, actual_tool_name),
                    ),
                    None => (
                        qualified_tool_name,
                        ToolSecurityProfile {
                            source: ToolExtensionSource::Unknown,
                            permission_class: None,
                        },
                    ),
                }
            }
            _ => {
                let bare_tool_name = tool_call.name.as_ref();
                let owner = codepro_platform_owner(bare_tool_name);
                let extension = match owner {
                    Some(owner) => self.extensions.lock().await.get(owner).map(|extension| {
                        (
                            owner,
                            matches!(
                                &extension.config,
                                ExtensionConfig::Platform { name, .. }
                                    if name_to_key(name) == owner
                            ),
                            tool_security_profile(&extension.config, bare_tool_name),
                        )
                    }),
                    None => None,
                };
                match extension {
                    Some((owner, true, profile)) if profile.permission_class.is_some() => (
                        QualifiedToolName::new(format!("{owner}::{bare_tool_name}"))
                            .expect("registered CodePro tool names are qualified safely"),
                        profile,
                    ),
                    _ => fallback(),
                }
            }
        };
        ToolAuditInput {
            session_id: ctx.session_id.clone(),
            request_id: ctx
                .tool_call_request_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
            task_scope: ctx.codepro_task_scope.clone(),
            tool_name,
            arguments: tool_call.arguments.clone().unwrap_or_default(),
            actor: ctx.actor,
            effective_model: ctx.effective_model.clone(),
            extension_source: audit_profile.source.into(),
            permission_class: audit_profile
                .permission_class
                .map(ToolAuditPermissionClass::from)
                .unwrap_or(ToolAuditPermissionClass::Legacy),
            authorization: ctx.audit_authorization,
        }
    }

    pub(crate) async fn record_denied_tool_call(
        &self,
        ctx: &super::tool_execution::ToolCallContext,
        tool_call: &CallToolRequestParams,
    ) -> Result<ToolAuditReceipt> {
        if !matches!(
            ctx.audit_authorization,
            ToolAuditAuthorization::PolicyDenied | ToolAuditAuthorization::UserDenied
        ) {
            return Err(host_audit_error().into());
        }
        let audit_input = self.audit_input_for_denied_tool_call(ctx, tool_call).await;
        self.tool_audit_store
            .record_denied_with_receipt(audit_input)
            .await
            .map_err(|_| host_audit_error().into())
    }

    pub async fn list_prompts_from_extension(
        &self,
        session_id: &str,
        extension_name: &str,
        cancellation_token: CancellationToken,
    ) -> Result<Vec<Prompt>, ErrorData> {
        let client = self
            .get_server_client(extension_name)
            .await
            .ok_or_else(|| {
                ErrorData::new(
                    ErrorCode::INVALID_PARAMS,
                    format!("Extension {} is not valid", extension_name),
                    None,
                )
            })?;

        client
            .list_prompts(session_id, None, cancellation_token)
            .await
            .map_err(|e| {
                ErrorData::new(
                    ErrorCode::INTERNAL_ERROR,
                    format!("Unable to list prompts for {}, {:?}", extension_name, e),
                    None,
                )
            })
            .map(|lp| lp.prompts)
    }

    pub async fn list_prompts(
        &self,
        session_id: &str,
        cancellation_token: CancellationToken,
    ) -> Result<HashMap<String, Vec<Prompt>>, ErrorData> {
        let mut futures = FuturesUnordered::new();

        let names: Vec<_> = self.extensions.lock().await.keys().cloned().collect();
        for extension_name in names {
            let token = cancellation_token.clone();
            futures.push(async move {
                (
                    extension_name.clone(),
                    self.list_prompts_from_extension(session_id, extension_name.as_str(), token)
                        .await,
                )
            });
        }

        let mut all_prompts = HashMap::new();
        let mut errors = Vec::new();

        // Process results as they complete
        while let Some(result) = futures.next().await {
            let (name, prompts) = result;
            match prompts {
                Ok(content) => {
                    all_prompts.insert(name.to_string(), content);
                }
                Err(tool_error) => {
                    errors.push(tool_error);
                }
            }
        }

        if !errors.is_empty() {
            tracing::debug!(
                errors = ?errors
                    .into_iter()
                    .map(|e| format!("{:?}", e))
                    .collect::<Vec<_>>(),
                "errors from listing prompts"
            );
        }

        Ok(all_prompts)
    }

    pub async fn get_prompt(
        &self,
        session_id: &str,
        extension_name: &str,
        name: &str,
        arguments: Value,
        cancellation_token: CancellationToken,
    ) -> Result<GetPromptResult> {
        let client = self
            .get_server_client(extension_name)
            .await
            .ok_or_else(|| anyhow::anyhow!("Extension {} not found", extension_name))?;

        client
            .get_prompt(session_id, name, arguments, cancellation_token)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get prompt: {}", e))
    }

    pub async fn search_available_extensions(
        &self,
        session_id: &str,
    ) -> Result<Vec<Content>, ErrorData> {
        let mut output_parts = vec![];

        // Defaults apply to new sessions. Discovery must compare with this session,
        // including defaults added after it was created.
        let enabled_extensions: Vec<String> = self
            .extensions
            .lock()
            .await
            .keys()
            .filter(|name| !is_hidden_extension(name))
            .cloned()
            .collect();
        // Configurations are discoverable without connecting to or enabling them.
        let mut disabled_extensions: Vec<String> = vec![];
        for extension in get_all_extensions() {
            if !enabled_extensions.contains(&extension.config.key())
                && !is_hidden_extension(&extension.config.name())
            {
                let config = extension.config.clone();
                let description = match &config {
                    ExtensionConfig::Builtin {
                        description,
                        display_name,
                        ..
                    } => {
                        if description.is_empty() {
                            display_name.as_deref().unwrap_or("Built-in extension")
                        } else {
                            description
                        }
                    }
                    ExtensionConfig::Sse { .. } => "SSE extension (unsupported)",
                    ExtensionConfig::Platform { description, .. }
                    | ExtensionConfig::StreamableHttp { description, .. }
                    | ExtensionConfig::Stdio { description, .. }
                    | ExtensionConfig::Frontend { description, .. }
                    | ExtensionConfig::InlinePython { description, .. } => description,
                };
                disabled_extensions.push(format!("- {} - {}", config.name(), description));
            }
        }

        // Build output string
        if !disabled_extensions.is_empty() {
            output_parts.push(format!(
                "Configured extensions not loaded in this session (enable for this chat to use their tools):\n{}\n",
                disabled_extensions.join("\n")
            ));
        } else {
            output_parts
                .push("No configured extensions are missing from this session.\n".to_string());
        }

        if !enabled_extensions.is_empty() {
            output_parts.push(format!(
                "\n\nExtensions loaded in this session:\n{}\n",
                enabled_extensions
                    .iter()
                    .map(|name| format!("- {}", name))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        } else {
            output_parts.push("No visible extensions are loaded in this session.\n".to_string());
        }

        // Inventory is distinct from tools offered for execution in this turn.
        // In particular, an MCP without readOnlyHint remains discoverable here.
        let tools = self
            .get_prefixed_tools(session_id, None)
            .await
            .map_err(|error| ErrorData::new(ErrorCode::INTERNAL_ERROR, error.to_string(), None))?;
        let mut tool_names: Vec<_> = tools
            .iter()
            .filter(|tool| {
                get_tool_owner(tool).is_some_and(|owner| enabled_extensions.contains(&owner))
            })
            .map(|tool| tool.name.as_ref())
            .collect();
        tool_names.sort_unstable();
        output_parts.push(format!(
            "Discovered tool names from loaded extensions (inventory only; this does not grant execution permission or mark tools as read-only):\n{}",
            tool_names.join("\n")
        ));
        Ok(vec![Content::text(output_parts.join("\n"))])
    }

    async fn get_server_client(&self, name: impl Into<String>) -> Option<McpClientBox> {
        let normalized = name_to_key(&name.into());
        self.extensions
            .lock()
            .await
            .get(&normalized)
            .map(|ext| ext.get_client())
    }

    pub async fn collect_moim_parts(&self, session_id: &str) -> Vec<String> {
        let platform_clients: Vec<(String, McpClientBox)> = {
            let extensions = self.extensions.lock().await;
            extensions
                .iter()
                .filter_map(|(name, extension)| {
                    let is_platform = match &extension.config {
                        ExtensionConfig::Platform { .. } => true,
                        ExtensionConfig::Builtin { name: ext_name, .. } => {
                            PLATFORM_EXTENSIONS.contains_key(name_to_key(ext_name).as_str())
                        }
                        _ => false,
                    };
                    if is_platform {
                        Some((name.clone(), extension.get_client()))
                    } else {
                        None
                    }
                })
                .collect()
        };

        let mut parts = Vec::new();
        for (name, client) in platform_clients {
            if let Some(moim_content) = client.get_moim(session_id).await {
                tracing::debug!("MOIM content from {}: {} chars", name, moim_content.len());
                parts.push(moim_content);
            }
        }
        parts
    }
}

fn stdio_should_advertise_roots(cmd: &str, args: &[String]) -> bool {
    !std::iter::once(cmd)
        .chain(args.iter().map(String::as_str))
        .any(|part| {
            let normalized = part.to_ascii_lowercase().replace('\\', "/");
            normalized.contains("@modelcontextprotocol/server-filesystem")
                || normalized.ends_with("mcp-server-filesystem")
                || normalized.ends_with("mcp-server-filesystem.cmd")
                || normalized.ends_with("mcp-server-filesystem.exe")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::tool_audit::{EffectiveModel, ToolAuditActor, ToolAuditAuthorization};
    use crate::config::permission::CodeProTaskScope;
    use rmcp::model::CallToolResult;
    use rmcp::model::{InitializeResult, JsonObject};
    use rmcp::{object, ServiceError as Error};

    use rmcp::model::ListPromptsResult;
    use rmcp::model::ListResourcesResult;
    use rmcp::model::ListToolsResult;
    use rmcp::model::ReadResourceResult;
    use rmcp::model::ServerNotification;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::mpsc;

    #[test]
    fn read_only_builtin_queries_have_explicit_profiles_without_authorizing_writes() {
        assert_eq!(
            builtin_permission_class("memory", "retrieve_memories"),
            Some(CodeProPermissionClass::ReadOnly)
        );
        assert_eq!(builtin_permission_class("memory", "remember_memory"), None);
        assert_eq!(
            builtin_permission_class("memory", "remove_memory_category"),
            None
        );
        assert_eq!(
            platform_permission_class("apps", "list_apps"),
            Some(CodeProPermissionClass::ReadOnly)
        );
        assert_eq!(platform_permission_class("apps", "delete_app"), None);
        assert_eq!(
            builtin_permission_class("autovisualiser", "show_chart"),
            Some(CodeProPermissionClass::ReadOnly)
        );
        assert_eq!(
            builtin_permission_class("autovisualiser", "execute_script"),
            None
        );
        for name in ["docx_tool", "xlsx_tool", "pdf_tool", "web_scrape", "cache"] {
            assert_eq!(
                builtin_permission_class("computercontroller", name),
                Some(CodeProPermissionClass::HighRisk)
            );
        }
        assert_eq!(
            builtin_permission_class("computercontroller", "automation_script"),
            None
        );
    }

    #[test]
    fn official_filesystem_server_keeps_command_line_scope_authoritative() {
        assert!(!stdio_should_advertise_roots(
            "cmd",
            &[
                "/c".to_string(),
                "npx".to_string(),
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem@2026.8.31".to_string(),
                r"D:\allowed".to_string(),
            ]
        ));
        assert!(stdio_should_advertise_roots(
            "npx",
            &["other-mcp-server".to_string()]
        ));
    }

    #[test]
    fn mcp_explicit_scope_detects_direct_node_and_package_launches() {
        for (cmd, args) in [
            (
                r"C:\Program Files\nodejs\node.exe",
                vec![r"D:\app\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js"],
            ),
            (
                "node",
                vec!["/app/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"],
            ),
            (
                "NODE.EXE",
                vec![r"D:\app/node_modules\@ModelContextProtocol/SERVER-FILESYSTEM\dist/index.js"],
            ),
            (
                "npx",
                vec!["-y", "@modelcontextprotocol/server-filesystem@2026.8.31"],
            ),
            (r"C:\bin\mcp-server-filesystem.cmd", vec![]),
            ("/bin/mcp-server-filesystem", vec![]),
            (r"C:\bin\MCP-SERVER-FILESYSTEM.EXE", vec![]),
        ] {
            let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert!(!stdio_should_advertise_roots(cmd, &args), "{cmd} {args:?}");
        }
        for (cmd, args) in [
            (
                "node",
                vec![r"D:\app\node_modules\other-mcp-server\index.js"],
            ),
            ("npx", vec!["-y", "other-mcp-server"]),
            (r"C:\bin\other-mcp-server.cmd", vec![]),
        ] {
            let args = args.into_iter().map(str::to_owned).collect::<Vec<_>>();
            assert!(stdio_should_advertise_roots(cmd, &args), "{cmd} {args:?}");
        }
    }

    fn audit_outcomes(root: &std::path::Path) -> Vec<String> {
        let audit_root = root.join("audit").join("tool-audit-v2");
        let mut outcomes = Vec::new();
        if !audit_root.exists() {
            return outcomes;
        }
        for session in std::fs::read_dir(audit_root).unwrap() {
            for entry in std::fs::read_dir(session.unwrap().path()).unwrap() {
                let entry = entry.unwrap();
                if entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".completed.json")
                {
                    let value: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap();
                    outcomes.push(value["outcome"].as_str().unwrap().to_owned());
                }
            }
        }
        outcomes.sort();
        outcomes
    }

    fn audit_records(root: &std::path::Path) -> Vec<serde_json::Value> {
        let audit_root = root.join("audit").join("tool-audit-v2");
        let mut records = Vec::new();
        if !audit_root.exists() {
            return records;
        }
        for session in std::fs::read_dir(audit_root).unwrap() {
            for entry in std::fs::read_dir(session.unwrap().path()).unwrap() {
                let entry = entry.unwrap();
                if entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".completed.json")
                {
                    records.push(
                        serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap(),
                    );
                }
            }
        }
        records
    }

    #[tokio::test]
    async fn tool_execution_limit_queues_calls_and_cancellation_stops_waiting() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::sync::Notify;

        let limits =
            ToolExecutionLimits::for_test(1, Duration::from_secs(5), Duration::from_millis(50));
        let first_started = Arc::new(Notify::new());
        let release_first = Arc::new(Notify::new());
        let first = {
            let limits = limits.clone();
            let first_started = Arc::clone(&first_started);
            let release_first = Arc::clone(&release_first);
            tokio::spawn(async move {
                run_bounded_tool_operation(
                    limits,
                    CancellationToken::new(),
                    "first_tool".to_string(),
                    move |_| async move {
                        first_started.notify_one();
                        release_first.notified().await;
                        Ok(())
                    },
                )
                .await
            })
        };
        first_started.notified().await;

        let second_started = Arc::new(AtomicBool::new(false));
        let cancel_second = CancellationToken::new();
        let second = {
            let second_started = Arc::clone(&second_started);
            let cancel_second_for_call = cancel_second.clone();
            tokio::spawn(async move {
                run_bounded_tool_operation(
                    limits,
                    cancel_second_for_call,
                    "second_tool".to_string(),
                    move |_| async move {
                        second_started.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
            })
        };

        tokio::task::yield_now().await;
        assert!(!second_started.load(Ordering::SeqCst));
        cancel_second.cancel();
        let second_error = tokio::time::timeout(Duration::from_millis(200), second)
            .await
            .expect("cancelled queued tool must return promptly")
            .unwrap()
            .unwrap_err();
        let BoundedToolError::Cancelled(second_error) = second_error else {
            panic!("queued cancellation must retain its typed outcome");
        };
        assert_eq!(
            second_error.message,
            "Tool 'second_tool' was cancelled while waiting to run"
        );
        assert!(!second_started.load(Ordering::SeqCst));

        release_first.notify_one();
        first.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn tool_execution_timeout_cancels_child_and_discards_late_success() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let limits =
            ToolExecutionLimits::for_test(1, Duration::from_millis(20), Duration::from_millis(100));
        let child_cancelled = Arc::new(AtomicBool::new(false));
        let child_cancelled_for_call = Arc::clone(&child_cancelled);

        let error = run_bounded_tool_operation(
            limits,
            CancellationToken::new(),
            "slow_tool".to_string(),
            move |child| async move {
                tokio::select! {
                    _ = child.cancelled() => {
                        child_cancelled_for_call.store(true, Ordering::SeqCst);
                    }
                    _ = tokio::time::sleep(Duration::from_millis(150)) => {}
                }
                Ok(())
            },
        )
        .await
        .unwrap_err();
        let BoundedToolError::TimedOut(error) = error else {
            panic!("timeout must retain its typed outcome");
        };

        assert_eq!(
            error.message,
            "Tool 'slow_tool' exceeded its host execution timeout and was cancelled"
        );
        assert!(child_cancelled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn bounded_timeout_preserves_same_attempt_cleanup_without_accepting_late_success() {
        let error = run_bounded_tool_operation(
            ToolExecutionLimits::for_test(1, Duration::from_millis(10), Duration::from_millis(100)),
            CancellationToken::new(),
            "shell".into(),
            |token| async move {
                token.cancelled().await;
                let mut result = CallToolResult::error(vec![]);
                result.structured_content = Some(serde_json::json!({
                    "cancelled":true, "termination_confirmed":true, "output_truncated":false,
                    "exit_code":null, "stdout":"partial output",
                }));
                Ok(result)
            },
        )
        .await
        .unwrap_err();
        let BoundedToolError::TimedOut(error) = error else {
            panic!("deadline outcome must survive cleanup")
        };
        let retained = bounded_execution_result(&error).expect("same-attempt cleanup receipt");
        assert_eq!(retained.is_error, Some(true));
        assert_eq!(
            retained.structured_content.as_ref().unwrap()["termination_confirmed"],
            true
        );
        assert_eq!(
            retained.structured_content.as_ref().unwrap()["stdout"],
            "partial output"
        );
    }

    #[tokio::test]
    async fn running_tool_cancellation_is_bounded_when_cleanup_is_slow() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let limits =
            ToolExecutionLimits::for_test(1, Duration::from_secs(5), Duration::from_millis(20));
        let parent = CancellationToken::new();
        let cancel_observed = Arc::new(AtomicBool::new(false));
        let cancel_observed_for_call = Arc::clone(&cancel_observed);
        let cancel_parent = parent.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel_parent.cancel();
        });

        let result = tokio::time::timeout(
            Duration::from_millis(200),
            run_bounded_tool_operation(
                limits,
                parent,
                "cancelled_tool".to_string(),
                move |child| async move {
                    child.cancelled().await;
                    cancel_observed_for_call.store(true, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    Ok(())
                },
            ),
        )
        .await
        .expect("host cancellation must not wait for slow cleanup")
        .unwrap_err();
        let BoundedToolError::Cancelled(result) = result else {
            panic!("running cancellation must retain its typed outcome");
        };

        assert_eq!(
            result.message,
            "Tool 'cancelled_tool' was cancelled during execution"
        );
        assert!(cancel_observed.load(Ordering::SeqCst));
        assert!(
            bounded_execution_result(&result).is_none(),
            "expired cleanup cannot invent a receipt"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn bounded_windows_shell_timeout_retains_real_cleanup_receipt() {
        use super::super::platform_extensions::developer::shell::{ShellParams, ShellTool};
        let shell = ShellTool::new(false).expect("installed shell");
        let workspace = tempfile::tempdir().unwrap();
        let result = run_bounded_tool_operation(
            ToolExecutionLimits::for_test(1, Duration::from_secs(3), Duration::from_secs(8)),
            CancellationToken::new(),
            "shell".into(),
            |token| async move {
                Ok(shell
                    .shell_with_cwd(
                        ShellParams {
                            command: "powershell -NoProfile -NonInteractive -Command \"Write-Output 'cleanup-fixture-started'; Start-Sleep -Seconds 30\"".into(),
                            timeout_secs: None,
                        },
                        Some(workspace.path()),
                        None,
                        token,
                    )
                    .await)
            },
        )
        .await;
        let Err(BoundedToolError::TimedOut(error)) = result else {
            panic!("outer deadline must remain a timeout: {result:?}")
        };
        let retained = bounded_execution_result(&error).expect("real same-attempt cleanup");
        assert_eq!(retained.is_error, Some(true));
        let body = retained
            .structured_content
            .expect("structured shell result");
        assert_eq!(body["termination_confirmed"], true);
        assert_eq!(body["cancelled"], true);
        let shell_output: super::super::platform_extensions::developer::shell::ShellOutput =
            serde_json::from_value(body.clone()).unwrap();
        assert!(!shell_output.output_truncated);
        assert!(body["stdout"]
            .as_str()
            .unwrap()
            .contains("cleanup-fixture-started"));
    }

    #[test]
    fn tool_execution_timeout_is_clamped_to_host_bounds() {
        assert_eq!(
            bounded_tool_timeout(Some(0)),
            Duration::from_secs(MIN_TOOL_TIMEOUT_SECS)
        );
        assert_eq!(
            bounded_tool_timeout(Some(u64::MAX)),
            Duration::from_secs(MAX_TOOL_TIMEOUT_SECS)
        );
    }

    #[test]
    fn configured_tool_limits_share_one_process_wide_semaphore() {
        let first = ToolExecutionLimits::configured();
        let second = ToolExecutionLimits::configured();

        assert!(Arc::ptr_eq(&first.semaphore, &second.semaphore));
    }

    impl ExtensionManager {
        async fn add_mock_extension(&self, name: String, client: McpClientBox) {
            self.add_mock_extension_with_tools(name, client, vec![])
                .await;
        }

        async fn add_mock_extension_with_timeout(
            &self,
            name: String,
            client: McpClientBox,
            timeout: u64,
        ) {
            let sanitized_name = name_to_key(&name);
            let config = ExtensionConfig::Builtin {
                name: name.clone(),
                display_name: Some(name.clone()),
                description: "built-in".to_string(),
                timeout: Some(timeout),
                bundled: None,
                available_tools: vec![],
            };
            let extension = Extension::new(config.clone(), config, client, None, None);
            self.extensions
                .lock()
                .await
                .insert(sanitized_name, extension);
            self.invalidate_tools_cache_and_bump_version().await;
        }

        async fn add_mock_extension_with_tools(
            &self,
            name: String,
            client: McpClientBox,
            available_tools: Vec<String>,
        ) {
            let sanitized_name = name_to_key(&name);
            let config = ExtensionConfig::Builtin {
                name: name.clone(),
                display_name: Some(name.clone()),
                description: "built-in".to_string(),
                timeout: None,
                bundled: None,
                available_tools,
            };
            let extension = Extension::new(config.clone(), config.clone(), client, None, None);
            self.extensions
                .lock()
                .await
                .insert(sanitized_name, extension);
            self.invalidate_tools_cache_and_bump_version().await;
        }

        async fn add_mock_platform_extension(&self, name: String, client: McpClientBox) {
            let sanitized_name = name_to_key(&name);
            let config = ExtensionConfig::Platform {
                name,
                display_name: Some("mock platform".to_string()),
                description: "mock platform".to_string(),
                bundled: None,
                available_tools: vec![],
            };
            let extension = Extension::new(config.clone(), config.clone(), client, None, None);
            self.extensions
                .lock()
                .await
                .insert(sanitized_name, extension);
            self.invalidate_tools_cache_and_bump_version().await;
        }

        async fn add_mock_stdio_extension(&self, name: String, client: McpClientBox) {
            let sanitized_name = name_to_key(&name);
            let config = ExtensionConfig::Stdio {
                name,
                description: "external stdio".to_string(),
                cmd: "mock-stdio".to_string(),
                args: vec![],
                envs: Default::default(),
                env_keys: vec![],
                timeout: None,
                cwd: None,
                bundled: None,
                available_tools: vec![],
                read_only_tools: vec![],
            };
            let extension = Extension::new(config.clone(), config, client, None, None);
            self.extensions
                .lock()
                .await
                .insert(sanitized_name, extension);
            self.invalidate_tools_cache_and_bump_version().await;
        }

        async fn add_mock_http_extension(&self, name: String, client: McpClientBox) {
            let sanitized_name = name_to_key(&name);
            let config = ExtensionConfig::StreamableHttp {
                name,
                description: "external http".to_string(),
                uri: "https://example.invalid/mcp".to_string(),
                envs: Default::default(),
                env_keys: vec![],
                headers: HashMap::new(),
                timeout: None,
                socket: None,
                bundled: None,
                available_tools: vec![],
                read_only_tools: vec![],
            };
            let extension = Extension::new(config.clone(), config, client, None, None);
            self.extensions
                .lock()
                .await
                .insert(sanitized_name, extension);
            self.invalidate_tools_cache_and_bump_version().await;
        }
    }

    struct MockClient {}

    static MOCK_GIT_COMMIT_CALLS: AtomicUsize = AtomicUsize::new(0);
    static MOCK_GIT_COMMIT_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    #[derive(Default)]
    struct AuditTestClient {
        calls: AtomicUsize,
        lists: AtomicUsize,
        method_tools: Vec<&'static str>,
    }

    impl AuditTestClient {
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn lists(&self) -> usize {
            self.lists.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl McpClientTrait for AuditTestClient {
        fn get_info(&self) -> Option<&InitializeResult> {
            None
        }

        async fn list_resources(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListResourcesResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn read_resource(
            &self,
            _session_id: &str,
            _uri: &str,
            _cancellation_token: CancellationToken,
        ) -> Result<ReadResourceResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn list_tools(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListToolsResult, Error> {
            self.lists.fetch_add(1, Ordering::SeqCst);
            Ok(ListToolsResult {
                tools: [
                    "success",
                    "tool_error",
                    "outside",
                    "transport_error",
                    "wait",
                    "write",
                    "edit",
                    "shell",
                ]
                .into_iter()
                .chain(self.method_tools.iter().copied())
                .map(|name| {
                    Tool::new(
                        name.to_string(),
                        "audit test tool".to_string(),
                        Arc::new(
                            serde_json::json!({ "type": "object" })
                                .as_object()
                                .unwrap()
                                .clone(),
                        ),
                    )
                })
                .collect(),
                next_cursor: None,
                meta: None,
            })
        }

        async fn call_tool(
            &self,
            ctx: &ToolCallContext,
            name: &str,
            arguments: Option<JsonObject>,
            cancellation_token: CancellationToken,
        ) -> Result<CallToolResult, Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if name == "edit" {
                let simulate = arguments
                    .as_ref()
                    .and_then(|arguments| arguments.get("simulate"))
                    .and_then(Value::as_str);
                if matches!(simulate, Some("transport_error" | "wait")) {
                    let workspace = ctx
                        .working_dir
                        .as_ref()
                        .expect("simulated edit requires a workspace");
                    let relative = arguments
                        .as_ref()
                        .and_then(|arguments| arguments.get("path"))
                        .and_then(Value::as_str)
                        .expect("simulated edit requires a path");
                    let target = workspace.join(relative);
                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent).unwrap();
                    }
                    std::fs::write(target, "changed by simulated edit").unwrap();
                    if simulate == Some("transport_error") {
                        return Err(Error::TransportClosed);
                    }
                    cancellation_token.cancelled().await;
                    return Ok(CallToolResult::success(vec![]));
                }
            }
            match name {
                "success" => Ok(CallToolResult::success(vec![])),
                "tool_error" => Ok(CallToolResult::error(vec![Content::text(
                    "expected test error",
                )])),
                "outside" => {
                    let mut result = CallToolResult::error(vec![Content::text("outside")]);
                    result.meta = Some(Meta(
                        serde_json::json!({
                            REPORTED_CODEPRO_FAILURE_META_KEY: "outside_workspace"
                        })
                        .as_object()
                        .unwrap()
                        .clone(),
                    ));
                    Ok(result)
                }
                "transport_error" => Err(Error::TransportClosed),
                "wait" => {
                    cancellation_token.cancelled().await;
                    Ok(CallToolResult::success(vec![]))
                }
                "write" | "edit" | "shell" => Ok(CallToolResult::success(vec![])),
                name if self.method_tools.contains(&name) => Ok(CallToolResult::success(vec![])),
                _ => Err(Error::TransportClosed),
            }
        }

        async fn list_prompts(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListPromptsResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn get_prompt(
            &self,
            _session_id: &str,
            _name: &str,
            _arguments: Value,
            _cancellation_token: CancellationToken,
        ) -> Result<GetPromptResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn subscribe(&self) -> mpsc::Receiver<ServerNotification> {
            mpsc::channel(1).1
        }
    }

    #[async_trait::async_trait]
    impl McpClientTrait for MockClient {
        fn get_info(&self) -> Option<&InitializeResult> {
            None
        }

        async fn list_resources(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListResourcesResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn read_resource(
            &self,
            _session_id: &str,
            _uri: &str,
            _cancellation_token: CancellationToken,
        ) -> Result<ReadResourceResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn list_tools(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListToolsResult, Error> {
            use serde_json::json;
            use std::sync::Arc;
            Ok(ListToolsResult {
                tools: vec![
                    Tool::new(
                        "tool".to_string(),
                        "A basic tool".to_string(),
                        Arc::new(json!({}).as_object().unwrap().clone()),
                    ),
                    Tool::new(
                        "available_tool".to_string(),
                        "An available tool".to_string(),
                        Arc::new(json!({}).as_object().unwrap().clone()),
                    ),
                    Tool::new(
                        "hidden_tool".to_string(),
                        "hidden tool".to_string(),
                        Arc::new(json!({}).as_object().unwrap().clone()),
                    ),
                    Tool::new(
                        "schema_tool".to_string(),
                        "A tool with a strict input schema".to_string(),
                        Arc::new(
                            json!({
                                "type": "object",
                                "properties": { "count": { "type": "integer", "minimum": 1 } },
                                "required": ["count"],
                                "additionalProperties": false
                            })
                            .as_object()
                            .unwrap()
                            .clone(),
                        ),
                    ),
                    Tool::new(
                        "git_commit".to_string(),
                        "A counted non-idempotent tool".to_string(),
                        Arc::new(json!({ "type": "object" }).as_object().unwrap().clone()),
                    ),
                    {
                        let mut tool = Tool::new(
                            "git_status".to_string(),
                            "An idempotent registered tool".to_string(),
                            Arc::new(json!({ "type": "object" }).as_object().unwrap().clone()),
                        )
                        .annotate(
                            rmcp::model::ToolAnnotations::with_title(
                                "forged read-only git status".to_string(),
                            )
                            .read_only(true),
                        );
                        tool.meta = Some(Meta(
                            json!({ "goose_extension": "forged_owner" })
                                .as_object()
                                .unwrap()
                                .clone(),
                        ));
                        tool
                    },
                    {
                        let mut t = Tool::new(
                            "render_chart".to_string(),
                            "Render a chart".to_string(),
                            Arc::new(json!({}).as_object().unwrap().clone()),
                        );
                        t.meta = Some(Meta(
                            json!({ "ui": { "resourceUri": "ui://autovisualiser/chart" } })
                                .as_object()
                                .unwrap()
                                .clone(),
                        ));
                        t
                    },
                ],
                next_cursor: None,
                meta: None,
            })
        }

        async fn call_tool(
            &self,
            _ctx: &ToolCallContext,
            name: &str,
            _arguments: Option<JsonObject>,
            _cancellation_token: CancellationToken,
        ) -> Result<CallToolResult, Error> {
            match name {
                "git_commit" => {
                    MOCK_GIT_COMMIT_CALLS.fetch_add(1, Ordering::SeqCst);
                    Ok(CallToolResult::success(vec![]))
                }
                "tool" | "test__tool" | "available_tool" | "hidden_tool" | "schema_tool"
                | "git_status" | "render_chart" => Ok(CallToolResult::success(vec![])),
                _ => Err(Error::TransportClosed),
            }
        }

        async fn list_prompts(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListPromptsResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn get_prompt(
            &self,
            _session_id: &str,
            _name: &str,
            _arguments: Value,
            _cancellation_token: CancellationToken,
        ) -> Result<GetPromptResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn subscribe(&self) -> mpsc::Receiver<ServerNotification> {
            mpsc::channel(1).1
        }
    }

    #[tokio::test]
    async fn dispatch_audits_success_and_tool_error_without_extra_client_calls() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension_with_timeout("audit".to_string(), client.clone(), 1)
            .await;
        let ctx = ToolCallContext::new(
            "audit-session".to_string(),
            None,
            Some("audit-request".to_string()),
        )
        .with_audit_identity(
            ToolAuditActor::Primary,
            EffectiveModel::new("host-provider/host-model").unwrap(),
        )
        .with_audit_authorization(ToolAuditAuthorization::UserConfirmed);

        let mut receipt_outcomes = Vec::new();
        for tool in ["audit__success", "audit__tool_error"] {
            let result = manager
                .dispatch_tool_call(
                    &ctx,
                    CallToolRequestParams::new(tool.to_string()).with_arguments(object!({})),
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .result
                .await
                .unwrap();
            let receipt = result
                .meta
                .as_ref()
                .and_then(|meta| meta.0.get(TRUSTED_TOOL_UPDATE_META_KEY))
                .and_then(|meta| meta.get("toolAudit"))
                .expect("host audit receipt");
            assert_eq!(receipt["schemaVersion"], 2);
            assert_eq!(
                receipt["toolName"],
                format!("audit::{}", tool.replace("audit__", ""))
            );
            assert!(receipt.get("argumentDigest").is_none());
            receipt_outcomes.push(receipt["outcome"].as_str().unwrap().to_string());
        }

        assert_eq!(client.calls(), 2);
        assert_eq!(audit_outcomes(temp_dir.path()), ["success", "tool_error"]);
        assert_eq!(receipt_outcomes, ["success", "tool_error"]);
        for record in audit_records(temp_dir.path()) {
            assert_eq!(record["actor"], "primary");
            assert_eq!(record["effective_model"], "host-provider/host-model");
            assert_eq!(record["authorization"], "user_confirmed");
        }
    }

    fn scoped_edit_context(workspace: &std::path::Path, request_id: &str) -> ToolCallContext {
        let scope = CodeProTaskScope::new_bound(
            "run-workspace-delta",
            "task-workspace-delta",
            workspace,
            vec!["./**".into()],
            vec!["app.js".into()],
        )
        .unwrap();
        ToolCallContext::new(
            "workspace-delta-session".to_string(),
            Some(workspace.to_path_buf()),
            Some(request_id.to_string()),
        )
        .with_codepro_task_scope(scope)
    }

    #[tokio::test]
    async fn fifth_repair_batch_transport_error_preserves_observed_workspace_delta() {
        let temp_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension("developer".to_string(), client)
            .await;
        let ctx = scoped_edit_context(workspace.path(), "transport-error-edit");

        let error = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("edit").with_arguments(object!({
                    "path": "app.js",
                    "simulate": "transport_error"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap_err();

        assert_eq!(
            std::fs::read_to_string(workspace.path().join("app.js")).unwrap(),
            "changed by simulated edit"
        );
        assert_eq!(
            trusted_workspace_delta_from_error(&error),
            Some(vec!["app.js".to_string()])
        );
        assert_eq!(
            trusted_tool_audit_from_error(&error).unwrap().outcome,
            ToolAuditOutcome::ToolError
        );
    }

    #[tokio::test]
    async fn fifth_repair_batch_timeout_preserves_observed_workspace_delta() {
        let temp_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension_with_timeout("developer".to_string(), client, 1)
            .await;
        let ctx = scoped_edit_context(workspace.path(), "timeout-edit");

        let error = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("edit").with_arguments(object!({
                    "path": "app.js",
                    "simulate": "wait"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap_err();

        assert_eq!(
            std::fs::read_to_string(workspace.path().join("app.js")).unwrap(),
            "changed by simulated edit"
        );
        assert_eq!(
            trusted_workspace_delta_from_error(&error),
            Some(vec!["app.js".to_string()])
        );
        assert_eq!(
            trusted_tool_audit_from_error(&error).unwrap().outcome,
            ToolAuditOutcome::TimedOut
        );
    }

    #[tokio::test]
    async fn task_scoped_developer_write_is_rejected_before_client_execution() {
        let temp_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension("developer".to_string(), client.clone())
            .await;
        let scope = CodeProTaskScope::new_bound(
            "run-write-scope",
            "task-write-scope",
            workspace.path(),
            vec!["./**".into()],
            vec!["src/owned.rs".into()],
        )
        .unwrap();
        let ctx = ToolCallContext::new(
            "write-scope-session".to_string(),
            Some(workspace.path().to_path_buf()),
            Some("write-scope-request".to_string()),
        )
        .with_codepro_task_scope(scope);

        let absolute = workspace.path().join("absolute-generated.txt");
        for path in [
            "notes/generated.txt".to_string(),
            "../parent-generated.txt".to_string(),
            absolute.display().to_string(),
        ] {
            let result = manager
                .dispatch_tool_call(
                    &ctx,
                    CallToolRequestParams::new("write")
                        .with_arguments(object!({ "path": path, "content": "x" })),
                    CancellationToken::new(),
                )
                .await
                .unwrap()
                .result
                .await
                .unwrap();

            assert_eq!(result.is_error, Some(true));
            assert_eq!(
                result.meta.as_ref().unwrap().0[TRUSTED_TOOL_UPDATE_META_KEY]["codeProFailure"],
                "outside_workspace"
            );
        }
        assert_eq!(
            client.calls(),
            0,
            "policy rejection must precede client execution"
        );
        assert!(!workspace.path().join("notes/generated.txt").exists());
        assert!(!absolute.exists());
    }

    #[tokio::test]
    async fn task_scoped_developer_shell_is_rejected_before_client_execution() {
        let temp_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension("developer".to_string(), client.clone())
            .await;
        let scope = CodeProTaskScope::new_bound(
            "run-shell-scope",
            "task-shell-scope",
            workspace.path(),
            vec!["./**".into()],
            vec!["src/**".into()],
        )
        .unwrap();
        let ctx = ToolCallContext::new(
            "shell-scope-session".to_string(),
            Some(workspace.path().to_path_buf()),
            Some("shell-scope-request".to_string()),
        )
        .with_codepro_task_scope(scope);

        let result = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("shell")
                    .with_arguments(object!({ "command": "opaque fixture" })),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap();

        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            client.calls(),
            0,
            "bounded shell must fail before execution"
        );
        assert_eq!(
            result.meta.as_ref().unwrap().0[TRUSTED_TOOL_UPDATE_META_KEY]["codeProFailure"],
            "outside_workspace"
        );
    }

    #[tokio::test]
    async fn unscoped_developer_shell_and_allowed_direct_write_still_execute() {
        let temp_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension("developer".to_string(), client.clone())
            .await;
        let unscoped = ToolCallContext::new(
            "unscoped-shell-session".to_string(),
            Some(workspace.path().to_path_buf()),
            Some("unscoped-shell-request".to_string()),
        );
        let shell = manager
            .dispatch_tool_call(
                &unscoped,
                CallToolRequestParams::new("shell")
                    .with_arguments(object!({ "command": "opaque fixture" })),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap();
        assert_ne!(shell.is_error, Some(true));

        let scope = CodeProTaskScope::new_bound(
            "run-write-allowed",
            "task-write-allowed",
            workspace.path(),
            vec!["./**".into()],
            vec!["src/owned.rs".into()],
        )
        .unwrap();
        let scoped = ToolCallContext::new(
            "allowed-write-session".to_string(),
            Some(workspace.path().to_path_buf()),
            Some("allowed-write-request".to_string()),
        )
        .with_codepro_task_scope(scope);
        let write = manager
            .dispatch_tool_call(
                &scoped,
                CallToolRequestParams::new("write")
                    .with_arguments(object!({ "path": "src/owned.rs", "content": "x" })),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap();

        assert_ne!(write.is_error, Some(true));
        let edit = manager
            .dispatch_tool_call(
                &scoped,
                CallToolRequestParams::new("edit").with_arguments(object!({
                    "path": "src/owned.rs",
                    "before": "x",
                    "after": "y"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap();

        assert_ne!(edit.is_error, Some(true));
        assert_eq!(client.calls(), 3);
    }

    #[tokio::test]
    async fn denied_calls_write_matching_terminal_records_without_calling_the_client() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension_with_timeout("audit".to_string(), client.clone(), 1)
            .await;
        manager
            .get_prefixed_tools("audit-session", None)
            .await
            .unwrap();
        let list_calls_before_denials = client.lists();

        for (request_id, authorization) in [
            ("policy-denied", ToolAuditAuthorization::PolicyDenied),
            ("user-denied", ToolAuditAuthorization::UserDenied),
        ] {
            let ctx = ToolCallContext::new(
                "audit-session".to_string(),
                None,
                Some(request_id.to_string()),
            )
            .with_audit_identity(
                ToolAuditActor::CodeproTester,
                EffectiveModel::new("host-provider/host-model").unwrap(),
            )
            .with_audit_authorization(authorization);
            let receipt = manager
                .record_denied_tool_call(
                    &ctx,
                    &CallToolRequestParams::new("audit__success".to_string())
                        .with_arguments(object!({})),
                )
                .await
                .unwrap();
            let receipt = serde_json::to_value(receipt).unwrap();
            assert_eq!(receipt["authorization"], receipt["outcome"]);
        }

        assert_eq!(client.calls(), 0);
        assert_eq!(client.lists(), list_calls_before_denials);
        let mut records = audit_records(temp_dir.path());
        records.sort_by_key(|record| record["request_digest"].as_str().unwrap().to_string());
        assert_eq!(records.len(), 2);
        for record in records {
            assert_eq!(record["actor"], "codepro_tester");
            assert_eq!(record["effective_model"], "host-provider/host-model");
            assert_eq!(record["authorization"], record["outcome"]);
        }
    }

    #[tokio::test]
    async fn denied_calls_persist_matching_terminals_without_host_tool_cache() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension_with_timeout("audit".to_string(), client.clone(), 1)
            .await;
        for (request_id, authorization) in [
            ("policy-denied", ToolAuditAuthorization::PolicyDenied),
            ("user-denied", ToolAuditAuthorization::UserDenied),
        ] {
            let ctx = ToolCallContext::new(
                "audit-session".to_string(),
                None,
                Some(request_id.to_string()),
            )
            .with_audit_authorization(authorization);
            manager
                .record_denied_tool_call(
                    &ctx,
                    &CallToolRequestParams::new("audit__success".to_string())
                        .with_arguments(object!({})),
                )
                .await
                .unwrap();
        }
        let sentinel_context = ToolCallContext::new(
            "audit-session".to_string(),
            None,
            Some("untrusted-name".to_string()),
        )
        .with_audit_authorization(ToolAuditAuthorization::PolicyDenied);
        manager
            .record_denied_tool_call(
                &sentinel_context,
                &CallToolRequestParams::new("untrusted tool name".to_string())
                    .with_arguments(object!({})),
            )
            .await
            .unwrap();
        let unavailable_context = ToolCallContext::new(
            "audit-session".to_string(),
            None,
            Some("unavailable-tool".to_string()),
        )
        .with_audit_authorization(ToolAuditAuthorization::UserDenied);
        manager
            .record_denied_tool_call(
                &unavailable_context,
                &CallToolRequestParams::new("developer__write".to_string())
                    .with_arguments(object!({"path": "denied-marker.txt"})),
            )
            .await
            .unwrap();

        assert_eq!(client.calls(), 0);
        assert_eq!(client.lists(), 0);
        let records = audit_records(temp_dir.path());
        assert_eq!(records.len(), 4);
        assert!(records.iter().any(|record| {
            record["authorization"] == "policy_denied"
                && record["outcome"] == "policy_denied"
                && record["tool_name"] == "audit::success"
        }));
        assert!(records.iter().any(|record| {
            record["authorization"] == "user_denied"
                && record["outcome"] == "user_denied"
                && record["tool_name"] == "audit::success"
        }));
        assert!(records.iter().any(|record| {
            record["authorization"] == "policy_denied"
                && record["outcome"] == "policy_denied"
                && record["tool_name"] == "unknown::tool"
                && record["extension_source"] == "unknown"
                && record["permission_class"] == "legacy"
        }));
        assert!(records.iter().any(|record| {
            record["authorization"] == "user_denied"
                && record["outcome"] == "user_denied"
                && record["tool_name"] == "developer::write"
                && record["extension_source"] == "unknown"
                && record["permission_class"] == "legacy"
        }));
    }

    #[tokio::test]
    async fn unprefixed_platform_denials_keep_registered_identity_without_client_calls() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_platform_extension("git".to_string(), client.clone())
            .await;

        for (request_id, authorization) in [
            ("git-policy-denied", ToolAuditAuthorization::PolicyDenied),
            ("git-user-denied", ToolAuditAuthorization::UserDenied),
        ] {
            let ctx = ToolCallContext::new(
                "git-denial-session".to_string(),
                None,
                Some(request_id.to_string()),
            )
            .with_audit_authorization(authorization);
            manager
                .record_denied_tool_call(
                    &ctx,
                    &CallToolRequestParams::new("git_push").with_arguments(object!({})),
                )
                .await
                .unwrap();
        }

        assert_eq!(client.calls(), 0);
        assert_eq!(client.lists(), 0);
        let records = audit_records(temp_dir.path());
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|record| {
            record["tool_name"] == "git::git_push"
                && record["extension_source"] == "platform"
                && record["permission_class"] == "external_write"
                && record["authorization"] == record["outcome"]
        }));
    }

    #[tokio::test]
    async fn project_memory_denials_use_the_registered_platform_owner() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_platform_extension("projectmemory".to_string(), client.clone())
            .await;

        let ctx = ToolCallContext::new(
            "project-memory-denial-session".to_string(),
            None,
            Some("project-memory-policy-denied".to_string()),
        )
        .with_audit_authorization(ToolAuditAuthorization::PolicyDenied);
        manager
            .record_denied_tool_call(
                &ctx,
                &CallToolRequestParams::new("project_memory_remember").with_arguments(object!({})),
            )
            .await
            .unwrap();

        assert_eq!(client.calls(), 0);
        assert_eq!(client.lists(), 0);
        let records = audit_records(temp_dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0]["tool_name"],
            "projectmemory::project_memory_remember"
        );
        assert_eq!(records[0]["extension_source"], "platform");
        assert_eq!(records[0]["permission_class"], "workspace_write");
        assert_eq!(records[0]["authorization"], "policy_denied");
        assert_eq!(records[0]["outcome"], "policy_denied");
    }

    #[tokio::test]
    async fn dispatch_audits_cancellation_and_timeout_with_typed_outcomes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager.tool_execution_limits =
            ToolExecutionLimits::for_test(1, Duration::from_millis(20), Duration::from_millis(20));
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension_with_timeout("audit".to_string(), client.clone(), 1)
            .await;
        let ctx = ToolCallContext::new(
            "audit-session".to_string(),
            None,
            Some("audit-request".to_string()),
        )
        .with_codepro_task_scope(CodeProTaskScope::new("run-a", "task-a").unwrap())
        .with_audit_identity(
            ToolAuditActor::CodeproTester,
            EffectiveModel::new("host-provider/host-model").unwrap(),
        );

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let cancellation_error = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("audit__wait".to_string()).with_arguments(object!({})),
                cancelled,
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap_err();
        assert_eq!(
            cancellation_error.message,
            "Tool 'audit__wait' was cancelled while waiting to run"
        );
        assert_eq!(
            cancellation_error.data.as_ref().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]
                ["outcome"],
            "cancelled"
        );
        assert_eq!(
            cancellation_error.data.as_ref().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]
                ["failureKind"],
            "cancelled"
        );

        let timeout_error = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("audit__wait".to_string()).with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap_err();
        assert_eq!(
            timeout_error.message,
            "Tool 'audit__wait' exceeded its host execution timeout and was cancelled"
        );
        assert_eq!(
            timeout_error.data.as_ref().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]
                ["outcome"],
            "timed_out"
        );
        assert_eq!(client.calls(), 1);
        assert_eq!(audit_outcomes(temp_dir.path()), ["cancelled", "timed_out"]);
        for record in audit_records(temp_dir.path()) {
            assert_eq!(record["actor"], "codepro_tester");
            assert_eq!(record["effective_model"], "host-provider/host-model");
            assert_eq!(record["authorization"], "policy_allowed");
        }
    }

    #[tokio::test]
    async fn dispatch_trusts_only_platform_failure_facts_and_maps_transport_errors() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_platform_extension("auditplatform".to_string(), client.clone())
            .await;
        manager
            .add_mock_extension("externalaudit".to_string(), client)
            .await;
        let ctx = ToolCallContext::new(
            "failure-session".to_string(),
            None,
            Some("failure-request".to_string()),
        );

        let platform = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("auditplatform__outside").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap();
        assert_eq!(
            platform.meta.as_ref().unwrap().0[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]
                ["failureKind"],
            "outside_workspace"
        );

        let external = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("externalaudit__outside").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap();
        assert_eq!(
            external.meta.as_ref().unwrap().0[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]
                ["failureKind"],
            Value::Null
        );

        let environment_error = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("externalaudit__transport_error")
                    .with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap_err();
        assert_eq!(
            environment_error.data.as_ref().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]
                ["failureKind"],
            "environment_failure"
        );
    }

    #[tokio::test]
    async fn test_dispatch_tool_call() {
        use super::super::tool_execution::ToolCallContext;

        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        // Add some mock clients using the helper method
        extension_manager
            .add_mock_extension("test_client".to_string(), Arc::new(MockClient {}))
            .await;

        extension_manager
            .add_mock_extension("__cli__ent__".to_string(), Arc::new(MockClient {}))
            .await;

        extension_manager
            .add_mock_extension("client 🚀".to_string(), Arc::new(MockClient {}))
            .await;

        let ctx = ToolCallContext::new(
            "test-session-id".to_string(),
            None,
            Some("test-req-id".to_string()),
        );

        let tool_call =
            CallToolRequestParams::new("test_client__tool".to_string()).with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, tool_call, CancellationToken::default())
            .await;
        assert!(result.is_ok());

        let tool_call = CallToolRequestParams::new("test_client__available_tool".to_string())
            .with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, tool_call, CancellationToken::default())
            .await;
        assert!(result.is_ok());

        let tool_call = CallToolRequestParams::new("__cli__ent____tool".to_string())
            .with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, tool_call, CancellationToken::default())
            .await;
        assert!(result.is_ok());

        let tool_call =
            CallToolRequestParams::new("client___tool".to_string()).with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, tool_call, CancellationToken::default())
            .await;
        assert!(result.is_ok());

        let invalid_tool_call =
            CallToolRequestParams::new("client___tools".to_string()).with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, invalid_tool_call, CancellationToken::default())
            .await;
        if let Err(err) = result {
            let tool_err = err.downcast_ref::<ErrorData>().expect("Expected ErrorData");
            assert_eq!(tool_err.code, ErrorCode::RESOURCE_NOT_FOUND);
        } else {
            panic!("Expected ErrorData with ErrorCode::RESOURCE_NOT_FOUND");
        }

        let invalid_tool_call =
            CallToolRequestParams::new("_client__tools".to_string()).with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, invalid_tool_call, CancellationToken::default())
            .await;
        if let Err(err) = result {
            let tool_err = err.downcast_ref::<ErrorData>().expect("Expected ErrorData");
            assert_eq!(tool_err.code, ErrorCode::RESOURCE_NOT_FOUND);
        } else {
            panic!("Expected ErrorData with ErrorCode::RESOURCE_NOT_FOUND");
        }
    }

    #[tokio::test]
    async fn repeated_non_idempotent_request_executes_the_client_only_once() {
        use super::super::tool_execution::ToolCallContext;

        let _test_guard = MOCK_GIT_COMMIT_TEST_LOCK.lock().await;
        MOCK_GIT_COMMIT_CALLS.store(0, Ordering::SeqCst);
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_platform_extension("git".to_string(), Arc::new(MockClient {}))
            .await;
        let ctx = ToolCallContext::new(
            "idempotency-session".to_string(),
            None,
            Some("idempotency-request".to_string()),
        );

        let mut receipt_outcomes = Vec::new();
        for _ in 0..2 {
            let result = extension_manager
                .dispatch_tool_call(
                    &ctx,
                    CallToolRequestParams::new("git_commit").with_arguments(object!({})),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            let result = result.result.await.unwrap();
            receipt_outcomes.push(
                result.meta.as_ref().unwrap().0[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]
                    ["outcome"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            );
        }

        assert_eq!(MOCK_GIT_COMMIT_CALLS.load(Ordering::SeqCst), 1);
        assert_eq!(receipt_outcomes, ["success", "replay_suppressed"]);
        assert_eq!(
            audit_outcomes(temp_dir.path()),
            ["replay_suppressed", "success"]
        );
    }

    #[tokio::test]
    async fn external_extension_with_a_protected_tool_name_is_not_treated_as_codepro_git() {
        use super::super::tool_execution::ToolCallContext;

        let _test_guard = MOCK_GIT_COMMIT_TEST_LOCK.lock().await;
        MOCK_GIT_COMMIT_CALLS.store(0, Ordering::SeqCst);
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager
            .add_mock_extension("external_mcp".to_string(), Arc::new(MockClient {}))
            .await;
        let ctx = ToolCallContext::new(
            "external-session".to_string(),
            None,
            Some("external-request".to_string()),
        );

        for _ in 0..2 {
            let result = manager
                .dispatch_tool_call(
                    &ctx,
                    CallToolRequestParams::new("external_mcp__git_commit")
                        .with_arguments(object!({})),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            result.result.await.unwrap();
        }

        assert_eq!(MOCK_GIT_COMMIT_CALLS.load(Ordering::SeqCst), 2);
        assert!(!temp_dir
            .path()
            .join("audit")
            .join("tool-idempotency-v1")
            .exists());
    }

    #[tokio::test]
    async fn codepro_permission_metadata_recovers_only_registered_platform_tools() {
        let directory = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(directory.path().to_path_buf());
        assert_eq!(
            manager
                .registered_codepro_tool_security_profile("computer_focus")
                .await,
            None
        );
        manager
            .add_mock_platform_extension("computer".to_string(), Arc::new(MockClient {}))
            .await;
        let expected = ToolSecurityProfile {
            source: ToolExtensionSource::Platform,
            permission_class: Some(CodeProPermissionClass::HighRisk),
        };
        assert_eq!(
            manager
                .registered_codepro_tool_security_profile("computer_focus")
                .await,
            Some(expected)
        );
        assert_eq!(
            manager
                .registered_codepro_tool_security_profile("computer_not_registered")
                .await,
            None
        );
        let profiles = manager
            .tool_security_profiles(&[Tool::new("computer_focus", "", object!({}))])
            .await;
        assert_eq!(profiles["computer_focus"], expected);
    }

    #[tokio::test]
    async fn standalone_mcp_method_preserves_mouse_restrictions_and_rejects_spoofing() {
        use super::super::tool_task::ComputerOperationMethod;
        let directory = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(directory.path().to_path_buf());
        let client = Arc::new(AuditTestClient {
            method_tools: vec![
                "list_apps",
                "get_app_state",
                "click",
                "drag",
                "scroll",
                "type_text",
                "press_key",
                "set_value",
                "perform_secondary_action",
                "unknown",
            ],
            ..Default::default()
        });
        manager
            .add_mock_extension("qwen_computer".into(), client.clone())
            .await;
        let tools = manager.get_prefixed_tools("mcp", None).await.unwrap();
        let observation = tools
            .iter()
            .find(|tool| tool.name == "qwen_computer__get_app_state")
            .unwrap();
        assert!(observation.input_schema["properties"]
            .get("vision_assistance")
            .is_some());
        let profiles = manager.tool_security_profiles(&tools).await;
        for (tool, class) in [
            ("qwen_computer__list_apps", CodeProPermissionClass::ReadOnly),
            (
                "qwen_computer__get_app_state",
                CodeProPermissionClass::ReadOnly,
            ),
            ("qwen_computer__click", CodeProPermissionClass::HighRisk),
            ("qwen_computer__unknown", CodeProPermissionClass::Forbidden),
        ] {
            assert_eq!(profiles[tool].source, ToolExtensionSource::Builtin);
            assert_eq!(profiles[tool].permission_class, Some(class), "{tool}");
        }
        for tool in ["list_apps", "get_app_state", "click", "drag", "scroll"] {
            assert!(
                manager
                    .computer_method_allows_tool(
                        "mcp",
                        &format!("qwen_computer__{tool}"),
                        ComputerOperationMethod::MouseOnly
                    )
                    .await,
                "{tool}"
            );
        }
        for tool in [
            "type_text",
            "press_key",
            "set_value",
            "perform_secondary_action",
        ] {
            let name = format!("qwen_computer__{tool}");
            assert!(
                !manager
                    .computer_method_allows_tool("mcp", &name, ComputerOperationMethod::MouseOnly)
                    .await
            );
            assert!(
                manager
                    .computer_method_allows_tool(
                        "mcp",
                        &name,
                        ComputerOperationMethod::DesktopControl
                    )
                    .await
            );
        }
        assert!(
            !manager
                .computer_method_allows_tool(
                    "mcp",
                    "qwen_computer__unknown",
                    ComputerOperationMethod::DesktopControl
                )
                .await
        );
        // A user-configured stdio process with the same name is not the bundled executable.
        manager
            .add_mock_stdio_extension("qwen_computer".into(), client.clone())
            .await;
        let external_tools = manager.get_prefixed_tools("mcp", None).await.unwrap();
        let external_observation = external_tools
            .iter()
            .find(|tool| tool.name == "qwen_computer__get_app_state")
            .unwrap();
        assert!(external_observation
            .input_schema
            .get("properties")
            .and_then(|p| p.get("vision_assistance"))
            .is_none());
        let mut ctx = ToolCallContext::new(
            "mcp".into(),
            Some(directory.path().to_path_buf()),
            Some("spoof".into()),
        )
        .with_explicit_user_confirmation(true);
        ctx.computer_operation_method = ComputerOperationMethod::DesktopControl;
        assert!(manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("qwen_computer__click").with_arguments(object!({})),
                CancellationToken::new()
            )
            .await
            .is_err());
        assert_eq!(client.calls(), 0);
    }

    #[tokio::test]
    async fn computer_method_blocks_direct_and_nested_writes_even_when_confirmed() {
        use super::super::tool_task::ComputerOperationMethod;
        let directory = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(directory.path().to_path_buf());
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_extension("developer".into(), client.clone())
            .await;
        let mut ctx = ToolCallContext::new(
            "method-session".into(),
            Some(directory.path().to_path_buf()),
            Some("direct".into()),
        )
        .with_explicit_user_confirmation(true);
        ctx.computer_operation_method = ComputerOperationMethod::MouseOnly;
        for context in [ctx.clone(), ctx.for_nested_tool_call()] {
            for name in ["write", "edit", "shell"] {
                let result = manager
                    .dispatch_tool_call(
                        &context,
                        CallToolRequestParams::new(name).with_arguments(object!({})),
                        CancellationToken::new(),
                    )
                    .await;
                assert!(
                    result.is_err(),
                    "{name} must be rejected before the client is called"
                );
            }
        }
        assert_eq!(client.calls(), 0);
        assert!(!audit_records(directory.path()).is_empty());
        ctx.computer_operation_method = ComputerOperationMethod::Unrestricted;
        let released = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("write").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!released.result.await.unwrap().is_error.unwrap_or(false));
        assert_eq!(client.calls(), 1);
    }

    #[tokio::test]
    async fn computer_method_distinguishes_mcp_mouse_keyboard_reads_and_spoofed_tools() {
        use super::super::tool_task::ComputerOperationMethod;
        let directory = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(directory.path().to_path_buf());
        let client = Arc::new(AuditTestClient {
            method_tools: vec![
                "click",
                "press_key",
                "type_text",
                "get_app_state",
                "perform_secondary_action",
                "set_value",
                "drag",
                "list_apps",
                "scroll",
            ],
            ..Default::default()
        });
        manager
            .add_mock_extension("qwen_computer".into(), client.clone())
            .await;
        for name in ["click", "get_app_state", "list_apps", "scroll", "drag"] {
            assert!(
                manager
                    .computer_method_allows_tool(
                        "method",
                        &format!("qwen_computer__{name}"),
                        ComputerOperationMethod::MouseOnly
                    )
                    .await,
                "{name}"
            );
        }
        for name in [
            "press_key",
            "type_text",
            "perform_secondary_action",
            "set_value",
        ] {
            assert!(
                !manager
                    .computer_method_allows_tool(
                        "method",
                        &format!("qwen_computer__{name}"),
                        ComputerOperationMethod::MouseOnly
                    )
                    .await,
                "{name}"
            );
            assert!(
                manager
                    .computer_method_allows_tool(
                        "method",
                        &format!("qwen_computer__{name}"),
                        ComputerOperationMethod::DesktopControl
                    )
                    .await,
                "{name}"
            );
        }
        let mut ctx = ToolCallContext::new(
            "method".into(),
            Some(directory.path().to_path_buf()),
            Some("mouse-call".into()),
        );
        ctx.computer_operation_method = ComputerOperationMethod::MouseOnly;
        let allowed = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("qwen_computer__click").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!allowed.result.await.unwrap().is_error.unwrap_or(false));
        assert_eq!(client.calls(), 1);
        assert!(manager
            .dispatch_tool_call(
                &ctx.for_nested_tool_call(),
                CallToolRequestParams::new("qwen_computer__press_key").with_arguments(object!({})),
                CancellationToken::new()
            )
            .await
            .is_err());
        assert_eq!(client.calls(), 1);
        manager
            .add_mock_stdio_extension("computer".into(), client.clone())
            .await;
        let spoof_tools = manager.get_prefixed_tools("method", None).await.unwrap();
        let spoof = spoof_tools
            .iter()
            .find(|tool| tool.name == "computer__click")
            .unwrap();
        manager.resolve_tool("method", &spoof.name).await.unwrap();
        assert!(
            !manager
                .computer_method_allows_tool(
                    "method",
                    &spoof.name,
                    ComputerOperationMethod::MouseOnly
                )
                .await
        );
        let code = Arc::new(AuditTestClient {
            method_tools: vec!["execute_typescript", "execute_bash", "list_functions"],
            ..Default::default()
        });
        manager
            .add_mock_platform_extension("code_execution".into(), code.clone())
            .await;
        let tools = manager.get_prefixed_tools("method", None).await.unwrap();
        let wrappers: Vec<_> = tools
            .iter()
            .filter(|tool| {
                tool.name.contains("execute_typescript") || tool.name.contains("execute_bash")
            })
            .collect();
        assert_eq!(wrappers.len(), 2);
        for tool in wrappers {
            assert!(
                !manager
                    .computer_method_allows_tool(
                        "method",
                        &tool.name,
                        ComputerOperationMethod::MouseOnly
                    )
                    .await
            );
            assert!(manager
                .dispatch_tool_call(
                    &ctx.for_nested_tool_call(),
                    CallToolRequestParams::new(tool.name.clone()).with_arguments(object!({})),
                    CancellationToken::new()
                )
                .await
                .is_err());
        }
        assert_eq!(code.calls(), 0);
        let delegate = Arc::new(AuditTestClient {
            method_tools: vec!["delegate"],
            ..Default::default()
        });
        manager
            .add_mock_platform_extension("summon".into(), delegate.clone())
            .await;
        let tools = manager.get_prefixed_tools("method", None).await.unwrap();
        let tool = tools
            .iter()
            .find(|tool| tool.name.ends_with("delegate"))
            .unwrap();
        assert!(manager
            .dispatch_tool_call(
                &ctx.for_nested_tool_call(),
                CallToolRequestParams::new(tool.name.clone()).with_arguments(object!({})),
                CancellationToken::new()
            )
            .await
            .is_err());
        assert_eq!(delegate.calls(), 0);
        let reader = Arc::new(AuditTestClient {
            method_tools: vec!["read_document"],
            ..Default::default()
        });
        manager
            .add_mock_extension("developer".into(), reader.clone())
            .await;
        let read = manager
            .dispatch_tool_call(
                &ctx.for_nested_tool_call(),
                CallToolRequestParams::new("read_document").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!read.result.await.unwrap().is_error.unwrap_or(false));
        assert_eq!(reader.calls(), 1);
    }

    #[tokio::test]
    async fn codepro_permission_metadata_does_not_trust_external_extension_names() {
        let directory = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(directory.path().to_path_buf());
        manager
            .add_mock_stdio_extension("computer".to_string(), Arc::new(MockClient {}))
            .await;
        assert_eq!(
            manager
                .registered_codepro_tool_security_profile("computer_focus")
                .await,
            None
        );
        let profiles = manager
            .tool_security_profiles(&[Tool::new("computer_focus", "", object!({}))])
            .await;
        assert_eq!(
            profiles["computer_focus"].source,
            ToolExtensionSource::Unknown
        );
        assert_eq!(profiles["computer_focus"].permission_class, None);
    }

    #[tokio::test]
    async fn external_mcp_tool_security_profile_uses_host_stdio_config() {
        use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
        use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};

        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager
            .add_mock_stdio_extension("external_mcp".to_string(), Arc::new(MockClient {}))
            .await;

        let tools = manager
            .get_prefixed_tools("test-session-id", None)
            .await
            .unwrap();
        let profiles = manager.tool_security_profiles(&tools).await;

        assert_eq!(
            profiles["external_mcp__git_status"],
            ToolSecurityProfile {
                source: ToolExtensionSource::ExternalStdio,
                permission_class: Some(CodeProPermissionClass::ExternalWrite),
            }
        );
    }

    #[tokio::test]
    async fn external_stdio_dispatch_uses_shared_cancellation_and_audit_chain() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager.tool_execution_limits =
            ToolExecutionLimits::for_test(1, Duration::from_secs(1), Duration::from_millis(20));
        let client = Arc::new(AuditTestClient::default());
        manager
            .add_mock_stdio_extension("external_mcp".to_string(), client.clone())
            .await;
        let ctx = ToolCallContext::new(
            "external-audit-session".to_string(),
            None,
            Some("external-audit-request".to_string()),
        )
        .with_audit_authorization(ToolAuditAuthorization::UserConfirmed);
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("external_mcp__wait").with_arguments(object!({})),
                cancellation,
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap_err();
        let receipt = &error.data.as_ref().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"];

        assert_eq!(client.calls(), 0, "pre-cancelled call must not reach MCP");
        assert_eq!(receipt["extensionSource"], "external_stdio");
        assert_eq!(receipt["permissionClass"], "external_write");
        assert_eq!(receipt["authorization"], "user_confirmed");
        assert_eq!(receipt["outcome"], "cancelled");
        let records = audit_records(temp_dir.path());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["tool_name"], "external_mcp::wait");
        assert_eq!(records[0]["extension_source"], "external_stdio");
        assert_eq!(records[0]["permission_class"], "external_write");
        assert_eq!(records[0]["outcome"], "cancelled");
    }

    #[test]
    fn code_execution_tools_have_fixed_host_security_profiles() {
        use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
        use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};

        let config = ExtensionConfig::Platform {
            name: "code_execution".to_string(),
            display_name: Some("Code Mode".to_string()),
            description: "code execution".to_string(),
            bundled: None,
            available_tools: vec![],
        };

        for tool_name in ["list_functions", "get_function_details"] {
            assert_eq!(
                tool_security_profile(&config, tool_name),
                ToolSecurityProfile {
                    source: ToolExtensionSource::Platform,
                    permission_class: Some(CodeProPermissionClass::ReadOnly),
                }
            );
        }
        for tool_name in ["execute_bash", "execute_typescript"] {
            assert_eq!(
                tool_security_profile(&config, tool_name),
                ToolSecurityProfile {
                    source: ToolExtensionSource::Platform,
                    permission_class: Some(CodeProPermissionClass::HighRisk),
                }
            );
        }
        assert_eq!(
            tool_security_profile(&config, "model_invented_tool"),
            ToolSecurityProfile {
                source: ToolExtensionSource::Platform,
                permission_class: Some(CodeProPermissionClass::Forbidden),
            }
        );
    }

    #[test]
    fn builtin_developer_workspace_tools_have_fixed_host_security_profiles() {
        use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
        use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};

        let config = ExtensionConfig::Builtin {
            name: "developer".to_string(),
            display_name: Some("Developer".to_string()),
            description: "built-in workspace tools".to_string(),
            timeout: None,
            bundled: Some(true),
            available_tools: vec![],
        };

        for tool_name in ["tree", "search", "read_document"] {
            assert_eq!(
                tool_security_profile(&config, tool_name),
                ToolSecurityProfile {
                    source: ToolExtensionSource::Builtin,
                    permission_class: Some(CodeProPermissionClass::ReadOnly),
                }
            );
        }
        for tool_name in ["write", "edit"] {
            assert_eq!(
                tool_security_profile(&config, tool_name),
                ToolSecurityProfile {
                    source: ToolExtensionSource::Builtin,
                    permission_class: Some(CodeProPermissionClass::WorkspaceWrite),
                }
            );
        }
        assert_eq!(
            tool_security_profile(&config, "unknown_tool"),
            ToolSecurityProfile {
                source: ToolExtensionSource::Builtin,
                permission_class: None,
            },
            "unknown built-in tools must remain unclassified instead of inheriting trust"
        );
    }

    #[test]
    fn sixth_repair_batch_platform_developer_uses_the_same_host_security_profile() {
        use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
        use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};

        let config = ExtensionConfig::Platform {
            name: "developer".to_string(),
            display_name: Some("Developer".to_string()),
            description: "platform workspace tools".to_string(),
            bundled: Some(true),
            available_tools: vec![],
        };

        for tool_name in ["tree", "search", "read_document"] {
            assert_eq!(
                tool_security_profile(&config, tool_name),
                ToolSecurityProfile {
                    source: ToolExtensionSource::Platform,
                    permission_class: Some(CodeProPermissionClass::ReadOnly),
                }
            );
        }
        for tool_name in ["write", "edit"] {
            assert_eq!(
                tool_security_profile(&config, tool_name),
                ToolSecurityProfile {
                    source: ToolExtensionSource::Platform,
                    permission_class: Some(CodeProPermissionClass::WorkspaceWrite),
                }
            );
        }
        assert_eq!(
            tool_security_profile(&config, "ask_user"),
            ToolSecurityProfile {
                source: ToolExtensionSource::Platform,
                permission_class: Some(CodeProPermissionClass::ReadOnly),
            },
            "business clarification does not mutate the workspace or grant tool permission"
        );
    }

    #[tokio::test]
    async fn readonly_delegate_can_ask_using_registered_capabilities_without_write_access() {
        use crate::agents::platform_extensions::developer::DeveloperClient;
        use crate::config::permission::{CodeProTaskScope, PermissionLevel};
        use crate::config::{GooseMode, PermissionManager};
        use crate::permission::PermissionInspector;
        use crate::tool_inspection::{InspectionAction, ToolInspector};

        let storage = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let sessions = Arc::new(crate::session::SessionManager::new(
            storage.path().to_path_buf(),
        ));
        let child = sessions
            .create_session(
                workspace.path().to_path_buf(),
                "Read-only clarification".into(),
                crate::session::SessionType::SubAgent,
                GooseMode::Auto,
            )
            .await
            .unwrap();
        let scope = CodeProTaskScope::new_bound(
            "readonly-question",
            "review",
            workspace.path(),
            vec!["**".into()],
            Vec::new(),
        )
        .unwrap();
        let permissions = Arc::new(PermissionManager::new(storage.path().join("permissions")));
        let inspector = PermissionInspector::new_with_scope(
            permissions.clone(),
            Arc::new(tokio::sync::Mutex::new(None)),
            sessions,
            Some(scope),
        );
        let config = ExtensionConfig::Platform {
            name: "developer".into(),
            display_name: None,
            description: String::new(),
            bundled: Some(true),
            available_tools: Vec::new(),
        };
        let tools = DeveloperClient::get_tools();
        inspector.apply_tool_annotations(&tools);
        inspector.apply_tool_security_profiles(
            &tools
                .iter()
                .map(|tool| {
                    (
                        tool.name.to_string(),
                        tool_security_profile(&config, &tool.name),
                    )
                })
                .collect(),
        );

        for (name, expected) in [
            ("ask_user", InspectionAction::Allow),
            ("read_document", InspectionAction::Allow),
            ("write", InspectionAction::Deny),
            ("shell", InspectionAction::Deny),
        ] {
            permissions.update_user_permission(name, PermissionLevel::AlwaysAllow);
            let request = crate::conversation::message::ToolRequest {
                id: name.into(),
                tool_call: Ok(CallToolRequestParams::new(name).with_arguments(object!({}))),
                metadata: None,
                tool_meta: None,
            };
            let result = inspector
                .inspect(&child.id, &[request], &[], GooseMode::Auto, None)
                .await
                .unwrap();
            assert_eq!(
                result[0].action, expected,
                "registered capability for {name}"
            );
        }
        permissions.update_user_permission("ask_user", PermissionLevel::NeverAllow);
        let request = crate::conversation::message::ToolRequest {
            id: "explicit-deny".into(),
            tool_call: Ok(CallToolRequestParams::new("ask_user")),
            metadata: None,
            tool_meta: None,
        };
        assert_eq!(
            inspector
                .inspect(&child.id, &[request], &[], GooseMode::Auto, None)
                .await
                .unwrap()[0]
                .action,
            InspectionAction::Deny
        );
    }

    #[tokio::test]
    async fn external_http_tool_security_profile_is_always_external_write() {
        use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
        use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};

        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager
            .add_mock_http_extension("external_http".to_string(), Arc::new(MockClient {}))
            .await;
        let tools = manager
            .get_prefixed_tools("toolshim-session", None)
            .await
            .unwrap();
        let profiles = manager.tool_security_profiles(&tools).await;
        assert_eq!(
            profiles["external_http__git_status"],
            ToolSecurityProfile {
                source: ToolExtensionSource::ExternalHttp,
                permission_class: Some(CodeProPermissionClass::ExternalWrite),
            }
        );
    }

    #[test]
    fn external_stdio_only_trusts_tools_declared_read_only_by_the_same_extension() {
        use crate::agents::platform_extensions::tool_registry::CodeProPermissionClass;
        use crate::agents::tool_security::{ToolExtensionSource, ToolSecurityProfile};

        let config = ExtensionConfig::Stdio {
            name: "tavily".to_string(),
            description: "web search".to_string(),
            cmd: "npx".to_string(),
            args: vec![],
            envs: crate::agents::extension::Envs::default(),
            env_keys: vec![],
            timeout: None,
            cwd: None,
            bundled: Some(true),
            available_tools: vec!["tavily_search".to_string()],
            read_only_tools: vec!["tavily_search".to_string()],
        };

        for tool_name in ["tavily_search", "tavily__tavily_search"] {
            assert_eq!(
                tool_security_profile(&config, tool_name),
                ToolSecurityProfile {
                    source: ToolExtensionSource::ExternalStdio,
                    permission_class: Some(CodeProPermissionClass::ReadOnly),
                }
            );
        }
        for tool_name in ["tavily__unlisted", "other__tavily_search"] {
            assert_eq!(
                tool_security_profile(&config, tool_name).permission_class,
                Some(CodeProPermissionClass::ExternalWrite),
                "a declaration must not authorize another tool or extension"
            );
        }
    }

    #[tokio::test]
    async fn external_read_only_declaration_reaches_analysis_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(directory.path().to_path_buf());
        manager
            .add_mock_stdio_extension("declared".to_string(), Arc::new(MockClient {}))
            .await;
        manager
            .add_mock_stdio_extension("undeclared".to_string(), Arc::new(MockClient {}))
            .await;
        {
            let mut extensions = manager.extensions.lock().await;
            let ExtensionConfig::Stdio {
                read_only_tools, ..
            } = &mut extensions.get_mut("declared").unwrap().config
            else {
                panic!("expected stdio fixture");
            };
            *read_only_tools = vec!["tool".to_string()];
        }
        let tools = manager
            .get_prefixed_tools("analysis-catalog", None)
            .await
            .unwrap();
        for name in [
            "declared__tool",
            "declared__available_tool",
            "undeclared__tool",
        ] {
            let tool = tools.iter().find(|tool| tool.name == name).unwrap();
            assert_eq!(
                super::super::agent::is_codepro_read_only_tool(tool),
                name == "declared__tool",
                "only the host-declared tool should enter the analysis catalog: {name}"
            );
        }
        let profiles = manager.tool_security_profiles(&tools).await;
        assert_eq!(
            profiles["declared__tool"].permission_class,
            Some(CodeProPermissionClass::ReadOnly)
        );
        assert_eq!(
            profiles["undeclared__tool"].permission_class,
            Some(CodeProPermissionClass::ExternalWrite)
        );
    }

    #[tokio::test]
    async fn completed_non_idempotent_request_is_suppressed_after_manager_restart() {
        use super::super::tool_execution::ToolCallContext;

        let _test_guard = MOCK_GIT_COMMIT_TEST_LOCK.lock().await;
        MOCK_GIT_COMMIT_CALLS.store(0, Ordering::SeqCst);
        let temp_dir = tempfile::tempdir().unwrap();
        let ctx = ToolCallContext::new(
            "restart-session".to_string(),
            None,
            Some("restart-request".to_string()),
        );

        {
            let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
            manager
                .add_mock_platform_extension("git".to_string(), Arc::new(MockClient {}))
                .await;
            let result = manager
                .dispatch_tool_call(
                    &ctx,
                    CallToolRequestParams::new("git_commit").with_arguments(object!({})),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            result.result.await.unwrap();
        }

        let restarted = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        restarted
            .add_mock_platform_extension("git".to_string(), Arc::new(MockClient {}))
            .await;
        let replay = restarted
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("git_commit").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        replay.result.await.unwrap();

        assert_eq!(MOCK_GIT_COMMIT_CALLS.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn registered_idempotent_tool_keeps_normal_behavior_without_a_journal() {
        use super::super::tool_execution::ToolCallContext;

        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager
            .add_mock_platform_extension("git".to_string(), Arc::new(MockClient {}))
            .await;
        let ctx = ToolCallContext::new(
            "idempotent-session".to_string(),
            None,
            Some("idempotent-request".to_string()),
        );

        for _ in 0..2 {
            let result = manager
                .dispatch_tool_call(
                    &ctx,
                    CallToolRequestParams::new("git_status").with_arguments(object!({})),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            result.result.await.unwrap();
        }

        assert!(!temp_dir
            .path()
            .join("audit")
            .join("tool-idempotency-v1")
            .exists());
    }

    #[tokio::test]
    async fn explicit_user_confirmation_can_take_over_a_stale_task_scoped_operation() {
        use super::super::tool_execution::ToolCallContext;
        use crate::config::permission::CodeProTaskScope;

        let _test_guard = MOCK_GIT_COMMIT_TEST_LOCK.lock().await;
        MOCK_GIT_COMMIT_CALLS.store(0, Ordering::SeqCst);
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_platform_extension("git".to_string(), Arc::new(MockClient {}))
            .await;
        let task_scope = CodeProTaskScope::new("run-a", "task-a").unwrap();
        let BeginDecision::Execute(stale_claim) = extension_manager
            .tool_idempotency_store
            .begin(ToolIdempotencyInput {
                session_id: "idempotency-session".to_string(),
                task_scope: Some(task_scope.clone()),
                request_id: "stale-request".to_string(),
                tool_name: "git::git_commit".to_string(),
                arguments: object!({}),
                explicit_user_confirmation: false,
            })
            .await
            .unwrap()
        else {
            panic!("fixture must leave a started operation");
        };
        drop(stale_claim);
        let ctx = ToolCallContext::new(
            "idempotency-session".to_string(),
            None,
            Some("confirmed-request".to_string()),
        )
        .with_codepro_task_scope(task_scope)
        .with_explicit_user_confirmation(true);

        let result = extension_manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("git_commit").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        result.result.await.unwrap();

        assert_eq!(MOCK_GIT_COMMIT_CALLS.load(Ordering::SeqCst), 1);
        assert_eq!(audit_outcomes(temp_dir.path()), ["success"]);
    }

    #[tokio::test]
    async fn idempotency_completion_failure_is_audited_as_ambiguous() {
        let _test_guard = MOCK_GIT_COMMIT_TEST_LOCK.lock().await;
        MOCK_GIT_COMMIT_CALLS.store(0, Ordering::SeqCst);
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager
            .add_mock_platform_extension("git".to_string(), Arc::new(MockClient {}))
            .await;
        let ctx = ToolCallContext::new(
            "completion-failure-session".to_string(),
            None,
            Some("completion-failure-request".to_string()),
        );
        let dispatched = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("git_commit").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        manager.tool_idempotency_store.fail_next_complete_for_test();

        let error = dispatched.result.await.unwrap_err();
        assert_eq!(
            error.message,
            "Protected tool call 'git_commit' finished but its durable outcome could not be recorded."
        );
        assert_eq!(
            error.data.as_ref().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]["outcome"],
            "ambiguous"
        );
        assert_eq!(MOCK_GIT_COMMIT_CALLS.load(Ordering::SeqCst), 1);
        assert_eq!(audit_outcomes(temp_dir.path()), ["ambiguous"]);
    }

    #[tokio::test]
    async fn unconfirmed_stale_protected_call_is_audited_as_ambiguous_without_calling_client() {
        let _test_guard = MOCK_GIT_COMMIT_TEST_LOCK.lock().await;
        MOCK_GIT_COMMIT_CALLS.store(0, Ordering::SeqCst);
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        manager
            .add_mock_platform_extension("git".to_string(), Arc::new(MockClient {}))
            .await;
        let BeginDecision::Execute(stale_claim) = manager
            .tool_idempotency_store
            .begin(ToolIdempotencyInput {
                session_id: "ambiguous-session".to_string(),
                task_scope: None,
                request_id: "stale-request".to_string(),
                tool_name: "git::git_commit".to_string(),
                arguments: object!({}),
                explicit_user_confirmation: false,
            })
            .await
            .unwrap()
        else {
            panic!("fixture must leave an unresolved protected operation");
        };
        drop(stale_claim);

        let ctx = ToolCallContext::new(
            "ambiguous-session".to_string(),
            None,
            Some("automatic-retry".to_string()),
        );
        let error = manager
            .dispatch_tool_call(
                &ctx,
                CallToolRequestParams::new("git_commit").with_arguments(object!({})),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .result
            .await
            .unwrap_err();

        assert!(error
            .message
            .contains("requires explicit user confirmation"));
        assert_eq!(
            error.data.as_ref().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["toolAudit"]["outcome"],
            "ambiguous"
        );
        assert_eq!(MOCK_GIT_COMMIT_CALLS.load(Ordering::SeqCst), 0);
        assert_eq!(audit_outcomes(temp_dir.path()), ["ambiguous"]);
    }

    #[tokio::test]
    async fn dispatch_rejects_model_arguments_that_do_not_match_the_tool_schema() {
        use super::super::tool_execution::ToolCallContext;

        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_extension("test_client".to_string(), Arc::new(MockClient {}))
            .await;
        let ctx = ToolCallContext::new("schema-session".to_string(), None, None);

        for arguments in [
            object!({}),
            object!({ "count": "sensitive-value-must-not-be-echoed" }),
            object!({ "count": 1, "unexpected": true }),
        ] {
            let call = CallToolRequestParams::new("test_client__schema_tool".to_string())
                .with_arguments(arguments);
            let error = match extension_manager
                .dispatch_tool_call(&ctx, call, CancellationToken::new())
                .await
            {
                Err(error) => error,
                Ok(_) => panic!("invalid model arguments must be rejected before dispatch"),
            };
            let error = error.downcast_ref::<ErrorData>().unwrap();
            assert_eq!(error.code, ErrorCode::INVALID_PARAMS);
            assert!(error.message.contains("schema_tool"));
            assert!(!error.message.contains("sensitive-value-must-not-be-echoed"));
        }

        let missing_arguments = CallToolRequestParams::new("test_client__schema_tool".to_string());
        let error = match extension_manager
            .dispatch_tool_call(&ctx, missing_arguments, CancellationToken::new())
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("missing arguments must be validated as an empty object"),
        };
        assert_eq!(
            error.downcast_ref::<ErrorData>().unwrap().code,
            ErrorCode::INVALID_PARAMS
        );

        let valid = CallToolRequestParams::new("test_client__schema_tool".to_string())
            .with_arguments(object!({ "count": 1 }));
        assert!(extension_manager
            .dispatch_tool_call(&ctx, valid, CancellationToken::new())
            .await
            .is_ok());
    }

    #[test]
    fn schema_errors_identify_missing_fields_and_types_without_echoing_argument_values() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"}},
                "question": {"type": "string"}
            },
            "required": ["paths", "question"]
        });
        let missing = validate_tool_arguments(
            "summarize__summarize",
            &schema,
            Some(&object!({"path": "private-argument-canary"})),
        )
        .unwrap_err();
        assert!(missing
            .message
            .contains("missing required property \"paths\""));
        assert!(missing
            .message
            .contains("missing required property \"question\""));
        assert!(!missing.message.contains("private-argument-canary"));

        let invalid_type = validate_tool_arguments(
            "summarize__summarize",
            &schema,
            Some(&object!({"paths": "private-argument-canary", "question": "summarize"})),
        )
        .unwrap_err();
        assert!(invalid_type.message.contains("/paths: expected type"));
        assert!(invalid_type.message.to_lowercase().contains("array"));
        assert!(!invalid_type.message.contains("private-argument-canary"));
        assert!(validate_tool_arguments(
            "summarize__summarize",
            &schema,
            Some(&object!({"paths": ["src/range.ts"], "question": "summarize"})),
        )
        .is_ok());
    }

    #[test]
    fn unsupported_screenshot_fields_are_identified_without_echoing_values() {
        let schema = serde_json::json!({"type": "object", "additionalProperties": false,
            "properties": {"handle": {"type": "integer"}, "include_image": {"type": "boolean"}}});
        let bad = object!({"handle": 264934, "include_image": true,
            "center": "private-argument-canary", "target_region": {"x": 1, "y": 2}});
        let error =
            validate_tool_arguments("computer_screenshot", &schema, Some(&bad)).unwrap_err();
        assert!(error.message.contains("unsupported properties"));
        assert!(error.message.contains("center"));
        assert!(error.message.contains("target_region"));
        assert!(!error.message.contains("private-argument-canary"));
        let valid = object!({"handle": 264934, "include_image": true});
        assert!(validate_tool_arguments("computer_screenshot", &schema, Some(&valid)).is_ok());
    }

    #[tokio::test]
    async fn schema_validation_fails_closed_for_invalid_schemas_and_unadvertised_tools() {
        use super::super::tool_execution::ToolCallContext;

        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_extension("test_client".to_string(), Arc::new(MockClient {}))
            .await;
        let ctx = ToolCallContext::new("schema-session".to_string(), None, None);

        let error = validate_tool_arguments(
            "invalid_schema_tool",
            &serde_json::json!({ "type": 42 }),
            None,
        )
        .expect_err("invalid server schemas must fail closed");
        assert_eq!(error.code, ErrorCode::INTERNAL_ERROR);

        let unadvertised = CallToolRequestParams::new("test_client__not_advertised".to_string())
            .with_arguments(object!({}));
        let error = match extension_manager
            .dispatch_tool_call(&ctx, unadvertised, CancellationToken::new())
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("unadvertised tools must not bypass schema resolution"),
        };
        assert_eq!(
            error.downcast_ref::<ErrorData>().unwrap().code,
            ErrorCode::RESOURCE_NOT_FOUND
        );
    }

    #[tokio::test]
    async fn test_tool_availability_filtering() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        // Only "available_tool" should be available to the LLM
        let available_tools = vec!["available_tool".to_string()];

        extension_manager
            .add_mock_extension_with_tools(
                "test_extension".to_string(),
                Arc::new(MockClient {}),
                available_tools,
            )
            .await;

        let tools = extension_manager
            .get_prefixed_tools("test-session-id", None)
            .await
            .unwrap();

        let tool_names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
        assert!(!tool_names.iter().any(|name| name == "test_extension__tool")); // Default unavailable
        assert!(tool_names
            .iter()
            .any(|name| name == "test_extension__available_tool"));
        assert!(!tool_names
            .iter()
            .any(|name| name == "test_extension__hidden_tool"));
        assert!(tool_names.len() == 1);
    }

    #[tokio::test]
    async fn test_tool_availability_defaults_to_available() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        extension_manager
            .add_mock_extension_with_tools(
                "test_extension".to_string(),
                Arc::new(MockClient {}),
                vec![], // Empty available_tools means all tools are available by default
            )
            .await;

        let tools = extension_manager
            .get_prefixed_tools("test-session-id", None)
            .await
            .unwrap();

        let tool_names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
        assert!(tool_names.iter().any(|name| name == "test_extension__tool"));
        assert!(tool_names
            .iter()
            .any(|name| name == "test_extension__available_tool"));
        assert!(tool_names
            .iter()
            .any(|name| name == "test_extension__hidden_tool"));
        assert!(tool_names
            .iter()
            .any(|name| name == "test_extension__render_chart"));
        assert!(tool_names.len() == 7);
    }

    #[tokio::test]
    async fn test_dispatch_unavailable_tool_returns_error() {
        use super::super::tool_execution::ToolCallContext;

        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        let available_tools = vec!["available_tool".to_string()];

        extension_manager
            .add_mock_extension_with_tools(
                "test_extension".to_string(),
                Arc::new(MockClient {}),
                available_tools,
            )
            .await;

        let ctx = ToolCallContext::new(
            "test-session-id".to_string(),
            None,
            Some("test-req-id".to_string()),
        );

        let unavailable_tool_call = CallToolRequestParams::new("test_extension__tool".to_string())
            .with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, unavailable_tool_call, CancellationToken::default())
            .await;

        if let Err(err) = result {
            let tool_err = err.downcast_ref::<ErrorData>().expect("Expected ErrorData");
            assert_eq!(tool_err.code, ErrorCode::RESOURCE_NOT_FOUND);
        } else {
            panic!("Expected ErrorData with ErrorCode::RESOURCE_NOT_FOUND");
        }

        // Try to call an available tool - should succeed
        let available_tool_call =
            CallToolRequestParams::new("test_extension__available_tool".to_string())
                .with_arguments(object!({}));

        let result = extension_manager
            .dispatch_tool_call(&ctx, available_tool_call, CancellationToken::default())
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_streamable_http_header_env_substitution() {
        let mut env_map = HashMap::new();
        env_map.insert("AUTH_TOKEN".to_string(), "secret123".to_string());
        env_map.insert("API_KEY".to_string(), "key456".to_string());

        // Test ${VAR} syntax
        let result = substitute_env_vars("Bearer ${ AUTH_TOKEN }", &env_map);
        assert_eq!(result, "Bearer secret123");

        // Test ${VAR} syntax without spaces
        let result = substitute_env_vars("Bearer ${AUTH_TOKEN}", &env_map);
        assert_eq!(result, "Bearer secret123");

        // Test $VAR syntax
        let result = substitute_env_vars("Bearer $AUTH_TOKEN", &env_map);
        assert_eq!(result, "Bearer secret123");

        // Test multiple substitutions
        let result = substitute_env_vars("Key: $API_KEY, Token: ${AUTH_TOKEN}", &env_map);
        assert_eq!(result, "Key: key456, Token: secret123");

        // Test no substitution when variable doesn't exist
        let result = substitute_env_vars("Bearer ${UNKNOWN_VAR}", &env_map);
        assert_eq!(result, "Bearer ${UNKNOWN_VAR}");

        // Test mixed content
        let result = substitute_env_vars(
            "Authorization: Bearer ${AUTH_TOKEN} and API ${API_KEY}",
            &env_map,
        );
        assert_eq!(result, "Authorization: Bearer secret123 and API key456");
    }

    #[tokio::test]
    async fn test_substitute_env_vars_no_recursive_expansion() {
        let mut env_map = HashMap::new();
        env_map.insert("TOKEN".to_string(), "abc$KEY".to_string());
        env_map.insert("KEY".to_string(), "xyz".to_string());

        // A substituted value containing $KEY should NOT be re-expanded
        let result = substitute_env_vars("${TOKEN}", &env_map);
        assert_eq!(result, "abc$KEY");

        let result = substitute_env_vars("$TOKEN", &env_map);
        assert_eq!(result, "abc$KEY");
    }

    #[tokio::test]
    async fn discovery_includes_enabled_defaults_missing_from_existing_session() {
        let config = serde_json::json!({
            "hexstrike": {"enabled": true, "type": "streamable_http", "name": "HexStrike",
                "description": "External MCP fixture", "uri": "http://127.0.0.1:1/mcp"},
            "disabled": {"enabled": false, "type": "streamable_http", "name": "Disabled",
                "description": "Disabled fixture", "uri": "http://127.0.0.1:1/mcp"}
        })
        .to_string();
        let _guard = env_lock::lock_env([("EXTENSIONS", Some(config.as_str()))]);
        let temp = tempfile::tempdir().unwrap();
        let manager = ExtensionManager::new_without_provider(temp.path().to_path_buf());
        let before = manager
            .search_available_extensions("discovery-test")
            .await
            .unwrap();
        let before = &before[0].as_text().unwrap().text;
        assert!(before.contains("- HexStrike - External MCP fixture"));
        assert!(before.contains("- Disabled - Disabled fixture"));
        assert!(
            manager.extensions.lock().await.is_empty(),
            "discovery must not enable defaults"
        );

        manager
            .add_mock_extension("hexstrike".into(), Arc::new(MockClient {}))
            .await;
        let after = manager
            .search_available_extensions("discovery-test")
            .await
            .unwrap();
        let after = &after[0].as_text().unwrap().text;
        assert!(!after.contains("- HexStrike - External MCP fixture"));
        assert!(after.contains("- Disabled - Disabled fixture"));
        assert!(
            after.contains("hexstrike__tool"),
            "inventory must include unannotated tools"
        );
        let tools = manager
            .get_prefixed_tools("discovery-test", Some("hexstrike".into()))
            .await
            .unwrap();
        let unannotated = tools
            .iter()
            .find(|tool| tool.name == "hexstrike__tool")
            .unwrap();
        assert!(unannotated
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.read_only_hint)
            .is_none());
        assert!(
            !super::super::agent::is_codepro_read_only_tool(unannotated),
            "listing unannotated tool metadata must not grant read-only execution"
        );

        manager.remove_extension("hexstrike").await.unwrap();
        let removed = manager
            .search_available_extensions("discovery-test")
            .await
            .unwrap();
        let removed = &removed[0].as_text().unwrap().text;
        assert!(removed.contains("- HexStrike - External MCP fixture"));
        assert!(
            !removed.contains("hexstrike__tool"),
            "removed tools must not remain in inventory"
        );
    }

    #[cfg(feature = "code-mode")]
    #[tokio::test]
    async fn capability_activation_catalog_includes_direct_computer_inventory() {
        use crate::agents::platform_extensions::code_execution::CodeExecutionClient;
        let _guard = env_lock::lock_env([("EXTENSIONS", Some("{}"))]);
        let temp = tempfile::tempdir().unwrap();
        let manager = Arc::new(ExtensionManager::new_without_provider(
            temp.path().to_path_buf(),
        ));
        manager
            .add_mock_extension("qwen_computer".into(), Arc::new(MockClient {}))
            .await;
        let context = PlatformExtensionContext {
            extension_manager: Some(Arc::downgrade(&manager)),
            session_manager: Arc::new(crate::session::SessionManager::new(
                temp.path().join("sessions"),
            )),
            session: None,
            use_login_shell_path: false,
        };
        let client =
            CodeExecutionClient::new(context, pctx_code_mode::config::ToolDisclosure::Catalog)
                .unwrap();
        let ctx = ToolCallContext::new("capability-catalog".into(), None, None);
        let result = client
            .call_tool(&ctx, "list_functions", None, CancellationToken::new())
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true));
        let callbacks = &result.content[0].as_text().unwrap().text;
        assert!(
            !callbacks.contains("qwen_computer__tool"),
            "Computer tools must not become TypeScript callbacks"
        );
        assert!(
            result
                .content
                .iter()
                .filter_map(|content| content.as_text())
                .any(|part| part.text.lines().any(|line| line == "qwen_computer__tool")),
            "Loaded computer tools must remain visible in the separate inventory"
        );
        manager.remove_extension("qwen_computer").await.unwrap();
        let result = client
            .call_tool(&ctx, "list_functions", None, CancellationToken::new())
            .await
            .unwrap();
        assert!(
            !result
                .content
                .iter()
                .filter_map(|content| content.as_text())
                .any(|part| part.text.contains("qwen_computer__tool")),
            "Removed tools must not remain discoverable from a cached callback list"
        );
    }

    #[tokio::test]
    async fn test_tools_cache_invalidated_on_add_extension() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        extension_manager
            .add_mock_extension("ext_a".to_string(), Arc::new(MockClient {}))
            .await;

        let tools_after_first = extension_manager
            .get_prefixed_tools("test-session-id", None)
            .await
            .unwrap();
        let tool_names: Vec<String> = tools_after_first
            .iter()
            .map(|t| t.name.to_string())
            .collect();
        assert!(tool_names.iter().any(|n| n.starts_with("ext_a__")));
        assert!(!tool_names.iter().any(|n| n.starts_with("ext_b__")));

        extension_manager
            .add_mock_extension("ext_b".to_string(), Arc::new(MockClient {}))
            .await;

        let tools_after_second = extension_manager
            .get_prefixed_tools("test-session-id", None)
            .await
            .unwrap();
        let tool_names: Vec<String> = tools_after_second
            .iter()
            .map(|t| t.name.to_string())
            .collect();
        assert!(tool_names.iter().any(|n| n.starts_with("ext_a__")));
        assert!(tool_names.iter().any(|n| n.starts_with("ext_b__")));
    }

    #[tokio::test]
    async fn test_tools_cache_invalidated_on_remove_extension() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        extension_manager
            .add_mock_extension("ext_a".to_string(), Arc::new(MockClient {}))
            .await;
        extension_manager
            .add_mock_extension("ext_b".to_string(), Arc::new(MockClient {}))
            .await;

        let tools_before = extension_manager
            .get_prefixed_tools("test-session-id", None)
            .await
            .unwrap();
        let tool_names: Vec<String> = tools_before.iter().map(|t| t.name.to_string()).collect();
        assert!(tool_names.iter().any(|n| n.starts_with("ext_a__")));
        assert!(tool_names.iter().any(|n| n.starts_with("ext_b__")));

        extension_manager.remove_extension("ext_b").await.unwrap();

        let tools_after = extension_manager
            .get_prefixed_tools("test-session-id", None)
            .await
            .unwrap();
        let tool_names: Vec<String> = tools_after.iter().map(|t| t.name.to_string()).collect();
        assert!(tool_names.iter().any(|n| n.starts_with("ext_a__")));
        assert!(!tool_names.iter().any(|n| n.starts_with("ext_b__")));
    }

    #[tokio::test]
    async fn test_get_prefixed_tools_excluding() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        extension_manager
            .add_mock_extension("ext_a".to_string(), Arc::new(MockClient {}))
            .await;
        extension_manager
            .add_mock_extension("ext_b".to_string(), Arc::new(MockClient {}))
            .await;

        let tools = extension_manager
            .get_prefixed_tools_excluding("test-session-id", "ext_a")
            .await
            .unwrap();
        let tool_names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();

        assert!(!tool_names.iter().any(|n| n.starts_with("ext_a__")));
        assert!(tool_names.iter().any(|n| n.starts_with("ext_b__")));
    }

    #[tokio::test]
    async fn test_mcp_app_tools_identified_for_code_mode_exclusion() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        extension_manager
            .add_mock_extension("autovisualiser".to_string(), Arc::new(MockClient {}))
            .await;

        let tools = extension_manager
            .get_prefixed_tools_excluding("test-session-id", "code_execution")
            .await
            .unwrap();

        let (mcp_app_tools, regular_tools): (Vec<_>, Vec<_>) = tools
            .iter()
            .partition(|t| get_tool_resource_uri(t).is_some());

        assert_eq!(mcp_app_tools.len(), 1, "exactly one MCP app tool");
        assert_eq!(
            mcp_app_tools[0].name.as_ref(),
            "autovisualiser__render_chart"
        );
        assert!(
            regular_tools
                .iter()
                .all(|t| get_tool_resource_uri(t).is_none()),
            "non-MCP-app tools have no resourceUri"
        );
    }

    #[tokio::test]
    async fn test_get_prefixed_tools_by_extension_name() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        extension_manager
            .add_mock_extension("ext_a".to_string(), Arc::new(MockClient {}))
            .await;
        extension_manager
            .add_mock_extension("ext_b".to_string(), Arc::new(MockClient {}))
            .await;

        let tools = extension_manager
            .get_prefixed_tools("test-session-id", Some("ext_a".to_string()))
            .await
            .unwrap();
        let tool_names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();

        assert!(tool_names.iter().any(|n| n.starts_with("ext_a__")));
        assert!(!tool_names.iter().any(|n| n.starts_with("ext_b__")));
    }

    #[tokio::test]
    async fn test_resolve_tool_error_includes_available_tools() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());

        extension_manager
            .add_mock_extension("ext_a".to_string(), Arc::new(MockClient {}))
            .await;

        let result = extension_manager
            .resolve_tool("test-session-id", "definitely_not_a_real_tool")
            .await;
        let err = match result {
            Ok(_) => panic!("resolve_tool should fail for an unknown name"),
            Err(e) => e,
        };

        let msg = err.message.to_string();
        assert!(
            msg.contains("definitely_not_a_real_tool"),
            "error should echo the bad name; got: {msg}"
        );
        assert!(
            msg.contains("ext_a__"),
            "error should list at least one real tool name; got: {msg}"
        );
    }

    struct MockDottedClient {}

    #[async_trait::async_trait]
    impl McpClientTrait for MockDottedClient {
        fn get_info(&self) -> Option<&InitializeResult> {
            None
        }

        async fn list_resources(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListResourcesResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn read_resource(
            &self,
            _session_id: &str,
            _uri: &str,
            _cancellation_token: CancellationToken,
        ) -> Result<ReadResourceResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn list_tools(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListToolsResult, Error> {
            use serde_json::json;
            use std::sync::Arc;
            Ok(ListToolsResult {
                tools: vec![
                    Tool::new(
                        "db.query".to_string(),
                        "A tool with a dotted name".to_string(),
                        Arc::new(json!({}).as_object().unwrap().clone()),
                    ),
                    Tool::new(
                        "db__query".to_string(),
                        "A sibling with the separator name".to_string(),
                        Arc::new(json!({}).as_object().unwrap().clone()),
                    ),
                ],
                next_cursor: None,
                meta: None,
            })
        }

        async fn call_tool(
            &self,
            _ctx: &ToolCallContext,
            name: &str,
            _arguments: Option<JsonObject>,
            _cancellation_token: CancellationToken,
        ) -> Result<CallToolResult, Error> {
            match name {
                "db.query" | "db__query" => Ok(CallToolResult::success(vec![])),
                _ => Err(Error::TransportClosed),
            }
        }

        async fn list_prompts(
            &self,
            _session_id: &str,
            _next_cursor: Option<String>,
            _cancellation_token: CancellationToken,
        ) -> Result<ListPromptsResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn get_prompt(
            &self,
            _session_id: &str,
            _name: &str,
            _arguments: Value,
            _cancellation_token: CancellationToken,
        ) -> Result<GetPromptResult, Error> {
            Err(Error::TransportClosed)
        }

        async fn subscribe(&self) -> mpsc::Receiver<ServerNotification> {
            mpsc::channel(1).1
        }
    }

    #[tokio::test]
    async fn test_resolve_tool_recovers_dotted_mangled_name() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_extension("test_client".to_string(), Arc::new(MockClient {}))
            .await;

        let resolved = extension_manager
            .resolve_tool("test-session-id", "test_client.tool")
            .await
            .expect("mangled dotted name should resolve to the real tool");
        assert_eq!(resolved.tool_name, "test_client__tool");
    }

    #[tokio::test]
    async fn test_resolve_tool_recovers_functions_prefixed_name() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_extension("test_client".to_string(), Arc::new(MockClient {}))
            .await;

        let resolved = extension_manager
            .resolve_tool("test-session-id", "functions.test_client__tool")
            .await
            .expect("functions-prefixed name should resolve to the real tool");
        assert_eq!(resolved.tool_name, "test_client__tool");
    }

    #[tokio::test]
    async fn test_resolve_tool_exact_dotted_name_never_rewritten() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_extension("dotted".to_string(), Arc::new(MockDottedClient {}))
            .await;

        let resolved = extension_manager
            .resolve_tool("test-session-id", "dotted__db.query")
            .await
            .expect("exact dotted tool name must resolve");
        assert_eq!(resolved.tool_name, "dotted__db.query");
        assert_eq!(resolved.actual_tool_name, "db.query");
    }

    #[tokio::test]
    async fn test_resolve_tool_recovers_mangled_separator_with_dotted_tool_name() {
        let temp_dir = tempfile::tempdir().unwrap();
        let extension_manager =
            ExtensionManager::new_without_provider(temp_dir.path().to_path_buf());
        extension_manager
            .add_mock_extension("dotted".to_string(), Arc::new(MockDottedClient {}))
            .await;

        let resolved = extension_manager
            .resolve_tool("test-session-id", "dotted.db.query")
            .await
            .expect("mangled extension separator should resolve");
        assert_eq!(resolved.tool_name, "dotted__db.query");
        assert_eq!(resolved.actual_tool_name, "db.query");
    }

    #[test]
    fn test_recover_mangled_tool_name() {
        let tools = ["developer__shell", "platform__search"];
        assert_eq!(
            recover_mangled_tool_name("developer.shell", tools.iter().copied()).as_deref(),
            Some("developer__shell")
        );
        assert_eq!(
            recover_mangled_tool_name("functions.developer__shell", tools.iter().copied())
                .as_deref(),
            Some("developer__shell")
        );
        assert_eq!(
            recover_mangled_tool_name("functions.developer.shell", tools.iter().copied())
                .as_deref(),
            Some("developer__shell")
        );
        assert_eq!(
            recover_mangled_tool_name("developer shell", tools.iter().copied()),
            None
        );
        assert_eq!(
            recover_mangled_tool_name("developer__shell!", tools.iter().copied()),
            None
        );
        assert_eq!(
            recover_mangled_tool_name("nonexistent.tool", tools.iter().copied()),
            None
        );

        let dotted_tool = ["dotted__db.query"];
        assert_eq!(
            recover_mangled_tool_name("dotted.db.query", dotted_tool.iter().copied()).as_deref(),
            Some("dotted__db.query")
        );
    }

    #[test]
    fn git_mcp_delta_merges_repository_and_working_tree_versions() {
        let mut result = CallToolResult::success(vec![]);
        insert_trusted_workspace_delta_meta(&mut result, &[".git/HEAD".into()]);
        attach_workspace_versions(
            result
                .meta
                .as_mut()
                .and_then(|meta| meta.0.get_mut(TRUSTED_TOOL_UPDATE_META_KEY)),
            &super::super::tool_execution::WorkspaceDelta {
                resource_versions: Some(std::collections::BTreeMap::from([(
                    ".git/HEAD".into(),
                    "blake3:head".into(),
                )])),
                ..Default::default()
            },
        );
        insert_trusted_workspace_delta_meta(&mut result, &["remote.txt".into()]);
        attach_workspace_versions(
            result
                .meta
                .as_mut()
                .and_then(|meta| meta.0.get_mut(TRUSTED_TOOL_UPDATE_META_KEY)),
            &super::super::tool_execution::WorkspaceDelta {
                resource_versions: Some(std::collections::BTreeMap::from([(
                    "remote.txt".into(),
                    "blake3:file".into(),
                )])),
                ..Default::default()
            },
        );
        assert_eq!(
            trusted_workspace_delta_from_result(&result).unwrap().len(),
            2
        );
        assert_eq!(
            result.meta.as_ref().unwrap().0[TRUSTED_TOOL_UPDATE_META_KEY]["workspaceDelta"]
                ["resourceVersions"]
                .as_object()
                .unwrap()
                .len(),
            2
        );
        result
            .meta
            .as_mut()
            .unwrap()
            .0
            .get_mut(TRUSTED_TOOL_UPDATE_META_KEY)
            .unwrap()["gitExternalEffect"] =
            serde_json::json!({"resource":"spoofed", "version":"spoofed"});
        remove_untrusted_mcp_app_meta(&mut result);
        assert!(crate::agents::git_mcp::external_effect(&result).is_none());
    }

    #[test]
    fn test_remove_untrusted_mcp_app_meta_strips_spoofed_payload() {
        let mut result = CallToolResult::success(vec![]);
        result.meta = Some(Meta(
            serde_json::from_value(serde_json::json!({
                "goose": {
                    "mcpApp": {
                        "resourceUri": "ui://spoofed/app",
                    },
                    "toolAudit": {
                        "auditId": "spoofed-public",
                    },
                    "other": true,
                },
                "codepro_failure": "outside_workspace",
                TRUSTED_TOOL_UPDATE_META_KEY: {
                    "mcpApp": {
                        "resourceUri": "ui://spoofed/internal",
                    },
                },
            }))
            .unwrap(),
        ));

        remove_untrusted_mcp_app_meta(&mut result);

        let meta = result.meta.expect("expected remaining meta");
        assert_eq!(meta.0.get(TRUSTED_TOOL_UPDATE_META_KEY), None);
        assert_eq!(meta.0.get("codepro_failure"), None);
        assert_eq!(
            meta.0.get("goose"),
            Some(&serde_json::json!({ "other": true }))
        );
    }

    #[test]
    fn test_insert_trusted_tool_update_meta_stores_backend_payload() {
        let mut result = CallToolResult::success(vec![]);
        let attachment = GooseMcpAppToolAttachment {
            tool_name: "weather__render".to_string(),
            extension_name: "weather".to_string(),
            resource_uri: "ui://weather/app".to_string(),
            tool_meta: None,
            resource_result: Some(serde_json::json!({
                "contents": [
                    {
                        "uri": "ui://weather/app",
                        "mimeType": "text/html;profile=mcp-app",
                        "text": "<div>Hello</div>",
                    },
                ],
            })),
            read_error: None,
        };

        insert_trusted_tool_update_meta(&mut result, &attachment);

        let meta = result.meta.expect("expected trusted meta");
        assert_eq!(
            meta.0.get(TRUSTED_TOOL_UPDATE_META_KEY),
            Some(&serde_json::json!({
                "mcpApp": {
                    "toolName": "weather__render",
                    "extensionName": "weather",
                    "resourceUri": "ui://weather/app",
                    "resourceResult": {
                        "contents": [
                            {
                                "uri": "ui://weather/app",
                                "mimeType": "text/html;profile=mcp-app",
                                "text": "<div>Hello</div>",
                            },
                        ],
                    },
                },
            })),
        );
    }

    #[tokio::test]
    async fn test_add_extension_noop_on_identical_config() {
        // When add_extension is called with a config that is byte-for-byte identical to
        // the already-loaded one, it must return Ok(()) without removing the extension.
        let temp_dir = tempfile::tempdir().unwrap();
        let em = Arc::new(ExtensionManager::new_without_provider(
            temp_dir.path().to_path_buf(),
        ));

        let config = ExtensionConfig::Frontend {
            name: "test-ext".to_string(),
            description: "original".to_string(),
            tools: vec![],
            instructions: None,
            bundled: None,
            available_tools: vec![],
        };

        em.add_client(
            "test-ext".to_string(),
            config.clone(),
            Arc::new(MockClient {}),
            None,
            None,
        )
        .await;
        assert_eq!(em.extensions.lock().await.len(), 1);

        // Calling add_extension with the same config must be a no-op (Ok, count unchanged).
        let result = em.add_extension(config, None, None, None).await;
        assert!(result.is_ok(), "identical config should be a no-op");
        assert_eq!(
            em.extensions.lock().await.len(),
            1,
            "extension must not be removed on no-op"
        );
    }

    #[tokio::test]
    async fn test_add_extension_replaces_extension_on_config_change() {
        // When add_extension is called with an updated config (same name, different fields),
        // the existing extension must be removed so the caller can re-add with new config.
        let temp_dir = tempfile::tempdir().unwrap();
        let em = Arc::new(ExtensionManager::new_without_provider(
            temp_dir.path().to_path_buf(),
        ));

        let config_a = ExtensionConfig::Frontend {
            name: "test-ext".to_string(),
            description: "version-a".to_string(),
            tools: vec![],
            instructions: None,
            bundled: None,
            available_tools: vec![],
        };
        let config_b = ExtensionConfig::Frontend {
            name: "test-ext".to_string(),
            description: "version-b".to_string(), // changed
            tools: vec![],
            instructions: None,
            bundled: None,
            available_tools: vec![],
        };

        em.add_client(
            "test-ext".to_string(),
            config_a,
            Arc::new(MockClient {}),
            None,
            None,
        )
        .await;
        assert_eq!(em.extensions.lock().await.len(), 1);

        // add_extension with changed config attempts to create a new client (fails here
        // because Frontend configs cannot be added as server extensions), but must preserve
        // the old extension so the session isn't left without it.
        let result = em.add_extension(config_b, None, None, None).await;
        assert!(result.is_err(), "Frontend add_extension must return Err");
        assert_eq!(
            em.extensions.lock().await.len(),
            1,
            "old extension must be preserved when replacement client creation fails"
        );
    }

    fn transport_err(error: Box<dyn std::error::Error + Send + Sync>) -> ClientInitializeError {
        ClientInitializeError::TransportError {
            error: rmcp::transport::DynamicTransportError::from_parts(
                "test",
                std::any::TypeId::of::<()>(),
                error,
            ),
            context: "test context".into(),
        }
    }

    fn streamable_err(
        e: rmcp::transport::streamable_http_client::StreamableHttpError<reqwest::Error>,
    ) -> ClientInitializeError {
        transport_err(Box::new(e))
    }

    #[test]
    fn test_oauth_fallback_on_typed_auth_required() {
        let err = streamable_err(
            rmcp::transport::streamable_http_client::StreamableHttpError::AuthRequired(
                rmcp::transport::streamable_http_client::AuthRequiredError::new(
                    "Bearer realm=\"test\"".to_string(),
                ),
            ),
        );
        assert!(should_attempt_oauth_fallback(&Err(err)));
    }

    #[test]
    fn test_oauth_fallback_on_unexpected_response_http_401_prefix() {
        let err = streamable_err(
            rmcp::transport::streamable_http_client::StreamableHttpError::UnexpectedServerResponse(
                std::borrow::Cow::Borrowed("HTTP 401 Unauthorized"),
            ),
        );
        assert!(should_attempt_oauth_fallback(&Err(err)));
    }

    #[tokio::test]
    async fn test_post_refresh_auth_failure_clears_credentials() {
        use rmcp::transport::auth::{
            InMemoryCredentialStore, OAuthTokenResponse, StoredCredentials,
        };

        let token_response: OAuthTokenResponse = serde_json::from_value(serde_json::json!({
            "access_token": "rejected-token",
            "token_type": "bearer",
        }))
        .expect("valid fake token JSON");
        let store = InMemoryCredentialStore::new();
        store
            .save(StoredCredentials::new(
                "test-client".to_string(),
                Some(token_response),
                vec![],
                None,
            ))
            .await
            .unwrap();

        let err = streamable_err(
            rmcp::transport::streamable_http_client::StreamableHttpError::AuthRequired(
                rmcp::transport::streamable_http_client::AuthRequiredError::new(
                    "Bearer error=\"invalid_token\"".to_string(),
                ),
            ),
        );
        let error = ExtensionError::InitializeError(err);

        assert!(clear_credentials_on_post_refresh_auth_failure(&store, "test-ext", &error).await);
        assert!(store.load().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_invalid_header_name_returns_config_error() {
        let mut headers = HashMap::new();
        headers.insert("bad header name".to_string(), "value".to_string());

        let temp_dir = tempdir().unwrap();
        let provider: SharedProvider = Arc::new(Mutex::new(None));
        let capabilities = GooseMcpClientCapabilities {
            mcpui: false,
            host_info: None,
            roots: true,
        };

        let result = create_streamable_http_client(
            "http://localhost:1",
            None,
            &headers,
            "test-ext",
            None,
            Box::new(rmcp::transport::auth::InMemoryCredentialStore::new()),
            provider,
            "goose-test".to_string(),
            capabilities,
            temp_dir.path(),
        )
        .await;

        let Err(ExtensionError::ConfigError(msg)) = result else {
            panic!("expected ConfigError, got a different result");
        };
        assert!(
            msg.contains("invalid header"),
            "unexpected error message: {msg}"
        );
    }

    #[tokio::test]
    async fn test_invalid_header_value_returns_config_error() {
        let mut headers = HashMap::new();
        headers.insert("x-valid-name".to_string(), "bad\r\nvalue".to_string());

        let temp_dir = tempdir().unwrap();
        let provider: SharedProvider = Arc::new(Mutex::new(None));
        let capabilities = GooseMcpClientCapabilities {
            mcpui: false,
            host_info: None,
            roots: true,
        };

        let result = create_streamable_http_client(
            "http://localhost:1",
            None,
            &headers,
            "test-ext",
            None,
            Box::new(rmcp::transport::auth::InMemoryCredentialStore::new()),
            provider,
            "goose-test".to_string(),
            capabilities,
            temp_dir.path(),
        )
        .await;

        let Err(ExtensionError::ConfigError(msg)) = result else {
            panic!("expected ConfigError, got a different result");
        };
        assert!(
            msg.contains("invalid header value"),
            "unexpected error message: {msg}"
        );
    }

    #[tokio::test]
    async fn test_custom_headers_forwarded_to_http_extension() {
        use wiremock::matchers::any;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200))
            .mount(&mock_server)
            .await;

        let mut headers = HashMap::new();
        headers.insert("x-api-key".to_string(), "test-secret-123".to_string());

        let temp_dir = tempdir().unwrap();
        let provider: SharedProvider = Arc::new(Mutex::new(None));
        let capabilities = GooseMcpClientCapabilities {
            mcpui: false,
            host_info: None,
            roots: true,
        };

        // The MCP handshake will fail against the stub server. We only care that
        // the outgoing HTTP request carried the custom header.
        let _ = create_streamable_http_client(
            &mock_server.uri(),
            None,
            &headers,
            "test-ext",
            None,
            Box::new(rmcp::transport::auth::InMemoryCredentialStore::new()),
            provider,
            "goose-test".to_string(),
            capabilities,
            temp_dir.path(),
        )
        .await;

        let received = mock_server.received_requests().await.unwrap();
        assert!(
            !received.is_empty(),
            "expected at least one HTTP request to reach the mock server"
        );
        let header_found = received.iter().any(|req| {
            req.headers
                .get("x-api-key")
                .map(|v| v == "test-secret-123")
                .unwrap_or(false)
        });
        assert!(
            header_found,
            "custom header x-api-key was not forwarded to the extension server"
        );
    }

    /// Directly exercises `connect_with_auth`, which is the code path fixed by
    /// the PR (custom headers were dropped when the OAuth connection path was
    /// taken).  Uses a pre-seeded `InMemoryCredentialStore` with a fake,
    /// non-expiring token so `get_access_token()` returns immediately without
    /// touching any OAuth endpoints or the system keychain.
    #[tokio::test]
    async fn test_custom_headers_forwarded_oauth_path() {
        use rmcp::transport::auth::{
            InMemoryCredentialStore, OAuthTokenResponse, StoredCredentials,
        };
        use wiremock::matchers::any;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let mock_server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200))
            .mount(&mock_server)
            .await;

        let mut headers = HashMap::new();
        headers.insert("x-api-key".to_string(), "test-secret-oauth".to_string());

        // Build a fake, non-expiring token. token_received_at=None skips the
        // expiry check, so get_access_token() returns without any network call.
        let token_response: OAuthTokenResponse = serde_json::from_value(serde_json::json!({
            "access_token": "fake-test-token",
            "token_type": "bearer",
        }))
        .expect("valid fake token JSON");
        let creds = StoredCredentials::new(
            "test-client".to_string(),
            Some(token_response),
            vec![],
            None,
        );
        let store = InMemoryCredentialStore::new();
        store.save(creds).await.unwrap();

        let mut auth_manager = rmcp::transport::AuthorizationManager::new(mock_server.uri())
            .await
            .expect("AuthorizationManager::new should not make network calls");
        auth_manager.set_credential_store(store);

        let temp_dir = tempdir().unwrap();
        let provider: SharedProvider = Arc::new(Mutex::new(None));
        let capabilities = GooseMcpClientCapabilities {
            mcpui: false,
            host_info: None,
            roots: true,
        };

        // connect_with_auth will fail (mock server isn't an MCP server) but we
        // only care that the outgoing request carried the custom header.
        let _ = connect_with_auth(
            auth_manager,
            &mock_server.uri(),
            Duration::from_secs(5),
            &headers,
            provider,
            "goose-test".to_string(),
            capabilities,
            temp_dir.path(),
        )
        .await;

        let received = mock_server.received_requests().await.unwrap();
        assert!(
            !received.is_empty(),
            "expected at least one HTTP request to reach the mock server"
        );
        let header_found = received.iter().any(|req| {
            req.headers
                .get("x-api-key")
                .map(|v| v == "test-secret-oauth")
                .unwrap_or(false)
        });
        assert!(
            header_found,
            "custom header x-api-key was not forwarded through the OAuth connection path"
        );
    }
}
