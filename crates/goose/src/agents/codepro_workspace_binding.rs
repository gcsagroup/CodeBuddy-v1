use crate::agents::codepro_intent::{
    codepro_workspace_requirement, CodeProIntent, CodeProWorkspaceRequirement,
};
use crate::session::extension_data::ExtensionData;
use crate::session::extension_data::ExtensionState;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodeProWorkspaceBinding {
    Unbound,
    RootContainer { path: String },
    ProjectContainer { path: String },
    WritableProject { path: String, lease_id: String },
}

impl ExtensionState for CodeProWorkspaceBinding {
    const EXTENSION_NAME: &'static str = "codepro_workspace_binding";
    const VERSION: &'static str = "v1";
}

impl CodeProWorkspaceBinding {
    pub fn from_extension_data_strict(extension_data: &ExtensionData) -> Result<Option<Self>> {
        let Some(value) = extension_data.get_extension_state(Self::EXTENSION_NAME, Self::VERSION)
        else {
            return Ok(None);
        };
        Self::from_value(value).map(Some)
    }
}

/// Session-level permissions that override workspace-gate defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodeProWorkspacePermissions {
    pub restricted_readonly_allowed: bool,
}

impl ExtensionState for CodeProWorkspacePermissions {
    const EXTENSION_NAME: &'static str = "codepro_workspace_permissions";
    const VERSION: &'static str = "v1";
}

pub fn is_codepro_restricted_readonly_allowed(extension_data: &ExtensionData) -> bool {
    CodeProWorkspacePermissions::from_extension_data(extension_data)
        .map(|perms| perms.restricted_readonly_allowed)
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeProWorkspaceGate {
    ContinueConversationOnly,
    NeedsRestrictedReadOnlyCapability,
    ContinueWritable,
    NeedsWorkspace,
    ClarificationRequired,
}

pub fn codepro_workspace_gate(
    binding: &CodeProWorkspaceBinding,
    intent: CodeProIntent,
) -> CodeProWorkspaceGate {
    match binding {
        CodeProWorkspaceBinding::WritableProject { .. } => CodeProWorkspaceGate::ContinueWritable,
        CodeProWorkspaceBinding::RootContainer { .. } => {
            match codepro_workspace_requirement(intent) {
                CodeProWorkspaceRequirement::NoWritableWorkspace => {
                    CodeProWorkspaceGate::ContinueWritable
                }
                CodeProWorkspaceRequirement::AtomicProjectChild => {
                    CodeProWorkspaceGate::NeedsWorkspace
                }
                CodeProWorkspaceRequirement::ClarificationRequired => {
                    CodeProWorkspaceGate::ClarificationRequired
                }
            }
        }
        CodeProWorkspaceBinding::Unbound | CodeProWorkspaceBinding::ProjectContainer { .. } => {
            match (intent, codepro_workspace_requirement(intent)) {
                (CodeProIntent::Conversation, CodeProWorkspaceRequirement::NoWritableWorkspace) => {
                    CodeProWorkspaceGate::ContinueConversationOnly
                }
                (CodeProIntent::ReadOnly, CodeProWorkspaceRequirement::NoWritableWorkspace) => {
                    CodeProWorkspaceGate::NeedsRestrictedReadOnlyCapability
                }
                (_, CodeProWorkspaceRequirement::AtomicProjectChild) => {
                    CodeProWorkspaceGate::NeedsWorkspace
                }
                (_, CodeProWorkspaceRequirement::ClarificationRequired) => {
                    CodeProWorkspaceGate::ClarificationRequired
                }
                _ => CodeProWorkspaceGate::NeedsRestrictedReadOnlyCapability,
            }
        }
    }
}

pub fn codepro_binding_allows_generic_tools(binding: &CodeProWorkspaceBinding) -> bool {
    matches!(
        binding,
        CodeProWorkspaceBinding::WritableProject { .. }
            | CodeProWorkspaceBinding::RootContainer { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_container_persists_without_granting_parent_tools() {
        let binding = CodeProWorkspaceBinding::ProjectContainer {
            path: "/Users/test/Projects".into(),
        };
        let mut data = ExtensionData::default();
        binding.to_extension_data(&mut data).unwrap();
        assert_eq!(
            CodeProWorkspaceBinding::from_extension_data_strict(&data).unwrap(),
            Some(binding.clone())
        );
        assert!(!codepro_binding_allows_generic_tools(&binding));
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Change),
            CodeProWorkspaceGate::NeedsWorkspace
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::ReadOnly),
            CodeProWorkspaceGate::NeedsRestrictedReadOnlyCapability
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Conversation),
            CodeProWorkspaceGate::ContinueConversationOnly
        );
        assert!(CodeProWorkspaceBinding::from_value(
            &serde_json::json!({"kind":"project_container"})
        )
        .is_err());
    }

    #[test]
    fn unbound_blocks_write_intents_and_requires_capability_for_readonly() {
        let binding = CodeProWorkspaceBinding::Unbound;
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Conversation),
            CodeProWorkspaceGate::ContinueConversationOnly
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::ReadOnly),
            CodeProWorkspaceGate::NeedsRestrictedReadOnlyCapability
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Change),
            CodeProWorkspaceGate::NeedsWorkspace
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Test),
            CodeProWorkspaceGate::NeedsWorkspace
        );
    }

    #[test]
    fn root_container_requires_an_atomic_child_for_write_or_test_intents() {
        let binding = CodeProWorkspaceBinding::RootContainer {
            path: "D:\\".to_string(),
        };
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Conversation),
            CodeProWorkspaceGate::ContinueWritable
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::ReadOnly),
            CodeProWorkspaceGate::ContinueWritable
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Change),
            CodeProWorkspaceGate::NeedsWorkspace
        );
        assert_eq!(
            codepro_workspace_gate(&binding, CodeProIntent::Test),
            CodeProWorkspaceGate::NeedsWorkspace
        );
    }

    #[test]
    fn writable_project_keeps_existing_execution_paths() {
        let binding = CodeProWorkspaceBinding::WritableProject {
            path: "D:\\project".to_string(),
            lease_id: "lease-1".to_string(),
        };
        for intent in [
            CodeProIntent::Conversation,
            CodeProIntent::ReadOnly,
            CodeProIntent::Test,
            CodeProIntent::Change,
        ] {
            assert_eq!(
                codepro_workspace_gate(&binding, intent),
                CodeProWorkspaceGate::ContinueWritable
            );
        }
    }

    #[test]
    fn generic_tools_require_writable_or_root_container_binding() {
        assert!(!codepro_binding_allows_generic_tools(
            &CodeProWorkspaceBinding::Unbound
        ));
        assert!(codepro_binding_allows_generic_tools(
            &CodeProWorkspaceBinding::RootContainer {
                path: "D:\\".to_string(),
            }
        ));
        assert!(codepro_binding_allows_generic_tools(
            &CodeProWorkspaceBinding::WritableProject {
                path: "D:\\project".to_string(),
                lease_id: "lease-1".to_string(),
            }
        ));
    }

    #[test]
    fn missing_and_malformed_binding_metadata_are_never_treated_as_writable() {
        let missing = ExtensionData::default();
        assert_eq!(
            CodeProWorkspaceBinding::from_extension_data_strict(&missing).unwrap(),
            None
        );

        let mut malformed = ExtensionData::default();
        malformed.set_extension_state(
            CodeProWorkspaceBinding::EXTENSION_NAME,
            CodeProWorkspaceBinding::VERSION,
            serde_json::json!({ "kind": "writable_project", "path": "D:\\" }),
        );
        assert!(CodeProWorkspaceBinding::from_extension_data_strict(&malformed).is_err());
    }
}
