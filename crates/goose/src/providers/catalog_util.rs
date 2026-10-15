pub use goose_providers::canonical::catalog::{
    ModelCapabilities, ModelTemplate, ProviderCatalogEntry, ProviderFormat,
    ProviderSetupCapabilities, ProviderSetupCatalogEntry, ProviderSetupCategory,
    ProviderSetupConfigKey, ProviderSetupField, ProviderSetupGroup, ProviderSetupMetadata,
    ProviderSetupMethod, ProviderTemplate,
};
use std::collections::{HashMap, HashSet};

use super::base::{ConfigKey, ProviderMetadata};

fn setup_config_key(config_key: ConfigKey) -> ProviderSetupConfigKey {
    ProviderSetupConfigKey {
        name: config_key.name,
        required: config_key.required,
        secret: config_key.secret,
        default: config_key.default,
        primary: config_key.primary,
    }
}

fn setup_metadata(metadata: ProviderMetadata) -> ProviderSetupMetadata {
    let activation_disabled_reason =
        super::activation_disabled_reason(&metadata.name).map(str::to_string);
    ProviderSetupMetadata {
        name: metadata.name,
        display_name: metadata.display_name,
        description: metadata.description,
        model_doc_link: metadata.model_doc_link,
        config_keys: metadata
            .config_keys
            .into_iter()
            .map(setup_config_key)
            .collect(),
        activation_disabled_reason,
    }
}

pub async fn get_providers_by_format(format: ProviderFormat) -> Vec<ProviderCatalogEntry> {
    let native_provider_ids = super::init::providers()
        .await
        .into_iter()
        .map(|(metadata, _)| metadata.name)
        .collect::<HashSet<_>>();

    goose_providers::canonical::catalog::get_providers_by_format(format, &native_provider_ids)
}

pub async fn get_setup_catalog_entries() -> Vec<ProviderSetupCatalogEntry> {
    let registry_metadata = super::providers()
        .await
        .into_iter()
        .map(|(metadata, _)| {
            let name = metadata.name.clone();
            (name, setup_metadata(metadata))
        })
        .collect::<HashMap<_, _>>();

    goose_providers::canonical::catalog::get_setup_catalog_entries(&registry_metadata)
}

pub fn get_provider_setup_category(provider_id: &str) -> Option<ProviderSetupCategory> {
    goose_providers::canonical::catalog::get_provider_setup_category(provider_id)
}

pub fn get_provider_template(provider_id: &str) -> Option<ProviderTemplate> {
    goose_providers::canonical::catalog::get_provider_template(provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::base::ProviderType;

    #[tokio::test]
    async fn test_zai_provider() {
        let zai = crate::providers::get_from_registry("zai")
            .await
            .expect("z.ai should be registered as a declarative provider");
        assert_eq!(zai.provider_type(), ProviderType::Declarative);

        let metadata = zai.metadata();
        assert_eq!(metadata.display_name, "Z.AI");
        assert!(
            !metadata.known_models.is_empty(),
            "z.ai should have known models"
        );
        assert!(
            metadata
                .config_keys
                .iter()
                .any(|key| key.name == "ZHIPU_API_KEY"),
            "z.ai should expose its API key config"
        );

        let setup_entries = get_setup_catalog_entries().await;
        let setup_entry = setup_entries
            .iter()
            .find(|entry| entry.provider_id == "zai")
            .expect("z.ai should be in the setup catalog");
        let public_entry = serde_json::to_value(setup_entry).unwrap();
        assert_eq!(public_entry["enabled"], false);
        assert_eq!(public_entry["setup_method"], "disabled");
        assert!(
            public_entry["disabled_reason"]
                .as_str()
                .is_some_and(|reason| !reason.trim().is_empty()),
            "disabled providers must carry an explicit public reason"
        );
        assert_eq!(public_entry["fields"], serde_json::json!([]));

        let template = get_provider_template("zai");
        assert!(template.is_some(), "z.ai should have a template");

        let template = template.unwrap();
        println!("Z.AI template: {} models", template.models.len());
        for model in template.models.iter().take(3) {
            println!(
                "  - {} ({}K context)",
                model.name,
                model.context_limit / 1000
            );
        }
        assert!(
            !template.models.is_empty(),
            "z.ai template should have models"
        );
    }

    #[tokio::test]
    async fn setup_catalog_includes_goose_and_curated_fields() {
        let entries = get_setup_catalog_entries().await;

        let goose = entries
            .iter()
            .find(|entry| entry.provider_id == "goose")
            .expect("setup catalog should include synthetic goose");
        assert_eq!(goose.category, ProviderSetupCategory::Agent);
        assert_eq!(goose.setup_method, ProviderSetupMethod::None);
        assert!(goose.fields.is_empty());

        let ollama = entries
            .iter()
            .find(|entry| entry.provider_id == "ollama")
            .expect("setup catalog should include ollama");
        assert_eq!(ollama.setup_method, ProviderSetupMethod::ConfigFields);
        assert_eq!(ollama.fields.len(), 1);
        assert_eq!(ollama.fields[0].key, "OLLAMA_HOST");
        assert_eq!(ollama.fields[0].label, "Host");
        assert_eq!(
            ollama.fields[0].default_value.as_deref(),
            Some("http://localhost:11434")
        );

        let databricks = entries
            .iter()
            .find(|entry| entry.provider_id == "databricks")
            .expect("setup catalog should include databricks");
        assert_eq!(
            databricks.setup_method,
            ProviderSetupMethod::HostWithOauthFallback
        );
        assert_eq!(
            databricks
                .fields
                .iter()
                .map(|field| field.key.as_str())
                .collect::<Vec<_>>(),
            ["DATABRICKS_HOST", "DATABRICKS_TOKEN"]
        );

        let huggingface = entries
            .iter()
            .find(|entry| entry.provider_id == "huggingface")
            .expect("setup catalog should include huggingface");
        assert_eq!(huggingface.setup_method, ProviderSetupMethod::SingleApiKey);
        assert_eq!(
            huggingface
                .fields
                .iter()
                .map(|field| field.key.as_str())
                .collect::<Vec<_>>(),
            ["HF_TOKEN"]
        );

        let atomic_chat = entries
            .iter()
            .find(|entry| entry.provider_id == "atomic_chat")
            .expect("setup catalog should include atomic_chat declarative provider");
        assert_eq!(atomic_chat.setup_method, ProviderSetupMethod::ConfigFields);
        let host_field = atomic_chat
            .fields
            .iter()
            .find(|field| field.key == "ATOMIC_CHAT_HOST")
            .expect("atomic_chat should expose ATOMIC_CHAT_HOST");
        assert_eq!(host_field.label, "Host URL");
        assert_eq!(
            host_field.default_value.as_deref(),
            Some("http://localhost:1337")
        );
    }

    #[tokio::test]
    async fn setup_catalog_disables_unverified_single_api_key_providers() {
        let entries = get_setup_catalog_entries().await;

        for provider_id in ["zai", "nvidia"] {
            let entry = entries
                .iter()
                .find(|entry| entry.provider_id == provider_id)
                .unwrap_or_else(|| panic!("{provider_id} should remain visible in the catalog"));
            let public_entry = serde_json::to_value(entry).unwrap();
            assert_eq!(public_entry["enabled"], false, "{provider_id}");
            assert_eq!(public_entry["setup_method"], "disabled", "{provider_id}");
            assert!(
                public_entry["disabled_reason"]
                    .as_str()
                    .is_some_and(|reason| !reason.trim().is_empty()),
                "{provider_id} must explain why activation is disabled"
            );
            assert_eq!(
                public_entry["fields"],
                serde_json::json!([]),
                "{provider_id}"
            );
        }
    }

    #[tokio::test]
    async fn setup_catalog_excludes_uncurated_deprecated_providers() {
        let provider_ids = get_setup_catalog_entries()
            .await
            .into_iter()
            .map(|entry| entry.provider_id)
            .collect::<std::collections::HashSet<_>>();

        assert!(provider_ids.contains("claude-acp"));
        assert!(provider_ids.contains("codex-acp"));
        assert!(provider_ids.contains("atomic_chat"));
        assert!(!provider_ids.contains("claude_code"));
        assert!(!provider_ids.contains("codex"));
        assert!(!provider_ids.contains("gemini_cli"));
    }
}
