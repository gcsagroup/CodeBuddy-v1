mod acp_tooling;
pub mod amp_acp;
pub mod anthropic {
    pub use goose_providers::anthropic::*;
}
pub mod anthropic_def;
pub mod api_client {
    pub use goose_providers::api_client::*;
}
pub mod avian;
pub mod azure;
pub mod azureauth;
pub mod base;
#[cfg(feature = "aws-providers")]
pub mod bedrock;
pub mod canonical {
    pub use goose_providers::canonical::*;
}
mod catalog_util;
pub mod catalog {
    pub use super::catalog_util::*;
}
pub mod chatgpt_codex;
pub mod claude_acp;
pub mod claude_code;
pub(crate) mod cli_common;
pub mod codex;
pub mod codex_acp;
pub mod copilot_acp;
pub mod cursor_agent;
pub mod custom_provider_config;
pub mod databricks_def;
pub mod databricks_v2_def;
pub mod formats;
mod gcpauth;
pub mod gcpvertexai;
pub mod gemini_cli;
pub mod gemini_oauth;
pub mod githubcopilot;
pub mod google {
    pub use goose_providers::google::*;
}
pub mod google_def;
pub mod http_status {
    pub use goose_providers::http_status::*;
}
pub mod huggingface;
pub mod huggingface_auth;
mod init;
pub mod inventory;
pub mod kimicode;
pub mod litellm;
#[cfg(feature = "local-inference")]
pub mod local_inference;
pub mod model_capabilities;
pub mod nanogpt;
pub mod oauth;
pub mod oauth_device_flow;
pub mod ollama {
    pub use goose_providers::ollama::*;
}
pub mod ollama_cloud;
pub mod ollama_def;
pub mod openai {
    pub use goose_providers::openai::*;
}
pub mod openai_compatible {
    pub use goose_providers::openai_compatible::*;
}
pub mod openrouter;
pub mod pi_acp;
pub(crate) mod private_file;
pub mod provider_registry;
pub mod provider_secrets;
pub mod provider_test;
mod retry {
    pub use goose_providers::retry::*;
}
pub mod openai_def;
#[cfg(feature = "aws-providers")]
pub mod sagemaker_tgi;
pub mod snowflake {
    pub use goose_providers::snowflake::*;
}
pub mod snowflake_def;
pub mod testprovider;
pub mod tetrate;
pub mod toolshim;
pub mod usage_estimator;
pub mod utils;

pub mod xai;
pub mod xai_oauth;

pub use init::{
    cleanup_provider, create, create_with_default_model, create_with_named_model,
    create_with_working_dir, get_from_registry, inventory_identity, providers,
    refresh_custom_providers,
};
pub use retry::{retry_operation, RetryConfig};

pub const UNVERIFIED_CREDENTIAL_ACTIVATION_REASON: &str =
    "Provider activation is disabled because a trusted credential validation endpoint has not been verified.";
pub const UNSUPPORTED_CUSTOM_CREDENTIAL_REASON: &str =
    "Unsupported: authenticated custom providers require a trusted credential validation contract.";
pub const INVALID_CUSTOM_PROVIDER_URL_REASON: &str = "Invalid custom provider API URL.";
pub const UNSUPPORTED_CUSTOM_CREDENTIAL_CHANNEL_REASON: &str =
    "Unsupported: unauthenticated custom providers cannot contain credential channels.";

pub fn activation_disabled_reason(provider_id: &str) -> Option<&'static str> {
    let canonical_id =
        goose_providers::canonical::catalog::canonical_setup_provider_id(provider_id)
            .unwrap_or_else(|| provider_id.trim());
    (canonical_id.eq_ignore_ascii_case("zai") || canonical_id.eq_ignore_ascii_case("nvidia"))
        .then_some(UNVERIFIED_CREDENTIAL_ACTIVATION_REASON)
}

pub fn activation_disabled_reason_for_api_url(api_url: &str) -> Option<&'static str> {
    // Disable each entire exact vendor origin, regardless of path. Otherwise
    // a custom base path could reconstruct a disabled canonical endpoint.
    (goose_providers::api_client::has_trusted_https_origin(api_url, "api.z.ai")
        || goose_providers::api_client::has_trusted_https_origin(
            api_url,
            "integrate.api.nvidia.com",
        ))
    .then_some(UNVERIFIED_CREDENTIAL_ACTIVATION_REASON)
}

pub fn custom_provider_activation_disabled_reason(
    catalog_provider_id: Option<&str>,
    api_url: &str,
) -> Option<&'static str> {
    catalog_provider_id
        .and_then(activation_disabled_reason)
        .or_else(|| activation_disabled_reason_for_api_url(api_url))
}

fn custom_headers_are_noncredential(
    headers: Option<&std::collections::HashMap<String, String>>,
) -> bool {
    match headers {
        None => true,
        Some(headers) => headers.keys().all(|name| {
            name.eq_ignore_ascii_case("accept") || name.eq_ignore_ascii_case("content-type")
        }),
    }
}

pub fn validate_custom_provider_contract(
    catalog_provider_id: Option<&str>,
    api_url: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
    requires_auth: bool,
    has_api_key: bool,
    base_path: Option<&str>,
) -> Result<(), &'static str> {
    let parsed = goose_providers::api_client::parse_provider_api_url(api_url)
        .map_err(|_| INVALID_CUSTOM_PROVIDER_URL_REASON)?;
    if let Some(reason) = custom_provider_activation_disabled_reason(catalog_provider_id, api_url) {
        return Err(reason);
    }
    if parsed.query().is_some()
        || parsed.fragment().is_some()
        || base_path.is_some_and(|path| path.contains('?') || path.contains('#'))
        || !custom_headers_are_noncredential(headers)
    {
        return Err(UNSUPPORTED_CUSTOM_CREDENTIAL_CHANNEL_REASON);
    }
    if !requires_auth && has_api_key {
        return Err(UNSUPPORTED_CUSTOM_CREDENTIAL_CHANNEL_REASON);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{activation_disabled_reason, activation_disabled_reason_for_api_url};

    #[test]
    fn disabled_vendor_url_matching_is_exact_to_https_origin() {
        for api_url in [
            "https://api.z.ai/api/anthropic",
            "https://api.z.ai/another/path",
            "https://integrate.api.nvidia.com/v1",
            "https://integrate.api.nvidia.com/another/path",
        ] {
            assert!(activation_disabled_reason_for_api_url(api_url).is_some());
        }

        for api_url in [
            "https://api.z.ai.example.invalid/api/anthropic",
            "https://integrate.api.nvidia.com.example.invalid/v1",
            "https://example.invalid/api.z.ai/api/anthropic",
        ] {
            assert!(activation_disabled_reason_for_api_url(api_url).is_none());
        }
    }

    #[test]
    fn disabled_catalog_provider_ids_use_canonical_aliases_and_trim() {
        for provider_id in [
            "zai", "ZAI", " ZaI ", "z.ai", " Z.AI ", "zhipu", " ZHIPU ", "nvidia", " NVIDIA ",
            "NvIdIa",
        ] {
            assert!(activation_disabled_reason(provider_id).is_some());
        }
    }
}
