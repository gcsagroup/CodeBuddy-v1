use super::decision::{
    CoordinatorAction, CoordinatorDecisionEnvelope, CoordinatorTaskProposal, DecisionShapeError,
    ValidatedCoordinatorDecision,
};
use crate::agents::control_plane::ConvergenceStatus;
use crate::agents::protocol::{
    AgentId, AgentState, EventId, EvidenceRef, RunId, RunState, TaskDependency, TaskId, TaskState,
};
use crate::agents::task_graph::{validate_write_ownership, TaskGraph, WriteOwnershipClaim};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct DecisionValidationSnapshot {
    run_id: RunId,
    run_state: RunState,
    plan_revision: u32,
    tasks: BTreeMap<TaskId, TaskState>,
    agents: BTreeMap<AgentId, AgentValidationState>,
    known_evidence: BTreeSet<EventId>,
    evidence_refs: BTreeMap<EventId, EvidenceRef>,
    failure_evidence: BTreeSet<EventId>,
    applied_decisions: BTreeSet<EventId>,
    granted_permissions: BTreeSet<String>,
    allowed_write_scopes: Vec<NormalizedScope>,
    max_additional_turns: u32,
    max_additional_tokens: Option<u64>,
    task_retry_counts: BTreeMap<TaskId, u32>,
    max_semantic_retries: u32,
    convergence_status: ConvergenceStatus,
}

#[derive(Debug, Clone)]
struct AgentValidationState {
    task_id: Option<TaskId>,
    state: AgentState,
}

impl DecisionValidationSnapshot {
    pub fn new(run_id: RunId, run_state: RunState, plan_revision: u32) -> Self {
        Self {
            run_id,
            run_state,
            plan_revision,
            tasks: BTreeMap::new(),
            agents: BTreeMap::new(),
            known_evidence: BTreeSet::new(),
            evidence_refs: BTreeMap::new(),
            failure_evidence: BTreeSet::new(),
            applied_decisions: BTreeSet::new(),
            granted_permissions: BTreeSet::new(),
            allowed_write_scopes: Vec::new(),
            max_additional_turns: 0,
            max_additional_tokens: Some(0),
            task_retry_counts: BTreeMap::new(),
            max_semantic_retries: 0,
            convergence_status: ConvergenceStatus::InProgress,
        }
    }

    pub fn insert_task(&mut self, task_id: TaskId, state: TaskState) {
        self.tasks.insert(task_id, state);
    }

    pub fn insert_agent(&mut self, agent_id: AgentId, task_id: Option<TaskId>, state: AgentState) {
        self.agents
            .insert(agent_id, AgentValidationState { task_id, state });
    }

    pub fn record_evidence(&mut self, event_id: EventId) {
        self.known_evidence.insert(event_id);
    }

    pub fn record_failure_evidence(&mut self, event_id: EventId) {
        self.known_evidence.insert(event_id.clone());
        self.failure_evidence.insert(event_id);
    }

    pub fn record_evidence_ref(&mut self, evidence: EvidenceRef) {
        self.known_evidence.insert(evidence.event_id().clone());
        self.evidence_refs
            .insert(evidence.event_id().clone(), evidence);
    }

    pub fn record_applied_decision(&mut self, decision_id: EventId) {
        self.applied_decisions.insert(decision_id);
    }

    pub fn grant_permission(&mut self, permission: impl Into<String>) {
        self.granted_permissions.insert(permission.into());
    }

    pub fn allow_write_scope(&mut self, scope: impl AsRef<str>) -> Result<(), ScopeError> {
        self.allowed_write_scopes
            .push(NormalizedScope::parse(scope.as_ref())?);
        Ok(())
    }

    pub fn set_budget_limits(&mut self, turns: u32, tokens: Option<u64>) {
        self.max_additional_turns = turns;
        self.max_additional_tokens = tokens;
    }

    pub fn set_convergence_status(&mut self, status: ConvergenceStatus) {
        self.convergence_status = status;
    }

    pub fn set_task_retry_count(&mut self, task_id: TaskId, retry_count: u32) {
        self.task_retry_counts.insert(task_id, retry_count);
    }

    pub fn set_max_semantic_retries(&mut self, maximum: u32) {
        self.max_semantic_retries = maximum;
    }

    pub(super) fn task_state(&self, task_id: &TaskId) -> Option<TaskState> {
        self.tasks.get(task_id).copied()
    }

    pub(super) fn first_retry_is_available(&self, task_id: &TaskId) -> bool {
        self.task_retry_counts.get(task_id).copied().unwrap_or(0) == 0
            && self.max_semantic_retries >= 1
    }

    pub(super) fn is_failure_evidence(&self, event_id: &EventId) -> bool {
        self.failure_evidence.contains(event_id)
    }

    pub(super) fn run_id(&self) -> &RunId {
        &self.run_id
    }

    pub(super) fn plan_revision(&self) -> u32 {
        self.plan_revision
    }

    pub(super) fn resolve_evidence_refs(
        &self,
        event_ids: &[EventId],
    ) -> Result<Vec<EvidenceRef>, DecisionValidationError> {
        event_ids
            .iter()
            .map(|event_id| {
                self.evidence_refs
                    .get(event_id)
                    .cloned()
                    .ok_or_else(|| DecisionValidationError::UnknownEvidence(event_id.to_string()))
            })
            .collect()
    }
}

pub struct CoordinatorDecisionValidator;

impl CoordinatorDecisionValidator {
    pub fn validate(
        envelope: CoordinatorDecisionEnvelope,
        snapshot: &DecisionValidationSnapshot,
    ) -> Result<ValidatedCoordinatorDecision, DecisionValidationError> {
        validate_shape(&envelope)?;
        validate_run(&envelope, snapshot)?;
        validate_not_replayed(&envelope, snapshot)?;
        validate_plan_basis(&envelope, snapshot)?;
        validate_evidence(&envelope, snapshot)?;
        validate_budget_and_permissions(&envelope, snapshot)?;
        validate_targets(&envelope, snapshot)?;
        validate_action(&envelope, snapshot)?;
        Ok(ValidatedCoordinatorDecision::new(envelope))
    }
}

fn validate_not_replayed(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    if snapshot
        .applied_decisions
        .contains(&envelope.candidate.decision_id)
        || snapshot
            .known_evidence
            .contains(&envelope.candidate.decision_id)
    {
        Err(DecisionValidationError::ReplayedDecision(
            envelope.candidate.decision_id.to_string(),
        ))
    } else {
        Ok(())
    }
}

fn validate_shape(envelope: &CoordinatorDecisionEnvelope) -> Result<(), DecisionValidationError> {
    match envelope.validate_shape() {
        Ok(()) => Ok(()),
        Err(DecisionShapeError::UnsupportedSchema(version)) => {
            Err(DecisionValidationError::UnsupportedSchema(version))
        }
        Err(DecisionShapeError::UnsupportedProtocol(version)) => {
            Err(DecisionValidationError::UnsupportedProtocol(version))
        }
        Err(DecisionShapeError::ActionMismatch) => Err(DecisionValidationError::ActionMismatch),
        Err(DecisionShapeError::InvalidField(message)) => {
            Err(DecisionValidationError::InvalidEnvelope(message))
        }
        Err(DecisionShapeError::Protocol(error)) => {
            Err(DecisionValidationError::InvalidEnvelope(error.to_string()))
        }
    }
}

fn validate_run(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    if envelope.candidate.run_id != snapshot.run_id {
        return Err(DecisionValidationError::RunMismatch {
            expected: snapshot.run_id.to_string(),
            actual: envelope.candidate.run_id.to_string(),
        });
    }
    if matches!(
        snapshot.run_state,
        RunState::Completed | RunState::Failed | RunState::Cancelled
    ) {
        return Err(DecisionValidationError::RunTerminal(snapshot.run_state));
    }
    Ok(())
}

fn validate_plan_basis(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    if envelope.candidate.supersedes_plan_revision != Some(snapshot.plan_revision) {
        return Err(DecisionValidationError::StalePlan {
            expected: snapshot.plan_revision,
            actual: envelope.candidate.supersedes_plan_revision,
        });
    }
    Ok(())
}

fn validate_evidence(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    if envelope.candidate.evidence_refs.is_empty() {
        return Err(DecisionValidationError::MissingEvidence);
    }
    for evidence in &envelope.candidate.evidence_refs {
        if !snapshot.known_evidence.contains(evidence.event_id()) {
            return Err(DecisionValidationError::UnknownEvidence(
                evidence.event_id().to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_budget_and_permissions(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    if let Some(request) = &envelope.candidate.requested_budget {
        let tokens_fit = match (
            request.max_additional_tokens,
            snapshot.max_additional_tokens,
        ) {
            (None, _) => true,
            (Some(_), None) => true,
            (Some(requested), Some(maximum)) => requested <= maximum,
        };
        if request.max_additional_turns > snapshot.max_additional_turns || !tokens_fit {
            return Err(DecisionValidationError::BudgetEscalation);
        }
    }
    if !matches!(envelope.action, CoordinatorAction::AskUser { .. }) {
        for permission in &envelope.candidate.required_permissions {
            if !snapshot.granted_permissions.contains(permission) {
                return Err(DecisionValidationError::PermissionEscalation(
                    permission.clone(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_targets(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    let candidate = &envelope.candidate;
    let task_target_required = matches!(
        envelope.action,
        CoordinatorAction::ContinueTask
            | CoordinatorAction::RetryTask
            | CoordinatorAction::ReplaceWorker { .. }
            | CoordinatorAction::PauseTask
            | CoordinatorAction::CancelTask
            | CoordinatorAction::CancelBranch
    );
    if task_target_required && candidate.target_task_id.is_none() {
        return Err(DecisionValidationError::MissingTargetTask);
    }
    if let Some(task_id) = &candidate.target_task_id {
        if !snapshot.tasks.contains_key(task_id) {
            return Err(DecisionValidationError::UnknownTask(task_id.to_string()));
        }
    }
    if matches!(envelope.action, CoordinatorAction::SendInstruction { .. })
        && candidate.target_agent_id.is_none()
    {
        return Err(DecisionValidationError::MissingTargetAgent);
    }
    if matches!(envelope.action, CoordinatorAction::ReplaceWorker { .. })
        && candidate.target_agent_id.is_none()
    {
        return Err(DecisionValidationError::MissingTargetAgent);
    }
    if let Some(agent_id) = &candidate.target_agent_id {
        if !snapshot.agents.contains_key(agent_id) {
            return Err(DecisionValidationError::UnknownAgent(agent_id.to_string()));
        }
    }
    let agent_target_allowed = matches!(
        envelope.action,
        CoordinatorAction::SendInstruction { .. } | CoordinatorAction::ReplaceWorker { .. }
    );
    if !agent_target_allowed && candidate.target_agent_id.is_some() {
        return Err(DecisionValidationError::UnexpectedTarget);
    }
    let target_free = matches!(
        envelope.action,
        CoordinatorAction::RevisePlan { .. }
            | CoordinatorAction::AskUser { .. }
            | CoordinatorAction::PauseRun
            | CoordinatorAction::CompleteRun { .. }
            | CoordinatorAction::FailRun { .. }
    );
    if target_free && (candidate.target_task_id.is_some() || candidate.target_agent_id.is_some()) {
        return Err(DecisionValidationError::UnexpectedTarget);
    }
    Ok(())
}

fn validate_action(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    match &envelope.action {
        CoordinatorAction::ContinueTask | CoordinatorAction::RetryTask => require_task_state(
            envelope,
            snapshot,
            &[TaskState::WaitingForCoordinator, TaskState::Paused],
        ),
        CoordinatorAction::ReplaceWorker { .. } => require_task_state(
            envelope,
            snapshot,
            &[TaskState::WaitingForCoordinator, TaskState::Running],
        )
        .and_then(|_| validate_agent_task_match(envelope, snapshot)),
        CoordinatorAction::PauseTask => require_task_state(
            envelope,
            snapshot,
            &[
                TaskState::Ready,
                TaskState::Running,
                TaskState::WaitingForCoordinator,
            ],
        ),
        CoordinatorAction::PauseRun => {
            if matches!(snapshot.run_state, RunState::Running | RunState::Recovering) {
                Ok(())
            } else {
                Err(DecisionValidationError::InvalidRunState(snapshot.run_state))
            }
        }
        CoordinatorAction::CancelTask | CoordinatorAction::CancelBranch => {
            require_non_terminal_task(envelope, snapshot)
        }
        CoordinatorAction::SendInstruction { .. } => validate_instruction(envelope, snapshot),
        CoordinatorAction::SpawnTask {
            plan_revision,
            task,
        } => {
            require_next_revision(*plan_revision, snapshot.plan_revision)?;
            validate_proposal_scope(task, snapshot)
        }
        CoordinatorAction::RevisePlan {
            plan_revision,
            tasks,
        } => validate_revised_plan(*plan_revision, tasks, snapshot),
        CoordinatorAction::CompleteRun { .. } => {
            if snapshot.convergence_status == ConvergenceStatus::Eligible {
                Ok(())
            } else {
                Err(DecisionValidationError::RunNotConverged)
            }
        }
        CoordinatorAction::AskUser { .. } | CoordinatorAction::FailRun { .. } => Ok(()),
    }
}

fn require_task_state(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
    allowed: &[TaskState],
) -> Result<(), DecisionValidationError> {
    let task_id = envelope
        .candidate
        .target_task_id
        .as_ref()
        .ok_or(DecisionValidationError::MissingTargetTask)?;
    let state = snapshot
        .tasks
        .get(task_id)
        .copied()
        .ok_or_else(|| DecisionValidationError::UnknownTask(task_id.to_string()))?;
    if allowed.contains(&state) {
        Ok(())
    } else {
        Err(DecisionValidationError::InvalidTaskState {
            task_id: task_id.to_string(),
            state,
        })
    }
}

fn require_non_terminal_task(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    require_task_state(
        envelope,
        snapshot,
        &[
            TaskState::Proposed,
            TaskState::Ready,
            TaskState::Running,
            TaskState::WaitingForCoordinator,
            TaskState::WaitingForApproval,
            TaskState::Paused,
        ],
    )
}

fn validate_instruction(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    let agent_id = envelope
        .candidate
        .target_agent_id
        .as_ref()
        .ok_or(DecisionValidationError::MissingTargetAgent)?;
    let agent = snapshot
        .agents
        .get(agent_id)
        .ok_or_else(|| DecisionValidationError::UnknownAgent(agent_id.to_string()))?;
    if agent.state != AgentState::Idle {
        return Err(DecisionValidationError::InvalidAgentState {
            agent_id: agent_id.to_string(),
            state: agent.state,
        });
    }
    validate_agent_task_match(envelope, snapshot)?;
    Ok(())
}

fn validate_agent_task_match(
    envelope: &CoordinatorDecisionEnvelope,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    let agent_id = envelope
        .candidate
        .target_agent_id
        .as_ref()
        .ok_or(DecisionValidationError::MissingTargetAgent)?;
    let agent = snapshot
        .agents
        .get(agent_id)
        .ok_or_else(|| DecisionValidationError::UnknownAgent(agent_id.to_string()))?;
    if let Some(target_task_id) = &envelope.candidate.target_task_id {
        if agent.task_id.as_ref() != Some(target_task_id) {
            return Err(DecisionValidationError::AgentTaskMismatch {
                agent_id: agent_id.to_string(),
                task_id: target_task_id.to_string(),
            });
        }
    }
    Ok(())
}

fn validate_revised_plan(
    revision: u32,
    tasks: &[CoordinatorTaskProposal],
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    require_next_revision(revision, snapshot.plan_revision)?;
    for task in tasks {
        validate_proposal_scope(task, snapshot)?;
    }
    let graph = TaskGraph::new(
        revision,
        tasks
            .iter()
            .map(|task| TaskDependency {
                task_id: task.task_id.clone(),
                depends_on: task.depends_on.clone(),
            })
            .collect(),
    )
    .map_err(|error| DecisionValidationError::InvalidTaskProposal(error.to_string()))?;
    let claims = tasks
        .iter()
        .map(|task| WriteOwnershipClaim::new(task.task_id.clone(), task.write_scope.clone()))
        .collect::<Vec<_>>();
    validate_write_ownership(&graph, &claims)
        .map_err(|error| DecisionValidationError::UnsafeWriteOwnership(error.to_string()))
}

fn require_next_revision(actual: u32, current: u32) -> Result<(), DecisionValidationError> {
    let expected = current
        .checked_add(1)
        .ok_or(DecisionValidationError::InvalidPlanRevision {
            expected: current,
            actual,
        })?;
    if actual == expected {
        Ok(())
    } else {
        Err(DecisionValidationError::InvalidPlanRevision { expected, actual })
    }
}

fn validate_proposal_scope(
    task: &CoordinatorTaskProposal,
    snapshot: &DecisionValidationSnapshot,
) -> Result<(), DecisionValidationError> {
    for scope in &task.read_scope {
        NormalizedScope::parse(scope).map_err(|_| {
            DecisionValidationError::InvalidTaskProposal(format!(
                "task {} contains invalid read scope {scope}",
                task.task_id
            ))
        })?;
    }
    for scope in &task.write_scope {
        let candidate = NormalizedScope::parse(scope).map_err(|_| {
            DecisionValidationError::WriteScopeExpansion {
                task_id: task.task_id.to_string(),
                scope: scope.clone(),
            }
        })?;
        if !snapshot
            .allowed_write_scopes
            .iter()
            .any(|allowed| allowed.contains(&candidate))
        {
            return Err(DecisionValidationError::WriteScopeExpansion {
                task_id: task.task_id.to_string(),
                scope: scope.clone(),
            });
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct NormalizedScope {
    segments: Vec<String>,
    recursive: bool,
}

impl NormalizedScope {
    fn parse(raw: &str) -> Result<Self, ScopeError> {
        let value = raw.trim().replace('\\', "/").to_lowercase();
        if value.is_empty() || value.starts_with('/') || value.contains(':') {
            return Err(ScopeError::Invalid(raw.into()));
        }
        let recursive = value == "**" || value.ends_with("/**");
        let prefix = if value == "**" {
            ""
        } else if recursive {
            value.strip_suffix("/**").unwrap_or_default()
        } else {
            value.as_str()
        };
        if prefix.contains('*') || prefix.contains('?') {
            return Err(ScopeError::Invalid(raw.into()));
        }
        let segments = if prefix.is_empty() {
            Vec::new()
        } else {
            prefix.split('/').map(str::to_string).collect::<Vec<_>>()
        };
        if segments
            .iter()
            .any(|segment| segment.is_empty() || matches!(segment.as_str(), "." | ".."))
        {
            return Err(ScopeError::Invalid(raw.into()));
        }
        Ok(Self {
            segments,
            recursive,
        })
    }

    fn contains(&self, candidate: &Self) -> bool {
        if self.recursive {
            candidate.segments.starts_with(&self.segments)
        } else {
            !candidate.recursive && candidate.segments == self.segments
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ScopeError {
    #[error("invalid workspace-relative scope: {0}")]
    Invalid(String),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DecisionValidationError {
    #[error("unsupported coordinator decision schema: {0}")]
    UnsupportedSchema(u16),
    #[error("unsupported coordinator protocol version: {0}")]
    UnsupportedProtocol(u16),
    #[error("invalid coordinator decision: {0}")]
    InvalidEnvelope(String),
    #[error("coordinator action does not match candidate decision")]
    ActionMismatch,
    #[error("decision belongs to run {actual}, expected {expected}")]
    RunMismatch { expected: String, actual: String },
    #[error("run is already terminal: {0:?}")]
    RunTerminal(RunState),
    #[error("run is in invalid state for this decision: {0:?}")]
    InvalidRunState(RunState),
    #[error("decision is based on stale plan revision {actual:?}; expected {expected}")]
    StalePlan { expected: u32, actual: Option<u32> },
    #[error("decision has no host-recorded evidence")]
    MissingEvidence,
    #[error("decision has already been applied: {0}")]
    ReplayedDecision(String),
    #[error("decision references unknown evidence: {0}")]
    UnknownEvidence(String),
    #[error("decision requests permission not already granted: {0}")]
    PermissionEscalation(String),
    #[error("decision requests more budget than the host permits")]
    BudgetEscalation,
    #[error("decision requires a target task")]
    MissingTargetTask,
    #[error("decision requires a target agent")]
    MissingTargetAgent,
    #[error("this decision must not include a target")]
    UnexpectedTarget,
    #[error("unknown task: {0}")]
    UnknownTask(String),
    #[error("unknown agent: {0}")]
    UnknownAgent(String),
    #[error("task {task_id} is in invalid state {state:?}")]
    InvalidTaskState { task_id: String, state: TaskState },
    #[error("agent {agent_id} is in invalid state {state:?}")]
    InvalidAgentState { agent_id: String, state: AgentState },
    #[error("agent {agent_id} is not assigned to task {task_id}")]
    AgentTaskMismatch { agent_id: String, task_id: String },
    #[error("run has not passed the host convergence gate")]
    RunNotConverged,
    #[error("invalid plan revision {actual}; expected {expected}")]
    InvalidPlanRevision { expected: u32, actual: u32 },
    #[error("invalid task proposal: {0}")]
    InvalidTaskProposal(String),
    #[error("task {task_id} expands write scope to {scope}")]
    WriteScopeExpansion { task_id: String, scope: String },
    #[error("unsafe write ownership: {0}")]
    UnsafeWriteOwnership(String),
}
