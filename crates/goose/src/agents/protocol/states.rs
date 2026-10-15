use super::ProtocolError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Planning,
    Running,
    VerificationFailed,
    Repairing,
    Retesting,
    WaitingForUser,
    WaitingForEnvironment,
    Paused,
    Recovering,
    Completing,
    Completed,
    Exhausted,
    Fatal,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    RetrySameStep,
    RepairThenRetest,
    AskUserThenResume,
    DiagnoseEnvironment,
    Replan,
    Finish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryDecision {
    pub state: RunState,
    pub action: RecoveryAction,
    pub terminal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Proposed,
    Ready,
    Running,
    VerificationFailed,
    RepairPending,
    WaitingForUser,
    WaitingForCoordinator,
    WaitingForApproval,
    Paused,
    Succeeded,
    RepairExhausted,
    Failed,
    Cancelled,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Starting,
    Running,
    Idle,
    Stopping,
    Stopped,
    Crashed,
}

impl RunState {
    pub fn validate_transition(self, next: Self) -> Result<(), ProtocolError> {
        let valid = matches!(
            (self, next),
            (
                Self::Planning,
                Self::Running
                    | Self::WaitingForUser
                    | Self::WaitingForEnvironment
                    | Self::Paused
                    | Self::Fatal
                    | Self::Failed
                    | Self::Cancelled
            ) | (
                Self::Running,
                Self::VerificationFailed
                    | Self::Repairing
                    | Self::Retesting
                    | Self::WaitingForUser
                    | Self::WaitingForEnvironment
                    | Self::Paused
                    | Self::Recovering
                    | Self::Completing
                    | Self::Exhausted
                    | Self::Fatal
                    | Self::Failed
                    | Self::Cancelled
            ) | (
                Self::VerificationFailed,
                Self::Repairing
                    | Self::WaitingForUser
                    | Self::WaitingForEnvironment
                    | Self::Exhausted
                    | Self::Fatal
                    | Self::Cancelled
            ) | (
                Self::Repairing,
                Self::Retesting
                    | Self::WaitingForUser
                    | Self::WaitingForEnvironment
                    | Self::Exhausted
                    | Self::Fatal
                    | Self::Cancelled
            ) | (
                Self::Retesting,
                Self::Running
                    | Self::VerificationFailed
                    | Self::WaitingForUser
                    | Self::WaitingForEnvironment
                    | Self::Completing
                    | Self::Exhausted
                    | Self::Fatal
                    | Self::Cancelled
            ) | (
                Self::WaitingForUser,
                Self::Running
                    | Self::Repairing
                    | Self::Retesting
                    | Self::WaitingForEnvironment
                    | Self::Paused
                    | Self::Fatal
                    | Self::Failed
                    | Self::Cancelled
            ) | (
                Self::WaitingForEnvironment,
                Self::Running
                    | Self::Repairing
                    | Self::Retesting
                    | Self::WaitingForUser
                    | Self::Paused
                    | Self::Exhausted
                    | Self::Fatal
                    | Self::Cancelled
            ) | (Self::Paused, Self::Recovering | Self::Cancelled)
                | (Self::Cancelled, Self::Recovering)
                | (
                    Self::Recovering,
                    Self::Running
                        | Self::Repairing
                        | Self::Retesting
                        | Self::WaitingForUser
                        | Self::WaitingForEnvironment
                        | Self::Paused
                        | Self::Fatal
                        | Self::Failed
                        | Self::Cancelled
                )
                | (
                    Self::Completing,
                    Self::Completed | Self::Fatal | Self::Failed | Self::Cancelled
                )
        );
        transition_result("run", self, next, valid)
    }
}

impl TaskState {
    pub fn validate_transition(self, next: Self) -> Result<(), ProtocolError> {
        let valid = matches!(
            (self, next),
            (
                Self::Proposed,
                Self::Ready | Self::Cancelled | Self::Skipped
            ) | (
                Self::Ready,
                Self::Running | Self::Paused | Self::Cancelled | Self::Skipped
            ) | (
                Self::Running,
                Self::VerificationFailed
                    | Self::RepairPending
                    | Self::WaitingForUser
                    | Self::RepairExhausted
                    | Self::WaitingForCoordinator
                    | Self::WaitingForApproval
                    | Self::Paused
                    | Self::Succeeded
                    | Self::Failed
                    | Self::Cancelled
                    | Self::Skipped
            ) | (
                Self::VerificationFailed,
                Self::RepairPending
                    | Self::WaitingForUser
                    | Self::RepairExhausted
                    | Self::Failed
                    | Self::Cancelled
            ) | (
                Self::RepairPending,
                Self::Ready
                    | Self::Running
                    | Self::WaitingForUser
                    | Self::RepairExhausted
                    | Self::Failed
                    | Self::Cancelled
            ) | (
                Self::WaitingForUser,
                Self::Ready
                    | Self::Running
                    | Self::RepairPending
                    | Self::Paused
                    | Self::Failed
                    | Self::Cancelled
                    | Self::Skipped
            ) | (
                Self::WaitingForCoordinator | Self::WaitingForApproval,
                Self::Ready | Self::Running | Self::Paused | Self::Failed | Self::Cancelled
            ) | (Self::Paused, Self::Ready | Self::Running | Self::Cancelled)
                | (Self::Cancelled, Self::Paused)
        );
        transition_result("task", self, next, valid)
    }
}

impl AgentState {
    pub fn validate_transition(self, next: Self) -> Result<(), ProtocolError> {
        let valid = matches!(
            (self, next),
            (
                Self::Starting,
                Self::Running | Self::Stopping | Self::Stopped | Self::Crashed
            ) | (Self::Running, Self::Idle | Self::Stopping | Self::Crashed)
                | (Self::Idle, Self::Running | Self::Stopping | Self::Crashed)
                | (Self::Stopping, Self::Stopped | Self::Crashed)
        );
        transition_result("agent", self, next, valid)
    }
}

fn transition_result<T: std::fmt::Debug>(
    entity: &'static str,
    current: T,
    next: T,
    valid: bool,
) -> Result<(), ProtocolError> {
    if valid {
        Ok(())
    } else {
        Err(ProtocolError::InvalidStateTransition {
            entity,
            from: format!("{current:?}"),
            to: format!("{next:?}"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states_never_transition() {
        let run_states = [
            RunState::Planning,
            RunState::Running,
            RunState::VerificationFailed,
            RunState::Repairing,
            RunState::Retesting,
            RunState::WaitingForUser,
            RunState::WaitingForEnvironment,
            RunState::Paused,
            RunState::Recovering,
            RunState::Completing,
            RunState::Completed,
            RunState::Exhausted,
            RunState::Fatal,
            RunState::Failed,
            RunState::Cancelled,
        ];
        for terminal in [
            RunState::Completed,
            RunState::Exhausted,
            RunState::Fatal,
            RunState::Failed,
        ] {
            for next in run_states {
                assert!(terminal.validate_transition(next).is_err());
            }
        }
        assert!(RunState::Cancelled
            .validate_transition(RunState::Recovering)
            .is_ok());

        let task_states = [
            TaskState::Proposed,
            TaskState::Ready,
            TaskState::Running,
            TaskState::VerificationFailed,
            TaskState::RepairPending,
            TaskState::WaitingForUser,
            TaskState::WaitingForCoordinator,
            TaskState::WaitingForApproval,
            TaskState::Paused,
            TaskState::Succeeded,
            TaskState::RepairExhausted,
            TaskState::Failed,
            TaskState::Cancelled,
            TaskState::Skipped,
        ];
        for terminal in [
            TaskState::Succeeded,
            TaskState::RepairExhausted,
            TaskState::Failed,
            TaskState::Skipped,
        ] {
            for next in task_states {
                assert!(terminal.validate_transition(next).is_err());
            }
        }
        assert!(TaskState::Cancelled
            .validate_transition(TaskState::Paused)
            .is_ok());

        for (state, wire) in [
            (TaskState::VerificationFailed, "verification_failed"),
            (TaskState::RepairPending, "repair_pending"),
            (TaskState::WaitingForUser, "waiting_for_user"),
            (TaskState::RepairExhausted, "repair_exhausted"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), wire);
        }

        for terminal in [AgentState::Stopped, AgentState::Crashed] {
            for next in [
                AgentState::Starting,
                AgentState::Running,
                AgentState::Idle,
                AgentState::Stopping,
                AgentState::Stopped,
                AgentState::Crashed,
            ] {
                assert!(terminal.validate_transition(next).is_err());
            }
        }
    }
}
