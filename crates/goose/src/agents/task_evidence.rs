use crate::agents::activity_event::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use crate::agents::agent::SharedCodeProEventLog;
use crate::agents::protocol::{EventId, EvidenceRef, RunId};
use crate::agents::task_dag::{TaskNode, TaskPurpose, TaskStatus, VerificationEvidenceV1};
use crate::agents::tool_task::MainAgentActionEvidenceV1;
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(crate) const TASK_EVIDENCE_BUNDLE_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEvidenceBundleV1<'a> {
    schema_version: u8,
    run_id: &'a str,
    plan_revision: u32,
    task_id: &'a str,
    attempt: u32,
    purpose: TaskPurpose,
    status: TaskStatus,
    output: Option<&'a crate::agents::task_dag::TaskOutput>,
    workspace_delta: Option<crate::agents::task_dag::WorkspaceDeltaEvidenceV1>,
    verification_evidence: &'a [VerificationEvidenceV1],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MainAgentTaskEvidenceBundleV1<'a> {
    schema_version: u8,
    run_id: &'a str,
    task_id: &'a str,
    task_kind: &'a str,
    summary: &'a str,
    actions: &'a MainAgentActionEvidenceV1,
    coverage: &'a super::main_agent_contract::CoverageProposal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DelegatedTaskEvidenceBundleV1<'a> {
    schema_version: u8,
    run_id: &'a str,
    task_id: &'a str,
    worker_id: &'a str,
    summary: &'a str,
    subagent_session_id: &'a str,
    response_excerpt: &'a str,
    response_bytes: usize,
    response_blake3: String,
    response_truncated: bool,
    parent_task_id: &'a str,
    terminal_outcome: crate::agents::subagent_handler::SubagentTerminalOutcome,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DelegatedTaskBinding {
    schema_version: u8,
    run_id: String,
    task_id: String,
    parent_task_id: String,
    pub(crate) subagent_session_id: String,
    pub(crate) terminal_outcome: crate::agents::subagent_handler::SubagentTerminalOutcome,
}

/// Shared by takeover and file-evidence consumers. The committed delegation
/// and original session relationship are authoritative, never report prose.
pub(crate) async fn load_delegated_session(
    sessions: &crate::session::SessionManager,
    root: &Path,
    run_id: &RunId,
    parent: (&str, &crate::agents::protocol::TaskId),
    child_task_id: &crate::agents::protocol::TaskId,
    evidence: &EvidenceRef,
) -> Result<Option<(crate::session::Session, DelegatedTaskBinding)>> {
    let run_dir = root.join(run_id.as_str()).join("run");
    let records =
        crate::agents::codepro_event_log::read_codepro_event_records(run_dir.join("events.jsonl"))?;
    let record = records
        .iter()
        .find(|record| record.event_id == evidence.event_id().as_str())
        .context("evidence event is unavailable")?;
    // Ordinary scheduler evidence and another parent's delegation are not
    // inputs to this parent's file projection. Identity comes from the owner
    // event, not an artifact filename or a model-written summary.
    if record.parent_task_id.as_deref() != Some(parent.1.as_str()) {
        return Ok(None);
    }
    crate::agents::codepro_event_log::verify_task_evidence_records(
        &records,
        &run_dir,
        evidence,
        child_task_id.as_str(),
    )?;
    anyhow::ensure!(
        record.session_id == parent.0,
        "delegation belongs to another parent session"
    );
    let binding: DelegatedTaskBinding = serde_json::from_slice(&std::fs::read(
        run_dir.join(evidence.artifact_ref()),
    )?)
    .context("delegation identity is unavailable; old evidence is not guessed or migrated")?;
    anyhow::ensure!(
        binding.schema_version == TASK_EVIDENCE_BUNDLE_SCHEMA_VERSION
            && binding.run_id == run_id.as_str()
            && binding.task_id == child_task_id.as_str()
            && binding.parent_task_id == parent.1.as_str(),
        "delegation evidence does not match the original parent/run/task"
    );
    let parent_session = sessions.get_session(parent.0, false).await?;
    let child = sessions
        .get_session(&binding.subagent_session_id, true)
        .await?;
    anyhow::ensure!(
        parent_session.session_type != crate::session::SessionType::SubAgent
            && child.session_type == crate::session::SessionType::SubAgent
            && child.parent_session_id.as_deref() == Some(parent.0),
        "only the original parent may consume its own delegation"
    );
    Ok(Some((child, binding)))
}

// Each identifier is independently recorded in the persisted evidence contract.
#[allow(clippy::too_many_arguments)]
pub(crate) fn commit_delegated_task_evidence(
    event_log_root: &Path,
    session_id: &str,
    worker: &crate::agents::workers::WorkerHandle,
    summary: &str,
    subagent_session_id: &str,
    result: &crate::agents::subagent_handler::SubagentRunResult,
    parent_task_id: &str,
) -> Result<Vec<EvidenceRef>> {
    let run_id = worker.run_id().as_str();
    let task_id = worker
        .task_id()
        .context("delegated worker has no task binding")?
        .as_str();
    let worker_id = worker.agent_id().as_str();
    let response = &result.response;
    const RESPONSE_EXCERPT_BYTES: usize = 64 * 1024;
    let excerpt = crate::utils::truncate_utf8_bytes(response, RESPONSE_EXCERPT_BYTES);
    let payload = serde_json::to_string_pretty(&DelegatedTaskEvidenceBundleV1 {
        schema_version: TASK_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        run_id,
        task_id,
        worker_id,
        summary,
        subagent_session_id,
        response_excerpt: &excerpt,
        response_bytes: response.len(),
        response_blake3: blake3::hash(response.as_bytes()).to_hex().to_string(),
        response_truncated: excerpt.len() < response.len(),
        parent_task_id,
        terminal_outcome: result.terminal_outcome,
    })
    .context("failed to serialize delegated task evidence")?;
    let now = Utc::now();
    let event_id = format!("delegated-task-evidence-{}", now.timestamp_micros());
    let event = ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: event_id.clone(),
        event_type: ActivityEventKind::EvidenceCommitted,
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        task_id: Some(task_id.to_string()),
        parent_task_id: Some(parent_task_id.to_string()),
        agent_role: Some(crate::agents::AgentRole::Coder),
        effective_model: None,
        status: ActivityEventStatus::Completed,
        started_at: now,
        finished_at: Some(now),
        title: "Delegated task evidence committed".to_string(),
        technical_details: None,
        path: None,
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
    let path = event_log_root.join(run_id).join("run").join("events.jsonl");
    let mut event_log = crate::agents::codepro_event_log::CodeProEventLog::open(path)?;
    let record = event_log.append_with_text_artifact(&event, "delegated-task-evidence", payload)?;
    let artifact_ref = record
        .artifact_ref
        .context("committed delegated task evidence is missing its artifact reference")?;
    Ok(vec![EvidenceRef::new(
        RunId::new(run_id.to_string())?,
        EventId::new(event_id)?,
        artifact_ref,
    )?])
}

pub(crate) fn commit_task_evidence(
    event_log: &Option<SharedCodeProEventLog>,
    session_id: &str,
    run_id: &str,
    plan_revision: u32,
    purpose: TaskPurpose,
    task: &TaskNode,
    verification_evidence: &[VerificationEvidenceV1],
) -> Result<Vec<EvidenceRef>> {
    let Some(event_log) = event_log else {
        return Ok(Vec::new());
    };

    let payload = serde_json::to_string_pretty(&TaskEvidenceBundleV1 {
        schema_version: TASK_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        run_id,
        plan_revision,
        task_id: &task.id,
        attempt: task.retry_count,
        purpose,
        status: task.status,
        output: task.output.as_ref(),
        workspace_delta: if purpose == TaskPurpose::Implementation
            && task.status == TaskStatus::Done
        {
            task.output
                .as_ref()
                .map(|output| output.workspace_delta_evidence())
        } else {
            None
        },
        verification_evidence,
    })
    .context("failed to serialize committed task evidence")?;

    let now = Utc::now();
    let task_hash = task
        .id
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    let event_id = format!(
        "task-evidence-{plan_revision}-{task_hash:016x}-{}-{}",
        task.retry_count,
        now.timestamp_micros()
    );
    let status = match task.status {
        TaskStatus::Done => ActivityEventStatus::Completed,
        TaskStatus::Skipped => ActivityEventStatus::Skipped,
        TaskStatus::Cancelled => ActivityEventStatus::Cancelled,
        TaskStatus::Paused | TaskStatus::WaitingForUser => ActivityEventStatus::Interrupted,
        TaskStatus::Pending | TaskStatus::Ready | TaskStatus::Running => {
            ActivityEventStatus::Unknown
        }
        TaskStatus::VerificationFailed
        | TaskStatus::RepairPending
        | TaskStatus::RepairExhausted
        | TaskStatus::Failed => ActivityEventStatus::Failed,
    };
    let event = ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: event_id.clone(),
        event_type: ActivityEventKind::EvidenceCommitted,
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        task_id: Some(task.id.clone()),
        parent_task_id: None,
        agent_role: Some(task.role),
        effective_model: None,
        status,
        started_at: now,
        finished_at: Some(now),
        title: "Task evidence committed".to_string(),
        technical_details: None,
        path: None,
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

    let record = event_log
        .lock()
        .map_err(|_| anyhow::anyhow!("CodePro event log lock poisoned"))?
        .as_mut()
        .context("CodePro event log is unavailable while committing task evidence")?
        .append_with_text_artifact(&event, "task-evidence", payload)?;
    let artifact_ref = record
        .artifact_ref
        .context("committed task evidence is missing its artifact reference")?;
    Ok(vec![EvidenceRef::new(
        RunId::new(run_id.to_string())?,
        EventId::new(event_id)?,
        artifact_ref,
    )?])
}

#[allow(clippy::too_many_arguments)] // Preserve explicit evidence provenance at the commit boundary.
pub(crate) fn commit_main_agent_task_evidence(
    event_log: &Option<SharedCodeProEventLog>,
    session_id: &str,
    run_id: &str,
    task_id: &str,
    task_kind: &str,
    summary: &str,
    actions: &MainAgentActionEvidenceV1,
    coverage: &super::main_agent_contract::CoverageProposal,
) -> Result<Vec<EvidenceRef>> {
    let Some(event_log) = event_log else {
        return Ok(Vec::new());
    };

    let payload = serde_json::to_string_pretty(&MainAgentTaskEvidenceBundleV1 {
        schema_version: TASK_EVIDENCE_BUNDLE_SCHEMA_VERSION,
        run_id,
        task_id,
        task_kind,
        summary,
        actions,
        coverage,
    })
    .context("failed to serialize main Agent task evidence")?;

    let now = Utc::now();
    let task_hash = task_id
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    let event_id = format!(
        "main-agent-evidence-{task_hash:016x}-{}",
        now.timestamp_micros()
    );
    let event = ActivityEvent {
        schema_version: ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: event_id.clone(),
        event_type: ActivityEventKind::EvidenceCommitted,
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        task_id: Some(task_id.to_string()),
        parent_task_id: None,
        agent_role: None,
        effective_model: None,
        status: ActivityEventStatus::Completed,
        started_at: now,
        finished_at: Some(now),
        title: "Main Agent task evidence committed".to_string(),
        technical_details: None,
        path: None,
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

    let record = event_log
        .lock()
        .map_err(|_| anyhow::anyhow!("CodePro event log lock poisoned"))?
        .as_mut()
        .context("CodePro event log is unavailable while committing main Agent evidence")?
        .append_with_text_artifact(&event, "main-agent-task-evidence", payload)?;
    let artifact_ref = record
        .artifact_ref
        .context("committed main Agent evidence is missing its artifact reference")?;
    Ok(vec![EvidenceRef::new(
        RunId::new(run_id.to_string())?,
        EventId::new(event_id)?,
        artifact_ref,
    )?])
}

#[cfg(test)]
mod completion_feedback_tests {
    use super::*;

    #[tokio::test]
    async fn completion_feedback_ordinary_task_evidence_is_not_a_delegation() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let run_id = RunId::new("mixed-tasks")?;
        let task_id = crate::agents::protocol::TaskId::new("ordinary-task")?;
        let parent_id = crate::agents::protocol::TaskId::new("main-agent")?;
        let root = temp.path().join("events");
        let log = crate::agents::codepro_event_log::CodeProEventLog::open(
            root.join(run_id.as_str()).join("run/events.jsonl"),
        )?;
        let shared = Some(std::sync::Arc::new(std::sync::Mutex::new(Some(log))));
        let node = TaskNode {
            id: task_id.to_string(),
            name: "scheduler task".into(),
            description: "ordinary scheduler output".into(),
            role: crate::agents::AgentRole::Coder,
            depends_on: vec![],
            acceptance_criteria: "output".into(),
            status: TaskStatus::Done,
            output: None,
            retry_count: 0,
        };
        let evidence = commit_task_evidence(
            &shared,
            "parent-session",
            run_id.as_str(),
            1,
            TaskPurpose::Implementation,
            &node,
            &[],
        )?;
        let manager = crate::session::SessionManager::new(temp.path().join("sessions"));
        let path = root.join(run_id.as_str()).join("run/events.jsonl");
        let mut bytes = std::fs::read(&path)?;
        bytes.extend_from_slice(b"{\"partial");
        std::fs::write(&path, &bytes)?;
        assert!(load_delegated_session(
            &manager,
            &root,
            &run_id,
            ("parent-session", &parent_id),
            &task_id,
            &evidence[0]
        )
        .await?
        .is_none());
        assert_eq!(
            std::fs::read(path)?,
            bytes,
            "lookup must not recover another writer's journal"
        );
        Ok(())
    }
}
