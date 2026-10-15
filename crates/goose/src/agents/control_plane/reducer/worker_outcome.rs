use super::{agent_stopping, task_transition, EffectIntent, EventIntent, ReducerError, Reduction};
use crate::agents::control_plane::{ControlEffect, FailureDisposition, FailurePolicy};
use crate::agents::protocol::{
    AgentId, AgentState, BlockKind, FailureClass, RunEventPayload, RunId, RunState, TaskId,
    TaskState, WorkerOutcome,
};
use crate::agents::reporting::RunProjection;
use std::collections::BTreeMap;

pub(super) fn submit(
    projection: &RunProjection,
    run_id: &RunId,
    task_id: &TaskId,
    agent_id: Option<&AgentId>,
    outcome: &WorkerOutcome,
) -> Result<Reduction, ReducerError> {
    if projection.state != RunState::Running {
        return Err(ReducerError::RunNotRunning(projection.state));
    }
    let task = projection
        .tasks
        .get(task_id)
        .ok_or_else(|| ReducerError::UnknownTask(task_id.to_string()))?;
    if task.state != TaskState::Running {
        return Err(ReducerError::TaskNotRunning {
            task_id: task_id.to_string(),
            actual: task.state,
        });
    }
    let agent_state = match agent_id {
        Some(agent_id) => {
            let worker_owner = projection
                .active_worker_for_task(task_id)
                .map_err(|error| {
                    crate::agents::protocol::ProtocolError::InvalidEnvelope(error.to_string())
                })?;
            if worker_owner.as_ref() != Some(agent_id) {
                return Err(ReducerError::TaskOutcomeSubmitterRequired(
                    task_id.to_string(),
                ));
            }
            let agent = projection
                .agents
                .get(agent_id)
                .ok_or_else(|| ReducerError::UnknownAgent(agent_id.to_string()))?;
            if agent.task_id.as_ref() != Some(task_id) {
                return Err(ReducerError::UnknownAgent(agent_id.to_string()));
            }
            if !matches!(agent.state, AgentState::Running | AgentState::Idle) {
                return Err(ReducerError::AgentNotStoppable {
                    agent_id: agent_id.to_string(),
                    state: agent.state,
                });
            }
            Some(agent.state)
        }
        None => {
            let worker_owner = projection
                .active_worker_for_task(task_id)
                .map_err(|error| {
                    crate::agents::protocol::ProtocolError::InvalidEnvelope(error.to_string())
                })?;
            if task.role.is_some()
                || worker_owner.is_some()
                || matches!(outcome, WorkerOutcome::NeedsHelp(_))
            {
                return Err(ReducerError::TaskOutcomeSubmitterRequired(
                    task_id.to_string(),
                ));
            }
            None
        }
    };

    let mut events = vec![accepted_outcome(task_id, agent_id, outcome)];
    let mut effects = Vec::new();
    match outcome {
        WorkerOutcome::Succeeded(result) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            events.push(EventIntent {
                task_id: Some(task_id.clone()),
                agent_id: None,
                payload: RunEventPayload::TaskSucceeded {
                    task_id: task_id.clone(),
                    result: result.clone(),
                },
                evidence_refs: vec![],
            });
            if let Ok(graph) = projection.current_task_graph() {
                let mut states = projection
                    .tasks
                    .iter()
                    .map(|(id, task)| (id.clone(), task.state))
                    .collect::<BTreeMap<_, _>>();
                states.insert(task_id.clone(), TaskState::Succeeded);
                let ready = graph.ready_task_ids(&states).map_err(|error| {
                    crate::agents::protocol::ProtocolError::InvalidEnvelope(format!(
                        "current task graph cannot determine ready tasks: {error}"
                    ))
                })?;
                events.extend(ready.into_iter().map(|ready_task_id| {
                    task_transition(&ready_task_id, TaskState::Proposed, TaskState::Ready)
                }));
            }
        }
        WorkerOutcome::Skipped(_) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::Skipped,
            ));
        }
        WorkerOutcome::VerificationFailed(_) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::VerificationFailed,
            ));
        }
        WorkerOutcome::RepairPending(checkpoint) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            save_checkpoint(&mut events, task_id, checkpoint);
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::RepairPending,
            ));
        }
        WorkerOutcome::WaitingForUser(checkpoint) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            save_checkpoint(&mut events, task_id, checkpoint);
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::WaitingForUser,
            ));
        }
        WorkerOutcome::RepairExhausted(_) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::RepairExhausted,
            ));
        }
        WorkerOutcome::Failed(failure) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            let waiting_state = if matches!(
                failure.class,
                FailureClass::PermissionDenied | FailureClass::PolicyViolation
            ) {
                TaskState::WaitingForApproval
            } else {
                TaskState::WaitingForCoordinator
            };
            events.push(task_transition(task_id, TaskState::Running, waiting_state));
            if waiting_state == TaskState::WaitingForCoordinator {
                if let FailureDisposition::Retry { attempt, delay_ms } =
                    FailurePolicy::default().classify(failure, task.retry_attempts)
                {
                    schedule_retry(
                        &mut events,
                        &mut effects,
                        run_id,
                        task_id,
                        failure,
                        attempt,
                        delay_ms,
                    );
                }
            }
        }
        WorkerOutcome::Blocked(reason) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            let next = if matches!(reason.kind, BlockKind::Permission | BlockKind::UserInput) {
                TaskState::WaitingForApproval
            } else {
                TaskState::WaitingForCoordinator
            };
            events.push(task_transition(task_id, TaskState::Running, next));
        }
        WorkerOutcome::NeedsHelp(request) => {
            let agent_id = agent_id.expect("inline needs-help outcome was rejected above");
            let agent_state = agent_state.expect("registered worker state");
            if agent_state == AgentState::Running {
                events.push(agent_idle(task_id, agent_id));
            }
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::WaitingForCoordinator,
            ));
            events.push(EventIntent {
                task_id: Some(task_id.clone()),
                agent_id: Some(agent_id.clone()),
                payload: RunEventPayload::AssistanceRequested {
                    task_id: task_id.clone(),
                    agent_id: agent_id.clone(),
                    request: request.clone(),
                },
                evidence_refs: vec![],
            });
        }
        WorkerOutcome::Paused(checkpoint) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            save_checkpoint(&mut events, task_id, checkpoint);
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::Paused,
            ));
        }
        WorkerOutcome::Cancelled(_) => {
            stop_completed_agent(&mut events, task_id, agent_id, agent_state);
            events.push(task_transition(
                task_id,
                TaskState::Running,
                TaskState::Cancelled,
            ));
        }
    }
    Ok(Reduction { events, effects })
}

fn save_checkpoint(
    events: &mut Vec<EventIntent>,
    task_id: &TaskId,
    checkpoint: &crate::agents::protocol::Checkpoint,
) {
    events.push(EventIntent {
        task_id: Some(task_id.clone()),
        agent_id: None,
        payload: RunEventPayload::CheckpointSaved {
            task_id: Some(task_id.clone()),
            checkpoint: checkpoint.clone(),
        },
        evidence_refs: vec![],
    });
}

fn accepted_outcome(
    task_id: &TaskId,
    agent_id: Option<&AgentId>,
    outcome: &WorkerOutcome,
) -> EventIntent {
    EventIntent {
        task_id: Some(task_id.clone()),
        agent_id: agent_id.cloned(),
        payload: RunEventPayload::TaskOutcomeAccepted {
            task_id: task_id.clone(),
            agent_id: agent_id.cloned(),
            outcome: outcome.clone(),
            recovery_decision: Some(outcome.recovery_decision()),
        },
        evidence_refs: vec![],
    }
}

fn agent_idle(task_id: &TaskId, agent_id: &AgentId) -> EventIntent {
    EventIntent {
        task_id: Some(task_id.clone()),
        agent_id: Some(agent_id.clone()),
        payload: RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Running,
            to: AgentState::Idle,
        },
        evidence_refs: vec![],
    }
}

fn stop_completed_agent(
    events: &mut Vec<EventIntent>,
    task_id: &TaskId,
    agent_id: Option<&AgentId>,
    current: Option<AgentState>,
) {
    let (Some(agent_id), Some(current)) = (agent_id, current) else {
        return;
    };
    events.push(agent_stopping(agent_id, Some(task_id.clone()), current));
    events.push(EventIntent {
        task_id: Some(task_id.clone()),
        agent_id: Some(agent_id.clone()),
        payload: RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Stopping,
            to: AgentState::Stopped,
        },
        evidence_refs: vec![],
    });
}

fn schedule_retry(
    events: &mut Vec<EventIntent>,
    effects: &mut Vec<EffectIntent>,
    run_id: &RunId,
    task_id: &TaskId,
    failure: &crate::agents::protocol::TaskFailure,
    attempt: u32,
    delay_ms: u64,
) {
    let trigger_event_index = events.len();
    events.push(EventIntent {
        task_id: Some(task_id.clone()),
        agent_id: None,
        payload: RunEventPayload::TaskRetryScheduled {
            task_id: task_id.clone(),
            attempt,
            delay_ms,
            failure: failure.clone(),
        },
        evidence_refs: vec![],
    });
    events.push(task_transition(
        task_id,
        TaskState::WaitingForCoordinator,
        TaskState::Ready,
    ));
    effects.push(EffectIntent {
        trigger_event_index,
        effect: ControlEffect::RetryTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            attempt,
            delay_ms,
        },
    });
}
