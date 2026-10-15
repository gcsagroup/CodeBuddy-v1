use async_trait::async_trait;
use goose::agents::coordinator::{
    CoordinatorFormatRepair, CoordinatorModelClient, CoordinatorModelRequest,
    ProviderCoordinatorClient,
};
use goose::conversation::message::Message;
use goose::providers::base::{stream_from_single_message, MessageStream, Provider};
use goose_providers::conversation::token_usage::{ProviderUsage, Usage};
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use rmcp::model::Tool;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct CapturedRequest {
    model: String,
    system: String,
    user_text: String,
    tool_count: usize,
}

struct FakeProvider {
    response: Message,
    captured: Arc<Mutex<CapturedRequest>>,
}

#[async_trait]
impl Provider for FakeProvider {
    fn get_name(&self) -> &str {
        "fixed-provider"
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let mut captured = self.captured.lock().unwrap();
        captured.model = model_config.model_name.clone();
        captured.system = system.to_string();
        captured.user_text = messages
            .iter()
            .flat_map(|message| message.content.iter())
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("");
        captured.tool_count = tools.len();
        Ok(stream_from_single_message(
            self.response.clone(),
            ProviderUsage::new("fixed-provider".into(), Usage::default()),
        ))
    }
}

#[tokio::test]
async fn adapter_uses_the_fixed_provider_model_and_zero_tools() {
    let captured = Arc::new(Mutex::new(CapturedRequest::default()));
    let provider = Arc::new(FakeProvider {
        response: Message::assistant().with_text(r#"{"schema_version":1}"#),
        captured: captured.clone(),
    });
    let client = ProviderCoordinatorClient::new(provider, ModelConfig::new("fixed-model-high"));

    let output = client
        .generate(CoordinatorModelRequest {
            prompt: "<OUTPUT_CONTRACT>strict schema</OUTPUT_CONTRACT>".into(),
            repair: None,
        })
        .await
        .unwrap();

    assert_eq!(output, r#"{"schema_version":1}"#);
    assert_eq!(client.provider_name(), "fixed-provider");
    assert_eq!(client.model_config().model_name, "fixed-model-high");
    let captured = captured.lock().unwrap();
    assert_eq!(captured.model, "fixed-model-high");
    assert!(captured.system.contains("OUTPUT_CONTRACT"));
    assert!(captured.user_text.contains("single coordinator decision"));
    assert_eq!(captured.tool_count, 0);
}

#[tokio::test]
async fn repair_is_bounded_metadata_not_a_provider_or_model_fallback() {
    let captured = Arc::new(Mutex::new(CapturedRequest::default()));
    let provider = Arc::new(FakeProvider {
        response: Message::assistant().with_text("{}"),
        captured: captured.clone(),
    });
    let client = ProviderCoordinatorClient::new(provider, ModelConfig::new("same-model"));
    client
        .generate(CoordinatorModelRequest {
            prompt: "same trusted prompt".into(),
            repair: Some(CoordinatorFormatRepair {
                attempt: 1,
                schema_version: 1,
                error: "missing field action".into(),
            }),
        })
        .await
        .unwrap();

    let captured = captured.lock().unwrap();
    assert_eq!(captured.model, "same-model");
    assert_eq!(captured.system, "same trusted prompt");
    assert!(captured.user_text.contains("FORMAT_REPAIR_ATTEMPT=1"));
    assert!(captured.user_text.contains("missing field action"));
}

#[tokio::test]
async fn empty_provider_response_is_not_treated_as_a_decision() {
    let provider = Arc::new(FakeProvider {
        response: Message::assistant(),
        captured: Arc::new(Mutex::new(CapturedRequest::default())),
    });
    let client = ProviderCoordinatorClient::new(provider, ModelConfig::new("fixed-model"));

    assert!(client
        .generate(CoordinatorModelRequest {
            prompt: "trusted prompt".into(),
            repair: None,
        })
        .await
        .is_err());
}
