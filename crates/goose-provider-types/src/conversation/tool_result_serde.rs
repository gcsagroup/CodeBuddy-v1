use crate::conversation::message::ToolResult;
use rmcp::model::{CallToolRequestParams, ErrorCode, ErrorData, JsonObject};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Cow;

pub fn serialize<T, S>(value: &ToolResult<T>, serializer: S) -> Result<S::Ok, S::Error>
where
    T: Serialize,
    S: Serializer,
{
    match value {
        Ok(val) => {
            let mut state = serializer.serialize_struct("ToolResult", 2)?;
            state.serialize_field("status", "success")?;
            state.serialize_field("value", val)?;
            state.end()
        }
        Err(err) => {
            let mut state = serializer.serialize_struct("ToolResult", 2)?;
            state.serialize_field("status", "error")?;
            state.serialize_field("error", &err.to_string())?;
            state.end()
        }
    }
}

#[derive(Deserialize)]
struct ToolCallWithValueArguments {
    name: String,
    arguments: serde_json::Value,
}

impl ToolCallWithValueArguments {
    fn into_call_tool_request_param(self) -> CallToolRequestParams {
        let arguments = match self.arguments {
            serde_json::Value::Object(map) => Some(map),
            serde_json::Value::Null => None,
            other => {
                let mut map = JsonObject::new();
                map.insert("value".to_string(), other);
                Some(map)
            }
        };
        {
            let mut params = CallToolRequestParams::new(self.name);
            if let Some(args) = arguments {
                params = params.with_arguments(args);
            }
            params
        }
    }
}

pub fn deserialize<'de, D>(deserializer: D) -> Result<ToolResult<CallToolRequestParams>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ResultFormat {
        SuccessWithCallToolRequestParams {
            status: String,
            value: CallToolRequestParams,
        },
        SuccessWithToolCallValueArguments {
            status: String,
            value: ToolCallWithValueArguments,
        },
        Error {
            status: String,
            error: String,
        },
    }

    let format = ResultFormat::deserialize(deserializer)?;

    match format {
        ResultFormat::SuccessWithCallToolRequestParams { status, value } => {
            if status == "success" {
                Ok(Ok(value))
            } else {
                Err(serde::de::Error::custom(format!(
                    "Expected status 'success', got '{}'",
                    status
                )))
            }
        }
        ResultFormat::SuccessWithToolCallValueArguments { status, value } => {
            if status == "success" {
                Ok(Ok(value.into_call_tool_request_param()))
            } else {
                Err(serde::de::Error::custom(format!(
                    "Expected status 'success', got '{}'",
                    status
                )))
            }
        }
        ResultFormat::Error { status, error } => {
            if status == "error" {
                Ok(Err(ErrorData {
                    code: ErrorCode::INTERNAL_ERROR,
                    message: Cow::from(error),
                    data: None,
                }))
            } else {
                Err(serde::de::Error::custom(format!(
                    "Expected status 'error', got '{}'",
                    status
                )))
            }
        }
    }
}

pub mod call_tool_result {
    use super::*;
    use rmcp::model::{CallToolResult, Content};

    pub fn serialize<S>(
        value: &ToolResult<CallToolResult>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Ok(_) => super::serialize(value, serializer),
            Err(error) => {
                // Keep the legacy display field for old readers. New readers need
                // the original structured receipt, not a reparse of its text.
                let mut state = serializer.serialize_struct("ToolResult", 3)?;
                state.serialize_field("status", "error")?;
                state.serialize_field("error", &error.to_string())?;
                state.serialize_field("errorData", error)?;
                state.end()
            }
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<ToolResult<CallToolResult>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum ResultFormat {
            SuccessWithCallToolResult {
                status: String,
                value: CallToolResult,
            },
            SuccessWithContentVec {
                status: String,
                value: Vec<Content>,
            },
            Error {
                status: String,
                error: String,
                #[serde(default, rename = "errorData")]
                error_data: Option<serde_json::Value>,
            },
        }

        let format = ResultFormat::deserialize(deserializer)?;

        match format {
            ResultFormat::SuccessWithCallToolResult { status, value } => {
                if status == "success" {
                    Ok(Ok(value))
                } else {
                    Err(serde::de::Error::custom(format!(
                        "Expected status 'success', got '{}'",
                        status
                    )))
                }
            }
            ResultFormat::SuccessWithContentVec { status, value } => {
                if status == "success" {
                    Ok(Ok(CallToolResult::success(value)))
                } else {
                    Err(serde::de::Error::custom(format!(
                        "Expected status 'success', got '{}'",
                        status
                    )))
                }
            }
            ResultFormat::Error {
                status,
                error,
                error_data,
            } => {
                if status == "error" {
                    // Missing/invalid optional data degrades only the structured
                    // receipt. Never manufacture audit facts from legacy prose.
                    let structured = error_data.and_then(|data| serde_json::from_value(data).ok());
                    Ok(Err(structured.unwrap_or_else(|| ErrorData {
                        code: ErrorCode::INTERNAL_ERROR,
                        message: Cow::from(error),
                        data: None,
                    })))
                } else {
                    Err(serde::de::Error::custom(format!(
                        "Expected status 'error', got '{}'",
                        status
                    )))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::message::ToolResponse;

    #[test]
    fn tool_error_round_trip_preserves_receipt_and_legacy_display() {
        let error = ErrorData::new(
            ErrorCode::INVALID_REQUEST,
            "deadline",
            Some(serde_json::json!({
                "original_attempt":"attempt-1", "termination_confirmed":true,
            })),
        );
        let response = ToolResponse {
            id: "call-1".into(),
            tool_result: Err(error.clone()),
            metadata: None,
        };
        let value = serde_json::to_value(&response).unwrap();
        assert_eq!(value["toolResult"]["status"], "error");
        assert_eq!(value["toolResult"]["error"], error.to_string());
        let restored: ToolResponse = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(restored, response);

        // An old reader can still consume the unchanged status/error pair.
        #[derive(Deserialize)]
        struct LegacyError {
            status: String,
            error: String,
        }
        let legacy: LegacyError = serde_json::from_value(value["toolResult"].clone()).unwrap();
        assert_eq!(legacy.status, "error");
        assert_eq!(legacy.error, error.to_string());
    }

    #[test]
    fn old_or_invalid_tool_error_data_never_invents_structured_facts() {
        for optional in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!({"data":{"termination_confirmed":true}})),
        ] {
            let mut value = serde_json::json!({"id":"call-1","toolResult":{"status":"error","error":"old text: termination_confirmed=true"}});
            if let Some(optional) = optional {
                value["toolResult"]["errorData"] = optional;
            }
            let restored: ToolResponse = serde_json::from_value(value).unwrap();
            let error = restored.tool_result.unwrap_err();
            assert!(error.data.is_none());
            assert_eq!(error.message, "old text: termination_confirmed=true");
        }
    }
}
