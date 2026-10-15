use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use goose::agents::control_plane::{
    ControlEffectExecutor, DispatchReceipt, EffectDispatcher, EffectExecutionError, EffectLedger,
    FileRunEventStore, InMemoryEffectLedger, RunClock, RunEngine,
};
use goose::agents::protocol::{ControlCommand, RunId};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl RunClock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[derive(Clone, Default)]
struct RecordingExecutor {
    effect_ids: Arc<Mutex<Vec<String>>>,
    failures_remaining: Arc<Mutex<usize>>,
}

impl RecordingExecutor {
    fn fail_once_definitely_not_applied() -> Self {
        Self {
            effect_ids: Arc::default(),
            failures_remaining: Arc::new(Mutex::new(1)),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.effect_ids.lock().unwrap().clone()
    }
}

#[async_trait]
impl ControlEffectExecutor for RecordingExecutor {
    async fn execute(
        &self,
        effect: &goose::agents::control_plane::CommittedControlEffect,
    ) -> Result<(), EffectExecutionError> {
        let mut failures = self.failures_remaining.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            return Err(EffectExecutionError::definitely_not_applied(
                "injected executor failure",
            ));
        }
        drop(failures);
        self.effect_ids.lock().unwrap().push(effect.ledger_key());
        Ok(())
    }
}

async fn committed_pause_receipt_for(
    run_name: &str,
) -> (
    tempfile::TempDir,
    goose::agents::control_plane::CommandReceipt,
) {
    let directory = tempfile::tempdir().unwrap();
    let run_id = RunId::new(run_name).unwrap();
    let engine = RunEngine::new(
        FileRunEventStore::new(directory.path()),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 1, 30, 0).unwrap()),
    );
    engine
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "dispatch only committed work".to_string(),
        })
        .await
        .unwrap();
    let receipt = engine
        .apply(ControlCommand::PauseRun {
            run_id,
            reason: "test committed dispatcher".to_string(),
        })
        .await
        .unwrap();
    (directory, receipt)
}

async fn committed_pause_receipt() -> (
    tempfile::TempDir,
    goose::agents::control_plane::CommandReceipt,
) {
    committed_pause_receipt_for("run-effect-dispatch").await
}

#[tokio::test]
async fn committed_effect_executes_once_and_replay_is_deduplicated() {
    let (_directory, receipt) = committed_pause_receipt().await;
    let executor = RecordingExecutor::default();
    let dispatcher = EffectDispatcher::new(executor.clone(), InMemoryEffectLedger::new());

    let first = dispatcher.dispatch(&receipt).await.unwrap();
    assert_eq!(
        first,
        DispatchReceipt {
            executed_effect_ids: vec!["run-effect-dispatch::effect:2:0".to_string()],
            deduplicated_effect_ids: vec![],
        }
    );
    let replay = dispatcher.dispatch(&receipt).await.unwrap();
    assert_eq!(
        replay,
        DispatchReceipt {
            executed_effect_ids: vec![],
            deduplicated_effect_ids: vec!["run-effect-dispatch::effect:2:0".to_string()],
        }
    );
    assert_eq!(executor.calls(), vec!["run-effect-dispatch::effect:2:0"]);
}

#[tokio::test]
async fn failed_effect_releases_claim_and_can_be_retried() {
    let (_directory, receipt) = committed_pause_receipt().await;
    let executor = RecordingExecutor::fail_once_definitely_not_applied();
    let dispatcher = EffectDispatcher::new(executor.clone(), InMemoryEffectLedger::new());

    assert!(dispatcher.dispatch(&receipt).await.is_err());
    let retry = dispatcher.dispatch(&receipt).await.unwrap();
    assert_eq!(
        retry.executed_effect_ids,
        vec!["run-effect-dispatch::effect:2:0"]
    );
    assert!(retry.deduplicated_effect_ids.is_empty());
    assert_eq!(executor.calls(), vec!["run-effect-dispatch::effect:2:0"]);
}

#[tokio::test]
async fn unknown_executor_outcome_becomes_uncertain_and_cannot_replay() {
    #[derive(Clone, Default)]
    struct UnknownOutcomeExecutor(Arc<Mutex<usize>>);

    #[async_trait]
    impl ControlEffectExecutor for UnknownOutcomeExecutor {
        async fn execute(
            &self,
            _effect: &goose::agents::control_plane::CommittedControlEffect,
        ) -> Result<(), EffectExecutionError> {
            *self.0.lock().unwrap() += 1;
            Err(EffectExecutionError::new("connection closed after send"))
        }
    }

    let (_directory, receipt) = committed_pause_receipt().await;
    let executor = UnknownOutcomeExecutor::default();
    let dispatcher = EffectDispatcher::new(executor.clone(), InMemoryEffectLedger::new());

    assert!(matches!(
        dispatcher.dispatch(&receipt).await,
        Err(goose::agents::control_plane::EffectDispatchError::Execution { .. })
    ));
    assert!(matches!(
        dispatcher.dispatch(&receipt).await,
        Err(goose::agents::control_plane::EffectDispatchError::Uncertain(id))
            if id == "run-effect-dispatch::effect:2:0"
    ));
    assert_eq!(*executor.0.lock().unwrap(), 1);
}

#[tokio::test]
async fn concurrent_dispatch_observes_in_flight_claim_without_duplicate_execution() {
    let (_directory, receipt) = committed_pause_receipt().await;
    let executor = RecordingExecutor::default();
    let ledger = InMemoryEffectLedger::new();
    assert_eq!(
        ledger.claim(&receipt.effects()[0]).unwrap(),
        goose::agents::control_plane::EffectClaimStatus::Claimed
    );
    let dispatcher = EffectDispatcher::new(executor.clone(), ledger);

    assert!(matches!(
        dispatcher.dispatch(&receipt).await,
        Err(goose::agents::control_plane::EffectDispatchError::InFlight(id))
            if id == "run-effect-dispatch::effect:2:0"
    ));
    assert!(executor.calls().is_empty());
}

#[tokio::test]
async fn effects_from_different_runs_never_collide_in_a_shared_ledger() {
    let (_first_directory, first) = committed_pause_receipt_for("run-effect-first").await;
    let (_second_directory, second) = committed_pause_receipt_for("run-effect-second").await;
    let executor = RecordingExecutor::default();
    let dispatcher = EffectDispatcher::new(executor.clone(), InMemoryEffectLedger::new());

    assert_eq!(
        dispatcher
            .dispatch(&first)
            .await
            .unwrap()
            .executed_effect_ids
            .len(),
        1
    );
    assert_eq!(
        dispatcher
            .dispatch(&second)
            .await
            .unwrap()
            .executed_effect_ids
            .len(),
        1
    );
    assert_eq!(executor.calls().len(), 2);
    assert_ne!(executor.calls()[0], executor.calls()[1]);
}
