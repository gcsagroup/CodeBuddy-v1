use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{EventStoreError, FileRunEventStore, RunEventStore};
use goose::agents::protocol::{EventId, ProtocolVersion, RunEvent, RunEventPayload, RunId};
use std::fs;

fn run_started(run_id: &RunId, event_id: &str, sequence: u64) -> RunEvent {
    let event_id = EventId::new(event_id).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: None,
        agent_id: None,
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc.with_ymd_and_hms(2026, 8, 5, 2, 0, 0).unwrap(),
        payload: RunEventPayload::RunStarted {
            goal: "persist a versioned event".to_string(),
        },
        evidence_refs: vec![],
    }
}

fn run_cancelled(run_id: &RunId, event_id: &str, sequence: u64) -> RunEvent {
    let event_id = EventId::new(event_id).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: None,
        agent_id: None,
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc.with_ymd_and_hms(2026, 8, 5, 2, 0, 1).unwrap(),
        payload: RunEventPayload::RunCancelled {
            reason: "capacity safety stop".to_string(),
        },
        evidence_refs: vec![],
    }
}

#[tokio::test]
async fn append_and_load_roundtrip_uses_optimistic_sequence() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-store-1").unwrap();
    let event = run_started(&run_id, "event-1", 1);

    let receipt = store
        .append(&run_id, 0, std::slice::from_ref(&event))
        .await
        .unwrap();

    assert_eq!(receipt.previous_sequence, 0);
    assert_eq!(receipt.last_sequence, 1);
    assert_eq!(receipt.appended, 1);
    assert_eq!(store.load(&run_id).await.unwrap(), vec![event]);
}

#[tokio::test]
async fn append_rejects_stale_expected_sequence_without_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-store-2").unwrap();
    let first = run_started(&run_id, "event-1", 1);
    store
        .append(&run_id, 0, std::slice::from_ref(&first))
        .await
        .unwrap();

    let error = store
        .append(&run_id, 0, &[run_started(&run_id, "event-2", 1)])
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        EventStoreError::SequenceConflict {
            expected: 0,
            actual: 1
        }
    ));
    assert_eq!(store.load(&run_id).await.unwrap(), vec![first]);
}

#[tokio::test]
async fn append_rejects_cross_run_batches() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-store-3").unwrap();
    let foreign = RunId::new("run-foreign").unwrap();

    let error = store
        .append(&run_id, 0, &[run_started(&foreign, "event-1", 1)])
        .await
        .unwrap_err();

    assert!(matches!(error, EventStoreError::RunMismatch { .. }));
    assert!(store.load(&run_id).await.unwrap().is_empty());
}

#[tokio::test]
async fn append_rejects_sequence_gaps() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-store-4").unwrap();

    let error = store
        .append(&run_id, 0, &[run_started(&run_id, "event-1", 2)])
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        EventStoreError::InvalidSequence {
            expected: 1,
            actual: 2
        }
    ));
}

#[tokio::test]
async fn append_rejects_duplicate_event_ids() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-store-5").unwrap();
    let events = [
        run_started(&run_id, "event-duplicate", 1),
        run_started(&run_id, "event-duplicate", 2),
    ];

    let error = store.append(&run_id, 0, &events).await.unwrap_err();

    assert!(matches!(error, EventStoreError::DuplicateEventId(_)));
    assert!(store.load(&run_id).await.unwrap().is_empty());
}

#[tokio::test]
async fn append_rejects_empty_batches() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-store-6").unwrap();

    let error = store.append(&run_id, 0, &[]).await.unwrap_err();

    assert!(matches!(error, EventStoreError::EmptyBatch));
}

#[tokio::test]
async fn production_limits_bound_event_count_and_encoded_bytes_without_partial_append() {
    let temp = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-store-capacity").unwrap();
    let count_limited = FileRunEventStore::with_limits(temp.path(), 1024 * 1024, 1);
    count_limited
        .append(&run_id, 0, &[run_started(&run_id, "event-1", 1)])
        .await
        .unwrap();

    let count_error = count_limited
        .append(&run_id, 1, &[run_started(&run_id, "event-2", 2)])
        .await
        .unwrap_err();
    assert!(matches!(
        count_error,
        EventStoreError::RecordCapacity { limit: 1 }
    ));
    assert_eq!(count_limited.load(&run_id).await.unwrap().len(), 1);

    let byte_run = RunId::new("run-store-byte-capacity").unwrap();
    let byte_limited = FileRunEventStore::with_limits(temp.path(), 16, 100);
    let byte_error = byte_limited
        .append(&byte_run, 0, &[run_started(&byte_run, "event-byte-1", 1)])
        .await
        .unwrap_err();
    assert!(matches!(
        byte_error,
        EventStoreError::ByteCapacity { limit: 16 }
    ));
    assert_eq!(
        fs::metadata(byte_limited.event_log_path(&byte_run))
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn terminal_reserve_keeps_cancellation_writable_after_normal_capacity_is_exhausted() {
    let temp = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-store-terminal-reserve").unwrap();
    let store =
        FileRunEventStore::with_limits_and_terminal_reserve(temp.path(), 1024 * 1024, 2, 0, 1);
    store
        .append(&run_id, 0, &[run_started(&run_id, "event-1", 1)])
        .await
        .unwrap();

    let normal_error = store
        .append(&run_id, 1, &[run_started(&run_id, "event-2", 2)])
        .await
        .unwrap_err();
    assert!(matches!(
        normal_error,
        EventStoreError::RecordCapacity { limit: 1 }
    ));

    store
        .append(&run_id, 1, &[run_cancelled(&run_id, "event-stop", 2)])
        .await
        .unwrap();
    assert!(matches!(
        store
            .load(&run_id)
            .await
            .unwrap()
            .last()
            .map(|event| &event.payload),
        Some(RunEventPayload::RunCancelled { .. })
    ));

    let byte_run = RunId::new("run-store-terminal-byte-reserve").unwrap();
    let first = run_started(&byte_run, "event-byte-1", 1);
    let terminal = run_cancelled(&byte_run, "event-byte-stop", 2);
    let first_bytes = serde_json::to_vec(&first).unwrap().len() as u64 + 1;
    let terminal_bytes = serde_json::to_vec(&terminal).unwrap().len() as u64 + 1;
    let byte_store = FileRunEventStore::with_limits_and_terminal_reserve(
        temp.path(),
        first_bytes + terminal_bytes,
        10,
        terminal_bytes,
        0,
    );
    byte_store.append(&byte_run, 0, &[first]).await.unwrap();

    let normal_byte_error = byte_store
        .append(&byte_run, 1, &[run_started(&byte_run, "event-byte-2", 2)])
        .await
        .unwrap_err();
    assert!(matches!(
        normal_byte_error,
        EventStoreError::ByteCapacity { limit } if limit == first_bytes
    ));

    byte_store.append(&byte_run, 1, &[terminal]).await.unwrap();
    assert_eq!(byte_store.load(&byte_run).await.unwrap().len(), 2);
}

fn write_raw(store: &FileRunEventStore, run_id: &RunId, bytes: &[u8]) {
    let path = store.event_log_path(run_id);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[tokio::test]
async fn strict_load_rejects_an_incomplete_final_json_record() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-tail-1").unwrap();
    write_raw(&store, &run_id, br#"{"protocol_version":1"#);

    assert!(matches!(
        store.load(&run_id).await.unwrap_err(),
        EventStoreError::IncompleteTail
    ));
}

#[tokio::test]
async fn strict_load_rejects_malformed_committed_json() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-tail-2").unwrap();
    write_raw(&store, &run_id, b"not-json\n");

    assert!(matches!(
        store.load(&run_id).await.unwrap_err(),
        EventStoreError::CorruptLog { line: 1, .. }
    ));
}

#[tokio::test]
async fn strict_load_rejects_unknown_protocol_versions() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-tail-3").unwrap();
    let json = serde_json::to_string(&run_started(&run_id, "event-1", 1))
        .unwrap()
        .replace("\"protocol_version\":1", "\"protocol_version\":99");
    write_raw(&store, &run_id, format!("{json}\n").as_bytes());

    assert!(matches!(
        store.load(&run_id).await.unwrap_err(),
        EventStoreError::CorruptLog { line: 1, .. }
    ));
}

#[tokio::test]
async fn strict_load_rejects_wrong_run_and_duplicate_identity() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-tail-4").unwrap();
    let foreign = RunId::new("run-tail-foreign").unwrap();
    let wrong_run = serde_json::to_string(&run_started(&foreign, "event-1", 1)).unwrap();
    write_raw(&store, &run_id, format!("{wrong_run}\n").as_bytes());
    assert!(matches!(
        store.load(&run_id).await.unwrap_err(),
        EventStoreError::RunMismatch { .. }
    ));

    let first = serde_json::to_string(&run_started(&run_id, "event-1", 1)).unwrap();
    let duplicate_sequence = serde_json::to_string(&run_started(&run_id, "event-2", 1)).unwrap();
    write_raw(
        &store,
        &run_id,
        format!("{first}\n{duplicate_sequence}\n").as_bytes(),
    );
    assert!(matches!(
        store.load(&run_id).await.unwrap_err(),
        EventStoreError::CorruptLog { line: 2, .. }
    ));

    let duplicate_id = serde_json::to_string(&run_started(&run_id, "event-1", 2)).unwrap();
    write_raw(
        &store,
        &run_id,
        format!("{first}\n{duplicate_id}\n").as_bytes(),
    );
    assert!(matches!(
        store.load(&run_id).await.unwrap_err(),
        EventStoreError::CorruptLog { line: 2, .. }
    ));
}

#[tokio::test]
async fn strict_load_rejects_a_valid_record_without_commit_newline() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-tail-5").unwrap();
    let json = serde_json::to_vec(&run_started(&run_id, "event-1", 1)).unwrap();
    write_raw(&store, &run_id, &json);

    assert!(matches!(
        store.load(&run_id).await.unwrap_err(),
        EventStoreError::IncompleteTail
    ));
}

#[tokio::test]
async fn explicit_recovery_truncates_only_the_incomplete_tail_and_allows_append() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-tail-6").unwrap();
    let first = serde_json::to_string(&run_started(&run_id, "event-1", 1)).unwrap();
    write_raw(
        &store,
        &run_id,
        format!("{first}\n{{\"protocol_version\":1").as_bytes(),
    );

    let report = store.recover_incomplete_tail(&run_id).await.unwrap();

    assert!(report.truncated_bytes > 0);
    assert_eq!(report.last_sequence, 1);
    assert_eq!(
        store.load(&run_id).await.unwrap(),
        vec![run_started(&run_id, "event-1", 1)]
    );
    store
        .append(&run_id, 1, &[run_started(&run_id, "event-2", 2)])
        .await
        .unwrap();
    assert_eq!(store.load(&run_id).await.unwrap().len(), 2);
}

#[tokio::test]
async fn recovery_refuses_to_hide_malformed_committed_records() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(temp.path());
    let run_id = RunId::new("run-tail-7").unwrap();
    write_raw(&store, &run_id, b"not-json\npartial");

    assert!(matches!(
        store.recover_incomplete_tail(&run_id).await.unwrap_err(),
        EventStoreError::CorruptLog { line: 1, .. }
    ));
    assert_eq!(
        fs::read(store.event_log_path(&run_id)).unwrap(),
        b"not-json\npartial"
    );
}
