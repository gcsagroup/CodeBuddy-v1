use crate::conversation::message::{ActionRequiredData, MessageMetadata, MessageUsage};
use crate::conversation::message::{Message, MessageContent};
use crate::conversation::{merge_consecutive_messages, Conversation};
use crate::prompt_template::render_template;
use crate::providers::base::Provider;
#[cfg(test)]
use crate::providers::base::{stream_from_single_message, MessageStream};
use crate::{config::Config, token_counter::create_token_counter};
use anyhow::Result;
use goose_providers::conversation::token_usage::ProviderUsage;
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use indoc::indoc;
use rmcp::model::{Role, Tool};
use serde::Serialize;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::info;
use tracing_futures::Instrument;

pub const DEFAULT_COMPACTION_THRESHOLD: f64 = 0.8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestContextBudget {
    pub context_limit: usize,
    pub projected_input_tokens: usize,
    pub output_reserve_tokens: usize,
}

impl RequestContextBudget {
    pub fn projected_total_tokens(&self) -> usize {
        self.projected_input_tokens
            .saturating_add(self.output_reserve_tokens)
    }

    pub fn exceeds_threshold(&self, threshold: f64) -> bool {
        compaction_threshold_reached(self.projected_total_tokens(), self.context_limit, threshold)
    }
}

pub fn compaction_threshold_reached(used: usize, limit: usize, threshold: f64) -> bool {
    limit > 0
        && used > 0
        && threshold > 0.0
        && threshold <= 1.0
        && used as f64 / limit as f64 >= threshold
}

pub async fn visible_context_tokens(conversation: &Conversation) -> Result<usize> {
    let counter = create_token_counter().await.map_err(anyhow::Error::msg)?;
    Ok(counter.count_chat_tokens("", &conversation.agent_visible_messages(), &[]))
}

const TOOLCALL_SUMMARIZATION_BATCH_SIZE: usize = 10;
const RECENT_USER_REQUEST_LIMIT: usize = 5;
const RECENT_USER_REQUEST_CHAR_LIMIT: usize = 12_000;

fn tool_pair_summarization_enabled() -> bool {
    Config::global()
        .get_param::<bool>("GOOSE_TOOL_PAIR_SUMMARIZATION")
        .unwrap_or(true)
}

const CONVERSATION_CONTINUATION_TEXT: &str =
    "Your context was compacted. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Just continue the conversation naturally based on the summarized context.";

const TOOL_LOOP_CONTINUATION_TEXT: &str =
    "Your context was compacted. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Continue calling tools as necessary to complete the task.";

const MANUAL_COMPACT_CONTINUATION_TEXT: &str =
    "Your context was compacted at the user's request. The previous message contains a summary of the conversation so far.
Do not mention that you read a summary or that conversation summarization occurred.
Just continue the conversation naturally based on the summarized context.";

#[derive(Serialize)]
struct SummarizeContext {
    messages: String,
}

/// Compact messages by summarizing them
///
/// This function performs the actual compaction by summarizing messages and updating
/// their visibility metadata. It does not check thresholds - use `check_if_compaction_needed`
/// first to determine if compaction is necessary.
///
/// # Arguments
/// * `provider` - The provider to use for summarization
/// * `session_id` - The session to use for summarization
/// * `conversation` - The current conversation history
/// * `manual_compact` - If true, this is a manual compaction (don't preserve recent user messages)
///
/// # Returns
/// * A tuple containing:
///   - `Conversation`: The compacted messages
///   - `ProviderUsage`: Provider usage from summarization
pub async fn compact_messages(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    conversation: &Conversation,
    manual_compact: bool,
) -> Result<(Conversation, ProviderUsage)> {
    info!("Performing message compaction");

    let messages = conversation.messages();

    let has_text_only = |msg: &Message| {
        let has_text = msg
            .content
            .iter()
            .any(|c| matches!(c, MessageContent::Text(_)));
        let has_tool_content = msg.content.iter().any(|c| {
            matches!(
                c,
                MessageContent::ToolRequest(_) | MessageContent::ToolResponse(_)
            )
        });
        has_text && !has_tool_content
    };

    // Preserve a bounded set of recent user messages independently of the model-generated summary.
    let (preserved_user_messages, is_most_recent) = if !manual_compact {
        let mut preserved = Vec::new();
        let mut preserved_chars: usize = 0;
        let mut latest_index = None;
        for (idx, msg) in messages.iter().enumerate().rev() {
            if !msg.is_agent_visible() || !matches!(msg.role, rmcp::model::Role::User) {
                continue;
            }
            // Summaries use the user role for provider compatibility, not because
            // they are user requests. Only exclude explicitly recorded compactions.
            if msg
                .metadata
                .usage
                .as_ref()
                .is_some_and(|usage| usage.is_compaction)
            {
                continue;
            }

            let projected = msg.agent_visible_content();
            if !has_text_only(&projected) {
                continue;
            }

            let projected_chars = projected.as_concat_text().chars().count();
            if !preserved.is_empty()
                && (preserved.len() >= RECENT_USER_REQUEST_LIMIT
                    || preserved_chars.saturating_add(projected_chars)
                        > RECENT_USER_REQUEST_CHAR_LIMIT)
            {
                break;
            }
            latest_index.get_or_insert(idx);
            preserved_chars = preserved_chars.saturating_add(projected_chars);
            let preserved_message = projected
                .content
                .into_iter()
                .filter(|content| matches!(content, MessageContent::Text(_)))
                .fold(
                    Message::user().with_metadata(
                        msg.metadata
                            .clone()
                            .with_user_invisible()
                            .with_agent_visible(),
                    ),
                    Message::with_content,
                );
            preserved.push(preserved_message);
        }
        preserved.reverse();
        (preserved, latest_index == Some(messages.len() - 1))
    } else {
        (Vec::new(), false)
    };

    let messages_to_compact = messages.as_slice();

    let (summary_message, summarization_usage) =
        do_compact(provider, model_config, session_id, messages_to_compact).await?;

    // Create the final message list with updated visibility metadata:
    // 1. Original messages become user_visible but not agent_visible
    // 2. Summary message becomes agent_visible but not user_visible
    // 3. Assistant messages to continue the conversation are also agent_visible but not user_visible
    let mut final_messages = Vec::new();

    for msg in messages_to_compact {
        let updated_metadata = msg.metadata.clone().with_agent_invisible();
        let updated_msg = msg.clone().with_metadata(updated_metadata);
        final_messages.push(updated_msg);
    }

    let mut summary_metadata = MessageMetadata::agent_only();
    summary_metadata.usage = Some(Box::new(MessageUsage::from_provider_usage(
        &summarization_usage,
        true,
    )));
    let summary_msg = summary_message.with_metadata(summary_metadata);

    let mut continuation_messages = vec![summary_msg];

    let continuation_text = if manual_compact {
        MANUAL_COMPACT_CONTINUATION_TEXT
    } else if is_most_recent {
        CONVERSATION_CONTINUATION_TEXT
    } else {
        TOOL_LOOP_CONTINUATION_TEXT
    };

    let continuation_msg = Message::assistant()
        .with_text(continuation_text)
        .with_metadata(MessageMetadata::agent_only());
    continuation_messages.push(continuation_msg);

    let (merged_continuation, _issues) = merge_consecutive_messages(continuation_messages);
    final_messages.extend(merged_continuation);

    // Stored projections retain their own host associations. Provider request
    // normalization can merge roles, but must not relabel another run's input.
    for group in preserved_user_messages.chunk_by(|left, right| left.metadata == right.metadata) {
        final_messages.extend(merge_consecutive_messages(group.to_vec()).0);
    }

    Ok((
        Conversation::new_unvalidated(final_messages),
        summarization_usage,
    ))
}

/// Check if messages exceed the auto-compaction threshold
pub async fn check_if_compaction_needed(
    provider: &dyn Provider,
    conversation: &Conversation,
    threshold_override: Option<f64>,
    session: &crate::session::Session,
) -> Result<bool> {
    if provider.manages_own_context() {
        return Ok(false);
    }

    let messages = conversation.messages();
    let config = Config::global();
    let threshold = threshold_override.unwrap_or_else(|| {
        config
            .get_param::<f64>("GOOSE_AUTO_COMPACT_THRESHOLD")
            .unwrap_or(DEFAULT_COMPACTION_THRESHOLD)
    });

    let model_config = session
        .model_config
        .clone()
        .unwrap_or_else(|| ModelConfig::new("unknown"));
    let context_limit = provider
        .get_context_limit(&model_config)
        .await
        .unwrap_or_else(|_| model_config.context_limit());

    let (current_tokens, _token_source) = match session.usage.total_tokens {
        Some(tokens) => (tokens as usize, "session metadata"),
        None => {
            let token_counter = create_token_counter()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to create token counter: {}", e))?;

            let token_counts: Vec<_> = messages
                .iter()
                .filter(|m| m.is_agent_visible())
                .map(|msg| token_counter.count_chat_tokens("", std::slice::from_ref(msg), &[]))
                .collect();

            (token_counts.iter().sum(), "estimated")
        }
    };

    Ok(compaction_threshold_reached(
        current_tokens,
        context_limit,
        threshold,
    ))
}

/// Estimate the complete next provider request rather than relying only on usage recorded
/// after the previous response. The estimate includes the system prompt, messages, offered
/// tools, and the configured output reservation.
pub async fn request_context_budget(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    system_prompt: &str,
    messages: &[Message],
    tools: &[Tool],
) -> Result<Option<RequestContextBudget>> {
    if provider.manages_own_context() {
        return Ok(None);
    }

    let context_limit = provider
        .get_context_limit(model_config)
        .await
        .unwrap_or_else(|_| model_config.context_limit());
    let token_counter = create_token_counter()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to create token counter: {}", e))?;

    Ok(Some(RequestContextBudget {
        context_limit,
        projected_input_tokens: token_counter.count_chat_tokens(system_prompt, messages, tools),
        output_reserve_tokens: model_config.max_tokens.unwrap_or(4_096) as usize,
    }))
}

fn filter_tool_responses(messages: &[Message], remove_percent: u32) -> Vec<&Message> {
    fn has_tool_response(msg: &Message) -> bool {
        msg.content
            .iter()
            .any(|c| matches!(c, MessageContent::ToolResponse(_)))
    }

    if remove_percent == 0 {
        return messages.iter().collect();
    }

    let tool_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, msg)| has_tool_response(msg))
        .map(|(i, _)| i)
        .collect();

    if tool_indices.is_empty() {
        return messages.iter().collect();
    }

    let num_to_remove = ((tool_indices.len() * remove_percent as usize) / 100)
        .max(1)
        .min(tool_indices.len());

    let middle = (tool_indices.len() - 1) / 2;
    let mut indices_to_remove = Vec::with_capacity(num_to_remove);

    // Middle out
    for i in 0..num_to_remove {
        let index = if i % 2 == 0 {
            middle - i / 2
        } else {
            middle + i / 2 + 1
        };
        indices_to_remove.push(tool_indices[index]);
    }

    messages
        .iter()
        .enumerate()
        .filter(|(i, _)| !indices_to_remove.contains(i))
        .map(|(_, msg)| msg)
        .collect()
}

async fn do_compact(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    messages: &[Message],
) -> Result<(Message, ProviderUsage), anyhow::Error> {
    let agent_visible_messages =
        Conversation::new_unvalidated(messages.iter().cloned()).agent_visible_messages();

    // Try progressively removing more tool response messages from the middle to reduce context length
    let removal_percentages = [0, 10, 20, 50, 100];

    for (attempt, &remove_percent) in removal_percentages.iter().enumerate() {
        let filtered_messages = filter_tool_responses(&agent_visible_messages, remove_percent);

        let messages_text = filtered_messages
            .iter()
            .map(|&msg| format_message_for_compacting(msg))
            .collect::<Vec<_>>()
            .join("\n");

        let context = SummarizeContext {
            messages: messages_text,
        };

        let system_prompt = render_template("compaction.md", &context)?;

        let user_message = Message::user()
            .with_text("Please summarize the conversation history provided in the system prompt.");
        let summarization_request = vec![user_message];

        match crate::model_config::complete_fast(
            provider,
            model_config,
            session_id,
            &system_prompt,
            &summarization_request,
            &[],
        )
        .await
        {
            Ok((mut response, mut provider_usage)) => {
                response.role = Role::User;

                crate::providers::usage_estimator::ensure_usage_tokens(
                    &mut provider_usage,
                    &system_prompt,
                    &summarization_request,
                    &response,
                    &[],
                )
                .await
                .map_err(|e| anyhow::anyhow!("Failed to ensure usage tokens: {}", e))?;

                // The summarizer's reasoning belongs to its own inference, not
                // to the user-role summary consumed by the next model request.
                response
                    .content
                    .retain(|content| matches!(content, MessageContent::Text(_)));
                anyhow::ensure!(
                    !response.as_concat_text().trim().is_empty(),
                    "Compaction produced no summary text; the original conversation is unchanged"
                );
                return Ok((response, provider_usage));
            }
            Err(e) => {
                if matches!(e, ProviderError::ContextLengthExceeded(_)) {
                    if attempt < removal_percentages.len() - 1 {
                        continue;
                    } else {
                        return Err(anyhow::anyhow!(
                            "Failed to compact: context limit exceeded even after removing all tool responses"
                        ));
                    }
                }
                return Err(e.into());
            }
        }
    }

    Err(anyhow::anyhow!(
        "Unexpected: exhausted all attempts without returning"
    ))
}

pub fn format_message_for_compacting(msg: &Message) -> String {
    let content_parts: Vec<String> = msg
        .content
        .iter()
        .filter_map(|content| match content {
            MessageContent::Text(text) => Some(text.text.clone()),
            MessageContent::Image(img) => Some(format!("[image: {}]", img.mime_type)),
            MessageContent::ToolRequest(req) => {
                if let Ok(call) = &req.tool_call {
                    Some(format!(
                        "tool_request({}): {}",
                        call.name,
                        serde_json::to_string(&call.arguments)
                            .unwrap_or_else(|_| "<<invalid json>>".to_string())
                    ))
                } else {
                    Some("tool_request: [error]".to_string())
                }
            }
            MessageContent::ToolResponse(res) => {
                if let Ok(result) = &res.tool_result {
                    let text_items: Vec<String> = result
                        .content
                        .iter()
                        .filter_map(|content| {
                            content.as_text().map(|text_str| text_str.text.clone())
                        })
                        .collect();

                    if !text_items.is_empty() {
                        Some(format!("tool_response: {}", text_items.join("\n")))
                    } else {
                        Some("tool_response: [non-text content]".to_string())
                    }
                } else {
                    Some("tool_response: [error]".to_string())
                }
            }
            MessageContent::ToolConfirmationRequest(req) => {
                Some(format!("tool_confirmation_request: {}", req.tool_name))
            }
            MessageContent::ActionRequired(action) => match &action.data {
                ActionRequiredData::ToolConfirmation { tool_name, .. } => {
                    Some(format!("action_required(tool_confirmation): {}", tool_name))
                }
                ActionRequiredData::Elicitation { message, .. } => {
                    Some(format!("action_required(elicitation): {}", message))
                }
                ActionRequiredData::ElicitationResponse { id, .. } => {
                    Some(format!("action_required(elicitation_response): {}", id))
                }
            },
            MessageContent::FrontendToolRequest(req) => {
                if let Ok(call) = &req.tool_call {
                    Some(format!("frontend_tool_request: {}", call.name))
                } else {
                    Some("frontend_tool_request: [error]".to_string())
                }
            }
            MessageContent::Thinking(_) => None,
            MessageContent::RedactedThinking(_) => None,
            MessageContent::SystemNotification(notification) => {
                Some(format!("system_notification: {}", notification.msg))
            }
        })
        .collect();

    let role_str = match msg.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };

    if content_parts.is_empty() {
        format!("[{}]: <empty message>", role_str)
    } else {
        format!("[{}]: {}", role_str, content_parts.join("\n"))
    }
}

pub fn compute_tool_call_cutoff(context_limit: usize, compaction_threshold: f64) -> usize {
    let threshold = if compaction_threshold > 0.0 && compaction_threshold <= 1.0 {
        compaction_threshold
    } else {
        DEFAULT_COMPACTION_THRESHOLD
    };
    let effective_limit = (context_limit as f64 * threshold) as usize;
    (3 * effective_limit / 20_000).clamp(10, 500)
}

pub fn tool_ids_to_summarize(
    conversation: &Conversation,
    cutoff: usize,
    protect_last_n: usize,
) -> Vec<String> {
    let messages = conversation.messages();

    let mut tool_call_ids: Vec<String> = Vec::new();

    for msg in messages.iter() {
        if !msg.is_agent_visible() {
            continue;
        }

        for content in &msg.content {
            if let MessageContent::ToolRequest(req) = content {
                tool_call_ids.push(req.id.clone());
            }
        }
    }

    // Never summarize the last N tool calls (current turn)
    let eligible = tool_call_ids.len().saturating_sub(protect_last_n);
    if eligible <= cutoff + TOOLCALL_SUMMARIZATION_BATCH_SIZE {
        return Vec::new();
    }

    tool_call_ids
        .into_iter()
        .take(TOOLCALL_SUMMARIZATION_BATCH_SIZE)
        .collect()
}

fn agent_visible_tool_pair(conversation: &Conversation, tool_id: &str) -> Result<Vec<Message>> {
    let matching_messages = conversation
        .messages()
        .iter()
        .filter(|m| {
            m.content.iter().any(|c| match c {
                MessageContent::ToolRequest(req) => req.id == tool_id,
                MessageContent::ToolResponse(resp) => resp.id == tool_id,
                _ => false,
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let matching_messages =
        Conversation::new_unvalidated(matching_messages).agent_visible_messages();

    let has_request = matching_messages.iter().any(|message| {
        message.content.iter().any(
            |content| matches!(content, MessageContent::ToolRequest(request) if request.id == tool_id),
        )
    });
    let has_response = matching_messages.iter().any(|message| {
        message.content.iter().any(
            |content| matches!(content, MessageContent::ToolResponse(response) if response.id == tool_id),
        )
    });
    if !has_request || !has_response {
        return Err(anyhow::anyhow!(
            "No agent-visible tool pair found for tool id: {}",
            tool_id
        ));
    }
    Ok(matching_messages)
}

pub async fn summarize_tool_call(
    provider: &dyn Provider,
    model_config: &ModelConfig,
    session_id: &str,
    conversation: &Conversation,
    tool_id: &str,
) -> Result<Message> {
    let matching_messages = agent_visible_tool_pair(conversation, tool_id)?;

    let formatted = matching_messages
        .iter()
        .map(format_message_for_compacting)
        .collect::<Vec<_>>()
        .join("\n");

    let user_message = Message::user().with_text(formatted);
    let summarization_request = vec![user_message];

    let system_prompt = indoc! {r#"
                Your task is to summarize a tool call & response pair to save tokens.

                Reply with a single message that describes what happened. Typically a tool call
                asks for something using a bunch of parameters and then the result is also some
                structured output. So the tool might ask to look up something on github and the
                reply might be a json document. So you could reply with something like:

                "A call to github was made to get the project status"

                if that is what it was.
            "#};

    let (mut response, _) = crate::model_config::complete_fast(
        provider,
        model_config,
        session_id,
        system_prompt,
        &summarization_request,
        &[],
    )
    .await?;

    response.role = Role::User;
    response.created = matching_messages.last().unwrap().created;
    response.metadata = MessageMetadata::agent_only();

    Ok(response.with_generated_id())
}

pub fn maybe_summarize_tool_pairs(
    provider: Arc<dyn Provider>,
    model_config: ModelConfig,
    session_id: String,
    conversation: Conversation,
    cutoff: usize,
    protect_last_n: usize,
    http_attempt_gate: Option<Arc<dyn goose_providers::retry::HttpAttemptGate>>,
) -> Option<JoinHandle<Vec<(Message, String)>>> {
    if !tool_pair_summarization_enabled() || provider.manages_own_context() {
        return None;
    }

    let tool_ids = tool_ids_to_summarize(&conversation, cutoff, protect_last_n);
    if tool_ids.is_empty() {
        return None;
    }

    let summarize = async move {
        let batch_started = std::time::Instant::now();
        let selected_count = tool_ids.len();
        info!(session_id = %session_id, selected_count, "Tool history summary batch started");
        let mut results = Vec::new();
        for tool_id in tool_ids {
            let started = std::time::Instant::now();
            let span = tracing::info_span!("tool_history_summary", session_id = %session_id, tool_call_id = %tool_id);
            info!(parent: &span, "Tool history summary request started");
            match summarize_tool_call(
                provider.as_ref(),
                &model_config,
                &session_id,
                &conversation,
                &tool_id,
            )
            .instrument(span.clone())
            .await
            {
                Ok(summary) => {
                    info!(parent: &span, elapsed_ms = started.elapsed().as_millis() as u64,
                        "Tool history summary request finished");
                    results.push((summary, tool_id));
                }
                Err(e) => {
                    tracing::warn!(parent: &span,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        error_kind = e.downcast_ref::<ProviderError>().map(ProviderError::telemetry_type).unwrap_or("summary_error"),
                        "Tool history summary request failed");
                }
            }
        }
        info!(session_id = %session_id, selected_count, completed_count = results.len(),
            elapsed_ms = batch_started.elapsed().as_millis() as u64,
            "Tool history summary batch finished");
        results
    };
    Some(tokio::spawn(async move {
        match http_attempt_gate {
            Some(gate) => goose_providers::retry::with_http_attempt_gate(gate, summarize).await,
            None => summarize.await,
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use goose_providers::conversation::token_usage::Usage;
    use rmcp::model::{AnnotateAble, CallToolRequestParams, RawContent, Tool};

    fn create_tool_pair(
        call_id: &str,
        response_id: &str,
        tool_name: &str,
        response_text: &str,
    ) -> Vec<Message> {
        vec![
            Message::assistant()
                .with_tool_request(
                    call_id,
                    Ok(CallToolRequestParams::new(tool_name.to_string())),
                )
                .with_id(call_id),
            Message::user()
                .with_tool_response(
                    call_id,
                    Ok(rmcp::model::CallToolResult::success(vec![
                        RawContent::text(response_text).no_annotation(),
                    ])),
                )
                .with_id(response_id),
        ]
    }

    #[test]
    fn compaction_threshold_includes_exact_limit_and_one_hundred_percent() {
        for (used, limit, threshold, expected) in [
            (97_000, 128_000, 0.8, false),
            (102_400, 128_000, 0.8, true),
            (128_000, 128_000, 1.0, true),
            (127_999, 128_000, 1.0, false),
            (100, 0, 0.8, false),
            (100, 100, 0.0, false),
            (100, 100, f64::NAN, false),
        ] {
            assert_eq!(
                compaction_threshold_reached(used, limit, threshold),
                expected
            );
        }
    }

    #[tokio::test]
    async fn compaction_usage_counts_retained_constraints_and_excludes_hidden_history() {
        let constraint = "Do not send twice. Preserve the unsent draft. ".repeat(80);
        let history = Conversation::new_unvalidated([
            Message::user().with_text(constraint.clone()),
            Message::assistant().with_text("old tool output ".repeat(2000)),
        ]);
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 100_000);
        let (compacted, _) = compact_messages(
            &provider,
            &provider.config,
            "compact-usage",
            &history,
            false,
        )
        .await
        .unwrap();
        let used = visible_context_tokens(&compacted).await.unwrap();
        assert!(used > 100, "retained user restrictions must be counted");
        assert!(used < visible_context_tokens(&history).await.unwrap());
        assert!(compacted
            .agent_visible_messages()
            .iter()
            .any(|message| message.as_concat_text().contains(&constraint)));
        assert_eq!(
            compacted.messages()[1].as_concat_text(),
            history.messages()[1].as_concat_text()
        );
        assert!(!compacted.messages()[1].is_agent_visible());
    }

    #[test]
    fn filter_tool_responses_removes_all_single_and_odd_results() {
        for count in [1, 2, 3, 4, 5] {
            let mut messages = vec![Message::user().with_text("original goal").with_id("goal")];
            for index in 0..count {
                messages.extend(create_tool_pair(
                    &format!("call-{index}"),
                    &format!("response-{index}"),
                    "read_file",
                    "large tool output",
                ));
            }
            messages.push(
                Message::user()
                    .with_text("latest constraint")
                    .with_id("latest"),
            );
            let before = serde_json::to_value(&messages).unwrap();

            let filtered = filter_tool_responses(&messages, 100);
            let expected: Vec<_> = messages
                .iter()
                .filter(|message| !message.id.as_deref().unwrap().starts_with("response-"))
                .collect();

            assert_eq!(filtered, expected, "tool result count: {count}");
            assert_eq!(serde_json::to_value(&messages).unwrap(), before);
        }
    }

    #[test]
    fn filter_tool_responses_partial_removal_preserves_users_and_order() {
        let mut messages = Vec::new();
        for index in 0..5 {
            messages.push(
                Message::user()
                    .with_text(format!("constraint {index}"))
                    .with_id(format!("user-{index}")),
            );
            messages.extend(create_tool_pair(
                &format!("call-{index}"),
                &format!("response-{index}"),
                "read_file",
                "tool output",
            ));
        }

        let filtered = filter_tool_responses(&messages, 40);
        let remaining_ids: Vec<_> = filtered
            .iter()
            .map(|message| message.id.as_deref().unwrap())
            .collect();
        assert_eq!(
            remaining_ids,
            [
                "user-0",
                "call-0",
                "response-0",
                "user-1",
                "call-1",
                "response-1",
                "user-2",
                "call-2",
                "user-3",
                "call-3",
                "user-4",
                "call-4",
                "response-4",
            ]
        );
    }

    #[test]
    fn filter_tool_responses_handles_zero_percent_and_single_partial_result() {
        let mut messages = vec![Message::user().with_text("keep this goal").with_id("goal")];
        messages.extend(create_tool_pair("call", "response", "read_file", "output"));
        assert_eq!(
            filter_tool_responses(&messages, 0),
            messages.iter().collect::<Vec<_>>()
        );
        assert_eq!(
            filter_tool_responses(&messages, 1),
            vec![&messages[0], &messages[1]]
        );

        let users_only = vec![Message::user().with_text("no tool results")];
        assert_eq!(
            filter_tool_responses(&users_only, 100),
            vec![&users_only[0]]
        );
        assert!(filter_tool_responses(&[], 100).is_empty());
    }

    struct MockProvider {
        message: Message,
        config: ModelConfig,
        max_tool_responses: Option<usize>,
        compaction_attempts: std::sync::Mutex<Vec<(usize, bool)>>,
    }

    impl MockProvider {
        fn new(message: Message, context_limit: usize) -> Self {
            Self {
                message,
                config: ModelConfig {
                    model_name: "test".to_string(),
                    context_limit: Some(context_limit),
                    temperature: None,
                    max_tokens: None,
                    toolshim: false,
                    toolshim_model: None,
                    request_params: None,
                    reasoning: None,
                },
                max_tool_responses: None,
                compaction_attempts: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn with_max_tool_responses(mut self, max: usize) -> Self {
            self.max_tool_responses = Some(max);
            self
        }
    }

    #[async_trait]
    impl Provider for MockProvider {
        fn get_name(&self) -> &str {
            "mock"
        }

        async fn stream(
            &self,
            _model_config: &ModelConfig,
            system: &str,
            messages: &[Message],
            _tools: &[Tool],
        ) -> Result<MessageStream, ProviderError> {
            // If max_tool_responses is set, fail if we have too many
            if let Some(max) = self.max_tool_responses {
                let tool_response_count = system.matches("tool_response:").count()
                    + messages
                        .iter()
                        .filter(|m| {
                            m.content
                                .iter()
                                .any(|c| matches!(c, MessageContent::ToolResponse(_)))
                        })
                        .count();

                let context_exceeded = tool_response_count > max;
                self.compaction_attempts
                    .lock()
                    .unwrap()
                    .push((tool_response_count, context_exceeded));
                if context_exceeded {
                    return Err(ProviderError::ContextLengthExceeded(format!(
                        "Too many tool responses: {} > {}",
                        tool_response_count, max
                    )));
                }
            }

            let message = self.message.clone();
            let usage = ProviderUsage::new("mock-model".to_string(), Usage::default());
            Ok(stream_from_single_message(message, usage))
        }

        async fn get_context_limit(
            &self,
            _model_config: &ModelConfig,
        ) -> Result<usize, ProviderError> {
            Ok(self.config.context_limit())
        }
    }

    #[tokio::test]
    async fn test_keeps_tool_request() {
        let response_message = Message::assistant().with_text("<mock summary>");
        let provider = MockProvider::new(response_message, 1);
        let basic_conversation = vec![
            Message::user().with_text("read hello.txt"),
            Message::assistant()
                .with_tool_request("tool_0", Ok(CallToolRequestParams::new("read_file"))),
            Message::user().with_tool_response(
                "tool_0",
                Ok(rmcp::model::CallToolResult::success(vec![
                    RawContent::text("hello, world").no_annotation(),
                ])),
            ),
        ];

        let conversation = Conversation::new_unvalidated(basic_conversation);
        let model_config = provider.config.clone();
        let (compacted_conversation, _usage) = compact_messages(
            &provider,
            &model_config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap();

        let agent_conversation = compacted_conversation.agent_visible_messages();

        let _ = Conversation::new(agent_conversation)
            .expect("compaction should produce a valid conversation");
    }

    #[tokio::test]
    async fn preserved_user_message_keeps_audience_projection_after_compaction() {
        use rmcp::model::{RawTextContent, Role};

        let annotated_text = |text: &str, audience| {
            MessageContent::Text(
                RawTextContent {
                    text: text.to_string(),
                    meta: None,
                }
                .no_annotation()
                .with_audience(audience),
            )
        };
        let current_request = Message::user()
            .with_text("visible current request")
            .with_content(annotated_text("user-only secret", vec![Role::User]))
            .with_content(annotated_text(
                "assistant-only preprompt",
                vec![Role::Assistant],
            ));
        let conversation = Conversation::new_unvalidated([
            Message::user().with_text("earlier request"),
            Message::assistant().with_text("earlier response"),
            current_request,
        ]);
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 1000);

        let (compacted, _) = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap();

        let preserved_copies = compacted
            .messages()
            .iter()
            .filter(|message| message.as_concat_text().contains("visible current request"))
            .collect::<Vec<_>>();
        assert_eq!(preserved_copies.len(), 2);
        let archived = preserved_copies
            .iter()
            .find(|message| message.is_user_visible())
            .unwrap();
        assert!(!archived.is_agent_visible());
        assert!(archived.as_concat_text().contains("user-only secret"));
        let replay = preserved_copies
            .iter()
            .find(|message| message.is_agent_visible())
            .unwrap();
        assert!(!replay.is_user_visible());
        assert!(replay.as_concat_text().contains("assistant-only preprompt"));
        assert!(!replay.as_concat_text().contains("user-only secret"));

        let agent_text = compacted
            .agent_visible_messages()
            .iter()
            .map(Message::as_concat_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(agent_text.contains("visible current request"));
        assert!(agent_text.contains("assistant-only preprompt"));
        assert!(!agent_text.contains("user-only secret"));

        let user_text = compacted
            .user_visible_messages()
            .iter()
            .map(Message::as_concat_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(user_text.contains("user-only secret"));
        assert!(!user_text.contains("assistant-only preprompt"));
    }

    #[tokio::test]
    async fn compaction_preserves_several_recent_user_requests_when_summary_omits_them() {
        let provider = MockProvider::new(Message::assistant().with_text("generic summary"), 1000);
        let mut messages = Vec::new();
        for anchor in [
            "ANCHOR_ALPHA",
            "ANCHOR_BRAVO",
            "ANCHOR_CHARLIE",
            "ANCHOR_DELTA",
            "ANCHOR_ECHO",
            "ANCHOR_FOXTROT",
            "ANCHOR_GOLF",
        ] {
            messages.push(Message::user().with_text(format!("Remember {anchor} exactly")));
            messages.push(Message::assistant().with_text("acknowledged"));
        }
        let conversation = Conversation::new_unvalidated(messages);

        let (compacted, _) = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            false,
        )
        .await
        .unwrap();
        let agent_text = compacted
            .agent_visible_messages()
            .iter()
            .map(Message::as_concat_text)
            .collect::<Vec<_>>()
            .join("\n");

        for preserved in [
            "ANCHOR_CHARLIE",
            "ANCHOR_DELTA",
            "ANCHOR_ECHO",
            "ANCHOR_FOXTROT",
            "ANCHOR_GOLF",
        ] {
            assert!(agent_text.contains(preserved), "missing {preserved}");
        }
        assert!(!agent_text.contains("ANCHOR_ALPHA"));
        assert!(!agent_text.contains("ANCHOR_BRAVO"));

        let mut continued_messages = compacted.messages().to_vec();
        continued_messages.push(Message::assistant().with_text("continued response"));
        continued_messages.push(Message::user().with_text("Remember ANCHOR_HOTEL exactly"));
        let continued = Conversation::new_unvalidated(continued_messages);
        let (compacted_again, _) = compact_messages(
            &provider,
            &provider.config,
            "test-session-id",
            &continued,
            false,
        )
        .await
        .unwrap();
        let compacted_again_text = compacted_again
            .agent_visible_messages()
            .iter()
            .map(Message::as_concat_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(compacted_again_text.contains("ANCHOR_CHARLIE"));
        assert!(compacted_again_text.contains("ANCHOR_GOLF"));
        assert!(compacted_again_text.contains("ANCHOR_HOTEL"));
    }

    #[tokio::test]
    async fn repeated_compaction_does_not_retain_superseded_summaries_as_user_requests() {
        let mut metadata = MessageMetadata::default();
        metadata.task_run_id = Some("original-run".into());
        let real_request = "ContinuationSummary: this is my actual request, not a host summary";
        let mut conversation = Conversation::new_unvalidated([
            Message::user()
                .with_text(real_request)
                .with_metadata(metadata),
            Message::assistant()
                .with_thinking("original reasoning", "signature")
                .with_text("working"),
        ]);
        for summary in ["not fixed yet", "fixed and checked", "ready for handoff"] {
            let mut response = Message::assistant().with_text(summary);
            for _ in 0..1000 {
                response = response.with_thinking("summary generation only", "");
            }
            let provider = MockProvider::new(response, 1000);
            let (compacted, _) = compact_messages(
                &provider,
                &provider.config,
                "repeated-compaction",
                &conversation,
                false,
            )
            .await
            .unwrap();
            // Reload the persisted message representation, not just an in-memory flag.
            conversation =
                Conversation::new_unvalidated(compacted.messages().iter().map(|message| {
                    serde_json::from_value::<Message>(serde_json::to_value(message).unwrap())
                        .unwrap()
                }));
            let visible = conversation.agent_visible_messages();
            let summaries = visible
                .iter()
                .filter(|message| {
                    message
                        .metadata
                        .usage
                        .as_ref()
                        .is_some_and(|usage| usage.is_compaction)
                })
                .collect::<Vec<_>>();
            assert_eq!(summaries.len(), 1);
            assert_eq!(summaries[0].as_concat_text(), summary);
            assert!(visible
                .iter()
                .flat_map(|message| &message.content)
                .all(|content| matches!(content, MessageContent::Text(_))));
            let retained = visible
                .iter()
                .find(|message| message.as_concat_text() == real_request)
                .unwrap();
            assert_eq!(
                retained.metadata.task_run_id.as_deref(),
                Some("original-run")
            );
            for old_summary in ["not fixed yet", "fixed and checked", "ready for handoff"] {
                if old_summary != summary {
                    assert!(!visible
                        .iter()
                        .any(|message| message.as_concat_text() == old_summary));
                }
            }
            assert!(conversation.user_visible_messages().iter().any(|message| {
                message
                    .content
                    .iter()
                    .any(|content| content.as_thinking().is_some())
            }));
        }
    }

    #[tokio::test]
    async fn compaction_does_not_guess_legacy_sources_or_accept_reasoning_only_summary() {
        let legacy = Message::user()
            .with_text("Current Objective: legacy source is unknown")
            .with_metadata(MessageMetadata::agent_only());
        let conversation = Conversation::new_unvalidated([
            legacy.clone(),
            Message::assistant().with_text("continue"),
        ]);
        let provider = MockProvider::new(Message::assistant().with_text("new summary"), 1000);
        let (compacted, _) = compact_messages(
            &provider,
            &provider.config,
            "legacy-compaction",
            &conversation,
            false,
        )
        .await
        .unwrap();
        assert!(compacted.agent_visible_messages().iter().any(|message| {
            message.as_concat_text() == legacy.as_concat_text() && message.metadata.usage.is_none()
        }));
        let provider = MockProvider::new(
            Message::assistant().with_thinking("no summary body", ""),
            1000,
        );
        let failure = compact_messages(
            &provider,
            &provider.config,
            "empty-compaction",
            &conversation,
            false,
        )
        .await
        .unwrap_err();
        assert!(failure.to_string().contains("no summary text"));
        assert!(conversation
            .messages()
            .iter()
            .all(Message::is_agent_visible));
    }

    #[tokio::test]
    async fn compaction_retains_distinct_task_associations_on_preserved_user_inputs() {
        let request = |run: &str| {
            let mut metadata = MessageMetadata::default();
            metadata.task_run_id = Some(run.into());
            Message::user()
                .with_text(format!("request for {run}"))
                .with_metadata(metadata)
        };
        let conversation = Conversation::new_unvalidated([
            request("old-run"),
            Message::assistant().with_text("old response"),
            request("new-run"),
        ]);
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 1000);
        let (compacted, _) = compact_messages(
            &provider,
            &provider.config,
            "task-bindings",
            &conversation,
            false,
        )
        .await
        .unwrap();
        let latest_run = compacted
            .messages()
            .iter()
            .rev()
            .filter(|message| message.role == Role::User)
            .find_map(|message| message.metadata.task_run_id.as_deref());
        assert_eq!(latest_run, Some("new-run"));
        for run in ["old-run", "new-run"] {
            let preserved = compacted
                .messages()
                .iter()
                .find(|message| {
                    message.is_agent_visible()
                        && message.metadata.task_run_id.as_deref() == Some(run)
                })
                .unwrap();
            assert_eq!(preserved.as_concat_text(), format!("request for {run}"));
        }
        let (request_copy, _) = crate::conversation::fix_conversation(compacted.clone());
        assert!(request_copy
            .agent_visible_messages()
            .iter()
            .any(|message| message.as_concat_text().contains("request for new-run")));
    }

    #[tokio::test]
    async fn tool_pair_summary_projects_nested_audiences_before_provider_input() {
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 1000);
        let conversation = Conversation::new_unvalidated([
            Message::assistant()
                .with_tool_request("tool_0", Ok(CallToolRequestParams::new("read_file"))),
            Message::user().with_tool_response(
                "tool_0",
                Ok(rmcp::model::CallToolResult::success(vec![
                    RawContent::text("visible result").no_annotation(),
                    RawContent::text("user-only secret")
                        .no_annotation()
                        .with_audience(vec![Role::User]),
                ])),
            ),
        ]);

        let projected = agent_visible_tool_pair(&conversation, "tool_0").unwrap();
        let formatted = projected
            .iter()
            .map(format_message_for_compacting)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(formatted.contains("visible result"));
        assert!(!formatted.contains("user-only secret"));

        let user_only_conversation = Conversation::new_unvalidated([
            Message::assistant()
                .with_tool_request("tool_1", Ok(CallToolRequestParams::new("read_file"))),
            Message::user().with_tool_response(
                "tool_1",
                Ok(rmcp::model::CallToolResult::success(vec![
                    RawContent::text("user-only secret")
                        .no_annotation()
                        .with_audience(vec![Role::User]),
                ])),
            ),
        ]);
        let user_only_formatted = agent_visible_tool_pair(&user_only_conversation, "tool_1")
            .unwrap()
            .iter()
            .map(format_message_for_compacting)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!user_only_formatted.contains("user-only secret"));

        summarize_tool_call(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            "tool_0",
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn tool_pair_summary_rejects_agent_hidden_response() {
        let provider = MockProvider::new(Message::assistant().with_text("summary"), 1000);
        let conversation = Conversation::new_unvalidated([
            Message::assistant()
                .with_tool_request("tool_0", Ok(CallToolRequestParams::new("read_file"))),
            Message::user()
                .with_tool_response(
                    "tool_0",
                    Ok(rmcp::model::CallToolResult::success(vec![
                        RawContent::text("user-only secret").no_annotation(),
                    ])),
                )
                .with_metadata(MessageMetadata::user_only()),
        ]);

        let error = summarize_tool_call(
            &provider,
            &provider.config,
            "test-session-id",
            &conversation,
            "tool_0",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("No agent-visible tool pair"));
    }

    #[tokio::test]
    async fn test_progressive_removal_on_context_exceeded() {
        let response_message = Message::assistant().with_text("<mock summary>");
        // Set max to 2 tool responses - will trigger progressive removal
        let provider = MockProvider::new(response_message, 1000).with_max_tool_responses(2);

        // Create a conversation with many tool responses
        let mut messages = vec![Message::user().with_text("start")];
        for i in 0..10 {
            messages.push(Message::assistant().with_tool_request(
                format!("tool_{}", i),
                Ok(CallToolRequestParams::new("read_file")),
            ));
            messages.push(Message::user().with_tool_response(
                format!("tool_{}", i),
                Ok(rmcp::model::CallToolResult::success(vec![
                    RawContent::text(format!("response{}", i)).no_annotation(),
                ])),
            ));
        }

        let conversation = Conversation::new_unvalidated(messages);
        let model_config = provider.config.clone();
        let result = compact_messages(
            &provider,
            &model_config,
            "test-session-id",
            &conversation,
            false,
        )
        .await;

        assert!(
            result.is_ok(),
            "Should succeed with progressive removal: {:?}",
            result.err()
        );
        assert_eq!(
            *provider.compaction_attempts.lock().unwrap(),
            [(10, true), (9, true), (8, true), (5, true), (0, false)]
        );
    }

    #[tokio::test]
    async fn compaction_recovers_from_single_and_odd_large_results_without_losing_history() {
        for (count, expected_attempts) in [
            (1, vec![(1, true), (0, false)]),
            (
                3,
                vec![(3, true), (2, true), (2, true), (2, true), (0, false)],
            ),
            (
                5,
                vec![(5, true), (4, true), (4, true), (3, true), (0, false)],
            ),
        ] {
            let provider = MockProvider::new(Message::assistant().with_text("summary"), 1000)
                .with_max_tool_responses(0);
            let mut messages = vec![Message::user()
                .with_text("Analyze this project without modifying files")
                .with_id("original-goal")];
            let large_result = "large file contents ".repeat(3_500);
            for index in 0..count {
                messages.extend(create_tool_pair(
                    &format!("call-{index}"),
                    &format!("response-{index}"),
                    "read_file",
                    &large_result,
                ));
            }
            messages.push(
                Message::user()
                    .with_text("Keep the original goal and report only verified findings")
                    .with_id("latest-constraint"),
            );
            let conversation = Conversation::new_unvalidated(messages);
            let original = serde_json::to_value(&conversation).unwrap();

            let (compacted, _) = compact_messages(
                &provider,
                &provider.config,
                "large-results-recovery",
                &conversation,
                false,
            )
            .await
            .unwrap();

            assert_eq!(
                *provider.compaction_attempts.lock().unwrap(),
                expected_attempts,
                "tool result count: {count}"
            );
            assert_eq!(serde_json::to_value(&conversation).unwrap(), original);
            let visible_history = |history: &Conversation| {
                history
                    .user_visible_messages()
                    .into_iter()
                    .map(|message| (message.id, message.content))
                    .collect::<Vec<_>>()
            };
            assert_eq!(visible_history(&compacted), visible_history(&conversation));
            assert!(compacted
                .messages()
                .iter()
                .take(conversation.messages().len())
                .all(|message| !message.is_agent_visible()));
            let model_messages = compacted.agent_visible_messages();
            let model_text = model_messages
                .iter()
                .map(Message::as_concat_text)
                .collect::<Vec<_>>()
                .join("\n");
            assert!(model_text.contains("Analyze this project without modifying files"));
            assert!(model_text.contains("Keep the original goal and report only verified findings"));
            assert!(!model_text.contains(&large_result));
            assert!(model_messages.iter().all(|message| !message
                .content
                .iter()
                .any(|content| matches!(content, MessageContent::ToolResponse(_)))));
        }
    }

    #[test]
    fn test_compute_tool_call_cutoff_scales_with_context() {
        // Default threshold (0.8)
        assert_eq!(compute_tool_call_cutoff(128_000, 0.8), 15); // 102K effective
        assert_eq!(compute_tool_call_cutoff(200_000, 0.8), 24); // 160K effective
        assert_eq!(compute_tool_call_cutoff(1_000_000, 0.8), 120); // 800K effective
                                                                   // Clamp at minimum
        assert_eq!(compute_tool_call_cutoff(50_000, 0.8), 10);
        assert_eq!(compute_tool_call_cutoff(10_000, 0.8), 10);
        // Clamp at maximum (500)
        assert_eq!(compute_tool_call_cutoff(10_000_000, 0.8), 500);
        // Lower compaction threshold means earlier summarization
        assert_eq!(compute_tool_call_cutoff(200_000, 0.3), 10); // 60K effective
        assert_eq!(compute_tool_call_cutoff(1_000_000, 0.5), 75); // 500K effective
                                                                  // Invalid threshold falls back to default 0.8
        assert_eq!(compute_tool_call_cutoff(200_000, 0.0), 24); // falls back to 0.8
        assert_eq!(compute_tool_call_cutoff(200_000, -1.0), 24); // falls back to 0.8
    }

    #[test]
    fn test_tool_ids_to_summarize_triggers_at_cutoff_plus_batch() {
        // cutoff=5, so we need >5+10=15 to trigger. 15 exactly should NOT trigger.
        let mut messages = vec![Message::user().with_text("hello")];
        for i in 0..15 {
            messages.extend(create_tool_pair(
                &format!("call{}", i),
                &format!("resp{}", i),
                "read_file",
                "content",
            ));
        }
        let conversation = Conversation::new_unvalidated(messages);
        let result = tool_ids_to_summarize(&conversation, 5, 0);
        assert!(result.is_empty(), "Exactly cutoff+batch should not trigger");

        // 16 tool calls: now exceeds cutoff+10, should return a batch of 10
        let mut messages = vec![Message::user().with_text("hello")];
        for i in 0..16 {
            messages.extend(create_tool_pair(
                &format!("call{}", i),
                &format!("resp{}", i),
                "read_file",
                "content",
            ));
        }
        let conversation = Conversation::new_unvalidated(messages);
        let result = tool_ids_to_summarize(&conversation, 5, 0);
        assert_eq!(result.len(), TOOLCALL_SUMMARIZATION_BATCH_SIZE);
        assert_eq!(result[0], "call0");
        assert_eq!(result[9], "call9");
    }

    #[test]
    fn test_tool_ids_to_summarize_protects_current_turn() {
        // 20 tool pairs, cutoff=2 → 20 > 12, would normally trigger
        let mut messages = vec![Message::user().with_text("hello")];
        for i in 0..20 {
            messages.extend(create_tool_pair(
                &format!("call{}", i),
                &format!("resp{}", i),
                "read_file",
                "content",
            ));
        }
        let conversation = Conversation::new_unvalidated(messages);

        // No protection: 20 eligible, 20 > 12 → batch of 10
        let result = tool_ids_to_summarize(&conversation, 2, 0);
        assert_eq!(result.len(), TOOLCALL_SUMMARIZATION_BATCH_SIZE);

        // Protect last 8: 12 eligible, 12 <= 12 → nothing
        let result = tool_ids_to_summarize(&conversation, 2, 8);
        assert!(
            result.is_empty(),
            "Should not summarize when protected count leaves eligible <= cutoff + batch"
        );

        // Protect last 7: 13 eligible, 13 > 12 → batch of 10
        let result = tool_ids_to_summarize(&conversation, 2, 7);
        assert_eq!(result.len(), TOOLCALL_SUMMARIZATION_BATCH_SIZE);
        assert_eq!(result[0], "call0");
    }
}
