use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{
    archive_legacy_runs, LegacyArchiveDisposition, LegacyArchiveError, LegacyArchiveWarning,
    LEGACY_ARCHIVE_DIRECTORY_NAME, LEGACY_ARCHIVE_MANIFEST_FILE_NAME,
};
use goose::agents::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, AgentRole, CodeProEventRecord,
    CodeProRunState, CodeProRunStatus, ModelRouterConfig, TaskDAG, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn record(sequence: u64, event_id: &str) -> CodeProEventRecord {
    let activity = ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: event_id.to_string(),
        event_type: ActivityEventKind::FileRead,
        session_id: "session-1".to_string(),
        run_id: "run-1".to_string(),
        task_id: Some("task-1".to_string()),
        parent_task_id: None,
        agent_role: Some(AgentRole::Coder),
        effective_model: Some("openai/gpt-5".to_string()),
        status: ActivityEventStatus::Completed,
        started_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 8, 0, sequence as u32)
            .unwrap(),
        finished_at: None,
        title: format!("legacy event {sequence}"),
        technical_details: None,
        path: Some(PathBuf::from("src/lib.rs")),
        command_summary: None,
        exit_code: None,
        diff_summary: None,
        failure_kind: None,
        risk_tier: None,
        previous_risk_tier: None,
        risk_reasons: Vec::new(),
        selected_roles: Vec::new(),
        review_required: None,
        routing_evidence: None,
        include_in_model_context: false,
        retryable: false,
        retry_from_event_id: None,
    };
    CodeProEventRecord::from_activity_event(sequence, activity, None)
}

fn legacy_run_dir(root: &Path) -> PathBuf {
    root.join("run-1").join("run")
}

fn write_state(root: &Path) {
    let run_dir = legacy_run_dir(root);
    fs::create_dir_all(&run_dir).unwrap();
    let now = Utc.with_ymd_and_hms(2026, 8, 5, 7, 0, 0).unwrap();
    let state = CodeProRunState {
        run_id: "run-1".to_string(),
        goal: "preserve a legacy run".to_string(),
        source_repo: PathBuf::from(r"D:\legacy-project"),
        worktree_path: PathBuf::from(r"D:\legacy-project"),
        workspace: None,
        status: CodeProRunStatus::Completed,
        pause_reason: None,
        workflow: None,
        last_active_run_id: Some("durable-run-1".to_string()),
        dag: TaskDAG::new("preserve a legacy run", vec![]),
        router_config: ModelRouterConfig::default(),
        reviewer_action_budget: None,
        review_result: None,
        final_report: Some("legacy report".to_string()),
        created_at: now,
        updated_at: now,
    };
    fs::write(
        run_dir.join("state.json"),
        serde_json::to_vec_pretty(&state).unwrap(),
    )
    .unwrap();
}

fn append_record(path: &Path, value: &CodeProEventRecord) {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    serde_json::to_writer(&mut file, value).unwrap();
    file.write_all(b"\n").unwrap();
}

#[test]
fn valid_legacy_history_is_archived_once_without_becoming_authoritative() {
    let temp = tempfile::tempdir().unwrap();
    let legacy_root = temp.path().join("legacy");
    let control_root = temp.path().join("control");
    write_state(&legacy_root);
    let source_events = legacy_run_dir(&legacy_root).join("events.jsonl");
    append_record(&source_events, &record(1, "legacy-event-1"));
    append_record(&source_events, &record(2, "legacy-event-2"));
    let source_before = fs::read(&source_events).unwrap();

    let first = archive_legacy_runs(&legacy_root, &control_root).unwrap();
    assert_eq!(first.imports.len(), 1);
    assert!(!first.imports[0].already_imported);
    let manifest = &first.imports[0].manifest;
    assert_eq!(manifest.disposition, LegacyArchiveDisposition::Imported);
    assert_eq!(manifest.event_count, 2);
    assert_eq!(manifest.mappings.len(), 2);
    assert!(manifest.warnings.is_empty());
    assert!(!control_root.join("run-1").join("events.v1.jsonl").exists());

    let archive_dir = control_root
        .join(LEGACY_ARCHIVE_DIRECTORY_NAME)
        .join("run-1");
    let manifest_path = archive_dir.join(LEGACY_ARCHIVE_MANIFEST_FILE_NAME);
    let archived_events = archive_dir.join(manifest.archived_events_file.as_ref().unwrap());
    assert!(archived_events.is_file());
    let manifest_before = fs::read(&manifest_path).unwrap();
    assert_eq!(fs::read(&source_events).unwrap(), source_before);

    append_record(&source_events, &record(3, "legacy-event-3"));
    let second = archive_legacy_runs(&legacy_root, &control_root).unwrap();
    assert!(second.imports[0].already_imported);
    assert_eq!(fs::read(&manifest_path).unwrap(), manifest_before);
    assert_eq!(second.imports[0].manifest.event_count, 2);
    assert_eq!(
        fs::read_to_string(&source_events).unwrap().lines().count(),
        3
    );

    fs::OpenOptions::new()
        .append(true)
        .open(&archived_events)
        .unwrap()
        .write_all(b"tampered\n")
        .unwrap();
    assert!(matches!(
        archive_legacy_runs(&legacy_root, &control_root).unwrap_err(),
        LegacyArchiveError::InvalidManifest { .. }
    ));
}

#[test]
fn incomplete_legacy_history_is_preserved_with_a_read_only_warning() {
    let temp = tempfile::tempdir().unwrap();
    let legacy_root = temp.path().join("legacy");
    let control_root = temp.path().join("control");
    write_state(&legacy_root);
    let source_events = legacy_run_dir(&legacy_root).join("events.jsonl");
    append_record(&source_events, &record(1, "legacy-event-1"));
    fs::OpenOptions::new()
        .append(true)
        .open(&source_events)
        .unwrap()
        .write_all(br#"{"schema_version":1"#)
        .unwrap();
    let source_before = fs::read(&source_events).unwrap();

    let report = archive_legacy_runs(&legacy_root, &control_root).unwrap();
    let manifest = &report.imports[0].manifest;
    assert_eq!(manifest.disposition, LegacyArchiveDisposition::ReadOnly);
    assert_eq!(manifest.event_count, 0);
    assert!(manifest.archived_events_file.is_none());
    assert!(manifest.mappings.is_empty());
    assert!(matches!(
        manifest.warnings.as_slice(),
        [LegacyArchiveWarning::IncompleteEventLog]
    ));
    assert_eq!(fs::read(&source_events).unwrap(), source_before);
    assert!(!control_root.join("run-1").join("events.v1.jsonl").exists());
}

#[test]
fn missing_state_keeps_valid_events_as_a_non_authoritative_read_only_archive() {
    let temp = tempfile::tempdir().unwrap();
    let legacy_root = temp.path().join("legacy");
    let control_root = temp.path().join("control");
    let run_dir = legacy_run_dir(&legacy_root);
    fs::create_dir_all(&run_dir).unwrap();
    append_record(&run_dir.join("events.jsonl"), &record(1, "legacy-event-1"));

    let report = archive_legacy_runs(&legacy_root, &control_root).unwrap();
    let manifest = &report.imports[0].manifest;
    assert_eq!(manifest.disposition, LegacyArchiveDisposition::ReadOnly);
    assert_eq!(manifest.event_count, 1);
    assert!(manifest.archived_events_file.is_some());
    assert!(matches!(
        manifest.warnings.as_slice(),
        [LegacyArchiveWarning::MissingState]
    ));
}
