use super::{CoordinatorModelCallError, CoordinatorModelClient, CoordinatorModelRequest};
use crate::conversation::message::{Message, MessageContent};
use crate::providers::base::Provider;
use async_trait::async_trait;
use goose_providers::model::ModelConfig;
use std::sync::Arc;

pub struct ProviderCoordinatorClient<P> {
    provider: Arc<P>,
    model_config: ModelConfig,
}

impl<P> ProviderCoordinatorClient<P>
where
    P: Provider,
{
    pub fn new(provider: Arc<P>, model_config: ModelConfig) -> Self {
        Self {
            provider,
            model_config,
        }
    }

    pub fn provider_name(&self) -> &str {
        self.provider.get_name()
    }

    pub fn model_config(&self) -> &ModelConfig {
        &self.model_config
    }
}

#[async_trait]
impl<P> CoordinatorModelClient for ProviderCoordinatorClient<P>
where
    P: Provider + 'static,
{
    async fn generate(
        &self,
        request: CoordinatorModelRequest,
    ) -> Result<String, CoordinatorModelCallError> {
        let instruction = request.repair.map_or_else(
            || {
                "Produce the single coordinator decision now. Follow OUTPUT_CONTRACT exactly."
                    .to_string()
            },
            |repair| {
                format!(
                    "FORMAT_REPAIR_ATTEMPT={}; schema_version={}. The prior response failed strict parsing: {}. Return one corrected JSON object only.",
                    repair.attempt, repair.schema_version, repair.error
                )
            },
        );
        let messages = [Message::user().with_text(instruction)];
        let (message, _) = self
            .provider
            .complete(&self.model_config, &request.prompt, &messages, &[])
            .await
            .map_err(|error| CoordinatorModelCallError::new(error.to_string()))?;

        let mut output = String::new();
        for content in message.content {
            match content {
                MessageContent::Text(text) => output.push_str(&text.text),
                MessageContent::Thinking(_) | MessageContent::RedactedThinking(_) => {}
                _ => {
                    return Err(CoordinatorModelCallError::new(
                        "coordinator provider returned non-text action content",
                    ));
                }
            }
        }
        if output.trim().is_empty() {
            return Err(CoordinatorModelCallError::new(
                "coordinator provider returned no decision text",
            ));
        }
        Ok(output)
    }
}
