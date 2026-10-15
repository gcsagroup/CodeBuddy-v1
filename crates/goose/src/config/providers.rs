use super::base::{Config, ConfigError};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_yaml::Mapping;
use std::env;
use tracing::warn;

const PROVIDERS_CONFIG_KEY: &str = "providers";
const ACTIVE_PROVIDER_KEY: &str = "active_provider";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ProviderEntry {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub configured: bool,
}

fn parse_providers_map(raw: Mapping) -> IndexMap<String, ProviderEntry> {
    let mut map = IndexMap::with_capacity(raw.len());
    for (k, v) in raw {
        match (k, serde_yaml::from_value::<ProviderEntry>(v)) {
            (serde_yaml::Value::String(key), Ok(entry)) => {
                map.insert(key, entry);
            }
            (k, v) => {
                warn!(
                    key = ?k,
                    value = ?v,
                    "Skipping malformed provider config entry"
                );
            }
        }
    }
    map
}

fn get_providers_map(config: &Config) -> IndexMap<String, ProviderEntry> {
    let raw: Mapping = config
        .get_param(PROVIDERS_CONFIG_KEY)
        .unwrap_or_else(|_| Default::default());
    parse_providers_map(raw)
}

pub fn get_provider_entry(config: &Config, name: &str) -> Option<ProviderEntry> {
    get_providers_map(config).get(name).cloned()
}

pub fn set_provider_entry(
    config: &Config,
    name: &str,
    entry: &ProviderEntry,
) -> Result<(), ConfigError> {
    let name = name.to_string();
    let entry = entry.clone();
    config.update_param::<Mapping, _, _>(PROVIDERS_CONFIG_KEY, |raw| {
        let mut map = parse_providers_map(raw);
        map.insert(name, entry);
        map
    })
}

pub fn get_active_provider(config: &Config) -> Option<String> {
    if let Ok(val) = env::var("GOOSE_PROVIDER") {
        return Some(val);
    }
    if let Ok(val) = config.get_param::<String>(ACTIVE_PROVIDER_KEY) {
        return Some(val);
    }
    config.get_param::<String>("GOOSE_PROVIDER").ok()
}

pub fn get_active_model(config: &Config) -> Option<String> {
    if let Ok(val) = env::var("GOOSE_MODEL") {
        return Some(val);
    }
    if let Some(provider_name) = get_active_provider(config) {
        if let Some(entry) = get_provider_entry(config, &provider_name) {
            if !entry.model.is_empty() {
                return Some(entry.model);
            }
        }
    }
    config.get_param::<String>("GOOSE_MODEL").ok()
}

fn complete_provider_model_pair(
    provider: String,
    model: String,
    source: &str,
) -> Result<(String, String), ConfigError> {
    let provider = provider.trim().to_string();
    let model = model.trim().to_string();
    if provider.is_empty() || model.is_empty() {
        return Err(ConfigError::DeserializeError(format!(
            "{source} provider and model must both be non-empty"
        )));
    }
    Ok((provider, model))
}

fn snapshot_string(values: &Mapping, key: &str) -> Result<Option<String>, ConfigError> {
    values
        .get(key)
        .cloned()
        .map(serde_yaml::from_value::<String>)
        .transpose()
        .map_err(ConfigError::from)
}

fn environment_string(key: &str) -> Result<Option<String>, ConfigError> {
    match env::var(key) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(ConfigError::DeserializeError(format!(
            "{key} must contain valid Unicode"
        ))),
    }
}

pub(crate) fn environment_provider_model_pair() -> Result<Option<(String, String)>, ConfigError> {
    let env_provider = environment_string("GOOSE_PROVIDER")?;
    let env_model = environment_string("GOOSE_MODEL")?;
    if env_provider.is_some() || env_model.is_some() {
        return match (env_provider, env_model) {
            (Some(provider), Some(model)) => {
                complete_provider_model_pair(provider, model, "environment").map(Some)
            }
            _ => Err(ConfigError::DeserializeError(
                "environment GOOSE_PROVIDER and GOOSE_MODEL must be configured together"
                    .to_string(),
            )),
        };
    }
    Ok(None)
}

pub(crate) fn get_active_provider_model_pair_from_snapshot(
    values: &Mapping,
) -> Result<Option<(String, String)>, ConfigError> {
    if let Some(pair) = environment_provider_model_pair()? {
        return Ok(Some(pair));
    }

    if let Some(provider) = snapshot_string(values, ACTIVE_PROVIDER_KEY)? {
        let raw_providers = values.get(PROVIDERS_CONFIG_KEY).cloned().ok_or_else(|| {
            ConfigError::DeserializeError(
                "structured active_provider requires a providers mapping".to_string(),
            )
        })?;
        let providers: IndexMap<String, ProviderEntry> =
            serde_yaml::from_value(raw_providers).map_err(ConfigError::from)?;
        let model = providers
            .get(provider.trim())
            .map(|entry| entry.model.clone())
            .ok_or_else(|| {
                ConfigError::DeserializeError(
                    "structured active_provider has no matching provider entry".to_string(),
                )
            })?;
        return complete_provider_model_pair(provider, model, "structured config").map(Some);
    }

    let legacy_provider = snapshot_string(values, "GOOSE_PROVIDER")?;
    let legacy_model = snapshot_string(values, "GOOSE_MODEL")?;
    match (legacy_provider, legacy_model) {
        (None, None) => Ok(None),
        (Some(provider), Some(model)) => {
            complete_provider_model_pair(provider, model, "legacy config").map(Some)
        }
        _ => Err(ConfigError::DeserializeError(
            "legacy GOOSE_PROVIDER and GOOSE_MODEL must be configured together".to_string(),
        )),
    }
}

pub fn get_active_provider_model_pair(
    config: &Config,
) -> Result<Option<(String, String)>, ConfigError> {
    if let Some(pair) = environment_provider_model_pair()? {
        return Ok(Some(pair));
    }
    let values = config.merged_values_snapshot()?;
    get_active_provider_model_pair_from_snapshot(&values)
}

pub fn set_active_provider(config: &Config, name: &str, model: &str) -> Result<(), ConfigError> {
    let mut providers = get_providers_map(config);
    let entry = ProviderEntry {
        enabled: true,
        model: model.to_string(),
        configured: true,
    };
    providers.insert(name.to_string(), entry);
    config.set_param_values(&[
        (
            ACTIVE_PROVIDER_KEY.to_string(),
            serde_json::Value::String(name.to_string()),
        ),
        (
            PROVIDERS_CONFIG_KEY.to_string(),
            serde_json::to_value(providers)?,
        ),
    ])
}

pub fn clear_active_provider(config: &Config) -> Result<(), ConfigError> {
    for key in [ACTIVE_PROVIDER_KEY, "GOOSE_PROVIDER", "GOOSE_MODEL"] {
        match config.delete(key) {
            Ok(()) | Err(ConfigError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier};
    use tempfile::NamedTempFile;

    fn new_test_config() -> Config {
        let config_file = NamedTempFile::new().unwrap();
        let secrets_file = NamedTempFile::new().unwrap();
        Config::new_with_file_secrets(config_file.path(), secrets_file.path()).unwrap()
    }

    #[test]
    fn test_set_and_get_provider_entry() {
        let config = new_test_config();
        let entry = ProviderEntry {
            enabled: true,
            model: "gpt-4o".to_string(),
            configured: true,
        };
        set_provider_entry(&config, "openai", &entry).unwrap();

        let loaded = get_provider_entry(&config, "openai").unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.model, "gpt-4o");
        assert!(loaded.configured);
    }

    #[test]
    fn test_set_active_provider_writes_structured_keys() {
        let config = new_test_config();
        set_active_provider(&config, "claude-acp", "current").unwrap();

        let active: String = config.get_param(ACTIVE_PROVIDER_KEY).unwrap();
        assert_eq!(active, "claude-acp");

        let entry = get_provider_entry(&config, "claude-acp").unwrap();
        assert!(entry.enabled);
        assert!(entry.configured);
        assert_eq!(entry.model, "current");
    }

    #[test]
    fn test_clear_active_provider_preserves_provider_entries() {
        let config = new_test_config();
        set_active_provider(&config, "openai", "gpt-4o").unwrap();

        clear_active_provider(&config).unwrap();

        assert!(get_active_provider(&config).is_none());
        let entry = get_provider_entry(&config, "openai").unwrap();
        assert_eq!(entry.model, "gpt-4o");
        assert!(entry.configured);
    }

    #[test]
    fn test_clear_active_provider_removes_legacy_keys() {
        let config = new_test_config();
        config.set_param("GOOSE_PROVIDER", "anthropic").unwrap();
        config.set_param("GOOSE_MODEL", "claude").unwrap();

        clear_active_provider(&config).unwrap();

        assert!(get_active_provider(&config).is_none());
        assert!(get_active_model(&config).is_none());
    }

    #[test]
    fn test_get_active_model_from_provider_entry() {
        let config = new_test_config();
        set_active_provider(&config, "openai", "gpt-4o").unwrap();

        let result = get_active_model(&config);
        assert_eq!(result, Some("gpt-4o".to_string()));
    }

    #[test]
    fn test_multiple_providers_preserved() {
        let config = new_test_config();
        set_active_provider(&config, "openai", "gpt-4o").unwrap();
        set_active_provider(&config, "anthropic", "claude-3-opus").unwrap();

        let openai = get_provider_entry(&config, "openai").unwrap();
        assert_eq!(openai.model, "gpt-4o");
        assert!(openai.configured);

        let anthropic = get_provider_entry(&config, "anthropic").unwrap();
        assert_eq!(anthropic.model, "claude-3-opus");
        assert!(anthropic.configured);

        assert_eq!(get_active_provider(&config), Some("anthropic".to_string()));
    }

    #[test]
    fn active_provider_model_pair_uses_one_complete_source_and_fails_closed() {
        let _env = env_lock::lock_env([
            ("GOOSE_PROVIDER", None::<&str>),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.yaml");
        std::fs::write(
            &config_path,
            "GOOSE_PROVIDER: legacy-provider\nGOOSE_MODEL: legacy-model\n",
        )
        .unwrap();
        let config =
            Config::new_with_file_secrets(config_path, dir.path().join("secrets.yaml")).unwrap();
        assert_eq!(
            get_active_provider_model_pair(&config).unwrap(),
            Some(("legacy-provider".to_string(), "legacy-model".to_string()))
        );

        set_active_provider(&config, "structured-provider", "structured-model").unwrap();
        assert_eq!(
            get_active_provider_model_pair(&config).unwrap(),
            Some((
                "structured-provider".to_string(),
                "structured-model".to_string()
            ))
        );

        config
            .set_param(ACTIVE_PROVIDER_KEY, "missing-structured-provider")
            .unwrap();
        assert!(get_active_provider_model_pair(&config).is_err());
        drop(_env);

        let _env = env_lock::lock_env([
            ("GOOSE_PROVIDER", Some("environment-provider")),
            ("GOOSE_MODEL", Some("environment-model")),
        ]);
        assert_eq!(
            get_active_provider_model_pair(&config).unwrap(),
            Some((
                "environment-provider".to_string(),
                "environment-model".to_string()
            ))
        );
        drop(_env);

        let _env = env_lock::lock_env([
            ("GOOSE_PROVIDER", Some("environment-provider")),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        assert!(get_active_provider_model_pair(&config).is_err());
    }

    fn layered_pair_config(higher_path: std::path::PathBuf, dir: &std::path::Path) -> Config {
        let lower_path = dir.join("lower.yaml");
        std::fs::write(
            &lower_path,
            "active_provider: provider-a\nproviders:\n  provider-a:\n    enabled: true\n    model: model-a\n    configured: true\n",
        )
        .unwrap();
        Config::new_with_config_paths(vec![lower_path, higher_path], dir.join("secrets.yaml"))
            .unwrap()
    }

    #[test]
    fn active_provider_model_pair_rejects_malformed_higher_layer_instead_of_falling_back() {
        let _env = env_lock::lock_env([
            ("GOOSE_PROVIDER", None::<&str>),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let higher_path = dir.path().join("higher.yaml");
        std::fs::write(&higher_path, "active_provider: [malformed\n").unwrap();
        let config = layered_pair_config(higher_path, dir.path());

        assert!(get_active_provider_model_pair(&config).is_err());
    }

    #[test]
    fn active_provider_model_pair_rejects_higher_layer_read_errors_but_allows_not_found() {
        let _env = env_lock::lock_env([
            ("GOOSE_PROVIDER", None::<&str>),
            ("GOOSE_MODEL", None::<&str>),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let higher_directory = dir.path().join("higher-directory");
        std::fs::create_dir(&higher_directory).unwrap();
        let unreadable = layered_pair_config(higher_directory, dir.path());
        assert!(get_active_provider_model_pair(&unreadable).is_err());

        let missing = layered_pair_config(dir.path().join("missing.yaml"), dir.path());
        assert_eq!(
            get_active_provider_model_pair(&missing).unwrap(),
            Some(("provider-a".to_string(), "model-a".to_string()))
        );
    }

    #[test]
    fn active_provider_model_pair_is_one_locked_layered_snapshot_under_concurrent_commits() {
        let _env = env_lock::lock_env([
            ("GOOSE_PROVIDER", None::<&str>),
            ("GOOSE_MODEL", None::<&str>),
            ("ACTIVE_PROVIDER", None::<&str>),
            ("PROVIDERS", None::<&str>),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let base_path = dir.path().join("base.yaml");
        let user_path = dir.path().join("user.yaml");
        std::fs::write(&base_path, "layered_marker: preserved\n").unwrap();
        let config = Arc::new(
            Config::new_with_config_paths(
                vec![base_path, user_path],
                dir.path().join("secrets.yaml"),
            )
            .unwrap(),
        );
        set_active_provider(&config, "provider-a", "model-a").unwrap();

        let start = Arc::new(Barrier::new(2));
        let running = Arc::new(AtomicBool::new(true));
        let writer_config = Arc::clone(&config);
        let writer_start = Arc::clone(&start);
        let writer_running = Arc::clone(&running);
        let writer = std::thread::spawn(move || {
            writer_start.wait();
            for index in 0..2_000 {
                let (provider, model) = if index % 2 == 0 {
                    ("provider-b", "model-b")
                } else {
                    ("provider-a", "model-a")
                };
                set_active_provider(&writer_config, provider, model).unwrap();
            }
            writer_running.store(false, Ordering::SeqCst);
        });

        start.wait();
        let mut reads = 0usize;
        while running.load(Ordering::SeqCst) || reads < 2_000 {
            let pair = get_active_provider_model_pair(&config)
                .unwrap()
                .expect("a committed provider/model pair must remain configured");
            assert!(
                pair == ("provider-a".to_string(), "model-a".to_string())
                    || pair == ("provider-b".to_string(), "model-b".to_string()),
                "reader observed a torn provider/model pair: {pair:?}"
            );
            reads += 1;
        }
        writer.join().unwrap();

        let source = include_str!("providers.rs").replace("\r\n", "\n");
        let pair_reader = source
            .split_once("pub fn get_active_provider_model_pair(")
            .and_then(|(_, tail)| tail.split_once("pub fn set_active_provider("))
            .map(|(body, _)| body)
            .expect("active pair reader production body");
        assert_eq!(pair_reader.matches("merged_values_snapshot").count(), 1);
        assert!(!pair_reader.contains("get_active_provider(config)"));
        assert!(!pair_reader.contains("get_active_model(config)"));
        assert!(!pair_reader.contains("all_values"));
    }
}
