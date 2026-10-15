use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{migrate_legacy_records, MigrationError, MigrationWarning};
use goose::agents::protocol::RunEventPayload;
use goose::agents::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, AgentRole, CodeProEventRecord,
    ACTIVITY_EVENT_SCHEMA_VERSION,
};
use std::path::PathBuf;

fn record(
    sequence: u64,
    event_id: &str,
    event_type: ActivityEventKind,
    status: ActivityEventStatus,
) -> CodeProEventRecord {
    let artifact_ref = Some(PathBuf::from(format!("artifacts/event-{sequence}.txt")));
    let activity = ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: event_id.to_string(),
        event_type,
        session_id: "session-1".to_string(),
        run_id: "run-1".to_string(),
        task_id: Some("task-1".to_string()),
        parent_task_id: Some("task-parent".to_string()),
        agent_role: Some(AgentRole::Coder),
        effective_model: Some("openai/gpt-5".to_string()),
        status,
        started_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 4, 0, sequence as u32)
            .unwrap(),
        finished_at: Some(
            Utc.with_ymd_and_hms(2026, 8, 5, 4, 1, sequence as u32)
                .unwrap(),
        ),
        title: format!("legacy event {sequence}"),
        technical_details: Some(format!("detail {sequence}")),
        path: Some(PathBuf::from("src/lib.rs")),
        command_summary: Some("cargo test".to_string()),
        exit_code: Some(0),
        diff_summary: Some("1 file changed".to_string()),
        failure_kind: None,
        risk_tier: None,
        previous_risk_tier: None,
        risk_reasons: Vec::new(),
        selected_roles: Vec::new(),
        review_required: None,
        routing_evidence: None,
        include_in_model_context: true,
        retryable: false,
        retry_from_event_id: None,
    };
    CodeProEventRecord::from_activity_event(sequence, activity, artifact_ref)
}

#[test]
fn legacy_record_activity_conversion_preserves_every_representable_field() {
    let original = record(
        7,
        "event-7",
        ActivityEventKind::CommandCompleted,
        ActivityEventStatus::Completed,
    );

    let activity = original.to_activity_event();
    let roundtrip = CodeProEventRecord::from_activity_event(
        original.sequence,
        activity,
        original.artifact_ref.clone(),
    );

    assert_eq!(roundtrip, original);
}

#[test]
fn duplicate_legacy_ids_are_rewritten_deterministically_with_shared_correlation() {
    let records = vec![
        record(
            1,
            "tool-lifecycle-1",
            ActivityEventKind::ToolStarted,
            ActivityEventStatus::Running,
        ),
        record(
            2,
            "tool-lifecycle-1",
            ActivityEventKind::ToolCompleted,
            ActivityEventStatus::Completed,
        ),
    ];

    let first = migrate_legacy_records(&records).unwrap();
    let second = migrate_legacy_records(&records).unwrap();

    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert_eq!(first.events.len(), 2);
    assert_ne!(first.events[0].event_id, first.events[1].event_id);
    assert_eq!(first.events[0].correlation_id.as_str(), "tool-lifecycle-1");
    assert_eq!(first.events[1].correlation_id.as_str(), "tool-lifecycle-1");
    assert_eq!(first.mappings.len(), 2);
    assert_eq!(first.mappings[0].legacy_sequence, 1);
    assert_eq!(first.mappings[1].legacy_sequence, 2);
    assert_eq!(first.mappings[1].event_id, first.events[1].event_id);
    assert!(matches!(
        first.warnings.as_slice(),
        [MigrationWarning::DuplicateEventIdRewritten {
            legacy_sequence: 2,
            legacy_event_id,
            ..
        }] if legacy_event_id == "tool-lifecycle-1"
    ));
    assert!(first.events.iter().all(|event| event.agent_id.is_none()));
}

#[test]
fn migration_preserves_sequence_time_and_task_scope_without_promoting_observations() {
    let legacy = record(
        1,
        "file-read-1",
        ActivityEventKind::FileRead,
        ActivityEventStatus::Completed,
    );

    let migrated = migrate_legacy_records(std::slice::from_ref(&legacy)).unwrap();
    let event = &migrated.events[0];

    assert_eq!(event.sequence, legacy.sequence);
    assert_eq!(event.occurred_at, legacy.started_at);
    assert_eq!(event.run_id.as_str(), legacy.run_id);
    assert_eq!(event.task_id.as_ref().unwrap().as_str(), "task-1");
    assert!(event.agent_id.is_none());
    assert!(matches!(
        event.payload,
        RunEventPayload::LegacyActivityObserved { ref kind, .. } if kind == "file_read"
    ));
}

#[test]
fn committed_evidence_is_not_promoted_to_a_task_outcome_during_migration() {
    let legacy = record(
        1,
        "evidence-1",
        ActivityEventKind::EvidenceCommitted,
        ActivityEventStatus::Completed,
    );

    let migrated = migrate_legacy_records(&[legacy]).unwrap();

    assert!(matches!(
        migrated.events[0].payload,
        RunEventPayload::LegacyActivityObserved { ref kind, .. } if kind == "evidence_committed"
    ));
}

#[test]
fn legacy_task_completed_evidence_artifact_is_demoted_during_migration() {
    let mut legacy = record(
        1,
        "legacy-evidence-1",
        ActivityEventKind::TaskCompleted,
        ActivityEventStatus::Completed,
    );
    legacy.artifact_ref = Some(PathBuf::from(
        "artifacts/legacy-evidence-1.task-evidence.txt",
    ));

    let migrated = migrate_legacy_records(&[legacy]).unwrap();

    assert!(matches!(
        migrated.events[0].payload,
        RunEventPayload::LegacyActivityObserved { ref kind, .. } if kind == "evidence_committed"
    ));
    assert!(matches!(
        migrated.warnings.as_slice(),
        [MigrationWarning::LegacyTaskEvidenceDemoted {
            legacy_sequence: 1,
            legacy_event_id,
        }] if legacy_event_id == "legacy-evidence-1"
    ));
}

#[test]
fn migration_rejects_future_versions_mixed_runs_and_sequence_gaps() {
    let mut future = record(
        1,
        "event-1",
        ActivityEventKind::FileRead,
        ActivityEventStatus::Completed,
    );
    future.schema_version = ACTIVITY_EVENT_SCHEMA_VERSION + 1;
    assert!(matches!(
        migrate_legacy_records(&[future]).unwrap_err(),
        MigrationError::UnsupportedLegacyVersion { sequence: 1, .. }
    ));

    let first = record(
        1,
        "event-1",
        ActivityEventKind::FileRead,
        ActivityEventStatus::Completed,
    );
    let mut foreign = record(
        2,
        "event-2",
        ActivityEventKind::FileChanged,
        ActivityEventStatus::Completed,
    );
    foreign.run_id = "run-2".to_string();
    assert!(matches!(
        migrate_legacy_records(&[first.clone(), foreign]).unwrap_err(),
        MigrationError::MixedRuns { sequence: 2, .. }
    ));

    let mut gap = record(
        2,
        "event-2",
        ActivityEventKind::FileChanged,
        ActivityEventStatus::Completed,
    );
    gap.sequence = 3;
    assert!(matches!(
        migrate_legacy_records(&[first, gap]).unwrap_err(),
        MigrationError::SequenceGap {
            expected: 2,
            actual: 3
        }
    ));
}

#[test]
fn checked_in_legacy_fixtures_migrate_deterministically_and_block_future_versions() {
    let records: Vec<CodeProEventRecord> =
        serde_json::from_str(include_str!("fixtures/protocol/legacy/records_v1.json")).unwrap();
    let first = migrate_legacy_records(&records).unwrap();
    let second = migrate_legacy_records(&records).unwrap();

    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert_eq!(first.events.len(), records.len());
    assert_eq!(first.mappings.len(), records.len());
    assert_eq!(first.warnings.len(), 1);

    let future: Vec<CodeProEventRecord> = serde_json::from_str(include_str!(
        "fixtures/protocol/legacy/records_future_v2.json"
    ))
    .unwrap();
    assert!(matches!(
        migrate_legacy_records(&future).unwrap_err(),
        MigrationError::UnsupportedLegacyVersion {
            sequence: 1,
            version: 2,
            ..
        }
    ));
}
