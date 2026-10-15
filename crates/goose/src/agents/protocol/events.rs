use super::outcomes::{
    validate_evidence_refs, validate_named_value, validate_required_text, MAX_PROTOCOL_LIST_ITEMS,
};
use super::{
    AgentId, AgentState, AssistanceRequest, Checkpoint, CoordinatorAuditRecord,
    CoordinatorDecisionCandidate, EventId, EvidenceRef, FailureClass, ProtocolError,
    ProtocolVersion, RecoveryDecision, RunId, RunState, TaskFailure, TaskId, TaskResult, TaskState,
    WorkerOutcome,
};
use crate::agents::AgentRole;
use crate::agents::{
    ActivityEvent, ActivityEventKind, ActivityEventStatus, ACTIVITY_EVENT_SCHEMA_VERSION,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MAX_TASK_GRAPH_EDGES: usize = 512;
const MAX_TASK_RETRY_ATTEMPTS: u32 = 16;
const MAX_TASK_RETRY_DELAY_MS: u64 = 300_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDependency {
    pub task_id: TaskId,
    #[serde(default)]
    pub depends_on: Vec<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanRevisionAudit {
    pub supersedes_revision: u32,
    pub trigger_task_id: TaskId,
    pub trigger_failure: TaskFailure,
    pub planner_input: String,
    pub decision_basis: String,
    /// An explicit transfer of unfinished delegated work, not a successful outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reassigned_to: Option<TaskId>,
}

impl PlanRevisionAudit {
    pub fn validate_for_run(
        &self,
        run_id: &RunId,
        plan_revision: u32,
    ) -> Result<(), ProtocolError> {
        if self.supersedes_revision.saturating_add(1) != plan_revision {
            return Err(ProtocolError::InvalidEnvelope(
                "plan revision audit does not supersede the immediately previous revision"
                    .to_string(),
            ));
        }
        validate_required_text("plan_revision.planner_input", &self.planner_input)?;
        validate_required_text("plan_revision.decision_basis", &self.decision_basis)?;
        WorkerOutcome::VerificationFailed(self.trigger_failure.clone()).validate_for_run(run_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunEvent {
    pub protocol_version: ProtocolVersion,
    pub run_id: RunId,
    pub event_id: EventId,
    pub sequence: u64,
    pub task_id: Option<TaskId>,
    pub agent_id: Option<AgentId>,
    pub causation_id: Option<EventId>,
    pub correlation_id: EventId,
    pub occurred_at: DateTime<Utc>,
    #[serde(flatten)]
    pub payload: RunEventPayload,
    #[serde(default)]
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserInputResolution {
    pub task_id: TaskId,
    pub question_checkpoint_id: String,
    pub published_checkpoint_id: String,
    pub source_message_id: String,
    pub plan_revision: u32,
    #[serde(default)]
    pub format_version: u8,
    #[serde(default)]
    pub execution_payload_sha256: String,
    #[serde(default)]
    pub plan_semantics_sha256: String,
    #[serde(
        default,
        rename = "answer_sha256",
        skip_serializing_if = "Option::is_none"
    )]
    pub legacy_answer_sha256: Option<String>,
    pub skip: bool,
}

impl UserInputResolution {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.validate_record()?;
        if self.format_version != 1 || self.legacy_answer_sha256.is_some() {
            return Err(ProtocolError::InvalidEnvelope(
                "旧版输入记录需要重新验证，不能直接恢复执行".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_record(&self) -> Result<(), ProtocolError> {
        validate_required_text("input.question_checkpoint_id", &self.question_checkpoint_id)?;
        validate_required_text(
            "input.published_checkpoint_id",
            &self.published_checkpoint_id,
        )?;
        validate_required_text("input.source_message_id", &self.source_message_id)?;
        let valid_hash =
            |hash: &str| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
        let valid_format = match self.format_version {
            0 => {
                self.legacy_answer_sha256.as_deref().is_some_and(valid_hash)
                    && self.execution_payload_sha256.is_empty()
                    && self.plan_semantics_sha256.is_empty()
            }
            1 => {
                self.legacy_answer_sha256.is_none()
                    && valid_hash(&self.execution_payload_sha256)
                    && valid_hash(&self.plan_semantics_sha256)
            }
            _ => false,
        };
        if self.plan_revision == 0 || !valid_format {
            return Err(ProtocolError::InvalidEnvelope(
                "invalid user input resolution identity".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserRequirement {
    pub requirement_id: String,
    pub source_message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuation_source: Option<RequirementContinuationSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantics: Option<RequirementSemantics>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub execution_obligations: Vec<ExecutionObligation>,
}

/// A new run's explicit link to the prior run contract. It does not inherit
/// authorization or make prior evidence applicable to a new target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequirementContinuationSource {
    pub run_id: String,
    pub requirement_revision: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequirementSemantics {
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_effect: Option<RequirementEffect>,
    #[serde(default)]
    pub target_resources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_relation: Option<RequirementRevisionRelation>,
}

/// The delivery the user asks for, independent of tool permission classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementEffect {
    WorkspaceChange,
    Observation,
    Execution,
    ExternalEffect,
    /// An action and its visually observed application result, not remote delivery.
    DesktopInteraction,
    MemoryUpdate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequirementRevisionRelation {
    pub previous_revision: u32,
    pub requirement_ids: Vec<String>,
    pub kind: RequirementRevisionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementRevisionKind {
    Retained,
    Replaced,
    Withdrawn,
}

/// A formal approval-card decision, scoped to workspace file writes in one run.
/// This is an authorization fact, not evidence that the user goal was delivered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskWorkspaceGrant {
    pub grant_id: String,
    pub source_task_id: TaskId,
    pub request_id: String,
    pub option_id: String,
    pub workspace_root: String,
    pub requirement_revision: u32,
    pub authorization_revision: u32,
}

impl TaskWorkspaceGrant {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        validate_required_text("task_workspace_grant.grant_id", &self.grant_id)?;
        validate_required_text("task_workspace_grant.request_id", &self.request_id)?;
        validate_required_text("task_workspace_grant.option_id", &self.option_id)?;
        validate_required_text("task_workspace_grant.workspace_root", &self.workspace_root)?;
        if self.option_id != "allow_always"
            || self.authorization_revision == 0
            || self.requirement_revision == 0
            || !std::path::Path::new(&self.workspace_root).is_absolute()
        {
            return Err(ProtocolError::InvalidEnvelope(
                "invalid task workspace grant identity or scope".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRequirement {
    ExitCodeObserved,
    SuccessfulExitCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionObligation {
    pub obligation_id: String,
    pub source_message_id: String,
    pub invocation: crate::agents::validation_invocation::ValidationInvocation,
    pub evidence_requirement: EvidenceRequirement,
    #[serde(default)]
    pub allow_equivalent_invocation: bool,
}

impl ExecutionObligation {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        validate_required_text("execution_obligation.obligation_id", &self.obligation_id)?;
        validate_required_text(
            "execution_obligation.source_message_id",
            &self.source_message_id,
        )?;
        validate_required_text(
            "execution_obligation.invocation.executable",
            self.invocation.executable(),
        )?;
        validate_required_text("execution_obligation.invocation.cwd", self.invocation.cwd())?;
        validate_required_text(
            "execution_obligation.invocation.validation_identity",
            self.invocation.validation_identity(),
        )
    }
}

impl UserRequirement {
    pub fn is_active(&self) -> bool {
        !self
            .semantics
            .as_ref()
            .and_then(|semantics| semantics.revision_relation.as_ref())
            .is_some_and(|relation| relation.kind == RequirementRevisionKind::Withdrawn)
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        validate_required_text("user_requirement.requirement_id", &self.requirement_id)?;
        validate_required_text(
            "user_requirement.source_message_id",
            &self.source_message_id,
        )?;
        if let Some(source) = &self.continuation_source {
            validate_required_text(
                "user_requirement.continuation_source.run_id",
                &source.run_id,
            )?;
            if source.requirement_revision == 0 {
                return Err(ProtocolError::InvalidEnvelope(
                    "continuation source needs a requirement revision".to_string(),
                ));
            }
        }
        if let Some(semantics) = &self.semantics {
            validate_required_text("user_requirement.content", &semantics.content)?;
            for target in &semantics.target_resources {
                validate_required_text("user_requirement.target_resource", target)?;
            }
            if let Some(relation) = &semantics.revision_relation {
                if relation.previous_revision == 0 || relation.requirement_ids.is_empty() {
                    return Err(ProtocolError::InvalidEnvelope("requirement revision relation needs a previous revision and requirement IDs".to_string()));
                }
                let mut ids = std::collections::BTreeSet::new();
                for id in &relation.requirement_ids {
                    validate_required_text("user_requirement.previous_requirement_id", id)?;
                    if !ids.insert(id) {
                        return Err(ProtocolError::InvalidEnvelope(
                            "duplicate previous requirement ID".to_string(),
                        ));
                    }
                }
            }
        }
        if !self.is_active() && !self.execution_obligations.is_empty() {
            return Err(ProtocolError::InvalidEnvelope(
                "withdrawn requirement cannot introduce execution obligations".to_string(),
            ));
        }
        let mut obligation_ids = std::collections::BTreeSet::new();
        for obligation in &self.execution_obligations {
            obligation.validate()?;
            if obligation.source_message_id != self.source_message_id {
                return Err(ProtocolError::InvalidEnvelope(
                    "execution obligation source must match its user requirement".to_string(),
                ));
            }
            if !obligation_ids.insert(obligation.obligation_id.as_str()) {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "duplicate execution obligation: {}",
                    obligation.obligation_id
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event_type", content = "payload", rename_all = "snake_case")]
pub enum RunEventPayload {
    RunStarted {
        goal: String,
    },
    RunStateChanged {
        from: RunState,
        to: RunState,
    },
    UserRequirementsCommitted {
        revision: u32,
        requirements: Vec<UserRequirement>,
    },
    TaskWorkspaceGrantCommitted {
        grant: TaskWorkspaceGrant,
    },
    PlanProposed {
        plan_revision: u32,
        task_ids: Vec<TaskId>,
    },
    PlanRevised {
        plan_revision: u32,
        task_ids: Vec<TaskId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        audit: Option<PlanRevisionAudit>,
    },
    TaskCreated {
        task_id: TaskId,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<AgentRole>,
    },
    TaskGraphDeclared {
        plan_revision: u32,
        dependencies: Vec<TaskDependency>,
    },
    TaskStateChanged {
        task_id: TaskId,
        from: TaskState,
        to: TaskState,
    },
    UserInputResolved {
        resolution: UserInputResolution,
    },
    AgentSpawned {
        agent_id: AgentId,
        task_id: Option<TaskId>,
        role: AgentRole,
    },
    AgentStateChanged {
        agent_id: AgentId,
        task_id: Option<TaskId>,
        from: AgentState,
        to: AgentState,
    },
    #[serde(alias = "worker_outcome_accepted")]
    TaskOutcomeAccepted {
        task_id: TaskId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<AgentId>,
        outcome: WorkerOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        recovery_decision: Option<RecoveryDecision>,
    },
    TaskRetryScheduled {
        task_id: TaskId,
        attempt: u32,
        delay_ms: u64,
        failure: TaskFailure,
    },
    TaskRetryAuthorized {
        task_id: TaskId,
        attempt: u32,
        failure: TaskFailure,
    },
    ToolCallStarted {
        task_id: Option<TaskId>,
        agent_id: AgentId,
        tool_call_id: String,
        tool_name: String,
    },
    ToolCallCompleted {
        task_id: Option<TaskId>,
        agent_id: AgentId,
        tool_call_id: String,
        tool_name: String,
        success: bool,
        exit_code: Option<i32>,
    },
    CheckpointSaved {
        task_id: Option<TaskId>,
        checkpoint: Checkpoint,
    },
    TaskSucceeded {
        task_id: TaskId,
        result: TaskResult,
    },
    TaskFailed {
        task_id: TaskId,
        failure: TaskFailure,
    },
    AssistanceRequested {
        task_id: TaskId,
        agent_id: AgentId,
        request: AssistanceRequest,
    },
    PermissionRequested {
        task_id: Option<TaskId>,
        agent_id: Option<AgentId>,
        permission: String,
    },
    CoordinatorDecisionMade {
        candidate: CoordinatorDecisionCandidate,
    },
    CoordinatorAuditRecorded {
        audit: CoordinatorAuditRecord,
    },
    RunPaused {
        reason: String,
        checkpoint: Option<Checkpoint>,
    },
    RunCompleted {
        summary: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        requirement_evidence: BTreeMap<String, Vec<EvidenceRef>>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        execution_obligation_evidence: BTreeMap<String, Vec<EvidenceRef>>,
    },
    RunFailed {
        class: FailureClass,
        message: String,
        evidence_refs: Vec<EvidenceRef>,
    },
    RunCancelled {
        reason: String,
    },
    LegacyActivityObserved {
        kind: String,
        status: String,
        title: String,
    },
}

impl RunEvent {
    pub fn from_activity_event(
        sequence: u64,
        event: &ActivityEvent,
    ) -> Result<Self, ProtocolError> {
        if event.schema_version != ACTIVITY_EVENT_SCHEMA_VERSION {
            return Err(ProtocolError::UnsupportedVersion(
                event.schema_version.into(),
            ));
        }
        if event.event_type == ActivityEventKind::Unknown
            || event.status == ActivityEventStatus::Unknown
        {
            return Err(ProtocolError::InvalidEnvelope(
                "legacy activity kind and status must be known".to_string(),
            ));
        }

        let run_id = RunId::new(event.run_id.clone())?;
        let event_id = EventId::new(event.event_id.clone())?;
        let legacy_task_id = event.task_id.as_deref().map(TaskId::new).transpose()?;
        let summary = event
            .technical_details
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(event.title.as_str())
            .to_string();

        let (task_id, payload) = match event.event_type {
            ActivityEventKind::PlanCreated => (
                None,
                RunEventPayload::PlanProposed {
                    plan_revision: 1,
                    task_ids: vec![],
                },
            ),
            ActivityEventKind::PlanUpdated => (
                None,
                RunEventPayload::PlanRevised {
                    plan_revision: 1,
                    task_ids: vec![],
                    audit: None,
                },
            ),
            ActivityEventKind::TaskQueued => {
                let task_id = required_legacy_task_id(legacy_task_id)?;
                (
                    Some(task_id.clone()),
                    RunEventPayload::TaskStateChanged {
                        task_id,
                        from: TaskState::Proposed,
                        to: TaskState::Ready,
                    },
                )
            }
            ActivityEventKind::TaskStarted => {
                let task_id = required_legacy_task_id(legacy_task_id)?;
                (
                    Some(task_id.clone()),
                    RunEventPayload::TaskStateChanged {
                        task_id,
                        from: TaskState::Ready,
                        to: TaskState::Running,
                    },
                )
            }
            ActivityEventKind::TaskCompleted => {
                let task_id = required_legacy_task_id(legacy_task_id)?;
                (
                    Some(task_id.clone()),
                    RunEventPayload::TaskSucceeded {
                        task_id,
                        result: TaskResult {
                            summary,
                            evidence_refs: vec![],
                        },
                    },
                )
            }
            ActivityEventKind::TaskFailed => {
                let task_id = required_legacy_task_id(legacy_task_id)?;
                (
                    Some(task_id.clone()),
                    RunEventPayload::TaskFailed {
                        task_id,
                        failure: TaskFailure {
                            class: FailureClass::Unknown,
                            message: summary,
                            evidence_refs: vec![],
                        },
                    },
                )
            }
            ActivityEventKind::TaskSkipped => {
                let task_id = required_legacy_task_id(legacy_task_id)?;
                (
                    Some(task_id.clone()),
                    RunEventPayload::TaskStateChanged {
                        task_id,
                        from: TaskState::Proposed,
                        to: TaskState::Skipped,
                    },
                )
            }
            ActivityEventKind::ApprovalRequested => (
                legacy_task_id.clone(),
                RunEventPayload::PermissionRequested {
                    task_id: legacy_task_id,
                    agent_id: None,
                    permission: event.title.clone(),
                },
            ),
            ActivityEventKind::RunStopped => {
                (None, RunEventPayload::RunCancelled { reason: summary })
            }
            ActivityEventKind::RunFailed => (
                None,
                RunEventPayload::RunFailed {
                    class: FailureClass::Unknown,
                    message: summary,
                    evidence_refs: vec![],
                },
            ),
            ActivityEventKind::RunCompleted => (
                None,
                RunEventPayload::RunCompleted {
                    summary,
                    requirement_evidence: BTreeMap::new(),
                    execution_obligation_evidence: BTreeMap::new(),
                },
            ),
            ActivityEventKind::Unknown => unreachable!("unknown activity rejected above"),
            kind => (
                legacy_task_id,
                RunEventPayload::LegacyActivityObserved {
                    kind: serde_wire_name(kind)?,
                    status: serde_wire_name(event.status)?,
                    title: event.title.clone(),
                },
            ),
        };

        let converted = Self {
            protocol_version: ProtocolVersion::V1,
            run_id,
            event_id: event_id.clone(),
            sequence,
            task_id,
            agent_id: None,
            causation_id: event
                .retry_from_event_id
                .as_deref()
                .map(EventId::new)
                .transpose()?,
            correlation_id: event_id,
            occurred_at: event.started_at,
            payload,
            evidence_refs: vec![],
        };
        converted.validate()?;
        Ok(converted)
    }

    pub fn from_json(json: &str) -> Result<Self, ProtocolError> {
        let event: Self = serde_json::from_str(json)
            .map_err(|error| ProtocolError::InvalidEnvelope(error.to_string()))?;
        event.validate()?;
        Ok(event)
    }

    pub fn to_json(&self) -> Result<String, ProtocolError> {
        self.validate()?;
        serde_json::to_string_pretty(self)
            .map_err(|error| ProtocolError::InvalidEnvelope(error.to_string()))
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.sequence == 0 {
            return Err(ProtocolError::InvalidEnvelope(
                "event sequence must start at 1".to_string(),
            ));
        }
        validate_evidence_refs(&self.evidence_refs, &self.run_id)?;

        match &self.payload {
            RunEventPayload::RunStarted { goal } => {
                self.validate_scope(None, None)?;
                validate_required_text("run_started.goal", goal)
            }
            RunEventPayload::RunStateChanged { from, to } => {
                self.validate_scope(None, None)?;
                from.validate_transition(*to)
            }
            RunEventPayload::UserRequirementsCommitted {
                revision,
                requirements,
            } => {
                self.validate_scope(None, None)?;
                if *revision == 0 || requirements.is_empty() {
                    return Err(ProtocolError::InvalidEnvelope(
                        "user requirement revision must start at 1 and contain requirements"
                            .to_string(),
                    ));
                }
                if requirements.len() > MAX_PROTOCOL_LIST_ITEMS {
                    return Err(ProtocolError::LimitExceeded {
                        field: "run_event.user_requirements",
                        actual: requirements.len(),
                        maximum: MAX_PROTOCOL_LIST_ITEMS,
                    });
                }
                let mut ids = BTreeSet::new();
                for requirement in requirements {
                    requirement.validate()?;
                    if !ids.insert(requirement.requirement_id.as_str()) {
                        return Err(ProtocolError::InvalidEnvelope(format!(
                            "duplicate user requirement id: {}",
                            requirement.requirement_id
                        )));
                    }
                }
                Ok(())
            }
            RunEventPayload::TaskWorkspaceGrantCommitted { grant } => {
                self.validate_scope(None, None)?;
                grant.validate()
            }
            RunEventPayload::PlanProposed {
                plan_revision,
                task_ids,
            } => {
                self.validate_scope(None, None)?;
                validate_plan(
                    *plan_revision,
                    task_ids,
                    self.protocol_version >= ProtocolVersion::V2,
                )
            }
            RunEventPayload::PlanRevised {
                plan_revision,
                task_ids,
                audit,
            } => {
                self.validate_scope(None, None)?;
                validate_plan(
                    *plan_revision,
                    task_ids,
                    self.protocol_version >= ProtocolVersion::V2,
                )?;
                if let Some(audit) = audit {
                    audit.validate_for_run(&self.run_id, *plan_revision)?;
                    if audit.trigger_failure.evidence_refs != self.evidence_refs {
                        return Err(ProtocolError::InvalidEnvelope(
                            "plan revision event evidence must match the trigger failure"
                                .to_string(),
                        ));
                    }
                }
                Ok(())
            }
            RunEventPayload::TaskCreated {
                task_id,
                name,
                role: _,
            } => {
                self.validate_scope(Some(task_id), None)?;
                validate_required_text("task_created.name", name)
            }
            RunEventPayload::TaskGraphDeclared {
                plan_revision,
                dependencies,
            } => {
                self.validate_scope(None, None)?;
                if self.protocol_version < ProtocolVersion::V2 {
                    return Err(ProtocolError::InvalidEnvelope(
                        "task_graph_declared requires protocol version 2 or newer".to_string(),
                    ));
                }
                validate_task_graph(*plan_revision, dependencies)
            }
            RunEventPayload::TaskStateChanged { task_id, from, to } => {
                self.validate_scope(Some(task_id), None)?;
                from.validate_transition(*to)
            }
            RunEventPayload::UserInputResolved { resolution } => {
                self.validate_v2_event("user_input_resolved")?;
                self.validate_scope(Some(&resolution.task_id), None)?;
                resolution.validate_record()
            }
            RunEventPayload::AgentSpawned {
                agent_id, task_id, ..
            } => self.validate_scope(task_id.as_ref(), Some(agent_id)),
            RunEventPayload::AgentStateChanged {
                agent_id,
                task_id,
                from,
                to,
            } => {
                self.validate_scope(task_id.as_ref(), Some(agent_id))?;
                from.validate_transition(*to)
            }
            RunEventPayload::TaskOutcomeAccepted {
                task_id,
                agent_id,
                outcome,
                recovery_decision,
            } => {
                self.validate_v2_event("task_outcome_accepted")?;
                self.validate_scope(Some(task_id), agent_id.as_ref())?;
                outcome.validate_for_run(&self.run_id)?;
                if recovery_decision.is_some_and(|decision| decision != outcome.recovery_decision())
                {
                    return Err(ProtocolError::InvalidEnvelope(
                        "worker outcome recovery decision does not match the structured outcome"
                            .to_string(),
                    ));
                }
                Ok(())
            }
            RunEventPayload::TaskRetryScheduled {
                task_id,
                attempt,
                delay_ms,
                failure,
            } => {
                self.validate_v2_event("task_retry_scheduled")?;
                self.validate_scope(Some(task_id), None)?;
                if *attempt == 0 || *attempt > MAX_TASK_RETRY_ATTEMPTS {
                    return Err(ProtocolError::InvalidEnvelope(format!(
                        "retry attempt must be between 1 and {MAX_TASK_RETRY_ATTEMPTS}"
                    )));
                }
                if *delay_ms == 0 || *delay_ms > MAX_TASK_RETRY_DELAY_MS {
                    return Err(ProtocolError::InvalidEnvelope(format!(
                        "retry delay must be between 1 and {MAX_TASK_RETRY_DELAY_MS} milliseconds"
                    )));
                }
                if failure.class != FailureClass::TransientInfrastructure {
                    return Err(ProtocolError::InvalidEnvelope(
                        "only transient infrastructure failures may be scheduled mechanically"
                            .to_string(),
                    ));
                }
                WorkerOutcome::Failed(failure.clone()).validate_for_run(&self.run_id)
            }
            RunEventPayload::TaskRetryAuthorized {
                task_id,
                attempt,
                failure,
            } => {
                self.validate_v2_event("task_retry_authorized")?;
                self.validate_scope(Some(task_id), None)?;
                if *attempt == 0 || *attempt > MAX_TASK_RETRY_ATTEMPTS {
                    return Err(ProtocolError::InvalidEnvelope(format!(
                        "retry attempt must be between 1 and {MAX_TASK_RETRY_ATTEMPTS}"
                    )));
                }
                WorkerOutcome::Failed(failure.clone()).validate_for_run(&self.run_id)
            }
            RunEventPayload::ToolCallStarted {
                task_id,
                agent_id,
                tool_call_id,
                tool_name,
            }
            | RunEventPayload::ToolCallCompleted {
                task_id,
                agent_id,
                tool_call_id,
                tool_name,
                ..
            } => {
                self.validate_scope(task_id.as_ref(), Some(agent_id))?;
                validate_named_value("tool_call.tool_call_id", tool_call_id)?;
                validate_named_value("tool_call.tool_name", tool_name)
            }
            RunEventPayload::CheckpointSaved {
                task_id,
                checkpoint,
            } => {
                self.validate_scope(task_id.as_ref(), None)?;
                WorkerOutcome::Paused(checkpoint.clone()).validate_for_run(&self.run_id)
            }
            RunEventPayload::TaskSucceeded { task_id, result } => {
                self.validate_scope(Some(task_id), None)?;
                WorkerOutcome::Succeeded(result.clone()).validate_for_run(&self.run_id)
            }
            RunEventPayload::TaskFailed { task_id, failure } => {
                self.validate_scope(Some(task_id), None)?;
                WorkerOutcome::Failed(failure.clone()).validate_for_run(&self.run_id)
            }
            RunEventPayload::AssistanceRequested {
                task_id,
                agent_id,
                request,
            } => {
                self.validate_scope(Some(task_id), Some(agent_id))?;
                WorkerOutcome::NeedsHelp(request.clone()).validate_for_run(&self.run_id)
            }
            RunEventPayload::PermissionRequested {
                task_id,
                agent_id,
                permission,
            } => {
                self.validate_scope(task_id.as_ref(), agent_id.as_ref())?;
                validate_named_value("permission_requested.permission", permission)
            }
            RunEventPayload::CoordinatorDecisionMade { candidate } => {
                self.validate_scope(None, None)?;
                candidate.validate_for_run(&self.run_id)
            }
            RunEventPayload::CoordinatorAuditRecorded { audit } => {
                self.validate_scope(None, None)?;
                self.validate_v2_event("coordinator_audit_recorded")?;
                audit.validate()
            }
            RunEventPayload::RunPaused { reason, checkpoint } => {
                self.validate_scope(None, None)?;
                validate_required_text("run_paused.reason", reason)?;
                if let Some(checkpoint) = checkpoint {
                    WorkerOutcome::Paused(checkpoint.clone()).validate_for_run(&self.run_id)?;
                }
                Ok(())
            }
            RunEventPayload::RunCompleted {
                summary,
                requirement_evidence,
                execution_obligation_evidence,
            } => {
                self.validate_scope(None, None)?;
                validate_required_text("run_completed.summary", summary)?;
                for (requirement_id, evidence_refs) in requirement_evidence {
                    validate_required_text("run_completed.requirement_id", requirement_id)?;
                    validate_evidence_refs(evidence_refs, &self.run_id)?;
                }
                for (obligation_id, evidence_refs) in execution_obligation_evidence {
                    validate_required_text("run_completed.obligation_id", obligation_id)?;
                    validate_evidence_refs(evidence_refs, &self.run_id)?;
                }
                Ok(())
            }
            RunEventPayload::RunFailed {
                message,
                evidence_refs,
                ..
            } => {
                self.validate_scope(None, None)?;
                validate_required_text("run_failed.message", message)?;
                validate_evidence_refs(evidence_refs, &self.run_id)
            }
            RunEventPayload::RunCancelled { reason } => {
                self.validate_scope(None, None)?;
                validate_required_text("run_cancelled.reason", reason)
            }
            RunEventPayload::LegacyActivityObserved {
                kind,
                status,
                title,
            } => {
                validate_named_value("legacy_activity.kind", kind)?;
                validate_named_value("legacy_activity.status", status)?;
                validate_required_text("legacy_activity.title", title)
            }
        }
    }

    fn validate_scope(
        &self,
        task_id: Option<&TaskId>,
        agent_id: Option<&AgentId>,
    ) -> Result<(), ProtocolError> {
        if self.task_id.as_ref() != task_id || self.agent_id.as_ref() != agent_id {
            return Err(ProtocolError::InvalidEnvelope(format!(
                "event scope does not match payload: task={:?}, agent={:?}",
                self.task_id, self.agent_id
            )));
        }
        Ok(())
    }

    fn validate_v2_event(&self, name: &str) -> Result<(), ProtocolError> {
        if self.protocol_version >= ProtocolVersion::V2 {
            Ok(())
        } else {
            Err(ProtocolError::InvalidEnvelope(format!(
                "{name} requires protocol version 2 or newer"
            )))
        }
    }
}

fn required_legacy_task_id(task_id: Option<TaskId>) -> Result<TaskId, ProtocolError> {
    task_id.ok_or_else(|| {
        ProtocolError::InvalidEnvelope("legacy task activity is missing task_id".to_string())
    })
}

fn serde_wire_name(value: impl Serialize) -> Result<String, ProtocolError> {
    serde_json::to_value(value)
        .map_err(|error| ProtocolError::InvalidEnvelope(error.to_string()))?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| ProtocolError::InvalidEnvelope("legacy enum is not a string".to_string()))
}

fn validate_plan(
    plan_revision: u32,
    task_ids: &[TaskId],
    require_unique_tasks: bool,
) -> Result<(), ProtocolError> {
    if plan_revision == 0 {
        return Err(ProtocolError::InvalidEnvelope(
            "plan revision must start at 1".to_string(),
        ));
    }
    if task_ids.len() > MAX_PROTOCOL_LIST_ITEMS {
        return Err(ProtocolError::LimitExceeded {
            field: "plan.task_ids",
            actual: task_ids.len(),
            maximum: MAX_PROTOCOL_LIST_ITEMS,
        });
    }
    if require_unique_tasks && task_ids.iter().collect::<BTreeSet<_>>().len() != task_ids.len() {
        return Err(ProtocolError::InvalidEnvelope(
            "plan task IDs must be unique in protocol version 2".to_string(),
        ));
    }
    Ok(())
}

fn validate_task_graph(
    plan_revision: u32,
    dependencies: &[TaskDependency],
) -> Result<(), ProtocolError> {
    if plan_revision == 0 {
        return Err(ProtocolError::InvalidEnvelope(
            "task graph plan revision must start at 1".to_string(),
        ));
    }
    if dependencies.len() > MAX_PROTOCOL_LIST_ITEMS {
        return Err(ProtocolError::LimitExceeded {
            field: "task_graph.dependencies",
            actual: dependencies.len(),
            maximum: MAX_PROTOCOL_LIST_ITEMS,
        });
    }

    let mut task_ids = BTreeSet::new();
    let mut edge_count = 0_usize;
    for dependency in dependencies {
        if !task_ids.insert(&dependency.task_id) {
            return Err(ProtocolError::InvalidEnvelope(format!(
                "task graph contains duplicate task {}",
                dependency.task_id
            )));
        }
        if dependency.depends_on.len() > MAX_PROTOCOL_LIST_ITEMS {
            return Err(ProtocolError::LimitExceeded {
                field: "task_graph.depends_on",
                actual: dependency.depends_on.len(),
                maximum: MAX_PROTOCOL_LIST_ITEMS,
            });
        }
        edge_count = edge_count
            .checked_add(dependency.depends_on.len())
            .ok_or_else(|| {
                ProtocolError::InvalidEnvelope("task graph edge count overflow".to_string())
            })?;
        if edge_count > MAX_TASK_GRAPH_EDGES {
            return Err(ProtocolError::LimitExceeded {
                field: "task_graph.edges",
                actual: edge_count,
                maximum: MAX_TASK_GRAPH_EDGES,
            });
        }
        let mut prerequisites = BTreeSet::new();
        for prerequisite in &dependency.depends_on {
            if prerequisite == &dependency.task_id {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "task {} cannot depend on itself",
                    dependency.task_id
                )));
            }
            if !prerequisites.insert(prerequisite) {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "task {} contains duplicate dependency {}",
                    dependency.task_id, prerequisite
                )));
            }
        }
    }
    Ok(())
}
