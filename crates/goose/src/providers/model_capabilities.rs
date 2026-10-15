use crate::config::Config;
use goose_sdk_types::custom_requests::{
    ImageInputOverride, ModelCapabilityOverride, ModelCapabilityOverridesConfig,
    ModelCapabilitySource, ModelCapabilityState, MODEL_CAPABILITY_OVERRIDES_CONFIG_KEY,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedImageInputCapability {
    pub state: ModelCapabilityState,
    pub source: ModelCapabilitySource,
}

impl ResolvedImageInputCapability {
    pub fn is_supported(self) -> bool {
        self.state == ModelCapabilityState::Supported
    }
}

pub fn resolve_image_input(provider_id: &str, model_id: &str) -> ResolvedImageInputCapability {
    resolve_image_input_with_config(Config::global(), provider_id, model_id)
}

pub fn resolve_effective_model_image_input(effective_model: &str) -> ResolvedImageInputCapability {
    let Some((provider_id, model_id)) = effective_model.split_once('/') else {
        return unknown();
    };
    resolve_image_input(provider_id, model_id)
}

pub fn model_supports_image_input(effective_model: &str) -> bool {
    resolve_effective_model_image_input(effective_model).is_supported()
}

pub fn resolve_image_input_with_config(
    config: &Config,
    provider_id: &str,
    model_id: &str,
) -> ResolvedImageInputCapability {
    let overrides = config
        .get_param::<ModelCapabilityOverridesConfig>(MODEL_CAPABILITY_OVERRIDES_CONFIG_KEY)
        .unwrap_or_default();
    resolve_image_input_with_overrides(provider_id, model_id, &overrides.overrides)
}

pub fn resolve_image_input_with_overrides(
    provider_id: &str,
    model_id: &str,
    overrides: &[ModelCapabilityOverride],
) -> ResolvedImageInputCapability {
    let provider_id = provider_id.trim();
    let model_id = model_id.trim();
    if provider_id.is_empty() || model_id.is_empty() {
        return unknown();
    }

    if let Some(entry) = overrides.iter().find(|entry| {
        entry.provider_id.eq_ignore_ascii_case(provider_id)
            && entry.model_id.eq_ignore_ascii_case(model_id)
    }) {
        match entry.image_input {
            ImageInputOverride::ForceSupported => {
                return ResolvedImageInputCapability {
                    state: ModelCapabilityState::Supported,
                    source: ModelCapabilitySource::UserOverride,
                };
            }
            ImageInputOverride::ForceUnsupported => {
                return ResolvedImageInputCapability {
                    state: ModelCapabilityState::Unsupported,
                    source: ModelCapabilitySource::UserOverride,
                };
            }
            ImageInputOverride::Auto => {}
        }
    }

    let provider = provider_id.to_ascii_lowercase();
    let model = model_id.to_ascii_lowercase();
    if let Ok(registry) = crate::providers::canonical::CanonicalModelRegistry::bundled() {
        if let Some(canonical) = registry.get(&provider, &model) {
            let supported = canonical.attachment == Some(true)
                || canonical
                    .modalities
                    .input
                    .contains(&crate::providers::canonical::Modality::Image);
            let state = if supported {
                ModelCapabilityState::Supported
            } else if canonical.attachment == Some(false) {
                ModelCapabilityState::Unsupported
            } else {
                ModelCapabilityState::Unknown
            };
            return ResolvedImageInputCapability {
                state,
                source: ModelCapabilitySource::Catalog,
            };
        }
    }

    let supported = match provider.as_str() {
        "openai" | "codex" => {
            model.starts_with("gpt-4o")
                || model.starts_with("gpt-4.1")
                || model.starts_with("gpt-5")
        }
        "anthropic" => model.starts_with("claude-3") || model.starts_with("claude-4"),
        "google" | "gemini" => model.starts_with("gemini-"),
        "xai" => model.contains("vision"),
        "ollama" | "ollama_cloud" => {
            model.starts_with("qwen3.5")
                || ["-vl", "_vl", "vision", "llava", "pixtral"]
                    .into_iter()
                    .any(|marker| model.contains(marker))
        }
        provider if provider.starts_with("custom_") => {
            model.starts_with("qwen3.5")
                || ["-vl", "_vl", "vision", "llava", "pixtral"]
                    .into_iter()
                    .any(|marker| model.contains(marker))
        }
        _ => false,
    };
    if supported {
        ResolvedImageInputCapability {
            state: ModelCapabilityState::Supported,
            source: ModelCapabilitySource::Heuristic,
        }
    } else {
        unknown()
    }
}

fn unknown() -> ResolvedImageInputCapability {
    ResolvedImageInputCapability {
        state: ModelCapabilityState::Unknown,
        source: ModelCapabilitySource::Unknown,
    }
}

pub fn main_image_attempt_allowed(provider_id: &str, model_id: &str) -> bool {
    resolve_image_input(provider_id, model_id).state != ModelCapabilityState::Unsupported
}

#[cfg(test)]
mod tests {
    use super::*;

    fn override_for(image_input: ImageInputOverride) -> ModelCapabilityOverride {
        ModelCapabilityOverride {
            provider_id: "custom_1".to_string(),
            model_id: "kimi-k3".to_string(),
            image_input,
        }
    }

    #[test]
    fn user_override_is_authoritative_and_auto_falls_through() {
        let supported = resolve_image_input_with_overrides(
            "custom_1",
            "kimi-k3",
            &[override_for(ImageInputOverride::ForceSupported)],
        );
        assert_eq!(supported.state, ModelCapabilityState::Supported);
        assert_eq!(supported.source, ModelCapabilitySource::UserOverride);

        let unsupported = resolve_image_input_with_overrides(
            "custom_1",
            "qwen3-vl",
            &[ModelCapabilityOverride {
                provider_id: "custom_1".to_string(),
                model_id: "qwen3-vl".to_string(),
                image_input: ImageInputOverride::ForceUnsupported,
            }],
        );
        assert_eq!(unsupported.state, ModelCapabilityState::Unsupported);
        assert_eq!(unsupported.source, ModelCapabilitySource::UserOverride);

        let automatic = resolve_image_input_with_overrides(
            "custom_1",
            "qwen3-vl",
            &[ModelCapabilityOverride {
                provider_id: "custom_1".to_string(),
                model_id: "qwen3-vl".to_string(),
                image_input: ImageInputOverride::Auto,
            }],
        );
        assert_eq!(automatic.state, ModelCapabilityState::Supported);
        assert_eq!(automatic.source, ModelCapabilitySource::Heuristic);
    }

    #[test]
    fn unknown_models_fail_closed() {
        let resolved = resolve_image_input_with_overrides("custom_1", "kimi-k3", &[]);
        assert_eq!(resolved.state, ModelCapabilityState::Unknown);
        assert!(!resolved.is_supported());
    }
}
