#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;

use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{
    run_test, send_custom, Connection, Session, SessionData, TestConnectionConfig,
};
use goose::config::paths::Paths;
use goose::config::{Config, ConfigError};
use goose::providers::base::{MessageStream, Provider};
use goose::providers::inventory::ProviderInventoryService;
use goose::session::session_manager::SessionStorage;
use goose::session::SessionManager;
use goose_providers::errors::ProviderError;
use goose_providers::model::ModelConfig;
use goose_test_support::EnforceSessionId;
use serial_test::serial;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

struct MockProvider {
    name: String,
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
        Ok(vec!["claude-3-5-haiku-latest".to_string()])
    }
}

fn mock_provider_factory() -> goose::acp::server::AcpProviderFactory {
    Arc::new(|provider_name, _extensions, _working_dir| {
        Box::pin(async move {
            Ok(Arc::new(MockProvider {
                name: provider_name,
            }) as Arc<dyn Provider>)
        })
    })
}

fn write_config(config_dir: &std::path::Path) {
    std::fs::create_dir_all(config_dir).unwrap();
    std::fs::write(
        config_dir.join(goose::config::base::CONFIG_YAML_NAME),
        "GOOSE_MODEL: gpt-4o\nGOOSE_PROVIDER: openai\nGOOSE_DISABLE_KEYRING: true\n",
    )
    .unwrap();
}

fn write_secrets(config_dir: &std::path::Path, secrets: &str) {
    std::fs::write(config_dir.join("secrets.yaml"), secrets).unwrap();
}

fn shared_test_root() -> &'static std::path::Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| tempfile::tempdir().unwrap()).path()
}

#[derive(Debug, PartialEq)]
struct ProviderPersistenceSnapshot {
    config: Vec<u8>,
    secrets: Vec<u8>,
    provider: String,
    model: String,
    session: Vec<u8>,
}

async fn provider_persistence_snapshot(
    config_dir: &std::path::Path,
    data_root: &std::path::Path,
    session_id: &str,
) -> ProviderPersistenceSnapshot {
    let session = SessionManager::new(data_root.to_path_buf())
        .get_session(session_id, false)
        .await
        .unwrap();
    ProviderPersistenceSnapshot {
        config: std::fs::read(config_dir.join(goose::config::base::CONFIG_YAML_NAME)).unwrap(),
        secrets: std::fs::read(config_dir.join("secrets.yaml")).unwrap(),
        provider: Config::global().get_goose_provider().unwrap(),
        model: Config::global().get_goose_model().unwrap(),
        session: serde_json::to_vec(&session).unwrap(),
    }
}

#[test]
#[serial]
fn candidate_host_precedence_and_canonical_origin_rejections_are_transactional() {
    let root_path = shared_test_root().to_string_lossy().to_string();
    let deny_proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    deny_proxy.set_nonblocking(true).unwrap();
    let deny_proxy_url = format!("http://{}", deny_proxy.local_addr().unwrap());
    let deny_proxy_stop = Arc::new(AtomicBool::new(false));
    let external_request_count = Arc::new(AtomicUsize::new(0));
    let deny_proxy_stop_thread = Arc::clone(&deny_proxy_stop);
    let external_request_count_thread = Arc::clone(&external_request_count);
    let deny_proxy_thread = std::thread::spawn(move || {
        while !deny_proxy_stop_thread.load(Ordering::Acquire) {
            match deny_proxy.accept() {
                Ok((_stream, _address)) => {
                    external_request_count_thread.fetch_add(1, Ordering::AcqRel);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::yield_now();
                }
                Err(error) => panic!("deny proxy accept failed: {error}"),
            }
        }
    });
    let _env = env_lock::lock_env([
        ("GOOSE_PATH_ROOT", Some(root_path.as_str())),
        ("GOOSE_DISABLE_KEYRING", Some("1")),
        ("OPENAI_API_KEY", None),
        ("OPENAI_HOST", None),
        ("OPENAI_BASE_URL", None),
        ("ANTHROPIC_API_KEY", None),
        ("ANTHROPIC_HOST", None),
        ("GOOGLE_API_KEY", None),
        ("GOOGLE_HOST", None),
        ("XAI_API_KEY", None),
        ("XAI_HOST", None),
        ("HTTP_PROXY", Some(deny_proxy_url.as_str())),
        ("HTTPS_PROXY", Some(deny_proxy_url.as_str())),
        ("ALL_PROXY", Some(deny_proxy_url.as_str())),
        ("NO_PROXY", Some("127.0.0.1,localhost")),
    ]);
    let config_dir = Paths::config_dir();
    write_config(&config_dir);
    write_secrets(&config_dir, "{}\n");
    Config::global().invalidate_secrets_cache();

    run_test(async move {
        let local = wiremock::MockServer::start().await;
        let openai = common_tests::fixtures::OpenAiFixture::new(
            vec![],
            Arc::new(EnforceSessionId::default()),
        )
        .await;
        let config = TestConnectionConfig {
            data_root: config_dir.clone(),
            provider_factory: Some(mock_provider_factory()),
            ..Default::default()
        };
        let mut conn = AcpServerConnection::new(config, openai).await;
        let data_root = conn.data_root();
        let SessionData { session, .. } = conn.new_session().await.unwrap();
        let session_id = session.session_id().0.to_string();

        let read_all = send_custom(
            conn.cx(),
            "_goose/unstable/config/read-all",
            serde_json::json!({}),
        )
        .await
        .expect("generic config policy must be exposed to clients");
        let blocked = read_all["blockedMutationKeys"]
            .as_array()
            .expect("blockedMutationKeys must be a generated response field");
        for key in [
            "GOOSE_PROVIDER",
            "active_provider",
            "ZHIPU_API_KEY",
            "ZAI_BASE_URL",
        ] {
            assert!(
                blocked.iter().any(|value| value == key),
                "missing blocked key {key}"
            );
        }
        assert!(!blocked
            .iter()
            .any(|value| value == "MATRIX_B_GENERIC_SETTING"));

        for (provider_id, key_name) in [("zai", "ZHIPU_API_KEY"), ("nvidia", "NVIDIA_API_KEY")] {
            let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
            let error = send_custom(
                conn.cx(),
                "_goose/unstable/providers/config/save",
                serde_json::json!({
                    "providerId": provider_id,
                    "fields": [{"key": key_name, "value": "disabled-provider-canary"}]
                }),
            )
            .await
            .expect_err("providers without credential pre-validation must be disabled");
            let rendered = error.to_string();
            assert!(rendered.contains(goose::providers::UNVERIFIED_CREDENTIAL_ACTIVATION_REASON));
            assert!(!rendered.contains("disabled-provider-canary"));
            assert!(local.received_requests().await.unwrap().is_empty());
            assert_eq!(
                provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
                before
            );
        }

        for (key, value, is_secret) in [
            ("ZHIPU_API_KEY", "generic-provider-key-canary", true),
            ("ZAI_BASE_URL", "https://provider-endpoint.invalid", false),
            ("GOOSE_PROVIDER", "zai", false),
            ("GOOSE_MODEL", "glm-5.2", false),
            ("active_provider", "zai", false),
            ("providers", "provider-map-canary", false),
        ] {
            let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
            let error = send_custom(
                conn.cx(),
                "_goose/unstable/config/upsert",
                serde_json::json!({
                    "key": key,
                    "value": value,
                    "isSecret": is_secret,
                }),
            )
            .await
            .expect_err("generic config mutation must reject provider-owned state");
            let rendered = error.to_string();
            assert!(rendered.contains("provider configuration"));
            assert!(!rendered.contains(value));
            assert_eq!(
                provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
                before
            );

            let remove_error = send_custom(
                conn.cx(),
                "_goose/unstable/config/remove",
                serde_json::json!({"key": key, "isSecret": is_secret}),
            )
            .await
            .expect_err("generic config removal must reject provider-owned state");
            assert!(remove_error.to_string().contains("provider configuration"));
            assert_eq!(
                provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
                before
            );
        }

        send_custom(
            conn.cx(),
            "_goose/unstable/config/upsert",
            serde_json::json!({
                "key": "MATRIX_B_GENERIC_SETTING",
                "value": "safe-non-provider-value",
                "isSecret": false,
            }),
        )
        .await
        .expect("non-provider generic configuration must remain writable");
        send_custom(
            conn.cx(),
            "_goose/unstable/config/remove",
            serde_json::json!({"key": "MATRIX_B_GENERIC_SETTING", "isSecret": false}),
        )
        .await
        .expect("non-provider generic configuration must remain removable");

        write_secrets(&config_dir, "ZHIPU_API_KEY: legacy-zai-key-canary\n");
        Config::global().invalidate_secrets_cache();
        let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
        let error = send_custom(
            conn.cx(),
            "_goose/unstable/defaults/save",
            serde_json::json!({
                "providerId": "zai",
                "modelId": "glm-5.2",
            }),
        )
        .await
        .expect_err("unsupported provider credentials must not activate defaults");
        let rendered = error.to_string();
        assert!(rendered.contains(goose::providers::UNVERIFIED_CREDENTIAL_ACTIVATION_REASON));
        assert!(!rendered.contains("legacy-zai-key-canary"));
        assert_eq!(
            provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
            before
        );
        write_secrets(&config_dir, "{}\n");
        Config::global().invalidate_secrets_cache();

        std::env::set_var("OPENAI_HOST", "https://api.openai.com");
        std::env::set_var("OPENAI_API_KEY", "ambient-openai-key");
        let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [
                    {"key": "OPENAI_HOST", "value": local.uri()},
                    {"key": "OPENAI_API_KEY", "value": "candidate-openai-key"}
                ]
            }),
        )
        .await
        .expect_err("candidate custom host must override the ambient official host");
        assert!(error.to_string().contains("not supported"));
        assert!(local.received_requests().await.unwrap().is_empty());
        assert_eq!(
            provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
            before
        );
        std::env::remove_var("OPENAI_API_KEY");
        std::env::set_var("OPENAI_HOST", local.uri());

        for (host_key, candidate_host) in [("OPENAI_HOST", "https://api.openai.com/v1")] {
            let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
            let error = send_custom(
                conn.cx(),
                "_goose/unstable/providers/config/save",
                serde_json::json!({
                    "providerId": "openai",
                    "fields": [{"key": host_key, "value": candidate_host}]
                }),
            )
            .await
            .expect_err("candidate official host must override the ambient custom host");
            assert!(error.to_string().contains("API key is required"));
            assert_eq!(
                provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
                before
            );
        }

        let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
        let subdomain_error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [
                    {"key": "OPENAI_HOST", "value": "https://eu.api.openai.com"},
                    {"key": "OPENAI_API_KEY", "value": "candidate-subdomain-key"}
                ]
            }),
        )
        .await
        .expect_err("an OpenAI subdomain must not be trusted as an official credential origin");
        assert!(subdomain_error.to_string().contains("not supported"));
        assert!(!subdomain_error
            .to_string()
            .contains("candidate-subdomain-key"));
        assert!(local.received_requests().await.unwrap().is_empty());
        assert_eq!(
            provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
            before
        );
        std::env::remove_var("OPENAI_HOST");

        let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
        let dual_selector_error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [
                    {"key": "OPENAI_HOST", "value": "https://api.openai.com"},
                    {"key": "OPENAI_BASE_URL", "value": local.uri()},
                    {"key": "OPENAI_API_KEY", "value": "dual-selector-candidate-key"}
                ]
            }),
        )
        .await
        .expect_err("OpenAI host selectors must be mutually exclusive");
        let rendered = dual_selector_error.to_string();
        assert!(rendered.contains("mutually exclusive"));
        assert!(!rendered.contains("dual-selector-candidate-key"));
        assert!(local.received_requests().await.unwrap().is_empty());
        assert_eq!(
            provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
            before
        );

        for (candidate_host, expected_error) in [
            ("http://api.openai.com", "Invalid provider API origin"),
            ("https://api.openai.com:8443", "Invalid provider API origin"),
            (
                "https://user:pass@api.openai.com?token=openai-host-canary",
                "Invalid provider API URL",
            ),
            ("https://@api.openai.com", "Invalid provider API URL"),
            (
                "https://[malformed-openai-host-canary",
                "Invalid provider API URL",
            ),
        ] {
            let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
            let error = send_custom(
                conn.cx(),
                "_goose/unstable/providers/config/save",
                serde_json::json!({
                    "providerId": "openai",
                    "fields": [{"key": "OPENAI_HOST", "value": candidate_host}]
                }),
            )
            .await
            .expect_err("an invalid OpenAI host must fail before provider construction");
            let rendered = error.to_string();
            assert!(rendered.contains(expected_error));
            for secret in [
                candidate_host,
                "user",
                "pass",
                "token",
                "openai-host-canary",
                "malformed-openai-host-canary",
            ] {
                assert!(!rendered.contains(secret));
            }
            assert!(local.received_requests().await.unwrap().is_empty());
            assert_eq!(
                provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
                before
            );
        }

        let loopback_result = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [{"key": "OPENAI_HOST", "value": local.uri()}]
            }),
        )
        .await
        .expect("a loopback OpenAI-compatible host must remain valid without a key");
        assert_eq!(
            loopback_result
                .pointer("/status/isConfigured")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(local.received_requests().await.unwrap().is_empty());

        let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
        let stale_selector_error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [
                    {"key": "OPENAI_BASE_URL", "value": local.uri()},
                    {"key": "OPENAI_API_KEY", "value": "stale-selector-candidate-key"}
                ]
            }),
        )
        .await
        .expect_err("a persisted alternate selector must not coexist with a candidate selector");
        let rendered = stale_selector_error.to_string();
        assert!(rendered.contains("mutually exclusive"));
        assert!(!rendered.contains("stale-selector-candidate-key"));
        assert!(local.received_requests().await.unwrap().is_empty());
        assert_eq!(
            provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
            before
        );

        for (provider_id, key_name, host_name, canonical_hostname) in [
            ("openai", "OPENAI_API_KEY", "OPENAI_HOST", "api.openai.com"),
            (
                "anthropic",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_HOST",
                "api.anthropic.com",
            ),
            (
                "google",
                "GOOGLE_API_KEY",
                "GOOGLE_HOST",
                "generativelanguage.googleapis.com",
            ),
            ("xai", "XAI_API_KEY", "XAI_HOST", "api.x.ai"),
        ] {
            for candidate_host in [
                format!("http://{canonical_hostname}"),
                format!("https://{canonical_hostname}:8443"),
            ] {
                let before =
                    provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
                let error = send_custom(
                    conn.cx(),
                    "_goose/unstable/providers/config/save",
                    serde_json::json!({
                        "providerId": provider_id,
                        "fields": [
                            {"key": key_name, "value": "candidate-provider-key"},
                            {"key": host_name, "value": candidate_host}
                        ]
                    }),
                )
                .await
                .expect_err("insecure canonical vendor origin must fail closed");
                assert!(error.to_string().contains("Invalid provider API origin"));
                assert_eq!(
                    provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
                    before
                );
            }
        }

        let raw_url = "https://user:pass@api.openai.com/v1?access_token=url-userinfo-canary";
        let before = provider_persistence_snapshot(&config_dir, &data_root, &session_id).await;
        let error = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [
                    {"key": "OPENAI_API_KEY", "value": "candidate-userinfo-key"},
                    {"key": "OPENAI_BASE_URL", "value": raw_url}
                ]
            }),
        )
        .await
        .expect_err("userinfo URL must fail before construction and persistence");
        let rendered = error.to_string();
        for secret in [
            "user",
            "pass",
            "url-userinfo-canary",
            "candidate-userinfo-key",
            raw_url,
        ] {
            assert!(!rendered.contains(secret));
        }
        assert_eq!(
            provider_persistence_snapshot(&config_dir, &data_root, &session_id).await,
            before
        );
    });

    deny_proxy_stop.store(true, Ordering::Release);
    deny_proxy_thread.join().unwrap();
    assert_eq!(external_request_count.load(Ordering::Acquire), 0);
}

#[test]
#[serial]
fn acp_secret_mutations_and_inventory_refresh_invalidate_global_secret_cache() {
    let root_path = shared_test_root().to_string_lossy().to_string();
    let deny_proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    deny_proxy.set_nonblocking(true).unwrap();
    let deny_proxy_url = format!("http://{}", deny_proxy.local_addr().unwrap());
    let deny_proxy_stop = Arc::new(AtomicBool::new(false));
    let external_request_count = Arc::new(AtomicUsize::new(0));
    let deny_proxy_stop_thread = Arc::clone(&deny_proxy_stop);
    let external_request_count_thread = Arc::clone(&external_request_count);
    let deny_proxy_thread = std::thread::spawn(move || {
        while !deny_proxy_stop_thread.load(Ordering::Acquire) {
            match deny_proxy.accept() {
                Ok((_stream, _address)) => {
                    external_request_count_thread.fetch_add(1, Ordering::AcqRel);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::yield_now();
                }
                Err(error) => panic!("deny proxy accept failed: {error}"),
            }
        }
    });
    let _env = env_lock::lock_env([
        ("GOOSE_PATH_ROOT", Some(root_path.as_str())),
        ("GOOSE_DISABLE_KEYRING", Some("1")),
        ("ANTHROPIC_API_KEY", None),
        ("GROQ_API_KEY", None),
        ("OPENAI_API_KEY", None),
        ("OPENAI_HOST", None),
        ("XAI_API_KEY", Some("machine-primary-xai-key")),
        ("XAI_HOST", None),
        ("HTTP_PROXY", Some(deny_proxy_url.as_str())),
        ("HTTPS_PROXY", Some(deny_proxy_url.as_str())),
        ("ALL_PROXY", Some(deny_proxy_url.as_str())),
        ("NO_PROXY", Some("127.0.0.1,localhost")),
    ]);

    let config_dir = Paths::config_dir();
    let data_dir = Paths::data_dir();
    write_config(&config_dir);
    write_secrets(&config_dir, "GROQ_API_KEY: stale-key\n");
    Config::global().invalidate_secrets_cache();

    run_test(async move {
        assert_eq!(
            Config::global()
                .get_secret::<String>("GROQ_API_KEY")
                .unwrap(),
            "stale-key"
        );

        let openai = common_tests::fixtures::OpenAiFixture::new(
            vec![],
            Arc::new(EnforceSessionId::default()),
        )
        .await;
        let config = TestConnectionConfig {
            data_root: config_dir.clone(),
            provider_factory: Some(mock_provider_factory()),
            ..Default::default()
        };
        let conn = AcpServerConnection::new(config, openai).await;

        write_secrets(&config_dir, "GROQ_API_KEY: fresh-key\n");
        send_custom(
            conn.cx(),
            "_goose/unstable/dictation/secret/save",
            serde_json::json!({
                "provider": "groq",
                "value": "fresh-key",
            }),
        )
        .await
        .expect("dictation secret save should succeed");

        assert_eq!(
            Config::global()
                .get_secret::<String>("GROQ_API_KEY")
                .unwrap(),
            "fresh-key",
            "ACP dictation secret save should invalidate the global secrets cache"
        );

        write_secrets(&config_dir, "{}\n");
        send_custom(
            conn.cx(),
            "_goose/unstable/dictation/secret/delete",
            serde_json::json!({
                "provider": "groq",
            }),
        )
        .await
        .expect("dictation secret delete should succeed");

        assert!(
            matches!(
                Config::global().get_secret::<String>("GROQ_API_KEY"),
                Err(ConfigError::NotFound(_))
            ),
            "ACP dictation secret delete should invalidate the global secrets cache"
        );

        let xai = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .and(wiremock::matchers::header(
                "authorization",
                "Bearer xai-provider-config-key",
            ))
            .respond_with(wiremock::ResponseTemplate::new(401))
            .expect(0)
            .mount(&xai)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .and(wiremock::matchers::header(
                "authorization",
                "Bearer machine-primary-xai-key",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [{"id": "grok-local-fixture"}]})),
            )
            .expect(0)
            .mount(&xai)
            .await;

        let config_path = config_dir.join(goose::config::base::CONFIG_YAML_NAME);
        let secrets_path = config_dir.join("secrets.yaml");
        let config_before_candidate = std::fs::read(&config_path).unwrap();
        let secrets_before_candidate = std::fs::read(&secrets_path).unwrap();

        let save_provider_config = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "xai",
                "fields": [
                    {
                        "key": "XAI_API_KEY",
                        "value": "xai-provider-config-key",
                    },
                    {
                        "key": "XAI_HOST",
                        "value": xai.uri(),
                    },
                ],
            }),
        )
        .await
        .expect_err("invalid provider credentials must fail before persistence");
        assert!(save_provider_config
            .to_string()
            .contains("credential validation"));
        assert_eq!(
            Config::global()
                .get_secret::<String>("XAI_API_KEY")
                .unwrap(),
            "machine-primary-xai-key",
            "the rejected candidate must not replace the primary environment source"
        );
        assert_eq!(
            std::fs::read(&secrets_path).unwrap(),
            secrets_before_candidate,
            "rejected provider credentials must not change secret storage"
        );
        assert_eq!(
            std::fs::read(&config_path).unwrap(),
            config_before_candidate,
            "rejected provider credentials must not change persisted config"
        );
        assert!(
            Config::global().get_param::<String>("XAI_HOST").is_err(),
            "non-secret candidate fields must also remain uncommitted"
        );
        assert_eq!(Config::global().get_goose_provider().unwrap(), "openai");
        assert_eq!(Config::global().get_goose_model().unwrap(), "gpt-4o");
        assert!(
            xai.received_requests().await.unwrap().is_empty(),
            "an untrusted xAI host must fail closed before any request"
        );

        for (host_key, host_value) in [
            ("OPENAI_HOST", "https://API.OPENAI.COM/v1"),
            ("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        ] {
            let config_before_missing_key = std::fs::read(&config_path).unwrap();
            send_custom(
                conn.cx(),
                "_goose/unstable/providers/config/save",
                serde_json::json!({
                    "providerId": "openai",
                    "fields": [
                        {
                            "key": host_key,
                            "value": host_value,
                        },
                        {
                            "key": "OPENAI_BASE_PATH",
                            "value": "v1/chat/completions",
                        },
                    ],
                }),
            )
            .await
            .expect_err("the official OpenAI effective host must require credentials");
            assert_eq!(
                std::fs::read(&config_path).unwrap(),
                config_before_missing_key,
                "an official OpenAI host without a key must fail before any config write"
            );
        }

        std::env::set_var("OPENAI_API_KEY", "machine-openai-key");
        let local_openai_without_key = send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [
                    {
                        "key": "OPENAI_HOST",
                        "value": xai.uri(),
                    },
                    {
                        "key": "OPENAI_BASE_PATH",
                        "value": "v1/chat/completions",
                    },
                ],
            }),
        )
        .await
        .expect(
            "an explicit local OpenAI-compatible host may remain unauthenticated even when a machine OpenAI key exists",
        );
        std::env::remove_var("OPENAI_API_KEY");
        assert_eq!(
            local_openai_without_key
                .pointer("/status/isConfigured")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            Config::global().get_param::<String>("OPENAI_HOST").unwrap(),
            xai.uri()
        );

        send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [{"key": "OPENAI_BASE_URL", "value": xai.uri()}],
                "clearFields": ["OPENAI_HOST"],
            }),
        )
        .await
        .expect("a custom base URL must atomically replace a persisted host selector");
        assert!(Config::global().get_param::<String>("OPENAI_HOST").is_err());
        assert_eq!(
            Config::global()
                .get_param::<String>("OPENAI_BASE_URL")
                .unwrap(),
            xai.uri()
        );

        send_custom(
            conn.cx(),
            "_goose/unstable/providers/config/save",
            serde_json::json!({
                "providerId": "openai",
                "fields": [{"key": "OPENAI_HOST", "value": xai.uri()}],
                "clearFields": ["OPENAI_BASE_URL"],
            }),
        )
        .await
        .expect("a custom host must atomically replace a persisted base URL selector");
        assert!(Config::global()
            .get_param::<String>("OPENAI_BASE_URL")
            .is_err());
        assert_eq!(
            Config::global().get_param::<String>("OPENAI_HOST").unwrap(),
            xai.uri()
        );

        Config::global().invalidate_secrets_cache();
        assert!(Config::global()
            .get_secret::<String>("ANTHROPIC_API_KEY")
            .is_err());

        write_secrets(&config_dir, "ANTHROPIC_API_KEY: anthropic-key\n");

        let refresh = send_custom(
            conn.cx(),
            "_goose/unstable/providers/inventory/refresh",
            serde_json::json!({
                "providerIds": ["anthropic"],
            }),
        )
        .await
        .expect("inventory refresh should succeed");

        assert_eq!(
            refresh.get("started"),
            Some(&serde_json::json!(["anthropic"])),
            "inventory refresh should invalidate the global secrets cache before planning"
        );

        write_secrets(&config_dir, "OPENAI_API_KEY: plan-time-key\n");
        Config::global().invalidate_secrets_cache();

        let inventory = ProviderInventoryService::new(Arc::new(SessionStorage::new(data_dir)));
        let plan = inventory
            .plan_refresh(&["openai".to_string()])
            .await
            .expect("plan refresh should start for configured OpenAI provider");
        assert_eq!(plan.started, vec!["openai".to_string()]);

        let entry_during_refresh = inventory
            .entry_for_provider("openai")
            .await
            .expect("entry should load while refresh is in progress")
            .expect("OpenAI inventory entry should exist");
        assert!(
            entry_during_refresh.refreshing,
            "plan refresh should mark the plan-time identity as refreshing"
        );

        let sentinel_model = "stark-plan-time-model".to_string();
        inventory
            .store_refreshed_models("openai", std::slice::from_ref(&sentinel_model))
            .await
            .expect("public store_refreshed_models compatibility wrapper should succeed");

        let plan_time_entry = inventory
            .entry_for_provider("openai")
            .await
            .expect("entry should load for plan-time credentials")
            .expect("OpenAI inventory entry should exist for plan-time credentials");
        assert!(
            !plan_time_entry.refreshing,
            "store with captured identity should clear the plan-time refreshing key"
        );
        assert!(
            plan_time_entry
                .models
                .iter()
                .any(|model| model.id == sentinel_model),
            "models should be stored under the identity captured at plan time"
        );
    });

    deny_proxy_stop.store(true, Ordering::Release);
    deny_proxy_thread.join().unwrap();
    assert_eq!(
        external_request_count.load(Ordering::Acquire),
        0,
        "provider credential tests must not attempt any external request"
    );
}
