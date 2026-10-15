pub mod anthropic;
pub mod databricks;
pub mod google;
pub mod ollama;
pub mod openai;
pub mod openai_responses;

pub mod snowflake;

/// Display-only snapshot of arguments being generated. This is never a
/// ToolRequest: partial JSON must not reach execution or model history.
pub(crate) fn tool_input_preview(
    id: &str,
    name: &str,
    arguments: &str,
) -> crate::conversation::message::Message {
    use crate::conversation::message::{Message, SystemNotificationType};
    // Reuse tolerant JSON decoding only for the preview. The final request still
    // goes through the provider's normal complete-argument decoding and validation.
    let arguments = if arguments.len() <= 262_144 {
        crate::json::safely_parse_json(arguments)
            .ok()
            .filter(serde_json::Value::is_object)
    } else {
        None
    };
    Message::assistant().with_system_notification_with_data(
        SystemNotificationType::ProgressMessage,
        "Generating operation input",
        serde_json::json!({"type":"tool_input_preview", "id":id, "name":name, "arguments":arguments}),
    )
}
