use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{
    reduce, ControlEffect, EffectIntent, EventIntent, ReducerError, Reduction, WorkerStopMode,
};
use goose::agents::protocol::{
    AgentId, AgentState, ControlCommand, EventId, ProtocolVersion, RunEvent, RunEventPayload,
    RunId, RunState, TaskDependency, TaskId, TaskResult, TaskState,
};
use goose::agents::reporting::RunProjection;
use goose::agents::AgentRole;

fn event(
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    agent_id: Option<&AgentId>,
    payload: RunEventPayload,
) -> RunEvent {
    event_with_version(
        ProtocolVersion::V1,
        run_id,
        sequence,
        task_id,
        agent_id,
        payload,
    )
}

fn event_with_version(
    protocol_version: ProtocolVersion,
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    agent_id: Option<&AgentId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(format!("cancel-fixture-{sequence}")).unwrap();
    RunEvent {
        protocol_version,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: agent_id.cloned(),
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 14, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn branch_projection() -> RunProjection {
    let run_id = RunId::new("run-branch-cancel").unwrap();
    let root = TaskId::new("task-root").unwrap();
    let child = TaskId::new("task-child").unwrap();
    let grandchild = TaskId::new("task-grandchild").unwrap();
    let other = TaskId::new("task-other").unwrap();
    let child_agent = AgentId::new("agent-child").unwrap();
    let other_agent = AgentId::new("agent-other").unwrap();
    let mut events = vec![
        event(
            &run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "cancel one exact task branch".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
    ];
    for (task_id, name) in [
        (&root, "root"),
        (&child, "child"),
        (&grandchild, "grandchild"),
        (&other, "other"),
    ] {
        let sequence = events.len() as u64 + 1;
        events.push(event(
            &run_id,
            sequence,
            Some(task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: name.to_string(),
                role: None,
            },
        ));
    }
    events.push(event_with_version(
        ProtocolVersion::V2,
        &run_id,
        7,
        None,
        None,
        RunEventPayload::PlanProposed {
            plan_revision: 1,
            task_ids: vec![
                root.clone(),
                child.clone(),
                grandchild.clone(),
                other.clone(),
            ],
        },
    ));
    events.push(event_with_version(
        ProtocolVersion::V2,
        &run_id,
        8,
        None,
        None,
        RunEventPayload::TaskGraphDeclared {
            plan_revision: 1,
            dependencies: vec![
                TaskDependency {
                    task_id: root.clone(),
                    depends_on: vec![],
                },
                TaskDependency {
                    task_id: child.clone(),
                    depends_on: vec![root.clone()],
                },
                TaskDependency {
                    task_id: grandchild.clone(),
                    depends_on: vec![child.clone()],
                },
                TaskDependency {
                    task_id: other.clone(),
                    depends_on: vec![],
                },
            ],
        },
    ));
    for (task_id, sequence) in [(&root, 9), (&child, 12), (&grandchild, 13), (&other, 14)] {
        events.push(event_with_version(
            ProtocolVersion::V2,
            &run_id,
            sequence,
            Some(task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ));
        if task_id == &root {
            events.push(event_with_version(
                ProtocolVersion::V2,
                &run_id,
                10,
                Some(task_id),
                None,
                RunEventPayload::TaskStateChanged {
                    task_id: task_id.clone(),
                    from: TaskState::Ready,
                    to: TaskState::Running,
                },
            ));
            events.push(event_with_version(
                ProtocolVersion::V2,
                &run_id,
                11,
                Some(task_id),
                None,
                RunEventPayload::TaskSucceeded {
                    task_id: task_id.clone(),
                    result: TaskResult {
                        summary: "root already finished".to_string(),
                        evidence_refs: vec![],
                    },
                },
            ));
        }
    }
    for (task_id, sequence) in [(&child, 15), (&other, 16)] {
        events.push(event_with_version(
            ProtocolVersion::V2,
            &run_id,
            sequence,
            Some(task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ));
    }
    for (task_id, agent_id, spawn_sequence, run_sequence) in [
        (&child, &child_agent, 17, 18),
        (&other, &other_agent, 19, 20),
    ] {
        events.push(event_with_version(
            ProtocolVersion::V2,
            &run_id,
            spawn_sequence,
            Some(task_id),
            Some(agent_id),
            RunEventPayload::AgentSpawned {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                role: AgentRole::Coder,
            },
        ));
        events.push(event_with_version(
            ProtocolVersion::V2,
            &run_id,
            run_sequence,
            Some(task_id),
            Some(agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Starting,
                to: AgentState::Running,
            },
        ));
    }
    events.sort_by_key(|event| event.sequence);
    RunProjection::rebuild(&events).unwrap()
}

fn active_projection(second_ready_task: bool) -> RunProjection {
    let run_id = RunId::new("run-cancel").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let mut events = vec![
        event(
            &run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "test lifecycle cancellation".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            3,
            Some(&task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "active task".to_string(),
                role: None,
            },
        ),
        event(
            &run_id,
            4,
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            &run_id,
            5,
            Some(&task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
        event(
            &run_id,
            6,
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::AgentSpawned {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                role: AgentRole::Coder,
            },
        ),
        event(
            &run_id,
            7,
            Some(&task_id),
            Some(&agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Starting,
                to: AgentState::Running,
            },
        ),
    ];
    if second_ready_task {
        let task_2 = TaskId::new("task-2").unwrap();
        events.push(event(
            &run_id,
            8,
            Some(&task_2),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_2.clone(),
                name: "ready task".to_string(),
                role: None,
            },
        ));
        events.push(event(
            &run_id,
            9,
            Some(&task_2),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_2.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ));
    }
    RunProjection::rebuild(&events).unwrap()
}

#[test]
fn stop_worker_commits_stopping_and_waiting_before_cooperative_effect() {
    let projection = active_projection(false);
    let run_id = projection.run_id.clone();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();

    let reduction = reduce(
        Some(&projection),
        &ControlCommand::StopWorker {
            run_id: run_id.clone(),
            agent_id: agent_id.clone(),
            reason: "worker is going in the wrong direction".to_string(),
        },
    )
    .unwrap();

    assert_eq!(reduction.events.len(), 2);
    assert_eq!(
        reduction.events[0],
        EventIntent {
            task_id: Some(task_id.clone()),
            agent_id: Some(agent_id.clone()),
            payload: RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Running,
                to: AgentState::Stopping,
            },
            evidence_refs: vec![],
        }
    );
    assert_eq!(
        reduction.events[1].payload,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Running,
            to: TaskState::WaitingForCoordinator,
        }
    );
    assert_eq!(
        reduction.effects,
        vec![EffectIntent {
            trigger_event_index: 0,
            effect: ControlEffect::StopWorkers {
                run_id,
                agent_ids: vec![agent_id],
                mode: WorkerStopMode::CooperativeThenForce,
            },
        }]
    );
}

#[test]
fn cancel_task_and_emergency_stop_commit_exact_terminal_scope() {
    let projection = active_projection(false);
    let run_id = projection.run_id.clone();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let cancelled = reduce(
        Some(&projection),
        &ControlCommand::CancelTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            reason: "task no longer needed".to_string(),
        },
    )
    .unwrap();
    assert_eq!(cancelled.events.len(), 2);
    assert_eq!(
        cancelled.events[0].payload,
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Running,
            to: AgentState::Stopping,
        }
    );
    assert_eq!(
        cancelled.events[1].payload,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Running,
            to: TaskState::Cancelled,
        }
    );
    assert_eq!(cancelled.effects[0].trigger_event_index, 1);
    assert_eq!(
        cancelled.effects[0].effect,
        ControlEffect::StopWorkers {
            run_id: run_id.clone(),
            agent_ids: vec![agent_id.clone()],
            mode: WorkerStopMode::CooperativeThenForce,
        }
    );

    let projection = active_projection(true);
    let emergency = reduce(
        Some(&projection),
        &ControlCommand::EmergencyStop {
            run_id: run_id.clone(),
            reason: "operator emergency".to_string(),
        },
    )
    .unwrap();
    assert_eq!(emergency.events.len(), 4);
    assert!(matches!(
        emergency.events[0].payload,
        RunEventPayload::AgentStateChanged {
            to: AgentState::Stopping,
            ..
        }
    ));
    assert!(emergency.events.iter().any(|intent| {
        matches!(
            &intent.payload,
            RunEventPayload::TaskStateChanged {
                task_id,
                to: TaskState::Cancelled,
                ..
            } if task_id.as_str() == "task-1"
        )
    }));
    assert!(emergency.events.iter().any(|intent| {
        matches!(
            &intent.payload,
            RunEventPayload::TaskStateChanged {
                task_id,
                to: TaskState::Cancelled,
                ..
            } if task_id.as_str() == "task-2"
        )
    }));
    assert_eq!(
        emergency.events[3].payload,
        RunEventPayload::RunCancelled {
            reason: "operator emergency".to_string(),
        }
    );
    assert_eq!(emergency.effects[0].trigger_event_index, 3);
    assert_eq!(
        emergency.effects[0].effect,
        ControlEffect::EmergencyStop {
            run_id,
            agent_ids: vec![agent_id],
        }
    );
}

#[test]
fn unknown_terminal_and_branch_cancellation_fail_closed() {
    let projection = active_projection(false);
    let run_id = projection.run_id.clone();
    assert!(matches!(
        reduce(
            Some(&projection),
            &ControlCommand::StopWorker {
                run_id: run_id.clone(),
                agent_id: AgentId::new("agent-missing").unwrap(),
                reason: "not known".to_string(),
            }
        ),
        Err(ReducerError::UnknownAgent(_))
    ));

    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let stopping_event = event(
        &run_id,
        8,
        Some(&task_id),
        Some(&agent_id),
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Running,
            to: AgentState::Stopping,
        },
    );
    let mut base_events = projection_events(&projection);
    base_events.push(stopping_event);
    base_events.push(event(
        &run_id,
        9,
        Some(&task_id),
        Some(&agent_id),
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Stopping,
            to: AgentState::Stopped,
        },
    ));
    let stopped = RunProjection::rebuild(&base_events).unwrap();
    assert!(matches!(
        reduce(
            Some(&stopped),
            &ControlCommand::StopWorker {
                run_id: run_id.clone(),
                agent_id: agent_id.clone(),
                reason: "too late".to_string(),
            }
        ),
        Err(ReducerError::AgentNotStoppable { .. })
    ));

    let mut terminal_task_events = projection_events(&projection);
    terminal_task_events.push(event(
        &run_id,
        8,
        Some(&task_id),
        None,
        RunEventPayload::TaskSucceeded {
            task_id: task_id.clone(),
            result: TaskResult {
                summary: "already finished".to_string(),
                evidence_refs: vec![],
            },
        },
    ));
    let terminal_task = RunProjection::rebuild(&terminal_task_events).unwrap();
    assert!(matches!(
        reduce(
            Some(&terminal_task),
            &ControlCommand::CancelTask {
                run_id: run_id.clone(),
                task_id: task_id.clone(),
                reason: "too late".to_string(),
            }
        ),
        Err(ReducerError::TaskIsTerminal { .. })
    ));

    assert!(matches!(
        reduce(
            Some(&projection),
            &ControlCommand::CancelBranch {
                run_id,
                root_task_id: task_id,
                reason: "cancel descendants".to_string(),
            }
        ),
        Err(ReducerError::BranchTopologyUnavailable)
    ));
}

#[test]
fn lifecycle_effects_require_matching_committed_stopping_events() {
    let run_id = RunId::new("run-cancel").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let forged = Reduction {
        events: vec![EventIntent {
            task_id: Some(task_id.clone()),
            agent_id: None,
            payload: RunEventPayload::TaskStateChanged {
                task_id,
                from: TaskState::Running,
                to: TaskState::Cancelled,
            },
            evidence_refs: vec![],
        }],
        effects: vec![EffectIntent {
            trigger_event_index: 0,
            effect: ControlEffect::StopWorkers {
                run_id,
                agent_ids: vec![agent_id],
                mode: WorkerStopMode::CooperativeThenForce,
            },
        }],
    };
    assert!(matches!(
        forged.validate(),
        Err(ReducerError::EffectScopeMismatch { .. })
    ));
}

#[test]
fn cancel_branch_uses_replayed_descendants_and_leaves_unrelated_work_untouched() {
    let projection = branch_projection();
    let run_id = projection.run_id.clone();
    let root = TaskId::new("task-root").unwrap();
    let child = TaskId::new("task-child").unwrap();
    let grandchild = TaskId::new("task-grandchild").unwrap();
    let child_agent = AgentId::new("agent-child").unwrap();

    let reduction = reduce(
        Some(&projection),
        &ControlCommand::CancelBranch {
            run_id: run_id.clone(),
            root_task_id: root,
            reason: "downstream plan is no longer valid".to_string(),
        },
    )
    .unwrap();

    assert_eq!(reduction.events.len(), 3);
    assert_eq!(
        reduction.events[0].payload,
        RunEventPayload::AgentStateChanged {
            agent_id: child_agent.clone(),
            task_id: Some(child.clone()),
            from: AgentState::Running,
            to: AgentState::Stopping,
        }
    );
    assert_eq!(
        reduction.events[1].payload,
        RunEventPayload::TaskStateChanged {
            task_id: child.clone(),
            from: TaskState::Running,
            to: TaskState::Cancelled,
        }
    );
    assert_eq!(
        reduction.events[2].payload,
        RunEventPayload::TaskStateChanged {
            task_id: grandchild,
            from: TaskState::Ready,
            to: TaskState::Cancelled,
        }
    );
    assert_eq!(
        reduction.effects,
        vec![EffectIntent {
            trigger_event_index: 0,
            effect: ControlEffect::StopWorkers {
                run_id,
                agent_ids: vec![child_agent],
                mode: WorkerStopMode::CooperativeThenForce,
            },
        }]
    );
    assert!(reduction.events.iter().all(|intent| {
        intent.task_id.as_ref().map(TaskId::as_str) != Some("task-other")
            && intent.agent_id.as_ref().map(AgentId::as_str) != Some("agent-other")
    }));
}

#[test]
fn cancel_branch_rejects_unknown_root() {
    let projection = branch_projection();
    let run_id = projection.run_id.clone();
    assert!(matches!(
        reduce(
            Some(&projection),
            &ControlCommand::CancelBranch {
                run_id: run_id.clone(),
                root_task_id: TaskId::new("task-missing").unwrap(),
                reason: "unknown root".to_string(),
            }
        ),
        Err(ReducerError::UnknownTask(_))
    ));
}

fn projection_events(projection: &RunProjection) -> Vec<RunEvent> {
    assert_eq!(projection.run_id.as_str(), "run-cancel");
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let full = active_projection_events(&projection.run_id, &task_id, &agent_id);
    assert_eq!(RunProjection::rebuild(&full).unwrap(), *projection);
    full
}

fn active_projection_events(run_id: &RunId, task_id: &TaskId, agent_id: &AgentId) -> Vec<RunEvent> {
    vec![
        event(
            run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "test lifecycle cancellation".to_string(),
            },
        ),
        event(
            run_id,
            2,
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            run_id,
            3,
            Some(task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "active task".to_string(),
                role: None,
            },
        ),
        event(
            run_id,
            4,
            Some(task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            run_id,
            5,
            Some(task_id),
            None,
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
        event(
            run_id,
            6,
            Some(task_id),
            Some(agent_id),
            RunEventPayload::AgentSpawned {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                role: AgentRole::Coder,
            },
        ),
        event(
            run_id,
            7,
            Some(task_id),
            Some(agent_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Starting,
                to: AgentState::Running,
            },
        ),
    ]
}
