use super::{CommandReceipt, CommittedControlEffect};
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchReceipt {
    pub executed_effect_ids: Vec<String>,
    pub deduplicated_effect_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectExecutionOutcome {
    DefinitelyNotApplied,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EffectExecutionError {
    message: String,
    outcome: EffectExecutionOutcome,
}

impl EffectExecutionError {
    /// Creates a fail-closed error. Callers must use `definitely_not_applied`
    /// only when the executor can prove it did not cross its effect boundary.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            outcome: EffectExecutionOutcome::Unknown,
        }
    }

    pub fn definitely_not_applied(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            outcome: EffectExecutionOutcome::DefinitelyNotApplied,
        }
    }

    pub fn outcome(&self) -> EffectExecutionOutcome {
        self.outcome
    }
}

#[async_trait]
pub trait ControlEffectExecutor: Send + Sync {
    async fn execute(&self, effect: &CommittedControlEffect) -> Result<(), EffectExecutionError>;
}

#[async_trait]
impl<T> ControlEffectExecutor for Arc<T>
where
    T: ControlEffectExecutor + ?Sized,
{
    async fn execute(&self, effect: &CommittedControlEffect) -> Result<(), EffectExecutionError> {
        (**self).execute(effect).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectClaimStatus {
    Claimed,
    Completed,
    InFlight,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EffectLedgerError {
    #[error("effect ledger lock is poisoned")]
    Poisoned,
    #[error("effect {effect_id} cannot transition from {actual}")]
    InvalidTransition {
        effect_id: String,
        actual: &'static str,
    },
    #[error("effect was not durably prepared: {0}")]
    MissingPrepared(String),
    #[error("effect identity conflicts with durable ledger: {0}")]
    IdentityConflict(String),
    #[error("effect ledger has an incomplete final record")]
    IncompleteTail,
    #[error("effect ledger line {line} is corrupt: {reason}")]
    Corrupt { line: usize, reason: String },
    #[error("effect ledger exceeds its safety limit")]
    Capacity,
    #[error("effect ledger I/O failed at {path}: {message}")]
    Io { path: String, message: String },
}

pub trait EffectLedger: Send + Sync {
    fn claim(
        &self,
        effect: &CommittedControlEffect,
    ) -> Result<EffectClaimStatus, EffectLedgerError>;
    fn complete(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError>;
    fn retry(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError>;
    fn mark_uncertain(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LedgerState {
    InFlight,
    Completed,
    Uncertain,
}

#[derive(Clone, Default)]
pub struct InMemoryEffectLedger {
    state: Arc<Mutex<BTreeMap<String, LedgerState>>>,
}

impl InMemoryEffectLedger {
    pub fn new() -> Self {
        Self::default()
    }
}

impl EffectLedger for InMemoryEffectLedger {
    fn claim(
        &self,
        effect: &CommittedControlEffect,
    ) -> Result<EffectClaimStatus, EffectLedgerError> {
        let effect_id = effect.ledger_key();
        let mut state = self.state.lock().map_err(|_| EffectLedgerError::Poisoned)?;
        match state.get(&effect_id) {
            Some(LedgerState::Completed) => Ok(EffectClaimStatus::Completed),
            Some(LedgerState::InFlight) => Ok(EffectClaimStatus::InFlight),
            Some(LedgerState::Uncertain) => Ok(EffectClaimStatus::Uncertain),
            None => {
                state.insert(effect_id, LedgerState::InFlight);
                Ok(EffectClaimStatus::Claimed)
            }
        }
    }

    fn complete(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError> {
        let effect_id = effect.ledger_key();
        let mut state = self.state.lock().map_err(|_| EffectLedgerError::Poisoned)?;
        match state.get(&effect_id) {
            Some(LedgerState::InFlight) => {
                state.insert(effect_id, LedgerState::Completed);
                Ok(())
            }
            Some(LedgerState::Completed) => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "completed",
            }),
            Some(LedgerState::Uncertain) => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "uncertain",
            }),
            None => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "unclaimed",
            }),
        }
    }

    fn retry(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError> {
        let effect_id = effect.ledger_key();
        let mut state = self.state.lock().map_err(|_| EffectLedgerError::Poisoned)?;
        match state.get(&effect_id) {
            Some(LedgerState::InFlight) => {
                state.remove(&effect_id);
                Ok(())
            }
            Some(LedgerState::Completed) => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "completed",
            }),
            Some(LedgerState::Uncertain) => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "uncertain",
            }),
            None => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "unclaimed",
            }),
        }
    }

    fn mark_uncertain(&self, effect: &CommittedControlEffect) -> Result<(), EffectLedgerError> {
        let effect_id = effect.ledger_key();
        let mut state = self.state.lock().map_err(|_| EffectLedgerError::Poisoned)?;
        match state.get(&effect_id) {
            Some(LedgerState::InFlight) => {
                state.insert(effect_id, LedgerState::Uncertain);
                Ok(())
            }
            Some(LedgerState::Completed) => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "completed",
            }),
            Some(LedgerState::Uncertain) => Ok(()),
            None => Err(EffectLedgerError::InvalidTransition {
                effect_id,
                actual: "unclaimed",
            }),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EffectDispatchError {
    #[error("effect ledger failed: {0}")]
    Ledger(#[from] EffectLedgerError),
    #[error("effect is already executing: {0}")]
    InFlight(String),
    #[error("effect outcome is uncertain and requires recovery: {0}")]
    Uncertain(String),
    #[error("effect {effect_id} execution failed: {message}")]
    Execution { effect_id: String, message: String },
}

pub struct EffectDispatcher<E, L> {
    executor: E,
    ledger: L,
}

impl<E, L> EffectDispatcher<E, L>
where
    E: ControlEffectExecutor,
    L: EffectLedger,
{
    pub fn new(executor: E, ledger: L) -> Self {
        Self { executor, ledger }
    }

    pub async fn dispatch(
        &self,
        receipt: &CommandReceipt,
    ) -> Result<DispatchReceipt, EffectDispatchError> {
        self.dispatch_effects(receipt.effects()).await
    }

    pub async fn dispatch_effects(
        &self,
        effects: &[CommittedControlEffect],
    ) -> Result<DispatchReceipt, EffectDispatchError> {
        let mut dispatched = DispatchReceipt {
            executed_effect_ids: Vec::new(),
            deduplicated_effect_ids: Vec::new(),
        };
        for effect in effects {
            let ledger_key = effect.ledger_key();
            match self.ledger.claim(effect)? {
                EffectClaimStatus::Completed => {
                    dispatched.deduplicated_effect_ids.push(ledger_key);
                    continue;
                }
                EffectClaimStatus::InFlight => {
                    return Err(EffectDispatchError::InFlight(ledger_key));
                }
                EffectClaimStatus::Uncertain => {
                    return Err(EffectDispatchError::Uncertain(ledger_key));
                }
                EffectClaimStatus::Claimed => {}
            }

            if let Err(error) = self.executor.execute(effect).await {
                let transition = match error.outcome() {
                    EffectExecutionOutcome::DefinitelyNotApplied => self.ledger.retry(effect),
                    EffectExecutionOutcome::Unknown => self.ledger.mark_uncertain(effect),
                };
                let message = match transition {
                    Ok(()) => error.to_string(),
                    Err(transition) => {
                        format!("{error}; ledger outcome transition failed: {transition}")
                    }
                };
                return Err(EffectDispatchError::Execution {
                    effect_id: ledger_key,
                    message,
                });
            }
            self.ledger.complete(effect)?;
            dispatched.executed_effect_ids.push(ledger_key);
        }
        Ok(dispatched)
    }
}
