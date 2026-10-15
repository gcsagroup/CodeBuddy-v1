use super::TaskGraph;
use crate::agents::protocol::TaskId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteOwnershipClaim {
    pub task_id: TaskId,
    pub paths: Vec<String>,
}

impl WriteOwnershipClaim {
    pub fn new(task_id: TaskId, paths: Vec<String>) -> Self {
        Self { task_id, paths }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnershipConflict {
    pub first_task_id: TaskId,
    pub second_task_id: TaskId,
    pub first_path: String,
    pub second_path: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OwnershipError {
    #[error("write ownership references unknown task: {0}")]
    UnknownTask(String),
    #[error("task {task_id} contains an invalid write path")]
    InvalidPath { task_id: String },
    #[error(
        "concurrent tasks {conflict_first} and {conflict_second} have overlapping write ownership"
    )]
    Conflict {
        conflict_first: String,
        conflict_second: String,
        details: Box<OwnershipConflict>,
    },
}

pub fn validate_write_ownership(
    graph: &TaskGraph,
    claims: &[WriteOwnershipClaim],
) -> Result<(), OwnershipError> {
    let mut normalized = Vec::new();
    for claim in claims {
        if !graph.contains_task(&claim.task_id) {
            return Err(OwnershipError::UnknownTask(claim.task_id.to_string()));
        }
        let paths = claim
            .paths
            .iter()
            .map(|path| {
                normalize_path(path).ok_or_else(|| OwnershipError::InvalidPath {
                    task_id: claim.task_id.to_string(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        normalized.push((claim, paths));
    }

    for first_index in 0..normalized.len() {
        for second_index in (first_index + 1)..normalized.len() {
            let (first, first_paths) = &normalized[first_index];
            let (second, second_paths) = &normalized[second_index];
            if graph
                .is_ordered(&first.task_id, &second.task_id)
                .map_err(|_| OwnershipError::UnknownTask(second.task_id.to_string()))?
            {
                continue;
            }
            for (first_path, first_normalized) in first.paths.iter().zip(first_paths) {
                for (second_path, second_normalized) in second.paths.iter().zip(second_paths) {
                    if paths_overlap(first_normalized, second_normalized) {
                        let details = OwnershipConflict {
                            first_task_id: first.task_id.clone(),
                            second_task_id: second.task_id.clone(),
                            first_path: first_path.clone(),
                            second_path: second_path.clone(),
                        };
                        return Err(OwnershipError::Conflict {
                            conflict_first: first.task_id.to_string(),
                            conflict_second: second.task_id.to_string(),
                            details: Box::new(details),
                        });
                    }
                }
            }
        }
    }
    Ok(())
}

fn normalize_path(path: &str) -> Option<String> {
    let mut normalized = path.trim().replace('\\', "/");
    #[cfg(windows)]
    {
        normalized = normalized.to_lowercase();
    }
    if normalized.is_empty() {
        return None;
    }
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }
    if let Some(wildcard_index) = normalized.find(['*', '?']) {
        normalized.truncate(wildcard_index);
    }
    normalized = normalized.trim_end_matches('/').to_string();
    Some(normalized)
}

fn paths_overlap(first: &str, second: &str) -> bool {
    first.is_empty()
        || second.is_empty()
        || first == second
        || first
            .strip_prefix(second)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || second
            .strip_prefix(first)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
