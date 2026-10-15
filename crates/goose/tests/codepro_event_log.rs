use chrono::{TimeZone, Utc};
use goose::agents::{
    read_codepro_event_records, ActivityEvent, ActivityEventKind, ActivityEventStatus,
    CodeProArtifactStore, CodeProEventLog, CodeProEventRecord, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use tempfile::tempdir;

fn sample_event(event_id: &str, status: ActivityEventStatus) -> ActivityEvent {
    ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: event_id.to_string(),
        event_type: ActivityEventKind::FileRead,
        session_id: "session-1".to_string(),
        run_id: "run-1".to_string(),
        task_id: Some("task-1".to_string()),
        parent_task_id: None,
        agent_role: None,
        effective_model: Some("openai/gpt-5".to_string()),
        status,
        started_at: Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).single().unwrap(),
        finished_at: None,
        title: "读取配置文件".to_string(),
        technical_details: Some("读取 Cargo.toml".to_string()),
        path: Some("Cargo.toml".into()),
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
        include_in_model_context: true,
        retryable: false,
        retry_from_event_id: None,
    }
}

#[test]
fn appends_records_with_monotonic_sequence_and_recovers_them() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let mut log = CodeProEventLog::open(&path).unwrap();

    let first = log
        .append(&sample_event("event-1", ActivityEventStatus::Running), None)
        .unwrap();
    let second = log
        .append(
            &sample_event("event-1", ActivityEventStatus::Completed),
            Some("artifacts/event-1.txt".into()),
        )
        .unwrap();

    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    assert_eq!(
        second.artifact_ref.as_deref(),
        Some(std::path::Path::new("artifacts/event-1.txt"))
    );

    drop(log);
    let reopened = CodeProEventLog::open(&path).unwrap();
    assert_eq!(reopened.records(), &[first, second]);
}

#[test]
fn removes_only_a_truncated_final_record_after_a_crash() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let mut log = CodeProEventLog::open(&path).unwrap();
    let complete = log
        .append(&sample_event("event-1", ActivityEventStatus::Running), None)
        .unwrap();
    drop(log);

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(br#"{"sequence":2,"event_id":"event-2""#)
        .unwrap();
    drop(file);

    let mut recovered = CodeProEventLog::open(&path).unwrap();
    assert_eq!(recovered.records(), std::slice::from_ref(&complete));
    let next = recovered
        .append(
            &sample_event("event-2", ActivityEventStatus::Completed),
            None,
        )
        .unwrap();
    assert_eq!(next.sequence, 2);

    let bytes = std::fs::read(&path).unwrap();
    assert!(bytes.ends_with(b"\n"));
    assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 2);
}

#[test]
fn rejects_a_corrupt_complete_record_instead_of_hiding_it() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    std::fs::write(&path, b"{not-json}\n").unwrap();

    let error = CodeProEventLog::open(&path).unwrap_err();
    assert!(error.to_string().contains("第 1 行"));
}

#[test]
fn record_wire_format_is_versioned_and_flat() {
    let record = CodeProEventRecord::from_activity_event(
        7,
        sample_event("event-7", ActivityEventStatus::Running),
        None,
    );

    let json = serde_json::to_value(record).unwrap();
    assert_eq!(json["schema_version"], 1);
    assert_eq!(json["sequence"], 7);
    assert_eq!(json["event_id"], "event-7");
    assert_eq!(json["event_type"], "file_read");
    assert_eq!(json["status"], "running");
    assert_eq!(json["detail_summary"], "读取 Cargo.toml");
    assert!(json.get("event").is_none());
}

#[test]
fn read_only_reader_ignores_a_partial_tail_without_mutating_the_log() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let mut log = CodeProEventLog::open(&path).unwrap();
    let complete = log
        .append(&sample_event("event-1", ActivityEventStatus::Running), None)
        .unwrap();
    drop(log);

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(br#"{"sequence":2,"event_id":"partial""#)
        .unwrap();
    drop(file);
    let before = std::fs::read(&path).unwrap();

    assert_eq!(read_codepro_event_records(&path).unwrap(), vec![complete]);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn redacts_credentials_before_records_reach_memory_or_disk() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("events.jsonl");
    let mut event = sample_event("event-secret", ActivityEventStatus::Completed);
    event.title = "调用接口 password=hunter2".to_string();
    event.technical_details = Some(
        r#"OPENAI_API_KEY="sk-live-secret" GITHUB_TOKEN=github-secret AWS_SECRET_ACCESS_KEY=aws-secret DATABASE_PASSWORD=db-secret CLIENT_SECRET=client-value-987 authorization: Bearer access-secret"#
            .to_string(),
    );
    event.command_summary = Some(
        r#"curl --client-secret cli-value-987 -H "Authorization: Bearer command-secret" "https://example.test?api_key=query-secret&safe=1""#.to_string(),
    );
    event.diff_summary = Some(r#"{"refresh_token":"refresh-secret","result":"ok"}"#.to_string());

    let mut log = CodeProEventLog::open(&path).unwrap();
    let record = log.append(&event, None).unwrap();
    let raw_log = std::fs::read_to_string(&path).unwrap();

    for secret in [
        "hunter2",
        "sk-live-secret",
        "github-secret",
        "aws-secret",
        "db-secret",
        "client-value-987",
        "cli-value-987",
        "access-secret",
        "command-secret",
        "query-secret",
        "refresh-secret",
    ] {
        assert!(
            !raw_log.contains(secret),
            "persisted log must not contain {secret}"
        );
        assert!(
            !serde_json::to_string(&record).unwrap().contains(secret),
            "returned record must not retain {secret}"
        );
    }
    assert!(raw_log.matches("[REDACTED]").count() >= 6);
    assert_eq!(
        record.path.as_deref(),
        Some(std::path::Path::new("Cargo.toml"))
    );
    assert!(record
        .command_summary
        .as_deref()
        .unwrap()
        .contains("https://example.test?api_key=[REDACTED]&safe=1"));
}

#[test]
fn stores_bounded_redacted_artifacts_beside_the_append_only_log() {
    let directory = tempdir().unwrap();
    let run_dir = directory.path().join("run");
    let store = CodeProArtifactStore::with_max_bytes(&run_dir, 96);

    let artifact_ref = store
        .write_text(
            "event/unsafe",
            "stdout",
            format!("OPENAI_API_KEY=sk-secret\n{}", "x".repeat(256)),
        )
        .unwrap();
    let artifact = std::fs::read_to_string(run_dir.join(&artifact_ref)).unwrap();

    assert_eq!(
        artifact_ref,
        std::path::Path::new("artifacts/event_unsafe.stdout.txt")
    );
    assert!(!artifact.contains("sk-secret"));
    assert!(artifact.contains("[REDACTED]"));
    assert!(artifact.len() <= 96);
}

#[test]
fn appends_an_event_with_a_real_artifact_reference() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("run").join("events.jsonl");
    let mut log = CodeProEventLog::open(&path).unwrap();

    let record = log
        .append_with_text_artifact(
            &sample_event("event-output", ActivityEventStatus::Completed),
            "stdout",
            "full command output",
        )
        .unwrap();

    assert_eq!(
        record.artifact_ref.as_deref(),
        Some(std::path::Path::new("artifacts/event-output.stdout.txt"))
    );
    assert_eq!(
        std::fs::read_to_string(
            directory
                .path()
                .join("run")
                .join(record.artifact_ref.unwrap())
        )
        .unwrap(),
        "full command output"
    );
}
