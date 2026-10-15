use crate::agents::protocol::{AgentId, RunId, TaskId};

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct WorkerHandle {
    run_id: RunId,
    task_id: Option<TaskId>,
    agent_id: AgentId,
    generation: u64,
}

impl WorkerHandle {
    pub(super) fn new(
        run_id: RunId,
        task_id: Option<TaskId>,
        agent_id: AgentId,
        generation: u64,
    ) -> Self {
        Self {
            run_id,
            task_id,
            agent_id,
            generation,
        }
    }

    pub fn run_id(&self) -> &RunId {
        &self.run_id
    }

    pub fn task_id(&self) -> Option<&TaskId> {
        self.task_id.as_ref()
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}
