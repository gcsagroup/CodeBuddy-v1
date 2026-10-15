use super::codepro_control_projection::{
    as_u32, bounded_effects, map_agent_role, map_agent_state, map_event, map_evidence,
    map_recovery_decision, map_run_state, map_task_state,
};
use super::GooseAcpAgent;
use crate::acp::custom_notifications::CodeProRunNotification;
use crate::acp::custom_requests::{
    CodeProAgentProjection, CodeProCoordinatorMode, CodeProCoordinatorProjection,
    CodeProEffectResolution, CodeProEffectResolveRequest, CodeProQualificationResult,
    CodeProRecoveryProjection, CodeProRunControlAction, CodeProRunControlRequest,
    CodeProRunControlResponse, CodeProRunGetRequest, CodeProRunSnapshot,
    CodeProRunSnapshotResponse, CodeProTaskProjection, CodeProUserRequirementProjection,
    CODEPRO_RUN_SCHEMA_VERSION,
};
use crate::agents::control_plane::{
    archive_legacy_runs, CodeProRuntime, CodeProRuntimeError, CodeProRuntimeMode,
    LegacyArchiveDisposition, RuntimeModePolicy, RuntimeSnapshot, UncertainEffectResolution,
    RUN_EVENT_LOG_FILE_NAME,
};
use crate::agents::protocol::{
    AgentId, ControlCommand, FailureClass, RunId, RunState, TaskId, TaskState,
};
use crate::agents::CodeProStateStore;
use crate::conversation::message::{SystemNotificationContent, SystemNotificationType};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const BINDING_SCHEMA_VERSION: u16 = 1;
const BINDING_FILE_NAME: &str = "binding.v1.json";
const MAX_RECENT_EVENTS: usize = 100;

#[derive(Clone)]
pub(super) struct CodeProControlService {
    root: PathBuf,
    runtime: CodeProRuntime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunBinding {
    schema_version: u16,
    session_id: String,
    run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_root: Option<PathBuf>,
    coordinator: CodeProCoordinatorProjection,
}

#[derive(Debug, Deserialize)]
struct TurnTerminalControlSignal {
    schema_version: u16,
    session_id: String,
    run_id: String,
    status: String,
    retry_strategy: String,
    #[serde(default)]
    report: Option<TurnTerminalControlReport>,
}

#[derive(Debug, Deserialize)]
struct TurnTerminalControlReport {
    outcome: String,
}

#[derive(Debug, thiserror::Error)]
pub(super) enum CodeProControlError {
    #[error("unsupported CodePro run schema version {0}")]
    UnsupportedSchema(u16),
    #[error("{0} must not be empty")]
    EmptyField(&'static str),
    #[error("CodePro run identifier is invalid: {0}")]
    InvalidRunId(String),
    #[error("CodePro task identifier is invalid: {0}")]
    InvalidTaskId(String),
    #[error("CodePro Agent identifier is invalid: {0}")]
    InvalidAgentId(String),
    #[error("CodePro run {0} is not registered for this session")]
    UnknownRun(String),
    #[error("CodePro run belongs to session {expected}, not {actual}")]
    SessionMismatch { expected: String, actual: String },
    #[error("CodePro run sequence is stale: expected {expected}, actual {actual}")]
    StaleSequence { expected: u64, actual: u64 },
    #[error("CodePro effect {0} is not awaiting an explicit resolution")]
    EffectNotUncertain(String),
    #[error("CodePro runtime failed: {0}")]
    Runtime(String),
    #[error("CodePro control data I/O failed at {path}: {message}")]
    Io { path: PathBuf, message: String },
    #[error("CodePro control data is invalid: {0}")]
    InvalidData(String),
}

impl CodeProControlService {
    pub(super) async fn new(
        root: impl Into<PathBuf>,
        audit_root: PathBuf,
    ) -> Result<Self, CodeProControlError> {
        let policy = RuntimeModePolicy::from_environment();
        let legacy_root = CodeProStateStore::default_location().ok();
        Self::new_with_policy_and_legacy_root(
            root.into(),
            policy,
            legacy_root.as_deref(),
            Some(audit_root),
        )
        .await
    }

    #[cfg(test)]
    async fn new_with_policy(
        root: impl Into<PathBuf>,
        policy: RuntimeModePolicy,
    ) -> Result<Self, CodeProControlError> {
        Self::new_with_policy_and_legacy_root(root.into(), policy, None, None).await
    }

    async fn new_with_policy_and_legacy_root(
        root: PathBuf,
        policy: RuntimeModePolicy,
        legacy_root: Option<&Path>,
        audit_root: Option<PathBuf>,
    ) -> Result<Self, CodeProControlError> {
        if let Some(legacy_root) = legacy_root {
            match archive_legacy_runs(legacy_root, &root) {
                Ok(report) => {
                    for archived in report.imports {
                        if archived.manifest.disposition == LegacyArchiveDisposition::ReadOnly {
                            tracing::warn!(
                                source_key = %archived.manifest.source_key,
                                warning_count = archived.manifest.warnings.len(),
                                "legacy CodePro run was preserved as a read-only archive"
                            );
                        }
                    }
                }
                Err(error) => tracing::warn!(
                    "legacy CodePro archive import was skipped without changing legacy data: {error}"
                ),
            }
        }
        let mut runtime = CodeProRuntime::initialize_production(root.clone(), policy)
            .await
            .map_err(map_runtime_error)?;
        if let Some(audit_root) = audit_root {
            runtime = runtime.with_tool_audit_root(audit_root);
        }
        if let Some(warning) = runtime.mode_policy().warning() {
            tracing::warn!("{warning}");
        }
        Ok(Self { root, runtime })
    }

    pub(super) fn runtime(&self) -> CodeProRuntime {
        self.runtime.clone()
    }

    /// Read-only provenance check, not an execution grant. Binding files remain
    /// private to this owner; evidence consumers must not reinterpret them.
    pub(super) fn verify_continuation_workspaces(
        &self,
        session_id: &str,
        current_run: &RunId,
        source_run: &RunId,
        workspace: &Path,
    ) -> Result<(), CodeProControlError> {
        if current_run == source_run {
            return Err(CodeProControlError::InvalidData(
                "a run cannot cite itself as a continuation".into(),
            ));
        }
        let workspace = workspace
            .canonicalize()
            .map_err(|error| io_error(workspace, error))?;
        for run in [current_run, source_run] {
            let binding = self.ensure_binding(session_id, run)?;
            if binding.workspace_root.as_ref() != Some(&workspace) {
                return Err(CodeProControlError::InvalidData(
                    "continuation workspace is missing or differs from the original binding".into(),
                ));
            }
        }
        Ok(())
    }

    pub(super) fn tracks_prompt_runs(&self) -> bool {
        self.runtime.mode_policy().effective() != CodeProRuntimeMode::Legacy
    }

    /// Find the durable run bound to this session and workspace. Never use the
    /// legacy CodeProStateStore as the identity source for a Main Agent run.
    pub(super) async fn prior_prompt_run_for_input(
        &self,
        session_id: &str,
        workspace_root: &Path,
    ) -> Result<Option<(String, String)>, CodeProControlError> {
        if !self.tracks_prompt_runs() {
            return Ok(None);
        }
        let workspace_root = workspace_root.canonicalize().map_err(|error| {
            CodeProControlError::InvalidData(format!(
                "session workspace cannot be resolved: {error}"
            ))
        })?;
        let entries = std::fs::read_dir(&self.root).map_err(|error| io_error(&self.root, error))?;
        let mut unfinished = Vec::new();
        let mut terminal = Vec::new();
        let mut unbound_workspace = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&self.root, error))?;
            let binding_path = entry.path().join(BINDING_FILE_NAME);
            if !binding_path.is_file() {
                continue;
            }
            let binding = read_binding(&binding_path)?;
            if binding.session_id != session_id {
                continue;
            }
            let run_id = parse_run_id(&binding.run_id)?;
            let snapshot = self
                .runtime
                .snapshot(session_id, &run_id)
                .await
                .map_err(map_runtime_error)?;
            if binding.workspace_root.is_none() {
                if !matches!(
                    snapshot.projection.state,
                    RunState::Completed | RunState::Failed | RunState::Cancelled
                ) {
                    unbound_workspace.push(binding.run_id);
                }
                continue;
            }
            if binding.workspace_root.as_deref() != Some(workspace_root.as_path()) {
                continue;
            }
            let candidate = (binding.run_id, snapshot.projection.goal);
            match snapshot.projection.state {
                RunState::Completed | RunState::Failed | RunState::Cancelled => {
                    let modified = std::fs::metadata(&binding_path)
                        .and_then(|metadata| metadata.modified())
                        .map_err(|error| io_error(&binding_path, error))?;
                    terminal.push((modified, candidate));
                }
                _ => unfinished.push(candidate),
            }
        }
        if unfinished.len() > 1 {
            return Err(CodeProControlError::InvalidData(format!(
                "session has multiple unfinished runs; choose an exact run before continuing: {}",
                unfinished
                    .iter()
                    .map(|(id, _)| id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        if !unbound_workspace.is_empty() {
            return Err(CodeProControlError::InvalidData(format!(
                "unfinished legacy run has no verified workspace binding; refuse automatic continuation: {}",
                unbound_workspace.join(", ")
            )));
        }
        if let Some(candidate) = unfinished.pop() {
            return Ok(Some(candidate));
        }
        terminal.sort_by_key(|(modified, _)| *modified);
        Ok(terminal.pop().map(|(_, candidate)| candidate))
    }

    /// Prefer an explicit association accepted on a previous user input. A
    /// copied/forked history still cannot claim a different session's run.
    pub(super) async fn bound_prompt_run_for_input(
        &self,
        session_id: &str,
        workspace_root: &Path,
        run_id: &str,
    ) -> Result<Option<(String, String)>, CodeProControlError> {
        let run = parse_run_id(run_id)?;
        let binding = read_binding(&self.binding_path(&run))?;
        let workspace_root = workspace_root
            .canonicalize()
            .map_err(|error| io_error(workspace_root, error))?;
        if binding.session_id != session_id
            || binding.workspace_root.as_deref() != Some(workspace_root.as_path())
        {
            return Ok(None);
        }
        let snapshot = self
            .runtime
            .snapshot(session_id, &run)
            .await
            .map_err(map_runtime_error)?;
        Ok(Some((run_id.to_owned(), snapshot.projection.goal)))
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub(super) async fn validate_workspace_confirmation_run(
        &self,
        session_id: &str,
        workspace_root: &Path,
        run_id: &str,
        source_message_id: &str,
    ) -> Result<(), CodeProControlError> {
        let run = parse_run_id(run_id)?;
        let binding = self.ensure_binding(session_id, &run)?;
        let workspace = workspace_root
            .canonicalize()
            .map_err(|e| io_error(workspace_root, e))?;
        if binding.workspace_root.as_deref() != Some(workspace.as_path())
            || binding.source_message_id.as_deref() != Some(source_message_id)
        {
            return Err(CodeProControlError::InvalidData(
                "Workspace confirmation does not match the original run binding".into(),
            ));
        }
        let snapshot = self
            .runtime
            .snapshot(session_id, &run)
            .await
            .map_err(map_runtime_error)?;
        if matches!(
            snapshot.projection.state,
            RunState::Completed
                | RunState::Cancelled
                | RunState::Failed
                | RunState::Fatal
                | RunState::Exhausted
                | RunState::Completing
        ) {
            return Err(CodeProControlError::InvalidData(
                "This run no longer accepts workspace confirmation".into(),
            ));
        }
        Ok(())
    }

    pub(super) async fn diagnostics_for_session(&self, session_id: &str) -> serde_json::Value {
        let mut runs = Vec::new();
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) => {
                return serde_json::json!({
                    "mode": format!("{:?}", self.runtime.mode_policy().effective()),
                    "runs": [],
                    "error": error.to_string(),
                });
            }
        };
        for entry in entries.flatten() {
            let binding_path = entry.path().join(BINDING_FILE_NAME);
            if !binding_path.is_file() {
                continue;
            }
            let Ok(binding) = read_binding(&binding_path) else {
                continue;
            };
            if binding.session_id != session_id {
                continue;
            }
            let Ok(run_id) = parse_run_id(&binding.run_id) else {
                continue;
            };
            let snapshot = match self.runtime.snapshot(session_id, &run_id).await {
                Ok(runtime) => self.build_snapshot(session_id, &run_id, runtime).ok(),
                Err(_) => None,
            };
            let ledger_path = entry.path().join(RUN_EVENT_LOG_FILE_NAME);
            let ledger = ledger_path.metadata().ok().map(|metadata| {
                serde_json::json!({
                    "path": ledger_path.display().to_string(),
                    "bytes": metadata.len(),
                })
            });
            runs.push(serde_json::json!({
                "bindingPath": binding_path.display().to_string(),
                "binding": binding,
                "eventLedger": ledger,
                "snapshot": snapshot,
                "source": "durable_control_plane",
            }));
        }
        serde_json::json!({
            "mode": format!("{:?}", self.runtime.mode_policy().effective()),
            "runs": runs,
            "truncation": {
                "recentEventsPerRun": MAX_RECENT_EVENTS,
                "completeLedgerStoredSeparately": true,
            },
        })
    }

    pub(super) async fn snapshot_if_available(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<CodeProRunSnapshot>, CodeProControlError> {
        if !self.tracks_prompt_runs() {
            return Ok(None);
        }
        let run_id = parse_run_id(run_id)?;
        self.ensure_binding(session_id, &run_id)?;
        let runtime = match self.runtime.snapshot(session_id, &run_id).await {
            Ok(snapshot) => snapshot,
            Err(CodeProRuntimeError::UnknownRun(_)) => return Ok(None),
            Err(error) => return Err(map_runtime_error(error)),
        };
        self.build_snapshot(session_id, &run_id, runtime).map(Some)
    }

    pub(super) async fn pause_prompt_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        let run_id = parse_run_id(run_id)?;
        self.ensure_binding(session_id, &run_id)?;
        let snapshot = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        if !matches!(
            snapshot.projection.state,
            RunState::Paused | RunState::Completed | RunState::Failed | RunState::Cancelled
        ) {
            if let Err(error) = self
                .runtime
                .control(
                    session_id,
                    ControlCommand::PauseRun {
                        run_id: run_id.clone(),
                        reason: "Prompt execution stopped by the user".to_string(),
                    },
                    None,
                )
                .await
            {
                // The execution may have completed while Stop was admitted.
                // A terminal outcome wins; other control errors remain errors.
                let latest = self
                    .runtime
                    .snapshot(session_id, &run_id)
                    .await
                    .map_err(map_runtime_error)?;
                if matches!(
                    latest.projection.state,
                    RunState::Paused | RunState::Completed | RunState::Failed | RunState::Cancelled
                ) {
                    return self.build_snapshot(session_id, &run_id, latest);
                }
                return Err(map_runtime_error(error));
            }
        }
        let snapshot = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(session_id, &run_id, snapshot)
    }

    pub(super) async fn cancel_prompt_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<CodeProRunSnapshot>, CodeProControlError> {
        if !self.tracks_prompt_runs() {
            return Ok(None);
        }
        let run_id = parse_run_id(run_id)?;
        self.ensure_binding(session_id, &run_id)?;
        let runtime = match self.runtime.snapshot(session_id, &run_id).await {
            Ok(snapshot) => snapshot,
            Err(CodeProRuntimeError::UnknownRun(_)) => return Ok(None),
            Err(error) => return Err(map_runtime_error(error)),
        };
        if matches!(
            runtime.projection.state,
            crate::agents::protocol::RunState::Completed
                | crate::agents::protocol::RunState::Failed
                | crate::agents::protocol::RunState::Cancelled
        ) {
            return self.build_snapshot(session_id, &run_id, runtime).map(Some);
        }
        self.runtime
            .control(
                session_id,
                ControlCommand::EmergencyStop {
                    run_id: run_id.clone(),
                    reason: "Prompt cancelled by the user".to_string(),
                },
                None,
            )
            .await
            .map_err(map_runtime_error)?;
        let runtime = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(session_id, &run_id, runtime).map(Some)
    }

    pub(super) async fn fail_prompt_run(
        &self,
        session_id: &str,
        run_id: &str,
        message: &str,
    ) -> Result<Option<CodeProRunSnapshot>, CodeProControlError> {
        if !self.tracks_prompt_runs() {
            return Ok(None);
        }
        let run_id = parse_run_id(run_id)?;
        self.ensure_binding(session_id, &run_id)?;
        let runtime = match self.runtime.snapshot(session_id, &run_id).await {
            Ok(snapshot) => snapshot,
            Err(CodeProRuntimeError::UnknownRun(_)) => return Ok(None),
            Err(error) => return Err(map_runtime_error(error)),
        };
        if matches!(
            runtime.projection.state,
            crate::agents::protocol::RunState::Completed
                | crate::agents::protocol::RunState::Failed
                | crate::agents::protocol::RunState::Cancelled
        ) {
            return self.build_snapshot(session_id, &run_id, runtime).map(Some);
        }
        self.runtime
            .control(
                session_id,
                ControlCommand::FailRun {
                    run_id: run_id.clone(),
                    class: FailureClass::TransientInfrastructure,
                    message: bounded_failure_message(message),
                    evidence_refs: vec![],
                },
                None,
            )
            .await
            .map_err(map_runtime_error)?;
        let runtime = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(session_id, &run_id, runtime).map(Some)
    }

    pub(super) async fn observe_prompt_turn_terminal(
        &self,
        session_id: &str,
        run_id: &str,
        notification: &SystemNotificationContent,
    ) -> Result<Option<CodeProRunSnapshot>, CodeProControlError> {
        if !self.tracks_prompt_runs()
            || notification.notification_type != SystemNotificationType::TurnTerminal
        {
            return Ok(None);
        }
        let Some(data) = notification.data.as_ref() else {
            return Ok(None);
        };
        let signal: TurnTerminalControlSignal = serde_json::from_value(data.clone())
            .map_err(|error| CodeProControlError::InvalidData(error.to_string()))?;
        if signal.schema_version != 1 || signal.session_id != session_id || signal.run_id != run_id
        {
            return Err(CodeProControlError::InvalidData(
                "turn terminal control identity does not match the active run".to_string(),
            ));
        }
        let should_pause = signal.status == "interrupted"
            && (matches!(
                signal.retry_strategy.as_str(),
                "replay_user_request" | "continue_checkpoint"
            ) || signal.report.as_ref().is_some_and(|report| {
                matches!(report.outcome.as_str(), "waiting_for_user" | "paused")
            }));
        if !should_pause {
            return Ok(None);
        }

        let run_id = parse_run_id(run_id)?;
        self.ensure_binding(session_id, &run_id)?;
        let current = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        if matches!(
            current.projection.state,
            crate::agents::protocol::RunState::Paused
                | crate::agents::protocol::RunState::WaitingForUser
                | crate::agents::protocol::RunState::Completed
                | crate::agents::protocol::RunState::Failed
                | crate::agents::protocol::RunState::Cancelled
        ) {
            return self.build_snapshot(session_id, &run_id, current).map(Some);
        }
        if !matches!(
            current.projection.state,
            crate::agents::protocol::RunState::Planning
                | crate::agents::protocol::RunState::Running
                | crate::agents::protocol::RunState::Recovering
        ) {
            return Ok(None);
        }

        self.runtime
            .control(
                session_id,
                ControlCommand::PauseRun {
                    run_id: run_id.clone(),
                    reason: notification.msg.clone(),
                },
                None,
            )
            .await
            .map_err(map_runtime_error)?;
        let paused = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(session_id, &run_id, paused).map(Some)
    }

    #[cfg(test)]
    async fn create_run(
        &self,
        session_id: &str,
        run_id: &str,
        goal: &str,
        coordinator: CodeProCoordinatorProjection,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        require_text("sessionId", session_id)?;
        require_text("goal", goal)?;
        let run_id = parse_run_id(run_id)?;
        self.write_or_verify_binding(&RunBinding {
            schema_version: BINDING_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            source_message_id: None,
            workspace_root: None,
            coordinator,
        })?;
        let snapshot = self
            .runtime
            .create_or_verify_run(session_id, run_id.clone(), goal)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(session_id, &run_id, snapshot)
    }

    #[cfg(test)]
    pub(super) async fn register_prompt_run(
        &self,
        session_id: &str,
        run_id: &str,
        goal: &str,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        self.register_prompt_run_with_source(session_id, run_id, goal, None, None)
            .await
    }

    #[cfg(test)]
    pub(super) async fn register_prompt_run_with_source(
        &self,
        session_id: &str,
        run_id: &str,
        goal: &str,
        source_message_id: Option<&str>,
        workspace_root: Option<&Path>,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        self.register_prompt_run_with_origin(
            session_id,
            run_id,
            goal,
            source_message_id,
            workspace_root,
            None,
        )
        .await
    }

    pub(super) async fn register_prompt_run_with_origin(
        &self,
        session_id: &str,
        run_id: &str,
        goal: &str,
        source_message_id: Option<&str>,
        workspace_root: Option<&Path>,
        continuation_source: Option<crate::agents::protocol::RequirementContinuationSource>,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        require_text("sessionId", session_id)?;
        require_text("goal", goal)?;
        if let Some(source_message_id) = source_message_id {
            require_text("sourceMessageId", source_message_id)?;
        }
        let workspace_root = workspace_root
            .map(|root| {
                root.canonicalize().map_err(|error| {
                    CodeProControlError::InvalidData(format!(
                        "run workspace cannot be resolved: {error}"
                    ))
                })
            })
            .transpose()?;
        if let Some(source) = &continuation_source {
            let source_id = parse_run_id(&source.run_id)?;
            let source_binding = self.ensure_binding(session_id, &source_id)?;
            if workspace_root.is_none() || source_binding.workspace_root != workspace_root {
                return Err(CodeProControlError::InvalidData(
                    "continuation source belongs to a different workspace".to_string(),
                ));
            }
            let source_snapshot = self
                .runtime
                .snapshot(session_id, &source_id)
                .await
                .map_err(map_runtime_error)?;
            if source_snapshot.projection.user_requirement_revision != source.requirement_revision
                || !matches!(
                    source_snapshot.projection.state,
                    RunState::Completed | RunState::Failed | RunState::Cancelled
                )
            {
                return Err(CodeProControlError::InvalidData(
                    "continuation source is not the verified terminal contract".to_string(),
                ));
            }
        }
        let run_id = parse_run_id(run_id)?;
        if continuation_source
            .as_ref()
            .is_some_and(|source| source.run_id == run_id.as_str())
        {
            return Err(CodeProControlError::InvalidData(
                "a run cannot continue itself as a new run".to_string(),
            ));
        }
        self.write_or_verify_binding(&RunBinding {
            schema_version: BINDING_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            source_message_id: source_message_id.map(str::to_string),
            workspace_root,
            coordinator: self.coordinator_projection(),
        })?;
        let mut snapshot = self
            .runtime
            .create_or_verify_run(session_id, run_id.clone(), goal)
            .await
            .map_err(map_runtime_error)?;
        if snapshot.projection.user_requirement_revision == 0 {
            let source_message_id = source_message_id
                .map(str::to_string)
                .unwrap_or_else(|| format!("run:{}", run_id));
            self.runtime
                .control(
                    session_id,
                    ControlCommand::CommitUserRequirements {
                        run_id: run_id.clone(),
                        revision: 1,
                        requirements: vec![crate::agents::protocol::UserRequirement {
                            requirement_id: crate::agents::control_plane::ROOT_USER_REQUIREMENT_ID
                                .to_string(),
                            source_message_id,
                            continuation_source: continuation_source.clone(),
                            semantics: Some(crate::agents::protocol::RequirementSemantics {
                                content: goal.to_string(),
                                expected_effect: None,
                                target_resources: Vec::new(),
                                revision_relation: None,
                            }),
                            execution_obligations: Vec::new(),
                        }],
                    },
                    Some(snapshot.projection.last_sequence),
                )
                .await
                .map_err(map_runtime_error)?;
            snapshot = self
                .runtime
                .snapshot(session_id, &run_id)
                .await
                .map_err(map_runtime_error)?;
        } else if continuation_source.is_some()
            && snapshot
                .projection
                .user_requirements
                .get(crate::agents::control_plane::ROOT_USER_REQUIREMENT_ID)
                .and_then(|requirement| requirement.continuation_source.as_ref())
                != continuation_source.as_ref()
        {
            return Err(CodeProControlError::InvalidData(
                "registered run has a different continuation source".to_string(),
            ));
        }
        self.build_snapshot(session_id, &run_id, snapshot)
    }

    pub(super) async fn resume_prompt_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        require_text("sessionId", session_id)?;
        let run_id = parse_run_id(run_id)?;
        let binding = self.ensure_binding(session_id, &run_id)?;
        let current = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        if current.projection.user_requirement_revision == 0 {
            return self
                .register_prompt_run_with_origin(
                    session_id,
                    run_id.as_str(),
                    &current.projection.goal,
                    binding.source_message_id.as_deref(),
                    binding.workspace_root.as_deref(),
                    None,
                )
                .await;
        }
        if matches!(
            current.projection.state,
            RunState::Planning | RunState::Recovering
        ) {
            return self.build_snapshot(session_id, &run_id, current);
        }
        if matches!(
            current.projection.state,
            RunState::Cancelled | RunState::Completed | RunState::Failed
        ) {
            return Err(CodeProControlError::InvalidData(format!(
                "run {run_id} is terminal and cannot be resumed"
            )));
        }
        if current.projection.state == RunState::Paused {
            let unresolved = current
                .projection
                .tasks
                .iter()
                .filter(|(_, task)| {
                    task.state == TaskState::Running
                        || matches!(
                            task.latest_outcome.as_ref(),
                            Some(crate::agents::protocol::WorkerOutcome::Paused(_))
                        )
                })
                .map(|(task_id, _)| task_id.to_string())
                .collect::<Vec<_>>();
            if !unresolved.is_empty() {
                return Err(CodeProControlError::InvalidData(format!(
                    "paused run {run_id} has delegated outcomes or effects requiring reconciliation before resume: {}",
                    unresolved.join(", ")
                )));
            }
        }
        self.runtime
            .control(
                session_id,
                ControlCommand::ResumeRun {
                    run_id: run_id.clone(),
                },
                None,
            )
            .await
            .map_err(map_runtime_error)?;
        let snapshot = self
            .runtime
            .snapshot(session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(session_id, &run_id, snapshot)
    }

    fn coordinator_projection(&self) -> CodeProCoordinatorProjection {
        let runtime_mode = self.runtime.mode_policy().effective();
        let (requested_mode, effective_mode, reason) = match runtime_mode {
            CodeProRuntimeMode::Legacy => (
                CodeProCoordinatorMode::Off,
                CodeProCoordinatorMode::Off,
                "CodePro legacy runtime is active",
            ),
            CodeProRuntimeMode::Shadow => (
                CodeProCoordinatorMode::Shadow,
                CodeProCoordinatorMode::Shadow,
                "CodePro Coordinator records decisions without controlling execution",
            ),
            CodeProRuntimeMode::Durable => (
                CodeProCoordinatorMode::Shadow,
                CodeProCoordinatorMode::Shadow,
                "The durable host controls execution; Coordinator remains observational until qualification",
            ),
        };
        CodeProCoordinatorProjection {
            requested_mode,
            effective_mode,
            qualification: CodeProQualificationResult::NotRequired,
            reason: reason.to_string(),
        }
    }

    pub(super) async fn get(
        &self,
        request: &CodeProRunGetRequest,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        validate_request(request.schema_version, &request.session_id)?;
        let run_id = parse_run_id(&request.run_id)?;
        self.ensure_binding(&request.session_id, &run_id)?;
        let snapshot = self
            .runtime
            .snapshot(&request.session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(&request.session_id, &run_id, snapshot)
    }

    pub(super) async fn control(
        &self,
        request: &CodeProRunControlRequest,
    ) -> Result<CodeProRunControlResponse, CodeProControlError> {
        validate_request(request.schema_version, &request.session_id)?;
        require_text("commandId", &request.command_id)?;
        let run_id = parse_run_id(&request.run_id)?;
        self.ensure_binding(&request.session_id, &run_id)?;
        let command = map_command(&run_id, &request.action)?;
        let receipt = self
            .runtime
            .control(&request.session_id, command, request.expected_sequence)
            .await
            .map_err(map_runtime_error)?;
        let previous_sequence = receipt.append().previous_sequence;
        let committed_event_ids = receipt
            .committed_events()
            .iter()
            .map(|event| event.event_id.to_string())
            .collect();
        let runtime_snapshot = self
            .runtime
            .snapshot(&request.session_id, &run_id)
            .await
            .map_err(map_runtime_error)?;
        let snapshot = self.build_snapshot(&request.session_id, &run_id, runtime_snapshot)?;
        Ok(CodeProRunControlResponse {
            command_id: request.command_id.clone(),
            previous_sequence,
            committed_event_ids,
            snapshot,
        })
    }

    pub(super) async fn resolve_effect(
        &self,
        request: &CodeProEffectResolveRequest,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        validate_request(request.schema_version, &request.session_id)?;
        require_text("effectId", &request.effect_id)?;
        let run_id = parse_run_id(&request.run_id)?;
        self.ensure_binding(&request.session_id, &run_id)?;
        let resolution = match request.resolution {
            CodeProEffectResolution::ConfirmedApplied => {
                UncertainEffectResolution::ConfirmedApplied
            }
            CodeProEffectResolution::ConfirmedNotApplied => {
                UncertainEffectResolution::ConfirmedNotApplied
            }
        };
        let snapshot = self
            .runtime
            .resolve_uncertain(&request.session_id, &run_id, &request.effect_id, resolution)
            .await
            .map_err(map_runtime_error)?;
        self.build_snapshot(&request.session_id, &run_id, snapshot)
    }

    fn build_snapshot(
        &self,
        session_id: &str,
        run_id: &RunId,
        runtime: RuntimeSnapshot,
    ) -> Result<CodeProRunSnapshot, CodeProControlError> {
        let binding = self.ensure_binding(session_id, run_id)?;
        let RuntimeSnapshot {
            projection,
            recovery: report,
            events,
            ..
        } = runtime;
        let recovery = CodeProRecoveryProjection {
            truncated_event_bytes: report.event_log.truncated_bytes,
            truncated_effect_bytes: report.effect_ledger.truncated_bytes,
            pending_effects: as_u32(report.pending.len()),
            uncertain_effects: as_u32(report.uncertain.len()),
            abandoned_effects: as_u32(report.abandoned.len()),
        };
        let effects = bounded_effects(report);
        let current_graph = projection.current_task_graph().ok();
        Ok(CodeProRunSnapshot {
            schema_version: CODEPRO_RUN_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            state: map_run_state(projection.state),
            goal: projection.goal,
            user_requirement_revision: projection.user_requirement_revision,
            user_requirements: projection
                .user_requirements
                .iter()
                .map(
                    |(requirement_id, requirement)| CodeProUserRequirementProjection {
                        requirement_id: requirement_id.clone(),
                        source_message_id: requirement.source_message_id.clone(),
                        evidence_ids: projection
                            .completion_requirement_evidence
                            .get(requirement_id)
                            .into_iter()
                            .flatten()
                            .map(|evidence| evidence.event_id().to_string())
                            .collect(),
                    },
                )
                .collect(),
            plan_revision: projection.plan_revision,
            last_sequence: projection.last_sequence,
            tasks: projection
                .tasks
                .into_iter()
                .map(|(task_id, task)| CodeProTaskProjection {
                    in_current_plan: current_graph
                        .as_ref()
                        .map(|graph| graph.contains_task(&task_id)),
                    task_id: task_id.to_string(),
                    name: task.name,
                    state: map_task_state(task.state),
                    retry_attempts: task.retry_attempts,
                    result_summary: task.result.as_ref().map(|result| result.summary.clone()),
                    failure_message: task.failure.as_ref().map(|failure| failure.message.clone()),
                    recovery_decision: task.latest_recovery_decision.map(map_recovery_decision),
                    evidence: task
                        .result
                        .iter()
                        .flat_map(|result| result.evidence_refs.iter())
                        .chain(
                            task.failure
                                .iter()
                                .flat_map(|failure| failure.evidence_refs.iter()),
                        )
                        .map(map_evidence)
                        .collect(),
                })
                .collect(),
            agents: projection
                .agents
                .into_iter()
                .map(|(agent_id, agent)| CodeProAgentProjection {
                    agent_id: agent_id.to_string(),
                    task_id: agent.task_id.map(|task_id| task_id.to_string()),
                    role: map_agent_role(agent.role),
                    state: map_agent_state(agent.state),
                })
                .collect(),
            recent_events: events
                .iter()
                .rev()
                .take(MAX_RECENT_EVENTS)
                .rev()
                .map(map_event)
                .collect(),
            effects,
            coordinator: binding.coordinator,
            recovery,
        })
    }

    fn binding_path(&self, run_id: &RunId) -> PathBuf {
        self.root.join(run_id.as_str()).join(BINDING_FILE_NAME)
    }

    fn write_or_verify_binding(&self, binding: &RunBinding) -> Result<(), CodeProControlError> {
        let run_id = parse_run_id(&binding.run_id)?;
        let path = self.binding_path(&run_id);
        if path.exists() {
            let existing = read_binding(&path)?;
            return if existing == *binding {
                Ok(())
            } else {
                Err(CodeProControlError::InvalidData(
                    "run binding is immutable".to_string(),
                ))
            };
        }
        let parent = path.parent().expect("binding path has a parent");
        std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| io_error(&path, error))?;
        serde_json::to_writer(&mut file, binding)
            .map_err(|error| CodeProControlError::InvalidData(error.to_string()))?;
        file.write_all(b"\n")
            .map_err(|error| io_error(&path, error))?;
        file.flush().map_err(|error| io_error(&path, error))?;
        file.sync_all().map_err(|error| io_error(&path, error))
    }

    fn ensure_binding(
        &self,
        session_id: &str,
        run_id: &RunId,
    ) -> Result<RunBinding, CodeProControlError> {
        let path = self.binding_path(run_id);
        if !path.is_file() {
            return Err(CodeProControlError::UnknownRun(run_id.to_string()));
        }
        let binding = read_binding(&path)?;
        if binding.schema_version != BINDING_SCHEMA_VERSION || binding.run_id != run_id.as_str() {
            return Err(CodeProControlError::InvalidData(
                "run binding identity or schema version is invalid".to_string(),
            ));
        }
        if binding.session_id != session_id {
            return Err(CodeProControlError::SessionMismatch {
                expected: binding.session_id,
                actual: session_id.to_string(),
            });
        }
        Ok(binding)
    }
}

impl GooseAcpAgent {
    pub(super) async fn send_latest_codepro_update(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<bool, agent_client_protocol::Error> {
        let snapshot = match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.codepro_control
                .snapshot_if_available(session_id, run_id),
        )
        .await
        {
            Ok(result) => result.map_err(acp_error)?,
            Err(_) => {
                tracing::warn!(
                    session_id,
                    run_id,
                    "CodePro control snapshot refresh exceeded five seconds; preserving the live message stream"
                );
                return Ok(false);
            }
        };
        let Some(snapshot) = snapshot else {
            return Ok(false);
        };
        self.send_codepro_update(snapshot)?;
        Ok(true)
    }

    pub(super) async fn on_codepro_run_get(
        &self,
        request: CodeProRunGetRequest,
    ) -> Result<CodeProRunSnapshotResponse, agent_client_protocol::Error> {
        let snapshot = self
            .codepro_control
            .get(&request)
            .await
            .map_err(acp_error)?;
        Ok(CodeProRunSnapshotResponse { snapshot })
    }

    pub(super) async fn on_codepro_run_control(
        &self,
        request: CodeProRunControlRequest,
    ) -> Result<CodeProRunControlResponse, agent_client_protocol::Error> {
        let prompt_stop_reason = match &request.action {
            CodeProRunControlAction::PauseRun { .. } => super::ActivePromptStopReason::ControlPause,
            CodeProRunControlAction::EmergencyStop { .. } => {
                super::ActivePromptStopReason::ControlEmergencyStop
            }
            _ => super::ActivePromptStopReason::None,
        };
        let response = self
            .codepro_control
            .control(&request)
            .await
            .map_err(acp_error)?;
        if prompt_stop_reason != super::ActivePromptStopReason::None {
            let interrupted = {
                let mut active_prompt_runs = self.active_prompt_runs.lock().await;
                super::stop_active_run(
                    &mut active_prompt_runs,
                    &request.session_id,
                    Some(&request.run_id),
                    prompt_stop_reason,
                )
            };
            tracing::info!(
                session_id = %request.session_id,
                run_id = %request.run_id,
                interrupted,
                ?prompt_stop_reason,
                "committed run control propagated to the matching prompt loop"
            );
        }
        self.send_codepro_update(response.snapshot.clone())?;
        Ok(response)
    }

    pub(super) async fn on_codepro_effect_resolve(
        &self,
        request: CodeProEffectResolveRequest,
    ) -> Result<CodeProRunSnapshotResponse, agent_client_protocol::Error> {
        let snapshot = self
            .codepro_control
            .resolve_effect(&request)
            .await
            .map_err(acp_error)?;
        self.send_codepro_update(snapshot.clone())?;
        Ok(CodeProRunSnapshotResponse { snapshot })
    }

    pub(super) fn send_codepro_update(
        &self,
        snapshot: CodeProRunSnapshot,
    ) -> Result<(), agent_client_protocol::Error> {
        if !self.supports_goose_custom_notifications() {
            return Ok(());
        }
        if let Some(cx) = self.client_cx.get() {
            cx.send_notification(CodeProRunNotification { snapshot })?;
        }
        Ok(())
    }
}

fn validate_request(schema_version: u16, session_id: &str) -> Result<(), CodeProControlError> {
    if schema_version != CODEPRO_RUN_SCHEMA_VERSION {
        return Err(CodeProControlError::UnsupportedSchema(schema_version));
    }
    require_text("sessionId", session_id)
}

fn require_text(field: &'static str, value: &str) -> Result<(), CodeProControlError> {
    if value.trim().is_empty() {
        Err(CodeProControlError::EmptyField(field))
    } else {
        Ok(())
    }
}

fn bounded_failure_message(message: &str) -> String {
    const MAX_BYTES: usize = 4_096;
    let message = message.trim();
    if message.is_empty() {
        return "ACP agent response stream failed".to_string();
    }
    if message.len() <= MAX_BYTES {
        return message.to_string();
    }
    let mut end = MAX_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message
        .get(..end)
        .expect("end was moved to a UTF-8 boundary")
        .to_string()
}

fn parse_run_id(value: &str) -> Result<RunId, CodeProControlError> {
    RunId::new(value).map_err(|error| CodeProControlError::InvalidRunId(error.to_string()))
}

fn map_command(
    run_id: &RunId,
    action: &CodeProRunControlAction,
) -> Result<ControlCommand, CodeProControlError> {
    Ok(match action {
        CodeProRunControlAction::StopWorker { agent_id, reason } => ControlCommand::StopWorker {
            run_id: run_id.clone(),
            agent_id: AgentId::new(agent_id)
                .map_err(|error| CodeProControlError::InvalidAgentId(error.to_string()))?,
            reason: reason.clone(),
        },
        CodeProRunControlAction::CancelTask { task_id, reason } => ControlCommand::CancelTask {
            run_id: run_id.clone(),
            task_id: TaskId::new(task_id)
                .map_err(|error| CodeProControlError::InvalidTaskId(error.to_string()))?,
            reason: reason.clone(),
        },
        CodeProRunControlAction::CancelBranch {
            root_task_id,
            reason,
        } => ControlCommand::CancelBranch {
            run_id: run_id.clone(),
            root_task_id: TaskId::new(root_task_id)
                .map_err(|error| CodeProControlError::InvalidTaskId(error.to_string()))?,
            reason: reason.clone(),
        },
        CodeProRunControlAction::PauseRun { reason } => ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: reason.clone(),
        },
        CodeProRunControlAction::ResumeRun {} => ControlCommand::ResumeRun {
            run_id: run_id.clone(),
        },
        CodeProRunControlAction::EmergencyStop { reason } => ControlCommand::EmergencyStop {
            run_id: run_id.clone(),
            reason: reason.clone(),
        },
    })
}

fn read_binding(path: &Path) -> Result<RunBinding, CodeProControlError> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| io_error(path, error))?
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(path, error))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| CodeProControlError::InvalidData(error.to_string()))
}

fn io_error(path: impl AsRef<Path>, error: std::io::Error) -> CodeProControlError {
    CodeProControlError::Io {
        path: path.as_ref().to_path_buf(),
        message: error.to_string(),
    }
}

pub(super) fn acp_error(error: CodeProControlError) -> agent_client_protocol::Error {
    match error {
        CodeProControlError::UnsupportedSchema(_)
        | CodeProControlError::EmptyField(_)
        | CodeProControlError::InvalidRunId(_)
        | CodeProControlError::InvalidTaskId(_)
        | CodeProControlError::InvalidAgentId(_)
        | CodeProControlError::UnknownRun(_)
        | CodeProControlError::SessionMismatch { .. }
        | CodeProControlError::StaleSequence { .. }
        | CodeProControlError::EffectNotUncertain(_) => {
            agent_client_protocol::Error::invalid_params().data(error.to_string())
        }
        _ => agent_client_protocol::Error::internal_error().data(error.to_string()),
    }
}

fn map_runtime_error(error: CodeProRuntimeError) -> CodeProControlError {
    match error {
        CodeProRuntimeError::EmptyField(field) => CodeProControlError::EmptyField(field),
        CodeProRuntimeError::UnknownRun(run_id) => CodeProControlError::UnknownRun(run_id),
        CodeProRuntimeError::SessionMismatch { expected, actual } => {
            CodeProControlError::SessionMismatch { expected, actual }
        }
        CodeProRuntimeError::StaleSequence { expected, actual } => {
            CodeProControlError::StaleSequence { expected, actual }
        }
        CodeProRuntimeError::EffectNotUncertain(effect_id) => {
            CodeProControlError::EffectNotUncertain(effect_id)
        }
        other => CodeProControlError::Runtime(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::custom_requests::{CodeProEffectState, CodeProRunState};
    use crate::agents::control_plane::{
        DurableEffectState, EffectLedger, FileEffectLedger, FileRunEventStore, RunEventStore,
        RunRecovery,
    };
    use crate::agents::protocol::{AgentState, PlannedTask, TaskResult, TaskState, WorkerOutcome};

    async fn service(root: &Path) -> CodeProControlService {
        CodeProControlService::new_with_policy(root, RuntimeModePolicy::parse(Some("legacy")))
            .await
            .unwrap()
    }

    fn coordinator() -> CodeProCoordinatorProjection {
        CodeProCoordinatorProjection {
            requested_mode: CodeProCoordinatorMode::Authoritative,
            effective_mode: CodeProCoordinatorMode::Shadow,
            qualification: CodeProQualificationResult::Missing,
            reason: "No exact live qualification record".to_string(),
        }
    }

    #[test]
    fn bounded_failure_message_does_not_split_multibyte_characters() {
        let prefix = "a".repeat(4_094);
        let message = format!("{prefix}中🙂tail");

        assert_eq!(bounded_failure_message(&message), prefix);
    }

    #[tokio::test]
    async fn production_startup_archives_legacy_data_without_registering_it_as_a_live_run() {
        let temp = tempfile::tempdir().unwrap();
        let legacy_root = temp.path().join("legacy");
        let control_root = temp.path().join("control");
        let legacy_run = legacy_root.join("legacy-run-1").join("run");
        std::fs::create_dir_all(&legacy_run).unwrap();
        std::fs::write(legacy_run.join("events.jsonl"), b"{incomplete").unwrap();

        let service = CodeProControlService::new_with_policy_and_legacy_root(
            control_root.clone(),
            RuntimeModePolicy::parse(Some("legacy")),
            Some(&legacy_root),
            None,
        )
        .await
        .unwrap();

        assert!(control_root
            .join(crate::agents::control_plane::LEGACY_ARCHIVE_DIRECTORY_NAME)
            .join("legacy-run-1")
            .join(crate::agents::control_plane::LEGACY_ARCHIVE_MANIFEST_FILE_NAME)
            .is_file());
        assert!(service
            .runtime
            .snapshot("legacy-run-1", &RunId::new("legacy-run-1").unwrap())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn legacy_prompt_lifecycle_ignores_unregistered_durable_runs() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path()).await;

        assert!(service
            .snapshot_if_available("session-1", "run-legacy-prompt")
            .await
            .unwrap()
            .is_none());
        assert!(service
            .cancel_prompt_run("session-1", "run-legacy-prompt")
            .await
            .unwrap()
            .is_none());
        assert!(service
            .fail_prompt_run("session-1", "run-legacy-prompt", "stream failed")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn shadow_prompt_lifecycle_rejects_an_unregistered_run() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("shadow")),
        )
        .await
        .unwrap();

        let error = service
            .snapshot_if_available("session-1", "run-shadow-prompt")
            .await
            .unwrap_err();

        assert!(matches!(error, CodeProControlError::UnknownRun(_)));
    }

    #[tokio::test]
    async fn read_only_get_does_not_append_events() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path()).await;
        service
            .create_run("session-1", "run-1", "Fix the bug", coordinator())
            .await
            .unwrap();
        let path =
            FileRunEventStore::new(temp.path()).event_log_path(&RunId::new("run-1").unwrap());
        let before = std::fs::read(&path).unwrap();

        let snapshot = service
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-1".to_string(),
            })
            .await
            .unwrap();

        assert_eq!(snapshot.last_sequence, 1);
        assert_eq!(
            snapshot.coordinator.effective_mode,
            CodeProCoordinatorMode::Shadow
        );
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[tokio::test]
    async fn cross_runtime_read_only_get_refreshes_external_events() {
        let temp = tempfile::tempdir().unwrap();
        let writer = service(temp.path()).await;
        let reader = service(temp.path()).await;
        writer
            .create_run(
                "session-1",
                "run-cross-runtime",
                "Fix the bug",
                coordinator(),
            )
            .await
            .unwrap();
        writer
            .runtime
            .install_plan(
                "session-1",
                RunId::new("run-cross-runtime").unwrap(),
                1,
                vec![PlannedTask {
                    task_id: TaskId::new("task-1").unwrap(),
                    name: "Repair and retest".to_string(),
                    role: Some(crate::agents::AgentRole::Tester),
                    depends_on: vec![],
                }],
            )
            .await
            .unwrap();

        let intermediate = reader
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-cross-runtime".to_string(),
            })
            .await
            .unwrap();
        assert!(intermediate.last_sequence > 1);
        assert_eq!(intermediate.state, CodeProRunState::Running);

        let task_id = TaskId::new("task-1").unwrap();
        let agent_id = AgentId::new("tester-1").unwrap();
        writer
            .runtime
            .start_task(
                "session-1",
                RunId::new("run-cross-runtime").unwrap(),
                task_id.clone(),
            )
            .await
            .unwrap();
        let (_, handle) = writer
            .runtime
            .register_worker(
                "session-1",
                RunId::new("run-cross-runtime").unwrap(),
                task_id,
                agent_id,
                crate::agents::AgentRole::Tester,
            )
            .await
            .unwrap();
        writer
            .runtime
            .submit_outcome(
                "session-1",
                &handle,
                WorkerOutcome::Succeeded(TaskResult {
                    summary: "Original command passed".to_string(),
                    evidence_refs: vec![],
                }),
            )
            .await
            .unwrap();

        writer
            .runtime
            .control(
                "session-1",
                ControlCommand::CancelRun {
                    run_id: RunId::new("run-cross-runtime").unwrap(),
                    reason: "Cancel the isolated cross-runtime fixture".to_string(),
                },
                None,
            )
            .await
            .unwrap();

        let terminal = reader
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-cross-runtime".to_string(),
            })
            .await
            .unwrap();
        assert!(terminal.last_sequence > intermediate.last_sequence);
        assert_eq!(terminal.state, CodeProRunState::Cancelled);
        assert!(terminal
            .recent_events
            .iter()
            .any(|event| event.event_type == "run_cancelled"));
    }

    #[tokio::test]
    async fn read_only_get_does_not_reconcile_an_in_flight_effect() {
        let temp = tempfile::tempdir().unwrap();
        let writer = service(temp.path()).await;
        let reader = service(temp.path()).await;
        writer
            .create_run("session-1", "run-in-flight", "Fix the bug", coordinator())
            .await
            .unwrap();
        let receipt = writer
            .runtime
            .control(
                "session-1",
                ControlCommand::PauseRun {
                    run_id: RunId::new("run-in-flight").unwrap(),
                    reason: "Inspect progress".to_string(),
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(receipt.effects().len(), 1);

        let run_id = RunId::new("run-in-flight").unwrap();
        let ledger = FileEffectLedger::new(temp.path());
        assert_eq!(
            ledger.claim(&receipt.effects()[0]).unwrap(),
            crate::agents::control_plane::EffectClaimStatus::Claimed
        );
        let journal_path = ledger.journal_path(&run_id);
        let before = std::fs::read(&journal_path).unwrap();

        let snapshot = reader
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-in-flight".to_string(),
            })
            .await
            .unwrap();

        assert_eq!(snapshot.state, CodeProRunState::Paused);
        assert_eq!(snapshot.recovery.pending_effects, 1);
        assert_eq!(snapshot.recovery.uncertain_effects, 0);
        assert_eq!(snapshot.effects[0].state, CodeProEffectState::Claimed);
        assert!(!snapshot.effects[0].requires_resolution);
        assert_eq!(std::fs::read(journal_path).unwrap(), before);
        assert_eq!(
            ledger.snapshot(&run_id).unwrap()[0].state,
            DurableEffectState::Claimed
        );
    }

    #[tokio::test]
    async fn stale_control_is_rejected_before_any_event_is_appended() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path()).await;
        service
            .create_run("session-1", "run-1", "Fix the bug", coordinator())
            .await
            .unwrap();
        let error = service
            .control(&CodeProRunControlRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                command_id: "command-1".to_string(),
                run_id: "run-1".to_string(),
                expected_sequence: Some(0),
                action: CodeProRunControlAction::PauseRun {
                    reason: "Review progress".to_string(),
                },
            })
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            CodeProControlError::StaleSequence { actual: 1, .. }
        ));
        let events = FileRunEventStore::new(temp.path())
            .load(&RunId::new("run-1").unwrap())
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
    }

    #[tokio::test]
    async fn control_commits_through_the_durable_outbox_and_returns_backend_state() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path()).await;
        service
            .create_run("session-1", "run-1", "Fix the bug", coordinator())
            .await
            .unwrap();
        let response = service
            .control(&CodeProRunControlRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                command_id: "command-1".to_string(),
                run_id: "run-1".to_string(),
                expected_sequence: Some(1),
                action: CodeProRunControlAction::PauseRun {
                    reason: "Review progress".to_string(),
                },
            })
            .await
            .unwrap();

        assert_eq!(response.previous_sequence, 1);
        assert_eq!(response.snapshot.state, CodeProRunState::Paused);
        assert!(!response.committed_event_ids.is_empty());
        assert_eq!(response.snapshot.recovery.pending_effects, 1);
        assert_eq!(
            response.snapshot.effects[0].state,
            CodeProEffectState::Pending
        );
    }

    #[tokio::test]
    async fn durable_control_returns_only_after_the_physical_gate_effect_completes() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        service
            .create_run("session-1", "run-1", "Fix the bug", coordinator())
            .await
            .unwrap();
        let response = service
            .control(&CodeProRunControlRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                command_id: "command-durable".to_string(),
                run_id: "run-1".to_string(),
                expected_sequence: Some(1),
                action: CodeProRunControlAction::PauseRun {
                    reason: "Review progress".to_string(),
                },
            })
            .await
            .unwrap();

        assert_eq!(response.snapshot.recovery.pending_effects, 0);
        assert_eq!(
            response.snapshot.effects[0].state,
            CodeProEffectState::Completed
        );
    }

    #[tokio::test]
    async fn r3_prompt_registration_preserves_source_without_guessing_execution_obligations() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let goal = "Explain why npm.cmd test fails. Do not run npm.cmd test yet.";
        service
            .register_prompt_run_with_source(
                "session-source",
                "run-source",
                goal,
                Some("user-source"),
                Some(temp.path()),
            )
            .await
            .unwrap();
        let snapshot = service
            .runtime
            .snapshot("session-source", &RunId::new("run-source").unwrap())
            .await
            .unwrap();
        let requirement = &snapshot.projection.user_requirements
            [crate::agents::control_plane::ROOT_USER_REQUIREMENT_ID];
        assert_eq!(requirement.source_message_id, "user-source");
        assert_eq!(requirement.semantics.as_ref().unwrap().content, goal);
        assert!(requirement.execution_obligations.is_empty());
        assert!(snapshot.projection.execution_obligations.is_empty());
        assert_eq!(
            service
                .prior_prompt_run_for_input("session-source", temp.path())
                .await
                .unwrap(),
            Some(("run-source".to_string(), goal.to_string())),
        );
        let other_workspace = temp.path().join("other-project");
        std::fs::create_dir(&other_workspace).unwrap();
        assert_eq!(
            service
                .prior_prompt_run_for_input("session-source", &other_workspace)
                .await
                .unwrap(),
            None,
        );
    }

    #[tokio::test]
    async fn accepted_prompt_binding_disambiguates_without_adopting_foreign_runs() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        for (run, goal) in [
            ("edu", "Build education system"),
            ("app", "Build independent app"),
        ] {
            service
                .register_prompt_run_with_source("session", run, goal, Some(run), Some(temp.path()))
                .await
                .unwrap();
        }
        assert!(service
            .prior_prompt_run_for_input("session", temp.path())
            .await
            .is_err());
        assert_eq!(
            service
                .bound_prompt_run_for_input("session", temp.path(), "app")
                .await
                .unwrap(),
            Some(("app".into(), "Build independent app".into()))
        );
        assert!(service
            .bound_prompt_run_for_input("copied-session", temp.path(), "app")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            service
                .runtime
                .snapshot("session", &RunId::new("edu").unwrap())
                .await
                .unwrap()
                .projection
                .state,
            RunState::Planning
        );
    }

    #[tokio::test]
    async fn r3_legacy_binding_without_workspace_does_not_silently_start_another_run() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        service
            .register_prompt_run("session-old", "run-old", "Build the app")
            .await
            .unwrap();
        let error = service
            .prior_prompt_run_for_input("session-old", temp.path())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("no verified workspace binding"));
        assert!(error.contains("run-old"));
    }

    #[tokio::test]
    async fn r3_cancelled_prompt_can_link_new_run_without_inheriting_grant() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        service
            .register_prompt_run_with_source(
                "session-source",
                "run-old",
                "Build a university system",
                Some("user-old"),
                Some(temp.path()),
            )
            .await
            .unwrap();
        service
            .cancel_prompt_run("session-source", "run-old")
            .await
            .unwrap();
        assert_eq!(
            service
                .prior_prompt_run_for_input("session-source", temp.path())
                .await
                .unwrap(),
            Some((
                "run-old".to_string(),
                "Build a university system".to_string()
            ))
        );
        let source = crate::agents::protocol::RequirementContinuationSource {
            run_id: "run-old".to_string(),
            requirement_revision: 1,
        };
        let stale_source = crate::agents::protocol::RequirementContinuationSource {
            requirement_revision: 2,
            ..source.clone()
        };
        assert!(service
            .register_prompt_run_with_origin(
                "session-source",
                "run-invalid",
                "Do not start",
                Some("user-invalid"),
                Some(temp.path()),
                Some(stale_source),
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("verified terminal contract"));
        let snapshot = service
            .register_prompt_run_with_origin(
                "session-source",
                "run-new",
                "Build an expense mini-app",
                Some("user-new"),
                Some(temp.path()),
                Some(source.clone()),
            )
            .await
            .unwrap();
        let new_run = service
            .runtime
            .snapshot("session-source", &RunId::new("run-new").unwrap())
            .await
            .unwrap();
        let requirement = &new_run.projection.user_requirements
            [crate::agents::control_plane::ROOT_USER_REQUIREMENT_ID];
        assert_eq!(snapshot.goal, "Build an expense mini-app");
        assert_eq!(requirement.source_message_id, "user-new");
        assert_eq!(requirement.continuation_source, Some(source));
        assert!(new_run.projection.task_workspace_grant.is_none());
    }

    #[tokio::test]
    async fn prompt_registration_is_immediately_readable_and_scheduler_creation_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let registered = service
            .register_prompt_run("session-1", "run-live-prompt", "Fix the bug")
            .await
            .unwrap();
        assert_eq!(registered.goal, "Fix the bug");

        let immediate = service
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-live-prompt".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(immediate.goal, "Fix the bug");
        assert_eq!(immediate.last_sequence, registered.last_sequence);

        let run_id = RunId::new("run-live-prompt").unwrap();
        let scheduler_snapshot = service
            .runtime
            .create_or_verify_run("session-1", run_id, "Fix the bug")
            .await
            .unwrap();
        assert_eq!(
            scheduler_snapshot.projection.last_sequence,
            registered.last_sequence
        );

        let snapshot = service
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-live-prompt".to_string(),
            })
            .await
            .unwrap();

        assert_eq!(snapshot.goal, "Fix the bug");
        assert_eq!(
            snapshot.coordinator.effective_mode,
            CodeProCoordinatorMode::Shadow
        );
    }

    #[tokio::test]
    async fn seventh_repair_batch_checkpoint_prompt_resumes_the_existing_durable_run() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let started = service
            .register_prompt_run("session-1", "run-original", "Fix the bug")
            .await
            .unwrap();
        let paused = service
            .control(&CodeProRunControlRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                command_id: "pause-before-user".to_string(),
                run_id: "run-original".to_string(),
                expected_sequence: Some(started.last_sequence),
                action: CodeProRunControlAction::PauseRun {
                    reason: "Need user approval".to_string(),
                },
            })
            .await
            .unwrap();
        assert_eq!(paused.snapshot.state, CodeProRunState::Paused);

        let resumed = service
            .resume_prompt_run("session-1", "run-original")
            .await
            .unwrap();

        assert_eq!(resumed.run_id, "run-original");
        assert_eq!(resumed.goal, "Fix the bug");
        assert_eq!(resumed.state, CodeProRunState::Recovering);
        assert!(resumed.last_sequence > paused.snapshot.last_sequence);

        let resumed_again = service
            .resume_prompt_run("session-1", "run-original")
            .await
            .unwrap();

        assert_eq!(resumed_again.state, CodeProRunState::Recovering);
        assert_eq!(resumed_again.last_sequence, resumed.last_sequence);
    }

    #[tokio::test]
    async fn seventh_repair_batch_paused_prompt_rejects_an_unreconciled_delegated_worker() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        service
            .register_prompt_run("session-1", "run-delegated", "Fix the bug")
            .await
            .unwrap();
        let run_id = RunId::new("run-delegated").unwrap();
        let task_id = TaskId::new("delegate-review").unwrap();
        service
            .runtime
            .install_plan(
                "session-1",
                run_id.clone(),
                1,
                vec![PlannedTask {
                    task_id: task_id.clone(),
                    name: "Review the implementation".to_string(),
                    role: None,
                    depends_on: vec![],
                }],
            )
            .await
            .unwrap();
        service
            .runtime
            .start_task("session-1", run_id.clone(), task_id.clone())
            .await
            .unwrap();
        service
            .runtime
            .register_worker(
                "session-1",
                run_id.clone(),
                task_id.clone(),
                AgentId::new("reviewer-1").unwrap(),
                crate::agents::AgentRole::Coder,
            )
            .await
            .unwrap();
        service
            .runtime
            .control(
                "session-1",
                ControlCommand::PauseRun {
                    run_id: run_id.clone(),
                    reason: "delegated outcome is uncertain".to_string(),
                },
                None,
            )
            .await
            .unwrap();
        let before = service
            .runtime
            .snapshot("session-1", &run_id)
            .await
            .unwrap();

        let error = service
            .resume_prompt_run("session-1", "run-delegated")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("delegate-review"));
        let after = service
            .runtime
            .snapshot("session-1", &run_id)
            .await
            .unwrap();
        assert_eq!(after.projection.state, RunState::Paused);
        assert_eq!(
            after.projection.last_sequence,
            before.projection.last_sequence
        );
    }

    #[tokio::test]
    async fn running_prompt_run_recovers_orphaned_worker_after_process_restart() {
        let temp = tempfile::tempdir().unwrap();
        let writer = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        writer
            .register_prompt_run("session-1", "run-running", "Test the desktop flow")
            .await
            .unwrap();
        writer
            .runtime
            .install_plan(
                "session-1",
                RunId::new("run-running").unwrap(),
                1,
                vec![PlannedTask {
                    task_id: TaskId::new("desktop-acceptance").unwrap(),
                    name: "Test the desktop flow".to_string(),
                    role: Some(crate::agents::AgentRole::Tester),
                    depends_on: vec![],
                }],
            )
            .await
            .unwrap();
        let task_id = TaskId::new("desktop-acceptance").unwrap();
        writer
            .runtime
            .start_task(
                "session-1",
                RunId::new("run-running").unwrap(),
                task_id.clone(),
            )
            .await
            .unwrap();
        let agent_id = AgentId::new("tester-attempt-1").unwrap();
        writer
            .runtime
            .register_worker(
                "session-1",
                RunId::new("run-running").unwrap(),
                task_id.clone(),
                agent_id.clone(),
                crate::agents::AgentRole::Tester,
            )
            .await
            .unwrap();
        let before_restart = writer
            .runtime
            .snapshot("session-1", &RunId::new("run-running").unwrap())
            .await
            .unwrap();
        assert_eq!(before_restart.projection.state, RunState::Running);
        drop(writer);

        let restarted = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let resumed = restarted
            .resume_prompt_run("session-1", "run-running")
            .await
            .unwrap();

        assert_eq!(resumed.state, CodeProRunState::Recovering);
        assert!(resumed.last_sequence > before_restart.projection.last_sequence);
        let recovered = restarted
            .runtime
            .snapshot("session-1", &RunId::new("run-running").unwrap())
            .await
            .unwrap();
        assert_eq!(
            recovered.projection.tasks[&task_id].state,
            TaskState::Paused
        );
        assert_eq!(
            recovered.projection.agents[&agent_id].state,
            AgentState::Crashed
        );
    }

    #[tokio::test]
    async fn workspace_prompt_continues_an_existing_planning_run_without_forcing_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let started = service
            .register_prompt_run("session-1", "run-workspace", "Build a small game")
            .await
            .unwrap();
        assert_eq!(started.state, CodeProRunState::Planning);

        let resumed = service
            .resume_prompt_run("session-1", "run-workspace")
            .await
            .unwrap();

        assert_eq!(resumed.run_id, "run-workspace");
        assert_eq!(resumed.state, CodeProRunState::Planning);
        assert_eq!(resumed.last_sequence, started.last_sequence);
    }

    #[tokio::test]
    async fn registered_prompt_snapshot_is_available_before_cancel_is_terminal() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        service
            .register_prompt_run("session-1", "run-cancelled-prompt", "Stop safely")
            .await
            .unwrap();
        assert!(service
            .snapshot_if_available("session-1", "run-cancelled-prompt")
            .await
            .unwrap()
            .is_some());

        let snapshot = service
            .cancel_prompt_run("session-1", "run-cancelled-prompt")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(snapshot.state, CodeProRunState::Cancelled);
        assert!(snapshot
            .recent_events
            .iter()
            .any(|event| event.event_type == "run_cancelled"));
    }

    #[tokio::test]
    async fn prompt_stream_failure_commits_a_failed_terminal_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let service = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        service
            .register_prompt_run("session-1", "run-failed-prompt", "Fail safely")
            .await
            .unwrap();

        let snapshot = service
            .fail_prompt_run(
                "session-1",
                "run-failed-prompt",
                "agent stream disconnected",
            )
            .await
            .unwrap()
            .unwrap();

        assert_eq!(snapshot.state, CodeProRunState::Failed);
        assert!(snapshot
            .recent_events
            .iter()
            .any(|event| event.event_type == "run_failed"));
        assert!(snapshot
            .effects
            .iter()
            .all(|effect| !effect.requires_resolution));
    }

    #[tokio::test]
    async fn agent_turn_terminal_waiting_for_user_pauses_control_run_and_replays_non_running() {
        let temp = tempfile::tempdir().unwrap();
        let writer = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let reader = CodeProControlService::new_with_policy(
            temp.path(),
            RuntimeModePolicy::parse(Some("durable")),
        )
        .await
        .unwrap();
        let started = writer
            .register_prompt_run(
                "session-1",
                "run-provider-unavailable",
                "Analyze the project",
            )
            .await
            .unwrap();
        assert_eq!(started.state, CodeProRunState::Planning);

        let terminal = SystemNotificationContent {
            notification_type: SystemNotificationType::TurnTerminal,
            msg: "CodePro planning can be retried".to_string(),
            data: Some(serde_json::json!({
                "schema_version": 1,
                "session_id": "session-1",
                "run_id": "run-provider-unavailable",
                "terminal_message_id": "terminal-provider-unavailable",
                "source_user_message_id": "source-user-1",
                "status": "interrupted",
                "checkpoint_id": null,
                "retry_strategy": "replay_user_request",
                "visible_text_available": true,
                "tool_action_count": 0,
                "copy_artifact_ref": null,
                "finished_at": "2026-08-28T00:00:00Z",
                "report": {
                    "outcome": "waiting_for_user",
                    "classification_counts": {},
                    "changed_files": [],
                    "verification_summary": [],
                    "limitations": ["provider_unavailable"],
                    "recovery_action": "retry_planning",
                    "risk_tier": null,
                    "risk_reasons": [],
                    "review_required": false
                }
            })),
        };
        let paused = writer
            .observe_prompt_turn_terminal("session-1", "run-provider-unavailable", &terminal)
            .await
            .unwrap()
            .expect("the agent terminal must update the control plane");

        assert_eq!(paused.state, CodeProRunState::Paused);
        assert!(paused.last_sequence > started.last_sequence);
        assert!(paused
            .recent_events
            .iter()
            .any(|event| event.event_type == "run_paused"));

        let replayed = reader
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-provider-unavailable".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(replayed.state, CodeProRunState::Paused);
        assert_eq!(replayed.last_sequence, paused.last_sequence);
    }

    #[tokio::test]
    async fn cross_session_reads_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path()).await;
        service
            .create_run("session-1", "run-1", "Fix the bug", coordinator())
            .await
            .unwrap();

        let error = service
            .get(&CodeProRunGetRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-2".to_string(),
                run_id: "run-1".to_string(),
            })
            .await
            .unwrap_err();
        assert!(matches!(error, CodeProControlError::SessionMismatch { .. }));
    }

    #[tokio::test]
    async fn uncertain_effect_requires_an_explicit_matching_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let service = service(temp.path()).await;
        service
            .create_run("session-1", "run-1", "Fix the bug", coordinator())
            .await
            .unwrap();
        let response = service
            .control(&CodeProRunControlRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                command_id: "command-1".to_string(),
                run_id: "run-1".to_string(),
                expected_sequence: Some(1),
                action: CodeProRunControlAction::PauseRun {
                    reason: "Review progress".to_string(),
                },
            })
            .await
            .unwrap();
        let effect_id = response.snapshot.effects[0].effect_id.clone();
        let ledger = FileEffectLedger::new(temp.path());
        let report = RunRecovery::new(FileRunEventStore::new(temp.path()), ledger.clone())
            .recover(&RunId::new("run-1").unwrap())
            .await
            .unwrap();
        let effect = &report.pending[0].effect;
        assert!(matches!(
            ledger.claim(effect).unwrap(),
            crate::agents::control_plane::EffectClaimStatus::Claimed
        ));
        ledger.mark_uncertain(effect).unwrap();

        let snapshot = service
            .resolve_effect(&CodeProEffectResolveRequest {
                schema_version: CODEPRO_RUN_SCHEMA_VERSION,
                session_id: "session-1".to_string(),
                run_id: "run-1".to_string(),
                effect_id,
                resolution: CodeProEffectResolution::ConfirmedApplied,
            })
            .await
            .unwrap();
        assert_eq!(snapshot.recovery.uncertain_effects, 0);
        assert_eq!(snapshot.effects[0].state, CodeProEffectState::Completed);
    }
}
