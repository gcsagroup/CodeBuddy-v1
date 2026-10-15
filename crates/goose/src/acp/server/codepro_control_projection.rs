use crate::acp::custom_requests::{
    CodeProAgentRole, CodeProAgentState, CodeProEffectProjection, CodeProEffectState,
    CodeProEvidenceProjection, CodeProRecoveryAction, CodeProRecoveryDecision,
    CodeProRunEventSummary, CodeProRunState, CodeProTaskState,
};
use crate::agents::control_plane::{
    ControlEffect, DurableEffectEntry, DurableEffectState, RunRecoveryReport,
};
use crate::agents::protocol::{
    AgentState, RecoveryAction, RecoveryDecision, RunEvent, RunEventPayload, RunState, TaskState,
};
use crate::agents::AgentRole;

const MAX_EFFECTS: usize = 256;

pub(super) fn map_run_state(state: RunState) -> CodeProRunState {
    match state {
        RunState::Planning => CodeProRunState::Planning,
        RunState::Running => CodeProRunState::Running,
        RunState::VerificationFailed => CodeProRunState::VerificationFailed,
        RunState::Repairing => CodeProRunState::Repairing,
        RunState::Retesting => CodeProRunState::Retesting,
        RunState::WaitingForUser => CodeProRunState::WaitingForUser,
        RunState::WaitingForEnvironment => CodeProRunState::WaitingForEnvironment,
        RunState::Paused => CodeProRunState::Paused,
        RunState::Recovering => CodeProRunState::Recovering,
        RunState::Completing => CodeProRunState::Completing,
        RunState::Completed => CodeProRunState::Completed,
        RunState::Exhausted => CodeProRunState::Exhausted,
        RunState::Fatal => CodeProRunState::Fatal,
        RunState::Failed => CodeProRunState::Failed,
        RunState::Cancelled => CodeProRunState::Cancelled,
    }
}

pub(super) fn map_recovery_decision(decision: RecoveryDecision) -> CodeProRecoveryDecision {
    CodeProRecoveryDecision {
        state: map_run_state(decision.state),
        action: match decision.action {
            RecoveryAction::RetrySameStep => CodeProRecoveryAction::RetrySameStep,
            RecoveryAction::RepairThenRetest => CodeProRecoveryAction::RepairThenRetest,
            RecoveryAction::AskUserThenResume => CodeProRecoveryAction::AskUserThenResume,
            RecoveryAction::DiagnoseEnvironment => CodeProRecoveryAction::DiagnoseEnvironment,
            RecoveryAction::Replan => CodeProRecoveryAction::Replan,
            RecoveryAction::Finish => CodeProRecoveryAction::Finish,
        },
        terminal: decision.terminal,
    }
}

pub(super) fn map_task_state(state: TaskState) -> CodeProTaskState {
    match state {
        TaskState::Proposed => CodeProTaskState::Proposed,
        TaskState::Ready => CodeProTaskState::Ready,
        TaskState::Running => CodeProTaskState::Running,
        TaskState::VerificationFailed => CodeProTaskState::VerificationFailed,
        TaskState::RepairPending => CodeProTaskState::RepairPending,
        TaskState::WaitingForUser => CodeProTaskState::WaitingForUser,
        TaskState::WaitingForCoordinator => CodeProTaskState::WaitingForCoordinator,
        TaskState::WaitingForApproval => CodeProTaskState::WaitingForApproval,
        TaskState::Paused => CodeProTaskState::Paused,
        TaskState::Succeeded => CodeProTaskState::Succeeded,
        TaskState::RepairExhausted => CodeProTaskState::RepairExhausted,
        TaskState::Failed => CodeProTaskState::Failed,
        TaskState::Cancelled => CodeProTaskState::Cancelled,
        TaskState::Skipped => CodeProTaskState::Skipped,
    }
}

pub(super) fn map_agent_state(state: AgentState) -> CodeProAgentState {
    match state {
        AgentState::Starting => CodeProAgentState::Starting,
        AgentState::Running => CodeProAgentState::Running,
        AgentState::Idle => CodeProAgentState::Idle,
        AgentState::Stopping => CodeProAgentState::Stopping,
        AgentState::Stopped => CodeProAgentState::Stopped,
        AgentState::Crashed => CodeProAgentState::Crashed,
    }
}

pub(super) fn map_agent_role(role: AgentRole) -> CodeProAgentRole {
    match role {
        AgentRole::Planner => CodeProAgentRole::Planner,
        AgentRole::Coder => CodeProAgentRole::Coder,
        AgentRole::Tester => CodeProAgentRole::Tester,
        AgentRole::Reviewer => CodeProAgentRole::Reviewer,
    }
}

pub(super) fn map_evidence(
    evidence: &crate::agents::protocol::EvidenceRef,
) -> CodeProEvidenceProjection {
    CodeProEvidenceProjection {
        event_id: evidence.event_id().to_string(),
        artifact_ref: evidence.artifact_ref().to_string_lossy().to_string(),
    }
}

pub(super) fn map_event(event: &RunEvent) -> CodeProRunEventSummary {
    CodeProRunEventSummary {
        event_id: event.event_id.to_string(),
        sequence: event.sequence,
        event_type: event_type(&event.payload).to_string(),
        task_id: event.task_id.as_ref().map(ToString::to_string),
        agent_id: event.agent_id.as_ref().map(ToString::to_string),
        occurred_at: event.occurred_at.to_rfc3339(),
        evidence: event.evidence_refs.iter().map(map_evidence).collect(),
    }
}

fn event_type(payload: &RunEventPayload) -> &'static str {
    match payload {
        RunEventPayload::RunStarted { .. } => "run_started",
        RunEventPayload::RunStateChanged { .. } => "run_state_changed",
        RunEventPayload::UserRequirementsCommitted { .. } => "user_requirements_committed",
        RunEventPayload::TaskWorkspaceGrantCommitted { .. } => "task_workspace_grant_committed",
        RunEventPayload::PlanProposed { .. } => "plan_proposed",
        RunEventPayload::PlanRevised { .. } => "plan_revised",
        RunEventPayload::TaskCreated { .. } => "task_created",
        RunEventPayload::TaskGraphDeclared { .. } => "task_graph_declared",
        RunEventPayload::TaskStateChanged { .. } => "task_state_changed",
        RunEventPayload::UserInputResolved { .. } => "user_input_resolved",
        RunEventPayload::AgentSpawned { .. } => "agent_spawned",
        RunEventPayload::AgentStateChanged { .. } => "agent_state_changed",
        RunEventPayload::TaskOutcomeAccepted { .. } => "task_outcome_accepted",
        RunEventPayload::TaskRetryScheduled { .. } => "task_retry_scheduled",
        RunEventPayload::TaskRetryAuthorized { .. } => "task_retry_authorized",
        RunEventPayload::ToolCallStarted { .. } => "tool_call_started",
        RunEventPayload::ToolCallCompleted { .. } => "tool_call_completed",
        RunEventPayload::CheckpointSaved { .. } => "checkpoint_saved",
        RunEventPayload::TaskSucceeded { .. } => "task_succeeded",
        RunEventPayload::TaskFailed { .. } => "task_failed",
        RunEventPayload::AssistanceRequested { .. } => "assistance_requested",
        RunEventPayload::PermissionRequested { .. } => "permission_requested",
        RunEventPayload::CoordinatorDecisionMade { .. } => "coordinator_decision_made",
        RunEventPayload::CoordinatorAuditRecorded { .. } => "coordinator_audit_recorded",
        RunEventPayload::RunPaused { .. } => "run_paused",
        RunEventPayload::RunCompleted { .. } => "run_completed",
        RunEventPayload::RunFailed { .. } => "run_failed",
        RunEventPayload::RunCancelled { .. } => "run_cancelled",
        RunEventPayload::LegacyActivityObserved { .. } => "legacy_activity_observed",
    }
}

pub(super) fn bounded_effects(report: RunRecoveryReport) -> Vec<CodeProEffectProjection> {
    let mut unresolved = report
        .uncertain
        .into_iter()
        .chain(report.pending)
        .collect::<Vec<_>>();
    let remaining = MAX_EFFECTS.saturating_sub(unresolved.len());
    unresolved.extend(
        report
            .abandoned
            .into_iter()
            .chain(report.completed)
            .rev()
            .take(remaining),
    );
    unresolved
        .into_iter()
        .take(MAX_EFFECTS)
        .map(map_effect)
        .collect()
}

fn map_effect(entry: DurableEffectEntry) -> CodeProEffectProjection {
    let state = match entry.state {
        DurableEffectState::Prepared => CodeProEffectState::Prepared,
        DurableEffectState::Pending => CodeProEffectState::Pending,
        DurableEffectState::Claimed => CodeProEffectState::Claimed,
        DurableEffectState::Completed => CodeProEffectState::Completed,
        DurableEffectState::Uncertain => CodeProEffectState::Uncertain,
        DurableEffectState::Abandoned => CodeProEffectState::Abandoned,
    };
    CodeProEffectProjection {
        effect_id: entry.effect.ledger_key(),
        trigger_event_id: entry.effect.trigger_event_id.to_string(),
        state,
        summary: effect_summary(&entry.effect.effect),
        requires_resolution: entry.state == DurableEffectState::Uncertain,
    }
}

fn effect_summary(effect: &ControlEffect) -> String {
    match effect {
        ControlEffect::DispatchTask { task_id, .. } => format!("Dispatch task {task_id}"),
        ControlEffect::RetryTask {
            task_id, attempt, ..
        } => format!("Retry task {task_id} (attempt {attempt})"),
        ControlEffect::PauseScheduling { .. } => "Pause run scheduling".to_string(),
        ControlEffect::RecoverRun { .. } => "Recover run scheduling".to_string(),
        ControlEffect::StopWorkers { agent_ids, .. } => {
            format!("Stop {} worker(s)", agent_ids.len())
        }
        ControlEffect::EmergencyStop { agent_ids, .. } => {
            format!("Emergency stop {} worker(s)", agent_ids.len())
        }
        ControlEffect::AbortFailedRun { agent_ids, .. } => {
            format!("Abort {} worker(s) after run failure", agent_ids.len())
        }
    }
}

pub(super) fn as_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_task_projection_preserves_recovery_states_without_collapsing_to_failed() {
        for (runtime, api) in [
            (
                TaskState::VerificationFailed,
                CodeProTaskState::VerificationFailed,
            ),
            (TaskState::RepairPending, CodeProTaskState::RepairPending),
            (TaskState::WaitingForUser, CodeProTaskState::WaitingForUser),
            (
                TaskState::RepairExhausted,
                CodeProTaskState::RepairExhausted,
            ),
        ] {
            assert_eq!(map_task_state(runtime), api);
        }
    }

    #[test]
    fn acp_run_projection_preserves_structured_recovery_states() {
        for (runtime, api) in [
            (
                RunState::VerificationFailed,
                CodeProRunState::VerificationFailed,
            ),
            (RunState::Repairing, CodeProRunState::Repairing),
            (RunState::Retesting, CodeProRunState::Retesting),
            (
                RunState::WaitingForEnvironment,
                CodeProRunState::WaitingForEnvironment,
            ),
            (RunState::Exhausted, CodeProRunState::Exhausted),
            (RunState::Fatal, CodeProRunState::Fatal),
        ] {
            assert_eq!(map_run_state(runtime), api);
        }
    }
}
