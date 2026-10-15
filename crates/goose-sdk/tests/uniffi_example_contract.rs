const PROVIDER_EXAMPLE: &str = include_str!("../examples/uniffi/provider.py");
const LOCAL_MOCK_FIXTURE: &str = include_str!("../examples/local_mock.json");
const EXAMPLE_README: &str = include_str!("../examples/uniffi/README.md");
const SDK_README: &str = include_str!("../README.md");
const SDK_JUSTFILE: &str = include_str!("../justfile");
const KOTLIN_EXAMPLE: &str = include_str!("../examples/uniffi/kotlin/src/main/kotlin/Main.kt");
const KOTLIN_README: &str = include_str!("../examples/uniffi/kotlin/README.md");

#[test]
fn uniffi_example_uses_only_an_anonymous_loopback_provider() {
    assert!(PROVIDER_EXAMPLE.contains("anonymous-local-provider.json"));
    assert!(PROVIDER_EXAMPLE.contains("local-mock-model"));
    assert!(!PROVIDER_EXAMPLE.to_ascii_lowercase().contains("deepseek"));

    assert!(LOCAL_MOCK_FIXTURE.contains(r#""requires_auth": false"#));
    assert!(LOCAL_MOCK_FIXTURE.contains(r#""api_key_env": """#));
    assert!(LOCAL_MOCK_FIXTURE.contains(r#""base_url": "http://127.0.0.1:"#));
    assert!(!LOCAL_MOCK_FIXTURE.contains("https://"));
    assert!(!LOCAL_MOCK_FIXTURE.contains("DEEPSEEK_API_KEY"));
    assert!(!LOCAL_MOCK_FIXTURE.to_ascii_lowercase().contains("bearer "));

    for documentation in [EXAMPLE_README, SDK_README, KOTLIN_README] {
        assert!(documentation.contains("anonymous"));
        assert!(documentation.contains("127.0.0.1:8000"));
        assert!(!documentation.contains("DEEPSEEK_API_KEY"));
        assert!(!documentation.contains("OPENAI_API_KEY"));
        assert!(!documentation.contains("DATABRICKS_TOKEN"));
    }
    assert!(KOTLIN_EXAMPLE.contains("declarativeProviderFromJson"));
    assert!(KOTLIN_EXAMPLE.contains("local-mock-model"));
    assert!(!KOTLIN_EXAMPLE.contains("System.getenv"));
    assert!(!KOTLIN_EXAMPLE.contains("openAiProvider"));
    assert!(SDK_JUSTFILE.contains("local_mock_config"));
    assert!(SDK_JUSTFILE.contains("provider.py {{local_mock_config}}"));
    assert!(SDK_JUSTFILE.contains("run --args='../../local_mock.json'"));
}
