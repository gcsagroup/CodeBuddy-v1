use super::{DecisionValidationSnapshot, ScopeError};
use crate::agents::control_plane::ConvergenceStatus;
use crate::agents::protocol::{RunEvent, RunEventPayload};
use crate::agents::reporting::RunProjection;

#[derive(Debug, Clone)]
pub struct CoordinatorAuthorityInput {
    pub granted_permissions: Vec<String>,
    pub allowed_write_scopes: Vec<String>,
    pub max_additional_turns: u32,
    pub max_additional_tokens: Option<u64>,
    pub max_semantic_retries: u32,
    pub convergence_status: ConvergenceStatus,
}

impl Default for CoordinatorAuthorityInput {
    fn default() -> Self {
        Self {
            granted_permissions: Vec::new(),
            allowed_write_scopes: Vec::new(),
            max_additional_turns: 0,
            max_additional_tokens: Some(0),
            max_semantic_retries: 0,
            convergence_status: ConvergenceStatus::InProgress,
        }
    }
}

pub struct CoordinatorDecisionSnapshotBuilder;

impl CoordinatorDecisionSnapshotBuilder {
    pub fn build(
        projection: &RunProjection,
        events: &[RunEvent],
        authority: CoordinatorAuthorityInput,
    ) -> Result<DecisionValidationSnapshot, SnapshotBuildError> {
        let last_sequence = events.last().map_or(0, |event| event.sequence);
        if last_sequence != projection.last_sequence {
            return Err(SnapshotBuildError::StaleEvents {
                projection_sequence: projection.last_sequence,
                events_sequence: last_sequence,
            });
        }
        if events.iter().any(|event| event.run_id != projection.run_id) {
            return Err(SnapshotBuildError::RunMismatch);
        }

        let mut snapshot = DecisionValidationSnapshot::new(
            projection.run_id.clone(),
            projection.state,
            projection.plan_revision,
        );
        for (task_id, task) in &projection.tasks {
            snapshot.insert_task(task_id.clone(), task.state);
            snapshot.set_task_retry_count(task_id.clone(), task.retry_attempts);
        }
        for (agent_id, agent) in &projection.agents {
            snapshot.insert_agent(agent_id.clone(), agent.task_id.clone(), agent.state);
        }
        for event in events {
            snapshot.record_evidence(event.event_id.clone());
            for evidence_ref in &event.evidence_refs {
                snapshot.record_evidence_ref(evidence_ref.clone());
            }
            match &event.payload {
                RunEventPayload::TaskFailed { .. }
                | RunEventPayload::TaskRetryScheduled { .. }
                | RunEventPayload::TaskRetryAuthorized { .. } => {
                    snapshot.record_failure_evidence(event.event_id.clone());
                }
                RunEventPayload::TaskOutcomeAccepted {
                    outcome:
                        crate::agents::protocol::WorkerOutcome::Failed(_)
                        | crate::agents::protocol::WorkerOutcome::VerificationFailed(_)
                        | crate::agents::protocol::WorkerOutcome::RepairExhausted(_),
                    ..
                } => {
                    snapshot.record_failure_evidence(event.event_id.clone());
                }
                RunEventPayload::CoordinatorDecisionMade { candidate } => {
                    snapshot.record_applied_decision(candidate.decision_id.clone());
                }
                _ => {}
            }
        }
        for permission in authority.granted_permissions {
            snapshot.grant_permission(permission);
        }
        for scope in authority.allowed_write_scopes {
            snapshot.allow_write_scope(scope)?;
        }
        snapshot.set_budget_limits(
            authority.max_additional_turns,
            authority.max_additional_tokens,
        );
        snapshot.set_max_semantic_retries(authority.max_semantic_retries);
        snapshot.set_convergence_status(authority.convergence_status);
        Ok(snapshot)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SnapshotBuildError {
    #[error(
        "coordinator snapshot events are stale: projection={projection_sequence}, events={events_sequence}"
    )]
    StaleEvents {
        projection_sequence: u64,
        events_sequence: u64,
    },
    #[error("coordinator snapshot contains events from another run")]
    RunMismatch,
    #[error(transparent)]
    Scope(#[from] ScopeError),
}
