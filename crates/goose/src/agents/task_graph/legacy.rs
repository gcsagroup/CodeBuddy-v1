use super::{validate_write_ownership, TaskGraph, WriteOwnershipClaim};
use crate::agents::protocol::{TaskDependency, TaskId, TaskState};
use crate::agents::task_dag::{TaskDAG, TaskStatus};
use std::collections::BTreeMap;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LegacyReadyError {
    #[error("legacy DAG is invalid: {0}")]
    InvalidDag(String),
    #[error("legacy DAG uses an invalid protocol task id: {0}")]
    InvalidTaskId(String),
    #[error("task graph validation failed: {0}")]
    InvalidGraph(String),
    #[error("task {task_id} is Ready before dependency {dependency_id} succeeds")]
    PrematureReady {
        task_id: String,
        dependency_id: String,
    },
    #[error("legacy DAG has unsafe write ownership: {0}")]
    UnsafeWriteOwnership(String),
}

pub struct LegacyReadyAdapter;

impl LegacyReadyAdapter {
    pub fn validate(dag: &TaskDAG) -> Result<(), LegacyReadyError> {
        let graph = build_graph(dag)?;
        validate_explicit_ownership(dag, &graph)
    }

    pub fn promote_ready(dag: &mut TaskDAG) -> Result<Vec<String>, LegacyReadyError> {
        let graph = build_graph(dag)?;
        validate_explicit_ownership(dag, &graph)?;
        let states = legacy_states(dag)?;
        validate_existing_ready(dag, &graph, &states)?;
        let ready = graph
            .ready_task_ids(&states)
            .map_err(|error| LegacyReadyError::InvalidGraph(error.to_string()))?;
        let ready_strings = ready.iter().map(ToString::to_string).collect::<Vec<_>>();
        for task_id in &ready_strings {
            dag.promote_task_ready(task_id)
                .map_err(LegacyReadyError::InvalidDag)?;
        }
        Ok(ready_strings)
    }
}

fn build_graph(dag: &TaskDAG) -> Result<TaskGraph, LegacyReadyError> {
    let dependencies = dag
        .tasks
        .iter()
        .map(|task| {
            Ok(TaskDependency {
                task_id: parse_task_id(&task.id)?,
                depends_on: task
                    .depends_on
                    .iter()
                    .map(|dependency| parse_task_id(dependency))
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .collect::<Result<Vec<_>, LegacyReadyError>>()?;
    TaskGraph::new(1, dependencies)
        .map_err(|error| LegacyReadyError::InvalidGraph(error.to_string()))
}

fn legacy_states(dag: &TaskDAG) -> Result<BTreeMap<TaskId, TaskState>, LegacyReadyError> {
    dag.tasks
        .iter()
        .map(|task| {
            Ok((
                parse_task_id(&task.id)?,
                match task.status {
                    TaskStatus::Pending => TaskState::Proposed,
                    TaskStatus::Ready => TaskState::Ready,
                    TaskStatus::Running => TaskState::Running,
                    TaskStatus::Done => TaskState::Succeeded,
                    TaskStatus::VerificationFailed => TaskState::VerificationFailed,
                    TaskStatus::RepairPending => TaskState::RepairPending,
                    TaskStatus::WaitingForUser => TaskState::WaitingForUser,
                    TaskStatus::RepairExhausted => TaskState::RepairExhausted,
                    TaskStatus::Failed => TaskState::Failed,
                    TaskStatus::Paused => TaskState::Paused,
                    TaskStatus::Cancelled => TaskState::Cancelled,
                    TaskStatus::Skipped => TaskState::Skipped,
                },
            ))
        })
        .collect()
}

fn validate_existing_ready(
    dag: &TaskDAG,
    graph: &TaskGraph,
    states: &BTreeMap<TaskId, TaskState>,
) -> Result<(), LegacyReadyError> {
    for task in dag
        .tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Ready)
    {
        let task_id = parse_task_id(&task.id)?;
        for dependency in graph
            .dependencies_for(&task_id)
            .map_err(|error| LegacyReadyError::InvalidGraph(error.to_string()))?
        {
            if states.get(dependency) != Some(&TaskState::Succeeded) {
                return Err(LegacyReadyError::PrematureReady {
                    task_id: task.id.clone(),
                    dependency_id: dependency.to_string(),
                });
            }
        }
    }
    Ok(())
}

fn validate_explicit_ownership(dag: &TaskDAG, graph: &TaskGraph) -> Result<(), LegacyReadyError> {
    let claims = dag
        .tasks
        .iter()
        .filter(|task| task.status != TaskStatus::Skipped)
        .filter_map(|task| {
            let contract = dag.contracts.get(&task.id)?;
            (!contract.write_scope.is_empty()).then(|| {
                parse_task_id(&task.id)
                    .map(|task_id| WriteOwnershipClaim::new(task_id, contract.write_scope.clone()))
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_write_ownership(graph, &claims)
        .map_err(|error| LegacyReadyError::UnsafeWriteOwnership(error.to_string()))
}

fn parse_task_id(value: &str) -> Result<TaskId, LegacyReadyError> {
    TaskId::new(value).map_err(|_| LegacyReadyError::InvalidTaskId(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::task_dag::TaskNode;
    use crate::agents::AgentRole;

    #[test]
    fn legacy_recovery_states_keep_their_semantics_in_the_protocol_projection() {
        for (status, expected) in [
            (
                TaskStatus::VerificationFailed,
                TaskState::VerificationFailed,
            ),
            (TaskStatus::RepairPending, TaskState::RepairPending),
            (TaskStatus::WaitingForUser, TaskState::WaitingForUser),
            (TaskStatus::RepairExhausted, TaskState::RepairExhausted),
        ] {
            let dag = TaskDAG::new(
                "project recovery status",
                vec![TaskNode {
                    id: "test".to_string(),
                    name: "test".to_string(),
                    description: "run the bounded project test".to_string(),
                    role: AgentRole::Tester,
                    depends_on: Vec::new(),
                    acceptance_criteria: "record a conclusive test result".to_string(),
                    status,
                    output: None,
                    retry_count: 0,
                }],
            );
            assert_eq!(
                legacy_states(&dag).unwrap()[&TaskId::new("test").unwrap()],
                expected
            );
        }
    }

    #[test]
    fn skipped_planned_retest_does_not_keep_competing_write_ownership() {
        let repair_coder = TaskNode {
            id: "repair-code".to_string(),
            name: "repair implementation".to_string(),
            description: "repair app.js from the failed test evidence".to_string(),
            role: AgentRole::Coder,
            depends_on: Vec::new(),
            acceptance_criteria: "app.js is changed within scope".to_string(),
            status: TaskStatus::Pending,
            output: None,
            retry_count: 0,
        };
        let repair_pending = TaskNode {
            id: "diagnostic".to_string(),
            name: "node tests.js".to_string(),
            description: "rerun the original node tests.js command".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![repair_coder.id.clone()],
            acceptance_criteria: "node tests.js exits with zero".to_string(),
            status: TaskStatus::RepairPending,
            output: None,
            retry_count: 1,
        };
        let skipped_retest = TaskNode {
            id: "planned-retest".to_string(),
            name: "planned duplicate retest".to_string(),
            description: "superseded by the diagnostic task identity".to_string(),
            role: AgentRole::Tester,
            depends_on: vec![repair_coder.id.clone()],
            acceptance_criteria: "node tests.js exits with zero".to_string(),
            status: TaskStatus::Skipped,
            output: None,
            retry_count: 0,
        };
        let mut dag = TaskDAG::new(
            "repair and retest",
            vec![repair_pending, repair_coder, skipped_retest],
        );
        dag.contracts.get_mut("repair-code").unwrap().write_scope = vec!["app.js".to_string()];
        for tester_id in ["diagnostic", "planned-retest"] {
            dag.contracts.get_mut(tester_id).unwrap().write_scope =
                vec!["tests/.tmp/**".to_string()];
        }

        let promoted = LegacyReadyAdapter::promote_ready(&mut dag).unwrap();

        assert_eq!(promoted, vec!["repair-code"]);
        assert_eq!(dag.tasks[1].status, TaskStatus::Ready);
    }
}
