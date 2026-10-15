use async_trait::async_trait;
use goose::agents::control_plane::{
    CodeProRuntime, CodeProRuntimeMode, CommittedControlEffect, ControlEffectExecutor,
    EffectClaimStatus, EffectExecutionError, EffectLedger, FileEffectLedger, FileRunEventStore,
    OutcomeSubmission, RunEventStore, RuntimeModePolicy, UncertainEffectResolution,
    EFFECT_LEDGER_FILE_NAME, MAX_RUN_EVENT_LOG_BYTES, MAX_RUN_EVENT_RECORDS,
    RUN_EVENT_LOG_FILE_NAME,
};
use goose::agents::protocol::{
    AgentId, ControlCommand, EventId, FailureClass, PlanRevisionAudit, PlannedTask,
    ProtocolVersion, RunEvent, RunEventPayload, RunId, TaskFailure, TaskId, TaskResult, TaskState,
    TaskWorkspaceGrant, UserRequirement, WorkerOutcome,
};
use goose::agents::AgentRole;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
struct RecordingExecutor {
    effect_ids: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl ControlEffectExecutor for RecordingExecutor {
    async fn execute(&self, effect: &CommittedControlEffect) -> Result<(), EffectExecutionError> {
        self.effect_ids.lock().unwrap().push(effect.ledger_key());
        Ok(())
    }
}

#[test]
fn runtime_mode_defaults_to_durable_and_preserves_explicit_values() {
    for value in [None, Some("")] {
        let policy = RuntimeModePolicy::parse(value);
        assert_eq!(policy.requested(), CodeProRuntimeMode::Durable);
        assert_eq!(policy.effective(), CodeProRuntimeMode::Durable);
        assert!(policy.warning().is_none());
    }

    for (value, expected) in [
        ("legacy", CodeProRuntimeMode::Legacy),
        ("shadow", CodeProRuntimeMode::Shadow),
        ("durable", CodeProRuntimeMode::Durable),
    ] {
        let policy = RuntimeModePolicy::parse(Some(value));
        assert_eq!(policy.requested(), expected);
        assert_eq!(policy.effective(), expected);
        assert!(policy.warning().is_none());
    }

    let malformed = RuntimeModePolicy::parse(Some("DURABLE "));
    assert_eq!(malformed.requested(), CodeProRuntimeMode::Legacy);
    assert_eq!(malformed.effective(), CodeProRuntimeMode::Legacy);
    assert!(malformed.warning().is_some());
    assert!(!malformed.warning().unwrap().contains("DURABLE"));
}

#[tokio::test]
async fn runtime_binding_is_immutable_and_create_is_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let runtime =
        CodeProRuntime::initialize(temp.path(), RuntimeModePolicy::parse(Some("durable")))
            .await
            .unwrap();
    assert_eq!(
        runtime.mode_policy().requested(),
        CodeProRuntimeMode::Durable
    );
    assert_eq!(
        runtime.mode_policy().effective(),
        CodeProRuntimeMode::Legacy
    );
    assert!(runtime.mode_policy().warning().is_some());
    let run_id = RunId::new("runtime-run-1").unwrap();

    let created = runtime
        .create_or_verify_run("session-1", run_id.clone(), "Ship the runtime")
        .await
        .unwrap();
    let repeated = runtime
        .create_or_verify_run("session-1", run_id.clone(), "Ship the runtime")
        .await
        .unwrap();
    assert_eq!(created.projection, repeated.projection);
    assert_eq!(repeated.projection.last_sequence, 1);

    let wrong_session = runtime
        .create_or_verify_run("session-2", run_id.clone(), "Ship the runtime")
        .await
        .unwrap_err();
    assert!(wrong_session.to_string().contains("belongs to session"));
    let wrong_goal = runtime
        .create_or_verify_run("session-1", run_id.clone(), "Different goal")
        .await
        .unwrap_err();
    assert!(wrong_goal.to_string().contains("goal is immutable"));
}

#[tokio::test]
async fn unaudited_plan_revision_does_not_requeue_coordinator_failure() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize(temp.path(), RuntimeModePolicy::parse(Some("shadow")))
        .await
        .unwrap();
    let run_id = RunId::new("runtime-unaudited-revision").unwrap();
    let task_id = TaskId::new("desktop-acceptance").unwrap();
    let agent_id = AgentId::new("worker-desktop-acceptance-attempt-1").unwrap();
    let planned = PlannedTask {
        task_id: task_id.clone(),
        name: "Run desktop acceptance".to_string(),
        role: Some(AgentRole::Tester),
        depends_on: vec![],
    };

    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Do not loop failed workers")
        .await
        .unwrap();
    runtime
        .install_plan("session-1", run_id.clone(), 1, vec![planned.clone()])
        .await
        .unwrap();
    runtime
        .start_task("session-1", run_id.clone(), task_id.clone())
        .await
        .unwrap();
    let (_, handle) = runtime
        .register_worker(
            "session-1",
            run_id.clone(),
            task_id.clone(),
            agent_id,
            AgentRole::Tester,
        )
        .await
        .unwrap();
    runtime
        .submit_outcome(
            "session-1",
            &handle,
            WorkerOutcome::Failed(TaskFailure {
                class: FailureClass::Implementation,
                message: "worker returned no verification evidence".to_string(),
                evidence_refs: vec![],
            }),
        )
        .await
        .unwrap();

    runtime
        .install_plan("session-1", run_id.clone(), 2, vec![planned.clone()])
        .await
        .unwrap();

    let snapshot = runtime.snapshot("session-1", &run_id).await.unwrap();
    assert_eq!(
        snapshot.projection.tasks[&task_id].state,
        TaskState::WaitingForCoordinator
    );

    runtime
        .install_plan_with_audit(
            "session-1",
            run_id.clone(),
            3,
            vec![planned],
            Some(PlanRevisionAudit {
                supersedes_revision: 2,
                trigger_task_id: task_id.clone(),
                trigger_failure: TaskFailure {
                    class: FailureClass::Implementation,
                    message: "worker returned no verification evidence".to_string(),
                    evidence_refs: vec![],
                },
                planner_input: "retry after a bounded repair".to_string(),
                decision_basis: "the revised plan addresses the triggering failure".to_string(),
                reassigned_to: None,
            }),
        )
        .await
        .unwrap();

    let snapshot = runtime.snapshot("session-1", &run_id).await.unwrap();
    assert_eq!(snapshot.projection.tasks[&task_id].state, TaskState::Ready);
}

#[tokio::test]
async fn runtime_publishes_committed_updates_to_all_clones() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize(temp.path(), RuntimeModePolicy::parse(Some("shadow")))
        .await
        .unwrap();
    let clone = runtime.clone();
    let mut updates = clone.subscribe_updates();
    let run_id = RunId::new("runtime-updates").unwrap();

    runtime
        .create_or_verify_run("session-updates", run_id.clone(), "stream state")
        .await
        .unwrap();
    let started = updates.recv().await.unwrap();
    assert_eq!(started.session_id, "session-updates");
    assert_eq!(started.run_id, run_id);
    assert_eq!(started.last_sequence, 1);

    let notification_started = Instant::now();
    runtime
        .install_plan(
            "session-updates",
            started.run_id.clone(),
            1,
            vec![PlannedTask {
                task_id: TaskId::new("task-update").unwrap(),
                name: "publish state".to_string(),
                role: Some(AgentRole::Coder),
                depends_on: vec![],
            }],
        )
        .await
        .unwrap();
    let planned = tokio::time::timeout(Duration::from_secs(2), updates.recv())
        .await
        .expect("runtime update must arrive within the local notification gate")
        .unwrap();
    let notification_elapsed = notification_started.elapsed();
    println!(
        "CODEPRO_EVENT_TO_RUNTIME_NOTIFICATION_MS={}",
        notification_elapsed.as_secs_f64() * 1000.0
    );
    assert!(notification_elapsed < Duration::from_secs(2));
    assert!(planned.last_sequence > started.last_sequence);
}

#[tokio::test]
async fn runtime_recovers_ten_thousand_events_under_the_local_gate() {
    const EVENT_COUNT: u64 = 10_000;
    let temp = tempfile::tempdir().unwrap();
    let policy = RuntimeModePolicy::parse(Some("shadow"));
    let run_id = RunId::new("runtime-scale-10000").unwrap();
    let runtime = CodeProRuntime::initialize(temp.path(), policy.clone())
        .await
        .unwrap();
    runtime
        .create_or_verify_run("session-scale", run_id.clone(), "Recover bounded history")
        .await
        .unwrap();
    drop(runtime);

    let store = FileRunEventStore::new(temp.path());
    let occurred_at = chrono::Utc::now();
    let mut events = Vec::with_capacity((EVENT_COUNT - 1) as usize);
    for sequence in 2..=EVENT_COUNT {
        let event_id = EventId::new(format!("runtime-scale-event-{sequence}")).unwrap();
        events.push(RunEvent {
            protocol_version: ProtocolVersion::CURRENT,
            run_id: run_id.clone(),
            event_id: event_id.clone(),
            sequence,
            task_id: None,
            agent_id: None,
            causation_id: None,
            correlation_id: event_id,
            occurred_at,
            payload: RunEventPayload::LegacyActivityObserved {
                kind: "qualification_observation".to_string(),
                status: "completed".to_string(),
                title: "bounded runtime recovery event".to_string(),
            },
            evidence_refs: vec![],
        });
    }
    store.append(&run_id, 1, &events).await.unwrap();
    let event_log_bytes = std::fs::metadata(store.event_log_path(&run_id))
        .unwrap()
        .len();
    println!("CODEPRO_10000_EVENT_LOG_BYTES={event_log_bytes}");
    assert!(event_log_bytes <= MAX_RUN_EVENT_LOG_BYTES);
    assert!((EVENT_COUNT as usize) <= MAX_RUN_EVENT_RECORDS);

    let recovery_started = Instant::now();
    let recovered = CodeProRuntime::initialize(temp.path(), policy)
        .await
        .unwrap();
    let recovery_elapsed = recovery_started.elapsed();
    println!(
        "CODEPRO_10000_EVENT_RUNTIME_RECOVERY_MS={}",
        recovery_elapsed.as_secs_f64() * 1000.0
    );
    assert!(
        recovery_elapsed < Duration::from_secs(10),
        "10,000-event runtime recovery took {recovery_elapsed:?}"
    );
    let snapshot = recovered.snapshot("session-scale", &run_id).await.unwrap();
    assert_eq!(snapshot.projection.last_sequence, EVENT_COUNT);
    assert_eq!(snapshot.events.len(), EVENT_COUNT as usize);
}

#[tokio::test]
async fn runtime_clones_share_locks_and_read_only_snapshots_do_not_write() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize(temp.path(), RuntimeModePolicy::parse(Some("shadow")))
        .await
        .unwrap();
    let run_id = RunId::new("runtime-run-2").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Inspect safely")
        .await
        .unwrap();
    let event_path = temp
        .path()
        .join(run_id.as_str())
        .join(RUN_EVENT_LOG_FILE_NAME);
    let ledger_path = temp
        .path()
        .join(run_id.as_str())
        .join(EFFECT_LEDGER_FILE_NAME);
    let events_before = std::fs::read(&event_path).unwrap();
    let ledger_before = std::fs::read(&ledger_path).unwrap_or_default();

    let first = runtime.clone();
    let second = runtime.clone();
    let (left, right) = tokio::join!(
        first.snapshot("session-1", &run_id),
        second.snapshot("session-1", &run_id)
    );
    assert_eq!(left.unwrap().projection, right.unwrap().projection);
    assert_eq!(std::fs::read(event_path).unwrap(), events_before);
    assert_eq!(
        std::fs::read(ledger_path).unwrap_or_default(),
        ledger_before
    );
}

#[tokio::test]
async fn startup_recovery_finishes_before_runtime_is_returned() {
    let temp = tempfile::tempdir().unwrap();
    let policy = RuntimeModePolicy::parse(Some("legacy"));
    let runtime = CodeProRuntime::initialize(temp.path(), policy.clone())
        .await
        .unwrap();
    let run_id = RunId::new("runtime-recovery-1").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Recover me")
        .await
        .unwrap();
    drop(runtime);

    let restarted = CodeProRuntime::initialize(temp.path(), policy)
        .await
        .unwrap();
    assert_eq!(restarted.startup_recovery().recovered_runs, vec![run_id]);
}

#[tokio::test]
async fn startup_repairs_a_binding_committed_before_its_first_event() {
    let temp = tempfile::tempdir().unwrap();
    let policy = RuntimeModePolicy::parse(Some("durable"));
    let runtime = CodeProRuntime::initialize(temp.path(), policy.clone())
        .await
        .unwrap();
    let run_id = RunId::new("runtime-incomplete-registration").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Recover registration")
        .await
        .unwrap();
    let event_path = temp
        .path()
        .join(run_id.as_str())
        .join(RUN_EVENT_LOG_FILE_NAME);
    let completion_path = temp
        .path()
        .join(run_id.as_str())
        .join("runtime-registration.v1.complete");
    std::fs::remove_file(&event_path).unwrap();
    std::fs::remove_file(&completion_path).unwrap();
    drop(runtime);

    let restarted = CodeProRuntime::initialize(temp.path(), policy)
        .await
        .unwrap();
    let snapshot = restarted.snapshot("session-1", &run_id).await.unwrap();
    assert_eq!(snapshot.projection.goal, "Recover registration");
    assert_eq!(snapshot.projection.last_sequence, 1);
}

#[tokio::test]
async fn startup_rejects_event_loss_after_registration_completed() {
    let temp = tempfile::tempdir().unwrap();
    let policy = RuntimeModePolicy::parse(Some("durable"));
    let runtime = CodeProRuntime::initialize(temp.path(), policy.clone())
        .await
        .unwrap();
    let run_id = RunId::new("runtime-lost-events").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Do not hide data loss")
        .await
        .unwrap();
    std::fs::remove_file(
        temp.path()
            .join(run_id.as_str())
            .join(RUN_EVENT_LOG_FILE_NAME),
    )
    .unwrap();
    drop(runtime);

    let error = CodeProRuntime::initialize(temp.path(), policy)
        .await
        .err()
        .expect("completed registrations with missing events must fail closed");
    assert!(error.to_string().contains("missing its event stream"));
}

#[tokio::test]
async fn startup_persists_in_flight_effects_as_uncertain_without_retrying_them() {
    let temp = tempfile::tempdir().unwrap();
    let policy = RuntimeModePolicy::parse(Some("durable"));
    let runtime = CodeProRuntime::initialize(temp.path(), policy.clone())
        .await
        .unwrap();
    let run_id = RunId::new("runtime-uncertain-effect").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Recover controls")
        .await
        .unwrap();
    let receipt = runtime
        .control(
            "session-1",
            ControlCommand::PauseRun {
                run_id: run_id.clone(),
                reason: "Inspect state".to_string(),
            },
            Some(1),
        )
        .await
        .unwrap();
    let effect = receipt.effects()[0].clone();
    let ledger = FileEffectLedger::new(temp.path());
    assert_eq!(ledger.claim(&effect).unwrap(), EffectClaimStatus::Claimed);
    drop(runtime);

    let restarted = CodeProRuntime::initialize(temp.path(), policy)
        .await
        .unwrap();
    assert_eq!(restarted.startup_recovery().uncertain_effects, 1);
    assert_eq!(restarted.startup_recovery().pending_effects, 0);
    let resolved = restarted
        .resolve_uncertain(
            "session-1",
            &run_id,
            &effect.ledger_key(),
            UncertainEffectResolution::ConfirmedApplied,
        )
        .await
        .unwrap();
    assert!(resolved.recovery.uncertain.is_empty());
}

#[tokio::test]
async fn durable_startup_dispatches_each_pending_effect_exactly_once() {
    let temp = tempfile::tempdir().unwrap();
    let policy = RuntimeModePolicy::parse(Some("durable"));
    let runtime = CodeProRuntime::initialize(temp.path(), policy.clone())
        .await
        .unwrap();
    let run_id = RunId::new("runtime-pending-effect").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Dispatch after recovery")
        .await
        .unwrap();
    runtime
        .control(
            "session-1",
            ControlCommand::PauseRun {
                run_id: run_id.clone(),
                reason: "Wait for restart".to_string(),
            },
            Some(1),
        )
        .await
        .unwrap();
    drop(runtime);

    let executor = RecordingExecutor::default();
    let restarted =
        CodeProRuntime::initialize_with_executor(temp.path(), policy.clone(), executor.clone())
            .await
            .unwrap();
    assert_eq!(executor.effect_ids.lock().unwrap().len(), 1);
    assert_eq!(restarted.startup_recovery().pending_effects, 0);
    drop(restarted);

    let _second_restart =
        CodeProRuntime::initialize_with_executor(temp.path(), policy, executor.clone())
            .await
            .unwrap();
    assert_eq!(executor.effect_ids.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn production_facade_owns_plan_worker_and_outcome_lifecycle() {
    let temp = tempfile::tempdir().unwrap();
    let runtime =
        CodeProRuntime::initialize(temp.path(), RuntimeModePolicy::parse(Some("durable")))
            .await
            .unwrap();
    let run_id = RunId::new("runtime-production-lifecycle").unwrap();
    let task_id = TaskId::new("task-runtime").unwrap();
    let agent_id = AgentId::new("worker-runtime").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Execute safely")
        .await
        .unwrap();
    runtime
        .install_plan(
            "session-1",
            run_id.clone(),
            1,
            vec![PlannedTask {
                task_id: task_id.clone(),
                name: "Implement the runtime".to_string(),
                role: Some(AgentRole::Coder),
                depends_on: vec![],
            }],
        )
        .await
        .unwrap();
    runtime
        .start_task("session-1", run_id.clone(), task_id.clone())
        .await
        .unwrap();
    let (_, handle) = runtime
        .register_worker(
            "session-1",
            run_id.clone(),
            task_id.clone(),
            agent_id,
            AgentRole::Coder,
        )
        .await
        .unwrap();
    let submission = runtime
        .submit_outcome(
            "session-1",
            &handle,
            WorkerOutcome::Succeeded(TaskResult {
                summary: "implemented and verified".to_string(),
                evidence_refs: vec![],
            }),
        )
        .await
        .unwrap();
    assert!(matches!(submission, OutcomeSubmission::Committed { .. }));
    let snapshot = runtime.snapshot("session-1", &run_id).await.unwrap();
    assert_eq!(
        snapshot.projection.tasks[&task_id].state,
        TaskState::Succeeded
    );
}

#[tokio::test]
async fn production_runtime_dispatches_committed_controls_to_its_shared_gate() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize_production(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
    )
    .await
    .unwrap();
    assert_eq!(
        runtime.mode_policy().effective(),
        CodeProRuntimeMode::Durable
    );
    let run_id = RunId::new("runtime-production-gate").unwrap();
    let task_id = TaskId::new("task-gated").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Gate real work")
        .await
        .unwrap();
    runtime
        .install_plan(
            "session-1",
            run_id.clone(),
            1,
            vec![PlannedTask {
                task_id: task_id.clone(),
                name: "Run once".to_string(),
                role: Some(AgentRole::Coder),
                depends_on: vec![],
            }],
        )
        .await
        .unwrap();
    let started = runtime
        .start_task("session-1", run_id.clone(), task_id.clone())
        .await
        .unwrap();
    assert!(runtime
        .claim_scheduling_lease(&run_id, &task_id)
        .unwrap()
        .is_some());

    let paused = runtime
        .control(
            "session-1",
            ControlCommand::PauseRun {
                run_id: run_id.clone(),
                reason: "Inspect".to_string(),
            },
            Some(started.projection().last_sequence),
        )
        .await
        .unwrap();
    assert!(runtime
        .claim_scheduling_lease(&run_id, &task_id)
        .unwrap_err()
        .to_string()
        .contains("paused"));
    runtime
        .control(
            "session-1",
            ControlCommand::ResumeRun {
                run_id: run_id.clone(),
            },
            Some(paused.projection().last_sequence),
        )
        .await
        .unwrap();
    assert!(runtime
        .claim_scheduling_lease(&run_id, &task_id)
        .unwrap()
        .is_none());
    let snapshot = runtime.snapshot("session-1", &run_id).await.unwrap();
    assert!(snapshot.recovery.pending.is_empty());
    assert!(snapshot.recovery.uncertain.is_empty());
}

#[tokio::test]
async fn r3_action_admission_is_ordered_with_pause_commit() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize_production(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
    )
    .await
    .unwrap();
    let run_id = RunId::new("r3-admission").unwrap();
    let task_id = TaskId::new("root-task").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "admit before pause")
        .await
        .unwrap();
    runtime
        .install_plan(
            "session-1",
            run_id.clone(),
            1,
            vec![PlannedTask {
                task_id: task_id.clone(),
                name: "root".to_string(),
                role: None,
                depends_on: vec![],
            }],
        )
        .await
        .unwrap();
    runtime
        .start_task("session-1", run_id.clone(), task_id.clone())
        .await
        .unwrap();
    let admission = runtime
        .admit_action("session-1", &run_id, &task_id, "request-1", None)
        .await
        .unwrap();
    let pause = runtime.control(
        "session-1",
        ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: "stop".to_string(),
        },
        None,
    );
    tokio::pin!(pause);
    assert!(matches!(
        futures::poll!(pause.as_mut()),
        std::task::Poll::Pending
    ));
    drop(admission);
    pause.await.unwrap();
    let denied = runtime
        .admit_action("session-1", &run_id, &task_id, "request-2", None)
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("Paused"));
}

#[tokio::test]
async fn requirement_revision_recovers_after_rejected_unknown_effect_changes() {
    use goose::agents::protocol::{
        RequirementEffect, RequirementRevisionKind, RequirementRevisionRelation,
        RequirementSemantics,
    };

    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize_with_executor(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
        RecordingExecutor::default(),
    )
    .await
    .unwrap();
    let run_id = RunId::new("requirement-recovery").unwrap();
    runtime
        .create_or_verify_run(
            "session-1",
            run_id.clone(),
            "diagnose first, repair after approval",
        )
        .await
        .unwrap();
    let goal = UserRequirement {
        requirement_id: "run-goal".to_string(),
        source_message_id: "message-1".to_string(),
        continuation_source: None,
        semantics: Some(RequirementSemantics {
            content: "Inspect the inventory without changing files".to_string(),
            expected_effect: None,
            target_resources: Vec::new(),
            revision_relation: None,
        }),
        execution_obligations: Vec::new(),
    };
    runtime
        .control(
            "session-1",
            ControlCommand::CommitUserRequirements {
                run_id: run_id.clone(),
                revision: 1,
                requirements: vec![goal.clone()],
            },
            None,
        )
        .await
        .unwrap();
    let mut retained = goal;
    retained.semantics.as_mut().unwrap().revision_relation = Some(RequirementRevisionRelation {
        previous_revision: 1,
        requirement_ids: vec!["run-goal".to_string()],
        kind: RequirementRevisionKind::Retained,
    });
    let input = UserRequirement {
        requirement_id: "input-message-2".to_string(),
        source_message_id: "message-2".to_string(),
        continuation_source: None,
        semantics: Some(RequirementSemantics {
            content: "Repair only duplicate inventory deductions; leave cancellation and old orders alone".to_string(),
            expected_effect: None,
            target_resources: Vec::new(),
            revision_relation: None,
        }),
        execution_obligations: Vec::new(),
    };
    runtime
        .control(
            "session-1",
            ControlCommand::CommitUserRequirements {
                run_id: run_id.clone(),
                revision: 2,
                requirements: vec![retained.clone(), input.clone()],
            },
            None,
        )
        .await
        .unwrap();
    let before = runtime
        .snapshot("session-1", &run_id)
        .await
        .unwrap()
        .projection;
    let mut revised = vec![retained, input];
    for requirement in &mut revised {
        let semantics = requirement.semantics.as_mut().unwrap();
        semantics.expected_effect = Some(if requirement.requirement_id == "run-goal" {
            RequirementEffect::Observation
        } else {
            RequirementEffect::WorkspaceChange
        });
        semantics.revision_relation = Some(RequirementRevisionRelation {
            previous_revision: 2,
            requirement_ids: vec![requirement.requirement_id.clone()],
            kind: RequirementRevisionKind::Replaced,
        });
    }
    let mut incorrect_retained = revised.clone();
    incorrect_retained[0]
        .semantics
        .as_mut()
        .unwrap()
        .revision_relation
        .as_mut()
        .unwrap()
        .kind = RequirementRevisionKind::Retained;
    let mut stale = revised.clone();
    stale[0]
        .semantics
        .as_mut()
        .unwrap()
        .revision_relation
        .as_mut()
        .unwrap()
        .previous_revision = 1;
    let mut missing_relation = revised.clone();
    missing_relation[0]
        .semantics
        .as_mut()
        .unwrap()
        .revision_relation = None;
    let error = runtime
        .control(
            "session-1",
            ControlCommand::CommitUserRequirements {
                run_id: run_id.clone(),
                revision: 3,
                requirements: missing_relation,
            },
            None,
        )
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("requirements[0].semantics.revision_relation"),
        "{error}"
    );
    assert!(error.contains("\"previous_revision\":2"), "{error}");
    assert!(
        error.contains("\"requirement_ids\":[\"run-goal\"]"),
        "{error}"
    );
    assert!(error.contains("No contract state changed"), "{error}");
    assert_eq!(
        runtime
            .snapshot("session-1", &run_id)
            .await
            .unwrap()
            .projection,
        before
    );
    for invalid in [incorrect_retained, stale, vec![revised[1].clone()]] {
        assert!(runtime
            .control(
                "session-1",
                ControlCommand::CommitUserRequirements {
                    run_id: run_id.clone(),
                    revision: 3,
                    requirements: invalid,
                },
                None,
            )
            .await
            .is_err());
        assert_eq!(
            runtime
                .snapshot("session-1", &run_id)
                .await
                .unwrap()
                .projection,
            before
        );
    }
    runtime
        .control(
            "session-1",
            ControlCommand::CommitUserRequirements {
                run_id: run_id.clone(),
                revision: 3,
                requirements: revised,
            },
            None,
        )
        .await
        .unwrap();
    let committed = runtime
        .snapshot("session-1", &run_id)
        .await
        .unwrap()
        .projection;
    assert_eq!(committed.user_requirement_revision, 3);
    assert_eq!(
        committed.user_requirements["run-goal"]
            .semantics
            .as_ref()
            .unwrap()
            .expected_effect,
        Some(RequirementEffect::Observation)
    );
    assert_eq!(
        committed.user_requirements["input-message-2"]
            .semantics
            .as_ref()
            .unwrap()
            .expected_effect,
        Some(RequirementEffect::WorkspaceChange)
    );
    drop(runtime);
    let restored = CodeProRuntime::initialize_with_executor(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
        RecordingExecutor::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        restored
            .snapshot("session-1", &run_id)
            .await
            .unwrap()
            .projection,
        committed
    );
}

#[tokio::test]
async fn r3_formal_task_workspace_grant_replays_and_expires_with_requirement_revision() {
    let temp = tempfile::tempdir().unwrap();
    let control_root = temp.path().join("control");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let runtime = CodeProRuntime::initialize_with_executor(
        &control_root,
        RuntimeModePolicy::parse(Some("durable")),
        RecordingExecutor::default(),
    )
    .await
    .unwrap();
    let run_id = RunId::new("r3-task-grant").unwrap();
    let task_id = TaskId::new("main-agent-root").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "build a project")
        .await
        .unwrap();
    runtime
        .control(
            "session-1",
            ControlCommand::CommitUserRequirements {
                run_id: run_id.clone(),
                revision: 1,
                requirements: vec![UserRequirement {
                    requirement_id: "run-goal".to_string(),
                    source_message_id: "message-1".to_string(),
                    continuation_source: None,
                    semantics: Some(goose::agents::protocol::RequirementSemantics {
                        content: "build a project".to_string(),
                        expected_effect: Some(
                            goose::agents::protocol::RequirementEffect::WorkspaceChange,
                        ),
                        target_resources: vec!["project".to_string()],
                        revision_relation: None,
                    }),
                    execution_obligations: Vec::new(),
                }],
            },
            None,
        )
        .await
        .unwrap();
    runtime
        .install_plan(
            "session-1",
            run_id.clone(),
            1,
            vec![PlannedTask {
                task_id: task_id.clone(),
                name: "Main Agent".to_string(),
                role: None,
                depends_on: Vec::new(),
            }],
        )
        .await
        .unwrap();
    runtime
        .start_task("session-1", run_id.clone(), task_id.clone())
        .await
        .unwrap();
    let grant = TaskWorkspaceGrant {
        grant_id: "grant-1".to_string(),
        source_task_id: task_id.clone(),
        request_id: "confirmation-1".to_string(),
        option_id: "allow_always".to_string(),
        workspace_root: workspace
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string(),
        requirement_revision: 1,
        authorization_revision: 1,
    };
    runtime
        .control(
            "session-1",
            ControlCommand::CommitTaskWorkspaceGrant {
                run_id: run_id.clone(),
                grant: grant.clone(),
            },
            None,
        )
        .await
        .unwrap();
    drop(runtime);

    let restored = CodeProRuntime::initialize_with_executor(
        &control_root,
        RuntimeModePolicy::parse(Some("durable")),
        RecordingExecutor::default(),
    )
    .await
    .unwrap();
    let snapshot = restored.snapshot("session-1", &run_id).await.unwrap();
    assert_eq!(snapshot.projection.task_workspace_grant, Some(grant));
    assert_eq!(snapshot.projection.authorization_revision, 1);
    restored
        .admit_action("session-1", &run_id, &task_id, "write-1", Some(1))
        .await
        .unwrap();
    restored
        .control(
            "session-1",
            ControlCommand::CommitUserRequirements {
                run_id: run_id.clone(),
                revision: 2,
                requirements: vec![UserRequirement {
                    requirement_id: "run-goal".to_string(),
                    source_message_id: "message-2".to_string(),
                    continuation_source: None,
                    semantics: Some(goose::agents::protocol::RequirementSemantics {
                        content: "revised project".to_string(),
                        expected_effect: Some(
                            goose::agents::protocol::RequirementEffect::WorkspaceChange,
                        ),
                        target_resources: vec!["project".to_string()],
                        revision_relation: Some(
                            goose::agents::protocol::RequirementRevisionRelation {
                                previous_revision: 1,
                                requirement_ids: vec!["run-goal".to_string()],
                                kind: goose::agents::protocol::RequirementRevisionKind::Replaced,
                            },
                        ),
                    }),
                    execution_obligations: Vec::new(),
                }],
            },
            None,
        )
        .await
        .unwrap();
    let stale = restored
        .admit_action("session-1", &run_id, &task_id, "write-2", Some(1))
        .await;
    assert!(
        stale.is_err(),
        "revised requirements must not silently reuse the old grant"
    );
}

#[tokio::test]
async fn runtime_exposes_only_handle_scoped_worker_controls() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize_production(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
    )
    .await
    .unwrap();
    let run_id = RunId::new("runtime-worker-controls").unwrap();
    let task_id = TaskId::new("task-controlled").unwrap();
    let agent_id = AgentId::new("worker-controlled").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Control a real worker")
        .await
        .unwrap();
    runtime
        .install_plan(
            "session-1",
            run_id.clone(),
            1,
            vec![PlannedTask {
                task_id: task_id.clone(),
                name: "Controlled worker".to_string(),
                role: Some(AgentRole::Coder),
                depends_on: vec![],
            }],
        )
        .await
        .unwrap();
    runtime
        .start_task("session-1", run_id.clone(), task_id.clone())
        .await
        .unwrap();
    let (_, handle) = runtime
        .register_worker("session-1", run_id, task_id, agent_id, AgentRole::Coder)
        .await
        .unwrap();

    let worker_token = runtime.worker_cancellation_token(&handle).unwrap();
    assert!(!worker_token.is_cancelled());
    runtime.register_worker_process(&handle, 4242).unwrap();
    assert!(runtime.unregister_worker_process(&handle, 4242).unwrap());

    let runner = tokio::spawn(std::future::pending::<()>());
    runtime
        .attach_worker_abort_handle(&handle, runner.abort_handle())
        .unwrap();
    runtime
        .control(
            "session-1",
            ControlCommand::StopWorker {
                run_id: handle.run_id().clone(),
                agent_id: handle.agent_id().clone(),
                reason: "test scoped stop".to_string(),
            },
            None,
        )
        .await
        .unwrap();

    assert!(worker_token.is_cancelled());
    assert!(runner.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn rebinding_a_prompt_token_targets_the_current_prompt_only() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = CodeProRuntime::initialize_production(
        temp.path(),
        RuntimeModePolicy::parse(Some("durable")),
    )
    .await
    .unwrap();
    let run_id = RunId::new("runtime-current-prompt").unwrap();
    runtime
        .create_or_verify_run("session-1", run_id.clone(), "Stop the current prompt")
        .await
        .unwrap();
    let stale = tokio_util::sync::CancellationToken::new();
    let current = tokio_util::sync::CancellationToken::new();
    runtime.bind_prompt_token(&run_id, stale.clone()).unwrap();
    runtime.bind_prompt_token(&run_id, current.clone()).unwrap();

    runtime
        .control(
            "session-1",
            ControlCommand::EmergencyStop {
                run_id,
                reason: "operator requested stop".to_string(),
            },
            None,
        )
        .await
        .unwrap();

    assert!(!stale.is_cancelled());
    assert!(current.is_cancelled());
}
