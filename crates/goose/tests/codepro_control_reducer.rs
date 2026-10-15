use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{
    reduce, CompletionProposal, ControlEffect, EffectIntent, EventIntent, ReducerError, Reduction,
};
use goose::agents::protocol::{
    AgentId, AgentState, BudgetRequest, ControlCommand, CoordinatorDecision,
    CoordinatorDecisionCandidate, EventId, FailureClass, ProtocolVersion, RunEvent,
    RunEventPayload, RunId, RunState, TaskId, TaskState, UserRequirement,
};
use goose::agents::reporting::RunProjection;
use goose::agents::AgentRole;

#[tokio::test]
async fn checkpoint_input_resolution_is_durable_targeted_and_fenced() {
    use goose::agents::control_plane::{
        CodeProRuntime, CommittedControlEffect, EffectLedgerError, EffectOutbox, FileRunEventStore,
        RunEngine, RunEventStore, RuntimeModePolicy, SystemRunClock,
    };
    use goose::agents::protocol::{Checkpoint, PlannedTask, UserInputResolution, WorkerOutcome};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct CountingOutbox(Arc<AtomicUsize>);
    impl EffectOutbox for CountingOutbox {
        fn prepare(
            &self,
            _events: &[RunEvent],
            _effects: &[CommittedControlEffect],
        ) -> Result<(), EffectLedgerError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn commit_prepared(
            &self,
            _effects: &[CommittedControlEffect],
        ) -> Result<(), EffectLedgerError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize_production(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
    )
    .await
    .unwrap();
    let run_id = RunId::new("run-input").unwrap();
    runtime
        .create_or_verify_run("session-input", run_id.clone(), "two waiting tasks")
        .await
        .unwrap();
    runtime
        .install_plan(
            "session-input",
            run_id.clone(),
            1,
            ["one", "two"]
                .into_iter()
                .map(|id| PlannedTask {
                    task_id: TaskId::new(id).unwrap(),
                    name: id.to_string(),
                    role: Some(AgentRole::Tester),
                    depends_on: vec![],
                })
                .collect(),
        )
        .await
        .unwrap();
    for id in ["one", "two"] {
        let task_id = TaskId::new(id).unwrap();
        runtime
            .start_task("session-input", run_id.clone(), task_id.clone())
            .await
            .unwrap();
        let (_, worker) = runtime
            .register_worker(
                "session-input",
                run_id.clone(),
                task_id,
                AgentId::new(format!("agent-{id}")).unwrap(),
                AgentRole::Tester,
            )
            .await
            .unwrap();
        runtime
            .submit_outcome(
                "session-input",
                &worker,
                WorkerOutcome::WaitingForUser(Checkpoint {
                    checkpoint_id: format!("question-{id}"),
                    summary: "command required".to_string(),
                    evidence_refs: vec![],
                }),
            )
            .await
            .unwrap();
    }
    runtime
        .control(
            "session-input",
            ControlCommand::PauseRun {
                run_id: run_id.clone(),
                reason: "input required".to_string(),
            },
            None,
        )
        .await
        .unwrap();
    let before = runtime.snapshot("session-input", &run_id).await.unwrap();
    let answer = UserInputResolution {
        task_id: TaskId::new("one").unwrap(),
        question_checkpoint_id: "question-one".to_string(),
        published_checkpoint_id: "checkpoint-r1-e20".to_string(),
        source_message_id: "answer-one".to_string(),
        plan_revision: 1,
        format_version: 1,
        execution_payload_sha256: "a".repeat(64),
        plan_semantics_sha256: "d".repeat(64),
        legacy_answer_sha256: None,
        skip: false,
    };
    let command = |resolution| ControlCommand::ResolveUserInput {
        run_id: run_id.clone(),
        resolution,
    };
    let engine_temp = tempfile::tempdir().unwrap();
    let engine_directory = engine_temp.path().join("direct-engine");
    let event_store = FileRunEventStore::new(&engine_directory);
    event_store
        .append(&run_id, 0, &before.events)
        .await
        .unwrap();
    let event_path = event_store.event_log_path(&run_id);
    let outbox_calls = Arc::new(AtomicUsize::new(0));
    let first_receipt = RunEngine::with_effect_outbox(
        event_store,
        SystemRunClock,
        CountingOutbox(outbox_calls.clone()),
    )
    .apply(command(answer.clone()))
    .await
    .unwrap();
    assert_eq!(first_receipt.append().appended, 2);
    assert_eq!(first_receipt.committed_events().len(), 2);
    assert!(first_receipt.effects().is_empty());
    assert_eq!(outbox_calls.load(Ordering::SeqCst), 2);
    let committed_bytes = std::fs::read(&event_path).unwrap();
    for _ in 0..2 {
        let restarted = RunEngine::with_effect_outbox(
            FileRunEventStore::new(&engine_directory),
            SystemRunClock,
            CountingOutbox(outbox_calls.clone()),
        );
        let fresh_command: ControlCommand =
            serde_json::from_str(&serde_json::to_string(&command(answer.clone())).unwrap())
                .unwrap();
        let repeated = restarted.apply(fresh_command).await.unwrap();
        assert_eq!(repeated.projection(), first_receipt.projection());
        assert_eq!(repeated.append().appended, 0);
        assert_eq!(
            repeated.append().last_sequence,
            first_receipt.append().last_sequence
        );
        assert!(repeated.committed_events().is_empty());
        assert!(repeated.effects().is_empty());
        assert_eq!(std::fs::read(&event_path).unwrap(), committed_bytes);
        assert_eq!(outbox_calls.load(Ordering::SeqCst), 2);
        for wrong in [
            UserInputResolution {
                plan_revision: 2,
                ..answer.clone()
            },
            UserInputResolution {
                question_checkpoint_id: "old-question".to_string(),
                ..answer.clone()
            },
            UserInputResolution {
                execution_payload_sha256: "c".repeat(64),
                ..answer.clone()
            },
        ] {
            assert!(restarted.apply(command(wrong)).await.is_err());
        }
        assert_eq!(std::fs::read(&event_path).unwrap(), committed_bytes);
        assert_eq!(outbox_calls.load(Ordering::SeqCst), 2);
    }
    for wrong in [
        UserInputResolution {
            question_checkpoint_id: "old-question".to_string(),
            ..answer.clone()
        },
        UserInputResolution {
            task_id: TaskId::new("two").unwrap(),
            ..answer.clone()
        },
        UserInputResolution {
            plan_revision: 2,
            ..answer.clone()
        },
    ] {
        assert!(runtime
            .control(
                "session-input",
                command(wrong),
                Some(before.projection.last_sequence)
            )
            .await
            .is_err());
    }
    assert!(runtime
        .control("wrong-session", command(answer.clone()), None)
        .await
        .is_err());
    assert_eq!(
        runtime
            .snapshot("session-input", &run_id)
            .await
            .unwrap()
            .projection
            .last_sequence,
        before.projection.last_sequence
    );
    runtime
        .control(
            "session-input",
            command(answer.clone()),
            Some(before.projection.last_sequence),
        )
        .await
        .unwrap();
    let resolved = runtime.snapshot("session-input", &run_id).await.unwrap();
    assert_eq!(
        resolved.projection.tasks[&TaskId::new("one").unwrap()].state,
        TaskState::Ready
    );
    assert_eq!(
        resolved.projection.tasks[&TaskId::new("two").unwrap()].state,
        TaskState::WaitingForUser
    );
    assert_eq!(
        resolved.projection.tasks[&TaskId::new("two").unwrap()],
        before.projection.tasks[&TaskId::new("two").unwrap()]
    );
    assert!(runtime
        .control(
            "session-input",
            command(answer.clone()),
            Some(before.projection.last_sequence)
        )
        .await
        .is_err());
    drop(runtime);
    let runtime = CodeProRuntime::initialize_production(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
    )
    .await
    .unwrap();
    runtime
        .control(
            "session-input",
            command(answer.clone()),
            Some(resolved.projection.last_sequence),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .snapshot("session-input", &run_id)
            .await
            .unwrap()
            .projection
            .last_sequence,
        resolved.projection.last_sequence
    );
    for conflict in [
        UserInputResolution {
            skip: true,
            ..answer.clone()
        },
        UserInputResolution {
            source_message_id: "another-source".to_string(),
            ..answer.clone()
        },
    ] {
        assert!(runtime
            .control("session-input", command(conflict), None)
            .await
            .is_err());
    }
    runtime
        .control(
            "session-input",
            ControlCommand::CancelTask {
                run_id: run_id.clone(),
                task_id: TaskId::new("one").unwrap(),
                reason: "user cancelled just this task".to_string(),
            },
            None,
        )
        .await
        .unwrap();
    assert!(runtime
        .control("session-input", command(answer), None)
        .await
        .is_err());
    let skip = UserInputResolution {
        task_id: TaskId::new("two").unwrap(),
        question_checkpoint_id: "question-two".to_string(),
        published_checkpoint_id: "checkpoint-r1-e20".to_string(),
        source_message_id: "skip-two".to_string(),
        plan_revision: 1,
        execution_payload_sha256: "b".repeat(64),
        format_version: 1,
        plan_semantics_sha256: "d".repeat(64),
        legacy_answer_sha256: None,
        skip: true,
    };
    runtime
        .control("session-input", command(skip.clone()), None)
        .await
        .unwrap();
    let skipped = runtime.snapshot("session-input", &run_id).await.unwrap();
    assert_eq!(
        skipped.projection.tasks[&TaskId::new("two").unwrap()].state,
        TaskState::Skipped
    );
    assert_eq!(
        skipped.projection.tasks[&TaskId::new("one").unwrap()].state,
        TaskState::Cancelled
    );
    runtime
        .control("session-input", command(skip.clone()), None)
        .await
        .unwrap();
    assert_eq!(
        runtime
            .snapshot("session-input", &run_id)
            .await
            .unwrap()
            .projection
            .last_sequence,
        skipped.projection.last_sequence
    );
    runtime
        .control(
            "session-input",
            ControlCommand::EmergencyStop {
                run_id: run_id.clone(),
                reason: "cancel run".to_string(),
            },
            None,
        )
        .await
        .unwrap();
    assert!(runtime
        .control("session-input", command(skip), None)
        .await
        .is_err());
}

fn event(
    run_id: &RunId,
    sequence: u64,
    task_id: Option<&TaskId>,
    payload: RunEventPayload,
) -> RunEvent {
    let event_id = EventId::new(format!("fixture-event-{sequence}")).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::V2,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: None,
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 8, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn projection(run_id: &RunId, task_state: Option<TaskState>, paused: bool) -> RunProjection {
    let task_id = TaskId::new("task-1").unwrap();
    let mut events = vec![event(
        run_id,
        1,
        None,
        RunEventPayload::RunStarted {
            goal: "build the control plane".to_string(),
        },
    )];
    if let Some(task_state) = task_state {
        events.push(event(
            run_id,
            2,
            None,
            RunEventPayload::PlanProposed {
                plan_revision: 1,
                task_ids: vec![task_id.clone()],
            },
        ));
        events.push(event(
            run_id,
            3,
            Some(&task_id),
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "implement reducer".to_string(),
                role: Some(AgentRole::Tester),
            },
        ));
        events.push(event(
            run_id,
            4,
            None,
            RunEventPayload::TaskGraphDeclared {
                plan_revision: 1,
                dependencies: vec![goose::agents::protocol::TaskDependency {
                    task_id: task_id.clone(),
                    depends_on: vec![],
                }],
            },
        ));
        events.push(event(
            run_id,
            5,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ));
        if task_state != TaskState::Proposed {
            events.push(event(
                run_id,
                6,
                Some(&task_id),
                RunEventPayload::TaskStateChanged {
                    task_id: task_id.clone(),
                    from: TaskState::Proposed,
                    to: task_state,
                },
            ));
        }
    } else {
        events.push(event(
            run_id,
            2,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ));
    }
    if paused {
        let sequence = events.len() as u64 + 1;
        events.push(event(
            run_id,
            sequence,
            None,
            RunEventPayload::RunPaused {
                reason: "operator requested review".to_string(),
                checkpoint: None,
            },
        ));
    }
    RunProjection::rebuild(&events).unwrap()
}

#[test]
fn user_requirement_revision_is_committed_and_replayed_as_run_fact() {
    let run_id = RunId::new("run-requirements").unwrap();
    let running = projection(&run_id, None, false);
    let requirement = UserRequirement {
        requirement_id: "run-goal".to_string(),
        source_message_id: "user-message-1".to_string(),
        continuation_source: None,
        semantics: Some(goose::agents::protocol::RequirementSemantics {
            content: "build the requested project".to_string(),
            expected_effect: Some(goose::agents::protocol::RequirementEffect::WorkspaceChange),
            target_resources: vec!["project".to_string()],
            revision_relation: None,
        }),
        execution_obligations: Vec::new(),
    };

    let reduction = reduce(
        Some(&running),
        &ControlCommand::CommitUserRequirements {
            run_id: run_id.clone(),
            revision: 1,
            requirements: vec![requirement.clone()],
        },
    )
    .unwrap();
    assert_eq!(
        reduction.events[0].payload,
        RunEventPayload::UserRequirementsCommitted {
            revision: 1,
            requirements: vec![requirement.clone()],
        }
    );

    let events = vec![
        event(
            &run_id,
            1,
            None,
            RunEventPayload::RunStarted {
                goal: "preserve the user request".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(&run_id, 3, None, reduction.events[0].payload.clone()),
    ];
    let replayed = RunProjection::rebuild(&events).unwrap();
    assert_eq!(replayed.user_requirement_revision, 1);
    assert_eq!(
        replayed
            .user_requirements
            .get("run-goal")
            .map(|requirement| requirement.source_message_id.as_str()),
        Some("user-message-1")
    );

    assert!(reduce(
        Some(&running),
        &ControlCommand::CommitUserRequirements {
            run_id,
            revision: 2,
            requirements: vec![requirement],
        },
    )
    .is_err());
}

#[test]
fn supported_commands_reduce_to_exact_events_and_effects() {
    let run_id = RunId::new("run-reducer").unwrap();
    let task_id = TaskId::new("task-1").unwrap();

    let started = reduce(
        None,
        &ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "build the control plane".to_string(),
        },
    )
    .unwrap();
    assert_eq!(
        started,
        Reduction {
            events: vec![EventIntent {
                task_id: None,
                agent_id: None,
                payload: RunEventPayload::RunStarted {
                    goal: "build the control plane".to_string(),
                },
                evidence_refs: vec![],
            }],
            effects: vec![],
        }
    );

    let running = projection(&run_id, Some(TaskState::Ready), false);
    let task_started = reduce(
        Some(&running),
        &ControlCommand::StartTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        task_started.events[0].payload,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Ready,
            to: TaskState::Running,
        }
    );
    assert_eq!(
        task_started.effects,
        vec![EffectIntent {
            trigger_event_index: 0,
            effect: ControlEffect::DispatchTask {
                run_id: run_id.clone(),
                task_id,
            },
        }]
    );

    let paused = reduce(
        Some(&running),
        &ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "inspect progress".to_string(),
        },
    )
    .unwrap();
    assert_eq!(
        paused.events[0].payload,
        RunEventPayload::RunPaused {
            reason: "inspect progress".to_string(),
            checkpoint: None,
        }
    );
    assert_eq!(
        paused.effects[0].effect,
        ControlEffect::PauseScheduling {
            run_id: run_id.clone(),
        }
    );

    let paused_projection = projection(&run_id, None, true);
    let resumed = reduce(
        Some(&paused_projection),
        &ControlCommand::ResumeRun {
            run_id: run_id.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        resumed.events[0].payload,
        RunEventPayload::RunStateChanged {
            from: RunState::Paused,
            to: RunState::Recovering,
        }
    );
    assert_eq!(
        resumed.effects[0].effect,
        ControlEffect::RecoverRun { run_id }
    );
}

#[test]
fn explicitly_cancelled_run_can_recover_after_an_accidental_stop() {
    let run_id = RunId::new("run-cancelled-resume").unwrap();
    let task_id = TaskId::new("desktop-acceptance").unwrap();
    let agent_id = AgentId::new("tester-attempt-1").unwrap();
    let mut events = vec![
        event(
            &run_id,
            1,
            None,
            RunEventPayload::RunStarted {
                goal: "resume a desktop acceptance run after an accidental stop".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            Some(&task_id),
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "desktop acceptance".to_string(),
                role: Some(AgentRole::Tester),
            },
        ),
        event(
            &run_id,
            3,
            None,
            RunEventPayload::PlanProposed {
                plan_revision: 1,
                task_ids: vec![task_id.clone()],
            },
        ),
        event(
            &run_id,
            4,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            &run_id,
            5,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            6,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
        event(
            &run_id,
            7,
            Some(&task_id),
            RunEventPayload::AgentSpawned {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                role: AgentRole::Tester,
            },
        ),
        event(
            &run_id,
            8,
            Some(&task_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Starting,
                to: AgentState::Running,
            },
        ),
        event(
            &run_id,
            9,
            Some(&task_id),
            RunEventPayload::AgentStateChanged {
                agent_id: agent_id.clone(),
                task_id: Some(task_id.clone()),
                from: AgentState::Running,
                to: AgentState::Stopping,
            },
        ),
        event(
            &run_id,
            10,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Running,
                to: TaskState::Cancelled,
            },
        ),
        event(
            &run_id,
            11,
            None,
            RunEventPayload::RunCancelled {
                reason: "scheduler setup failed after process restart".to_string(),
            },
        ),
    ];
    for event in &mut events[6..9] {
        event.agent_id = Some(agent_id.clone());
    }
    let cancelled = RunProjection::rebuild(&events).unwrap();

    let resumed = reduce(
        Some(&cancelled),
        &ControlCommand::ResumeRun {
            run_id: run_id.clone(),
        },
    )
    .unwrap();

    assert_eq!(resumed.events.len(), 3);
    assert_eq!(
        resumed.events[0].payload,
        RunEventPayload::RunStateChanged {
            from: RunState::Cancelled,
            to: RunState::Recovering,
        }
    );
    assert_eq!(
        resumed.events[1].payload,
        RunEventPayload::AgentStateChanged {
            agent_id,
            task_id: Some(task_id.clone()),
            from: AgentState::Stopping,
            to: AgentState::Crashed,
        }
    );
    assert_eq!(
        resumed.events[2].payload,
        RunEventPayload::TaskStateChanged {
            task_id,
            from: TaskState::Cancelled,
            to: TaskState::Paused,
        }
    );
    assert_eq!(resumed.effects[0].trigger_event_index, 0);
    assert_eq!(
        resumed.effects[0].effect,
        ControlEffect::RecoverRun { run_id }
    );
}

#[test]
fn recovering_run_returns_to_running_before_dispatching_the_resumed_task() {
    let run_id = RunId::new("run-recover-task").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let events = vec![
        event(
            &run_id,
            1,
            None,
            RunEventPayload::RunStarted {
                goal: "resume desktop acceptance".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            RunEventPayload::PlanProposed {
                plan_revision: 1,
                task_ids: vec![task_id.clone()],
            },
        ),
        event(
            &run_id,
            3,
            Some(&task_id),
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "resume tester".to_string(),
                role: Some(AgentRole::Tester),
            },
        ),
        event(
            &run_id,
            4,
            None,
            RunEventPayload::TaskGraphDeclared {
                plan_revision: 1,
                dependencies: vec![goose::agents::protocol::TaskDependency {
                    task_id: task_id.clone(),
                    depends_on: vec![],
                }],
            },
        ),
        event(
            &run_id,
            5,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            6,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            &run_id,
            7,
            None,
            RunEventPayload::RunPaused {
                reason: "wait for environment".to_string(),
                checkpoint: None,
            },
        ),
        event(
            &run_id,
            8,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Paused,
                to: RunState::Recovering,
            },
        ),
    ];
    let recovering = RunProjection::rebuild(&events).unwrap();

    let resumed = reduce(
        Some(&recovering),
        &ControlCommand::StartTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
        },
    )
    .unwrap();

    assert_eq!(
        resumed.events[0].payload,
        RunEventPayload::RunStateChanged {
            from: RunState::Recovering,
            to: RunState::Running,
        }
    );
    assert_eq!(
        resumed.events[1].payload,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Ready,
            to: TaskState::Running,
        }
    );
    assert_eq!(
        resumed.effects,
        vec![EffectIntent {
            trigger_event_index: 1,
            effect: ControlEffect::DispatchTask { run_id, task_id },
        }]
    );
}

#[test]
fn running_run_recovery_marks_orphaned_work_paused_before_resuming() {
    let run_id = RunId::new("run-recover-orphan").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = AgentId::new("worker-task-1-attempt-1").unwrap();
    let mut spawned = event(
        &run_id,
        8,
        Some(&task_id),
        RunEventPayload::AgentSpawned {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            role: goose::agents::AgentRole::Tester,
        },
    );
    spawned.agent_id = Some(agent_id.clone());
    let mut agent_running = event(
        &run_id,
        9,
        Some(&task_id),
        RunEventPayload::AgentStateChanged {
            agent_id: agent_id.clone(),
            task_id: Some(task_id.clone()),
            from: AgentState::Starting,
            to: AgentState::Running,
        },
    );
    agent_running.agent_id = Some(agent_id.clone());
    let events = vec![
        event(
            &run_id,
            1,
            None,
            RunEventPayload::RunStarted {
                goal: "resume after process restart".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            RunEventPayload::PlanProposed {
                plan_revision: 1,
                task_ids: vec![task_id.clone()],
            },
        ),
        event(
            &run_id,
            3,
            Some(&task_id),
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "desktop acceptance".to_string(),
                role: Some(goose::agents::AgentRole::Tester),
            },
        ),
        event(
            &run_id,
            4,
            None,
            RunEventPayload::TaskGraphDeclared {
                plan_revision: 1,
                dependencies: vec![goose::agents::protocol::TaskDependency {
                    task_id: task_id.clone(),
                    depends_on: vec![],
                }],
            },
        ),
        event(
            &run_id,
            5,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            6,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            &run_id,
            7,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
        spawned,
        agent_running,
    ];
    let running = RunProjection::rebuild(&events).unwrap();

    let resumed = reduce(
        Some(&running),
        &ControlCommand::ResumeRun {
            run_id: run_id.clone(),
        },
    )
    .unwrap();

    assert_eq!(
        resumed.events,
        vec![
            EventIntent {
                task_id: Some(task_id.clone()),
                agent_id: Some(agent_id.clone()),
                payload: RunEventPayload::AgentStateChanged {
                    agent_id,
                    task_id: Some(task_id.clone()),
                    from: AgentState::Running,
                    to: AgentState::Crashed,
                },
                evidence_refs: vec![],
            },
            EventIntent {
                task_id: Some(task_id.clone()),
                agent_id: None,
                payload: RunEventPayload::TaskStateChanged {
                    task_id,
                    from: TaskState::Running,
                    to: TaskState::Paused,
                },
                evidence_refs: vec![],
            },
            EventIntent {
                task_id: None,
                agent_id: None,
                payload: RunEventPayload::RunStateChanged {
                    from: RunState::Running,
                    to: RunState::Recovering,
                },
                evidence_refs: vec![],
            },
        ]
    );
    assert_eq!(
        resumed.effects,
        vec![EffectIntent {
            trigger_event_index: 2,
            effect: ControlEffect::RecoverRun { run_id },
        }]
    );
}

#[test]
fn recovering_run_dispatches_the_same_paused_task_from_its_checkpoint() {
    let run_id = RunId::new("run-recover-paused-task").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let events = vec![
        event(
            &run_id,
            1,
            None,
            RunEventPayload::RunStarted {
                goal: "resume timed-out desktop acceptance".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            RunEventPayload::PlanProposed {
                plan_revision: 1,
                task_ids: vec![task_id.clone()],
            },
        ),
        event(
            &run_id,
            3,
            Some(&task_id),
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "resume tester from checkpoint".to_string(),
                role: Some(AgentRole::Tester),
            },
        ),
        event(
            &run_id,
            4,
            None,
            RunEventPayload::TaskGraphDeclared {
                plan_revision: 1,
                dependencies: vec![goose::agents::protocol::TaskDependency {
                    task_id: task_id.clone(),
                    depends_on: vec![],
                }],
            },
        ),
        event(
            &run_id,
            5,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            6,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Proposed,
                to: TaskState::Ready,
            },
        ),
        event(
            &run_id,
            7,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Ready,
                to: TaskState::Running,
            },
        ),
        event(
            &run_id,
            8,
            Some(&task_id),
            RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Running,
                to: TaskState::Paused,
            },
        ),
        event(
            &run_id,
            9,
            None,
            RunEventPayload::RunPaused {
                reason: "worker timed out after saving a checkpoint".to_string(),
                checkpoint: None,
            },
        ),
        event(
            &run_id,
            10,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Paused,
                to: RunState::Recovering,
            },
        ),
    ];
    let recovering = RunProjection::rebuild(&events).unwrap();

    let resumed = reduce(
        Some(&recovering),
        &ControlCommand::StartTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
        },
    )
    .unwrap();

    assert_eq!(
        resumed.events[0].payload,
        RunEventPayload::RunStateChanged {
            from: RunState::Recovering,
            to: RunState::Running,
        }
    );
    assert_eq!(
        resumed.events[1].payload,
        RunEventPayload::TaskStateChanged {
            task_id: task_id.clone(),
            from: TaskState::Paused,
            to: TaskState::Running,
        }
    );
    assert_eq!(
        resumed.effects,
        vec![EffectIntent {
            trigger_event_index: 1,
            effect: ControlEffect::DispatchTask { run_id, task_id },
        }]
    );
    TaskState::Paused
        .validate_transition(TaskState::Running)
        .expect("the protocol must accept the reducer's checkpoint resume transition");
}

#[test]
fn host_terminal_commands_require_evidence_for_completion() {
    let run_id = RunId::new("run-terminal").unwrap();
    let running = projection(&run_id, None, false);

    let completed = reduce(
        Some(&running),
        &ControlCommand::CompleteRun {
            run_id: run_id.clone(),
            summary: "all work verified".to_string(),
            proposal: None,
        },
    )
    .expect_err("an empty plan without acceptance evidence cannot complete");
    assert!(matches!(
        completed,
        ReducerError::CompletionEvidenceMissing(_)
    ));

    let failed = reduce(
        Some(&running),
        &ControlCommand::FailRun {
            run_id,
            class: FailureClass::Validation,
            message: "verification failed".to_string(),
            evidence_refs: vec![],
        },
    )
    .unwrap();
    assert!(matches!(
        failed.events.last().map(|event| &event.payload),
        Some(RunEventPayload::RunFailed {
            class: FailureClass::Validation,
            ..
        })
    ));
    assert!(matches!(
        failed.effects.as_slice(),
        [EffectIntent {
            effect: ControlEffect::AbortFailedRun { .. },
            ..
        }]
    ));
}

#[test]
fn complete_run_rejects_non_terminal_tasks() {
    let run_id = RunId::new("run-incomplete").unwrap();
    let ready = projection(&run_id, Some(TaskState::Ready), false);
    let proposal = CompletionProposal::for_projection(&ready);

    assert!(matches!(
        reduce(
            Some(&ready),
            &ControlCommand::CompleteRun {
                run_id,
                summary: "too early".to_string(),
                proposal: Some(proposal),
            }
        ),
        Err(ReducerError::CompletionBlocked(_))
    ));
}

#[test]
fn stream_identity_and_task_preconditions_fail_closed() {
    let run_id = RunId::new("run-reducer").unwrap();
    let foreign = RunId::new("run-foreign").unwrap();
    let ready = projection(&run_id, Some(TaskState::Ready), false);

    assert!(matches!(
        reduce(
            Some(&ready),
            &ControlCommand::StartRun {
                run_id: run_id.clone(),
                goal: "duplicate".to_string(),
            }
        ),
        Err(ReducerError::StreamAlreadyExists)
    ));
    assert!(matches!(
        reduce(
            None,
            &ControlCommand::ResumeRun {
                run_id: run_id.clone(),
            }
        ),
        Err(ReducerError::MissingStream { kind: "resume_run" })
    ));
    assert!(matches!(
        reduce(
            Some(&ready),
            &ControlCommand::StartTask {
                run_id: foreign,
                task_id: TaskId::new("task-1").unwrap(),
            }
        ),
        Err(ReducerError::RunMismatch { .. })
    ));
    assert!(matches!(
        reduce(
            Some(&ready),
            &ControlCommand::StartTask {
                run_id: run_id.clone(),
                task_id: TaskId::new("task-missing").unwrap(),
            }
        ),
        Err(ReducerError::UnknownTask(_))
    ));

    let proposed = projection(&run_id, Some(TaskState::Proposed), false);
    assert!(matches!(
        reduce(
            Some(&proposed),
            &ControlCommand::StartTask {
                run_id: run_id.clone(),
                task_id: TaskId::new("task-1").unwrap(),
            }
        ),
        Err(ReducerError::TaskNotReady { .. })
    ));
}

#[test]
fn invalid_run_transitions_and_deferred_commands_are_explicit() {
    let run_id = RunId::new("run-reducer").unwrap();
    let planning = RunProjection::rebuild(&[event(
        &run_id,
        1,
        None,
        RunEventPayload::RunStarted {
            goal: "still planning".to_string(),
        },
    )])
    .unwrap();
    assert!(matches!(
        reduce(
            Some(&planning),
            &ControlCommand::StartTask {
                run_id: run_id.clone(),
                task_id: TaskId::new("task-1").unwrap(),
            }
        ),
        Err(ReducerError::RunNotRunning(RunState::Planning))
    ));
    let terminal = RunProjection::rebuild(&[
        event(
            &run_id,
            1,
            None,
            RunEventPayload::RunStarted {
                goal: "already done".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
        event(
            &run_id,
            3,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Running,
                to: RunState::Completing,
            },
        ),
        event(
            &run_id,
            4,
            None,
            RunEventPayload::RunCompleted {
                summary: "done".to_string(),
                requirement_evidence: std::collections::BTreeMap::new(),
                execution_obligation_evidence: std::collections::BTreeMap::new(),
            },
        ),
    ])
    .unwrap();
    assert!(matches!(
        reduce(
            Some(&terminal),
            &ControlCommand::PauseRun {
                run_id: run_id.clone(),
                reason: "too late".to_string(),
            }
        ),
        Err(ReducerError::InvalidRunTransition { .. })
    ));

    let planning = RunProjection::rebuild(&[event(
        &run_id,
        1,
        None,
        RunEventPayload::RunStarted {
            goal: "not ready to resume".to_string(),
        },
    )])
    .unwrap();
    assert!(matches!(
        reduce(
            Some(&planning),
            &ControlCommand::ResumeRun {
                run_id: run_id.clone(),
            }
        ),
        Err(ReducerError::InvalidRunTransition { .. })
    ));

    let running = projection(&run_id, None, false);
    let candidate = CoordinatorDecisionCandidate {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        decision_id: EventId::new("decision-1").unwrap(),
        decision: CoordinatorDecision::ContinueTask,
        reason: "continue".to_string(),
        target_task_id: None,
        target_agent_id: None,
        evidence_refs: vec![],
        requested_budget: Some(BudgetRequest {
            max_additional_turns: 1,
            max_additional_tokens: None,
        }),
        required_permissions: vec![],
        expected_completion: "task continues".to_string(),
        supersedes_plan_revision: None,
    };
    let deferred = vec![
        ControlCommand::RevisePlan {
            run_id: run_id.clone(),
            plan_revision: 1,
        },
        ControlCommand::ApplyCoordinatorDecision { candidate },
    ];
    for command in deferred {
        assert!(matches!(
            reduce(Some(&running), &command),
            Err(ReducerError::DeferredCommand { kind }) if kind == command.kind()
        ));
    }
}

#[test]
fn reduction_invariants_reject_empty_out_of_range_and_scope_mismatch() {
    let run_id = RunId::new("run-reducer").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    assert!(matches!(
        Reduction {
            events: vec![],
            effects: vec![],
        }
        .validate(),
        Err(ReducerError::EmptyReduction)
    ));

    let base_event = EventIntent {
        task_id: None,
        agent_id: None,
        payload: RunEventPayload::RunPaused {
            reason: "review".to_string(),
            checkpoint: None,
        },
        evidence_refs: vec![],
    };
    assert!(matches!(
        Reduction {
            events: vec![base_event.clone()],
            effects: vec![EffectIntent {
                trigger_event_index: 1,
                effect: ControlEffect::PauseScheduling {
                    run_id: run_id.clone(),
                },
            }],
        }
        .validate(),
        Err(ReducerError::InvalidEffectIndex { .. })
    ));
    assert!(matches!(
        Reduction {
            events: vec![base_event],
            effects: vec![EffectIntent {
                trigger_event_index: 0,
                effect: ControlEffect::DispatchTask { run_id, task_id },
            }],
        }
        .validate(),
        Err(ReducerError::EffectScopeMismatch { .. })
    ));
}
