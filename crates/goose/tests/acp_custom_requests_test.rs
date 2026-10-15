#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;

use agent_client_protocol::schema::v1::{
    ContentBlock, PromptRequest, SessionUpdate, StopReason, TextContent,
};
use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{
    run_test, send_custom, Connection, PermissionDecision, Session, SessionData, TerminalFixture,
    TestConnectionConfig,
};
use goose::acp::server::AcpProviderFactory;
use goose::agents::extension::PlatformExtensionContext;
use goose::agents::mcp_client::McpClientTrait;
use goose::agents::{ProjectMemoryClient, ToolCallContext};
use goose::providers::base::{
    stream_from_single_message, MessageStream, Provider, ProviderUsage, Usage,
};
use goose::session::SessionManager;
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use goose_test_support::{EnforceSessionId, IgnoreSessionId};
use rmcp::object;
use serial_test::serial;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common_tests::fixtures::{OpenAiFixture, OpenAiRequestMatcher};

const DEFAULT_ACP_TEST_CONFIG: &str =
    "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nGOOSE_DISABLE_KEYRING: true\n";

static ACP_CONFIG_ROOT: LazyLock<tempfile::TempDir> =
    LazyLock::new(|| tempfile::tempdir().unwrap());

fn write_acp_global_config(contents: &str) -> PathBuf {
    std::env::set_var("GOOSE_PATH_ROOT", ACP_CONFIG_ROOT.path());
    std::env::set_var("GOOSE_DISABLE_KEYRING", "1");
    let config_dir = goose::config::paths::Paths::config_dir();
    std::fs::create_dir_all(&config_dir).unwrap();
    let mut contents = contents.to_string();
    if !contents.contains("GOOSE_DISABLE_KEYRING") {
        contents.push_str("GOOSE_DISABLE_KEYRING: true\n");
    }
    std::fs::write(
        config_dir.join(goose::config::base::CONFIG_YAML_NAME),
        contents,
    )
    .unwrap();
    config_dir
}

fn lock_unmanaged_preference_env() -> impl Drop {
    env_lock::lock_env([
        ("GOOSE_AUTO_COMPACT_THRESHOLD", None::<&str>),
        ("GOOSE_MODE", None),
        ("GOOSE_THINKING_EFFORT", None),
        ("GOOSE_MAX_TURNS", None),
        ("VOICE_AUTO_SUBMIT_PHRASES", None),
        ("VOICE_DICTATION_PROVIDER", None),
        ("VOICE_DICTATION_PREFERRED_MIC", None),
    ])
}

fn project_memory_context(data_dir: &Path) -> PlatformExtensionContext {
    PlatformExtensionContext {
        extension_manager: None,
        session_manager: Arc::new(SessionManager::new(data_dir.to_path_buf())),
        session: None,
        use_login_shell_path: false,
    }
}

struct MockProvider {
    name: String,
    recommended_models: Vec<String>,
    supported_models: Vec<String>,
}

struct CompletedPromptProvider {
    name: String,
}

#[async_trait::async_trait]
impl Provider for CompletedPromptProvider {
    fn get_name(&self) -> &str {
        &self.name
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        _system: &str,
        _messages: &[goose::conversation::message::Message],
        _tools: &[rmcp::model::Tool],
    ) -> Result<MessageStream, ProviderError> {
        Ok(stream_from_single_message(
            goose::conversation::message::Message::assistant().with_text("done"),
            ProviderUsage::new(model_config.model_name.clone(), Usage::default()),
        ))
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(vec!["gpt-4o".to_string()])
    }

    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[async_trait::async_trait]
impl Provider for MockProvider {
    fn get_name(&self) -> &str {
        &self.name
    }

    async fn stream(
        &self,
        _model_config: &ModelConfig,
        _system: &str,
        _messages: &[goose::conversation::message::Message],
        _tools: &[rmcp::model::Tool],
    ) -> Result<MessageStream, ProviderError> {
        unimplemented!()
    }

    async fn fetch_recommended_models(
        &self,
        _toolshim: bool,
    ) -> Result<Vec<String>, ProviderError> {
        Ok(self.recommended_models.clone())
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(self.supported_models.clone())
    }

    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

struct ObservedProvider {
    name: String,
    supported_models: Vec<String>,
    validations: Arc<std::sync::atomic::AtomicUsize>,
    model_fetches: Arc<std::sync::atomic::AtomicUsize>,
    stream_count: Arc<std::sync::atomic::AtomicUsize>,
    stream_models: Arc<Mutex<Vec<String>>>,
}

struct RolePreflightProvider {
    name: String,
    supported_model: String,
    reject_validation: bool,
    validation_order: Arc<Mutex<Vec<String>>>,
    model_fetches: Arc<std::sync::atomic::AtomicUsize>,
    streams: Arc<std::sync::atomic::AtomicUsize>,
}

#[derive(Clone, Debug)]
struct MemoryProviderEvent {
    action: String,
    requested_tool: Option<String>,
    offered_tools: Vec<String>,
    tool_was_offered: bool,
    tool_result: Option<String>,
    auto_context_present: Option<bool>,
}

#[derive(Default)]
struct MemoryProviderState {
    events: Mutex<Vec<MemoryProviderEvent>>,
    expected_markers: Mutex<HashMap<String, String>>,
    tool_call_sequence: std::sync::atomic::AtomicUsize,
}

struct ScriptedMemoryProvider {
    state: Arc<MemoryProviderState>,
}

fn message_text(message: &goose::conversation::message::Message) -> String {
    message
        .content
        .iter()
        .filter_map(|content| content.as_text())
        .collect::<Vec<_>>()
        .join("\n")
}

fn latest_memory_directive(
    messages: &[goose::conversation::message::Message],
) -> Option<(usize, String)> {
    messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, message)| {
            if message.role != rmcp::model::Role::User {
                return None;
            }
            let text = message_text(message);
            text.contains("MEMORY_ACCEPT ").then_some((index, text))
        })
}

fn memory_directive_value<'a>(directive: &'a str, key: &str) -> Option<&'a str> {
    directive.split_whitespace().find_map(|part| {
        part.strip_prefix(key)
            .and_then(|value| value.strip_prefix('='))
    })
}

fn memory_tool_results_after(
    messages: &[goose::conversation::message::Message],
    directive_index: usize,
) -> Vec<String> {
    messages[directive_index + 1..]
        .iter()
        .flat_map(|message| message.content.iter())
        .filter_map(|content| content.as_tool_response_text())
        .collect()
}

fn offered_memory_tool(tools: &[rmcp::model::Tool], short_name: &str) -> Option<String> {
    tools.iter().find_map(|tool| {
        let name = tool.name.as_ref();
        (name == short_name || name.ends_with(&format!("__{short_name}"))).then(|| name.to_string())
    })
}

#[async_trait::async_trait]
impl Provider for ScriptedMemoryProvider {
    fn get_name(&self) -> &str {
        "openai"
    }

    async fn stream(
        &self,
        _model_config: &ModelConfig,
        system: &str,
        messages: &[goose::conversation::message::Message],
        tools: &[rmcp::model::Tool],
    ) -> Result<MessageStream, ProviderError> {
        let Some((directive_index, directive)) = latest_memory_directive(messages) else {
            return Ok(stream_from_single_message(
                goose::conversation::message::Message::assistant()
                    .with_text("MEMORY_DIRECTIVE_MISSING"),
                ProviderUsage::new("memory-contract-model".to_string(), Usage::default()),
            ));
        };
        let subject = memory_directive_value(&directive, "subject").unwrap_or("desktop_rule");
        let marker = memory_directive_value(&directive, "marker");
        let results = memory_tool_results_after(messages, directive_index);
        let offered_tools = tools
            .iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();
        let (action, short_tool, arguments) = if directive.contains("MEMORY_ACCEPT remember ") {
            if let Some(marker) = marker {
                self.state
                    .expected_markers
                    .lock()
                    .unwrap()
                    .insert(subject.to_string(), marker.to_string());
            }
            (
                "remember",
                Some("project_memory_remember"),
                object!({
                    "kind": "project_rule",
                    "subject": subject,
                    "content": format!("Acceptance marker {}", marker.unwrap_or("missing")),
                    "confidence": "high",
                    "reason": "The user explicitly requested this project memory"
                }),
            )
        } else if directive.contains("MEMORY_ACCEPT search ") {
            (
                "search",
                Some("project_memory_search"),
                object!({"query": marker.unwrap_or(subject), "kinds": [], "limit": 20}),
            )
        } else if directive.contains("MEMORY_ACCEPT clear") {
            ("clear", Some("project_memory_clear"), object!({}))
        } else if directive.contains("MEMORY_ACCEPT stats") {
            ("stats", Some("project_memory_stats"), object!({}))
        } else {
            ("auto-context", None, object!({}))
        };

        if action == "auto-context" {
            let expected = self
                .state
                .expected_markers
                .lock()
                .unwrap()
                .get(subject)
                .cloned();
            let preceding_messages = messages[..directive_index]
                .iter()
                .map(message_text)
                .collect::<Vec<_>>()
                .join("\n");
            let present = expected
                .as_deref()
                .is_some_and(|value| system.contains(value) || preceding_messages.contains(value));
            self.state.events.lock().unwrap().push(MemoryProviderEvent {
                action: action.to_string(),
                requested_tool: None,
                offered_tools,
                tool_was_offered: true,
                tool_result: None,
                auto_context_present: Some(present),
            });
            return Ok(stream_from_single_message(
                goose::conversation::message::Message::assistant().with_text(if present {
                    "MEMORY_AUTO_CONTEXT_PRESENT"
                } else {
                    "MEMORY_AUTO_CONTEXT_ABSENT"
                }),
                ProviderUsage::new("memory-contract-model".to_string(), Usage::default()),
            ));
        }

        let short_tool = short_tool.unwrap();
        let offered_tool = offered_memory_tool(tools, short_tool);
        if results.is_empty() {
            self.state.events.lock().unwrap().push(MemoryProviderEvent {
                action: action.to_string(),
                requested_tool: offered_tool.clone(),
                offered_tools,
                tool_was_offered: offered_tool.is_some(),
                tool_result: None,
                auto_context_present: None,
            });
            let message = match offered_tool {
                Some(name) => {
                    let sequence = self
                        .state
                        .tool_call_sequence
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    goose::conversation::message::Message::assistant().with_tool_request(
                        format!("memory-contract-{sequence}"),
                        Ok(rmcp::model::CallToolRequestParams::new(name).with_arguments(arguments)),
                    )
                }
                None => goose::conversation::message::Message::assistant()
                    .with_text(format!("MEMORY_TOOL_NOT_AVAILABLE:{short_tool}")),
            };
            return Ok(stream_from_single_message(
                message,
                ProviderUsage::new("memory-contract-model".to_string(), Usage::default()),
            ));
        }

        self.state.events.lock().unwrap().push(MemoryProviderEvent {
            action: action.to_string(),
            requested_tool: None,
            offered_tools,
            tool_was_offered: true,
            tool_result: results.first().cloned(),
            auto_context_present: None,
        });
        Ok(stream_from_single_message(
            goose::conversation::message::Message::assistant()
                .with_text(format!("MEMORY_{action}_DONE {}", results.join("\n"))),
            ProviderUsage::new("memory-contract-model".to_string(), Usage::default()),
        ))
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        Ok(vec!["gpt-4o".to_string()])
    }

    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

fn scripted_memory_provider_factory(state: Arc<MemoryProviderState>) -> AcpProviderFactory {
    Arc::new(move |_provider_name, _extensions, _working_dir| {
        let state = Arc::clone(&state);
        Box::pin(async move { Ok(Arc::new(ScriptedMemoryProvider { state }) as Arc<dyn Provider>) })
    })
}

#[test]
#[serial]
fn main_agent_project_memory_tools_are_real_across_sessions_and_projects() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let storage = tempfile::tempdir().unwrap();
        let workspace_a = tempfile::tempdir().unwrap();
        let workspace_b = tempfile::tempdir().unwrap();
        let state = Arc::new(MemoryProviderState::default());
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut conn = AcpServerConnection::new(
            TestConnectionConfig {
                builtins: vec!["projectmemory".to_string()],
                cwd: Some(workspace_a),
                data_root: storage.path().to_path_buf(),
                provider_factory: Some(scripted_memory_provider_factory(Arc::clone(&state))),
                current_model: "gpt-4o".to_string(),
                ..Default::default()
            },
            openai,
        )
        .await;

        let SessionData {
            session: mut first_session,
            ..
        } = conn.new_session().await.unwrap();
        let workspace_a_path = first_session.work_dir();
        let remember = first_session
            .prompt(
                "MEMORY_ACCEPT remember subject=desktop_rule marker=marker-a-90210",
                PermissionDecision::AllowOnce,
            )
            .await
            .expect("the main Agent must execute the offered remember tool");
        assert!(remember.text.contains("MEMORY_remember_DONE"));
        assert_eq!(
            remember.tool_status,
            Some(agent_client_protocol::schema::v1::ToolCallStatus::Completed)
        );

        let same_project = send_custom(
            conn.cx(),
            "session/new",
            serde_json::json!({ "cwd": workspace_a_path, "mcpServers": [] }),
        )
        .await
        .expect("a second ACP session must open on the same project");
        let same_project_id = same_project["sessionId"]
            .as_str()
            .expect("same-project session ID")
            .to_string();

        send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": same_project_id,
                "prompt": [{ "type": "text", "text": "MEMORY_ACCEPT auto-context subject=desktop_rule" }]
            }),
        )
        .await
        .expect("the second session must receive automatic project context");
        send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": same_project_id,
                "prompt": [{ "type": "text", "text": "MEMORY_ACCEPT search marker=marker-a-90210" }]
            }),
        )
        .await
        .expect("the second session must execute project memory search");

        let other_project = send_custom(
            conn.cx(),
            "session/new",
            serde_json::json!({ "cwd": workspace_b.path(), "mcpServers": [] }),
        )
        .await
        .expect("an ACP session must open on another project");
        let other_project_id = other_project["sessionId"]
            .as_str()
            .expect("other-project session ID")
            .to_string();
        send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": other_project_id,
                "prompt": [{ "type": "text", "text": "MEMORY_ACCEPT auto-context subject=desktop_rule" }]
            }),
        )
        .await
        .expect("the other project auto-context probe must complete");
        send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": other_project_id,
                "prompt": [{ "type": "text", "text": "MEMORY_ACCEPT search marker=marker-a-90210" }]
            }),
        )
        .await
        .expect("the other project search must complete with no match");

        send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": same_project_id,
                "prompt": [{ "type": "text", "text": "MEMORY_ACCEPT clear" }]
            }),
        )
        .await
        .expect("the main Agent must execute project memory clear");
        send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": same_project_id,
                "prompt": [{ "type": "text", "text": "MEMORY_ACCEPT search marker=marker-a-90210" }]
            }),
        )
        .await
        .expect("post-clear search must complete");

        let events = state.events.lock().unwrap().clone();
        let requested = events
            .iter()
            .filter_map(|event| event.requested_tool.as_deref())
            .collect::<Vec<_>>();
        let requested_tool = |short_name: &str| {
            requested
                .iter()
                .any(|name| *name == short_name || name.ends_with(&format!("__{short_name}")))
        };
        assert!(
            requested_tool("project_memory_remember"),
            "provider events: {events:#?}"
        );
        assert!(
            requested_tool("project_memory_search"),
            "provider events: {events:#?}"
        );
        assert!(
            requested_tool("project_memory_clear"),
            "provider events: {events:#?}"
        );
        assert!(
            events
                .iter()
                .filter(|event| event.requested_tool.is_some())
                .all(|event| event.tool_was_offered
                    && event
                        .requested_tool
                        .as_ref()
                        .is_some_and(|name| event.offered_tools.contains(name))),
            "provider events: {events:#?}"
        );

        let auto_context = events
            .iter()
            .filter(|event| event.action == "auto-context")
            .filter_map(|event| event.auto_context_present)
            .collect::<Vec<_>>();
        assert_eq!(auto_context, vec![true, false]);

        let searches = events
            .iter()
            .filter(|event| event.action == "search")
            .filter_map(|event| event.tool_result.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(searches.len(), 3);
        assert!(searches[0].contains("marker-a-90210"));
        assert!(searches[1].contains("\"matched_count\":0"));
        assert!(searches[2].contains("\"matched_count\":0"));
    });
}

#[async_trait::async_trait]
impl Provider for RolePreflightProvider {
    fn get_name(&self) -> &str {
        &self.name
    }

    async fn stream(
        &self,
        _model_config: &ModelConfig,
        _system: &str,
        _messages: &[goose::conversation::message::Message],
        _tools: &[rmcp::model::Tool],
    ) -> Result<MessageStream, ProviderError> {
        self.streams
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(stream_from_single_message(
            goose::conversation::message::Message::assistant()
                .with_text(r#"{"intent":"read_only","clarification":null}"#),
            ProviderUsage::new(self.supported_model.clone(), Usage::default()),
        ))
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        self.model_fetches
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(vec![self.supported_model.clone()])
    }

    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        self.validation_order
            .lock()
            .unwrap()
            .push(self.name.clone());
        if self.reject_validation {
            Err(ProviderError::Authentication(
                "injected reviewer credential rejection".to_string(),
            ))
        } else {
            Ok(())
        }
    }
}

#[async_trait::async_trait]
impl Provider for ObservedProvider {
    fn get_name(&self) -> &str {
        &self.name
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        _system: &str,
        _messages: &[goose::conversation::message::Message],
        _tools: &[rmcp::model::Tool],
    ) -> Result<MessageStream, ProviderError> {
        self.stream_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.stream_models
            .lock()
            .unwrap()
            .push(model_config.model_name.clone());
        Ok(stream_from_single_message(
            goose::conversation::message::Message::assistant()
                .with_text(r#"{"intent":"read_only","clarification":null}"#),
            ProviderUsage::new("private-dynamic-model".to_string(), Usage::default()),
        ))
    }

    async fn fetch_supported_models(&self) -> Result<Vec<String>, ProviderError> {
        self.model_fetches
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self.supported_models.clone())
    }

    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        self.validations
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

fn deterministic_provider_factory() -> AcpProviderFactory {
    Arc::new(|provider_name, _extensions, _working_dir| {
        Box::pin(async move {
            Ok(Arc::new(MockProvider {
                name: provider_name,
                recommended_models: vec!["claude-sonnet-4-5".to_string()],
                supported_models: vec!["claude-sonnet-4-5".to_string()],
            }) as Arc<dyn Provider>)
        })
    })
}

fn codepro_routing_payload(model_id: &str) -> serde_json::Value {
    serde_json::json!({
        "version": 2,
        "advancedRoutingEnabled": true,
        "routes": [
            { "role": "planner", "providerId": " openai ", "modelId": format!(" {model_id} ") },
            { "role": "coder", "providerId": "openai", "modelId": model_id },
            { "role": "tester", "providerId": "openai", "modelId": model_id },
            { "role": "reviewer", "providerId": "openai", "modelId": model_id }
        ],
        "visionRoute": {
            "enabled": true,
            "mode": "auto"
        },
        "maxParallelCoders": 2
    })
}

fn failing_anthropic_provider_factory() -> AcpProviderFactory {
    Arc::new(|provider_name, _extensions, _working_dir| {
        Box::pin(async move {
            if provider_name == "anthropic" {
                anyhow::bail!("injected provider construction failure");
            }
            Ok(Arc::new(MockProvider {
                name: provider_name,
                recommended_models: vec!["gpt-4o".to_string()],
                supported_models: vec!["gpt-4o".to_string()],
            }) as Arc<dyn Provider>)
        })
    })
}

fn active_run_id_from_update(update: &SessionUpdate) -> Option<String> {
    let SessionUpdate::SessionInfoUpdate(info) = update else {
        return None;
    };
    info.meta
        .as_ref()?
        .get("goose")?
        .get("activeRunId")?
        .as_str()
        .map(ToString::to_string)
}

fn queued_steer_message_ids(updates: &[SessionUpdate]) -> Vec<String> {
    updates
        .iter()
        .filter_map(|update| {
            let SessionUpdate::SessionInfoUpdate(info) = update else {
                return None;
            };
            info.meta
                .as_ref()?
                .get("goose")?
                .get("queuedSteer")?
                .get("messageId")?
                .as_str()
                .map(ToString::to_string)
        })
        .collect()
}

fn steer_chunk_message_ids(updates: &[SessionUpdate]) -> Vec<String> {
    updates
        .iter()
        .filter_map(|update| {
            let SessionUpdate::UserMessageChunk(chunk) = update else {
                return None;
            };
            let goose = chunk.meta.as_ref()?.get("goose")?;
            goose.get("steer")?.as_bool().filter(|b| *b)?;
            goose.get("messageId")?.as_str().map(ToString::to_string)
        })
        .collect()
}

fn steer_chunk_texts(updates: &[SessionUpdate]) -> Vec<String> {
    updates
        .iter()
        .filter_map(|update| {
            // A steered message is a user message injected mid-run, so it must
            // arrive as a UserMessageChunk (matching the replay path), never an
            // AgentMessageChunk.
            let SessionUpdate::UserMessageChunk(chunk) = update else {
                return None;
            };
            let ContentBlock::Text(text) = &chunk.content else {
                return None;
            };
            let is_steer = chunk
                .meta
                .as_ref()
                .and_then(|m| m.get("goose"))
                .and_then(|g| g.get("steer"))
                .and_then(|s| s.as_bool())
                .unwrap_or(false);
            is_steer.then(|| text.text.clone())
        })
        .collect()
}

fn collect_agent_text(updates: &[SessionUpdate]) -> String {
    updates
        .iter()
        .filter_map(|update| match update {
            SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
                ContentBlock::Text(text) => Some(text.text.as_str()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

#[test]
#[serial]
fn test_custom_get_tools() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.clone();

        let result = send_custom(
            conn.cx(),
            "_goose/unstable/tools/list",
            serde_json::json!({ "sessionId": session_id }),
        )
        .await;
        assert!(result.is_ok(), "expected ok, got: {:?}", result);

        let response = result.unwrap();
        let tools = response.get("tools").expect("missing 'tools' field");
        assert!(tools.is_array(), "tools should be array");
    });
}

#[test]
#[serial]
fn test_custom_codepro_memory_list_is_scoped_and_versioned() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let workspace = tempfile::tempdir().unwrap();
    let other_workspace = tempfile::tempdir().unwrap();
    let working_dir = workspace.path().to_string_lossy().to_string();
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;
        let data_root = conn.data_root();
        let memory_root = data_root.join("memory");
        let memory =
            ProjectMemoryClient::new_with_root(project_memory_context(&data_root), &memory_root)
                .unwrap();
        let tool_context = ToolCallContext::new(
            "memory-acp-test".to_string(),
            Some(workspace.path().to_path_buf()),
            None,
        );
        let remembered = memory
            .call_tool(
                &tool_context,
                "project_memory_remember",
                Some(object!({
                    "kind": "project_rule",
                    "subject": "validation_order",
                    "content": "Run focused tests before full gates",
                    "confidence": "high",
                    "reason": "The user explicitly set the project validation order"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(remembered.is_error, Some(false));
        let remembered_json: serde_json::Value = match &remembered.content[0].raw {
            rmcp::model::RawContent::Text(text) => serde_json::from_str(&text.text).unwrap(),
            _ => panic!("expected text memory result"),
        };
        let memory_id = remembered_json["entry"]["id"].as_str().unwrap().to_string();

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/list",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "includeExpired": false
            }),
        )
        .await
        .expect("memory list should succeed for an existing workspace");
        assert_eq!(response.get("schemaVersion"), Some(&serde_json::json!(1)));
        assert_eq!(response["records"][0]["id"], memory_id);
        assert_eq!(response["records"][0]["subject"], "validation_order");
        assert_eq!(response["records"][0]["expired"], false);
        assert_eq!(response["records"][0]["recallable"], true);
        assert_eq!(response["totalRecords"], 1);
        assert!(response["usageBytes"]
            .as_u64()
            .is_some_and(|value| value > 0));
        assert_eq!(response["softLimitBytes"], 0);
        assert_eq!(response["hardLimitBytes"], 0);
        assert!(response["nextCursor"].is_null());
        assert!(response
            .get("projectIdentity")
            .and_then(|value| value.as_str())
            .is_some_and(|value| value.len() == 32));

        let other_project = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/list",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": other_workspace.path(),
                "includeExpired": false
            }),
        )
        .await
        .expect("memory list should succeed for another workspace");
        assert_eq!(other_project["records"], serde_json::json!([]));

        let updated = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/update",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": memory_id,
                "content": "Run memory tests before full gates",
                "reason": "The user corrected the project validation order"
            }),
        )
        .await
        .expect("memory update should succeed");
        assert_eq!(
            updated["record"]["content"],
            "Run memory tests before full gates"
        );

        let exported = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/export",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "includeExpired": false
            }),
        )
        .await
        .expect("memory export should succeed");
        let exported_json: serde_json::Value =
            serde_json::from_str(exported["json"].as_str().unwrap()).unwrap();
        assert_eq!(exported_json["records"][0]["id"], memory_id);
        assert_eq!(exported_json["records"][0]["subject"], "validation_order");

        let memory_path = ProjectMemoryClient::memory_path(&memory_root, workspace.path()).unwrap();
        let mut stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&memory_path).unwrap()).unwrap();
        stored["entries"][0]["expires_at"] = "2000-01-01T00:00:00Z".into();
        std::fs::write(&memory_path, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();

        let expired = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/list",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "includeExpired": true
            }),
        )
        .await
        .expect("expired memory should remain inspectable");
        assert_eq!(expired["records"][0]["expired"], true);
        assert_eq!(expired["records"][0]["recallable"], false);

        let active_only = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/list",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "includeExpired": false
            }),
        )
        .await
        .expect("active-only memory list should succeed");
        assert_eq!(active_only["records"], serde_json::json!([]));

        let deleted = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/delete",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": memory_id
            }),
        )
        .await
        .expect("memory delete should succeed");
        assert_eq!(deleted["removed"], true);

        let unsupported = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/list",
            serde_json::json!({
                "schemaVersion": 2,
                "workingDir": workspace.path(),
                "includeExpired": false
            }),
        )
        .await;
        assert!(unsupported.is_err(), "unsupported memory schema must fail");

        let oversized_page = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/list",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": workspace.path(),
                "includeExpired": false,
                "pageSize": 51
            }),
        )
        .await;
        assert!(
            oversized_page.is_err(),
            "memory page size above the bounded maximum must fail"
        );
    });
}

#[test]
#[serial]
fn test_custom_codepro_memory_review_is_content_and_version_bound() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let workspace = tempfile::tempdir().unwrap();
    let working_dir = workspace.path().to_string_lossy().to_string();
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;
        let data_root = conn.data_root();
        let memory_root = data_root.join("memory");
        let user_memory_dir = memory_root.join("user");
        std::fs::create_dir_all(&user_memory_dir).unwrap();
        let candidate_id = "00000000-0000-4000-8000-000000000071";
        std::fs::write(
            user_memory_dir.join("memory.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema_version": "2.0",
                "project_identity": "user",
                "entries": [{
                    "id": candidate_id,
                    "kind": "preference",
                    "subject": "response.style",
                    "content": "Keep answers compact",
                    "scope": "user",
                    "source": "user_inferred",
                    "status": "candidate",
                    "reason": "Learned from repeated requests",
                    "confidence": "medium",
                    "created_at": "2026-09-12T00:00:00.000000000Z",
                    "updated_at": "2026-09-12T00:00:01.000000000Z",
                    "last_verified_at": null,
                    "expires_at": null
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let memory =
            ProjectMemoryClient::new_with_root(project_memory_context(&data_root), &memory_root)
                .unwrap();
        let project_context = ToolCallContext::new(
            "memory-review-project-record".to_string(),
            Some(workspace.path().to_path_buf()),
            None,
        );
        let project_record = memory
            .call_tool(
                &project_context,
                "project_memory_remember",
                Some(object!({
                    "kind": "project_rule",
                    "subject": "test.order",
                    "content": "Run focused tests first",
                    "confidence": "high",
                    "reason": "The user requested this project rule"
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let project_record: serde_json::Value = match &project_record.content[0].raw {
            rmcp::model::RawContent::Text(text) => serde_json::from_str(&text.text).unwrap(),
            _ => panic!("expected text memory result"),
        };
        let project_id = project_record["entry"]["id"].as_str().unwrap();

        let listed = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/list",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "includeExpired": false
            }),
        )
        .await
        .expect("memory list should include the user candidate");
        let candidate = listed["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record["id"] == candidate_id)
            .unwrap();
        assert_eq!(candidate["status"], "candidate");
        assert_eq!(candidate["recallable"], false);
        let fingerprint = candidate["reviewFingerprint"].as_str().unwrap().to_string();
        assert_eq!(fingerprint.len(), 64);
        let expected_updated_at = candidate["updatedAt"].as_str().unwrap().to_string();
        assert_eq!(expected_updated_at, "2026-09-12T00:00:01.000000000Z");

        let exact = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/get",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id
            }),
        )
        .await
        .expect("exact user preference readback should succeed");
        assert_eq!(exact["record"]["id"], candidate_id);
        assert_eq!(exact["record"]["reviewFingerprint"], fingerprint);

        let project_lookup = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/get",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": project_id
            }),
        )
        .await
        .expect("exact user-store lookup should not scan project records");
        assert!(project_lookup["record"].is_null());

        let action_id = "00000000-0000-4000-8000-000000000072";
        let status_request = serde_json::json!({
            "schemaVersion": 1,
            "workingDir": working_dir,
            "id": candidate_id,
            "targetStatus": "active",
            "expectedStatus": "candidate",
            "expectedUpdatedAt": expected_updated_at,
            "reviewFingerprint": fingerprint,
            "actionId": action_id
        });
        let approved = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/status",
            status_request.clone(),
        )
        .await
        .expect("candidate approval should succeed");
        assert_eq!(approved["actionId"], action_id);
        assert_eq!(approved["changed"], true);
        assert_eq!(approved["record"]["status"], "active");
        assert_eq!(approved["record"]["recallable"], true);
        assert_eq!(approved["record"]["reviewFingerprint"], fingerprint);
        let approved_updated_at = approved["record"]["updatedAt"].as_str().unwrap();
        assert_ne!(approved_updated_at, expected_updated_at);

        let stale = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/status",
            status_request,
        )
        .await;
        assert!(
            stale.is_err(),
            "a stale approval snapshot must not be retried blindly"
        );

        let idempotent = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/status",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id,
                "targetStatus": "active",
                "expectedStatus": "active",
                "expectedUpdatedAt": approved_updated_at,
                "reviewFingerprint": fingerprint,
                "actionId": "00000000-0000-4000-8000-000000000073"
            }),
        )
        .await
        .expect("a fresh idempotent status request should succeed");
        assert_eq!(idempotent["changed"], false);
        assert_eq!(idempotent["record"]["updatedAt"], approved_updated_at);

        let backup_blocker = user_memory_dir.join("memory.json.bak");
        std::fs::create_dir(&backup_blocker).unwrap();
        let unknown_commit = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/status",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id,
                "targetStatus": "disabled",
                "expectedStatus": "active",
                "expectedUpdatedAt": approved_updated_at,
                "reviewFingerprint": fingerprint,
                "actionId": "00000000-0000-4000-8000-000000000077"
            }),
        )
        .await
        .expect_err("a post-mutation persistence failure must report an unknown commit");
        assert_eq!(
            unknown_commit.data.as_ref().unwrap()["code"],
            "memory_review_unknown_commit"
        );
        std::fs::remove_dir(&backup_blocker).unwrap();

        let unchanged_after_unknown = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/get",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id
            }),
        )
        .await
        .expect("the exact record must remain readable after an unknown response");
        assert_eq!(unchanged_after_unknown["record"]["status"], "active");
        assert_eq!(
            unchanged_after_unknown["record"]["updatedAt"],
            approved_updated_at
        );

        let stale_content = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/status",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id,
                "targetStatus": "disabled",
                "expectedStatus": "active",
                "expectedUpdatedAt": approved_updated_at,
                "reviewFingerprint": "0".repeat(64),
                "actionId": "00000000-0000-4000-8000-000000000074"
            }),
        )
        .await;
        assert!(
            stale_content.is_err(),
            "a stale semantic fingerprint must fail"
        );

        for invalid in [
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id,
                "targetStatus": "candidate",
                "expectedStatus": "active",
                "expectedUpdatedAt": approved_updated_at,
                "reviewFingerprint": fingerprint,
                "actionId": "00000000-0000-4000-8000-000000000075"
            }),
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id,
                "targetStatus": "disabled",
                "expectedStatus": "active",
                "expectedUpdatedAt": approved_updated_at,
                "reviewFingerprint": fingerprint,
                "actionId": "00000000-0000-4000-8000-000000000076",
                "source": "user_explicit"
            }),
        ] {
            assert!(
                send_custom(conn.cx(), "_goose/unstable/codepro/memory/status", invalid)
                    .await
                    .is_err(),
                "invalid review contracts must be rejected"
            );
        }

        std::fs::remove_dir_all(&user_memory_dir).unwrap();
        std::fs::write(&user_memory_dir, "not a directory").unwrap();
        let internal = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/memory/status",
            serde_json::json!({
                "schemaVersion": 1,
                "workingDir": working_dir,
                "id": candidate_id,
                "targetStatus": "disabled",
                "expectedStatus": "active",
                "expectedUpdatedAt": approved_updated_at,
                "reviewFingerprint": fingerprint,
                "actionId": "00000000-0000-4000-8000-000000000078"
            }),
        )
        .await
        .expect_err("a storage failure before mutation must be internal, not a conflict");
        assert_eq!(
            internal.data.as_ref().unwrap()["code"],
            "memory_review_internal"
        );
    });
}

#[test]
#[serial]
fn test_custom_get_extensions() {
    let config_key = "test-stdio-acp-mutation-flow";
    let updated_config_key = "test-stdio-acp-mutation-flow-updated";
    let _guard = env_lock::lock_env([("EXTENSIONS", None::<&str>)]);
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let test_result = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/test",
            serde_json::json!({
                "environment": {},
                "extension": {
                    "type": "mcp",
                    "server": {
                        "type": "stdio",
                        "name": "test-only-missing-command",
                        "command": "codebuddy-command-that-does-not-exist",
                        "args": [],
                        "env": []
                    }
                }
            }),
        )
        .await
        .expect("test request should be dispatched as a structured response");
        assert_eq!(test_result["success"], false);
        assert!(test_result["error"]
            .as_str()
            .is_some_and(|error| !error.contains("Method not found")));

        let add_result = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/add",
            serde_json::json!({
                "enabled": true,
                "extension": {
                    "type": "mcp",
                    "description": "Test stdio",
                    "envKeys": ["SECRET_TOKEN"],
                    "timeout": 42,
                    "server": {
                        "type": "stdio",
                        "name": config_key,
                        "command": "test-command",
                        "args": ["--flag", "value"],
                        "env": [
                            { "name": "INLINE_TOKEN", "value": "inline-secret" }
                        ]
                    }
                }
            }),
        )
        .await;
        assert!(add_result.is_ok(), "expected ok, got: {:?}", add_result);
        let stored_inline_token = goose::config::Config::global()
            .get_secret::<String>("INLINE_TOKEN")
            .expect("inline env should be saved as a secret");
        assert!(
            stored_inline_token == "inline-secret",
            "inline env secret was not saved correctly"
        );

        let list_extension = || async {
            let result = send_custom(
                conn.cx(),
                "_goose/unstable/config/extensions/list",
                serde_json::json!({}),
            )
            .await;
            assert!(result.is_ok(), "expected ok, got: {:?}", result);

            let response = result.unwrap();
            let extensions = response
                .get("extensions")
                .and_then(|extensions| extensions.as_array())
                .expect("extensions should be an array");
            extensions
                .iter()
                .find(|entry| entry["configKey"] == config_key)
                .cloned()
        };

        let entry = list_extension()
            .await
            .unwrap_or_else(|| panic!("missing added extension entry"));
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["configKey"], config_key);

        let extension = &entry["extension"];
        assert_eq!(extension["type"], "mcp");
        assert_eq!(
            extension["envKeys"],
            serde_json::json!(["SECRET_TOKEN", "INLINE_TOKEN"])
        );
        assert_eq!(extension["description"], "Test stdio");
        assert_eq!(extension["timeout"], 42);
        assert!(extension.get("socket").is_none());

        let server = &extension["server"];
        assert_eq!(server["name"], config_key);
        assert_eq!(server["command"], "test-command");
        assert_eq!(server["args"], serde_json::json!(["--flag", "value"]));
        assert_eq!(server["env"], serde_json::json!([]));

        let set_enabled_result = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/set-enabled",
            serde_json::json!({
                "configKey": config_key,
                "enabled": false,
            }),
        )
        .await;
        assert!(
            set_enabled_result.is_ok(),
            "expected ok, got: {:?}",
            set_enabled_result
        );

        let entry = list_extension()
            .await
            .unwrap_or_else(|| panic!("missing disabled extension entry"));
        assert_eq!(entry["enabled"], false);

        let update_result = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/update",
            serde_json::json!({
                "configKey": config_key,
                "enabled": true,
                "extension": {
                    "type": "mcp",
                    "description": "Updated stdio",
                    "envKeys": [],
                    "server": {
                        "type": "stdio",
                        "name": updated_config_key,
                        "command": "updated-command",
                        "args": [],
                        "env": []
                    }
                }
            }),
        )
        .await;
        assert!(
            update_result.is_ok(),
            "expected ok, got: {:?}",
            update_result
        );

        let listed = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/list",
            serde_json::json!({}),
        )
        .await
        .expect("updated extension list should load");
        let entries = listed["extensions"]
            .as_array()
            .expect("extensions should be an array");
        assert!(entries.iter().all(|entry| entry["configKey"] != config_key));
        let updated_entry = entries
            .iter()
            .find(|entry| entry["configKey"] == updated_config_key)
            .expect("updated extension should replace the old key");
        assert_eq!(updated_entry["enabled"], true);
        assert_eq!(updated_entry["extension"]["description"], "Updated stdio");

        let missing_update = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/update",
            serde_json::json!({
                "configKey": "missing-extension",
                "enabled": false,
                "extension": {
                    "type": "mcp",
                    "server": {
                        "type": "stdio",
                        "name": "must-not-be-created",
                        "command": "unused",
                        "args": [],
                        "env": []
                    }
                }
            }),
        )
        .await;
        assert!(missing_update.is_err(), "missing source key must fail");
        let listed = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/list",
            serde_json::json!({}),
        )
        .await
        .expect("extension list should remain readable after a rejected update");
        assert!(listed["extensions"]
            .as_array()
            .expect("extensions should be an array")
            .iter()
            .all(|entry| entry["configKey"] != "must-not-be-created"));

        let remove_result = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/remove",
            serde_json::json!({
                "configKey": updated_config_key,
            }),
        )
        .await;
        assert!(
            remove_result.is_ok(),
            "expected ok, got: {:?}",
            remove_result
        );

        let listed = send_custom(
            conn.cx(),
            "_goose/unstable/config/extensions/list",
            serde_json::json!({}),
        )
        .await
        .expect("extension list should load after removal");
        assert!(listed["extensions"]
            .as_array()
            .expect("extensions should be an array")
            .iter()
            .all(|entry| entry["configKey"] != updated_config_key));
    });
}

#[test]
#[serial]
fn test_custom_session_extensions_add_list_remove() {
    let extension_name = "summarize";
    let _guard = env_lock::lock_env([("EXTENSIONS", None::<&str>)]);
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.clone();

        let list_extension = || async {
            let result = send_custom(
                conn.cx(),
                "_goose/unstable/session/extensions/list",
                serde_json::json!({ "sessionId": session_id.clone() }),
            )
            .await;
            assert!(result.is_ok(), "expected ok, got: {:?}", result);

            let response = result.unwrap();
            let extensions = response
                .get("extensions")
                .and_then(|extensions| extensions.as_array())
                .expect("extensions should be an array");
            extensions
                .iter()
                .find(|extension| extension["name"] == extension_name)
                .cloned()
        };

        assert!(
            list_extension().await.is_none(),
            "{extension_name} should not be enabled before add"
        );

        let add_result = send_custom(
            conn.cx(),
            "_goose/unstable/session/extensions/add",
            serde_json::json!({
                "sessionId": session_id.clone(),
                "extension": {
                    "type": "platform",
                    "name": extension_name,
                    "description": "Load files/directories and get an LLM summary in a single call",
                    "displayName": "Summarize",
                    "bundled": true
                }
            }),
        )
        .await;
        assert!(add_result.is_ok(), "expected ok, got: {:?}", add_result);

        let extension = list_extension()
            .await
            .unwrap_or_else(|| panic!("missing added session extension"));
        assert_eq!(extension["type"], "platform");
        assert_eq!(extension["name"], extension_name);

        let remove_result = send_custom(
            conn.cx(),
            "_goose/unstable/session/extensions/remove",
            serde_json::json!({
                "sessionId": session_id.clone(),
                "name": extension_name,
            }),
        )
        .await;
        assert!(
            remove_result.is_ok(),
            "expected ok, got: {:?}",
            remove_result
        );

        assert!(
            list_extension().await.is_none(),
            "removed session extension should not be listed"
        );
    });
}

#[test]
#[serial]
fn test_custom_get_available_extensions() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let result = send_custom(
            conn.cx(),
            "_goose/unstable/extensions/available",
            serde_json::json!({}),
        )
        .await;
        assert!(result.is_ok(), "expected ok, got: {:?}", result);

        let response = result.unwrap();
        let extensions = response
            .get("extensions")
            .and_then(|extensions| extensions.as_array())
            .expect("extensions should be an array");
        assert!(!extensions.is_empty(), "extensions should not be empty");
        assert!(
            extensions.iter().all(|extension| matches!(
                extension["type"].as_str(),
                Some("builtin" | "platform")
            )),
            "available extensions should only include builtin and platform entries"
        );
        assert!(
            extensions.iter().any(|extension| {
                extension["type"] == "platform" && extension["name"] == "developer"
            }),
            "developer platform extension should be available"
        );
        assert!(
            !extensions.iter().any(|extension| {
                extension["type"] == "platform" && extension["name"] == "orchestrator"
            }),
            "hidden orchestrator platform extension should not be available"
        );
    });
}

#[test]
#[serial]
fn test_custom_prompt_methods() {
    let _guard = env_lock::lock_env([("EXTENSIONS", None::<&str>)]);
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let list_response = send_custom(
            conn.cx(),
            "_goose/unstable/config/prompts/list",
            serde_json::json!({}),
        )
        .await
        .expect("list prompts should succeed");
        let prompts = list_response["prompts"]
            .as_array()
            .expect("prompts should be an array");
        assert!(
            prompts.iter().any(|prompt| prompt["name"] == "system.md"),
            "system.md should be listed"
        );

        let get_response = send_custom(
            conn.cx(),
            "_goose/unstable/config/prompts/get",
            serde_json::json!({ "name": "system.md" }),
        )
        .await
        .expect("get prompt should succeed");
        assert_eq!(get_response["name"], "system.md");
        assert!(get_response["content"]
            .as_str()
            .is_some_and(|s| !s.is_empty()));
        assert_eq!(get_response["isCustomized"], false);

        let content = "custom acp system prompt";
        let save_response = send_custom(
            conn.cx(),
            "_goose/unstable/config/prompts/save",
            serde_json::json!({ "name": "system.md", "content": content }),
        )
        .await
        .expect("save prompt should succeed");
        assert_eq!(save_response["message"], "Saved prompt: system.md");

        let get_response = send_custom(
            conn.cx(),
            "_goose/unstable/config/prompts/get",
            serde_json::json!({ "name": "system.md" }),
        )
        .await
        .expect("get saved prompt should succeed");
        assert_eq!(get_response["content"], content);
        assert_eq!(get_response["isCustomized"], true);

        let reset_response = send_custom(
            conn.cx(),
            "_goose/unstable/config/prompts/reset",
            serde_json::json!({ "name": "system.md" }),
        )
        .await
        .expect("reset prompt should succeed");
        assert_eq!(
            reset_response["message"],
            "Reset prompt to default: system.md"
        );

        let get_response = send_custom(
            conn.cx(),
            "_goose/unstable/config/prompts/get",
            serde_json::json!({ "name": "system.md" }),
        )
        .await
        .expect("get reset prompt should succeed");
        assert_eq!(get_response["isCustomized"], false);
        assert_ne!(get_response["content"], content);

        let missing = send_custom(
            conn.cx(),
            "_goose/unstable/config/prompts/get",
            serde_json::json!({ "name": "missing.md" }),
        )
        .await
        .expect_err("unknown prompt should fail");
        assert_eq!(
            missing.code,
            agent_client_protocol::ErrorCode::InvalidParams
        );
    });
}

#[test]
#[serial]
fn test_steer_session_adds_input_to_active_prompt() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        // Two-turn exchange: the first turn ends the turn with plain text. A
        // steer queued before the turn ends keeps the loop alive (it flips
        // `exit_chat` back to false), so a second provider request fires whose
        // body must now contain the steered text.
        let openai = OpenAiFixture::new(
            vec![
                (
                    "start work".to_string(),
                    include_str!("acp_test_data/openai_steer_first.txt"),
                ),
                (
                    "steer while active".to_string(),
                    include_str!("acp_test_data/openai_steer_second.txt"),
                ),
            ],
            Arc::new(IgnoreSessionId),
        )
        .await;
        let mut conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.to_string();
        let acp_session_id = session.session_id().clone();

        let mut prompt = Box::pin(
            conn.cx()
                .send_request(PromptRequest::new(
                    acp_session_id,
                    vec![ContentBlock::Text(TextContent::new("start work"))],
                ))
                .block_task(),
        );
        let mut steer_sent = false;
        let mut steer_message_id: Option<String> = None;
        let mut final_response = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);

        while tokio::time::Instant::now() < deadline {
            tokio::select! {
                response = &mut prompt => {
                    final_response = Some(response.unwrap());
                    break;
                }
                _ = tokio::time::sleep(Duration::from_millis(10)), if !steer_sent => {
                    let updates = session.session_updates();
                    if let Some(run_id) = updates.iter().find_map(active_run_id_from_update) {
                        let response = send_custom(
                            conn.cx(),
                            "_goose/unstable/session/steer",
                            serde_json::json!({
                                "sessionId": session_id,
                                "expectedRunId": run_id,
                                "prompt": [
                                    { "type": "text", "text": "steer while active" }
                                ]
                            }),
                        )
                        .await
                        .unwrap();
                        assert_eq!(response["runId"], run_id);
                        let mid = response["messageId"].as_str();
                        assert!(
                            mid.is_some_and(|id| !id.is_empty()),
                            "steer response must return a messageId for correlation, got: {response:?}"
                        );
                        steer_message_id = mid.map(ToString::to_string);
                        steer_sent = true;
                    }
                }
            }
        }

        let response = final_response.expect("prompt did not complete");
        assert_eq!(response.stop_reason, StopReason::EndTurn);
        assert!(steer_sent, "test never observed an active run id");

        let updates = session.session_updates();
        let agent_text = collect_agent_text(&updates);
        assert!(
            agent_text.contains("saw steer"),
            "expected provider to receive steered input, got: {agent_text:?}"
        );

        // The echoed steer prompt must be marked structurally so the client
        // can locate the boundary without matching user-visible text.
        let steer_chunks = steer_chunk_texts(&updates);
        assert!(
            steer_chunks
                .iter()
                .any(|t| t.contains("steer while active")),
            "expected a chunk marked _meta.goose.steer with the steer text, got: {steer_chunks:?}"
        );

        // The queued steer must be announced (so a UI can show it as pending)
        // and carry the same messageId returned by the steer response and later
        // stamped on the picked-up UserMessageChunk.
        let steer_message_id = steer_message_id.expect("steer response had no messageId");
        let queued_ids = queued_steer_message_ids(&updates);
        assert!(
            queued_ids.contains(&steer_message_id),
            "expected a queuedSteer SessionInfoUpdate with messageId {steer_message_id:?}, got: {queued_ids:?}"
        );
        let picked_up_ids = steer_chunk_message_ids(&updates);
        assert!(
            picked_up_ids.contains(&steer_message_id),
            "picked-up steer chunk must carry the queued messageId {steer_message_id:?} for correlation, got: {picked_up_ids:?}"
        );
    });
}

#[test]
#[serial]
fn test_custom_list_builtin_skill_sources_excludes_retired_guide() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/sources/list",
            serde_json::json!({ "type": "builtinSkill" }),
        )
        .await
        .expect("builtin skill sources list should succeed");
        let sources = response
            .get("sources")
            .and_then(|value| value.as_array())
            .expect("missing sources array");
        assert!(!sources
            .iter()
            .any(|source| source.get("name") == Some(&serde_json::json!("goose-doc-guide"))));
    });
}

#[test]
#[serial]
fn test_custom_provider_inventory_includes_metadata() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/providers/list",
            serde_json::json!({}),
        )
        .await
        .expect("provider inventory should succeed");
        let providers = response
            .get("entries")
            .and_then(|value| value.as_array())
            .expect("missing entries array");
        let openai = providers
            .iter()
            .find(|provider| provider.get("providerId") == Some(&serde_json::json!("openai")))
            .expect("expected openai inventory entry");

        assert!(openai.get("providerName").is_some(), "missing providerName");
        assert!(openai.get("description").is_some(), "missing description");
        assert!(openai.get("defaultModel").is_some(), "missing defaultModel");
        assert!(openai.get("providerType").is_some(), "missing providerType");
        assert!(openai.get("configKeys").is_some(), "missing configKeys");
        assert!(openai.get("setupSteps").is_some(), "missing setupSteps");
    });
}

#[test]
#[serial]
fn test_custom_preferences_read_save_remove() {
    let _env = lock_unmanaged_preference_env();
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nGOOSE_AUTO_COMPACT_THRESHOLD: 0.7\nGOOSE_THINKING_EFFORT: high\nVOICE_AUTO_SUBMIT_PHRASES: send it\n",
    );

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let config = TestConnectionConfig {
            data_root: config_dir,
            ..Default::default()
        };
        let conn = AcpServerConnection::new(config, openai).await;

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({
                "keys": [
                    "autoCompactThreshold",
                    "gooseThinkingEffort",
                    "personalizedMemoryEnabled",
                    "voiceAutoSubmitPhrases",
                    "voiceDictationPreferredMic"
                ],
            }),
        )
        .await
        .expect("preferences read should succeed");
        assert_eq!(response.get("revision"), Some(&serde_json::json!(0)));
        assert_eq!(
            response.get("values"),
            Some(&serde_json::json!([
                { "key": "autoCompactThreshold", "value": 0.7, "isMutable": true },
                { "key": "gooseThinkingEffort", "value": "high", "isMutable": true },
                { "key": "personalizedMemoryEnabled", "value": null, "isMutable": true },
                { "key": "voiceAutoSubmitPhrases", "value": "send it", "isMutable": true },
                { "key": "voiceDictationPreferredMic", "value": null, "isMutable": true },
            ]))
        );

        send_custom(
            conn.cx(),
            "_goose/unstable/preferences/save",
            serde_json::json!({
                "expectedRevision": 0,
                "values": [
                    { "key": "gooseThinkingEffort", "value": "disabled" },
                    { "key": "gooseMaxTurns", "value": 250 },
                    { "key": "personalizedMemoryEnabled", "value": true },
                    { "key": "voiceDictationProvider", "value": "__disabled__" },
                    { "key": "voiceDictationPreferredMic", "value": "mic-1" }
                ],
            }),
        )
        .await
        .expect("preferences save should succeed");

        send_custom(
            conn.cx(),
            "_goose/unstable/preferences/remove",
            serde_json::json!({
                "expectedRevision": 1,
                "keys": ["voiceDictationProvider"],
            }),
        )
        .await
        .expect("preferences remove should succeed");

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({
                "keys": ["gooseThinkingEffort", "gooseMaxTurns", "personalizedMemoryEnabled", "voiceDictationProvider", "voiceDictationPreferredMic"],
            }),
        )
        .await
        .expect("preferences read after remove should succeed");
        assert_eq!(response.get("revision"), Some(&serde_json::json!(2)));
        assert_eq!(
            response.get("values"),
            Some(&serde_json::json!([
                { "key": "gooseThinkingEffort", "value": "off", "isMutable": true },
                { "key": "gooseMaxTurns", "value": 250, "isMutable": true },
                { "key": "personalizedMemoryEnabled", "value": true, "isMutable": true },
                { "key": "voiceDictationProvider", "value": null, "isMutable": true },
                { "key": "voiceDictationPreferredMic", "value": "mic-1", "isMutable": true },
            ]))
        );
    });
}

#[test]
#[serial]
fn test_custom_preferences_save_rejects_invalid_values() {
    let _env = lock_unmanaged_preference_env();
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let invalid_payloads = [
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "autoCompactThreshold", "value": 0 }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "autoCompactThreshold", "value": 1.1 }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "gooseThinkingEffort", "value": "bogus" }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "gooseThinkingEffort", "value": ["high"] }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "gooseMaxTurns", "value": 0 }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "gooseMaxTurns", "value": 10001 }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "gooseMode", "value": "unsafe-mode" }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "personalizedMemoryEnabled", "value": "yes" }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "voiceAutoSubmitPhrases", "value": ["send"] }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "voiceDictationProvider", "value": "bogus" }],
            }),
            serde_json::json!({
                "expectedRevision": 0,
                "values": [{ "key": "voiceDictationPreferredMic", "value": "" }],
            }),
        ];

        for payload in invalid_payloads {
            let result = send_custom(conn.cx(), "_goose/unstable/preferences/save", payload).await;
            assert!(result.is_err(), "expected invalid params error");
        }

        let result = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/save",
            serde_json::json!({
                "expectedRevision": 0,
                "values": [
                    { "key": "voiceDictationPreferredMic", "value": "mic-1" },
                    { "key": "voiceDictationProvider", "value": "bogus" }
                ],
            }),
        )
        .await;
        assert!(result.is_err(), "expected invalid params error");

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({
                "keys": ["voiceDictationPreferredMic"],
            }),
        )
        .await
        .expect("preferences read should succeed");
        assert_eq!(response.get("revision"), Some(&serde_json::json!(0)));
        assert_eq!(
            response.get("values"),
            Some(&serde_json::json!([
                { "key": "voiceDictationPreferredMic", "value": null, "isMutable": true },
            ]))
        );
    });
}

#[test]
#[serial]
fn preferences_read_returns_one_revisioned_canonical_legacy_snapshot() {
    let _env = lock_unmanaged_preference_env();
    let config_dir = write_acp_global_config(
        r#"GOOSE_MODEL: gpt-4o
GOOSE_PROVIDER: openai
CODEBUDDY_PREFERENCES_REVISION: 7
VOICE_DICTATION_PROVIDER: null
voice_dictation_provider: groq
VOICE_DICTATION_PREFERRED_MIC: ""
voice_dictation_preferred_mic: legacy-mic
"#,
    );
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;

        let read = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({
                "keys": ["voiceDictationProvider", "voiceDictationPreferredMic"]
            }),
        )
        .await
        .expect("valid legacy values should fill null or empty canonical values");
        assert_eq!(
            read,
            serde_json::json!({
                "revision": 7,
                "values": [
                    { "key": "voiceDictationProvider", "value": "groq", "isMutable": true },
                    { "key": "voiceDictationPreferredMic", "value": "legacy-mic", "isMutable": true }
                ]
            })
        );

        std::fs::write(
            &config_path,
            "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nCODEBUDDY_PREFERENCES_REVISION: 7\nVOICE_DICTATION_PROVIDER: __disabled__\nvoice_dictation_provider: groq\n",
        )
        .unwrap();
        let disabled = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({ "keys": ["voiceDictationProvider"] }),
        )
        .await
        .expect("the canonical disabled sentinel should remain authoritative");
        assert_eq!(
            disabled,
            serde_json::json!({
                "revision": 7,
                "values": [
                    { "key": "voiceDictationProvider", "value": "__disabled__", "isMutable": true }
                ]
            })
        );

        std::fs::write(
            &config_path,
            "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nCODEBUDDY_PREFERENCES_REVISION: 7\nVOICE_DICTATION_PROVIDER: null\nvoice_dictation_provider: unsupported-provider\n",
        )
        .unwrap();
        let invalid_legacy = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({ "keys": ["voiceDictationProvider"] }),
        )
        .await
        .expect("invalid legacy data should fail closed without failing the whole read");
        assert_eq!(
            invalid_legacy,
            serde_json::json!({
                "revision": 7,
                "values": [
                    { "key": "voiceDictationProvider", "value": null, "isMutable": true }
                ]
            })
        );
    });
}

#[test]
#[serial]
fn preferences_save_remove_use_one_cas_write_and_stale_requests_change_nothing() {
    let _env = lock_unmanaged_preference_env();
    let config_dir = write_acp_global_config(
        r#"GOOSE_MODEL: gpt-4o
GOOSE_PROVIDER: openai
VOICE_DICTATION_PROVIDER: groq
voice_dictation_provider: legacy-provider
voice_dictation_preferred_mic: legacy-mic
STALE_REMOVE_CANARY: "D:\\private\\stale-remove-canary"
"#,
    );
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;

        send_custom(
            conn.cx(),
            "_goose/unstable/preferences/save",
            serde_json::json!({
                "expectedRevision": 0,
                "values": [
                    { "key": "voiceDictationProvider", "value": "openai" },
                    { "key": "voiceDictationPreferredMic", "value": "primary-mic" },
                    { "key": "gooseMaxTurns", "value": 300 }
                ]
            }),
        )
        .await
        .expect("matching revision should commit all canonical values together");

        let after_save = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({
                "keys": ["voiceDictationProvider", "voiceDictationPreferredMic", "gooseMaxTurns"]
            }),
        )
        .await
        .unwrap();
        assert_eq!(after_save["revision"], 1);
        assert_eq!(after_save["values"][0]["value"], "openai");
        assert_eq!(after_save["values"][1]["value"], "primary-mic");
        assert_eq!(after_save["values"][2]["value"], 300);
        let committed_bytes = std::fs::read(&config_path).unwrap();
        let committed_text = String::from_utf8(committed_bytes.clone()).unwrap();
        assert!(!committed_text.contains("voice_dictation_provider:"));
        assert!(!committed_text.contains("voice_dictation_preferred_mic:"));
        assert!(committed_text.contains("CODEBUDDY_PREFERENCES_REVISION: 1"));

        let stale_remove = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/remove",
            serde_json::json!({
                "expectedRevision": 0,
                "keys": ["voiceDictationProvider", "voiceDictationPreferredMic"]
            }),
        )
        .await
        .expect_err("a stale remove must be rejected before deleting canonical or legacy keys");
        let stale_remove_data = stale_remove
            .data
            .as_ref()
            .expect("a stale remove must include stable structured data");
        assert_eq!(
            stale_remove_data["code"],
            serde_json::json!("preference_revision_conflict")
        );
        assert_eq!(stale_remove_data["expectedRevision"], 0);
        assert_eq!(stale_remove_data["actualRevision"], 1);
        let stale_remove_surface = format!("{} {stale_remove_data}", stale_remove.message);
        let config_path_text = config_path.to_string_lossy();
        for private_value in [
            "legacy-provider",
            "legacy-mic",
            "primary-mic",
            "stale-remove-canary",
            r"D:\private",
            config_path_text.as_ref(),
        ] {
            assert!(
                !stale_remove_surface.contains(private_value),
                "stale remove error leaked private value {private_value}"
            );
        }
        assert_eq!(
            std::fs::read(&config_path).unwrap(),
            committed_bytes,
            "a stale remove must preserve the exact committed snapshot"
        );

        let stale = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/save",
            serde_json::json!({
                "expectedRevision": 0,
                "values": [
                    { "key": "voiceDictationPreferredMic", "value": "D:\\private\\stale-mic" }
                ]
            }),
        )
        .await
        .expect_err("a stale revision must be rejected");
        let stale_debug = format!("{stale:?}");
        assert!(stale_debug.contains("preference_revision_conflict"));
        assert!(stale_debug.contains("expectedRevision"));
        assert!(stale_debug.contains("actualRevision"));
        assert!(!stale_debug.contains("private"));
        assert!(!stale_debug.contains("stale-mic"));
        assert_eq!(std::fs::read(&config_path).unwrap(), committed_bytes);

        send_custom(
            conn.cx(),
            "_goose/unstable/preferences/remove",
            serde_json::json!({
                "expectedRevision": 1,
                "keys": ["voiceDictationProvider", "voiceDictationPreferredMic", "gooseMaxTurns"]
            }),
        )
        .await
        .expect("matching revision should remove all canonical and legacy values together");
        let after_remove = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({
                "keys": ["voiceDictationProvider", "voiceDictationPreferredMic", "gooseMaxTurns"]
            }),
        )
        .await
        .unwrap();
        assert_eq!(after_remove["revision"], 2);
        assert!(after_remove["values"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["value"].is_null()));
    });
}

#[test]
#[serial]
fn preferences_generic_config_cannot_read_or_mutate_any_owned_key() {
    let _env = lock_unmanaged_preference_env();
    let owned_keys = [
        "GOOSE_AUTO_COMPACT_THRESHOLD",
        "GOOSE_MODE",
        "GOOSE_THINKING_EFFORT",
        "GOOSE_MAX_TURNS",
        "VOICE_AUTO_SUBMIT_PHRASES",
        "VOICE_DICTATION_PROVIDER",
        "voice_dictation_provider",
        "VOICE_DICTATION_PREFERRED_MIC",
        "voice_dictation_preferred_mic",
        "CODEBUDDY_PREFERENCES_REVISION",
    ];
    let mut persisted = DEFAULT_ACP_TEST_CONFIG.to_string();
    for (index, key) in owned_keys.iter().enumerate() {
        persisted.push_str(&format!("{key}: preference-canary-{index}\n"));
    }
    let config_dir = write_acp_global_config(&persisted);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;

        for owned_key in owned_keys {
            let mixed_case = owned_key
                .chars()
                .enumerate()
                .map(|(index, ch)| {
                    if index % 2 == 0 {
                        ch.to_ascii_lowercase()
                    } else {
                        ch.to_ascii_uppercase()
                    }
                })
                .collect::<String>();
            for is_secret in [false, true] {
                let read = send_custom(
                    conn.cx(),
                    "_goose/unstable/config/read",
                    serde_json::json!({ "key": mixed_case, "isSecret": is_secret }),
                )
                .await
                .expect("generic reads should hide preference-owned state");
                assert!(read["value"].is_null());

                assert!(send_custom(
                    conn.cx(),
                    "_goose/unstable/config/upsert",
                    serde_json::json!({
                        "key": mixed_case,
                        "value": "attacker-value",
                        "isSecret": is_secret
                    }),
                )
                .await
                .is_err());
                assert!(send_custom(
                    conn.cx(),
                    "_goose/unstable/config/remove",
                    serde_json::json!({ "key": mixed_case, "isSecret": is_secret }),
                )
                .await
                .is_err());
            }
        }

        let read_all = send_custom(
            conn.cx(),
            "_goose/unstable/config/read-all",
            serde_json::json!({}),
        )
        .await
        .unwrap();
        let values = read_all["config"].as_object().unwrap();
        let blocked = read_all["blockedMutationKeys"].as_array().unwrap();
        for owned_key in owned_keys {
            assert!(values
                .keys()
                .all(|key| !key.eq_ignore_ascii_case(owned_key)));
            assert!(blocked.iter().any(|key| {
                key.as_str()
                    .is_some_and(|key| key.eq_ignore_ascii_case(owned_key))
            }));
        }
    });
}

#[test]
#[serial]
fn preferences_read_marks_environment_authority_immutable_and_preserves_revision_priority() {
    let _env = env_lock::lock_env([
        ("GOOSE_ADDITIONAL_CONFIG_FILES", None::<&str>),
        ("GOOSE_AUTO_COMPACT_THRESHOLD", None::<&str>),
        ("GOOSE_MODE", Some("smart_approve")),
        ("GOOSE_THINKING_EFFORT", None),
        ("GOOSE_MAX_TURNS", None),
        ("VOICE_AUTO_SUBMIT_PHRASES", None),
        ("VOICE_DICTATION_PROVIDER", None),
        ("VOICE_DICTATION_PREFERRED_MIC", None),
    ]);
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nCODEBUDDY_PREFERENCES_REVISION: 9\nGOOSE_MAX_TURNS: 640\n",
    );
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;

        let read = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/read",
            serde_json::json!({
                "keys": ["gooseMode", "gooseMaxTurns", "voiceDictationPreferredMic"]
            }),
        )
        .await
        .expect("managed and persisted preferences should share one snapshot");
        assert_eq!(
            read,
            serde_json::json!({
                "revision": 9,
                "values": [
                    { "key": "gooseMode", "value": "smart_approve", "isMutable": false },
                    { "key": "gooseMaxTurns", "value": 640, "isMutable": true },
                    { "key": "voiceDictationPreferredMic", "value": null, "isMutable": true }
                ]
            })
        );
        let before = std::fs::read(&config_path).unwrap();

        let stale = send_custom(
            conn.cx(),
            "_goose/unstable/preferences/save",
            serde_json::json!({
                "expectedRevision": 8,
                "values": [{ "key": "gooseMode", "value": "chat" }]
            }),
        )
        .await
        .expect_err("revision conflict must take precedence over managed-key rejection");
        assert_eq!(stale.data.unwrap()["code"], "preference_revision_conflict");
        assert_eq!(std::fs::read(&config_path).unwrap(), before);

        for (method, payload) in [
            (
                "_goose/unstable/preferences/save",
                serde_json::json!({
                    "expectedRevision": 9,
                    "values": [
                        { "key": "gooseMaxTurns", "value": 1000 },
                        { "key": "gooseMode", "value": "chat" }
                    ]
                }),
            ),
            (
                "_goose/unstable/preferences/remove",
                serde_json::json!({
                    "expectedRevision": 9,
                    "keys": ["gooseMaxTurns", "gooseMode"]
                }),
            ),
        ] {
            let error = send_custom(conn.cx(), method, payload)
                .await
                .expect_err("a batch containing an environment-managed key must be rejected");
            let data = error.data.expect("managed-key errors must be structured");
            assert_eq!(data["code"], "preference_managed_key");
            assert_eq!(data["key"], "gooseMode");
            let surface = format!("{} {data}", error.message);
            assert!(!surface.contains(config_path.to_string_lossy().as_ref()));
            assert_eq!(std::fs::read(&config_path).unwrap(), before);
        }
    });
}

#[test]
#[serial]
fn preferences_reject_duplicate_keys_before_any_partial_write() {
    let _env = lock_unmanaged_preference_env();
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nCODEBUDDY_PREFERENCES_REVISION: 2\nGOOSE_MODE: auto\n",
    );
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;
        let before = std::fs::read(&config_path).unwrap();
        let cases = [
            (
                "_goose/unstable/preferences/read",
                serde_json::json!({ "keys": ["gooseMode", "gooseMode"] }),
            ),
            (
                "_goose/unstable/preferences/save",
                serde_json::json!({
                    "expectedRevision": 2,
                    "values": [
                        { "key": "gooseMode", "value": "approve" },
                        { "key": "gooseMode", "value": "chat" }
                    ]
                }),
            ),
            (
                "_goose/unstable/preferences/remove",
                serde_json::json!({
                    "expectedRevision": 2,
                    "keys": ["gooseMode", "gooseMode"]
                }),
            ),
        ];

        for (method, payload) in cases {
            let error = send_custom(conn.cx(), method, payload)
                .await
                .expect_err("duplicate preference keys must fail closed");
            assert_eq!(error.data.unwrap()["code"], "duplicate_preference_key");
            assert_eq!(std::fs::read(&config_path).unwrap(), before);
        }
    });
}

#[test]
#[serial]
fn preferences_invalid_managed_environment_values_fail_closed_without_leaking() {
    let _env = env_lock::lock_env([
        ("GOOSE_MODE", None::<&str>),
        ("GOOSE_MAX_TURNS", None),
        ("GOOSE_ADDITIONAL_CONFIG_FILES", None),
    ]);
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nGOOSE_MODE: approve\n",
    );

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;

        for invalid in ["   ", r"D:\private\invalid-mode"] {
            std::env::set_var("GOOSE_MODE", invalid);
            let error = send_custom(
                conn.cx(),
                "_goose/unstable/preferences/read",
                serde_json::json!({ "keys": ["gooseMode"] }),
            )
            .await
            .expect_err("invalid managed values must not fall back to persisted data");
            let surface = format!("{error:?}");
            assert!(surface.contains("preference_managed_value_invalid"));
            assert!(!surface.contains(invalid));
            assert!(!surface.contains(r"D:\private"));
        }

        #[cfg(windows)]
        {
            use std::ffi::OsString;
            use std::os::windows::ffi::OsStringExt;
            std::env::set_var("GOOSE_MODE", OsString::from_wide(&[0xd800]));
            let error = send_custom(
                conn.cx(),
                "_goose/unstable/preferences/read",
                serde_json::json!({ "keys": ["gooseMode"] }),
            )
            .await
            .expect_err("non-Unicode managed values must fail closed");
            assert!(format!("{error:?}").contains("preference_managed_value_invalid"));
        }
    });
}

#[test]
#[serial]
fn test_custom_defaults_read() {
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: claude-3-5-haiku-latest\nGOOSE_PROVIDER: anthropic\n",
    );

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let config = TestConnectionConfig {
            data_root: config_dir,
            ..Default::default()
        };
        let conn = AcpServerConnection::new(config, openai).await;

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/read",
            serde_json::json!({}),
        )
        .await
        .expect("defaults read should succeed");
        assert_eq!(
            response,
            serde_json::json!({
                "providerId": "anthropic",
                "modelId": "claude-3-5-haiku-latest",
            })
        );
    });
}

#[test]
#[serial]
fn codepro_routing_key_is_hidden_and_generic_mutations_reject_case_insensitively() {
    let config_dir = write_acp_global_config(
        r#"GOOSE_MODEL: gpt-4o
GOOSE_PROVIDER: openai
GOOSE_CODEPRO_MODEL_ROUTING:
  version: 1
  advancedRoutingEnabled: false
  routes: []
  maxParallelCoders: 1
gOoSe_CoDePrO_mOdEl_RoUtInG:
  persistedAliasCanary: must-never-be-readable
"#,
    );
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);
    assert!(
        std::fs::read_to_string(&config_path)
            .unwrap()
            .contains("gOoSe_CoDePrO_mOdEl_RoUtInG"),
        "the mixed-case bypass probe must exist on disk before generic reads"
    );

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;
        for key in ["gOoSe_CoDePrO_mOdEl_RoUtInG", "GOOSE_CODEPRO_MODEL_ROUTING"] {
            for is_secret in [false, true] {
                let direct_read = send_custom(
                    conn.cx(),
                    "_goose/unstable/config/read",
                    serde_json::json!({
                        "key": key,
                        "isSecret": is_secret,
                    }),
                )
                .await
                .expect("generic read must hide reserved routing state");
                assert!(
                    direct_read["value"].is_null(),
                    "generic read exposed {key} with isSecret={is_secret}"
                );

                assert!(
                    send_custom(
                        conn.cx(),
                        "_goose/unstable/config/upsert",
                        serde_json::json!({
                            "key": key,
                            "value": "attacker-controlled-routing",
                            "isSecret": is_secret,
                        }),
                    )
                    .await
                    .is_err(),
                    "generic upsert accepted {key} with isSecret={is_secret}"
                );
                assert!(
                    send_custom(
                        conn.cx(),
                        "_goose/unstable/config/remove",
                        serde_json::json!({ "key": key, "isSecret": is_secret }),
                    )
                    .await
                    .is_err(),
                    "generic remove accepted {key} with isSecret={is_secret}"
                );
            }
        }
        let read_all = send_custom(
            conn.cx(),
            "_goose/unstable/config/read-all",
            serde_json::json!({}),
        )
        .await
        .expect("generic read-all should filter reserved routing state");
        let routing_is_hidden = read_all["config"].as_object().is_some_and(|values| {
            values
                .keys()
                .all(|key| !key.eq_ignore_ascii_case("GOOSE_CODEPRO_MODEL_ROUTING"))
        });
        let routing_is_blocked = read_all["blockedMutationKeys"]
            .as_array()
            .is_some_and(|keys| {
                keys.iter().any(|key| {
                    key.as_str()
                        .is_some_and(|key| key.eq_ignore_ascii_case("GOOSE_CODEPRO_MODEL_ROUTING"))
                })
            });

        assert!(routing_is_hidden);
        assert!(routing_is_blocked);
    });
}

#[test]
#[serial]
fn defaults_require_a_trimmed_complete_pair_and_read_all_or_none() {
    let _env = env_lock::lock_env([
        ("GOOSE_PROVIDER", None::<&str>),
        ("GOOSE_MODEL", None::<&str>),
        ("OPENAI_API_KEY", Some("test-key")),
    ]);
    let config_dir = write_acp_global_config("GOOSE_PROVIDER: openai\n");
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(deterministic_provider_factory()),
                ..Default::default()
            },
            openai,
        )
        .await;
        let exact_bytes_before = std::fs::read(&config_path).unwrap();
        let read = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/read",
            serde_json::json!({}),
        )
        .await
        .expect("half-configured defaults must read as an empty pair");
        for (name, payload) in [
            (
                "missing model",
                serde_json::json!({ "providerId": "openai" }),
            ),
            (
                "missing provider",
                serde_json::json!({ "modelId": "gpt-4o" }),
            ),
            (
                "blank provider",
                serde_json::json!({ "providerId": "  ", "modelId": "gpt-4o" }),
            ),
            (
                "blank model",
                serde_json::json!({ "providerId": "openai", "modelId": "\t" }),
            ),
        ] {
            assert!(
                send_custom(conn.cx(), "_goose/unstable/defaults/save", payload)
                    .await
                    .is_err(),
                "defaults save accepted {name}"
            );
        }

        assert_eq!(
            (read["providerId"].is_null(), read["modelId"].is_null()),
            (true, true)
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), exact_bytes_before);
    });
}

#[test]
#[serial]
fn defaults_save_commits_one_canonical_pair_and_failed_save_preserves_exact_bytes() {
    let _env = env_lock::lock_env([("ANTHROPIC_API_KEY", Some("test-key"))]);
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(deterministic_provider_factory()),
                ..Default::default()
            },
            openai,
        )
        .await;
        let original_bytes = std::fs::read(&config_path).unwrap();
        let accepted = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": " anthropic ",
                "modelId": " claude-sonnet-4-5 "
            }),
        )
        .await
        .expect("a validated complete default pair should commit");
        assert_eq!(
            accepted,
            serde_json::json!({
                "providerId": "anthropic",
                "modelId": "claude-sonnet-4-5"
            })
        );
        let committed_bytes = std::fs::read(&config_path).unwrap();
        assert_ne!(committed_bytes, original_bytes);

        assert!(send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": "anthropic",
                "modelId": "not-in-live-catalogue"
            }),
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(&config_path).unwrap(),
            committed_bytes,
            "a failed defaults save must preserve the exact committed snapshot"
        );
        let still_committed = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/read",
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(still_committed, accepted);
    });
}

#[test]
#[serial]
fn defaults_save_rejects_retired_deepseek_models_and_accepts_v4() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let provider_factory: AcpProviderFactory =
            Arc::new(|provider_name, _extensions, _working_dir| {
                Box::pin(async move {
                    let supported_models = if provider_name == "custom_deepseek" {
                        vec![
                            "deepseek-v4-flash".to_string(),
                            "deepseek-v4-pro".to_string(),
                        ]
                    } else {
                        vec!["gpt-4o".to_string()]
                    };
                    Ok(Arc::new(MockProvider {
                        name: provider_name,
                        recommended_models: supported_models.clone(),
                        supported_models,
                    }) as Arc<dyn Provider>)
                })
            });
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;

        let error = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": "custom_deepseek",
                "modelId": "deepseek-chat"
            }),
        )
        .await
        .expect_err("the retired deepseek-chat alias must be rejected");
        assert!(error.to_string().contains("is not available for provider"));

        let accepted = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": "custom_deepseek",
                "modelId": "deepseek-v4-flash"
            }),
        )
        .await
        .expect("the live deepseek-v4-flash model must commit");
        assert_eq!(
            accepted,
            serde_json::json!({
                "providerId": "custom_deepseek",
                "modelId": "deepseek-v4-flash"
            })
        );

        let read = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/read",
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(read, accepted);
    });
}

#[test]
#[serial]
fn defaults_save_accepts_factory_live_only_model_with_one_activation_probe() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let factory_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let validations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let model_fetches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let streams = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stream_models = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed_factory_calls = Arc::clone(&factory_calls);
        let observed_validations = Arc::clone(&validations);
        let observed_model_fetches = Arc::clone(&model_fetches);
        let observed_streams = Arc::clone(&streams);
        let observed_stream_models = Arc::clone(&stream_models);
        let provider_factory: AcpProviderFactory =
            Arc::new(move |provider_name, _extensions, working_dir| {
                assert_eq!(provider_name, "openai");
                assert!(working_dir.is_none());
                observed_factory_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let provider = ObservedProvider {
                    name: provider_name,
                    supported_models: vec!["factory-live-only-model".to_string()],
                    validations: Arc::clone(&observed_validations),
                    model_fetches: Arc::clone(&observed_model_fetches),
                    stream_count: Arc::clone(&observed_streams),
                    stream_models: Arc::clone(&observed_stream_models),
                };
                Box::pin(async move { Ok(Arc::new(provider) as Arc<dyn Provider>) })
            });
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;

        let accepted = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": " openai ",
                "modelId": " factory-live-only-model "
            }),
        )
        .await
        .expect("the injected provider's live-only model must be accepted");

        assert_eq!(
            accepted,
            serde_json::json!({
                "providerId": "openai",
                "modelId": "factory-live-only-model"
            })
        );
        assert_eq!(
            (
                factory_calls.load(std::sync::atomic::Ordering::SeqCst),
                validations.load(std::sync::atomic::Ordering::SeqCst),
                model_fetches.load(std::sync::atomic::Ordering::SeqCst),
                streams.load(std::sync::atomic::Ordering::SeqCst),
            ),
            (1, 1, 1, 0)
        );
    });
}

#[test]
#[serial]
fn defaults_save_rejects_expired_credentials_without_rewriting_global_bytes() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);
    run_test(async move {
        let factory_names = Arc::new(Mutex::new(Vec::<String>::new()));
        let validation_order = Arc::new(Mutex::new(Vec::<String>::new()));
        let model_fetches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let streams = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_factory_names = Arc::clone(&factory_names);
        let observed_validation_order = Arc::clone(&validation_order);
        let observed_model_fetches = Arc::clone(&model_fetches);
        let observed_streams = Arc::clone(&streams);
        let provider_factory: AcpProviderFactory =
            Arc::new(move |provider_name, _extensions, working_dir| {
                assert_eq!(provider_name, "openai");
                assert!(working_dir.is_none());
                observed_factory_names
                    .lock()
                    .unwrap()
                    .push(provider_name.clone());
                let provider = RolePreflightProvider {
                    name: provider_name,
                    supported_model: "credential-protected-model".to_string(),
                    reject_validation: true,
                    validation_order: Arc::clone(&observed_validation_order),
                    model_fetches: Arc::clone(&observed_model_fetches),
                    streams: Arc::clone(&observed_streams),
                };
                Box::pin(async move { Ok(Arc::new(provider) as Arc<dyn Provider>) })
            });
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;
        let exact_bytes_before = std::fs::read(&config_path).unwrap();

        assert!(send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": "openai",
                "modelId": "credential-protected-model"
            }),
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(&config_path).unwrap(), exact_bytes_before);
        assert_eq!(*factory_names.lock().unwrap(), vec!["openai"]);
        assert_eq!(*validation_order.lock().unwrap(), vec!["openai"]);
        assert_eq!(model_fetches.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(streams.load(std::sync::atomic::Ordering::SeqCst), 0);
    });
}

#[test]
#[serial]
fn model_capability_overrides_round_trip_and_drive_resolution() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;

        let saved = send_custom(
            conn.cx(),
            "_goose/unstable/model-capabilities/save",
            serde_json::json!({
                "config": {
                    "version": 1,
                    "overrides": [{
                        "providerId": " custom_1 ",
                        "modelId": " kimi-k3 ",
                        "imageInput": "force_supported"
                    }]
                }
            }),
        )
        .await
        .expect("a valid capability override must persist");
        assert_eq!(
            saved,
            serde_json::json!({
                "version": 1,
                "overrides": [{
                    "providerId": "custom_1",
                    "modelId": "kimi-k3",
                    "imageInput": "force_supported"
                }]
            })
        );

        let read = send_custom(
            conn.cx(),
            "_goose/unstable/model-capabilities/read",
            serde_json::json!({}),
        )
        .await
        .expect("persisted capability overrides must be readable");
        assert_eq!(read["config"], saved);

        let resolved = send_custom(
            conn.cx(),
            "_goose/unstable/model-capabilities/resolve",
            serde_json::json!({ "providerId": "custom_1", "modelId": "kimi-k3" }),
        )
        .await
        .expect("the resolver must consume the persisted override");
        assert_eq!(resolved["imageInput"], "supported");
        assert_eq!(resolved["source"], "user_override");
    });
}

#[test]
#[serial]
fn typed_routing_read_rejects_malformed_state_instead_of_using_legacy_keys() {
    let config_dir = write_acp_global_config(
        r#"GOOSE_MODEL: gpt-4o
GOOSE_PROVIDER: openai
GOOSE_CODEPRO_ADVANCED_MODEL_ROUTING: true
GOOSE_CODER_PROVIDER: ollama_cloud
GOOSE_CODER_MODEL: glm-5.2
GOOSE_CODEPRO_MODEL_ROUTING:
  version: 2
  advancedRoutingEnabled: false
  routes: []
  maxParallelCoders: 1
"#,
    );
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;
        let error = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/read",
            serde_json::json!({}),
        )
        .await
        .expect_err("unsupported persisted routing versions must fail closed");
        let error = error.to_string().to_ascii_lowercase();
        assert!(error.contains("version") || error.contains("routing"));
        assert!(!error.contains("method not found"));
    });
}

#[test]
#[serial]
fn disabled_or_absent_typed_routing_never_falls_back_to_legacy_routes() {
    for typed_yaml in [
        "",
        "GOOSE_CODEPRO_MODEL_ROUTING:\n  version: 1\n  advancedRoutingEnabled: false\n  routes: []\n  maxParallelCoders: 1\n",
    ] {
        let config_dir = write_acp_global_config(&format!(
            "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nGOOSE_CODEPRO_ADVANCED_MODEL_ROUTING: true\nGOOSE_CODER_PROVIDER: ollama_cloud\nGOOSE_CODER_MODEL: glm-5.2\n{typed_yaml}"
        ));
        run_test(async move {
            let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
            let conn = AcpServerConnection::new(
                TestConnectionConfig {
                    data_root: config_dir,
                    ..Default::default()
                },
                openai,
            )
            .await;
            let response = send_custom(
                conn.cx(),
                "_goose/unstable/codepro/model-routing/read",
                serde_json::json!({}),
            )
            .await
            .expect("typed routing read must be the only routing authority");
            if typed_yaml.is_empty() {
                assert!(response["config"].is_null());
            } else {
                assert_eq!(response["config"]["version"], 2);
                assert_eq!(response["config"]["advancedRoutingEnabled"], false);
                assert_eq!(response["config"]["routes"], serde_json::json!([]));
                assert_eq!(
                    response["config"]["visionRoute"],
                    serde_json::json!({ "enabled": true, "mode": "auto" })
                );
            }
        });
    }
}

#[test]
#[serial]
fn typed_routing_save_validates_live_models_before_one_snapshot_write() {
    let config_dir = write_acp_global_config(
        r#"GOOSE_MODEL: gpt-4o
GOOSE_PROVIDER: openai
GOOSE_CODEPRO_MODEL_ROUTING:
  version: 1
  advancedRoutingEnabled: false
  routes: []
  maxParallelCoders: 1
"#,
    );
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let factory_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let validations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let model_fetches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stream_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stream_models = Arc::new(Mutex::new(Vec::<String>::new()));
        let working_dirs = Arc::new(Mutex::new(Vec::<Option<PathBuf>>::new()));
        let observed_factory_calls = Arc::clone(&factory_calls);
        let observed_validations = Arc::clone(&validations);
        let observed_model_fetches = Arc::clone(&model_fetches);
        let observed_stream_count = Arc::clone(&stream_count);
        let observed_stream_models = Arc::clone(&stream_models);
        let observed_working_dirs = Arc::clone(&working_dirs);
        let provider_factory: AcpProviderFactory =
            Arc::new(move |provider_name, _extensions, working_dir| {
                observed_factory_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                observed_working_dirs.lock().unwrap().push(working_dir);
                let validations = Arc::clone(&observed_validations);
                let model_fetches = Arc::clone(&observed_model_fetches);
                let stream_count = Arc::clone(&observed_stream_count);
                let stream_models = Arc::clone(&observed_stream_models);
                Box::pin(async move {
                    Ok(Arc::new(ObservedProvider {
                        name: provider_name,
                        supported_models: vec!["private-dynamic-model".to_string()],
                        validations,
                        model_fetches,
                        stream_count,
                        stream_models,
                    }) as Arc<dyn Provider>)
                })
            });
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;

        let accepted = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/save",
            serde_json::json!({ "config": codepro_routing_payload("private-dynamic-model") }),
        )
        .await
        .expect("a model from the injected provider's live catalogue must be accepted");
        assert_eq!(accepted["version"], 2);
        assert_eq!(
            accepted["visionRoute"],
            serde_json::json!({ "enabled": true, "mode": "auto" })
        );
        assert_eq!(accepted["routes"][0]["providerId"], "openai");
        assert_eq!(accepted["routes"][0]["modelId"], "private-dynamic-model");
        assert_eq!(
            (
                factory_calls.load(std::sync::atomic::Ordering::SeqCst),
                validations.load(std::sync::atomic::Ordering::SeqCst),
                model_fetches.load(std::sync::atomic::Ordering::SeqCst),
            ),
            (1, 1, 1),
            "four identical routes must share one live provider/model validation"
        );
        assert_eq!(stream_count.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            *working_dirs.lock().unwrap(),
            vec![None],
            "configuration validation must not invent a workspace"
        );

        let listed = send_custom(
            conn.cx(),
            "_goose/unstable/providers/supported-models/list",
            serde_json::json!({ "providerId": "openai" }),
        )
        .await
        .expect("supported-model discovery must use the same injected provider authority");
        assert_eq!(
            listed["models"],
            serde_json::json!(["private-dynamic-model"])
        );
        assert_eq!(
            (
                factory_calls.load(std::sync::atomic::Ordering::SeqCst),
                validations.load(std::sync::atomic::Ordering::SeqCst),
                model_fetches.load(std::sync::atomic::Ordering::SeqCst),
            ),
            (2, 1, 2),
            "listing and saving must use the same injected source without duplicate save probes"
        );

        let before = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/read",
            serde_json::json!({}),
        )
        .await
        .expect("accepted routing snapshot must be readable");
        let exact_bytes_before_failed_save = std::fs::read(&config_path).unwrap();
        let mut invalid = codepro_routing_payload("private-dynamic-model");
        invalid["routes"][3]["modelId"] = serde_json::json!("not-in-live-catalogue");
        assert!(send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/save",
            serde_json::json!({ "config": invalid }),
        )
        .await
        .is_err());
        let after = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/read",
            serde_json::json!({}),
        )
        .await
        .expect("failed routing save must preserve the old snapshot");
        assert_eq!(after, before);
        assert_eq!(
            std::fs::read(&config_path).unwrap(),
            exact_bytes_before_failed_save,
            "failure in the last route must not partially rewrite the routing snapshot"
        );
        assert_eq!(
            (
                factory_calls.load(std::sync::atomic::Ordering::SeqCst),
                validations.load(std::sync::atomic::Ordering::SeqCst),
                model_fetches.load(std::sync::atomic::Ordering::SeqCst),
            ),
            (3, 2, 3),
            "one provider catalogue fetch must validate the complete mixed-model route set"
        );
        assert_eq!(*working_dirs.lock().unwrap(), vec![None, None, None]);
        assert_eq!(stream_count.load(std::sync::atomic::Ordering::SeqCst), 0);

        // Remembering an unavailable combination is safe only while disabled.
        let mut dormant = codepro_routing_payload("not-in-live-catalogue");
        dormant["advancedRoutingEnabled"] = serde_json::json!(false);
        let saved = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/save",
            serde_json::json!({ "config": dormant }),
        )
        .await
        .expect("disabling must retain preferences without contacting providers");
        assert_eq!(factory_calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        let restored = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/read",
            serde_json::json!({}),
        )
        .await
        .unwrap();
        assert_eq!(restored["config"], saved);
        assert_eq!(saved["advancedRoutingEnabled"], false);
        assert_eq!(saved["routes"][0]["modelId"], "not-in-live-catalogue");
        let bytes_before_enable = std::fs::read(&config_path).unwrap();
        let mut reenabled = saved;
        reenabled["advancedRoutingEnabled"] = serde_json::json!(true);
        assert!(send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/save",
            serde_json::json!({ "config": reenabled }),
        )
        .await
        .is_err());
        assert_eq!(factory_calls.load(std::sync::atomic::Ordering::SeqCst), 4);
        assert_eq!(std::fs::read(&config_path).unwrap(), bytes_before_enable);
    });
}

#[test]
#[serial]
fn typed_routing_save_accepts_cli_login_provider_without_credential_prevalidation() {
    let config_dir = write_acp_global_config(
        r#"GOOSE_MODEL: gpt-4o
GOOSE_PROVIDER: openai
GOOSE_CODEPRO_MODEL_ROUTING:
  version: 1
  advancedRoutingEnabled: false
  routes: []
  maxParallelCoders: 1
"#,
    );
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let validation_order = Arc::new(Mutex::new(Vec::<String>::new()));
        let model_fetches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let streams = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_validation_order = Arc::clone(&validation_order);
        let observed_model_fetches = Arc::clone(&model_fetches);
        let observed_streams = Arc::clone(&streams);
        let provider_factory: AcpProviderFactory = Arc::new(move |provider_name, _, _| {
            let validation_order = Arc::clone(&observed_validation_order);
            let model_fetches = Arc::clone(&observed_model_fetches);
            let streams = Arc::clone(&observed_streams);
            Box::pin(async move {
                Ok(Arc::new(RolePreflightProvider {
                    name: provider_name,
                    supported_model: "gpt-5.2-codex".to_string(),
                    reject_validation: true,
                    validation_order,
                    model_fetches,
                    streams,
                }) as Arc<dyn Provider>)
            })
        });
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;

        let routes = ["planner", "coder", "tester", "reviewer"]
            .into_iter()
            .map(|role| {
                serde_json::json!({
                    "role": role,
                    "providerId": "codex",
                    "modelId": "gpt-5.2-codex"
                })
            })
            .collect::<Vec<_>>();
        let saved = send_custom(
            conn.cx(),
            "_goose/unstable/codepro/model-routing/save",
            serde_json::json!({
                "config": {
                    "version": 1,
                    "advancedRoutingEnabled": true,
                    "routes": routes,
                    "maxParallelCoders": 1
                }
            }),
        )
        .await
        .expect("CLI-login providers must be validated by their live model catalogue");

        assert_eq!(saved["routes"][0]["providerId"], "codex");
        assert!(validation_order.lock().unwrap().is_empty());
        assert_eq!(model_fetches.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(streams.load(std::sync::atomic::Ordering::SeqCst), 0);
    });
}

#[test]
#[serial]
fn acp_session_codepro_runtime_reuses_injected_provider_with_authoritative_working_dir() {
    run_test(async move {
        let openai = OpenAiFixture::new(
            vec![(
                "这个实现有问题".to_string(),
                include_str!("acp_test_data/openai_basic.txt"),
            )],
            Arc::new(IgnoreSessionId),
        )
        .await;
        let config_dir = write_acp_global_config(&format!(
            r#"GOOSE_MODEL: gpt-4.1
GOOSE_PROVIDER: openai
OPENAI_HOST: {}
GOOSE_CODEPRO_MODEL_ROUTING:
  version: 1
  advancedRoutingEnabled: true
  routes:
    - role: planner
      providerId: openai
      modelId: private-dynamic-model
    - role: coder
      providerId: openai
      modelId: private-dynamic-model
    - role: tester
      providerId: openai
      modelId: private-dynamic-model
    - role: reviewer
      providerId: openai
      modelId: private-dynamic-model
  maxParallelCoders: 2
"#,
            openai.uri()
        ));
        let workspace = tempfile::tempdir().unwrap();
        let session_working_dir = workspace.path().to_path_buf();
        let factory_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let validations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let model_fetches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stream_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stream_models = Arc::new(Mutex::new(Vec::<String>::new()));
        let working_dirs = Arc::new(Mutex::new(Vec::<Option<PathBuf>>::new()));
        let provider = Arc::new(ObservedProvider {
            name: "openai".to_string(),
            supported_models: vec!["private-dynamic-model".to_string()],
            validations: Arc::clone(&validations),
            model_fetches: Arc::clone(&model_fetches),
            stream_count: Arc::clone(&stream_count),
            stream_models: Arc::clone(&stream_models),
        });
        let observed_factory_calls = Arc::clone(&factory_calls);
        let observed_working_dirs = Arc::clone(&working_dirs);
        let factory_provider = Arc::clone(&provider);
        let provider_factory: AcpProviderFactory =
            Arc::new(move |provider_name, _extensions, working_dir| {
                assert_eq!(provider_name, "openai");
                observed_factory_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                observed_working_dirs.lock().unwrap().push(working_dir);
                let provider = Arc::clone(&factory_provider);
                Box::pin(async move { Ok(provider as Arc<dyn Provider>) })
            });
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                current_model: "gpt-4.1".to_string(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let created = send_custom(
            conn.cx(),
            "session/new",
            serde_json::json!({
                "cwd": session_working_dir,
                "mcpServers": [],
                "_meta": {
                    "workspaceMode": "codepro",
                    "workspaceBinding": "unbound"
                }
            }),
        )
        .await
        .expect("an unbound CodePro session should be created without a writable lease");
        let session_id = created["sessionId"]
            .as_str()
            .expect("session/new response sessionId")
            .to_string();

        factory_calls.store(0, std::sync::atomic::Ordering::SeqCst);
        validations.store(0, std::sync::atomic::Ordering::SeqCst);
        model_fetches.store(0, std::sync::atomic::Ordering::SeqCst);
        stream_count.store(0, std::sync::atomic::Ordering::SeqCst);
        stream_models.lock().unwrap().clear();
        working_dirs.lock().unwrap().clear();

        send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "这个实现有问题" }]
            }),
        )
        .await
        .expect("the CodePro semantic route should complete through the injected provider");

        assert_eq!(factory_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            *working_dirs.lock().unwrap(),
            vec![Some(session_working_dir)]
        );
        assert_eq!(validations.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(model_fetches.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            stream_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the exact provider Arc validated by the runtime route must perform generation"
        );
        assert_eq!(
            *stream_models.lock().unwrap(),
            vec!["private-dynamic-model"],
            "runtime generation must receive the private typed route model, not the global session model"
        );
    });
}

#[test]
#[serial]
fn codepro_late_role_preflight_failure_returns_retryable_pause_without_execution_side_effects() {
    run_test(async move {
        let config_dir = write_acp_global_config(
            r#"GOOSE_MODEL: primary-model
GOOSE_PROVIDER: openai
GOOSE_CODEPRO_MODEL_ROUTING:
  version: 1
  advancedRoutingEnabled: true
  routes:
    - role: planner
      providerId: dynamic-planner
      modelId: planner-private-model
    - role: coder
      providerId: dynamic-coder
      modelId: coder-private-model
    - role: tester
      providerId: dynamic-tester
      modelId: tester-private-model
    - role: reviewer
      providerId: dynamic-reviewer
      modelId: reviewer-private-model
  maxParallelCoders: 2
"#,
        );

        let plugin_parent = goose::config::paths::Paths::plugins_dir();
        std::fs::create_dir_all(&plugin_parent).unwrap();
        let hook_plugin = tempfile::Builder::new()
            .prefix("codepro-preflight-hooks-")
            .tempdir_in(plugin_parent)
            .unwrap();
        std::fs::create_dir_all(hook_plugin.path().join("hooks")).unwrap();
        let script_name = if cfg!(windows) {
            "record.cmd"
        } else {
            "record.sh"
        };
        let hook_action = serde_json::json!({
            "hooks": [{
                "type": "command",
                "command": format!(r#""${{PLUGIN_ROOT}}/{script_name}""#),
            }]
        });
        let hooks = serde_json::json!({
            "hooks": {
                "SessionStart": [hook_action.clone()],
                "UserPromptSubmit": [hook_action.clone()],
                "PreToolUse": [hook_action.clone()],
                "BeforeReadFile": [hook_action.clone()],
                "BeforeShellExecution": [hook_action],
            }
        });
        std::fs::write(
            hook_plugin.path().join("hooks/hooks.json"),
            serde_json::to_vec_pretty(&hooks).unwrap(),
        )
        .unwrap();
        #[cfg(windows)]
        let script = r#"@echo off
echo hook>> "%PLUGIN_ROOT%\hook.log"
"#;
        #[cfg(not(windows))]
        let script = r#"#!/bin/sh
echo hook >> "$PLUGIN_ROOT/hook.log"
"#;
        let script_path = hook_plugin.path().join(script_name);
        std::fs::write(&script_path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&script_path).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&script_path, permissions).unwrap();
        }
        let hook_log = hook_plugin.path().join("hook.log");

        let factory_names = Arc::new(Mutex::new(Vec::<String>::new()));
        let validation_order = Arc::new(Mutex::new(Vec::<String>::new()));
        let model_fetches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let streams = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_factory_names = Arc::clone(&factory_names);
        let observed_validation_order = Arc::clone(&validation_order);
        let observed_model_fetches = Arc::clone(&model_fetches);
        let observed_streams = Arc::clone(&streams);
        let provider_factory: AcpProviderFactory =
            Arc::new(move |provider_name, _extensions, _working_dir| {
                observed_factory_names
                    .lock()
                    .unwrap()
                    .push(provider_name.clone());
                let supported_model = match provider_name.as_str() {
                    "dynamic-planner" => "planner-private-model",
                    "dynamic-coder" => "coder-private-model",
                    "dynamic-tester" => "tester-private-model",
                    "dynamic-reviewer" => "reviewer-private-model",
                    _ => "primary-model",
                }
                .to_string();
                let provider = RolePreflightProvider {
                    reject_validation: provider_name == "dynamic-reviewer",
                    name: provider_name,
                    supported_model,
                    validation_order: Arc::clone(&observed_validation_order),
                    model_fetches: Arc::clone(&observed_model_fetches),
                    streams: Arc::clone(&observed_streams),
                };
                Box::pin(async move { Ok(Arc::new(provider) as Arc<dyn Provider>) })
            });
        let terminal = TerminalFixture::new(vec![]);
        let openai = OpenAiFixture::new(vec![], Arc::new(IgnoreSessionId)).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                terminal: Some(Arc::clone(&terminal)),
                current_model: "primary-model".to_string(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let workspace = tempfile::tempdir().unwrap();
        let created = send_custom(
            conn.cx(),
            "session/new",
            serde_json::json!({
                "cwd": workspace.path(),
                "mcpServers": [],
                "_meta": {
                    "workspaceMode": "codepro",
                    "workspaceBinding": "unbound"
                }
            }),
        )
        .await
        .expect("the CodePro session fixture should initialize");
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        let data_root = conn.data_root();
        let session_manager = SessionManager::new(data_root);
        let before_messages = session_manager
            .get_session(&session_id, true)
            .await
            .unwrap()
            .conversation
            .map(|conversation| conversation.len())
            .unwrap_or_default();
        assert_eq!(before_messages, 0);
        let state_run_dir = goose::config::paths::Paths::runs_dir()
            .join(&session_id)
            .join("run");
        let state_artifacts = |run_dir: &std::path::Path| {
            std::fs::read_dir(run_dir)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.contains("state"))
                })
                .collect::<Vec<_>>()
        };
        assert!(state_artifacts(&state_run_dir).is_empty());

        factory_names.lock().unwrap().clear();
        validation_order.lock().unwrap().clear();
        model_fetches.store(0, std::sync::atomic::Ordering::SeqCst);
        streams.store(0, std::sync::atomic::Ordering::SeqCst);

        let prompt_result = send_custom(
            conn.cx(),
            "session/prompt",
            serde_json::json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": "这个实现有问题" }]
            }),
        )
        .await;

        let after_messages = session_manager
            .get_session(&session_id, true)
            .await
            .unwrap()
            .conversation
            .map(|conversation| conversation.len())
            .unwrap_or_default();
        let state_artifacts_after = state_artifacts(&state_run_dir);
        let hook_invocations = std::fs::read_to_string(&hook_log)
            .map(|contents| contents.lines().count())
            .unwrap_or_default();
        terminal.assert_called();
        let expected_roles = [
            "dynamic-planner",
            "dynamic-coder",
            "dynamic-tester",
            "dynamic-reviewer",
        ]
        .map(str::to_string)
        .to_vec();
        assert_eq!(
            (
                prompt_result.is_err(),
                after_messages,
                state_artifacts_after,
                hook_invocations,
                streams.load(std::sync::atomic::Ordering::SeqCst),
                factory_names.lock().unwrap().clone(),
                validation_order.lock().unwrap().clone(),
                model_fetches.load(std::sync::atomic::Ordering::SeqCst),
            ),
            (
                false,
                before_messages + 2,
                Vec::<PathBuf>::new(),
                0,
                0,
                expected_roles.clone(),
                expected_roles,
                3,
            ),
            "the late role failure must return a retryable pause before run/hook/tool/stream side effects and must not trigger fallback"
        );
    });
}

#[test]
#[serial]
fn test_session_switch_accepts_a_live_custom_model_when_saved_catalog_is_stale() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);

    run_test(async move {
        let provider_id = "custom_live_model_fixture";
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "new-live-model" }]
            })))
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": { "role": "assistant", "content": "OK" }
                }]
            })))
            .mount(&model_server)
            .await;
        let providers_dir = config_dir.join("custom_providers");
        std::fs::create_dir_all(&providers_dir).unwrap();
        std::fs::write(
            providers_dir.join(format!("{provider_id}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "name": provider_id,
                "engine": "openai",
                "display_name": "Live Model Fixture",
                "description": "Tests a provider whose model changed after it was saved",
                "api_key_env": "",
                "base_url": model_server.uri(),
                "models": [{
                    "name": "old-saved-model",
                    "context_limit": 128000
                }],
                "supports_streaming": false,
                "requires_auth": false,
                "setup_steps": [],
                "preserves_thinking": true
            }))
            .unwrap(),
        )
        .unwrap();

        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(deterministic_provider_factory()),
                ..Default::default()
            },
            openai,
        )
        .await;
        let data_root = conn.data_root();
        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.clone();

        conn.set_config_option(
            &session_id,
            "provider_model",
            &serde_json::json!({
                "providerId": provider_id,
                "modelId": "new-live-model",
            })
            .to_string(),
        )
        .await
        .expect("the live custom model should not be rejected by the saved stale catalog");

        let persisted = SessionManager::new(data_root)
            .get_session(&session_id, false)
            .await
            .unwrap();
        assert_eq!(persisted.provider_name.as_deref(), Some(provider_id));
        assert_eq!(
            persisted
                .model_config
                .as_ref()
                .map(|model| model.model_name.as_str()),
            Some("new-live-model")
        );
    });
}

#[test]
#[serial]
fn test_session_switch_rejects_cross_provider_stale_model_transactionally() {
    let _env = env_lock::lock_env([("ANTHROPIC_API_KEY", Some("test-key"))]);
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let config = TestConnectionConfig {
            data_root: config_dir,
            provider_factory: Some(deterministic_provider_factory()),
            ..Default::default()
        };
        let mut conn = AcpServerConnection::new(config, openai).await;
        let data_root = conn.data_root();
        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.clone();
        let defaults_bytes_before = std::fs::read(&config_path).unwrap();

        let error = conn
            .set_config_option(
                &session_id,
                "provider_model",
                &serde_json::json!({
                    "providerId": "anthropic",
                    "modelId": "gpt-4o",
                })
                .to_string(),
            )
            .await
            .expect_err("a model from the previous provider must be rejected");

        assert!(error.to_string().contains("is not available for provider"));

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/read",
            serde_json::json!({}),
        )
        .await
        .expect("failed switch must preserve the old defaults");
        assert_eq!(
            response,
            serde_json::json!({
                "providerId": "openai",
                "modelId": "gpt-4o",
            })
        );

        let persisted = SessionManager::new(data_root)
            .get_session(&session_id, false)
            .await
            .expect("failed switch must preserve the persisted session");
        assert_eq!(persisted.provider_name.as_deref(), Some("openai"));
        assert_eq!(
            persisted
                .model_config
                .as_ref()
                .map(|model| model.model_name.as_str()),
            Some("gpt-4o")
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), defaults_bytes_before);
    });
}

#[test]
#[serial]
fn test_session_switch_provider_construction_failure_rolls_back_defaults_and_session() {
    let _env = env_lock::lock_env([("ANTHROPIC_API_KEY", Some("test-key"))]);
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let config = TestConnectionConfig {
            data_root: config_dir,
            provider_factory: Some(failing_anthropic_provider_factory()),
            ..Default::default()
        };
        let mut conn = AcpServerConnection::new(config, openai).await;
        let data_root = conn.data_root();
        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.clone();
        let defaults_bytes_before = std::fs::read(&config_path).unwrap();

        conn.set_config_option(
            &session_id,
            "provider_model",
            &serde_json::json!({
                "providerId": "anthropic",
                "modelId": "claude-sonnet-4-5",
                "thinkingEffort": "high",
            })
            .to_string(),
        )
        .await
        .expect_err("provider construction failure must reject the switch");

        let defaults = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/read",
            serde_json::json!({}),
        )
        .await
        .expect("failed switch must preserve defaults");
        assert_eq!(
            defaults,
            serde_json::json!({
                "providerId": "openai",
                "modelId": "gpt-4o",
            })
        );

        let persisted = SessionManager::new(data_root)
            .get_session(&session_id, false)
            .await
            .expect("failed switch must preserve the session");
        assert_eq!(persisted.provider_name.as_deref(), Some("openai"));
        let model = persisted.model_config.expect("session model");
        assert_eq!(model.model_name, "gpt-4o");
        assert_ne!(
            model
                .request_params
                .as_ref()
                .and_then(|params| params.get("thinking_effort"))
                .and_then(serde_json::Value::as_str),
            Some("high")
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), defaults_bytes_before);
    });
}

#[test]
#[serial]
fn test_custom_dictation_secret_save_delete() {
    let _env = env_lock::lock_env([
        ("GOOSE_DISABLE_KEYRING", Some("1")),
        ("GROQ_API_KEY", None::<&str>),
    ]);
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nGOOSE_DISABLE_KEYRING: true\n",
    );

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let config = TestConnectionConfig {
            data_root: config_dir.clone(),
            ..Default::default()
        };
        let conn = AcpServerConnection::new(config, openai).await;

        send_custom(
            conn.cx(),
            "_goose/unstable/dictation/secret/save",
            serde_json::json!({
                "provider": "groq",
                "value": "groq-key",
            }),
        )
        .await
        .expect("dictation secret save should succeed");

        let config = send_custom(
            conn.cx(),
            "_goose/unstable/dictation/config",
            serde_json::json!({}),
        )
        .await
        .expect("dictation config should succeed");
        assert_eq!(
            config
                .pointer("/providers/groq/configured")
                .and_then(|value| value.as_bool()),
            Some(true)
        );

        let provider_config_result = send_custom(
            conn.cx(),
            "_goose/unstable/dictation/secret/save",
            serde_json::json!({
                "provider": "openai",
                "value": "openai-key",
            }),
        )
        .await;
        assert!(
            provider_config_result.is_err(),
            "provider-config dictation providers should be rejected"
        );

        let unknown_result = send_custom(
            conn.cx(),
            "_goose/unstable/dictation/secret/save",
            serde_json::json!({
                "provider": "unknown",
                "value": "key",
            }),
        )
        .await;
        assert!(
            unknown_result.is_err(),
            "unknown provider should be rejected"
        );

        send_custom(
            conn.cx(),
            "_goose/unstable/dictation/secret/delete",
            serde_json::json!({
                "provider": "groq",
            }),
        )
        .await
        .expect("dictation secret delete should succeed");

        let config = send_custom(
            conn.cx(),
            "_goose/unstable/dictation/config",
            serde_json::json!({}),
        )
        .await
        .expect("dictation config should succeed");
        assert_eq!(
            config
                .pointer("/providers/groq/configured")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    });
}

#[test]
#[serial]
fn test_raw_config_and_secret_methods_are_removed() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        for method in [
            "_goose/config/read",
            "_goose/config/upsert",
            "_goose/config/remove",
            "_goose/secret/check",
            "_goose/secret/upsert",
            "_goose/secret/remove",
        ] {
            let result = send_custom(conn.cx(), method, serde_json::json!({})).await;
            assert!(result.is_err(), "{method} should be removed");
        }
    });
}

#[test]
#[serial]
fn test_provider_switching_updates_session_state() {
    let _env = env_lock::lock_env([("ANTHROPIC_API_KEY", Some("test-key"))]);
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let config = TestConnectionConfig {
            data_root: config_dir,
            current_model: "gpt-4o".to_string(),
            provider_factory: Some(deterministic_provider_factory()),
            ..Default::default()
        };
        let mut conn = AcpServerConnection::new(config, openai).await;
        let data_root = conn.data_root();

        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.clone();
        let defaults_bytes_before = std::fs::read(&config_path).unwrap();

        conn.set_config_option(
            &session_id,
            "provider_model",
            &serde_json::json!({
                "providerId": "anthropic",
                "modelId": "claude-sonnet-4-5",
                "thinkingEffort": "high",
            })
            .to_string(),
        )
        .await
        .expect("provider switch to anthropic should succeed");

        let defaults = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/read",
            serde_json::json!({}),
        )
        .await
        .expect("session switch must leave global defaults readable");
        assert_eq!(
            defaults,
            serde_json::json!({
                "providerId": "openai",
                "modelId": "gpt-4o",
            })
        );
        assert_eq!(
            std::fs::read(&config_path).unwrap(),
            defaults_bytes_before,
            "session-scoped provider_model must not rewrite global defaults"
        );

        let persisted = SessionManager::new(data_root)
            .get_session(&session_id, false)
            .await
            .expect("provider switch must update the persisted session");
        assert_eq!(persisted.provider_name.as_deref(), Some("anthropic"));
        assert_eq!(
            persisted
                .model_config
                .as_ref()
                .map(|model| model.model_name.as_str()),
            Some("claude-sonnet-4-5")
        );
        assert_eq!(
            persisted
                .model_config
                .as_ref()
                .and_then(|model| model.request_params.as_ref())
                .and_then(|params| params.get("thinking_effort"))
                .and_then(serde_json::Value::as_str),
            Some("high")
        );
    });
}

#[test]
#[serial]
fn test_custom_unknown_method() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let result = send_custom(conn.cx(), "_unknown/method", serde_json::json!({})).await;
        assert!(result.is_err(), "expected method_not_found error");
    });
}

#[test]
#[serial]
fn onboarding_import_apply_rejects_candidate_that_was_not_scanned() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);
    let secrets_path = config_dir.join("secrets.yaml");

    let source = tempfile::tempdir().unwrap();
    let source_config = source.path().join("config.yaml");
    std::fs::write(
        &source_config,
        "GOOSE_PROVIDER: zai\nGOOSE_MODEL: glm-5.2\n",
    )
    .unwrap();
    std::fs::write(
        source.path().join("secrets.yaml"),
        "ZHIPU_API_KEY: onboarding-import-canary\n",
    )
    .unwrap();

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir.clone(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let config_before = std::fs::read(&config_path).unwrap();
        let secrets_before = std::fs::read(&secrets_path).ok();

        let result = send_custom(
            conn.cx(),
            "_goose/unstable/onboarding/import/apply",
            serde_json::json!({
                "scanId": "fabricated-scan-authorization",
                "candidateIds": [format!("goose_config:{}", source_config.display())],
                "enableImportedExtensions": false,
            }),
        )
        .await;

        assert!(
            result.is_err(),
            "apply without a fresh scan must be rejected"
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), config_before);
        assert_eq!(std::fs::read(&secrets_path).ok(), secrets_before);
    });
}

#[test]
#[serial]
fn onboarding_import_scan_authorization_is_one_use_and_allows_safe_legacy_config() {
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: current\nGOOSE_PROVIDER: claude-acp\nGOOSE_DISABLE_KEYRING: true\n",
    );

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;

        let scan = send_custom(
            conn.cx(),
            "_goose/unstable/onboarding/import/scan",
            serde_json::json!({"sources": ["goose_config"]}),
        )
        .await
        .expect("scan should return an authorization");
        let scan_id = scan["scanId"].as_str().unwrap();
        let candidate_id = scan["candidates"][0]["id"].as_str().unwrap();
        let request = serde_json::json!({
            "scanId": scan_id,
            "candidateIds": [candidate_id],
            "enableImportedExtensions": false,
        });

        send_custom(
            conn.cx(),
            "_goose/unstable/onboarding/import/apply",
            request.clone(),
        )
        .await
        .expect("a scanned safe legacy config should import");
        assert!(send_custom(
            conn.cx(),
            "_goose/unstable/onboarding/import/apply",
            request,
        )
        .await
        .is_err());
    });
}

#[test]
#[serial]
fn onboarding_import_rejects_unsupported_provider_before_any_persistence() {
    let config_dir = write_acp_global_config(
        "GOOSE_MODEL: glm-5.2\nGOOSE_PROVIDER: zai\nGOOSE_DISABLE_KEYRING: true\n",
    );
    let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);
    let secrets_path = config_dir.join("secrets.yaml");
    std::fs::write(&secrets_path, "ZHIPU_API_KEY: onboarding-zai-canary\n").unwrap();

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;
        let config_before = std::fs::read(&config_path).unwrap();
        let secrets_before = std::fs::read(&secrets_path).unwrap();

        let scan = send_custom(
            conn.cx(),
            "_goose/unstable/onboarding/import/scan",
            serde_json::json!({"sources": ["goose_config"]}),
        )
        .await
        .unwrap();
        let result = send_custom(
            conn.cx(),
            "_goose/unstable/onboarding/import/apply",
            serde_json::json!({
                "scanId": scan["scanId"],
                "candidateIds": [scan["candidates"][0]["id"]],
                "enableImportedExtensions": false,
            }),
        )
        .await;

        assert!(result.is_err());
        assert_eq!(std::fs::read(&config_path).unwrap(), config_before);
        assert_eq!(std::fs::read(&secrets_path).unwrap(), secrets_before);
    });
}

#[test]
#[serial]
fn test_developer_fs_requests_use_acp_session_id() {
    run_test(async {
        let seen_session_id = Arc::new(Mutex::new(None::<String>));
        let seen_session_id_clone = Arc::clone(&seen_session_id);
        let openai = OpenAiFixture::new_matching(
            vec![
                (
                    OpenAiRequestMatcher::Contains(
                        "Use the read tool to read /tmp/test_acp_read.txt and output only its contents."
                            .to_string(),
                    ),
                    include_str!("acp_test_data/openai_fs_read_tool_call.txt"),
                ),
                (
                    OpenAiRequestMatcher::ToolResults(vec![
                        "call_ihWQp56Fq7txY7HHZJiNwzdy".to_string(),
                    ]),
                    include_str!("acp_test_data/openai_fs_read_tool_result.txt"),
                ),
            ],
            Arc::new(IgnoreSessionId),
        )
        .await;
        let config_dir = write_acp_global_config(&format!(
            "GOOSE_MODEL: gpt-4.1\nGOOSE_PROVIDER: openai\nOPENAI_HOST: {}\n",
            openai.uri()
        ));
        let config = TestConnectionConfig {
            // gpt-5-nano routes to the Responses API; use a Chat Completions
            // model so the canned SSE fixtures are parsed correctly.
            data_root: config_dir,
            current_model: "gpt-4.1".to_string(),
            read_text_file: Some(Arc::new(move |req| {
                *seen_session_id_clone.lock().unwrap() = Some(req.session_id.0.to_string());
                Ok(
                    agent_client_protocol::schema::v1::ReadTextFileResponse::new(
                        "test-read-content-12345",
                    ),
                )
            })),
            ..Default::default()
        };
        let mut conn = AcpServerConnection::new(config, openai).await;

        let SessionData { mut session, .. } = conn.new_session().await.unwrap();
        let acp_session_id = session.session_id().0.to_string();

        let output = session
            .prompt(
                "Use the read tool to read /tmp/test_acp_read.txt and output only its contents.",
                PermissionDecision::AllowOnce,
            )
            .await
            .expect("prompt should succeed");

        assert_eq!(output.text, "test-read-content-12345");
        assert_eq!(
            output.tool_status,
            Some(agent_client_protocol::schema::v1::ToolCallStatus::Completed),
        );
        assert_eq!(
            seen_session_id.lock().unwrap().as_deref(),
            Some(acp_session_id.as_str()),
            "ACP read request should use the ACP session/thread ID",
        );
    });
}

#[test]
#[serial]
fn test_custom_provider_supported_models_lists_raw_provider_models() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let provider_factory: AcpProviderFactory =
            Arc::new(|provider_name, _extensions, _working_dir| {
                Box::pin(async move {
                    Ok(Arc::new(MockProvider {
                        name: provider_name,
                        recommended_models: vec!["canonical-filtered-model".to_string()],
                        supported_models: vec![
                            "goose-claude-opus-4-8".to_string(),
                            "raw-databricks-endpoint".to_string(),
                        ],
                    }) as Arc<dyn Provider>)
                })
            });
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/providers/supported-models/list",
            serde_json::json!({ "providerId": "openai" }),
        )
        .await
        .expect("provider supported models list should succeed");

        assert_eq!(
            response.get("providerId"),
            Some(&serde_json::json!("openai"))
        );
        assert_eq!(
            response.get("models"),
            Some(&serde_json::json!([
                "goose-claude-opus-4-8",
                "raw-databricks-endpoint"
            ]))
        );
    });
}

#[test]
#[serial]
fn test_custom_provider_discovery_lists_ollama_models_without_persisting() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": [
                    { "name": "qwen3-coder" },
                    { "name": "deepseek-r1" },
                    { "name": "qwen3-coder" }
                ]
            })))
            .expect(1)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "OK" } }]
            })))
            .expect(0)
            .mount(&model_server)
            .await;
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "engine": "ollama_compatible",
                "apiUrl": model_server.uri(),
                "headers": {}
            }),
        )
        .await
        .expect("unpersisted Ollama discovery should succeed");

        assert_eq!(
            response.get("models"),
            Some(&serde_json::json!(["deepseek-r1", "qwen3-coder"]))
        );
    });
}

#[test]
#[serial]
fn test_unauthenticated_ollama_custom_provider_create_and_activation_require_live_validation() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let unavailable_listener = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("reserve an unavailable local address");
        let unavailable_url = format!(
            "http://{}",
            unavailable_listener
                .local_addr()
                .expect("read the unavailable local address")
        );
        drop(unavailable_listener);

        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": [{ "name": "local-ollama-model" }]
            })))
            .expect(2)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_json(serde_json::json!({
                "model": "local-ollama-model",
                "messages": [{ "role": "user", "content": "Reply OK." }],
                "max_tokens": 1,
                "stream": false
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "OK" } }]
            })))
            .expect(2)
            .mount(&model_server)
            .await;

        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;
        let direct_save_error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "ollama_compatible",
                "displayName": "Unreachable Local Connection",
                "apiUrl": unavailable_url,
                "models": ["local-ollama-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": false
            }),
        )
        .await
        .expect_err("an unauthenticated provider cannot bypass live validation on save");
        assert!(direct_save_error
            .to_string()
            .contains("custom_provider_endpoint_unreachable"));

        let created = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "ollama_compatible",
                "displayName": "Ollama Activation Fixture",
                "apiUrl": model_server.uri(),
                "models": ["local-ollama-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": false
            }),
        )
        .await
        .expect("a live unauthenticated Ollama connection should be saved");
        let provider_id = created
            .get("providerId")
            .and_then(serde_json::Value::as_str)
            .expect("created Ollama provider id");

        let changed_config_error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/update",
            serde_json::json!({
                "providerId": provider_id,
                "engine": "ollama_compatible",
                "displayName": "Ollama Activation Fixture",
                "apiUrl": unavailable_url,
                "models": ["local-ollama-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": false
            }),
        )
        .await
        .expect_err("a changed endpoint must invalidate the prior successful validation");
        assert!(changed_config_error
            .to_string()
            .contains("custom_provider_endpoint_unreachable"));

        let activated = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": provider_id,
                "modelId": "local-ollama-model"
            }),
        )
        .await
        .expect("the unchanged saved Ollama connection should activate");
        assert_eq!(
            activated,
            serde_json::json!({
                "providerId": provider_id,
                "modelId": "local-ollama-model"
            })
        );
        println!(
            "OLLAMA_HTTP_EVIDENCE GET /api/tags -> 200; POST /v1/chat/completions -> 200; model=local-ollama-model; stream=false"
        );

        send_custom(
            conn.cx(),
            "_goose/unstable/defaults/clear",
            serde_json::json!({}),
        )
        .await
        .expect("clear the active Ollama provider before cleanup");
        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/delete",
            serde_json::json!({ "providerId": provider_id }),
        )
        .await
        .expect("remove the Ollama acceptance provider");
    });
}

#[test]
#[serial]
fn test_custom_provider_discovery_uses_openai_models_endpoint_and_auth() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(header("authorization", "Bearer local-test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [
                    { "id": "local-coder" },
                    { "id": "local-reviewer" }
                ]
            })))
            .expect(1)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer local-test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "OK" } }]
            })))
            .expect(0)
            .mount(&model_server)
            .await;
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "engine": "openai_compatible",
                "apiUrl": model_server.uri(),
                "requiresAuth": true,
                "apiKey": "local-test-key",
                "headers": {}
            }),
        )
        .await
        .expect("unpersisted OpenAI-compatible discovery should succeed");

        assert_eq!(
            response.get("models"),
            Some(&serde_json::json!(["local-coder", "local-reviewer"]))
        );
    });
}

#[test]
#[serial]
fn test_custom_provider_save_rejects_an_invalid_key_when_models_are_public() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "public-catalog-model" }]
            })))
            .expect(2)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer definitely-wrong"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "message": "remote details must not be surfaced" }
            })))
            .expect(1)
            .mount(&model_server)
            .await;
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let catalog = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "engine": "openai_compatible",
                "apiUrl": model_server.uri(),
                "requiresAuth": true,
                "apiKey": "definitely-wrong",
                "headers": {}
            }),
        )
        .await
        .expect("a public catalog can be displayed before credential validation on save");
        assert_eq!(
            catalog["models"],
            serde_json::json!(["public-catalog-model"])
        );
        assert_eq!(model_server.received_requests().await.unwrap().len(), 1);

        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "openai_compatible",
                "displayName": "Rejected Provider Fixture",
                "models": ["public-catalog-model"],
                "supportsStreaming": false,
                "apiUrl": model_server.uri(),
                "requiresAuth": true,
                "apiKey": "definitely-wrong",
                "headers": {}
            }),
        )
        .await
        .expect_err("a public model catalog must not make an invalid key look valid");

        let rendered = error.to_string();
        assert!(rendered.contains("custom_provider_invalid_credentials"));
        assert!(!rendered.contains("remote details"));
        assert!(!rendered.contains("definitely-wrong"));
    });
}

#[test]
#[serial]
fn test_custom_provider_discovery_does_not_probe_broken_first_model_and_saves_selected_model() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/models"))
            .and(header("authorization", "Bearer gateway-fixture-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "ollama-dev" }, { "id": "gemini-3.6-flash" }]
            })))
            .expect(3)
            .mount(&model_server)
            .await;
        for (model, status) in [("gemini-3.6-flash", 502), ("ollama-dev", 200)] {
            Mock::given(method("POST"))
                .and(path("/api/v1/chat/completions"))
                .and(header("authorization", "Bearer gateway-fixture-key"))
                .and(body_json(serde_json::json!({
                    "model": model,
                    "messages": [{ "role": "user", "content": "Reply OK." }],
                    "max_tokens": 1,
                    "stream": false
                })))
                .respond_with(
                    ResponseTemplate::new(status).set_body_json(serde_json::json!({
                        "choices": [{ "message": { "role": "assistant", "content": "OK" } }]
                    })),
                )
                .expect(1)
                .mount(&model_server)
                .await;
        }
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;
        let mut params = serde_json::json!({
            "engine": "openai_compatible",
            "apiUrl": format!("{}/api/v1", model_server.uri()),
            "apiKey": "gateway-fixture-key",
            "requiresAuth": true,
            "headers": {}
        });
        let catalog = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            params.clone(),
        )
        .await
        .expect("a broken first model must not hide the catalog");
        assert_eq!(
            catalog["models"],
            serde_json::json!(["gemini-3.6-flash", "ollama-dev"])
        );
        let discovery_requests = model_server.received_requests().await.unwrap();
        assert_eq!(discovery_requests.len(), 1);
        assert_eq!(discovery_requests[0].method, "GET");

        params["displayName"] = serde_json::json!("Mixed Gateway Fixture");
        params["supportsStreaming"] = serde_json::json!(false);
        params["models"] = serde_json::json!(["gemini-3.6-flash", "ollama-dev"]);
        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            params.clone(),
        )
        .await
        .expect_err("explicitly selecting the broken model must fail validation");
        assert!(error
            .to_string()
            .contains("custom_provider_model_unavailable"));
        params["models"] = serde_json::json!(["ollama-dev", "gemini-3.6-flash"]);
        let created = send_custom(conn.cx(), "_goose/unstable/providers/custom/create", params)
            .await
            .expect("the healthy selected model must be saved despite another model failing");
        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/delete",
            serde_json::json!({
                "providerId": created["providerId"]
            }),
        )
        .await
        .expect("remove the mixed gateway fixture");
    });
}

#[test]
#[serial]
fn test_custom_provider_save_rejects_a_non_completion_success_response() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "listed-but-unusable" }]
            })))
            .expect(1)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer accepted-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "status": "ok"
            })))
            .expect(1)
            .mount(&model_server)
            .await;
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "openai_compatible",
                "displayName": "Rejected Provider Fixture",
                "models": ["listed-but-unusable"],
                "supportsStreaming": false,
                "apiUrl": model_server.uri(),
                "requiresAuth": true,
                "apiKey": "accepted-key",
                "headers": {}
            }),
        )
        .await
        .expect_err("a 200 response without a completion must not be reported as usable");

        assert!(error
            .to_string()
            .contains("custom_provider_model_unavailable"));
    });
}

#[test]
#[serial]
fn test_custom_provider_discovery_reports_no_local_models_without_attempting_completion() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "models": []
            })))
            .expect(1)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&model_server)
            .await;
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "engine": "ollama_compatible",
                "apiUrl": model_server.uri(),
                "requiresAuth": false,
                "headers": {}
            }),
        )
        .await
        .expect_err("a reachable local service without models must not pass");
        assert!(error.to_string().contains("custom_provider_no_models"));
    });
}

#[test]
#[serial]
fn test_custom_provider_save_reports_model_request_failure() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "temporarily-unavailable" }]
            })))
            .expect(1)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&model_server)
            .await;
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "openai_compatible",
                "displayName": "Rejected Provider Fixture",
                "models": ["temporarily-unavailable"],
                "supportsStreaming": false,
                "apiUrl": model_server.uri(),
                "requiresAuth": false,
                "headers": {}
            }),
        )
        .await
        .expect_err("a listed model that cannot answer must not pass");
        assert!(error
            .to_string()
            .contains("custom_provider_model_unavailable"));
    });
}

#[test]
#[serial]
fn test_custom_provider_discovery_rejects_invalid_and_oversized_model_lists() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        for (body, expected_code) in [
            (b"not-json".to_vec(), "custom_provider_invalid_response"),
            (
                vec![b'x'; 2 * 1024 * 1024 + 1],
                "custom_provider_response_too_large",
            ),
        ] {
            let model_server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path("/v1/models"))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
                .expect(1)
                .mount(&model_server)
                .await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(500))
                .expect(0)
                .mount(&model_server)
                .await;
            let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
            let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

            let error = send_custom(
                conn.cx(),
                "_goose/unstable/providers/custom/discover-models",
                serde_json::json!({
                    "engine": "openai_compatible",
                    "apiUrl": model_server.uri(),
                    "requiresAuth": false,
                    "headers": {}
                }),
            )
            .await
            .expect_err("an invalid model-list response must not pass");
            assert!(error.to_string().contains(expected_code));
        }
    });
}

#[test]
#[serial]
fn test_custom_provider_discovery_reports_an_unreachable_address() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("reserve an unused local port for the unreachable-address test");
        let unavailable_uri = format!(
            "http://{}",
            listener
                .local_addr()
                .expect("read the reserved local address")
        );
        drop(listener);
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "engine": "openai_compatible",
                "apiUrl": unavailable_uri,
                "requiresAuth": false,
                "headers": {}
            }),
        )
        .await
        .expect_err("an unreachable address must not pass");
        assert!(
            error
                .to_string()
                .contains("custom_provider_endpoint_unreachable"),
            "unexpected error: {error}"
        );
    });
}

#[test]
#[serial]
fn test_authenticated_custom_provider_create_retest_edit_and_delete_lifecycle() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let provider_id = "custom_credential_lifecycle_fixture";
        let provider_path = config_dir
            .join("custom_providers")
            .join(format!("{provider_id}.json"));
        let _ = std::fs::remove_file(&provider_path);

        let model_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": "lifecycle-model" }]
            })))
            .expect(4)
            .mount(&model_server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "OK" } }]
            })))
            .expect(3)
            .mount(&model_server)
            .await;

        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;
        let created = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "openai_compatible",
                "displayName": "Credential Lifecycle Fixture",
                "apiUrl": model_server.uri(),
                "apiKey": "lifecycle-key",
                "models": ["lifecycle-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": true
            }),
        )
        .await
        .expect("a verified authenticated provider should be created");
        assert_eq!(
            created.get("providerId"),
            Some(&serde_json::json!(provider_id))
        );

        let saved_json = std::fs::read_to_string(&provider_path).unwrap();
        assert!(!saved_json.contains("lifecycle-key"));
        let key_name = goose::config::declarative_providers::generate_scoped_api_key_name(
            provider_id,
            &model_server.uri(),
        )
        .unwrap();
        assert!(saved_json.contains(&key_name));
        goose::config::Config::global().invalidate_secrets_cache();
        assert_eq!(
            goose::config::Config::global()
                .get_secret::<String>(&key_name)
                .unwrap(),
            "lifecycle-key"
        );

        let read = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/read",
            serde_json::json!({ "providerId": provider_id }),
        )
        .await
        .expect("the saved provider should be readable");
        assert_eq!(
            read.pointer("/provider/apiKeySet"),
            Some(&serde_json::json!(true))
        );

        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "providerId": provider_id,
                "engine": "openai_compatible",
                "apiUrl": model_server.uri(),
                "requiresAuth": true,
                "headers": {}
            }),
        )
        .await
        .expect("retesting an unchanged provider should reuse its stored key");

        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/update",
            serde_json::json!({
                "providerId": provider_id,
                "engine": "openai_compatible",
                "displayName": "Credential Lifecycle Updated",
                "apiUrl": model_server.uri(),
                "models": ["lifecycle-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": true
            }),
        )
        .await
        .expect("updating an unchanged endpoint should keep and verify the stored key");

        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/update",
            serde_json::json!({
                "providerId": provider_id,
                "engine": "openai_compatible",
                "displayName": "Credential Lifecycle Without Auth",
                "apiUrl": model_server.uri(),
                "models": ["lifecycle-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": false
            }),
        )
        .await
        .expect("switching an existing connection to no authentication should succeed");
        goose::config::Config::global().invalidate_secrets_cache();
        assert!(goose::config::Config::global()
            .get_secret::<String>(&key_name)
            .is_err());
        let completion_requests = model_server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|request| request.url.path() == "/v1/chat/completions")
            .collect::<Vec<_>>();
        assert_eq!(completion_requests.len(), 3);
        assert!(completion_requests[..2].iter().all(|request| {
            request
                .headers
                .get("authorization")
                .is_some_and(|value| value.to_str().ok() == Some("Bearer lifecycle-key"))
        }));
        assert!(completion_requests[2]
            .headers
            .get("authorization")
            .is_none());

        let missing_key_after_reenable = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/update",
            serde_json::json!({
                "providerId": provider_id,
                "engine": "openai_compatible",
                "displayName": "Credential Lifecycle Reauth",
                "apiUrl": model_server.uri(),
                "models": ["lifecycle-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": true
            }),
        )
        .await
        .expect_err("turning authentication back on requires a new key");
        assert!(missing_key_after_reenable
            .to_string()
            .contains("custom_provider_api_key_required"));

        let changed_origin_error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/update",
            serde_json::json!({
                "providerId": provider_id,
                "engine": "openai_compatible",
                "displayName": "Must Reenter Key",
                "apiUrl": "https://changed.example.invalid/v1",
                "models": ["lifecycle-model"],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": true
            }),
        )
        .await
        .expect_err("a stored key must never be sent to a changed origin");
        assert!(changed_origin_error
            .to_string()
            .contains("custom_provider_api_key_required"));

        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/delete",
            serde_json::json!({ "providerId": provider_id }),
        )
        .await
        .expect("the custom provider should be deletable");
        assert!(!provider_path.exists());
        goose::config::Config::global().invalidate_secrets_cache();
        assert!(goose::config::Config::global()
            .get_secret::<String>(&key_name)
            .is_err());
    });
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RealHttpProviderTrace {
    method: &'static str,
    path: &'static str,
    credential_valid: bool,
    model: Option<String>,
    streaming: Option<bool>,
}

#[derive(Clone)]
struct RealHttpProviderState {
    traces: Arc<Mutex<Vec<RealHttpProviderTrace>>>,
}

fn real_http_credential_valid(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some("Bearer real-http-acceptance-key")
}

async fn real_http_models(
    axum::extract::State(state): axum::extract::State<RealHttpProviderState>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    let credential_valid = real_http_credential_valid(&headers);
    state.traces.lock().unwrap().push(RealHttpProviderTrace {
        method: "GET",
        path: "/v1/models",
        credential_valid,
        model: None,
        streaming: None,
    });
    if !credential_valid {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({ "error": { "message": "invalid credential" } })),
        )
            .into_response();
    }
    axum::Json(serde_json::json!({
        "object": "list",
        "data": [{ "id": "real-http-model" }]
    }))
    .into_response()
}

async fn real_http_completion(
    axum::extract::State(state): axum::extract::State<RealHttpProviderState>,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    let credential_valid = real_http_credential_valid(&headers);
    state.traces.lock().unwrap().push(RealHttpProviderTrace {
        method: "POST",
        path: "/v1/chat/completions",
        credential_valid,
        model: body
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        streaming: body.get("stream").and_then(serde_json::Value::as_bool),
    });
    if !credential_valid {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({ "error": { "message": "invalid credential" } })),
        )
            .into_response();
    }
    axum::Json(serde_json::json!({
        "id": "chatcmpl-real-http-acceptance",
        "object": "chat.completion",
        "model": "real-http-model",
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": "connected" }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
    }))
    .into_response()
}

#[test]
#[serial]
fn test_custom_provider_real_local_http_discovery_inference_and_stored_key_retest() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let traces = Arc::new(Mutex::new(Vec::new()));
        let state = RealHttpProviderState {
            traces: Arc::clone(&traces),
        };
        let app = axum::Router::new()
            .route("/v1/models", axum::routing::get(real_http_models))
            .route(
                "/v1/chat/completions",
                axum::routing::post(real_http_completion),
            )
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the real local HTTP provider");
        let base_url = format!(
            "http://{}",
            listener
                .local_addr()
                .expect("read the local provider address")
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve the real local HTTP provider");
        });

        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let conn = AcpServerConnection::new(TestConnectionConfig::default(), openai).await;

        let invalid = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "engine": "openai_compatible",
                "apiUrl": base_url,
                "requiresAuth": true,
                "apiKey": "wrong-key",
                "headers": {}
            }),
        )
        .await
        .expect_err("a real HTTP endpoint must reject the wrong key");
        assert!(invalid
            .to_string()
            .contains("custom_provider_invalid_credentials"));

        let discovered = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "engine": "openai_compatible",
                "apiUrl": base_url,
                "requiresAuth": true,
                "apiKey": "real-http-acceptance-key",
                "headers": {}
            }),
        )
        .await
        .expect("discover models without running an arbitrary model");
        assert_eq!(
            discovered.get("models"),
            Some(&serde_json::json!(["real-http-model"]))
        );

        let created = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "openai_compatible",
                "displayName": "Real HTTP Acceptance",
                "apiUrl": base_url,
                "apiKey": "real-http-acceptance-key",
                "models": ["real-http-model"],
                "supportsStreaming": false,
                "headers": {},
                "requiresAuth": true
            }),
        )
        .await
        .expect("save the provider after real endpoint validation");
        let provider_id = created
            .get("providerId")
            .and_then(serde_json::Value::as_str)
            .expect("created provider id");

        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/discover-models",
            serde_json::json!({
                "providerId": provider_id,
                "engine": "openai_compatible",
                "apiUrl": base_url,
                "requiresAuth": true,
                "headers": {}
            }),
        )
        .await
        .expect("reopen and retest with the origin-scoped stored key");

        let activated = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": provider_id,
                "modelId": "real-http-model"
            }),
        )
        .await
        .expect("a saved custom provider must activate after the same live validation");
        assert_eq!(
            activated,
            serde_json::json!({
                "providerId": provider_id,
                "modelId": "real-http-model"
            })
        );

        let recorded = traces.lock().unwrap().clone();
        assert_eq!(recorded.len(), 7);
        assert_eq!(recorded[0].method, "GET");
        assert!(!recorded[0].credential_valid);
        assert!(recorded[1..].iter().all(|trace| trace.credential_valid));
        let completions = recorded
            .iter()
            .filter(|trace| trace.path == "/v1/chat/completions")
            .collect::<Vec<_>>();
        assert_eq!(completions.len(), 2);
        assert!(completions.iter().all(|trace| {
            trace.model.as_deref() == Some("real-http-model") && trace.streaming == Some(false)
        }));
        println!(
            "REAL_HTTP_EVIDENCE invalid GET /v1/models -> 401; valid requests -> 200; parsed model=real-http-model; sanitized_traces={recorded:?}"
        );

        send_custom(
            conn.cx(),
            "_goose/unstable/defaults/clear",
            serde_json::json!({}),
        )
        .await
        .expect("clear the active acceptance provider before cleanup");
        send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/delete",
            serde_json::json!({ "providerId": provider_id }),
        )
        .await
        .expect("remove the real HTTP acceptance provider");
        server.abort();
    });
}

#[test]
#[serial]
fn test_activation_disabled_provider_supported_models_makes_zero_factory_requests() {
    write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let factory_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_calls = Arc::clone(&factory_calls);
        let provider_factory: AcpProviderFactory =
            Arc::new(move |provider_name, _extensions, _working_dir| {
                observed_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Box::pin(async move {
                    Ok(Arc::new(MockProvider {
                        name: provider_name,
                        recommended_models: vec![],
                        supported_models: vec![],
                    }) as Arc<dyn Provider>)
                })
            });
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;

        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/supported-models/list",
            serde_json::json!({ "providerId": "zai" }),
        )
        .await
        .expect_err("activation-disabled provider discovery must fail closed");

        assert!(error
            .to_string()
            .contains("trusted credential validation endpoint"));
        assert_eq!(factory_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    });
}

#[test]
#[serial]
fn direct_git_tool_uses_the_session_working_directory() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let workspace = tempfile::tempdir().unwrap();
    let init = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(workspace.path())
        .status()
        .unwrap();
    assert!(init.success());
    let expected_root = std::fs::canonicalize(workspace.path()).unwrap();

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut conn = AcpServerConnection::new(
            TestConnectionConfig {
                cwd: Some(workspace),
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;
        let SessionData { session, .. } = conn.new_session().await.unwrap();

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/tools/call",
            serde_json::json!({
                "sessionId": session.session_id().0,
                "name": "git_status",
                "arguments": {},
            }),
        )
        .await
        .expect("direct git status request should return a tool response");

        assert_eq!(
            response["isError"], false,
            "unexpected response: {response}"
        );
        let content = response["content"][0]["text"]
            .as_str()
            .expect("git status should return JSON text");
        let status: serde_json::Value = serde_json::from_str(content).unwrap();
        assert_eq!(
            std::fs::canonicalize(status["repository_root"].as_str().unwrap()).unwrap(),
            expected_root
        );
    });
}

#[test]
#[serial]
fn direct_git_tool_returns_after_a_completed_prompt() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let workspace = tempfile::tempdir().unwrap();
    let init = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(workspace.path())
        .status()
        .unwrap();
    assert!(init.success());

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(IgnoreSessionId)).await;
        let provider_factory: AcpProviderFactory =
            Arc::new(|provider_name, _extensions, _working_dir| {
                Box::pin(async move {
                    Ok(Arc::new(CompletedPromptProvider {
                        name: provider_name,
                    }) as Arc<dyn Provider>)
                })
            });
        let mut conn = AcpServerConnection::new(
            TestConnectionConfig {
                cwd: Some(workspace),
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;
        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let acp_session_id = session.session_id().clone();

        let prompt = tokio::time::timeout(
            Duration::from_secs(3),
            conn.cx()
                .send_request(PromptRequest::new(
                    acp_session_id,
                    vec![ContentBlock::Text(TextContent::new("finish before git"))],
                ))
                .block_task(),
        )
        .await
        .expect("prompt should complete within the timeout")
        .expect("prompt should complete before the direct tool call");
        assert_eq!(prompt.stop_reason, StopReason::EndTurn);

        let response = tokio::time::timeout(
            Duration::from_secs(3),
            send_custom(
                conn.cx(),
                "_goose/unstable/tools/call",
                serde_json::json!({
                    "sessionId": session.session_id().0,
                    "name": "git_status",
                    "arguments": {},
                }),
            ),
        )
        .await
        .expect("direct Git status should not wait on a completed prompt")
        .expect("direct Git status should return a tool response");

        assert_eq!(
            response["isError"], false,
            "unexpected response: {response}"
        );
    });
}

#[test]
#[serial]
fn approved_direct_git_write_has_a_host_request_identity() {
    let config_dir = write_acp_global_config(DEFAULT_ACP_TEST_CONFIG);
    let workspace = tempfile::tempdir().unwrap();
    let run_git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(workspace.path())
            .status()
            .unwrap();
        assert!(status.success(), "git command failed: {args:?}");
    };
    run_git(&["init", "--quiet", "-b", "main"]);
    run_git(&["config", "user.email", "codepro-test@example.invalid"]);
    run_git(&["config", "user.name", "CodePro Test"]);
    std::fs::write(workspace.path().join("staged.txt"), "base\n").unwrap();
    run_git(&["add", "staged.txt"]);
    run_git(&["commit", "--quiet", "-m", "base"]);
    std::fs::write(workspace.path().join("staged.txt"), "changed\n").unwrap();
    run_git(&["add", "staged.txt"]);

    run_test(async move {
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut conn = AcpServerConnection::new(
            TestConnectionConfig {
                cwd: Some(workspace),
                data_root: config_dir,
                ..Default::default()
            },
            openai,
        )
        .await;
        let SessionData { session, .. } = conn.new_session().await.unwrap();

        send_custom(
            conn.cx(),
            "_goose/unstable/tools/permissions/set",
            serde_json::json!({
                "toolPermissions": [{
                    "toolName": "git_unstage",
                    "permission": "always_allow",
                }],
            }),
        )
        .await
        .expect("direct Git write permission should be configurable");

        let response = send_custom(
            conn.cx(),
            "_goose/unstable/tools/call",
            serde_json::json!({
                "sessionId": session.session_id().0,
                "name": "git_unstage",
                "arguments": { "paths": ["staged.txt"] },
            }),
        )
        .await
        .expect("approved direct Git write should have a host request identity");

        assert_eq!(
            response["isError"], false,
            "unexpected response: {response}"
        );
        let cached = std::process::Command::new("git")
            .args(["diff", "--cached", "--name-only"])
            .current_dir(session.work_dir())
            .output()
            .unwrap();
        assert!(cached.status.success());
        assert!(String::from_utf8(cached.stdout).unwrap().trim().is_empty());
    });
}
