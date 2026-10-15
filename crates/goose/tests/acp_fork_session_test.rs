#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;

use agent_client_protocol::schema::v1::{
    ContentBlock, ForkSessionRequest, ForkSessionResponse, LoadSessionRequest, PromptRequest,
    ResourceLink, SessionId, TextContent,
};
use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{
    run_test, Connection, OpenAiFixture, OpenAiRequestLog, TestConnectionConfig,
};
use goose::agents::codepro_workspace_binding::CodeProWorkspaceBinding;
use goose::config::GooseMode;
use goose::conversation::message::{Message, MessageContent};
use goose::session::{ExtensionState, SessionManager, SessionType};
use std::path::Path;

async fn new_connection(data_root: &Path) -> AcpServerConnection {
    new_connection_with_log(data_root).await.0
}

async fn new_connection_with_log(data_root: &Path) -> (AcpServerConnection, OpenAiRequestLog) {
    let openai = OpenAiFixture::new(
        vec![],
        <AcpServerConnection as Connection>::expected_session_id(),
    )
    .await;
    let request_log = openai.request_log();
    let connection = <AcpServerConnection as Connection>::new(
        TestConnectionConfig {
            data_root: data_root.to_path_buf(),
            ..Default::default()
        },
        openai,
    )
    .await;
    (connection, request_log)
}

async fn fork_session_request(
    conn: &AcpServerConnection,
    request: ForkSessionRequest,
) -> anyhow::Result<ForkSessionResponse> {
    conn.cx()
        .send_request(request)
        .block_task()
        .await
        .map_err(Into::into)
}

async fn seed_session_with_messages(
    session_manager: &SessionManager,
    cwd: &Path,
    messages: &[(&str, i64)],
) -> goose::session::Session {
    let session = session_manager
        .create_session(
            cwd.to_path_buf(),
            "Fork before".to_string(),
            SessionType::Acp,
            GooseMode::default(),
        )
        .await
        .unwrap();

    for (text, created) in messages {
        let mut message = Message::user().with_text(*text);
        message.created = *created;
        session_manager
            .add_message(&session.id, &message)
            .await
            .unwrap();
    }

    session
}

async fn session_texts(session_manager: &SessionManager, session_id: &str) -> Vec<String> {
    session_manager
        .get_session(session_id, true)
        .await
        .unwrap()
        .conversation
        .unwrap()
        .messages()
        .iter()
        .flat_map(|message| {
            message.content.iter().filter_map(|content| match content {
                MessageContent::Text(text) => Some(text.text.clone()),
                _ => None,
            })
        })
        .collect()
}

fn conversation_before_meta(timestamp: i64) -> serde_json::Map<String, serde_json::Value> {
    let mut meta = serde_json::Map::new();
    meta.insert(
        "conversationBefore".to_string(),
        serde_json::Value::Number(timestamp.into()),
    );
    meta
}

#[test]
fn fork_session_conversation_before_matches_rest_cutoff() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let session_manager = SessionManager::new(data_root.path().to_path_buf());
        let session = seed_session_with_messages(
            &session_manager,
            cwd.path(),
            &[
                ("first", 1_718_000_000),
                ("second", 1_718_000_060),
                ("third", 1_718_000_120),
            ],
        )
        .await;
        let conn = new_connection(data_root.path()).await;

        let response = fork_session_request(
            &conn,
            ForkSessionRequest::new(SessionId::new(session.id.clone()), cwd.path())
                .meta(conversation_before_meta(1_718_000_120)),
        )
        .await
        .unwrap();

        assert_eq!(
            session_texts(&session_manager, response.session_id.0.as_ref()).await,
            vec!["first", "second"]
        );
        assert_eq!(
            session_texts(&session_manager, &session.id).await,
            vec!["first", "second", "third"]
        );
    });
}

#[test]
fn codepro_prompt_load_and_fork_handlers_reject_missing_or_overridden_workspace_authority() {
    run_test(async {
        let data_root = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let other_cwd = tempfile::tempdir().unwrap();
        let session_manager = SessionManager::new(data_root.path().to_path_buf());
        let session = session_manager
            .create_session(
                cwd.path().to_path_buf(),
                "CodePro fail closed".to_string(),
                SessionType::CodePro,
                GooseMode::default(),
            )
            .await
            .unwrap();
        let (conn, request_log) = new_connection_with_log(data_root.path()).await;
        let session_id = SessionId::new(session.id.clone());

        let prompt = conn
            .cx()
            .send_request(PromptRequest::new(
                session_id.clone(),
                vec![ContentBlock::Text(TextContent::new("hello"))],
            ))
            .block_task()
            .await;
        assert!(
            prompt.is_err(),
            "missing CodePro binding must reject prompt dispatch"
        );

        let mut unbound = Default::default();
        CodeProWorkspaceBinding::Unbound
            .to_extension_data(&mut unbound)
            .unwrap();
        session_manager
            .update(&session.id)
            .extension_data(unbound)
            .apply()
            .await
            .unwrap();
        let outside_file = other_cwd.path().join("secret.txt");
        std::fs::write(&outside_file, "must not be read").unwrap();
        let outside_uri = format!(
            "file:///{}",
            outside_file.to_string_lossy().replace('\\', "/")
        );
        let resource_prompt = conn
            .cx()
            .send_request(PromptRequest::new(
                session_id.clone(),
                vec![ContentBlock::ResourceLink(ResourceLink::new(
                    "secret.txt",
                    outside_uri,
                ))],
            ))
            .block_task()
            .await;
        assert!(resource_prompt.is_err());
        assert!(request_log.snapshot().is_empty());

        let mut mismatched_binding = Default::default();
        CodeProWorkspaceBinding::WritableProject {
            path: other_cwd.path().to_string_lossy().into_owned(),
            lease_id: "not-live".to_string(),
        }
        .to_extension_data(&mut mismatched_binding)
        .unwrap();
        session_manager
            .update(&session.id)
            .extension_data(mismatched_binding)
            .apply()
            .await
            .unwrap();
        let mismatched_prompt = conn
            .cx()
            .send_request(PromptRequest::new(
                session_id.clone(),
                vec![ContentBlock::Text(TextContent::new("hello again"))],
            ))
            .block_task()
            .await;
        assert!(mismatched_prompt.is_err());

        let mut released_binding = Default::default();
        CodeProWorkspaceBinding::WritableProject {
            path: cwd.path().to_string_lossy().into_owned(),
            lease_id: "already-released".to_string(),
        }
        .to_extension_data(&mut released_binding)
        .unwrap();
        session_manager
            .update(&session.id)
            .extension_data(released_binding)
            .apply()
            .await
            .unwrap();
        let released_prompt = conn
            .cx()
            .send_request(PromptRequest::new(
                session_id.clone(),
                vec![ContentBlock::Text(TextContent::new("hello after release"))],
            ))
            .block_task()
            .await;
        assert!(released_prompt.is_err());
        assert!(
            request_log.snapshot().is_empty(),
            "rejected prompts must be request0"
        );

        let load = conn
            .cx()
            .send_request(LoadSessionRequest::new(
                session_id.clone(),
                other_cwd.path(),
            ))
            .block_task()
            .await;
        assert!(
            load.is_err(),
            "request cwd must not override persisted CodePro cwd"
        );

        let fork =
            fork_session_request(&conn, ForkSessionRequest::new(session_id, other_cwd.path()))
                .await;
        assert!(
            fork.is_err(),
            "CodePro fork must be rejected by the real handler"
        );
    });
}
