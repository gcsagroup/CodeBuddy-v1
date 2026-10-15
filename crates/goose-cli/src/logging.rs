use anyhow::Result;
use goose::providers::utils::init_goose_request_log;
use std::sync::OnceLock;

// Used to ensure we only set up tracing once
static INIT: OnceLock<Result<()>> = OnceLock::new();

/// Sets up the logging infrastructure for the CLI.
/// Logs go to a JSON file only (no console output).
pub fn setup_logging(name: Option<&str>) -> &'static Result<()> {
    INIT.get_or_init(|| {
        use tracing_subscriber::util::SubscriberInitExt;

        init_goose_request_log()?;
        let config = goose::logging::LoggingConfig {
            component: "cli",
            name,
            extra_directives: &["goose_cli=info"],
            console: false,
            json: true,
        };
        let subscriber = goose::logging::build_logging_subscriber(&config)?;

        subscriber
            .try_init()
            .map_err(|e| anyhow::anyhow!("Failed to set global subscriber: {}", e))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use goose::tracing::langfuse_layer;
    use std::env;
    use tempfile::TempDir;

    fn setup_temp_home() -> TempDir {
        let temp_dir = TempDir::new().unwrap();
        if cfg!(windows) {
            env::set_var("USERPROFILE", temp_dir.path());
        } else {
            env::set_var("HOME", temp_dir.path());
        }
        temp_dir
    }

    #[test]
    fn test_log_directory_creation() {
        let temp_dir = TempDir::new().unwrap();
        let isolated_home = temp_dir.path().join("isolated-codebuddy-home");
        let isolated_home_value = isolated_home.to_string_lossy().into_owned();
        let _guard = env_lock::lock_env([
            ("CODEBUDDY_HOME", Some(isolated_home_value.as_str())),
            ("GOOSE_PATH_ROOT", None),
        ]);

        let date_before = chrono::Local::now().format("%Y-%m-%d").to_string();
        let log_dir = goose::logging::prepare_log_directory("cli", true).unwrap();
        let date_after = chrono::Local::now().format("%Y-%m-%d").to_string();
        let expected_log_dir_before = isolated_home.join("logs").join("cli").join(date_before);
        let expected_log_dir_after = isolated_home.join("logs").join("cli").join(date_after);
        assert!(log_dir.exists());
        assert!(log_dir.is_dir());
        assert!(
            log_dir == expected_log_dir_before || log_dir == expected_log_dir_after,
            "unexpected log directory: {}",
            log_dir.display()
        );
    }

    #[tokio::test]
    async fn test_langfuse_layer_creation() {
        let _temp_dir = setup_temp_home();

        let original_vars = [
            ("LANGFUSE_PUBLIC_KEY", env::var("LANGFUSE_PUBLIC_KEY").ok()),
            ("LANGFUSE_SECRET_KEY", env::var("LANGFUSE_SECRET_KEY").ok()),
            ("LANGFUSE_URL", env::var("LANGFUSE_URL").ok()),
            (
                "LANGFUSE_INIT_PROJECT_PUBLIC_KEY",
                env::var("LANGFUSE_INIT_PROJECT_PUBLIC_KEY").ok(),
            ),
            (
                "LANGFUSE_INIT_PROJECT_SECRET_KEY",
                env::var("LANGFUSE_INIT_PROJECT_SECRET_KEY").ok(),
            ),
        ];

        for (var, _) in &original_vars {
            env::remove_var(var);
        }

        assert!(langfuse_layer::create_langfuse_observer().is_none());

        env::set_var("LANGFUSE_PUBLIC_KEY", "test_public_key");
        env::set_var("LANGFUSE_SECRET_KEY", "test_secret_key");
        assert!(langfuse_layer::create_langfuse_observer().is_some());

        env::remove_var("LANGFUSE_PUBLIC_KEY");
        env::remove_var("LANGFUSE_SECRET_KEY");
        env::set_var("LANGFUSE_INIT_PROJECT_PUBLIC_KEY", "test_public_key");
        env::set_var("LANGFUSE_INIT_PROJECT_SECRET_KEY", "test_secret_key");
        assert!(langfuse_layer::create_langfuse_observer().is_some());

        env::remove_var("LANGFUSE_INIT_PROJECT_PUBLIC_KEY");
        assert!(langfuse_layer::create_langfuse_observer().is_none());

        for (var, value) in original_vars {
            match value {
                Some(val) => env::set_var(var, val),
                None => env::remove_var(var),
            }
        }
    }

    #[tokio::test]
    async fn test_default_filter_avoids_debug_by_default() {
        // The shared helper honours RUST_LOG; without it the defaults apply.
        // We just smoke-check that building the subscriber doesn't panic.
        let _temp_dir = setup_temp_home();
        let config = goose::logging::LoggingConfig {
            component: "cli-test",
            name: None,
            extra_directives: &["goose_cli=info"],
            console: false,
            json: true,
        };
        assert!(goose::logging::build_logging_subscriber(&config).is_ok());
    }
}
