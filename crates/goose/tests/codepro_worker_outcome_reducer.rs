use chrono::{TimeZone, Utc};
use goose::agents::control_plane::{
    reduce, CompletionProposal, ControlEffect, ConvergenceBlocker, FailureDisposition,
    FailurePolicy, RequirementEvidenceCoverage,
};
use goose::agents::protocol::{
    AgentId, AgentState, AssistanceRequest, BlockKind, BlockReason, CancellationReport, Checkpoint,
    ControlCommand, EventId, EvidenceRef, FailureClass, ProtocolVersion, RecoveryAction, RunEvent,
    RunEventPayload, RunId, RunState, TaskFailure, TaskId, TaskResult, TaskState, WorkerOutcome,
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
    let event_id = EventId::new(format!("reducer-outcome-event-{sequence}")).unwrap();
    RunEvent {
        protocol_version: ProtocolVersion::V2,
        run_id: run_id.clone(),
        event_id: event_id.clone(),
        sequence,
        task_id: task_id.cloned(),
        agent_id: agent_id.cloned(),
        causation_id: None,
        correlation_id: event_id,
        occurred_at: Utc
            .with_ymd_and_hms(2026, 8, 5, 23, 0, sequence as u32)
            .unwrap(),
        payload,
        evidence_refs: vec![],
    }
}

fn running_worker() -> (RunId, TaskId, AgentId, RunProjection) {
    let run_id = RunId::new("run-outcome-reducer").unwrap();
    let task_id = TaskId::new("task-outcome-reducer").unwrap();
    let agent_id = AgentId::new("agent-outcome-reducer").unwrap();
    let projection =
        RunProjection::rebuild(&running_worker_events(&run_id, &task_id, &agent_id)).unwrap();
    (run_id, task_id, agent_id, projection)
}

fn running_worker_events(run_id: &RunId, task_id: &TaskId, agent_id: &AgentId) -> Vec<RunEvent> {
    vec![
        event(
            run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "adjudicate results".to_string(),
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
                name: "bounded worker task".to_string(),
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

fn running_inline_task() -> (RunId, TaskId, RunProjection) {
    let (run_id, task_id, _, _) = running_worker();
    let projection =
        RunProjection::rebuild(&projection_events_without_worker(&run_id, &task_id)).unwrap();
    (run_id, task_id, projection)
}

fn projection_events_without_worker(run_id: &RunId, task_id: &TaskId) -> Vec<RunEvent> {
    vec![
        event(
            run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "execute inline main Agent task".to_string(),
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
                name: "inline main Agent task".to_string(),
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
    ]
}

fn ready_task(role: Option<AgentRole>) -> (RunId, TaskId, RunProjection) {
    let run_id = RunId::new(match role {
        Some(_) => "run-ready-worker",
        None => "run-ready-inline",
    })
    .unwrap();
    let task_id = TaskId::new(match role {
        Some(_) => "task-ready-worker",
        None => "task-ready-inline",
    })
    .unwrap();
    let events = vec![
        event(
            &run_id,
            1,
            None,
            None,
            RunEventPayload::RunStarted {
                goal: "start task with explicit execution ownership".to_string(),
            },
        ),
        event(
            &run_id,
            2,
            Some(&task_id),
            None,
            RunEventPayload::TaskCreated {
                task_id: task_id.clone(),
                name: "ready task".to_string(),
                role,
            },
        ),
        event(
            &run_id,
            3,
            None,
            None,
            RunEventPayload::PlanProposed {
                plan_revision: 1,
                task_ids: vec![task_id.clone()],
            },
        ),
        event(
            &run_id,
            4,
            None,
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
            6,
            None,
            None,
            RunEventPayload::RunStateChanged {
                from: RunState::Planning,
                to: RunState::Running,
            },
        ),
    ];
    let projection = RunProjection::rebuild(&events).unwrap();
    (run_id, task_id, projection)
}

fn running_main_agent_task() -> (RunId, TaskId, RunProjection) {
    let (run_id, task_id, mut projection) = ready_task(None);
    projection.tasks.get_mut(&task_id).unwrap().state = TaskState::Running;
    projection.user_requirement_revision = 1;
    projection.user_requirements.insert(
        "run-goal".to_string(),
        goose::agents::protocol::UserRequirement {
            requirement_id: "run-goal".to_string(),
            source_message_id: "user-goal".to_string(),
            continuation_source: None,
            semantics: Some(goose::agents::protocol::RequirementSemantics {
                content: "start task with explicit execution ownership".to_string(),
                expected_effect: Some(goose::agents::protocol::RequirementEffect::Observation),
                target_resources: Vec::new(),
                revision_relation: None,
            }),
            execution_obligations: Vec::new(),
        },
    );
    (run_id, task_id, projection)
}

fn cited_requirement(run_id: &RunId, suffix: &str) -> RequirementEvidenceCoverage {
    RequirementEvidenceCoverage {
        requirement_id: "run-goal".to_string(),
        evidence_refs: vec![evidence(run_id, suffix)],
        audit_ids: vec![format!("audit-{suffix}")],
        resource_versions: Default::default(),
    }
}

fn evidence(run_id: &RunId, suffix: &str) -> EvidenceRef {
    EvidenceRef::new(
        run_id.clone(),
        EventId::new(format!("completion-evidence-{suffix}")).unwrap(),
        format!("artifacts/completion-evidence-{suffix}.json"),
    )
    .unwrap()
}

fn command(
    run_id: &RunId,
    task_id: &TaskId,
    agent_id: &AgentId,
    outcome: WorkerOutcome,
) -> ControlCommand {
    ControlCommand::SubmitTaskOutcome {
        run_id: run_id.clone(),
        task_id: task_id.clone(),
        agent_id: Some(agent_id.clone()),
        outcome,
    }
}

#[test]
fn success_is_recorded_before_control_plane_marks_task_succeeded() {
    let (run_id, task_id, agent_id, projection) = running_worker();
    let result = TaskResult {
        summary: "implementation and checks completed".to_string(),
        evidence_refs: vec![],
    };
    let reduction = reduce(
        Some(&projection),
        &command(
            &run_id,
            &task_id,
            &agent_id,
            WorkerOutcome::Succeeded(result.clone()),
        ),
    )
    .unwrap();

    assert!(matches!(
        reduction.events[0].payload,
        RunEventPayload::TaskOutcomeAccepted { .. }
    ));
    assert_eq!(
        reduction.events.last().unwrap().payload,
        RunEventPayload::TaskSucceeded { task_id, result }
    );
    assert!(reduction.effects.is_empty());
}

#[test]
fn unassigned_roleless_task_accepts_inline_outcome() {
    let (run_id, task_id, projection) = running_inline_task();
    let reduction = reduce(
        Some(&projection),
        &ControlCommand::SubmitTaskOutcome {
            run_id,
            task_id,
            agent_id: None,
            outcome: WorkerOutcome::Succeeded(TaskResult {
                summary: "main Agent completed inline work".to_string(),
                evidence_refs: vec![],
            }),
        },
    )
    .unwrap();

    assert!(matches!(
        reduction.events[0].payload,
        RunEventPayload::TaskOutcomeAccepted { agent_id: None, .. }
    ));
}

#[test]
fn main_agent_finish_atomically_succeeds_task_and_run() {
    let (run_id, task_id, projection) = running_main_agent_task();
    let proposal = CompletionProposal::for_main_agent_with_coverage(
        &projection,
        task_id.clone(),
        vec![cited_requirement(&run_id, "valid")],
        Vec::new(),
    );
    let reduction = reduce(
        Some(&projection),
        &ControlCommand::CompleteRun {
            run_id,
            summary: "the user goal is delivered".to_string(),
            proposal: Some(proposal),
        },
    )
    .unwrap();

    assert!(matches!(
        reduction.events.first().map(|event| &event.payload),
        Some(RunEventPayload::TaskOutcomeAccepted { agent_id: None, .. })
    ));
    assert!(reduction.events.iter().any(|event| matches!(
        &event.payload,
        RunEventPayload::TaskSucceeded {
            task_id: completed_task,
            result,
        } if completed_task == &task_id && result.evidence_refs.len() == 1
    )));
    assert!(matches!(
        reduction.events.last().map(|event| &event.payload),
        Some(RunEventPayload::RunCompleted {
            requirement_evidence,
            ..
        }) if requirement_evidence
            .get("run-goal")
            .is_some_and(|evidence| evidence.len() == 1)
    ));
    assert_eq!(
        projection.tasks.get(&task_id).unwrap().state,
        TaskState::Running
    );
}

#[test]
fn rejected_main_agent_finish_keeps_the_task_running() {
    let (run_id, task_id, projection) = running_main_agent_task();
    let proposal = CompletionProposal::for_main_agent(&projection, task_id.clone(), vec![]);
    let error = reduce(
        Some(&projection),
        &ControlCommand::CompleteRun {
            run_id,
            summary: "premature completion".to_string(),
            proposal: Some(proposal),
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        goose::agents::control_plane::ReducerError::CompletionBlocked(ref blockers)
            if blockers.iter().any(|blocker| matches!(
                blocker,
                ConvergenceBlocker::MissingRequirementActionEvidence(requirement)
                    if requirement == "run-goal"
            ))
    ));
    assert_eq!(
        projection.tasks.get(&task_id).unwrap().state,
        TaskState::Running
    );
}

#[test]
fn pause_run_atomically_pauses_the_inline_main_agent_task() {
    let (run_id, task_id, projection) = running_main_agent_task();
    let reduction = reduce(
        Some(&projection),
        &ControlCommand::PauseRun {
            run_id,
            reason: "action_budget_exhausted".to_string(),
        },
    )
    .unwrap();

    assert!(matches!(
        reduction.events.first().map(|event| &event.payload),
        Some(RunEventPayload::TaskStateChanged {
            task_id: paused_task,
            from: TaskState::Running,
            to: TaskState::Paused,
        }) if paused_task == &task_id
    ));
    assert!(matches!(
        reduction.events.last().map(|event| &event.payload),
        Some(RunEventPayload::RunPaused { reason, .. })
            if reason == "action_budget_exhausted"
    ));
    assert_eq!(reduction.effects[0].trigger_event_index, 1);
}

#[test]
fn main_agent_finish_rejects_non_authoritative_requirement_coverage() {
    let (run_id, task_id, projection) = running_main_agent_task();
    let mut proposal = CompletionProposal::for_main_agent_with_coverage(
        &projection,
        task_id.clone(),
        vec![cited_requirement(&run_id, "wrong-requirement")],
        Vec::new(),
    );
    proposal.requirement_coverage[0].requirement_id = "planner-invented-goal".to_string();
    let error = reduce(
        Some(&projection),
        &ControlCommand::CompleteRun {
            run_id,
            summary: "wrong requirement source".to_string(),
            proposal: Some(proposal),
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        goose::agents::control_plane::ReducerError::CompletionBlocked(ref blockers)
            if blockers.contains(&ConvergenceBlocker::RequirementCoverageMismatch)
    ));
    assert_eq!(
        projection.tasks.get(&task_id).unwrap().state,
        TaskState::Running
    );
}

#[test]
fn main_agent_finish_rejects_cross_run_evidence_at_the_protocol_boundary() {
    let (run_id, task_id, projection) = running_main_agent_task();
    let other_run = RunId::new("other-run").unwrap();
    let proposal = CompletionProposal::for_main_agent_with_coverage(
        &projection,
        task_id,
        vec![RequirementEvidenceCoverage {
            evidence_refs: vec![evidence(&other_run, "cross-run")],
            ..cited_requirement(&run_id, "valid")
        }],
        Vec::new(),
    );
    let error = reduce(
        Some(&projection),
        &ControlCommand::CompleteRun {
            run_id,
            summary: "cross-run evidence must not complete".to_string(),
            proposal: Some(proposal),
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        goose::agents::control_plane::ReducerError::Protocol(_)
    ));
}

#[test]
fn start_task_dispatches_only_tasks_owned_by_workers() {
    let (inline_run, inline_task, inline_projection) = ready_task(None);
    let inline = reduce(
        Some(&inline_projection),
        &ControlCommand::StartTask {
            run_id: inline_run,
            task_id: inline_task,
        },
    )
    .unwrap();
    assert!(inline.effects.is_empty());

    let (worker_run, worker_task, worker_projection) = ready_task(Some(AgentRole::Coder));
    let worker = reduce(
        Some(&worker_projection),
        &ControlCommand::StartTask {
            run_id: worker_run.clone(),
            task_id: worker_task.clone(),
        },
    )
    .unwrap();
    assert_eq!(worker.effects.len(), 1);
    assert!(matches!(
        &worker.effects[0].effect,
        ControlEffect::DispatchTask { run_id, task_id }
            if run_id == &worker_run && task_id == &worker_task
    ));
}

#[test]
fn delegated_roleless_task_rejects_inline_outcome() {
    let (run_id, task_id, _, projection) = running_worker();
    let error = reduce(
        Some(&projection),
        &ControlCommand::SubmitTaskOutcome {
            run_id,
            task_id,
            agent_id: None,
            outcome: WorkerOutcome::Succeeded(TaskResult {
                summary: "inline submitter must not steal delegated task".to_string(),
                evidence_refs: vec![],
            }),
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        goose::agents::control_plane::ReducerError::TaskOutcomeSubmitterRequired(_)
    ));
}

#[test]
fn delegated_roleless_task_rejects_a_second_active_worker() {
    let (run_id, task_id, _, projection) = running_worker();
    let second_agent = AgentId::new("agent-outcome-reducer-2").unwrap();
    let error = reduce(
        Some(&projection),
        &ControlCommand::RegisterWorker {
            run_id,
            task_id,
            agent_id: second_agent,
            role: AgentRole::Tester,
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        goose::agents::control_plane::ReducerError::TaskWorkerAlreadyRegistered { .. }
    ));
}

#[test]
fn projection_replay_rejects_inline_outcome_after_worker_takes_ownership() {
    let run_id = RunId::new("run-outcome-owner-replay").unwrap();
    let task_id = TaskId::new("task-outcome-owner-replay").unwrap();
    let agent_id = AgentId::new("agent-outcome-owner-replay").unwrap();
    let mut events = running_worker_events(&run_id, &task_id, &agent_id);
    let outcome = WorkerOutcome::Succeeded(TaskResult {
        summary: "inline submitter must not steal delegated task".to_string(),
        evidence_refs: vec![],
    });
    let accepted = event(
        &run_id,
        8,
        Some(&task_id),
        None,
        RunEventPayload::TaskOutcomeAccepted {
            task_id: task_id.clone(),
            agent_id: None,
            recovery_decision: Some(outcome.recovery_decision()),
            outcome,
        },
    );
    events.push(accepted);

    assert!(RunProjection::rebuild(&events).is_err());
}

#[test]
fn user_skipped_verification_is_terminal_without_retry_effects() {
    let (run_id, task_id, agent_id, projection) = running_worker();
    let result = TaskResult {
        summary: "user_decision:skip_dynamic_validation\nresult:NOT_RUN".to_string(),
        evidence_refs: vec![],
    };
    let reduction = reduce(
        Some(&projection),
        &command(&run_id, &task_id, &agent_id, WorkerOutcome::Skipped(result)),
    )
    .unwrap();

    assert!(reduction.events.iter().any(|event| matches!(
        &event.payload,
        RunEventPayload::TaskStateChanged {
            from: TaskState::Running,
            to: TaskState::Skipped,
            ..
        }
    )));
    assert!(!reduction
        .events
        .iter()
        .any(|event| matches!(event.payload, RunEventPayload::TaskRetryScheduled { .. })));
    assert!(reduction.effects.is_empty());
}

#[test]
fn only_transient_infrastructure_failure_is_retried_mechanically() {
    let (run_id, task_id, agent_id, projection) = running_worker();
    let failure = TaskFailure {
        class: FailureClass::TransientInfrastructure,
        message: "provider returned 429".to_string(),
        evidence_refs: vec![],
    };
    let reduction = reduce(
        Some(&projection),
        &command(
            &run_id,
            &task_id,
            &agent_id,
            WorkerOutcome::Failed(failure.clone()),
        ),
    )
    .unwrap();

    assert!(reduction.events.iter().any(|event| matches!(
        event.payload,
        RunEventPayload::TaskRetryScheduled {
            attempt: 1,
            delay_ms: 250,
            ..
        }
    )));
    assert_eq!(
        reduction.effects.last().unwrap().effect,
        ControlEffect::RetryTask {
            run_id,
            task_id,
            attempt: 1,
            delay_ms: 250,
        }
    );

    let policy = FailurePolicy::default();
    assert_eq!(
        policy.classify(&failure, 0),
        FailureDisposition::Retry {
            attempt: 1,
            delay_ms: 250,
        }
    );
    assert_eq!(
        policy.classify(&failure, 1),
        FailureDisposition::Retry {
            attempt: 2,
            delay_ms: 500,
        }
    );
    assert_eq!(
        policy.classify(&failure, 2),
        FailureDisposition::Coordinator
    );
    let implementation = TaskFailure {
        class: FailureClass::Implementation,
        message: "tests expose invalid code".to_string(),
        evidence_refs: vec![],
    };
    assert_eq!(
        policy.classify(&implementation, 0),
        FailureDisposition::Coordinator
    );
}

#[test]
fn semantic_failure_waits_for_coordinator_without_retry_or_terminal_failure() {
    let (run_id, task_id, agent_id, projection) = running_worker();
    let reduction = reduce(
        Some(&projection),
        &command(
            &run_id,
            &task_id,
            &agent_id,
            WorkerOutcome::Failed(TaskFailure {
                class: FailureClass::Validation,
                message: "acceptance test failed".to_string(),
                evidence_refs: vec![],
            }),
        ),
    )
    .unwrap();

    assert!(reduction.events.iter().any(|event| {
        event.payload
            == RunEventPayload::TaskStateChanged {
                task_id: task_id.clone(),
                from: TaskState::Running,
                to: TaskState::WaitingForCoordinator,
            }
    }));
    assert!(!reduction.events.iter().any(|event| matches!(
        event.payload,
        RunEventPayload::TaskFailed { .. } | RunEventPayload::TaskRetryScheduled { .. }
    )));
    assert!(reduction.effects.is_empty());
}

#[test]
fn assistance_pause_block_and_cancel_have_distinct_authoritative_states() {
    let cases = [
        (
            WorkerOutcome::NeedsHelp(AssistanceRequest {
                reason: "need a security review".to_string(),
                required_capabilities: vec!["security".to_string()],
                evidence_refs: vec![],
            }),
            TaskState::WaitingForCoordinator,
        ),
        (
            WorkerOutcome::Paused(Checkpoint {
                checkpoint_id: "checkpoint-1".to_string(),
                summary: "safe boundary reached".to_string(),
                evidence_refs: vec![],
            }),
            TaskState::Paused,
        ),
        (
            WorkerOutcome::Blocked(BlockReason {
                kind: BlockKind::Permission,
                message: "write approval required".to_string(),
                evidence_refs: vec![],
            }),
            TaskState::WaitingForApproval,
        ),
        (
            WorkerOutcome::Cancelled(CancellationReport {
                reason: "worker observed cancellation".to_string(),
                evidence_refs: vec![],
            }),
            TaskState::Cancelled,
        ),
    ];

    for (outcome, expected) in cases {
        let (run_id, task_id, agent_id, projection) = running_worker();
        let reduction = reduce(
            Some(&projection),
            &command(&run_id, &task_id, &agent_id, outcome),
        )
        .unwrap();
        assert!(reduction.events.iter().any(|event| matches!(
            &event.payload,
            RunEventPayload::TaskStateChanged { to, .. } if *to == expected
        )));
    }
}

#[test]
fn verification_repair_outcomes_keep_distinct_authoritative_states() {
    let failure = || TaskFailure {
        class: FailureClass::Validation,
        message: "node tests.js exited 1".to_string(),
        evidence_refs: vec![],
    };
    let checkpoint = || Checkpoint {
        checkpoint_id: "repair-checkpoint-1".to_string(),
        summary: "repair state saved".to_string(),
        evidence_refs: vec![],
    };
    let cases = [
        (
            WorkerOutcome::VerificationFailed(failure()),
            TaskState::VerificationFailed,
            RunState::VerificationFailed,
            RecoveryAction::RepairThenRetest,
        ),
        (
            WorkerOutcome::RepairPending(checkpoint()),
            TaskState::RepairPending,
            RunState::Repairing,
            RecoveryAction::RepairThenRetest,
        ),
        (
            WorkerOutcome::WaitingForUser(checkpoint()),
            TaskState::WaitingForUser,
            RunState::WaitingForUser,
            RecoveryAction::AskUserThenResume,
        ),
        (
            WorkerOutcome::RepairExhausted(TaskFailure {
                class: FailureClass::BudgetExhausted,
                ..failure()
            }),
            TaskState::RepairExhausted,
            RunState::Exhausted,
            RecoveryAction::Finish,
        ),
    ];

    for (outcome, expected_task_state, expected_run_state, expected_action) in cases {
        let (run_id, task_id, agent_id, projection) = running_worker();
        let reduction = reduce(
            Some(&projection),
            &command(&run_id, &task_id, &agent_id, outcome),
        )
        .unwrap();
        assert!(reduction.events.iter().any(|event| matches!(
            &event.payload,
            RunEventPayload::TaskStateChanged { to, .. } if *to == expected_task_state
        )));
        assert!(reduction.events.iter().any(|event| matches!(
            &event.payload,
            RunEventPayload::TaskOutcomeAccepted {
                recovery_decision: Some(recovery_decision),
                ..
            } if recovery_decision.state == expected_run_state
                && recovery_decision.action == expected_action
        )));
    }
}

#[test]
fn wrong_task_unknown_agent_and_inactive_worker_fail_closed() {
    let (run_id, task_id, agent_id, projection) = running_worker();
    let success = WorkerOutcome::Succeeded(TaskResult {
        summary: "should not be accepted".to_string(),
        evidence_refs: vec![],
    });
    assert!(reduce(
        Some(&projection),
        &command(
            &run_id,
            &TaskId::new("task-unknown").unwrap(),
            &agent_id,
            success.clone(),
        ),
    )
    .is_err());
    assert!(reduce(
        Some(&projection),
        &command(
            &run_id,
            &task_id,
            &AgentId::new("agent-unknown").unwrap(),
            success,
        ),
    )
    .is_err());
}
