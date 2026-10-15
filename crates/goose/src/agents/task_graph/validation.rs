use super::graph::GraphError;
use crate::agents::protocol::{TaskDependency, TaskId};
use std::collections::{BTreeMap, BTreeSet};

const MAX_TASKS: usize = 128;
const MAX_DEPENDENCIES: usize = 512;

pub(super) fn validate_dependencies(
    tasks: Vec<TaskDependency>,
) -> Result<BTreeMap<TaskId, BTreeSet<TaskId>>, GraphError> {
    if tasks.len() > MAX_TASKS {
        return Err(GraphError::TooManyTasks {
            actual: tasks.len(),
            maximum: MAX_TASKS,
        });
    }
    let task_ids = tasks
        .iter()
        .map(|task| task.task_id.clone())
        .collect::<BTreeSet<_>>();
    if task_ids.len() != tasks.len() {
        let mut seen = BTreeSet::new();
        let duplicate = tasks
            .iter()
            .find(|task| !seen.insert(task.task_id.clone()))
            .expect("a duplicate must exist");
        return Err(GraphError::DuplicateTask(duplicate.task_id.to_string()));
    }
    let edge_count = tasks.iter().map(|task| task.depends_on.len()).sum();
    if edge_count > MAX_DEPENDENCIES {
        return Err(GraphError::TooManyDependencies {
            actual: edge_count,
            maximum: MAX_DEPENDENCIES,
        });
    }

    let mut dependencies = BTreeMap::new();
    for task in tasks {
        let mut prerequisites = BTreeSet::new();
        for dependency in task.depends_on {
            if dependency == task.task_id {
                return Err(GraphError::SelfDependency {
                    task_id: task.task_id.to_string(),
                });
            }
            if !task_ids.contains(&dependency) {
                return Err(GraphError::UnknownDependency {
                    task_id: task.task_id.to_string(),
                    dependency_id: dependency.to_string(),
                });
            }
            if !prerequisites.insert(dependency.clone()) {
                return Err(GraphError::DuplicateDependency {
                    task_id: task.task_id.to_string(),
                    dependency_id: dependency.to_string(),
                });
            }
        }
        dependencies.insert(task.task_id, prerequisites);
    }
    if !is_acyclic(&dependencies) {
        return Err(GraphError::Cycle);
    }
    Ok(dependencies)
}

fn is_acyclic(dependencies: &BTreeMap<TaskId, BTreeSet<TaskId>>) -> bool {
    let mut remaining = dependencies
        .iter()
        .map(|(task_id, prerequisites)| (task_id.clone(), prerequisites.len()))
        .collect::<BTreeMap<_, _>>();
    let mut dependents = BTreeMap::<TaskId, BTreeSet<TaskId>>::new();
    for (task_id, prerequisites) in dependencies {
        for prerequisite in prerequisites {
            dependents
                .entry(prerequisite.clone())
                .or_default()
                .insert(task_id.clone());
        }
    }
    let mut ready = remaining
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(task_id, _)| task_id.clone())
        .collect::<BTreeSet<_>>();
    let mut visited = 0;
    while let Some(task_id) = ready.pop_first() {
        visited += 1;
        if let Some(children) = dependents.get(&task_id) {
            for child in children {
                let count = remaining
                    .get_mut(child)
                    .expect("validated child must be in graph");
                *count -= 1;
                if *count == 0 {
                    ready.insert(child.clone());
                }
            }
        }
    }
    visited == dependencies.len()
}
