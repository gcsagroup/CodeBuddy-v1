use super::reducer::{EventIntent, ReducerError, Reduction};
use crate::agents::protocol::{
    AgentId, AgentState, PlanRevisionAudit, PlannedTask, RunEventPayload, RunState, TaskDependency,
    TaskId, TaskState,
};
use crate::agents::reporting::RunProjection;
use crate::agents::AgentRole;

pub(super) fn install_plan(
    projection: &RunProjection,
    plan_revision: u32,
    tasks: &[PlannedTask],
    revision_audit: Option<&PlanRevisionAudit>,
) -> Result<Reduction, ReducerError> {
    if !matches!(
        projection.state,
        RunState::Planning | RunState::Running | RunState::WaitingForUser | RunState::Recovering
    ) {
        return Err(ReducerError::PlanInstallState(projection.state));
    }
    let expected_revision = projection.plan_revision.saturating_add(1);
    if plan_revision != expected_revision {
        return Err(ReducerError::PlanRevision {
            expected: expected_revision,
            actual: plan_revision,
        });
    }
    if let Some(audit) = revision_audit.filter(|audit| audit.reassigned_to.is_some()) {
        validate_delegation_transfer(projection, tasks, audit)?;
    }

    let task_ids = tasks
        .iter()
        .map(|task| task.task_id.clone())
        .collect::<Vec<_>>();
    let mut events = Vec::new();
    for task in tasks {
        if let Some(existing) = projection.tasks.get(&task.task_id) {
            if existing.name != task.name || existing.role != task.role {
                return Err(ReducerError::PlanTaskIdentityChanged(
                    task.task_id.to_string(),
                ));
            }
        } else {
            events.push(EventIntent {
                task_id: Some(task.task_id.clone()),
                agent_id: None,
                payload: RunEventPayload::TaskCreated {
                    task_id: task.task_id.clone(),
                    name: task.name.clone(),
                    role: task.role,
                },
                evidence_refs: vec![],
            });
        }
    }
    events.push(EventIntent {
        task_id: None,
        agent_id: None,
        payload: if plan_revision == 1 {
            RunEventPayload::PlanProposed {
                plan_revision,
                task_ids: task_ids.clone(),
            }
        } else {
            RunEventPayload::PlanRevised {
                plan_revision,
                task_ids: task_ids.clone(),
                audit: revision_audit.cloned(),
            }
        },
        evidence_refs: revision_audit
            .map(|audit| audit.trigger_failure.evidence_refs.clone())
            .unwrap_or_default(),
    });
    events.push(EventIntent {
        task_id: None,
        agent_id: None,
        payload: RunEventPayload::TaskGraphDeclared {
            plan_revision,
            dependencies: tasks
                .iter()
                .map(|task| TaskDependency {
                    task_id: task.task_id.clone(),
                    depends_on: task.depends_on.clone(),
                })
                .collect(),
        },
        evidence_refs: vec![],
    });

    for task in tasks {
        let current_state = projection
            .tasks
            .get(&task.task_id)
            .map(|task| task.state)
            .unwrap_or(TaskState::Proposed);
        let dependencies_succeeded = task.depends_on.iter().all(|dependency| {
            projection
                .tasks
                .get(dependency)
                .is_some_and(|task| task.state == TaskState::Succeeded)
        });
        if current_state == TaskState::Proposed
            && (task.depends_on.is_empty() || dependencies_succeeded)
        {
            events.push(task_transition(
                &task.task_id,
                TaskState::Proposed,
                TaskState::Ready,
            ));
        } else if plan_revision > 1
            && current_state == TaskState::WaitingForCoordinator
            && revision_audit.is_some_and(|audit| audit.trigger_task_id == task.task_id)
            && (task.depends_on.is_empty() || dependencies_succeeded)
        {
            events.push(task_transition(
                &task.task_id,
                TaskState::WaitingForCoordinator,
                TaskState::Ready,
            ));
        } else if plan_revision > 1 && current_state == TaskState::VerificationFailed {
            events.push(task_transition(
                &task.task_id,
                TaskState::VerificationFailed,
                TaskState::RepairPending,
            ));
        }
    }
    if projection.state == RunState::Planning {
        events.push(EventIntent {
            task_id: None,
            agent_id: None,
            payload: RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
            evidence_refs: vec![],
        });
    }
    Ok(Reduction {
        events,
        effects: vec![],
    })
}

fn validate_delegation_transfer(
    projection: &RunProjection,
    tasks: &[PlannedTask],
    audit: &PlanRevisionAudit,
) -> Result<(), ReducerError> {
    let invalid = |reason: &str| {
        ReducerError::Protocol(crate::agents::protocol::ProtocolError::InvalidEnvelope(
            format!("delegation transfer rejected: {reason}"),
        ))
    };
    let source = &audit.trigger_task_id;
    let target = audit
        .reassigned_to
        .as_ref()
        .expect("transfer audit selected");
    let graph = projection
        .current_task_graph()
        .map_err(|_| invalid("current graph unavailable"))?;
    if projection.state != RunState::Running
        || source == target
        || !graph.contains_task(source)
        || !graph.contains_task(target)
        || projection
            .tasks
            .get(source)
            .is_none_or(|task| task.state != TaskState::Paused)
        || projection
            .tasks
            .get(target)
            .is_none_or(|task| task.state != TaskState::Running)
    {
        return Err(invalid(
            "requires a stopped partial task and a running replacement in the current plan",
        ));
    }
    let source_agents = projection
        .agents
        .values()
        .filter(|agent| agent.task_id.as_ref() == Some(source))
        .collect::<Vec<_>>();
    if source_agents.is_empty()
        || source_agents
            .iter()
            .any(|agent| agent.state != AgentState::Stopped)
    {
        return Err(invalid("delegated worker stop is not confirmed"));
    }
    // This entry transfers one leaf only. Never silently erase dependent work,
    // rename other tasks, or weaken the user's requirements while retiring it.
    if graph.task_ids().any(|id| {
        graph
            .dependencies_for(id)
            .is_ok_and(|deps| deps.contains(source))
    }) {
        return Err(invalid("dependent tasks require an explicit plan revision"));
    }
    let expected = graph
        .task_ids()
        .filter(|id| *id != source)
        .collect::<std::collections::BTreeSet<_>>();
    if tasks
        .iter()
        .map(|task| &task.task_id)
        .collect::<std::collections::BTreeSet<_>>()
        != expected
    {
        return Err(invalid("only the delegated source may be retired"));
    }
    for task in tasks {
        let old = &projection.tasks[&task.task_id];
        let dependencies = task
            .depends_on
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if task.name != old.name
            || task.role != old.role
            || graph.dependencies_for(&task.task_id).ok() != Some(&dependencies)
        {
            return Err(invalid("unrelated task identity or dependencies changed"));
        }
    }
    Ok(())
}

pub(super) fn register_worker(
    projection: &RunProjection,
    task_id: &TaskId,
    agent_id: &AgentId,
    role: AgentRole,
) -> Result<Reduction, ReducerError> {
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
    if let Some(expected) = task.role {
        if expected != role {
            return Err(ReducerError::WorkerRoleMismatch {
                task_id: task_id.to_string(),
                expected,
                actual: role,
            });
        }
    }
    if projection.agents.contains_key(agent_id) {
        return Err(ReducerError::AgentAlreadyExists(agent_id.to_string()));
    }
    if let Some(owner) = projection
        .active_worker_for_task(task_id)
        .map_err(|error| {
            crate::agents::protocol::ProtocolError::InvalidEnvelope(error.to_string())
        })?
    {
        return Err(ReducerError::TaskWorkerAlreadyRegistered {
            task_id: task_id.to_string(),
            agent_id: owner.to_string(),
        });
    }
    Ok(Reduction {
        events: vec![
            EventIntent {
                task_id: Some(task_id.clone()),
                agent_id: Some(agent_id.clone()),
                payload: RunEventPayload::AgentSpawned {
                    agent_id: agent_id.clone(),
                    task_id: Some(task_id.clone()),
                    role,
                },
                evidence_refs: vec![],
            },
            EventIntent {
                task_id: Some(task_id.clone()),
                agent_id: Some(agent_id.clone()),
                payload: RunEventPayload::AgentStateChanged {
                    agent_id: agent_id.clone(),
                    task_id: Some(task_id.clone()),
                    from: AgentState::Starting,
                    to: AgentState::Running,
                },
                evidence_refs: vec![],
            },
        ],
        effects: vec![],
    })
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
