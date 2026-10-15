use crate::agents::agent_role::CodeProTaskKind;
use crate::agents::codepro_intent::CodeProIntent;
use crate::agents::codepro_simple_change_run::{tool_exit_code, tool_receipt_is_unverified};
use crate::agents::extension_manager::{
    trusted_tool_audit_from_error, trusted_tool_audit_from_result,
    trusted_workspace_delta_from_error, trusted_workspace_delta_from_result,
    trusted_workspace_versions_from_error, trusted_workspace_versions_from_result,
};
use crate::agents::tool_audit::{
    ToolAuditExtensionSource, ToolAuditOutcome, ToolAuditPermissionClass, ToolAuditReceipt,
};
use crate::agents::validation_invocation::ValidationInvocation;
use crate::config::permission::CodeProTaskScope;
use crate::conversation::message::{Message, MessageContent, ToolRequest, ToolResponse};
use crate::session::ExtensionData;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

pub(crate) const COMPLETION_REVIEW: &str = "# Main Agent completion review\nThe previous prose is a draft, not a verified result. Recheck the original user objective against actual tool receipts and current state. A script exiting successfully, a focused window, or a click is not proof that the requested task is complete. If work remains and tools can make progress, continue now without asking a routine continuation question. For GUI messages, verify the exact recipient/content and the after-image: report visible submission or a matching application reply as desktop_interaction, without claiming independent recipient delivery. Require an owner receipt only for an actual external delivery requirement; never replay an uncertain send. If blocked, state the exact unfinished work and required input. Only produce a final answer after this check.";
pub(crate) const REPEATED_FAILURE_REVIEW: &str = "# Main Agent tool repair\nThe same tool and arguments failed or returned an unverified outcome twice. Read the actual receipt and the tool input schema before acting. For an uncertain side effect, use read-only observation to check the current state; the action may already have happened. Do not replay the same action merely because an observation succeeded. Retry only with new state or corrected arguments supported by evidence. Do not claim completion or ask the user to repair ordinary tool arguments. If no safe repair is possible, explain the concrete blocker and preserve the unfinished goal.";
pub(crate) const NO_VERIFIED_RESULT: &str = "任务尚未完成：未取得成功执行的工具证据，不能确认目标已达成。原任务及对话已保留，可继续核查或补充所需条件。";
pub(crate) const NO_DELIVERY_PROOF: &str = "任务尚未完成：尚未取得绑定收件人的发送成功证据。脚本执行结束或点击成功不能证明消息已发出；为避免重复发送，已保留当前对话与工具结果，请先核对实际发送状态。";
pub(crate) const NO_VALIDATION_OBSERVATION: &str = "任务尚未完成：没有取得受宿主审计且带退出码的验证动作回执，不能确认已运行用户要求的验证。原任务、对话和已有工具结果已保留。";
pub(crate) const NO_CHANGE_OBSERVATION: &str = "任务尚未完成：没有取得成功工作区写入或受宿主审计的验证动作回执。读取文件本身不能证明修改任务已经交付；原任务、对话和已有工具结果已保留。";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ComputerOperationMethod {
    #[default]
    Unrestricted,
    DesktopControl,
    MouseOnly,
    StateUnavailable,
}

impl ComputerOperationMethod {
    pub(crate) fn instruction(self) -> &'static str {
        match self {
            Self::Unrestricted => "",
            Self::StateUnavailable => "The current task operation method could not be loaded. Retry after session state is available; do not infer permission from missing state.",
            Self::DesktopControl => "The user requires computer control for this task. Use registered computer actions for changes; host-classified read-only tools remain available. Direct file writes, shell, code execution, and delegation are unavailable until the user explicitly changes the method.",
            Self::MouseOnly => "The user requires mouse-only computer control for this task. Use mouse movement, clicks, dragging, and scrolling. Observation, host-classified read-only tools, necessary window focus, and stopping input remain available. Keyboard, typing, UI Automation invocation/value setting, direct file writes, shell, code execution, and delegation are unavailable until the user explicitly changes the method.",
        }
    }
}

fn explicit_computer_method(text: &str) -> Option<ComputerOperationMethod> {
    let normalized = text.trim().to_lowercase();
    normalized
        .split([',', '，', ';', '；', '。', '\n'])
        .filter_map(computer_method_clause)
        .next_back()
}

fn computer_method_clause(clause: &str) -> Option<ComputerOperationMethod> {
    let clause = clause.trim().trim_end_matches(['.', '!', '！']);
    let clause = clause
        .strip_prefix("但")
        .or_else(|| clause.strip_prefix("but "))
        .unwrap_or(clause);
    let next = match clause {
        "只用鼠标"
        | "必须只用鼠标"
        | "只能用鼠标"
        | "只能使用鼠标"
        | "只用鼠标操作窗口"
        | "只用滑鼠"
        | "必須只用滑鼠"
        | "only use the mouse"
        | "use only the mouse" => ComputerOperationMethod::MouseOnly,
        "必须使用电脑控制" | "必須使用電腦控制" | "改用电脑控制" | "must use computer control" => {
            ComputerOperationMethod::DesktopControl
        }
        "解除操作方式限制"
        | "解除操作方式約束"
        | "允许使用键盘和脚本"
        | "remove the operation method restriction" => ComputerOperationMethod::Unrestricted,
        _ => return None,
    };
    Some(next)
}

pub(crate) fn saved_computer_method(data: &ExtensionData) -> ComputerOperationMethod {
    let Some(state) = data.get_extension_state("codepro_unified_turn", "v1") else {
        return ComputerOperationMethod::Unrestricted;
    };
    match state.get("computer_operation_method") {
        Some(value) => serde_json::from_value(value.clone())
            .unwrap_or(ComputerOperationMethod::StateUnavailable),
        None => state["goal"]
            .as_str()
            .and_then(explicit_computer_method)
            .unwrap_or_default(),
    }
}

pub(crate) fn amend_computer_method(data: &mut ExtensionData, user: &Message) {
    let Some(mut state) = data
        .get_extension_state("codepro_unified_turn", "v1")
        .cloned()
    else {
        return;
    };
    if user.role != rmcp::model::Role::User
        || !user.metadata.user_visible
        || user.content.iter().any(|content| {
            matches!(
                content,
                MessageContent::ToolResponse(_) | MessageContent::ToolRequest(_)
            )
        })
        || user.metadata.task_continuation_of.as_deref() != state["source_message_id"].as_str()
        || user.metadata.task_continuation_of.is_none()
    {
        return;
    }
    if let Some(method) = explicit_computer_method(&user.as_concat_text()) {
        state["computer_operation_method"] = serde_json::json!(method);
        data.set_extension_state("codepro_unified_turn", "v1", state);
    }
}

pub(crate) fn new_goal_replaces_computer_method(data: &ExtensionData, user: &Message) -> bool {
    if saved_computer_method(data) == ComputerOperationMethod::Unrestricted {
        return false;
    }
    let Some(state) = data.get_extension_state("codepro_unified_turn", "v1") else {
        return false;
    };
    user.role == rmcp::model::Role::User
        && user.metadata.user_visible
        && user.metadata.task_continuation_of.is_none()
        && !is_unified_continuation(&user.as_concat_text())
        && user.id.as_deref() != state["source_message_id"].as_str()
        && !user.content.iter().any(|content| {
            matches!(
                content,
                MessageContent::ToolResponse(_) | MessageContent::ToolRequest(_)
            )
        })
}

pub(crate) fn is_plain_continuation(text: &str) -> bool {
    matches!(
        text.trim().to_lowercase().as_str(),
        "继续"
            | "继续吧"
            | "继续任务"
            | "继续执行"
            | "继续上次任务"
            | "继续做"
            | "continue"
            | "resume"
    )
}

fn substantive_user(message: &Message) -> bool {
    message.role == rmcp::model::Role::User
        && message.metadata.user_visible
        && (has_image_attachment(message)
            || (!message.as_concat_text().trim().is_empty()
                && !is_plain_continuation(&message.as_concat_text())))
}

fn is_unified_continuation(text: &str) -> bool {
    let normalized = text
        .trim()
        .trim_end_matches(['。', '！', '.', '!'])
        .to_lowercase();
    if is_plain_continuation(&normalized) {
        return true;
    }
    let Some((continuation, constraint)) = normalized.split_once([',', '，']) else {
        return false;
    };
    is_plain_continuation(continuation) && computer_method_clause(constraint).is_some()
}

fn goal_source_index(messages: &[Message]) -> Option<usize> {
    let mut source: Option<usize> = None;
    for (index, message) in messages.iter().enumerate() {
        if !substantive_user(message) {
            continue;
        }
        let continues_source = !has_image_attachment(message)
            && is_unified_continuation(&message.as_concat_text())
            && message
                .metadata
                .task_continuation_of
                .as_deref()
                .is_some_and(|id| {
                    // A late continuation of an older goal must not replace a newer goal.
                    messages[..index]
                        .iter()
                        .any(|prior| substantive_user(prior) && prior.id.as_deref() == Some(id))
                });
        if !continues_source {
            source = Some(index);
        }
    }
    source
}

pub(crate) fn bind_unified_continuation(
    data: &ExtensionData,
    messages: &[Message],
    user: &mut Message,
    working_dir: &str,
) -> Option<CodeProIntent> {
    user.metadata.task_continuation_of = None;
    if user.role != rmcp::model::Role::User
        || !user.metadata.user_visible
        || has_image_attachment(user)
        || !is_unified_continuation(&user.as_concat_text())
    {
        return None;
    }
    let saved = data.get_extension_state("codepro_unified_turn", "v1")?;
    if !matches!(
        saved["status"].as_str(),
        Some("running" | "paused" | "finished")
    ) {
        return None;
    }
    let intent = saved_unified_intent(data, messages, working_dir)?;
    user.metadata.task_continuation_of = messages[goal_source_index(messages)?].id.clone();
    user.metadata.task_continuation_of.as_ref()?;
    Some(intent)
}

fn has_image_attachment(message: &Message) -> bool {
    crate::prompt_attachments::validated_image_count(message).is_ok_and(|count| count > 0)
}

pub(crate) fn discard_stale_turn_controls(messages: &mut Vec<Message>) {
    messages.retain(|message| {
        if message.role != rmcp::model::Role::User || message.metadata.user_visible {
            return true;
        }
        let text = message.as_concat_text();
        text != COMPLETION_REVIEW
            && text != REPEATED_FAILURE_REVIEW
            && text != crate::agents::action_budget::ACTION_BUDGET_FINALIZATION_INSTRUCTION
            && !text.starts_with("主 Agent 已根据新的成功操作延长执行窗口。")
    });
}

pub(crate) fn saved_unified_intent(
    data: &ExtensionData,
    messages: &[Message],
    working_dir: &str,
) -> Option<CodeProIntent> {
    let source_index = goal_source_index(messages)?;
    let source = &messages[source_index];
    if let Some(saved) = data.get_extension_state("codepro_unified_turn", "v1") {
        if saved["working_dir"].as_str() == Some(working_dir)
            && saved["source_message_id"].as_str() == source.id.as_deref()
        {
            return match saved["intent"].as_str()? {
                "tool_action" => Some(CodeProIntent::ToolAction),
                "read_only" => Some(CodeProIntent::ReadOnly),
                "conversation" => Some(CodeProIntent::Conversation),
                "test" => Some(CodeProIntent::Test),
                "change" => Some(CodeProIntent::Change),
                _ => None,
            };
        }
        return None;
    }
    // Older desktop turns have no workflow state. A fresh ACP run ID is not
    // evidence of a durable CodePro checkpoint; recover from saved tool history.
    messages[source_index + 1..]
        .iter()
        .any(|message| {
            message.content.iter().any(|content| {
                matches!(content,
            MessageContent::ToolRequest(request) if request.tool_call.as_ref().is_ok_and(|call|
                call.name.starts_with("computer_") || call.name.starts_with("computercontroller::")
                || call.name.starts_with("computercontroller__")
                || call.name.starts_with("computer__") || call.name.starts_with("qwen_computer__")))
            })
        })
        .then_some(CodeProIntent::ToolAction)
}

pub(crate) fn save_unified_intent(
    data: &mut ExtensionData,
    messages: &[Message],
    user: &Message,
    working_dir: &str,
    intent: &str,
) {
    let prior_source = goal_source_index(messages).map(|index| &messages[index]);
    let linked = user
        .metadata
        .task_continuation_of
        .as_deref()
        .is_some_and(|id| {
            prior_source.is_some_and(|source| source.id.as_deref() == Some(id))
                && is_unified_continuation(&user.as_concat_text())
        });
    let continues_prior = (is_plain_continuation(&user.as_concat_text()) || linked)
        && !has_image_attachment(user)
        && prior_source.is_some();
    let source = if continues_prior {
        prior_source.unwrap_or(user)
    } else {
        user
    };
    let mut method = if continues_prior {
        saved_computer_method(data)
    } else {
        ComputerOperationMethod::Unrestricted
    };
    if user.role == rmcp::model::Role::User
        && user.metadata.user_visible
        && !user.content.iter().any(|content| {
            matches!(
                content,
                MessageContent::ToolResponse(_) | MessageContent::ToolRequest(_)
            )
        })
    {
        if let Some(explicit) = explicit_computer_method(&user.as_concat_text()) {
            method = explicit;
        }
    }
    data.set_extension_state(
        "codepro_unified_turn",
        "v1",
        serde_json::json!({
            "intent": intent, "working_dir": working_dir,
            "source_message_id": source.id, "goal": source.as_concat_text(),
            "turn_id": user.id,
            "run_id": user.metadata.task_run_id,
            "computer_operation_method": method,
            "status": "running",
        }),
    );
}

#[derive(Default, Clone)]
pub(crate) struct ToolTaskProgress {
    observed_terminal_request_ids: HashSet<String>,
    distinct_successes: HashSet<[u8; 32]>,
    progress_at_extension: usize,
    pub successful_tools: usize,
    pub delivery_attempted: bool,
    pub delivery_verified: bool,
    send_attempts: usize,
    verified_sends: usize,
    failed_calls: HashMap<[u8; 32], u8>,
    unverified_actions: HashSet<(String, String)>,
    repeated_failures: u8,
    action_facts: MainAgentActionFacts,
    // Rebuilt availability diagnostics, not action outcomes or persisted facts.
    unavailable_delegated_evidence: BTreeMap<String, String>,
    // Rebuilt references to original unresolved facts; never persisted or used
    // as current-run success, authorization or budget accounting.
    referenced_unresolved_actions: BTreeMap<String, Value>,
}

#[derive(Default, Clone)]
struct MainAgentActionFacts {
    expected_task_scope_digest: Option<String>,
    validation_cwd: PathBuf,
    audited_action_ids: HashSet<String>,
    successful_action_ids: HashSet<String>,
    workspace_write_action_ids: HashSet<String>,
    validation_action_ids: HashSet<String>,
    passed_validation_action_ids: HashSet<String>,
    failed_validation_action_ids: HashSet<String>,
    last_validation_succeeded: Option<bool>,
    validation_observations: Vec<ValidationObservationV1>,
    action_index: BTreeMap<String, ContractActionFact>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContractActionFact {
    call_id: String,
    completed_at: chrono::DateTime<chrono::Utc>,
    tool_name: String,
    command: Option<String>,
    invocation: Option<ValidationInvocation>,
    shell_outcome: Option<Value>,
    outcome: ToolAuditOutcome,
    pub(crate) changed_paths: Vec<String>,
    resource_versions: BTreeMap<String, String>,
    observed_resources: Vec<String>,
    desktop_observation: Option<DesktopObservation>,
    pub(crate) exit_code: Option<i32>,
    observation: bool,
    memory_effect: Option<(String, String)>,
    external_effect: Option<(String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<ReferencedActionSource>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferencedActionSource {
    pub(crate) session_id: String,
    pub(crate) task_id: crate::agents::protocol::TaskId,
    pub(crate) task_scope_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) delegation: Option<crate::agents::protocol::EvidenceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) continuation: Option<crate::agents::protocol::RequirementContinuationSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ValidationObservationV1 {
    pub(crate) audit_id: String,
    pub(crate) invocation: ValidationInvocation,
    pub(crate) exit_code: i32,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MainAgentActionEvidenceV1 {
    schema_version: u8,
    task_scope_digest: Option<String>,
    audited_action_ids: Vec<String>,
    successful_action_ids: Vec<String>,
    workspace_write_action_ids: Vec<String>,
    validation_action_ids: Vec<String>,
    passed_validation_action_ids: Vec<String>,
    failed_validation_action_ids: Vec<String>,
    pub(crate) validation_observations: Vec<ValidationObservationV1>,
    last_validation_succeeded: Option<bool>,
    successful_tool_count: usize,
    unverified_action_count: usize,
    delivery_attempted: bool,
    delivery_verified: bool,
    pub(crate) action_index: BTreeMap<String, ContractActionFact>,
}

fn trusted_workspace_delta_from_tool_result(
    result: &crate::mcp_utils::ToolResult<rmcp::model::CallToolResult>,
) -> Option<Vec<String>> {
    match result {
        Ok(result) => trusted_workspace_delta_from_result(result),
        Err(error) => trusted_workspace_delta_from_error(error),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct DesktopObservation {
    schema_version: u32,
    pid: u32,
    window_handle: u64,
    app_name: String,
    bundle_identifier: String,
    window_title: String,
}

impl DesktopObservation {
    fn resource(&self) -> String {
        format!("desktop:{}/{}", self.pid, self.window_handle)
    }

    fn matches_target(&self, target: &str) -> bool {
        target == self.resource()
            || [&self.app_name, &self.bundle_identifier, &self.window_title]
                .iter()
                .any(|alias| !alias.is_empty() && alias.eq_ignore_ascii_case(target))
    }
}

fn desktop_observation(
    receipt: &ToolAuditReceipt,
    result: &crate::mcp_utils::ToolResult<rmcp::model::CallToolResult>,
) -> Option<DesktopObservation> {
    // Only our bundled runtime owns this evidence. A similarly named external
    // extension or a successful input without an after-image is not an observation.
    if receipt.extension_source != ToolAuditExtensionSource::Builtin
        || receipt.outcome != ToolAuditOutcome::Success
        || !receipt.tool_name.starts_with("qwen_computer::")
    {
        return None;
    }
    let result = result.as_ref().ok()?;
    if result.is_error == Some(true)
        || !result.content.iter().any(|content| {
            content
                .as_image()
                .is_some_and(|image| !image.data.is_empty())
        })
    {
        return None;
    }
    let observation: DesktopObservation = serde_json::from_value(
        result
            .structured_content
            .as_ref()?
            .get("desktop_observation")?
            .clone(),
    )
    .ok()?;
    (observation.schema_version == 1
        && observation.pid > 0
        && observation.window_handle > 0
        && !observation.app_name.trim().is_empty())
    .then_some(observation)
}

fn desktop_input_tool(name: &str) -> bool {
    matches!(
        name,
        "qwen_computer::click"
            | "qwen_computer::drag"
            | "qwen_computer::press_key"
            | "qwen_computer::type_text"
            | "qwen_computer::scroll"
            | "qwen_computer::set_value"
            | "qwen_computer::perform_secondary_action"
    )
}

fn normalized_resource(root: &Path, resource: &str) -> String {
    let path = Path::new(resource);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let path = path.canonicalize().unwrap_or(path);
    let value = path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("//?/")
        .trim_end_matches('/')
        .to_string();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

fn resource_within(resource: &str, target: &str) -> bool {
    resource == target
        || resource
            .strip_prefix(target)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn verify_current_resource(resource: &str, expected: &str) -> Result<(), String> {
    if expected == "deleted" {
        return match std::fs::symlink_metadata(resource) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(format!(
                "resource {resource} exists again after the cited deletion"
            )),
            Err(error) => Err(format!(
                "cannot verify current resource {resource}: {error}"
            )),
        };
    }
    let expected_hash = expected
        .strip_prefix("blake3:")
        .ok_or_else(|| format!("resource {resource} has an unsupported receipt version"))?;
    let mut file = std::fs::File::open(resource)
        .map_err(|error| format!("cannot verify current resource {resource}: {error}"))?;
    let mut hasher = blake3::Hasher::new();
    std::io::copy(&mut file, &mut hasher)
        .map_err(|error| format!("cannot hash current resource {resource}: {error}"))?;
    if hasher.finalize().to_hex().as_str() == expected_hash {
        Ok(())
    } else {
        Err(format!(
            "resource {resource} changed after the cited action; obtain fresh evidence"
        ))
    }
}

fn action_result_body(
    result: &crate::mcp_utils::ToolResult<rmcp::model::CallToolResult>,
) -> Option<Value> {
    let retained;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let audit = trusted_tool_audit_from_error(error)?;
            if audit.extension_source != ToolAuditExtensionSource::Platform
                || audit.tool_name != "developer::shell"
                || !matches!(
                    audit.outcome,
                    ToolAuditOutcome::TimedOut | ToolAuditOutcome::Cancelled
                )
            {
                return None;
            }
            retained = super::extension_manager::bounded_execution_result(error)?;
            &retained
        }
    };
    result.structured_content.clone().or_else(|| {
        result
            .content
            .iter()
            .filter_map(|content| content.as_text())
            .find_map(|text| serde_json::from_str::<Value>(&text.text).ok())
    })
}

impl MainAgentActionFacts {
    fn for_scope(task_scope: Option<&CodeProTaskScope>) -> Self {
        Self {
            expected_task_scope_digest: task_scope
                .map(crate::agents::tool_audit::task_scope_digest),
            validation_cwd: task_scope
                .and_then(CodeProTaskScope::workspace_root)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".")),
            ..Self::default()
        }
    }

    fn observe(
        &mut self,
        request: &ToolRequest,
        receipt: &ToolAuditReceipt,
        result: &crate::mcp_utils::ToolResult<rmcp::model::CallToolResult>,
    ) {
        if receipt.schema_version != 2 {
            return;
        }
        if receipt.task_scope_digest != self.expected_task_scope_digest {
            return;
        }
        self.audited_action_ids.insert(receipt.audit_id.clone());
        let changed_paths = trusted_workspace_delta_from_tool_result(result).unwrap_or_default();
        let resource_versions = match result {
            Ok(result) => trusted_workspace_versions_from_result(result),
            Err(error) => trusted_workspace_versions_from_error(error),
        }
        .unwrap_or_default();
        let exit_code = tool_exit_code(result);
        let success = receipt.outcome == ToolAuditOutcome::Success;
        let mut observed_resources = request
            .tool_call
            .as_ref()
            .ok()
            .and_then(|call| call.arguments.as_ref())
            .into_iter()
            .flat_map(|arguments| {
                ["path", "file_path", "cwd"]
                    .into_iter()
                    .filter_map(|key| arguments.get(key).and_then(Value::as_str))
            })
            .map(|path| normalized_resource(&self.validation_cwd, path))
            .collect::<Vec<_>>();
        if exit_code.is_some() {
            observed_resources.push(normalized_resource(&self.validation_cwd, "."));
        }
        let body = action_result_body(result);
        let trusted_platform = receipt.extension_source == ToolAuditExtensionSource::Platform;
        let command = request
            .tool_call
            .as_ref()
            .ok()
            .and_then(|call| call.arguments.as_ref())
            .and_then(|arguments| arguments.get("command"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let invocation_cwd = body
            .as_ref()
            .filter(|_| trusted_platform && receipt.tool_name == "developer::shell")
            .and_then(|body| body.get("cwd"))
            .and_then(Value::as_str)
            .filter(|cwd| Path::new(cwd).is_absolute())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.validation_cwd.clone());
        let invocation = command.as_deref().and_then(|command| {
            if trusted_platform && receipt.tool_name == "developer::shell" {
                ValidationInvocation::for_evidence(command, &invocation_cwd).ok()
            } else {
                ValidationInvocation::parse(command, &invocation_cwd).ok()
            }
        });
        let memory_effect = if success && trusted_platform {
            match receipt.tool_name.as_str() {
                "projectmemory::project_memory_remember" => body
                    .as_ref()
                    .and_then(|body| {
                        serde_json::from_value::<
                            super::platform_extensions::project_memory::ProjectMemoryEntry,
                        >(body.get("entry")?.clone())
                        .ok()
                    })
                    .filter(|entry| !entry.id.is_empty() && !entry.subject.is_empty())
                    .map(|entry| {
                        (
                            format!("memory:{}", entry.subject),
                            format!("{}:{}", entry.id, entry.updated_at.to_rfc3339()),
                        )
                    }),
                // Successful deletion receipts confirm absence, including an
                // idempotent retry (removed=false). Bind that fact to the exact
                // requested ID; model prose and read-only search are not receipts.
                "projectmemory::project_memory_forget" => body
                    .as_ref()
                    .and_then(|body| body.get("removed")?.as_bool())
                    .and_then(|_| request.tool_call.as_ref().ok()?.arguments.as_ref())
                    .and_then(|arguments| arguments.get("id")?.as_str())
                    .and_then(|id| uuid::Uuid::parse_str(id).ok().map(|_| id))
                    .map(|id| {
                        (
                            format!("memory:{id}"),
                            format!("absent:{}", receipt.audit_id),
                        )
                    }),
                "projectmemory::project_memory_clear" => body
                    .as_ref()
                    .and_then(|body| body.get("removed_count")?.as_u64())
                    .map(|_| {
                        (
                            "memory:project".to_string(),
                            format!("cleared:{}", receipt.audit_id),
                        )
                    }),
                _ => None,
            }
        } else {
            None
        };
        let external_effect = if success
            && trusted_platform
            && receipt.tool_name == "computer::computer_send_message"
        {
            body.as_ref()
                .filter(|body| {
                    body["outcome"] == "worked" && body["verification"]["matched"] == true
                })
                .and_then(|body| {
                    Some((
                        body["recipient"].as_str()?.to_string(),
                        body["message_sha256"].as_str()?.to_string(),
                    ))
                })
                .filter(|(recipient, version)| !recipient.is_empty() && !version.is_empty())
        } else {
            None
        };
        let external_effect = external_effect.or_else(|| {
            if success && receipt.tool_name == "local_git::git_push" {
                result
                    .as_ref()
                    .ok()
                    .and_then(super::git_mcp::external_effect)
            } else {
                None
            }
        });
        let desktop_observation = desktop_observation(receipt, result);
        if let Some(observation) = &desktop_observation {
            observed_resources.push(observation.resource());
        }
        self.action_index.insert(
            receipt.audit_id.clone(),
            ContractActionFact {
                call_id: request.id.to_string(),
                completed_at: receipt.completed_at,
                tool_name: receipt.tool_name.clone(),
                command,
                invocation: invocation.clone(),
                shell_outcome: body.as_ref()
                    .filter(|_| trusted_platform && receipt.tool_name == "developer::shell")
                    .map(|body| serde_json::json!({
                        "exit_code":body.get("exit_code"), "timed_out":body.get("timed_out"),
                        "cancelled":body.get("cancelled"), "termination_confirmed":body.get("termination_confirmed"),
                        "output_truncated":body.get("output_truncated"), "cwd":body.get("cwd"),
                        "managed_process":body.get("managed_process"),
                        "managed_process_operation":request.tool_call.as_ref().ok().and_then(|call| call.arguments.as_ref()).and_then(|args| args.get("process_action")),
                    })),
                outcome: receipt.outcome,
                changed_paths: changed_paths.clone(),
                resource_versions,
                observed_resources,
                exit_code,
                observation: desktop_observation.is_some() || (success
                    && receipt.permission_class == ToolAuditPermissionClass::ReadOnly)
                    || (exit_code.is_some()
                        && matches!(
                            receipt.outcome,
                            ToolAuditOutcome::Success | ToolAuditOutcome::ToolError
                        )),
                desktop_observation,
                memory_effect,
                external_effect,
                source: None,
            },
        );
        let has_workspace_delta = !changed_paths.is_empty();
        if has_workspace_delta {
            self.workspace_write_action_ids
                .insert(receipt.audit_id.clone());
        }
        if receipt.outcome == ToolAuditOutcome::Success {
            self.successful_action_ids.insert(receipt.audit_id.clone());
        }
        if let Some(exit_code) = tool_exit_code(result) {
            self.validation_action_ids.insert(receipt.audit_id.clone());
            let succeeded = exit_code == 0;
            if succeeded {
                self.passed_validation_action_ids
                    .insert(receipt.audit_id.clone());
            } else {
                self.failed_validation_action_ids
                    .insert(receipt.audit_id.clone());
            }
            self.last_validation_succeeded = Some(succeeded);
            if let Some(invocation) = invocation {
                self.validation_observations.push(ValidationObservationV1 {
                    audit_id: receipt.audit_id.clone(),
                    invocation,
                    exit_code,
                });
            }
        }
    }

    fn has_validation_observation(&self) -> bool {
        !self.validation_action_ids.is_empty()
    }

    fn latest_validation_passed(&self) -> bool {
        self.last_validation_succeeded == Some(true)
    }

    fn has_workspace_write(&self) -> bool {
        !self.workspace_write_action_ids.is_empty()
            || self
                .action_index
                .values()
                .any(|action| action.source.is_some() && !action.changed_paths.is_empty())
    }
}

impl ToolTaskProgress {
    pub(crate) fn clear_delegated_workspace_actions(&mut self) {
        self.unavailable_delegated_evidence.clear();
        self.referenced_unresolved_actions.clear();
        self.action_facts
            .action_index
            .retain(|_, action| action.source.is_none());
    }

    pub(crate) fn evidence_workspace(&self) -> &Path {
        &self.action_facts.validation_cwd
    }

    pub(crate) fn note_unavailable_delegation(
        &mut self,
        evidence: &super::protocol::EvidenceRef,
        reason: String,
    ) {
        self.unavailable_delegated_evidence
            .insert(evidence.event_id().to_string(), reason);
    }

    pub(crate) fn note_unavailable_continuation(&mut self, run_id: &str, reason: String) {
        self.unavailable_delegated_evidence
            .entry(format!("continuation:{run_id}"))
            .and_modify(|existing| {
                existing.push('\n');
                existing.push_str(&reason);
            })
            .or_insert(reason);
    }

    pub(crate) fn note_referenced_unresolved_action(
        &mut self,
        source_run: &str,
        mut action: Value,
    ) {
        action["sourceRunId"] = source_run.into();
        let id = format!(
            "{source_run}:{}:{}:{}",
            action["source"]["sessionId"].as_str().unwrap_or_default(),
            action["source"]["taskScopeDigest"]
                .as_str()
                .unwrap_or_default(),
            action["callId"].as_str().unwrap_or_default()
        );
        self.referenced_unresolved_actions.insert(id, action);
    }

    /// Import only file receipts from an authenticated source. The caller
    /// verifies the original session/workspace binding; the audit owner verifies
    /// each original request. No child budget, shell result or lifecycle state
    /// is merged into the parent execution tracker.
    pub(crate) async fn import_referenced_workspace_actions(
        &mut self,
        messages: &[Message],
        scope: &CodeProTaskScope,
        source: &ReferencedActionSource,
        store: &super::tool_audit::ToolAuditStore,
    ) -> anyhow::Result<usize> {
        anyhow::ensure!(
            source.task_scope_digest == super::tool_audit::task_scope_digest(scope)
                && source.task_id.as_str() == scope.task_id()
                && (source.delegation.is_some() || source.continuation.is_some())
                && source
                    .delegation
                    .as_ref()
                    .is_none_or(|reference| reference.run_id().as_str() == scope.run_id())
                && source
                    .continuation
                    .as_ref()
                    .is_none_or(|reference| reference.run_id == scope.run_id()),
            "referenced action source does not match its task scope"
        );
        let mut facts = MainAgentActionFacts::for_scope(Some(scope));
        let mut original_progress = Self::from_history_in_scope(&[], Some(scope));
        let mut requests = HashMap::new();
        for message in messages {
            for content in &message.content {
                match content {
                    MessageContent::ToolRequest(request) => {
                        requests.insert(request.id.as_str(), request);
                    }
                    MessageContent::ToolResponse(response) => {
                        let Some(request) = requests.get(response.id.as_str()) else {
                            continue;
                        };
                        let receipt = match &response.tool_result {
                            Ok(result) => trusted_tool_audit_from_result(result),
                            Err(error) => trusted_tool_audit_from_error(error),
                        };
                        let Some(receipt) = receipt else {
                            continue;
                        };
                        if receipt.task_scope_digest.as_deref()
                            != Some(source.task_scope_digest.as_str())
                        {
                            continue;
                        }
                        let file_write = receipt.outcome == ToolAuditOutcome::Success
                            && receipt.extension_source == ToolAuditExtensionSource::Platform
                            && matches!(
                                receipt.tool_name.as_str(),
                                "developer::write" | "developer::edit"
                            )
                            && trusted_workspace_delta_from_tool_result(&response.tool_result)
                                .is_some_and(|paths| !paths.is_empty());
                        // Reuse the existing outcome interpreter as a candidate
                        // filter. Only authenticated candidates enter the replay;
                        // unrelated reads and unaudited public progress do not
                        // become new completion requirements.
                        let mut candidate = Self::from_history_in_scope(&[], Some(scope));
                        candidate.observe(request, response);
                        let replay_outcome = source.continuation.is_some()
                            && (!candidate.unverified_actions.is_empty()
                                || candidate.delivery_attempted
                                || (receipt.extension_source
                                    == ToolAuditExtensionSource::Platform
                                    && receipt.tool_name == "developer::shell"));
                        if !file_write && !replay_outcome {
                            continue;
                        }
                        let call = request
                            .tool_call
                            .as_ref()
                            .map_err(|error| anyhow::anyhow!("{error:?}"))?;
                        if let Err(error) = store
                            .verify_completed_receipt(
                                &source.session_id,
                                &request.id,
                                scope,
                                &call.arguments.clone().unwrap_or_default(),
                                &receipt,
                            )
                            .await
                        {
                            self.unavailable_delegated_evidence.insert(
                                receipt.audit_id.clone(),
                                format!("original source receipt cannot be verified: {error}"),
                            );
                            if replay_outcome {
                                self.note_unavailable_continuation(
                                    scope.run_id(),
                                    format!(
                                        "original action {} cannot be authenticated: {error}",
                                        receipt.audit_id
                                    ),
                                );
                            }
                            tracing::warn!(audit_id = %receipt.audit_id, child_session_id = %source.session_id,
                                %error, "Delegated receipt is unavailable for coverage");
                            continue;
                        }
                        if replay_outcome {
                            original_progress.observe(request, response);
                        }
                        if file_write {
                            facts.observe(request, &receipt, &response.tool_result);
                        }
                    }
                    _ => {}
                }
            }
        }
        for mut action in original_progress.unresolved_action_index() {
            action["source"] = serde_json::to_value(source)?;
            // The source's process handle is not authorization to control it
            // from the successor run. Reconciliation stays with its owner.
            action["nextStep"] = "Reconcile this original action through its source owner. Continuing or re-running business checks does not settle it or inherit process-control authorization; preserve confirmed deliverables and hand off the specific limitation if no bound recovery is available.".into();
            self.note_referenced_unresolved_action(scope.run_id(), action);
        }
        if original_progress.unverified_delivery() {
            self.note_unavailable_continuation(
                scope.run_id(),
                "original outgoing delivery has no recipient-bound success evidence".into(),
            );
        }
        let root = normalized_resource(&self.action_facts.validation_cwd, ".");
        let mut imported = 0;
        for (id, mut action) in facts.action_index {
            if action.changed_paths.is_empty() || action.resource_versions.is_empty() {
                continue;
            }
            anyhow::ensure!(
                action.changed_paths.iter().all(|path| resource_within(
                    &normalized_resource(&facts.validation_cwd, path),
                    &root
                )),
                "delegated file evidence is outside the parent workspace"
            );
            // Workspace deltas are relative to the delegated scope's workspace,
            // not necessarily the child's narrower process working directory.
            action.changed_paths = action
                .changed_paths
                .iter()
                .map(|path| normalized_resource(&facts.validation_cwd, path))
                .collect();
            action.resource_versions = action
                .resource_versions
                .into_iter()
                .map(|(path, version)| (normalized_resource(&facts.validation_cwd, &path), version))
                .filter(|(path, _)| action.changed_paths.contains(path))
                .collect();
            action.source = Some(source.clone());
            // A write receipt is not also a parent read or command validation.
            action.observation = false;
            action.observed_resources.clear();
            action.command = None;
            action.invocation = None;
            action.shell_outcome = None;
            action.exit_code = None;
            if let Some(previous) = self.action_facts.action_index.get(&id) {
                anyhow::ensure!(
                    previous
                        .source
                        .as_ref()
                        .is_some_and(|previous_source| previous_source.session_id
                            == source.session_id
                            && previous_source.task_scope_digest == source.task_scope_digest),
                    "delegated audit identity collides with another action"
                );
            } else {
                imported += 1;
            }
            self.action_facts.action_index.insert(id, action);
        }
        Ok(imported)
    }
    #[cfg(test)]
    pub(crate) fn unresolved_action_count(&self) -> usize {
        self.unverified_actions.len()
    }

    pub(crate) fn unresolved_action_index(&self) -> Vec<Value> {
        let mut unresolved = self.unverified_actions.iter().map(|(id, name)| {
            let fact = self.action_facts.action_index.iter().find(|(_, action)| action.call_id == *id);
            let bound_stop = fact.is_some_and(|(_, action)| action.shell_outcome.as_ref().is_some_and(|outcome|
                outcome["managed_process_operation"] == "stop" && outcome["managed_process"]["handle"].is_string()));
            let next_step = if bound_stop {
                "Use shell process_action=status with this receipt's exact process_handle and original command. Only that owner's stopped/exited process group can reconcile the uncertain stop; do not substitute an HTTP probe or user confirmation."
            } else {
                "No supported bound reconciliation is available in the current action index. Re-running business checks cannot settle this original action. Do not replay it, repeatedly probe unrelated processes, or ask the user to certify it. Preserve confirmed deliverables and use codepro__task_contract report_blocked to explain the specific uncertainty and next safe step."
            };
            serde_json::json!({"callId":id, "toolName":name, "receipt":fact.map(|(audit_id, action)|
                serde_json::json!({"auditId":audit_id,"action":action})),
                "nextStep":next_step})
        }).collect::<Vec<_>>();
        unresolved.extend(self.referenced_unresolved_actions.values().cloned());
        unresolved.sort_by(|left, right| left["callId"].as_str().cmp(&right["callId"].as_str()));
        unresolved
    }

    pub(crate) fn contract_action_index(&self) -> Value {
        let mut resources = BTreeMap::new();
        for (id, action) in &self.action_facts.action_index {
            if action.outcome != ToolAuditOutcome::Success {
                continue;
            }
            for (path, version) in &action.resource_versions {
                let resource = normalized_resource(&self.action_facts.validation_cwd, path);
                let entry = resources.entry(resource).or_insert((id, action, version));
                if action.completed_at > entry.1.completed_at {
                    *entry = (id, action, version);
                }
            }
        }
        let resources = resources
            .into_iter()
            .map(|(path, (id, action, version))| {
                let error = verify_current_resource(&path, version).err();
                serde_json::json!({"resource":path, "auditId":id, "callId":action.call_id,
                "current":error.is_none(), "gap":error})
            })
            .collect::<Vec<_>>();
        let unresolved = self.unresolved_action_index();
        // Inspect is a navigation index, not another copy of the evidence bundle.
        // Validation invocations and current file versions are indexed below;
        // keep complete receipts in the original evidence and unresolved entries.
        let actions = self.action_facts.action_index.iter().map(|(id, action)| {
            let mut summary = serde_json::json!({
                "callId": action.call_id, "toolName": action.tool_name,
                "completedAt": action.completed_at, "outcome": action.outcome,
                "changedPaths": action.changed_paths, "observedResources": action.observed_resources,
                "exitCode": action.exit_code, "observation": action.observation,
                "desktopObservation": action.desktop_observation,
                "command": if action.invocation.is_none() || action.exit_code.is_none() { action.command.as_ref() } else { None },
                "shellOutcome": action.shell_outcome,
                "memoryEffect": action.memory_effect, "externalEffect": action.external_effect,
                "source": action.source,
            });
            if let Some(fields) = summary.as_object_mut() {
                fields.retain(|_, value| !value.is_null() && !value.as_array().is_some_and(Vec::is_empty));
            }
            (id, summary)
        }).collect::<BTreeMap<_, _>>();
        serde_json::json!({"actions": actions,
            "currentResourceEvidence":resources, "unresolvedActions":unresolved,
            "unavailableDelegatedEvidence": self.unavailable_delegated_evidence,
            "validationObservations": self.action_facts.validation_observations})
    }

    pub(crate) fn resolve_audit_ids(&self, ids: &[String]) -> Result<Vec<String>, String> {
        let results = ids.iter().map(|id| {
            if self.action_facts.action_index.contains_key(id) { return Ok(id.clone()); }
            if let Some(reason) = self.unavailable_delegated_evidence.get(id) {
                return Err(format!("audit ID {id} is unavailable: {reason}"));
            }
            let matches = self.action_facts.action_index.iter()
                .filter(|(_, action)| action.call_id == *id).map(|(id, _)| id).collect::<Vec<_>>();
            match matches.as_slice() {
                [audit_id] => Ok((*audit_id).clone()),
                [] => Err(format!("audit or call ID {id} does not belong to the current task evidence; copy an exact callId from inspect. IDs are never fuzzy-matched.")),
                _ => Err(format!("call ID {id} refers to multiple audit receipts; use its exact audit ID")),
            }
        }).collect::<Vec<_>>();
        let gaps = results
            .iter()
            .filter_map(|result| result.as_ref().err().cloned())
            .collect::<Vec<_>>();
        if gaps.is_empty() {
            Ok(results.into_iter().filter_map(Result::ok).collect())
        } else {
            Err(gaps.join("\n"))
        }
    }

    pub(crate) fn validate_coverage_entry(
        &self,
        requirement: &crate::agents::protocol::UserRequirement,
        entry: &super::main_agent_contract::ActionCoverage,
    ) -> Result<BTreeMap<String, String>, String> {
        use crate::agents::protocol::RequirementEffect;
        let versions = self.validate_requirement_actions(requirement, &entry.audit_ids)?;
        if requirement
            .semantics
            .as_ref()
            .and_then(|s| s.expected_effect)
            != Some(RequirementEffect::DesktopInteraction)
        {
            if !entry.desktop_results.is_empty() {
                return Err("desktop_results only applies to desktop_interaction; it cannot replace external delivery evidence".into());
            }
            return Ok(versions);
        }
        if entry.desktop_results.is_empty() {
            return Err("desktop_interaction needs desktop_results binding the actual action to its observed after-state".into());
        }
        let mut covered = HashSet::new();
        for result in &entry.desktop_results {
            if result.summary.trim().is_empty() || result.summary.chars().count() > 2000 {
                return Err(
                    "desktop result needs a concrete visual summary of 1 to 2000 characters".into(),
                );
            }
            let ids =
                self.resolve_audit_ids(&[result.action_id.clone(), result.observation_id.clone()])?;
            if ids.iter().any(|id| !entry.audit_ids.contains(id)) {
                return Err("desktop result references evidence absent from its audit_ids".into());
            }
            let action = &self.action_facts.action_index[&ids[0]];
            let observed = &self.action_facts.action_index[&ids[1]];
            if !desktop_input_tool(&action.tool_name) || action.outcome != ToolAuditOutcome::Success
            {
                return Err("desktop result requires a successful audited input, not a read, error or unknown action".into());
            }
            let before = action.desktop_observation.as_ref().ok_or("desktop action lacks trusted window/image evidence; do not replay it to repair a missing receipt")?;
            let after = observed
                .desktop_observation
                .as_ref()
                .ok_or("desktop result lacks a trusted after-image")?;
            if before.resource() != after.resource() || observed.completed_at < action.completed_at
            {
                return Err(
                    "desktop after-image belongs to another window or predates the action".into(),
                );
            }
            // A direct after-image remains evidence of that observed event even if
            // later navigation checks a different subgoal (for example a saved draft).
            // An intervening input cannot borrow an older action's identity.
            if self.action_facts.action_index.values().any(|middle| {
                middle.completed_at > action.completed_at
                    && middle.completed_at < observed.completed_at
                    && desktop_input_tool(&middle.tool_name)
            }) {
                return Err("another desktop input intervened; bind the result to the action that produced this after-state".into());
            }
            covered.insert(after.resource());
        }
        let semantics = requirement
            .semantics
            .as_ref()
            .ok_or("requirement semantics are unknown")?;
        if semantics.target_resources.is_empty() {
            return Err("desktop_interaction has no target resource; inspect exposes exact desktop:PID/HWND identities for the actual audited windows".into());
        }
        let uncovered = semantics
            .target_resources
            .iter()
            .filter(|target| !covered.contains(*target))
            .collect::<Vec<_>>();
        if !uncovered.is_empty() {
            let mut observed = covered.into_iter().collect::<Vec<_>>();
            observed.sort();
            return Err(format!(
                "desktop results do not cover targets {uncovered:?}; audited after-images cover {observed:?}. Desktop evidence certifies exact desktop:PID/HWND resources, not file resources. The contract supports separate requirements for different effects; a file write is not evidence that a requested desktop check succeeded."
            ));
        }
        Ok(versions)
    }

    pub(crate) fn validate_requirement_actions(
        &self,
        requirement: &crate::agents::protocol::UserRequirement,
        audit_ids: &[String],
    ) -> Result<BTreeMap<String, String>, String> {
        use crate::agents::protocol::RequirementEffect;
        let semantics = requirement
            .semantics
            .as_ref()
            .ok_or("requirement semantics are unknown")?;
        let effect = semantics
            .expected_effect
            .ok_or("requirement expected effect is unknown. Do not repeat propose_coverage with different receipts. First call task_contract revise: set this requirement semantics.expected_effect to observation, workspace_change, execution, memory_update, external_effect, or desktop_interaction according to the original goal; preserve its content and source_message_id. For external_effect, target_resources must be the external resource IDs from the host receipt, not local file paths. Then propose coverage with the NEW requirement_revision returned by revise and exact audit IDs from inspect.")?;
        if audit_ids.is_empty() {
            return Err("coverage requires specific audited actions".to_string());
        }
        let selected = audit_ids
            .iter()
            .map(|id| {
                self.action_facts.action_index.get(id).ok_or_else(|| {
                    format!("audit {id} does not belong to the current task evidence")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if selected.iter().any(|action| {
            !matches!(
                action.outcome,
                ToolAuditOutcome::Success | ToolAuditOutcome::ToolError
            )
        }) {
            return Err(
                "coverage cites an unresolved, cancelled, or unexecuted action".to_string(),
            );
        }
        let targets = semantics
            .target_resources
            .iter()
            .map(|target| normalized_resource(&self.action_facts.validation_cwd, target))
            .collect::<Vec<_>>();
        let mut versions = BTreeMap::new();
        let mut gaps = Vec::new();
        match effect {
            RequirementEffect::WorkspaceChange => {
                if targets.is_empty() {
                    return Err("workspace delivery has no bound target resource".to_string());
                }
                // Several selected edits can legitimately supersede one another.
                // Verify the newest selected receipt for each path, not every old
                // version; an unselected or external later edit still fails the hash check.
                let mut latest = BTreeMap::new();
                for action in &selected {
                    if action.outcome != ToolAuditOutcome::Success {
                        continue;
                    }
                    for changed in &action.changed_paths {
                        let resource =
                            normalized_resource(&self.action_facts.validation_cwd, changed);
                        let entry = latest.entry(resource).or_insert(*action);
                        if action.completed_at > entry.completed_at {
                            *entry = *action;
                        }
                    }
                }
                for target in &targets {
                    let mut matched = false;
                    for (resource, action) in &latest {
                        if !resource_within(resource, target) {
                            continue;
                        }
                        matched = true;
                        let Some(version) = action
                            .resource_versions
                            .iter()
                            .find(|(path, _)| {
                                normalized_resource(&self.action_facts.validation_cwd, path)
                                    == *resource
                            })
                            .map(|(_, version)| version)
                        else {
                            gaps.push(format!("changed resource {resource} has no version captured by its tool receipt"));
                            continue;
                        };
                        match verify_current_resource(resource, version) {
                            Ok(()) => {
                                versions.insert(resource.clone(), version.clone());
                            }
                            Err(gap) => gaps.push(gap),
                        }
                    }
                    if !matched {
                        gaps.push(format!(
                            "no selected successful action changed target {target}"
                        ));
                    }
                }
            }
            RequirementEffect::Execution => {
                if requirement.execution_obligations.is_empty() {
                    return Err("execution coverage has no bound command requirement; revise it with execution_obligations before selecting receipts".to_string());
                }
                let observations = self
                    .action_facts
                    .validation_observations
                    .iter()
                    .filter(|observation| audit_ids.contains(&observation.audit_id))
                    .collect::<Vec<_>>();
                if observations.is_empty() {
                    return Err(
                        "execution coverage has no audited invocation and exit code".to_string()
                    );
                }
            }
            RequirementEffect::Observation => {
                let current =
                    selected
                        .iter()
                        .copied()
                        .filter(|action| {
                            if let Some(desktop) = &action.desktop_observation {
                                // A later desktop input invalidates earlier screen evidence,
                                // including when the input outcome is uncertain.
                                return !self.action_facts.action_index.values().any(|later| {
                                    later.completed_at > action.completed_at
                                        && later.tool_name.starts_with("qwen_computer::")
                                        && (later.desktop_observation.as_ref().is_some_and(
                                            |next| next.resource() == desktop.resource(),
                                        ) || !matches!(
                                            later.tool_name.as_str(),
                                            "qwen_computer::list_apps"
                                                | "qwen_computer::get_app_state"
                                        ))
                                });
                            }
                            action.observation
                        })
                        .collect::<Vec<_>>();
                if current.is_empty() {
                    return Err("observation coverage requires a current audited read or diagnostic receipt; use the latest after-state for desktop observations".to_string());
                }
                for target in &semantics.target_resources {
                    let file_target =
                        normalized_resource(&self.action_facts.validation_cwd, target);
                    if !current.iter().any(|action| {
                        if let Some(desktop) = &action.desktop_observation {
                            return desktop.matches_target(target);
                        }
                        action
                            .observed_resources
                            .iter()
                            .any(|resource| resource_within(resource, &file_target))
                    }) {
                        gaps.push(format!(
                            "selected observations do not refer to target {target}"
                        ));
                    }
                }
            }
            RequirementEffect::MemoryUpdate => {
                for action in &selected {
                    if let Some((resource, version)) = &action.memory_effect {
                        versions.insert(resource.clone(), version.clone());
                    }
                }
                if versions.is_empty() {
                    return Err(
                        "memory coverage lacks a successful memory-owner mutation receipt"
                            .to_string(),
                    );
                }
                for target in &semantics.target_resources {
                    if !versions.contains_key(target) {
                        gaps.push(format!(
                            "memory-owner receipt does not identify target {target}"
                        ));
                    }
                }
            }
            RequirementEffect::DesktopInteraction => {
                // The complete action/result contract is checked by validate_coverage_entry.
            }
            RequirementEffect::ExternalEffect => {
                for action in &selected {
                    if let Some((resource, version)) = &action.external_effect {
                        versions.insert(resource.clone(), version.clone());
                    }
                }
                if versions.is_empty() {
                    return Err("external-effect coverage lacks a supported owner-confirmed postcondition receipt. Desktop inputs and screenshots alone do not confirm external delivery. Preserve the sending requirement and use report_blocked when no supported confirmation is available; do not replay the action or relabel sending as observation".to_string());
                }
                for target in &semantics.target_resources {
                    if !versions.contains_key(target) {
                        gaps.push(format!(
                            "external owner receipt does not identify target {target}"
                        ));
                    }
                }
            }
        }
        for obligation in &requirement.execution_obligations {
            if !self
                .observation_for_obligation(obligation)
                .is_some_and(|observation| audit_ids.contains(&observation.audit_id))
            {
                gaps.push(format!(
                    "selected actions do not satisfy execution obligation {}",
                    obligation.obligation_id
                ));
            }
        }
        if gaps.is_empty() {
            Ok(versions)
        } else {
            gaps.sort();
            gaps.dedup();
            Err(gaps.join("\n"))
        }
    }

    #[cfg(test)]
    pub fn from_history(messages: &[Message]) -> Self {
        Self::from_history_in_scope(messages, None)
    }

    pub fn from_history_in_scope(
        messages: &[Message],
        task_scope: Option<&CodeProTaskScope>,
    ) -> Self {
        let mut progress = Self {
            action_facts: MainAgentActionFacts::for_scope(task_scope),
            ..Self::default()
        };
        // A durable task is identified by its audited run/task digest, not by
        // the latest user utterance. An amendment must not erase valid prior
        // receipts from the same run; resource versions are checked at use.
        let start = if task_scope.is_some() {
            0
        } else {
            goal_source_index(messages).unwrap_or(0)
        };
        let mut requests = std::collections::HashMap::new();
        for message in &messages[start..] {
            for content in &message.content {
                match content {
                    MessageContent::ToolRequest(request) => {
                        requests.insert(request.id.as_str(), request);
                    }
                    MessageContent::ToolResponse(response) => {
                        if let Some(request) = requests.get(response.id.as_str()) {
                            progress.observe(request, response);
                        }
                    }
                    _ => {}
                }
            }
        }
        progress.progress_at_extension = progress.distinct_successes.len();
        progress.failed_calls.clear();
        progress.repeated_failures = 0;
        progress
    }

    pub fn observe(&mut self, request: &ToolRequest, response: &ToolResponse) {
        if !self
            .observed_terminal_request_ids
            .insert(request.id.to_string())
        {
            tracing::warn!(
                request_id = %request.id,
                "duplicate terminal tool response ignored"
            );
            return;
        }
        let Ok(call) = request.tool_call.as_ref() else {
            return;
        };
        let name = call.name.as_ref();
        // Public commentary has no execution effect and must not reset failure
        // accounting or become delivery evidence.
        if name == super::main_agent_contract::PROGRESS_TOOL_NAME {
            return;
        }
        let arguments = Value::Object(call.arguments.clone().unwrap_or_default());
        let audit_receipt = match &response.tool_result {
            Ok(result) => trusted_tool_audit_from_result(result),
            Err(error) => trusted_tool_audit_from_error(error),
        };
        if self.action_facts.expected_task_scope_digest.is_some()
            && audit_receipt.as_ref().is_some_and(|receipt| {
                receipt.task_scope_digest != self.action_facts.expected_task_scope_digest
            })
        {
            // A different run's failure must not poison this task on history replay.
            return;
        }
        if let Some(audit_receipt) = audit_receipt.as_ref() {
            self.action_facts
                .observe(request, audit_receipt, &response.tool_result);
        }
        let receipt = action_result_body(&response.tool_result);
        let unverified = receipt.as_ref().is_some_and(tool_receipt_is_unverified);
        let trusted_shell = audit_receipt.as_ref().is_some_and(|audit| {
            audit.extension_source == ToolAuditExtensionSource::Platform
                && audit.tool_name == "developer::shell"
        });
        let known_shell_failure = trusted_shell
            && receipt.as_ref().is_some_and(|body| {
                body["output_truncated"] != true
                    && (body.get("exit_code").and_then(Value::as_i64).is_some()
                        || ((body["timed_out"] == true || body["cancelled"] == true)
                            && body["termination_confirmed"] == true))
            });
        let audit_unverified = audit_receipt.as_ref().is_some_and(|receipt| {
            match receipt.outcome {
                ToolAuditOutcome::Ambiguous | ToolAuditOutcome::ReplaySuppressed => true,
                ToolAuditOutcome::TimedOut | ToolAuditOutcome::Cancelled => {
                    // An outer deadline remains a failed execution. Only the
                    // same trusted shell's explicit cleanup facts settle whether
                    // it is still running; a late exit code alone is insufficient.
                    !(trusted_shell
                        && action_result_body(&response.tool_result)
                            .and_then(|body| {
                                serde_json::from_value::<
                                    super::platform_extensions::developer::shell::ShellOutput,
                                >(body)
                                .ok()
                            })
                            .is_some_and(|body| {
                                body.termination_confirmed == Some(true)
                                    && !body.output_truncated
                                    && (body.timed_out || body.cancelled)
                            }))
                }
                _ => false,
            }
        });
        let shell_outcome_unknown = trusted_shell
            && receipt.as_ref().is_some_and(|body| {
                // A parent exit code does not settle a child still holding its
                // pipes. Keep this distinct from ordinary output-size truncation.
                body["output_truncated"] == true
                    || ((body["timed_out"] == true || body["cancelled"] == true)
                        && body["termination_confirmed"] != true)
            });
        let known_git_conflict = audit_receipt.as_ref().is_some_and(|receipt| {
            receipt.tool_name == "local_git::git_merge"
                && receipt.outcome == ToolAuditOutcome::ToolError
        }) && response
            .tool_result
            .as_ref()
            .is_ok_and(super::git_mcp::known_conflict);
        let failed_workspace_effect = audit_receipt.as_ref().is_some_and(|receipt| {
            receipt.outcome != ToolAuditOutcome::Success
                && !known_shell_failure
                && !known_git_conflict
                && trusted_workspace_delta_from_tool_result(&response.tool_result)
                    .is_some_and(|changed_paths| !changed_paths.is_empty())
        });
        let computer_tool_name = name
            .rsplit("::")
            .next()
            .unwrap_or(name)
            .rsplit("__")
            .next()
            .unwrap_or(name);
        let read_only_computer_call = audit_receipt.as_ref().is_some_and(|audit| {
            audit.extension_source == ToolAuditExtensionSource::Builtin
                && matches!(
                    audit.tool_name.as_str(),
                    "qwen_computer::get_app_state" | "qwen_computer::list_apps"
                )
        }) || matches!(
            computer_tool_name,
            "computer_observe"
                | "computer_observe_ui"
                | "computer_search_ui"
                | "computer_inspect_ui"
                | "computer_screenshot"
                | "computer_wait"
        );
        if !read_only_computer_call
            && (audit_unverified
                || failed_workspace_effect
                || shell_outcome_unknown
                || receipt
                    .as_ref()
                    .is_some_and(|value| value["outcome"] == "unknown"))
        {
            // A later successful action cannot adjudicate an earlier uncertain side effect.
            // Keep the request reference across history replay until a bound verifier exists.
            self.unverified_actions
                .insert((request.id.to_string(), name.to_string()));
        }
        // Only the process owner can settle an uncertain stop of that same
        // group. A successful HTTP request or the user's confirmation cannot.
        if trusted_shell
            && !audit_unverified
            && response
                .tool_result
                .as_ref()
                .is_ok_and(|result| result.is_error != Some(true))
        {
            if let Some(process) = receipt
                .as_ref()
                .and_then(|body| body.get("managed_process"))
            {
                if process["schema_version"] == 1
                    && matches!(process["state"].as_str(), Some("exited" | "stopped"))
                {
                    if let Some(handle) = process["handle"]
                        .as_str()
                        .filter(|handle| !handle.is_empty())
                    {
                        let resolved: HashSet<_> = self
                            .action_facts
                            .action_index
                            .values()
                            .filter_map(|action| {
                                let original = action.shell_outcome.as_ref()?;
                                (original["managed_process_operation"] == "stop"
                                    && original["managed_process"]["handle"] == handle
                                    && original["managed_process"]["cwd"] == process["cwd"])
                                    .then(|| action.call_id.clone())
                            })
                            .collect();
                        self.unverified_actions
                            .retain(|(id, _)| !resolved.contains(id));
                    }
                }
            }
        }
        let mut fingerprint_arguments = arguments.clone();
        if let Some(fields) = fingerprint_arguments.as_object_mut() {
            for key in ["trace", "request_id", "requestId", "timeout_secs"] {
                fields.remove(key);
            }
            // This pre-input rejection has no structured category yet. A new screenshot
            // cannot repair normalized coordinates outside the fixed 0..1000 range.
            if matches!(
                computer_tool_name,
                "computer_move" | "computer_click" | "computer_drag" | "computer_scroll"
            ) && fields.get("coordinate_space").and_then(Value::as_str)
                == Some("screenshot_normalized_1000")
                && response.tool_result.as_ref().is_ok_and(|result| {
                    result.is_error == Some(true)
                        && result.content.len() == 1
                        && matches!(
                            &result.content[0].raw,
                            rmcp::model::RawContent::Text(text)
                                if text.text == "归一化截图坐标必须位于 0..1000"
                        )
                })
            {
                fields.remove("screenshot_id");
            }
        }
        let fingerprint =
            *blake3::hash(format!("{name}:{fingerprint_arguments}").as_bytes()).as_bytes();
        if !read_only_computer_call
            && (unverified
                || audit_unverified
                || response
                    .tool_result
                    .as_ref()
                    .map_or(true, |result| result.is_error == Some(true)))
        {
            let count = self.failed_calls.entry(fingerprint).or_default();
            *count = count.saturating_add(1);
            self.repeated_failures = *count;
        } else if !read_only_computer_call {
            self.failed_calls.remove(&fingerprint);
            self.repeated_failures = 0;
        }
        let argument_text = arguments.to_string().to_lowercase();
        let is_send = name == "computer_send_message"
            || ((name.starts_with("computercontroller::")
                || name.starts_with("computercontroller__"))
                && ["send", "发送", "发消息", "press('enter", "press(\"enter"]
                    .iter()
                    .any(|s| argument_text.contains(s)));
        self.delivery_attempted |= is_send || name == "computer_prepare_message";
        self.send_attempts += usize::from(is_send);
        let Ok(result) = response.tool_result.as_ref() else {
            return;
        };
        if audit_receipt
            .as_ref()
            .is_some_and(|receipt| !matches!(receipt.outcome, ToolAuditOutcome::Success))
        {
            return;
        }
        if result.is_error == Some(true) {
            return;
        }
        if unverified {
            return;
        }
        self.successful_tools += 1;
        if name == "computer_send_message" {
            if let Some(receipt) = receipt.as_ref() {
                let verified = receipt["outcome"] == "worked"
                    && receipt["recipient"].as_str().is_some_and(|s| !s.is_empty())
                    && receipt["message_sha256"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
                    && receipt["verification"]["matched"] == true;
                self.verified_sends += usize::from(verified);
                self.delivery_verified =
                    self.verified_sends > 0 && self.verified_sends == self.send_attempts;
            }
        }
        if read_only_computer_call
            || name.contains("wait")
            || name.contains("poll")
            || name.ends_with("status")
            || name.ends_with("screenshot")
            || name.ends_with("observe")
        {
            return;
        }
        let mut arguments = arguments;
        if let Value::Object(fields) = &mut arguments {
            for key in ["trace", "state_id", "snapshot_id", "request_id"] {
                fields.remove(key);
            }
        }
        self.distinct_successes
            .insert(*blake3::hash(format!("{name}:{arguments}").as_bytes()).as_bytes());
    }

    pub fn take_new_progress(&mut self) -> bool {
        let count = self.distinct_successes.len();
        let progressed = count > self.progress_at_extension;
        self.progress_at_extension = count;
        progressed
    }

    pub fn repeating_failed_call(&self) -> bool {
        self.repeated_failures >= 3
    }

    pub fn needs_failure_review(&self) -> bool {
        self.repeated_failures == 2
    }

    pub fn unverified_delivery(&self) -> bool {
        self.delivery_attempted
            && (!self.delivery_verified || self.verified_sends != self.send_attempts)
    }

    #[cfg(test)]
    pub fn has_unverified_result(&self) -> bool {
        self.successful_tools == 0
            || !self.unverified_actions.is_empty()
            || self.unverified_delivery()
    }

    pub(crate) fn minimum_completion_evidence_satisfied(&self, task_kind: CodeProTaskKind) -> bool {
        if !self.unverified_actions.is_empty()
            || !self.referenced_unresolved_actions.is_empty()
            || self
                .unavailable_delegated_evidence
                .keys()
                .any(|id| id.starts_with("continuation:"))
            || self.unverified_delivery()
        {
            return false;
        }
        match task_kind {
            CodeProTaskKind::ToolAction => self.successful_tools > 0,
            CodeProTaskKind::FocusedTest | CodeProTaskKind::ProjectTest => {
                self.action_facts.latest_validation_passed()
            }
            CodeProTaskKind::SimpleChange
            | CodeProTaskKind::BugFix
            | CodeProTaskKind::ComplexChange => {
                if self.action_facts.has_workspace_write() {
                    !self.action_facts.has_validation_observation()
                        || self.action_facts.latest_validation_passed()
                } else {
                    self.action_facts.has_validation_observation()
                }
            }
            CodeProTaskKind::Conversation | CodeProTaskKind::ReadOnly => true,
        }
    }

    pub(crate) fn completion_gaps(&self, task_kind: CodeProTaskKind) -> Vec<String> {
        let mut gaps = Vec::new();
        if self.unverified_delivery() {
            gaps.push("outgoing delivery has no recipient-bound success evidence".to_string());
        }
        if !self.unverified_actions.is_empty() || !self.referenced_unresolved_actions.is_empty() {
            // Consume the same owner-derived recovery details as inspect,
            // rather than making the model reconstruct them from a bare ID.
            for action in self.unresolved_action_index() {
                gaps.push(format!(
                    "tool action result remains unknown: {} ({}, source run {}). {}",
                    action["toolName"].as_str().unwrap_or_default(),
                    action["callId"].as_str().unwrap_or_default(),
                    action["sourceRunId"].as_str().unwrap_or("current"),
                    action["nextStep"].as_str().unwrap_or_default(),
                ));
            }
        }
        gaps.extend(
            self.unavailable_delegated_evidence
                .iter()
                .filter(|(id, _)| id.starts_with("continuation:"))
                .map(|(id, reason)| format!("source evidence unavailable ({id}): {reason}")),
        );
        if !gaps.is_empty() {
            return gaps;
        }
        match task_kind {
            CodeProTaskKind::ToolAction if self.successful_tools == 0 => {
                gaps.push("no successful audited tool action exists for this task".to_string());
            }
            CodeProTaskKind::FocusedTest | CodeProTaskKind::ProjectTest
                if !self.action_facts.latest_validation_passed() =>
            {
                gaps.push(
                    "no successful audited validation receipt with exit code 0 exists for this task"
                        .to_string(),
                );
            }
            CodeProTaskKind::SimpleChange
            | CodeProTaskKind::BugFix
            | CodeProTaskKind::ComplexChange
                if !self.action_facts.has_workspace_write()
                    && !self.action_facts.has_validation_observation() =>
            {
                gaps.push(
                    "no audited workspace file delta or validation observation exists for the requested change"
                        .to_string(),
                );
            }
            CodeProTaskKind::SimpleChange
            | CodeProTaskKind::BugFix
            | CodeProTaskKind::ComplexChange
                if self.action_facts.has_workspace_write()
                    && self.action_facts.has_validation_observation()
                    && !self.action_facts.latest_validation_passed() =>
            {
                gaps.push(
                    "workspace files changed but the latest audited validation exited unsuccessfully"
                        .to_string(),
                );
            }
            _ => {}
        }
        gaps
    }

    pub(crate) fn completion_state_fingerprint(&self) -> [u8; 32] {
        if !self.unverified_actions.is_empty() {
            // Unrelated successful probes do not repair an unresolved owner
            // outcome. Only changing that set counts as progress on this gap.
            let unresolved = self
                .unverified_actions
                .iter()
                .collect::<std::collections::BTreeSet<_>>();
            return *blake3::hash(&serde_json::to_vec(&unresolved).unwrap_or_default()).as_bytes();
        }
        // Completion retries track material progress, not receipt volume. A
        // repeated read creates a new audit ID but does not resolve the same
        // completion gap. Keep raw IDs in action_evidence() for forensics.
        let validations = self
            .action_facts
            .validation_observations
            .iter()
            .filter_map(|observation| {
                serde_json::to_vec(&(&observation.invocation, observation.exit_code)).ok()
            })
            .collect::<std::collections::BTreeSet<_>>();
        let unresolved_tools = self
            .unverified_actions
            .iter()
            .map(|(_, tool)| tool.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let state = serde_json::json!({
            "taskScope": self.action_facts.expected_task_scope_digest,
            "workspaceWriteEffects": self.action_facts.workspace_write_action_ids.len(),
            "validations": validations,
            "unresolvedTools": unresolved_tools,
            "deliveryAttempted": self.delivery_attempted,
            "deliveryVerified": self.delivery_verified,
        });
        *blake3::hash(&serde_json::to_vec(&state).unwrap_or_default()).as_bytes()
    }

    pub(crate) fn action_evidence(&self) -> MainAgentActionEvidenceV1 {
        fn sorted(values: &HashSet<String>) -> Vec<String> {
            let mut values = values.iter().cloned().collect::<Vec<_>>();
            values.sort_unstable();
            values
        }

        MainAgentActionEvidenceV1 {
            schema_version: 1,
            task_scope_digest: self.action_facts.expected_task_scope_digest.clone(),
            audited_action_ids: sorted(&self.action_facts.audited_action_ids),
            successful_action_ids: sorted(&self.action_facts.successful_action_ids),
            workspace_write_action_ids: sorted(&self.action_facts.workspace_write_action_ids),
            validation_action_ids: sorted(&self.action_facts.validation_action_ids),
            passed_validation_action_ids: sorted(&self.action_facts.passed_validation_action_ids),
            failed_validation_action_ids: sorted(&self.action_facts.failed_validation_action_ids),
            validation_observations: self.action_facts.validation_observations.clone(),
            last_validation_succeeded: self.action_facts.last_validation_succeeded,
            successful_tool_count: self.successful_tools,
            unverified_action_count: self.unverified_actions.len(),
            delivery_attempted: self.delivery_attempted,
            delivery_verified: self.delivery_verified,
            action_index: self.action_facts.action_index.clone(),
        }
    }

    pub fn checked_final_text(&self, task_kind: CodeProTaskKind, text: &str) -> String {
        if self.unverified_delivery() {
            NO_DELIVERY_PROOF.to_string()
        } else if !self.unverified_actions.is_empty() {
            let mut tools = self
                .unverified_actions
                .iter()
                .map(|(_, name)| name.as_str())
                .collect::<Vec<_>>();
            tools.sort_unstable();
            tools.dedup();
            format!("任务尚未完成：{} 的动作结果仍未确认，动作可能已经生效。尚缺少与原动作绑定的独立核验回执，普通观察或后续操作成功不能替代；请勿盲目重做。原任务与工具记录已保留。", tools.join("、"))
        } else {
            match task_kind {
                CodeProTaskKind::ToolAction
                    if !self.minimum_completion_evidence_satisfied(task_kind) =>
                {
                    NO_VERIFIED_RESULT.to_string()
                }
                CodeProTaskKind::FocusedTest | CodeProTaskKind::ProjectTest
                    if !self.minimum_completion_evidence_satisfied(task_kind) =>
                {
                    NO_VALIDATION_OBSERVATION.to_string()
                }
                CodeProTaskKind::SimpleChange
                | CodeProTaskKind::BugFix
                | CodeProTaskKind::ComplexChange
                    if !self.minimum_completion_evidence_satisfied(task_kind) =>
                {
                    NO_CHANGE_OBSERVATION.to_string()
                }
                _ => text.to_string(),
            }
        }
    }

    pub(crate) fn observation_for_obligation(
        &self,
        obligation: &crate::agents::protocol::ExecutionObligation,
    ) -> Option<&ValidationObservationV1> {
        let matches = |invocation: &ValidationInvocation| {
            if obligation.allow_equivalent_invocation {
                invocation.validation_identity() == obligation.invocation.validation_identity()
            } else {
                invocation.exact_match(&obligation.invocation)
            }
        };
        let latest_action = self
            .action_facts
            .action_index
            .iter()
            .filter(|(_, action)| action.invocation.as_ref().is_some_and(&matches))
            .max_by_key(|(_, action)| action.completed_at)
            .map(|(id, _)| id);
        self.action_facts
            .validation_observations
            .iter()
            .rev()
            .find(|observation| {
                matches(&observation.invocation)
                    && latest_action.is_none_or(|id| *id == observation.audit_id)
            })
            .filter(|observation| {
                obligation.evidence_requirement
                    == crate::agents::protocol::EvidenceRequirement::ExitCodeObserved
                    || observation.exit_code == 0
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::extension_manager::{
        insert_trusted_tool_audit_meta, insert_trusted_workspace_delta_meta,
    };
    use crate::agents::tool_audit::{
        ToolAuditActor, ToolAuditAuthorization, ToolAuditExtensionSource, ToolAuditPermissionClass,
    };
    use rmcp::model::{CallToolRequestParams, CallToolResult, Content};

    #[test]
    fn r3_completion_progress_ignores_repeat_read_audits_but_not_effects() {
        let mut progress = ToolTaskProgress::default();
        let initial = progress.completion_state_fingerprint();
        progress
            .action_facts
            .audited_action_ids
            .insert("read-1".to_string());
        progress
            .action_facts
            .successful_action_ids
            .insert("read-1".to_string());
        progress.successful_tools = 1;
        assert_eq!(progress.completion_state_fingerprint(), initial);
        progress
            .action_facts
            .audited_action_ids
            .insert("read-2".to_string());
        progress.successful_tools = 2;
        assert_eq!(progress.completion_state_fingerprint(), initial);
        progress
            .action_facts
            .workspace_write_action_ids
            .insert("write-1".to_string());
        assert_ne!(progress.completion_state_fingerprint(), initial);
    }

    #[test]
    fn unified_turn_resume_keeps_original_goal_and_uses_a_new_turn_id() {
        let user = Message::user()
            .with_text("调用 analyze")
            .with_generated_id();
        let mut data = ExtensionData::default();
        save_unified_intent(&mut data, &[], &user, "D:/project", "tool_action");
        for status in ["paused", "finished"] {
            data.extension_states
                .get_mut("codepro_unified_turn.v1")
                .unwrap()["status"] = serde_json::json!(status);
            assert_eq!(
                saved_unified_intent(&data, std::slice::from_ref(&user), "D:/project"),
                Some(CodeProIntent::ToolAction)
            );
        }
        let resume = Message::user().with_text("继续").with_generated_id();
        save_unified_intent(
            &mut data,
            std::slice::from_ref(&user),
            &resume,
            "D:/project",
            "tool_action",
        );
        let saved = data
            .get_extension_state("codepro_unified_turn", "v1")
            .unwrap();
        assert_eq!(saved["source_message_id"].as_str(), user.id.as_deref());
        assert_eq!(saved["turn_id"].as_str(), resume.id.as_deref());
        assert_eq!(saved["goal"], "调用 analyze");
        assert_eq!(saved["status"], "running");
    }

    fn call(name: &str, path: &str) -> ToolRequest {
        ToolRequest {
            id: "call".into(),
            tool_call: Ok(CallToolRequestParams::new(name.to_string()).with_arguments(
                serde_json::json!({"path":path})
                    .as_object()
                    .unwrap()
                    .clone(),
            )),
            metadata: None,
            tool_meta: None,
        }
    }
    fn response() -> ToolResponse {
        ToolResponse {
            id: "call".into(),
            tool_result: Ok(CallToolResult::success(vec![Content::text("ok")])),
            metadata: None,
        }
    }

    fn native_call(id: &str, name: &str, arguments: Value) -> ToolRequest {
        ToolRequest {
            id: id.into(),
            tool_call: Ok(CallToolRequestParams::new(name.to_string())
                .with_arguments(arguments.as_object().unwrap().clone())),
            metadata: None,
            tool_meta: None,
        }
    }

    // Distinct retries have distinct protocol IDs. Reusing one ID represents
    // replay of the same terminal receipt, which the production tracker deduplicates.
    fn observe_attempt(
        progress: &mut ToolTaskProgress,
        request: &ToolRequest,
        response: &ToolResponse,
    ) {
        let id = uuid::Uuid::new_v4().to_string();
        let mut request = request.clone();
        let mut response = response.clone();
        request.id = id.clone();
        response.id = id;
        progress.observe(&request, &response);
    }

    fn audited_result(
        id: &str,
        tool_name: &str,
        permission_class: ToolAuditPermissionClass,
        changed_paths: &[&str],
        outcome: ToolAuditOutcome,
    ) -> ToolResponse {
        let now = chrono::Utc::now();
        let receipt = ToolAuditReceipt {
            schema_version: 2,
            audit_id: format!("audit-{id}"),
            actor: ToolAuditActor::Primary,
            effective_model: "test/model".to_string(),
            extension_source: ToolAuditExtensionSource::Platform,
            tool_name: tool_name.to_string(),
            permission_class,
            authorization: ToolAuditAuthorization::PolicyAllowed,
            outcome,
            failure_kind: None,
            task_scoped: false,
            task_scope_digest: None,
            started_at: now,
            completed_at: now,
            duration_ms: 1,
        };
        let mut result = if outcome == ToolAuditOutcome::Success {
            CallToolResult::success(vec![Content::text("ok")])
        } else {
            CallToolResult::error(vec![Content::text("tool reported an error")])
        };
        insert_trusted_tool_audit_meta(&mut result, &receipt);
        insert_trusted_workspace_delta_meta(
            &mut result,
            &changed_paths
                .iter()
                .map(|path| (*path).to_string())
                .collect::<Vec<_>>(),
        );
        ToolResponse {
            id: id.into(),
            tool_result: Ok(result),
            metadata: None,
        }
    }

    fn audited_success(
        id: &str,
        tool_name: &str,
        permission_class: ToolAuditPermissionClass,
        changed_paths: &[&str],
    ) -> ToolResponse {
        audited_result(
            id,
            tool_name,
            permission_class,
            changed_paths,
            ToolAuditOutcome::Success,
        )
    }

    #[test]
    fn bounded_shell_cleanup_settles_execution_only_and_survives_history_replay() {
        use crate::agents::extension_manager::{
            insert_trusted_tool_audit_error, TRUSTED_TOOL_UPDATE_META_KEY,
        };
        for (confirmed, truncated, external, outcome_unknown, expected_unknown) in [
            (Some(true), false, false, false, false),
            (Some(false), false, false, false, true),
            (None, false, false, false, true),
            (Some(true), true, false, false, true),
            (Some(true), false, true, false, true),
            (Some(true), false, false, true, true),
        ] {
            let audited = audited_result(
                "timeout",
                "developer::shell",
                ToolAuditPermissionClass::WorkspaceWrite,
                &["partial.json"],
                ToolAuditOutcome::TimedOut,
            );
            let mut audit =
                trusted_tool_audit_from_result(audited.tool_result.as_ref().unwrap()).unwrap();
            if external {
                audit.extension_source = ToolAuditExtensionSource::ExternalStdio;
            }
            let mut cleanup = CallToolResult::error(vec![]);
            cleanup.structured_content = Some(serde_json::json!({
                "stdout":"partial output", "stderr":"",
                "cancelled":true, "termination_confirmed":confirmed, "output_truncated":truncated,
                // Adversarial late exit code must not become passed validation.
                "exit_code":0, "outcome":if outcome_unknown {"unknown"} else {"cancelled"},
            }));
            // The real shell omits false booleans. Replay must honor its schema,
            // not require fields that its serializer intentionally leaves out.
            if !truncated {
                cleanup
                    .structured_content
                    .as_mut()
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove("output_truncated");
            }
            let error = rmcp::model::ErrorData::new(
                rmcp::model::ErrorCode::INTERNAL_ERROR,
                "host timeout",
                Some(
                    serde_json::json!({"codepro_bounded_execution":{"schema_version":1,"cleanup_result":{"Ok":cleanup}}}),
                ),
            );
            let mut error = insert_trusted_tool_audit_error(error, &audit);
            error.data.as_mut().unwrap()[TRUSTED_TOOL_UPDATE_META_KEY]["workspaceDelta"] = audited
                .tool_result
                .as_ref()
                .unwrap()
                .meta
                .as_ref()
                .unwrap()
                .0[TRUSTED_TOOL_UPDATE_META_KEY]["workspaceDelta"]
                .clone();
            let request = native_call(
                "timeout",
                "shell",
                serde_json::json!({"command":"python test.py"}),
            );
            let response = ToolResponse {
                id: "timeout".into(),
                tool_result: Err(error),
                metadata: None,
            };
            let mut progress = ToolTaskProgress::default();
            progress.observe(&request, &response);
            assert_eq!(progress.unresolved_action_count() > 0, expected_unknown);
            let fact = &progress.action_facts.action_index["audit-timeout"];
            assert_eq!(fact.outcome, ToolAuditOutcome::TimedOut);
            assert_eq!(fact.changed_paths, vec!["partial.json"]);
            assert!(progress.action_facts.successful_action_ids.is_empty());
            assert!(progress
                .action_facts
                .passed_validation_action_ids
                .is_empty());
            assert_eq!(fact.exit_code, None);
            let history = vec![
                Message::user().with_text("修复测试"),
                Message::assistant().with_tool_request("timeout", request.tool_call),
                Message::user().with_tool_response("timeout", response.tool_result),
            ];
            let history =
                serde_json::from_str::<Vec<Message>>(&serde_json::to_string(&history).unwrap())
                    .unwrap();
            let mut replayed = ToolTaskProgress::from_history(&history);
            assert_eq!(replayed.unresolved_action_count() > 0, expected_unknown);
            // A later valid observation cannot settle a genuinely unknown old
            // action. Conversely, a settled failure must not demand a dummy write.
            replayed.observe(
                &native_call(
                    "check",
                    "developer__read",
                    serde_json::json!({"path":"partial.json"}),
                ),
                &audited_success(
                    "check",
                    "developer::read",
                    ToolAuditPermissionClass::ReadOnly,
                    &[],
                ),
            );
            assert_eq!(
                replayed.minimum_completion_evidence_satisfied(CodeProTaskKind::ToolAction),
                !expected_unknown
            );
            assert_eq!(
                replayed.action_evidence().workspace_write_action_ids,
                vec!["audit-timeout"],
                "recovery must retain the partial write, not manufacture a new successful write"
            );
            let delivery = serde_json::from_value(serde_json::json!({
                "requirement_id":"delivery", "source_message_id":"user", "semantics":{
                    "content":"deliver partial.json", "expected_effect":"workspace_change", "target_resources":["partial.json"]}
            })).unwrap();
            assert!(
                replayed
                    .validate_requirement_actions(&delivery, &["audit-timeout".into()])
                    .is_err(),
                "termination confirmation cannot certify the partially written file"
            );
        }
    }

    #[test]
    fn second_repair_batch_workspace_permission_is_not_delivery_evidence() {
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "memory",
            "project_memory_remember",
            serde_json::json!({"fact":"blocked"}),
        );
        progress.observe(
            &request,
            &audited_success(
                "memory",
                "project_memory::project_memory_remember",
                ToolAuditPermissionClass::WorkspaceWrite,
                &[],
            ),
        );

        assert!(!progress.minimum_completion_evidence_satisfied(CodeProTaskKind::ComplexChange));
        assert!(progress
            .completion_gaps(CodeProTaskKind::ComplexChange)
            .iter()
            .any(|gap| gap.contains("workspace file delta")));
    }

    #[test]
    fn desktop_after_image_covers_only_current_window_observation_not_external_delivery() {
        use crate::agents::protocol::{RequirementEffect, RequirementSemantics, UserRequirement};
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "desktop",
            "qwen_computer__press_key",
            serde_json::json!({"app":"Calculator", "key":"Return"}),
        );
        let mut response = audited_success(
            "desktop",
            "qwen_computer::press_key",
            ToolAuditPermissionClass::HighRisk,
            &[],
        );
        let result = response.tool_result.as_mut().unwrap();
        let mut receipt = trusted_tool_audit_from_result(result).unwrap();
        receipt.extension_source = ToolAuditExtensionSource::Builtin;
        insert_trusted_tool_audit_meta(result, &receipt);
        result.content.push(Content::image("cGl4ZWxz", "image/png"));
        result.structured_content = Some(serde_json::json!({"desktop_observation":{
            "schema_version":1, "pid":42, "window_handle":101, "app_name":"Calculator",
            "bundle_identifier":"Calculator.App", "window_title":"计算器"
        }}));
        progress.observe(&request, &response);
        let mut requirement = UserRequirement {
            requirement_id: "screen".into(),
            source_message_id: "user".into(),
            continuation_source: None,
            execution_obligations: Vec::new(),
            semantics: Some(RequirementSemantics {
                content: "Read the computed result".into(),
                expected_effect: Some(RequirementEffect::Observation),
                target_resources: vec!["desktop:42/101".into()],
                revision_relation: None,
            }),
        };
        let ids = ["audit-desktop".into()];
        let index = progress.contract_action_index();
        assert_eq!(
            index["actions"]["audit-desktop"]["desktopObservation"]["window_handle"],
            101
        );
        assert_eq!(index["actions"]["audit-desktop"]["callId"], "desktop");
        for target in ["desktop:42/101", "Calculator", "计算器", "Calculator.App"] {
            requirement.semantics.as_mut().unwrap().target_resources = vec![target.into()];
            assert!(
                progress
                    .validate_requirement_actions(&requirement, &ids)
                    .is_ok(),
                "{target}"
            );
        }
        requirement.semantics.as_mut().unwrap().target_resources = vec!["desktop:99/101".into()];
        assert!(progress
            .validate_requirement_actions(&requirement, &ids)
            .is_err());
        requirement.semantics.as_mut().unwrap().target_resources = vec!["Calculator".into()];
        requirement.semantics.as_mut().unwrap().expected_effect =
            Some(RequirementEffect::ExternalEffect);
        assert!(progress
            .validate_requirement_actions(&requirement, &ids)
            .unwrap_err()
            .contains("report_blocked"));
        requirement.semantics.as_mut().unwrap().expected_effect =
            Some(RequirementEffect::Observation);

        // A later input with no usable after-image makes the previous one stale.
        let later_request = native_call(
            "later",
            "qwen_computer__click",
            serde_json::json!({"app":"Other"}),
        );
        let mut later_response = audited_success(
            "later",
            "qwen_computer::click",
            ToolAuditPermissionClass::HighRisk,
            &[],
        );
        let result = later_response.tool_result.as_mut().unwrap();
        let mut later_receipt = trusted_tool_audit_from_result(result).unwrap();
        later_receipt.completed_at = receipt.completed_at + chrono::Duration::seconds(1);
        insert_trusted_tool_audit_meta(result, &later_receipt);
        progress.observe(&later_request, &later_response);
        assert!(progress
            .validate_requirement_actions(&requirement, &ids)
            .is_err());
        requirement
            .semantics
            .as_mut()
            .unwrap()
            .target_resources
            .clear();
        assert!(progress
            .validate_requirement_actions(&requirement, &ids)
            .is_err());
    }

    #[test]
    fn desktop_observation_rejects_external_spoofs_missing_images_and_invalid_windows() {
        let mut response = audited_success(
            "desktop",
            "qwen_computer::press_key",
            ToolAuditPermissionClass::HighRisk,
            &[],
        );
        let result = response.tool_result.as_mut().unwrap();
        let mut receipt = trusted_tool_audit_from_result(result).unwrap();
        receipt.extension_source = ToolAuditExtensionSource::Builtin;
        result.content = vec![Content::image("cGl4ZWxz", "image/png")];
        result.structured_content = Some(serde_json::json!({"desktop_observation":{
            "schema_version":1, "pid":42, "window_handle":101, "app_name":"Calculator",
            "bundle_identifier":"", "window_title":"计算器"
        }}));
        assert!(desktop_observation(&receipt, &response.tool_result).is_some());
        for source in [
            ToolAuditExtensionSource::ExternalStdio,
            ToolAuditExtensionSource::Platform,
        ] {
            receipt.extension_source = source;
            assert!(desktop_observation(&receipt, &response.tool_result).is_none());
        }
        receipt.extension_source = ToolAuditExtensionSource::Builtin;
        for field in ["schema_version", "pid", "window_handle"] {
            let mut bad = response.tool_result.clone();
            bad.as_mut().unwrap().structured_content.as_mut().unwrap()["desktop_observation"]
                [field] = serde_json::json!(0);
            assert!(desktop_observation(&receipt, &bad).is_none(), "{field}");
        }
        response.tool_result.as_mut().unwrap().content.clear();
        assert!(desktop_observation(&receipt, &response.tool_result).is_none());
    }

    fn desktop_result_fixture() -> (
        ToolTaskProgress,
        crate::agents::protocol::UserRequirement,
        super::super::main_agent_contract::ActionCoverage,
    ) {
        use crate::agents::protocol::{RequirementEffect, RequirementSemantics, UserRequirement};
        let mut progress = ToolTaskProgress::default();
        desktop_result_add(&mut progress, "send", "click", 101, 10, true);
        let requirement = UserRequirement {
            requirement_id: "send-and-check".into(),
            source_message_id: "user".into(),
            continuation_source: None,
            execution_obligations: Vec::new(),
            semantics: Some(RequirementSemantics {
                content: "Submit one message in the selected chat and read the reply".into(),
                expected_effect: Some(RequirementEffect::DesktopInteraction),
                target_resources: vec!["desktop:42/101".into()],
                revision_relation: None,
            }),
        };
        let coverage = serde_json::from_value(serde_json::json!({
            "requirement_id":"send-and-check", "audit_ids":["audit-send"],
            "desktop_results":[{"action_id":"send", "observation_id":"send",
                "result":"application_response", "summary":"The requested chat shows one new outgoing test message and the matching application reply; the composer is empty."}]
        })).unwrap();
        (progress, requirement, coverage)
    }

    fn desktop_result_add(
        progress: &mut ToolTaskProgress,
        id: &str,
        tool: &str,
        window: u64,
        second: i64,
        image: bool,
    ) {
        let request = native_call(
            id,
            &format!("qwen_computer__{tool}"),
            serde_json::json!({"app":format!("window:42:{window}")}),
        );
        let mut response = audited_success(
            id,
            &format!("qwen_computer::{tool}"),
            ToolAuditPermissionClass::HighRisk,
            &[],
        );
        let result = response.tool_result.as_mut().unwrap();
        let mut receipt = trusted_tool_audit_from_result(result).unwrap();
        receipt.extension_source = ToolAuditExtensionSource::Builtin;
        receipt.completed_at = chrono::DateTime::from_timestamp(second, 0).unwrap();
        insert_trusted_tool_audit_meta(result, &receipt);
        if image {
            result.content.push(Content::image("cGl4ZWxz", "image/png"));
        }
        result.structured_content = Some(serde_json::json!({"desktop_observation":{
            "schema_version":1, "pid":42, "window_handle":window, "app_name":"Chat",
            "bundle_identifier":"Chat.App", "window_title":"Exact recipient"
        }}));
        progress.observe(&request, &response);
    }

    #[test]
    fn desktop_result_accepts_actual_submission_and_reply_without_claiming_remote_delivery() {
        use crate::agents::protocol::RequirementEffect;
        let (mut progress, mut requirement, mut coverage) = desktop_result_fixture();
        for result in ["ui_state", "ui_submitted", "application_response"] {
            coverage.desktop_results[0].result =
                serde_json::from_value(serde_json::json!(result)).unwrap();
            assert!(
                progress
                    .validate_coverage_entry(&requirement, &coverage)
                    .is_ok(),
                "{result}"
            );
        }
        // Reopening a preserved draft does not undo a historically verified submission.
        desktop_result_add(&mut progress, "draft", "click", 101, 20, true);
        assert!(progress
            .validate_coverage_entry(&requirement, &coverage)
            .is_ok());
        requirement.semantics.as_mut().unwrap().expected_effect =
            Some(RequirementEffect::ExternalEffect);
        assert!(progress
            .validate_coverage_entry(&requirement, &coverage)
            .unwrap_err()
            .contains("owner-confirmed"));
    }

    #[test]
    fn desktop_result_rejects_unbound_or_fabricated_claims() {
        for invalid in [
            "empty-results",
            "blank-summary",
            "uncited",
            "invented",
            "wrong-target",
            "missing-target",
            "read-as-action",
            "missing-image",
            "foreign-source",
            "unknown-action",
        ] {
            let (mut progress, mut requirement, mut coverage) = desktop_result_fixture();
            match invalid {
                "empty-results" => coverage.desktop_results.clear(),
                "blank-summary" => coverage.desktop_results[0].summary = "  ".into(),
                "uncited" => coverage.audit_ids.clear(),
                "invented" => coverage.desktop_results[0].action_id = "made-up-id".into(),
                "wrong-target" => {
                    requirement.semantics.as_mut().unwrap().target_resources =
                        vec!["desktop:99/101".into()]
                }
                "missing-target" => requirement
                    .semantics
                    .as_mut()
                    .unwrap()
                    .target_resources
                    .clear(),
                "read-as-action" => {
                    progress
                        .action_facts
                        .action_index
                        .get_mut("audit-send")
                        .unwrap()
                        .tool_name = "qwen_computer::get_app_state".into()
                }
                "missing-image" => {
                    progress = ToolTaskProgress::default();
                    desktop_result_add(&mut progress, "send", "click", 101, 10, false);
                }
                "foreign-source" => {
                    progress = ToolTaskProgress::default();
                    let mut r = audited_success(
                        "send",
                        "qwen_computer::click",
                        ToolAuditPermissionClass::HighRisk,
                        &[],
                    );
                    let receipt =
                        trusted_tool_audit_from_result(r.tool_result.as_ref().unwrap()).unwrap();
                    insert_trusted_tool_audit_meta(r.tool_result.as_mut().unwrap(), &receipt);
                    progress.observe(
                        &native_call(
                            "send",
                            "qwen_computer__click",
                            serde_json::json!({"app":"Chat"}),
                        ),
                        &r,
                    );
                }
                "unknown-action" => {
                    progress
                        .action_facts
                        .action_index
                        .get_mut("audit-send")
                        .unwrap()
                        .outcome = ToolAuditOutcome::ToolError
                }
                _ => unreachable!(),
            }
            assert!(
                progress
                    .validate_coverage_entry(&requirement, &coverage)
                    .is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn desktop_result_reports_mixed_targets_without_certifying_the_file_or_discarding_the_check() {
        let (progress, mut requirement, coverage) = desktop_result_fixture();
        requirement
            .semantics
            .as_mut()
            .unwrap()
            .target_resources
            .push("file:C:/isolated/app.js".into());
        let gap = progress
            .validate_coverage_entry(&requirement, &coverage)
            .unwrap_err();
        assert!(gap.contains("file:C:/isolated/app.js"));
        assert!(gap.contains("desktop:42/101"));
        assert!(gap.contains("not evidence"));
        // Reporting a gap must not silently narrow or complete the original requirement.
        assert_eq!(
            requirement
                .semantics
                .as_ref()
                .unwrap()
                .target_resources
                .len(),
            2
        );
        requirement.semantics.as_mut().unwrap().target_resources = vec!["desktop:42/101".into()];
        assert!(progress
            .validate_coverage_entry(&requirement, &coverage)
            .is_ok());
    }

    #[test]
    fn desktop_result_binds_after_image_to_exact_action_and_window() {
        for (window, second, intervening, expected) in [
            (101, 11, false, true),
            (102, 11, false, false),
            (101, 9, false, false),
            (101, 12, true, false),
        ] {
            let (mut progress, requirement, mut coverage) = desktop_result_fixture();
            if intervening {
                desktop_result_add(&mut progress, "other-input", "type_text", 102, 11, true);
            }
            desktop_result_add(
                &mut progress,
                "observe",
                "get_app_state",
                window,
                second,
                true,
            );
            coverage.audit_ids.push("audit-observe".into());
            coverage.desktop_results[0].observation_id = "observe".into();
            assert_eq!(
                progress
                    .validate_coverage_entry(&requirement, &coverage)
                    .is_ok(),
                expected,
                "window={window} second={second} intervening={intervening}"
            );
        }
    }

    #[test]
    fn desktop_result_cannot_downgrade_bound_delivery_without_a_new_user_requirement() {
        use crate::agents::protocol::RequirementEffect;
        let (_, mut previous, _) = desktop_result_fixture();
        previous.semantics.as_mut().unwrap().expected_effect =
            Some(RequirementEffect::ExternalEffect);
        for weaker in [
            RequirementEffect::DesktopInteraction,
            RequirementEffect::Observation,
        ] {
            let mut proposed = previous.clone();
            proposed.semantics.as_mut().unwrap().expected_effect = Some(weaker);
            assert!(super::super::main_agent_contract::validate_effect_revision(
                &previous, &proposed
            )
            .is_err());
            if matches!(weaker, RequirementEffect::Observation) {
                let mut desktop = previous.clone();
                desktop.semantics.as_mut().unwrap().expected_effect =
                    Some(RequirementEffect::DesktopInteraction);
                assert!(super::super::main_agent_contract::validate_effect_revision(
                    &desktop, &proposed
                )
                .is_err());
            }
            proposed.source_message_id = "new-user-goal".into();
            assert!(super::super::main_agent_contract::validate_effect_revision(
                &previous, &proposed
            )
            .is_ok());
        }
    }

    #[test]
    fn project_memory_task_contract_accepts_owner_receipt_without_file_delta() {
        use crate::agents::protocol::{RequirementEffect, RequirementSemantics, UserRequirement};
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "memory",
            "project_memory_remember",
            serde_json::json!({"subject":"project.rule"}),
        );
        let mut response = audited_success(
            "memory",
            "projectmemory::project_memory_remember",
            ToolAuditPermissionClass::WorkspaceWrite,
            &[],
        );
        response.tool_result.as_mut().unwrap().content = vec![Content::text(serde_json::json!({
            "created":true,"entry":{"id":"memory-entry","kind":"project_rule","subject":"project.rule",
            "content":"Release on Friday","scope":"project","source":"user_explicit","status":"active",
            "reason":"User requested project memory","confidence":"high",
            "created_at":"2026-09-30T06:07:22Z","updated_at":"2026-09-30T06:07:22Z"}
        }).to_string())];
        progress.observe(&request, &response);
        assert!(progress.minimum_completion_evidence_satisfied(CodeProTaskKind::ToolAction));
        assert!(!progress.minimum_completion_evidence_satisfied(CodeProTaskKind::SimpleChange));
        let mut requirement = UserRequirement {
            requirement_id: "remember".into(),
            source_message_id: "user".into(),
            continuation_source: None,
            execution_obligations: vec![],
            semantics: Some(RequirementSemantics {
                content: "Save this project rule without editing files".into(),
                expected_effect: Some(RequirementEffect::MemoryUpdate),
                target_resources: vec!["memory:project.rule".into()],
                revision_relation: None,
            }),
        };
        let ids = vec!["audit-memory".to_string()];
        assert!(progress
            .validate_requirement_actions(&requirement, &ids)
            .is_ok());
        requirement.semantics.as_mut().unwrap().target_resources = vec!["memory:other.rule".into()];
        assert!(progress
            .validate_requirement_actions(&requirement, &ids)
            .is_err());
        requirement.semantics.as_mut().unwrap().expected_effect =
            Some(RequirementEffect::WorkspaceChange);
        requirement.semantics.as_mut().unwrap().target_resources = vec!["app.js".into()];
        assert!(progress
            .validate_requirement_actions(&requirement, &ids)
            .is_err());
    }

    #[test]
    fn project_memory_deletion_receipts_complete_only_their_memory_target() {
        use crate::agents::protocol::{RequirementEffect, RequirementSemantics, UserRequirement};
        let id = "5c8542be-7253-42d4-8fca-c5768fffd6f8";
        for (tool, arguments, body, target) in [
            (
                "project_memory_forget",
                serde_json::json!({"id":id}),
                serde_json::json!({"removed":true}),
                format!("memory:{id}"),
            ),
            (
                "project_memory_forget",
                serde_json::json!({"id":id}),
                serde_json::json!({"removed":false}),
                format!("memory:{id}"),
            ),
            (
                "project_memory_forget",
                serde_json::json!({"id":id.to_uppercase()}),
                serde_json::json!({"removed":false}),
                format!("memory:{}", id.to_uppercase()),
            ),
            (
                "project_memory_clear",
                serde_json::json!({}),
                serde_json::json!({"removed_count":2}),
                "memory:project".into(),
            ),
            (
                "project_memory_clear",
                serde_json::json!({}),
                serde_json::json!({"removed_count":0}),
                "memory:project".into(),
            ),
        ] {
            let request = native_call("delete", tool, arguments);
            let mut response = audited_success(
                "delete",
                &format!("projectmemory::{tool}"),
                ToolAuditPermissionClass::HighRisk,
                &[],
            );
            response.tool_result.as_mut().unwrap().content = vec![Content::text(body.to_string())];
            let mut progress = ToolTaskProgress::default();
            progress.observe(&request, &response);
            let mut requirement = UserRequirement {
                requirement_id: "forget".into(),
                source_message_id: "user".into(),
                continuation_source: None,
                execution_obligations: vec![],
                semantics: Some(RequirementSemantics {
                    content: "Forget the requested project memory without changing files".into(),
                    expected_effect: Some(RequirementEffect::MemoryUpdate),
                    target_resources: vec![target],
                    revision_relation: None,
                }),
            };
            let audits = vec!["audit-delete".to_string()];
            assert!(
                progress
                    .validate_requirement_actions(&requirement, &audits)
                    .is_ok(),
                "{tool}: {body}"
            );
            requirement.semantics.as_mut().unwrap().target_resources =
                vec!["memory:unrelated".into()];
            assert!(progress
                .validate_requirement_actions(&requirement, &audits)
                .is_err());
            requirement
                .semantics
                .as_mut()
                .unwrap()
                .target_resources
                .clear();
            requirement.semantics.as_mut().unwrap().expected_effect =
                Some(RequirementEffect::WorkspaceChange);
            assert!(progress
                .validate_requirement_actions(&requirement, &audits)
                .is_err());
        }
    }

    #[test]
    fn project_memory_deletion_rejects_failed_forged_or_malformed_receipts() {
        for invalid in [
            "failed",
            "foreign",
            "wrong-tool",
            "missing-body",
            "invalid-id",
            "string-removed",
            "negative-count",
        ] {
            let clear = invalid == "negative-count";
            let tool = if clear {
                "project_memory_clear"
            } else {
                "project_memory_forget"
            };
            let request = native_call(
                "delete",
                tool,
                serde_json::json!({"id":if invalid == "invalid-id" {"bad"} else {"5c8542be-7253-42d4-8fca-c5768fffd6f8"}}),
            );
            let mut response = audited_success(
                "delete",
                &format!("projectmemory::{tool}"),
                ToolAuditPermissionClass::HighRisk,
                &[],
            );
            let result = response.tool_result.as_mut().unwrap();
            let body = match invalid {
                "missing-body" => serde_json::json!({}),
                "string-removed" => serde_json::json!({"removed":"true"}),
                "negative-count" => serde_json::json!({"removed_count":-1}),
                _ => serde_json::json!({"removed":true}),
            };
            result.content = vec![Content::text(body.to_string())];
            let mut receipt = trusted_tool_audit_from_result(result).unwrap();
            match invalid {
                "failed" => {
                    receipt.outcome = ToolAuditOutcome::ToolError;
                    result.is_error = Some(true);
                }
                "foreign" => receipt.extension_source = ToolAuditExtensionSource::ExternalStdio,
                "wrong-tool" => receipt.tool_name = "projectmemory::project_memory_search".into(),
                _ => {}
            }
            insert_trusted_tool_audit_meta(result, &receipt);
            let mut progress = ToolTaskProgress::default();
            progress.observe(&request, &response);
            assert!(
                progress.action_facts.action_index["audit-delete"]
                    .memory_effect
                    .is_none(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn r3_memory_owner_receipt_cannot_prove_workspace_delivery() {
        use crate::agents::protocol::{RequirementEffect, RequirementSemantics, UserRequirement};
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "memory",
            "project_memory_remember",
            serde_json::json!({"subject":"project.rule"}),
        );
        progress.observe(
            &request,
            &audited_success(
                "memory",
                "projectmemory::project_memory_remember",
                ToolAuditPermissionClass::WorkspaceWrite,
                &[],
            ),
        );
        let requirement = UserRequirement {
            requirement_id: "deliver".to_string(),
            source_message_id: "user".to_string(),
            continuation_source: None,
            execution_obligations: Vec::new(),
            semantics: Some(RequirementSemantics {
                content: "Deliver the application".to_string(),
                expected_effect: Some(RequirementEffect::WorkspaceChange),
                target_resources: vec![".".to_string()],
                revision_relation: None,
            }),
        };
        assert!(progress
            .validate_requirement_actions(&requirement, &["audit-memory".to_string()])
            .is_err());
    }

    #[test]
    fn completion_feedback_collects_independent_file_and_execution_gaps() {
        use crate::agents::protocol::{
            EvidenceRequirement, ExecutionObligation, RequirementEffect, RequirementSemantics,
            UserRequirement,
        };
        let temp = tempfile::tempdir().unwrap();
        let scope =
            CodeProTaskScope::new_bound("run", "main", temp.path(), vec![], vec![]).unwrap();
        let mut progress = ToolTaskProgress::from_history_in_scope(&[], Some(&scope));
        for (id, path) in [("stale", "stale.txt"), ("valid", "valid.txt")] {
            std::fs::write(temp.path().join(path), "version-one").unwrap();
            let request = native_call(id, "developer__write", serde_json::json!({"path":path}));
            let mut response = audited_success(
                id,
                "developer::write",
                ToolAuditPermissionClass::WorkspaceWrite,
                &[path],
            );
            let result = response.tool_result.as_mut().unwrap();
            let mut receipt = trusted_tool_audit_from_result(result).unwrap();
            receipt.task_scoped = true;
            receipt.task_scope_digest = Some(super::super::tool_audit::task_scope_digest(&scope));
            insert_trusted_tool_audit_meta(result, &receipt);
            let meta = result.meta.as_mut().unwrap();
            meta.0
                .get_mut(super::super::extension_manager::TRUSTED_TOOL_UPDATE_META_KEY)
                .unwrap()["workspaceDelta"]["resourceVersions"] = serde_json::json!({path: format!("blake3:{}", blake3::hash(b"version-one").to_hex())});
            progress.observe(&request, &response);
        }
        std::fs::write(
            temp.path().join("stale.txt"),
            "changed outside selected receipt",
        )
        .unwrap();
        let requirement = UserRequirement {
            requirement_id: "delivery".into(),
            source_message_id: "user".into(),
            continuation_source: None,
            semantics: Some(RequirementSemantics {
                content: "deliver and test".into(),
                expected_effect: Some(RequirementEffect::WorkspaceChange),
                target_resources: vec![
                    "missing.txt".into(),
                    "stale.txt".into(),
                    "valid.txt".into(),
                ],
                revision_relation: None,
            }),
            execution_obligations: vec![ExecutionObligation {
                obligation_id: "test-delivery".into(),
                source_message_id: "user".into(),
                invocation: ValidationInvocation::parse("npm.cmd test", temp.path()).unwrap(),
                evidence_requirement: EvidenceRequirement::ExitCodeObserved,
                allow_equivalent_invocation: false,
            }],
        };
        let gaps = progress
            .validate_requirement_actions(
                &requirement,
                &["audit-stale".into(), "audit-valid".into()],
            )
            .unwrap_err();
        assert!(gaps.contains("missing.txt"), "{gaps}");
        assert!(gaps.contains("stale.txt"), "{gaps}");
        assert!(gaps.contains("test-delivery"), "{gaps}");
        assert!(!gaps.contains("valid.txt"), "{gaps}");
        let bad_ids = progress
            .resolve_audit_ids(&["bad-one".into(), "bad-two".into()])
            .unwrap_err();
        assert!(bad_ids.contains("bad-one") && bad_ids.contains("bad-two"));
    }

    #[tokio::test]
    async fn completion_feedback_child_receipts_preserve_identity_without_extending_parent_budget()
    {
        use crate::agents::protocol::{EventId, EvidenceRef, RunId, TaskId, UserRequirement};
        use crate::agents::tool_audit::{
            EffectiveModel, QualifiedToolName, ToolAuditInput, ToolAuditPolicy, ToolAuditStore,
        };
        let temp = tempfile::tempdir().unwrap();
        let store = ToolAuditStore::with_policy(
            temp.path().join("audit"),
            ToolAuditPolicy {
                max_records_per_session: 100,
                completed_retention: std::time::Duration::ZERO,
            },
        );
        let scope =
            CodeProTaskScope::new_bound("run", "child", temp.path(), vec![], vec![]).unwrap();
        let parent_scope =
            CodeProTaskScope::new_bound("run", "parent", temp.path(), vec![], vec![]).unwrap();
        let source = ReferencedActionSource {
            session_id: "child-session".into(),
            task_id: TaskId::new("child").unwrap(),
            task_scope_digest: super::super::tool_audit::task_scope_digest(&scope),
            delegation: Some(
                EvidenceRef::new(
                    RunId::new("run").unwrap(),
                    EventId::new("delegated").unwrap(),
                    "evidence.json",
                )
                .unwrap(),
            ),
            continuation: None,
        };
        let mut messages = Vec::new();
        let mut ids = Vec::new();
        for id in ["old", "latest"] {
            let request = native_call(
                id,
                "developer__write",
                serde_json::json!({"path":"delivery.txt", "content":id}),
            );
            let arguments = request
                .tool_call
                .as_ref()
                .unwrap()
                .arguments
                .clone()
                .unwrap();
            let claim = store
                .begin(ToolAuditInput {
                    session_id: source.session_id.clone(),
                    request_id: id.into(),
                    task_scope: Some(scope.clone()),
                    tool_name: QualifiedToolName::new("developer::write").unwrap(),
                    arguments,
                    actor: ToolAuditActor::CodeproCoder,
                    effective_model: EffectiveModel::new("test/model").unwrap(),
                    extension_source: ToolAuditExtensionSource::Platform,
                    permission_class: ToolAuditPermissionClass::WorkspaceWrite,
                    authorization: ToolAuditAuthorization::PolicyAllowed,
                })
                .await
                .unwrap();
            std::fs::write(temp.path().join("delivery.txt"), id).unwrap();
            let receipt = store
                .complete_with_receipt(&claim, ToolAuditOutcome::Success)
                .await
                .unwrap();
            ids.push(receipt.audit_id.clone());
            let mut result = CallToolResult::success(vec![Content::text("written")]);
            insert_trusted_tool_audit_meta(&mut result, &receipt);
            insert_trusted_workspace_delta_meta(&mut result, &["delivery.txt".into()]);
            result
                .meta
                .as_mut()
                .unwrap()
                .0
                .get_mut(super::super::extension_manager::TRUSTED_TOOL_UPDATE_META_KEY)
                .unwrap()["workspaceDelta"]["resourceVersions"] = serde_json::json!({"delivery.txt":format!("blake3:{}", blake3::hash(id.as_bytes()).to_hex())});
            messages.push(Message::assistant().with_tool_request(id, request.tool_call));
            messages.push(Message::user().with_tool_response(id, Ok(result)));
            if id == "old" {
                let preview = store.preview_completed_cleanup().await.unwrap();
                assert_eq!(preview.len(), 1);
                store.cleanup_completed_exact(&preview).await.unwrap();
            }
        }
        let mut parent = ToolTaskProgress::from_history_in_scope(&[], Some(&parent_scope));
        assert_eq!(
            parent
                .import_referenced_workspace_actions(&messages, &scope, &source, &store)
                .await
                .unwrap(),
            1
        );
        assert_eq!(parent.successful_tools, 0);
        assert!(parent
            .action_evidence()
            .workspace_write_action_ids
            .is_empty());
        assert!(parent.action_facts.has_workspace_write());
        assert!(parent
            .resolve_audit_ids(&[ids[0].clone()])
            .unwrap_err()
            .contains("unavailable"));
        let requirement:UserRequirement = serde_json::from_value(serde_json::json!({
            "requirement_id":"delivery", "source_message_id":"user", "semantics":{
                "content":"deliver file", "expected_effect":"workspace_change", "target_resources":["delivery.txt"]}})).unwrap();
        parent
            .validate_requirement_actions(&requirement, &[ids[1].clone()])
            .unwrap();
        let index = parent.contract_action_index();
        assert_eq!(
            index["actions"][&ids[1]]["source"]["sessionId"],
            "child-session"
        );
        assert_eq!(
            parent
                .import_referenced_workspace_actions(&messages, &scope, &source, &store)
                .await
                .unwrap(),
            0
        );
        assert_eq!(parent.successful_tools, 0);
        std::fs::write(temp.path().join("delivery.txt"), "unreceipted later edit").unwrap();
        assert!(parent
            .validate_requirement_actions(&requirement, &[ids[1].clone()])
            .is_err());
        let wrong_scope = CodeProTaskScope::new("other-run", "child").unwrap();
        assert!(parent
            .import_referenced_workspace_actions(&messages, &wrong_scope, &source, &store)
            .await
            .is_err());
    }

    #[test]
    fn r3_changed_path_without_its_receipt_version_does_not_prove_current_delivery() {
        use crate::agents::protocol::{RequirementEffect, RequirementSemantics, UserRequirement};
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "write",
            "developer__write",
            serde_json::json!({"path":"app.js"}),
        );
        progress.observe(
            &request,
            &audited_success(
                "write",
                "developer::write",
                ToolAuditPermissionClass::WorkspaceWrite,
                &["app.js"],
            ),
        );
        let requirement = UserRequirement {
            requirement_id: "deliver".to_string(),
            source_message_id: "user".to_string(),
            continuation_source: None,
            execution_obligations: Vec::new(),
            semantics: Some(RequirementSemantics {
                content: "Deliver app.js".to_string(),
                expected_effect: Some(RequirementEffect::WorkspaceChange),
                target_resources: vec!["app.js".to_string()],
                revision_relation: None,
            }),
        };
        assert!(progress
            .validate_requirement_actions(&requirement, &["audit-write".to_string()])
            .unwrap_err()
            .contains("no version captured"));
    }

    #[test]
    fn r3_effect_evidence_does_not_skip_a_separate_execution_obligation() {
        use crate::agents::protocol::{
            EvidenceRequirement, ExecutionObligation, RequirementEffect, RequirementSemantics,
            UserRequirement,
        };
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "read",
            "developer__read",
            serde_json::json!({"path":"app.js"}),
        );
        progress.observe(
            &request,
            &audited_success(
                "read",
                "developer::read",
                ToolAuditPermissionClass::ReadOnly,
                &[],
            ),
        );
        let invocation =
            ValidationInvocation::parse("npm.cmd test", Path::new("C:/project")).unwrap();
        let requirement = UserRequirement {
            requirement_id: "inspect-and-test".to_string(),
            source_message_id: "user".to_string(),
            continuation_source: None,
            semantics: Some(RequirementSemantics {
                content: "Inspect app.js and run the requested test".to_string(),
                expected_effect: Some(RequirementEffect::Observation),
                target_resources: Vec::new(),
                revision_relation: None,
            }),
            execution_obligations: vec![ExecutionObligation {
                obligation_id: "npm-test".to_string(),
                source_message_id: "user".to_string(),
                invocation,
                evidence_requirement: EvidenceRequirement::ExitCodeObserved,
                allow_equivalent_invocation: false,
            }],
        };
        assert!(progress
            .validate_requirement_actions(&requirement, &["audit-read".to_string()])
            .unwrap_err()
            .contains("npm-test"));
    }

    #[test]
    fn second_repair_batch_real_workspace_delta_is_change_evidence() {
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "edit",
            "developer__edit",
            serde_json::json!({"path":"app.js"}),
        );
        progress.observe(
            &request,
            &audited_success(
                "edit",
                "developer::edit",
                ToolAuditPermissionClass::WorkspaceWrite,
                &["app.js"],
            ),
        );

        assert!(progress.minimum_completion_evidence_satisfied(CodeProTaskKind::SimpleChange));
        assert_eq!(
            progress.action_evidence().workspace_write_action_ids,
            vec!["audit-edit".to_string()]
        );
    }

    #[test]
    fn git_mcp_confirmed_conflict_is_known_failure_not_success_or_unknown() {
        for (outcome, trusted, expected_unknown) in [
            (ToolAuditOutcome::ToolError, true, false),
            (ToolAuditOutcome::ToolError, false, true),
            (ToolAuditOutcome::TimedOut, true, true),
            (ToolAuditOutcome::Cancelled, true, true),
        ] {
            let mut progress = ToolTaskProgress::default();
            let request = native_call(
                "merge",
                "local_git__git_merge",
                serde_json::json!({"branch":"peer"}),
            );
            let mut response = audited_result(
                "merge",
                "local_git::git_merge",
                ToolAuditPermissionClass::WorkspaceWrite,
                &["fee.cjs"],
                outcome,
            );
            let result = response.tool_result.as_mut().unwrap();
            if trusted {
                result
                    .meta
                    .as_mut()
                    .unwrap()
                    .0
                    .get_mut("__goose_tool_update_meta")
                    .unwrap()["gitKnownConflict"] = serde_json::json!(true);
            } else {
                result.structured_content = Some(serde_json::json!({"gitKnownConflict":true}));
            }
            progress.observe(&request, &response);
            assert_eq!(!progress.unverified_actions.is_empty(), expected_unknown);
            assert_eq!(
                progress.successful_tools, 0,
                "a conflict is never a successful merge"
            );
        }
    }

    #[test]
    fn fourth_repair_batch_failed_tool_with_real_delta_remains_unverified() {
        let mut progress = ToolTaskProgress::default();
        let request = native_call(
            "partial-edit",
            "developer__edit",
            serde_json::json!({"path":"app.js"}),
        );
        progress.observe(
            &request,
            &audited_result(
                "partial-edit",
                "developer::edit",
                ToolAuditPermissionClass::WorkspaceWrite,
                &["app.js"],
                ToolAuditOutcome::ToolError,
            ),
        );

        assert!(progress.action_facts.has_workspace_write());
        assert!(progress.has_unverified_result());
        assert!(!progress.minimum_completion_evidence_satisfied(CodeProTaskKind::SimpleChange));
    }

    #[test]
    fn repeat_success_and_polling_do_not_extend_forever() {
        let mut progress = ToolTaskProgress::default();
        observe_attempt(
            &mut progress,
            &call("read_document", "one.txt"),
            &response(),
        );
        assert!(progress.take_new_progress());
        observe_attempt(
            &mut progress,
            &call("read_document", "one.txt"),
            &response(),
        );
        observe_attempt(&mut progress, &call("computer_observe", "any"), &response());
        assert!(!progress.take_new_progress());
        observe_attempt(
            &mut progress,
            &call("read_document", "two.txt"),
            &response(),
        );
        assert!(progress.take_new_progress());
    }

    #[test]
    fn builtin_desktop_observation_does_not_clear_failed_inputs_or_extend_the_budget() {
        let mut progress = ToolTaskProgress::default();
        let failed = native_call(
            "click",
            "qwen_computer__click",
            serde_json::json!({"app":"window:42:101", "element_id":7}),
        );
        let failure = audited_result(
            "click",
            "qwen_computer::click",
            ToolAuditPermissionClass::HighRisk,
            &[],
            ToolAuditOutcome::ToolError,
        );
        for attempt in 0..3 {
            observe_attempt(&mut progress, &failed, &failure);
            desktop_result_add(
                &mut progress,
                &format!("observe-{attempt}"),
                "get_app_state",
                101,
                10 + attempt,
                true,
            );
            assert!(!progress.take_new_progress());
        }
        assert!(progress.repeating_failed_call());
        // An actual new input remains material progress; observations did not disable it.
        desktop_result_add(&mut progress, "new-input", "click", 101, 20, true);
        assert!(progress.take_new_progress());
        assert!(!progress.repeating_failed_call());
        // A similarly named external tool cannot acquire the builtin observation exemption.
        let mut external = ToolTaskProgress::default();
        external.observe(
            &native_call(
                "external",
                "extension__get_app_state",
                serde_json::json!({}),
            ),
            &audited_success(
                "external",
                "extension::get_app_state",
                ToolAuditPermissionClass::HighRisk,
                &[],
            ),
        );
        assert!(external.take_new_progress());
    }
    #[test]
    fn failed_tool_does_not_justify_extension() {
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::error(vec![Content::text("failed")]));
        let mut progress = ToolTaskProgress::default();
        progress.observe(&call("read_document", "one.txt"), &failed);
        assert!(!progress.take_new_progress());
    }
    #[test]
    fn script_success_is_not_delivery_proof() {
        let mut progress = ToolTaskProgress::default();
        progress.observe(
            &call("computercontroller::computer_control", "send message"),
            &response(),
        );
        assert!(progress.unverified_delivery());
        assert!(!progress
            .checked_final_text(CodeProTaskKind::ToolAction, "已完成全部发送")
            .contains("已完成全部发送"));
    }

    #[test]
    fn missing_evidence_cannot_render_a_model_completion_claim() {
        let progress = ToolTaskProgress::default();
        assert_eq!(
            progress.checked_final_text(CodeProTaskKind::ToolAction, "已完成全部发送"),
            NO_VERIFIED_RESULT
        );
    }

    #[test]
    fn change_completion_distinguishes_diagnosis_from_a_failed_post_write_validation() {
        let mut diagnosis = ToolTaskProgress::default();
        diagnosis
            .action_facts
            .validation_action_ids
            .insert("validation-failed".to_string());
        diagnosis.action_facts.last_validation_succeeded = Some(false);
        assert!(diagnosis.minimum_completion_evidence_satisfied(CodeProTaskKind::SimpleChange));

        diagnosis
            .action_facts
            .workspace_write_action_ids
            .insert("write-app".to_string());
        assert!(!diagnosis.minimum_completion_evidence_satisfied(CodeProTaskKind::SimpleChange));

        diagnosis.action_facts.last_validation_succeeded = Some(true);
        assert!(diagnosis.minimum_completion_evidence_satisfied(CodeProTaskKind::SimpleChange));
    }

    #[test]
    fn unsuccessful_postcondition_is_not_progress() {
        let mut result = response();
        result.tool_result.as_mut().unwrap().structured_content =
            Some(serde_json::json!({"outcome":"unknown"}));
        let mut progress = ToolTaskProgress::default();
        progress.observe(&call("computer_click", "button"), &result);
        assert_eq!(progress.successful_tools, 0);
        assert!(!progress.take_new_progress());
    }

    #[test]
    fn consumer_unknown_cannot_be_hidden_by_observation_or_unrelated_success() {
        for structured in [true, false] {
            let receipt = serde_json::json!({"outcome":"unknown"});
            let mut unknown = response();
            unknown.tool_result = Ok(CallToolResult::success(vec![Content::text(
                receipt.to_string(),
            )]));
            if structured {
                unknown.tool_result.as_mut().unwrap().structured_content = Some(receipt);
            }
            let mut progress = ToolTaskProgress::default();
            progress.observe(&native_call("click-1", "computer_click", serde_json::json!({"handle":42,"x":10,"y":20,"screenshot_id":"before","expect":{"text":"Done"}})), &unknown);
            progress.observe(
                &native_call(
                    "observe-1",
                    "computer_observe_ui",
                    serde_json::json!({"handle":42}),
                ),
                &response(),
            );
            progress.observe(&call("read_document", "other.txt"), &response());
            assert!(progress.has_unverified_result());
            assert_ne!(
                progress.checked_final_text(CodeProTaskKind::ToolAction, "所有操作已完成"),
                "所有操作已完成"
            );
        }
    }

    #[test]
    fn consumer_unknown_is_not_adjudicated_by_a_later_worked_receipt() {
        for name in ["computer_focus", "computer_send_message"] {
            let mut unknown = response();
            unknown.tool_result.as_mut().unwrap().structured_content = Some(
                serde_json::json!({"outcome":"unknown","checkpoint_id":"old-checkpoint","recipient":"test","message_sha256":"abc"}),
            );
            let mut progress = ToolTaskProgress::default();
            let arguments = if name == "computer_focus" {
                serde_json::json!({"handle":42,"expect":{"foreground":true}})
            } else {
                serde_json::json!({"checkpoint_id":"old-checkpoint","state_id":"state-1","conversation_reference":"conversation","input_reference":"input","submit_key":"enter"})
            };
            progress.observe(
                &native_call("old-attempt", name, arguments.clone()),
                &unknown,
            );
            let mut worked = response();
            worked.tool_result.as_mut().unwrap().structured_content = Some(
                serde_json::json!({"outcome":"worked","checkpoint_id":"new-checkpoint","recipient":"test","message_sha256":"abc","verification":{"matched":true}}),
            );
            let mut new_arguments = arguments;
            if name == "computer_send_message" {
                new_arguments["checkpoint_id"] = serde_json::json!("new-checkpoint");
                new_arguments["state_id"] = serde_json::json!("new-state");
            }
            progress.observe(&native_call("new-attempt", name, new_arguments), &worked);
            assert!(progress.has_unverified_result());
            assert_ne!(
                progress.checked_final_text(CodeProTaskKind::ToolAction, "已完成"),
                "已完成"
            );
        }
    }

    #[test]
    fn consumer_unknown_survives_continuation_history_but_not_a_new_goal() {
        let unknown = Ok(CallToolResult::success(vec![Content::text(
            r#"{"outcome":"unknown"}"#,
        )]));
        let mut history = vec![
            Message::user()
                .with_id("original-goal")
                .with_text("操作窗口"),
            Message::assistant()
                .with_tool_request("uncertain", call("computer_click", "button").tool_call),
            Message::user().with_tool_response("uncertain", unknown),
            Message::user().with_text("继续"),
            Message::assistant().with_tool_request(
                "observation",
                call("computer_observe_ui", "window").tool_call,
            ),
            Message::user().with_tool_response("observation", response().tool_result),
        ];
        let progress = ToolTaskProgress::from_history(&history);
        assert!(progress.has_unverified_result());
        assert_ne!(
            progress.checked_final_text(CodeProTaskKind::ToolAction, "已完成"),
            "已完成"
        );
        history.push(
            Message::user()
                .with_id("new-goal")
                .with_text("读取另一个文件"),
        );
        let mut next = ToolTaskProgress::from_history(&history);
        next.observe(&call("read_document", "next.txt"), &response());
        assert!(!next.has_unverified_result());
    }

    #[test]
    fn continuation_punctuation_and_mouse_constraint_preserve_goal_and_unknown() {
        for text in ["继续。", "继续！", "Continue.", "继续，但必须只用鼠标"] {
            let original = Message::user()
                .with_id("original")
                .with_text("操作窗口并核实结果");
            let mut followup = Message::user().with_id("followup").with_text(text);
            let mut data = ExtensionData::default();
            save_unified_intent(&mut data, &[], &original, "D:/project", "tool_action");
            let mut history = vec![
                original.clone(),
                Message::assistant()
                    .with_tool_request("uncertain", call("computer_click", "button").tool_call),
                Message::user().with_tool_response(
                    "uncertain",
                    Ok(CallToolResult::success(vec![Content::text(
                        r#"{"outcome":"unknown"}"#,
                    )])),
                ),
            ];
            assert_eq!(
                bind_unified_continuation(&data, &history, &mut followup, "D:/project"),
                Some(CodeProIntent::ToolAction)
            );
            history.push(followup.clone());
            let history: Vec<Message> =
                serde_json::from_str(&serde_json::to_string(&history).unwrap()).unwrap();
            let mut history = history;
            let progress = ToolTaskProgress::from_history(&history);
            assert!(
                !progress.unverified_actions.is_empty(),
                "lost uncertain action: {text}"
            );
            save_unified_intent(&mut data, &history, &followup, "D:/project", "tool_action");
            let saved = data
                .get_extension_state("codepro_unified_turn", "v1")
                .unwrap();
            assert_eq!(saved["source_message_id"], "original", "{text}");
            assert_eq!(saved["goal"], original.as_concat_text());
            assert_eq!(saved["turn_id"], "followup");
            assert_eq!(history.last().unwrap().as_concat_text(), text);
            let resume = Message::user().with_id("later").with_text("继续");
            history.push(resume.clone());
            assert_eq!(
                saved_unified_intent(&data, &history, "D:/project"),
                Some(CodeProIntent::ToolAction)
            );
            save_unified_intent(&mut data, &history, &resume, "D:/project", "tool_action");
            assert_eq!(
                data.get_extension_state("codepro_unified_turn", "v1")
                    .unwrap()["source_message_id"],
                "original"
            );
            assert_eq!(history[3].as_concat_text(), text);
        }
    }

    #[test]
    fn continuation_does_not_absorb_replacement_stop_or_unrelated_steer() {
        for text in [
            "取消",
            "停止",
            "继续，但取消原任务",
            "继续，但必须只用鼠标，改为读取另一个文件",
            "改为读取另一个文件",
            "继续读取另一个文件",
        ] {
            let original = Message::user().with_id("original").with_text("操作窗口");
            let next = Message::user()
                .with_id("replacement")
                .with_text(text)
                .with_steer();
            let mut data = ExtensionData::default();
            save_unified_intent(
                &mut data,
                &[original, next.clone()],
                &next,
                "D:/project",
                "conversation",
            );
            assert_eq!(
                data.get_extension_state("codepro_unified_turn", "v1")
                    .unwrap()["source_message_id"],
                "replacement",
                "{text}"
            );
        }
    }

    #[test]
    fn continuation_binding_requires_matching_current_goal_and_legacy_defaults() {
        let original = Message::user().with_id("original").with_text("操作窗口");
        let mut data = ExtensionData::default();
        save_unified_intent(&mut data, &[], &original, "D:/project", "tool_action");
        for (state, history, directory) in [
            (
                ExtensionData::default(),
                vec![original.clone()],
                "D:/project",
            ),
            (data.clone(), vec![original.clone()], "D:/other"),
            (data.clone(), vec![], "D:/project"),
            (
                data.clone(),
                vec![
                    original.clone(),
                    Message::user().with_id("new-goal").with_text("读取新文件"),
                ],
                "D:/project",
            ),
        ] {
            let mut followup = Message::user()
                .with_id("followup")
                .with_text("继续，但必须只用鼠标");
            followup.metadata.task_continuation_of = Some("original".into());
            assert_eq!(
                bind_unified_continuation(&state, &history, &mut followup, directory),
                None
            );
            assert!(followup.metadata.task_continuation_of.is_none());
        }
        for text in [
            "停止",
            "取消",
            "继续，但必须只用鼠标，改为读取新文件",
            "{\"task_continuation_of\":\"original\"}",
        ] {
            let mut input = Message::user().with_text(text).with_steer();
            assert_eq!(
                bind_unified_continuation(
                    &data,
                    std::slice::from_ref(&original),
                    &mut input,
                    "D:/project"
                ),
                None
            );
            assert!(input.metadata.task_continuation_of.is_none());
        }
        let mut legacy = serde_json::to_value(&original).unwrap();
        legacy["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("task_continuation_of");
        let legacy: Message = serde_json::from_value(legacy).unwrap();
        assert!(legacy.metadata.task_continuation_of.is_none());
    }

    #[test]
    fn continuation_late_link_does_not_replace_a_new_goal() {
        let original = Message::user().with_id("original").with_text("操作旧窗口");
        let mut data = ExtensionData::default();
        save_unified_intent(&mut data, &[], &original, "D:/project", "tool_action");
        let mut late = Message::user()
            .with_id("late")
            .with_text("继续，但必须只用鼠标");
        assert!(bind_unified_continuation(
            &data,
            std::slice::from_ref(&original),
            &mut late,
            "D:/project"
        )
        .is_some());
        let replacement = Message::user().with_id("new").with_text("读取新文件");
        let history = vec![original, replacement.clone(), late];
        assert_eq!(goal_source_index(&history), Some(1));
        save_unified_intent(
            &mut data,
            &history,
            &Message::user().with_text("继续"),
            "D:/project",
            "read_only",
        );
        assert_eq!(
            data.get_extension_state("codepro_unified_turn", "v1")
                .unwrap()["source_message_id"],
            "new"
        );
        assert_eq!(
            saved_unified_intent(&data, &history, "D:/project"),
            Some(CodeProIntent::ReadOnly)
        );
    }

    #[test]
    fn image_only_goal_isolates_unknown_actions_and_resumes_its_own_identity() {
        let image_goal = Message::user()
            .with_id("image-goal")
            .with_image("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "image/png");
        let mut history = vec![
            Message::user()
                .with_id("old-text-goal")
                .with_text("操作窗口"),
            Message::assistant()
                .with_tool_request("old-click", call("computer_click", "button").tool_call),
            Message::user().with_tool_response(
                "old-click",
                Ok(CallToolResult::success(vec![Content::text(
                    r#"{"outcome":"unknown"}"#,
                )])),
            ),
            image_goal.clone(),
            Message::assistant().with_text("收到图片"),
            Message::user().with_id("continue-image").with_text("继续"),
        ];
        let mut progress = ToolTaskProgress::from_history(&history);
        assert!(
            progress.unverified_actions.is_empty(),
            "a new image goal must not inherit an old text goal's unknown action"
        );
        assert!(progress.has_unverified_result());
        progress.observe(&call("computer_observe", "current window"), &response());
        assert!(!progress.has_unverified_result());
        let mut data = ExtensionData::default();
        save_unified_intent(
            &mut data,
            &history,
            &image_goal,
            "/workspace",
            "conversation",
        );
        assert_eq!(
            saved_unified_intent(&data, &history, "/workspace"),
            Some(CodeProIntent::Conversation)
        );
        let continuation = history.pop().unwrap();
        save_unified_intent(
            &mut data,
            &history,
            &continuation,
            "/workspace",
            "conversation",
        );
        assert_eq!(
            data.get_extension_state("codepro_unified_turn", "v1")
                .unwrap()["source_message_id"],
            "image-goal"
        );
    }

    #[test]
    fn image_only_invalid_history_does_not_clear_a_previous_unknown() {
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
        for (data, mime) in [
            ("invalid!base64", "image/png"),
            (PNG, "text/plain"),
            ("", "image/png"),
            ("AA", "image/png"),
            ("AB==", "image/png"),
        ] {
            for candidate in [
                Message::user().with_image(data, mime),
                Message::user()
                    .with_image(PNG, "image/png")
                    .with_image(data, mime),
                Message::user().with_text("继续").with_image(data, mime),
            ] {
                assert!(
                    !substantive_user(&candidate),
                    "invalid attachment established a new source"
                );
                let history = vec![
                    Message::user().with_id("old-goal").with_text("操作窗口"),
                    Message::assistant()
                        .with_tool_request("old-click", call("computer_click", "button").tool_call),
                    Message::user().with_tool_response(
                        "old-click",
                        Ok(CallToolResult::success(vec![Content::text(
                            r#"{"outcome":"unknown"}"#,
                        )])),
                    ),
                    candidate.with_id("invalid-image"),
                    Message::user().with_text("继续"),
                ];
                assert!(ToolTaskProgress::from_history(&history).has_unverified_result());
            }
            let explicit_text_goal = Message::user()
                .with_text("解释这段代码")
                .with_image(data, mime);
            assert!(
                substantive_user(&explicit_text_goal),
                "invalid historical image must not erase a valid explicit text goal"
            );
        }
    }

    #[test]
    fn image_only_or_captioned_attachment_is_a_goal_but_empty_payload_is_not() {
        let previous = Message::user().with_id("previous").with_text("旧目标");
        let image = Message::user()
            .with_id("new-image")
            .with_text("继续")
            .with_image("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "image/png");
        assert!(substantive_user(&image));
        assert!(!substantive_user(
            &image.clone().with_visibility(false, true)
        ));
        assert!(!substantive_user(
            &Message::user().with_image("", "image/png")
        ));
        assert!(!substantive_user(&Message::user().with_text("继续")));
        let mut data = ExtensionData::default();
        save_unified_intent(&mut data, &[previous], &image, "/workspace", "conversation");
        assert_eq!(
            data.get_extension_state("codepro_unified_turn", "v1")
                .unwrap()["source_message_id"],
            "new-image"
        );
    }

    #[test]
    fn unknown_receipts_are_bounded_even_when_read_only_observations_succeed() {
        for structured in [true, false] {
            let mut unknown = response();
            if structured {
                unknown.tool_result.as_mut().unwrap().structured_content =
                    Some(serde_json::json!({"outcome":"unknown"}));
            } else {
                unknown.tool_result = Ok(CallToolResult::success(vec![Content::text(
                    r#"{"outcome":"unknown"}"#,
                )]));
            }
            let mut progress = ToolTaskProgress::default();
            let action = call("computer_click", "button");
            observe_attempt(&mut progress, &action, &unknown);
            observe_attempt(
                &mut progress,
                &call("computer_observe_ui", "window"),
                &response(),
            );
            observe_attempt(&mut progress, &action, &unknown);
            assert!(progress.needs_failure_review());
            observe_attempt(
                &mut progress,
                &call("computer_screenshot", "window"),
                &response(),
            );
            observe_attempt(&mut progress, &action, &unknown);
            assert!(progress.repeating_failed_call());
            assert_ne!(unknown.tool_result.as_ref().unwrap().is_error, Some(true));
        }
    }

    #[test]
    fn error_then_unknown_keeps_the_same_action_history() {
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::error(vec![Content::text(
            "dispatch unavailable",
        )]));
        let mut unknown = response();
        unknown.tool_result.as_mut().unwrap().structured_content =
            Some(serde_json::json!({"outcome":"unknown"}));
        let mut progress = ToolTaskProgress::default();
        let action = call("computer_click", "button");
        observe_attempt(&mut progress, &action, &failed);
        observe_attempt(&mut progress, &action, &unknown);
        assert!(progress.needs_failure_review());
        let mut worked = response();
        worked.tool_result.as_mut().unwrap().structured_content =
            Some(serde_json::json!({"outcome":"worked"}));
        observe_attempt(&mut progress, &action, &worked);
        assert!(!progress.needs_failure_review());
        observe_attempt(&mut progress, &action, &unknown);
        assert!(!progress.needs_failure_review());
        observe_attempt(
            &mut progress,
            &call("computer_click", "corrected target"),
            &unknown,
        );
        assert!(!progress.repeating_failed_call());
        assert!(!progress.needs_failure_review());
    }

    #[test]
    fn first_repair_batch_duplicate_terminal_response_for_one_request_is_counted_once() {
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::error(vec![Content::text("blocked")]));
        let request = native_call(
            "request-1",
            "developer__shell",
            serde_json::json!({"command":"npm.cmd test","timeout_secs":30}),
        );
        let mut progress = ToolTaskProgress::default();

        progress.observe(&request, &failed);
        progress.observe(&request, &failed);

        assert!(!progress.needs_failure_review());
        assert!(!progress.repeating_failed_call());
    }

    #[test]
    fn first_repair_batch_timeout_does_not_change_failed_operation_identity() {
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::error(vec![Content::text("blocked")]));
        let mut progress = ToolTaskProgress::default();
        for (id, timeout_secs) in [("request-1", 30), ("request-2", 120)] {
            let request = native_call(
                id,
                "developer__shell",
                serde_json::json!({
                    "command":"npm.cmd test",
                    "timeout_secs":timeout_secs
                }),
            );
            progress.observe(&request, &failed);
        }

        assert!(progress.needs_failure_review());
        assert!(!progress.repeating_failed_call());
    }

    #[test]
    fn fresh_state_changes_allow_reassessment_but_request_ids_do_not() {
        let mut unknown = response();
        unknown.tool_result.as_mut().unwrap().structured_content =
            Some(serde_json::json!({"outcome":"unknown"}));
        for (name, freshness, arguments) in [
            (
                "computer_click",
                "screenshot_id",
                serde_json::json!({"handle":42,"x":10,"y":20,"screenshot_id":"old","expect":{"text":"Done"}}),
            ),
            (
                "computer_invoke_ui",
                "state_id",
                serde_json::json!({"state_id":"old","reference":"button","expect":{"text":"Done"}}),
            ),
        ] {
            let mut progress = ToolTaskProgress::default();
            for attempt in ["first", "second"] {
                let mut arguments = arguments.clone();
                arguments["trace"] = serde_json::json!({"agent_id":"main","role":"orchestrator","run_id":"run","step_id":"step","attempt_id":attempt,"authorization_scope":"project"});
                arguments["request_id"] = serde_json::json!(attempt);
                arguments["requestId"] = serde_json::json!(attempt);
                progress.observe(&native_call(attempt, name, arguments), &unknown);
            }
            assert!(progress.needs_failure_review());
            let mut refreshed = arguments;
            refreshed[freshness] = serde_json::json!("fresh-observed-state");
            progress.observe(&native_call("fresh", name, refreshed), &unknown);
            assert!(!progress.needs_failure_review());
            assert!(progress.has_unverified_result());
        }
    }

    #[test]
    fn invalid_normalized_coordinates_do_not_get_a_new_retry_budget_from_screenshots() {
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::error(vec![Content::text(
            "归一化截图坐标必须位于 0..1000",
        )]));
        let mut progress = ToolTaskProgress::default();
        for (index, screenshot) in ["first", "second", "third"].iter().enumerate() {
            let request = native_call(
                screenshot,
                "computer_click",
                serde_json::json!({
                    "handle": 42, "x": 1001, "y": 500,
                    "coordinate_space": "screenshot_normalized_1000",
                    "screenshot_id": screenshot, "button": "left", "clicks": 1
                }),
            );
            progress.observe(&request, &failed);
            assert_eq!(progress.needs_failure_review(), index == 1);
            assert_eq!(progress.repeating_failed_call(), index == 2);
        }
        assert!(progress.has_unverified_result());
    }

    #[test]
    fn actual_acp_coordinate_rejections_reach_tracker_pause_threshold() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/computer/normalized-coordinate-rejections.json"
        ))
        .unwrap();
        let calls = fixture["calls"].as_array().unwrap();
        let mut progress = ToolTaskProgress::default();
        let mut reviewed_after = None;
        let mut paused_after = None;
        for (index, call) in calls.iter().enumerate() {
            let request = native_call(
                &format!("actual-{index}"),
                call["name"].as_str().unwrap(),
                call["args"].clone(),
            );
            let result = ToolResponse {
                id: request.id.clone(),
                tool_result: Ok(serde_json::from_value(call["result"].clone()).unwrap()),
                metadata: None,
            };
            progress.observe(&request, &result);
            if progress.needs_failure_review() {
                reviewed_after = Some(index + 1);
            }
            if progress.repeating_failed_call() {
                paused_after = Some(index + 1);
                break;
            }
        }
        assert_eq!(reviewed_after, Some(2));
        assert_eq!(paused_after, Some(3));
        assert!(progress.has_unverified_result());
        assert_ne!(
            progress.checked_final_text(CodeProTaskKind::ToolAction, "已完成"),
            "已完成"
        );
    }

    #[test]
    fn coordinate_retry_repair_preserves_target_input_and_failure_distinctions() {
        let arguments = serde_json::json!({
            "handle": 42, "x": 1001, "y": 500,
            "coordinate_space": "screenshot_normalized_1000",
            "screenshot_id": "old", "button": "left", "clicks": 1
        });
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::error(vec![Content::text(
            "归一化截图坐标必须位于 0..1000",
        )]));
        for change in [
            "target",
            "coordinate",
            "space",
            "stale",
            "unknown",
            "corrected",
        ] {
            let mut progress = ToolTaskProgress::default();
            for _ in 0..2 {
                observe_attempt(
                    &mut progress,
                    &native_call("old", "computer_click", arguments.clone()),
                    &failed,
                );
            }
            assert!(progress.needs_failure_review());
            let mut repaired = arguments.clone();
            repaired["screenshot_id"] = serde_json::json!("fresh");
            let mut result = failed.clone();
            match change {
                "target" => repaired["handle"] = serde_json::json!(43),
                "coordinate" => repaired["x"] = serde_json::json!(1002),
                "space" => repaired["coordinate_space"] = serde_json::json!("screen"),
                "stale" => {
                    result.tool_result = Ok(CallToolResult::error(vec![Content::text(
                        "截图状态不存在或不属于当前会话",
                    )]))
                }
                "unknown" => {
                    result.tool_result = Ok(CallToolResult::success(vec![Content::text(
                        r#"{"outcome":"unknown"}"#,
                    )]))
                }
                "corrected" => {
                    repaired["x"] = serde_json::json!(500);
                    result.tool_result = Ok(CallToolResult::success(vec![Content::text(
                        r#"{"outcome":"worked"}"#,
                    )]));
                }
                _ => unreachable!(),
            }
            observe_attempt(
                &mut progress,
                &native_call("fresh", "computer_click", repaired),
                &result,
            );
            assert!(!progress.needs_failure_review(), "{change}");
            assert!(!progress.repeating_failed_call(), "{change}");
            if change == "corrected" {
                assert!(progress.take_new_progress());
                assert!(!progress.has_unverified_result());
            }
        }
    }

    #[test]
    fn bound_delivery_receipt_is_required_to_confirm_send() {
        let mut result = response();
        result.tool_result.as_mut().unwrap().structured_content = Some(
            serde_json::json!({"outcome":"worked", "recipient":"test", "message_sha256":"abc", "verification":{"matched":true}}),
        );
        let mut progress = ToolTaskProgress::default();
        observe_attempt(
            &mut progress,
            &call("computer_send_message", "checkpoint"),
            &result,
        );
        assert!(!progress.unverified_delivery());
        assert_eq!(
            progress.checked_final_text(CodeProTaskKind::ToolAction, "发送已核实"),
            "发送已核实"
        );
        observe_attempt(
            &mut progress,
            &call("computer_send_message", "second"),
            &response(),
        );
        assert_eq!(
            progress.checked_final_text(CodeProTaskKind::ToolAction, "全部发送已核实"),
            NO_DELIVERY_PROOF
        );
    }
    #[test]
    fn native_text_json_receipts_use_the_same_postcondition_check() {
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::success(vec![Content::text(
            r#"{"outcome":"didnt","verification":{"matched":false}}"#,
        )]));
        let mut progress = ToolTaskProgress::default();
        progress.observe(&call("computer_focus", "window"), &failed);
        assert_eq!(progress.successful_tools, 0);
        let mut sent = response();
        sent.tool_result = Ok(CallToolResult::success(vec![Content::text(
            r#"{"outcome":"worked","recipient":"test","message_sha256":"abc","verification":{"matched":true}}"#,
        )]));
        progress.observe(&call("computer_send_message", "checkpoint"), &sent);
        assert!(!progress.unverified_delivery());
    }
    #[test]
    fn builtin_double_underscore_names_restore_legacy_computer_tasks() {
        let messages = vec![
            Message::user()
                .with_id("goal")
                .with_text("open the application"),
            Message::assistant().with_tool_request(
                "call",
                call("computercontroller__computer_control", "window").tool_call,
            ),
            Message::user().with_text("继续"),
        ];
        assert_eq!(
            saved_unified_intent(&ExtensionData::new(), &messages, "D:/project"),
            Some(CodeProIntent::ToolAction)
        );
    }

    #[test]
    fn new_turn_drops_old_host_controls_without_losing_user_goals_or_receipts() {
        let mut messages = vec![
            Message::user().with_text("draw a chart"),
            Message::user()
                .with_text(COMPLETION_REVIEW)
                .with_visibility(false, true),
            Message::assistant().with_text("chart attempt failed"),
            Message::user().with_text(COMPLETION_REVIEW),
        ];
        discard_stale_turn_controls(&mut messages);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].as_concat_text(), "draw a chart");
        assert_eq!(messages[1].as_concat_text(), "chart attempt failed");
        assert!(messages[2].metadata.user_visible);
    }

    #[test]
    fn identical_failures_are_bounded_but_corrected_arguments_get_a_new_attempt() {
        let mut failed = response();
        failed.tool_result = Ok(CallToolResult::error(vec![Content::text(
            "invalid parameters",
        )]));
        let mut progress = ToolTaskProgress::default();
        observe_attempt(&mut progress, &call("show_chart", "bad"), &failed);
        assert!(!progress.repeating_failed_call());
        observe_attempt(&mut progress, &call("show_chart", "bad"), &failed);
        assert!(progress.needs_failure_review());
        assert!(!progress.repeating_failed_call());
        observe_attempt(&mut progress, &call("show_chart", "bad"), &failed);
        assert!(progress.repeating_failed_call());
        assert!(!progress.needs_failure_review());
        observe_attempt(&mut progress, &call("show_chart", "corrected"), &response());
        assert!(!progress.repeating_failed_call());
    }

    #[test]
    fn semantic_failure_is_not_successful_progress() {
        for value in [
            serde_json::json!({"success":false}),
            serde_json::json!({"error":{}}),
        ] {
            let mut failed = response();
            failed.tool_result = Ok(CallToolResult::success(vec![Content::text(
                value.to_string(),
            )]));
            let mut progress = ToolTaskProgress::default();
            progress.observe(&call("execute_typescript", "test"), &failed);
            assert_eq!(progress.successful_tools, 0);
            assert!(!progress.take_new_progress());
        }
    }

    #[test]
    fn computer_method_explicit_user_changes_preserve_goal_and_reset_for_new_goal() {
        let goal = Message::user()
            .with_id("goal")
            .with_text("必须使用电脑控制，只用鼠标操作窗口；禁止键盘和脚本。");
        let mut data = ExtensionData::new();
        save_unified_intent(&mut data, &[], &goal, "project", "tool_action");
        assert_eq!(
            saved_computer_method(&data),
            ComputerOperationMethod::MouseOnly
        );
        let mut history = vec![goal];
        for (index, text, expected) in [
            (0, "继续。", ComputerOperationMethod::MouseOnly),
            (
                1,
                "继续，但必须使用电脑控制",
                ComputerOperationMethod::DesktopControl,
            ),
            (
                2,
                "继续，但必须只用鼠标",
                ComputerOperationMethod::MouseOnly,
            ),
            (
                3,
                "继续，解除操作方式限制",
                ComputerOperationMethod::Unrestricted,
            ),
        ] {
            let mut user = Message::user()
                .with_id(format!("followup-{index}"))
                .with_text(text);
            assert!(bind_unified_continuation(&data, &history, &mut user, "project").is_some());
            save_unified_intent(&mut data, &history, &user, "project", "tool_action");
            let serialized = serde_json::to_string(&data).unwrap();
            data = serde_json::from_str(&serialized).unwrap();
            assert_eq!(saved_computer_method(&data), expected);
            assert_eq!(
                data.get_extension_state("codepro_unified_turn", "v1")
                    .unwrap()["source_message_id"],
                "goal"
            );
            history.push(user);
        }
        let new_goal = Message::user().with_id("new").with_text("修改项目文件");
        data.extension_states
            .get_mut("codepro_unified_turn.v1")
            .unwrap()["computer_operation_method"] = serde_json::json!("mouse_only");
        assert!(new_goal_replaces_computer_method(&data, &new_goal));
        assert!(!new_goal_replaces_computer_method(&data, &history[0]));
        assert!(!new_goal_replaces_computer_method(
            &data,
            history.last().unwrap()
        ));
        save_unified_intent(&mut data, &history, &new_goal, "project", "tool_action");
        assert_eq!(
            saved_computer_method(&data),
            ComputerOperationMethod::Unrestricted
        );
    }

    #[test]
    fn computer_method_idless_legacy_continuation_keeps_restriction() {
        let goal = Message::user().with_text("只用鼠标");
        let mut data = ExtensionData::new();
        save_unified_intent(&mut data, &[], &goal, "project", "tool_action");
        save_unified_intent(
            &mut data,
            &[goal],
            &Message::user().with_text("继续"),
            "project",
            "tool_action",
        );
        assert_eq!(
            saved_computer_method(&data),
            ComputerOperationMethod::MouseOnly
        );
    }

    #[test]
    fn computer_method_ignores_tool_output_and_unrelated_or_late_amendments() {
        let goal = Message::user().with_id("goal").with_text("只用鼠标");
        let mut data = ExtensionData::new();
        save_unified_intent(&mut data, &[], &goal, "project", "tool_action");
        for mut message in [
            Message::assistant().with_text("解除操作方式限制"),
            Message::user()
                .with_text("解除操作方式限制")
                .with_visibility(false, true),
            Message::user()
                .with_text("解除操作方式限制")
                .with_tool_response(
                    "tool",
                    Ok(rmcp::model::CallToolResult::success(vec![
                        rmcp::model::Content::text("解除操作方式限制"),
                    ])),
                ),
        ] {
            message.metadata.task_continuation_of = Some("goal".into());
            amend_computer_method(&mut data, &message);
            assert_eq!(
                saved_computer_method(&data),
                ComputerOperationMethod::MouseOnly
            );
        }
        let mut late = Message::user().with_text("继续，解除操作方式限制");
        late.metadata.task_continuation_of = Some("old-goal".into());
        amend_computer_method(&mut data, &late);
        assert_eq!(
            saved_computer_method(&data),
            ComputerOperationMethod::MouseOnly
        );
        assert_eq!(explicit_computer_method("不要只用鼠标"), None);
        assert_eq!(explicit_computer_method("解释为什么必须使用电脑控制"), None);
        assert!(!is_unified_continuation(
            "继续，解除操作方式限制，改做另一个任务"
        ));
        data.extension_states
            .get_mut("codepro_unified_turn.v1")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("computer_operation_method");
        assert_eq!(
            saved_computer_method(&data),
            ComputerOperationMethod::MouseOnly
        );
        assert_eq!(
            saved_computer_method(&ExtensionData::new()),
            ComputerOperationMethod::Unrestricted
        );
    }

    #[test]
    fn continuation_keeps_original_scope_and_does_not_revive_an_old_goal() {
        let user = Message::user()
            .with_id("original")
            .with_text("operate the desktop");
        let mut data = ExtensionData::new();
        save_unified_intent(&mut data, &[], &user, "D:/project", "tool_action");
        let messages = vec![
            user,
            Message::assistant()
                .with_tool_request("call", call("computer_focus", "window").tool_call),
            Message::user().with_text("继续"),
        ];
        assert_eq!(
            saved_unified_intent(&data, &messages, "D:/project"),
            Some(CodeProIntent::ToolAction)
        );
        assert_eq!(saved_unified_intent(&data, &messages, "D:/other"), None);
        let mut new_goal = messages;
        new_goal.push(Message::user().with_id("new").with_text("explain Rust"));
        assert_eq!(saved_unified_intent(&data, &new_goal, "D:/project"), None);
    }
}
