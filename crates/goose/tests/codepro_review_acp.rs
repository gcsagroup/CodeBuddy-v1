#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;

use agent_client_protocol::JsonRpcMessage;
use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{
    run_test, send_custom, Connection, OpenAiFixture, Session, SessionData, TestConnectionConfig,
};
use goose::acp::server::AcpProviderFactory;
use goose::conversation::message::Message;
use goose::providers::base::{MessageStream, Provider, ProviderUsage, Usage};
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use goose_sdk_types::custom_requests::{
    CodeProReviewCancelRequest, CodeProReviewGetRequest, CodeProReviewSnapshotRequest,
    CodeProReviewStartRequest,
};
use goose_test_support::EnforceSessionId;
use serial_test::serial;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

struct AcpReviewProvider {
    calls: AtomicUsize,
    started: Option<Arc<Notify>>,
    release: Option<Arc<Notify>>,
    dropped: Option<Arc<AtomicBool>>,
}

struct DropSignal(Arc<AtomicBool>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl Provider for AcpReviewProvider {
    fn get_name(&self) -> &str {
        "review-test"
    }

    async fn stream(
        &self,
        model_config: &ModelConfig,
        system: &str,
        messages: &[Message],
        tools: &[rmcp::model::Tool],
    ) -> Result<MessageStream, ProviderError> {
        let (message, usage) = self.complete(model_config, system, messages, tools).await?;
        Ok(goose::providers::base::stream_from_single_message(
            message, usage,
        ))
    }

    async fn complete(
        &self,
        _model_config: &ModelConfig,
        _system: &str,
        _messages: &[Message],
        tools: &[rmcp::model::Tool],
    ) -> Result<(Message, ProviderUsage), ProviderError> {
        let _drop_signal = self
            .dropped
            .as_ref()
            .map(|dropped| DropSignal(dropped.clone()));
        assert!(tools.is_empty());
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(started) = &self.started {
            started.notify_one();
        }
        if let Some(release) = &self.release {
            release.notified().await;
        }
        let response = serde_json::json!({
            "findings": [{
                "id": "acp-finding",
                "priority": 1,
                "title": "Changed value",
                "body": "The changed value breaks the fixture contract.",
                "path": "src/lib.rs",
                "side": "new",
                "startLine": 1,
                "endLine": 1
            }]
        });
        Ok((
            Message::assistant().with_text(response.to_string()),
            ProviderUsage::new("review-test".into(), Usage::default()),
        ))
    }
}

fn provider_factory(provider: Arc<AcpReviewProvider>) -> AcpProviderFactory {
    Arc::new(move |_provider_name, _extensions, _working_dir| {
        let provider = provider.clone();
        Box::pin(async move { Ok(provider as Arc<dyn Provider>) })
    })
}

fn git(path: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Review Test",
            "-c",
            "user.email=review@example.invalid",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(path)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn review_repository() -> tempfile::TempDir {
    let repository = tempfile::tempdir().unwrap();
    git(repository.path(), &["init", "--quiet"]);
    std::fs::create_dir_all(repository.path().join("src")).unwrap();
    std::fs::write(
        repository.path().join("src/lib.rs"),
        "pub fn value() -> i32 { 1 }\n",
    )
    .unwrap();
    git(repository.path(), &["add", "--", "src/lib.rs"]);
    git(repository.path(), &["commit", "--quiet", "-m", "base"]);
    std::fs::write(
        repository.path().join("src/lib.rs"),
        "pub fn value() -> i32 { 2 }\n",
    )
    .unwrap();
    repository
}

async fn snapshot(
    connection: &AcpServerConnection,
    session_id: &str,
) -> Result<serde_json::Value, agent_client_protocol::Error> {
    send_custom(
        connection.cx(),
        "_goose/unstable/codepro/review/snapshot",
        serde_json::json!({
            "schemaVersion": 1,
            "sessionId": session_id,
            "scope": "working_tree",
            "baseRef": null
        }),
    )
    .await
}

#[test]
fn review_requests_register_the_four_session_scoped_methods() {
    assert!(CodeProReviewSnapshotRequest::matches_method(
        "_goose/unstable/codepro/review/snapshot"
    ));
    assert!(CodeProReviewStartRequest::matches_method(
        "_goose/unstable/codepro/review/start"
    ));
    assert!(CodeProReviewGetRequest::matches_method(
        "_goose/unstable/codepro/review/get"
    ));
    assert!(CodeProReviewCancelRequest::matches_method(
        "_goose/unstable/codepro/review/cancel"
    ));
}

#[test]
fn review_requests_have_no_client_working_directory_field() {
    for request in [
        serde_json::json!({"schemaVersion": 1, "sessionId": "s", "scope": "working_tree"}),
        serde_json::json!({"schemaVersion": 1, "sessionId": "s", "requestId": "r", "snapshotId": "p", "testEvidence": []}),
        serde_json::json!({"schemaVersion": 1, "sessionId": "s", "reviewId": "r"}),
    ] {
        assert!(request.get("workingDir").is_none());
        assert!(request.get("cwd").is_none());
    }
}

#[test]
#[serial]
fn review_acp_is_session_scoped_versioned_and_idempotent() {
    run_test(async move {
        let repository = review_repository();
        let repository_path = repository.path().to_path_buf();
        let other_repository = review_repository();
        let provider = Arc::new(AcpReviewProvider {
            calls: AtomicUsize::new(0),
            started: None,
            release: None,
            dropped: None,
        });
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut connection = AcpServerConnection::new(
            TestConnectionConfig {
                cwd: Some(repository),
                provider_factory: Some(provider_factory(provider.clone())),
                current_model: "review-model".into(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let SessionData { session, .. } = connection.new_session().await.unwrap();
        let session_id = session.session_id().0.to_string();

        assert!(send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/snapshot",
            serde_json::json!({
                "schemaVersion": 2,
                "sessionId": session_id,
                "scope": "working_tree"
            })
        )
        .await
        .is_err());
        assert!(send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/snapshot",
            serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "scope": "working_tree",
                "cwd": "C:/forged"
            })
        )
        .await
        .is_err());

        let preview = snapshot(&connection, &session_id).await.unwrap();
        let snapshot_id = preview["snapshot"]["snapshotId"].as_str().unwrap();
        let start_payload = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": session_id,
            "requestId": "request-1",
            "snapshotId": snapshot_id,
            "testEvidence": []
        });
        let started = send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/start",
            start_payload.clone(),
        )
        .await
        .unwrap();
        let retry = send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/start",
            start_payload,
        )
        .await
        .unwrap();
        assert_eq!(retry["result"]["reviewId"], started["result"]["reviewId"]);
        let review_id = started["result"]["reviewId"].as_str().unwrap();
        for _ in 0..100 {
            let current = send_custom(
                connection.cx(),
                "_goose/unstable/codepro/review/get",
                serde_json::json!({
                    "schemaVersion": 1,
                    "sessionId": session_id,
                    "reviewId": review_id
                }),
            )
            .await
            .unwrap();
            assert!(current.get("snapshot").is_none());
            if current["result"]["status"] != "running" {
                assert_eq!(current["result"]["status"], "completed");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        std::fs::write(
            repository_path.join("src/lib.rs"),
            "pub fn value() -> i32 { 3 }\n",
        )
        .unwrap();

        let openai_reconnected =
            OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let reconnected = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: connection.data_root(),
                provider_factory: Some(provider_factory(provider.clone())),
                current_model: "review-model".into(),
                ..Default::default()
            },
            openai_reconnected,
        )
        .await;
        let recovered = send_custom(
            reconnected.cx(),
            "_goose/unstable/codepro/review/get",
            serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "reviewId": review_id,
                "includeSnapshot": true
            }),
        )
        .await
        .unwrap();
        assert_eq!(recovered["result"]["status"], "completed");
        assert_eq!(
            recovered["snapshot"]["snapshotId"],
            preview["snapshot"]["snapshotId"]
        );
        assert_eq!(
            recovered["snapshot"]["files"][0]["newText"],
            "pub fn value() -> i32 { 2 }\n"
        );
        assert_ne!(
            recovered["snapshot"]["files"][0]["newText"],
            "pub fn value() -> i32 { 3 }\n"
        );
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);

        let other = send_custom(
            connection.cx(),
            "session/new",
            serde_json::json!({"cwd": other_repository.path(), "mcpServers": []}),
        )
        .await
        .unwrap();
        let other_session = other["sessionId"].as_str().unwrap();
        for method in [
            "_goose/unstable/codepro/review/get",
            "_goose/unstable/codepro/review/cancel",
        ] {
            assert!(send_custom(
                connection.cx(),
                method,
                serde_json::json!({
                    "schemaVersion": 1,
                    "sessionId": other_session,
                    "reviewId": review_id
                })
            )
            .await
            .is_err());
        }
        assert!(send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/get",
            serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "reviewId": "unknown"
            })
        )
        .await
        .is_err());
    });
}

#[test]
#[serial]
fn review_acp_get_and_cancel_remain_available_during_provider_wait() {
    run_test(async move {
        let repository = review_repository();
        let started_signal = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let provider = Arc::new(AcpReviewProvider {
            calls: AtomicUsize::new(0),
            started: Some(started_signal.clone()),
            release: Some(release.clone()),
            dropped: None,
        });
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut connection = AcpServerConnection::new(
            TestConnectionConfig {
                cwd: Some(repository),
                provider_factory: Some(provider_factory(provider.clone())),
                current_model: "review-model".into(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let SessionData { session, .. } = connection.new_session().await.unwrap();
        let session_id = session.session_id().0.to_string();
        let preview = snapshot(&connection, &session_id).await.unwrap();
        let snapshot_id = preview["snapshot"]["snapshotId"].as_str().unwrap();
        let started = send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/start",
            serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "requestId": "wait-request",
                "snapshotId": snapshot_id,
                "testEvidence": []
            }),
        )
        .await
        .unwrap();
        let review_id = started["result"]["reviewId"].as_str().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), started_signal.notified())
            .await
            .unwrap();
        let running = send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/get",
            serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "reviewId": review_id
            }),
        )
        .await
        .unwrap();
        assert_eq!(running["result"]["status"], "running");
        let cancelled = send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/cancel",
            serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "reviewId": review_id
            }),
        )
        .await
        .unwrap();
        assert_eq!(cancelled["result"]["status"], "cancelled");
        release.notify_one();
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
#[serial]
fn deleting_a_session_cancels_review_and_removes_persisted_state() {
    run_test(async move {
        let repository = review_repository();
        let started_signal = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(AcpReviewProvider {
            calls: AtomicUsize::new(0),
            started: Some(started_signal.clone()),
            release: Some(Arc::new(Notify::new())),
            dropped: Some(dropped.clone()),
        });
        let openai = OpenAiFixture::new(vec![], Arc::new(EnforceSessionId::default())).await;
        let mut connection = AcpServerConnection::new(
            TestConnectionConfig {
                cwd: Some(repository),
                provider_factory: Some(provider_factory(provider)),
                current_model: "review-model".into(),
                ..Default::default()
            },
            openai,
        )
        .await;
        let SessionData { session, .. } = connection.new_session().await.unwrap();
        let session_id = session.session_id().0.to_string();
        let data_root = connection.data_root();
        let preview = snapshot(&connection, &session_id).await.unwrap();
        let snapshot_id = preview["snapshot"]["snapshotId"].as_str().unwrap();
        send_custom(
            connection.cx(),
            "_goose/unstable/codepro/review/start",
            serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "requestId": "delete-session-review",
                "snapshotId": snapshot_id,
                "testEvidence": []
            }),
        )
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), started_signal.notified())
            .await
            .unwrap();
        assert!(std::fs::read_dir(data_root.join("reviews"))
            .unwrap()
            .next()
            .is_some());

        connection.delete_session(&session_id).await.unwrap();

        for _ in 0..100 {
            if dropped.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            dropped.load(Ordering::SeqCst),
            "provider request must be dropped when its session is deleted"
        );
        assert!(std::fs::read_dir(data_root.join("reviews"))
            .unwrap()
            .next()
            .is_none());
    });
}
