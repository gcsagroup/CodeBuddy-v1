use crate::agents::protocol::{
    AgentId, AgentState, EventId, ExecutionObligation, ProtocolError, ProtocolVersion,
    RecoveryDecision, RunEvent, RunEventPayload, RunId, RunState, TaskDependency, TaskFailure,
    TaskId, TaskResult, TaskState, TaskWorkspaceGrant, UserRequirement, WorkerOutcome,
};
use crate::agents::task_graph::TaskGraph;
use crate::agents::AgentRole;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskProjection {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<AgentRole>,
    pub state: TaskState,
    pub result: Option<TaskResult>,
    pub failure: Option<TaskFailure>,
    #[serde(default)]
    pub latest_outcome: Option<WorkerOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_recovery_decision: Option<RecoveryDecision>,
    #[serde(default)]
    pub retry_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProjection {
    pub task_id: Option<TaskId>,
    pub role: AgentRole,
    pub state: AgentState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunProjection {
    pub run_id: RunId,
    pub state: RunState,
    pub goal: String,
    #[serde(default)]
    pub user_requirement_revision: u32,
    #[serde(default, deserialize_with = "deserialize_user_requirements")]
    pub user_requirements: BTreeMap<String, UserRequirement>,
    #[serde(default)]
    pub execution_obligations: BTreeMap<String, ExecutionObligation>,
    #[serde(default)]
    pub authorization_revision: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_workspace_grant: Option<TaskWorkspaceGrant>,
    pub plan_revision: u32,
    pub tasks: BTreeMap<TaskId, TaskProjection>,
    pub agents: BTreeMap<AgentId, AgentProjection>,
    #[serde(default)]
    pub completion_requirement_evidence:
        BTreeMap<String, Vec<crate::agents::protocol::EvidenceRef>>,
    #[serde(default)]
    pub completion_execution_obligation_evidence:
        BTreeMap<String, Vec<crate::agents::protocol::EvidenceRef>>,
    pub last_sequence: u64,
    #[serde(default)]
    pub resolved_user_inputs: BTreeMap<String, crate::agents::protocol::UserInputResolution>,
    #[serde(default = "default_protocol_version")]
    protocol_version: ProtocolVersion,
    #[serde(default)]
    plan_task_ids: BTreeSet<TaskId>,
    #[serde(default)]
    task_graph_revision: Option<u32>,
    #[serde(default)]
    task_dependencies: BTreeMap<TaskId, BTreeSet<TaskId>>,
    seen_event_ids: BTreeSet<EventId>,
}

fn deserialize_user_requirements<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, UserRequirement>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StoredRequirement {
        Current(UserRequirement),
        Legacy(String),
    }
    let stored = BTreeMap::<String, StoredRequirement>::deserialize(deserializer)?;
    Ok(stored
        .into_iter()
        .map(|(id, requirement)| {
            let requirement = match requirement {
                StoredRequirement::Current(requirement) => requirement,
                StoredRequirement::Legacy(source_message_id) => UserRequirement {
                    requirement_id: id.clone(),
                    source_message_id,
                    continuation_source: None,
                    semantics: None,
                    execution_obligations: Vec::new(),
                },
            };
            (id, requirement)
        })
        .collect())
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TaskTopologyError {
    #[error("task topology is unavailable for plan revision {plan_revision}")]
    Unavailable { plan_revision: u32 },
    #[error("task is not a root in the current plan graph: {0}")]
    UnknownRoot(String),
    #[error("authoritative task topology is invalid: {0}")]
    Invalid(String),
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectionError {
    #[error("an event stream must not be empty")]
    EmptyStream,
    #[error("the first event must be RunStarted at sequence 1")]
    FirstEventMustStartRun,
    #[error("the run has already started")]
    RunAlreadyStarted,
    #[error("event belongs to run {actual}, expected {expected}")]
    RunMismatch { expected: String, actual: String },
    #[error("event sequence gap: expected {expected}, actual {actual}")]
    SequenceGap { expected: u64, actual: u64 },
    #[error("duplicate event id: {0}")]
    DuplicateEvent(String),
    #[error("run is already terminal: {0:?}")]
    RunIsTerminal(RunState),
    #[error("unknown task: {0}")]
    UnknownTask(String),
    #[error("task already exists: {0}")]
    DuplicateTask(String),
    #[error("protocol version downgrade: {previous:?} -> {actual:?}")]
    ProtocolVersionDowngrade {
        previous: ProtocolVersion,
        actual: ProtocolVersion,
    },
    #[error("task graph revision mismatch: expected {expected}, actual {actual}")]
    TaskGraphPlanRevision { expected: u32, actual: u32 },
    #[error("task graph is already declared for plan revision {0}")]
    TaskGraphAlreadyDeclared(u32),
    #[error("task graph task set does not match the current plan")]
    TaskGraphTaskSetMismatch,
    #[error("task {task_id} depends on unknown task {dependency_id}")]
    TaskGraphUnknownDependency {
        task_id: String,
        dependency_id: String,
    },
    #[error("task graph contains a dependency cycle")]
    TaskGraphCycle,
    #[error("unknown agent: {0}")]
    UnknownAgent(String),
    #[error("agent already exists: {0}")]
    DuplicateAgent(String),
    #[error("{entity} state mismatch: expected {expected}, actual {actual}")]
    StateMismatch {
        entity: &'static str,
        expected: String,
        actual: String,
    },
    #[error("plan revision mismatch: expected {expected}, actual {actual}")]
    PlanRevision { expected: u32, actual: u32 },
    #[error("user requirement revision mismatch: expected {expected}, actual {actual}")]
    UserRequirementRevision { expected: u32, actual: u32 },
    #[error("invalid task workspace authorization: {0}")]
    InvalidState(String),
    #[error("CodePro protocol validation failed: {0}")]
    Protocol(#[from] ProtocolError),
}

impl RunProjection {
    pub fn validate_requirement_revision(
        &self,
        requirements: &[UserRequirement],
    ) -> Result<(), ProtocolError> {
        use crate::agents::protocol::RequirementRevisionKind;
        let mut covered = BTreeMap::new();
        for (index, requirement) in requirements.iter().enumerate() {
            requirement.validate()?;
            let semantics = requirement.semantics.as_ref().ok_or_else(|| {
                ProtocolError::InvalidEnvelope(format!(
                    "requirement {} has unknown semantics",
                    requirement.requirement_id
                ))
            })?;
            if self
                .user_requirements
                .get(&requirement.requirement_id)
                .is_some_and(UserRequirement::is_active)
                && semantics.revision_relation.as_ref().is_none_or(|relation| {
                    !relation
                        .requirement_ids
                        .contains(&requirement.requirement_id)
                })
            {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "requirements[{index}].semantics.revision_relation: existing requirement {} needs an explicit relation to its prior version. Put the relation inside semantics, not at the requirement root. Example structure (the kind is illustrative): {{\"previous_revision\":{},\"requirement_ids\":[{}],\"kind\":\"replaced\"}}. Choose kind from retained (unchanged), replaced, or withdrawn based on the user request; inspect the current contract before retrying. No contract state changed.",
                    requirement.requirement_id,
                    self.user_requirement_revision,
                    serde_json::json!(requirement.requirement_id),
                )));
            }
            let Some(relation) = &semantics.revision_relation else {
                continue;
            };
            if relation.previous_revision != self.user_requirement_revision {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "requirements[{index}].semantics.revision_relation.previous_revision: requirement relation targets a stale revision (received {}, current {}). Inspect the current contract before retrying. No contract state changed.", relation.previous_revision, self.user_requirement_revision
                )));
            }
            for id in &relation.requirement_ids {
                let previous = self
                    .user_requirements
                    .get(id)
                    .filter(|requirement| requirement.is_active())
                    .ok_or_else(|| {
                        ProtocolError::InvalidEnvelope(format!(
                            "requirement relation references unknown or withdrawn requirement {id}"
                        ))
                    })?;
                if let Some(kind) = covered.insert(id.clone(), relation.kind) {
                    if kind != relation.kind {
                        return Err(ProtocolError::InvalidEnvelope(format!(
                            "requirement {id} has conflicting revision relations"
                        )));
                    }
                }
                if relation.kind == RequirementRevisionKind::Retained
                    && (relation.requirement_ids.len() != 1
                        || requirement.requirement_id != *id
                        || requirement.source_message_id != previous.source_message_id
                        || requirement.continuation_source != previous.continuation_source
                        || requirement.execution_obligations != previous.execution_obligations
                        || previous.semantics.as_ref().is_some_and(|prior| {
                            prior.content != semantics.content
                                || prior.target_resources != semantics.target_resources
                                || prior.expected_effect != semantics.expected_effect
                        }))
                {
                    return Err(ProtocolError::InvalidEnvelope(format!(
                        "retained requirement {id} changes its existing contract"
                    )));
                }
            }
        }
        for (id, requirement) in &self.user_requirements {
            if requirement.is_active() && !covered.contains_key(id) {
                return Err(ProtocolError::InvalidEnvelope(format!("requirement {id} was silently removed; retain, replace, or withdraw it explicitly")));
            }
        }
        Ok(())
    }

    pub fn rebuild(events: &[RunEvent]) -> Result<Self, ProjectionError> {
        let first = events.first().ok_or(ProjectionError::EmptyStream)?;
        let RunEventPayload::RunStarted { goal } = &first.payload else {
            return Err(ProjectionError::FirstEventMustStartRun);
        };
        if first.sequence != 1 {
            return Err(ProjectionError::FirstEventMustStartRun);
        }
        first.validate()?;

        let mut seen_event_ids = BTreeSet::new();
        seen_event_ids.insert(first.event_id.clone());
        let mut projection = Self {
            run_id: first.run_id.clone(),
            state: RunState::Planning,
            goal: goal.clone(),
            user_requirement_revision: 0,
            user_requirements: BTreeMap::new(),
            execution_obligations: BTreeMap::new(),
            authorization_revision: 0,
            task_workspace_grant: None,
            plan_revision: 0,
            tasks: BTreeMap::new(),
            agents: BTreeMap::new(),
            completion_requirement_evidence: BTreeMap::new(),
            completion_execution_obligation_evidence: BTreeMap::new(),
            last_sequence: 1,
            resolved_user_inputs: BTreeMap::new(),
            protocol_version: first.protocol_version,
            plan_task_ids: BTreeSet::new(),
            task_graph_revision: None,
            task_dependencies: BTreeMap::new(),
            seen_event_ids,
        };
        for event in &events[1..] {
            projection.apply(event)?;
        }
        Ok(projection)
    }

    pub fn apply(&mut self, event: &RunEvent) -> Result<(), ProjectionError> {
        event.validate()?;
        if event.run_id != self.run_id {
            return Err(ProjectionError::RunMismatch {
                expected: self.run_id.to_string(),
                actual: event.run_id.to_string(),
            });
        }
        let expected_sequence =
            self.last_sequence
                .checked_add(1)
                .ok_or(ProjectionError::SequenceGap {
                    expected: u64::MAX,
                    actual: event.sequence,
                })?;
        if event.sequence != expected_sequence {
            return Err(ProjectionError::SequenceGap {
                expected: expected_sequence,
                actual: event.sequence,
            });
        }
        if self.seen_event_ids.contains(&event.event_id) {
            return Err(ProjectionError::DuplicateEvent(event.event_id.to_string()));
        }
        if event.protocol_version < self.protocol_version {
            return Err(ProjectionError::ProtocolVersionDowngrade {
                previous: self.protocol_version,
                actual: event.protocol_version,
            });
        }
        let is_explicit_cancelled_recovery = matches!(
            event.payload,
            RunEventPayload::RunStateChanged {
                from: RunState::Cancelled,
                to: RunState::Recovering,
            }
        );
        // Cancelling a run records intent before lifecycle dispatch finishes.
        // A later confirmed stop settles that existing worker, not the run outcome.
        let is_stop_confirmation = matches!(
            event.payload,
            RunEventPayload::AgentStateChanged {
                from: AgentState::Stopping,
                to: AgentState::Stopped,
                ..
            }
        );
        if is_terminal_run(self.state) && !is_explicit_cancelled_recovery && !is_stop_confirmation {
            return Err(ProjectionError::RunIsTerminal(self.state));
        }

        self.apply_payload(&event.payload)?;
        self.protocol_version = event.protocol_version;
        self.seen_event_ids.insert(event.event_id.clone());
        self.last_sequence = event.sequence;
        Ok(())
    }

    fn apply_payload(&mut self, payload: &RunEventPayload) -> Result<(), ProjectionError> {
        match payload {
            RunEventPayload::UserInputResolved { resolution } => {
                if self.plan_revision != resolution.plan_revision {
                    return Err(ProjectionError::StateMismatch {
                        entity: "input plan revision",
                        expected: self.plan_revision.to_string(),
                        actual: resolution.plan_revision.to_string(),
                    });
                }
                let task = self.task_mut(&resolution.task_id)?;
                ensure_state("user input task", task.state, TaskState::WaitingForUser)?;
                if !matches!(&task.latest_outcome, Some(WorkerOutcome::WaitingForUser(question)) if question.checkpoint_id == resolution.question_checkpoint_id)
                {
                    return Err(ProjectionError::StateMismatch {
                        entity: "input question",
                        expected: "current waiting checkpoint".to_string(),
                        actual: resolution.question_checkpoint_id.clone(),
                    });
                }
                task.latest_recovery_decision = None;
                if self
                    .resolved_user_inputs
                    .contains_key(&resolution.source_message_id)
                {
                    return Err(ProjectionError::StateMismatch {
                        entity: "user input source",
                        expected: "unconsumed message".to_string(),
                        actual: resolution.source_message_id.clone(),
                    });
                }
                self.resolved_user_inputs
                    .insert(resolution.source_message_id.clone(), resolution.clone());
                Ok(())
            }
            RunEventPayload::RunStarted { .. } => Err(ProjectionError::RunAlreadyStarted),
            RunEventPayload::RunStateChanged { from, to } => {
                ensure_state("run", self.state, *from)?;
                from.validate_transition(*to)?;
                self.state = *to;
                Ok(())
            }
            RunEventPayload::UserRequirementsCommitted {
                revision,
                requirements,
            } => {
                let expected = self.user_requirement_revision.saturating_add(1);
                if *revision != expected {
                    return Err(ProjectionError::UserRequirementRevision {
                        expected,
                        actual: *revision,
                    });
                }
                self.user_requirement_revision = *revision;
                self.user_requirements = requirements
                    .iter()
                    .map(|requirement| (requirement.requirement_id.clone(), requirement.clone()))
                    .collect();
                self.execution_obligations = requirements
                    .iter()
                    .filter(|requirement| requirement.is_active())
                    .flat_map(|requirement| requirement.execution_obligations.iter().cloned())
                    .map(|obligation| (obligation.obligation_id.clone(), obligation))
                    .collect();
                Ok(())
            }
            RunEventPayload::TaskWorkspaceGrantCommitted { grant } => {
                let expected = self.authorization_revision.saturating_add(1);
                if grant.authorization_revision != expected
                    || grant.requirement_revision != self.user_requirement_revision
                    || !self.tasks.contains_key(&grant.source_task_id)
                {
                    return Err(ProjectionError::InvalidState(
                        "task workspace grant does not match the current run contract".to_string(),
                    ));
                }
                self.authorization_revision = expected;
                self.task_workspace_grant = Some(grant.clone());
                Ok(())
            }
            RunEventPayload::PlanProposed {
                plan_revision,
                task_ids,
            } => {
                self.apply_plan_revision(1, *plan_revision)?;
                self.begin_plan_revision(task_ids);
                Ok(())
            }
            RunEventPayload::PlanRevised {
                plan_revision,
                task_ids,
                ..
            } => {
                let expected = self.plan_revision.saturating_add(1);
                self.apply_plan_revision(expected, *plan_revision)?;
                self.begin_plan_revision(task_ids);
                Ok(())
            }
            RunEventPayload::TaskCreated {
                task_id,
                name,
                role,
            } => {
                if self.tasks.contains_key(task_id) {
                    return Err(ProjectionError::DuplicateTask(task_id.to_string()));
                }
                self.tasks.insert(
                    task_id.clone(),
                    TaskProjection {
                        name: name.clone(),
                        role: *role,
                        state: TaskState::Proposed,
                        result: None,
                        failure: None,
                        latest_outcome: None,
                        latest_recovery_decision: None,
                        retry_attempts: 0,
                    },
                );
                Ok(())
            }
            RunEventPayload::TaskGraphDeclared {
                plan_revision,
                dependencies,
            } => self.apply_task_graph(*plan_revision, dependencies),
            RunEventPayload::TaskStateChanged { task_id, from, to } => {
                let task = self.task_mut(task_id)?;
                ensure_state("task", task.state, *from)?;
                from.validate_transition(*to)?;
                task.state = *to;
                Ok(())
            }
            RunEventPayload::AgentSpawned {
                agent_id,
                task_id,
                role,
            } => {
                if let Some(task_id) = task_id {
                    let task = self.task(task_id)?;
                    ensure_state("worker task", task.state, TaskState::Running)?;
                    if let Some(expected_role) = task.role {
                        if expected_role != *role {
                            return Err(ProjectionError::StateMismatch {
                                entity: "worker role",
                                expected: format!("{expected_role:?}"),
                                actual: format!("{role:?}"),
                            });
                        }
                    }
                    if let Some(owner) = self.active_worker_for_task(task_id)? {
                        return Err(ProjectionError::StateMismatch {
                            entity: "task execution owner",
                            expected: "no active worker".to_string(),
                            actual: owner.to_string(),
                        });
                    }
                }
                if self.agents.contains_key(agent_id) {
                    return Err(ProjectionError::DuplicateAgent(agent_id.to_string()));
                }
                self.agents.insert(
                    agent_id.clone(),
                    AgentProjection {
                        task_id: task_id.clone(),
                        role: *role,
                        state: AgentState::Starting,
                    },
                );
                Ok(())
            }
            RunEventPayload::AgentStateChanged {
                agent_id,
                task_id,
                from,
                to,
            } => {
                let agent = self.agent_mut(agent_id)?;
                if &agent.task_id != task_id {
                    return Err(ProjectionError::StateMismatch {
                        entity: "agent task scope",
                        expected: format!("{:?}", agent.task_id),
                        actual: format!("{task_id:?}"),
                    });
                }
                ensure_state("agent", agent.state, *from)?;
                from.validate_transition(*to)?;
                agent.state = *to;
                Ok(())
            }
            RunEventPayload::TaskOutcomeAccepted {
                task_id,
                agent_id,
                outcome,
                recovery_decision,
            } => {
                let task_role = self.task(task_id)?.role;
                let worker_owner = self.active_worker_for_task(task_id)?;
                match (agent_id, worker_owner.as_ref(), task_role) {
                    (Some(agent_id), Some(owner), _) if agent_id == owner => {
                        self.ensure_worker_scope(Some(task_id), agent_id)?;
                        let agent = self.agent(agent_id)?;
                        if !matches!(agent.state, AgentState::Running | AgentState::Idle) {
                            return Err(ProjectionError::StateMismatch {
                                entity: "outcome agent",
                                expected: "Running or Idle".to_string(),
                                actual: format!("{:?}", agent.state),
                            });
                        }
                    }
                    (None, None, None) => {}
                    (actual, expected, _) => {
                        let expected = expected
                            .map(ToString::to_string)
                            .or_else(|| task_role.map(|_| "registered worker".to_string()))
                            .unwrap_or_else(|| "inline main Agent".to_string());
                        return Err(ProjectionError::StateMismatch {
                            entity: "task execution owner",
                            expected,
                            actual: actual
                                .as_ref()
                                .map(ToString::to_string)
                                .unwrap_or_else(|| "inline main Agent".to_string()),
                        });
                    }
                }
                let task = self.task_mut(task_id)?;
                ensure_state("outcome task", task.state, TaskState::Running)?;
                task.latest_outcome = Some(outcome.clone());
                task.latest_recovery_decision = *recovery_decision;
                Ok(())
            }
            RunEventPayload::TaskRetryScheduled {
                task_id, attempt, ..
            }
            | RunEventPayload::TaskRetryAuthorized {
                task_id, attempt, ..
            } => {
                let task = self.task_mut(task_id)?;
                ensure_state("retry task", task.state, TaskState::WaitingForCoordinator)?;
                let expected = task.retry_attempts.checked_add(1).ok_or_else(|| {
                    ProjectionError::StateMismatch {
                        entity: "retry attempt",
                        expected: "a non-overflowing attempt".to_string(),
                        actual: attempt.to_string(),
                    }
                })?;
                if *attempt != expected {
                    return Err(ProjectionError::StateMismatch {
                        entity: "retry attempt",
                        expected: expected.to_string(),
                        actual: attempt.to_string(),
                    });
                }
                task.retry_attempts = *attempt;
                Ok(())
            }
            RunEventPayload::ToolCallStarted {
                task_id, agent_id, ..
            }
            | RunEventPayload::ToolCallCompleted {
                task_id, agent_id, ..
            } => self.ensure_worker_scope(task_id.as_ref(), agent_id),
            RunEventPayload::CheckpointSaved { task_id, .. } => {
                self.ensure_optional_task(task_id.as_ref())
            }
            RunEventPayload::TaskSucceeded { task_id, result } => {
                let task = self.task_mut(task_id)?;
                task.state.validate_transition(TaskState::Succeeded)?;
                task.state = TaskState::Succeeded;
                task.result = Some(result.clone());
                task.failure = None;
                Ok(())
            }
            RunEventPayload::TaskFailed { task_id, failure } => {
                let task = self.task_mut(task_id)?;
                task.state.validate_transition(TaskState::Failed)?;
                task.state = TaskState::Failed;
                task.failure = Some(failure.clone());
                task.result = None;
                Ok(())
            }
            RunEventPayload::AssistanceRequested {
                task_id, agent_id, ..
            } => self.ensure_worker_scope(Some(task_id), agent_id),
            RunEventPayload::PermissionRequested {
                task_id, agent_id, ..
            } => {
                self.ensure_optional_task(task_id.as_ref())?;
                if let Some(agent_id) = agent_id {
                    self.agent(agent_id)?;
                }
                Ok(())
            }
            RunEventPayload::CoordinatorDecisionMade { .. }
            | RunEventPayload::CoordinatorAuditRecorded { .. }
            | RunEventPayload::LegacyActivityObserved { .. } => Ok(()),
            RunEventPayload::RunPaused { .. } => self.transition_run(RunState::Paused),
            RunEventPayload::RunCompleted {
                requirement_evidence,
                execution_obligation_evidence,
                ..
            } => {
                if self.state != RunState::Completing {
                    self.transition_run(RunState::Completing)?;
                }
                self.completion_requirement_evidence = requirement_evidence.clone();
                self.completion_execution_obligation_evidence =
                    execution_obligation_evidence.clone();
                self.transition_run(RunState::Completed)
            }
            RunEventPayload::RunFailed { .. } => self.transition_run(RunState::Failed),
            RunEventPayload::RunCancelled { .. } => self.transition_run(RunState::Cancelled),
        }
    }

    fn apply_plan_revision(&mut self, expected: u32, actual: u32) -> Result<(), ProjectionError> {
        if actual != expected {
            return Err(ProjectionError::PlanRevision { expected, actual });
        }
        self.plan_revision = actual;
        Ok(())
    }

    fn begin_plan_revision(&mut self, task_ids: &[TaskId]) {
        self.plan_task_ids = task_ids.iter().cloned().collect();
        self.task_graph_revision = None;
        self.task_dependencies.clear();
    }

    fn apply_task_graph(
        &mut self,
        plan_revision: u32,
        dependencies: &[TaskDependency],
    ) -> Result<(), ProjectionError> {
        if plan_revision != self.plan_revision {
            return Err(ProjectionError::TaskGraphPlanRevision {
                expected: self.plan_revision,
                actual: plan_revision,
            });
        }
        if self.task_graph_revision == Some(plan_revision) {
            return Err(ProjectionError::TaskGraphAlreadyDeclared(plan_revision));
        }
        let declared_task_ids = dependencies
            .iter()
            .map(|dependency| dependency.task_id.clone())
            .collect::<BTreeSet<_>>();
        if declared_task_ids != self.plan_task_ids {
            return Err(ProjectionError::TaskGraphTaskSetMismatch);
        }

        let mut candidate = BTreeMap::new();
        for dependency in dependencies {
            if !self.tasks.contains_key(&dependency.task_id) {
                return Err(ProjectionError::UnknownTask(dependency.task_id.to_string()));
            }
            let mut prerequisites = BTreeSet::new();
            for prerequisite in &dependency.depends_on {
                if !declared_task_ids.contains(prerequisite) {
                    return Err(ProjectionError::TaskGraphUnknownDependency {
                        task_id: dependency.task_id.to_string(),
                        dependency_id: prerequisite.to_string(),
                    });
                }
                if !self.tasks.contains_key(prerequisite) {
                    return Err(ProjectionError::UnknownTask(prerequisite.to_string()));
                }
                prerequisites.insert(prerequisite.clone());
            }
            candidate.insert(dependency.task_id.clone(), prerequisites);
        }
        if !is_acyclic(&candidate) {
            return Err(ProjectionError::TaskGraphCycle);
        }

        self.task_dependencies = candidate;
        self.task_graph_revision = Some(plan_revision);
        Ok(())
    }

    pub fn protocol_version(&self) -> ProtocolVersion {
        self.protocol_version
    }

    pub fn task_graph_revision(&self) -> Option<u32> {
        self.task_graph_revision
    }

    pub fn current_task_graph(&self) -> Result<TaskGraph, TaskTopologyError> {
        if self.task_graph_revision != Some(self.plan_revision) {
            return Err(TaskTopologyError::Unavailable {
                plan_revision: self.plan_revision,
            });
        }
        let dependencies = self
            .task_dependencies
            .iter()
            .map(|(task_id, depends_on)| TaskDependency {
                task_id: task_id.clone(),
                depends_on: depends_on.iter().cloned().collect(),
            })
            .collect();
        TaskGraph::new(self.plan_revision, dependencies)
            .map_err(|error| TaskTopologyError::Invalid(error.to_string()))
    }

    pub fn dispatchable_task_ids(&self) -> Result<Vec<TaskId>, TaskTopologyError> {
        if !matches!(self.state, RunState::Running | RunState::Recovering) {
            return Ok(Vec::new());
        }
        let graph = self.current_task_graph()?;
        let mut dispatchable = Vec::new();
        for task_id in graph.task_ids() {
            let task = self.tasks.get(task_id).ok_or_else(|| {
                TaskTopologyError::Invalid(format!(
                    "current task graph references missing task {task_id}"
                ))
            })?;
            let dependencies_succeeded = || {
                graph.dependencies_for(task_id).is_ok_and(|dependencies| {
                    dependencies.iter().all(|dependency| {
                        self.tasks
                            .get(dependency)
                            .is_some_and(|task| task.state == TaskState::Succeeded)
                    })
                })
            };
            let can_dispatch = task.state == TaskState::Ready
                || (task.state == TaskState::RepairPending && dependencies_succeeded())
                || (self.state == RunState::Recovering && task.state == TaskState::Paused);
            if can_dispatch {
                dispatchable.push(task_id.clone());
            }
        }
        Ok(dispatchable)
    }

    pub(crate) fn active_worker_for_task(
        &self,
        task_id: &TaskId,
    ) -> Result<Option<AgentId>, ProjectionError> {
        self.task(task_id)?;
        let mut owners = self
            .agents
            .iter()
            .filter(|(_, agent)| {
                agent.task_id.as_ref() == Some(task_id)
                    && matches!(
                        agent.state,
                        AgentState::Starting
                            | AgentState::Running
                            | AgentState::Idle
                            | AgentState::Stopping
                    )
            })
            .map(|(agent_id, _)| agent_id.clone());
        let owner = owners.next();
        if let Some(conflict) = owners.next() {
            return Err(ProjectionError::StateMismatch {
                entity: "task execution owner",
                expected: owner
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "one active worker".to_string()),
                actual: conflict.to_string(),
            });
        }
        Ok(owner)
    }

    pub fn branch_task_ids(&self, root: &TaskId) -> Result<Vec<TaskId>, TaskTopologyError> {
        if self.task_graph_revision != Some(self.plan_revision) {
            return Err(TaskTopologyError::Unavailable {
                plan_revision: self.plan_revision,
            });
        }
        if !self.task_dependencies.contains_key(root) {
            return Err(TaskTopologyError::UnknownRoot(root.to_string()));
        }

        let mut dependents = BTreeMap::<TaskId, BTreeSet<TaskId>>::new();
        for (task_id, dependencies) in &self.task_dependencies {
            for dependency in dependencies {
                dependents
                    .entry(dependency.clone())
                    .or_default()
                    .insert(task_id.clone());
            }
        }
        let mut branch = BTreeSet::from([root.clone()]);
        let mut pending = vec![root.clone()];
        while let Some(task_id) = pending.pop() {
            if let Some(children) = dependents.get(&task_id) {
                for child in children {
                    if branch.insert(child.clone()) {
                        pending.push(child.clone());
                    }
                }
            }
        }
        Ok(branch.into_iter().collect())
    }

    fn transition_run(&mut self, next: RunState) -> Result<(), ProjectionError> {
        self.state.validate_transition(next)?;
        self.state = next;
        Ok(())
    }

    fn task(&self, task_id: &TaskId) -> Result<&TaskProjection, ProjectionError> {
        self.tasks
            .get(task_id)
            .ok_or_else(|| ProjectionError::UnknownTask(task_id.to_string()))
    }

    fn task_mut(&mut self, task_id: &TaskId) -> Result<&mut TaskProjection, ProjectionError> {
        self.tasks
            .get_mut(task_id)
            .ok_or_else(|| ProjectionError::UnknownTask(task_id.to_string()))
    }

    fn agent(&self, agent_id: &AgentId) -> Result<&AgentProjection, ProjectionError> {
        self.agents
            .get(agent_id)
            .ok_or_else(|| ProjectionError::UnknownAgent(agent_id.to_string()))
    }

    fn agent_mut(&mut self, agent_id: &AgentId) -> Result<&mut AgentProjection, ProjectionError> {
        self.agents
            .get_mut(agent_id)
            .ok_or_else(|| ProjectionError::UnknownAgent(agent_id.to_string()))
    }

    fn ensure_optional_task(&self, task_id: Option<&TaskId>) -> Result<(), ProjectionError> {
        if let Some(task_id) = task_id {
            self.task(task_id)?;
        }
        Ok(())
    }

    fn ensure_worker_scope(
        &self,
        task_id: Option<&TaskId>,
        agent_id: &AgentId,
    ) -> Result<(), ProjectionError> {
        self.ensure_optional_task(task_id)?;
        let agent = self.agent(agent_id)?;
        if agent.task_id.as_ref() != task_id {
            return Err(ProjectionError::StateMismatch {
                entity: "agent task scope",
                expected: format!("{:?}", agent.task_id),
                actual: format!("{task_id:?}"),
            });
        }
        Ok(())
    }
}

fn default_protocol_version() -> ProtocolVersion {
    ProtocolVersion::V1
}

fn is_acyclic(dependencies: &BTreeMap<TaskId, BTreeSet<TaskId>>) -> bool {
    let mut remaining_dependencies = dependencies
        .iter()
        .map(|(task_id, prerequisites)| (task_id.clone(), prerequisites.len()))
        .collect::<BTreeMap<_, _>>();
    let mut dependents = BTreeMap::<TaskId, BTreeSet<TaskId>>::new();
    for (task_id, prerequisites) in dependencies {
        for prerequisite in prerequisites {
            dependents
                .entry(prerequisite.clone())
                .or_default()
                .insert(task_id.clone());
        }
    }
    let mut ready = remaining_dependencies
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(task_id, _)| task_id.clone())
        .collect::<BTreeSet<_>>();
    let mut visited = 0_usize;
    while let Some(task_id) = ready.iter().next().cloned() {
        ready.remove(&task_id);
        visited += 1;
        if let Some(children) = dependents.get(&task_id) {
            for child in children {
                let Some(count) = remaining_dependencies.get_mut(child) else {
                    return false;
                };
                *count -= 1;
                if *count == 0 {
                    ready.insert(child.clone());
                }
            }
        }
    }
    visited == dependencies.len()
}

fn ensure_state<T: std::fmt::Debug + PartialEq>(
    entity: &'static str,
    actual: T,
    expected: T,
) -> Result<(), ProjectionError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ProjectionError::StateMismatch {
            entity,
            expected: format!("{expected:?}"),
            actual: format!("{actual:?}"),
        })
    }
}

fn is_terminal_run(state: RunState) -> bool {
    matches!(
        state,
        RunState::Completed | RunState::Failed | RunState::Cancelled
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(state: TaskState) -> TaskProjection {
        TaskProjection {
            name: format!("{state:?}"),
            role: None,
            state,
            result: None,
            failure: None,
            latest_outcome: None,
            latest_recovery_decision: None,
            retry_attempts: 0,
        }
    }

    fn projection(run_state: RunState, dependency_state: TaskState) -> RunProjection {
        let dependency = TaskId::new("repair").unwrap();
        let retest = TaskId::new("retest").unwrap();
        let paused = TaskId::new("paused").unwrap();
        RunProjection {
            run_id: RunId::new("run-dispatchable").unwrap(),
            state: run_state,
            goal: "repair and retest".to_string(),
            user_requirement_revision: 0,
            user_requirements: BTreeMap::new(),
            execution_obligations: BTreeMap::new(),
            authorization_revision: 0,
            task_workspace_grant: None,
            plan_revision: 1,
            tasks: BTreeMap::from([
                (dependency.clone(), task(dependency_state)),
                (retest.clone(), task(TaskState::RepairPending)),
                (paused.clone(), task(TaskState::Paused)),
            ]),
            agents: BTreeMap::new(),
            completion_requirement_evidence: BTreeMap::new(),
            completion_execution_obligation_evidence: BTreeMap::new(),
            last_sequence: 1,
            resolved_user_inputs: BTreeMap::new(),
            protocol_version: ProtocolVersion::CURRENT,
            plan_task_ids: BTreeSet::from([dependency.clone(), retest.clone(), paused.clone()]),
            task_graph_revision: Some(1),
            task_dependencies: BTreeMap::from([
                (dependency, BTreeSet::new()),
                (retest, BTreeSet::from([TaskId::new("repair").unwrap()])),
                (paused, BTreeSet::new()),
            ]),
            seen_event_ids: BTreeSet::new(),
        }
    }

    #[test]
    fn dispatchability_uses_projection_state_for_retest_and_recovery() {
        let running = projection(RunState::Running, TaskState::Succeeded);
        assert_eq!(
            running.dispatchable_task_ids().unwrap(),
            vec![TaskId::new("retest").unwrap()]
        );

        let blocked = projection(RunState::Running, TaskState::Failed);
        assert!(blocked.dispatchable_task_ids().unwrap().is_empty());

        let recovering = projection(RunState::Recovering, TaskState::Succeeded);
        assert_eq!(
            recovering.dispatchable_task_ids().unwrap(),
            vec![
                TaskId::new("paused").unwrap(),
                TaskId::new("retest").unwrap()
            ]
        );
    }
}
