use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use goose::agents::control_plane::{
    AppendReceipt, ControlEffect, EventStoreError, FileRunEventStore, RunClock, RunEngine,
    RunEngineError, RunEventStore,
};
use goose::agents::protocol::{
    AgentId, AgentState, ControlCommand, EventId, FailureClass, PlannedTask, ProtocolVersion,
    RunEvent, RunEventPayload, RunId, RunState, TaskDependency, TaskFailure, TaskId, TaskState,
    WorkerOutcome,
};
use goose::agents::reporting::RunProjection;
use goose::agents::AgentRole;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl RunClock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

fn event(
    run_id: &RunId,
    sequence: u64,
    event_id: &str,
    task_id: Option<&TaskId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(event_id).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: None,
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 9, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn v2_event(
    run_id: &RunId,
    sequence: u64,
    event_id: &str,
    task_id: Option<&TaskId>,
    payload: RunEventPayload,
) -> RunEvent {
    let mut event = event(run_id, sequence, event_id, task_id, payload);
    event.protocol_version = ProtocolVersion::V2;
    event
}

fn running_events(run_id: &RunId) -> Vec<RunEvent> {
    vec![
        event(
            run_id,
            1,
            "event:1",
            None,
            RunEventPayload::RunStarted {
                goal: "build durable control".to_string(),
            },
        ),
        event(
            run_id,
            2,
            "event:2",
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
    ]
}

fn running_ready_events(run_id: &RunId, task_id: &TaskId) -> Vec<RunEvent> {
    let mut events = running_events(run_id);
    events.push(event(
        run_id,
        3,
        "event:3",
        Some(task_id),
        RunEventPayload::TaskCreated {
            task_id: task_id.clone(),
            name: "implement run engine".to_string(),
            role: None,
        },
    ));
    events.push(event(
        run_id,
        4,
        "event:5",
        Some(task_id),
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Proposed,
            to: TaskState::Ready,
        },
    ));
    events
}

#[tokio::test]
async fn production_plan_and_worker_registration_rebuild_from_committed_events() {
    let directory = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-engine-production-plan").unwrap();
    let root = TaskId::new("task-root").unwrap();
    let child = TaskId::new("task-child").unwrap();
    let agent_id = AgentId::new("worker-task-root").unwrap();
    let now = Utc.with_ymd_and_hms(2026, 8, 6, 3, 0, 0).unwrap();
    let engine = RunEngine::new(FileRunEventStore::new(directory.path()), FixedClock(now));

    engine
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "ship the runtime".to_string(),
        })
        .await
        .unwrap();
    let installed = engine
        .apply(ControlCommand::InstallPlan {
            run_id: run_id.clone(),
            plan_revision: 1,
            revision_audit: None,
            tasks: vec![
                PlannedTask {
                    task_id: root.clone(),
                    name: "Implement runtime".to_string(),
                    role: Some(AgentRole::Coder),
                    depends_on: vec![],
                },
                PlannedTask {
                    task_id: child.clone(),
                    name: "Verify runtime".to_string(),
                    role: Some(AgentRole::Tester),
                    depends_on: vec![root.clone()],
                },
            ],
        })
        .await
        .unwrap();
    assert_eq!(installed.projection().state, RunState::Running);
    assert_eq!(installed.projection().plan_revision, 1);
    assert_eq!(installed.projection().tasks[&root].state, TaskState::Ready);
    assert_eq!(
        installed.projection().tasks[&child].state,
        TaskState::Proposed
    );
    assert!(installed.effects().is_empty());

    let started = engine
        .apply(ControlCommand::StartTask {
            run_id: run_id.clone(),
            task_id: root.clone(),
        })
        .await
        .unwrap();
    assert_eq!(started.effects().len(), 1);
    let role_error = engine
        .apply(ControlCommand::RegisterWorker {
            run_id: run_id.clone(),
            task_id: root.clone(),
            agent_id: agent_id.clone(),
            role: AgentRole::Tester,
        })
        .await
        .unwrap_err();
    assert!(role_error.to_string().contains("worker role mismatch"));
    let registered = engine
        .apply(ControlCommand::RegisterWorker {
            run_id: run_id.clone(),
            task_id: root.clone(),
            agent_id: agent_id.clone(),
            role: AgentRole::Coder,
        })
        .await
        .unwrap();
    assert_eq!(
        registered.projection().agents[&agent_id].state,
        AgentState::Running
    );
    let identity_error = engine
        .apply(ControlCommand::InstallPlan {
            run_id: run_id.clone(),
            plan_revision: 2,
            revision_audit: None,
            tasks: vec![PlannedTask {
                task_id: root.clone(),
                name: "Silently renamed task".to_string(),
                role: Some(AgentRole::Coder),
                depends_on: vec![],
            }],
        })
        .await
        .unwrap_err();
    assert!(identity_error
        .to_string()
        .contains("plan task identity changed"));

    let rebuilt = RunEngine::new(FileRunEventStore::new(directory.path()), FixedClock(now))
        .load_projection(&run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rebuilt, registered.projection().clone());
}

#[tokio::test]
async fn start_run_commits_before_return_and_restart_continues_sequence() {
    let directory = tempfile::tempdir().unwrap();
    let run_id = RunId::new("run-engine-start").unwrap();
    let now = Utc.with_ymd_and_hms(2026, 8, 5, 10, 0, 0).unwrap();

    let first = RunEngine::new(FileRunEventStore::new(directory.path()), FixedClock(now))
        .apply(ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "build durable control".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(first.append().previous_sequence, 0);
    assert_eq!(first.append().last_sequence, 1);
    assert_eq!(first.append().appended, 1);
    assert_eq!(first.committed_events()[0].event_id.as_str(), "event:1");
    assert_eq!(
        first.committed_events()[0].protocol_version,
        ProtocolVersion::V2
    );
    assert_eq!(first.committed_events()[0].occurred_at, now);
    assert_eq!(first.projection().state, RunState::Planning);
    assert!(first.effects().is_empty());

    let restarted = RunEngine::new(FileRunEventStore::new(directory.path()), FixedClock(now))
        .apply(ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "review the plan".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(restarted.append().previous_sequence, 1);
    assert_eq!(restarted.append().last_sequence, 2);
    assert_eq!(restarted.committed_events()[0].event_id.as_str(), "event:2");
    assert_eq!(restarted.projection().state, RunState::Paused);
    assert_eq!(
        restarted.effects()[0].effect,
        ControlEffect::PauseScheduling {
            run_id: run_id.clone(),
        }
    );

    let persisted = FileRunEventStore::new(directory.path())
        .load(&run_id)
        .await
        .unwrap();
    assert_eq!(
        persisted,
        [first.committed_events(), restarted.committed_events()].concat()
    );
}

#[tokio::test]
async fn branch_cancellation_continues_v1_stream_with_committed_v2_batch() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-engine-branch").unwrap();
    let root = TaskId::new("task-root").unwrap();
    let child = TaskId::new("task-child").unwrap();
    let agent_id = AgentId::new("agent-child").unwrap();
    let mut seed = running_events(&run_id);
    seed.extend([
        event(
            &run_id,
            3,
            "event:3",
            Some(&root),
            RunEventPayload::TaskCreated {
                task_id: root.clone(),
                name: "root".to_string(),
                role: None,
            },
        ),
        event(
            &run_id,
            4,
            "event:4",
            Some(&child),
            RunEventPayload::TaskCreated {
                task_id: child.clone(),
                name: "child".to_string(),
                role: None,
            },
        ),
        v2_event(
            &run_id,
            5,
            "event:5",
            None,
            RunEventPayload::PlanProposed {
                plan_revision: 1,
                task_ids: vec![root.clone(), child.clone()],
            },
        ),
        v2_event(
            &run_id,
            6,
            "event:6",
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
                ],
            },
        ),
        v2_event(
            &run_id,
            7,
            "event:7",
            Some(&root),
            RunEventPayload::TaskStateChanged {
                task_id: root.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        v2_event(
            &run_id,
            8,
            "event:8",
            Some(&child),
            RunEventPayload::TaskStateChanged {
                task_id: child.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        v2_event(
            &run_id,
            9,
            "event:9",
            Some(&child),
            RunEventPayload::TaskStateChanged {
                task_id: child.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
    ]);
    let mut spawned = v2_event(
        &run_id,
        10,
        "event:10",
        Some(&child),
        RunEventPayload::AgentSpawned {
            agent_id: agent_id.clone(),
            task_id: Some(child.clone()),
            role: AgentRole::Coder,
        },
    );
    spawned.agent_id = Some(agent_id.clone());
    seed.push(spawned);
    let mut running = v2_event(
        &run_id,
        11,
        "event:11",
        Some(&child),
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(child.clone()),
            from: AgentState::Starting,
            to: AgentState::Running,
        },
    );
    running.agent_id = Some(agent_id.clone());
    seed.push(running);
    store.append(&run_id, 0, &seed).await.unwrap();

    let receipt = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 5, 11, 45, 0).unwrap()),
    )
    .apply(ControlCommand::CancelBranch {
        run_id: run_id.clone(),
        root_task_id: root.clone(),
        reason: "cancel the whole branch".to_string(),
    })
    .await
    .unwrap();

    assert_eq!(receipt.committed_events().len(), 3);
    assert!(receipt
        .committed_events()
        .iter()
        .all(|event| event.protocol_version == ProtocolVersion::V2));
    assert_eq!(receipt.effects().len(), 1);
    assert_eq!(receipt.effects()[0].effect_id, "effect:12:0");
    assert_eq!(
        receipt.effects()[0].trigger_event_id,
        receipt.committed_events()[0].event_id
    );
    assert_eq!(
        receipt.projection().tasks[&root].state,
        TaskState::Cancelled
    );
    assert_eq!(
        receipt.projection().tasks[&child].state,
        TaskState::Cancelled
    );
    assert_eq!(
        receipt.projection().agents[&agent_id].state,
        AgentState::Stopping
    );
    let persisted = store.load(&run_id).await.unwrap();
    assert_eq!(persisted.len(), 14);
    assert_eq!(
        receipt.projection().clone(),
        RunProjection::rebuild(&persisted).unwrap()
    );
}

#[tokio::test]
async fn task_dispatch_uses_collision_safe_ids_and_matches_fresh_replay() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-engine-task").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let seed = running_ready_events(&run_id, &task_id);
    store.append(&run_id, 0, &seed).await.unwrap();
    let now = Utc.with_ymd_and_hms(2026, 8, 5, 11, 0, 0).unwrap();

    let receipt = RunEngine::new(store.clone(), FixedClock(now))
        .apply(ControlCommand::StartTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
        })
        .await
        .unwrap();

    let committed = &receipt.committed_events()[0];
    assert_eq!(committed.sequence, 5);
    assert_eq!(committed.event_id.as_str(), "event:5:1");
    assert_eq!(committed.correlation_id, committed.event_id);
    assert_eq!(committed.occurred_at, now);
    assert_eq!(receipt.effects().len(), 1);
    assert_eq!(receipt.effects()[0].effect_id, "effect:5:0");
    assert_eq!(receipt.effects()[0].trigger_event_id, committed.event_id);
    assert_eq!(
        receipt.effects()[0].effect,
        ControlEffect::DispatchTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
        }
    );
    assert_eq!(
        receipt.projection().tasks[&task_id].state,
        TaskState::Running
    );

    let persisted = store.load(&run_id).await.unwrap();
    assert_eq!(
        receipt.projection().clone(),
        RunProjection::rebuild(&persisted).unwrap()
    );
}

#[tokio::test]
async fn transient_worker_outcome_commits_complete_retry_decision_before_effect() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-engine-outcome").unwrap();
    let task_id = TaskId::new("task-outcome").unwrap();
    let agent_id = AgentId::new("agent-outcome").unwrap();
    let mut seed = running_ready_events(&run_id, &task_id);
    seed.push(event(
        &run_id,
        5,
        "outcome-seed:5",
        Some(&task_id),
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Ready,
            to: TaskState::Running,
        },
    ));
    let mut spawned = event(
        &run_id,
        6,
        "outcome-seed:6",
        Some(&task_id),
        RunEventPayload::AgentSpawned {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            role: AgentRole::Coder,
        },
    );
    spawned.agent_id = Some(agent_id.clone());
    seed.push(spawned);
    let mut running = event(
        &run_id,
        7,
        "outcome-seed:7",
        Some(&task_id),
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Starting,
            to: AgentState::Running,
        },
    );
    running.agent_id = Some(agent_id.clone());
    seed.push(running);
    store.append(&run_id, 0, &seed).await.unwrap();

    let receipt = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 5, 23, 30, 0).unwrap()),
    )
    .apply(ControlCommand::SubmitTaskOutcome {
        run_id: run_id.clone(),
        task_id: task_id.clone(),
        agent_id: Some(agent_id.clone()),
        outcome: WorkerOutcome::Failed(TaskFailure {
            class: FailureClass::TransientInfrastructure,
            message: "provider connection reset".to_string(),
            evidence_refs: vec![],
        }),
    })
    .await
    .unwrap();

    assert_eq!(receipt.committed_events().len(), 6);
    assert!(matches!(
        receipt.committed_events()[0].payload,
        RunEventPayload::TaskOutcomeAccepted { .. }
    ));
    assert_eq!(receipt.projection().tasks[&task_id].state, TaskState::Ready);
    assert_eq!(receipt.projection().tasks[&task_id].retry_attempts, 1);
    assert_eq!(
        receipt.projection().agents[&agent_id].state,
        AgentState::Stopped
    );
    assert_eq!(receipt.effects().len(), 1);
    assert_eq!(receipt.effects()[0].effect_id, "effect:12:0");
    assert_eq!(
        receipt.effects()[0].trigger_event_id,
        receipt.committed_events()[4].event_id
    );
    assert_eq!(
        receipt.effects()[0].effect,
        ControlEffect::RetryTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            attempt: 1,
            delay_ms: 250,
        }
    );
    assert_eq!(
        receipt.projection().clone(),
        RunProjection::rebuild(&store.load(&run_id).await.unwrap()).unwrap()
    );
}

#[tokio::test]
async fn task_cancellation_commits_agent_then_task_before_binding_stop_effect() {
    let directory = tempfile::tempdir().unwrap();
    let store = FileRunEventStore::new(directory.path());
    let run_id = RunId::new("run-engine-cancel").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("agent-1").unwrap();
    let mut seed = running_ready_events(&run_id, &task_id);
    seed.push(event(
        &run_id,
        5,
        "event:6",
        Some(&task_id),
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Ready,
            to: TaskState::Running,
        },
    ));
    let mut spawned = event(
        &run_id,
        6,
        "event:7",
        Some(&task_id),
        RunEventPayload::AgentSpawned {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            role: AgentRole::Coder,
        },
    );
    spawned.agent_id = Some(agent_id.clone());
    seed.push(spawned);
    let mut running = event(
        &run_id,
        7,
        "event:8",
        Some(&task_id),
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Starting,
            to: AgentState::Running,
        },
    );
    running.agent_id = Some(agent_id.clone());
    seed.push(running);
    store.append(&run_id, 0, &seed).await.unwrap();

    let receipt = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 5, 11, 30, 0).unwrap()),
    )
    .apply(ControlCommand::CancelTask {
        run_id: run_id.clone(),
        task_id: task_id.clone(),
        reason: "cancel active task".to_string(),
    })
    .await
    .unwrap();

    assert_eq!(receipt.committed_events().len(), 2);
    assert_eq!(receipt.committed_events()[0].sequence, 8);
    assert_eq!(receipt.committed_events()[0].event_id.as_str(), "event:8:1");
    assert_eq!(receipt.committed_events()[1].sequence, 9);
    assert_eq!(
        receipt.committed_events()[1].causation_id,
        Some(receipt.committed_events()[0].event_id.clone())
    );
    assert_eq!(receipt.effects()[0].effect_id, "effect:9:0");
    assert_eq!(
        receipt.effects()[0].trigger_event_id,
        receipt.committed_events()[1].event_id
    );
    assert_eq!(
        receipt.projection().agents[&agent_id].state,
        AgentState::Stopping
    );
    assert_eq!(
        receipt.projection().tasks[&task_id].state,
        TaskState::Cancelled
    );
    assert_eq!(
        receipt.projection().clone(),
        RunProjection::rebuild(&store.load(&run_id).await.unwrap()).unwrap()
    );
}

#[derive(Clone)]
struct RejectingStore {
    loaded: Arc<Mutex<Vec<RunEvent>>>,
    append_attempts: Arc<AtomicUsize>,
}

#[async_trait]
impl RunEventStore for RejectingStore {
    async fn append(
        &self,
        _run_id: &RunId,
        expected_sequence: u64,
        _events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError> {
        self.append_attempts.fetch_add(1, Ordering::SeqCst);
        Err(EventStoreError::SequenceConflict {
            expected: expected_sequence,
            actual: expected_sequence + 1,
        })
    }

    async fn load(&self, _run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError> {
        Ok(self.loaded.lock().unwrap().clone())
    }
}

#[derive(Clone)]
struct MisreportingStore {
    events: Arc<Mutex<Vec<RunEvent>>>,
}

#[async_trait]
impl RunEventStore for MisreportingStore {
    async fn append(
        &self,
        _run_id: &RunId,
        expected_sequence: u64,
        events: &[RunEvent],
    ) -> Result<AppendReceipt, EventStoreError> {
        self.events.lock().unwrap().extend_from_slice(events);
        Ok(AppendReceipt {
            previous_sequence: expected_sequence,
            last_sequence: expected_sequence + events.len() as u64,
            appended: 0,
        })
    }

    async fn load(&self, _run_id: &RunId) -> Result<Vec<RunEvent>, EventStoreError> {
        Ok(self.events.lock().unwrap().clone())
    }
}

#[tokio::test]
async fn append_conflict_returns_no_receipt_or_effect_and_commits_nothing() {
    let run_id = RunId::new("run-engine-conflict").unwrap();
    let loaded = running_events(&run_id);
    let append_attempts = Arc::new(AtomicUsize::new(0));
    let store = RejectingStore {
        loaded: Arc::new(Mutex::new(loaded.clone())),
        append_attempts: append_attempts.clone(),
    };
    let engine = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 5, 12, 0, 0).unwrap()),
    );

    let error = engine
        .apply(ControlCommand::PauseRun {
            run_id,
            reason: "test optimistic conflict".to_string(),
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        RunEngineError::Store(EventStoreError::SequenceConflict { .. })
    ));
    assert_eq!(append_attempts.load(Ordering::SeqCst), 1);
    assert_eq!(*store.loaded.lock().unwrap(), loaded);
}

#[tokio::test]
async fn inconsistent_append_receipt_is_rejected_before_effect_binding() {
    let run_id = RunId::new("run-engine-receipt").unwrap();
    let store = MisreportingStore {
        events: Arc::new(Mutex::new(running_events(&run_id))),
    };
    let error = RunEngine::new(
        store.clone(),
        FixedClock(Utc.with_ymd_and_hms(2026, 8, 5, 12, 30, 0).unwrap()),
    )
    .apply(ControlCommand::PauseRun {
        run_id,
        reason: "verify receipt".to_string(),
    })
    .await
    .unwrap_err();

    assert!(matches!(error, RunEngineError::Invariant(_)));
    assert_eq!(store.events.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn reducer_and_projection_rejection_never_attempt_append() {
    let run_id = RunId::new("run-engine-reject").unwrap();
    let append_attempts = Arc::new(AtomicUsize::new(0));
    let valid_store = RejectingStore {
        loaded: Arc::new(Mutex::new(running_events(&run_id))),
        append_attempts: append_attempts.clone(),
    };
    let clock = FixedClock(Utc.with_ymd_and_hms(2026, 8, 5, 13, 0, 0).unwrap());
    let reducer_error = RunEngine::new(valid_store, clock.clone())
        .apply(ControlCommand::StartTask {
            run_id: run_id.clone(),
            task_id: TaskId::new("task-missing").unwrap(),
        })
        .await
        .unwrap_err();
    assert!(matches!(reducer_error, RunEngineError::Reducer(_)));
    assert_eq!(append_attempts.load(Ordering::SeqCst), 0);

    let mut invalid = running_events(&run_id);
    invalid[1].sequence = 3;
    let invalid_store = RejectingStore {
        loaded: Arc::new(Mutex::new(invalid)),
        append_attempts: append_attempts.clone(),
    };
    let projection_error = RunEngine::new(invalid_store, clock)
        .apply(ControlCommand::PauseRun {
            run_id,
            reason: "must not append".to_string(),
        })
        .await
        .unwrap_err();
    assert!(matches!(projection_error, RunEngineError::Projection(_)));
    assert_eq!(append_attempts.load(Ordering::SeqCst), 0);
}
