use super::validation::validate_dependencies;
use crate::agents::protocol::{TaskDependency, TaskId, TaskState};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GraphError {
    #[error("task graph revision must be greater than zero")]
    InvalidRevision,
    #[error("task graph exceeds the task limit: {actual} > {maximum}")]
    TooManyTasks { actual: usize, maximum: usize },
    #[error("task graph exceeds the dependency limit: {actual} > {maximum}")]
    TooManyDependencies { actual: usize, maximum: usize },
    #[error("duplicate task in graph: {0}")]
    DuplicateTask(String),
    #[error("task {task_id} depends on itself")]
    SelfDependency { task_id: String },
    #[error("task {task_id} depends on unknown task {dependency_id}")]
    UnknownDependency {
        task_id: String,
        dependency_id: String,
    },
    #[error("task {task_id} contains duplicate dependency {dependency_id}")]
    DuplicateDependency {
        task_id: String,
        dependency_id: String,
    },
    #[error("task graph contains a dependency cycle")]
    Cycle,
    #[error("task state is unavailable: {0}")]
    MissingTaskState(String),
    #[error("unknown task in graph: {0}")]
    UnknownTask(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskGraph {
    revision: u32,
    dependencies: BTreeMap<TaskId, BTreeSet<TaskId>>,
}

impl TaskGraph {
    pub fn new(revision: u32, tasks: Vec<TaskDependency>) -> Result<Self, GraphError> {
        if revision == 0 {
            return Err(GraphError::InvalidRevision);
        }
        let dependencies = validate_dependencies(tasks)?;
        Ok(Self {
            revision,
            dependencies,
        })
    }

    pub fn revision(&self) -> u32 {
        self.revision
    }

    pub fn task_ids(&self) -> impl Iterator<Item = &TaskId> {
        self.dependencies.keys()
    }

    pub fn contains_task(&self, task_id: &TaskId) -> bool {
        self.dependencies.contains_key(task_id)
    }

    pub fn dependencies_for(&self, task_id: &TaskId) -> Result<&BTreeSet<TaskId>, GraphError> {
        self.dependencies
            .get(task_id)
            .ok_or_else(|| GraphError::UnknownTask(task_id.to_string()))
    }

    pub fn ready_task_ids(
        &self,
        states: &BTreeMap<TaskId, TaskState>,
    ) -> Result<Vec<TaskId>, GraphError> {
        for task_id in self.dependencies.keys() {
            if !states.contains_key(task_id) {
                return Err(GraphError::MissingTaskState(task_id.to_string()));
            }
        }
        Ok(self
            .dependencies
            .iter()
            .filter(|(task_id, prerequisites)| {
                states.get(*task_id) == Some(&TaskState::Proposed)
                    && prerequisites
                        .iter()
                        .all(|dependency| states.get(dependency) == Some(&TaskState::Succeeded))
            })
            .map(|(task_id, _)| task_id.clone())
            .collect())
    }

    pub fn is_ordered(&self, first: &TaskId, second: &TaskId) -> Result<bool, GraphError> {
        if !self.contains_task(first) {
            return Err(GraphError::UnknownTask(first.to_string()));
        }
        if !self.contains_task(second) {
            return Err(GraphError::UnknownTask(second.to_string()));
        }
        Ok(self.depends_transitively(first, second) || self.depends_transitively(second, first))
    }

    fn depends_transitively(&self, task_id: &TaskId, dependency_id: &TaskId) -> bool {
        let mut pending = vec![task_id.clone()];
        let mut visited = BTreeSet::new();
        while let Some(current) = pending.pop() {
            if !visited.insert(current.clone()) {
                continue;
            }
            let Some(dependencies) = self.dependencies.get(&current) else {
                continue;
            };
            if dependencies.contains(dependency_id) {
                return true;
            }
            pending.extend(dependencies.iter().cloned());
        }
        false
    }
}
