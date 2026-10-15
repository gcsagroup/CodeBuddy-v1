#![recursion_limit = "256"]

#[allow(dead_code)]
#[path = "acp_common_tests/mod.rs"]
mod common_tests;

use common_tests::fixtures::server::AcpServerConnection;
use common_tests::fixtures::{
    run_test, Connection, OpenAiFixture, PermissionDecision, Session, TestConnectionConfig,
};
use goose::acp::server::AcpProviderFactory;
use goose::config::declarative_providers::{DeclarativeProviderConfig, ProviderEngine};
use goose::config::paths::Paths;
use goose::providers::base::{ModelInfo, Provider};
use goose::providers::ollama_cloud::OllamaCloudProvider;
use goose::providers::utils::init_goose_request_log;
use goose::session::SessionManager;
use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const MODEL: &str = "kimi-k2.7-code";
const PROVIDER_ID: &str = "ollama_cloud";
const API_KEY: &str = "cp05a-loopback-api-key-canary";
const SERVER_CANARY: &str = "cp05a-upstream-500-body-canary";
const RATE_LIMIT_CANARY: &str = "cp05a-upstream-429-body-canary";
const BAD_REQUEST_CANARY: &str = "cp05a-upstream-400-body-canary";
const NOT_FOUND_CANARY: &str = "cp05a-upstream-404-body-canary";
const TERMINAL_SERVER_CANARY: &str = "cp05a-terminal-upstream-500-body-canary";
const COMPLETIONS_PATH: &str = "/v1/chat/completions";
const RECOVERY_MODE: usize = 0;
const BAD_REQUEST_MODE: usize = 1;
const NOT_FOUND_MODE: usize = 2;
const TERMINAL_SERVER_MODE: usize = 3;
const EXPECTED_RECOVERY_REQUESTS: usize = 3;
const EXPECTED_ATTEMPTS_PER_TERMINAL: usize = 4;
const TERMINAL_SCENARIO_COUNT: usize = 3;
const EXPECTED_TOTAL_REQUESTS: usize =
    EXPECTED_RECOVERY_REQUESTS + TERMINAL_SCENARIO_COUNT * EXPECTED_ATTEMPTS_PER_TERMINAL;

#[derive(Clone)]
struct TraceWriter(Arc<Mutex<Vec<u8>>>);

impl Write for TraceWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn assert_no_untrusted_canaries(label: &str, value: &str) {
    for canary in [
        API_KEY,
        SERVER_CANARY,
        RATE_LIMIT_CANARY,
        BAD_REQUEST_CANARY,
        NOT_FOUND_CANARY,
        TERMINAL_SERVER_CANARY,
    ] {
        assert!(
            !value.contains(canary),
            "{label} exposed untrusted provider data"
        );
    }
}

fn trace_bytes() -> Arc<Mutex<Vec<u8>>> {
    static TRACE_BYTES: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();

    Arc::clone(TRACE_BYTES.get_or_init(|| {
        let trace_bytes = Arc::new(Mutex::new(Vec::new()));
        tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer({
                let trace_bytes = Arc::clone(&trace_bytes);
                move || TraceWriter(Arc::clone(&trace_bytes))
            })
            .try_init()
            .expect("the independent integration test binary owns tracing initialization");
        trace_bytes
    }))
}

fn provider_config(base_url: String, provider_id: &str) -> DeclarativeProviderConfig {
    DeclarativeProviderConfig {
        name: provider_id.to_string(),
        engine: ProviderEngine::OpenAI,
        display_name: "Ollama Cloud".to_string(),
        description: Some("CP-05A loopback qualification fixture".to_string()),
        api_key_env: "CP05A_OLLAMA_API_KEY".to_string(),
        base_url,
        models: vec![ModelInfo::new(MODEL, 131_072)],
        headers: None,
        timeout_seconds: Some(10),
        supports_streaming: Some(true),
        requires_auth: true,
        catalog_provider_id: Some("ollama_cloud".to_string()),
        base_path: None,
        env_vars: None,
        dynamic_models: Some(false),
        skip_canonical_filtering: false,
        model_doc_link: None,
        setup_steps: vec![],
        fast_model: None,
        preserves_thinking: true,
    }
}

fn read_request_logs() -> String {
    let mut contents = String::new();
    for entry in std::fs::read_dir(Paths::logs_dir()).unwrap() {
        let path = entry.unwrap().path();
        let is_request_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("llm_request.") && name.ends_with(".jsonl"));
        if is_request_log {
            contents.push_str(&std::fs::read_to_string(path).unwrap());
        }
    }
    contents
}

#[test]
fn ollama_cloud_retries_sanitized_failures_through_agent_and_acp() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_string_lossy().to_string();
    let _environment = env_lock::lock_env([
        ("GOOSE_PATH_ROOT", Some(root_path.as_str())),
        ("GOOSE_PROVIDER_SKIP_BACKOFF", Some("true")),
        ("CP05A_OLLAMA_API_KEY", Some(API_KEY)),
    ]);

    let trace_bytes = trace_bytes();
    trace_bytes.lock().unwrap().clear();

    run_test({
        let trace_bytes = Arc::clone(&trace_bytes);
        async move {
            init_goose_request_log().expect("request logging must be active");

            let server = MockServer::start().await;
            let response_mode = Arc::new(AtomicUsize::new(RECOVERY_MODE));
            let attempts = Arc::new([
                AtomicUsize::new(0),
                AtomicUsize::new(0),
                AtomicUsize::new(0),
                AtomicUsize::new(0),
            ]);
            let request_modes = Arc::new(Mutex::new(Vec::new()));
            let responder_mode = Arc::clone(&response_mode);
            let responder_attempts = Arc::clone(&attempts);
            let responder_request_modes = Arc::clone(&request_modes);
            Mock::given(method("GET"))
                .and(path("/api/tags"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "models": [{"name": MODEL, "model": MODEL}]
                })))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/api/generate"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path(COMPLETIONS_PATH))
                .respond_with(move |_request: &wiremock::Request| {
                    let mode = responder_mode.load(Ordering::SeqCst);
                    responder_request_modes.lock().unwrap().push(mode);
                    let attempt = responder_attempts[mode].fetch_add(1, Ordering::SeqCst);
                    match (mode, attempt) {
                        (RECOVERY_MODE, 0) => {
                            ResponseTemplate::new(500).set_body_json(serde_json::json!({
                                "error": { "message": SERVER_CANARY }
                            }))
                        }
                        (RECOVERY_MODE, 1) => {
                            ResponseTemplate::new(429).set_body_json(serde_json::json!({
                                "error": { "message": RATE_LIMIT_CANARY }
                            }))
                        }
                        (RECOVERY_MODE, _) => ResponseTemplate::new(200)
                            .insert_header("content-type", "text/event-stream")
                            .set_body_string(include_str!("acp_test_data/openai_basic.txt")),
                        (BAD_REQUEST_MODE, _) => {
                            ResponseTemplate::new(400).set_body_json(serde_json::json!({
                                "error": { "message": BAD_REQUEST_CANARY }
                            }))
                        }
                        (NOT_FOUND_MODE, _) => {
                            ResponseTemplate::new(404).set_body_json(serde_json::json!({
                                "error": { "message": NOT_FOUND_CANARY }
                            }))
                        }
                        (TERMINAL_SERVER_MODE, _) => {
                            ResponseTemplate::new(500).set_body_json(serde_json::json!({
                                "error": { "message": TERMINAL_SERVER_CANARY }
                            }))
                        }
                        _ => unreachable!("unsupported response mode"),
                    }
                })
                .mount(&server)
                .await;

            let loopback_uri = server.uri();
            let config = provider_config(format!("{loopback_uri}/v1"), PROVIDER_ID);
            let data_root = root.path().join("acp-data");
            std::fs::create_dir_all(&data_root).unwrap();
            let config_dir = Paths::config_dir();
            std::fs::create_dir_all(&config_dir).unwrap();
            let config_yaml = format!("GOOSE_MODEL: {MODEL}\nGOOSE_PROVIDER: {PROVIDER_ID}\n");
            for root in [&data_root, &config_dir] {
                std::fs::write(
                    root.join(goose::config::base::CONFIG_YAML_NAME),
                    &config_yaml,
                )
                .unwrap();
            }
            let provider_factory: AcpProviderFactory = Arc::new(move |_, _, _| {
                let config = config.clone();
                Box::pin(async move {
                    let provider: Arc<dyn Provider> =
                        Arc::new(OllamaCloudProvider::from_custom_config(config, None)?);
                    Ok(provider)
                })
            });

            let openai = OpenAiFixture::new(
                vec![],
                <AcpServerConnection as Connection>::expected_session_id(),
            )
            .await;
            let mut connection = AcpServerConnection::new(
                TestConnectionConfig {
                    data_root: data_root.clone(),
                    current_model: MODEL.to_string(),
                    provider_factory: Some(provider_factory),
                    ..Default::default()
                },
                openai,
            )
            .await;
            let mut session = connection.new_session().await.unwrap().session;
            let output = session
                .prompt(
                    "Return the loopback fixture result.",
                    PermissionDecision::Cancel,
                )
                .await
                .unwrap();

            let received_requests = server.received_requests().await.unwrap();
            let completion_requests = received_requests
                .iter()
                .filter(|request| request.url.path() == COMPLETIONS_PATH)
                .collect::<Vec<_>>();
            assert_eq!(
                attempts[RECOVERY_MODE].load(Ordering::SeqCst),
                EXPECTED_RECOVERY_REQUESTS,
                "unexpected loopback requests at {loopback_uri}: {:?}; ACP output: {:?}",
                received_requests
                    .iter()
                    .map(|request| request.url.path())
                    .collect::<Vec<_>>(),
                output.text
            );
            assert_eq!(output.text, "2");
            assert_no_untrusted_canaries("ACP output", &output.text);
            let updates = serde_json::to_string(&session.session_updates()).unwrap();
            assert_no_untrusted_canaries("ACP updates", &updates);

            assert_eq!(completion_requests.len(), EXPECTED_RECOVERY_REQUESTS);
            assert!(received_requests.iter().all(|request| {
                request
                    .headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value == format!("Bearer {API_KEY}"))
            }));

            let terminal_cases = [
                (BAD_REQUEST_MODE, 400, "request settings"),
                (NOT_FOUND_MODE, 404, "endpoint or model"),
                (TERMINAL_SERVER_MODE, 500, "try again later"),
            ];
            for (mode, status, expected_action) in terminal_cases {
                response_mode.store(mode, Ordering::SeqCst);
                let output = session
                    .prompt(
                        &format!("Trigger the terminal {status} fixture."),
                        PermissionDecision::Cancel,
                    )
                    .await
                    .unwrap();

                let attempt_count = attempts[mode].load(Ordering::SeqCst);
                assert_eq!(
                    attempt_count, EXPECTED_ATTEMPTS_PER_TERMINAL,
                    "{status} must use the current default retry budget exactly"
                );
                assert!(
                    output.text.to_ascii_lowercase().contains(expected_action),
                    "{status} must retain its stable public recovery action: {:?}",
                    output.text
                );
                assert_no_untrusted_canaries("ACP terminal output", &output.text);
                let updates = serde_json::to_string(&session.session_updates()).unwrap();
                assert_no_untrusted_canaries("ACP terminal updates", &updates);
            }

            let received_requests = server.received_requests().await.unwrap();
            let completion_requests = received_requests
                .iter()
                .filter(|request| request.url.path() == COMPLETIONS_PATH)
                .collect::<Vec<_>>();
            let observed_modes = request_modes.lock().unwrap().clone();
            assert_eq!(completion_requests.len(), EXPECTED_TOTAL_REQUESTS);
            assert_eq!(observed_modes.len(), EXPECTED_TOTAL_REQUESTS);

            let mut expected_modes = vec![RECOVERY_MODE; EXPECTED_RECOVERY_REQUESTS];
            for mode in [BAD_REQUEST_MODE, NOT_FOUND_MODE, TERMINAL_SERVER_MODE] {
                expected_modes.extend(std::iter::repeat_n(mode, EXPECTED_ATTEMPTS_PER_TERMINAL));
            }
            let actual_sequence = completion_requests
                .iter()
                .zip(observed_modes.iter())
                .map(|(request, mode)| (*mode, request.url.path().to_string()))
                .collect::<Vec<_>>();
            let expected_sequence = expected_modes
                .into_iter()
                .map(|mode| (mode, COMPLETIONS_PATH.to_string()))
                .collect::<Vec<_>>();
            assert_eq!(actual_sequence, expected_sequence);

            let request_logs = read_request_logs();
            assert!(request_logs.contains(MODEL));
            assert!(request_logs.contains("\"2\""));
            assert_no_untrusted_canaries("request log", &request_logs);

            let session_manager = SessionManager::new(data_root);
            let mut persisted_text = String::new();
            for listed in session_manager.list_all_sessions().await.unwrap() {
                if let Some(conversation) = session_manager
                    .get_session(&listed.id, true)
                    .await
                    .unwrap()
                    .conversation
                {
                    for message in conversation.messages() {
                        persisted_text.push_str(&message.as_concat_text());
                    }
                }
            }
            assert!(persisted_text.contains("2"));
            assert_no_untrusted_canaries("Agent session", &persisted_text);

            let traces = String::from_utf8(trace_bytes.lock().unwrap().clone()).unwrap();
            assert!(traces.matches("Request failed, retrying").count() >= 2);
            assert_no_untrusted_canaries("tracing", &traces);
        }
    });
}
