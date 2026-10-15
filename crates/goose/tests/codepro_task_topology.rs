use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{reduce, ReducerError};
use goose::agents::protocol::{
    ControlCommand, EventId, ProtocolVersion, RunEvent, RunEventPayload, RunId, TaskDependency,
    TaskId, TaskState,
};
use goose::agents::reporting::{ProjectionError, RunProjection, TaskTopologyError};

fn event(
    version: ProtocolVersion,
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(format!("topology-event-{sequence}")).unwrap();
    RunEvent {
        protocol_version: version,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: None,
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 22, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn ids() -> (RunId, TaskId, TaskId, TaskId, TaskId) {
    (
        RunId::new("run-topology").unwrap(),
        TaskId::new("task-root").unwrap(),
        TaskId::new("task-child").unwrap(),
        TaskId::new("task-grandchild").unwrap(),
        TaskId::new("task-other").unwrap(),
    )
}

fn stream_with_graph(reverse_input: bool) -> Vec<RunEvent> {
    let (run_id, root, child, grandchild, other) = ids();
    let tasks = [
        root.clone(),
        child.clone(),
        grandchild.clone(),
        other.clone(),
    ];
    let mut events = vec![event(
        ProtocolVersion::V1,
        &run_id,
        1,
        None,
        RunEventPayload::RunStarted {
            goal: "replay an authoritative task graph".to_string(),
        },
    )];
    for (index, task_id) in tasks.iter().enumerate() {
        events.push(event(
            ProtocolVersion::V1,
            &run_id,
            index as u64 + 2,
            Some(task_id),
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: format!("work for {task_id}"),
                role: None,
            },
        ));
    }
    events.push(event(
        ProtocolVersion::V2,
        &run_id,
        6,
        None,
        RunEventPayload::PlanProposed {
            plan_revision: 1,
            task_ids: tasks.to_vec(),
        },
    ));
    let mut dependencies = vec![
        TaskDependency {
            task_id: root,
            depends_on: vec![],
        },
        TaskDependency {
            task_id: child.clone(),
            depends_on: vec![TaskId::new("task-root").unwrap()],
        },
        TaskDependency {
            task_id: grandchild,
            depends_on: vec![child],
        },
        TaskDependency {
            task_id: other,
            depends_on: vec![],
        },
    ];
    if reverse_input {
        dependencies.reverse();
    }
    events.push(event(
        ProtocolVersion::V2,
        &run_id,
        7,
        None,
        RunEventPayload::TaskGraphDeclared {
            plan_revision: 1,
            dependencies,
        },
    ));
    events
}

#[test]
fn complete_v2_graph_replays_and_derives_deterministic_descendants() {
    let projection = RunProjection::rebuild(&stream_with_graph(false)).unwrap();
    let reordered = RunProjection::rebuild(&stream_with_graph(true)).unwrap();
    let root = TaskId::new("task-root").unwrap();
    let expected = vec![
        TaskId::new("task-child").unwrap(),
        TaskId::new("task-grandchild").unwrap(),
        root.clone(),
    ];

    assert_eq!(projection.protocol_version(), ProtocolVersion::V2);
    assert_eq!(projection.task_graph_revision(), Some(1));
    assert_eq!(projection.branch_task_ids(&root).unwrap(), expected);
    assert_eq!(
        reordered.branch_task_ids(&root).unwrap(),
        projection.branch_task_ids(&root).unwrap()
    );
    assert_eq!(projection, reordered);
}

#[test]
fn v1_stream_and_new_plan_revision_keep_topology_unavailable_until_declared() {
    let events = stream_with_graph(false);
    let v1_only = RunProjection::rebuild(&events[..5]).unwrap();
    assert!(matches!(
        v1_only.branch_task_ids(&TaskId::new("task-root").unwrap()),
        Err(TaskTopologyError::Unavailable { plan_revision: 0 })
    ));

    let mut projection = RunProjection::rebuild(&events).unwrap();
    let (_, root, child, grandchild, other) = ids();
    projection
        .apply(&event(
            ProtocolVersion::V2,
            &projection.run_id,
            8,
            None,
            RunEventPayload::PlanRevised {
                plan_revision: 2,
                audit: None,
                task_ids: vec![
                    root.clone(),
                    child.clone(),
                    grandchild.clone(),
                    other.clone(),
                ],
            },
        ))
        .unwrap();
    assert_eq!(projection.task_graph_revision(), None);
    assert!(matches!(
        projection.branch_task_ids(&root),
        Err(TaskTopologyError::Unavailable { plan_revision: 2 })
    ));

    projection
        .apply(&event(
            ProtocolVersion::V2,
            &projection.run_id,
            9,
            None,
            RunEventPayload::TaskGraphDeclared {
                plan_revision: 2,
                dependencies: vec![
                    TaskDependency {
                        task_id: root.clone(),
                        depends_on: vec![],
                    },
                    TaskDependency {
                        task_id: child,
                        depends_on: vec![root.clone()],
                    },
                    TaskDependency {
                        task_id: grandchild,
                        depends_on: vec![root.clone()],
                    },
                    TaskDependency {
                        task_id: other,
                        depends_on: vec![],
                    },
                ],
            },
        ))
        .unwrap();
    assert_eq!(projection.task_graph_revision(), Some(2));
    assert_eq!(projection.branch_task_ids(&root).unwrap().len(), 3);
}

#[test]
fn incomplete_unknown_and_cyclic_graphs_fail_without_mutating_projection() {
    let events = stream_with_graph(false);
    let base = RunProjection::rebuild(&events[..6]).unwrap();
    let run_id = base.run_id.clone();
    let (_, root, child, grandchild, other) = ids();

    let cases = [
        (
            vec![
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
            ],
            "incomplete",
        ),
        (
            vec![
                TaskDependency {
                    task_id: root.clone(),
                    depends_on: vec![],
                },
                TaskDependency {
                    task_id: child.clone(),
                    depends_on: vec![TaskId::new("task-from-another-run").unwrap()],
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
            "unknown",
        ),
        (
            vec![
                TaskDependency {
                    task_id: root.clone(),
                    depends_on: vec![grandchild.clone()],
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
                    task_id: other,
                    depends_on: vec![],
                },
            ],
            "cycle",
        ),
    ];

    for (dependencies, label) in cases {
        let mut projection = base.clone();
        let before = projection.clone();
        let result = projection.apply(&event(
            ProtocolVersion::V2,
            &run_id,
            7,
            None,
            RunEventPayload::TaskGraphDeclared {
                plan_revision: 1,
                dependencies,
            },
        ));
        assert!(result.is_err(), "{label} graph must fail");
        assert_eq!(projection, before, "{label} graph mutated projection");
    }
}

#[test]
fn stream_rejects_protocol_downgrade_and_unknown_branch_root() {
    let events = stream_with_graph(false);
    let mut projection = RunProjection::rebuild(&events).unwrap();
    let before = projection.clone();
    let downgrade = event(
        ProtocolVersion::V1,
        &projection.run_id,
        8,
        None,
        RunEventPayload::PlanRevised {
            plan_revision: 2,
            audit: None,
            task_ids: vec![],
        },
    );
    assert!(matches!(
        projection.apply(&downgrade),
        Err(ProjectionError::ProtocolVersionDowngrade { .. })
    ));
    assert_eq!(projection, before);
    assert!(matches!(
        projection.branch_task_ids(&TaskId::new("task-missing").unwrap()),
        Err(TaskTopologyError::UnknownRoot(_))
    ));
}

#[test]
fn graph_snapshot_is_immutable_within_one_plan_revision() {
    let events = stream_with_graph(false);
    let mut projection = RunProjection::rebuild(&events).unwrap();
    let before = projection.clone();
    let repeated_payload = events.last().unwrap().payload.clone();
    let repeated = event(
        ProtocolVersion::V2,
        &projection.run_id,
        8,
        None,
        repeated_payload,
    );

    assert!(matches!(
        projection.apply(&repeated),
        Err(ProjectionError::TaskGraphAlreadyDeclared(1))
    ));
    assert_eq!(projection, before);
}

#[test]
fn branch_with_only_terminal_tasks_has_nothing_to_cancel() {
    let mut projection = RunProjection::rebuild(&stream_with_graph(false)).unwrap();
    for task_id in ["task-root", "task-child", "task-grandchild"] {
        projection
            .tasks
            .get_mut(&TaskId::new(task_id).unwrap())
            .unwrap()
            .state = TaskState::Cancelled;
    }
    let run_id = projection.run_id.clone();
    assert!(matches!(
        reduce(
            Some(&projection),
            &ControlCommand::CancelBranch {
                run_id,
                root_task_id: TaskId::new("task-root").unwrap(),
                reason: "nothing remains".to_string(),
            }
        ),
        Err(ReducerError::BranchAlreadyTerminal(_))
    ));
}
