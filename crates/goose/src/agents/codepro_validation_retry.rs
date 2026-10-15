use crate::agents::codepro_simple_change_run::{
    is_validation_command, SimpleChangeOutcome, SimpleChangeStatus,
};
use crate::conversation::message::{Message, SystemNotificationType};
use rmcp::model::Role;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ValidationRetryEvidence {
    pub(crate) target_path: String,
    pub(crate) command: String,
    pub(crate) exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimpleChangeTerminalContext {
    pub(crate) run_id: String,
    pub(crate) source_user_message_id: String,
    pub(crate) retry_of_terminal_message_id: Option<String>,
    pub(crate) tool_action_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidationRetryLink {
    pub(crate) source_run_id: String,
    pub(crate) source_user_message_id: String,
    pub(crate) source_terminal_message_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidationRetrySource {
    pub(crate) terminal_message_id: String,
    pub(crate) evidence: ValidationRetryEvidence,
}

#[derive(Debug, Deserialize)]
struct PersistedValidationTerminal {
    schema_version: u8,
    session_id: String,
    run_id: String,
    terminal_message_id: String,
    source_user_message_id: String,
    status: String,
    checkpoint_id: serde_json::Value,
    retry_strategy: String,
    visible_text_available: bool,
    #[serde(rename = "tool_action_count")]
    _tool_action_count: usize,
    #[serde(rename = "copy_artifact_ref")]
    _copy_artifact_ref: Option<String>,
    finished_at: String,
    validation_retry: Option<ValidationRetryEvidence>,
    #[serde(rename = "retry_of_terminal_message_id")]
    _retry_of_terminal_message_id: Option<String>,
}

pub(crate) fn resolve_validation_retry_source(
    messages: &[Message],
    session_id: &str,
    link: &ValidationRetryLink,
) -> Result<ValidationRetrySource, String> {
    if session_id.trim().is_empty()
        || link.source_run_id.trim().is_empty()
        || link.source_user_message_id.trim().is_empty()
        || link.source_terminal_message_id.trim().is_empty()
    {
        return Err("失败验证重试关联 ID 不完整".to_string());
    }

    let source_user_indices = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            (message.role == Role::User
                && message.metadata.user_visible
                && message.metadata.agent_visible
                && message.id.as_deref() == Some(link.source_user_message_id.as_str()))
            .then_some(index)
        })
        .collect::<Vec<_>>();
    if source_user_indices.len() != 1 {
        return Err("失败验证重试源用户消息不唯一或不存在".to_string());
    }

    let mut matching_terminals = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        for content in &message.content {
            let Some(notification) = content.as_system_notification() else {
                continue;
            };
            if notification.notification_type != SystemNotificationType::TurnTerminal {
                continue;
            }
            let Some(data) = notification.data.as_ref() else {
                continue;
            };
            if data
                .get("terminal_message_id")
                .and_then(serde_json::Value::as_str)
                != Some(link.source_terminal_message_id.as_str())
            {
                continue;
            }
            let terminal = serde_json::from_value::<PersistedValidationTerminal>(data.clone())
                .map_err(|error| format!("失败验证终态数据无效：{error}"))?;
            matching_terminals.push((message_index, message, terminal));
        }
    }
    if matching_terminals.len() != 1 {
        return Err("失败验证重试源终态不唯一或不存在".to_string());
    }
    let (terminal_index, terminal_message, terminal) = matching_terminals
        .pop()
        .expect("one matching validation terminal");
    if source_user_indices[0] >= terminal_index
        || terminal_message.id.as_deref() != Some(terminal.terminal_message_id.as_str())
        || terminal.schema_version != 1
        || terminal.session_id != session_id
        || terminal.run_id != link.source_run_id
        || terminal.source_user_message_id != link.source_user_message_id
        || terminal.terminal_message_id != link.source_terminal_message_id
        || terminal.status != "failed"
        || !terminal.checkpoint_id.is_null()
        || terminal.retry_strategy != "retry_failed_validation"
        || !terminal.visible_text_available
        || terminal.finished_at.trim().is_empty()
    {
        return Err("失败验证重试源终态关联不匹配".to_string());
    }
    let evidence = terminal
        .validation_retry
        .ok_or_else(|| "失败验证重试证据缺失".to_string())?;
    if evidence.target_path.trim().is_empty() || !is_validation_command(&evidence.command) {
        return Err("失败验证重试目标或命令不安全".to_string());
    }

    for message in messages.iter().skip(terminal_index + 1) {
        for content in &message.content {
            let Some(notification) = content.as_system_notification() else {
                continue;
            };
            if notification.notification_type != SystemNotificationType::TurnTerminal {
                continue;
            }
            if notification
                .data
                .as_ref()
                .and_then(|data| data.get("retry_of_terminal_message_id"))
                .and_then(serde_json::Value::as_str)
                == Some(link.source_terminal_message_id.as_str())
            {
                return Err("失败验证重试源终态已被后继终态取代".to_string());
            }
        }
    }

    Ok(ValidationRetrySource {
        terminal_message_id: terminal.terminal_message_id,
        evidence,
    })
}

pub(crate) fn build_simple_change_terminal(
    outcome: &SimpleChangeOutcome,
    session_id: &str,
    context: &SimpleChangeTerminalContext,
) -> Message {
    let message = Message::assistant()
        .with_generated_id()
        .with_text(outcome.render_user_message());
    let terminal_message_id = message
        .id
        .as_deref()
        .expect("generated simple change terminal message id");
    let (status, retry_strategy) = match outcome.status {
        SimpleChangeStatus::Pass => ("completed", "not_available"),
        SimpleChangeStatus::Fail
            if outcome
                .command
                .as_deref()
                .is_some_and(is_validation_command) =>
        {
            ("failed", "retry_failed_validation")
        }
        SimpleChangeStatus::Fail | SimpleChangeStatus::Blocked | SimpleChangeStatus::NotRun => {
            ("failed", "not_available")
        }
    };
    let validation_retry =
        (retry_strategy == "retry_failed_validation").then(|| ValidationRetryEvidence {
            target_path: outcome.target.display().to_string(),
            command: outcome
                .command
                .clone()
                .expect("retryable failed validation command"),
            exit_code: outcome.exit_code,
        });
    let mut terminal = serde_json::json!({
        "schema_version": 1,
        "session_id": session_id,
        "run_id": context.run_id,
        "terminal_message_id": terminal_message_id,
        "source_user_message_id": context.source_user_message_id,
        "status": status,
        "checkpoint_id": serde_json::Value::Null,
        "retry_strategy": retry_strategy,
        "visible_text_available": true,
        "tool_action_count": context.tool_action_count,
        "copy_artifact_ref": serde_json::Value::Null,
        "finished_at": chrono::Utc::now().to_rfc3339(),
        "retry_of_terminal_message_id": context.retry_of_terminal_message_id,
    });
    if let Some(validation_retry) = validation_retry {
        terminal["validation_retry"] =
            serde_json::to_value(validation_retry).expect("serialize validation retry evidence");
    }

    message.with_system_notification_with_data(
        SystemNotificationType::TurnTerminal,
        "CodePro simple change terminal",
        terminal,
    )
}

pub(crate) fn build_cancelled_validation_retry_terminal(
    session_id: &str,
    context: &SimpleChangeTerminalContext,
    target: &Path,
    command: &str,
) -> Message {
    let message = Message::assistant().with_generated_id().with_text(format!(
        "失败验证重试终态：CANCELLED\n文件：{}\n验证：{}\n退出码：NOT_RUN\n证据：用户取消后宿主已停止验证重试。",
        target.display(),
        command
    ));
    let terminal_message_id = message
        .id
        .as_deref()
        .expect("generated cancelled validation retry terminal message id");
    let terminal = serde_json::json!({
        "schema_version": 1,
        "session_id": session_id,
        "run_id": context.run_id,
        "terminal_message_id": terminal_message_id,
        "source_user_message_id": context.source_user_message_id,
        "status": "cancelled",
        "checkpoint_id": serde_json::Value::Null,
        "retry_strategy": "not_available",
        "visible_text_available": true,
        "tool_action_count": context.tool_action_count,
        "copy_artifact_ref": serde_json::Value::Null,
        "finished_at": chrono::Utc::now().to_rfc3339(),
        "retry_of_terminal_message_id": context.retry_of_terminal_message_id,
    });

    message.with_system_notification_with_data(
        SystemNotificationType::TurnTerminal,
        "CodePro validation retry cancelled",
        terminal,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_simple_change_terminal, resolve_validation_retry_source, SimpleChangeTerminalContext,
        ValidationRetryLink,
    };
    use crate::agents::codepro_simple_change_run::{SimpleChangeOutcome, SimpleChangeStatus};
    use crate::conversation::message::{Message, MessageContent, SystemNotificationType};
    use serde_json::Value;
    use std::path::PathBuf;

    fn outcome(status: SimpleChangeStatus, exit_code: Option<i32>) -> SimpleChangeOutcome {
        SimpleChangeOutcome {
            status,
            target: PathBuf::from(r"D:\workspace\app.rs"),
            command: Some("cargo test -p app title_test".to_string()),
            exit_code,
            reason: "host evidence".to_string(),
        }
    }

    fn context(retry_of_terminal_message_id: Option<&str>) -> SimpleChangeTerminalContext {
        SimpleChangeTerminalContext {
            run_id: "run-current".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            retry_of_terminal_message_id: retry_of_terminal_message_id.map(str::to_string),
            tool_action_count: 2,
        }
    }

    fn terminal_data(message: &Message) -> &Value {
        let notification = message
            .content
            .iter()
            .find_map(MessageContent::as_system_notification)
            .expect("turn terminal notification");
        assert_eq!(
            notification.notification_type,
            SystemNotificationType::TurnTerminal
        );
        notification.data.as_ref().expect("turn terminal data")
    }

    #[test]
    fn codepro_validation_retry_terminal_makes_only_failed_validation_retryable() {
        let failed = build_simple_change_terminal(
            &outcome(SimpleChangeStatus::Fail, Some(3)),
            "session-1",
            &context(None),
        );
        let failed_data = terminal_data(&failed);
        assert_eq!(failed_data["status"], "failed");
        assert_eq!(failed_data["retry_strategy"], "retry_failed_validation");
        assert_eq!(failed_data["checkpoint_id"], Value::Null);
        assert_eq!(failed_data["retry_of_terminal_message_id"], Value::Null);
        assert_eq!(
            failed_data["validation_retry"]["target_path"],
            r"D:\workspace\app.rs"
        );
        assert_eq!(
            failed_data["validation_retry"]["command"],
            "cargo test -p app title_test"
        );
        assert_eq!(failed_data["validation_retry"]["exit_code"], 3);
        assert_eq!(failed_data["tool_action_count"], 2);
        assert_eq!(
            failed_data["terminal_message_id"],
            failed.id.as_deref().unwrap()
        );

        let passed = build_simple_change_terminal(
            &outcome(SimpleChangeStatus::Pass, Some(0)),
            "session-1",
            &context(Some("failed-terminal")),
        );
        let passed_data = terminal_data(&passed);
        assert_eq!(passed_data["status"], "completed");
        assert_eq!(passed_data["retry_strategy"], "not_available");
        assert_eq!(
            passed_data["retry_of_terminal_message_id"],
            "failed-terminal"
        );
        assert!(passed_data.get("validation_retry").is_none());

        let blocked = build_simple_change_terminal(
            &outcome(SimpleChangeStatus::Blocked, None),
            "session-1",
            &context(None),
        );
        let blocked_data = terminal_data(&blocked);
        assert_eq!(blocked_data["status"], "failed");
        assert_eq!(blocked_data["retry_strategy"], "not_available");
        assert!(blocked_data.get("validation_retry").is_none());

        let mut incomplete_failure = outcome(SimpleChangeStatus::Fail, Some(3));
        incomplete_failure.command = Some("   ".to_string());
        let incomplete =
            build_simple_change_terminal(&incomplete_failure, "session-1", &context(None));
        let incomplete_data = terminal_data(&incomplete);
        assert_eq!(incomplete_data["status"], "failed");
        assert_eq!(incomplete_data["retry_strategy"], "not_available");
        assert!(incomplete_data.get("validation_retry").is_none());
    }

    #[test]
    fn codepro_validation_retry_terminal_keeps_latest_failed_link_retryable() {
        let message = build_simple_change_terminal(
            &outcome(SimpleChangeStatus::Fail, Some(7)),
            "session-1",
            &context(Some("failed-terminal-1")),
        );
        let data = terminal_data(&message);

        assert_eq!(data["retry_strategy"], "retry_failed_validation");
        assert_eq!(data["retry_of_terminal_message_id"], "failed-terminal-1");
        assert_eq!(data["validation_retry"]["exit_code"], 7);
    }

    fn failed_terminal(
        run_id: &str,
        source_user_message_id: &str,
        retry_of_terminal_message_id: Option<&str>,
        command: &str,
    ) -> Message {
        let mut failed = outcome(SimpleChangeStatus::Fail, Some(3));
        failed.command = Some(command.to_string());
        build_simple_change_terminal(
            &failed,
            "session-1",
            &SimpleChangeTerminalContext {
                run_id: run_id.to_string(),
                source_user_message_id: source_user_message_id.to_string(),
                retry_of_terminal_message_id: retry_of_terminal_message_id.map(str::to_string),
                tool_action_count: 1,
            },
        )
    }

    #[test]
    fn codepro_validation_retry_source_accepts_only_matching_latest_failed_terminal() {
        let source_user = Message::user()
            .with_id("source-user-1")
            .with_text("change app.rs");
        let failed = failed_terminal("run-source", "source-user-1", None, "cargo test -p app");
        let link = ValidationRetryLink {
            source_run_id: "run-source".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            source_terminal_message_id: failed.id.clone().unwrap(),
        };
        let messages = vec![source_user, failed];

        let source = resolve_validation_retry_source(&messages, "session-1", &link).unwrap();
        assert_eq!(source.terminal_message_id, link.source_terminal_message_id);
        assert_eq!(source.evidence.command, "cargo test -p app");
        assert_eq!(source.evidence.exit_code, Some(3));
        assert_eq!(source.evidence.target_path, r"D:\workspace\app.rs");

        for invalid in [
            ValidationRetryLink {
                source_run_id: "wrong-run".to_string(),
                ..link.clone()
            },
            ValidationRetryLink {
                source_user_message_id: "wrong-user".to_string(),
                ..link.clone()
            },
            ValidationRetryLink {
                source_terminal_message_id: "missing-terminal".to_string(),
                ..link.clone()
            },
        ] {
            assert!(resolve_validation_retry_source(&messages, "session-1", &invalid).is_err());
        }
        assert!(resolve_validation_retry_source(&messages, "wrong-session", &link).is_err());
    }

    #[test]
    fn codepro_validation_retry_source_rejects_malformed_duplicate_and_superseded_evidence() {
        let source_user = Message::user()
            .with_id("source-user-1")
            .with_text("change app.rs");
        let malformed = failed_terminal("run-source", "source-user-1", None, "   ");
        let malformed_link = ValidationRetryLink {
            source_run_id: "run-source".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            source_terminal_message_id: malformed.id.clone().unwrap(),
        };
        assert!(resolve_validation_retry_source(
            &[source_user.clone(), malformed],
            "session-1",
            &malformed_link,
        )
        .is_err());

        let passed = build_simple_change_terminal(
            &outcome(SimpleChangeStatus::Pass, Some(0)),
            "session-1",
            &SimpleChangeTerminalContext {
                run_id: "run-source".to_string(),
                source_user_message_id: "source-user-1".to_string(),
                retry_of_terminal_message_id: None,
                tool_action_count: 1,
            },
        );
        let passed_link = ValidationRetryLink {
            source_run_id: "run-source".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            source_terminal_message_id: passed.id.clone().unwrap(),
        };
        assert!(resolve_validation_retry_source(
            &[source_user.clone(), passed],
            "session-1",
            &passed_link,
        )
        .is_err());

        let failed = failed_terminal("run-source", "source-user-1", None, "cargo test -p app");
        let link = ValidationRetryLink {
            source_run_id: "run-source".to_string(),
            source_user_message_id: "source-user-1".to_string(),
            source_terminal_message_id: failed.id.clone().unwrap(),
        };
        let duplicate = failed.clone();
        assert!(resolve_validation_retry_source(
            &[source_user.clone(), failed.clone(), duplicate],
            "session-1",
            &link,
        )
        .is_err());

        let successor = failed_terminal(
            "run-retry",
            "retry-user-2",
            failed.id.as_deref(),
            "cargo test -p app",
        );
        assert!(resolve_validation_retry_source(
            &[
                source_user,
                failed,
                Message::user()
                    .with_id("retry-user-2")
                    .with_text("retry validation"),
                successor,
            ],
            "session-1",
            &link,
        )
        .is_err());
    }
}
