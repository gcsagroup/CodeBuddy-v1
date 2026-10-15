use super::{CommandReceipt, EffectOutbox, RunClock, RunEngine, RunEngineError, RunEventStore};
use crate::agents::protocol::{ControlCommand, CoordinatorDecisionPoint, WorkerOutcome};
use crate::agents::workers::{OutcomeSuppression, RegistryError, WorkerHandle, WorkerRegistry};
use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutcomeRuntimeSync {
    Synchronized,
    RequiresRecovery(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutcomeSubmission {
    Suppressed(OutcomeSuppression),
    Committed {
        receipt: Box<CommandReceipt>,
        runtime_sync: OutcomeRuntimeSync,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoordinatorHookStatus {
    NotRequired,
    Observed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatedOutcomeSubmission {
    pub submission: OutcomeSubmission,
    pub coordinator: CoordinatorHookStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("coordinator decision hook failed: {message}")]
pub struct CoordinatorHookError {
    pub message: String,
}

impl CoordinatorHookError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait CoordinatorDecisionHook: Send + Sync {
    async fn observe(
        &self,
        point: CoordinatorDecisionPoint,
        receipt: &CommandReceipt,
    ) -> Result<(), CoordinatorHookError>;
}

#[derive(Debug, thiserror::Error)]
pub enum OutcomeIngressError {
    #[error("run event stream does not exist: {0}")]
    MissingRun(String),
    #[error("outcome command failed before commit: {0}")]
    Engine(#[source] RunEngineError),
    #[error("outcome command failed and its runtime claim could not be released: engine={engine}; registry={registry}")]
    ClaimRelease {
        engine: String,
        #[source]
        registry: RegistryError,
    },
}

pub struct OutcomeIngress<'a, S, C, O> {
    engine: &'a RunEngine<S, C, O>,
    registry: &'a WorkerRegistry,
}

impl<'a, S, C, O> OutcomeIngress<'a, S, C, O>
where
    S: RunEventStore,
    C: RunClock,
    O: EffectOutbox,
{
    pub fn new(engine: &'a RunEngine<S, C, O>, registry: &'a WorkerRegistry) -> Self {
        Self { engine, registry }
    }

    pub async fn submit(
        &self,
        handle: &WorkerHandle,
        outcome: WorkerOutcome,
    ) -> Result<OutcomeSubmission, OutcomeIngressError> {
        let Some(task_id) = handle.task_id().cloned() else {
            return Ok(OutcomeSubmission::Suppressed(
                OutcomeSuppression::UnknownWorker,
            ));
        };
        let projection = self
            .engine
            .load_projection(handle.run_id())
            .await?
            .ok_or_else(|| OutcomeIngressError::MissingRun(handle.run_id().to_string()))?;
        let claim = match self.registry.claim_outcome(handle, &projection) {
            Ok(claim) => claim,
            Err(reason) => return Ok(OutcomeSubmission::Suppressed(reason)),
        };
        let keeps_worker_alive = matches!(outcome, WorkerOutcome::NeedsHelp(_));
        let command = ControlCommand::SubmitTaskOutcome {
            run_id: handle.run_id().clone(),
            task_id,
            agent_id: Some(handle.agent_id().clone()),
            outcome,
        };

        let receipt = match self.engine.apply(command).await {
            Ok(receipt) => receipt,
            Err(engine) => {
                if let Err(registry) = self.registry.release_outcome(claim) {
                    return Err(OutcomeIngressError::ClaimRelease {
                        engine: engine.to_string(),
                        registry,
                    });
                }
                return Err(OutcomeIngressError::Engine(engine));
            }
        };

        let runtime_result = if keeps_worker_alive {
            self.registry.release_outcome(claim)
        } else {
            self.registry.finalize_outcome(claim)
        };
        let runtime_sync = match runtime_result {
            Ok(()) => OutcomeRuntimeSync::Synchronized,
            Err(error) => OutcomeRuntimeSync::RequiresRecovery(error.to_string()),
        };
        Ok(OutcomeSubmission::Committed {
            receipt: Box::new(receipt),
            runtime_sync,
        })
    }

    pub async fn submit_with_coordinator<H: CoordinatorDecisionHook>(
        &self,
        handle: &WorkerHandle,
        outcome: WorkerOutcome,
        hook: &H,
    ) -> Result<CoordinatedOutcomeSubmission, OutcomeIngressError> {
        let decision_point = semantic_decision_point(&outcome);
        let submission = self.submit(handle, outcome).await?;
        let coordinator = match (&submission, decision_point) {
            (OutcomeSubmission::Committed { receipt, .. }, Some(point)) => {
                match hook.observe(point, receipt).await {
                    Ok(()) => CoordinatorHookStatus::Observed,
                    Err(_) => CoordinatorHookStatus::Failed,
                }
            }
            _ => CoordinatorHookStatus::NotRequired,
        };
        Ok(CoordinatedOutcomeSubmission {
            submission,
            coordinator,
        })
    }
}

fn semantic_decision_point(outcome: &WorkerOutcome) -> Option<CoordinatorDecisionPoint> {
    match outcome {
        WorkerOutcome::Succeeded(_) | WorkerOutcome::Skipped(_) => {
            Some(CoordinatorDecisionPoint::CompletionCheck)
        }
        WorkerOutcome::VerificationFailed(_) | WorkerOutcome::RepairExhausted(_) => {
            Some(CoordinatorDecisionPoint::WorkerFailed)
        }
        WorkerOutcome::RepairPending(_) | WorkerOutcome::WaitingForUser(_) => {
            Some(CoordinatorDecisionPoint::TaskPaused)
        }
        WorkerOutcome::Failed(_) => Some(CoordinatorDecisionPoint::WorkerFailed),
        WorkerOutcome::Blocked(_) => Some(CoordinatorDecisionPoint::WorkerBlocked),
        WorkerOutcome::NeedsHelp(_) => Some(CoordinatorDecisionPoint::WorkerNeedsHelp),
        WorkerOutcome::Paused(_) => Some(CoordinatorDecisionPoint::TaskPaused),
        WorkerOutcome::Cancelled(_) => None,
    }
}

impl From<RunEngineError> for OutcomeIngressError {
    fn from(value: RunEngineError) -> Self {
        Self::Engine(value)
    }
}
