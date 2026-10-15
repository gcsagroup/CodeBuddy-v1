use super::codepro_intent::{CodeProExecutionRoute, CodeProIntent, CodeProIntentWarning};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProBuildProvenance {
    pub schema_version: u8,
    pub package_version: String,
    pub source_revision: Option<String>,
    pub source_dirty: Option<bool>,
}

impl CodeProBuildProvenance {
    pub fn current() -> Self {
        Self {
            schema_version: 1,
            package_version: env!("CARGO_PKG_VERSION").to_owned(),
            source_revision: match env!("GOOSE_BUILD_REVISION") {
                "unknown" => None,
                revision => Some(revision.to_owned()),
            },
            source_dirty: match env!("GOOSE_BUILD_DIRTY") {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            },
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProClassificationSource {
    #[default]
    Unspecified,
    SimpleConversation,
    WorkspaceConstraint,
    SemanticModel,
    SemanticRouterPostprocessed,
    CheckpointInspection,
    CheckpointResume,
    TextualResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProEffectiveIntentReason {
    ClassifiedIntent,
    ToolsExplicitlyForbidden,
    ProjectMemoryManagement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProGoalSource {
    ExecutionMessage,
    ClarificationContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeProSimpleChangeCheck {
    NotApplicable,
    Matched,
    Unmatched,
}

/// Host observations only: these fields must never grant capabilities or replace the goal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeProRoutingEvidence {
    pub schema_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_provenance: Option<CodeProBuildProvenance>,
    pub classification_source: CodeProClassificationSource,
    pub classified_intent: CodeProIntent,
    pub semantic_warning: Option<CodeProIntentWarning>,
    pub effective_intent: CodeProIntent,
    pub effective_intent_reason: CodeProEffectiveIntentReason,
    pub goal_source: CodeProGoalSource,
    pub simple_change_check: CodeProSimpleChangeCheck,
    pub execution_route: CodeProExecutionRoute,
}
