#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;

use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{run_test, send_custom, Connection, Session, TestConnectionConfig};
use goose::acp::server::AcpProviderFactory;
use goose::config::base::CONFIG_YAML_NAME;
use goose::config::paths::Paths;
use goose::providers::api_client::{ApiClient, AuthMethod};
use goose::providers::base::Provider;
use goose::providers::openai::OpenAiProviderBuilder;
use goose_test_support::EnforceSessionId;
use serial_test::serial;
use std::sync::Arc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
#[serial]
fn unauthenticated_custom_provider_can_be_selected_using_live_model_id() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_string_lossy().to_string();
    let _env = env_lock::lock_env([
        ("GOOSE_PATH_ROOT", Some(root_path.as_str())),
        ("GOOSE_DISABLE_KEYRING", Some("1")),
    ]);
    let config_dir = Paths::config_dir();
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join(CONFIG_YAML_NAME),
        "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nGOOSE_DISABLE_KEYRING: true\n",
    )
    .unwrap();

    run_test(async move {
        let model_id = "/shared/QuantitiveModels/Qwen3.8-27B-direct-A-best15-FP4";
        let upstream = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": model_id }]
            })))
            .expect(2)
            .mount(&upstream)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "OK" } }]
            })))
            .expect(2)
            .mount(&upstream)
            .await;
        let upstream_url = upstream.uri();
        let live_model = model_id.to_string();
        let provider_factory: AcpProviderFactory =
            Arc::new(move |provider_name, _extensions, _working_dir| {
                let upstream_url = upstream_url.clone();
                let live_model = live_model.clone();
                Box::pin(async move {
                    let api_client =
                        ApiClient::new_with_tls(upstream_url, AuthMethod::NoAuth, None)?;
                    Ok(Arc::new(
                        OpenAiProviderBuilder::new(api_client)
                            .name(provider_name)
                            .custom_models(Some(vec![live_model]))
                            .build(),
                    ) as Arc<dyn Provider>)
                })
            });

        let openai = common_tests::fixtures::OpenAiFixture::new(
            vec![],
            Arc::new(EnforceSessionId::default()),
        )
        .await;
        let mut conn = AcpServerConnection::new(
            TestConnectionConfig {
                data_root: config_dir,
                provider_factory: Some(provider_factory),
                ..Default::default()
            },
            openai,
        )
        .await;

        let created = send_custom(
            conn.cx(),
            "_goose/unstable/providers/custom/create",
            serde_json::json!({
                "engine": "openai_compatible",
                "displayName": "Unauthenticated Local Provider",
                "apiUrl": upstream.uri(),
                "apiKey": "",
                "models": [model_id],
                "supportsStreaming": true,
                "headers": {},
                "requiresAuth": false
            }),
        )
        .await
        .expect("unauthenticated custom provider should be created");
        let provider_id = created["providerId"].as_str().unwrap();

        let selected = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": provider_id,
                "modelId": model_id,
            }),
        )
        .await
        .expect("a reachable unauthenticated provider should not require a credential probe");

        assert_eq!(
            selected,
            serde_json::json!({
                "providerId": provider_id,
                "modelId": model_id,
            })
        );
        let requests = upstream.received_requests().await.unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url.path() == "/v1/models")
                .count(),
            2,
            "creation and selection should each verify the live model list"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.url.path() == "/v1/chat/completions")
                .count(),
            2,
            "creation and selection should each verify a real model response"
        );

        let session = conn.new_session().await.unwrap().session;
        let session_id = session.session_id().0.to_string();
        upstream.reset().await;
        let replacement_model = "Qwen3.8-27B-direct-A-best15-FP4";
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{ "id": replacement_model }]
            })))
            .mount(&upstream)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(wiremock::matchers::body_partial_json(
                serde_json::json!({"model": replacement_model}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "OK" } }]
            })))
            .mount(&upstream)
            .await;
        let selection = |model: &str| {
            serde_json::json!({
                "providerId": provider_id, "modelId": model
            })
            .to_string()
        };
        conn.set_config_option(&session_id, "provider_model", &selection(replacement_model))
            .await
            .expect("session switching must accept a live model absent from the saved snapshot");
        send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": provider_id, "modelId": replacement_model
            }),
        )
        .await
        .expect("session and defaults must agree on model availability");
        let error = conn
            .set_config_option(&session_id, "provider_model", &selection(model_id))
            .await
            .expect_err("a cached model removed by the endpoint must be rejected");
        let error = error.downcast::<agent_client_protocol::Error>().unwrap();
        assert_eq!(
            error.data.as_ref().unwrap()["code"],
            "custom_provider_model_unavailable"
        );
        upstream.reset().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&upstream)
            .await;
        assert!(
            conn.set_config_option(&session_id, "provider_model", &selection(model_id))
                .await
                .is_err(),
            "an unavailable service must not fall back to a stale model"
        );
        let exported = send_custom(
            conn.cx(),
            "_goose/unstable/session/export",
            serde_json::json!({
                "sessionId": session_id, "format": "json"
            }),
        )
        .await
        .unwrap();
        let persisted: serde_json::Value =
            serde_json::from_str(exported["data"].as_str().unwrap()).unwrap();
        assert_eq!(persisted["provider_name"], provider_id);
        assert_eq!(
            persisted["model_config"]["model_name"], replacement_model,
            "rejected switches must retain the last committed selection"
        );
    });
}
