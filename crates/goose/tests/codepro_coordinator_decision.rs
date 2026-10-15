use goose::agents::control_plane::ConvergenceStatus;
use goose::agents::coordinator::{
    CoordinatorAction, CoordinatorDecisionEnvelope, CoordinatorDecisionValidator,
    CoordinatorTaskProposal, DecisionValidationError, DecisionValidationSnapshot,
    COORDINATOR_DECISION_SCHEMA_VERSION,
};
use goose::agents::protocol::{
    AgentId, AgentState, BudgetRequest, CoordinatorDecision, CoordinatorDecisionCandidate, EventId,
    EvidenceRef, ProtocolVersion, RunId, RunState, TaskId, TaskState,
};
use goose::agents::AgentRole;

fn evidence(run_id: &RunId, event_id: &str) -> EvidenceRef {
    EvidenceRef::new(
        run_id.clone(),
        EventId::new(event_id).unwrap(),
        format!("artifacts/{event_id}.json"),
    )
    .unwrap()
}

fn snapshot() -> DecisionValidationSnapshot {
    let run_id = RunId::new("run-decision").unwrap();
    let task_id = TaskId::new("task-code").unwrap();
    let agent_id = AgentId::new("agent-code").unwrap();
    let mut snapshot = DecisionValidationSnapshot::new(run_id, RunState::Running, 2);
    snapshot.insert_task(task_id.clone(), TaskState::WaitingForCoordinator);
    snapshot.insert_agent(agent_id, Some(task_id), AgentState::Idle);
    snapshot.record_evidence(EventId::new("event-failure").unwrap());
    snapshot.allow_write_scope("src/**").unwrap();
    snapshot.set_budget_limits(20, Some(10_000));
    snapshot
}

fn candidate(decision: CoordinatorDecision) -> CoordinatorDecisionCandidate {
    let run_id = RunId::new("run-decision").unwrap();
    CoordinatorDecisionCandidate {
        protocol_version: ProtocolVersion::V2,
        run_id: run_id.clone(),
        decision_id: EventId::new("decision-1").unwrap(),
        decision,
        reason: "current failure evidence supports this action".into(),
        target_task_id: Some(TaskId::new("task-code").unwrap()),
        target_agent_id: None,
        evidence_refs: vec![evidence(&run_id, "event-failure")],
        requested_budget: None,
        required_permissions: vec![],
        expected_completion: "task returns new test evidence".into(),
        supersedes_plan_revision: Some(2),
    }
}

fn envelope(
    decision: CoordinatorDecision,
    action: CoordinatorAction,
) -> CoordinatorDecisionEnvelope {
    CoordinatorDecisionEnvelope {
        schema_version: COORDINATOR_DECISION_SCHEMA_VERSION,
        candidate: candidate(decision),
        action,
    }
}

#[test]
fn current_evidence_and_waiting_task_produce_a_validated_capability() {
    let decision = CoordinatorDecisionValidator::validate(
        envelope(
            CoordinatorDecision::ContinueTask,
            CoordinatorAction::ContinueTask,
        ),
        &snapshot(),
    )
    .unwrap();

    assert_eq!(
        decision.envelope().candidate.decision_id.to_string(),
        "decision-1"
    );
}

#[test]
fn unknown_evidence_and_stale_plan_fail_closed() {
    let mut unknown = envelope(
        CoordinatorDecision::ContinueTask,
        CoordinatorAction::ContinueTask,
    );
    unknown.candidate.evidence_refs = vec![evidence(
        &RunId::new("run-decision").unwrap(),
        "event-fabricated",
    )];
    assert!(matches!(
        CoordinatorDecisionValidator::validate(unknown, &snapshot()),
        Err(DecisionValidationError::UnknownEvidence(_))
    ));

    let mut stale = envelope(
        CoordinatorDecision::ContinueTask,
        CoordinatorAction::ContinueTask,
    );
    stale.candidate.supersedes_plan_revision = Some(1);
    assert!(matches!(
        CoordinatorDecisionValidator::validate(stale, &snapshot()),
        Err(DecisionValidationError::StalePlan { .. })
    ));
}

#[test]
fn permission_and_budget_escalation_cannot_create_an_executable_decision() {
    let mut permission = envelope(CoordinatorDecision::RetryTask, CoordinatorAction::RetryTask);
    permission.candidate.required_permissions = vec!["network:example.com".into()];
    assert!(matches!(
        CoordinatorDecisionValidator::validate(permission, &snapshot()),
        Err(DecisionValidationError::PermissionEscalation(_))
    ));

    let mut budget = envelope(CoordinatorDecision::RetryTask, CoordinatorAction::RetryTask);
    budget.candidate.requested_budget = Some(BudgetRequest {
        max_additional_turns: 21,
        max_additional_tokens: Some(10_001),
    });
    assert!(matches!(
        CoordinatorDecisionValidator::validate(budget, &snapshot()),
        Err(DecisionValidationError::BudgetEscalation)
    ));
}

#[test]
fn ask_user_may_request_permission_but_cannot_masquerade_as_retry() {
    let mut ask = envelope(
        CoordinatorDecision::AskUser,
        CoordinatorAction::AskUser {
            question: "Allow access to example.com?".into(),
        },
    );
    ask.candidate.target_task_id = None;
    ask.candidate.required_permissions = vec!["network:example.com".into()];
    assert!(CoordinatorDecisionValidator::validate(ask, &snapshot()).is_ok());

    let mismatch = envelope(
        CoordinatorDecision::RetryTask,
        CoordinatorAction::ContinueTask,
    );
    assert!(matches!(
        CoordinatorDecisionValidator::validate(mismatch, &snapshot()),
        Err(DecisionValidationError::ActionMismatch)
    ));
}

#[test]
fn completion_requires_the_host_convergence_gate() {
    let mut complete = envelope(
        CoordinatorDecision::CompleteRun,
        CoordinatorAction::CompleteRun {
            summary: "all acceptance evidence is present".into(),
        },
    );
    complete.candidate.target_task_id = None;
    let mut blocked = snapshot();
    blocked.set_convergence_status(ConvergenceStatus::Blocked);
    assert!(matches!(
        CoordinatorDecisionValidator::validate(complete.clone(), &blocked),
        Err(DecisionValidationError::RunNotConverged)
    ));

    blocked.set_convergence_status(ConvergenceStatus::Eligible);
    assert!(CoordinatorDecisionValidator::validate(complete, &blocked).is_ok());
}

#[test]
fn instruction_targets_an_idle_agent_and_has_bounded_text() {
    let mut instruction = envelope(
        CoordinatorDecision::SendInstruction,
        CoordinatorAction::SendInstruction {
            instruction: "rerun the exact failed test and return evidence".into(),
        },
    );
    instruction.candidate.target_agent_id = Some(AgentId::new("agent-code").unwrap());
    assert!(CoordinatorDecisionValidator::validate(instruction.clone(), &snapshot()).is_ok());

    instruction.candidate.target_agent_id = Some(AgentId::new("missing-agent").unwrap());
    assert!(matches!(
        CoordinatorDecisionValidator::validate(instruction, &snapshot()),
        Err(DecisionValidationError::UnknownAgent(_))
    ));
}

fn proposal(id: &str, write_scope: &str) -> CoordinatorTaskProposal {
    CoordinatorTaskProposal {
        task_id: TaskId::new(id).unwrap(),
        name: id.into(),
        role: AgentRole::Coder,
        depends_on: vec![],
        acceptance_criteria: "host tests pass".into(),
        read_scope: vec!["src/**".into()],
        write_scope: vec![write_scope.into()],
        required_evidence: vec!["patch".into(), "test_result".into()],
    }
}

#[test]
fn revised_plan_cannot_expand_write_scope_or_create_parallel_writer_conflicts() {
    let mut revise = envelope(
        CoordinatorDecision::RevisePlan,
        CoordinatorAction::RevisePlan {
            plan_revision: 3,
            tasks: vec![proposal("task-a", "outside/**")],
        },
    );
    revise.candidate.target_task_id = None;
    assert!(matches!(
        CoordinatorDecisionValidator::validate(revise, &snapshot()),
        Err(DecisionValidationError::WriteScopeExpansion { .. })
    ));

    let mut conflict = envelope(
        CoordinatorDecision::RevisePlan,
        CoordinatorAction::RevisePlan {
            plan_revision: 3,
            tasks: vec![
                proposal("task-a", "src/auth/**"),
                proposal("task-b", "src/auth/token.rs"),
            ],
        },
    );
    conflict.candidate.target_task_id = None;
    assert!(matches!(
        CoordinatorDecisionValidator::validate(conflict, &snapshot()),
        Err(DecisionValidationError::UnsafeWriteOwnership(_))
    ));
}

#[test]
fn replayed_decisions_and_ambiguous_targets_fail_closed() {
    let mut consumed = snapshot();
    consumed.record_applied_decision(EventId::new("decision-1").unwrap());
    assert!(matches!(
        CoordinatorDecisionValidator::validate(
            envelope(
                CoordinatorDecision::ContinueTask,
                CoordinatorAction::ContinueTask,
            ),
            &consumed,
        ),
        Err(DecisionValidationError::ReplayedDecision(_))
    ));

    let mut ambiguous = envelope(
        CoordinatorDecision::ContinueTask,
        CoordinatorAction::ContinueTask,
    );
    ambiguous.candidate.target_agent_id = Some(AgentId::new("agent-code").unwrap());
    assert!(matches!(
        CoordinatorDecisionValidator::validate(ambiguous, &snapshot()),
        Err(DecisionValidationError::UnexpectedTarget)
    ));
}

#[test]
fn traversal_and_unknown_json_fields_are_rejected() {
    let mut traversal = envelope(
        CoordinatorDecision::RevisePlan,
        CoordinatorAction::RevisePlan {
            plan_revision: 3,
            tasks: vec![proposal("task-a", "src/../outside.rs")],
        },
    );
    traversal.candidate.target_task_id = None;
    assert!(matches!(
        CoordinatorDecisionValidator::validate(traversal, &snapshot()),
        Err(DecisionValidationError::WriteScopeExpansion { .. })
    ));

    let mut json = serde_json::to_value(envelope(
        CoordinatorDecision::ContinueTask,
        CoordinatorAction::ContinueTask,
    ))
    .unwrap();
    json.as_object_mut()
        .unwrap()
        .insert("execute_without_validation".into(), true.into());
    assert!(serde_json::from_value::<CoordinatorDecisionEnvelope>(json).is_err());

    let mut nested = serde_json::to_value(envelope(
        CoordinatorDecision::ContinueTask,
        CoordinatorAction::ContinueTask,
    ))
    .unwrap();
    nested["candidate"]
        .as_object_mut()
        .unwrap()
        .insert("hidden_instruction".into(), "bypass host".into());
    assert!(serde_json::from_value::<CoordinatorDecisionEnvelope>(nested).is_err());
}
