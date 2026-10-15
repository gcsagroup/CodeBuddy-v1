use super::base::Config;
use crate::agents::extension::PLATFORM_EXTENSIONS;
use crate::agents::ExtensionConfig;
use anyhow::Result;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_yaml::Mapping;
use tracing::warn;

pub const DEFAULT_EXTENSION: &str = "developer";
pub const DEFAULT_EXTENSION_TIMEOUT: u64 = 300;
pub const DEFAULT_EXTENSION_DESCRIPTION: &str = "";
pub const DEFAULT_DISPLAY_NAME: &str = "Developer";
const EXTENSIONS_CONFIG_KEY: &str = "extensions";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExtensionEntry {
    pub enabled: bool,
    #[serde(flatten)]
    pub config: ExtensionConfig,
}

pub fn name_to_key(name: &str) -> String {
    let mut result = String::with_capacity(name.len());
    for c in name.chars() {
        result.push(match c {
            c if c.is_ascii_alphanumeric() || c == '_' || c == '-' => c,
            c if c.is_whitespace() => continue,
            _ => '_',
        });
    }
    result.to_lowercase()
}

/// The sole desktop executor. Old platform entries migrate at the config boundary.
pub fn computer_mcp_config(available_tools: Vec<String>) -> ExtensionConfig {
    ExtensionConfig::Builtin {
        name: "qwen_computer".into(),
        description: "Computer control through MCP".into(),
        display_name: Some("Computer control".into()),
        timeout: Some(60),
        bundled: Some(true),
        available_tools,
    }
}

pub(crate) fn computer_model_supports_host_tools(effective_model: &str) -> bool {
    let Some((provider, model)) = effective_model.split_once('/') else {
        return false;
    };
    !provider.trim().is_empty()
        && !model.trim().is_empty()
        && !provider.eq_ignore_ascii_case("codex")
        && !provider.eq_ignore_ascii_case("unknown")
}

pub(crate) fn is_retired_computer(config: &ExtensionConfig) -> bool {
    matches!(config, ExtensionConfig::Platform { name, .. } | ExtensionConfig::Builtin { name, .. }
        if name_to_key(name) == "computer")
}

fn migrate_retired_computer(config: &ExtensionConfig) -> Option<ExtensionConfig> {
    let available_tools = match config {
        ExtensionConfig::Platform {
            available_tools, ..
        }
        | ExtensionConfig::Builtin {
            available_tools, ..
        } => available_tools,
        _ => return None,
    };
    if available_tools.is_empty() {
        return Some(computer_mcp_config(Vec::new()));
    }
    // A restricted historical worker must not gain the full desktop tool set on resume.
    let mut mapped = available_tools
        .iter()
        .filter_map(|name| match name.as_str() {
            "computer_observe" => Some("list_apps".to_string()),
            "computer_observe_ui"
            | "computer_search_ui"
            | "computer_inspect_ui"
            | "computer_screenshot"
            | "computer_read_screen_text"
            | "computer_wait" => Some("get_app_state".to_string()),
            "computer_click" => Some("click".to_string()),
            "computer_drag" => Some("drag".to_string()),
            "computer_scroll" => Some("scroll".to_string()),
            "computer_type" => Some("type_text".to_string()),
            "computer_key" => Some("press_key".to_string()),
            "computer_set_value_ui" => Some("set_value".to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    mapped.sort();
    mapped.dedup();
    (!mapped.is_empty()).then(|| computer_mcp_config(mapped))
}

pub(crate) fn migrate_computer_extensions(
    extensions: Vec<ExtensionConfig>,
) -> Vec<ExtensionConfig> {
    let has_mcp = extensions
        .iter()
        .any(|e| matches!(e, ExtensionConfig::Builtin { name, .. } if name == "qwen_computer"));
    let mut migrated = has_mcp;
    extensions
        .into_iter()
        .filter_map(|e| {
            if is_retired_computer(&e) {
                if migrated {
                    None
                } else {
                    migrated = true;
                    migrate_retired_computer(&e)
                }
            } else if is_extension_available(&e) {
                Some(e)
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn is_extension_available(config: &ExtensionConfig) -> bool {
    if is_retired_computer(config) {
        return false;
    }
    match config {
        ExtensionConfig::Builtin { name, .. } if name_to_key(name) == "tutorial" => false,
        ExtensionConfig::Platform { name, .. } => {
            crate::agents::extension::PLATFORM_EXTENSIONS.contains_key(name_to_key(name).as_str())
        }
        _ => true,
    }
}

fn parse_extensions_map(raw: &Mapping) -> IndexMap<String, ExtensionEntry> {
    let mut extensions_map = IndexMap::with_capacity(raw.len());
    let mut legacy_computer = None;
    for (k, v) in raw {
        let Some(key) = k.as_str() else {
            warn!(key = ?k, "Skipping malformed extension config entry");
            continue;
        };

        match serde_yaml::from_value::<ExtensionEntry>(v.clone()) {
            Ok(entry) => {
                if is_retired_computer(&entry.config) {
                    legacy_computer =
                        migrate_retired_computer(&entry.config).map(|config| ExtensionEntry {
                            enabled: entry.enabled,
                            config,
                        });
                    continue;
                }
                if !is_extension_available(&entry.config) {
                    continue;
                }
                extensions_map.insert(key.to_string(), entry);
            }
            Err(err) => {
                warn!(
                    key = %key,
                    error = %err,
                    "Skipping malformed extension config entry"
                );
            }
        }
    }

    if !extensions_map.values().any(
        |e| matches!(&e.config, ExtensionConfig::Builtin { name, .. } if name == "qwen_computer"),
    ) {
        if let Some(entry) = legacy_computer {
            extensions_map.insert("qwen_computer".into(), entry);
        }
    }
    extensions_map
}

fn get_extensions_map_with_config(config: &Config) -> IndexMap<String, ExtensionEntry> {
    let raw: Mapping = config
        .get_param(EXTENSIONS_CONFIG_KEY)
        .unwrap_or_else(|err| {
            warn!(
                "Failed to load {}: {err}. Falling back to empty object.",
                EXTENSIONS_CONFIG_KEY
            );
            Default::default()
        });

    parse_extensions_map(&raw)
}

fn get_extensions_map() -> IndexMap<String, ExtensionEntry> {
    get_extensions_map_with_config(Config::global())
}

enum ExtensionMutation {
    Upsert(String, Box<ExtensionEntry>),
    Remove(String),
    Noop,
}

fn with_raw_extensions_mapping<F>(config: &Config, mutate: F)
where
    F: FnOnce(&mut IndexMap<String, ExtensionEntry>) -> ExtensionMutation,
{
    let mut serialize_error = None;
    let result = config.update_param::<Mapping, Mapping, _>(EXTENSIONS_CONFIG_KEY, |mut raw| {
        let mut extensions = parse_extensions_map(&raw);
        let retired_keys = raw
            .iter()
            .filter_map(|(key, value)| {
                serde_yaml::from_value::<ExtensionEntry>(value.clone())
                    .ok()
                    .filter(|entry| is_retired_computer(&entry.config))
                    .map(|_| key.clone())
            })
            .collect::<Vec<_>>();
        if !retired_keys.is_empty() {
            for key in retired_keys {
                raw.shift_remove(&key);
            }
            if let Some(entry) = extensions.get("qwen_computer") {
                if let Ok(value) = serde_yaml::to_value(entry) {
                    raw.insert(serde_yaml::Value::String("qwen_computer".into()), value);
                }
            }
        }

        match mutate(&mut extensions) {
            ExtensionMutation::Upsert(key, entry) => match serde_yaml::to_value(entry) {
                Ok(value) => {
                    raw.insert(serde_yaml::Value::String(key), value);
                }
                Err(err) => {
                    serialize_error = Some(err);
                }
            },
            ExtensionMutation::Remove(key) => {
                raw.shift_remove(key.as_str());
            }
            ExtensionMutation::Noop => {}
        }

        raw
    });

    if let Some(e) = serialize_error {
        warn!("Failed to serialize extensions config entry: {}", e);
    } else if let Err(e) = result {
        warn!("Failed to save extensions config: {}", e);
    }
}

pub fn get_extension_by_name(name: &str) -> Option<ExtensionConfig> {
    get_extension_by_name_with_config(Config::global(), name)
}

fn get_extension_by_name_with_config(config: &Config, name: &str) -> Option<ExtensionConfig> {
    let extensions = get_extensions_map_with_config(config);
    let key = name_to_key(name);

    if let Some(entry) = extensions
        .values()
        .find(|entry| entry.config.name() == name)
        .or_else(|| extensions.get(&key))
    {
        return Some(entry.config.clone());
    }

    get_available_extensions()
        .into_iter()
        .find(|config| config.name() == name || config.key() == key)
}

pub fn set_extension(entry: ExtensionEntry) {
    set_extension_with_config(Config::global(), entry);
}

/// Replaces an existing entry in one atomic config-file update.
/// Returns false without writing when the source key does not exist.
pub fn replace_extension(key: &str, entry: ExtensionEntry) -> Result<bool> {
    let config = Config::global();
    let old_key = serde_yaml::Value::String(key.to_string());
    let new_key = serde_yaml::Value::String(entry.config.key());
    let new_value = serde_yaml::to_value(entry)?;
    let mut replaced = false;

    config.update_param::<Mapping, Mapping, _>(EXTENSIONS_CONFIG_KEY, |mut raw| {
        if raw.contains_key(&old_key) {
            raw.remove(&old_key);
            raw.insert(new_key, new_value);
            replaced = true;
        }
        raw
    })?;

    Ok(replaced)
}

fn set_extension_with_config(config: &Config, entry: ExtensionEntry) {
    let key = entry.config.key();
    with_raw_extensions_mapping(config, |_| ExtensionMutation::Upsert(key, Box::new(entry)));
}

pub fn remove_extension(key: &str) {
    remove_extension_with_config(Config::global(), key);
}

fn remove_extension_with_config(config: &Config, key: &str) {
    with_raw_extensions_mapping(config, |_| ExtensionMutation::Remove(key.to_string()));
}

/// Returns true when an existing extension was updated, false when the key was missing.
pub fn set_extension_enabled(key: &str, enabled: bool) -> bool {
    set_extension_enabled_with_config(Config::global(), key, enabled)
}

fn set_extension_enabled_with_config(config: &Config, key: &str, enabled: bool) -> bool {
    let mut updated = false;
    with_raw_extensions_mapping(config, |extensions| {
        let Some(entry) = extensions.get_mut(key) else {
            return ExtensionMutation::Noop;
        };

        entry.enabled = enabled;
        updated = true;
        ExtensionMutation::Upsert(key.to_string(), Box::new(entry.clone()))
    });

    updated
}

pub fn get_all_extensions() -> Vec<ExtensionEntry> {
    let extensions = get_extensions_map();
    extensions.into_values().collect()
}

pub fn get_all_extension_names() -> Vec<String> {
    let extensions = get_extensions_map();
    extensions.keys().cloned().collect()
}

pub fn is_extension_enabled(key: &str) -> bool {
    let extensions = get_extensions_map();
    extensions.get(key).map(|e| e.enabled).unwrap_or(false)
}

pub fn get_enabled_extensions() -> Vec<ExtensionConfig> {
    get_all_extensions()
        .into_iter()
        .filter(|ext| ext.enabled)
        .map(|ext| ext.config)
        .collect()
}

pub fn get_enabled_extensions_with_config(config: &Config) -> Vec<ExtensionConfig> {
    get_extensions_map_with_config(config)
        .into_values()
        .filter(|ext| ext.enabled)
        .map(|ext| ext.config)
        .collect()
}

pub fn get_available_extensions() -> Vec<ExtensionConfig> {
    let mut builtin_names = crate::builtin_extension::get_builtin_extension_names();
    #[cfg(windows)]
    builtin_names.push("qwen_computer");
    builtin_names.sort_unstable();
    builtin_names.dedup();

    let mut platform_definitions = PLATFORM_EXTENSIONS
        .values()
        .filter(|definition| !definition.hidden)
        .collect::<Vec<_>>();
    platform_definitions.sort_unstable_by_key(|definition| definition.name);

    builtin_names
        .into_iter()
        .map(|name| ExtensionConfig::Builtin {
            name: name.to_string(),
            description: String::new(),
            display_name: Some(name.to_string()),
            timeout: None,
            bundled: Some(true),
            available_tools: Vec::new(),
        })
        .chain(
            platform_definitions
                .into_iter()
                .map(|definition| ExtensionConfig::Platform {
                    name: definition.name.to_string(),
                    description: definition.description.to_string(),
                    display_name: Some(definition.display_name.to_string()),
                    bundled: Some(true),
                    available_tools: Vec::new(),
                }),
        )
        .collect()
}

pub fn get_warnings() -> Vec<String> {
    let raw: Mapping = Config::global()
        .get_param(EXTENSIONS_CONFIG_KEY)
        .unwrap_or_default();

    let mut warnings = Vec::new();
    for (k, v) in raw {
        if let (serde_yaml::Value::String(key), Ok(entry)) =
            (k, serde_yaml::from_value::<ExtensionEntry>(v))
        {
            if matches!(entry.config, ExtensionConfig::Sse { .. }) {
                warnings.push(format!(
                    "'{}': SSE is unsupported, migrate to streamable_http",
                    key
                ));
            }
        }
    }
    warnings
}

pub fn resolve_extensions_for_new_session(
    recipe_extensions: Option<&[ExtensionConfig]>,
    override_extensions: Option<Vec<ExtensionConfig>>,
) -> Vec<ExtensionConfig> {
    let extensions = if let Some(exts) = recipe_extensions {
        exts.to_vec()
    } else if let Some(exts) = override_extensions {
        exts
    } else {
        get_enabled_extensions()
    };

    migrate_computer_extensions(extensions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use tracing::{Event, Level, Subscriber};
    use tracing_subscriber::layer::SubscriberExt;

    fn test_config(content: &str) -> (Config, TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let config_file = directory.path().join("config.yaml");
        let secrets_file = directory.path().join("secrets.yaml");
        std::fs::write(&config_file, content).unwrap();
        let config = Config::new_with_file_secrets(&config_file, &secrets_file).unwrap();
        (config, directory)
    }

    fn read_extensions(config: &Config) -> Mapping {
        let content = std::fs::read_to_string(config.path()).unwrap();
        let values: Mapping = serde_yaml::from_str(&content).unwrap();
        values
            .get(EXTENSIONS_CONFIG_KEY)
            .unwrap()
            .as_mapping()
            .unwrap()
            .clone()
    }

    fn builtin_entry(name: &str, enabled: bool) -> ExtensionEntry {
        ExtensionEntry {
            enabled,
            config: ExtensionConfig::Builtin {
                name: name.to_string(),
                description: format!("{name} description"),
                display_name: Some(name.to_string()),
                timeout: None,
                bundled: None,
                available_tools: Vec::new(),
            },
        }
    }

    #[test]
    fn retired_tutorial_is_filtered_without_removing_other_builtins() {
        assert!(!is_extension_available(
            &builtin_entry("tutorial", true).config
        ));
        assert!(is_extension_available(
            &builtin_entry("memory", true).config
        ));
        assert!(is_extension_available(
            &builtin_entry("computercontroller", true).config
        ));
        let raw = serde_yaml::to_value(IndexMap::from([
            ("old_tutorial", builtin_entry("tutorial", true)),
            ("memory", builtin_entry("memory", true)),
        ]))
        .unwrap();
        let parsed = parse_extensions_map(raw.as_mapping().unwrap());
        assert!(!parsed.contains_key("old_tutorial"));
        assert!(parsed.contains_key("memory"));
    }

    #[test]
    fn main_first_migrates_native_computer_without_overriding_mcp_preference() {
        let native = ExtensionConfig::Platform {
            name: "computer".into(),
            description: "old".into(),
            display_name: None,
            bundled: None,
            available_tools: vec!["computer_click".into()],
        };
        assert!(!is_extension_available(&native));
        let raw = serde_yaml::to_value(IndexMap::from([
            (
                "computer",
                ExtensionEntry {
                    enabled: true,
                    config: native.clone(),
                },
            ),
            (
                "qwen_computer",
                ExtensionEntry {
                    enabled: false,
                    config: computer_mcp_config(vec![]),
                },
            ),
            (
                "external",
                ExtensionEntry {
                    enabled: true,
                    config: ExtensionConfig::Stdio {
                        name: "computer".into(),
                        cmd: "external-server".into(),
                        args: vec![],
                        envs: Default::default(),
                        env_keys: vec![],
                        timeout: None,
                        description: String::new(),
                        bundled: None,
                        available_tools: vec![],
                        read_only_tools: vec![],
                        cwd: None,
                    },
                },
            ),
        ]))
        .unwrap();
        let parsed = parse_extensions_map(raw.as_mapping().unwrap());
        assert!(!parsed.contains_key("computer"));
        assert!(!parsed["qwen_computer"].enabled);
        assert!(parsed.contains_key("external"));
        let migrated =
            migrate_computer_extensions(vec![native.clone(), computer_mcp_config(vec![])]);
        assert_eq!(migrated.len(), 1);
        assert_eq!(migrated[0].name(), "qwen_computer");
        let raw = serde_yaml::to_value(IndexMap::from([(
            "computer",
            ExtensionEntry {
                enabled: true,
                config: native,
            },
        )]))
        .unwrap();
        let migrated = parse_extensions_map(raw.as_mapping().unwrap());
        assert!(migrated["qwen_computer"].enabled);
        assert!(migrated["qwen_computer"].config.is_tool_available("click"));
    }

    #[test]
    fn main_first_migration_preserves_read_only_worker_scope() {
        let old = ExtensionConfig::Platform {
            name: "computer".into(),
            description: String::new(),
            display_name: None,
            bundled: None,
            available_tools: vec!["computer_observe".into(), "computer_screenshot".into()],
        };
        let migrated = migrate_computer_extensions(vec![old]);
        assert_eq!(migrated.len(), 1);
        assert!(migrated[0].is_tool_available("get_app_state"));
        for input in ["click", "press_key", "type_text", "set_value"] {
            assert!(!migrated[0].is_tool_available(input));
        }
    }

    #[test]
    fn test_is_extension_available_filters_unknown_platform() {
        let unknown_platform = ExtensionConfig::Platform {
            name: "definitely_not_real_platform_extension".to_string(),
            description: "unknown".to_string(),
            display_name: None,
            bundled: None,
            available_tools: Vec::new(),
        };

        let builtin = ExtensionConfig::Builtin {
            name: "developer".to_string(),
            description: "".to_string(),
            display_name: Some("Developer".to_string()),
            timeout: None,
            bundled: None,
            available_tools: Vec::new(),
        };

        assert!(!is_extension_available(&unknown_platform));
        assert!(is_extension_available(&builtin));
    }

    #[test]
    fn test_set_extension_enabled_preserves_clean_siblings() {
        let (config, _directory) = test_config(
            r#"
extensions:
  first:
    enabled: true
    type: builtin
    name: first
    description: first description
    display_name: First
  second:
    enabled: true
    type: builtin
    name: second
    description: second description
    display_name: Second
    extra_field: preserved
"#,
        );
        let before = read_extensions(&config);
        let second_before = before.get("second").unwrap().clone();

        set_extension_enabled_with_config(&config, "first", false);

        let extensions = read_extensions(&config);
        assert_eq!(
            extensions
                .get("first")
                .unwrap()
                .as_mapping()
                .unwrap()
                .get("enabled")
                .unwrap()
                .as_bool(),
            Some(false)
        );
        assert_eq!(extensions.get("second").unwrap(), &second_before);
    }

    #[test]
    fn test_set_extension_enabled_preserves_unparseable_sibling() {
        let (config, _directory) = test_config(
            r#"
extensions:
  valid:
    enabled: true
    type: builtin
    name: valid
    description: valid description
    display_name: Valid
  broken:
    enabled: true
    type: stdio
    name: Broken
    description: missing cmd
    args: []
"#,
        );
        let before = read_extensions(&config);
        let broken_before = before.get("broken").unwrap().clone();

        set_extension_enabled_with_config(&config, "valid", false);

        let extensions = read_extensions(&config);
        assert!(extensions.contains_key("valid"));
        assert_eq!(extensions.get("broken").unwrap(), &broken_before);
        assert_eq!(
            extensions
                .get("valid")
                .unwrap()
                .as_mapping()
                .unwrap()
                .get("enabled")
                .unwrap()
                .as_bool(),
            Some(false)
        );
    }

    #[test]
    fn test_set_extension_adds_entry_without_dropping_unparseable_entries() {
        let (config, _directory) = test_config(
            r#"
extensions:
  broken:
    enabled: true
    type: stdio
    name: Broken
    description: missing cmd
    args: []
"#,
        );
        let before = read_extensions(&config);
        let broken_before = before.get("broken").unwrap().clone();

        set_extension_with_config(&config, builtin_entry("new extension", true));

        let extensions = read_extensions(&config);
        assert_eq!(extensions.get("broken").unwrap(), &broken_before);
        assert!(extensions.contains_key("newextension"));
    }

    #[test]
    fn test_get_extension_by_name_falls_back_to_available_builtin() {
        fn spawn_builtin(_: tokio::io::DuplexStream, _: tokio::io::DuplexStream) {}
        crate::builtin_extension::register_builtin_extension("memory", spawn_builtin);

        let extension = get_extension_by_name("memory").unwrap();

        assert!(matches!(
            extension,
            ExtensionConfig::Builtin { ref name, .. } if name == "memory"
        ));
    }

    #[test]
    fn test_get_extension_by_name_resolves_saved_entry_by_key() {
        let saved = ExtensionEntry {
            enabled: true,
            config: ExtensionConfig::Stdio {
                name: "My Tool".to_string(),
                description: "saved description".to_string(),
                cmd: "my-tool".to_string(),
                args: Vec::new(),
                envs: Default::default(),
                env_keys: Vec::new(),
                timeout: Some(120),
                cwd: None,
                bundled: None,
                available_tools: vec!["run".to_string()],
                read_only_tools: vec![],
            },
        };
        let key = saved.config.key();
        assert_ne!(key, saved.config.name());

        let (config, _directory) = test_config("");
        set_extension_with_config(&config, saved);

        let resolved = get_extension_by_name_with_config(&config, &key).unwrap();

        match resolved {
            ExtensionConfig::Stdio {
                timeout,
                available_tools,
                ..
            } => {
                assert_eq!(timeout, Some(120));
                assert_eq!(available_tools, vec!["run".to_string()]);
            }
            other => panic!("expected stdio, got {other:?}"),
        }
    }

    #[test]
    fn test_remove_extension_preserves_unparseable_sibling() {
        let (config, _directory) = test_config(
            r#"
extensions:
  valid:
    enabled: true
    type: builtin
    name: valid
    description: valid description
    display_name: Valid
  broken:
    enabled: true
    type: stdio
    name: Broken
    description: missing cmd
    args: []
"#,
        );
        let before = read_extensions(&config);
        let broken_before = before.get("broken").unwrap().clone();

        remove_extension_with_config(&config, "valid");

        let extensions = read_extensions(&config);
        assert!(!extensions.contains_key("valid"));
        assert_eq!(extensions.get("broken").unwrap(), &broken_before);
    }

    #[derive(Clone, Default)]
    struct CapturedLogs {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    #[derive(Debug)]
    struct CapturedEvent {
        level: Level,
        message: String,
        key: Option<String>,
    }

    impl<S> tracing_subscriber::Layer<S> for CapturedLogs
    where
        S: Subscriber,
    {
        fn on_event(&self, event: &Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
            let mut visitor = EventVisitor::default();
            event.record(&mut visitor);
            self.events.lock().unwrap().push(CapturedEvent {
                level: *event.metadata().level(),
                message: visitor.message,
                key: visitor.key,
            });
        }
    }

    #[derive(Default)]
    struct EventVisitor {
        message: String,
        key: Option<String>,
    }

    impl tracing::field::Visit for EventVisitor {
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            match field.name() {
                "message" => self.message = value.to_string(),
                "key" => self.key = Some(value.to_string()),
                _ => {}
            }
        }

        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
            match field.name() {
                "message" => self.message = format!("{value:?}").trim_matches('"').to_string(),
                "key" => {
                    self.key = Some(format!("{value:?}").trim_matches('"').to_string());
                }
                _ => {}
            }
        }
    }

    #[test]
    #[serial_test::serial]
    fn test_deserialization_failure_logs_offending_key() {
        let (config, _directory) = test_config(
            r#"
extensions:
  valid:
    enabled: true
    type: builtin
    name: valid
    description: valid description
    display_name: Valid
  broken:
    enabled: true
    type: stdio
    name: Broken
    description: missing cmd
    args: []
"#,
        );
        let logs = CapturedLogs::default();
        let subscriber = tracing_subscriber::registry().with(logs.clone());

        tracing::subscriber::with_default(subscriber, || {
            let extensions = get_enabled_extensions_with_config(&config);
            // Bundled platform extensions are auto-injected; filter to user-declared entries
            // (Builtin or anything with the test YAML's names) for the invariant check.
            let user_names: Vec<&str> = extensions
                .iter()
                .filter_map(|ext| match ext {
                    ExtensionConfig::Builtin { name, .. } => Some(name.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(
                user_names,
                vec!["valid"],
                "expected only the parseable user extension to be enabled, got {:?}",
                user_names
            );
        });

        let matching_events: Vec<_> = logs
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| {
                event.level == Level::WARN
                    && event
                        .message
                        .contains("Skipping malformed extension config entry")
            })
            .map(|event| event.key.clone())
            .collect();

        let broken_logs: Vec<_> = matching_events
            .iter()
            .filter(|k| k.as_deref() == Some("broken"))
            .collect();
        assert!(
            !broken_logs.is_empty(),
            "expected at least one log naming the broken extension key, got {:?}",
            matching_events
        );
        let other_keys: Vec<_> = matching_events
            .iter()
            .filter(|k| k.as_deref() != Some("broken"))
            .collect();
        assert!(
            other_keys.is_empty(),
            "expected no logs for other extension keys, got {:?}",
            other_keys
        );
    }
}
