use super::{CoordinatorAuditCommitError, CoordinatorAuditCommitter, CoordinatorAuditReceipt};
use crate::agents::control_plane::{RunClock, RunEngine, RunEventStore};
use crate::agents::protocol::{ControlCommand, CoordinatorAuditRecord, RunId};
use async_trait::async_trait;

pub struct RunEngineAuditCommitter<'a, S, C> {
    engine: &'a RunEngine<S, C>,
    run_id: RunId,
}

impl<'a, S, C> RunEngineAuditCommitter<'a, S, C> {
    pub fn new(engine: &'a RunEngine<S, C>, run_id: RunId) -> Self {
        Self { engine, run_id }
    }
}

#[async_trait]
impl<S, C> CoordinatorAuditCommitter for RunEngineAuditCommitter<'_, S, C>
where
    S: RunEventStore,
    C: RunClock,
{
    async fn commit(
        &self,
        audit: &CoordinatorAuditRecord,
    ) -> Result<CoordinatorAuditReceipt, CoordinatorAuditCommitError> {
        let receipt = self
            .engine
            .apply(ControlCommand::RecordCoordinatorAudit {
                run_id: self.run_id.clone(),
                audit: audit.clone(),
            })
            .await
            .map_err(|error| CoordinatorAuditCommitError::new(error.to_string()))?;
        let event = receipt
            .committed_events()
            .first()
            .ok_or_else(|| CoordinatorAuditCommitError::new("audit commit returned no event"))?;
        if !receipt.effects().is_empty() {
            return Err(CoordinatorAuditCommitError::new(
                "audit commit unexpectedly produced execution effects",
            ));
        }
        Ok(CoordinatorAuditReceipt {
            audit_event_id: event.event_id.clone(),
        })
    }
}
