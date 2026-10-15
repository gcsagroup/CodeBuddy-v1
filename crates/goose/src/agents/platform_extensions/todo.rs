use crate::agents::extension::PlatformExtensionContext;
use crate::agents::mcp_client::{Error, McpClientTrait};
use crate::agents::tool_execution::ToolCallContext;
use crate::session::extension_data;
use crate::session::extension_data::ExtensionState;
use anyhow::Result;
use async_trait::async_trait;
use indoc::indoc;
use rmcp::model::{
    CallToolResult, Content, Implementation, InitializeResult, JsonObject, ListToolsResult,
    ServerCapabilities, Tool, ToolAnnotations,
};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub static EXTENSION_NAME: &str = "todo";

/// Capture once at execution entry, never from the growing live conversation.
pub(crate) fn checklist_request_ids(
    messages: &[crate::conversation::message::Message],
) -> std::collections::HashSet<String> {
    use crate::conversation::message::MessageContent;
    messages
        .iter()
        .flat_map(|message| message.content.iter())
        .filter_map(|content| match content {
            MessageContent::ToolRequest(request)
                if request.tool_call.as_ref().is_ok_and(|call| {
                    matches!(call.name.as_ref(), "todo__todo_write" | "todo_write")
                }) =>
            {
                Some(request.id.clone())
            }
            _ => None,
        })
        .collect()
}

/// Provider projection only. Preserve this execution's calls and failures so
/// the model can correct them; only older lists are replaced by bound context.
pub(crate) fn without_historical_checklists(
    mut messages: Vec<crate::conversation::message::Message>,
    historical_ids: &std::collections::HashSet<String>,
) -> Vec<crate::conversation::message::Message> {
    use crate::conversation::message::MessageContent;
    for message in &mut messages {
        message.content.retain(|content| match content {
            MessageContent::ToolRequest(request) => !historical_ids.contains(&request.id),
            MessageContent::ToolResponse(response) => !historical_ids.contains(&response.id),
            _ => true,
        });
    }
    messages.retain(|message| !message.content.is_empty());
    crate::conversation::fix_conversation(crate::conversation::Conversation::new_unvalidated(
        messages,
    ))
    .0
    .messages()
    .clone()
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct TodoWriteParams {
    content: String,
}

pub struct TodoClient {
    info: InitializeResult,
    context: PlatformExtensionContext,
}

impl TodoClient {
    pub fn new(context: PlatformExtensionContext) -> Result<Self> {
        let info = InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(EXTENSION_NAME.to_string(), "1.0.0".to_string())
                    .with_title("Todo"),
            )
            .with_instructions(
                indoc! {r#"
                Your todo content is automatically available in your context.

                Workflow:
                - Start: write initial checklist
                - During: mark the item you are actually working on with [-] before starting it;
                  use present-tense wording for that item, and [x] only after its work is done.
                  Keep not-yet-started items [ ]. A checklist is not task acceptance.
                - End: verify all complete

                Template:
                - [x] Requirement 1
                - [-] Working on the current task
                  - [ ] Sub-task
                - [ ] Requirement 2
                - [ ] Another task
            "#}
                .to_string(),
            );

        Ok(Self { info, context })
    }

    async fn handle_write_todo(
        &self,
        ctx: &ToolCallContext,
        arguments: Option<JsonObject>,
    ) -> Result<CallToolResult, String> {
        let session_id = &ctx.session_id;
        let content = arguments
            .as_ref()
            .ok_or("Missing arguments")?
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("Missing required parameter: content")?
            .to_string();

        let char_count = content.chars().count();
        let max_chars = std::env::var("GOOSE_TODO_MAX_CHARS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(50_000);

        if max_chars > 0 && char_count > max_chars {
            return Err(format!(
                "Todo list too large: {} chars (max: {})",
                char_count, max_chars
            ));
        }

        let manager = &self.context.session_manager;
        match manager.get_session(session_id, false).await {
            Ok(mut session) => {
                if session.session_type == crate::session::SessionType::CodePro {
                    let scope = ctx
                        .codepro_task_scope
                        .as_ref()
                        // Checklist ownership does not require workspace-wide write authority.
                        .filter(|scope| {
                            scope.task_id() == "main-agent"
                                && scope.permission_session_id() == Some(session_id.as_str())
                        })
                        .ok_or(
                            "A CodePro checklist needs the host's current Main Agent task binding",
                        )?;
                    let runtime = ctx
                        .codepro_runtime
                        .as_ref()
                        .ok_or("Task runtime unavailable")?;
                    let run_id = crate::agents::protocol::RunId::new(scope.run_id().to_owned())
                        .map_err(|e| e.to_string())?;
                    let snapshot = runtime
                        .snapshot(session_id, &run_id)
                        .await
                        .map_err(|e| e.to_string())?;
                    let binding = extension_data::TodoBinding {
                        session_id: session_id.clone(),
                        run_id: run_id.to_string(),
                        requirement_revision: snapshot.projection.user_requirement_revision,
                    };
                    let plan = extension_data::BoundTodo {
                        binding: binding.clone(),
                        content,
                        request_id: ctx
                            .tool_call_request_id
                            .clone()
                            .ok_or("Checklist call ID unavailable")?,
                    };
                    let state = manager
                        .update_codepro_todo(session_id, Some(binding), Some(plan))
                        .await
                        .map_err(|e| e.to_string())?;
                    let mut result = CallToolResult::success(vec![Content::text(format!(
                        "Updated ({} chars)",
                        char_count
                    ))]);
                    result.structured_content =
                        Some(serde_json::json!({"codepro_plan": state.current()}));
                    return Ok(result);
                }
                let todo_state = extension_data::TodoState::new(content);
                if todo_state
                    .to_extension_data(&mut session.extension_data)
                    .is_ok()
                {
                    match manager
                        .update(session_id)
                        .extension_data(session.extension_data)
                        .apply()
                        .await
                    {
                        Ok(_) => Ok(CallToolResult::success(vec![Content::text(format!(
                            "Updated ({} chars)",
                            char_count
                        ))])),
                        Err(_) => Err("Failed to update session metadata".to_string()),
                    }
                } else {
                    Err("Failed to serialize TODO state".to_string())
                }
            }
            Err(_) => Err("Failed to read session metadata".to_string()),
        }
    }

    fn get_tools() -> Vec<Tool> {
        let schema = schema_for!(TodoWriteParams);
        let schema_value =
            serde_json::to_value(schema).expect("Failed to serialize TodoWriteParams schema");

        vec![Tool::new(
            "todo_write".to_string(),
            indoc! {r#"
                    Overwrite the entire TODO content for the host-bound current task.

                    The content persists across conversation turns and compaction. Use this for:
                    - Task tracking and progress updates
                    - Important notes and reminders

                    Use a checklist for multi-step work, not greetings, arithmetic or incidental
                    questions. Continue the existing checklist for the same task. After a requirement
                    revision, inspect the contract and update the checklist, preserving still-valid
                    progress. The host binds ownership; never copy another task's checklist.

                    Checklist notation: [ ] pending, [-] explicitly in progress, [x] completed.
                    Mark the current step before work starts. Do not infer completion from time
                    elapsed; keep unfinished items when updating the entire list.

                    WARNING: This operation completely replaces the existing content. Always include
                    all content you want to keep, not just the changes.
                "#}
            .to_string(),
            schema_value.as_object().unwrap().clone(),
        )
        .annotate(ToolAnnotations::from_raw(
            Some("Write TODO".to_string()),
            // This only replaces CodePro's private per-session checklist. It has no
            // project, filesystem, external-service, or open-world side effects.
            Some(true),
            Some(false),
            Some(true),
            Some(false),
        ))]
    }
}

#[async_trait]
impl McpClientTrait for TodoClient {
    async fn list_tools(
        &self,
        _session_id: &str,
        _next_cursor: Option<String>,
        _cancellation_token: CancellationToken,
    ) -> Result<ListToolsResult, Error> {
        Ok(ListToolsResult {
            tools: Self::get_tools(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        ctx: &ToolCallContext,
        name: &str,
        arguments: Option<JsonObject>,
        _cancellation_token: CancellationToken,
    ) -> Result<CallToolResult, Error> {
        let content = match name {
            "todo_write" => self.handle_write_todo(ctx, arguments).await,
            _ => Err(format!("Unknown tool: {}", name)),
        };

        match content {
            Ok(result) => Ok(result),
            Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Error: {}",
                error
            ))])),
        }
    }

    fn get_info(&self) -> Option<&InitializeResult> {
        Some(&self.info)
    }

    async fn get_moim(&self, session_id: &str) -> Option<String> {
        let metadata = self
            .context
            .session_manager
            .get_session(session_id, false)
            .await
            .ok()?;

        if metadata.session_type == crate::session::SessionType::CodePro {
            let state =
                extension_data::CodeProTodoState::from_extension_data(&metadata.extension_data)?;
            if state
                .selected
                .as_ref()
                .is_none_or(|binding| binding.session_id != session_id)
            {
                return None;
            }
            return Some(match state.current() {
                Some(plan) => format!(
                    "Current task checklist (not acceptance evidence):\n{}\n",
                    plan.content
                ),
                None => {
                    let previous = state
                        .plans
                        .values()
                        .filter(|plan| {
                            state.selected.as_ref().is_some_and(|selected| {
                                plan.binding.session_id == selected.session_id
                                    && plan.binding.run_id == selected.run_id
                                    && plan.binding.requirement_revision
                                        < selected.requirement_revision
                            })
                        })
                        .max_by_key(|plan| plan.binding.requirement_revision);
                    let mut hint = "No checklist is bound to the current task and requirement revision. For multi-step work, inspect the current requirements and write its checklist. Historical or unbound checklists are not current instructions. Simple questions need no checklist.".to_owned();
                    if let Some(previous) = previous {
                        hint.push_str(&format!("\nPrevious revision of THIS task only, for reconciliation, NOT an active checklist or acceptance evidence. Preserve only still-valid progress after checking the new requirements:\n{}", previous.content));
                    }
                    hint
                }
            });
        }

        match extension_data::TodoState::from_extension_data(&metadata.extension_data) {
            Some(state) if !state.content.trim().is_empty() => {
                Some(format!("Current tasks and notes:\n{}\n", state.content))
            }
            _ => Some(
                "Current tasks and notes:\nOnce given a task, immediately update your todo with all explicit and implicit requirements\n"
                    .to_string(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TodoClient;

    #[tokio::test]
    async fn limited_main_agent_can_write_its_plan_without_granting_workspace_access() {
        use crate::agents::control_plane::{CodeProRuntime, RuntimeModePolicy};
        use crate::agents::extension::PlatformExtensionContext;
        use crate::agents::protocol::RunId;
        use crate::agents::tool_execution::ToolCallContext;
        use crate::config::permission::CodeProTaskScope;
        use crate::config::GooseMode;
        use crate::session::extension_data::{CodeProTodoState, ExtensionState, TodoBinding};
        use crate::session::{SessionManager, SessionType};
        use std::sync::Arc;

        let temp = tempfile::tempdir().unwrap();
        let manager = Arc::new(SessionManager::new(temp.path().join("sessions")));
        let session = manager
            .create_session(
                temp.path().to_path_buf(),
                "limited change".into(),
                SessionType::CodePro,
                GooseMode::Auto,
            )
            .await
            .unwrap();
        let runtime = CodeProRuntime::initialize_production(
            temp.path().join("runtime"),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let run_id = RunId::new("limited-plan").unwrap();
        let snapshot = runtime
            .create_or_verify_run(&session.id, run_id.clone(), "repair only store.js")
            .await
            .unwrap();
        let binding = TodoBinding {
            session_id: session.id.clone(),
            run_id: run_id.to_string(),
            requirement_revision: snapshot.projection.user_requirement_revision,
        };
        manager
            .update_codepro_todo(&session.id, Some(binding.clone()), None)
            .await
            .unwrap();
        let client = TodoClient::new(PlatformExtensionContext {
            extension_manager: None,
            session_manager: manager.clone(),
            session: None,
            use_login_shell_path: false,
        })
        .unwrap();
        let scope = CodeProTaskScope::new_bound(
            run_id.as_str(),
            "main-agent",
            temp.path(),
            vec!["**".into()],
            vec!["store.js".into()],
        )
        .unwrap()
        .with_permission_session_id(&session.id)
        .unwrap();
        assert!(!scope.is_durable_main_agent());
        let context = |scope| {
            ToolCallContext::new(
                session.id.clone(),
                Some(temp.path().into()),
                Some("limited-plan-write".into()),
            )
            .with_codepro_runtime_context(Some(runtime.clone()), None)
            .with_codepro_task_scope(scope)
        };
        let arguments = || {
            Some(
                serde_json::json!({"content": "- [-] 修复幂等逻辑"})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
        };
        client
            .handle_write_todo(&context(scope.clone()), arguments())
            .await
            .unwrap();
        let read_state = || async {
            let stored = manager.get_session(&session.id, false).await.unwrap();
            CodeProTodoState::from_extension_data(&stored.extension_data).unwrap()
        };
        let accepted = read_state().await;
        assert_eq!(accepted.current().unwrap().binding, binding);
        assert_eq!(accepted.current().unwrap().content, "- [-] 修复幂等逻辑");
        assert!(scope.write_scope_allows_path(std::path::Path::new("store.js")));
        assert!(!scope.write_scope_allows_path(std::path::Path::new("server.js")));

        for rejected in [
            scope.for_delegated_task("reviewer", &[]).unwrap(),
            scope
                .clone()
                .with_permission_session_id("different-session")
                .unwrap(),
            CodeProTaskScope::new_bound(
                run_id.as_str(),
                "main-agent",
                temp.path(),
                vec!["**".into()],
                vec!["store.js".into()],
            )
            .unwrap(),
        ] {
            assert!(client
                .handle_write_todo(&context(rejected), arguments())
                .await
                .is_err());
            assert_eq!(
                serde_json::to_value(read_state().await).unwrap(),
                serde_json::to_value(&accepted).unwrap()
            );
        }
        let mut newer = binding;
        newer.requirement_revision += 1;
        manager
            .update_codepro_todo(&session.id, Some(newer), None)
            .await
            .unwrap();
        let selected = read_state().await;
        assert!(client
            .handle_write_todo(&context(scope), arguments())
            .await
            .is_err());
        assert_eq!(
            serde_json::to_value(read_state().await).unwrap(),
            serde_json::to_value(selected).unwrap()
        );
    }

    #[test]
    fn old_checklists_are_isolated_without_hiding_live_failure_feedback() {
        use crate::conversation::message::{Message, MessageContent};
        use rmcp::model::{CallToolRequestParams, CallToolResult, Content};

        let request = |id: &str| {
            Message::assistant()
                .with_tool_request(id, Ok(CallToolRequestParams::new("todo__todo_write")))
        };
        let old = vec![
            Message::user().with_text("Old task"),
            request("old"),
            Message::user().with_tool_response(
                "old",
                Ok(CallToolResult::success(vec![Content::text("Updated")])),
            ),
        ];
        let historical_ids = super::checklist_request_ids(&old);
        let mut live = old;
        live.extend([
            Message::user().with_text("New task"),
            request("live"),
            Message::user().with_tool_response(
                "live",
                Ok(CallToolResult::error(vec![Content::text(
                    "Checklist binding changed; retry against the current task",
                )])),
            ),
        ]);
        let projected = super::without_historical_checklists(live.clone(), &historical_ids);
        assert!(projected.iter().flat_map(|message| &message.content).any(|content|
            matches!(content, MessageContent::ToolResponse(response) if response.id == "live" && response.tool_result.as_ref().is_ok_and(|result| result.is_error == Some(true)))
        ));
        assert!(!projected.iter().flat_map(|message| &message.content).any(
            |content| matches!(content, MessageContent::ToolRequest(request) if request.id == "old")
        ));
        assert!(live.iter().flat_map(|message| &message.content).any(
            |content| matches!(content, MessageContent::ToolRequest(request) if request.id == "old")
        ));
    }

    #[test]
    fn todo_write_is_classified_as_internal_idempotent_session_state() {
        let tool = TodoClient::get_tools().pop().expect("todo tool");
        let annotations = tool.annotations.expect("todo annotations");

        assert_eq!(annotations.read_only_hint, Some(true));
        assert_eq!(annotations.destructive_hint, Some(false));
        assert_eq!(annotations.idempotent_hint, Some(true));
        assert_eq!(annotations.open_world_hint, Some(false));
    }
}
