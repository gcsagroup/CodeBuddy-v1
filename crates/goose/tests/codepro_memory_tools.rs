use chrono::{TimeZone, Utc};
use goose::agents::extension::PlatformExtensionContext;
use goose::agents::mcp_client::McpClientTrait;
use goose::agents::platform_extensions::PLATFORM_EXTENSIONS;
use goose::agents::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, AgentRole, CodeProEventLog,
    CodeProEventRecord, CodeProMemoryClient, ToolCallContext, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use goose::session::{SessionManager, SessionType};
use rmcp::model::{CallToolResult, RawContent};
use rmcp::object;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

const MAX_MEMORY_TOOL_RESPONSE_BYTES: usize = 32 * 1024;

fn event(
    event_id: &str,
    task_id: &str,
    status: ActivityEventStatus,
    title: &str,
    details: &str,
) -> ActivityEvent {
    ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: event_id.to_string(),
        event_type: ActivityEventKind::TestCompleted,
        session_id: "session-1".to_string(),
        run_id: "run-1".to_string(),
        task_id: Some(task_id.to_string()),
        parent_task_id: None,
        agent_role: Some(AgentRole::Tester),
        effective_model: Some("ollama_cloud/deepseek-v4-flash".to_string()),
        status,
        started_at: Utc
            .with_ymd_and_hms(2026, 7, 30, 10, 0, 0)
            .single()
            .unwrap(),
        finished_at: Some(
            Utc.with_ymd_and_hms(2026, 7, 30, 10, 0, 1)
                .single()
                .unwrap(),
        ),
        title: title.to_string(),
        technical_details: Some(details.to_string()),
        path: Some("crates/goose/src/lib.rs".into()),
        command_summary: Some("cargo test -p goose".to_string()),
        exit_code: Some(if status == ActivityEventStatus::Completed {
            0
        } else {
            1
        }),
        diff_summary: None,
        failure_kind: None,
        risk_tier: None,
        previous_risk_tier: None,
        risk_reasons: Vec::new(),
        selected_roles: Vec::new(),
        review_required: None,
        routing_evidence: None,
        include_in_model_context: true,
        retryable: status == ActivityEventStatus::Failed,
        retry_from_event_id: None,
    }
}

fn context(data_dir: &std::path::Path) -> PlatformExtensionContext {
    PlatformExtensionContext {
        extension_manager: None,
        session_manager: Arc::new(SessionManager::new(data_dir.to_path_buf())),
        session: None,
        use_login_shell_path: false,
    }
}

fn text(result: &CallToolResult) -> &str {
    match &result.content[0].raw {
        RawContent::Text(text) => &text.text,
        _ => panic!("expected text content"),
    }
}

fn json(result: &CallToolResult) -> Value {
    serde_json::from_str(text(result)).unwrap()
}

fn write_event_records(path: &Path, count: usize, detail_size: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut contents = String::new();
    for index in 0..count {
        let record = CodeProEventRecord::from_activity_event(
            (index + 1) as u64,
            event(
                &format!("event-{index}"),
                &format!("task-{}", index % 4),
                ActivityEventStatus::Completed,
                "历史测试通过",
                &format!("needle-{index} {}", "x".repeat(detail_size)),
            ),
            None,
        );
        contents.push_str(&serde_json::to_string(&record).unwrap());
        contents.push('\n');
    }
    std::fs::write(path, contents).unwrap();
}

#[tokio::test]
async fn exposes_exactly_three_read_only_memory_tools() {
    let directory = tempdir().unwrap();
    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    let extension = PLATFORM_EXTENSIONS.get("codepromemory").unwrap();
    assert!(extension.default_enabled);
    assert!(extension.unprefixed_tools);
    assert!(extension.hidden);

    let result = client
        .list_tools("session-1", None, CancellationToken::new())
        .await
        .unwrap();
    let names = result
        .tools
        .iter()
        .map(|tool| tool.name.as_ref())
        .collect::<Vec<_>>();
    assert_eq!(names, ["memory_search", "memory_read", "memory_stats"]);
    for tool in result.tools {
        let annotations = tool.annotations.unwrap();
        assert_eq!(annotations.read_only_hint, Some(true));
        assert_eq!(annotations.destructive_hint, Some(false));
        assert_eq!(annotations.idempotent_hint, Some(true));
        assert_eq!(annotations.open_world_hint, Some(false));
    }
}

#[tokio::test]
async fn searches_with_filters_and_returns_only_bounded_matches() {
    let directory = tempdir().unwrap();
    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    let mut log = CodeProEventLog::open(&log_path).unwrap();
    log.append(
        &event(
            "event-1",
            "task-a",
            ActivityEventStatus::Failed,
            "测试失败",
            "发现 panic 证据",
        ),
        None,
    )
    .unwrap();
    log.append(
        &event(
            "event-2",
            "task-b",
            ActivityEventStatus::Completed,
            "测试通过",
            "没有错误",
        ),
        None,
    )
    .unwrap();
    drop(log);

    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    let result = client
        .call_tool(
            &ToolCallContext::new("session-1".to_string(), None, None),
            "memory_search",
            Some(object!({
                "run_id": "run-1",
                "task_id": "task-a",
                "agent_role": "tester",
                "path": "src/lib.rs",
                "command": "cargo test",
                "status": "failed",
                "query": "panic",
                "started_from": "2026-07-30T09:59:59Z",
                "started_to": "2026-07-30T10:00:01Z",
                "limit": 1
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false));
    let body = json(&result);
    assert_eq!(body["matched_count"], 1);
    assert_eq!(body["returned_count"], 1);
    assert_eq!(body["truncated"], false);
    assert_eq!(body["records"][0]["event_id"], "event-1");
    assert_eq!(body["records"][0]["detail_summary"], "发现 panic 证据");
}

#[tokio::test]
async fn reads_one_record_and_reports_compact_run_statistics() {
    let directory = tempdir().unwrap();
    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    let mut log = CodeProEventLog::open(&log_path).unwrap();
    log.append(
        &event(
            "event-1",
            "task-a",
            ActivityEventStatus::Failed,
            "测试失败",
            "失败证据",
        ),
        Some("artifacts/event-1.txt".into()),
    )
    .unwrap();
    log.append(
        &event(
            "event-2",
            "task-b",
            ActivityEventStatus::Completed,
            "测试通过",
            "通过证据",
        ),
        None,
    )
    .unwrap();
    drop(log);

    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    let ctx = ToolCallContext::new("session-1".to_string(), None, None);
    let read = client
        .call_tool(
            &ctx,
            "memory_read",
            Some(object!({"run_id": "run-1", "sequence": 1})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(read.is_error, Some(false));
    assert_eq!(
        json(&read)["record"]["artifact_ref"],
        "artifacts/event-1.txt"
    );

    let stats = client
        .call_tool(
            &ctx,
            "memory_stats",
            Some(object!({"run_id": "run-1"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(stats.is_error, Some(false));
    let body = json(&stats);
    assert_eq!(body["total_records"], 2);
    assert_eq!(body["first_sequence"], 1);
    assert_eq!(body["last_sequence"], 2);
    assert_eq!(body["by_status"]["failed"], 1);
    assert_eq!(body["by_status"]["completed"], 1);
}

#[tokio::test]
async fn rejects_path_traversal_and_cross_session_reads() {
    let directory = tempdir().unwrap();
    assert!(CodeProMemoryClient::event_log_path(directory.path(), "../escape").is_err());

    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    let mut log = CodeProEventLog::open(&log_path).unwrap();
    log.append(
        &event(
            "event-1",
            "task-a",
            ActivityEventStatus::Completed,
            "测试通过",
            "通过证据",
        ),
        None,
    )
    .unwrap();
    drop(log);

    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    let result = client
        .call_tool(
            &ToolCallContext::new("another-session".to_string(), None, None),
            "memory_read",
            Some(object!({"run_id": "run-1", "event_id": "event-1"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(true));
    assert!(text(&result).contains("会话边界"));
}

#[tokio::test]
async fn reading_by_event_id_returns_the_latest_state_transition() {
    let directory = tempdir().unwrap();
    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    let mut log = CodeProEventLog::open(&log_path).unwrap();
    log.append(
        &event(
            "event-1",
            "task-a",
            ActivityEventStatus::Running,
            "正在测试",
            "测试开始",
        ),
        None,
    )
    .unwrap();
    log.append(
        &event(
            "event-1",
            "task-a",
            ActivityEventStatus::Completed,
            "测试通过",
            "测试结束",
        ),
        None,
    )
    .unwrap();
    drop(log);

    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    let result = client
        .call_tool(
            &ToolCallContext::new("session-1".to_string(), None, None),
            "memory_read",
            Some(object!({"run_id": "run-1", "event_id": "event-1"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false));
    assert_eq!(json(&result)["record"]["sequence"], 2);
    assert_eq!(json(&result)["record"]["status"], "completed");
}

#[tokio::test]
async fn thousand_event_history_requires_explicit_bounded_context_loading() {
    let directory = tempdir().unwrap();
    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    write_event_records(&log_path, 1_001, 2_000);

    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    assert_eq!(
        client.get_moim("session-1").await,
        None,
        "the complete history must never be injected into every model turn"
    );

    let result = client
        .call_tool(
            &ToolCallContext::new("session-1".to_string(), None, None),
            "memory_search",
            Some(object!({
                "run_id": "run-1",
                "query": "needle",
                "limit": 100
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false));
    let body = json(&result);
    assert_eq!(body["matched_count"], 1_001);
    assert_eq!(body["truncated"], true);
    assert!(body["returned_count"].as_u64().unwrap() < 100);
    assert!(
        text(&result).len() <= MAX_MEMORY_TOOL_RESPONSE_BYTES,
        "memory tool output was {} bytes",
        text(&result).len()
    );
    assert_eq!(body["records"][0]["sequence"], 1_001);
}

#[tokio::test]
async fn repeated_identical_search_requires_new_event_progress() {
    let directory = tempdir().unwrap();
    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    let mut log = CodeProEventLog::open(&log_path).unwrap();
    log.append(
        &event(
            "event-1",
            "task-a",
            ActivityEventStatus::Completed,
            "第一次检查",
            "现有证据",
        ),
        None,
    )
    .unwrap();
    drop(log);

    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    let ctx = ToolCallContext::new("session-1".to_string(), None, None);
    let search_arguments = || {
        Some(object!({
            "run_id": "run-1",
            "task_id": "task-a",
            "limit": 20
        }))
    };

    let first = client
        .call_tool(
            &ctx,
            "memory_search",
            search_arguments(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first.is_error, Some(false));

    let repeated = client
        .call_tool(
            &ctx,
            "memory_search",
            search_arguments(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(repeated.is_error, Some(true));
    assert!(text(&repeated).contains("NO_PROGRESS"));

    let mut log = CodeProEventLog::open(&log_path).unwrap();
    log.append(
        &event(
            "event-2",
            "task-a",
            ActivityEventStatus::Completed,
            "第二次检查",
            "新增证据",
        ),
        None,
    )
    .unwrap();
    drop(log);

    let after_progress = client
        .call_tool(
            &ctx,
            "memory_search",
            search_arguments(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(after_progress.is_error, Some(false));
    assert_eq!(json(&after_progress)["matched_count"], 2);

    let repeated_after_progress = client
        .call_tool(
            &ctx,
            "memory_search",
            search_arguments(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(repeated_after_progress.is_error, Some(true));

    let changed_query = client
        .call_tool(
            &ctx,
            "memory_search",
            Some(object!({
                "run_id": "run-1",
                "task_id": "task-a",
                "status": "completed",
                "limit": 20
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(changed_query.is_error, Some(false));
    assert_eq!(json(&changed_query)["matched_count"], 2);
}

#[tokio::test]
async fn searches_one_hundred_thousand_events_with_combined_filters() {
    let directory = tempdir().unwrap();
    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    write_event_records(&log_path, 100_000, 0);
    let client =
        CodeProMemoryClient::new_with_root(context(directory.path()), directory.path()).unwrap();
    let ctx = ToolCallContext::new("session-1".to_string(), None, None);

    let result = client
        .call_tool(
            &ctx,
            "memory_search",
            Some(object!({
                "run_id": "run-1",
                "task_id": "task-3",
                "path": "crates/goose/src",
                "status": "completed",
                "query": "needle-99999",
                "limit": 5
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(result.is_error, Some(false));
    assert_eq!(json(&result)["matched_count"], 1);
    assert_eq!(json(&result)["records"][0]["sequence"], 100_000);
}

#[tokio::test]
async fn child_agent_can_read_only_its_parent_codepro_run() {
    let directory = tempdir().unwrap();
    let log_path = CodeProMemoryClient::event_log_path(directory.path(), "run-1").unwrap();
    write_event_records(&log_path, 2, 16);

    let session_manager = Arc::new(SessionManager::new(directory.path().join("sessions")));
    let child = session_manager
        .create_session(
            directory.path().to_path_buf(),
            "child".to_string(),
            SessionType::SubAgent,
            Default::default(),
        )
        .await
        .unwrap();
    session_manager
        .update(&child.id)
        .parent_session_id(Some("session-1".to_string()))
        .apply()
        .await
        .unwrap();
    let child = session_manager.get_session(&child.id, false).await.unwrap();
    let child_id = child.id.clone();
    let client = CodeProMemoryClient::new_with_root(
        PlatformExtensionContext {
            extension_manager: None,
            session_manager,
            session: Some(Arc::new(child)),
            use_login_shell_path: false,
        },
        directory.path(),
    )
    .unwrap();

    let allowed = client
        .call_tool(
            &ToolCallContext::new(child_id, None, None),
            "memory_stats",
            Some(object!({"run_id": "run-1"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(allowed.is_error, Some(false));
    assert_eq!(json(&allowed)["total_records"], 2);

    let rejected = client
        .call_tool(
            &ToolCallContext::new("different-child".to_string(), None, None),
            "memory_stats",
            Some(object!({"run_id": "run-1"})),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.is_error, Some(true));
    assert!(text(&rejected).contains("会话边界"));
}
