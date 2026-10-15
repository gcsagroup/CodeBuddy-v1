use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use goose::agents::control_plane::{
    AppendReceipt, ControlEffect, ControlEffectExecutor, DurableEffectState, EffectClaimStatus,
    EffectDispatcher, EffectExecutionError, EffectLedger, EffectLedgerError, EffectOutbox,
    EventStoreError, FileEffectLedger, FileRunEventStore, RunClock, RunEngine, RunEventStore,
};
use goose::agents::protocol::{ControlCommand, RunEvent, RunId};
use std::io::Write;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl RunClock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

async fn pause_receipt(root: &std::path::Path) -> goose::agents::control_plane::CommandReceipt {
    let run_id = RunId::new("run-durable-effects").unwrap();
    let engine = RunEngine::new(
        FileRunEventStore::new(root),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 2, 0, 0).unwrap()),
    );
    engine
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "survive restart".to_string(),
        })
        .await
        .unwrap();
    engine
        .apply(ControlCommand::PauseRun {
            run_id,
            reason: "test".to_string(),
        })
        .await
        .unwrap()
}

#[test]
fn prepared_effect_is_not_dispatchable_until_event_commit_is_acknowledged() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let root = tempfile::tempdir().unwrap();
    let receipt = runtime.block_on(pause_receipt(root.path()));
    let ledger = FileEffectLedger::new(root.path());
    ledger
        .prepare(receipt.committed_events(), receipt.effects())
        .unwrap();

    assert!(ledger.claim(&receipt.effects()[0]).is_err());
    assert_eq!(
        ledger
            .snapshot(receipt.effects()[0].effect.run_id())
            .unwrap()[0]
            .state,
        DurableEffectState::Prepared
    );

    ledger.commit_prepared(receipt.effects()).unwrap();
    assert_eq!(
        ledger.claim(&receipt.effects()[0]).unwrap(),
        EffectClaimStatus::Claimed
    );
}

#[derive(Clone, Default)]
struct RecordingExecutor(Arc<Mutex<usize>>);

#[async_trait]
impl ControlEffectExecutor for RecordingExecutor {
    async fn execute(
        &self,
        _effect: &goose::agents::control_plane::CommittedControlEffect,
    ) -> Result<(), EffectExecutionError> {
        *self.0.lock().unwrap() += 1;
        Ok(())
    }
}

#[tokio::test]
async fn completed_effect_is_deduplicated_after_ledger_reopen() {
    let root = tempfile::tempdir().unwrap();
    let receipt = pause_receipt(root.path()).await;
    let ledger = FileEffectLedger::new(root.path());
    ledger
        .prepare(receipt.committed_events(), receipt.effects())
        .unwrap();
    ledger.commit_prepared(receipt.effects()).unwrap();
    let executor = RecordingExecutor::default();

    EffectDispatcher::new(executor.clone(), ledger)
        .dispatch(&receipt)
        .await
        .unwrap();
    let replay = EffectDispatcher::new(executor.clone(), FileEffectLedger::new(root.path()))
        .dispatch(&receipt)
        .await
        .unwrap();

    assert_eq!(*executor.0.lock().unwrap(), 1);
    assert_eq!(replay.deduplicated_effect_ids.len(), 1);
}

#[tokio::test]
async fn unknown_outcome_remains_uncertain_after_ledger_reopen() {
    #[derive(Clone)]
    struct UnknownExecutor;
    #[async_trait]
    impl ControlEffectExecutor for UnknownExecutor {
        async fn execute(
            &self,
            _effect: &goose::agents::control_plane::CommittedControlEffect,
        ) -> Result<(), EffectExecutionError> {
            Err(EffectExecutionError::new("ambiguous transport failure"))
        }
    }

    let root = tempfile::tempdir().unwrap();
    let receipt = pause_receipt(root.path()).await;
    let ledger = FileEffectLedger::new(root.path());
    ledger
        .prepare(receipt.committed_events(), receipt.effects())
        .unwrap();
    ledger.commit_prepared(receipt.effects()).unwrap();
    assert!(EffectDispatcher::new(UnknownExecutor, ledger)
        .dispatch(&receipt)
        .await
        .is_err());

    let reopened = FileEffectLedger::new(root.path());
    assert_eq!(
        reopened
            .snapshot(receipt.effects()[0].effect.run_id())
            .unwrap()[0]
            .state,
        DurableEffectState::Uncertain
    );
    assert_eq!(
        reopened.claim(&receipt.effects()[0]).unwrap(),
        EffectClaimStatus::Uncertain
    );
}

#[test]
fn incomplete_tail_is_rejected_then_repaired_without_losing_committed_records() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let root = tempfile::tempdir().unwrap();
    let receipt = runtime.block_on(pause_receipt(root.path()));
    let ledger = FileEffectLedger::new(root.path());
    ledger
        .prepare(receipt.committed_events(), receipt.effects())
        .unwrap();
    let path = ledger.journal_path(receipt.effects()[0].effect.run_id());
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(b"{\"schema_version\":1").unwrap();
    file.sync_data().unwrap();

    assert!(ledger
        .snapshot(receipt.effects()[0].effect.run_id())
        .is_err());
    let report = ledger
        .recover_incomplete_tail(receipt.effects()[0].effect.run_id())
        .unwrap();
    assert!(report.truncated_bytes > 0);
    assert_eq!(
        ledger
            .snapshot(receipt.effects()[0].effect.run_id())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn same_ledger_key_with_different_effect_identity_is_rejected() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let root = tempfile::tempdir().unwrap();
    let receipt = runtime.block_on(pause_receipt(root.path()));
    let ledger = FileEffectLedger::new(root.path());
    ledger
        .prepare(receipt.committed_events(), receipt.effects())
        .unwrap();

    let mut conflicting = receipt.effects()[0].clone();
    conflicting.effect = ControlEffect::RecoverRun {
        run_id: conflicting.effect.run_id().clone(),
    };
    assert!(ledger
        .prepare(receipt.committed_events(), &[conflicting])
        .is_err());
}

#[test]
fn concurrent_file_claims_have_one_winner() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let root = tempfile::tempdir().unwrap();
    let receipt = runtime.block_on(pause_receipt(root.path()));
    let ledger = FileEffectLedger::new(root.path());
    ledger
        .prepare(receipt.committed_events(), receipt.effects())
        .unwrap();
    ledger.commit_prepared(receipt.effects()).unwrap();
    let effect = receipt.effects()[0].clone();
    let first = ledger.clone();
    let second = ledger.clone();

    let left_effect = effect.clone();
    let left = std::thread::spawn(move || first.claim(&left_effect).unwrap());
    let right = std::thread::spawn(move || second.claim(&effect).unwrap());
    let outcomes = [left.join().unwrap(), right.join().unwrap()];

    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == EffectClaimStatus::Claimed)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| **outcome == EffectClaimStatus::InFlight)
            .count(),
        1
    );
}

#[tokio::test]
async fn run_engine_prepares_then_commits_effect_outbox() {
    let root = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-engine-outbox").unwrap();
    let store = FileRunEventStore::new(root.path());
    let ledger = FileEffectLedger::new(root.path());
    let engine = RunEngine::with_effect_outbox(
        store,
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 6, 2, 30, 0).unwrap()),
        ledger.clone(),
    );
    engine
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "durable outbox".to_string(),
        })
        .await
        .unwrap();
    engine
        .apply(ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "checkpoint".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(
        ledger.snapshot(&run_id).unwrap()[0].state,
        DurableEffectState::Pending
    );
}

#[derive(Clone)]
struct RejectingAppendStore(FileRunEventStore);

#[async_trait]
impl RunEventStore for RejectingAppendStore {
    async fn append(
        &self,
        _run_id: &RunId,
        _expected_sequence: u64,
        _events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError> {
        Err(EventStoreError::BlockingTask(
            "injected append crash".to_string(),
        ))
    }

    async fn load(&self, run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError> {
        self.0.load(run_id).await
    }
}

#[tokio::test]
async fn failed_event_append_leaves_prepared_effect_non_dispatchable() {
    let root = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-outbox-before-event").unwrap();
    let store = FileRunEventStore::new(root.path());
    RunEngine::new(store.clone(), FixedClock(Utc::now()))
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "crash before event".to_string(),
        })
        .await
        .unwrap();
    let ledger = FileEffectLedger::new(root.path());
    let engine = RunEngine::with_effect_outbox(
        RejectingAppendStore(store.clone()),
        FixedClock(Utc::now()),
        ledger.clone(),
    );

    assert!(engine
        .apply(ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "not committed".to_string(),
        })
        .await
        .is_err());
    assert_eq!(store.load(&run_id).await.unwrap().len(), 1);
    assert_eq!(
        ledger.snapshot(&run_id).unwrap()[0].state,
        DurableEffectState::Prepared
    );
}

#[derive(Clone)]
struct RejectingCommitOutbox(FileEffectLedger);

impl EffectOutbox for RejectingCommitOutbox {
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
            message: "crash after event commit".to_string(),
        })
    }
}

#[tokio::test]
async fn failed_outbox_commit_keeps_committed_event_and_prepared_effect() {
    let root = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-outbox-after-event").unwrap();
    let store = FileRunEventStore::new(root.path());
    RunEngine::new(store.clone(), FixedClock(Utc::now()))
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "crash after event".to_string(),
        })
        .await
        .unwrap();
    let ledger = FileEffectLedger::new(root.path());
    let engine = RunEngine::with_effect_outbox(
        store.clone(),
        FixedClock(Utc::now()),
        RejectingCommitOutbox(ledger.clone()),
    );

    assert!(engine
        .apply(ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "event committed".to_string(),
        })
        .await
        .is_err());
    assert_eq!(store.load(&run_id).await.unwrap().len(), 2);
    assert_eq!(
        ledger.snapshot(&run_id).unwrap()[0].state,
        DurableEffectState::Prepared
    );
}
