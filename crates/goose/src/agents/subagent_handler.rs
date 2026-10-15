use crate::agents::action_budget::ActionBudgetReport;
use crate::agents::tool_confirmation_router::ToolConfirmationRouter;
use crate::{
    agents::{subagent_task_config::TaskConfig, Agent, AgentConfig, AgentEvent, SessionConfig},
    conversation::{
        message::{Message, MessageContent, SystemNotificationType},
        Conversation,
    },
    prompt_template::render_template,
    recipe::Recipe,
};
use anyhow::{anyhow, Result};
use futures::StreamExt;
use rmcp::model::{
    ErrorCode, ErrorData, LoggingLevel, LoggingMessageNotificationParam, Notification,
    ServerNotification,
};
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info};

pub type OnMessageCallback = Arc<dyn Fn(&Message) + Send + Sync>;

#[derive(Serialize)]
pub struct SubagentPromptContext {
    pub max_turns: usize,
    pub subagent_id: String,
    pub task_instructions: String,
    pub tool_count: usize,
    pub available_tools: String,
}

type AgentMessagesFuture = Pin<
    Box<
        dyn Future<Output = Result<(Conversation, Option<String>, Option<ActionBudgetReport>)>>
            + Send,
    >,
>;

#[derive(Debug)]
pub struct SubagentRunResult {
    pub response: String,
    pub action_budget: Option<ActionBudgetReport>,
    pub terminal_outcome: SubagentTerminalOutcome,
}

pub(crate) const CODEPRO_PROVIDER_UNAVAILABLE_EVENT: &str = "codepro.provider_unavailable";
pub(crate) const CODEPRO_EXECUTION_LIMIT_EVENT: &str = "codepro.execution_limit_reached";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentTerminalOutcome {
    Completed,
    ActionBudgetExhausted,
    ProviderUnavailable,
}

impl SubagentTerminalOutcome {
    fn from_action_budget(action_budget: Option<&ActionBudgetReport>) -> Self {
        if action_budget.is_some_and(|report| report.exhausted) {
            Self::ActionBudgetExhausted
        } else {
            Self::Completed
        }
    }

    fn from_run(messages: &Conversation, action_budget: Option<&ActionBudgetReport>) -> Self {
        let has_event = |event| {
            messages.iter().any(|message| {
                message.content.iter().any(|content| {
                    content
                        .as_system_notification()
                        .and_then(|notification| notification.data.as_ref())
                        .and_then(|data| data.get("event"))
                        .and_then(serde_json::Value::as_str)
                        == Some(event)
                })
            })
        };
        if has_event(CODEPRO_PROVIDER_UNAVAILABLE_EVENT) {
            Self::ProviderUnavailable
        } else if has_event(CODEPRO_EXECUTION_LIMIT_EVENT) {
            Self::ActionBudgetExhausted
        } else {
            Self::from_action_budget(action_budget)
        }
    }
}

pub struct SubagentRunParams {
    pub config: AgentConfig,
    pub recipe: Recipe,
    pub task_config: TaskConfig,
    pub return_last_only: bool,
    pub session_id: String,
    pub cancellation_token: Option<CancellationToken>,
    pub on_message: Option<OnMessageCallback>,
    pub notification_tx: Option<tokio::sync::mpsc::UnboundedSender<ServerNotification>>,
    pub input_message: Option<Message>,
    pub(crate) tool_confirmation_router: Option<Arc<ToolConfirmationRouter>>,
}

fn subagent_user_message(user_task: String, input_message: Option<Message>) -> Message {
    input_message.unwrap_or_else(|| Message::user().with_text(user_task))
}

pub async fn run_subagent_task(params: SubagentRunParams) -> Result<String, anyhow::Error> {
    Ok(run_subagent_task_detailed(params).await?.response)
}

pub async fn run_subagent_task_detailed(
    params: SubagentRunParams,
) -> Result<SubagentRunResult, anyhow::Error> {
    let return_last_only = params.return_last_only;
    let (messages, final_output, action_budget) =
        get_agent_messages(params).await.map_err(|e| {
            ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("Failed to execute task: {}", e),
                None,
            )
        })?;

    let terminal_outcome = SubagentTerminalOutcome::from_run(&messages, action_budget.as_ref());
    if let Some(output) = final_output {
        return Ok(SubagentRunResult {
            response: output,
            action_budget,
            terminal_outcome,
        });
    }

    Ok(SubagentRunResult {
        response: extract_response_text(&messages, return_last_only),
        action_budget,
        terminal_outcome,
    })
}

fn extract_response_text(messages: &Conversation, return_last_only: bool) -> String {
    if return_last_only {
        messages
            .messages()
            .last()
            .and_then(|message| {
                message.content.iter().find_map(|content| match content {
                    crate::conversation::message::MessageContent::Text(text_content) => {
                        Some(text_content.text.clone())
                    }
                    _ => None,
                })
            })
            .unwrap_or_else(|| String::from("No text content in last message"))
    } else {
        let all_text_content: Vec<String> = messages
            .iter()
            .flat_map(|message| {
                message.content.iter().filter_map(|content| match content {
                    crate::conversation::message::MessageContent::Text(text_content) => {
                        Some(text_content.text.clone())
                    }
                    crate::conversation::message::MessageContent::ToolResponse(tool_response) => {
                        if let Ok(result) = &tool_response.tool_result {
                            let texts: Vec<String> = result
                                .content
                                .iter()
                                .filter_map(|content| {
                                    if let rmcp::model::RawContent::Text(raw_text_content) =
                                        &content.raw
                                    {
                                        Some(raw_text_content.text.clone())
                                    } else {
                                        None
                                    }
                                })
                                .collect();
                            if !texts.is_empty() {
                                Some(format!("Tool result: {}", texts.join("\n")))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    _ => None,
                })
            })
            .collect();

        all_text_content.join("\n")
    }
}

pub const SUBAGENT_TOOL_REQUEST_TYPE: &str = "subagent_tool_request";

fn is_worker_telemetry(content: &MessageContent) -> bool {
    matches!(
        content
            .as_system_notification()
            .and_then(|notification| notification.data.as_ref())
            .and_then(|data| data.get("event"))
            .and_then(serde_json::Value::as_str),
        Some("worker_usage" | "compaction_lifecycle")
    )
}

fn get_agent_messages(params: SubagentRunParams) -> AgentMessagesFuture {
    Box::pin(async move {
        let SubagentRunParams {
            config,
            recipe,
            task_config,
            session_id,
            cancellation_token,
            on_message,
            notification_tx,
            input_message,
            tool_confirmation_router,
            ..
        } = params;

        let worker_events = config.codepro_worker_events.clone();
        let worker_origin = serde_json::json!({
            "task_id": config.codepro_permission_scope.as_ref()
                .map(|scope| scope.task_id()).unwrap_or(&session_id),
            "role": config.codepro_agent_role.map(|role| serde_json::json!(role))
                .unwrap_or_else(|| serde_json::json!("orchestrator")),
            "name": recipe.title,
            "effective_model": task_config.model_config.model_name,
        });
        let emit_telemetry = |message: &Message| {
            if let Some(callback) = &worker_events {
                let mut forwarded = message.clone();
                forwarded.content.retain(is_worker_telemetry);
                for content in &mut forwarded.content {
                    if let MessageContent::SystemNotification(notification) = content {
                        if let Some(data) = notification
                            .data
                            .as_mut()
                            .and_then(serde_json::Value::as_object_mut)
                        {
                            data.insert("worker_session_id".into(), serde_json::json!(session_id));
                            data.insert("origin".into(), worker_origin.clone());
                        }
                    }
                }
                if !forwarded.content.is_empty() {
                    callback(&forwarded);
                }
            }
        };
        let system_instructions = recipe.instructions.clone().unwrap_or_default();
        let user_task = recipe
            .prompt
            .clone()
            .unwrap_or_else(|| "Begin.".to_string());

        let agent = Arc::new(match tool_confirmation_router {
            Some(router) => Agent::with_config_and_tool_confirmation_router(config, router),
            None => Agent::with_config(config),
        });

        agent
            .update_provider(
                task_config.provider.clone(),
                task_config.model_config.clone(),
                &session_id,
            )
            .await
            .map_err(|e| anyhow!("Failed to set provider on sub agent: {}", e))?;

        for extension in &task_config.extensions {
            if let Err(e) = agent.add_extension(extension.clone(), &session_id).await {
                debug!(
                    "Failed to add extension '{}' to subagent: {}",
                    extension.name(),
                    e
                );
            }
        }

        let has_response_schema = recipe.response.is_some();
        agent
            .apply_recipe_components(recipe.response.clone(), true)
            .await;

        let subagent_prompt =
            build_subagent_prompt(&agent, &task_config, &session_id, system_instructions).await?;
        agent.override_system_prompt(subagent_prompt).await;
        if let Some(action_budget) = task_config.action_budget {
            agent.set_action_budget_override(action_budget).await;
        }
        if let Some(sink) = task_config.action_budget_report_sink {
            agent.set_action_budget_report_sink(sink).await;
        }

        let user_message = subagent_user_message(user_task, input_message);
        let mut conversation = Conversation::new_unvalidated(vec![user_message.clone()]);

        if let Some(activities) = recipe.activities {
            for activity in activities {
                info!("Recipe activity: {}", activity);
            }
        }
        let session_config = SessionConfig {
            id: session_id.clone(),
            schedule_id: None,
            max_turns: task_config.max_turns.map(|v| v as u32),
            retry_config: recipe.retry,
        };

        let mut stream =
            crate::session_context::with_session_id(Some(session_id.to_string()), async {
                agent
                    .reply(user_message, session_config, cancellation_token)
                    .await
            })
            .await
            .map_err(|e| anyhow!("Failed to get reply from agent: {}", e))?;

        while let Some(message_result) = stream.next().await {
            match message_result {
                Ok(AgentEvent::Message(msg)) => {
                    emit_telemetry(&msg);
                    if let Some(ref callback) = on_message {
                        let mut forwarded = msg.clone();
                        if worker_events.is_some() {
                            forwarded
                                .content
                                .retain(|content| !is_worker_telemetry(content));
                        }
                        for content in &mut forwarded.content {
                            if let MessageContent::SystemNotification(notification) = content {
                                if let Some(data) = notification
                                    .data
                                    .as_mut()
                                    .and_then(serde_json::Value::as_object_mut)
                                {
                                    if data.get("event").and_then(serde_json::Value::as_str)
                                        == Some("compaction_lifecycle")
                                    {
                                        data.insert(
                                            "worker_session_id".to_string(),
                                            serde_json::json!(session_id),
                                        );
                                    }
                                }
                            }
                        }
                        callback(&forwarded);
                    }
                    if let Some(ref tx) = notification_tx {
                        for content in &msg.content {
                            if let Some(notif) = create_tool_notification(content, &session_id) {
                                if tx.send(notif).is_err() {
                                    debug!(
                                        "Notification receiver dropped for subagent {}",
                                        session_id
                                    );
                                }
                            }
                        }
                    }
                    conversation.push(msg);
                }
                Ok(AgentEvent::Usage(_)) => {}
                Ok(AgentEvent::MessageUsage { message_id, usage }) => {
                    let message = Message::assistant().with_system_notification_with_data(
                        SystemNotificationType::ProgressMessage,
                        "子任务模型请求用量",
                        serde_json::json!({
                            "schema_version": 1,
                            "event": "worker_usage",
                            "worker_session_id": session_id,
                            "request_message_id": message_id,
                            "context_limit": task_config.model_config.context_limit(),
                            "usage": usage,
                        }),
                    );
                    emit_telemetry(&message);
                    if worker_events.is_none() {
                        if let Some(ref callback) = on_message {
                            callback(&message);
                        }
                    }
                }
                Ok(AgentEvent::McpNotification(_)) => {}
                Ok(AgentEvent::HistoryReplaced(updated_conversation)) => {
                    conversation = updated_conversation;
                }
                Err(e) => {
                    tracing::error!("Error receiving message from subagent: {}", e);
                    return Err(e.context(
                        "subagent response stream failed; completed tool effects are preserved",
                    ));
                }
            }
        }

        let final_output = get_final_output(&agent, has_response_schema).await;
        let action_budget = agent.take_action_budget_report().await;

        Ok((conversation, final_output, action_budget))
    })
}

async fn build_subagent_prompt(
    agent: &Agent,
    task_config: &TaskConfig,
    session_id: &str,
    system_instructions: String,
) -> Result<String> {
    let tools: Vec<_> = agent
        .list_tools(session_id, None)
        .await
        .into_iter()
        .filter(super::reply_parts::is_tool_visible_to_model)
        .collect();
    render_template(
        "subagent_system.md",
        &SubagentPromptContext {
            max_turns: task_config
                .max_turns
                .expect("TaskConfig always sets max_turns"),
            subagent_id: session_id.to_string(),
            task_instructions: system_instructions,
            tool_count: tools.len(),
            available_tools: tools
                .iter()
                .map(|t| t.name.to_string())
                .collect::<Vec<_>>()
                .join(", "),
        },
    )
    .map_err(|e| anyhow!("Failed to render subagent system prompt: {}", e))
}

async fn get_final_output(agent: &Agent, has_response_schema: bool) -> Option<String> {
    if has_response_schema {
        agent
            .final_output_tool
            .lock()
            .await
            .as_ref()
            .and_then(|tool| tool.final_output.clone())
    } else {
        None
    }
}

pub fn create_tool_notification(
    content: &MessageContent,
    subagent_id: &str,
) -> Option<ServerNotification> {
    if let MessageContent::ToolRequest(req) = content {
        let tool_call = req.tool_call.as_ref().ok()?;

        Some(ServerNotification::LoggingMessageNotification(
            Notification::new(
                LoggingMessageNotificationParam::new(
                    LoggingLevel::Info,
                    serde_json::json!({
                        "type": SUBAGENT_TOOL_REQUEST_TYPE,
                        "subagent_id": subagent_id,
                        "tool_call": {
                            "name": tool_call.name,
                            "arguments": tool_call.arguments
                        }
                    }),
                )
                .with_logger(format!("subagent:{}", subagent_id)),
            ),
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_tool_notification, subagent_user_message, SubagentTerminalOutcome,
        CODEPRO_EXECUTION_LIMIT_EVENT, CODEPRO_PROVIDER_UNAVAILABLE_EVENT,
        SUBAGENT_TOOL_REQUEST_TYPE,
    };
    use crate::agents::action_budget::ActionBudgetReport;
    use crate::conversation::{
        message::{Message, MessageContent, SystemNotificationType},
        Conversation,
    };
    use rmcp::model::{CallToolRequestParams, ServerNotification};
    use serde_json::json;

    fn action_budget_report(exhausted: bool) -> ActionBudgetReport {
        ActionBudgetReport {
            current_limit_turns: 12,
            turns_taken: 12,
            extension_used: false,
            successful_action_seen: true,
            last_successful_effect_fingerprint: None,
            consecutive_unchanged_effects: 0,
            completion_checkpoint_requested: false,
            completion_checkpoint_used: false,
            finalization_started: true,
            exhausted,
        }
    }

    #[test]
    fn r4_core5_terminal_outcome_comes_from_typed_budget_state() {
        let completed = action_budget_report(false);
        let exhausted = action_budget_report(true);

        assert_eq!(
            SubagentTerminalOutcome::from_action_budget(Some(&completed)),
            SubagentTerminalOutcome::Completed
        );
        assert_eq!(
            SubagentTerminalOutcome::from_action_budget(Some(&exhausted)),
            SubagentTerminalOutcome::ActionBudgetExhausted
        );
        assert_eq!(
            SubagentTerminalOutcome::from_action_budget(None),
            SubagentTerminalOutcome::Completed
        );
    }

    #[test]
    fn execution_limit_notification_does_not_require_an_action_budget_tracker() {
        let message = Message::assistant()
            .with_system_notification_with_data(
                SystemNotificationType::ProgressMessage,
                "Execution capacity exhausted",
                json!({"event": CODEPRO_EXECUTION_LIMIT_EVENT, "max_turns": 1}),
            )
            .with_visibility(false, false);
        let conversation = Conversation::new_unvalidated(vec![message]);
        assert_eq!(
            SubagentTerminalOutcome::from_run(&conversation, None),
            SubagentTerminalOutcome::ActionBudgetExhausted
        );
        let prose = Conversation::new_unvalidated(vec![Message::assistant().with_text(
            "Execution capacity exhausted; I've reached the maximum number of actions.",
        )]);
        assert_eq!(
            SubagentTerminalOutcome::from_run(&prose, None),
            SubagentTerminalOutcome::Completed
        );
    }

    #[test]
    fn provider_unavailable_notification_overrides_completed_worker_outcome() {
        let message = Message::assistant()
            .with_text("模型服务暂时不可用")
            .with_system_notification_with_data(
                crate::conversation::message::SystemNotificationType::InlineMessage,
                "模型服务暂时不可用，请稍后重试。",
                json!({"event": CODEPRO_PROVIDER_UNAVAILABLE_EVENT}),
            );
        let conversation = crate::conversation::Conversation::new_unvalidated(vec![message]);

        assert_eq!(
            SubagentTerminalOutcome::from_run(&conversation, None),
            SubagentTerminalOutcome::ProviderUnavailable
        );
    }

    #[test]
    fn subagent_handler_reuses_the_shared_agent_executor() {
        let source = include_str!("subagent_handler.rs").replace("\r\n", "\n");
        let production = source
            .split_once("\n#[cfg(test)]\nmod tests {")
            .map(|(production, _)| production)
            .expect("subagent handler test module boundary");
        let execution = production
            .split_once("fn get_agent_messages(")
            .and_then(|(_, tail)| {
                tail.split_once("async fn build_subagent_prompt(")
                    .map(|(body, _)| body)
            })
            .expect("subagent execution boundary");

        assert!(execution.contains("Agent::with_config(config)"));
        assert!(execution.contains("agent\n                    .reply("));
        assert!(execution.contains("set_action_budget_override"));
        assert!(execution.contains("take_action_budget_report"));
        assert!(!execution.contains("dispatch_tool_call"));
        assert!(!execution.contains("provider.stream"));
    }

    #[test]
    fn legacy_subagent_entry_is_a_compatible_detailed_result_wrapper() {
        let source = include_str!("subagent_handler.rs").replace("\r\n", "\n");
        let production = source
            .split_once("\n#[cfg(test)]\nmod tests {")
            .map(|(production, _)| production)
            .expect("subagent handler test module boundary");
        let wrapper = production
            .split_once("pub async fn run_subagent_task(")
            .and_then(|(_, tail)| {
                tail.split_once("pub async fn run_subagent_task_detailed(")
                    .map(|(body, _)| body)
            })
            .expect("legacy subagent wrapper boundary");

        assert!(wrapper.contains("run_subagent_task_detailed(params)"));
        assert!(wrapper.contains(".response"));
    }

    #[test]
    fn create_tool_notification_for_tool_request() {
        let tool_call = CallToolRequestParams::new("developer__shell".to_string())
            .with_arguments(json!({"command": "ls"}).as_object().unwrap().clone());
        let content = MessageContent::tool_request("req1", Ok(tool_call));
        let notification =
            create_tool_notification(&content, "session_1").expect("expected notification");

        let ServerNotification::LoggingMessageNotification(log_notif) = notification else {
            panic!("expected logging notification");
        };
        let data = log_notif
            .params
            .data
            .as_object()
            .expect("expected object data");
        assert_eq!(
            data.get("type").and_then(|v| v.as_str()),
            Some(SUBAGENT_TOOL_REQUEST_TYPE)
        );
        assert_eq!(
            data.get("subagent_id").and_then(|v| v.as_str()),
            Some("session_1")
        );
        let tool_call = data
            .get("tool_call")
            .and_then(|v| v.as_object())
            .expect("expected tool_call object");
        assert_eq!(
            tool_call.get("name").and_then(|v| v.as_str()),
            Some("developer__shell")
        );
    }

    #[test]
    fn create_tool_notification_ignores_non_tool_request() {
        let content = MessageContent::text("hello");
        assert!(create_tool_notification(&content, "session_1").is_none());
    }

    #[test]
    fn supplied_subagent_message_preserves_image_content() {
        let supplied = Message::user()
            .with_text("分析这张截图")
            .with_image("aGVsbG8=", "image/png");

        let message = subagent_user_message("fallback prompt".to_string(), Some(supplied));

        assert!(message
            .content
            .iter()
            .any(|content| matches!(content, MessageContent::Image(_))));
        assert_eq!(message.as_concat_text(), "分析这张截图");
    }
}
