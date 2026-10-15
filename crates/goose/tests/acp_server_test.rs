#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;
use agent_client_protocol::schema::v1::{
    ListSessionsRequest, ListSessionsResponse, NewSessionRequest, SessionConfigKind,
    SessionConfigOptionCategory, SessionConfigOptionValue, SessionInfo,
    SetSessionConfigOptionRequest,
};
use agent_client_protocol::ErrorCode;
use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{
    run_test, run_test_isolated_storage, Connection, OpenAiFixture, Session, TestConnectionConfig,
};
#[cfg(feature = "code-mode")]
use common_tests::run_prompt_codemode;
use common_tests::{
    run_close_session, run_config_mcp, run_config_option_mode_set, run_config_option_model_set,
    run_delete_session, run_fs_read_text_file_true, run_fs_write_text_file_false,
    run_fs_write_text_file_true, run_initialize_doesnt_hit_provider, run_list_sessions,
    run_load_mode, run_load_model, run_load_session_error, run_load_session_mcp,
    run_load_session_replays_image_attachment, run_mode_set, run_model_list, run_model_set,
    run_model_set_error_session_not_found, run_new_session_returns_initial_config,
    run_new_session_uses_current_config_mode, run_permission_persistence, run_prompt_basic,
    run_prompt_error, run_prompt_image, run_prompt_image_attachment, run_prompt_mcp,
    run_prompt_model_mismatch, run_prompt_skill, run_session_name_update_notification,
    run_shell_terminal_false, run_shell_terminal_true,
};
use goose::config::GooseMode;
use goose::conversation::message::{Message, MessageMetadata};
use goose::custom_requests::{GetSessionInfoRequest, GetSessionInfoResponse};
use goose::recipe::{Recipe, Settings};
use goose::recipe_deeplink;
use goose::session::{SessionManager, SessionType};
use std::path::Path;

include!("fixtures/acp_plain_continuation.rs");

tests_config_option_set_error!(AcpServerConnection);
tests_mode_set_error!(AcpServerConnection);

async fn seed_list_sessions(data_root: &Path, working_dir: &Path, count: usize) {
    let session_manager = SessionManager::new(data_root.to_path_buf());
    for index in 0..count {
        let session = session_manager
            .create_session(
                working_dir.to_path_buf(),
                format!("Seed session {index}"),
                SessionType::Acp,
                GooseMode::default(),
            )
            .await
            .unwrap();
        session_manager
            .add_message(&session.id, &Message::user().with_text("hello"))
            .await
            .unwrap();
    }
}

async fn seed_list_session_with_message(
    data_root: &Path,
    working_dir: &Path,
    name: &str,
    session_type: SessionType,
    message: &str,
) {
    let session_manager = SessionManager::new(data_root.to_path_buf());
    let session = session_manager
        .create_session(
            working_dir.to_path_buf(),
            name.to_string(),
            session_type,
            GooseMode::default(),
        )
        .await
        .unwrap();
    session_manager
        .add_message(&session.id, &Message::user().with_text(message))
        .await
        .unwrap();
}

async fn new_connection(data_root: &Path) -> AcpServerConnection {
    let openai = OpenAiFixture::new(
        vec![],
        <AcpServerConnection as Connection>::expected_session_id(),
    )
    .await;
    <AcpServerConnection as Connection>::new(
        TestConnectionConfig {
            data_root: data_root.to_path_buf(),
            ..Default::default()
        },
        openai,
    )
    .await
}

async fn list_sessions_request(
    conn: &AcpServerConnection,
    request: ListSessionsRequest,
) -> anyhow::Result<ListSessionsResponse> {
    conn.cx()
        .send_request(request)
        .block_task()
        .await
        .map_err(Into::into)
}

async fn get_session_info_request(
    conn: &AcpServerConnection,
    request: GetSessionInfoRequest,
) -> anyhow::Result<GetSessionInfoResponse> {
    conn.cx()
        .send_request(request)
        .block_task()
        .await
        .map_err(Into::into)
}

fn assert_invalid_params(error: anyhow::Error) {
    let acp_error = error.downcast::<agent_client_protocol::Error>().unwrap();
    assert_eq!(acp_error.code, ErrorCode::InvalidParams);
}

fn include_last_message_snippet_meta(
    value: serde_json::Value,
) -> serde_json::Map<String, serde_json::Value> {
    let mut goose = serde_json::Map::new();
    goose.insert("includeLastMessageSnippet".to_string(), value);

    let mut meta = serde_json::Map::new();
    meta.insert("goose".to_string(), serde_json::Value::Object(goose));
    meta
}

fn last_message_snippet(session: &SessionInfo) -> Option<&str> {
    session
        .meta
        .as_ref()
        .and_then(|meta| meta.get("lastMessageSnippet"))
        .and_then(serde_json::Value::as_str)
}

#[test]
fn test_config_mcp() {
    run_test(async { run_config_mcp::<AcpServerConnection>().await });
}

#[test]
fn test_config_option_mode_set() {
    run_test(async { run_config_option_mode_set::<AcpServerConnection>().await });
}

#[test]
fn test_list_sessions() {
    run_test(async { run_list_sessions::<AcpServerConnection>().await });
}

#[test]
fn test_list_sessions_emits_computed_snippet() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let cwd = Path::new("/tmp/acp-session-list-snippet");
        let session_manager = SessionManager::new(data_root.path().to_path_buf());
        let session = session_manager
            .create_session(
                cwd.to_path_buf(),
                "Live subtitle".to_string(),
                SessionType::Acp,
                GooseMode::default(),
            )
            .await
            .unwrap();
        session_manager
            .add_message(
                &session.id,
                &Message::user().with_text("**raw** _markdown_ subtitle"),
            )
            .await
            .unwrap();
        session_manager
            .add_message(
                &session.id,
                &Message::assistant()
                    .with_text("hidden newer text")
                    .with_metadata(MessageMetadata::agent_only()),
            )
            .await
            .unwrap();

        let conn = new_connection(data_root.path()).await;
        let response = list_sessions_request(
            &conn,
            ListSessionsRequest::new()
                .meta(include_last_message_snippet_meta(serde_json::Value::Null)),
        )
        .await
        .unwrap();

        assert_eq!(response.sessions.len(), 1);
        assert_eq!(last_message_snippet(&response.sessions[0]), None);

        let response = list_sessions_request(
            &conn,
            ListSessionsRequest::new().meta(include_last_message_snippet_meta(
                serde_json::Value::Bool(false),
            )),
        )
        .await
        .unwrap();

        assert_eq!(response.sessions.len(), 1);
        assert_eq!(last_message_snippet(&response.sessions[0]), None);

        let response = list_sessions_request(
            &conn,
            ListSessionsRequest::new().meta(include_last_message_snippet_meta(
                serde_json::Value::Bool(true),
            )),
        )
        .await
        .unwrap();

        assert_eq!(response.sessions.len(), 1);
        assert_eq!(
            last_message_snippet(&response.sessions[0]),
            Some("**raw** _markdown_ subtitle")
        );
    });
}

#[test]
fn test_list_sessions_pagination() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        seed_list_sessions(data_root.path(), Path::new("/tmp/acp-session-list"), 51).await;
        let conn = new_connection(data_root.path()).await;

        let first = list_sessions_request(&conn, ListSessionsRequest::new())
            .await
            .unwrap();
        assert_eq!(first.sessions.len(), 50);
        assert!(first
            .sessions
            .iter()
            .all(|session| last_message_snippet(session).is_none()));

        let second = list_sessions_request(
            &conn,
            ListSessionsRequest::new()
                .cursor(first.next_cursor.clone().unwrap())
                .meta(include_last_message_snippet_meta(serde_json::Value::Bool(
                    true,
                ))),
        )
        .await
        .unwrap();
        assert_eq!(second.sessions.len(), 1);
        assert!(second.next_cursor.is_none());
        assert_eq!(last_message_snippet(&second.sessions[0]), Some("hello"));

        let second_id = &second.sessions[0].session_id;
        assert!(first
            .sessions
            .iter()
            .all(|session| session.session_id != *second_id));
    });
}

#[test]
fn test_list_sessions_query_filters_results() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let cwd = Path::new("/tmp/acp-session-list");
        seed_list_session_with_message(
            data_root.path(),
            cwd,
            "Postgres session",
            SessionType::Acp,
            "Discuss Postgres migrations",
        )
        .await;
        seed_list_session_with_message(
            data_root.path(),
            cwd,
            "Mobile session",
            SessionType::Acp,
            "Plan the mobile release",
        )
        .await;
        let conn = new_connection(data_root.path()).await;

        let mut meta = serde_json::Map::new();
        meta.insert(
            "query".to_string(),
            serde_json::Value::String("postgres".to_string()),
        );
        let response = list_sessions_request(&conn, ListSessionsRequest::new().meta(meta))
            .await
            .unwrap();

        assert_eq!(response.sessions.len(), 1);
        assert_eq!(
            response.sessions[0].title.as_deref(),
            Some("Postgres session")
        );
        assert!(response.next_cursor.is_none());
    });
}

#[test]
fn test_list_sessions_types_override_filters_results() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let cwd = Path::new("/tmp/acp-session-list");
        seed_list_session_with_message(
            data_root.path(),
            cwd,
            "ACP session",
            SessionType::Acp,
            "ACP message",
        )
        .await;
        seed_list_session_with_message(
            data_root.path(),
            cwd,
            "User session",
            SessionType::User,
            "User message",
        )
        .await;
        let conn = new_connection(data_root.path()).await;

        let mut meta = serde_json::Map::new();
        meta.insert(
            "types".to_string(),
            serde_json::Value::Array(vec![serde_json::Value::String("user".to_string())]),
        );
        let response = list_sessions_request(&conn, ListSessionsRequest::new().meta(meta))
            .await
            .unwrap();

        assert_eq!(response.sessions.len(), 1);
        assert_eq!(response.sessions[0].title.as_deref(), Some("User session"));
        assert!(response.next_cursor.is_none());
    });
}

#[test]
fn test_list_sessions_types_rejects_internal_session_types() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let conn = new_connection(data_root.path()).await;

        for session_type in ["hidden", "sub_agent"] {
            let mut meta = serde_json::Map::new();
            meta.insert(
                "types".to_string(),
                serde_json::Value::Array(vec![serde_json::Value::String(session_type.to_string())]),
            );

            let error = list_sessions_request(&conn, ListSessionsRequest::new().meta(meta))
                .await
                .unwrap_err();
            assert_invalid_params(error);
        }
    });
}

#[test]
fn test_list_sessions_invalid_params() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let other_cwd = tempfile::tempdir().unwrap();
        seed_list_sessions(data_root.path(), cwd.path(), 51).await;
        let conn = new_connection(data_root.path()).await;

        let error =
            list_sessions_request(&conn, ListSessionsRequest::new().cursor("*".to_string()))
                .await
                .unwrap_err();
        assert_invalid_params(error);

        let error = list_sessions_request(
            &conn,
            ListSessionsRequest::new().cwd(std::path::PathBuf::from("relative/path")),
        )
        .await
        .unwrap_err();
        assert_invalid_params(error);

        let first = list_sessions_request(&conn, ListSessionsRequest::new().cwd(cwd.path()))
            .await
            .unwrap();

        let error = list_sessions_request(
            &conn,
            ListSessionsRequest::new()
                .cwd(other_cwd.path())
                .cursor(first.next_cursor.unwrap()),
        )
        .await
        .unwrap_err();
        assert_invalid_params(error);

        let error = list_sessions_request(
            &conn,
            ListSessionsRequest::new().meta(include_last_message_snippet_meta(
                serde_json::Value::String("true".to_string()),
            )),
        )
        .await
        .unwrap_err();
        assert_invalid_params(error);
    });
}

#[test]
fn test_get_session_info() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let cwd = Path::new("/tmp/acp-session-info");
        let session_manager = SessionManager::new(data_root.path().to_path_buf());
        let session = session_manager
            .create_session(
                cwd.to_path_buf(),
                "Session info".to_string(),
                SessionType::Acp,
                GooseMode::default(),
            )
            .await
            .unwrap();
        session_manager
            .add_message(&session.id, &Message::user().with_text("hello"))
            .await
            .unwrap();
        let conn = new_connection(data_root.path()).await;

        let response = get_session_info_request(
            &conn,
            GetSessionInfoRequest {
                session_id: session.id.clone(),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            response.session.session_id,
            agent_client_protocol::schema::v1::SessionId::new(session.id)
        );
        assert_eq!(response.session.cwd, cwd.to_path_buf());
        assert_eq!(response.session.title.as_deref(), Some("Session info"));
        assert!(response.session.updated_at.is_some());

        let meta = response
            .session
            .meta
            .expect("session info should include meta");
        assert!(meta.get("createdAt").and_then(|v| v.as_str()).is_some());
        assert_eq!(meta.get("messageCount"), Some(&serde_json::json!(1)));
        assert_eq!(meta.get("userSetName"), Some(&serde_json::json!(false)));
        assert_eq!(meta.get("sessionType"), Some(&serde_json::json!("acp")));
        assert_eq!(meta.get("hasRecipe"), Some(&serde_json::json!(false)));
    });
}

#[test]
fn test_session_name_update_notification() {
    run_test(async { run_session_name_update_notification::<AcpServerConnection>().await });
}

#[test]
fn test_close_session() {
    run_test(async { run_close_session::<AcpServerConnection>().await });
}

#[test]
fn test_config_option_model_set() {
    run_test(async { run_config_option_model_set::<AcpServerConnection>().await });
}

#[test]
fn test_config_option_thinking_effort_set() {
    run_test(async {
        let openai = OpenAiFixture::new(
            vec![],
            <AcpServerConnection as Connection>::expected_session_id(),
        )
        .await;
        let mut conn = <AcpServerConnection as Connection>::new(
            TestConnectionConfig {
                current_model: "claude-sonnet-4".to_string(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let data = conn.new_session().await.unwrap();

        let response = conn
            .cx()
            .send_request(SetSessionConfigOptionRequest::new(
                data.session.session_id().clone(),
                "thinking_effort".to_string(),
                SessionConfigOptionValue::value_id("high".to_string()),
            ))
            .block_task()
            .await
            .unwrap();

        let option = response
            .config_options
            .iter()
            .find(|option| option.id.0.as_ref() == "thinking_effort")
            .expect("thinking_effort option");
        assert_eq!(
            option.category,
            Some(SessionConfigOptionCategory::ThoughtLevel)
        );
        let select = match &option.kind {
            SessionConfigKind::Select(select) => select,
            _ => panic!("thinking_effort should be a select option"),
        };

        assert_eq!(select.current_value.0.as_ref(), "high");
    });
}

#[test]
fn test_config_option_non_value_id_returns_error_and_keeps_connection() {
    run_test(async {
        let openai = OpenAiFixture::new(
            vec![],
            <AcpServerConnection as Connection>::expected_session_id(),
        )
        .await;
        let mut conn =
            <AcpServerConnection as Connection>::new(TestConnectionConfig::default(), openai).await;
        let data = conn.new_session().await.unwrap();

        let err = conn
            .cx()
            .send_request(SetSessionConfigOptionRequest::new(
                data.session.session_id().clone(),
                "mode".to_string(),
                SessionConfigOptionValue::boolean(true),
            ))
            .block_task()
            .await
            .unwrap_err();
        assert_eq!(
            err,
            agent_client_protocol::Error::invalid_params().data("Expected a value ID")
        );

        conn.cx()
            .send_request(ListSessionsRequest::new())
            .block_task()
            .await
            .expect("connection should survive an invalid set_config_option");
    });
}

#[test]
fn test_delete_session() {
    run_test(async { run_delete_session::<AcpServerConnection>().await });
}

#[test]
fn test_fs_read_text_file_true() {
    run_test(async { run_fs_read_text_file_true::<AcpServerConnection>().await });
}

#[test]
fn test_fs_write_text_file_false() {
    run_test(async { run_fs_write_text_file_false::<AcpServerConnection>().await });
}

#[test]
fn test_fs_write_text_file_true() {
    run_test(async { run_fs_write_text_file_true::<AcpServerConnection>().await });
}

#[test]
fn test_initialize_doesnt_hit_provider() {
    run_test(async { run_initialize_doesnt_hit_provider::<AcpServerConnection>().await });
}

#[test]
fn test_load_mode() {
    run_test(async { run_load_mode::<AcpServerConnection>().await });
}

#[test]
fn test_load_model() {
    run_test(async { run_load_model::<AcpServerConnection>().await });
}

#[test]
fn test_load_session_error_session_not_found() {
    run_test(async { run_load_session_error::<AcpServerConnection>().await });
}

#[test]
fn test_load_session_mcp() {
    run_test(async { run_load_session_mcp::<AcpServerConnection>().await });
}

#[test]
fn test_load_session_replays_image_attachment() {
    run_test(async { run_load_session_replays_image_attachment::<AcpServerConnection>().await });
}

#[test]
fn test_mode_set() {
    run_test(async { run_mode_set::<AcpServerConnection>().await });
}

#[test]
fn test_model_list() {
    run_test(async { run_model_list::<AcpServerConnection>().await });
}

#[test]
fn test_new_session_returns_initial_config() {
    run_test(async { run_new_session_returns_initial_config::<AcpServerConnection>().await });
}

#[test]
fn test_new_session_uses_current_config_mode() {
    run_test(async { run_new_session_uses_current_config_mode::<AcpServerConnection>().await });
}

#[test]
fn test_new_session_honors_recipe_model_without_recipe_provider() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let conn = new_connection(data_root.path()).await;
        let work_dir = tempfile::tempdir().unwrap();
        let recipe_model = "gpt-4.1";
        let recipe = Recipe::builder()
            .title("Recipe model")
            .description("A recipe that only overrides the model")
            .instructions("Use the requested model")
            .settings(Settings {
                goose_provider: None,
                goose_model: Some(recipe_model.to_string()),
                temperature: None,
                max_turns: None,
            })
            .build()
            .unwrap();
        let mut meta = serde_json::Map::new();
        meta.insert(
            "recipeDeeplink".to_string(),
            serde_json::Value::String(recipe_deeplink::encode(&recipe).unwrap()),
        );

        let response = conn
            .cx()
            .send_request(NewSessionRequest::new(work_dir.path()).meta(meta))
            .block_task()
            .await
            .unwrap();
        let session_info = get_session_info_request(
            &conn,
            GetSessionInfoRequest {
                session_id: response.session_id.0.to_string(),
            },
        )
        .await
        .unwrap();
        let meta = session_info
            .session
            .meta
            .expect("session info should include meta");

        assert_eq!(
            meta.get("modelId").and_then(|v| v.as_str()),
            Some(recipe_model)
        );
        assert_eq!(
            meta.get("providerId").and_then(|v| v.as_str()),
            Some("openai")
        );
    });
}

#[test]
fn test_new_session_cleans_up_when_config_fails() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let conn = new_connection(data_root.path()).await;
        let work_dir = tempfile::tempdir().unwrap();
        let mut meta = serde_json::Map::new();
        meta.insert(
            "enabledExtensions".to_string(),
            serde_json::Value::String("invalid".to_string()),
        );

        let error: anyhow::Error = conn
            .cx()
            .send_request(NewSessionRequest::new(work_dir.path()).meta(meta))
            .block_task()
            .await
            .unwrap_err()
            .into();

        assert_invalid_params(error);

        let sessions = SessionManager::new(data_root.path().to_path_buf())
            .list_all_sessions()
            .await
            .unwrap();
        assert!(sessions.is_empty());
    });
}

#[test]
fn test_model_set() {
    run_test(async { run_model_set::<AcpServerConnection>().await });
}

#[test]
fn test_model_set_error_session_not_found() {
    run_test(async { run_model_set_error_session_not_found::<AcpServerConnection>().await });
}

#[test]
fn test_permission_persistence() {
    run_test(async { run_permission_persistence::<AcpServerConnection>().await });
}

#[test]
fn test_prompt_basic() {
    run_test(async { run_prompt_basic::<AcpServerConnection>().await });
}

#[test]
#[cfg(feature = "code-mode")]
fn test_prompt_codemode() {
    run_test(async { run_prompt_codemode::<AcpServerConnection>().await });
}

#[test]
fn test_prompt_error_session_not_found() {
    run_test(async { run_prompt_error::<AcpServerConnection>().await });
}

#[test]
fn test_prompt_image() {
    run_test(async { run_prompt_image::<AcpServerConnection>().await });
}

#[test]
fn test_prompt_image_attachment() {
    run_test(async { run_prompt_image_attachment::<AcpServerConnection>().await });
}

#[test]
fn test_codepro_image_only_prompt_preserves_the_original_attachment() {
    run_test_isolated_storage(async {
        use agent_client_protocol::schema::v1::{
            ContentBlock, ImageContent, PromptRequest, TextContent,
        };
        use goose_test_support::TEST_IMAGE_B64;

        let data_root = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let router_response = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            serde_json::json!({
                "id": "image-intent", "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"role": "assistant", "content":
                    "{\"intent\":\"conversation\",\"clarification\":null}"}, "finish_reason": "stop"}]
            })
        );
        let openai = OpenAiFixture::new_owned(
            vec![
                (
                    "CodePro's semantic intent router".to_string(),
                    router_response,
                ),
                (
                    "image_url".to_string(),
                    include_str!("acp_test_data/openai_image_attachment.txt").to_string(),
                ),
            ],
            AcpServerConnection::expected_session_id(),
        )
        .await;
        let request_log = openai.request_log();
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: data_root.path().to_path_buf(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let session = conn
            .cx()
            .send_request(
                NewSessionRequest::new(cwd.path().to_path_buf()).meta(
                    serde_json::json!({"workspaceMode":"codepro", "workspaceBinding":"unbound"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .block_task()
            .await
            .unwrap();
        let manager = SessionManager::new(data_root.path().to_path_buf());
        let session_id = session.session_id.0.to_string();
        let mut prior = manager.get_session(&session_id, false).await.unwrap();
        prior.extension_data.set_extension_state(
            "codepro_unified_turn",
            "v1",
            serde_json::json!({
                "intent":"tool_action", "source_message_id":"old-goal-fixture",
                "turn_id":"old-goal-fixture", "goal":"旧目标测试夹具", "status":"paused",
                "pause_reason":"unverified_result", "working_dir":cwd.path().to_string_lossy()
            }),
        );
        manager
            .update(&session_id)
            .extension_data(prior.extension_data)
            .apply()
            .await
            .unwrap();
        manager
            .add_message(
                &session_id,
                &Message::user()
                    .with_id("old-goal-fixture")
                    .with_text("旧目标测试夹具"),
            )
            .await
            .unwrap();
        manager
            .add_message(
                &session_id,
                &Message::assistant().with_tool_request(
                    "old-unknown-fixture",
                    Ok(rmcp::model::CallToolRequestParams::new("computer_click")),
                ),
            )
            .await
            .unwrap();
        manager
            .add_message(
                &session_id,
                &Message::user().with_tool_response(
                    "old-unknown-fixture",
                    Ok(rmcp::model::CallToolResult::success(vec![
                        rmcp::model::Content::text(r#"{"outcome":"unknown"}"#),
                    ])),
                ),
            )
            .await
            .unwrap();
        let before = manager.get_session(&session_id, true).await.unwrap();
        let mut invalid_prompts = vec![
            Vec::new(),
            vec![ContentBlock::Text(TextContent::new(" \n "))],
        ];
        for (data, mime) in [
            ("invalid!base64", "image/png"),
            (TEST_IMAGE_B64, "text/plain"),
            ("", "image/png"),
            ("AA", "image/png"),
            ("AB==", "image/png"),
        ] {
            for mut blocks in [
                Vec::new(),
                vec![ContentBlock::Image(ImageContent::new(
                    TEST_IMAGE_B64,
                    "image/png",
                ))],
                vec![ContentBlock::Text(TextContent::new("new explicit caption"))],
            ] {
                blocks.push(ContentBlock::Image(ImageContent::new(data, mime)));
                invalid_prompts.push(blocks);
            }
        }
        for blocks in invalid_prompts {
            let rejected = conn
                .cx()
                .send_request(PromptRequest::new(session.session_id.clone(), blocks))
                .block_task()
                .await;
            assert_invalid_params(
                rejected
                    .expect_err("invalid prompt must be rejected before a new run")
                    .into(),
            );
            let after = manager.get_session(&session_id, true).await.unwrap();
            assert_eq!(
                serde_json::to_value(&after.extension_data).unwrap(),
                serde_json::to_value(&before.extension_data).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&after.conversation).unwrap(),
                serde_json::to_value(&before.conversation).unwrap()
            );
            assert!(
                request_log.snapshot().is_empty(),
                "invalid input reached the provider"
            );
        }
        let response = conn
            .cx()
            .send_request(
                PromptRequest::new(
                    session.session_id.clone(),
                    vec![ContentBlock::Image(ImageContent::new(
                        TEST_IMAGE_B64,
                        "image/png",
                    ))],
                )
                .meta(
                    serde_json::json!({"codebuddy/source-message-id":"new-image-fixture"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .block_task()
            .await;
        assert!(
            response.is_ok(),
            "image-only CodePro prompt rejected: {response:?}"
        );
        let persisted = manager.get_session(&session_id, true).await.unwrap();
        let conversation = persisted.conversation.as_ref().unwrap();
        let image_source = conversation
            .messages()
            .iter()
            .find(|message| message.id.as_deref() == Some("new-image-fixture"))
            .expect("the original image source must remain persisted");
        assert_eq!(image_source.role, rmcp::model::Role::User);
        assert!(image_source.as_concat_text().is_empty());
        assert_eq!(image_source.content.len(), 1);
        assert!(matches!(
            &image_source.content[0],
            goose::conversation::message::MessageContent::Image(image)
                if image.data == TEST_IMAGE_B64 && image.mime_type == "image/png"
        ));
        let old_source = conversation
            .messages()
            .iter()
            .find(|message| message.id.as_deref() == Some("old-goal-fixture"))
            .expect("an image goal must not erase the original history");
        assert_eq!(old_source.as_concat_text(), "旧目标测试夹具");
        let requests = request_log.snapshot();
        assert!(!requests.is_empty(), "image never reached the provider");
        for (request_index, request) in requests.into_iter().enumerate() {
            let image_messages: Vec<_> = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| {
                    message["role"] == "user"
                        && message["content"].as_array().is_some_and(|content| {
                            content.iter().any(|block| block["type"] == "image_url")
                        })
                })
                .collect();
            assert_eq!(image_messages.len(), 1);
            let blocks = image_messages[0]["content"].as_array().unwrap();
            let image = blocks
                .iter()
                .find(|block| block["type"] == "image_url")
                .unwrap();
            assert_eq!(
                image["image_url"]["url"],
                format!("data:image/png;base64,{TEST_IMAGE_B64}")
            );
            assert!(
                blocks.iter().all(|block| block["type"] != "text"
                    || block["text"]
                        .as_str()
                        .is_some_and(|text| text == old_source.as_concat_text()
                            || goose::conversation::is_turn_context_text(text))),
                "a run summary must not become a fabricated user instruction; actual text blocks: {:?}",
                blocks.iter().filter(|block| block["type"] == "text").collect::<Vec<_>>()
            );
            let user_texts: Vec<_> = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|message| message["role"] == "user")
                .flat_map(|message| {
                    if let Some(text) = message["content"].as_str() {
                        vec![text]
                    } else {
                        message["content"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|block| block["type"] == "text")
                            .map(|block| {
                                block["text"].as_str().expect("user text must be a string")
                            })
                            .collect()
                    }
                })
                .filter(|text| !goose::conversation::is_turn_context_text(text))
                .collect();
            let message_roles: Vec<_> = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(index, message)| (index, &message["role"]))
                .collect();
            assert_eq!(
                user_texts,
                vec!["旧目标测试夹具"],
                "request_index={request_index}; message_roles={message_roles:?}"
            );
        }
        let empty = conn
            .cx()
            .send_request(PromptRequest::new(
                session.session_id,
                vec![ContentBlock::Text(TextContent::new(" \n "))],
            ))
            .block_task()
            .await;
        assert!(empty.is_err(), "a blank prompt must still be rejected");
    });
}

#[test]
fn test_prompt_mcp() {
    run_test(async { run_prompt_mcp::<AcpServerConnection>().await });
}

#[test]
fn test_prompt_model_mismatch() {
    run_test(async { run_prompt_model_mismatch::<AcpServerConnection>().await });
}

#[test]
fn test_prompt_skill() {
    run_test(async { run_prompt_skill::<AcpServerConnection>().await });
}

#[test]
fn test_shell_terminal_false() {
    run_test(async { run_shell_terminal_false::<AcpServerConnection>().await });
}

#[test]
fn test_shell_terminal_true() {
    run_test(async { run_shell_terminal_true::<AcpServerConnection>().await });
}

#[test]
fn test_codepro_unknown_model_keeps_user_images_on_initial_and_continue_requests() {
    run_test_isolated_storage(async {
        use agent_client_protocol::schema::v1::{
            ContentBlock, ImageContent, PromptRequest, TextContent,
        };
        use goose_test_support::TEST_IMAGE_B64;

        let data_root = tempfile::tempdir().unwrap();
        let mut session_ids = std::collections::HashSet::new();
        for caption in ["", "请描述附件"] {
            let cwd = tempfile::tempdir().unwrap();
            let model = "opaque-image-fixture";
            let router_response = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::json!({
                    "id":"image-intent", "object":"chat.completion.chunk",
                    "choices":[{"index":0,"delta":{"role":"assistant","content":
                        "{\"intent\":\"conversation\",\"clarification\":null}"},"finish_reason":"stop"}]
                })
            );
            let final_response = include_str!("acp_test_data/openai_basic.txt").to_string();
            let openai = OpenAiFixture::new_owned(
                vec![
                    (
                        "CodePro's semantic intent router".to_string(),
                        router_response,
                    ),
                    (format!(r#""model":"{model}""#), final_response.clone()),
                    (format!(r#""model":"{model}""#), final_response),
                ],
                AcpServerConnection::expected_session_id(),
            )
            .await;
            openai.advertise_model(model).await;
            let request_log = openai.request_log();
            let conn = AcpServerConnection::new(
                TestConnectionConfig {
                    data_root: data_root.path().to_path_buf(),
                    current_model: model.to_string(),
                    ..Default::default()
                },
                openai,
            )
            .await;
            let session = conn.cx().send_request(
                NewSessionRequest::new(cwd.path().to_path_buf()).meta(
                    serde_json::json!({"workspaceMode":"codepro", "workspaceBinding":"unbound"})
                        .as_object().unwrap().clone()
                )
            ).block_task().await.unwrap();
            assert!(
                session_ids.insert(session.session_id.0.to_string()),
                "image scenarios must use distinct session ids"
            );
            eprintln!(
                "image scenario session_id={} data_root={}",
                session.session_id.0,
                data_root.path().display()
            );
            let mut blocks = vec![ContentBlock::Image(ImageContent::new(
                TEST_IMAGE_B64,
                "image/png",
            ))];
            if !caption.is_empty() {
                blocks.push(ContentBlock::Text(TextContent::new(caption)));
            }
            conn.cx()
                .send_request(
                    PromptRequest::new(session.session_id.clone(), blocks).meta(
                        serde_json::json!({"codebuddy/source-message-id":"opaque-image-source"})
                            .as_object()
                            .unwrap()
                            .clone(),
                    ),
                )
                .block_task()
                .await
                .unwrap();
            conn.cx().send_request(PromptRequest::new(session.session_id.clone(), vec![
                ContentBlock::Text(TextContent::new("继续"))
            ]).meta(serde_json::json!({"codebuddy/source-message-id":"opaque-image-continuation"})
                .as_object().unwrap().clone())).block_task().await.unwrap();

            let requests = request_log.snapshot();
            let received = request_log.received_post_requests().await;
            let request_summary: Vec<_> = received.iter().map(|request| serde_json::json!({
                "model": request["model"],
                "system_prefix": request["messages"][0]["content"].as_str().unwrap_or("").chars().take(120).collect::<String>(),
                "image_blocks": request.to_string().matches("image_url").count()
            })).collect();
            eprintln!(
                "actual fixture requests: {}",
                serde_json::to_string(&request_summary).unwrap()
            );
            if requests.len() != 3 {
                let updates = conn.session_updates_snapshot();
                eprintln!(
                    "client updates: {}",
                    serde_json::to_string(&updates)
                        .unwrap()
                        .chars()
                        .take(1800)
                        .collect::<String>()
                );
            }
            assert_eq!(
                received.len(),
                requests.len(),
                "unmatched provider requests: {request_summary:?}"
            );
            assert_eq!(
                requests.len(),
                3,
                "router, final, continuation; no extra text-only retry"
            );
            for request in &requests {
                let images: Vec<_> = request["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|message| message["role"] == "user")
                    .filter_map(|message| message["content"].as_array())
                    .flatten()
                    .filter(|block| block["type"] == "image_url")
                    .collect();
                assert_eq!(
                    images.len(),
                    1,
                    "user image missing for {model}; caption={caption:?}"
                );
                assert_eq!(
                    images[0]["image_url"]["url"],
                    format!("data:image/png;base64,{TEST_IMAGE_B64}")
                );
            }
            let manager = SessionManager::new(data_root.path().to_path_buf());
            let persisted = manager
                .get_session(&session.session_id.0, true)
                .await
                .unwrap();
            let source: Vec<_> = persisted
                .conversation
                .as_ref()
                .unwrap()
                .messages()
                .iter()
                .filter(|message| message.id.as_deref() == Some("opaque-image-source"))
                .collect();
            assert_eq!(
                source.len(),
                1,
                "continuation must not duplicate the original source"
            );
            assert_eq!(source[0].as_concat_text(), caption);
            assert!(source[0].content.iter().any(|content| matches!(content,
                goose::conversation::message::MessageContent::Image(image)
                    if image.data == TEST_IMAGE_B64 && image.mime_type == "image/png")));
            let turn = persisted
                .extension_data
                .get_extension_state("codepro_unified_turn", "v1")
                .unwrap();
            assert_eq!(turn["source_message_id"], "opaque-image-source");
        }
    });
}

#[test]
fn test_openai_http_fixture_preserves_legacy_sse_and_reset() {
    run_test(async {
        let legacy = OpenAiFixture::new_owned(
            vec![("fixture".to_string(), "data: [DONE]\n\n".to_string())],
            AcpServerConnection::expected_session_id(),
        )
        .await;
        let error_body =
            serde_json::json!({"error":{"message":"image input rejected"}}).to_string();
        let rejected = OpenAiFixture::new_http_owned(
            vec![("fixture".to_string(), 400, error_body.clone())],
            AcpServerConnection::expected_session_id(),
        )
        .await;
        for (fixture, status, content_type, body) in [
            (
                legacy,
                200,
                "text/event-stream",
                "data: [DONE]\n\n".to_string(),
            ),
            (rejected, 400, "application/json", error_body),
        ] {
            for _ in 0..2 {
                let response = reqwest::Client::new()
                    .post(format!("{}/v1/chat/completions", fixture.uri()))
                    .json(&serde_json::json!({"fixture":"matched"}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.status().as_u16(), status);
                assert_eq!(response.headers()["content-type"], content_type);
                assert_eq!(response.text().await.unwrap(), body);
                assert_eq!(fixture.request_log().snapshot().len(), 1);
                fixture.reset();
                assert!(fixture.request_log().snapshot().is_empty());
            }
        }
    });
}

#[test]
fn test_codepro_image_http_rejection_pauses_and_model_switch_continues_original_source() {
    run_test_isolated_storage(async {
        use agent_client_protocol::schema::v1::{
            ContentBlock, ImageContent, PromptRequest, TextContent,
        };
        use goose_test_support::TEST_IMAGE_B64;
        let data_root = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let rejected_model = "opaque-image-fixture";
        let error_marker = "image_input_rejected_fixture_20260912";
        let router_response = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            serde_json::json!({
                "id":"image-intent", "object":"chat.completion.chunk",
                "choices":[{"index":0,"delta":{"role":"assistant","content":
                    "{\"intent\":\"conversation\",\"clarification\":null}"},"finish_reason":"stop"}]
            })
        );
        let rejected_attempts = goose_providers::retry::RetryConfig::default().max_retries() + 1;
        let mut exchanges = vec![(
            "CodePro's semantic intent router".to_string(),
            200,
            router_response,
        )];
        exchanges.extend((0..rejected_attempts).map(|_| (
            format!(r#""model":"{rejected_model}""#),
            400,
            serde_json::json!({
                "error":{"message":error_marker,"type":"invalid_request_error","param":"messages","code":"unsupported_image"}
            }).to_string(),
        )));
        exchanges.push((
            r#""model":"gpt-4.1""#.to_string(),
            200,
            include_str!("acp_test_data/openai_basic.txt").to_string(),
        ));
        let openai =
            OpenAiFixture::new_http_owned(exchanges, AcpServerConnection::expected_session_id())
                .await;
        openai.advertise_model(rejected_model).await;
        let request_log = openai.request_log();
        let conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: data_root.path().to_path_buf(),
                current_model: rejected_model.to_string(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let session = conn
            .cx()
            .send_request(
                NewSessionRequest::new(cwd.path().to_path_buf()).meta(
                    serde_json::json!({"workspaceMode":"codepro","workspaceBinding":"unbound"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .block_task()
            .await
            .unwrap();
        conn.cx()
            .send_request(
                PromptRequest::new(
                    session.session_id.clone(),
                    vec![
                        ContentBlock::Image(ImageContent::new(TEST_IMAGE_B64, "image/png")),
                        ContentBlock::Text(TextContent::new("请查看这张图片")),
                    ],
                )
                .meta(
                    serde_json::json!({"codebuddy/source-message-id":"rejected-image-source"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .block_task()
            .await
            .unwrap();
        let updates = conn.session_updates_snapshot();
        let visible_error = updates
            .iter()
            .filter_map(|update| {
                if let agent_client_protocol::schema::v1::SessionUpdate::AgentMessageChunk(chunk) =
                    update
                {
                    if let ContentBlock::Text(text) = &chunk.content {
                        return Some(text.text.as_str());
                    }
                }
                None
            })
            .collect::<Vec<_>>()
            .join("");
        let received = request_log.received_post_requests().await;
        let request_summary: Vec<_> = received
            .iter()
            .map(|request| {
                serde_json::json!({
                    "model": request["model"],
                    "user_image_blocks": request["messages"].as_array().unwrap().iter()
                        .filter(|message| message["role"] == "user")
                        .filter_map(|message| message["content"].as_array())
                        .flatten().filter(|content| content["type"] == "image_url").count()
                })
            })
            .collect();
        eprintln!("rejection request summary: {request_summary:?}");
        eprintln!("visible rejection text: {visible_error}");
        assert_eq!(
            received.len(),
            request_log.snapshot().len(),
            "unmatched provider requests: {request_summary:?}"
        );
        assert!(
            visible_error.contains("The provider rejected the request. Check the model and request settings, then try again."),
            "safe actionable provider error must reach visible assistant text: {visible_error}"
        );
        assert!(
            !visible_error.contains(error_marker),
            "remote error body must remain redacted"
        );
        let manager = SessionManager::new(data_root.path().to_path_buf());
        let failed = manager
            .get_session(&session.session_id.0, true)
            .await
            .unwrap();
        let turn = failed
            .extension_data
            .get_extension_state("codepro_unified_turn", "v1")
            .unwrap();
        assert_eq!(turn["status"], "paused");
        assert_eq!(turn["pause_reason"], "execution_error");
        assert_eq!(turn["source_message_id"], "rejected-image-source");
        assert_eq!(
            request_log.snapshot().len(),
            1 + rejected_attempts,
            "only intent routing and the configured same-model rejection attempts are allowed"
        );
        let original = failed
            .conversation
            .as_ref()
            .unwrap()
            .messages()
            .iter()
            .find(|m| m.id.as_deref() == Some("rejected-image-source"))
            .unwrap()
            .clone();
        assert!(original.content.iter().any(|c| matches!(c,
            goose::conversation::message::MessageContent::Image(image) if image.data==TEST_IMAGE_B64)));

        conn.set_model(&session.session_id.0, "gpt-4.1")
            .await
            .unwrap();
        conn.cx()
            .send_request(
                PromptRequest::new(
                    session.session_id.clone(),
                    vec![ContentBlock::Text(TextContent::new("继续"))],
                )
                .meta(
                    serde_json::json!({"codebuddy/source-message-id":"rejected-image-continue"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .block_task()
            .await
            .unwrap();
        let after = manager
            .get_session(&session.session_id.0, true)
            .await
            .unwrap();
        let turn = after
            .extension_data
            .get_extension_state("codepro_unified_turn", "v1")
            .unwrap();
        assert_eq!(turn["source_message_id"], "rejected-image-source");
        assert_eq!(turn["status"], "finished");
        assert!(turn["pause_reason"].is_null());
        let source: Vec<_> = after
            .conversation
            .as_ref()
            .unwrap()
            .messages()
            .iter()
            .filter(|m| m.id.as_deref() == Some("rejected-image-source"))
            .collect();
        assert_eq!(source.len(), 1);
        assert_eq!(
            serde_json::to_value(source[0]).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        let requests = request_log.snapshot();
        assert_eq!(
            request_log.received_post_requests().await.len(),
            requests.len(),
            "model-switch continuation must not issue unmatched requests"
        );
        assert_eq!(requests.len(), rejected_attempts + 2);
        assert_eq!(requests.last().unwrap()["model"], "gpt-4.1");
        for request in &requests[1..=rejected_attempts] {
            assert_eq!(request["model"], rejected_model);
            assert_eq!(
                request["messages"], requests[1]["messages"],
                "HTTP retry must preserve the original payload"
            );
        }
        for request in &requests {
            let images: Vec<_> = request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "user")
                .filter_map(|m| m["content"].as_array())
                .flatten()
                .filter(|c| c["type"] == "image_url")
                .collect();
            assert_eq!(
                images.len(),
                1,
                "every stage must receive the original image, even the rejected request"
            );
            assert_eq!(
                images[0]["image_url"]["url"],
                format!("data:image/png;base64,{TEST_IMAGE_B64}")
            );
        }
    });
}

#[test]
fn test_isolated_acp_storage_reuses_session_keys_without_budget_collision() {
    let roots = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    for _ in 0..2 {
        let roots = roots.clone();
        run_test_isolated_storage(async move {
            let root = goose::config::paths::Paths::runs_dir();
            let destination = root
                .join("same-session")
                .join("run")
                .join("external-http-attempt-budget.json");
            std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .unwrap();
            drop(file);
            roots.lock().unwrap().push(root);
        });
    }
    let roots = roots.lock().unwrap();
    assert_ne!(roots[0], roots[1]);
}
