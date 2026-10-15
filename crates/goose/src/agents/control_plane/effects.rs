use crate::agents::protocol::{AgentId, EventId, RunId, TaskId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStopMode {
    CooperativeThenForce,
    Immediate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "effect", content = "arguments", rename_all = "snake_case")]
pub enum ControlEffect {
    DispatchTask {
        run_id: RunId,
        task_id: TaskId,
    },
    RetryTask {
        run_id: RunId,
        task_id: TaskId,
        attempt: u32,
        delay_ms: u64,
    },
    PauseScheduling {
        run_id: RunId,
    },
    RecoverRun {
        run_id: RunId,
    },
    StopWorkers {
        run_id: RunId,
        agent_ids: Vec<AgentId>,
        mode: WorkerStopMode,
    },
    EmergencyStop {
        run_id: RunId,
        agent_ids: Vec<AgentId>,
    },
    AbortFailedRun {
        run_id: RunId,
        agent_ids: Vec<AgentId>,
    },
}

impl ControlEffect {
    pub fn run_id(&self) -> &RunId {
        match self {
            Self::DispatchTask { run_id, .. }
            | Self::RetryTask { run_id, .. }
            | Self::PauseScheduling { run_id }
            | Self::RecoverRun { run_id }
            | Self::StopWorkers { run_id, .. }
            | Self::EmergencyStop { run_id, .. }
            | Self::AbortFailedRun { run_id, .. } => run_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommittedControlEffect {
    pub effect_id: String,
    pub trigger_event_id: EventId,
    pub effect: ControlEffect,
}

impl CommittedControlEffect {
    pub fn ledger_key(&self) -> String {
        format!("{}::{}", self.effect.run_id(), self.effect_id)
    }
}
