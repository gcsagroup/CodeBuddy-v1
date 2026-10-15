use super::runtime_storage::{
    io_error, read_binding, registration_complete_path, write_registration_complete,
    RUNTIME_BINDING_FILE_NAME, RUNTIME_BINDING_SCHEMA_VERSION,
};
use super::{
    CommandReceipt, ControlEffectExecutor, DurableEffectState, EffectDispatcher, EffectLedger,
    FileEffectLedger, FileRunEventStore, OutcomeIngress, OutcomeIngressError, OutcomeSubmission,
    ProductionControlEffectExecutor, RunEngine, RunEngineError, RunEventStore, RunRecovery,
    RunRecoveryError, RunRecoveryReport, SchedulerGateError, SchedulerGateRegistry,
    SchedulingLease, SystemRunClock, UncertainEffectResolution,
};
use crate::agents::protocol::{
    AgentId, ControlCommand, PlannedTask, RunEvent, RunId, RunState, TaskId, TaskState,
    WorkerOutcome,
};
use crate::agents::reporting::RunProjection;
use crate::agents::tool_audit::ToolAuditStore;
use crate::agents::workers::{
    RegistryError, SystemProcessTreeTerminator, WorkerHandle, WorkerRegistry,
};
use crate::agents::AgentRole;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, OwnedMutexGuard};
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

const PRODUCTION_WORKER_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeProRuntimeMode {
    Legacy,
    Shadow,
    Durable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeModePolicy {
    requested: CodeProRuntimeMode,
    effective: CodeProRuntimeMode,
    warning: Option<&'static str>,
}

impl RuntimeModePolicy {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            None | Some("") => Self {
                requested: CodeProRuntimeMode::Durable,
                effective: CodeProRuntimeMode::Durable,
                warning: None,
            },
            Some("legacy") => Self {
                requested: CodeProRuntimeMode::Legacy,
                effective: CodeProRuntimeMode::Legacy,
                warning: None,
            },
            Some("shadow") => Self {
                requested: CodeProRuntimeMode::Shadow,
                effective: CodeProRuntimeMode::Shadow,
                warning: None,
            },
            Some("durable") => Self {
                requested: CodeProRuntimeMode::Durable,
                effective: CodeProRuntimeMode::Durable,
                warning: None,
            },
            Some(_) => Self {
                requested: CodeProRuntimeMode::Legacy,
                effective: CodeProRuntimeMode::Legacy,
                warning: Some("invalid CODEPRO_RUNTIME_MODE; using the legacy runtime for safety"),
            },
        }
    }

    pub fn from_environment() -> Self {
        Self::parse(std::env::var("CODEPRO_RUNTIME_MODE").ok().as_deref())
    }

    pub fn effective(&self) -> CodeProRuntimeMode {
        self.effective
    }

    pub fn requested(&self) -> CodeProRuntimeMode {
        self.requested
    }

    pub fn warning(&self) -> Option<&'static str> {
        self.warning
    }

    fn enforce_executor_availability(mut self, available: bool) -> Self {
        if self.requested == CodeProRuntimeMode::Durable && !available {
            self.effective = CodeProRuntimeMode::Legacy;
            self.warning = Some(
                "durable CodePro runtime requested without an effect executor; using legacy for safety",
            );
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeRunBinding {
    pub schema_version: u16,
    pub session_id: String,
    pub run_id: RunId,
    pub goal: String,
}

#[derive(Debug, Clone)]
pub struct RuntimeSnapshot {
    pub binding: RuntimeRunBinding,
    pub projection: RunProjection,
    pub recovery: RunRecoveryReport,
    pub events: Vec<RunEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeUpdate {
    pub session_id: String,
    pub run_id: RunId,
    pub last_sequence: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeStartupRecovery {
    pub recovered_runs: Vec<RunId>,
    pub pending_effects: usize,
    pub uncertain_effects: usize,
    pub abandoned_effects: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum CodeProRuntimeError {
    #[error("{0} must not be empty")]
    EmptyField(&'static str),
    #[error("CodePro run {0} is not registered")]
    UnknownRun(String),
    #[error("CodePro run belongs to session {expected}, not {actual}")]
    SessionMismatch { expected: String, actual: String },
    #[error("CodePro run goal is immutable")]
    GoalMismatch,
    #[error("CodePro action is not admitted for run {run_id} task {task_id}: run={run_state:?}, task={task_state:?}")]
    ActionNotAdmitted {
        run_id: RunId,
        task_id: TaskId,
        run_state: RunState,
        task_state: Option<TaskState>,
    },
    #[error("CodePro run sequence is stale: expected {expected}, actual {actual}")]
    StaleSequence { expected: u64, actual: u64 },
    #[error("CodePro effect {0} is not awaiting an explicit resolution")]
    EffectNotUncertain(String),
    #[error("CodePro run engine failed: {0}")]
    Engine(String),
    #[error("CodePro completion proposal is blocked: {0:?}")]
    CompletionBlocked(Vec<super::ConvergenceBlocker>),
    #[error("CodePro run recovery failed: {0}")]
    Recovery(#[from] RunRecoveryError),
    #[error("CodePro Worker registry failed: {0}")]
    Registry(#[from] RegistryError),
    #[error("CodePro Worker outcome failed: {0}")]
    Outcome(#[from] OutcomeIngressError),
    #[error("CodePro effect dispatch failed: {0}")]
    Dispatch(String),
    #[error("CodePro scheduler gate failed: {0}")]
    SchedulerGate(#[from] SchedulerGateError),
    #[error("CodePro runtime data I/O failed at {path}: {message}")]
    Io { path: PathBuf, message: String },
    #[error("CodePro runtime data is invalid: {0}")]
    InvalidData(String),
    #[error("CodePro runtime state changed after commit: {0}")]
    RuntimeSync(String),
}

#[derive(Clone)]
pub struct CodeProRuntime {
    root: Arc<PathBuf>,
    policy: RuntimeModePolicy,
    store: FileRunEventStore,
    ledger: FileEffectLedger,
    registry: WorkerRegistry,
    gates: SchedulerGateRegistry,
    executor: Option<Arc<dyn ControlEffectExecutor>>,
    run_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    startup_recovery: Arc<RuntimeStartupRecovery>,
    updates: broadcast::Sender<RuntimeUpdate>,
    tool_audit_store: Option<Arc<ToolAuditStore>>,
}

impl CodeProRuntime {
    pub async fn initialize(
        root: impl Into<PathBuf>,
        policy: RuntimeModePolicy,
    ) -> Result<Self, CodeProRuntimeError> {
        Self::initialize_inner(
            root.into(),
            policy,
            WorkerRegistry::new(),
            SchedulerGateRegistry::new(),
            None,
        )
        .await
    }

    pub async fn initialize_with_executor<E>(
        root: impl Into<PathBuf>,
        policy: RuntimeModePolicy,
        executor: E,
    ) -> Result<Self, CodeProRuntimeError>
    where
        E: ControlEffectExecutor + 'static,
    {
        Self::initialize_inner(
            root.into(),
            policy,
            WorkerRegistry::new(),
            SchedulerGateRegistry::new(),
            Some(Arc::new(executor)),
        )
        .await
    }

    pub async fn initialize_production(
        root: impl Into<PathBuf>,
        policy: RuntimeModePolicy,
    ) -> Result<Self, CodeProRuntimeError> {
        let registry = WorkerRegistry::new();
        let gates = SchedulerGateRegistry::new();
        let executor = ProductionControlEffectExecutor::new(
            gates.clone(),
            registry.clone(),
            SystemProcessTreeTerminator,
            PRODUCTION_WORKER_GRACE,
        );
        Self::initialize_inner(
            root.into(),
            policy,
            registry,
            gates,
            Some(Arc::new(executor)),
        )
        .await
    }

    async fn initialize_inner(
        root: PathBuf,
        policy: RuntimeModePolicy,
        registry: WorkerRegistry,
        gates: SchedulerGateRegistry,
        executor: Option<Arc<dyn ControlEffectExecutor>>,
    ) -> Result<Self, CodeProRuntimeError> {
        let policy = policy.enforce_executor_availability(executor.is_some());
        let (updates, _) = broadcast::channel(256);
        std::fs::create_dir_all(&root).map_err(|error| io_error(&root, error))?;
        let store = FileRunEventStore::new(root.clone());
        let ledger = FileEffectLedger::new(root.clone());
        let startup_recovery = recover_registered_runs(
            &root,
            &store,
            &ledger,
            policy.effective(),
            executor.as_ref(),
            &gates,
        )
        .await?;
        Ok(Self {
            root: Arc::new(root),
            policy,
            store,
            ledger,
            registry,
            gates,
            executor,
            run_locks: Arc::new(Mutex::new(HashMap::new())),
            startup_recovery: Arc::new(startup_recovery),
            updates,
            tool_audit_store: None,
        })
    }

    pub fn with_tool_audit_root(mut self, root: PathBuf) -> Self {
        self.tool_audit_store = Some(Arc::new(ToolAuditStore::new(root)));
        self
    }

    pub fn mode_policy(&self) -> &RuntimeModePolicy {
        &self.policy
    }

    pub fn startup_recovery(&self) -> &RuntimeStartupRecovery {
        &self.startup_recovery
    }

    pub fn subscribe_updates(&self) -> broadcast::Receiver<RuntimeUpdate> {
        self.updates.subscribe()
    }

    pub async fn create_or_verify_run(
        &self,
        session_id: &str,
        run_id: RunId,
        goal: &str,
    ) -> Result<RuntimeSnapshot, CodeProRuntimeError> {
        require_text("session_id", session_id)?;
        require_text("goal", goal)?;
        let lock = self.run_lock(run_id.as_str()).await;
        let _guard = lock.lock().await;
        self.gates.ensure_run(run_id.clone())?;
        self.write_or_verify_binding(&RuntimeRunBinding {
            schema_version: RUNTIME_BINDING_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            run_id: run_id.clone(),
            goal: goal.to_string(),
        })?;

        let engine = self.engine();
        if let Some(projection) = engine
            .load_projection(&run_id)
            .await
            .map_err(engine_error)?
        {
            if projection.goal != goal {
                return Err(CodeProRuntimeError::GoalMismatch);
            }
        } else {
            engine
                .apply(ControlCommand::StartRun {
                    run_id: run_id.clone(),
                    goal: goal.to_string(),
                })
                .await
                .map_err(engine_error)?;
        }
        write_registration_complete(&self.root, &run_id)?;
        let snapshot = self.snapshot_locked(session_id, &run_id).await?;
        self.publish_update(session_id, &run_id, snapshot.projection.last_sequence);
        Ok(snapshot)
    }

    pub async fn snapshot(
        &self,
        session_id: &str,
        run_id: &RunId,
    ) -> Result<RuntimeSnapshot, CodeProRuntimeError> {
        require_text("session_id", session_id)?;
        let lock = self.run_lock(run_id.as_str()).await;
        let _guard = lock.lock().await;
        self.snapshot_locked(session_id, run_id).await
    }

    /// Linearize business-action admission with PauseRun/CancelRun commits.
    /// A call admitted before a pause remains in flight and must be reconciled
    /// from its tool receipt; a call arriving after the pause is never dispatched.
    pub async fn admit_action(
        &self,
        session_id: &str,
        run_id: &RunId,
        task_id: &TaskId,
        request_id: &str,
        task_workspace_grant_revision: Option<u32>,
    ) -> Result<OwnedMutexGuard<()>, CodeProRuntimeError> {
        require_text("session_id", session_id)?;
        require_text("request_id", request_id)?;
        let lock = self.run_lock(run_id.as_str()).await;
        let guard = lock.lock_owned().await;
        self.ensure_binding(session_id, run_id)?;
        let projection = self
            .engine()
            .load_projection(run_id)
            .await
            .map_err(engine_error)?
            .ok_or_else(|| CodeProRuntimeError::UnknownRun(run_id.to_string()))?;
        let task_state = projection.tasks.get(task_id).map(|task| task.state);
        if projection.state != RunState::Running || task_state != Some(TaskState::Running) {
            return Err(CodeProRuntimeError::ActionNotAdmitted {
                run_id: run_id.clone(),
                task_id: task_id.clone(),
                run_state: projection.state,
                task_state,
            });
        }
        if let Some(grant_revision) = task_workspace_grant_revision {
            if projection
                .task_workspace_grant
                .as_ref()
                .is_none_or(|grant| {
                    grant.authorization_revision != grant_revision
                        || grant.requirement_revision != projection.user_requirement_revision
                })
            {
                return Err(CodeProRuntimeError::Engine(format!(
                    "task workspace grant revision {grant_revision} is no longer valid for run {run_id}"
                )));
            }
        }
        tracing::debug!(
            %session_id,
            %run_id,
            %task_id,
            %request_id,
            run_sequence = projection.last_sequence,
            "CodePro business action admitted"
        );
        Ok(guard)
    }

    pub async fn install_plan(
        &self,
        session_id: &str,
        run_id: RunId,
        plan_revision: u32,
        tasks: Vec<PlannedTask>,
    ) -> Result<CommandReceipt, CodeProRuntimeError> {
        self.install_plan_with_audit(session_id, run_id, plan_revision, tasks, None)
            .await
    }

    pub async fn install_plan_with_audit(
        &self,
        session_id: &str,
        run_id: RunId,
        plan_revision: u32,
        tasks: Vec<PlannedTask>,
        revision_audit: Option<crate::agents::protocol::PlanRevisionAudit>,
    ) -> Result<CommandReceipt, CodeProRuntimeError> {
        self.apply(
            session_id,
            ControlCommand::InstallPlan {
                run_id,
                plan_revision,
                tasks,
                revision_audit,
            },
            None,
        )
        .await
    }

    pub async fn start_task(
        &self,
        session_id: &str,
        run_id: RunId,
        task_id: TaskId,
    ) -> Result<CommandReceipt, CodeProRuntimeError> {
        self.apply(
            session_id,
            ControlCommand::StartTask { run_id, task_id },
            None,
        )
        .await
    }

    pub async fn register_worker(
        &self,
        session_id: &str,
        run_id: RunId,
        task_id: TaskId,
        agent_id: AgentId,
        role: AgentRole,
    ) -> Result<(CommandReceipt, WorkerHandle), CodeProRuntimeError> {
        let lock = self.run_lock(run_id.as_str()).await;
        let _guard = lock.lock().await;
        self.ensure_binding(session_id, &run_id)?;
        let receipt = self
            .engine()
            .apply(ControlCommand::RegisterWorker {
                run_id: run_id.clone(),
                task_id: task_id.clone(),
                agent_id: agent_id.clone(),
                role,
            })
            .await
            .map_err(engine_error)?;
        self.publish_update(
            session_id,
            &receipt.projection().run_id,
            receipt.projection().last_sequence,
        );
        let handle = self
            .registry
            .register(run_id, Some(task_id), agent_id)
            .map_err(|error| CodeProRuntimeError::RuntimeSync(error.to_string()))?;
        Ok((receipt, handle))
    }

    pub async fn submit_outcome(
        &self,
        session_id: &str,
        handle: &WorkerHandle,
        outcome: WorkerOutcome,
    ) -> Result<OutcomeSubmission, CodeProRuntimeError> {
        let lock = self.run_lock(handle.run_id().as_str()).await;
        let _guard = lock.lock().await;
        self.ensure_binding(session_id, handle.run_id())?;
        let engine = self.engine();
        let submission = OutcomeIngress::new(&engine, &self.registry)
            .submit(handle, outcome)
            .await?;
        if let OutcomeSubmission::Committed { receipt, .. } = &submission {
            let dispatch = self.dispatch_receipt(receipt).await;
            self.publish_update(
                session_id,
                handle.run_id(),
                receipt.projection().last_sequence,
            );
            dispatch?;
        }
        Ok(submission)
    }

    pub async fn submit_inline_outcome(
        &self,
        session_id: &str,
        run_id: RunId,
        task_id: TaskId,
        outcome: WorkerOutcome,
    ) -> Result<CommandReceipt, CodeProRuntimeError> {
        self.apply(
            session_id,
            ControlCommand::SubmitTaskOutcome {
                run_id,
                task_id,
                agent_id: None,
                outcome,
            },
            None,
        )
        .await
    }

    pub fn worker_cancellation_token(
        &self,
        handle: &WorkerHandle,
    ) -> Result<CancellationToken, CodeProRuntimeError> {
        Ok(self.registry.cancellation_token(handle)?)
    }

    pub fn attach_worker_abort_handle(
        &self,
        handle: &WorkerHandle,
        abort_handle: AbortHandle,
    ) -> Result<(), CodeProRuntimeError> {
        self.registry.attach_abort_handle(handle, abort_handle)?;
        Ok(())
    }

    pub fn register_worker_process(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
    ) -> Result<(), CodeProRuntimeError> {
        self.registry.register_process(handle, process_id)?;
        Ok(())
    }

    pub fn register_worker_process_owner(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
        owner: Arc<dyn crate::session::SessionProcessOwner>,
    ) -> Result<(), CodeProRuntimeError> {
        self.registry
            .register_process_owner(handle, process_id, owner)?;
        Ok(())
    }

    pub(crate) fn worker_process_owner(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
    ) -> Result<Option<Arc<dyn crate::session::SessionProcessOwner>>, CodeProRuntimeError> {
        Ok(self.registry.process_owner(handle, process_id)?)
    }

    pub fn unregister_worker_process(
        &self,
        handle: &WorkerHandle,
        process_id: u32,
    ) -> Result<bool, CodeProRuntimeError> {
        Ok(self.registry.unregister_process(handle, process_id)?)
    }

    #[cfg(test)]
    pub(crate) fn worker_process_ids(
        &self,
        handle: &WorkerHandle,
    ) -> Result<Vec<u32>, CodeProRuntimeError> {
        Ok(self.registry.process_ids(handle)?)
    }

    pub async fn control(
        &self,
        session_id: &str,
        command: ControlCommand,
        expected_sequence: Option<u64>,
    ) -> Result<CommandReceipt, CodeProRuntimeError> {
        self.apply(session_id, command, expected_sequence).await
    }

    pub fn register_prompt_token(
        &self,
        run_id: &RunId,
        token: CancellationToken,
    ) -> Result<(), CodeProRuntimeError> {
        self.gates.register_prompt(run_id, token)?;
        Ok(())
    }

    pub fn bind_prompt_token(
        &self,
        run_id: &RunId,
        token: CancellationToken,
    ) -> Result<(), CodeProRuntimeError> {
        self.gates.bind_prompt(run_id, token)?;
        Ok(())
    }

    pub fn claim_scheduling_lease(
        &self,
        run_id: &RunId,
        task_id: &TaskId,
    ) -> Result<Option<SchedulingLease>, CodeProRuntimeError> {
        Ok(self.gates.try_claim(run_id, task_id)?)
    }

    pub async fn resolve_uncertain(
        &self,
        session_id: &str,
        run_id: &RunId,
        effect_id: &str,
        resolution: UncertainEffectResolution,
    ) -> Result<RuntimeSnapshot, CodeProRuntimeError> {
        require_text("effect_id", effect_id)?;
        let lock = self.run_lock(run_id.as_str()).await;
        let _guard = lock.lock().await;
        self.ensure_binding(session_id, run_id)?;
        let report = self.recovery().recover(run_id).await?;
        let effect = report
            .uncertain
            .iter()
            .find(|entry| entry.effect.ledger_key() == effect_id)
            .ok_or_else(|| CodeProRuntimeError::EffectNotUncertain(effect_id.to_string()))?;
        self.ledger
            .resolve_uncertain(&effect.effect, resolution)
            .map_err(|error| CodeProRuntimeError::Engine(error.to_string()))?;
        let dispatch = self.dispatch_pending_locked(run_id).await;
        let snapshot = self.snapshot_locked(session_id, run_id).await?;
        self.publish_update(session_id, run_id, snapshot.projection.last_sequence);
        dispatch?;
        Ok(snapshot)
    }

    async fn apply(
        &self,
        session_id: &str,
        mut command: ControlCommand,
        expected_sequence: Option<u64>,
    ) -> Result<CommandReceipt, CodeProRuntimeError> {
        require_text("session_id", session_id)?;
        let run_id = command.run_id().clone();
        let command_kind = command.kind();
        let (proposal_task_id, requirement_ids, evidence_event_ids) = match &command {
            ControlCommand::CompleteRun {
                proposal: Some(proposal),
                ..
            } => (
                proposal
                    .completion_task_id
                    .as_ref()
                    .map(ToString::to_string),
                proposal
                    .requirement_coverage
                    .iter()
                    .map(|coverage| coverage.requirement_id.clone())
                    .collect::<std::collections::BTreeSet<_>>(),
                proposal
                    .requirement_coverage
                    .iter()
                    .flat_map(|coverage| coverage.evidence_refs.iter())
                    .map(|evidence| evidence.event_id().to_string())
                    .collect::<std::collections::BTreeSet<_>>(),
            ),
            _ => (None, Default::default(), Default::default()),
        };
        let requirement_count = requirement_ids.len();
        let evidence_ref_count = evidence_event_ids.len();
        tracing::info!(
            session_id,
            run_id = %run_id,
            task_id = ?proposal_task_id.as_deref(),
            command = command_kind,
            requirement_count,
            evidence_ref_count,
            requirement_ids = ?requirement_ids,
            evidence_event_ids = ?evidence_event_ids,
            "CodePro runtime is waiting for the run mutation lock"
        );
        let lock = self.run_lock(run_id.as_str()).await;
        let _guard = lock.lock().await;
        tracing::info!(
            session_id,
            run_id = %run_id,
            task_id = ?proposal_task_id.as_deref(),
            command = command_kind,
            "CodePro runtime acquired the run mutation lock"
        );
        self.ensure_binding(session_id, &run_id)?;
        if let ControlCommand::CompleteRun {
            proposal: Some(proposal),
            ..
        } = &mut command
        {
            let completion_started = std::time::Instant::now();
            let effects = self
                .ledger
                .snapshot(&run_id)
                .map_err(|error| CodeProRuntimeError::Engine(error.to_string()))?;
            proposal.extend_uncertain_effects(
                effects
                    .into_iter()
                    .filter(|entry| {
                        matches!(
                            entry.state,
                            super::DurableEffectState::Uncertain
                                | super::DurableEffectState::Claimed
                        )
                    })
                    .map(|entry| entry.effect.ledger_key()),
            );
            if let Some(audit_store) = self.tool_audit_store.as_ref() {
                let projection = self
                    .engine()
                    .load_projection(&run_id)
                    .await
                    .map_err(engine_error)?
                    .ok_or_else(|| CodeProRuntimeError::UnknownRun(run_id.to_string()))?;
                let task_ids = projection.tasks.keys().cloned().collect::<Vec<_>>();
                let unfinished = audit_store
                    .unfinished_for_run(&run_id, &task_ids)
                    .await
                    .map_err(|error| {
                        CodeProRuntimeError::Engine(format!(
                            "tool audit reconciliation is unavailable for run {run_id}: {error}"
                        ))
                    })?;
                proposal.extend_uncertain_effects(unfinished.into_iter().map(|audit| {
                    format!(
                        "tool_audit:{}:task:{}:request_digest:{}:tool:{}",
                        audit.audit_id, audit.task_id, audit.request_digest, audit.tool_name
                    )
                }));
            }
            tracing::info!(
                session_id,
                run_id = %run_id,
                elapsed_ms = completion_started.elapsed().as_millis() as u64,
                "CodePro completion effect and audit reconciliation finished"
            );
        }
        if let ControlCommand::InstallPlan {
            revision_audit: Some(audit),
            ..
        } = &command
        {
            if audit.reassigned_to.is_some() {
                // Transfer changes responsibility, not the effects already dispatched.
                // Check their original owners under the same run mutation lock.
                let unresolved = self
                    .ledger
                    .snapshot(&run_id)
                    .map_err(|error| CodeProRuntimeError::Engine(error.to_string()))?
                    .into_iter()
                    .any(|entry| {
                        matches!(
                            entry.state,
                            DurableEffectState::Uncertain | DurableEffectState::Claimed
                        )
                    });
                if unresolved {
                    return Err(CodeProRuntimeError::Engine("Delegation transfer requires reconciliation of outstanding runtime effects".into()));
                }
                if let Some(store) = &self.tool_audit_store {
                    let unfinished = store
                        .unfinished_for_run(&run_id, std::slice::from_ref(&audit.trigger_task_id))
                        .await
                        .map_err(|error| {
                            CodeProRuntimeError::Engine(format!(
                                "Cannot inspect delegated tool effects: {error}"
                            ))
                        })?;
                    if !unfinished.is_empty() {
                        return Err(CodeProRuntimeError::Engine(format!(
                            "Delegation transfer requires reconciliation of tool audits: {}",
                            unfinished
                                .iter()
                                .map(|entry| entry.audit_id.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        )));
                    }
                }
            }
        }
        if let Some(expected) = expected_sequence {
            let actual = self
                .engine()
                .load_projection(&run_id)
                .await
                .map_err(engine_error)?
                .ok_or_else(|| CodeProRuntimeError::UnknownRun(run_id.to_string()))?
                .last_sequence;
            if expected != actual {
                tracing::warn!(
                    session_id,
                    run_id = %run_id,
                    task_id = ?proposal_task_id.as_deref(),
                    command = command_kind,
                    expected_sequence = expected,
                    actual_sequence = actual,
                    "CodePro control command was rejected before event commit"
                );
                return Err(CodeProRuntimeError::StaleSequence { expected, actual });
            }
        }
        tracing::info!(
            session_id,
            run_id = %run_id,
            task_id = ?proposal_task_id.as_deref(),
            command = command_kind,
            "CodePro runtime is applying the control command"
        );
        let receipt = match self.engine().apply(command).await {
            Ok(receipt) => receipt,
            Err(error) => {
                tracing::warn!(
                    session_id,
                    run_id = %run_id,
                    task_id = ?proposal_task_id.as_deref(),
                    command = command_kind,
                    requirement_count,
                    evidence_ref_count,
                    requirement_ids = ?requirement_ids,
                    evidence_event_ids = ?evidence_event_ids,
                    error = %error,
                    "CodePro control command was rejected before event commit"
                );
                return Err(completion_engine_error(error));
            }
        };
        let committed_task_ids = receipt
            .committed_events()
            .iter()
            .filter_map(|event| event.task_id.as_ref().map(ToString::to_string))
            .collect::<std::collections::BTreeSet<_>>();
        let committed_evidence_refs = receipt
            .committed_events()
            .iter()
            .map(|event| event.evidence_refs.len())
            .sum::<usize>();
        tracing::info!(
            session_id,
            run_id = %run_id,
            task_ids = ?committed_task_ids,
            command = command_kind,
            first_sequence = receipt.append().previous_sequence.saturating_add(1),
            last_sequence = receipt.append().last_sequence,
            event_count = receipt.committed_events().len(),
            evidence_ref_count = committed_evidence_refs,
            requirement_ids = ?requirement_ids,
            evidence_event_ids = ?evidence_event_ids,
            run_state = ?receipt.projection().state,
            "CodePro runtime committed authoritative control events"
        );
        let dispatch = self.dispatch_receipt(&receipt).await;
        let confirmed_stops = receipt
            .projection()
            .agents
            .iter()
            .filter_map(|(id, agent)| {
                if agent.state != crate::agents::protocol::AgentState::Stopping {
                    return None;
                }
                let handle = self.registry.current_handle(&run_id, id).ok()?;
                (self.registry.state(&handle).ok()?
                    == crate::agents::workers::WorkerRuntimeState::Stopped)
                    .then(|| id.clone())
            })
            .collect::<Vec<_>>();
        // Even a partially failed stop may contain confirmed individual workers.
        // Preserve the dispatch error and only publish facts the lifecycle owns.
        let receipt = self
            .engine()
            .record_confirmed_stops(receipt, &confirmed_stops)
            .await
            .map_err(engine_error)?;
        self.publish_update(session_id, &run_id, receipt.projection().last_sequence);
        dispatch?;
        Ok(receipt)
    }

    fn publish_update(&self, session_id: &str, run_id: &RunId, last_sequence: u64) {
        let _ = self.updates.send(RuntimeUpdate {
            session_id: session_id.to_string(),
            run_id: run_id.clone(),
            last_sequence,
        });
    }

    async fn snapshot_locked(
        &self,
        session_id: &str,
        run_id: &RunId,
    ) -> Result<RuntimeSnapshot, CodeProRuntimeError> {
        let binding = self.ensure_binding(session_id, run_id)?;
        let recovery = self.recovery().inspect(run_id).await?;
        let projection = recovery
            .projection
            .clone()
            .ok_or_else(|| CodeProRuntimeError::UnknownRun(run_id.to_string()))?;
        let events = self.store.load(run_id).await.map_err(engine_error)?;
        Ok(RuntimeSnapshot {
            binding,
            projection,
            recovery,
            events,
        })
    }

    fn engine(&self) -> RunEngine<FileRunEventStore, SystemRunClock, FileEffectLedger> {
        RunEngine::with_effect_outbox(self.store.clone(), SystemRunClock, self.ledger.clone())
    }

    fn recovery(&self) -> RunRecovery {
        RunRecovery::new(self.store.clone(), self.ledger.clone())
    }

    async fn dispatch_receipt(&self, receipt: &CommandReceipt) -> Result<(), CodeProRuntimeError> {
        if self.policy.effective() != CodeProRuntimeMode::Durable || receipt.effects().is_empty() {
            return Ok(());
        }
        let executor = self.executor.as_ref().ok_or_else(|| {
            CodeProRuntimeError::Dispatch(
                "durable runtime has no control effect executor".to_string(),
            )
        })?;
        EffectDispatcher::new(executor.clone(), self.ledger.clone())
            .dispatch(receipt)
            .await
            .map_err(|error| CodeProRuntimeError::Dispatch(error.to_string()))?;
        Ok(())
    }

    async fn dispatch_pending_locked(&self, run_id: &RunId) -> Result<(), CodeProRuntimeError> {
        if self.policy.effective() != CodeProRuntimeMode::Durable {
            return Ok(());
        }
        let executor = self.executor.as_ref().ok_or_else(|| {
            CodeProRuntimeError::Dispatch(
                "durable runtime has no control effect executor".to_string(),
            )
        })?;
        let report = self.recovery().recover(run_id).await?;
        let effects = report
            .pending
            .iter()
            .map(|entry| entry.effect.clone())
            .collect::<Vec<_>>();
        if effects.is_empty() {
            return Ok(());
        }
        EffectDispatcher::new(executor.clone(), self.ledger.clone())
            .dispatch_effects(&effects)
            .await
            .map_err(|error| CodeProRuntimeError::Dispatch(error.to_string()))?;
        Ok(())
    }

    async fn run_lock(&self, run_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.run_locks.lock().await;
        locks
            .entry(run_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn binding_path(&self, run_id: &RunId) -> PathBuf {
        self.root
            .join(run_id.as_str())
            .join(RUNTIME_BINDING_FILE_NAME)
    }

    fn write_or_verify_binding(
        &self,
        binding: &RuntimeRunBinding,
    ) -> Result<(), CodeProRuntimeError> {
        let path = self.binding_path(&binding.run_id);
        if path.exists() {
            let existing = read_binding(&path)?;
            verify_binding(&existing, &binding.session_id, &binding.run_id)?;
            return if existing.goal == binding.goal {
                Ok(())
            } else {
                Err(CodeProRuntimeError::GoalMismatch)
            };
        }
        let parent = path.parent().expect("binding path has a parent");
        std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
        match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(mut file) => {
                serde_json::to_writer(&mut file, binding)
                    .map_err(|error| CodeProRuntimeError::InvalidData(error.to_string()))?;
                file.write_all(b"\n")
                    .map_err(|error| io_error(&path, error))?;
                file.flush().map_err(|error| io_error(&path, error))?;
                file.sync_all().map_err(|error| io_error(&path, error))
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = read_binding(&path)?;
                verify_binding(&existing, &binding.session_id, &binding.run_id)?;
                if existing.goal == binding.goal {
                    Ok(())
                } else {
                    Err(CodeProRuntimeError::GoalMismatch)
                }
            }
            Err(error) => Err(io_error(&path, error)),
        }
    }

    fn ensure_binding(
        &self,
        session_id: &str,
        run_id: &RunId,
    ) -> Result<RuntimeRunBinding, CodeProRuntimeError> {
        let path = self.binding_path(run_id);
        if !path.is_file() {
            return Err(CodeProRuntimeError::UnknownRun(run_id.to_string()));
        }
        let binding = read_binding(&path)?;
        verify_binding(&binding, session_id, run_id)?;
        Ok(binding)
    }
}

async fn recover_registered_runs(
    root: &Path,
    store: &FileRunEventStore,
    ledger: &FileEffectLedger,
    mode: CodeProRuntimeMode,
    executor: Option<&Arc<dyn ControlEffectExecutor>>,
    gates: &SchedulerGateRegistry,
) -> Result<RuntimeStartupRecovery, CodeProRuntimeError> {
    let mut bindings = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|error| io_error(root, error))? {
        let entry = entry.map_err(|error| io_error(root, error))?;
        if !entry
            .file_type()
            .map_err(|error| io_error(entry.path(), error))?
            .is_dir()
        {
            continue;
        }
        let path = entry.path().join(RUNTIME_BINDING_FILE_NAME);
        if path.is_file() {
            let binding = read_binding(&path)?;
            if entry.file_name().to_string_lossy() != binding.run_id.as_str() {
                return Err(CodeProRuntimeError::InvalidData(
                    "runtime binding directory does not match its run identifier".to_string(),
                ));
            }
            gates.ensure_run(binding.run_id.clone())?;
            bindings.push(binding);
        }
    }
    bindings.sort_by(|left, right| left.run_id.cmp(&right.run_id));

    let recovery = RunRecovery::new(store.clone(), ledger.clone());
    let mut recovered = Vec::with_capacity(bindings.len());
    for binding in bindings {
        let mut report = recovery.recover(&binding.run_id).await?;
        if report.projection.is_none() {
            if registration_complete_path(root, &binding.run_id).is_file() {
                return Err(CodeProRuntimeError::InvalidData(format!(
                    "registered run {} is missing its event stream",
                    binding.run_id
                )));
            }
            RunEngine::with_effect_outbox(store.clone(), SystemRunClock, ledger.clone())
                .apply(ControlCommand::StartRun {
                    run_id: binding.run_id.clone(),
                    goal: binding.goal.clone(),
                })
                .await
                .map_err(engine_error)?;
            report = recovery.recover(&binding.run_id).await?;
        }
        let claimed = report
            .uncertain
            .iter()
            .filter(|entry| entry.state == DurableEffectState::Claimed)
            .map(|entry| entry.effect.clone())
            .collect::<Vec<_>>();
        for effect in claimed {
            ledger
                .mark_uncertain(&effect)
                .map_err(|error| CodeProRuntimeError::Engine(error.to_string()))?;
        }
        if report
            .uncertain
            .iter()
            .any(|entry| entry.state == DurableEffectState::Claimed)
        {
            report = recovery.recover(&binding.run_id).await?;
        }
        let projection = report.projection.as_ref().ok_or_else(|| {
            CodeProRuntimeError::InvalidData(format!(
                "runtime registration {} could not be recovered",
                binding.run_id
            ))
        })?;
        if projection.goal != binding.goal {
            return Err(CodeProRuntimeError::GoalMismatch);
        }
        write_registration_complete(root, &binding.run_id)?;
        recovered.push((binding, report));
    }

    // No new effect claim is allowed until every registered run has been
    // recovered and every prior in-flight claim is durably uncertain.
    let mut startup = RuntimeStartupRecovery::default();
    for (binding, mut report) in recovered {
        if mode == CodeProRuntimeMode::Durable && !report.pending.is_empty() {
            if let Some(executor) = executor {
                let mut pending = report.pending.iter().collect::<Vec<_>>();
                pending.sort_by_key(|entry| entry.trigger_event.sequence);
                let effects = pending
                    .into_iter()
                    .map(|entry| entry.effect.clone())
                    .collect::<Vec<_>>();
                EffectDispatcher::new((*executor).clone(), ledger.clone())
                    .dispatch_effects(&effects)
                    .await
                    .map_err(|error| CodeProRuntimeError::Dispatch(error.to_string()))?;
                report = recovery.recover(&binding.run_id).await?;
            }
        }
        startup.pending_effects += report.pending.len();
        startup.uncertain_effects += report.uncertain.len();
        startup.abandoned_effects += report.abandoned.len();
        startup.recovered_runs.push(binding.run_id);
    }
    Ok(startup)
}

fn verify_binding(
    binding: &RuntimeRunBinding,
    session_id: &str,
    run_id: &RunId,
) -> Result<(), CodeProRuntimeError> {
    if &binding.run_id != run_id {
        return Err(CodeProRuntimeError::InvalidData(
            "runtime binding run identifier changed".to_string(),
        ));
    }
    if binding.session_id != session_id {
        return Err(CodeProRuntimeError::SessionMismatch {
            expected: binding.session_id.clone(),
            actual: session_id.to_string(),
        });
    }
    Ok(())
}

fn require_text(field: &'static str, value: &str) -> Result<(), CodeProRuntimeError> {
    if value.trim().is_empty() {
        Err(CodeProRuntimeError::EmptyField(field))
    } else {
        Ok(())
    }
}

fn completion_engine_error(error: RunEngineError) -> CodeProRuntimeError {
    match error {
        RunEngineError::Reducer(super::ReducerError::CompletionBlocked(blockers)) => {
            CodeProRuntimeError::CompletionBlocked(blockers)
        }
        error => CodeProRuntimeError::Engine(error.to_string()),
    }
}

fn engine_error(error: impl std::fmt::Display) -> CodeProRuntimeError {
    CodeProRuntimeError::Engine(error.to_string())
}
