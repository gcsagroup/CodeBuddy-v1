use chrono::{DateTime, Utc};
use goose::agents::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, AgentRole, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use serde_json::json;
use std::path::PathBuf;

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}

fn running_event() -> ActivityEvent {
    ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: "event-0001".to_string(),
        event_type: ActivityEventKind::CommandStarted,
        session_id: "session-01".to_string(),
        run_id: "run-01".to_string(),
        task_id: Some("task-01".to_string()),
        parent_task_id: None,
        agent_role: Some(AgentRole::Tester),
        effective_model: Some("provider/model".to_string()),
        status: ActivityEventStatus::Running,
        started_at: timestamp("2026-07-30T12:00:00Z"),
        finished_at: None,
        title: "运行目标测试".to_string(),
        technical_details: Some("pnpm test:run".to_string()),
        path: Some(PathBuf::from("ui/desktop")),
        command_summary: Some("pnpm test:run".to_string()),
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
        retryable: true,
        retry_from_event_id: None,
    }
}

#[test]
fn activity_event_v1_has_a_stable_wire_format() {
    let value = serde_json::to_value(running_event()).unwrap();

    assert_eq!(
        value,
        json!({
            "schema_version": 1,
            "event_id": "event-0001",
            "event_type": "command_started",
            "session_id": "session-01",
            "run_id": "run-01",
            "task_id": "task-01",
            "parent_task_id": null,
            "agent_role": "tester",
            "effective_model": "provider/model",
            "status": "running",
            "started_at": "2026-07-30T12:00:00Z",
            "finished_at": null,
            "title": "运行目标测试",
            "technical_details": "pnpm test:run",
            "path": "ui/desktop",
            "command_summary": "pnpm test:run",
            "exit_code": null,
            "diff_summary": null,
            "include_in_model_context": false,
            "retryable": true,
            "retry_from_event_id": null
        })
    );
}

fn routing_evidence_fixture() -> serde_json::Value {
    json!({
        "schema_version": 2,
        "build_provenance": {
            "schema_version": 1,
            "package_version": "1.0.0",
            "source_revision": "0123456789abcdef",
            "source_dirty": false
        },
        "classification_source": "workspace_constraint",
        "classified_intent": "change",
        "semantic_warning": null,
        "effective_intent": "conversation",
        "effective_intent_reason": "tools_explicitly_forbidden",
        "goal_source": "execution_message",
        "simple_change_check": "not_applicable",
        "execution_route": "unified_executor"
    })
}

#[test]
fn routing_evidence_survives_activity_and_event_log_round_trips() {
    let evidence = routing_evidence_fixture();
    let mut value = serde_json::to_value(running_event()).unwrap();
    value["event_type"] = json!("intent_completed");
    value["routing_evidence"] = evidence.clone();
    let event: ActivityEvent = serde_json::from_value(value).unwrap();
    assert_eq!(
        serde_json::to_value(&event).unwrap()["routing_evidence"],
        evidence
    );

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.jsonl");
    let mut log = goose::agents::CodeProEventLog::open(&path).unwrap();
    log.append(&event, None).unwrap();
    drop(log);
    let log = goose::agents::CodeProEventLog::open(&path).unwrap();
    let restored = log.records()[0].to_activity_event();
    assert_eq!(
        serde_json::to_value(restored).unwrap()["routing_evidence"],
        evidence
    );
}

#[test]
fn legacy_activity_does_not_fabricate_routing_evidence() {
    let value = serde_json::to_value(running_event()).unwrap();
    assert!(value.get("routing_evidence").is_none());
    let event: ActivityEvent = serde_json::from_value(value).unwrap();
    let record = goose::agents::CodeProEventRecord::from_activity_event(1, event, None);
    let old_record = serde_json::to_value(record).unwrap();
    let restored: goose::agents::CodeProEventRecord = serde_json::from_value(old_record).unwrap();
    assert!(serde_json::to_value(restored.to_activity_event())
        .unwrap()
        .get("routing_evidence")
        .is_none());
}

#[test]
fn the_same_event_id_can_move_from_running_to_a_terminal_status() {
    let mut event = running_event();
    event.status = ActivityEventStatus::Completed;
    event.finished_at = Some(timestamp("2026-07-30T12:00:05Z"));
    event.exit_code = Some(0);

    assert_eq!(event.event_id, "event-0001");
    assert!(event.status.is_terminal());
}

#[test]
fn unknown_future_event_types_degrade_without_rejecting_the_event() {
    let mut value = serde_json::to_value(running_event()).unwrap();
    value["event_type"] = json!("future_activity");
    value["status"] = json!("future_status");

    let event: ActivityEvent = serde_json::from_value(value).unwrap();

    assert_eq!(event.event_type, ActivityEventKind::Unknown);
    assert_eq!(event.status, ActivityEventStatus::Unknown);
    assert!(event.status.is_terminal());
}

#[test]
fn strategy_events_have_distinct_wire_names_from_planner_events() {
    assert_eq!(
        serde_json::to_value(ActivityEventKind::StrategySelected).unwrap(),
        serde_json::json!("strategy_selected")
    );
    assert_eq!(
        serde_json::to_value(ActivityEventKind::StrategyUpdated).unwrap(),
        serde_json::json!("strategy_updated")
    );
    assert_ne!(
        ActivityEventKind::StrategySelected,
        ActivityEventKind::PlanCreated
    );
}

#[test]
fn stopped_failed_cancelled_and_interrupted_are_terminal() {
    for status in [
        ActivityEventStatus::Stopped,
        ActivityEventStatus::Failed,
        ActivityEventStatus::Cancelled,
        ActivityEventStatus::Interrupted,
    ] {
        assert!(status.is_terminal(), "{status:?}");
    }
    assert!(!ActivityEventStatus::Running.is_terminal());
}
