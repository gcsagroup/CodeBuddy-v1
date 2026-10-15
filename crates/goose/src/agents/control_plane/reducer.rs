use super::plan::{install_plan, register_worker};
use super::{ControlEffect, WorkerStopMode};
use crate::agents::protocol::{
    AgentId, AgentState, ControlCommand, EvidenceRef, ProtocolError, RunEventPayload, RunId,
    RunState, TaskId, TaskState,
};
use crate::agents::reporting::{RunProjection, TaskTopologyError};
use std::collections::BTreeSet;

mod worker_outcome;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventIntent {
    pub task_id: Option<TaskId>,
    pub agent_id: Option<AgentId>,
    pub payload: RunEventPayload,
    pub evidence_refs: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectIntent {
    pub trigger_event_index: usize,
    pub effect: ControlEffect,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reduction {
    pub events: Vec<EventIntent>,
    pub effects: Vec<EffectIntent>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ReducerError {
    #[error("control command validation failed: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("a run event stream already exists")]
    StreamAlreadyExists,
    #[error("{kind} requires an existing run event stream")]
    MissingStream { kind: &'static str },
    #[error("command belongs to run {actual}, expected {expected}")]
    RunMismatch { expected: String, actual: String },
    #[error("the run must be running to start a task, actual state: {0:?}")]
    RunNotRunning(RunState),
    #[error("unknown task: {0}")]
    UnknownTask(String),
    #[error("unknown agent: {0}")]
    UnknownAgent(String),
    #[error("agent already exists: {0}")]
    AgentAlreadyExists(String),
    #[error("task {task_id} already has active worker {agent_id}")]
    TaskWorkerAlreadyRegistered { task_id: String, agent_id: String },
    #[error("task {0} requires a registered worker outcome submitter")]
    TaskOutcomeSubmitterRequired(String),
    #[error("worker role mismatch for task {task_id}: expected {expected:?}, actual {actual:?}")]
    WorkerRoleMismatch {
        task_id: String,
        expected: crate::agents::AgentRole,
        actual: crate::agents::AgentRole,
    },
    #[error("plan revision mismatch: expected {expected}, actual {actual}")]
    PlanRevision { expected: u32, actual: u32 },
    #[error("plan task identity changed across revisions: {0}")]
    PlanTaskIdentityChanged(String),
    #[error("run state {0:?} cannot install a plan")]
    PlanInstallState(RunState),
    #[error("agent {agent_id} cannot be stopped from state {state:?}")]
    AgentNotStoppable { agent_id: String, state: AgentState },
    #[error("task {task_id} is already terminal in state {state:?}")]
    TaskIsTerminal { task_id: String, state: TaskState },
    #[error("run is already terminal in state {0:?}")]
    RunIsTerminal(RunState),
    #[error("run completion is blocked by task {task_id} in state {state:?}")]
    RunCompletionBlocked { task_id: String, state: TaskState },
    #[error("run completion requires a current host acceptance assessment: {0}")]
    CompletionEvidenceMissing(String),
    #[error("run completion is blocked: {0:?}")]
    CompletionBlocked(Vec<super::ConvergenceBlocker>),
    #[error("branch cancellation requires authoritative task topology")]
    BranchTopologyUnavailable,
    #[error("task branch rooted at {0} has no active work to cancel")]
    BranchAlreadyTerminal(String),
    #[error("task {task_id} must be ready, actual state: {actual:?}")]
    TaskNotReady { task_id: String, actual: TaskState },
    #[error("task {task_id} must be running to accept a worker outcome, actual state: {actual:?}")]
    TaskNotRunning { task_id: String, actual: TaskState },
    #[error("invalid run transition for {kind}: {from:?} -> {to:?}")]
    InvalidRunTransition {
        kind: &'static str,
        from: RunState,
        to: RunState,
    },
    #[error("control command is deferred to a later control-plane slice: {kind}")]
    DeferredCommand { kind: &'static str },
    #[error("a successful reduction must emit at least one event")]
    EmptyReduction,
    #[error(
        "effect {effect_index} refers to event {event_index}, but only {event_count} events exist"
    )]
    InvalidEffectIndex {
        effect_index: usize,
        event_index: usize,
        event_count: usize,
    },
    #[error("effect {effect_index} does not match its authorizing event scope")]
    EffectScopeMismatch { effect_index: usize },
}

impl Reduction {
    pub fn validate(&self) -> Result<(), ReducerError> {
        if self.events.is_empty() {
            return Err(ReducerError::EmptyReduction);
        }
        for (effect_index, intent) in self.effects.iter().enumerate() {
            let event = self.events.get(intent.trigger_event_index).ok_or(
                ReducerError::InvalidEffectIndex {
                    effect_index,
                    event_index: intent.trigger_event_index,
                    event_count: self.events.len(),
                },
            )?;
            let authorized = match (&intent.effect, &event.payload) {
                (
                    ControlEffect::DispatchTask { task_id, .. },
                    RunEventPayload::TaskStateChanged {
                        task_id: payload_task_id,
                        from: TaskState::Ready | TaskState::RepairPending | TaskState::Paused,
                        to: TaskState::Running,
                    },
                ) => event.task_id.as_ref() == Some(task_id) && payload_task_id == task_id,
                (
                    ControlEffect::RetryTask {
                        task_id,
                        attempt,
                        delay_ms,
                        ..
                    },
                    RunEventPayload::TaskRetryScheduled {
                        task_id: payload_task_id,
                        attempt: payload_attempt,
                        delay_ms: payload_delay_ms,
                        ..
                    },
                ) => {
                    event.task_id.as_ref() == Some(task_id)
                        && payload_task_id == task_id
                        && payload_attempt == attempt
                        && payload_delay_ms == delay_ms
                }
                (ControlEffect::PauseScheduling { .. }, RunEventPayload::RunPaused { .. })
                | (
                    ControlEffect::RecoverRun { .. },
                    RunEventPayload::RunStateChanged {
                        from: RunState::Running | RunState::Paused | RunState::Cancelled,
                        to: RunState::Recovering,
                    },
                ) => event.task_id.is_none() && event.agent_id.is_none(),
                (
                    ControlEffect::StopWorkers { agent_ids, .. },
                    RunEventPayload::AgentStateChanged {
                        agent_id,
                        to: AgentState::Stopping,
                        ..
                    },
                ) => {
                    agent_ids.len() == 1
                        && unique_agent_ids(agent_ids)
                        && agent_ids.first() == Some(agent_id)
                        && has_stopping_events(&self.events, agent_ids)
                }
                (
                    ControlEffect::StopWorkers { agent_ids, .. },
                    RunEventPayload::TaskStateChanged {
                        task_id,
                        to: TaskState::Cancelled,
                        ..
                    },
                ) => {
                    !agent_ids.is_empty()
                        && unique_agent_ids(agent_ids)
                        && has_scoped_stopping_events(&self.events, agent_ids, task_id)
                }
                (
                    ControlEffect::EmergencyStop { agent_ids, .. },
                    RunEventPayload::RunCancelled { .. },
                ) => {
                    event.task_id.is_none()
                        && event.agent_id.is_none()
                        && unique_agent_ids(agent_ids)
                        && has_stopping_events(&self.events, agent_ids)
                }
                (
                    ControlEffect::AbortFailedRun { agent_ids, .. },
                    RunEventPayload::RunFailed { .. },
                ) => {
                    event.task_id.is_none()
                        && event.agent_id.is_none()
                        && unique_agent_ids(agent_ids)
                        && has_stopping_events(&self.events, agent_ids)
                }
                _ => false,
            };
            if !authorized {
                return Err(ReducerError::EffectScopeMismatch { effect_index });
            }
        }
        Ok(())
    }
}

pub fn reduce(
    projection: Option<&RunProjection>,
    command: &ControlCommand,
) -> Result<Reduction, ReducerError> {
    command.validate()?;
    let reduction = match (projection, command) {
        (None, ControlCommand::StartRun { goal, run_id: _ }) => Reduction {
            events: vec![EventIntent {
                task_id: None,
                agent_id: None,
                payload: RunEventPayload::RunStarted { goal: goal.clone() },
                evidence_refs: vec![],
            }],
            effects: vec![],
        },
        (Some(_), ControlCommand::StartRun { .. }) => {
            return Err(ReducerError::StreamAlreadyExists);
        }
        (None, command) => {
            return Err(ReducerError::MissingStream {
                kind: command.kind(),
            });
        }
        (Some(projection), command) => reduce_existing(projection, command)?,
    };
    reduction.validate()?;
    Ok(reduction)
}

pub(crate) fn verified_user_input_replay(
    projection: &RunProjection,
    command: &ControlCommand,
) -> Result<bool, ReducerError> {
    let ControlCommand::ResolveUserInput { run_id, resolution } = command else {
        return Ok(false);
    };
    command.validate()?;
    if run_id != &projection.run_id {
        return Err(ReducerError::RunMismatch {
            expected: projection.run_id.to_string(),
            actual: run_id.to_string(),
        });
    }
    let Some(previous) = projection
        .resolved_user_inputs
        .get(&resolution.source_message_id)
    else {
        return Ok(false);
    };
    if !matches!(
        projection.state,
        RunState::Paused | RunState::Recovering | RunState::Running
    ) {
        return Err(ReducerError::RunNotRunning(projection.state));
    }
    if previous != resolution {
        return Err(ProtocolError::InvalidEnvelope(
            "user input source was already consumed with different content".to_string(),
        )
        .into());
    }
    let task = projection
        .tasks
        .get(&resolution.task_id)
        .ok_or_else(|| ReducerError::UnknownTask(resolution.task_id.to_string()))?;
    if projection.plan_revision != resolution.plan_revision
        || !matches!(&task.latest_outcome, Some(crate::agents::protocol::WorkerOutcome::WaitingForUser(question)) if question.checkpoint_id == resolution.question_checkpoint_id)
        || task.state
            != if resolution.skip {
                TaskState::Skipped
            } else {
                TaskState::Ready
            }
    {
        return Err(ProtocolError::InvalidEnvelope(
            "resolved user input is no longer awaiting dispatch".to_string(),
        )
        .into());
    }
    Ok(true)
}

fn reduce_existing(
    projection: &RunProjection,
    command: &ControlCommand,
) -> Result<Reduction, ReducerError> {
    if command.run_id() != &projection.run_id {
        return Err(ReducerError::RunMismatch {
            expected: projection.run_id.to_string(),
            actual: command.run_id().to_string(),
        });
    }

    match command {
        ControlCommand::CommitUserRequirements {
            revision,
            requirements,
            ..
        } => {
            if is_terminal_run(projection.state) {
                return Err(ReducerError::RunIsTerminal(projection.state));
            }
            let expected = projection.user_requirement_revision.saturating_add(1);
            if *revision != expected {
                return Err(ProtocolError::InvalidEnvelope(format!(
                    "user requirement revision mismatch: expected {expected}, actual {revision}"
                ))
                .into());
            }
            projection.validate_requirement_revision(requirements)?;
            Ok(Reduction {
                events: vec![EventIntent {
                    task_id: None,
                    agent_id: None,
                    payload: RunEventPayload::UserRequirementsCommitted {
                        revision: *revision,
                        requirements: requirements.clone(),
                    },
                    evidence_refs: vec![],
                }],
                effects: vec![],
            })
        }
        ControlCommand::CommitTaskWorkspaceGrant { grant, .. } => {
            if projection.state != RunState::Running {
                return Err(ReducerError::RunNotRunning(projection.state));
            }
            let task = projection
                .tasks
                .get(&grant.source_task_id)
                .ok_or_else(|| ReducerError::UnknownTask(grant.source_task_id.to_string()))?;
            if task.state != TaskState::Running {
                return Err(ReducerError::TaskNotReady {
                    task_id: grant.source_task_id.to_string(),
                    actual: task.state,
                });
            }
            if grant.requirement_revision != projection.user_requirement_revision
                || grant.authorization_revision
                    != projection.authorization_revision.saturating_add(1)
                || projection
                    .task_workspace_grant
                    .as_ref()
                    .is_some_and(|previous| previous.request_id == grant.request_id)
            {
                return Err(ProtocolError::InvalidEnvelope(
                    "task workspace grant does not match the current requirement or authorization revision"
                        .to_string(),
                )
                .into());
            }
            Ok(Reduction {
                events: vec![EventIntent {
                    task_id: None,
                    agent_id: None,
                    payload: RunEventPayload::TaskWorkspaceGrantCommitted {
                        grant: grant.clone(),
                    },
                    evidence_refs: vec![],
                }],
                effects: vec![],
            })
        }
        ControlCommand::ResolveUserInput { resolution, .. } => {
            if !matches!(
                projection.state,
                RunState::Paused | RunState::Recovering | RunState::Running
            ) {
                return Err(ReducerError::RunNotRunning(projection.state));
            }
            if verified_user_input_replay(projection, command)? {
                return Err(ProtocolError::InvalidEnvelope(
                    "committed user input requires receipt reconciliation, not a new reduction"
                        .to_string(),
                )
                .into());
            }
            if projection.plan_revision != resolution.plan_revision {
                return Err(ReducerError::PlanRevision {
                    expected: projection.plan_revision,
                    actual: resolution.plan_revision,
                });
            }
            let task = projection
                .tasks
                .get(&resolution.task_id)
                .ok_or_else(|| ReducerError::UnknownTask(resolution.task_id.to_string()))?;
            if task.state != TaskState::WaitingForUser {
                return Err(ReducerError::TaskNotReady {
                    task_id: resolution.task_id.to_string(),
                    actual: task.state,
                });
            }
            if !matches!(&task.latest_outcome, Some(crate::agents::protocol::WorkerOutcome::WaitingForUser(question))
                if question.checkpoint_id == resolution.question_checkpoint_id)
            {
                return Err(ProtocolError::InvalidEnvelope(
                    "user input question checkpoint has changed".to_string(),
                )
                .into());
            }
            Ok(Reduction {
                events: vec![
                    EventIntent {
                        task_id: Some(resolution.task_id.clone()),
                        agent_id: None,
                        payload: RunEventPayload::UserInputResolved {
                            resolution: resolution.clone(),
                        },
                        evidence_refs: vec![],
                    },
                    task_transition(
                        &resolution.task_id,
                        TaskState::WaitingForUser,
                        if resolution.skip {
                            TaskState::Skipped
                        } else {
                            TaskState::Ready
                        },
                    ),
                ],
                effects: vec![],
            })
        }
        ControlCommand::InstallPlan {
            run_id: _,
            plan_revision,
            tasks,
            revision_audit,
        } => install_plan(projection, *plan_revision, tasks, revision_audit.as_ref()),
        ControlCommand::RegisterWorker {
            task_id,
            agent_id,
            role,
            ..
        } => register_worker(projection, task_id, agent_id, *role),
        ControlCommand::StartTask { run_id, task_id } => {
            if !matches!(projection.state, RunState::Running | RunState::Recovering) {
                return Err(ReducerError::RunNotRunning(projection.state));
            }
            let task = projection
                .tasks
                .get(task_id)
                .ok_or_else(|| ReducerError::UnknownTask(task_id.to_string()))?;
            let dispatchable = projection.dispatchable_task_ids().map_err(|error| {
                ProtocolError::InvalidEnvelope(format!(
                    "current task graph cannot determine dispatchable tasks: {error}"
                ))
            })?;
            if !dispatchable.contains(task_id) {
                return Err(ReducerError::TaskNotReady {
                    task_id: task_id.to_string(),
                    actual: task.state,
                });
            }
            let mut events = Vec::with_capacity(2);
            if projection.state == RunState::Recovering {
                events.push(EventIntent {
                    task_id: None,
                    agent_id: None,
                    payload: RunEventPayload::RunStateChanged {
                        from: RunState::Recovering,
                        to: RunState::Running,
                    },
                    evidence_refs: vec![],
                });
            }
            events.push(EventIntent {
                task_id: Some(task_id.clone()),
                agent_id: None,
                payload: RunEventPayload::TaskStateChanged {
                    task_id: task_id.clone(),
                    from: task.state,
                    to: TaskState::Running,
                },
                evidence_refs: vec![],
            });
            let effects = task
                .role
                .map(|_| EffectIntent {
                    trigger_event_index: events.len() - 1,
                    effect: ControlEffect::DispatchTask {
                        run_id: run_id.clone(),
                        task_id: task_id.clone(),
                    },
                })
                .into_iter()
                .collect();
            Ok(Reduction { events, effects })
        }
        ControlCommand::RetryTask { task_id, .. } => {
            if !matches!(projection.state, RunState::Running | RunState::Recovering) {
                return Err(ReducerError::RunNotRunning(projection.state));
            }
            let task = projection
                .tasks
                .get(task_id)
                .ok_or_else(|| ReducerError::UnknownTask(task_id.to_string()))?;
            if task.state != TaskState::WaitingForCoordinator {
                return Err(ReducerError::TaskNotReady {
                    task_id: task_id.to_string(),
                    actual: task.state,
                });
            }
            let Some(crate::agents::protocol::WorkerOutcome::Failed(failure)) =
                &task.latest_outcome
            else {
                return Err(ProtocolError::InvalidEnvelope(
                    "task retry requires a recorded worker failure".to_string(),
                )
                .into());
            };
            let attempt = task.retry_attempts.checked_add(1).ok_or_else(|| {
                ProtocolError::InvalidEnvelope("task retry attempt overflowed".to_string())
            })?;
            Ok(Reduction {
                events: vec![
                    EventIntent {
                        task_id: Some(task_id.clone()),
                        agent_id: None,
                        payload: RunEventPayload::TaskRetryAuthorized {
                            task_id: task_id.clone(),
                            attempt,
                            failure: failure.clone(),
                        },
                        evidence_refs: failure.evidence_refs.clone(),
                    },
                    task_transition(task_id, TaskState::WaitingForCoordinator, TaskState::Ready),
                ],
                effects: vec![],
            })
        }
        ControlCommand::PauseRun { run_id, reason } => pause_run(projection, run_id, reason),
        ControlCommand::ResumeRun { run_id } => {
            if !matches!(
                projection.state,
                RunState::Running | RunState::Paused | RunState::Cancelled
            ) {
                return Err(ReducerError::InvalidRunTransition {
                    kind: command.kind(),
                    from: projection.state,
                    to: RunState::Recovering,
                });
            }
            ensure_run_transition(command.kind(), projection.state, RunState::Recovering)?;
            let mut events = Vec::new();
            if projection.state == RunState::Cancelled {
                events.push(EventIntent {
                    task_id: None,
                    agent_id: None,
                    payload: RunEventPayload::RunStateChanged {
                        from: projection.state,
                        to: RunState::Recovering,
                    },
                    evidence_refs: vec![],
                });
            }
            for (agent_id, agent) in &projection.agents {
                if matches!(
                    agent.state,
                    AgentState::Starting
                        | AgentState::Running
                        | AgentState::Idle
                        | AgentState::Stopping
                ) {
                    events.push(EventIntent {
                        task_id: agent.task_id.clone(),
                        agent_id: Some(agent_id.clone()),
                        payload: RunEventPayload::AgentStateChanged {
                            agent_id: agent_id.clone(),
                            task_id: agent.task_id.clone(),
                            from: agent.state,
                            to: AgentState::Crashed,
                        },
                        evidence_refs: vec![],
                    });
                }
            }
            if projection.state == RunState::Running {
                for (task_id, task) in &projection.tasks {
                    if task.state == TaskState::Running {
                        events.push(task_transition(task_id, task.state, TaskState::Paused));
                    }
                }
            } else if projection.state == RunState::Cancelled {
                for (task_id, task) in &projection.tasks {
                    if task.state == TaskState::Cancelled {
                        events.push(task_transition(task_id, task.state, TaskState::Paused));
                    }
                }
            }
            let recovery_event_index = if projection.state == RunState::Cancelled {
                0
            } else {
                events.push(EventIntent {
                    task_id: None,
                    agent_id: None,
                    payload: RunEventPayload::RunStateChanged {
                        from: projection.state,
                        to: RunState::Recovering,
                    },
                    evidence_refs: vec![],
                });
                events.len() - 1
            };
            Ok(Reduction {
                events,
                effects: vec![EffectIntent {
                    trigger_event_index: recovery_event_index,
                    effect: ControlEffect::RecoverRun {
                        run_id: run_id.clone(),
                    },
                }],
            })
        }
        ControlCommand::StopWorker {
            run_id, agent_id, ..
        } => stop_worker(projection, run_id, agent_id),
        ControlCommand::CancelTask {
            run_id, task_id, ..
        } => cancel_task(projection, run_id, task_id),
        ControlCommand::CancelBranch {
            run_id,
            root_task_id,
            ..
        } => cancel_branch(projection, run_id, root_task_id),
        ControlCommand::CancelRun { run_id, reason } => cancel_run(projection, run_id, reason),
        ControlCommand::EmergencyStop { run_id, reason } => cancel_run(projection, run_id, reason),
        ControlCommand::CompleteRun {
            summary, proposal, ..
        } => complete_run(projection, summary, proposal.as_ref()),
        ControlCommand::FailRun {
            run_id,
            class,
            message,
            evidence_refs,
        } => fail_run(projection, run_id, *class, message, evidence_refs),
        ControlCommand::SubmitTaskOutcome {
            run_id,
            task_id,
            agent_id,
            outcome,
        } => worker_outcome::submit(projection, run_id, task_id, agent_id.as_ref(), outcome),
        ControlCommand::RecordCoordinatorAudit { audit, .. } => Ok(Reduction {
            events: vec![EventIntent {
                task_id: None,
                agent_id: None,
                payload: RunEventPayload::CoordinatorAuditRecorded {
                    audit: audit.clone(),
                },
                evidence_refs: vec![],
            }],
            effects: vec![],
        }),
        ControlCommand::RevisePlan { .. } | ControlCommand::ApplyCoordinatorDecision { .. } => {
            Err(ReducerError::DeferredCommand {
                kind: command.kind(),
            })
        }
        ControlCommand::StartRun { .. } => Err(ReducerError::StreamAlreadyExists),
    }
}

fn complete_run(
    projection: &RunProjection,
    summary: &str,
    proposal: Option<&super::CompletionProposal>,
) -> Result<Reduction, ReducerError> {
    if is_terminal_run(projection.state) {
        return Err(ReducerError::RunIsTerminal(projection.state));
    }
    if projection.state != RunState::Running {
        return Err(ReducerError::InvalidRunTransition {
            kind: "complete_run",
            from: projection.state,
            to: RunState::Completed,
        });
    }
    let proposal = proposal.ok_or_else(|| {
        ReducerError::CompletionEvidenceMissing("completion proposal not supplied".to_string())
    })?;
    let (assessment_projection, mut events, effects) =
        if let Some(task_id) = proposal.completion_task_id.as_ref() {
            let mut evidence_refs = Vec::new();
            for evidence in proposal
                .requirement_coverage
                .iter()
                .flat_map(|coverage| coverage.evidence_refs.iter())
            {
                if !evidence_refs.contains(evidence) {
                    evidence_refs.push(evidence.clone());
                }
            }
            let result = crate::agents::protocol::TaskResult {
                summary: summary.to_string(),
                evidence_refs,
            };
            let outcome = crate::agents::protocol::WorkerOutcome::Succeeded(result.clone());
            let reduction =
                worker_outcome::submit(projection, &projection.run_id, task_id, None, &outcome)?;
            let mut prospective = projection.clone();
            let task = prospective
                .tasks
                .get_mut(task_id)
                .ok_or_else(|| ReducerError::UnknownTask(task_id.to_string()))?;
            task.latest_outcome = Some(outcome);
            task.latest_recovery_decision = Some(
                task.latest_outcome
                    .as_ref()
                    .expect("prospective outcome was assigned")
                    .recovery_decision(),
            );
            task.state = TaskState::Succeeded;
            task.result = Some(result);
            task.failure = None;
            (prospective, reduction.events, reduction.effects)
        } else {
            (projection.clone(), Vec::new(), Vec::new())
        };
    let requirements =
        super::CompletionRequirements::host_derived(&assessment_projection, proposal);
    let assessment = super::ConvergenceEngine::assess(&assessment_projection, &requirements);
    if assessment.status != super::ConvergenceStatus::Eligible {
        return Err(ReducerError::CompletionBlocked(assessment.blockers));
    }
    events.push(EventIntent {
        task_id: None,
        agent_id: None,
        payload: RunEventPayload::RunCompleted {
            summary: summary.to_string(),
            requirement_evidence: requirements.requirement_coverage.clone(),
            execution_obligation_evidence: requirements
                .execution_obligation_coverage
                .iter()
                .map(|(obligation_id, coverage)| {
                    (obligation_id.clone(), coverage.evidence_refs.clone())
                })
                .collect(),
        },
        evidence_refs: requirements.goal_evidence().to_vec(),
    });
    Ok(Reduction { events, effects })
}

fn fail_run(
    projection: &RunProjection,
    run_id: &RunId,
    class: crate::agents::protocol::FailureClass,
    message: &str,
    evidence_refs: &[EvidenceRef],
) -> Result<Reduction, ReducerError> {
    if is_terminal_run(projection.state) {
        return Err(ReducerError::RunIsTerminal(projection.state));
    }
    ensure_run_transition("fail_run", projection.state, RunState::Failed)?;
    let mut events = Vec::new();
    let mut agent_ids = Vec::new();
    for (agent_id, agent) in &projection.agents {
        if is_stoppable_agent(agent.state) {
            agent_ids.push(agent_id.clone());
            events.push(agent_stopping(agent_id, agent.task_id.clone(), agent.state));
        }
    }
    for (task_id, task) in &projection.tasks {
        if !is_terminal_task(task.state) {
            events.push(task_transition(task_id, task.state, TaskState::Cancelled));
        }
    }
    events.push(EventIntent {
        task_id: None,
        agent_id: None,
        payload: RunEventPayload::RunFailed {
            class,
            message: message.to_string(),
            evidence_refs: evidence_refs.to_vec(),
        },
        evidence_refs: evidence_refs.to_vec(),
    });
    let trigger_event_index = events.len() - 1;
    Ok(Reduction {
        events,
        effects: vec![EffectIntent {
            trigger_event_index,
            effect: ControlEffect::AbortFailedRun {
                run_id: run_id.clone(),
                agent_ids,
            },
        }],
    })
}

fn stop_worker(
    projection: &RunProjection,
    run_id: &RunId,
    agent_id: &AgentId,
) -> Result<Reduction, ReducerError> {
    if is_terminal_run(projection.state) {
        return Err(ReducerError::RunIsTerminal(projection.state));
    }
    let agent = projection
        .agents
        .get(agent_id)
        .ok_or_else(|| ReducerError::UnknownAgent(agent_id.to_string()))?;
    if !is_stoppable_agent(agent.state) {
        return Err(ReducerError::AgentNotStoppable {
            agent_id: agent_id.to_string(),
            state: agent.state,
        });
    }
    let mut events = vec![EventIntent {
        task_id: agent.task_id.clone(),
        agent_id: Some(agent_id.clone()),
        payload: RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: agent.task_id.clone(),
            from: agent.state,
            to: AgentState::Stopping,
        },
        evidence_refs: vec![],
    }];
    if let Some(task_id) = &agent.task_id {
        let task = projection
            .tasks
            .get(task_id)
            .ok_or_else(|| ReducerError::UnknownTask(task_id.to_string()))?;
        if task.state == TaskState::Running {
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::WaitingForCoordinator,
            ));
        }
    }
    Ok(Reduction {
        events,
        effects: vec![EffectIntent {
            trigger_event_index: 0,
            effect: ControlEffect::StopWorkers {
                run_id: run_id.clone(),
                agent_ids: vec![agent_id.clone()],
                mode: WorkerStopMode::CooperativeThenForce,
            },
        }],
    })
}

/// Consume confirmed lifecycle observations without changing task/run outcomes.
pub(super) fn confirm_stopped_workers(
    projection: &RunProjection,
    agent_ids: &[AgentId],
) -> Result<Reduction, ReducerError> {
    let mut events = Vec::new();
    for agent_id in agent_ids {
        let agent = projection
            .agents
            .get(agent_id)
            .ok_or_else(|| ReducerError::UnknownAgent(agent_id.to_string()))?;
        if agent.state != AgentState::Stopping {
            return Err(ReducerError::AgentNotStoppable {
                agent_id: agent_id.to_string(),
                state: agent.state,
            });
        }
        events.push(EventIntent {
            task_id: agent.task_id.clone(),
            agent_id: Some(agent_id.clone()),
            payload: RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: agent.task_id.clone(),
                from: AgentState::Stopping,
                to: AgentState::Stopped,
            },
            evidence_refs: vec![],
        });
    }
    Ok(Reduction {
        events,
        effects: vec![],
    })
}

fn cancel_task(
    projection: &RunProjection,
    run_id: &RunId,
    task_id: &TaskId,
) -> Result<Reduction, ReducerError> {
    if is_terminal_run(projection.state) {
        return Err(ReducerError::RunIsTerminal(projection.state));
    }
    let task = projection
        .tasks
        .get(task_id)
        .ok_or_else(|| ReducerError::UnknownTask(task_id.to_string()))?;
    if is_terminal_task(task.state) {
        return Err(ReducerError::TaskIsTerminal {
            task_id: task_id.to_string(),
            state: task.state,
        });
    }

    let mut events = Vec::new();
    let mut agent_ids = Vec::new();
    for (agent_id, agent) in &projection.agents {
        if agent.task_id.as_ref() != Some(task_id) {
            continue;
        }
        match agent.state {
            AgentState::Starting | AgentState::Running | AgentState::Idle => {
                agent_ids.push(agent_id.clone());
                events.push(agent_stopping(agent_id, Some(task_id.clone()), agent.state));
            }
            AgentState::Stopping => {}
            AgentState::Stopped | AgentState::Crashed => {}
        }
    }
    events.push(task_transition(task_id, task.state, TaskState::Cancelled));
    let trigger_event_index = events.len() - 1;
    let effects = if agent_ids.is_empty() {
        vec![]
    } else {
        vec![EffectIntent {
            trigger_event_index,
            effect: ControlEffect::StopWorkers {
                run_id: run_id.clone(),
                agent_ids,
                mode: WorkerStopMode::CooperativeThenForce,
            },
        }]
    };
    Ok(Reduction { events, effects })
}

fn cancel_branch(
    projection: &RunProjection,
    run_id: &RunId,
    root_task_id: &TaskId,
) -> Result<Reduction, ReducerError> {
    if is_terminal_run(projection.state) {
        return Err(ReducerError::RunIsTerminal(projection.state));
    }
    if !projection.tasks.contains_key(root_task_id) {
        return Err(ReducerError::UnknownTask(root_task_id.to_string()));
    }
    let branch_task_ids =
        projection
            .branch_task_ids(root_task_id)
            .map_err(|error| match error {
                TaskTopologyError::Unavailable { .. } => ReducerError::BranchTopologyUnavailable,
                TaskTopologyError::UnknownRoot(task_id) => ReducerError::UnknownTask(task_id),
                TaskTopologyError::Invalid(_) => ReducerError::BranchTopologyUnavailable,
            })?;
    let branch = branch_task_ids.iter().collect::<BTreeSet<_>>();
    let mut events = Vec::new();
    let mut effects = Vec::new();

    for (agent_id, agent) in &projection.agents {
        let Some(task_id) = agent.task_id.as_ref() else {
            continue;
        };
        if !branch.contains(task_id) || !is_stoppable_agent(agent.state) {
            continue;
        }
        let trigger_event_index = events.len();
        events.push(agent_stopping(agent_id, Some(task_id.clone()), agent.state));
        effects.push(EffectIntent {
            trigger_event_index,
            effect: ControlEffect::StopWorkers {
                run_id: run_id.clone(),
                agent_ids: vec![agent_id.clone()],
                mode: WorkerStopMode::CooperativeThenForce,
            },
        });
    }
    for task_id in branch_task_ids {
        let task = projection
            .tasks
            .get(&task_id)
            .ok_or_else(|| ReducerError::UnknownTask(task_id.to_string()))?;
        if !is_terminal_task(task.state) {
            events.push(task_transition(&task_id, task.state, TaskState::Cancelled));
        }
    }
    if events.is_empty() {
        return Err(ReducerError::BranchAlreadyTerminal(
            root_task_id.to_string(),
        ));
    }
    Ok(Reduction { events, effects })
}

fn cancel_run(
    projection: &RunProjection,
    run_id: &RunId,
    reason: &str,
) -> Result<Reduction, ReducerError> {
    if is_terminal_run(projection.state) {
        return Err(ReducerError::RunIsTerminal(projection.state));
    }
    let mut events = Vec::new();
    let mut agent_ids = Vec::new();
    for (agent_id, agent) in &projection.agents {
        if is_stoppable_agent(agent.state) {
            agent_ids.push(agent_id.clone());
            events.push(agent_stopping(agent_id, agent.task_id.clone(), agent.state));
        }
    }
    for (task_id, task) in &projection.tasks {
        if !is_terminal_task(task.state) {
            events.push(task_transition(task_id, task.state, TaskState::Cancelled));
        }
    }
    events.push(EventIntent {
        task_id: None,
        agent_id: None,
        payload: RunEventPayload::RunCancelled {
            reason: reason.to_string(),
        },
        evidence_refs: vec![],
    });
    let trigger_event_index = events.len() - 1;
    Ok(Reduction {
        events,
        effects: vec![EffectIntent {
            trigger_event_index,
            effect: ControlEffect::EmergencyStop {
                run_id: run_id.clone(),
                agent_ids,
            },
        }],
    })
}

fn pause_run(
    projection: &RunProjection,
    run_id: &RunId,
    reason: &str,
) -> Result<Reduction, ReducerError> {
    ensure_run_transition("pause_run", projection.state, RunState::Paused)?;
    let mut events = Vec::new();
    for (task_id, task) in &projection.tasks {
        let active_worker = projection
            .active_worker_for_task(task_id)
            .map_err(|error| ProtocolError::InvalidEnvelope(error.to_string()))?;
        if task.state == TaskState::Running && active_worker.is_none() {
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::Paused,
            ));
        }
    }
    events.push(EventIntent {
        task_id: None,
        agent_id: None,
        payload: RunEventPayload::RunPaused {
            reason: reason.to_string(),
            checkpoint: None,
        },
        evidence_refs: vec![],
    });
    let trigger_event_index = events.len() - 1;
    Ok(Reduction {
        events,
        effects: vec![EffectIntent {
            trigger_event_index,
            effect: ControlEffect::PauseScheduling {
                run_id: run_id.clone(),
            },
        }],
    })
}

fn agent_stopping(agent_id: &AgentId, task_id: Option<TaskId>, from: AgentState) -> EventIntent {
    EventIntent {
        task_id: task_id.clone(),
        agent_id: Some(agent_id.clone()),
        payload: RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id,
            from,
            to: AgentState::Stopping,
        },
        evidence_refs: vec![],
    }
}

fn task_transition(task_id: &TaskId, from: TaskState, to: TaskState) -> EventIntent {
    EventIntent {
        task_id: Some(task_id.clone()),
        agent_id: None,
        payload: RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from,
            to,
        },
        evidence_refs: vec![],
    }
}

fn is_stoppable_agent(state: AgentState) -> bool {
    matches!(
        state,
        AgentState::Starting | AgentState::Running | AgentState::Idle
    )
}

fn is_terminal_task(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Succeeded
            | TaskState::RepairExhausted
            | TaskState::Failed
            | TaskState::Cancelled
            | TaskState::Skipped
    )
}

fn is_terminal_run(state: RunState) -> bool {
    matches!(
        state,
        RunState::Completed | RunState::Failed | RunState::Cancelled
    )
}

fn has_stopping_events(events: &[EventIntent], agent_ids: &[AgentId]) -> bool {
    agent_ids.iter().all(|expected| {
        events.iter().any(|event| {
            matches!(
                &event.payload,
                RunEventPayload::AgentStateChanged {
                    agent_id,
                    to: AgentState::Stopping,
                    ..
                } if agent_id == expected && event.agent_id.as_ref() == Some(expected)
            )
        })
    })
}

fn unique_agent_ids(agent_ids: &[AgentId]) -> bool {
    agent_ids.iter().collect::<BTreeSet<_>>().len() == agent_ids.len()
}

fn has_scoped_stopping_events(
    events: &[EventIntent],
    agent_ids: &[AgentId],
    task_id: &TaskId,
) -> bool {
    has_stopping_events(events, agent_ids)
        && agent_ids.iter().all(|expected| {
            events.iter().any(|event| {
                event.task_id.as_ref() == Some(task_id)
                    && event.agent_id.as_ref() == Some(expected)
                    && matches!(
                        &event.payload,
                        RunEventPayload::AgentStateChanged {
                            agent_id,
                            task_id: Some(payload_task_id),
                            to: AgentState::Stopping,
                            ..
                        } if agent_id == expected && payload_task_id == task_id
                    )
            })
        })
}

fn ensure_run_transition(
    kind: &'static str,
    from: RunState,
    to: RunState,
) -> Result<(), ReducerError> {
    from.validate_transition(to)
        .map_err(|_| ReducerError::InvalidRunTransition { kind, from, to })
}
