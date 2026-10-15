use goose::agents::protocol::{
    BudgetRequest, ControlCommand, CoordinatorAuditRecord, CoordinatorCandidateStatus,
    CoordinatorComparisonClass, CoordinatorDecision, CoordinatorDecisionCandidate,
    CoordinatorDecisionPoint, CoordinatorExecutionDisposition, CoordinatorFallbackReason,
    CoordinatorMode, CoordinatorQualificationResult, EventId, EvidenceRef, FailureClass,
    ProtocolVersion, RunId, TaskId, TaskResult, WorkerOutcome, COORDINATOR_AUDIT_SCHEMA_VERSION,
};

fn audit() -> CoordinatorAuditRecord {
    CoordinatorAuditRecord {
        schema_version: COORDINATOR_AUDIT_SCHEMA_VERSION,
        requested_mode: CoordinatorMode::Shadow,
        effective_mode: CoordinatorMode::Shadow,
        qualification: CoordinatorQualificationResult::NotRequired,
        decision_point: CoordinatorDecisionPoint::WorkerBlocked,
        candidate_status: CoordinatorCandidateStatus::Valid,
        legacy_action: Some(CoordinatorDecision::ContinueTask),
        coordinator_action: Some(CoordinatorDecision::ContinueTask),
        comparison: CoordinatorComparisonClass::Match,
        rejection_reason: None,
        execution_disposition: CoordinatorExecutionDisposition::Legacy,
        fallback_reason: Some(CoordinatorFallbackReason::ShadowMode),
        latency_ms: 10,
        prompt_tokens: 100,
        completion_bytes: 200,
    }
}

fn candidate(run_id: &RunId) -> CoordinatorDecisionCandidate {
    CoordinatorDecisionCandidate {
        protocol_version: ProtocolVersion::V1,
        run_id: run_id.clone(),
        decision_id: EventId::new("decision-1").unwrap(),
        decision: CoordinatorDecision::ContinueTask,
        reason: "continue the bounded task".to_string(),
        target_task_id: None,
        target_agent_id: None,
        evidence_refs: vec![],
        requested_budget: None,
        required_permissions: vec![],
        expected_completion: "task reaches a terminal state".to_string(),
        supersedes_plan_revision: None,
    }
}

fn valid_commands(run_id: &RunId) -> Vec<(ControlCommand, &'static str)> {
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = goose::agents::protocol::AgentId::new("agent-1").unwrap();
    vec![
        (
            ControlCommand::StartRun {
                run_id: run_id.clone(),
                goal: "build the control plane".to_string(),
            },
            "start_run",
        ),
        (
            ControlCommand::RevisePlan {
                run_id: run_id.clone(),
                plan_revision: 1,
            },
            "revise_plan",
        ),
        (
            ControlCommand::StartTask {
                run_id: run_id.clone(),
                task_id: task_id.clone(),
            },
            "start_task",
        ),
        (
            ControlCommand::StopWorker {
                run_id: run_id.clone(),
                agent_id: agent_id.clone(),
                reason: "replace a stuck worker".to_string(),
            },
            "stop_worker",
        ),
        (
            ControlCommand::CancelTask {
                run_id: run_id.clone(),
                task_id: task_id.clone(),
                reason: "task is no longer needed".to_string(),
            },
            "cancel_task",
        ),
        (
            ControlCommand::CancelBranch {
                run_id: run_id.clone(),
                root_task_id: task_id.clone(),
                reason: "branch is superseded".to_string(),
            },
            "cancel_branch",
        ),
        (
            ControlCommand::PauseRun {
                run_id: run_id.clone(),
                reason: "wait for user direction".to_string(),
            },
            "pause_run",
        ),
        (
            ControlCommand::ResumeRun {
                run_id: run_id.clone(),
            },
            "resume_run",
        ),
        (
            ControlCommand::EmergencyStop {
                run_id: run_id.clone(),
                reason: "stop external writes".to_string(),
            },
            "emergency_stop",
        ),
        (
            ControlCommand::CompleteRun {
                run_id: run_id.clone(),
                summary: "all work verified".to_string(),
                proposal: None,
            },
            "complete_run",
        ),
        (
            ControlCommand::FailRun {
                run_id: run_id.clone(),
                class: FailureClass::Validation,
                message: "verification failed".to_string(),
                evidence_refs: vec![],
            },
            "fail_run",
        ),
        (
            ControlCommand::SubmitTaskOutcome {
                run_id: run_id.clone(),
                task_id,
                agent_id: Some(agent_id),
                outcome: WorkerOutcome::Succeeded(TaskResult {
                    summary: "implemented and verified".to_string(),
                    evidence_refs: vec![],
                }),
            },
            "submit_worker_outcome",
        ),
        (
            ControlCommand::ApplyCoordinatorDecision {
                candidate: candidate(run_id),
            },
            "apply_coordinator_decision",
        ),
        (
            ControlCommand::RecordCoordinatorAudit {
                run_id: run_id.clone(),
                audit: audit(),
            },
            "record_coordinator_audit",
        ),
    ]
}

#[test]
fn every_control_command_exposes_stable_kind_and_authoritative_run() {
    let run_id = RunId::new("run-command-contract").unwrap();

    for (command, expected_kind) in valid_commands(&run_id) {
        assert_eq!(command.run_id(), &run_id, "{expected_kind}");
        assert_eq!(command.kind(), expected_kind);
        command.validate().unwrap();
    }
}

#[test]
fn required_goal_and_reason_fields_fail_closed() {
    let run_id = RunId::new("run-command-contract").unwrap();
    let task_id = TaskId::new("task-1").unwrap();
    let agent_id = goose::agents::protocol::AgentId::new("agent-1").unwrap();
    let commands = [
        ControlCommand::StartRun {
            run_id: run_id.clone(),
            goal: "  ".to_string(),
        },
        ControlCommand::StopWorker {
            run_id: run_id.clone(),
            agent_id,
            reason: "".to_string(),
        },
        ControlCommand::CancelTask {
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            reason: "\t".to_string(),
        },
        ControlCommand::CancelBranch {
            run_id: run_id.clone(),
            root_task_id: task_id,
            reason: "\n".to_string(),
        },
        ControlCommand::PauseRun {
            run_id: run_id.clone(),
            reason: " ".to_string(),
        },
        ControlCommand::EmergencyStop {
            run_id: run_id.clone(),
            reason: "".to_string(),
        },
        ControlCommand::CompleteRun {
            run_id: run_id.clone(),
            summary: "".to_string(),
            proposal: None,
        },
        ControlCommand::FailRun {
            run_id,
            class: FailureClass::Unknown,
            message: "".to_string(),
            evidence_refs: vec![],
        },
    ];

    for command in commands {
        assert!(command.validate().is_err(), "{} must fail", command.kind());
    }
}

#[test]
fn nested_versions_budgets_and_evidence_are_validated() {
    let run_id = RunId::new("run-command-contract").unwrap();
    assert!(ControlCommand::RevisePlan {
        run_id: run_id.clone(),
        plan_revision: 0,
    }
    .validate()
    .is_err());

    let foreign_evidence = EvidenceRef::new(
        RunId::new("run-foreign").unwrap(),
        EventId::new("event-foreign").unwrap(),
        "artifacts/result.txt",
    )
    .unwrap();
    assert!(ControlCommand::SubmitTaskOutcome {
        run_id: run_id.clone(),
        task_id: TaskId::new("task-1").unwrap(),
        agent_id: Some(goose::agents::protocol::AgentId::new("agent-1").unwrap()),
        outcome: WorkerOutcome::Succeeded(TaskResult {
            summary: "foreign evidence must fail".to_string(),
            evidence_refs: vec![foreign_evidence],
        }),
    }
    .validate()
    .is_err());

    let mut invalid_candidate = candidate(&run_id);
    invalid_candidate.requested_budget = Some(BudgetRequest {
        max_additional_turns: 0,
        max_additional_tokens: Some(0),
    });
    assert!(ControlCommand::ApplyCoordinatorDecision {
        candidate: invalid_candidate,
    }
    .validate()
    .is_err());
}
