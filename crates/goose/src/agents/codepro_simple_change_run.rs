use crate::agents::codepro_report::{
    sanitize_report_block, sanitize_report_inline, CodeProReportClassification,
};
use crate::agents::user_report::{render_user_report_v1, UserReportV1};
use crate::conversation::message::{ToolRequest, ToolResponse};
use crate::permission::permission_judge::PermissionCheckResult;
use rmcp::model::{CallToolResult, Tool};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SimpleChangeStatus {
    Pass,
    Fail,
    Blocked,
    NotRun,
}

impl SimpleChangeStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "PASS",
            Self::Fail => "FAIL",
            Self::Blocked => "BLOCKED",
            Self::NotRun => "NOT_RUN",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimpleChangeOutcome {
    pub(crate) status: SimpleChangeStatus,
    pub(crate) target: PathBuf,
    pub(crate) command: Option<String>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) reason: String,
}

impl SimpleChangeOutcome {
    pub(crate) fn render_user_message(&self) -> String {
        let target = self.target.display().to_string();
        let visible_target = user_visible_target(&self.target);
        let reason = sanitize_report_block(self.reason.trim());
        let classification = match self.status {
            SimpleChangeStatus::Pass => None,
            SimpleChangeStatus::Fail => Some(CodeProReportClassification::TestFailure),
            SimpleChangeStatus::Blocked => Some(CodeProReportClassification::CodeProIncomplete),
            SimpleChangeStatus::NotRun => Some(CodeProReportClassification::Unverified),
        };
        let fixed = match self.status {
            SimpleChangeStatus::Pass => "已经修好，目标文件已修改且写入后验证通过。",
            SimpleChangeStatus::Fail => "尚未修好：测试失败，修改不能作为成功结果交付。",
            SimpleChangeStatus::Blocked => "CodePro 未完成：本轮修改被安全边界或执行条件阻止。",
            SimpleChangeStatus::NotRun => "未验证：当前修改不能作为已完成结果交付。",
        };
        let visible_change = match self.status {
            SimpleChangeStatus::Pass => "目标文件中的修改已经生效。",
            SimpleChangeStatus::Fail => "目标文件已修改，但失败证据已保留，尚未作为成功结果交付。",
            SimpleChangeStatus::Blocked => "本轮没有形成可交付的用户可见变化。",
            SimpleChangeStatus::NotRun => "目标文件已修改，但最后一次写入后的效果尚未验证。",
        };
        let verification = match self.status {
            SimpleChangeStatus::Pass => "- 写入后验证：通过。",
            SimpleChangeStatus::Fail => "- 测试失败：写入后验证已经运行且失败。",
            SimpleChangeStatus::Blocked => "- CodePro 未完成：验证没有形成可交付结果。",
            SimpleChangeStatus::NotRun => "- 未验证：最后一次写入后没有运行验证。",
        };
        let user_actions = match classification {
            None => Vec::new(),
            Some(classification) => {
                let next_step = match classification {
                    CodeProReportClassification::TestFailure => {
                        "修复失败原因后，重新运行同一写入后验证。"
                    }
                    CodeProReportClassification::CodeProIncomplete => {
                        "解除所列阻止原因后，从当前目标文件重新执行。"
                    }
                    CodeProReportClassification::Unverified => {
                        "对最后一次写入运行目标测试或最小确定性检查。"
                    }
                    CodeProReportClassification::ConfirmedBug
                    | CodeProReportClassification::EnvironmentProblem => {
                        unreachable!("simple change status cannot produce this classification")
                    }
                };
                vec![
                    format!("**{}**：{reason}", classification.label()),
                    format!("下一步：{next_step}"),
                ]
            }
        };
        let command = self.command.as_deref().unwrap_or("未运行");
        let exit_code = self
            .exit_code
            .map_or_else(|| "不适用".to_string(), |exit_code| exit_code.to_string());

        render_user_report_v1(&UserReportV1 {
            schema_version: 1,
            result: fixed.to_string(),
            agent_results: Vec::new(),
            changes: vec![
                format!(
                    "修改了 `{}`。",
                    sanitize_report_inline(&visible_target).replace('`', "\\`")
                ),
                visible_change.to_string(),
            ],
            verification: vec![verification.trim_start_matches("- ").to_string()],
            user_actions,
            technical_details: vec![
                format!("终态：{}", self.status.as_str()),
                format!("文件：`{}`", target.replace('`', "\\`")),
                format!("验证命令：`{}`", command.replace('`', "\\`")),
                format!("退出码：{exit_code}"),
                format!("说明：{reason}"),
            ],
        })
    }
}

fn user_visible_target(target: &Path) -> String {
    if !target.is_absolute() {
        return target.display().to_string().replace('\\', "/");
    }

    let parts = target
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let start = parts.len().saturating_sub(2);
    parts[start..].join("/")
}

pub(crate) fn simple_change_workspace_scope(
    working_dir: &Path,
    target: &Path,
    files_changed: &[String],
    sensitive_files_changed: &[String],
) -> Result<(bool, Vec<PathBuf>), String> {
    let root = working_dir
        .canonicalize()
        .map_err(|error| format!("无法规范化工作目录：{error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("无法规范化目标文件：{error}"))?;
    let target_relative = target
        .strip_prefix(&root)
        .map_err(|_| "目标文件不在工作目录内".to_string())?;
    let target_relative = normalize_evidence_path(&target_relative.to_string_lossy());
    let mut target_changed = false;
    let mut out_of_scope = BTreeSet::new();

    for path in files_changed {
        let normalized = normalize_workspace_evidence_path(&root, path);
        if evidence_paths_equal(&normalized, &target_relative) {
            target_changed = true;
        } else {
            out_of_scope.insert(PathBuf::from(path));
        }
    }
    out_of_scope.extend(sensitive_files_changed.iter().map(PathBuf::from));
    Ok((target_changed, out_of_scope.into_iter().collect()))
}

fn normalize_evidence_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn normalize_workspace_evidence_path(root: &Path, path: &str) -> String {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        if let Ok(relative) = candidate.strip_prefix(root) {
            return normalize_evidence_path(&relative.to_string_lossy());
        }
        if let Ok(canonical) = candidate.canonicalize() {
            if let Ok(relative) = canonical.strip_prefix(root) {
                return normalize_evidence_path(&relative.to_string_lossy());
            }
        }
    }
    normalize_evidence_path(path)
}

fn evidence_paths_equal(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

#[derive(Debug, Clone)]
enum PendingAction {
    Write,
    Validation { command: String },
}

#[derive(Debug, Clone)]
struct ValidationResult {
    write_generation: u64,
    command: String,
    exit_code: Option<i32>,
    failed: bool,
}

#[derive(Debug)]
pub(crate) struct SimpleChangeRunTracker {
    working_dir: PathBuf,
    target: PathBuf,
    tool_action_count: usize,
    write_generation: u64,
    pending: HashMap<String, PendingAction>,
    validation: Option<ValidationResult>,
    policy_denial: Option<String>,
}

impl SimpleChangeRunTracker {
    pub(crate) fn new(working_dir: PathBuf, target: PathBuf) -> Self {
        Self {
            working_dir,
            target,
            tool_action_count: 0,
            write_generation: 0,
            pending: HashMap::new(),
            validation: None,
            policy_denial: None,
        }
    }

    pub(crate) fn observe_request(&mut self, request: &ToolRequest) {
        self.tool_action_count += 1;
        let Ok(call) = &request.tool_call else {
            return;
        };
        match unqualified_tool_name(&call.name) {
            "write" | "edit" | "write_file" | "edit_file" => {
                if self.target_write_path(request).is_some() {
                    self.pending
                        .insert(request.id.clone(), PendingAction::Write);
                }
            }
            "shell" => {
                let command = call
                    .arguments
                    .as_ref()
                    .and_then(|arguments| arguments.get("command"))
                    .and_then(serde_json::Value::as_str);
                if self.has_successful_write() && command.is_some_and(is_validation_command) {
                    self.pending.insert(
                        request.id.clone(),
                        PendingAction::Validation {
                            command: command.unwrap_or_default().to_string(),
                        },
                    );
                }
            }
            _ => {}
        }
    }

    pub(crate) fn target_write_path(&self, request: &ToolRequest) -> Option<String> {
        let call = request.tool_call.as_ref().ok()?;
        matches!(
            unqualified_tool_name(&call.name),
            "write" | "edit" | "write_file" | "edit_file"
        )
        .then(|| {
            call.arguments
                .as_ref()
                .and_then(|arguments| arguments.get("path"))
                .and_then(serde_json::Value::as_str)
                .filter(|path| self.path_is_target(path))
                .map(str::to_string)
        })
        .flatten()
    }

    pub(crate) fn observe_response(&mut self, response: &ToolResponse) {
        let Some(action) = self.pending.remove(&response.id) else {
            return;
        };
        match action {
            PendingAction::Write => {
                if !tool_result_failed(&response.tool_result) {
                    self.write_generation += 1;
                    self.validation = None;
                }
            }
            PendingAction::Validation { command } => {
                self.validation = Some(ValidationResult {
                    write_generation: self.write_generation,
                    command,
                    exit_code: tool_exit_code(&response.tool_result),
                    failed: tool_result_failed(&response.tool_result),
                });
            }
        }
    }

    pub(crate) fn has_successful_write(&self) -> bool {
        self.write_generation > 0
    }

    pub(crate) fn tool_action_count(&self) -> usize {
        self.tool_action_count
    }

    pub(crate) fn outcome(
        &self,
        target_changed: bool,
        out_of_scope_files: Vec<PathBuf>,
        evidence_error: Option<String>,
    ) -> SimpleChangeOutcome {
        let blocked = |reason: String| SimpleChangeOutcome {
            status: SimpleChangeStatus::Blocked,
            target: self.target.clone(),
            command: self
                .validation
                .as_ref()
                .map(|result| result.command.clone()),
            exit_code: self.validation.as_ref().and_then(|result| result.exit_code),
            reason,
        };

        if let Some(error) = evidence_error {
            return blocked(format!("无法核验工作树证据：{error}"));
        }
        if let Some(reason) = &self.policy_denial {
            return blocked(reason.clone());
        }
        if !out_of_scope_files.is_empty() {
            return blocked(format!(
                "检测到目标外文件变更：{}",
                out_of_scope_files
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join("、")
            ));
        }
        if !target_changed || !self.has_successful_write() {
            return blocked("目标文件没有产生可核验的本轮修改".to_string());
        }
        let Some(validation) = self
            .validation
            .as_ref()
            .filter(|result| result.write_generation == self.write_generation)
        else {
            return SimpleChangeOutcome {
                status: SimpleChangeStatus::NotRun,
                target: self.target.clone(),
                command: None,
                exit_code: None,
                reason: "最后一次写入后没有运行相关验证".to_string(),
            };
        };
        let status = if validation.failed || validation.exit_code != Some(0) {
            SimpleChangeStatus::Fail
        } else {
            SimpleChangeStatus::Pass
        };
        SimpleChangeOutcome {
            status,
            target: self.target.clone(),
            command: Some(validation.command.clone()),
            exit_code: validation.exit_code,
            reason: match status {
                SimpleChangeStatus::Pass => "目标修改和写入后验证均已核验".to_string(),
                SimpleChangeStatus::Fail => "写入后验证失败，变更和失败证据已保留".to_string(),
                _ => unreachable!("terminal validation can only pass or fail"),
            },
        }
    }

    fn path_is_target(&self, value: &str) -> bool {
        let path = Path::new(value);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.working_dir.join(path)
        };
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            return false;
        };
        if !metadata.is_file() || is_link_or_reparse_point(&metadata) {
            return false;
        }
        path.canonicalize().is_ok_and(|path| path == self.target)
    }

    fn observe_policy_denial(&mut self, request: &ToolRequest) {
        let tool_name = request
            .tool_call
            .as_ref()
            .map(|call| unqualified_tool_name(&call.name))
            .unwrap_or("unknown");
        self.policy_denial
            .get_or_insert_with(|| format!("操作需要调整或扩大用户授权范围：{tool_name}"));
    }
}

pub(crate) fn enforce_simple_change_permissions(
    permission_result: &mut PermissionCheckResult,
    requests: &[ToolRequest],
    tools: &[Tool],
    tracker: &mut SimpleChangeRunTracker,
) {
    for request in requests {
        if simple_change_request_allowed(request, tools, tracker) {
            if let Some(index) = permission_result
                .needs_approval
                .iter()
                .position(|candidate| candidate.id == request.id)
            {
                let approved = permission_result.needs_approval.remove(index);
                if !permission_result
                    .approved
                    .iter()
                    .any(|candidate| candidate.id == request.id)
                {
                    permission_result.approved.push(approved);
                }
            }
            continue;
        }
        tracker.observe_policy_denial(request);
        permission_result
            .approved
            .retain(|candidate| candidate.id != request.id);
        permission_result
            .needs_approval
            .retain(|candidate| candidate.id != request.id);
        if !permission_result
            .denied
            .iter()
            .any(|candidate| candidate.id == request.id)
        {
            permission_result.denied.push(request.clone());
        }
    }
}

fn simple_change_request_allowed(
    request: &ToolRequest,
    tools: &[Tool],
    tracker: &SimpleChangeRunTracker,
) -> bool {
    let Ok(call) = &request.tool_call else {
        return true;
    };
    let Some(tool) = tools.iter().find(|tool| tool.name == call.name) else {
        return false;
    };
    match unqualified_tool_name(&call.name) {
        "read" | "read_document" | "tree" | "read_image" | "search" => true,
        "write" | "edit" | "write_file" | "edit_file" => call
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("path"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|path| tracker.path_is_target(path)),
        "shell" => call
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("command"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_validation_command),
        _ => {
            tool.annotations
                .as_ref()
                .and_then(|annotations| annotations.read_only_hint)
                == Some(true)
        }
    }
}

fn unqualified_tool_name(name: &str) -> &str {
    name.rsplit("__").next().unwrap_or(name)
}

pub(crate) fn is_validation_command(command: &str) -> bool {
    if crate::agents::tester_runtime::is_bounded_absolute_python_validation_command(command) {
        return true;
    }
    crate::agents::validation_invocation::ValidationInvocation::parse(command, Path::new("."))
        .is_ok()
}

pub(crate) fn has_forbidden_shell_syntax(command: &str) -> bool {
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    let chars = command.chars().collect::<Vec<_>>();

    for (index, character) in chars.iter().copied().enumerate() {
        if matches!(character, '\r' | '\n') {
            return true;
        }
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quoted {
            escaped = true;
            continue;
        }
        if character == '\'' && !double_quoted {
            single_quoted = !single_quoted;
            continue;
        }
        if character == '"' && !single_quoted {
            double_quoted = !double_quoted;
            continue;
        }
        if single_quoted || double_quoted {
            continue;
        }
        if matches!(character, ';' | '&' | '|' | '>' | '<' | '`') {
            return true;
        }
        if character == '$' && matches!(chars.get(index + 1), Some('(' | '{')) {
            return true;
        }
    }

    single_quoted || double_quoted
}

pub(crate) fn tool_result_failed(result: &crate::mcp_utils::ToolResult<CallToolResult>) -> bool {
    match result {
        Err(_) => true,
        Ok(result) => result.is_error == Some(true),
    }
}

pub(crate) fn tool_result_eligible_for_success_progress(
    result: &crate::mcp_utils::ToolResult<CallToolResult>,
) -> bool {
    if tool_result_failed(result) {
        return false;
    }
    let Ok(result) = result else {
        return false;
    };
    let receipt = result.structured_content.clone().or_else(|| {
        result.content.iter().find_map(|content| {
            content
                .as_text()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text.text).ok())
        })
    });
    !receipt.as_ref().is_some_and(tool_receipt_is_unverified)
}

pub(crate) fn tool_receipt_is_unverified(value: &serde_json::Value) -> bool {
    value
        .get("outcome")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|outcome| matches!(outcome, "unknown" | "didnt" | "failed" | "blocked"))
        || value.get("success") == Some(&serde_json::Value::Bool(false))
        || value.get("error").is_some_and(|error| !error.is_null())
}

pub(crate) fn tool_exit_code(result: &crate::mcp_utils::ToolResult<CallToolResult>) -> Option<i32> {
    let result = result.as_ref().ok()?;
    if let Some(exit_code) = result
        .structured_content
        .as_ref()
        .and_then(|structured| {
            structured
                .get("exit_code")
                .or_else(|| structured.get("exitCode"))
        })
        .and_then(serde_json::Value::as_i64)
        .and_then(|exit_code| i32::try_from(exit_code).ok())
    {
        return Some(exit_code);
    }
    result.content.iter().find_map(|content| {
        let text = content.as_text()?.text.to_ascii_lowercase();
        let suffix = text.split_once("exit code:")?.1.trim_start();
        suffix
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<i32>().ok())
    })
}

fn is_link_or_reparse_point(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{
        enforce_simple_change_permissions, is_validation_command, simple_change_workspace_scope,
        tool_result_eligible_for_success_progress, tool_result_failed, SimpleChangeOutcome,
        SimpleChangeRunTracker, SimpleChangeStatus,
    };
    use crate::conversation::message::{ToolRequest, ToolResponse};
    use crate::permission::permission_judge::PermissionCheckResult;
    use rmcp::model::{CallToolRequestParams, CallToolResult, Content, Tool, ToolAnnotations};
    use serde_json::json;
    use std::path::{Path, PathBuf};

    #[test]
    fn explicit_unverified_receipts_do_not_extend_the_success_budget() {
        use crate::agents::action_budget::{
            classify_successful_tool_effect, ActionBudgetDecision, ActionBudgetTracker,
            CodeProActionBudgetPolicy,
        };
        use crate::agents::agent_role::CodeProTaskKind;
        for outcome in ["unknown", "didnt", "failed", "blocked", "worked"] {
            for structured in [true, false] {
                let receipt = json!({"outcome":outcome});
                let mut result = CallToolResult::success(vec![Content::text(receipt.to_string())]);
                if structured {
                    result.structured_content = Some(receipt);
                }
                let response = ToolResponse {
                    id: "call".into(),
                    tool_result: Ok(result),
                    metadata: None,
                };
                let request = request("call", "computer_click", json!({"x":10,"y":20}));
                let mut budget = ActionBudgetTracker::from_policy(
                    CodeProActionBudgetPolicy::for_task_kind(CodeProTaskKind::ToolAction),
                    100,
                );
                if tool_result_eligible_for_success_progress(&response.tool_result) {
                    budget.observe_successful_tool_effect(classify_successful_tool_effect(
                        &request, &response,
                    ));
                }
                assert_eq!(budget.successful_action_seen(), outcome == "worked");
                assert_eq!(
                    budget.prepare_turn(26),
                    if outcome == "worked" {
                        ActionBudgetDecision::Execute
                    } else {
                        ActionBudgetDecision::Finalize
                    }
                );
                assert!(!tool_result_failed(&response.tool_result));
            }
        }
    }

    #[test]
    fn success_eligibility_keeps_ordinary_success_and_error_semantics() {
        for body in [
            "ordinary successful output",
            "the word unknown is not a receipt",
            r#"{"value":"unknown"}"#,
        ] {
            let result = Ok(CallToolResult::success(vec![Content::text(body)]));
            assert!(tool_result_eligible_for_success_progress(&result));
            assert!(!tool_result_failed(&result));
        }
        let error = Ok(CallToolResult::error(vec![Content::text("failed")]));
        assert!(!tool_result_eligible_for_success_progress(&error));
        assert!(tool_result_failed(&error));
        let transport = Err(rmcp::model::ErrorData::internal_error("transport", None));
        assert!(!tool_result_eligible_for_success_progress(&transport));
        assert!(tool_result_failed(&transport));
    }

    #[test]
    fn consumer_unknown_budget_rejects_semantic_failure_receipts() {
        for receipt in [
            json!({"success":false}),
            json!({"error":{}}),
            json!({"outcome":"worked","error":"not verified"}),
        ] {
            for structured in [true, false] {
                let mut result = CallToolResult::success(vec![Content::text(receipt.to_string())]);
                if structured {
                    result.structured_content = Some(receipt.clone());
                }
                assert!(!tool_result_eligible_for_success_progress(&Ok(
                    result.clone()
                )));
                assert!(!tool_result_failed(&Ok(result)));
            }
        }
    }

    fn create_file(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().expect("test file should have a parent")).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn request(id: &str, name: &str, arguments: serde_json::Value) -> ToolRequest {
        ToolRequest {
            id: id.to_string(),
            tool_call: Ok(CallToolRequestParams::new(name.to_string()).with_arguments(
                arguments
                    .as_object()
                    .expect("tool arguments should be an object")
                    .clone(),
            )),
            metadata: None,
            tool_meta: None,
        }
    }

    fn response(id: &str, mut result: CallToolResult) -> ToolResponse {
        ToolResponse {
            id: id.to_string(),
            tool_result: Ok({
                result.meta = None;
                result
            }),
            metadata: None,
        }
    }

    fn successful_response(id: &str) -> ToolResponse {
        response(id, CallToolResult::success(vec![Content::text("ok")]))
    }

    fn structured_shell_response(id: &str, exit_code: i32) -> ToolResponse {
        let mut result = if exit_code == 0 {
            CallToolResult::success(vec![Content::text("tests passed")])
        } else {
            CallToolResult::error(vec![Content::text("tests failed")])
        };
        result.structured_content = Some(json!({
            "stdout": "test output",
            "stderr": "",
            "exit_code": exit_code,
        }));
        response(id, result)
    }

    fn tool(name: &str) -> Tool {
        Tool::new(name.to_string(), String::new(), serde_json::Map::new())
    }

    fn read_only_tool(name: &str) -> Tool {
        tool(name).annotate(ToolAnnotations::with_title("Read only").read_only(true))
    }

    fn permissions(requests: &[ToolRequest]) -> PermissionCheckResult {
        PermissionCheckResult {
            approved: requests.to_vec(),
            needs_approval: Vec::new(),
            denied: Vec::new(),
        }
    }

    fn ids(requests: &[ToolRequest]) -> Vec<&str> {
        requests.iter().map(|request| request.id.as_str()).collect()
    }

    fn tracker(project: &Path, target: &Path) -> SimpleChangeRunTracker {
        SimpleChangeRunTracker::new(
            project.canonicalize().unwrap(),
            target.canonicalize().unwrap(),
        )
    }

    fn record_successful_write(tracker: &mut SimpleChangeRunTracker, target: &str) {
        let write = request("write-1", "developer__edit", json!({"path": target}));
        tracker.observe_request(&write);
        tracker.observe_response(&successful_response("write-1"));
        assert!(tracker.has_successful_write());
    }

    #[test]
    fn codepro_simple_change_run_status_uses_stable_evidence_labels() {
        assert_eq!(SimpleChangeStatus::Pass.as_str(), "PASS");
        assert_eq!(SimpleChangeStatus::Fail.as_str(), "FAIL");
        assert_eq!(SimpleChangeStatus::Blocked.as_str(), "BLOCKED");
        assert_eq!(SimpleChangeStatus::NotRun.as_str(), "NOT_RUN");
    }

    #[test]
    fn workspace_scope_accepts_canonical_absolute_target_evidence() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("src").join("button.js");
        create_file(&target, "export const label = 'new';\n");
        let absolute_evidence = target.canonicalize().unwrap().display().to_string();

        let (target_changed, out_of_scope) =
            simple_change_workspace_scope(project.path(), &target, &[absolute_evidence], &[])
                .unwrap();

        assert!(target_changed);
        assert!(out_of_scope.is_empty());
    }

    #[test]
    fn simple_change_reports_all_terminal_states_with_the_fix_section_order() {
        let cases = [
            (
                SimpleChangeStatus::Pass,
                Some("cargo test -p app title_test"),
                Some(0),
                "目标修改和写入后验证均已核验",
                true,
            ),
            (
                SimpleChangeStatus::Fail,
                Some("cargo test -p app title_test"),
                Some(1),
                "写入后验证失败，变更和失败证据已保留",
                false,
            ),
            (
                SimpleChangeStatus::Blocked,
                Some("cargo check -p app"),
                None,
                "检测到目标外文件变更",
                false,
            ),
            (
                SimpleChangeStatus::NotRun,
                None,
                None,
                "最后一次写入后没有运行相关验证",
                false,
            ),
        ];

        for (status, command, exit_code, reason, fixed) in cases {
            let report = SimpleChangeOutcome {
                status,
                target: PathBuf::from(r"D:\workspace\src\app.rs"),
                command: command.map(str::to_string),
                exit_code,
                reason: reason.to_string(),
            }
            .render_user_message();
            let headings = [
                "## 执行 Agent",
                "做了什么：",
                "结果：",
                "## 总结",
                "<details>",
            ];
            let positions = headings
                .iter()
                .map(|heading| {
                    assert_eq!(
                        report.matches(heading).count(),
                        1,
                        "{}: {heading}\n{report}",
                        status.as_str()
                    );
                    report.find(heading).unwrap()
                })
                .collect::<Vec<_>>();
            let beginner = report
                .get(..positions[4])
                .expect("details position comes from a UTF-8 marker");
            let technical = report
                .get(positions[4]..)
                .expect("details position comes from a UTF-8 marker");

            assert!(report.starts_with("# 任务报告"));
            assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
            assert_eq!(report.contains("### 接下来需要你做什么"), !fixed);
            assert!(beginner.contains("src/app.rs"));
            assert_eq!(beginner.contains("已经修好"), fixed);
            assert!(!beginner.contains("cargo test -p app title_test"));
            assert!(!beginner.contains("cargo check -p app"));
            assert!(!beginner.contains("退出码"));
            assert!(technical.contains(status.as_str()));
            if let Some(command) = command {
                assert!(technical.contains(command));
            }
            if let Some(exit_code) = exit_code {
                assert!(technical.contains(&format!("退出码：{exit_code}")));
            }
        }
    }

    #[test]
    fn user_report_uses_planned_failure_classifications() {
        let cases = [
            (
                SimpleChangeStatus::Fail,
                "测试失败",
                Some("cargo test -p app title_test"),
                Some(1),
                "目标测试未通过",
            ),
            (
                SimpleChangeStatus::Blocked,
                "CodePro 未完成",
                None,
                None,
                "安全边界阻止目标外写入",
            ),
            (
                SimpleChangeStatus::NotRun,
                "未验证",
                None,
                None,
                "最后一次写入后没有运行验证",
            ),
        ];

        for (status, classification, command, exit_code, reason) in cases {
            let report = SimpleChangeOutcome {
                status,
                target: PathBuf::from("src/app.rs"),
                command: command.map(str::to_string),
                exit_code,
                reason: reason.to_string(),
            }
            .render_user_message();
            let beginner = report.split("<details>").next().unwrap_or(&report);

            assert!(
                beginner.contains(classification),
                "{} missing {classification}\n{beginner}",
                status.as_str()
            );
            assert!(beginner.contains("src/app.rs"));
            assert!(!beginner.contains(r"D:\workspace"));
            assert!(beginner.contains("下一步："));
            assert!(!beginner.contains("cargo test -p app title_test"));
            assert!(!beginner.contains("退出码"));
        }
    }

    #[test]
    fn codepro_simple_change_run_allows_only_the_target_write() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("src/app.rs");
        let other = project.path().join("src/other.rs");
        create_file(&target, "old\n");
        create_file(&other, "other\n");
        let mut tracker = tracker(project.path(), &target);
        let target_write = request(
            "target-write",
            "developer__edit",
            json!({"path": "src/app.rs"}),
        );
        let other_write = request(
            "other-write",
            "developer__write",
            json!({"path": "src/other.rs", "content": "changed"}),
        );
        let requests = vec![target_write, other_write];
        let mut result = permissions(&requests);

        enforce_simple_change_permissions(
            &mut result,
            &requests,
            &[tool("developer__edit"), tool("developer__write")],
            &mut tracker,
        );

        assert_eq!(ids(&result.approved), vec!["target-write"]);
        assert_eq!(ids(&result.denied), vec!["other-write"]);
    }

    #[test]
    fn codepro_simple_change_run_cannot_pass_after_a_policy_denied_write() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.txt");
        let test_file = project.path().join("app.test.mjs");
        create_file(&target, "old\n");
        create_file(&test_file, "old test\n");
        let mut tracker = tracker(project.path(), &target);

        record_successful_write(&mut tracker, "app.txt");

        let denied_test_write = request(
            "test-write",
            "developer__write",
            json!({"path": "app.test.mjs", "content": "updated test"}),
        );
        let mut result = permissions(std::slice::from_ref(&denied_test_write));
        enforce_simple_change_permissions(
            &mut result,
            std::slice::from_ref(&denied_test_write),
            &[tool("developer__write")],
            &mut tracker,
        );
        assert_eq!(ids(&result.denied), vec!["test-write"]);

        let shell = request("test", "developer__shell", json!({"command": "npm test"}));
        tracker.observe_request(&shell);
        tracker.observe_response(&structured_shell_response("test", 0));

        let outcome = tracker.outcome(true, Vec::new(), None);
        assert_eq!(outcome.status, SimpleChangeStatus::Blocked);
        assert!(outcome.reason.contains("需要调整或扩大用户授权范围"));
    }

    #[test]
    fn codepro_simple_change_run_allows_read_only_tools_and_denies_unknown_mutators() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.rs");
        create_file(&target, "old\n");
        let mut tracker = tracker(project.path(), &target);
        let read = request("read", "developer__read", json!({"path": "app.rs"}));
        let search = request("search", "search", json!({"query": "unsafe"}));
        let diagnostic = request("diagnostic", "inspect_symbols", json!({}));
        let unknown = request("unknown", "deploy_project", json!({}));
        let requests = vec![read, search, diagnostic, unknown];
        let mut result = permissions(&requests);

        enforce_simple_change_permissions(
            &mut result,
            &requests,
            &[
                tool("developer__read"),
                tool("search"),
                read_only_tool("inspect_symbols"),
                tool("deploy_project"),
            ],
            &mut tracker,
        );

        assert_eq!(ids(&result.approved), vec!["read", "search", "diagnostic"]);
        assert_eq!(ids(&result.denied), vec!["unknown"]);
    }

    #[test]
    fn codepro_simple_change_run_allows_safe_read_only_validation_before_a_write() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.rs");
        create_file(&target, "old\n");
        let mut tracker = tracker(project.path(), &target);
        let shell = request(
            "test",
            "developer__shell",
            json!({"command": "cargo test -p app title_test"}),
        );
        let mut result = PermissionCheckResult {
            approved: Vec::new(),
            needs_approval: vec![shell.clone()],
            denied: Vec::new(),
        };

        enforce_simple_change_permissions(
            &mut result,
            std::slice::from_ref(&shell),
            &[tool("developer__shell")],
            &mut tracker,
        );

        assert_eq!(ids(&result.approved), vec!["test"]);
        assert!(result.denied.is_empty());
    }

    #[test]
    fn codepro_validation_accepts_node_script_but_rejects_inline_node_code() {
        assert!(is_validation_command("node tests.js"));
        assert!(is_validation_command("node ./tests/check.mjs --verbose"));
        assert!(!is_validation_command("node -e console.log('ok')"));
        assert!(!is_validation_command("node --eval console.log('ok')"));
    }

    #[test]
    fn shell_syntax_guard_ignores_quoted_program_text_but_rejects_shell_composition() {
        assert!(!super::has_forbidden_shell_syntax(
            r#"python -c "import sys; sys.exit(42)""#
        ));
        assert!(!super::has_forbidden_shell_syntax(
            r#""C:\tools&A\.venv\Scripts\python.exe" -m pytest -q"#
        ));
        assert!(super::has_forbidden_shell_syntax(
            r#"python -c "print('ok')" & whoami"#
        ));
        assert!(super::has_forbidden_shell_syntax("cargo test > result.txt"));
    }

    #[test]
    fn codepro_validation_accepts_git_diff_check_but_rejects_mutating_git_commands() {
        assert!(is_validation_command("git diff --check"));
        assert!(is_validation_command("git.exe diff --check"));
        assert!(!is_validation_command("git add ."));
        assert!(!is_validation_command("git checkout -- app.rs"));
    }

    #[test]
    fn codepro_validation_accepts_read_only_windows_file_checks() {
        assert!(is_validation_command(
            r#"findstr /C:\"expected text\" D:\project\index.html"#
        ));
        assert!(is_validation_command(r#"type D:\project\index.html"#));
        assert!(!is_validation_command(
            r#"findstr /C:\"expected text\" D:\project\index.html & del D:\project\index.html"#
        ));
    }

    #[test]
    fn codepro_validation_accepts_bounded_absolute_python_checks() {
        let python = if cfg!(windows) {
            r#"C:\workspace\.venv\Scripts\python.exe"#
        } else {
            "/workspace/.venv/bin/python"
        };
        assert!(is_validation_command(&format!(
            r#""{python}" -m pytest -q"#
        )));
        assert!(is_validation_command(&format!(
            r#""{python}" -m ruff check . --no-cache"#
        )));
        if cfg!(windows) {
            assert!(is_validation_command(&format!(r#"{python} -m pytest -q"#)));
            assert!(is_validation_command(&format!(
                r#"{python} -m ruff check . --no-cache"#
            )));
        }
        assert!(!is_validation_command(&format!(
            r#""{python}" -m ruff check . --fix"#
        )));
        assert!(!is_validation_command(&format!(
            r#""{python}" -m pip install package"#
        )));
    }

    #[test]
    fn codepro_simple_change_run_allows_one_validation_command_after_write() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.rs");
        create_file(&target, "old\n");
        let mut tracker = tracker(project.path(), &target);
        record_successful_write(&mut tracker, "app.rs");
        let shell = request(
            "test",
            "developer__shell",
            json!({"command": "cargo test -p app title_test"}),
        );
        let mut result = PermissionCheckResult {
            approved: Vec::new(),
            needs_approval: vec![shell.clone()],
            denied: Vec::new(),
        };

        enforce_simple_change_permissions(
            &mut result,
            std::slice::from_ref(&shell),
            &[tool("developer__shell")],
            &mut tracker,
        );

        assert_eq!(ids(&result.approved), vec!["test"]);
        assert!(result.needs_approval.is_empty());
        assert!(result.denied.is_empty());
    }

    #[test]
    fn codepro_simple_change_run_rejects_composed_or_mutating_shell_commands() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.rs");
        create_file(&target, "old\n");
        let mut tracker = tracker(project.path(), &target);
        record_successful_write(&mut tracker, "app.rs");

        for (index, command) in [
            "cargo test > result.txt",
            "cargo test | Tee-Object result.txt",
            "cargo test && echo done",
            "cargo test; Remove-Item app.rs",
            "Set-Content app.rs changed",
            "Remove-Item app.rs",
            "rm app.rs",
            "mv app.rs old.rs",
            "cp app.rs copy.rs",
        ]
        .into_iter()
        .enumerate()
        {
            let shell = request(
                &format!("shell-{index}"),
                "developer__shell",
                json!({"command": command}),
            );
            let mut result = permissions(std::slice::from_ref(&shell));
            enforce_simple_change_permissions(
                &mut result,
                std::slice::from_ref(&shell),
                &[tool("developer__shell")],
                &mut tracker,
            );
            assert!(result.approved.is_empty(), "command: {command}");
            assert_eq!(result.denied.len(), 1, "command: {command}");
        }
    }

    #[test]
    fn codepro_simple_change_run_requires_validation_after_the_last_write() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.rs");
        create_file(&target, "old\n");
        let mut tracker = tracker(project.path(), &target);
        record_successful_write(&mut tracker, "app.rs");
        let shell = request(
            "test-1",
            "developer__shell",
            json!({"command": "cargo test -p app title_test"}),
        );
        tracker.observe_request(&shell);
        tracker.observe_response(&structured_shell_response("test-1", 0));
        assert_eq!(
            tracker.outcome(true, Vec::new(), None).status,
            SimpleChangeStatus::Pass
        );

        let second_write = request("write-2", "developer__edit", json!({"path": "app.rs"}));
        tracker.observe_request(&second_write);
        tracker.observe_response(&successful_response("write-2"));

        assert_eq!(
            tracker.outcome(true, Vec::new(), None).status,
            SimpleChangeStatus::NotRun
        );
    }

    #[test]
    fn codepro_simple_change_run_records_structured_and_acp_text_exit_codes() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.rs");
        create_file(&target, "old\n");
        let mut tracker = tracker(project.path(), &target);
        record_successful_write(&mut tracker, "app.rs");
        let shell = request(
            "test-structured",
            "developer__shell",
            json!({"command": "cargo test -p app title_test"}),
        );
        tracker.observe_request(&shell);
        tracker.observe_response(&structured_shell_response("test-structured", 3));
        let outcome = tracker.outcome(true, Vec::new(), None);
        assert_eq!(outcome.status, SimpleChangeStatus::Fail);
        assert_eq!(outcome.exit_code, Some(3));

        let retry = request(
            "test-acp",
            "developer__shell",
            json!({"command": "cargo test -p app title_test"}),
        );
        tracker.observe_request(&retry);
        tracker.observe_response(&response(
            "test-acp",
            CallToolResult::error(vec![Content::text("exit code: 7\ntests failed")]),
        ));
        let outcome = tracker.outcome(true, Vec::new(), None);
        assert_eq!(outcome.status, SimpleChangeStatus::Fail);
        assert_eq!(outcome.exit_code, Some(7));
    }

    #[test]
    fn codepro_simple_change_run_computes_blocked_and_not_run_outcomes() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("app.rs");
        create_file(&target, "old\n");
        let mut tracker = tracker(project.path(), &target);
        record_successful_write(&mut tracker, "app.rs");

        assert_eq!(
            tracker.outcome(false, Vec::new(), None).status,
            SimpleChangeStatus::Blocked
        );
        assert_eq!(
            tracker
                .outcome(true, vec![PathBuf::from("src/other.rs")], None)
                .status,
            SimpleChangeStatus::Blocked
        );
        assert_eq!(
            tracker
                .outcome(true, Vec::new(), Some("evidence unavailable".to_string()))
                .status,
            SimpleChangeStatus::Blocked
        );
        assert_eq!(
            tracker.outcome(true, Vec::new(), None).status,
            SimpleChangeStatus::NotRun
        );
    }
}
