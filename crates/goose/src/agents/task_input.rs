use crate::agents::agent_role::AgentRole;
use crate::agents::task_dag::{
    TaskDAG, TaskInputKindV1, TaskNode, TaskPurpose, TaskStatus, VerificationEvidenceV1,
    WorkspaceDeltaEvidenceV1,
};
use serde::Serialize;
use std::collections::HashSet;

pub(crate) const TASK_INPUT_ENVELOPE_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskInputEnvelopeV1 {
    schema_version: u8,
    run_id: String,
    plan_revision: u32,
    consumer_task_id: String,
    dependencies: Vec<TaskDependencyInputV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDependencyInputV1 {
    source_task_id: String,
    input_kind: TaskInputRelationV1,
    role: AgentRole,
    purpose: TaskPurpose,
    status: TaskStatus,
    attempt: u32,
    verification_evidence: Vec<VerificationEvidenceV1>,
    workspace_delta: Option<WorkspaceDeltaEvidenceV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TaskInputRelationV1 {
    Dependency,
    RecoveryEvidence,
}

impl TaskInputEnvelopeV1 {
    pub(crate) fn from_dag(
        run_id: &str,
        plan_revision: u32,
        dag: &TaskDAG,
        consumer: &TaskNode,
    ) -> Result<Option<Self>, String> {
        let supplemental_inputs = dag
            .task_input_refs_v1
            .get(&consumer.id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if consumer.depends_on.is_empty() && supplemental_inputs.is_empty() {
            return Ok(None);
        }
        if run_id.trim().is_empty() {
            return Err("task input envelope requires a run identity".to_string());
        }
        if plan_revision == 0 {
            return Err("task input envelope requires an installed plan revision".to_string());
        }
        if !dag.tasks.iter().any(|task| task.id == consumer.id) {
            return Err(format!(
                "task input consumer {} is not part of the current plan",
                consumer.id
            ));
        }

        let mut seen = HashSet::new();
        let mut inputs = consumer
            .depends_on
            .iter()
            .map(|task_id| (task_id.as_str(), TaskInputRelationV1::Dependency))
            .chain(supplemental_inputs.iter().map(|input_ref| {
                let relation = match input_ref.kind {
                    TaskInputKindV1::RecoveryEvidence => TaskInputRelationV1::RecoveryEvidence,
                };
                (input_ref.source_task_id.as_str(), relation)
            }))
            .collect::<Vec<_>>();
        inputs.sort_by(|left, right| {
            left.0
                .cmp(right.0)
                .then_with(|| (left.1 as u8).cmp(&(right.1 as u8)))
        });
        let mut dependencies = Vec::with_capacity(inputs.len());
        for (dependency_id, input_kind) in inputs {
            if !seen.insert(dependency_id) {
                return Err(format!(
                    "task input consumer {} repeats dependency {}",
                    consumer.id, dependency_id
                ));
            }
            let archive = (input_kind == TaskInputRelationV1::RecoveryEvidence)
                .then(|| dag.archived_task_revision(dependency_id))
                .flatten();
            let dependency = dag
                .tasks
                .iter()
                .find(|task| task.id == dependency_id)
                .or_else(|| {
                    archive.and_then(|revision| {
                        revision.tasks.iter().find(|task| task.id == dependency_id)
                    })
                })
                .ok_or_else(|| {
                    format!(
                        "task input consumer {} references missing dependency {}",
                        consumer.id, dependency_id
                    )
                })?;
            match input_kind {
                TaskInputRelationV1::Dependency if dependency.status != TaskStatus::Done => {
                    return Err(format!(
                        "task input dependency {} is {:?}, not done",
                        dependency.id, dependency.status
                    ));
                }
                TaskInputRelationV1::Dependency | TaskInputRelationV1::RecoveryEvidence => {}
            }
            let contract = dag
                .contracts
                .get(dependency_id)
                .or_else(|| archive.and_then(|revision| revision.contracts.get(dependency_id)))
                .ok_or_else(|| {
                    format!(
                        "task input dependency {} does not have a host contract",
                        dependency.id
                    )
                })?;
            let verification_evidence = dag.verification_evidence(dependency_id).to_vec();
            if input_kind == TaskInputRelationV1::RecoveryEvidence
                && !verification_evidence.iter().any(|evidence| {
                    evidence.repair_context.as_ref().is_some_and(|context| {
                        archive.is_none()
                            || (archive.is_none()
                                || (context.run_id == run_id && context.task_id == dependency_id))
                    }) && matches!(
                        evidence.execution_outcome,
                        crate::agents::task_dag::ExecutionOutcome::VerificationFailed
                    )
                })
            {
                return Err(format!(
                    "recovery input {} has no structured failed verification evidence",
                    dependency.id
                ));
            }
            let workspace_delta = if contract.purpose == TaskPurpose::Implementation {
                dependency
                    .output
                    .as_ref()
                    .map(|output| output.workspace_delta_evidence())
            } else {
                None
            };
            match contract.purpose {
                TaskPurpose::Diagnostic | TaskPurpose::Verification
                    if verification_evidence.is_empty() =>
                {
                    return Err(format!(
                        "task input dependency {} completed without verification evidence",
                        dependency.id
                    ));
                }
                TaskPurpose::Implementation if workspace_delta.is_none() => {
                    return Err(format!(
                        "task input dependency {} completed without workspace evidence",
                        dependency.id
                    ));
                }
                TaskPurpose::Legacy
                | TaskPurpose::Implementation
                | TaskPurpose::Diagnostic
                | TaskPurpose::Verification => {}
            }
            dependencies.push(TaskDependencyInputV1 {
                source_task_id: dependency.id.clone(),
                input_kind,
                role: dependency.role,
                purpose: contract.purpose,
                status: dependency.status,
                attempt: dependency.retry_count,
                verification_evidence,
                workspace_delta,
            });
        }

        Ok(Some(Self {
            schema_version: TASK_INPUT_ENVELOPE_SCHEMA_VERSION,
            run_id: run_id.to_string(),
            plan_revision,
            consumer_task_id: consumer.id.clone(),
            dependencies,
        }))
    }

    pub(crate) fn model_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}
