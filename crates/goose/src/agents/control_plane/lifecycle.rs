use super::{CommittedControlEffect, ControlEffect, WorkerStopMode};
use crate::agents::protocol::AgentId;
use crate::agents::workers::{
    ProcessTreeError, ProcessTreeStop, ProcessTreeStopOutcome, ProcessTreeTerminator,
    RegistryError, WorkerHandle, WorkerRegistry, WorkerRuntimeState, WorkerTerminalState,
};
use futures::future::join_all;
use std::collections::BTreeSet;
use std::time::Duration;
use tokio::sync::watch;

const MAX_LIFECYCLE_FAILURE_CHARS: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessTreeFailure {
    pub process_id: u32,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerStopReceipt {
    pub agent_id: AgentId,
    pub generation: u64,
    pub cooperative: bool,
    pub forced: bool,
    pub confirmed_stopped: bool,
    pub runner_aborted: bool,
    pub process_trees: Vec<ProcessTreeStop>,
    pub failures: Vec<ProcessTreeFailure>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LifecycleError {
    #[error(transparent)]
    Registry(#[from] RegistryError),
    #[error("invalid committed control effect: {0}")]
    InvalidEffect(String),
    #[error("control effect is not handled by the worker lifecycle controller: {0}")]
    UnsupportedEffect(&'static str),
}

pub struct LifecycleController<P> {
    registry: WorkerRegistry,
    process_terminator: P,
    cooperative_grace: Duration,
}

impl<P> LifecycleController<P>
where
    P: ProcessTreeTerminator,
{
    pub fn new(
        registry: WorkerRegistry,
        process_terminator: P,
        cooperative_grace: Duration,
    ) -> Self {
        Self {
            registry,
            process_terminator,
            cooperative_grace,
        }
    }

    pub async fn apply(
        &self,
        committed: &CommittedControlEffect,
    ) -> Result<Vec<WorkerStopReceipt>, LifecycleError> {
        if committed.effect_id.trim().is_empty() {
            return Err(LifecycleError::InvalidEffect(
                "effect_id must not be empty".to_string(),
            ));
        }

        let (handles, mode) = match &committed.effect {
            ControlEffect::StopWorkers {
                run_id,
                agent_ids,
                mode,
            } => {
                validate_unique_agents(agent_ids)?;
                let handles = agent_ids
                    .iter()
                    .map(|agent_id| self.registry.current_handle(run_id, agent_id))
                    .collect::<Result<Vec<_>, _>>()?;
                (handles, *mode)
            }
            ControlEffect::EmergencyStop { run_id, .. }
            | ControlEffect::AbortFailedRun { run_id, .. } => (
                self.registry.live_handles_for_run(run_id)?,
                WorkerStopMode::Immediate,
            ),
            ControlEffect::DispatchTask { .. } => {
                return Err(LifecycleError::UnsupportedEffect("dispatch_task"));
            }
            ControlEffect::RetryTask { .. } => {
                return Err(LifecycleError::UnsupportedEffect("retry_task"));
            }
            ControlEffect::PauseScheduling { .. } => {
                return Err(LifecycleError::UnsupportedEffect("pause_scheduling"));
            }
            ControlEffect::RecoverRun { .. } => {
                return Err(LifecycleError::UnsupportedEffect("recover_run"));
            }
        };

        join_all(
            handles
                .into_iter()
                .map(|handle| self.stop_worker(handle, mode)),
        )
        .await
        .into_iter()
        .collect()
    }

    async fn stop_worker(
        &self,
        handle: WorkerHandle,
        mode: WorkerStopMode,
    ) -> Result<WorkerStopReceipt, LifecycleError> {
        let state_rx = self.registry.subscribe(&handle)?;
        if state_rx.borrow().is_terminal() {
            return Ok(cooperative_receipt(&handle));
        }

        match self.registry.request_stop(&handle) {
            Ok(_) => {}
            Err(RegistryError::WorkerTerminal(_)) => return Ok(cooperative_receipt(&handle)),
            Err(error) => return Err(error.into()),
        }

        if mode == WorkerStopMode::CooperativeThenForce
            && wait_for_terminal(state_rx, self.cooperative_grace).await
        {
            return Ok(cooperative_receipt(&handle));
        }

        // Closing registration and taking owners happen atomically. A later spawn must
        // reject registration and clean up its own retained owner.
        let processes = self.registry.begin_process_cleanup(&handle)?;
        let process_results = join_all(processes.iter().map(|process| async {
            match &process.owner {
                Some(owner) => owner.terminate().map(|_| None).map_err(|message| {
                    ProcessTreeError::StatusProbe {
                        process_id: process.process_id,
                        message,
                    }
                }),
                None => self
                    .process_terminator
                    .terminate_tree(process.process_id)
                    .await
                    .map(Some),
            }
        }))
        .await;
        // Drop the runner's Child before waiting for Unix groups to become empty:
        // otherwise a killed but unreaped parent can keep its group visible.
        let runner_aborted = self.registry.abort_runner(&handle)?;
        let process_results = join_all(processes.iter().zip(process_results).map(
            |(process, result)| async move {
                match result? {
                    Some(stop) => Ok(stop),
                    None => {
                        confirm_owned_process_exit(
                            process.process_id,
                            process.owner.as_ref().expect("owned termination").as_ref(),
                        )
                        .await
                    }
                }
            },
        ))
        .await;
        let mut process_trees = Vec::new();
        let mut failures = Vec::new();
        for (process, result) in processes.into_iter().zip(process_results) {
            match result {
                Ok(stop) => {
                    // A later retry must target only unconfirmed processes.
                    self.registry
                        .confirm_process_exited(&handle, process.process_id)?;
                    process_trees.push(stop);
                }
                Err(error) => failures.push(ProcessTreeFailure {
                    process_id: process.process_id,
                    message: bounded_failure(&error.to_string()),
                }),
            }
        }

        let runner_terminal = self.registry.state(&handle)?.is_terminal();
        let confirmed_stopped = failures.is_empty() && (runner_terminal || runner_aborted);
        if confirmed_stopped {
            self.registry
                .mark_terminal(&handle, WorkerTerminalState::Stopped)?;
        }

        Ok(WorkerStopReceipt {
            agent_id: handle.agent_id().clone(),
            generation: handle.generation(),
            cooperative: false,
            forced: true,
            confirmed_stopped,
            runner_aborted,
            process_trees,
            failures,
        })
    }
}

async fn confirm_owned_process_exit(
    process_id: u32,
    owner: &dyn crate::session::SessionProcessOwner,
) -> Result<ProcessTreeStop, ProcessTreeError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let empty = owner
            .is_empty()
            .map_err(|message| ProcessTreeError::StatusProbe {
                process_id,
                message,
            })?;
        if empty {
            return Ok(ProcessTreeStop {
                process_id,
                outcome: ProcessTreeStopOutcome::Terminated,
            });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ProcessTreeError::StillRunning(process_id));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn validate_unique_agents(agent_ids: &[AgentId]) -> Result<(), LifecycleError> {
    if agent_ids.is_empty() {
        return Err(LifecycleError::InvalidEffect(
            "stop_workers must name at least one agent".to_string(),
        ));
    }
    let mut unique = BTreeSet::new();
    for agent_id in agent_ids {
        if !unique.insert(agent_id) {
            return Err(LifecycleError::InvalidEffect(format!(
                "stop_workers contains duplicate agent {agent_id}"
            )));
        }
    }
    Ok(())
}

async fn wait_for_terminal(
    mut state_rx: watch::Receiver<WorkerRuntimeState>,
    grace: Duration,
) -> bool {
    if state_rx.borrow().is_terminal() {
        return true;
    }
    tokio::time::timeout(grace, async move {
        loop {
            if state_rx.changed().await.is_err() {
                return state_rx.borrow().is_terminal();
            }
            if state_rx.borrow().is_terminal() {
                return true;
            }
        }
    })
    .await
    .unwrap_or(false)
}

fn cooperative_receipt(handle: &WorkerHandle) -> WorkerStopReceipt {
    WorkerStopReceipt {
        agent_id: handle.agent_id().clone(),
        generation: handle.generation(),
        cooperative: true,
        forced: false,
        confirmed_stopped: true,
        runner_aborted: false,
        process_trees: Vec::new(),
        failures: Vec::new(),
    }
}

fn bounded_failure(message: &str) -> String {
    message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_LIFECYCLE_FAILURE_CHARS)
        .collect()
}
