use std::collections::{HashMap, HashSet};
use std::time::Duration;

use rmcp::model::{CallToolResult, Content};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::action_required_manager::{ActionRequiredManager, ElicitationOutcome};
use crate::agents::ToolCallContext;

const MAX_QUESTIONS: usize = 4;
// Added for debugging
const MAX_OPTIONS: usize = 8;
const ELICITATION_TIMEOUT: Duration = Duration::from_secs(300);

type QuestionSchema<'a> = (&'a str, &'a str, Option<&'a str>, bool, Map<String, Value>);

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct AskUserParams {
    /// Short explanation shown above the questions.
    #[serde(default)]
    pub message: String,
    /// One to four questions. Ask only questions whose answers materially affect the work.
    pub questions: Vec<AskUserQuestion>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub(crate) enum AskUserQuestion {
    Structured(StructuredAskUserQuestion),
    Codex(CodexAskUserQuestion),
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum StructuredAskUserQuestion {
    Single {
        key: String,
        title: String,
        #[serde(default)]
        description: Option<String>,
        options: Vec<AskUserOptionInput>,
        #[serde(default = "default_required")]
        required: bool,
    },
    Multiple {
        key: String,
        title: String,
        #[serde(default)]
        description: Option<String>,
        options: Vec<AskUserOptionInput>,
        #[serde(default)]
        required: bool,
    },
    Text {
        key: String,
        title: String,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        required: bool,
        #[serde(default = "default_max_length")]
        max_length: u32,
    },
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct CodexAskUserQuestion {
    /// Stable identifier used as the response key.
    #[serde(default, alias = "key")]
    id: Option<String>,
    /// Short label displayed above the question.
    #[serde(default, alias = "short_label")]
    header: Option<String>,
    /// User-facing question text.
    #[serde(alias = "title", alias = "prompt")]
    question: String,
    /// Two or more mutually exclusive choices. If omitted, the question is
    /// rendered as a required text response instead of rejecting the request.
    #[serde(default, alias = "choices")]
    options: Vec<AskUserOptionInput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct AskUserOption {
    /// Stable response value. Codex-style callers may omit it; the label is then used.
    #[serde(default)]
    pub value: Option<String>,
    /// User-facing label. When a recommendation is useful, put that choice first
    /// and append "（推荐）" (or the user's language equivalent). This is not consent or a default answer.
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(untagged)]
pub(crate) enum AskUserOptionInput {
    Detailed(AskUserOption),
    Label(String),
}

#[derive(Debug, Serialize)]
struct AskUserResult<'a> {
    action: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    answers: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'a str>,
}

fn default_required() -> bool {
    true
}

fn default_max_length() -> u32 {
    1000
}

impl AskUserParams {
    fn requested_schema(&self) -> Result<Value, String> {
        if self.questions.is_empty() || self.questions.len() > MAX_QUESTIONS {
            return Err(format!("questions must contain 1 to {MAX_QUESTIONS} items"));
        }

        let mut properties = Map::new();
        let mut required = Vec::new();
        let mut keys = HashSet::new();

        for question in &self.questions {
            let (key, title, description, is_required, property) = question.to_schema()?;
            if !is_safe_key(key) {
                return Err(format!(
                    "question key '{key}' must start with a letter and contain only letters, digits, or underscores"
                ));
            }
            if !keys.insert(key.to_string()) {
                return Err(format!("question key '{key}' is duplicated"));
            }
            if title.trim().is_empty() {
                return Err(format!("question '{key}' title must not be empty"));
            }

            let mut property = property;
            property.insert("title".to_string(), Value::String(title.to_string()));
            if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
                property.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
            properties.insert(key.to_string(), Value::Object(property));
            if is_required {
                required.push(Value::String(key.to_string()));
            }
        }

        Ok(json!({
            "type": "object",
            "properties": properties,
            "required": required,
        }))
    }
}

impl AskUserQuestion {
    fn to_schema(&self) -> Result<QuestionSchema<'_>, String> {
        match self {
            Self::Structured(StructuredAskUserQuestion::Single {
                key,
                title,
                description,
                options,
                required,
            }) => Ok((
                key,
                title,
                description.as_deref(),
                *required,
                choice_schema(options, false, *required)?,
            )),
            Self::Structured(StructuredAskUserQuestion::Multiple {
                key,
                title,
                description,
                options,
                required,
            }) => Ok((
                key,
                title,
                description.as_deref(),
                *required,
                choice_schema(options, true, *required)?,
            )),
            Self::Structured(StructuredAskUserQuestion::Text {
                key,
                title,
                description,
                required,
                max_length,
            }) => {
                if !(1..=4000).contains(max_length) {
                    return Err(format!(
                        "question '{key}' max_length must be between 1 and 4000"
                    ));
                }
                let mut schema = Map::from_iter([
                    ("type".to_string(), Value::String("string".to_string())),
                    ("maxLength".to_string(), Value::Number((*max_length).into())),
                ]);
                if *required {
                    schema.insert("minLength".to_string(), Value::Number(1.into()));
                }
                Ok((key, title, description.as_deref(), *required, schema))
            }
            Self::Codex(question) => {
                let title = question
                    .header
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(&question.question);
                let description = question
                    .header
                    .as_ref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|_| question.question.as_str());
                let property = if question.options.is_empty() {
                    Map::from_iter([
                        ("type".to_string(), Value::String("string".to_string())),
                        ("minLength".to_string(), Value::Number(1.into())),
                        ("maxLength".to_string(), Value::Number(1000.into())),
                    ])
                } else {
                    choice_schema(&question.options, false, true)?
                };
                Ok((
                    question.id.as_deref().unwrap_or("answer"),
                    title,
                    description,
                    true,
                    property,
                ))
            }
        }
    }
}

fn choice_schema(
    options: &[AskUserOptionInput],
    multiple: bool,
    required: bool,
) -> Result<Map<String, Value>, String> {
    if options.len() < 2 || options.len() > MAX_OPTIONS {
        return Err(format!(
            "choice questions must contain 2 to {MAX_OPTIONS} options"
        ));
    }

    let mut values = HashSet::new();
    let mut descriptions = HashMap::new();
    let mut variants = Vec::with_capacity(options.len());
    for option in options {
        let (configured_value, label, description) = match option {
            AskUserOptionInput::Detailed(option) => (
                option.value.as_deref(),
                option.label.as_str(),
                option.description.as_deref(),
            ),
            AskUserOptionInput::Label(label) => (None, label.as_str(), None),
        };
        let value = configured_value
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(label);
        if value.trim().is_empty() || label.trim().is_empty() {
            return Err("choice values and labels must not be empty".to_string());
        }
        if !values.insert(value) {
            return Err(format!("choice value '{value}' is duplicated"));
        }
        let mut variant = json!({ "const": value, "title": label });
        if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
            variant["description"] = Value::String(description.to_string());
            descriptions.insert(value.to_string(), description.to_string());
        }
        variants.push(variant);
    }

    let meta = json!({ "codepro.dev/optionDescriptions": descriptions });
    if multiple {
        let mut schema = Map::from_iter([
            ("type".to_string(), Value::String("array".to_string())),
            ("items".to_string(), json!({ "anyOf": variants })),
            ("_meta".to_string(), meta),
        ]);
        if required {
            schema.insert("minItems".to_string(), Value::Number(1.into()));
        }
        Ok(schema)
    } else {
        Ok(Map::from_iter([
            ("type".to_string(), Value::String("string".to_string())),
            ("oneOf".to_string(), Value::Array(variants)),
            ("_meta".to_string(), meta),
        ]))
    }
}

fn is_safe_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

pub(crate) async fn ask_user(params: AskUserParams, ctx: &ToolCallContext) -> CallToolResult {
    let schema = match params.requested_schema() {
        Ok(schema) => schema,
        Err(error) => return CallToolResult::error(vec![Content::text(format!("Error: {error}"))]),
    };
    let Some(tool_call_request_id) = ctx.tool_call_request_id.clone() else {
        return CallToolResult::error(vec![Content::text(
            "Error: ask_user requires a tool call request id",
        )]);
    };

    let message = if params.message.trim().is_empty() {
        "Please answer the following question(s) to continue.".to_string()
    } else {
        params.message
    };

    match ActionRequiredManager::global()
        .request_and_wait(
            ctx.session_id.clone(),
            tool_call_request_id,
            message,
            schema,
            ELICITATION_TIMEOUT,
        )
        .await
    {
        Ok(ElicitationOutcome::Accept(answers)) => tool_result(AskUserResult {
            action: "accept",
            answers: Some(answers),
            reason: None,
        }),
        Ok(ElicitationOutcome::Decline) => tool_result(AskUserResult {
            action: "unanswered",
            answers: None,
            reason: Some("declined"),
        }),
        Ok(ElicitationOutcome::Cancel) => tool_result(AskUserResult {
            action: "unanswered",
            answers: None,
            reason: Some("cancelled_or_expired"),
        }),
        Err(error) if error.is::<tokio::time::error::Elapsed>() => tool_result(AskUserResult {
            action: "unanswered",
            answers: None,
            reason: Some("timeout"),
        }),
        Err(error) => CallToolResult::error(vec![Content::text(format!(
            "Error while waiting for user response: {error}"
        ))]),
    }
}

fn tool_result(result: AskUserResult<'_>) -> CallToolResult {
    let json = serde_json::to_string(&result).expect("ask_user result should serialize");
    CallToolResult::success(vec![Content::text(json)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::message::{ActionRequiredData, MessageContent};

    fn option(value: &str, label: &str) -> AskUserOptionInput {
        AskUserOptionInput::Detailed(AskUserOption {
            value: Some(value.to_string()),
            label: label.to_string(),
            description: None,
        })
    }

    #[test]
    fn builds_standard_single_multi_and_text_schema() {
        let params = AskUserParams {
            message: "Need direction".to_string(),
            questions: vec![
                AskUserQuestion::Structured(StructuredAskUserQuestion::Single {
                    key: "scope".to_string(),
                    title: "Choose scope".to_string(),
                    description: None,
                    options: vec![option("current", "Current"), option("all", "All")],
                    required: true,
                }),
                AskUserQuestion::Structured(StructuredAskUserQuestion::Multiple {
                    key: "goals".to_string(),
                    title: "Choose goals".to_string(),
                    description: None,
                    options: vec![option("audit", "Audit"), option("repair", "Repair")],
                    required: false,
                }),
                AskUserQuestion::Structured(StructuredAskUserQuestion::Text {
                    key: "notes".to_string(),
                    title: "Additional notes".to_string(),
                    description: None,
                    required: false,
                    max_length: 1000,
                }),
            ],
        };

        let schema = params.requested_schema().unwrap();
        let parsed: agent_client_protocol::schema::v1::ElicitationSchema =
            serde_json::from_value(schema.clone()).unwrap();
        assert_eq!(parsed.required, Some(vec!["scope".to_string()]));
        assert_eq!(schema["properties"]["scope"]["type"], "string");
        assert_eq!(
            schema["properties"]["scope"]["oneOf"][0]["const"],
            "current"
        );
        assert_eq!(schema["properties"]["goals"]["type"], "array");
        assert_eq!(
            schema["properties"]["goals"]["items"]["anyOf"][1]["title"],
            "Repair"
        );
        assert_eq!(schema["properties"]["notes"]["maxLength"], 1000);
        assert_eq!(schema["required"], json!(["scope"]));
    }

    #[test]
    fn accepts_codex_style_questions_and_uses_labels_as_values() {
        let params: AskUserParams = serde_json::from_value(json!({
            "message": "The user must choose a product behavior.",
            "questions": [{
                "header": "Behavior",
                "id": "behavior",
                "question": "Keep or replace the existing records?",
                "options": [
                    { "label": "Keep", "description": "Preserve the existing records." },
                    { "label": "Replace", "description": "Use the new records instead." }
                ]
            }]
        }))
        .unwrap();

        let schema = params.requested_schema().unwrap();
        assert_eq!(schema["properties"]["behavior"]["title"], "Behavior");
        assert_eq!(
            schema["properties"]["behavior"]["description"],
            "Keep or replace the existing records?"
        );
        assert_eq!(
            schema["properties"]["behavior"]["oneOf"][0]["const"],
            "Keep"
        );
        assert_eq!(schema["required"], json!(["behavior"]));
    }

    #[test]
    fn accepts_minimal_model_question_without_message_or_id() {
        let params: AskUserParams = serde_json::from_value(json!({
            "questions": [{
                "prompt": "Which language should the generated documentation use?",
                "choices": ["English", "Chinese"]
            }]
        }))
        .unwrap();

        let schema = params.requested_schema().unwrap();
        assert_eq!(
            schema["properties"]["answer"]["title"],
            "Which language should the generated documentation use?"
        );
        assert_eq!(
            schema["properties"]["answer"]["oneOf"][0]["const"],
            "English"
        );
        assert_eq!(schema["required"], json!(["answer"]));
    }

    #[test]
    fn accepts_codex_question_without_options_as_required_text() {
        let params: AskUserParams = serde_json::from_value(json!({
            "message": "A required product name is missing.",
            "questions": [{
                "id": "product_name",
                "question": "What should the product be called?"
            }]
        }))
        .unwrap();

        let schema = params.requested_schema().unwrap();
        assert_eq!(schema["properties"]["product_name"]["type"], "string");
        assert_eq!(schema["properties"]["product_name"]["minLength"], 1);
        assert_eq!(schema["properties"]["product_name"]["maxLength"], 1000);
        assert_eq!(schema["required"], json!(["product_name"]));
    }

    #[test]
    fn rejects_unsafe_or_duplicated_questions() {
        let invalid_key = AskUserParams {
            message: "Need direction".to_string(),
            questions: vec![AskUserQuestion::Structured(
                StructuredAskUserQuestion::Text {
                    key: "bad-key".to_string(),
                    title: "Question".to_string(),
                    description: None,
                    required: false,
                    max_length: 100,
                },
            )],
        };
        assert!(invalid_key
            .requested_schema()
            .unwrap_err()
            .contains("bad-key"));

        let too_many = AskUserParams {
            message: "Need direction".to_string(),
            questions: (0..5)
                .map(|index| {
                    AskUserQuestion::Structured(StructuredAskUserQuestion::Text {
                        key: format!("q{index}"),
                        title: format!("Question {index}"),
                        description: None,
                        required: false,
                        max_length: 100,
                    })
                })
                .collect(),
        };
        assert!(too_many.requested_schema().is_err());
    }

    #[tokio::test]
    async fn pauses_for_and_returns_the_user_response() {
        let session_id = "ask-user-tool-session".to_string();
        let tool_call_id = "ask-user-tool-call".to_string();
        let manager = ActionRequiredManager::global();
        let mut messages = manager
            .register_action_required_stream(session_id.clone(), tool_call_id.clone())
            .await;
        let params = AskUserParams {
            message: "Choose a scope".to_string(),
            questions: vec![AskUserQuestion::Structured(
                StructuredAskUserQuestion::Single {
                    key: "scope".to_string(),
                    title: "Scope".to_string(),
                    description: None,
                    options: vec![option("workspace", "Workspace"), option("file", "File")],
                    required: true,
                },
            )],
        };
        let ctx = ToolCallContext::new(session_id.clone(), None, Some(tool_call_id.clone()));

        let waiting = tokio::spawn(async move { ask_user(params, &ctx).await });
        let message = tokio::time::timeout(Duration::from_secs(1), messages.recv())
            .await
            .expect("timed out waiting for the question")
            .expect("question stream closed");
        let request_id = match &message.content[0] {
            MessageContent::ActionRequired(action_required) => match &action_required.data {
                ActionRequiredData::Elicitation {
                    id,
                    requested_schema,
                    ..
                } => {
                    assert_eq!(requested_schema["properties"]["scope"]["type"], "string");
                    id.clone()
                }
                _ => panic!("expected elicitation request"),
            },
            _ => panic!("expected action-required message"),
        };

        manager
            .claim_response(&session_id, &request_id)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Accept(json!({ "scope": "workspace" })))
            .unwrap();
        let result = waiting.await.unwrap();
        assert_eq!(result.is_error, Some(false));

        manager
            .unregister_action_required_stream(&session_id, &tool_call_id)
            .await;
    }

    #[tokio::test]
    async fn ask_user_flow_skipped_question_is_unanswered_not_permission() {
        let session_id = "ask-user-skipped-session".to_string();
        let tool_call_id = "ask-user-skipped-call".to_string();
        let manager = ActionRequiredManager::global();
        let mut messages = manager
            .register_action_required_stream(session_id.clone(), tool_call_id.clone())
            .await;
        let params = AskUserParams {
            message: "Which product behavior do you want?".to_string(),
            questions: vec![AskUserQuestion::Structured(
                StructuredAskUserQuestion::Single {
                    key: "behavior".to_string(),
                    title: "Behavior".to_string(),
                    description: None,
                    options: vec![option("keep", "Keep"), option("replace", "Replace")],
                    required: true,
                },
            )],
        };
        let ctx = ToolCallContext::new(session_id.clone(), None, Some(tool_call_id.clone()));

        let waiting = tokio::spawn(async move { ask_user(params, &ctx).await });
        let message = messages.recv().await.expect("question should be emitted");
        let request_id = match &message.content[0] {
            MessageContent::ActionRequired(action_required) => match &action_required.data {
                ActionRequiredData::Elicitation { id, .. } => id.clone(),
                _ => panic!("expected elicitation request"),
            },
            _ => panic!("expected action-required message"),
        };
        manager
            .claim_response(&session_id, &request_id)
            .await
            .unwrap()
            .submit(ElicitationOutcome::Cancel)
            .unwrap();

        let result = waiting.await.unwrap();
        assert_eq!(result.is_error, Some(false));
        let rmcp::model::RawContent::Text(text) = &result.content[0].raw else {
            panic!("expected text result");
        };
        let answer: Value = serde_json::from_str(&text.text).unwrap();
        assert_eq!(answer["action"], "unanswered");
        assert_eq!(answer["reason"], "cancelled_or_expired");
        assert!(answer.get("answers").is_none());

        manager
            .unregister_action_required_stream(&session_id, &tool_call_id)
            .await;
    }
}
