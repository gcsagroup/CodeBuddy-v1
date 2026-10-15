use crate::conversation::token_usage::{CostSource, ProviderUsage};
use crate::images::ImageFormat;
use anyhow::Error;
use async_stream::try_stream;
use futures::TryStreamExt;
use reqwest::Response;
#[cfg(test)]
use reqwest::StatusCode;
use serde_json::Value;
use std::time::Duration;
use tokio::pin;
use tokio::time::{timeout_at, Instant};
use tokio_stream::StreamExt;
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::io::StreamReader;

use super::api_client::ApiClient;
use super::base::{stream_from_single_message, MessageStream, Provider};
use super::retry::ProviderRetry;
use crate::conversation::message::{Message, MessageContent};
use crate::errors::ProviderError;
use crate::formats::openai::{
    create_request, get_cost, get_usage, response_to_message, response_to_streaming_message,
};
use crate::formats::openai_responses::responses_api_to_streaming_message;
use crate::model::ModelConfig;
use crate::request_log::{start_log, LoggerHandleExt, RequestLogHandle, StreamTiming};
use rmcp::model::Tool;

// A total HTTP timeout also covers active generation. Bound silent waits separately,
// without replaying a request whose response may already have started.
pub(crate) const DEFAULT_STREAM_WAIT: Duration = Duration::from_secs(60);

pub(crate) async fn await_stream_headers<F>(
    request: F,
    deadline: Option<Instant>,
) -> Result<Response, ProviderError>
where
    F: std::future::Future<Output = Result<Response, ProviderError>>,
{
    match deadline {
        Some(deadline) => timeout_at(deadline, request)
            .await
            .map_err(|_| stream_wait_error())?,
        None => request.await,
    }
}

fn stream_wait_error() -> ProviderError {
    ProviderError::NetworkError(
        "Model response wait timed out without stream data; retry when the service is ready."
            .into(),
    )
}

fn bounded_sse_lines<S>(
    lines: S,
    mut deadline: Instant,
    wait: Duration,
) -> impl futures::Stream<Item = Result<String, Error>> + Send
where
    S: futures::Stream<Item = Result<String, Error>> + Send,
{
    try_stream! {
        pin!(lines);
        loop {
            let next = timeout_at(deadline, lines.next()).await
                .map_err(|_| Error::new(stream_wait_error()))?;
            let Some(line) = next else { break };
            let line = line?;
            // SSE comments/blank keepalives are not model progress. Count complete
            // data events, including incremental tool arguments not yet emitted by
            // the message parser, so a long active tool stream remains alive.
            if line.strip_prefix("data:").is_some_and(|data| !data.trim().is_empty()) {
                deadline = Instant::now() + wait;
            }
            yield line;
        }
    }
}

#[derive(Clone, Copy)]
enum CredentialProbe {
    Unsupported,
    ModelsEndpoint { vendor_hostname: &'static str },
}

pub struct OpenAiCompatibleProvider {
    name: String,
    /// Client targeted at the base URL (e.g. `https://api.x.ai/v1`)
    api_client: ApiClient,
    /// Path prefix prepended to `chat/completions` (e.g. `"deployments/{name}/"` for Azure).
    completions_prefix: String,
    supports_streaming: bool,
    stream_wait: Duration,
    credential_probe: CredentialProbe,
}

impl OpenAiCompatibleProvider {
    pub fn new(name: String, api_client: ApiClient, completions_prefix: String) -> Self {
        Self {
            name,
            api_client,
            completions_prefix,
            supports_streaming: true,
            stream_wait: DEFAULT_STREAM_WAIT,
            credential_probe: CredentialProbe::Unsupported,
        }
    }

    pub fn with_supports_streaming(mut self, supports_streaming: bool) -> Self {
        self.supports_streaming = supports_streaming;
        self
    }

    pub fn api_host(&self) -> &str {
        self.api_client.host()
    }

    pub fn with_models_credential_probe_for_vendor(
        mut self,
        vendor_hostname: &'static str,
    ) -> Self {
        self.credential_probe = CredentialProbe::ModelsEndpoint { vendor_hostname };
        self
    }

    fn build_request(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
        for_streaming: bool,
    ) -> Result<Value, ProviderError> {
        create_request(
            model_config,
            system,
            messages,
            tools,
            &ImageFormat::OpenAi,
            for_streaming,
        )
        .map_err(|e| ProviderError::RequestFailed(format!("Failed to create request: {}", e)))
    }
}

#[async_trait::async_trait]
impl Provider for OpenAiCompatibleProvider {
    fn retry_config(&self) -> super::retry::RetryConfig {
        // An unchanged invalid endpoint/model request cannot recover with backoff.
        super::retry::RetryConfig::default().transient_only()
    }

    fn get_name(&self) -> &str {
        &self.name
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        let response = self
            .api_client
            .response_get("models")
            .await
            .map_err(|e| ProviderError::RequestFailed(e.to_string()))?;
        let json = handle_response_openai_compat(response).await?;

        if let Some(err_obj) = json.get("error") {
            let msg = err_obj
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(ProviderError::Authentication(msg.to_string()));
        }

        let arr = json.get("data").and_then(|v| v.as_array()).ok_or_else(|| {
            ProviderError::RequestFailed("Missing 'data' array in models response".to_string())
        })?;
        let mut models: Vec<String> = arr
            .iter()
            .filter_map(|m| m.get("id").and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect();
        if models.is_empty() {
            return Err(ProviderError::RequestFailed(
                "Models response did not contain a usable model id".to_string(),
            ));
        }
        models.sort();
        Ok(models)
    }

    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        match self.credential_probe {
            CredentialProbe::Unsupported => Err(ProviderError::NotImplemented(format!(
                "Credential pre-validation is not supported for provider '{}'",
                self.name
            ))),
            CredentialProbe::ModelsEndpoint { vendor_hostname } => {
                if !crate::api_client::has_trusted_https_origin(
                    self.api_client.host(),
                    vendor_hostname,
                ) {
                    return Err(ProviderError::NotImplemented(format!(
                        "Credential pre-validation is not supported for provider '{}' on this host",
                        self.name
                    )));
                }
                self.fetch_supported_models()
                    .await
                    .map(|_| ())
                    .map_err(ProviderError::for_credential_probe)
            }
        }
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[Tool],
    ) -> Result<MessageStream, ProviderError> {
        let payload = self.build_request(
            model_config,
            system,
            messages,
            tools,
            self.supports_streaming,
        )?;
        let mut log = start_log(model_config, &payload)?;
        let timing = StreamTiming::start();
        let attempt = std::sync::atomic::AtomicU64::new(0);

        let completions_path = format!("{}chat/completions", self.completions_prefix);
        let deadline = Instant::now() + self.stream_wait;
        let response = await_stream_headers(
            self.with_retry(|| async {
                if let Some(timing) = &timing {
                    timing.record(
                        "http_attempt",
                        attempt.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1,
                        0,
                    );
                }
                let resp = self
                    .api_client
                    .response_post(&completions_path, &payload)
                    .await?;
                handle_status(resp).await
            }),
            self.supports_streaming.then_some(deadline),
        )
        .await
        .inspect_err(|e| {
            if let Some(timing) = &timing {
                timing.record(
                    "http_failed",
                    attempt.load(std::sync::atomic::Ordering::Relaxed),
                    0,
                );
            }
            let _ = log.error(e);
        })?;

        if self.supports_streaming {
            stream_openai_compat_with_timing(response, log, timing, deadline, self.stream_wait)
        } else {
            let json: serde_json::Value = response.json().await.map_err(|e| {
                ProviderError::RequestFailed(format!("Failed to parse JSON: {}", e))
            })?;

            let message = response_to_message(&json).map_err(|e| {
                ProviderError::RequestFailed(format!("Failed to parse message: {}", e))
            })?;

            let usage_json = json.get("usage").unwrap_or(&serde_json::Value::Null);
            let usage_data = get_usage(usage_json);
            let mut usage = ProviderUsage::new(model_config.model_name.clone(), usage_data);
            if let Some(cost) = get_cost(usage_json) {
                usage = usage.with_cost(cost, CostSource::ProviderReported);
            }

            log.write(
                &serde_json::to_value(&message).unwrap_or_default(),
                Some(&usage.usage),
            )?;

            Ok(stream_from_single_message(message, usage))
        }
    }
}

// Re-exported from the dedicated `http_status` module — these helpers are
// format-agnostic and used across all provider families.
pub use super::http_status::{
    handle_response, handle_status, map_http_error_to_provider_error, sanitize_url,
};

// Legacy alias kept for callers that haven't migrated their import path yet.
pub use super::http_status::handle_response as handle_response_openai_compat;

pub fn stream_openai_compat(
    response: Response,
    log: Option<Box<dyn RequestLogHandle>>,
) -> Result<MessageStream, ProviderError> {
    stream_openai_compat_with_deadline(
        response,
        log,
        Instant::now() + DEFAULT_STREAM_WAIT,
        DEFAULT_STREAM_WAIT,
    )
}

pub(crate) fn stream_openai_compat_with_deadline(
    response: Response,
    log: Option<Box<dyn RequestLogHandle>>,
    deadline: Instant,
    wait: Duration,
) -> Result<MessageStream, ProviderError> {
    stream_openai_compat_with_timing(response, log, StreamTiming::start(), deadline, wait)
}

fn stream_openai_compat_with_timing(
    response: Response,
    mut log: Option<Box<dyn RequestLogHandle>>,
    mut timing: Option<StreamTiming>,
    deadline: Instant,
    wait: Duration,
) -> Result<MessageStream, ProviderError> {
    let diagnostics = std::env::var("GOOSE_STREAM_DIAGNOSTICS").is_ok_and(|value| value == "1");
    if diagnostics && timing.is_none() {
        timing = StreamTiming::start();
    }
    if let Some(timing) = &timing {
        timing.record("headers", 0, 0);
    }
    let network_timing = timing.clone();
    let mut network_sequence = 0;
    let stream = response.bytes_stream().map(move |result| match result {
        Ok(bytes) => {
            network_sequence += 1;
            if let Some(timing) = &network_timing {
                timing.record("body_chunk", network_sequence, bytes.len());
            }
            Ok(bytes)
        }
        Err(error) => {
            if let Some(timing) = &network_timing {
                timing.record("body_error", network_sequence, 0);
                tracing::warn!(target: "goose::stream_timing",
                        request_id = %timing.request_id,
                        body_chunk_count = network_sequence,
                        is_timeout = error.is_timeout(), is_decode = error.is_decode(),
                        is_body = error.is_body(), is_connect = error.is_connect(),
                        "Provider response body read failed");
            }
            Err(std::io::Error::other(error))
        }
    });

    Ok(Box::pin(try_stream! {
        let mut saw_text = false;
        let mut saw_thinking = false;
        let mut saw_tool = false;
        let mut text_bytes = 0usize;
        let mut thinking_bytes = 0usize;
        let mut tool_count = 0usize;
        let stream_reader = StreamReader::new(stream);
        let diagnostic_timing = timing.clone();
        let mut line_sequence = 0u64;
        let framed = FramedRead::new(stream_reader, LinesCodec::new())
            .map_err(Error::from)
            .map(move |line| {
                if diagnostics {
                    if let (Some(timing), Ok(line)) = (&diagnostic_timing, &line) {
                        line_sequence += 1;
                        let summary = summarize_sse_line(line);
                        tracing::info!(target: "goose::stream_diagnostics",
                            request_id = %timing.request_id, at_ms = chrono::Utc::now().timestamp_millis(),
                            stage = "sse_line", line_sequence, bytes = line.len(),
                            summary = %summary, "Provider SSE shape before message parsing");
                    }
                }
                line
            });

        let message_stream = response_to_streaming_message(Box::pin(bounded_sse_lines(framed, deadline, wait)));
        pin!(message_stream);
        while let Some(message) = message_stream.next().await {
            if message.is_err() {
                if let Some(timing) = &timing {
                    timing.record("parse_or_body_error", timing.parsed_sequence, 0);
                }
            }
            let (mut message, usage) = message.map_err(|e|
                e.downcast::<ProviderError>()
                    .unwrap_or_else(ProviderError::stream_decode_error)
            )?;
            if let Some(timing) = &mut timing {
                timing.parsed_sequence += 1;
                timing.record("parsed", timing.parsed_sequence, message.as_ref().map_or(0, |message| message.content.len()));
                if let Some(message) = &mut message {
                    if diagnostics {
                        let preview_count = message.content.iter().filter(|content| {
                            matches!(content, MessageContent::SystemNotification(notification)
                                if notification.data.as_ref().and_then(|data| data.get("type"))
                                    .and_then(Value::as_str) == Some("tool_input_preview"))
                        }).count();
                        if preview_count > 0 {
                            tracing::info!(target: "goose::stream_diagnostics",
                                request_id = %timing.request_id, at_ms = chrono::Utc::now().timestamp_millis(),
                                stage = "parsed_tool_preview", parsed_sequence = timing.parsed_sequence,
                                preview_count, "Provider tool preview emitted");
                        }
                    }
                    for content in &message.content {
                        match content {
                            MessageContent::Text(text) => {
                                text_bytes += text.text.len();
                                if !saw_text && !text.text.is_empty() {
                                    timing.record("first_text", timing.parsed_sequence, text.text.len());
                                    saw_text = true;
                                }
                            }
                            MessageContent::Thinking(thinking) => {
                                thinking_bytes += thinking.thinking.len();
                                if !saw_thinking && !thinking.thinking.is_empty() {
                                    timing.record("first_thinking", timing.parsed_sequence, thinking.thinking.len());
                                    saw_thinking = true;
                                }
                            }
                            MessageContent::ToolRequest(_) => {
                                tool_count += 1;
                                if !saw_tool {
                                    timing.record("first_tool_request", timing.parsed_sequence, 1);
                                    saw_tool = true;
                                }
                            }
                            _ => {}
                        }
                    }
                    message.metadata.stream_timing = Some(timing.clone());
                }
            }
            log.write(&message, usage.as_ref().map(|f| f.usage).as_ref())?;
            yield (message, usage);
        }
        if let Some(timing) = &timing {
            timing.record("parsed_end", timing.parsed_sequence, 0);
            timing.record("text_bytes_total", timing.parsed_sequence, text_bytes);
            timing.record("thinking_bytes_total", timing.parsed_sequence, thinking_bytes);
            timing.record("tool_requests_total", timing.parsed_sequence, tool_count);
        }
    }))
}

// Observe the existing line stream without changing framing, parser decisions or
// polling. Only allowlisted shape/length metadata may leave this function.
fn summarize_sse_line(line: &str) -> Value {
    use serde_json::json;
    let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else {
        return json!({"kind": if line.is_empty() { "boundary" } else if line.starts_with(':') { "comment" } else { "other" }});
    };
    if data == "[DONE]" {
        return json!({"kind": "done"});
    }
    // Diagnostics must not amplify a large upstream frame's allocation cost.
    if data.len() > 1_048_576 {
        return json!({"kind": "size_limit", "bytes": data.len()});
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return json!({"kind": "invalid_json"});
    };
    let byte_len = |value: &Value| value.as_str().map_or(0, str::len);
    let choices = value["choices"].as_array().map(|choices| {
        choices.iter().take(16).map(|choice| {
            let delta = &choice["delta"];
            let tools = delta["tool_calls"].as_array().map(|tools| {
                tools.iter().take(128).map(|tool| json!({
                    "index": tool["index"].as_i64(),
                    "id_present": tool["id"].is_string(),
                    "name_present": tool["function"]["name"].is_string(),
                    "argument_bytes": byte_len(&tool["function"]["arguments"]),
                    "arguments_present": !tool["function"]["arguments"].is_null(),
                    "arguments_string": tool["function"]["arguments"].is_string()
                })).collect::<Vec<_>>()
            });
            json!({
                "index": choice["index"].as_i64(),
                "finish_present": !choice["finish_reason"].is_null(),
                "text_bytes": byte_len(&delta["content"]),
                "reasoning_bytes": byte_len(&delta["reasoning_content"]) + byte_len(&delta["reasoning"]),
                "reasoning_details_present": !delta["reasoning_details"].is_null(),
                "full_message_present": !choice["message"].is_null(),
                "tool_count": delta["tool_calls"].as_array().map_or(0, Vec::len),
                "tools": tools
            })
        }).collect::<Vec<_>>()
    });
    json!({"kind": "json", "choice_count": value["choices"].as_array().map_or(0, Vec::len),
        "choices": choices, "usage_present": !value["usage"].is_null(), "error_present": !value["error"].is_null()})
}

pub fn stream_responses_compat(
    response: Response,
    log: Option<Box<dyn RequestLogHandle>>,
) -> Result<MessageStream, ProviderError> {
    stream_responses_compat_with_deadline(
        response,
        log,
        Instant::now() + DEFAULT_STREAM_WAIT,
        DEFAULT_STREAM_WAIT,
    )
}

pub(crate) fn stream_responses_compat_with_deadline(
    response: Response,
    mut log: Option<Box<dyn RequestLogHandle>>,
    deadline: Instant,
    wait: Duration,
) -> Result<MessageStream, ProviderError> {
    let stream = response.bytes_stream().map_err(std::io::Error::other);

    Ok(Box::pin(try_stream! {
        let stream_reader = StreamReader::new(stream);
        let framed = FramedRead::new(stream_reader, LinesCodec::new())
            .map_err(Error::from);

        let message_stream = responses_api_to_streaming_message(Box::pin(bounded_sse_lines(framed, deadline, wait)));
        pin!(message_stream);
        while let Some(message) = message_stream.next().await {
            let (message, usage) = message.map_err(|e|
                e.downcast::<ProviderError>()
                    .unwrap_or_else(ProviderError::stream_decode_error)
            )?;
            log.write(&message, usage.as_ref().map(|f| f.usage).as_ref())?;
            yield (message, usage);
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ModelConfig;
    use serde_json::json;
    use test_case::test_case;

    #[tokio::test]
    async fn stream_wait_bounds_headers_without_reposting_for_both_openai_paths() {
        use crate::openai::OpenAiProviderBuilder;
        for model in ["test-chat", "gpt-5"] {
            let server = wiremock::MockServer::start().await;
            wiremock::Mock::given(wiremock::matchers::method("POST"))
                .respond_with(
                    wiremock::ResponseTemplate::new(200)
                        .set_delay(Duration::from_secs(2))
                        .set_body_string("data: [DONE]\n\n"),
                )
                .expect(1)
                .mount(&server)
                .await;
            let provider = OpenAiProviderBuilder::new(
                ApiClient::new_with_tls(
                    server.uri(),
                    super::super::api_client::AuthMethod::NoAuth,
                    None,
                )
                .unwrap(),
            )
            .stream_wait(Duration::from_millis(100))
            .build();
            let start = Instant::now();
            let result = provider
                .stream(&ModelConfig::new(model), "", &[], &[])
                .await;
            assert!(matches!(result, Err(ProviderError::NetworkError(_))));
            assert!(start.elapsed() < Duration::from_secs(1));
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn stream_wait_does_not_change_non_streaming_responses() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(150))
                    .set_body_json(json!({
                        "model":"test", "choices":[{"message":{"role":"assistant","content":"ok"}}],
                        "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
                    })),
            )
            .expect(1)
            .mount(&server)
            .await;
        let provider = crate::openai::OpenAiProviderBuilder::new(
            ApiClient::new_with_tls(
                server.uri(),
                super::super::api_client::AuthMethod::NoAuth,
                None,
            )
            .unwrap(),
        )
        .supports_streaming(false)
        .stream_wait(Duration::from_millis(20))
        .build();
        let mut stream = provider
            .stream(&ModelConfig::new("test"), "", &[], &[])
            .await
            .unwrap();
        assert!(stream.next().await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn stream_wait_comments_do_not_extend_first_response_deadline() {
        let lines = async_stream::stream! {
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
                yield Ok(": heartbeat".to_string());
            }
        };
        let start = Instant::now();
        let bounded = bounded_sse_lines(
            lines,
            start + Duration::from_millis(80),
            Duration::from_millis(80),
        );
        pin!(bounded);
        let mut comments = 0;
        while let Some(line) = bounded.next().await {
            match line {
                Ok(_) => comments += 1,
                Err(error) => {
                    assert!(matches!(
                        error.downcast_ref::<ProviderError>(),
                        Some(ProviderError::NetworkError(_))
                    ));
                    break;
                }
            }
        }
        assert!(comments > 0);
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn stream_wait_keeps_active_text_thinking_and_tool_argument_data() {
        let lines = async_stream::stream! {
            for data in [
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}",
                "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"arguments\":\"{}\"}}]}}]}",
                "data: [DONE]",
            ] {
                tokio::time::sleep(Duration::from_millis(40)).await;
                yield Ok(data.to_string());
            }
        };
        let start = Instant::now();
        let bounded = bounded_sse_lines(
            lines,
            start + Duration::from_millis(100),
            Duration::from_millis(100),
        );
        let events = bounded.try_collect::<Vec<_>>().await.unwrap();
        assert_eq!(events.len(), 4);
        assert!(start.elapsed() > Duration::from_millis(100));
    }

    #[tokio::test]
    async fn stream_wait_preserves_partial_output_then_propagates_stall_or_disconnect() {
        for disconnect in [false, true] {
            let lines = async_stream::stream! {
                yield Ok("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}".to_string());
                if disconnect { yield Err(Error::new(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "fixture disconnect"))); }
                else { tokio::time::sleep(Duration::from_secs(2)).await; }
            };
            let bounded = bounded_sse_lines(
                lines,
                Instant::now() + Duration::from_millis(50),
                Duration::from_millis(50),
            );
            let messages = response_to_streaming_message(Box::pin(bounded));
            pin!(messages);
            let first = messages.next().await.unwrap().unwrap();
            assert!(first.0.is_some());
            assert!(messages.next().await.unwrap().is_err());
            assert!(messages.next().await.is_none());
        }
    }

    #[tokio::test]
    async fn incomplete_http_body_preserves_partial_thinking_then_reports_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (close_sender, close_receiver) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            socket.read(&mut request).await.unwrap();
            let partial = "data: {\"id\":\"partial\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"正在检查预约冲突\"},\"finish_reason\":null}]}\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{partial}", partial.len() + 100).as_bytes()).await.unwrap();
            // Close only after the consumer actually received the partial message.
            close_receiver.await.unwrap();
            socket.shutdown().await.unwrap();
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .unwrap();
        let mut messages = stream_openai_compat_with_timing(
            response,
            None,
            Some(StreamTiming {
                request_id: "isolated-incomplete-body".into(),
                parsed_sequence: 0,
            }),
            Instant::now() + Duration::from_secs(15),
            Duration::from_secs(15),
        )
        .unwrap();
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), messages.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .0
            .unwrap();
        assert!(first.content.iter().any(|content|
            matches!(content, MessageContent::Thinking(thinking) if thinking.thinking == "正在检查预约冲突")));
        close_sender.send(()).unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_secs(5), messages.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, ProviderError::NetworkError(_)));
        assert!(messages.next().await.is_none());
        server.await.unwrap();
    }

    #[test_case(
        StatusCode::PAYMENT_REQUIRED,
        Some(json!({"error": {"message": "Insufficient credits to complete this request"}})),
        "CreditsExhausted"
        ; "402 with payload"
    )]
    #[test_case(
        StatusCode::PAYMENT_REQUIRED,
        None,
        "CreditsExhausted"
        ; "402 without payload"
    )]
    #[test_case(
        StatusCode::TOO_MANY_REQUESTS,
        Some(json!({"error": {"message": "Rate limit exceeded"}})),
        "RateLimitExceeded"
        ; "429 rate limit"
    )]
    #[test_case(
        StatusCode::UNAUTHORIZED,
        None,
        "Authentication"
        ; "401 unauthorized"
    )]
    #[test_case(
        StatusCode::BAD_REQUEST,
        Some(json!({"error": {"message": "This request exceeds the maximum context length"}})),
        "ContextLengthExceeded"
        ; "400 context length"
    )]
    #[test_case(
        StatusCode::INTERNAL_SERVER_ERROR,
        None,
        "ServerError"
        ; "500 server error"
    )]
    #[test_case(
        StatusCode::NOT_FOUND,
        None,
        "RequestFailed"
        ; "404 not found"
    )]
    #[test_case(
        StatusCode::NOT_FOUND,
        Some(json!({"error": {"message": "model not available"}})),
        "RequestFailed"
        ; "404 with error payload"
    )]
    fn http_status_maps_to_expected_error(
        status: StatusCode,
        payload: Option<Value>,
        expected_variant: &str,
    ) {
        let err = map_http_error_to_provider_error(status, payload, "http://test/endpoint");
        let actual = err.telemetry_type();
        let expected_telemetry = match expected_variant {
            "CreditsExhausted" => "credits_exhausted",
            "RateLimitExceeded" => "rate_limit",
            "Authentication" => "auth",
            "ContextLengthExceeded" => "context_length",
            "ServerError" => "server",
            "RequestFailed" => "request",
            other => panic!("Unknown variant: {other}"),
        };
        assert_eq!(
            actual, expected_telemetry,
            "Expected {expected_variant}, got error: {err:?}"
        );
    }

    #[test]
    fn build_request_respects_non_streaming_mode() {
        let provider = OpenAiCompatibleProvider::new(
            "test".to_string(),
            ApiClient::new_with_tls(
                "http://localhost".to_string(),
                super::super::api_client::AuthMethod::NoAuth,
                None,
            )
            .unwrap(),
            String::new(),
        )
        .with_supports_streaming(false);

        let model = ModelConfig::new("test-model");
        let payload = provider
            .build_request(&model, "", &[], &[], provider.supports_streaming)
            .unwrap();

        assert_eq!(payload.get("stream"), None);
        assert_eq!(payload.get("stream_options"), None);
    }

    #[tokio::test]
    async fn desktop_launch88_compatible_404_is_not_retried() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/chat/completions"))
            .respond_with(
                wiremock::ResponseTemplate::new(404)
                    .set_body_json(serde_json::json!({"error":{"message":"model not found"}})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let provider = OpenAiCompatibleProvider::new(
            "acceptance".into(),
            ApiClient::new_with_tls(
                server.uri(),
                super::super::api_client::AuthMethod::NoAuth,
                None,
            )
            .unwrap(),
            String::new(),
        );
        assert!(provider
            .stream(&ModelConfig::new("missing"), "", &[], &[])
            .await
            .is_err());
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        let config = Provider::retry_config(&provider);
        assert!(super::super::retry::should_retry(
            &ProviderError::NetworkError("temporary".into()),
            &config
        ));
        assert!(super::super::retry::should_retry(
            &ProviderError::ServerError("temporary".into()),
            &config
        ));
    }

    #[tokio::test]
    async fn credential_probe_requires_vendor_opt_in() {
        let provider = OpenAiCompatibleProvider::new(
            "unverified-compatible-provider".to_string(),
            ApiClient::new_with_tls(
                "http://127.0.0.1:1".to_string(),
                super::super::api_client::AuthMethod::NoAuth,
                None,
            )
            .unwrap(),
            String::new(),
        );

        let error = provider
            .validate_credentials()
            .await
            .expect_err("generic compatible providers must fail closed without vendor opt-in");

        assert!(matches!(error, ProviderError::NotImplemented(_)));
    }

    #[tokio::test]
    async fn empty_or_malformed_model_catalog_cannot_authenticate_vendor() {
        for body in [
            serde_json::json!({"data": []}),
            serde_json::json!({"data": [{"id": ""}, {"id": "   "}, {"name": "missing-id"}]}),
        ] {
            let server = wiremock::MockServer::start().await;
            wiremock::Mock::given(wiremock::matchers::method("GET"))
                .and(wiremock::matchers::path("/models"))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(body))
                .mount(&server)
                .await;
            let provider = OpenAiCompatibleProvider::new(
                "xai".to_string(),
                ApiClient::new_with_tls(
                    server.uri(),
                    super::super::api_client::AuthMethod::BearerToken(
                        "candidate-canary".to_string(),
                    ),
                    None,
                )
                .unwrap(),
                String::new(),
            );

            let error = provider
                .fetch_supported_models()
                .await
                .expect_err("a catalog without a usable model id must fail closed");
            let rendered = ProviderError::for_credential_probe(error).to_string();
            assert_eq!(
                rendered,
                "Request failed: Provider credential validation failed."
            );
            assert!(!rendered.contains("candidate-canary"));
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn model_catalog_trims_ids_and_preserves_every_usable_entry() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "data": [
                        {"id": " model-b "},
                        {"id": ""},
                        {"name": "missing-id"},
                        {"id": "model-a"}
                    ]
                })),
            )
            .mount(&server)
            .await;
        let provider = OpenAiCompatibleProvider::new(
            "xai".to_string(),
            ApiClient::new_with_tls(
                server.uri(),
                super::super::api_client::AuthMethod::BearerToken("candidate-canary".to_string()),
                None,
            )
            .unwrap(),
            String::new(),
        );

        let models = provider.fetch_supported_models().await.unwrap();

        assert_eq!(models, ["model-a", "model-b"]);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn credential_probe_rejects_untrusted_public_catalog_host_without_request() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [{"id": "public-model"}]})),
            )
            .mount(&server)
            .await;
        let provider = OpenAiCompatibleProvider::new(
            "xai".to_string(),
            ApiClient::new_with_tls(
                server.uri(),
                super::super::api_client::AuthMethod::BearerToken("candidate-canary".to_string()),
                None,
            )
            .unwrap(),
            String::new(),
        )
        .with_models_credential_probe_for_vendor("api.x.ai");

        let error = provider
            .validate_credentials()
            .await
            .expect_err("a public catalog on an untrusted host must not authenticate xAI");

        assert!(matches!(error, ProviderError::NotImplemented(_)));
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}
