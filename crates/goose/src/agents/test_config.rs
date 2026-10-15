use serde::Deserialize;
use std::path::Path;

const CONFIG_RELATIVE_PATH: &str = ".codepro/test-config.yml";

#[derive(Debug, Default, Clone, Deserialize)]
pub(crate) struct TestConfig {
    #[serde(default)]
    test_cmd: Option<String>,
    #[serde(default)]
    pass_to_pass: Vec<String>,
}

impl TestConfig {
    pub(crate) async fn load(working_dir: &Path) -> Self {
        let path = working_dir.join(CONFIG_RELATIVE_PATH);
        match tokio::fs::read_to_string(&path).await {
            Ok(contents) => serde_yaml::from_str(&contents).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub(crate) fn test_cmd(&self) -> Option<&str> {
        self.test_cmd
            .as_deref()
            .map(str::trim)
            .filter(|cmd| !cmd.is_empty())
    }

    pub(crate) fn pass_to_pass(&self) -> &[String] {
        &self.pass_to_pass
    }
}

#[cfg(test)]
mod tests {
    use super::TestConfig;

    #[tokio::test]
    async fn returns_none_when_config_file_missing() {
        let project = tempfile::tempdir().unwrap();
        let config = TestConfig::load(project.path()).await;
        assert!(config.test_cmd().is_none());
    }

    #[tokio::test]
    async fn loads_test_cmd_from_config_file() {
        let project = tempfile::tempdir().unwrap();
        let config_dir = project.path().join(".codepro");
        tokio::fs::create_dir_all(&config_dir).await.unwrap();
        tokio::fs::write(
            config_dir.join("test-config.yml"),
            "test_cmd: cargo test -p goose --lib\n",
        )
        .await
        .unwrap();

        let config = TestConfig::load(project.path()).await;
        assert_eq!(config.test_cmd(), Some("cargo test -p goose --lib"));
    }

    #[tokio::test]
    async fn treats_empty_or_whitespace_only_cmd_as_missing() {
        let project = tempfile::tempdir().unwrap();
        let config_dir = project.path().join(".codepro");
        tokio::fs::create_dir_all(&config_dir).await.unwrap();
        tokio::fs::write(config_dir.join("test-config.yml"), "test_cmd: \"   \"\n")
            .await
            .unwrap();

        let config = TestConfig::load(project.path()).await;
        assert!(config.test_cmd().is_none());
    }

    #[tokio::test]
    async fn malformed_yaml_falls_back_to_default() {
        let project = tempfile::tempdir().unwrap();
        let config_dir = project.path().join(".codepro");
        tokio::fs::create_dir_all(&config_dir).await.unwrap();
        tokio::fs::write(
            config_dir.join("test-config.yml"),
            "this: is: not: valid: yaml:\n  - [unterminated",
        )
        .await
        .unwrap();

        let config = TestConfig::load(project.path()).await;
        assert!(config.test_cmd().is_none());
    }

    #[tokio::test]
    async fn config_without_test_cmd_key_is_valid_but_empty() {
        let project = tempfile::tempdir().unwrap();
        let config_dir = project.path().join(".codepro");
        tokio::fs::create_dir_all(&config_dir).await.unwrap();
        tokio::fs::write(config_dir.join("test-config.yml"), "other_key: value\n")
            .await
            .unwrap();

        let config = TestConfig::load(project.path()).await;
        assert!(config.test_cmd().is_none());
    }

    #[tokio::test]
    async fn trims_whitespace_around_command() {
        let project = tempfile::tempdir().unwrap();
        let config_dir = project.path().join(".codepro");
        tokio::fs::create_dir_all(&config_dir).await.unwrap();
        tokio::fs::write(
            config_dir.join("test-config.yml"),
            "test_cmd: \"  pytest -q  \"\n",
        )
        .await
        .unwrap();

        let config = TestConfig::load(project.path()).await;
        assert_eq!(config.test_cmd(), Some("pytest -q"));
    }

    #[tokio::test]
    async fn loads_pass_to_pass_list() {
        let project = tempfile::tempdir().unwrap();
        let config_dir = project.path().join(".codepro");
        tokio::fs::create_dir_all(&config_dir).await.unwrap();
        tokio::fs::write(
            config_dir.join("test-config.yml"),
            "test_cmd: pytest\npass_to_pass:\n  - test_foo\n  - test_bar\n",
        )
        .await
        .unwrap();

        let config = TestConfig::load(project.path()).await;
        assert_eq!(config.pass_to_pass(), &["test_foo", "test_bar"]);
    }

    #[tokio::test]
    async fn pass_to_pass_defaults_to_empty() {
        let project = tempfile::tempdir().unwrap();
        let config = TestConfig::load(project.path()).await;
        assert!(config.pass_to_pass().is_empty());
    }
}
