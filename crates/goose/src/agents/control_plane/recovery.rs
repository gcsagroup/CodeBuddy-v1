use super::{
    DurableEffectEntry, DurableEffectState, EffectLedgerError, EffectLedgerRecoveryReport,
    EventStoreError, FileEffectLedger, FileRunEventStore, RecoveryReport, RunEventStore,
};
use crate::agents::protocol::RunId;
use crate::agents::reporting::{ProjectionError, RunProjection};

#[derive(Debug, Clone)]
pub struct RunRecoveryReport {
    pub event_log: RecoveryReport,
    pub effect_ledger: EffectLedgerRecoveryReport,
    pub projection: Option<RunProjection>,
    pub pending: Vec<DurableEffectEntry>,
    pub completed: Vec<DurableEffectEntry>,
    pub uncertain: Vec<DurableEffectEntry>,
    pub abandoned: Vec<DurableEffectEntry>,
}

impl RunRecoveryReport {
    pub fn uncertain_effect_ids(&self) -> Vec<String> {
        self.uncertain
            .iter()
            .map(|entry| entry.effect.ledger_key())
            .collect()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RunRecoveryError {
    #[error("run event recovery failed: {0}")]
    Events(#[from] EventStoreError),
    #[error("effect ledger recovery failed: {0}")]
    Effects(#[from] EffectLedgerError),
    #[error("recovered run projection is invalid: {0}")]
    Projection(#[from] ProjectionError),
}

/// Performs startup reconciliation only. The caller must ensure the prior host
/// process has terminated and must not dispatch effects concurrently.
#[derive(Debug, Clone)]
pub struct RunRecovery {
    event_store: FileRunEventStore,
    effect_ledger: FileEffectLedger,
}

impl RunRecovery {
    pub fn new(event_store: FileRunEventStore, effect_ledger: FileEffectLedger) -> Self {
        Self {
            event_store,
            effect_ledger,
        }
    }

    pub async fn recover(&self, run_id: &RunId) -> Result<RunRecoveryReport, RunRecoveryError> {
        let event_log = self.event_store.recover_incomplete_tail(run_id).await?;
        let effect_ledger = self.effect_ledger.recover_incomplete_tail(run_id)?;
        let events = self.event_store.load(run_id).await?;
        let entries = self
            .effect_ledger
            .reconcile_committed_events(run_id, &events)?;
        let projection = if events.is_empty() {
            None
        } else {
            Some(RunProjection::rebuild(&events)?)
        };
        let mut pending = Vec::new();
        let mut completed = Vec::new();
        let mut uncertain = Vec::new();
        let mut abandoned = Vec::new();
        for entry in entries {
            match entry.state {
                DurableEffectState::Pending => pending.push(entry),
                DurableEffectState::Completed => completed.push(entry),
                DurableEffectState::Uncertain | DurableEffectState::Claimed => {
                    uncertain.push(entry)
                }
                DurableEffectState::Abandoned | DurableEffectState::Prepared => {
                    abandoned.push(entry)
                }
            }
        }
        Ok(RunRecoveryReport {
            event_log,
            effect_ledger,
            projection,
            pending,
            completed,
            uncertain,
            abandoned,
        })
    }

    /// Observes a live run without truncating files or reconciling effect state.
    /// Startup recovery is intentionally mutating and must not be used by read-only APIs.
    pub async fn inspect(&self, run_id: &RunId) -> Result<RunRecoveryReport, RunRecoveryError> {
        let events = self.event_store.load(run_id).await?;
        let (effect_ledger, entries) = self.effect_ledger.inspect(run_id)?;
        let projection = if events.is_empty() {
            None
        } else {
            Some(RunProjection::rebuild(&events)?)
        };
        let event_log = RecoveryReport {
            truncated_bytes: 0,
            last_sequence: events.last().map_or(0, |event| event.sequence),
        };
        let mut pending = Vec::new();
        let mut completed = Vec::new();
        let mut uncertain = Vec::new();
        let mut abandoned = Vec::new();
        for entry in entries {
            match entry.state {
                DurableEffectState::Pending | DurableEffectState::Claimed => pending.push(entry),
                DurableEffectState::Completed => completed.push(entry),
                DurableEffectState::Uncertain => uncertain.push(entry),
                DurableEffectState::Abandoned | DurableEffectState::Prepared => {
                    abandoned.push(entry)
                }
            }
        }
        Ok(RunRecoveryReport {
            event_log,
            effect_ledger,
            projection,
            pending,
            completed,
            uncertain,
            abandoned,
        })
    }
}
