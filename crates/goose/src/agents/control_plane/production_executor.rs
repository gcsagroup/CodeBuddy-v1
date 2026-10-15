use super::{
    CommittedControlEffect, ControlEffect, ControlEffectExecutor, EffectExecutionError,
    LifecycleController, SchedulerGateRegistry,
};
use crate::agents::workers::{ProcessTreeTerminator, WorkerRegistry};
use async_trait::async_trait;
use std::time::Duration;

pub struct ProductionControlEffectExecutor<P> {
    gates: SchedulerGateRegistry,
    registry: WorkerRegistry,
    process_terminator: P,
    cooperative_grace: Duration,
}

impl<P> ProductionControlEffectExecutor<P> {
    pub fn new(
        gates: SchedulerGateRegistry,
        registry: WorkerRegistry,
        process_terminator: P,
        cooperative_grace: Duration,
    ) -> Self {
        Self {
            gates,
            registry,
            process_terminator,
            cooperative_grace,
        }
    }
}

#[async_trait]
impl<P> ControlEffectExecutor for ProductionControlEffectExecutor<P>
where
    P: ProcessTreeTerminator + Clone,
{
    async fn execute(
        &self,
        committed: &CommittedControlEffect,
    ) -> Result<(), EffectExecutionError> {
        match &committed.effect {
            ControlEffect::DispatchTask { run_id, task_id } => self
                .gates
                .grant(run_id, task_id.clone(), &committed.effect_id, None)
                .map_err(definitely_not_applied),
            ControlEffect::RetryTask {
                run_id,
                task_id,
                attempt,
                delay_ms,
            } => {
                if *delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
                }
                self.gates
                    .grant(
                        run_id,
                        task_id.clone(),
                        &committed.effect_id,
                        Some(*attempt),
                    )
                    .map_err(definitely_not_applied)
            }
            ControlEffect::PauseScheduling { run_id } => {
                self.gates.pause(run_id).map_err(definitely_not_applied)
            }
            ControlEffect::RecoverRun { run_id } => {
                self.gates.recover(run_id).map_err(definitely_not_applied)
            }
            ControlEffect::StopWorkers { .. } => self.stop_workers(committed).await,
            ControlEffect::EmergencyStop { run_id, .. }
            | ControlEffect::AbortFailedRun { run_id, .. } => {
                self.gates
                    .emergency_stop(run_id)
                    .map_err(definitely_not_applied)?;
                self.stop_workers(committed).await
            }
        }
    }
}

impl<P> ProductionControlEffectExecutor<P>
where
    P: ProcessTreeTerminator + Clone,
{
    async fn stop_workers(
        &self,
        committed: &CommittedControlEffect,
    ) -> Result<(), EffectExecutionError> {
        let receipts = LifecycleController::new(
            self.registry.clone(),
            self.process_terminator.clone(),
            self.cooperative_grace,
        )
        .apply(committed)
        .await
        .map_err(|error| EffectExecutionError::new(error.to_string()))?;
        if receipts.iter().all(|receipt| receipt.confirmed_stopped) {
            Ok(())
        } else {
            Err(EffectExecutionError::new(
                "one or more CodePro workers could not be confirmed stopped",
            ))
        }
    }
}

fn definitely_not_applied(error: impl std::fmt::Display) -> EffectExecutionError {
    EffectExecutionError::definitely_not_applied(error.to_string())
}
