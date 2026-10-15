use super::outcomes::{
    validate_evidence_refs, validate_required_text, validate_string_list, MAX_PROTOCOL_LIST_ITEMS,
    MAX_PROTOCOL_NAME_BYTES,
};
use super::{
    AgentId, CoordinatorAuditRecord, EventId, EvidenceRef, FailureClass, PlanRevisionAudit,
    ProtocolError, ProtocolVersion, RunId, TaskId,
};
use crate::agents::protocol::WorkerOutcome;
use crate::agents::AgentRole;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_PLANNED_TASKS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinatorDecision {
    ContinueTask,
    SendInstruction,
    SpawnTask,
    RetryTask,
    ReplaceWorker,
    RevisePlan,
    PauseTask,
    PauseRun,
    CancelTask,
    CancelBranch,
    AskUser,
    CompleteRun,
    FailRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetRequest {
    pub max_additional_turns: u32,
    pub max_additional_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorDecisionCandidate {
    pub protocol_version: ProtocolVersion,
    pub run_id: RunId,
    pub decision_id: EventId,
    pub decision: CoordinatorDecision,
    pub reason: String,
    pub target_task_id: Option<TaskId>,
    pub target_agent_id: Option<AgentId>,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
    pub requested_budget: Option<BudgetRequest>,
    #[serde(default)]
    pub required_permissions: Vec<String>,
    pub expected_completion: String,
    pub supersedes_plan_revision: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedTask {
    pub task_id: TaskId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<AgentRole>,
    #[serde(default)]
    pub depends_on: Vec<TaskId>,
}

impl CoordinatorDecisionCandidate {
    pub fn validate_for_run(&self, run_id: &RunId) -> Result<(), ProtocolError> {
        if &self.run_id != run_id {
            return Err(ProtocolError::RunMismatch {
                expected: run_id.to_string(),
                actual: self.run_id.to_string(),
            });
        }
        validate_required_text("coordinator_decision.reason", &self.reason)?;
        validate_required_text(
            "coordinator_decision.expected_completion",
            &self.expected_completion,
        )?;
        validate_string_list(
            "coordinator_decision.required_permissions",
            &self.required_permissions,
            MAX_PROTOCOL_NAME_BYTES,
        )?;
        validate_evidence_refs(&self.evidence_refs, run_id)?;
        if self.requested_budget.as_ref().is_some_and(|budget| {
            budget.max_additional_turns == 0
                && budget.max_additional_tokens.unwrap_or_default() == 0
        }) {
            return Err(ProtocolError::InvalidEnvelope(
                "requested budget must increase turns or tokens".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "command",
    content = "arguments",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ControlCommand {
    StartRun {
        run_id: RunId,
        goal: String,
    },
    CommitUserRequirements {
        run_id: RunId,
        revision: u32,
        requirements: Vec<super::UserRequirement>,
    },
    CommitTaskWorkspaceGrant {
        run_id: RunId,
        grant: super::TaskWorkspaceGrant,
    },
    InstallPlan {
        run_id: RunId,
        plan_revision: u32,
        tasks: Vec<PlannedTask>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revision_audit: Option<PlanRevisionAudit>,
    },
    RegisterWorker {
        run_id: RunId,
        task_id: TaskId,
        agent_id: AgentId,
        role: AgentRole,
    },
    RevisePlan {
        run_id: RunId,
        plan_revision: u32,
    },
    StartTask {
        run_id: RunId,
        task_id: TaskId,
    },
    RetryTask {
        run_id: RunId,
        task_id: TaskId,
    },
    StopWorker {
        run_id: RunId,
        agent_id: AgentId,
        reason: String,
    },
    CancelTask {
        run_id: RunId,
        task_id: TaskId,
        reason: String,
    },
    CancelBranch {
        run_id: RunId,
        root_task_id: TaskId,
        reason: String,
    },
    CancelRun {
        run_id: RunId,
        reason: String,
    },
    PauseRun {
        run_id: RunId,
        reason: String,
    },
    ResumeRun {
        run_id: RunId,
    },
    ResolveUserInput {
        run_id: RunId,
        resolution: super::UserInputResolution,
    },
    EmergencyStop {
        run_id: RunId,
        reason: String,
    },
    CompleteRun {
        run_id: RunId,
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proposal: Option<crate::agents::control_plane::CompletionProposal>,
    },
    FailRun {
        run_id: RunId,
        class: FailureClass,
        message: String,
        #[serde(default)]
        evidence_refs: Vec<EvidenceRef>,
    },
    #[serde(alias = "submit_worker_outcome")]
    SubmitTaskOutcome {
        run_id: RunId,
        task_id: TaskId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<AgentId>,
        outcome: WorkerOutcome,
    },
    ApplyCoordinatorDecision {
        candidate: CoordinatorDecisionCandidate,
    },
    RecordCoordinatorAudit {
        run_id: RunId,
        audit: CoordinatorAuditRecord,
    },
}

impl ControlCommand {
    pub fn run_id(&self) -> &RunId {
        match self {
            Self::StartRun { run_id, .. }
            | Self::CommitUserRequirements { run_id, .. }
            | Self::CommitTaskWorkspaceGrant { run_id, .. }
            | Self::InstallPlan { run_id, .. }
            | Self::RegisterWorker { run_id, .. }
            | Self::RevisePlan { run_id, .. }
            | Self::StartTask { run_id, .. }
            | Self::RetryTask { run_id, .. }
            | Self::StopWorker { run_id, .. }
            | Self::CancelTask { run_id, .. }
            | Self::CancelBranch { run_id, .. }
            | Self::CancelRun { run_id, .. }
            | Self::PauseRun { run_id, .. }
            | Self::ResumeRun { run_id }
            | Self::ResolveUserInput { run_id, .. }
            | Self::EmergencyStop { run_id, .. }
            | Self::CompleteRun { run_id, .. }
            | Self::FailRun { run_id, .. }
            | Self::SubmitTaskOutcome { run_id, .. }
            | Self::RecordCoordinatorAudit { run_id, .. } => run_id,
            Self::ApplyCoordinatorDecision { candidate } => &candidate.run_id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::StartRun { .. } => "start_run",
            Self::CommitUserRequirements { .. } => "commit_user_requirements",
            Self::CommitTaskWorkspaceGrant { .. } => "commit_task_workspace_grant",
            Self::InstallPlan { .. } => "install_plan",
            Self::RegisterWorker { .. } => "register_worker",
            Self::RevisePlan { .. } => "revise_plan",
            Self::StartTask { .. } => "start_task",
            Self::RetryTask { .. } => "retry_task",
            Self::StopWorker { .. } => "stop_worker",
            Self::CancelTask { .. } => "cancel_task",
            Self::CancelBranch { .. } => "cancel_branch",
            Self::CancelRun { .. } => "cancel_run",
            Self::PauseRun { .. } => "pause_run",
            Self::ResumeRun { .. } => "resume_run",
            Self::ResolveUserInput { .. } => "resolve_user_input",
            Self::EmergencyStop { .. } => "emergency_stop",
            Self::CompleteRun { .. } => "complete_run",
            Self::FailRun { .. } => "fail_run",
            Self::SubmitTaskOutcome { .. } => "submit_task_outcome",
            Self::ApplyCoordinatorDecision { .. } => "apply_coordinator_decision",
            Self::RecordCoordinatorAudit { .. } => "record_coordinator_audit",
        }
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::StartRun { goal, .. } => {
                validate_required_text("control_command.start_run.goal", goal)
            }
            Self::CommitUserRequirements {
                revision,
                requirements,
                ..
            } => {
                if *revision == 0 || requirements.is_empty() {
                    return Err(ProtocolError::InvalidEnvelope(
                        "user requirement revision must start at 1 and contain requirements"
                            .to_string(),
                    ));
                }
                if requirements.len() > MAX_PROTOCOL_LIST_ITEMS {
                    return Err(ProtocolError::LimitExceeded {
                        field: "control_command.user_requirements",
                        actual: requirements.len(),
                        maximum: MAX_PROTOCOL_LIST_ITEMS,
                    });
                }
                let mut ids = std::collections::BTreeSet::new();
                for requirement in requirements {
                    requirement.validate()?;
                    if !ids.insert(requirement.requirement_id.as_str()) {
                        return Err(ProtocolError::InvalidEnvelope(format!(
                            "duplicate user requirement id: {}",
                            requirement.requirement_id
                        )));
                    }
                }
                Ok(())
            }
            Self::CommitTaskWorkspaceGrant { grant, .. } => grant.validate(),
            Self::InstallPlan {
                run_id,
                plan_revision,
                tasks,
                revision_audit,
                ..
            } => {
                validate_plan(*plan_revision, tasks)?;
                if let Some(audit) = revision_audit {
                    audit.validate_for_run(run_id, *plan_revision)?;
                }
                Ok(())
            }
            Self::RegisterWorker { .. } => Ok(()),
            Self::RevisePlan { plan_revision, .. } => {
                if *plan_revision == 0 {
                    return Err(ProtocolError::InvalidEnvelope(
                        "plan_revision must start at 1".to_string(),
                    ));
                }
                Ok(())
            }
            Self::StartTask { .. } | Self::RetryTask { .. } | Self::ResumeRun { .. } => Ok(()),
            Self::ResolveUserInput { resolution, .. } => resolution.validate(),
            Self::StopWorker { reason, .. } => {
                validate_required_text("control_command.stop_worker.reason", reason)
            }
            Self::CancelTask { reason, .. } => {
                validate_required_text("control_command.cancel_task.reason", reason)
            }
            Self::CancelBranch { reason, .. } => {
                validate_required_text("control_command.cancel_branch.reason", reason)
            }
            Self::CancelRun { reason, .. } => {
                validate_required_text("control_command.cancel_run.reason", reason)
            }
            Self::PauseRun { reason, .. } => {
                validate_required_text("control_command.pause_run.reason", reason)
            }
            Self::EmergencyStop { reason, .. } => {
                validate_required_text("control_command.emergency_stop.reason", reason)
            }
            Self::CompleteRun {
                run_id,
                summary,
                proposal,
            } => {
                validate_required_text("control_command.complete_run.summary", summary)?;
                if let Some(proposal) = proposal {
                    proposal.validate_for_run(run_id)?;
                }
                Ok(())
            }
            Self::FailRun {
                run_id,
                message,
                evidence_refs,
                ..
            } => {
                validate_required_text("control_command.fail_run.message", message)?;
                validate_evidence_refs(evidence_refs, run_id)
            }
            Self::SubmitTaskOutcome {
                run_id, outcome, ..
            } => outcome.validate_for_run(run_id),
            Self::ApplyCoordinatorDecision { candidate } => {
                candidate.validate_for_run(&candidate.run_id)
            }
            Self::RecordCoordinatorAudit { audit, .. } => audit.validate(),
        }
    }
}

fn validate_plan(plan_revision: u32, tasks: &[PlannedTask]) -> Result<(), ProtocolError> {
    if plan_revision == 0 {
        return Err(ProtocolError::InvalidEnvelope(
            "plan_revision must start at 1".to_string(),
        ));
    }
    if tasks.is_empty() || tasks.len() > MAX_PLANNED_TASKS {
        return Err(ProtocolError::InvalidEnvelope(format!(
            "install_plan tasks must contain between 1 and {MAX_PLANNED_TASKS} entries"
        )));
    }

    let mut ids = BTreeSet::new();
    for task in tasks {
        validate_required_text("control_command.install_plan.task.name", &task.name)?;
        if !ids.insert(task.task_id.clone()) {
            return Err(ProtocolError::InvalidEnvelope(format!(
                "install_plan contains duplicate task {}",
                task.task_id
            )));
        }
    }

    let mut indegree = BTreeMap::new();
    let mut dependents = BTreeMap::<TaskId, Vec<TaskId>>::new();
    for task in tasks {
        let mut unique_dependencies = BTreeSet::new();
        for dependency in &task.depends_on {
            if dependency == &task.task_id {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "task {} cannot depend on itself",
                    task.task_id
                )));
            }
            if !ids.contains(dependency) {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "task {} depends on unknown task {dependency}",
                    task.task_id
                )));
            }
            if !unique_dependencies.insert(dependency.clone()) {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "task {} contains duplicate dependency {dependency}",
                    task.task_id
                )));
            }
            dependents
                .entry(dependency.clone())
                .or_default()
                .push(task.task_id.clone());
        }
        indegree.insert(task.task_id.clone(), unique_dependencies.len());
    }

    let mut ready = indegree
        .iter()
        .filter_map(|(task_id, count)| (*count == 0).then_some(task_id.clone()))
        .collect::<VecDeque<_>>();
    let mut visited = 0;
    while let Some(task_id) = ready.pop_front() {
        visited += 1;
        for dependent in dependents.get(&task_id).into_iter().flatten() {
            let count = indegree
                .get_mut(dependent)
                .expect("validated dependency points to a known task");
            *count -= 1;
            if *count == 0 {
                ready.push_back(dependent.clone());
            }
        }
    }
    if visited != tasks.len() {
        return Err(ProtocolError::InvalidEnvelope(
            "install_plan task graph contains a cycle".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::AgentRole;

    fn planned(task_id: &str, depends_on: &[&str]) -> PlannedTask {
        PlannedTask {
            task_id: TaskId::new(task_id).unwrap(),
            name: format!("Task {task_id}"),
            role: Some(AgentRole::Coder),
            depends_on: depends_on
                .iter()
                .map(|dependency| TaskId::new(*dependency).unwrap())
                .collect(),
        }
    }

    fn install(tasks: Vec<PlannedTask>) -> ControlCommand {
        ControlCommand::InstallPlan {
            run_id: RunId::new("run-1").unwrap(),
            plan_revision: 1,
            tasks,
            revision_audit: None,
        }
    }

    #[test]
    fn install_plan_rejects_duplicate_tasks_unknown_dependencies_and_cycles() {
        assert!(
            install(vec![planned("task-1", &[]), planned("task-1", &[])])
                .validate()
                .is_err()
        );
        assert!(install(vec![planned("task-1", &["missing"])])
            .validate()
            .is_err());
        assert!(install(vec![
            planned("task-1", &["task-2"]),
            planned("task-2", &["task-1"]),
        ])
        .validate()
        .is_err());
    }

    #[test]
    fn install_plan_and_worker_registration_use_strict_wire_shapes() {
        let valid = serde_json::json!({
            "command": "install_plan",
            "arguments": {
                "run_id": "run-1",
                "plan_revision": 1,
                "tasks": [{
                    "task_id": "task-1",
                    "name": "Implement the change",
                    "role": "coder",
                    "depends_on": []
                }]
            }
        });
        let command: ControlCommand = serde_json::from_value(valid.clone()).unwrap();
        command.validate().unwrap();

        let mut unknown = valid;
        unknown["arguments"]["tasks"][0]["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<ControlCommand>(unknown).is_err());

        let worker: ControlCommand = serde_json::from_value(serde_json::json!({
            "command": "register_worker",
            "arguments": {
                "run_id": "run-1",
                "task_id": "task-1",
                "agent_id": "worker-task-1",
                "role": "coder"
            }
        }))
        .unwrap();
        worker.validate().unwrap();
    }
}
