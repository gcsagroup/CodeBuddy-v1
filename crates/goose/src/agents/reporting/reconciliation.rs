use crate::agents::protocol::{RunId, RunState};
use crate::agents::CodeProRunStatus;
use serde::{Deserialize, Serialize};

pub const PROJECTION_RECONCILIATION_FILE_NAME: &str = "projection-reconciliation.v1.json";
pub const MAX_PROJECTION_RECONCILIATION_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionReconciliation {
    pub run_id: String,
    pub legacy_status: CodeProRunStatus,
    pub projected_status: RunState,
    pub differences: Vec<ProjectionDifference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProjectionDifference {
    StatusMismatch {
        legacy_status: CodeProRunStatus,
        projected_status: RunState,
    },
}

impl ProjectionReconciliation {
    pub fn new(run_id: RunId, legacy_status: CodeProRunStatus, projected_status: RunState) -> Self {
        let differences = if statuses_match(legacy_status, projected_status) {
            vec![]
        } else {
            vec![ProjectionDifference::StatusMismatch {
                legacy_status,
                projected_status,
            }]
        };
        Self {
            run_id: run_id.to_string(),
            legacy_status,
            projected_status,
            differences,
        }
    }
}

fn statuses_match(legacy: CodeProRunStatus, projected: RunState) -> bool {
    matches!(
        (legacy, projected),
        (CodeProRunStatus::Planning, RunState::Planning)
            | (CodeProRunStatus::Running, RunState::Running)
            | (CodeProRunStatus::Paused, RunState::Paused)
            | (CodeProRunStatus::Reviewing, RunState::Completing)
            | (CodeProRunStatus::Completed, RunState::Completed)
            | (CodeProRunStatus::Failed, RunState::Failed)
            | (CodeProRunStatus::Discarded, RunState::Cancelled)
    )
}
