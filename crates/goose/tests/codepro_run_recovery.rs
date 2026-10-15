use async_trait::async_trait;
use chrono::{DateTime, Utc};
use goose::agents::control_plane::{
    AppendReceipt, DurableEffectState, EffectLedger, EffectLedgerError, EffectOutbox,
    EventStoreError, FileEffectLedger, FileRunEventStore, RunClock, RunEngine, RunEventStore,
    RunRecovery, UncertainEffectResolution,
};
use goose::agents::protocol::{ControlCommand, RunEvent, RunId, RunState};

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl RunClock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

async fn start_run(root: &std::path::Path, run_id: &RunId) {
    RunEngine::new(FileRunEventStore::new(root), FixedClock(Utc::now()))
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "recover safely".to_string(),
        })
        .await
        .unwrap();
}

#[derive(Clone)]
struct FailCommitOutbox(FileEffectLedger);

impl EffectOutbox for FailCommitOutbox {
    fn prepare(
        &self,
        events: &[RunEvent],
        effects: &[goose::agents::control_plane::CommittedControlEffect],
    ) -> Result<(), EffectLedgerError> {
        self.0.prepare(events, effects)
    }

    fn commit_prepared(
        &self,
        _effects: &[goose::agents::control_plane::CommittedControlEffect],
    ) -> Result<(), EffectLedgerError> {
        Err(EffectLedgerError::Io {
            path: "injected".to_string(),
            message: "stop after event sync".to_string(),
        })
    }
}

#[tokio::test]
async fn committed_event_promotes_prepared_effect_to_pending_on_recovery() {
    let root = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-recover-committed").unwrap();
    start_run(root.path(), &run_id).await;
    let store = FileRunEventStore::new(root.path());
    let ledger = FileEffectLedger::new(root.path());
    let engine = RunEngine::with_effect_outbox(
        store.clone(),
        FixedClock(Utc::now()),
        FailCommitOutbox(ledger.clone()),
    );
    assert!(engine
        .apply(ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "crash window".to_string(),
        })
        .await
        .is_err());

    let mut mismatched_events = store.load(&run_id).await.unwrap();
    mismatched_events.last_mut().unwrap().occurred_at += chrono::Duration::seconds(1);
    assert!(ledger
        .reconcile_committed_events(&run_id, &mismatched_events)
        .is_err());

    let report = RunRecovery::new(store, ledger)
        .recover(&run_id)
        .await
        .unwrap();
    assert_eq!(report.pending.len(), 1);
    assert!(report.uncertain.is_empty());
    assert!(report.abandoned.is_empty());
    assert_eq!(report.projection.unwrap().state, RunState::Paused);
}

#[derive(Clone)]
struct FailAppendStore(FileRunEventStore);

#[async_trait]
impl RunEventStore for FailAppendStore {
    async fn append(
        &self,
        _run_id: &RunId,
        _expected_sequence: u64,
        _events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError> {
        Err(EventStoreError::BlockingTask(
            "stop before event sync".to_string(),
        ))
    }

    async fn load(&self, run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError> {
        self.0.load(run_id).await
    }
}

#[tokio::test]
async fn preparation_without_committed_trigger_is_abandoned_on_recovery() {
    let root = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-recover-abandoned").unwrap();
    start_run(root.path(), &run_id).await;
    let store = FileRunEventStore::new(root.path());
    let ledger = FileEffectLedger::new(root.path());
    let engine = RunEngine::with_effect_outbox(
        FailAppendStore(store.clone()),
        FixedClock(Utc::now()),
        ledger.clone(),
    );
    assert!(engine
        .apply(ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "never committed".to_string(),
        })
        .await
        .is_err());

    let report = RunRecovery::new(store, ledger)
        .recover(&run_id)
        .await
        .unwrap();
    assert_eq!(report.abandoned.len(), 1);
    assert!(report.pending.is_empty());
    assert_eq!(report.projection.unwrap().state, RunState::Planning);
}

#[tokio::test]
async fn interrupted_claim_becomes_uncertain_until_explicitly_resolved() {
    let root = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-recover-claim").unwrap();
    let store = FileRunEventStore::new(root.path());
    let ledger = FileEffectLedger::new(root.path());
    let engine =
        RunEngine::with_effect_outbox(store.clone(), FixedClock(Utc::now()), ledger.clone());
    engine
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "recover claim".to_string(),
        })
        .await
        .unwrap();
    let receipt = engine
        .apply(ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "claim then terminate".to_string(),
        })
        .await
        .unwrap();
    ledger.claim(&receipt.effects()[0]).unwrap();

    let report = RunRecovery::new(store, ledger.clone())
        .recover(&run_id)
        .await
        .unwrap();
    assert_eq!(
        report.uncertain_effect_ids(),
        vec![receipt.effects()[0].ledger_key()]
    );
    assert_eq!(report.uncertain[0].state, DurableEffectState::Uncertain);

    ledger
        .resolve_uncertain(
            &receipt.effects()[0],
            UncertainEffectResolution::ConfirmedNotApplied,
        )
        .unwrap();
    assert_eq!(
        ledger.snapshot(&run_id).unwrap()[0].state,
        DurableEffectState::Pending
    );
}
