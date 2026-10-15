use crate::agents::protocol::{RunId, TaskId};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio_util::sync::CancellationToken;

const MAX_PENDING_LEASES_PER_RUN: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulingLease {
    pub effect_id: String,
    pub task_id: TaskId,
    pub retry_attempt: Option<u32>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SchedulerGateError {
    #[error("unknown scheduler gate for run {0}")]
    UnknownRun(String),
    #[error("scheduling is paused for run {0}")]
    Paused(String),
    #[error("run {0} already has a prompt cancellation token")]
    PromptAlreadyRegistered(String),
    #[error("scheduler lease already exists for effect {0}")]
    DuplicateLease(String),
    #[error("scheduler lease capacity exceeded for run {0}")]
    Capacity(String),
    #[error("scheduler gate lock is poisoned")]
    Poisoned,
}

#[derive(Clone, Default)]
pub struct SchedulerGateRegistry {
    inner: Arc<Mutex<GateRegistryState>>,
}

#[derive(Default)]
struct GateRegistryState {
    runs: BTreeMap<RunId, RunGate>,
}

struct RunGate {
    open: bool,
    prompt: Option<CancellationToken>,
    leases: BTreeMap<TaskId, VecDeque<SchedulingLease>>,
    lease_ids: BTreeSet<String>,
    pending_leases: usize,
}

impl Default for RunGate {
    fn default() -> Self {
        Self {
            open: true,
            prompt: None,
            leases: BTreeMap::new(),
            lease_ids: BTreeSet::new(),
            pending_leases: 0,
        }
    }
}

impl SchedulerGateRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ensure_run(&self, run_id: RunId) -> Result<(), SchedulerGateError> {
        self.lock()?.runs.entry(run_id).or_default();
        Ok(())
    }

    pub fn register_prompt(
        &self,
        run_id: &RunId,
        token: CancellationToken,
    ) -> Result<(), SchedulerGateError> {
        let mut state = self.lock()?;
        let gate = gate_mut(&mut state, run_id)?;
        if gate.prompt.is_some() {
            return Err(SchedulerGateError::PromptAlreadyRegistered(
                run_id.to_string(),
            ));
        }
        gate.prompt = Some(token);
        Ok(())
    }

    pub fn bind_prompt(
        &self,
        run_id: &RunId,
        token: CancellationToken,
    ) -> Result<(), SchedulerGateError> {
        let mut state = self.lock()?;
        gate_mut(&mut state, run_id)?.prompt = Some(token);
        Ok(())
    }

    pub fn grant(
        &self,
        run_id: &RunId,
        task_id: TaskId,
        effect_id: &str,
        retry_attempt: Option<u32>,
    ) -> Result<(), SchedulerGateError> {
        let mut state = self.lock()?;
        let gate = gate_mut(&mut state, run_id)?;
        if !gate.open {
            return Err(SchedulerGateError::Paused(run_id.to_string()));
        }
        if gate.pending_leases >= MAX_PENDING_LEASES_PER_RUN {
            return Err(SchedulerGateError::Capacity(run_id.to_string()));
        }
        if !gate.lease_ids.insert(effect_id.to_string()) {
            return Err(SchedulerGateError::DuplicateLease(effect_id.to_string()));
        }
        gate.leases
            .entry(task_id.clone())
            .or_default()
            .push_back(SchedulingLease {
                effect_id: effect_id.to_string(),
                task_id,
                retry_attempt,
            });
        gate.pending_leases += 1;
        Ok(())
    }

    pub fn try_claim(
        &self,
        run_id: &RunId,
        task_id: &TaskId,
    ) -> Result<Option<SchedulingLease>, SchedulerGateError> {
        let mut state = self.lock()?;
        let gate = gate_mut(&mut state, run_id)?;
        if !gate.open {
            return Err(SchedulerGateError::Paused(run_id.to_string()));
        }
        let Some(queue) = gate.leases.get_mut(task_id) else {
            return Ok(None);
        };
        let lease = queue.pop_front();
        if let Some(lease) = &lease {
            gate.lease_ids.remove(&lease.effect_id);
            gate.pending_leases = gate.pending_leases.saturating_sub(1);
        }
        if queue.is_empty() {
            gate.leases.remove(task_id);
        }
        Ok(lease)
    }

    pub fn pause(&self, run_id: &RunId) -> Result<(), SchedulerGateError> {
        let mut state = self.lock()?;
        gate_mut(&mut state, run_id)?.open = false;
        Ok(())
    }

    pub fn recover(&self, run_id: &RunId) -> Result<(), SchedulerGateError> {
        let mut state = self.lock()?;
        gate_mut(&mut state, run_id)?.open = true;
        Ok(())
    }

    pub fn emergency_stop(&self, run_id: &RunId) -> Result<(), SchedulerGateError> {
        let token = {
            let mut state = self.lock()?;
            let gate = gate_mut(&mut state, run_id)?;
            gate.open = false;
            gate.prompt.clone()
        };
        if let Some(token) = token {
            token.cancel();
        }
        Ok(())
    }

    pub fn is_open(&self, run_id: &RunId) -> Result<bool, SchedulerGateError> {
        let state = self.lock()?;
        Ok(gate(&state, run_id)?.open)
    }

    fn lock(&self) -> Result<MutexGuard<'_, GateRegistryState>, SchedulerGateError> {
        self.inner.lock().map_err(|_| SchedulerGateError::Poisoned)
    }
}

fn gate<'a>(
    state: &'a GateRegistryState,
    run_id: &RunId,
) -> Result<&'a RunGate, SchedulerGateError> {
    state
        .runs
        .get(run_id)
        .ok_or_else(|| SchedulerGateError::UnknownRun(run_id.to_string()))
}

fn gate_mut<'a>(
    state: &'a mut GateRegistryState,
    run_id: &RunId,
) -> Result<&'a mut RunGate, SchedulerGateError> {
    state
        .runs
        .get_mut(run_id)
        .ok_or_else(|| SchedulerGateError::UnknownRun(run_id.to_string()))
}
