use super::WorkerHandle;
use crate::agents::protocol::{AgentId, AgentState, RunId, TaskId, TaskState};
use crate::agents::reporting::RunProjection;
use crate::session::SessionProcessOwner;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::watch;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerRuntimeState {
    Active,
    CommittingOutcome,
    Stopping,
    Stopped,
    Crashed,
}

impl WorkerRuntimeState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Stopped | Self::Crashed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerTerminalState {
    Stopped,
    Crashed,
}

impl From<WorkerTerminalState> for WorkerRuntimeState {
    fn from(value: WorkerTerminalState) -> Self {
        match value {
            WorkerTerminalState::Stopped => Self::Stopped,
            WorkerTerminalState::Crashed => Self::Crashed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeAdmission {
    Accepted,
    Suppressed(OutcomeSuppression),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeSuppression {
    UnknownWorker,
    StaleGeneration,
    OutcomeCommitting,
    WorkerStopping,
    WorkerTerminal,
    TaskTerminal,
    RunMismatch,
}

#[derive(Debug, PartialEq, Eq)]
pub struct OutcomeClaim {
    handle: WorkerHandle,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerStopSnapshot {
    pub handle: WorkerHandle,
    pub newly_cancelled: bool,
    pub process_ids: Vec<u32>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistryError {
    #[error("worker {agent_id} already has a live generation")]
    DuplicateLiveWorker { agent_id: String },
    #[error("unknown worker: {0}")]
    UnknownWorker(String),
    #[error("stale worker generation: expected {expected}, actual {actual}")]
    StaleGeneration { expected: u64, actual: u64 },
    #[error("worker generation overflow for agent {0}")]
    GenerationOverflow(String),
    #[error("worker is already stopping: {0}")]
    WorkerStopping(String),
    #[error("worker must be stopping before its runner can be aborted: {0}")]
    WorkerNotStopping(String),
    #[error("worker is terminal: {0}")]
    WorkerTerminal(String),
    #[error("worker {agent_id} outcome lost a runtime race from state {state:?}")]
    OutcomeLostRace {
        agent_id: String,
        state: WorkerRuntimeState,
    },
    #[error("process id must be non-zero")]
    InvalidProcessId,
    #[error("process {0} already has a different owner")]
    ProcessOwnerConflict(u32),
    #[error("worker registry lock is poisoned")]
    Poisoned,
}

#[derive(Clone, Default)]
pub struct WorkerRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

#[derive(Default)]
struct RegistryState {
    entries: BTreeMap<(RunId, AgentId), WorkerEntry>,
}

pub(crate) struct RegisteredWorkerProcess {
    pub process_id: u32,
    pub owner: Option<Arc<dyn SessionProcessOwner>>,
}

struct WorkerEntry {
    handle: WorkerHandle,
    cancellation: CancellationToken,
    state: WorkerRuntimeState,
    state_tx: watch::Sender<WorkerRuntimeState>,
    process_ids: BTreeSet<u32>,
    process_owners: BTreeMap<u32, Arc<dyn SessionProcessOwner>>,
    process_registration_closed: bool,
    abort_handle: Option<AbortHandle>,
}

impl WorkerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &self,
        run_id: RunId,
        task_id: Option<TaskId>,
        agent_id: AgentId,
    ) -> Result<WorkerHandle, RegistryError> {
        let mut state = self.lock()?;
        let key = (run_id.clone(), agent_id.clone());
        let generation = match state.entries.get(&key) {
            Some(entry) if !entry.state.is_terminal() => {
                return Err(RegistryError::DuplicateLiveWorker {
                    agent_id: agent_id.to_string(),
                })
            }
            Some(entry) => entry
                .handle
                .generation()
                .checked_add(1)
                .ok_or_else(|| RegistryError::GenerationOverflow(agent_id.to_string()))?,
            None => 1,
        };
        let handle = WorkerHandle::new(run_id, task_id, agent_id, generation);
        let (state_tx, _) = watch::channel(WorkerRuntimeState::Active);
        state.entries.insert(
            key,
            WorkerEntry {
                handle: handle.clone(),
                cancellation: CancellationToken::new(),
                state: WorkerRuntimeState::Active,
                state_tx,
                process_ids: BTreeSet::new(),
                process_owners: BTreeMap::new(),
                process_registration_closed: false,
                abort_handle: None,
            },
        );
        Ok(handle)
    }

    pub fn cancellation_token(
        &self,
        handle: &WorkerHandle,
    ) -> Result<CancellationToken, RegistryError> {
        let state = self.lock()?;
        Ok(current_entry(&state, handle)?.cancellation.clone())
    }

    pub fn state(&self, handle: &WorkerHandle) -> Result<WorkerRuntimeState, RegistryError> {
        let state = self.lock()?;
        Ok(current_entry(&state, handle)?.state)
    }

    pub fn current_handle(
        &self,
        run_id: &RunId,
        agent_id: &AgentId,
    ) -> Result<WorkerHandle, RegistryError> {
        let state = self.lock()?;
        state
            .entries
            .get(&(run_id.clone(), agent_id.clone()))
            .map(|entry| entry.handle.clone())
            .ok_or_else(|| RegistryError::UnknownWorker(agent_id.to_string()))
    }

    pub fn live_handles_for_run(&self, run_id: &RunId) -> Result<Vec<WorkerHandle>, RegistryError> {
        let state = self.lock()?;
        Ok(state
            .entries
            .iter()
            .filter(|((entry_run_id, _), entry)| {
                entry_run_id == run_id && !entry.state.is_terminal()
            })
            .map(|(_, entry)| entry.handle.clone())
            .collect())
    }

    pub fn subscribe(
        &self,
        handle: &WorkerHandle,
    ) -> Result<watch::Receiver<WorkerRuntimeState>, RegistryError> {
        let state = self.lock()?;
        Ok(current_entry(&state, handle)?.state_tx.subscribe())
    }

    pub fn attach_abort_handle(
        &self,
        handle: &WorkerHandle,
        abort_handle: AbortHandle,
    ) -> Result<(), RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        if entry.state.is_terminal() {
            return Err(RegistryError::WorkerTerminal(handle.agent_id().to_string()));
        }
        if entry.state == WorkerRuntimeState::Stopping {
            return Err(RegistryError::WorkerStopping(handle.agent_id().to_string()));
        }
        entry.abort_handle = Some(abort_handle);
        Ok(())
    }

    pub fn abort_runner(&self, handle: &WorkerHandle) -> Result<bool, RegistryError> {
        let state = self.lock()?;
        let entry = current_entry(&state, handle)?;
        match entry.state {
            WorkerRuntimeState::Active | WorkerRuntimeState::CommittingOutcome => {
                return Err(RegistryError::WorkerNotStopping(
                    handle.agent_id().to_string(),
                ));
            }
            WorkerRuntimeState::Stopped | WorkerRuntimeState::Crashed => return Ok(false),
            WorkerRuntimeState::Stopping => {}
        }
        if let Some(abort_handle) = &entry.abort_handle {
            abort_handle.abort();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn register_process(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
    ) -> Result<(), RegistryError> {
        if process_id == 0 {
            return Err(RegistryError::InvalidProcessId);
        }
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        if entry.state.is_terminal() {
            return Err(RegistryError::WorkerTerminal(handle.agent_id().to_string()));
        }
        if entry.process_registration_closed {
            return Err(RegistryError::WorkerStopping(handle.agent_id().to_string()));
        }
        // Accept late spawns during cooperative grace, before the force-stop snapshot closes registration.
        entry.process_ids.insert(process_id);
        Ok(())
    }

    pub fn register_process_owner(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
        owner: Arc<dyn SessionProcessOwner>,
    ) -> Result<(), RegistryError> {
        if process_id == 0 {
            return Err(RegistryError::InvalidProcessId);
        }
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        if entry.state.is_terminal() {
            return Err(RegistryError::WorkerTerminal(handle.agent_id().to_string()));
        }
        if entry.process_registration_closed {
            return Err(RegistryError::WorkerStopping(handle.agent_id().to_string()));
        }
        if let Some(existing) = entry.process_owners.get(&process_id) {
            return if Arc::ptr_eq(existing, &owner) {
                Ok(())
            } else {
                Err(RegistryError::ProcessOwnerConflict(process_id))
            };
        }
        entry.process_ids.insert(process_id);
        entry.process_owners.insert(process_id, owner);
        Ok(())
    }

    pub fn process_owner(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
    ) -> Result<Option<Arc<dyn SessionProcessOwner>>, RegistryError> {
        let state = self.lock()?;
        Ok(current_entry(&state, handle)?
            .process_owners
            .get(&process_id)
            .cloned())
    }

    pub(crate) fn begin_process_cleanup(
        &self,
        handle: &WorkerHandle,
    ) -> Result<Vec<RegisteredWorkerProcess>, RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        if !entry.state.is_terminal() && entry.state != WorkerRuntimeState::Stopping {
            return Err(RegistryError::WorkerNotStopping(
                handle.agent_id().to_string(),
            ));
        }
        entry.process_registration_closed = true;
        Ok(entry
            .process_ids
            .iter()
            .map(|process_id| RegisteredWorkerProcess {
                process_id: *process_id,
                owner: entry.process_owners.get(process_id).cloned(),
            })
            .collect())
    }

    pub fn unregister_process(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
    ) -> Result<bool, RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        // Runner drop must not erase an unconfirmed force-stop target. Retain it for retries.
        if entry.process_registration_closed && !entry.state.is_terminal() {
            return Ok(false);
        }
        let removed = entry.process_ids.remove(&process_id);
        let owner = entry.process_owners.remove(&process_id);
        drop(state);
        drop(owner);
        Ok(removed)
    }

    pub(crate) fn confirm_process_exited(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
    ) -> Result<(), RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        if !entry.process_registration_closed {
            return Err(RegistryError::WorkerNotStopping(
                handle.agent_id().to_string(),
            ));
        }
        entry.process_ids.remove(&process_id);
        let owner = entry.process_owners.remove(&process_id);
        drop(state);
        drop(owner);
        Ok(())
    }

    pub fn process_ids(&self, handle: &WorkerHandle) -> Result<Vec<u32>, RegistryError> {
        let state = self.lock()?;
        Ok(current_entry(&state, handle)?
            .process_ids
            .iter()
            .copied()
            .collect())
    }

    pub fn request_stop(&self, handle: &WorkerHandle) -> Result<WorkerStopSnapshot, RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        if entry.state.is_terminal() {
            return Err(RegistryError::WorkerTerminal(handle.agent_id().to_string()));
        }
        let newly_cancelled = entry.state != WorkerRuntimeState::Stopping;
        if newly_cancelled {
            entry.state = WorkerRuntimeState::Stopping;
            entry.cancellation.cancel();
            entry.state_tx.send_replace(WorkerRuntimeState::Stopping);
        }
        Ok(WorkerStopSnapshot {
            handle: handle.clone(),
            newly_cancelled,
            process_ids: entry.process_ids.iter().copied().collect(),
        })
    }

    pub fn mark_terminal(
        &self,
        handle: &WorkerHandle,
        terminal: WorkerTerminalState,
    ) -> Result<(), RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, handle)?;
        let next = WorkerRuntimeState::from(terminal);
        if entry.state.is_terminal() {
            return Ok(());
        }
        entry.state = next;
        entry.cancellation.cancel();
        entry.process_ids.clear();
        let owners = std::mem::take(&mut entry.process_owners);
        entry.abort_handle = None;
        entry.state_tx.send_replace(next);
        drop(state);
        drop(owners);
        Ok(())
    }

    pub fn admit_outcome(
        &self,
        handle: &WorkerHandle,
        projection: &RunProjection,
    ) -> OutcomeAdmission {
        if &projection.run_id != handle.run_id() {
            return OutcomeAdmission::Suppressed(OutcomeSuppression::RunMismatch);
        }
        let state = match self.lock() {
            Ok(state) => state,
            Err(_) => {
                return OutcomeAdmission::Suppressed(OutcomeSuppression::UnknownWorker);
            }
        };
        let Some(entry) = state
            .entries
            .get(&(handle.run_id().clone(), handle.agent_id().clone()))
        else {
            return OutcomeAdmission::Suppressed(OutcomeSuppression::UnknownWorker);
        };
        if entry.handle.generation() != handle.generation() {
            return OutcomeAdmission::Suppressed(OutcomeSuppression::StaleGeneration);
        }
        match entry.state {
            WorkerRuntimeState::CommittingOutcome => {
                return OutcomeAdmission::Suppressed(OutcomeSuppression::OutcomeCommitting)
            }
            WorkerRuntimeState::Stopping => {
                return OutcomeAdmission::Suppressed(OutcomeSuppression::WorkerStopping)
            }
            WorkerRuntimeState::Stopped | WorkerRuntimeState::Crashed => {
                return OutcomeAdmission::Suppressed(OutcomeSuppression::WorkerTerminal)
            }
            WorkerRuntimeState::Active => {}
        }

        if let Some(task_id) = handle.task_id() {
            let Some(task) = projection.tasks.get(task_id) else {
                return OutcomeAdmission::Suppressed(OutcomeSuppression::UnknownWorker);
            };
            if is_terminal_task(task.state) {
                return OutcomeAdmission::Suppressed(OutcomeSuppression::TaskTerminal);
            }
        }
        let Some(agent) = projection.agents.get(handle.agent_id()) else {
            return OutcomeAdmission::Suppressed(OutcomeSuppression::UnknownWorker);
        };
        if agent.task_id.as_ref() != handle.task_id() {
            return OutcomeAdmission::Suppressed(OutcomeSuppression::UnknownWorker);
        }
        match agent.state {
            AgentState::Starting | AgentState::Running | AgentState::Idle => {
                OutcomeAdmission::Accepted
            }
            AgentState::Stopping => {
                OutcomeAdmission::Suppressed(OutcomeSuppression::WorkerStopping)
            }
            AgentState::Stopped | AgentState::Crashed => {
                OutcomeAdmission::Suppressed(OutcomeSuppression::WorkerTerminal)
            }
        }
    }

    pub fn claim_outcome(
        &self,
        handle: &WorkerHandle,
        projection: &RunProjection,
    ) -> Result<OutcomeClaim, OutcomeSuppression> {
        if &projection.run_id != handle.run_id() {
            return Err(OutcomeSuppression::RunMismatch);
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| OutcomeSuppression::UnknownWorker)?;
        let Some(entry) = state
            .entries
            .get_mut(&(handle.run_id().clone(), handle.agent_id().clone()))
        else {
            return Err(OutcomeSuppression::UnknownWorker);
        };
        if entry.handle.generation() != handle.generation() {
            return Err(OutcomeSuppression::StaleGeneration);
        }
        match entry.state {
            WorkerRuntimeState::Active => {}
            WorkerRuntimeState::CommittingOutcome => {
                return Err(OutcomeSuppression::OutcomeCommitting)
            }
            WorkerRuntimeState::Stopping => return Err(OutcomeSuppression::WorkerStopping),
            WorkerRuntimeState::Stopped | WorkerRuntimeState::Crashed => {
                return Err(OutcomeSuppression::WorkerTerminal)
            }
        }
        let Some(task_id) = handle.task_id() else {
            return Err(OutcomeSuppression::UnknownWorker);
        };
        let Some(task) = projection.tasks.get(task_id) else {
            return Err(OutcomeSuppression::UnknownWorker);
        };
        if is_terminal_task(task.state) {
            return Err(OutcomeSuppression::TaskTerminal);
        }
        let Some(agent) = projection.agents.get(handle.agent_id()) else {
            return Err(OutcomeSuppression::UnknownWorker);
        };
        if agent.task_id.as_ref() != handle.task_id() {
            return Err(OutcomeSuppression::UnknownWorker);
        }
        match agent.state {
            AgentState::Starting | AgentState::Running | AgentState::Idle => {}
            AgentState::Stopping => return Err(OutcomeSuppression::WorkerStopping),
            AgentState::Stopped | AgentState::Crashed => {
                return Err(OutcomeSuppression::WorkerTerminal)
            }
        }

        entry.state = WorkerRuntimeState::CommittingOutcome;
        entry
            .state_tx
            .send_replace(WorkerRuntimeState::CommittingOutcome);
        Ok(OutcomeClaim {
            handle: handle.clone(),
        })
    }

    pub fn release_outcome(&self, claim: OutcomeClaim) -> Result<(), RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, &claim.handle)?;
        if entry.state == WorkerRuntimeState::CommittingOutcome {
            entry.state = WorkerRuntimeState::Active;
            entry.state_tx.send_replace(WorkerRuntimeState::Active);
        }
        Ok(())
    }

    pub fn finalize_outcome(&self, claim: OutcomeClaim) -> Result<(), RegistryError> {
        let mut state = self.lock()?;
        let entry = current_entry_mut(&mut state, &claim.handle)?;
        if entry.state != WorkerRuntimeState::CommittingOutcome {
            return Err(RegistryError::OutcomeLostRace {
                agent_id: claim.handle.agent_id().to_string(),
                state: entry.state,
            });
        }
        entry.state = WorkerRuntimeState::Stopped;
        entry.cancellation.cancel();
        entry.process_ids.clear();
        entry.abort_handle = None;
        entry.state_tx.send_replace(WorkerRuntimeState::Stopped);
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, RegistryState>, RegistryError> {
        self.inner.lock().map_err(|_| RegistryError::Poisoned)
    }
}

fn current_entry<'a>(
    state: &'a RegistryState,
    handle: &WorkerHandle,
) -> Result<&'a WorkerEntry, RegistryError> {
    let entry = state
        .entries
        .get(&(handle.run_id().clone(), handle.agent_id().clone()))
        .ok_or_else(|| RegistryError::UnknownWorker(handle.agent_id().to_string()))?;
    ensure_generation(entry, handle)?;
    Ok(entry)
}

fn current_entry_mut<'a>(
    state: &'a mut RegistryState,
    handle: &WorkerHandle,
) -> Result<&'a mut WorkerEntry, RegistryError> {
    let entry = state
        .entries
        .get_mut(&(handle.run_id().clone(), handle.agent_id().clone()))
        .ok_or_else(|| RegistryError::UnknownWorker(handle.agent_id().to_string()))?;
    ensure_generation(entry, handle)?;
    Ok(entry)
}

fn ensure_generation(entry: &WorkerEntry, handle: &WorkerHandle) -> Result<(), RegistryError> {
    if entry.handle.generation() == handle.generation() {
        Ok(())
    } else {
        Err(RegistryError::StaleGeneration {
            expected: entry.handle.generation(),
            actual: handle.generation(),
        })
    }
}

fn is_terminal_task(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Succeeded | TaskState::Failed | TaskState::Cancelled | TaskState::Skipped
    )
}
